import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import type {
  ApprovedResearchAnswer,
  ResearchAnswerRun,
  ResearchChallenge,
  ResearchChallengeCommand,
  ResearchChallengeRun,
  ResearchCurrentAnswer,
  ResearchOfferCommand,
} from '@probyu/contracts/types';

import type { Context, FamilyService } from '../family/service.js';
import { AccessError } from '../family/policy.js';
import {
  ANSWER_SCHEMA_VERSION,
  FAKE_ADAPTER_VERSION,
  LEGACY_ANSWER_SCHEMA_VERSION,
  RESEARCH_POLICY,
  contentHash,
} from './content.js';
import {
  decryptJson,
  encryptJson,
  normalizeQuestion,
  questionDecision,
  requestHash,
  type AgeBand,
  type FakeAnswer,
} from './runtime.js';

type AnswerRow = QueryResultRow & {
  id: string;
  family_id: string;
  child_id: string;
  status: ResearchAnswerRun['status'];
  failure_code: ResearchAnswerRun['failureCode'] | null;
  created_at: Date;
  updated_at: Date;
  access_epoch: number;
  child_access_epoch: number;
  kill_epoch: number;
  artifact_ciphertext: string | null;
  artifact_content_hash: string | null;
  artifact_schema_version: string | null;
  offer_id: string | null;
  offer_expires_at: Date | null;
  challenge_version_id: string | null;
  challenge_key: string | null;
  challenge_version: number | null;
  challenge_kind: ResearchChallenge['kind'] | null;
  challenge_title: string | null;
  challenge_goal: string | null;
  duration_minutes: number | null;
  materials: string[] | null;
  steps: string[] | null;
  age_bands: AgeBand[] | null;
  risk_class: ResearchChallenge['riskClass'] | null;
  supervision_requirement: ResearchChallenge['supervisionRequirement'] | null;
  challenge_content_hash: string | null;
  resume_window_minutes: number | null;
  policy_active: boolean;
  current_kill_epoch: number;
};

type ChallengeRunRow = QueryResultRow & {
  id: string;
  family_id: string;
  child_id: string;
  answer_run_id: string;
  offer_id: string;
  challenge_version_id: string;
  status: ResearchChallengeRun['status'];
  current_step: number;
  paused_at: Date | null;
  expires_at: Date;
  offer_expires_at: Date;
  row_version: number;
  challenge_version: number;
  key: string;
  kind: ResearchChallenge['kind'];
  title: string;
  goal: string;
  duration_minutes: number;
  resume_window_minutes: number | null;
  materials: string[];
  steps: string[];
  age_bands: AgeBand[];
  risk_class: ResearchChallenge['riskClass'];
  supervision_requirement: ResearchChallenge['supervisionRequirement'];
  content_hash: string;
  answer_kill_epoch: number;
  current_kill_epoch: number;
  policy_active: boolean;
};

type AnswerMetadataRow = QueryResultRow & {
  id: string;
  status: ResearchAnswerRun['status'];
  failure_code: ResearchAnswerRun['failureCode'] | null;
  created_at: Date;
  updated_at: Date;
};

type ChallengePolicyState = Pick<
  ChallengeRunRow,
  'policy_active' | 'current_kill_epoch' | 'answer_kill_epoch'
>;

function challengePolicyDisposition(row: ChallengePolicyState): 'ACTIVE' | 'PAUSED' | 'KILLED' {
  if (row.current_kill_epoch !== row.answer_kill_epoch) return 'KILLED';
  return row.policy_active ? 'ACTIVE' : 'PAUSED';
}

export type ResearchConfig = {
  mode: 'fake';
  environment: 'development' | 'test';
  dataKey: string;
};

export class ResearchService {
  readonly dataKey: Buffer;
  constructor(
    readonly family: FamilyService,
    readonly config: ResearchConfig,
  ) {
    if (
      config.mode !== 'fake' ||
      !['development', 'test'].includes(config.environment) ||
      !/^[a-f0-9]{64}$/.test(config.dataKey)
    )
      throw new Error('Synthetic research configuration rejected.');
    this.dataKey = Buffer.from(config.dataKey, 'hex');
  }

