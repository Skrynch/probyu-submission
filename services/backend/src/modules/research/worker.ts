import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

import { POLICY } from '../family/policy.js';
import { RESEARCH_POLICY, contentHash, type CuratedChallenge } from './content.js';
import {
  DeterministicFakeGeneration,
  ProviderOutcomeUnknownError,
  approveFakeAnswer,
  decryptJson,
  encryptJson,
  type AgeBand,
  type TextGeneration,
} from './runtime.js';
import { approvedArtifactPayload } from './service.js';

type ClaimedRun = QueryResultRow & {
  outbox_id: string;
  outbox_state: 'PENDING' | 'PROCESSING';
  id: string;
  family_id: string;
  child_id: string;
  input_ciphertext: string;
  adapter_version: string;
  fence: number;
  lease_owner: string;
  status: 'QUEUED' | 'GENERATING';
  recovered_unknown: boolean;
};

type VersionRow = QueryResultRow & {
  id: string;
  key: string;
  version: number;
  kind: CuratedChallenge['kind'];
  title: string;
  goal: string;
  duration_minutes: number;
  resume_window_minutes: number | null;
  materials: string[];
  steps: string[];
  age_bands: AgeBand[];
  risk_class: 'MINIMAL_RISK';
  supervision_requirement: 'NONE';
  content_hash: string;
};

type WorkerFailure =
  | 'INPUT_LOST'
  | 'OUTPUT_REJECTED'
  | 'GATE_TIMEOUT'
  | 'PROVIDER_OUTCOME_UNKNOWN'
  | 'ACCESS_REVOKED'
  | 'KILLED';

type RunBlockReason = Extract<WorkerFailure, 'ACCESS_REVOKED' | 'KILLED'> | 'PAUSED';

class RunBlockedError extends Error {
  constructor(readonly code: RunBlockReason) {
    super(code);
  }
}