  async createQuestion(token: string, rawQuestion: string, idempotencyKey: string) {
    const question = normalizeQuestion(rawQuestion);
    const hash = requestHash(this.dataKey, question);
    return this.family.context(token, async (ctx) => {
      const childId = this.childId(ctx);
      await this.family.guardChild(ctx, childId, 'TEXT');
      const prior = (
        await ctx.client.query<{ id: string; request_hash: string }>(
          `SELECT id,request_hash FROM research.answer_runs
           WHERE family_id=$1 AND child_id=$2 AND idempotency_key=$3`,
          [ctx.session.family_id, childId, idempotencyKey],
        )
      ).rows[0];
      if (prior) {
        if (prior.request_hash !== hash) throw new AccessError('CONFLICT', 409);
        return { created: false, view: await this.answerView(ctx, prior.id) };
      }
      const active = await ctx.client.query<{ id: string; request_hash: string }>(
        `SELECT a.id,a.request_hash FROM research.answer_runs a
         JOIN research.policy_versions p ON p.id=a.policy_version
           AND p.active AND p.kill_epoch=a.kill_epoch
         LEFT JOIN research.challenge_offers o ON o.answer_run_id=a.id
           AND o.family_id=a.family_id AND o.child_id=a.child_id
         LEFT JOIN research.challenge_runs r ON r.offer_id=o.id
           AND r.family_id=a.family_id AND r.child_id=a.child_id
         LEFT JOIN research.challenge_versions v ON v.id=r.challenge_version_id
         WHERE a.family_id=$1 AND a.child_id=$2
           AND (
             a.status=ANY(ARRAY['RECEIVED','INPUT_APPROVED','QUEUED','GENERATING','OUTPUT_VALIDATING'])
             OR (a.status=ANY(ARRAY['APPROVED','DELIVERING','COMPLETED']) AND (
               (r.id IS NULL AND o.expires_at>$3)
               OR (r.status='IN_PROGRESS' AND r.expires_at>$3
                 AND r.current_step<jsonb_array_length(v.steps))
             ))
           )
         ORDER BY a.updated_at DESC LIMIT 1`,
        [ctx.session.family_id, childId, ctx.now],
      );
      if (active.rows[0]) {
        if (active.rows[0].request_hash !== hash) throw new AccessError('CONFLICT', 409);
        return { created: false, view: await this.answerView(ctx, active.rows[0].id) };
      }
      const scope = (
        await ctx.client.query<{
          family_epoch: number;
          child_epoch: number;
          kill_epoch: number;
        }>(
          `SELECT f.access_epoch family_epoch,c.access_epoch child_epoch,
                  p.current_kill_epoch kill_epoch
           FROM family.families f
           JOIN family.children c ON c.family_id=f.id AND c.id=$2
           JOIN LATERAL research.lock_policy_version($3) p ON p.policy_active
           WHERE f.id=$1 AND f.status='ACTIVE' AND c.status='ACTIVE'`,
          [ctx.session.family_id, childId, RESEARCH_POLICY],
        )
      ).rows[0];
      if (!scope) throw new AccessError('UNAVAILABLE', 503);
      const id = randomUUID();
      await ctx.client.query(
        `INSERT INTO research.answer_runs(
          id,family_id,child_id,session_id,registration_id,idempotency_key,request_hash,
          status,access_epoch,child_access_epoch,session_privilege_epoch,policy_version,
          kill_epoch,adapter_version
         ) VALUES($1,$2,$3,$4,$5,$6,$7,'RECEIVED',$8,$9,$10,$11,$12,$13)`,
        [
          id,
          ctx.session.family_id,
          childId,
          ctx.session.id,
          ctx.session.registration_id,
          idempotencyKey,
          hash,
          scope.family_epoch,
          scope.child_epoch,
          ctx.session.privilege_epoch,
          RESEARCH_POLICY,
          scope.kill_epoch,
          FAKE_ADAPTER_VERSION,
        ],
      );
      const decision = questionDecision(question);
      if (decision.action === 'BLOCK') {
        await ctx.client.query(
          `UPDATE research.answer_runs
           SET status='DENIED',safety_action='BLOCK',failure_code=$2,updated_at=$3
           WHERE id=$1`,
          [id, decision.code, ctx.now],
        );
        await ctx.client.query(
          `INSERT INTO research.answer_delivery_events(
            family_id,child_id,answer_run_id,sequence,event_type
           ) VALUES($1,$2,$3,1,'TERMINAL')`,
          [ctx.session.family_id, childId, id],
        );
      } else {
        await ctx.client.query(
          `UPDATE research.answer_runs
           SET input_ciphertext=$2,input_hash=$3,status='QUEUED',safety_action='ALLOW',updated_at=$4
           WHERE id=$1`,
          [id, encryptJson(this.dataKey, decision.sanitized), hash, ctx.now],
        );
        await ctx.client.query(
          `INSERT INTO research.answer_delivery_events(
            family_id,child_id,answer_run_id,sequence,event_type
           ) VALUES($1,$2,$3,1,'QUESTION_ACCEPTED')`,
          [ctx.session.family_id, childId, id],
        );
        await ctx.client.query(
          `INSERT INTO research.outbox(id,family_id,child_id,answer_run_id,event_type)
           VALUES($1,$2,$3,$4,'GENERATE_ANSWER')`,
          [randomUUID(), ctx.session.family_id, childId, id],
        );
      }
      await ctx.client.query('UPDATE identity.sessions SET last_seen=$2 WHERE id=$1', [
        ctx.session.id,
        ctx.now,
      ]);
      return { created: decision.action === 'ALLOW', view: await this.answerView(ctx, id) };
    });
  }

  async getAnswer(token: string, answerRunId: string): Promise<ResearchAnswerRun> {
    return this.family.context(token, async (ctx) => {
      await this.family.guardChild(ctx, this.childId(ctx), 'TEXT');
      return this.answerView(ctx, answerRunId);
    });
  }