export class ResearchWorker {
  readonly pool: Pool;
  readonly dataKey: Buffer;
  constructor(
    databaseUrl: string,
    dataKey: string,
    readonly adapter: TextGeneration = new DeterministicFakeGeneration(),
    readonly clock: () => Date = () => new Date(),
  ) {
    if (!/^[a-f0-9]{64}$/.test(dataKey)) throw new Error('Research data key is invalid.');
    this.dataKey = Buffer.from(dataKey, 'hex');
    this.pool = new Pool({ connectionString: databaseUrl, max: 3, connectionTimeoutMillis: 1000 });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async cycle(): Promise<{ processed: number }> {
    const claimed = await this.claim();
    if (!claimed) return { processed: 0 };
    if (claimed.recovered_unknown) {
      await this.fail(claimed, 'PROVIDER_OUTCOME_UNKNOWN');
      return { processed: 1 };
    }
    let question: string;
    try {
      question = decryptJson<string>(this.dataKey, claimed.input_ciphertext);
    } catch {
      await this.fail(claimed, 'INPUT_LOST');
      return { processed: 1 };
    }
    if (claimed.adapter_version !== this.adapter.version) {
      await this.fail(claimed, 'OUTPUT_REJECTED');
      return { processed: 1 };
    }
    const authorization = await this.authorization(claimed);
    if (!authorization.allowed) {
      if (authorization.code === 'PAUSED') await this.deferForPolicyPause(claimed);
      else await this.fail(claimed, authorization.code);
      return { processed: 1 };
    }
    const ageBand = authorization.ageBand;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('GATE_TIMEOUT')), 1500);
    timeout.unref();
    let output: unknown;
    try {
      output = await this.adapter.generate({ question, ageBand }, controller.signal);
    } catch (error) {
      await this.fail(
        claimed,
        error instanceof ProviderOutcomeUnknownError
          ? 'PROVIDER_OUTCOME_UNKNOWN'
          : controller.signal.aborted
            ? 'GATE_TIMEOUT'
            : 'OUTPUT_REJECTED',
      );
      return { processed: 1 };
    } finally {
      clearTimeout(timeout);
    }
    try {
      const approved = approveFakeAnswer(output, ageBand);
      await this.commitApproved(claimed, ageBand, approved.answer, approved.challenge);
    } catch (error) {
      const code = error instanceof RunBlockedError ? error.code : 'OUTPUT_REJECTED';
      if (code === 'PAUSED') await this.deferForPolicyPause(claimed);
      else await this.fail(claimed, code);
    }
    return { processed: 1 };
  }

  private async claim(): Promise<ClaimedRun | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE probyu_research_worker');
      await client.query("SET LOCAL statement_timeout='5s'");
      const selected = (
        await client.query<ClaimedRun>(
          `SELECT o.id outbox_id,o.state outbox_state,a.*,false recovered_unknown
           FROM research.outbox o
           JOIN research.answer_runs a ON a.id=o.answer_run_id
             AND a.family_id=o.family_id AND a.child_id=o.child_id
           JOIN LATERAL research.lock_policy_version(a.policy_version) p ON true
           WHERE o.event_type='GENERATE_ANSWER'
             AND o.state=ANY(ARRAY['PENDING','PROCESSING'])
             AND a.status=ANY(ARRAY['QUEUED','GENERATING'])
             AND (a.lease_expires_at IS NULL OR a.lease_expires_at<=$1)
             AND (p.policy_active OR p.current_kill_epoch<>a.kill_epoch)
           ORDER BY o.created_at
           FOR UPDATE OF o,a SKIP LOCKED LIMIT 1`,
          [this.clock()],
        )
      ).rows[0];
      if (!selected) {
        await client.query('COMMIT');
        return undefined;
      }
      const owner = randomUUID();
      const recoveredUnknown =
        selected.status === 'GENERATING' || selected.outbox_state === 'PROCESSING';
      const updated = (
        await client.query<ClaimedRun>(
          `UPDATE research.answer_runs
           SET status='GENERATING',fence=fence+1,lease_owner=$2,
               lease_expires_at=$3,updated_at=$1
           WHERE id=$4
           RETURNING *, $5::uuid outbox_id,$6::text outbox_state,
             $7::boolean recovered_unknown`,
          [
            this.clock(),
            owner,
            new Date(this.clock().getTime() + 10_000),
            selected.id,
            selected.outbox_id,
            selected.outbox_state,
            recoveredUnknown,
          ],
        )
      ).rows[0]!;
      await client.query("UPDATE research.outbox SET state='PROCESSING' WHERE id=$1", [
        selected.outbox_id,
      ]);
      await client.query('COMMIT');
      return updated;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async authorization(
    claimed: ClaimedRun,
  ): Promise<{ allowed: true; ageBand: AgeBand } | { allowed: false; code: RunBlockReason }> {
    return this.tenant(claimed.family_id, async (client) => {
      const blocked = await this.blockedReason(client, claimed);
      if (blocked) return { allowed: false, code: blocked };
      const row = (
        await client.query<{ age_band: AgeBand }>(
          `SELECT c.age_band
           FROM research.answer_runs a
           JOIN family.families f ON f.id=a.family_id AND f.status='ACTIVE'
             AND f.access_epoch=a.access_epoch
           JOIN family.children c ON c.family_id=a.family_id AND c.id=a.child_id
             AND c.status='ACTIVE' AND c.access_epoch=a.child_access_epoch
           JOIN identity.sessions s ON s.id=a.session_id AND s.family_id=a.family_id
             AND s.child_id=a.child_id AND s.registration_id=a.registration_id
             AND s.mode='CHILD' AND s.revoked_at IS NULL AND s.expires_at>$4
             AND s.last_seen>$4::timestamptz-interval '30 minutes'
             AND s.privilege_epoch=a.session_privilege_epoch
           JOIN identity.registrations g ON g.id=a.registration_id AND g.family_id=a.family_id
             AND g.status='ACTIVE' AND g.privilege_epoch=a.session_privilege_epoch
           JOIN family.consent_projections cp ON cp.family_id=a.family_id
             AND cp.child_id=a.child_id AND cp.purpose='TEXT' AND cp.granted
             AND cp.document_version=$5 AND cp.expires_at>$4
           JOIN family.consent_documents cd ON cd.version=cp.document_version AND cd.expires_at>$4
           JOIN family.representatives r ON r.family_id=a.family_id AND r.policy_version=$5
             AND r.expires_at>$4
           JOIN research.policy_versions p ON p.id=a.policy_version AND p.active
             AND p.kill_epoch=a.kill_epoch
           WHERE a.id=$1 AND a.family_id=$2 AND a.child_id=$3
             AND a.fence=$6 AND a.lease_owner=$7 AND a.status='GENERATING'`,
          [
            claimed.id,
            claimed.family_id,
            claimed.child_id,
            this.clock(),
            POLICY,
            claimed.fence,
            claimed.lease_owner,
          ],
        )
      ).rows[0];
      return row
        ? { allowed: true, ageBand: row.age_band }
        : { allowed: false, code: 'ACCESS_REVOKED' };
    });
  }

  private async commitApproved(
    claimed: ClaimedRun,
    ageBand: AgeBand,
    answer: ReturnType<typeof approveFakeAnswer>['answer'],
    expected: CuratedChallenge,
  ): Promise<void> {
    await this.tenant(claimed.family_id, async (client) => {
      const family = await client.query(
        `SELECT id FROM family.families
         WHERE id=$1 AND status='ACTIVE'
         FOR UPDATE /* research-worker-family-gate */`,
        [claimed.family_id],
      );
      if (family.rowCount !== 1) throw new RunBlockedError('ACCESS_REVOKED');
      const blocked = await this.blockedReason(client, claimed);
      if (blocked) throw new RunBlockedError(blocked);
      const stillAllowed = await this.currentRun(client, claimed);
      if (!stillAllowed) throw new RunBlockedError('ACCESS_REVOKED');
      const version = (
        await client.query<VersionRow>(
          `SELECT * FROM research.challenge_versions
           WHERE key=$1 AND version=$2 AND status='PUBLISHED'
             AND origin='CURATED' AND distribution_scope='CATALOG'
             AND risk_class='MINIMAL_RISK' AND supervision_requirement='NONE'
             AND policy_version=$3`,
          [expected.key, expected.version, RESEARCH_POLICY],
        )
      ).rows[0];
      if (!version || !version.age_bands.includes(ageBand)) throw new Error('OUTPUT_REJECTED');
      const hash = contentHash({
        id: version.id,
        key: version.key,
        version: version.version,
        kind: version.kind,
        title: version.title,
        goal: version.goal,
        durationMinutes: version.duration_minutes,
        ...(version.resume_window_minutes === null
          ? {}
          : { resumeWindowMinutes: version.resume_window_minutes }),
        materials: version.materials,
        steps: version.steps,
        ageBands: version.age_bands,
      });
      if (hash !== version.content_hash) throw new Error('OUTPUT_REJECTED');
      const artifactId = randomUUID();
      const offerId = randomUUID();
      const expiresAt = new Date(this.clock().getTime() + 30 * 60_000);
      const challenge = {
        offerId,
        versionId: version.id,
        version: version.version,
        kind: version.kind,
        title: version.title,
        goal: version.goal,
        durationMinutes: version.duration_minutes,
        materials: version.materials,
        steps: version.steps,
        ageBands: version.age_bands,
        riskClass: version.risk_class,
        supervisionRequirement: version.supervision_requirement,
        contentHash: version.content_hash,
        expiresAt: expiresAt.toISOString(),
      } as const;
      const artifact = approvedArtifactPayload(answer, challenge);
      const encrypted = encryptJson(this.dataKey, {
        explanation: answer.explanation,
        roleNotice: answer.roleNotice,
      });
      await client.query(
        `INSERT INTO research.approved_answer_artifacts(
          id,family_id,child_id,answer_run_id,ciphertext,content_hash,schema_version,
          output_decision,age_band,policy_version
         ) VALUES($1,$2,$3,$4,$5,$6,$7,'ALLOW',$8,$9)`,
        [
          artifactId,
          claimed.family_id,
          claimed.child_id,
          claimed.id,
          encrypted,
          contentHash(artifact),
          answer.schemaVersion,
          ageBand,
          RESEARCH_POLICY,
        ],
      );
      await client.query(
        `INSERT INTO research.challenge_offers(
          id,family_id,child_id,answer_run_id,challenge_version_id,expires_at
         ) VALUES($1,$2,$3,$4,$5,$6)`,
        [offerId, claimed.family_id, claimed.child_id, claimed.id, version.id, expiresAt],
      );
      await client.query(
        `INSERT INTO research.answer_delivery_events(
          family_id,child_id,answer_run_id,sequence,event_type,artifact_id
         ) VALUES($1,$2,$3,2,'ANSWER_APPROVED',$4)`,
        [claimed.family_id, claimed.child_id, claimed.id, artifactId],
      );
      const updated = await client.query(
        `UPDATE research.answer_runs
         SET status='APPROVED',input_ciphertext=NULL,lease_owner=NULL,
             lease_expires_at=NULL,updated_at=$4
         WHERE id=$1 AND fence=$2 AND lease_owner=$3 AND status='GENERATING'`,
        [claimed.id, claimed.fence, claimed.lease_owner, this.clock()],
      );
      if (updated.rowCount !== 1) throw new RunBlockedError('ACCESS_REVOKED');
      await client.query("UPDATE research.outbox SET state='PROCESSED' WHERE id=$1", [
        claimed.outbox_id,
      ]);
    });
  }

  private async currentRun(client: PoolClient, claimed: ClaimedRun) {
    const result = await client.query(
      `SELECT 1
       FROM research.answer_runs a
       JOIN family.families f ON f.id=a.family_id AND f.status='ACTIVE'
         AND f.access_epoch=a.access_epoch
       JOIN family.children c ON c.family_id=a.family_id AND c.id=a.child_id
         AND c.status='ACTIVE' AND c.access_epoch=a.child_access_epoch
       JOIN identity.sessions s ON s.id=a.session_id AND s.mode='CHILD'
         AND s.family_id=a.family_id AND s.child_id=a.child_id
         AND s.registration_id=a.registration_id AND s.revoked_at IS NULL
         AND s.expires_at>$4 AND s.last_seen>$4::timestamptz-interval '30 minutes'
         AND s.privilege_epoch=a.session_privilege_epoch
       JOIN identity.registrations g ON g.id=a.registration_id AND g.family_id=a.family_id
         AND g.status='ACTIVE' AND g.privilege_epoch=a.session_privilege_epoch
       JOIN family.consent_projections cp ON cp.family_id=a.family_id
         AND cp.child_id=a.child_id AND cp.purpose='TEXT' AND cp.granted
         AND cp.document_version=$5 AND cp.expires_at>$4
       JOIN family.consent_documents cd ON cd.version=cp.document_version AND cd.expires_at>$4
       JOIN family.representatives r ON r.family_id=a.family_id AND r.policy_version=$5
         AND r.expires_at>$4
       JOIN research.policy_versions p ON p.id=a.policy_version AND p.active
         AND p.kill_epoch=a.kill_epoch
       WHERE a.id=$1 AND a.family_id=$2 AND a.child_id=$3
         AND a.fence=$6 AND a.lease_owner=$7 AND a.status='GENERATING'
       FOR UPDATE OF a`,
      [
        claimed.id,
        claimed.family_id,
        claimed.child_id,
        this.clock(),
        POLICY,
        claimed.fence,
        claimed.lease_owner,
      ],
    );
    return result.rowCount === 1;
  }

  private async blockedReason(
    client: PoolClient,
    claimed: ClaimedRun,
  ): Promise<RunBlockReason | undefined> {
    const row = (
      await client.query<{ active: boolean; run_kill_epoch: number; current_kill_epoch: number }>(
        `SELECT p.policy_active active,a.kill_epoch run_kill_epoch,
                p.current_kill_epoch
         FROM research.answer_runs a
         JOIN LATERAL research.lock_policy_version(a.policy_version) p ON true
         WHERE a.id=$1 AND a.family_id=$2 AND a.child_id=$3
           AND a.fence=$4 AND a.lease_owner=$5 AND a.status='GENERATING'`,
        [claimed.id, claimed.family_id, claimed.child_id, claimed.fence, claimed.lease_owner],
      )
    ).rows[0];
    if (!row) return 'ACCESS_REVOKED';
    if (row.run_kill_epoch !== row.current_kill_epoch) return 'KILLED';
    if (!row.active) return 'PAUSED';
    return undefined;
  }

  private async deferForPolicyPause(claimed: ClaimedRun): Promise<void> {
    await this.tenant(claimed.family_id, async (client) => {
      const policy = await this.blockedReason(client, claimed);
      if (policy === 'ACCESS_REVOKED') return;
      if (policy === 'KILLED') {
        await this.failRun(client, claimed, 'KILLED');
        return;
      }
      const updated = await client.query(
        `UPDATE research.answer_runs
         SET status='QUEUED',lease_owner=NULL,lease_expires_at=NULL,updated_at=$4
         WHERE id=$1 AND family_id=$2 AND child_id=$3 AND fence=$5 AND lease_owner=$6
           AND status='GENERATING'`,
        [
          claimed.id,
          claimed.family_id,
          claimed.child_id,
          this.clock(),
          claimed.fence,
          claimed.lease_owner,
        ],
      );
      if (updated.rowCount !== 1) return;
      await client.query(
        "UPDATE research.outbox SET state='PENDING' WHERE id=$1 AND state='PROCESSING'",
        [claimed.outbox_id],
      );
    });
  }

  private async fail(claimed: ClaimedRun, code: WorkerFailure): Promise<void> {
    await this.tenant(claimed.family_id, async (client) => {
      await this.failRun(client, claimed, code);
    });
  }

  private async failRun(
    client: PoolClient,
    claimed: ClaimedRun,
    code: WorkerFailure,
  ): Promise<void> {
    const updated = await client.query(
      `UPDATE research.answer_runs
       SET status='FAILED_SAFE',failure_code=$2,input_ciphertext=NULL,
           lease_owner=NULL,lease_expires_at=NULL,updated_at=$5
       WHERE id=$1 AND family_id=$3 AND child_id=$4 AND fence=$6 AND lease_owner=$7
         AND status='GENERATING'`,
      [
        claimed.id,
        code,
        claimed.family_id,
        claimed.child_id,
        this.clock(),
        claimed.fence,
        claimed.lease_owner,
      ],
    );
    if (updated.rowCount !== 1) return;
    await client.query(
      `INSERT INTO research.answer_delivery_events(
        family_id,child_id,answer_run_id,sequence,event_type
       ) VALUES($1,$2,$3,2,'TERMINAL') ON CONFLICT DO NOTHING`,
      [claimed.family_id, claimed.child_id, claimed.id],
    );
    await client.query(
      "UPDATE research.outbox SET state='DEAD' WHERE id=$1 AND state<>'PROCESSED'",
      [claimed.outbox_id],
    );
  }

  private async tenant<T>(familyId: string, run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE probyu_family_runtime');
      await client.query("SET LOCAL statement_timeout='5s'");
      await client.query("SELECT set_config('app.family_id',$1,true)", [familyId]);
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