  async currentAnswer(token: string): Promise<ResearchCurrentAnswer> {
    return this.family.context(token, async (ctx) => {
      const childId = this.childId(ctx);
      await this.family.guardChild(ctx, childId, 'TEXT');
      const row = (
        await ctx.client.query<{ id: string }>(
          `SELECT a.id
           FROM research.answer_runs a
           JOIN research.policy_versions p ON p.id=a.policy_version
             AND p.active AND p.kill_epoch=a.kill_epoch
           LEFT JOIN research.challenge_offers o ON o.answer_run_id=a.id
             AND o.family_id=a.family_id AND o.child_id=a.child_id
           LEFT JOIN research.challenge_runs r ON r.offer_id=o.id
             AND r.family_id=a.family_id AND r.child_id=a.child_id
           LEFT JOIN research.challenge_versions v ON v.id=r.challenge_version_id
           WHERE a.family_id=$1 AND a.child_id=$2
             AND (
               a.status=ANY(ARRAY['RECEIVED','INPUT_APPROVED','QUEUED','GENERATING','OUTPUT_VALIDATING'])
               OR (a.status=ANY(ARRAY['APPROVED','DELIVERING','COMPLETED']) AND (
                 (r.id IS NULL AND o.expires_at>$3)
                 OR (r.status='IN_PROGRESS' AND r.expires_at>$3
                   AND r.current_step<jsonb_array_length(v.steps))
               ))
             )
           ORDER BY a.updated_at DESC LIMIT 1`,
          [ctx.session.family_id, childId, ctx.now],
        )
      ).rows[0];
      return row ? { answer: await this.answerView(ctx, row.id) } : {};
    });
  }

  async answerEvents(token: string, answerRunId: string, cursor: number) {
    return this.family.context(token, async (ctx) => {
      await this.family.guardChild(ctx, this.childId(ctx), 'TEXT');
      const view = await this.answerView(ctx, answerRunId);
      const result = await ctx.client.query<{ sequence: number }>(
        `SELECT sequence FROM research.answer_delivery_events
         WHERE family_id=$1 AND child_id=$2 AND answer_run_id=$3 AND sequence>$4
         ORDER BY sequence`,
        [ctx.session.family_id, ctx.session.child_id, answerRunId, cursor],
      );
      return { view, sequences: result.rows.map((row) => row.sequence) };
    });
  }

  async completeDelivery(token: string, answerRunId: string): Promise<void> {
    await this.family.context(token, async (ctx) => {
      await this.family.guardChild(ctx, this.childId(ctx), 'TEXT');
      const policyDisposition = challengePolicyDisposition(
        await this.answerPolicyState(ctx, answerRunId),
      );
      if (policyDisposition !== 'ACTIVE') return;
      const updated = await ctx.client.query(
        `UPDATE research.answer_runs a SET status='COMPLETED',updated_at=$4
         WHERE a.id=$1 AND a.family_id=$2 AND a.child_id=$3
           AND a.status=ANY(ARRAY['APPROVED','DELIVERING'])`,
        [answerRunId, ctx.session.family_id, ctx.session.child_id, ctx.now],
      );
      if (updated.rowCount) {
        await ctx.client.query(
          `INSERT INTO research.answer_delivery_events(
            family_id,child_id,answer_run_id,sequence,event_type
           ) VALUES($1,$2,$3,3,'ANSWER_COMPLETED') ON CONFLICT DO NOTHING`,
          [ctx.session.family_id, ctx.session.child_id, answerRunId],
        );
      }
    });
  }

  async cancelAnswer(token: string, answerRunId: string, commandKey: string) {
    return this.family.context(token, async (ctx) => {
      const childId = this.childId(ctx);
      await this.family.guardChild(ctx, childId, 'TEXT');
      const actionHash = contentHash({ action: 'CANCEL_ANSWER', answerRunId });
      if (challengePolicyDisposition(await this.answerPolicyState(ctx, answerRunId)) === 'PAUSED')
        throw new AccessError('FORBIDDEN');
      const prior = await this.priorCommand(ctx.client, ctx, commandKey, actionHash);
      if (prior) return this.cancelAnswerView(ctx, answerRunId);
      const row = await ctx.client.query(
        `UPDATE research.answer_runs a
         SET status='CANCELLED',failure_code='CANCELLED',cancelled_at=$4,updated_at=$4
         WHERE a.id=$1 AND a.family_id=$2 AND a.child_id=$3
           AND a.status=ANY(ARRAY['RECEIVED','INPUT_APPROVED','QUEUED','GENERATING','OUTPUT_VALIDATING','APPROVED','DELIVERING'])
           AND NOT EXISTS (
             SELECT 1 FROM research.challenge_runs r
             WHERE r.answer_run_id=a.id AND r.family_id=a.family_id AND r.child_id=a.child_id
           )`,
        [answerRunId, ctx.session.family_id, childId, ctx.now],
      );
      if (!row.rowCount) {
        const view = await this.cancelAnswerView(ctx, answerRunId);
        await this.saveCommand(ctx.client, ctx, commandKey, actionHash, {
          kind: 'answer',
          id: answerRunId,
        });
        return view;
      }
      await ctx.client.query(
        `UPDATE research.outbox SET state='DEAD'
         WHERE answer_run_id=$1 AND family_id=$2 AND child_id=$3 AND state<>'PROCESSED'`,
        [answerRunId, ctx.session.family_id, childId],
      );
      await ctx.client.query(
        `INSERT INTO research.answer_delivery_events(
          family_id,child_id,answer_run_id,sequence,event_type
         )
         SELECT $1,$2,$3,COALESCE(MAX(sequence),0)+1,'TERMINAL'
         FROM research.answer_delivery_events WHERE answer_run_id=$3`,
        [ctx.session.family_id, childId, answerRunId],
      );
      await this.saveCommand(ctx.client, ctx, commandKey, actionHash, {
        kind: 'answer',
        id: answerRunId,
      });
      return this.answerMetadataView(ctx, answerRunId);
    });
  }

  async offerCommand(
    token: string,
    offerId: string,
    action: ResearchOfferCommand['action'],
    commandKey: string,
  ): Promise<ResearchChallengeRun> {
    if (action !== 'START' && action !== 'DECLINE') throw new AccessError('INVALID_REQUEST', 400);
    return this.family.context(token, async (ctx) => {
      const childId = this.childId(ctx);
      await this.family.guardChild(ctx, childId, 'TEXT');
      const actionHash = contentHash({ action, offerId });
      const offer = (
        await ctx.client.query<{
          answer_run_id: string;
          challenge_version_id: string;
          expires_at: Date;
          answer_kill_epoch: number;
          current_kill_epoch: number;
          policy_active: boolean;
          duration_minutes: number;
          resume_window_minutes: number | null;
          challenge_run_id: string | null;
        }>(
          `SELECT o.answer_run_id,o.challenge_version_id,o.expires_at,
                  a.kill_epoch answer_kill_epoch,p.current_kill_epoch,
                  p.policy_active,
                  v.duration_minutes,v.resume_window_minutes,
                  r.id challenge_run_id
           FROM research.challenge_offers o
           JOIN research.answer_runs a ON a.id=o.answer_run_id
             AND a.family_id=o.family_id AND a.child_id=o.child_id
             AND a.status=ANY(ARRAY['APPROVED','DELIVERING','COMPLETED'])
           JOIN family.families f ON f.id=a.family_id AND f.status='ACTIVE'
           JOIN family.children c ON c.family_id=a.family_id AND c.id=a.child_id
             AND c.status='ACTIVE'
           JOIN LATERAL research.lock_policy_version(a.policy_version) p ON true
           JOIN research.challenge_versions v ON v.id=o.challenge_version_id
           LEFT JOIN research.challenge_runs r ON r.offer_id=o.id
             AND r.family_id=o.family_id AND r.child_id=o.child_id
           WHERE o.id=$1 AND o.family_id=$2 AND o.child_id=$3`,
          [offerId, ctx.session.family_id, childId],
        )
      ).rows[0];
      if (!offer) throw new AccessError('NOT_FOUND', 404);
      const policyDisposition = challengePolicyDisposition(offer);
      if (policyDisposition === 'PAUSED') throw new AccessError('FORBIDDEN');
      const prior = await this.priorCommand(ctx.client, ctx, commandKey, actionHash);
      if (prior) return this.reconcileChallenge(ctx, String(prior.id));
      if (offer.challenge_run_id) {
        const reconciled = await this.reconcileChallenge(ctx, offer.challenge_run_id);
        if (['BLOCKED_BY_POLICY', 'EXPIRED'].includes(reconciled.status)) {
          await this.saveCommand(ctx.client, ctx, commandKey, actionHash, {
            kind: 'challenge',
            id: offer.challenge_run_id,
          });
          return reconciled;
        }
        const sameOutcome =
          (action === 'START' && reconciled.status === 'IN_PROGRESS') ||
          (action === 'DECLINE' && reconciled.status === 'DECLINED');
        if (!sameOutcome) throw new AccessError('CONFLICT', 409);
        await this.saveCommand(ctx.client, ctx, commandKey, actionHash, {
          kind: 'challenge',
          id: offer.challenge_run_id,
        });
        return reconciled;
      }
      if (policyDisposition !== 'ACTIVE') throw new AccessError('FORBIDDEN');
      if (action === 'START' && offer.expires_at <= ctx.now)
        throw new AccessError('OFFER_EXPIRED', 410);
      const id = randomUUID();
      const runWindowMinutes =
        offer.resume_window_minutes ?? Math.max(offer.duration_minutes + 10, 30);
      const runExpiresAt = new Date(ctx.now.getTime() + runWindowMinutes * 60_000);
      await ctx.client.query(
        `INSERT INTO research.challenge_runs(
          id,family_id,child_id,answer_run_id,offer_id,challenge_version_id,status,expires_at
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          id,
          ctx.session.family_id,
          childId,
          offer.answer_run_id,
          offerId,
          offer.challenge_version_id,
          action === 'START' ? 'IN_PROGRESS' : 'DECLINED',
          runExpiresAt,
        ],
      );
      await this.saveCommand(ctx.client, ctx, commandKey, actionHash, {
        kind: 'challenge',
        id,
      });
      await this.touchSession(ctx);
      return this.challengeView(ctx, id);
    });
  }

  async challengeCommand(
    token: string,
    challengeRunId: string,
    action: ResearchChallengeCommand['action'],
    commandKey: string,
    expectedVersion: number,
  ): Promise<ResearchChallengeRun> {
    if (!['NEXT', 'PAUSE', 'RESUME', 'CANCEL'].includes(action))
      throw new AccessError('INVALID_REQUEST', 400);
    return this.family.context(token, async (ctx) => {
      const childId = this.childId(ctx);
      await this.family.guardChild(ctx, childId, 'TEXT');
      const actionHash = contentHash({ action, challengeRunId, expectedVersion });
      const row = await this.challengeRow(ctx, challengeRunId, true);
      const policyDisposition = challengePolicyDisposition(row);
      if (policyDisposition === 'PAUSED') throw new AccessError('FORBIDDEN');
      const prior = await this.priorCommand(ctx.client, ctx, commandKey, actionHash);
      if (prior) return this.reconcileChallenge(ctx, String(prior.id));
      if (row.status !== 'IN_PROGRESS') {
        if (action === 'CANCEL' && row.status === 'ABANDONED') {
          await this.saveCommand(ctx.client, ctx, commandKey, actionHash, {
            kind: 'challenge',
            id: challengeRunId,
          });
          await this.touchSession(ctx);
          return this.challengeView(ctx, challengeRunId);
        }
        throw new AccessError('CONFLICT', 409);
      }
      if (policyDisposition === 'KILLED') {
        await ctx.client.query(
          `UPDATE research.challenge_runs
           SET status='BLOCKED_BY_POLICY',row_version=row_version+1,paused_at=NULL,updated_at=$2
           WHERE id=$1 AND status='IN_PROGRESS' AND row_version=$3`,
          [challengeRunId, ctx.now, row.row_version],
        );
        await this.saveCommand(ctx.client, ctx, commandKey, actionHash, {
          kind: 'challenge',
          id: challengeRunId,
        });
        await this.touchSession(ctx);
        return this.challengeView(ctx, challengeRunId);
      }
      if (row.expires_at <= ctx.now) {
        await ctx.client.query(
          `UPDATE research.challenge_runs
           SET status='EXPIRED',row_version=row_version+1,paused_at=NULL,updated_at=$2
           WHERE id=$1 AND status='IN_PROGRESS' AND row_version=$3`,
          [challengeRunId, ctx.now, row.row_version],
        );
        await this.saveCommand(ctx.client, ctx, commandKey, actionHash, {
          kind: 'challenge',
          id: challengeRunId,
        });
        await this.touchSession(ctx);
        return this.challengeView(ctx, challengeRunId);
      }
      if (row.row_version !== expectedVersion) throw new AccessError('CONFLICT', 409);
      const total = row.steps.length;
      let updated;
      if (action === 'NEXT') {
        if (row.paused_at) throw new AccessError('CONFLICT', 409);
        updated = await ctx.client.query(
          `UPDATE research.challenge_runs
           SET current_step=LEAST(current_step+1,$2),row_version=row_version+1,updated_at=$3
           WHERE id=$1 AND status='IN_PROGRESS' AND row_version=$4`,
          [challengeRunId, total, ctx.now, expectedVersion],
        );
      } else if (action === 'PAUSE') {
        if (row.paused_at) throw new AccessError('CONFLICT', 409);
        updated = await ctx.client.query(
          `UPDATE research.challenge_runs SET paused_at=$2,row_version=row_version+1,updated_at=$2
           WHERE id=$1 AND status='IN_PROGRESS' AND row_version=$3`,
          [challengeRunId, ctx.now, expectedVersion],
        );
      } else if (action === 'RESUME') {
        if (!row.paused_at) throw new AccessError('CONFLICT', 409);
        updated = await ctx.client.query(
          `UPDATE research.challenge_runs SET paused_at=NULL,row_version=row_version+1,updated_at=$2
           WHERE id=$1 AND status='IN_PROGRESS' AND row_version=$3`,
          [challengeRunId, ctx.now, expectedVersion],
        );
      } else {
        updated = await ctx.client.query(
          `UPDATE research.challenge_runs
           SET status='ABANDONED',row_version=row_version+1,paused_at=NULL,updated_at=$2
           WHERE id=$1 AND status='IN_PROGRESS' AND row_version=$3`,
          [challengeRunId, ctx.now, expectedVersion],
        );
      }
      if (updated.rowCount !== 1) throw new AccessError('CONFLICT', 409);
      await this.saveCommand(ctx.client, ctx, commandKey, actionHash, {
        kind: 'challenge',
        id: challengeRunId,
      });
      await this.touchSession(ctx);
      return this.challengeView(ctx, challengeRunId);
    });
  }

  private childId(ctx: Context): string {
    if (!ctx.session.child_id) throw new AccessError('FORBIDDEN');
    return ctx.session.child_id;
  }

  private async answerMetadataView(ctx: Context, answerRunId: string): Promise<ResearchAnswerRun> {
    const row = (
      await ctx.client.query<AnswerMetadataRow>(
        `SELECT a.id,a.status,a.failure_code,a.created_at,a.updated_at
         FROM research.answer_runs a
         WHERE a.id=$1 AND a.family_id=$2 AND a.child_id=$3`,
        [answerRunId, ctx.session.family_id, ctx.session.child_id],
      )
    ).rows[0];
    if (!row) throw new AccessError('NOT_FOUND', 404);
    return {
      id: row.id,
      status: row.status,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      ...(row.failure_code ? { failureCode: row.failure_code } : {}),
    };
  }

  private async cancelAnswerView(ctx: Context, answerRunId: string): Promise<ResearchAnswerRun> {
    return this.answerMetadataView(ctx, answerRunId);
  }

  private async answerPolicyState(
    ctx: Context,
    answerRunId: string,
  ): Promise<ChallengePolicyState> {
    const row = (
      await ctx.client.query<ChallengePolicyState>(
        `SELECT a.kill_epoch answer_kill_epoch,p.current_kill_epoch,
                p.policy_active
         FROM research.answer_runs a
         JOIN LATERAL research.lock_policy_version(a.policy_version) p ON true
         WHERE a.id=$1 AND a.family_id=$2 AND a.child_id=$3`,
        [answerRunId, ctx.session.family_id, ctx.session.child_id],
      )
    ).rows[0];
    if (!row) throw new AccessError('NOT_FOUND', 404);
    return row;
  }

  private async answerView(ctx: Context, answerRunId: string): Promise<ResearchAnswerRun> {
    const row = (
      await ctx.client.query<AnswerRow>(
        `SELECT a.*,
          x.ciphertext artifact_ciphertext,x.content_hash artifact_content_hash,
          x.schema_version artifact_schema_version,
          o.id offer_id,o.expires_at offer_expires_at,
          v.id challenge_version_id,v.key challenge_key,v.version challenge_version,
          v.kind challenge_kind,v.title challenge_title,v.goal challenge_goal,
          v.duration_minutes,v.resume_window_minutes,v.materials,v.steps,v.age_bands,
          v.risk_class,v.supervision_requirement,
          v.content_hash challenge_content_hash,
          p.policy_active,p.current_kill_epoch
         FROM research.answer_runs a
         JOIN family.families f ON f.id=a.family_id AND f.status='ACTIVE'
         JOIN family.children c ON c.family_id=a.family_id AND c.id=a.child_id
           AND c.status='ACTIVE'
         JOIN LATERAL research.lock_policy_version(a.policy_version) p ON true
         LEFT JOIN research.approved_answer_artifacts x ON x.answer_run_id=a.id
         LEFT JOIN research.challenge_offers o ON o.answer_run_id=a.id
         LEFT JOIN research.challenge_versions v ON v.id=o.challenge_version_id
         WHERE a.id=$1 AND a.family_id=$2 AND a.child_id=$3`,
        [answerRunId, ctx.session.family_id, ctx.session.child_id],
      )
    ).rows[0];
    if (!row) throw new AccessError('NOT_FOUND', 404);
    if (!row.policy_active || row.current_kill_epoch !== row.kill_epoch)
      throw new AccessError('FORBIDDEN');
    const view: ResearchAnswerRun = {
      id: row.id,
      status: row.status,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      ...(row.failure_code ? { failureCode: row.failure_code } : {}),
    };
    if (row.artifact_ciphertext && ['APPROVED', 'DELIVERING', 'COMPLETED'].includes(row.status)) {
      if (
        ![ANSWER_SCHEMA_VERSION, LEGACY_ANSWER_SCHEMA_VERSION].includes(
          row.artifact_schema_version ?? '',
        ) ||
        !row.offer_id ||
        !row.offer_expires_at ||
        !row.challenge_version_id ||
        !row.challenge_key ||
        !row.challenge_version ||
        !row.challenge_kind ||
        !row.challenge_title ||
        !row.challenge_goal ||
        !row.duration_minutes ||
        !row.materials ||
        !row.steps ||
        !row.age_bands ||
        !row.risk_class ||
        !row.supervision_requirement ||
        !row.challenge_content_hash
      )
        throw new AccessError('UNAVAILABLE', 503);
      const challenge = this.challengeFromAnswer(row);
      const storedHash = contentHash({
        id: row.challenge_version_id,
        key: row.challenge_key,
        version: row.challenge_version,
        kind: row.challenge_kind,
        title: row.challenge_title,
        goal: row.challenge_goal,
        durationMinutes: row.duration_minutes,
        ...(row.resume_window_minutes === null
          ? {}
          : { resumeWindowMinutes: row.resume_window_minutes }),
        materials: row.materials,
        steps: row.steps,
        ageBands: row.age_bands,
      });
      if (storedHash !== row.challenge_content_hash) throw new AccessError('UNAVAILABLE', 503);
      const payload = decryptJson<Pick<FakeAnswer, 'explanation' | 'roleNotice'>>(
        this.dataKey,
        row.artifact_ciphertext,
      );
      const answer: ApprovedResearchAnswer = { ...payload, challenge };
      const currentHashMatches =
        row.artifact_schema_version === ANSWER_SCHEMA_VERSION &&
        row.challenge_version >= 2 &&
        row.resume_window_minutes !== null &&
        contentHash(answer) === row.artifact_content_hash;
      const recentV1HashMatches =
        row.artifact_schema_version === LEGACY_ANSWER_SCHEMA_VERSION &&
        row.challenge_version === 1 &&
        row.resume_window_minutes === null &&
        contentHash(answer) === row.artifact_content_hash;
      const legacyHashMatches =
        row.artifact_schema_version === LEGACY_ANSWER_SCHEMA_VERSION &&
        row.challenge_version === 1 &&
        row.resume_window_minutes === null &&
        contentHash({ ...payload, challenge: this.legacyChallengeFromAnswer(row) }) ===
          row.artifact_content_hash;
      if (!currentHashMatches && !recentV1HashMatches && !legacyHashMatches)
        throw new AccessError('UNAVAILABLE', 503);
      const challengeRun = (
        await ctx.client.query<{ id: string }>(
          `SELECT id FROM research.challenge_runs
           WHERE family_id=$1 AND child_id=$2 AND offer_id=$3`,
          [ctx.session.family_id, ctx.session.child_id, row.offer_id],
        )
      ).rows[0];
      if (challengeRun) view.challengeRun = await this.challengeView(ctx, challengeRun.id);
      else view.answer = answer;
    }
    return view;
  }

  private challengeFromAnswer(row: AnswerRow): ResearchChallenge {
    return {
      offerId: row.offer_id!,
      versionId: row.challenge_version_id!,
      version: row.challenge_version!,
      kind: row.challenge_kind!,
      title: row.challenge_title!,
      goal: row.challenge_goal!,
      durationMinutes: row.duration_minutes!,
      materials: row.materials!,
      steps: row.steps!,
      ageBands: row.age_bands!,
      riskClass: row.risk_class!,
      supervisionRequirement: row.supervision_requirement!,
      contentHash: row.challenge_content_hash!,
      expiresAt: row.offer_expires_at!.toISOString(),
    };
  }

  private legacyChallengeFromAnswer(row: AnswerRow) {
    return {
      offerId: row.offer_id!,
      versionId: row.challenge_version_id!,
      version: row.challenge_version!,
      kind: row.challenge_kind!,
      title: row.challenge_title!,
      goal: row.challenge_goal!,
      durationMinutes: row.duration_minutes!,
      materials: row.materials!,
      steps: row.steps!,
      contentHash: row.challenge_content_hash!,
      expiresAt: row.offer_expires_at!.toISOString(),
    };
  }

  private async challengeRow(
    ctx: Context,
    challengeRunId: string,
    lock = false,
  ): Promise<ChallengeRunRow> {
    const row = (
      await ctx.client.query<ChallengeRunRow>(
        `SELECT r.*,o.expires_at offer_expires_at,v.key,v.version challenge_version,v.kind,v.title,v.goal,v.duration_minutes,
                v.resume_window_minutes,v.materials,v.steps,v.age_bands,v.risk_class,v.supervision_requirement,v.content_hash,
                a.kill_epoch answer_kill_epoch,p.current_kill_epoch,
                p.policy_active
         FROM research.challenge_runs r
         JOIN research.challenge_offers o ON o.id=r.offer_id
           AND o.family_id=r.family_id AND o.child_id=r.child_id
         JOIN research.answer_runs a ON a.id=r.answer_run_id
           AND a.family_id=r.family_id AND a.child_id=r.child_id
           AND a.status=ANY(ARRAY['APPROVED','DELIVERING','COMPLETED'])
         JOIN family.families f ON f.id=a.family_id AND f.status='ACTIVE'
         JOIN family.children c ON c.family_id=a.family_id AND c.id=a.child_id
           AND c.status='ACTIVE'
         JOIN research.challenge_versions v ON v.id=r.challenge_version_id
         JOIN LATERAL research.lock_policy_version(a.policy_version) p ON true
         WHERE r.id=$1 AND r.family_id=$2 AND r.child_id=$3 ${lock ? 'FOR UPDATE OF r' : ''}`,
        [challengeRunId, ctx.session.family_id, ctx.session.child_id],
      )
    ).rows[0];
    if (!row) throw new AccessError('NOT_FOUND', 404);
    return row;
  }

  private async reconcileChallenge(
    ctx: Context,
    challengeRunId: string,
  ): Promise<ResearchChallengeRun> {
    const row = await this.challengeRow(ctx, challengeRunId, true);
    if (row.status === 'IN_PROGRESS') {
      const policyDisposition = challengePolicyDisposition(row);
      if (policyDisposition === 'PAUSED') throw new AccessError('FORBIDDEN');
      const reconciledStatus =
        policyDisposition === 'KILLED'
          ? 'BLOCKED_BY_POLICY'
          : policyDisposition === 'ACTIVE' && row.expires_at <= ctx.now
            ? 'EXPIRED'
            : undefined;
      if (reconciledStatus) {
        await ctx.client.query(
          `UPDATE research.challenge_runs
           SET status=$2,row_version=row_version+1,paused_at=NULL,updated_at=$3
           WHERE id=$1 AND status='IN_PROGRESS' AND row_version=$4`,
          [challengeRunId, reconciledStatus, ctx.now, row.row_version],
        );
      }
    }
    await this.touchSession(ctx);
    return this.challengeView(ctx, challengeRunId);
  }

  private async challengeView(ctx: Context, challengeRunId: string): Promise<ResearchChallengeRun> {
    const row = await this.challengeRow(ctx, challengeRunId);
    const storedHash = contentHash({
      id: row.challenge_version_id,
      key: row.key,
      version: row.challenge_version,
      kind: row.kind,
      title: row.title,
      goal: row.goal,
      durationMinutes: row.duration_minutes,
      ...(row.resume_window_minutes === null
        ? {}
        : { resumeWindowMinutes: row.resume_window_minutes }),
      materials: row.materials,
      steps: row.steps,
      ageBands: row.age_bands,
    });
    if (storedHash !== row.content_hash) throw new AccessError('UNAVAILABLE', 503);
    const challenge = {
      versionId: row.challenge_version_id,
      version: row.challenge_version,
      kind: row.kind,
      title: row.title,
      goal: row.goal,
      durationMinutes: row.duration_minutes,
      ageBands: row.age_bands,
      riskClass: row.risk_class,
      supervisionRequirement: row.supervision_requirement,
      contentHash: row.content_hash,
    };
    const status =
      row.status === 'IN_PROGRESS' && challengePolicyDisposition(row) !== 'ACTIVE'
        ? 'BLOCKED_BY_POLICY'
        : row.status === 'IN_PROGRESS' && row.expires_at <= ctx.now
          ? 'EXPIRED'
          : row.status;
    const common = {
      id: row.id,
      offerId: row.offer_id,
      answerRunId: row.answer_run_id,
      status,
      expiresAt: row.expires_at.toISOString(),
      rowVersion: row.row_version,
      currentStep: row.current_step,
      totalSteps: row.steps.length,
      paused: status === 'IN_PROGRESS' && row.paused_at !== null,
      instructionsComplete: row.current_step >= row.steps.length,
    };
    if (status !== 'IN_PROGRESS') return { ...common, status };
    return {
      ...common,
      status,
      ...(row.current_step < row.steps.length ? { step: row.steps[row.current_step] } : {}),
      challenge,
    };
  }

  private async priorCommand(
    client: PoolClient,
    ctx: Context,
    commandKey: string,
    actionHash: string,
  ): Promise<{ kind: string; id: string } | undefined> {
    const row = (
      await client.query<{ action_hash: string; result: { kind: string; id: string } }>(
        `SELECT action_hash,result FROM research.command_receipts
         WHERE family_id=$1 AND child_id=$2 AND command_key=$3`,
        [ctx.session.family_id, ctx.session.child_id, commandKey],
      )
    ).rows[0];
    if (!row) return undefined;
    if (row.action_hash !== actionHash) throw new AccessError('CONFLICT', 409);
    return row.result;
  }

  private async saveCommand(
    client: PoolClient,
    ctx: Context,
    commandKey: string,
    actionHash: string,
    result: { kind: string; id: string },
  ): Promise<void> {
    const inserted = await client.query(
      `INSERT INTO research.command_receipts(
        family_id,child_id,command_key,action_hash,result
       )
       SELECT $1,$2,$3,$4,$5
       WHERE (
         $6::text='answer' AND EXISTS (
           SELECT 1 FROM research.answer_runs a
           JOIN LATERAL research.lock_policy_version(a.policy_version) p ON true
           WHERE a.id=$7 AND a.family_id=$1 AND a.child_id=$2
             AND (p.policy_active OR p.current_kill_epoch<>a.kill_epoch)
         )
       ) OR (
         $6::text='challenge' AND EXISTS (
           SELECT 1 FROM research.challenge_runs r
           JOIN research.answer_runs a ON a.id=r.answer_run_id
             AND a.family_id=r.family_id AND a.child_id=r.child_id
           JOIN LATERAL research.lock_policy_version(a.policy_version) p ON true
           WHERE r.id=$7 AND r.family_id=$1 AND r.child_id=$2
             AND (p.policy_active OR p.current_kill_epoch<>a.kill_epoch)
         )
       )`,
      [
        ctx.session.family_id,
        ctx.session.child_id,
        commandKey,
        actionHash,
        result,
        result.kind,
        result.id,
      ],
    );
    if (inserted.rowCount !== 1) throw new AccessError('FORBIDDEN');
  }

  private async touchSession(ctx: Context): Promise<void> {
    await ctx.client.query('UPDATE identity.sessions SET last_seen=$2 WHERE id=$1', [
      ctx.session.id,
      ctx.now,
    ]);
  }
}

export function approvedArtifactPayload(answer: FakeAnswer, challenge: ResearchChallenge) {
  return {
    explanation: answer.explanation,
    roleNotice: answer.roleNotice,
    challenge,
  } satisfies ApprovedResearchAnswer;
}
