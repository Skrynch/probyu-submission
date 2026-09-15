import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  FamilyAction,
  FamilyChallenge,
  FamilyReauthResponse,
  FamilySession,
  ResearchAnswerRun,
  ResearchChallengeRun,
} from '@probyu/contracts/types';

import { buildApp } from '../app.js';
import { POLICY } from '../modules/family/policy.js';
import type { FamilyConfig } from '../modules/family/service.js';
import { contentHash } from '../modules/research/content.js';
import { ResearchWorker } from '../modules/research/worker.js';
import {
  DeterministicFakeGeneration,
  ProviderOutcomeUnknownError,
  type TextGeneration,
} from '../modules/research/runtime.js';

const databaseUrl = 'postgresql://probyu:probyu_local@127.0.0.1:54329/probyu_m3_test';
const dataKey = randomBytes(32).toString('hex');
const family: FamilyConfig = {
  mode: 'synthetic',
  environment: 'test',
  origin: 'http://127.0.0.1:4178',
  key: randomBytes(32).toString('base64url'),
  databaseUrl,
};
const admin = new Pool({ connectionString: databaseUrl });
let app: FastifyInstance;

class Browser {
  cookie = '';
  csrf = '';
  async request(
    prefix: 'family' | 'research',
    path: string,
    body?: unknown,
    expected = 200,
    method: 'GET' | 'POST' = body === undefined ? 'GET' : 'POST',
  ) {
    const options: InjectOptions = {
      method,
      url: `/v1/${prefix}/${path}`,
      headers: {
        origin: family.origin,
        cookie: this.cookie,
        'x-csrf-token': this.csrf,
        'x-probyu-bootstrap': '1',
      },
      ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
    };
    const response = await app.inject(options);
    expect(response.statusCode, `${prefix}/${path}: ${response.body}`).toBe(expected);
    const setCookie = response.headers['set-cookie'];
    if (typeof setCookie === 'string') this.cookie = setCookie.split(';')[0]!;
    const value = response.json<Record<string, unknown>>();
    if (typeof value.csrfToken === 'string') this.csrf = value.csrfToken;
    return value;
  }
  async login(identity: 'aurora' | 'comet' = 'aurora') {
    await this.request('family', 'bootstrap', undefined, 200, 'POST');
    const challenge = await this.request('family', 'login/challenge', { identity });
    await this.request('family', 'login', {
      challengeId: challenge.challengeId,
      code: challenge.devCode,
    });
    return this;
  }
  async receipt(action: FamilyAction) {
    const challenge = (await this.request('family', 'reauth/challenge', {
      action,
    })) as unknown as FamilyChallenge;
    return (
      (await this.request('family', 'reauth', {
        challengeId: challenge.challengeId,
        code: challenge.devCode,
      })) as unknown as FamilyReauthResponse
    ).receiptId;
  }
  async familyCommand(action: FamilyAction) {
    const receiptId = await this.receipt(action);
    await this.request('family', 'commands', {
      action,
      receiptId,
      idempotencyKey: randomUUID(),
    });
    return (await this.request('family', 'session')) as unknown as FamilySession;
  }
  async activateAndHandoff(ageBand: '8_10' | '11_12' | '13_14' = '8_10') {
    const parent = await this.familyCommand({
      kind: 'ACTIVATE',
      documentVersion: POLICY,
      ageBand,
      text: true,
      history: false,
    });
    await this.familyCommand({ kind: 'HANDOFF', childId: parent.child!.id });
    return parent.child!.id;
  }
  question(question: string, idempotencyKey = randomUUID(), expected = 202) {
    return this.request('research', 'questions', { question, idempotencyKey }, expected, 'POST');
  }
}

async function waitForBlockedQuery(fragment: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const blocked = await admin.query(
      `SELECT 1 FROM pg_stat_activity
       WHERE datname=current_database() AND pid<>pg_backend_pid()
         AND state='active' AND wait_event_type='Lock' AND query LIKE $1`,
      [`%${fragment}%`],
    );
    if (blocked.rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for blocked query: ${fragment}`);
}

beforeEach(async () => {
  if (app) await app.close();
  await admin.query(
    `TRUNCATE
      research.command_receipts,research.challenge_runs,research.challenge_offers,
      research.answer_delivery_events,research.approved_answer_artifacts,research.outbox,
      research.answer_runs,
      identity.auth_budgets,family.families,identity.parents,identity.registrations,
      identity.sessions,identity.proofs,family.memberships,family.representatives,
      family.children,family.reauth_receipts,family.consent_receipts,
      family.consent_projections,family.command_receipts,ops.family_outbox,
      family.processing_authorizations CASCADE`,
  );
  await admin.query(
    "UPDATE research.policy_versions SET active=true,kill_epoch=1 WHERE id='synthetic-m3-v1'",
  );
  app = await buildApp({
    family,
    research: { mode: 'fake', environment: 'test', dataKey },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await admin.end();
});

describe('M3 synthetic research vertical', () => {
  it('keeps the policy serialization capability narrower than policy mutation authority', async () => {
    const privileges = await admin.query<{
      runtime_execute: boolean;
      worker_execute: boolean;
      runtime_update: boolean;
      locker_update: boolean;
      locker_select: boolean;
    }>(
      `SELECT
         has_function_privilege(
           'probyu_family_runtime','research.lock_policy_version(text)','EXECUTE'
         ) runtime_execute,
         has_function_privilege(
           'probyu_research_worker','research.lock_policy_version(text)','EXECUTE'
         ) worker_execute,
         has_table_privilege(
           'probyu_family_runtime','research.policy_versions','UPDATE'
         ) runtime_update,
         has_table_privilege(
           'probyu_research_policy_locker','research.policy_versions','UPDATE'
         ) locker_update,
         has_table_privilege(
           'probyu_research_policy_locker','research.policy_versions','SELECT'
         ) locker_select`,
    );
    expect(privileges.rows[0]).toEqual({
      runtime_execute: true,
      worker_execute: true,
      runtime_update: false,
      locker_update: false,
      locker_select: true,
    });
    expect(
      (
        await admin.query<{
          rolcanlogin: boolean;
          rolsuper: boolean;
          rolbypassrls: boolean;
          rolinherit: boolean;
        }>(
          `SELECT rolcanlogin,rolsuper,rolbypassrls,rolinherit
           FROM pg_roles WHERE rolname='probyu_research_policy_locker'`,
        )
      ).rows[0],
    ).toEqual({ rolcanlogin: false, rolsuper: false, rolbypassrls: false, rolinherit: false });
  });

  it('deduplicates one question, approves only the full artifact and runs a curated project', async () => {
    const browser = await new Browser().login();
    await browser.activateAndHandoff('13_14');
    const key = randomUUID();
    const accepted = (await browser.question(
      'Почему бумажная башня бывает устойчивой?',
      key,
    )) as unknown as ResearchAnswerRun;
    const repeated = (await browser.question(
      'Почему бумажная башня бывает устойчивой?',
      key,
      200,
    )) as unknown as ResearchAnswerRun;
    expect(repeated.id).toBe(accepted.id);
    const worker = new ResearchWorker(databaseUrl, dataKey);
    try {
      await expect(worker.cycle()).resolves.toEqual({ processed: 1 });
    } finally {
      await worker.close();
    }
    const approved = (await browser.request(
      'research',
      `answers/${accepted.id}`,
    )) as unknown as ResearchAnswerRun;
    expect(approved.status).toBe('APPROVED');
    expect(approved.answer?.challenge.kind).toBe('PROJECT');
    expect(approved.answer?.challenge).toMatchObject({
      ageBands: ['8_10', '11_12', '13_14'],
      riskClass: 'MINIMAL_RISK',
      supervisionRequirement: 'NONE',
    });
    expect(approved.answer?.explanation.join(' ')).not.toContain('Почему бумажная башня');
    const stream = await app.inject({
      method: 'GET',
      url: `/v1/research/answers/${accepted.id}/events?cursor=1`,
      headers: { cookie: browser.cookie, origin: family.origin },
    });
    expect(stream.statusCode).toBe(200);
    expect(stream.headers['content-type']).toContain('text/event-stream');
    expect(stream.body).toContain('"status":"APPROVED"');
    expect(stream.body).toContain('Бумажная башня без клея');
    const offerId = approved.answer!.challenge.offerId;
    let challenge = (await browser.request('research', `offers/${offerId}/commands`, {
      action: 'START',
      idempotencyKey: randomUUID(),
    })) as unknown as ResearchChallengeRun;
    expect(challenge).not.toHaveProperty('challenge.steps');
    expect(challenge).not.toHaveProperty('challenge.materials');
    expect(challenge.currentStep).toBe(0);
    expect(challenge.rowVersion).toBe(0);
    const activeAnswer = (await browser.request(
      'research',
      `answers/${accepted.id}`,
    )) as unknown as ResearchAnswerRun;
    expect(activeAnswer.answer).toBeUndefined();
    expect(activeAnswer.challengeRun).toMatchObject({ id: challenge.id, status: 'IN_PROGRESS' });
    expect(JSON.stringify(activeAnswer)).not.toContain('Сложи один лист гармошкой');
    const pauseKey = randomUUID();
    const pauseVersion = challenge.rowVersion;
    challenge = (await browser.request('research', `challenges/${challenge.id}/commands`, {
      action: 'PAUSE',
      idempotencyKey: pauseKey,
      expectedVersion: pauseVersion,
    })) as unknown as ResearchChallengeRun;
    expect(challenge.paused).toBe(true);
    expect(challenge.rowVersion).toBe(1);
    const repeatedPause = (await browser.request(
      'research',
      `challenges/${challenge.id}/commands`,
      { action: 'PAUSE', idempotencyKey: pauseKey, expectedVersion: pauseVersion },
    )) as unknown as ResearchChallengeRun;
    expect(repeatedPause.paused).toBe(true);
    await browser.request(
      'research',
      `challenges/${challenge.id}/commands`,
      { action: 'RESUME', idempotencyKey: pauseKey, expectedVersion: challenge.rowVersion },
      409,
    );
    challenge = (await browser.request('research', `challenges/${challenge.id}/commands`, {
      action: 'RESUME',
      idempotencyKey: randomUUID(),
      expectedVersion: challenge.rowVersion,
    })) as unknown as ResearchChallengeRun;
    while (!challenge.instructionsComplete) {
      challenge = (await browser.request('research', `challenges/${challenge.id}/commands`, {
        action: 'NEXT',
        idempotencyKey: randomUUID(),
        expectedVersion: challenge.rowVersion,
      })) as unknown as ResearchChallengeRun;
    }
    expect(challenge.currentStep).toBe(challenge.totalSteps);
    const rows = await admin.query<{ input_ciphertext: string | null; ciphertext: string }>(
      `SELECT a.input_ciphertext,x.ciphertext
       FROM research.answer_runs a JOIN research.approved_answer_artifacts x ON x.answer_run_id=a.id`,
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]!.input_ciphertext).toBeNull();
    expect(rows.rows[0]!.ciphertext).not.toContain('башня');
  });

  it('never queues blocked or identifying input and never stores the raw question', async () => {
    const browser = await new Browser().login();
    await browser.activateAndHandoff();
    const denied = (await browser.question(
      'Меня зовут Петя, мой телефон +7 999 123-45-67',
      randomUUID(),
      200,
    )) as unknown as ResearchAnswerRun;
    expect(denied).toMatchObject({ status: 'DENIED', failureCode: 'INPUT_BLOCKED' });
    const result = await admin.query<{
      request_hash: string;
      input_ciphertext: string | null;
      input_hash: string | null;
    }>('SELECT request_hash,input_ciphertext,input_hash FROM research.answer_runs WHERE id=$1', [
      denied.id,
    ]);
    expect(result.rows[0]).toMatchObject({ input_ciphertext: null, input_hash: null });
    expect(result.rows[0]!.request_hash).not.toBe(
      createHash('sha256').update('Меня зовут Петя, мой телефон +7 999 123-45-67').digest('hex'),
    );
    expect((await admin.query('SELECT * FROM research.outbox')).rowCount).toBe(0);
  });

  it('fails closed on malformed model output and exposes no draft', async () => {
    const browser = await new Browser().login();
    await browser.activateAndHandoff();
    const accepted = (await browser.question(
      'Почему бумага падает?',
    )) as unknown as ResearchAnswerRun;
    const unsafe: TextGeneration = {
      version: 'deterministic-fake-m3-v2',
      generate: () =>
        Promise.resolve({
          explanation: ['Открой https://example.com и возьми острый предмет'],
          roleNotice: 'Это учебный ответ системы: он может ошибаться.',
          challengeKey: 'paper-shapes',
          schemaVersion: 'approved-answer-m3-v2',
        }),
    };
    const worker = new ResearchWorker(databaseUrl, dataKey, unsafe);
    try {
      await worker.cycle();
    } finally {
      await worker.close();
    }
    const failed = (await browser.request(
      'research',
      `answers/${accepted.id}`,
    )) as unknown as ResearchAnswerRun;
    expect(failed).toMatchObject({ status: 'FAILED_SAFE', failureCode: 'OUTPUT_REJECTED' });
    expect(failed.answer).toBeUndefined();
    expect((await admin.query('SELECT * FROM research.approved_answer_artifacts')).rowCount).toBe(
      0,
    );
  });

  it('recovers the same active question but rejects silent substitution by another question', async () => {
    const browser = await new Browser().login();
    await browser.activateAndHandoff();
    const accepted = (await browser.question(
      'Почему лист кружится?',
    )) as unknown as ResearchAnswerRun;
    const recovered = (await browser.question(
      'Почему лист кружится?',
      randomUUID(),
      200,
    )) as unknown as ResearchAnswerRun;
    expect(recovered.id).toBe(accepted.id);
    await browser.question('Почему бумага мнётся?', randomUUID(), 409);
    const commandKey = randomUUID();
    await browser.request('research', `answers/${accepted.id}/cancel`, {
      idempotencyKey: commandKey,
    });
    await browser.request('research', `answers/${accepted.id}/cancel`, {
      idempotencyKey: commandKey,
    });
    const worker = new ResearchWorker(databaseUrl, dataKey);
    try {
      await expect(worker.cycle()).resolves.toEqual({ processed: 0 });
    } finally {
      await worker.close();
    }
    expect((await admin.query('SELECT * FROM research.answer_runs')).rowCount).toBe(1);
    expect((await admin.query('SELECT * FROM research.approved_answer_artifacts')).rowCount).toBe(
      0,
    );
  });

  it('rejects reuse of a question idempotency key with a different payload', async () => {
    const browser = await new Browser().login();
    await browser.activateAndHandoff();
    const key = randomUUID();
    await browser.question('Почему лист кружится?', key);
    await browser.question('Почему бумага мнётся?', key, 409);
    expect((await admin.query('SELECT * FROM research.answer_runs')).rowCount).toBe(1);
  });

  it('fails closed when generation exceeds the gate timeout', async () => {
    const browser = await new Browser().login();
    await browser.activateAndHandoff();
    const accepted = (await browser.question(
      'Почему бумага падает?',
    )) as unknown as ResearchAnswerRun;
    const slow: TextGeneration = {
      version: 'deterministic-fake-m3-v2',
      generate: (_input, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () =>
              reject(signal.reason instanceof Error ? signal.reason : new Error('GATE_TIMEOUT')),
            { once: true },
          );
        }),
    };
    const worker = new ResearchWorker(databaseUrl, dataKey, slow);
    try {
      await worker.cycle();
    } finally {
      await worker.close();
    }
    const failed = (await browser.request(
      'research',
      `answers/${accepted.id}`,
    )) as unknown as ResearchAnswerRun;
    expect(failed).toMatchObject({ status: 'FAILED_SAFE', failureCode: 'GATE_TIMEOUT' });
    expect(failed.answer).toBeUndefined();
    expect((await admin.query('SELECT * FROM research.approved_answer_artifacts')).rowCount).toBe(
      0,
    );
  });

  it('does not blindly retry an unknown provider outcome', async () => {
    const browser = await new Browser().login();
    await browser.activateAndHandoff();
    const accepted = (await browser.question(
      'Почему бумага падает?',
    )) as unknown as ResearchAnswerRun;
    const unknown: TextGeneration = {
      version: 'deterministic-fake-m3-v2',
      generate: () => Promise.reject(new ProviderOutcomeUnknownError('Synthetic unknown outcome')),
    };
    const worker = new ResearchWorker(databaseUrl, dataKey, unknown);
    try {
      await worker.cycle();
      await expect(worker.cycle()).resolves.toEqual({ processed: 0 });
    } finally {
      await worker.close();
    }
    expect(
      (
        await admin.query('SELECT status,failure_code FROM research.answer_runs WHERE id=$1', [
          accepted.id,
        ])
      ).rows[0],
    ).toEqual({ status: 'FAILED_SAFE', failure_code: 'PROVIDER_OUTCOME_UNKNOWN' });
    expect(
      (await admin.query<{ state: string }>('SELECT state FROM research.outbox')).rows[0]?.state,
    ).toBe('DEAD');
    expect((await admin.query('SELECT * FROM research.approved_answer_artifacts')).rowCount).toBe(
      0,
    );
  });

  it('finalizes an expired generating lease without a blind provider retry', async () => {
    const browser = await new Browser().login();
    await browser.activateAndHandoff();
    const accepted = (await browser.question(
      'Почему бумага падает?',
    )) as unknown as ResearchAnswerRun;
    const fake = new DeterministicFakeGeneration();
    let release!: () => void;
    let started!: () => void;
    const hasStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const waitForRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delayed: TextGeneration = {
      version: fake.version,
      generate: async (input, signal) => {
        started();
        await waitForRelease;
        return fake.generate(input, signal);
      },
    };
    const staleWorker = new ResearchWorker(databaseUrl, dataKey, delayed);
    let retryCalls = 0;
    const mustNotRun: TextGeneration = {
      version: fake.version,
      generate: () => {
        retryCalls++;
        return Promise.reject(new Error('blind retry'));
      },
    };
    const retryWorker = new ResearchWorker(databaseUrl, dataKey, mustNotRun);
    try {
      const staleCycle = staleWorker.cycle();
      await hasStarted;
      await admin.query(
        "UPDATE research.answer_runs SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
        [accepted.id],
      );
      await expect(retryWorker.cycle()).resolves.toEqual({ processed: 1 });
      release();
      await expect(staleCycle).resolves.toEqual({ processed: 1 });
    } finally {
      await staleWorker.close();
      await retryWorker.close();
    }
    expect(
      (
        await admin.query('SELECT status,fence FROM research.answer_runs WHERE id=$1', [
          accepted.id,
        ])
      ).rows[0],
    ).toEqual({ status: 'FAILED_SAFE', fence: 2 });
    expect(retryCalls).toBe(0);
    expect(
      (await admin.query<{ state: string }>('SELECT state FROM research.outbox')).rows[0]?.state,
    ).toBe('DEAD');
    expect((await admin.query('SELECT * FROM research.approved_answer_artifacts')).rowCount).toBe(
      0,
    );
  });

  it('blocks stale consent before approved commit', async () => {
    const browser = await new Browser().login();
    const childId = await browser.activateAndHandoff();
    const accepted = (await browser.question(
      'Как провести опыт с бумагой?',
    )) as unknown as ResearchAnswerRun;
    const adult = await new Browser().login();
    await adult.familyCommand({
      kind: 'CONSENT',
      childId,
      documentVersion: POLICY,
      purpose: 'TEXT',
      granted: false,
    });
    const worker = new ResearchWorker(databaseUrl, dataKey);
    try {
      await worker.cycle();
    } finally {
      await worker.close();
    }
    expect(
      (
        await admin.query('SELECT status,failure_code FROM research.answer_runs WHERE id=$1', [
          accepted.id,
        ])
      ).rows[0],
    ).toEqual({ status: 'FAILED_SAFE', failure_code: 'ACCESS_REVOKED' });
    expect((await admin.query('SELECT * FROM research.approved_answer_artifacts')).rowCount).toBe(
      0,
    );
  });

  it('serializes approval behind a concurrent consent revocation', async () => {
    const browser = await new Browser().login();
    const childId = await browser.activateAndHandoff();
    const accepted = (await browser.question(
      'Как провести опыт с бумагой?',
    )) as unknown as ResearchAnswerRun;
    const adult = await new Browser().login();
    const action = {
      kind: 'CONSENT',
      childId,
      documentVersion: POLICY,
      purpose: 'TEXT',
      granted: false,
    } as const;
    const receiptId = await adult.receipt(action);
    const blocker = await admin.connect();
    const worker = new ResearchWorker(databaseUrl, dataKey);
    let blockerOpen = false;
    let revocation: Promise<Record<string, unknown>> | undefined;
    let workerCycle: Promise<{ processed: number }> | undefined;
    try {
      await blocker.query('BEGIN');
      blockerOpen = true;
      await blocker.query('LOCK TABLE ops.family_outbox IN SHARE MODE');
      revocation = adult.request('family', 'commands', {
        action,
        receiptId,
        idempotencyKey: randomUUID(),
      });
      await waitForBlockedQuery('INSERT INTO ops.family_outbox');

      workerCycle = worker.cycle();
      await waitForBlockedQuery('research-worker-family-gate');
      expect((await admin.query('SELECT * FROM research.approved_answer_artifacts')).rowCount).toBe(
        0,
      );

      await blocker.query('COMMIT');
      blockerOpen = false;
      await revocation;
      await expect(workerCycle).resolves.toEqual({ processed: 1 });
    } finally {
      if (blockerOpen) await blocker.query('ROLLBACK');
      await revocation?.catch(() => undefined);
      await workerCycle?.catch(() => undefined);
      blocker.release();
      await worker.close();
    }
    expect(
      (
        await admin.query('SELECT status,failure_code FROM research.answer_runs WHERE id=$1', [
          accepted.id,
        ])
      ).rows[0],
    ).toEqual({ status: 'FAILED_SAFE', failure_code: 'ACCESS_REVOKED' });
    expect((await admin.query('SELECT * FROM research.approved_answer_artifacts')).rowCount).toBe(
      0,
    );
    expect((await admin.query('SELECT * FROM research.challenge_offers')).rowCount).toBe(0);
    expect(
      (
        await admin.query(
          "SELECT * FROM research.answer_delivery_events WHERE event_type='ANSWER_APPROVED'",
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (await admin.query<{ state: string }>('SELECT state FROM research.outbox')).rows[0]?.state,
    ).toBe('DEAD');
  });

  it('honors the kill switch before generation and discloses no answer', async () => {
    const browser = await new Browser().login();
    await browser.activateAndHandoff();
    const accepted = (await browser.question(
      'Как провести опыт с бумагой?',
    )) as unknown as ResearchAnswerRun;
    await admin.query(
      "UPDATE research.policy_versions SET kill_epoch=kill_epoch+1 WHERE id='synthetic-m3-v1'",
    );
    const worker = new ResearchWorker(databaseUrl, dataKey);
    try {
      await worker.cycle();
    } finally {
      await worker.close();
    }
    expect(
      (
        await admin.query('SELECT status,failure_code FROM research.answer_runs WHERE id=$1', [
          accepted.id,
        ])
      ).rows[0],
    ).toEqual({ status: 'FAILED_SAFE', failure_code: 'KILLED' });
    expect((await admin.query('SELECT * FROM research.approved_answer_artifacts')).rowCount).toBe(
      0,
    );
    await browser.request('research', `answers/${accepted.id}`, undefined, 403);
  });

  it('keeps queued work untouched during a reversible pause and resumes the same run', async () => {
    const browser = await new Browser().login();
    await browser.activateAndHandoff();
    const accepted = (await browser.question(
      'Как провести опыт с бумагой?',
    )) as unknown as ResearchAnswerRun;
    await admin.query(
      "UPDATE research.policy_versions SET active=false WHERE id='synthetic-m3-v1'",
    );
    const worker = new ResearchWorker(databaseUrl, dataKey);
    try {
      await expect(worker.cycle()).resolves.toEqual({ processed: 0 });
      expect(
        (
          await admin.query<{
            status: string;
            failure_code: string | null;
            input_ciphertext: string | null;
            state: string;
          }>(
            `SELECT a.status,a.failure_code,a.input_ciphertext,o.state
             FROM research.answer_runs a
             JOIN research.outbox o ON o.answer_run_id=a.id
             WHERE a.id=$1`,
            [accepted.id],
          )
        ).rows[0],
      ).toMatchObject({
        status: 'QUEUED',
        failure_code: null,
        state: 'PENDING',
      });
      expect(
        (
          await admin.query<{ input_ciphertext: string | null }>(
            'SELECT input_ciphertext FROM research.answer_runs WHERE id=$1',
            [accepted.id],
          )
        ).rows[0]?.input_ciphertext,
      ).not.toBeNull();
      await admin.query(
        "UPDATE research.policy_versions SET active=true WHERE id='synthetic-m3-v1'",
      );
      await expect(worker.cycle()).resolves.toEqual({ processed: 1 });
    } finally {
      await worker.close();
    }
    const approved = (await browser.request(
      'research',
      `answers/${accepted.id}`,
    )) as unknown as ResearchAnswerRun;
    expect(approved.status).toBe('APPROVED');
  });

  it('defers known generated output during a reversible pause without a terminal outcome', async () => {
    const browser = await new Browser().login();
    await browser.activateAndHandoff();
    const accepted = (await browser.question(
      'Как провести опыт с бумагой?',
    )) as unknown as ResearchAnswerRun;
    const fake = new DeterministicFakeGeneration();
    let release!: () => void;
    let started!: () => void;
    let calls = 0;
    const hasStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const waitForRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delayed: TextGeneration = {
      version: fake.version,
      generate: async (input, signal) => {
        calls++;
        if (calls === 1) {
          started();
          await waitForRelease;
        }
        return fake.generate(input, signal);
      },
    };
    const worker = new ResearchWorker(databaseUrl, dataKey, delayed);
    try {
      const firstCycle = worker.cycle();
      await hasStarted;
      await admin.query(
        "UPDATE research.policy_versions SET active=false WHERE id='synthetic-m3-v1'",
      );
      release();
      await expect(firstCycle).resolves.toEqual({ processed: 1 });
      expect(
        (
          await admin.query<{
            status: string;
            failure_code: string | null;
            input_ciphertext: string | null;
            lease_owner: string | null;
            state: string;
          }>(
            `SELECT a.status,a.failure_code,a.input_ciphertext,a.lease_owner,o.state
             FROM research.answer_runs a
             JOIN research.outbox o ON o.answer_run_id=a.id
             WHERE a.id=$1`,
            [accepted.id],
          )
        ).rows[0],
      ).toMatchObject({
        status: 'QUEUED',
        failure_code: null,
        lease_owner: null,
        state: 'PENDING',
      });
      expect(
        (
          await admin.query<{ input_ciphertext: string | null }>(
            'SELECT input_ciphertext FROM research.answer_runs WHERE id=$1',
            [accepted.id],
          )
        ).rows[0]?.input_ciphertext,
      ).not.toBeNull();
      expect((await admin.query('SELECT * FROM research.approved_answer_artifacts')).rowCount).toBe(
        0,
      );
      expect(
        (
          await admin.query<{ count: number }>(
            'SELECT COUNT(*)::int count FROM research.answer_delivery_events WHERE answer_run_id=$1',
            [accepted.id],
          )
        ).rows[0]?.count,
      ).toBe(1);
      await expect(worker.cycle()).resolves.toEqual({ processed: 0 });
      expect(calls).toBe(1);

      await admin.query(
        "UPDATE research.policy_versions SET active=true WHERE id='synthetic-m3-v1'",
      );
      await expect(worker.cycle()).resolves.toEqual({ processed: 1 });
      expect(calls).toBe(2);
    } finally {
      await worker.close();
    }
    const approved = (await browser.request(
      'research',
      `answers/${accepted.id}`,
    )) as unknown as ResearchAnswerRun;
    expect(approved.status).toBe('APPROVED');
  });

  it('persists a policy-blocked challenge when kill changes between steps', async () => {
    const browser = await new Browser().login();
    await browser.activateAndHandoff();
    const accepted = (await browser.question(
      'Почему бумажная башня бывает устойчивой?',
    )) as unknown as ResearchAnswerRun;
    const worker = new ResearchWorker(databaseUrl, dataKey);
    try {
      await worker.cycle();
    } finally {
      await worker.close();
    }
    const approved = (await browser.request(
      'research',
      `answers/${accepted.id}`,
    )) as unknown as ResearchAnswerRun;
    const challenge = (await browser.request(
      'research',
      `offers/${approved.answer!.challenge.offerId}/commands`,
      { action: 'START', idempotencyKey: randomUUID() },
    )) as unknown as ResearchChallengeRun;
    await admin.query(
      "UPDATE research.policy_versions SET kill_epoch=kill_epoch+1 WHERE id='synthetic-m3-v1'",
    );
    const blocked = (await browser.request('research', `challenges/${challenge.id}/commands`, {
      action: 'NEXT',
      idempotencyKey: randomUUID(),
      expectedVersion: challenge.rowVersion,
    })) as unknown as ResearchChallengeRun;
    expect(blocked).toMatchObject({ status: 'BLOCKED_BY_POLICY', currentStep: 0 });
    expect(
      (await admin.query('SELECT status,current_step FROM research.challenge_runs')).rows[0],
    ).toEqual({ status: 'BLOCKED_BY_POLICY', current_step: 0 });
  });

  it('reconciles policy kill before replaying START or a prior challenge command', async () => {
    const browser = await new Browser().login();
    await browser.activateAndHandoff();
    const accepted = (await browser.question(
      'Почему бумажная башня бывает устойчивой?',
    )) as unknown as ResearchAnswerRun;
    const worker = new ResearchWorker(databaseUrl, dataKey);
    try {
      await worker.cycle();
    } finally {
      await worker.close();
    }
    const approved = (await browser.request(
      'research',
      `answers/${accepted.id}`,
    )) as unknown as ResearchAnswerRun;
    const startKey = randomUUID();
    let challenge = (await browser.request(
      'research',
      `offers/${approved.answer!.challenge.offerId}/commands`,
      { action: 'START', idempotencyKey: startKey },
    )) as unknown as ResearchChallengeRun;
    const pauseKey = randomUUID();
    const pausedVersion = challenge.rowVersion;
    challenge = (await browser.request('research', `challenges/${challenge.id}/commands`, {
      action: 'PAUSE',
      idempotencyKey: pauseKey,
      expectedVersion: pausedVersion,
    })) as unknown as ResearchChallengeRun;
    await admin.query(
      "UPDATE research.policy_versions SET kill_epoch=kill_epoch+1 WHERE id='synthetic-m3-v1'",
    );

    const replayedCommand = (await browser.request(
      'research',
      `challenges/${challenge.id}/commands`,
      { action: 'PAUSE', idempotencyKey: pauseKey, expectedVersion: pausedVersion },
    )) as unknown as ResearchChallengeRun;
    expect(replayedCommand).toMatchObject({
      status: 'BLOCKED_BY_POLICY',
      paused: false,
      rowVersion: 2,
    });
    expect(replayedCommand).not.toHaveProperty('step');
    expect(replayedCommand).not.toHaveProperty('challenge');

    const replayedStart = (await browser.request(
      'research',
      `offers/${approved.answer!.challenge.offerId}/commands`,
      { action: 'START', idempotencyKey: startKey },
    )) as unknown as ResearchChallengeRun;
    expect(replayedStart.status).toBe('BLOCKED_BY_POLICY');
    expect(replayedStart).not.toHaveProperty('step');
    expect(replayedStart).not.toHaveProperty('challenge');
    expect(
      (await admin.query<{ status: string }>('SELECT status FROM research.challenge_runs')).rows[0]
        ?.status,
    ).toBe('BLOCKED_BY_POLICY');
  });

  it('releases stale-kill answers without disclosing their artifact and permits content-free cancel', async () => {
    const browser = await new Browser().login();
    await browser.activateAndHandoff();
    const accepted = (await browser.question(
      'Почему бумажная башня бывает устойчивой?',
    )) as unknown as ResearchAnswerRun;
    const worker = new ResearchWorker(databaseUrl, dataKey);
    try {
      await worker.cycle();
    } finally {
      await worker.close();
    }
    const approved = (await browser.request(
      'research',
      `answers/${accepted.id}`,
    )) as unknown as ResearchAnswerRun;
    await admin.query(
      "UPDATE research.policy_versions SET kill_epoch=kill_epoch+1 WHERE id='synthetic-m3-v1'",
    );

    expect(await browser.request('research', 'answers/current')).toEqual({});
    await browser.request('research', `answers/${accepted.id}`, undefined, 403);
    await browser.request('research', `answers/${accepted.id}/events?cursor=0`, undefined, 403);
    const cancelled = (await browser.request('research', `answers/${accepted.id}/cancel`, {
      idempotencyKey: randomUUID(),
    })) as unknown as ResearchAnswerRun;
    expect(cancelled).toMatchObject({ status: 'CANCELLED', failureCode: 'CANCELLED' });
    expect(cancelled.answer).toBeUndefined();
    expect(cancelled.challengeRun).toBeUndefined();
    expect(
      (
        await admin.query('SELECT status,failure_code FROM research.answer_runs WHERE id=$1', [
          accepted.id,
        ])
      ).rows[0],
    ).toEqual({ status: 'CANCELLED', failure_code: 'CANCELLED' });
    expect(
      (
        await admin.query<{ state: string }>(
          'SELECT state FROM research.outbox WHERE answer_run_id=$1',
          [accepted.id],
        )
      ).rows[0]?.state,
    ).toBe('PROCESSED');

    const next = (await browser.question(
      'Почему бумажная дорожка изгибается?',
    )) as unknown as ResearchAnswerRun;
    expect(next.id).not.toBe(accepted.id);
    expect(approved.answer).toBeDefined();
  });

  it('keeps a full policy kill fail-closed while reconciling a started challenge', async () => {
    const browser = await new Browser().login();
    await browser.activateAndHandoff();
    const accepted = (await browser.question(
      'Почему бумажная башня бывает устойчивой?',
    )) as unknown as ResearchAnswerRun;
    const worker = new ResearchWorker(databaseUrl, dataKey);
    try {
      await worker.cycle();
    } finally {
      await worker.close();
    }
    const approved = (await browser.request(
      'research',
      `answers/${accepted.id}`,
    )) as unknown as ResearchAnswerRun;
    const challenge = (await browser.request(
      'research',
      `offers/${approved.answer!.challenge.offerId}/commands`,
      { action: 'START', idempotencyKey: randomUUID() },
    )) as unknown as ResearchChallengeRun;
    await admin.query(
      "UPDATE research.policy_versions SET active=false,kill_epoch=kill_epoch+1 WHERE id='synthetic-m3-v1'",
    );

    expect(await browser.request('research', 'answers/current')).toEqual({});
    await browser.request('research', `answers/${accepted.id}`, undefined, 403);
    const cancellation = (await browser.request('research', `answers/${accepted.id}/cancel`, {
      idempotencyKey: randomUUID(),
    })) as unknown as ResearchAnswerRun;
    expect(cancellation).toMatchObject({ status: 'APPROVED' });
    expect(cancellation.failureCode).toBeUndefined();
    expect(cancellation.answer).toBeUndefined();
    expect(cancellation.challengeRun).toBeUndefined();
    await browser.question('Почему бумага мнётся?', randomUUID(), 503);

    const blocked = (await browser.request('research', `challenges/${challenge.id}/commands`, {
      action: 'NEXT',
      idempotencyKey: randomUUID(),
      expectedVersion: challenge.rowVersion,
    })) as unknown as ResearchChallengeRun;
    expect(blocked.status).toBe('BLOCKED_BY_POLICY');
    expect(blocked).not.toHaveProperty('step');
    expect(blocked).not.toHaveProperty('challenge');
  });

  it('recovers an approved answer and paused challenge after return and handoff', async () => {
    const browser = await new Browser().login();
    const childId = await browser.activateAndHandoff();
    const accepted = (await browser.question(
      'Почему бумага падает?',
    )) as unknown as ResearchAnswerRun;
    const worker = new ResearchWorker(databaseUrl, dataKey);
    try {
      await worker.cycle();
    } finally {
      await worker.close();
    }
    const current = (await browser.request('research', 'answers/current')) as unknown as {
      answer: ResearchAnswerRun;
    };
    expect(current.answer.id).toBe(accepted.id);
    const approved = current.answer;
    let challenge = (await browser.request(
      'research',
      `offers/${approved.answer!.challenge.offerId}/commands`,
      { action: 'START', idempotencyKey: randomUUID() },
    )) as unknown as ResearchChallengeRun;
    await admin.query(
      "UPDATE identity.sessions SET last_seen=now()-interval '29 minutes' WHERE mode='CHILD' AND revoked_at IS NULL",
    );
    challenge = (await browser.request('research', `challenges/${challenge.id}/commands`, {
      action: 'PAUSE',
      idempotencyKey: randomUUID(),
      expectedVersion: challenge.rowVersion,
    })) as unknown as ResearchChallengeRun;
    expect(
      (
        await admin.query<{ touched: boolean }>(
          "SELECT last_seen>now()-interval '1 minute' touched FROM identity.sessions WHERE mode='CHILD' AND revoked_at IS NULL",
        )
      ).rows[0]?.touched,
    ).toBe(true);
    await browser.familyCommand({ kind: 'RETURN' });
    await browser.familyCommand({ kind: 'HANDOFF', childId });
    const restored = (await browser.request(
      'research',
      `answers/${accepted.id}`,
    )) as unknown as ResearchAnswerRun;
    expect(restored.challengeRun).toMatchObject({
      id: challenge.id,
      status: 'IN_PROGRESS',
      paused: true,
      rowVersion: 1,
    });
  });

  it('releases an expired completed offer from current recovery and active backpressure', async () => {
    const browser = await new Browser().login();
    await browser.activateAndHandoff();
    const accepted = (await browser.question(
      'Почему бумага падает?',
    )) as unknown as ResearchAnswerRun;
    const worker = new ResearchWorker(databaseUrl, dataKey);
    try {
      await worker.cycle();
    } finally {
      await worker.close();
    }
    await admin.query("UPDATE research.answer_runs SET status='COMPLETED' WHERE id=$1", [
      accepted.id,
    ]);
    await admin.query(
      "UPDATE research.challenge_offers SET expires_at=now()-interval '1 second' WHERE answer_run_id=$1",
      [accepted.id],
    );

    const current = await browser.request('research', 'answers/current');
    expect(current.answer).toBeUndefined();
    const next = (await browser.question(
      'Почему бумажная дорожка изгибается?',
    )) as unknown as ResearchAnswerRun;
    expect(next.id).not.toBe(accepted.id);
    expect(next.status).toBe('QUEUED');
  });

  it('makes START resource-idempotent and rejects a conflicting offer decision', async () => {
    const browser = await new Browser().login();
    await browser.activateAndHandoff();
    const accepted = (await browser.question(
      'Почему бумага падает?',
    )) as unknown as ResearchAnswerRun;
    const worker = new ResearchWorker(databaseUrl, dataKey);
    try {
      await worker.cycle();
    } finally {
      await worker.close();
    }
    const approved = (await browser.request(
      'research',
      `answers/${accepted.id}`,
    )) as unknown as ResearchAnswerRun;
    const offerId = approved.answer!.challenge.offerId;
    const started = (await browser.request('research', `offers/${offerId}/commands`, {
      action: 'START',
      idempotencyKey: randomUUID(),
    })) as unknown as ResearchChallengeRun;
    const recovered = (await browser.request('research', `offers/${offerId}/commands`, {
      action: 'START',
      idempotencyKey: randomUUID(),
    })) as unknown as ResearchChallengeRun;
    expect(recovered.id).toBe(started.id);
    await browser.request(
      'research',
      `offers/${offerId}/commands`,
      { action: 'DECLINE', idempotencyKey: randomUUID() },
      409,
    );
    expect((await admin.query('SELECT * FROM research.challenge_runs')).rowCount).toBe(1);
  });

  it('assigns a reviewed run deadline from START instead of inheriting the offer deadline', async () => {
    const browser = await new Browser().login();
    await browser.activateAndHandoff();
    const accepted = (await browser.question(
      'Почему бумажная башня бывает устойчивой?',
    )) as unknown as ResearchAnswerRun;
    const worker = new ResearchWorker(databaseUrl, dataKey);
    try {
      await worker.cycle();
    } finally {
      await worker.close();
    }
    const approved = (await browser.request(
      'research',
      `answers/${accepted.id}`,
    )) as unknown as ResearchAnswerRun;
    const offerId = approved.answer!.challenge.offerId;
    await admin.query(
      "UPDATE research.challenge_offers SET expires_at=now()+interval '1 minute' WHERE id=$1",
      [offerId],
    );
    const startedAt = Date.now();
    const challenge = (await browser.request('research', `offers/${offerId}/commands`, {
      action: 'START',
      idempotencyKey: randomUUID(),
    })) as unknown as ResearchChallengeRun;
    expect(new Date(challenge.expiresAt).getTime()).toBeGreaterThan(startedAt + 23 * 60 * 60_000);
    expect(
      (
        await admin.query<{ independent: boolean }>(
          `SELECT r.expires_at>o.expires_at independent
           FROM research.challenge_runs r JOIN research.challenge_offers o ON o.id=r.offer_id
           WHERE r.id=$1`,
          [challenge.id],
        )
      ).rows[0]?.independent,
    ).toBe(true);
    const expiredOffer = (
      await admin.query<{ expires_at: Date }>(
        "UPDATE research.challenge_offers SET expires_at=now()-interval '1 second' WHERE id=$1 RETURNING expires_at",
        [offerId],
      )
    ).rows[0]!;
    const expiredOfferAnswer = {
      ...approved.answer!,
      challenge: {
        ...approved.answer!.challenge,
        expiresAt: expiredOffer.expires_at.toISOString(),
      },
    };
    await admin.query(
      'UPDATE research.approved_answer_artifacts SET content_hash=$2 WHERE answer_run_id=$1',
      [accepted.id, contentHash(expiredOfferAnswer)],
    );
    const current = (await browser.request('research', 'answers/current')) as unknown as {
      answer: ResearchAnswerRun;
    };
    expect(current.answer.challengeRun?.id).toBe(challenge.id);
    const recovered = (await browser.question(
      'Почему бумажная башня бывает устойчивой?',
      randomUUID(),
      200,
    )) as unknown as ResearchAnswerRun;
    expect(recovered.challengeRun?.id).toBe(challenge.id);
    await browser.question('Почему бумажная дорожка изгибается?', randomUUID(), 409);
    expect((await admin.query('SELECT * FROM research.answer_runs')).rowCount).toBe(1);
  });

  it('returns a scoped expired-offer outcome for START but still accepts DECLINE', async () => {
    const browser = await new Browser().login();
    await browser.activateAndHandoff();
    const accepted = (await browser.question(
      'Как провести опыт с бумажной дорожкой?',
    )) as unknown as ResearchAnswerRun;
    const worker = new ResearchWorker(databaseUrl, dataKey);
    try {
      await worker.cycle();
    } finally {
      await worker.close();
    }
    const approved = (await browser.request(
      'research',
      `answers/${accepted.id}`,
    )) as unknown as ResearchAnswerRun;
    const offerId = approved.answer!.challenge.offerId;
    await admin.query(
      "UPDATE research.challenge_offers SET expires_at=now()-interval '1 second' WHERE id=$1",
      [offerId],
    );

    const expired = await browser.request(
      'research',
      `offers/${offerId}/commands`,
      { action: 'START', idempotencyKey: randomUUID() },
      410,
    );
    expect(expired).toEqual({ code: 'OFFER_EXPIRED' });
    expect((await admin.query('SELECT * FROM research.challenge_runs')).rowCount).toBe(0);

    const declined = (await browser.request('research', `offers/${offerId}/commands`, {
      action: 'DECLINE',
      idempotencyKey: randomUUID(),
    })) as unknown as ResearchChallengeRun;
    expect(declined.status).toBe('DECLINED');
    expect((await admin.query('SELECT * FROM research.challenge_runs')).rowCount).toBe(1);
  });

  it('does not cancel an answer after START and rejects a legacy orphan challenge', async () => {
    const browser = await new Browser().login();
    await browser.activateAndHandoff();
    const accepted = (await browser.question(
      'Как провести опыт с бумажной дорожкой?',
    )) as unknown as ResearchAnswerRun;
    const worker = new ResearchWorker(databaseUrl, dataKey);
    try {
      await worker.cycle();
    } finally {
      await worker.close();
    }
    const approved = (await browser.request(
      'research',
      `answers/${accepted.id}`,
    )) as unknown as ResearchAnswerRun;
    let challenge = (await browser.request(
      'research',
      `offers/${approved.answer!.challenge.offerId}/commands`,
      { action: 'START', idempotencyKey: randomUUID() },
    )) as unknown as ResearchChallengeRun;

    const cancellation = (await browser.request('research', `answers/${accepted.id}/cancel`, {
      idempotencyKey: randomUUID(),
    })) as unknown as ResearchAnswerRun;
    expect(cancellation.status).toBe('APPROVED');
    expect(cancellation.answer).toBeUndefined();
    expect(cancellation.challengeRun).toBeUndefined();
    challenge = (await browser.request('research', `challenges/${challenge.id}/commands`, {
      action: 'NEXT',
      idempotencyKey: randomUUID(),
      expectedVersion: challenge.rowVersion,
    })) as unknown as ResearchChallengeRun;
    expect(challenge.currentStep).toBe(1);

    await admin.query("UPDATE research.answer_runs SET status='CANCELLED' WHERE id=$1", [
      accepted.id,
    ]);
    await browser.request(
      'research',
      `challenges/${challenge.id}/commands`,
      { action: 'NEXT', idempotencyKey: randomUUID(), expectedVersion: challenge.rowVersion },
      404,
    );
  });

  it('rejects a stale challenge version without skipping a step', async () => {
    const browser = await new Browser().login();
    await browser.activateAndHandoff();
    const accepted = (await browser.question(
      'Как провести опыт с бумажной дорожкой?',
    )) as unknown as ResearchAnswerRun;
    const worker = new ResearchWorker(databaseUrl, dataKey);
    try {
      await worker.cycle();
    } finally {
      await worker.close();
    }
    const approved = (await browser.request(
      'research',
      `answers/${accepted.id}`,
    )) as unknown as ResearchAnswerRun;
    const challenge = (await browser.request(
      'research',
      `offers/${approved.answer!.challenge.offerId}/commands`,
      { action: 'START', idempotencyKey: randomUUID() },
    )) as unknown as ResearchChallengeRun;
    const advanced = (await browser.request('research', `challenges/${challenge.id}/commands`, {
      action: 'NEXT',
      idempotencyKey: randomUUID(),
      expectedVersion: challenge.rowVersion,
    })) as unknown as ResearchChallengeRun;
    await browser.request(
      'research',
      `challenges/${challenge.id}/commands`,
      { action: 'NEXT', idempotencyKey: randomUUID(), expectedVersion: challenge.rowVersion },
      409,
    );
    expect(advanced).toMatchObject({ currentStep: 1, rowVersion: 1 });
    expect(
      (await admin.query('SELECT current_step,row_version FROM research.challenge_runs')).rows[0],
    ).toEqual({ current_step: 1, row_version: 1 });
  });

  it('preserves terminal challenge state and distinguishes expiry', async () => {
    const browser = await new Browser().login();
    await browser.activateAndHandoff();
    const accepted = (await browser.question(
      'Почему бумага падает?',
    )) as unknown as ResearchAnswerRun;
    const worker = new ResearchWorker(databaseUrl, dataKey);
    try {
      await worker.cycle();
    } finally {
      await worker.close();
    }
    const approved = (await browser.request(
      'research',
      `answers/${accepted.id}`,
    )) as unknown as ResearchAnswerRun;
    const first = (await browser.request(
      'research',
      `offers/${approved.answer!.challenge.offerId}/commands`,
      { action: 'START', idempotencyKey: randomUUID() },
    )) as unknown as ResearchChallengeRun;
    const abandoned = (await browser.request('research', `challenges/${first.id}/commands`, {
      action: 'CANCEL',
      idempotencyKey: randomUUID(),
      expectedVersion: first.rowVersion,
    })) as unknown as ResearchChallengeRun;
    await admin.query(
      "UPDATE research.policy_versions SET kill_epoch=kill_epoch+1 WHERE id='synthetic-m3-v1'",
    );
    await browser.request(
      'research',
      `challenges/${first.id}/commands`,
      { action: 'NEXT', idempotencyKey: randomUUID(), expectedVersion: abandoned.rowVersion },
      409,
    );
    expect(
      (await admin.query<{ status: string }>('SELECT status FROM research.challenge_runs')).rows[0]
        ?.status,
    ).toBe('ABANDONED');

    await admin.query(
      "UPDATE research.policy_versions SET kill_epoch=1 WHERE id='synthetic-m3-v1'",
    );
    const expiryBrowser = await new Browser().login('comet');
    await expiryBrowser.activateAndHandoff();
    const another = (await expiryBrowser.question(
      'Почему бумажная башня устойчива?',
    )) as unknown as ResearchAnswerRun;
    const nextWorker = new ResearchWorker(databaseUrl, dataKey);
    try {
      await nextWorker.cycle();
    } finally {
      await nextWorker.close();
    }
    const nextApproved = (await expiryBrowser.request(
      'research',
      `answers/${another.id}`,
    )) as unknown as ResearchAnswerRun;
    const expiring = (await expiryBrowser.request(
      'research',
      `offers/${nextApproved.answer!.challenge.offerId}/commands`,
      { action: 'START', idempotencyKey: randomUUID() },
    )) as unknown as ResearchChallengeRun;
    await admin.query(
      `UPDATE research.challenge_runs
       SET created_at=now()-interval '2 minutes',expires_at=now()-interval '1 second'
       WHERE id=$1`,
      [expiring.id],
    );
    const expired = (await expiryBrowser.request('research', `challenges/${expiring.id}/commands`, {
      action: 'NEXT',
      idempotencyKey: randomUUID(),
      expectedVersion: expiring.rowVersion,
    })) as unknown as ResearchChallengeRun;
    expect(expired.status).toBe('EXPIRED');
    expect(expired).not.toHaveProperty('step');
    expect(expired).not.toHaveProperty('challenge');
  });

  it('uses kill before expiry for fresh commands and persists one terminal outcome', async () => {
    const browser = await new Browser().login();
    await browser.activateAndHandoff();
    const accepted = (await browser.question(
      'Почему бумажная башня бывает устойчивой?',
    )) as unknown as ResearchAnswerRun;
    const worker = new ResearchWorker(databaseUrl, dataKey);
    try {
      await worker.cycle();
    } finally {
      await worker.close();
    }
    const approved = (await browser.request(
      'research',
      `answers/${accepted.id}`,
    )) as unknown as ResearchAnswerRun;
    const challenge = (await browser.request(
      'research',
      `offers/${approved.answer!.challenge.offerId}/commands`,
      { action: 'START', idempotencyKey: randomUUID() },
    )) as unknown as ResearchChallengeRun;
    await admin.query(
      `UPDATE research.challenge_runs
       SET created_at=now()-interval '2 minutes',expires_at=now()-interval '1 second'
       WHERE id=$1`,
      [challenge.id],
    );
    await admin.query(
      "UPDATE research.policy_versions SET kill_epoch=kill_epoch+1 WHERE id='synthetic-m3-v1'",
    );
    const blocked = (await browser.request('research', `challenges/${challenge.id}/commands`, {
      action: 'NEXT',
      idempotencyKey: randomUUID(),
      expectedVersion: challenge.rowVersion + 10,
    })) as unknown as ResearchChallengeRun;
    expect(blocked).toMatchObject({ status: 'BLOCKED_BY_POLICY', rowVersion: 1 });
    expect(blocked).not.toHaveProperty('step');
    expect(blocked).not.toHaveProperty('challenge');
    expect(
      (
        await admin.query<{ status: string }>(
          'SELECT status FROM research.challenge_runs WHERE id=$1',
          [challenge.id],
        )
      ).rows[0]?.status,
    ).toBe('BLOCKED_BY_POLICY');
  });

  it('treats active=false as a reversible fail-closed pause without consuming intent', async () => {
    const browser = await new Browser().login();
    await browser.activateAndHandoff();
    const accepted = (await browser.question(
      'Почему бумага падает?',
    )) as unknown as ResearchAnswerRun;
    const worker = new ResearchWorker(databaseUrl, dataKey);
    try {
      await worker.cycle();
    } finally {
      await worker.close();
    }
    const approved = (await browser.request(
      'research',
      `answers/${accepted.id}`,
    )) as unknown as ResearchAnswerRun;
    const offerId = approved.answer!.challenge.offerId;
    const startKey = randomUUID();
    const challenge = (await browser.request('research', `offers/${offerId}/commands`, {
      action: 'START',
      idempotencyKey: startKey,
    })) as unknown as ResearchChallengeRun;
    await admin.query(
      "UPDATE research.policy_versions SET active=false WHERE id='synthetic-m3-v1'",
    );
    const cancelKey = randomUUID();
    await browser.request(
      'research',
      `answers/${accepted.id}/cancel`,
      { idempotencyKey: cancelKey },
      403,
    );
    const pausedCommandKey = randomUUID();
    await browser.request(
      'research',
      `offers/${offerId}/commands`,
      { action: 'START', idempotencyKey: startKey },
      403,
    );
    await browser.request(
      'research',
      `challenges/${challenge.id}/commands`,
      {
        action: 'NEXT',
        idempotencyKey: pausedCommandKey,
        expectedVersion: challenge.rowVersion,
      },
      403,
    );
    expect(await browser.request('research', 'answers/current')).toEqual({});
    expect(
      (
        await admin.query<{ status: string; row_version: number }>(
          'SELECT status,row_version FROM research.challenge_runs WHERE id=$1',
          [challenge.id],
        )
      ).rows[0],
    ).toEqual({ status: 'IN_PROGRESS', row_version: challenge.rowVersion });
    expect(
      (
        await admin.query<{ count: number }>(
          'SELECT COUNT(*)::int count FROM research.command_receipts WHERE command_key=ANY($1::uuid[])',
          [[cancelKey, pausedCommandKey]],
        )
      ).rows[0]?.count,
    ).toBe(0);
    await admin.query("UPDATE research.policy_versions SET active=true WHERE id='synthetic-m3-v1'");
    const replayedCancellation = (await browser.request(
      'research',
      `answers/${accepted.id}/cancel`,
      { idempotencyKey: cancelKey },
    )) as unknown as ResearchAnswerRun;
    expect(replayedCancellation).toMatchObject({ status: 'APPROVED' });
    expect(replayedCancellation.answer).toBeUndefined();
    expect(replayedCancellation.challengeRun).toBeUndefined();
    const replayedStart = (await browser.request('research', `offers/${offerId}/commands`, {
      action: 'START',
      idempotencyKey: startKey,
    })) as unknown as ResearchChallengeRun;
    expect(replayedStart).toMatchObject({
      id: challenge.id,
      status: 'IN_PROGRESS',
      currentStep: 0,
      rowVersion: challenge.rowVersion,
    });
    const resumed = (await browser.request('research', `challenges/${challenge.id}/commands`, {
      action: 'NEXT',
      idempotencyKey: pausedCommandKey,
      expectedVersion: challenge.rowVersion,
    })) as unknown as ResearchChallengeRun;
    expect(resumed).toMatchObject({
      status: 'IN_PROGRESS',
      currentStep: 1,
      rowVersion: challenge.rowVersion + 1,
    });
  });

  it('does not cancel or consume an unstarted answer command while policy is paused', async () => {
    const browser = await new Browser().login();
    await browser.activateAndHandoff();
    const accepted = (await browser.question(
      'Почему бумага падает?',
    )) as unknown as ResearchAnswerRun;
    const worker = new ResearchWorker(databaseUrl, dataKey);
    try {
      await worker.cycle();
    } finally {
      await worker.close();
    }
    const beforeEvents = await admin.query<{ count: number }>(
      'SELECT COUNT(*)::int count FROM research.answer_delivery_events WHERE answer_run_id=$1',
      [accepted.id],
    );
    await admin.query(
      "UPDATE research.policy_versions SET active=false WHERE id='synthetic-m3-v1'",
    );
    const cancelKey = randomUUID();
    await browser.request(
      'research',
      `answers/${accepted.id}/cancel`,
      { idempotencyKey: cancelKey },
      403,
    );
    expect(
      (
        await admin.query<{ status: string }>(
          'SELECT status FROM research.answer_runs WHERE id=$1',
          [accepted.id],
        )
      ).rows[0]?.status,
    ).toBe('APPROVED');
    expect(
      (
        await admin.query<{ count: number }>(
          'SELECT COUNT(*)::int count FROM research.answer_delivery_events WHERE answer_run_id=$1',
          [accepted.id],
        )
      ).rows[0]?.count,
    ).toBe(beforeEvents.rows[0]?.count);
    expect(
      (
        await admin.query<{ count: number }>(
          'SELECT COUNT(*)::int count FROM research.command_receipts WHERE command_key=$1',
          [cancelKey],
        )
      ).rows[0]?.count,
    ).toBe(0);

    await admin.query("UPDATE research.policy_versions SET active=true WHERE id='synthetic-m3-v1'");
    const cancelled = (await browser.request('research', `answers/${accepted.id}/cancel`, {
      idempotencyKey: cancelKey,
    })) as unknown as ResearchAnswerRun;
    expect(cancelled).toMatchObject({ status: 'CANCELLED', failureCode: 'CANCELLED' });
  });

  it('does not append fresh terminal offer or challenge receipts while policy is paused', async () => {
    const browser = await new Browser().login();
    await browser.activateAndHandoff();
    const first = (await browser.question('Почему бумага падает?')) as unknown as ResearchAnswerRun;
    let worker = new ResearchWorker(databaseUrl, dataKey);
    try {
      await worker.cycle();
    } finally {
      await worker.close();
    }
    const firstAnswer = (await browser.request(
      'research',
      `answers/${first.id}`,
    )) as unknown as ResearchAnswerRun;
    const started = (await browser.request(
      'research',
      `offers/${firstAnswer.answer!.challenge.offerId}/commands`,
      { action: 'START', idempotencyKey: randomUUID() },
    )) as unknown as ResearchChallengeRun;
    const abandoned = (await browser.request('research', `challenges/${started.id}/commands`, {
      action: 'CANCEL',
      idempotencyKey: randomUUID(),
      expectedVersion: started.rowVersion,
    })) as unknown as ResearchChallengeRun;

    const second = (await browser.question(
      'Как провести опыт с бумажной дорожкой?',
    )) as unknown as ResearchAnswerRun;
    worker = new ResearchWorker(databaseUrl, dataKey);
    try {
      await worker.cycle();
    } finally {
      await worker.close();
    }
    const secondAnswer = (await browser.request(
      'research',
      `answers/${second.id}`,
    )) as unknown as ResearchAnswerRun;
    const declined = (await browser.request(
      'research',
      `offers/${secondAnswer.answer!.challenge.offerId}/commands`,
      { action: 'DECLINE', idempotencyKey: randomUUID() },
    )) as unknown as ResearchChallengeRun;

    await admin.query(
      "UPDATE research.policy_versions SET active=false WHERE id='synthetic-m3-v1'",
    );
    const terminalChallengeKey = randomUUID();
    const terminalOfferKey = randomUUID();
    await browser.request(
      'research',
      `challenges/${abandoned.id}/commands`,
      {
        action: 'CANCEL',
        idempotencyKey: terminalChallengeKey,
        expectedVersion: abandoned.rowVersion,
      },
      403,
    );
    await browser.request(
      'research',
      `offers/${secondAnswer.answer!.challenge.offerId}/commands`,
      { action: 'DECLINE', idempotencyKey: terminalOfferKey },
      403,
    );
    expect(
      (
        await admin.query<{ count: number }>(
          'SELECT COUNT(*)::int count FROM research.command_receipts WHERE command_key=ANY($1::uuid[])',
          [[terminalChallengeKey, terminalOfferKey]],
        )
      ).rows[0]?.count,
    ).toBe(0);

    await admin.query("UPDATE research.policy_versions SET active=true WHERE id='synthetic-m3-v1'");
    const replayedAbandon = (await browser.request(
      'research',
      `challenges/${abandoned.id}/commands`,
      {
        action: 'CANCEL',
        idempotencyKey: terminalChallengeKey,
        expectedVersion: abandoned.rowVersion,
      },
    )) as unknown as ResearchChallengeRun;
    expect(replayedAbandon.status).toBe('ABANDONED');
    const replayedDecline = (await browser.request(
      'research',
      `offers/${secondAnswer.answer!.challenge.offerId}/commands`,
      { action: 'DECLINE', idempotencyKey: terminalOfferKey },
    )) as unknown as ResearchChallengeRun;
    expect(replayedDecline).toMatchObject({ id: declined.id, status: 'DECLINED' });
  });

  it('serializes an answer command commit before a concurrent reversible policy pause', async () => {
    const browser = await new Browser().login();
    await browser.activateAndHandoff();
    const accepted = (await browser.question(
      'Почему бумага падает?',
    )) as unknown as ResearchAnswerRun;
    const worker = new ResearchWorker(databaseUrl, dataKey);
    try {
      await worker.cycle();
    } finally {
      await worker.close();
    }

    const blocker = await admin.connect();
    const updater = await admin.connect();
    let blockerOpen = false;
    let policyUpdate: Promise<unknown> | undefined;
    try {
      await blocker.query('BEGIN');
      blockerOpen = true;
      await blocker.query('LOCK TABLE research.command_receipts IN SHARE MODE');
      const cancelKey = randomUUID();
      const cancellation = browser.request('research', `answers/${accepted.id}/cancel`, {
        idempotencyKey: cancelKey,
      });
      await waitForBlockedQuery('INSERT INTO research.command_receipts');

      let policySettled = false;
      policyUpdate = updater
        .query("UPDATE research.policy_versions SET active=false WHERE id='synthetic-m3-v1'")
        .then(() => {
          policySettled = true;
        });
      await waitForBlockedQuery('UPDATE research.policy_versions SET active=false');
      expect(policySettled).toBe(false);

      await blocker.query('COMMIT');
      blockerOpen = false;
      const cancelled = (await cancellation) as unknown as ResearchAnswerRun;
      expect(cancelled).toMatchObject({ status: 'CANCELLED', failureCode: 'CANCELLED' });
      await policyUpdate;
      expect(
        (
          await admin.query<{ active: boolean }>(
            "SELECT active FROM research.policy_versions WHERE id='synthetic-m3-v1'",
          )
        ).rows[0]?.active,
      ).toBe(false);
    } finally {
      if (blockerOpen) await blocker.query('ROLLBACK');
      await policyUpdate?.catch(() => undefined);
      blocker.release();
      updater.release();
    }
  });

  it('queues a later policy reader behind an already waiting pause writer', async () => {
    const firstReader = await admin.connect();
    const writer = await admin.connect();
    const lateReader = await admin.connect();
    let firstReaderOpen = false;
    let lateReaderOpen = false;
    let writerUpdate: Promise<unknown> | undefined;
    let lateRead: Promise<{ policy_active: boolean; current_kill_epoch: number }> | undefined;
    try {
      await firstReader.query('BEGIN');
      firstReaderOpen = true;
      await firstReader.query('SET LOCAL ROLE probyu_family_runtime');
      await firstReader.query("SELECT * FROM research.lock_policy_version('synthetic-m3-v1')");

      writerUpdate = writer.query(
        "UPDATE research.policy_versions SET active=false WHERE id='synthetic-m3-v1' /* policy-fair-writer */",
      );
      await waitForBlockedQuery('policy-fair-writer');

      await lateReader.query('BEGIN');
      lateReaderOpen = true;
      await lateReader.query('SET LOCAL ROLE probyu_family_runtime');
      lateRead = lateReader
        .query<{ policy_active: boolean; current_kill_epoch: number }>(
          "SELECT * FROM research.lock_policy_version('synthetic-m3-v1') /* policy-fair-reader */",
        )
        .then((result) => result.rows[0]!);
      await waitForBlockedQuery('policy-fair-reader');

      await firstReader.query('COMMIT');
      firstReaderOpen = false;
      await writerUpdate;
      expect(await lateRead).toEqual({ policy_active: false, current_kill_epoch: 1 });
      await lateReader.query('COMMIT');
      lateReaderOpen = false;
    } finally {
      if (firstReaderOpen) await firstReader.query('ROLLBACK');
      if (lateReaderOpen) await lateReader.query('ROLLBACK');
      await writerUpdate?.catch(() => undefined);
      await lateRead?.catch(() => undefined);
      firstReader.release();
      writer.release();
      lateReader.release();
    }
  });

  it('locks family and answer before approval events so concurrent cancel cannot deadlock', async () => {
    const browser = await new Browser().login();
    await browser.activateAndHandoff();
    const accepted = (await browser.question(
      'Почему бумага падает?',
    )) as unknown as ResearchAnswerRun;
    const blocker = await admin.connect();
    const worker = new ResearchWorker(databaseUrl, dataKey);
    let blockerOpen = false;
    let workerCycle: Promise<{ processed: number }> | undefined;
    let cancellation: Promise<Record<string, unknown>> | undefined;
    try {
      await blocker.query('BEGIN');
      blockerOpen = true;
      await blocker.query('LOCK TABLE research.answer_delivery_events IN SHARE MODE');
      workerCycle = worker.cycle();
      await waitForBlockedQuery("'ANSWER_APPROVED'");

      const cancelKey = randomUUID();
      cancellation = browser.request('research', `answers/${accepted.id}/cancel`, {
        idempotencyKey: cancelKey,
      });
      await waitForBlockedQuery("family.families WHERE id=$1 AND status='ACTIVE' FOR UPDATE");

      await blocker.query('COMMIT');
      blockerOpen = false;
      await expect(workerCycle).resolves.toEqual({ processed: 1 });
      await expect(cancellation).resolves.toMatchObject({
        status: 'CANCELLED',
        failureCode: 'CANCELLED',
      });
      expect(
        (
          await admin.query<{ sequence: number }>(
            `SELECT sequence FROM research.answer_delivery_events
             WHERE answer_run_id=$1 ORDER BY sequence`,
            [accepted.id],
          )
        ).rows.map((row) => row.sequence),
      ).toEqual([1, 2, 3]);
      expect(
        (
          await admin.query<{ count: number }>(
            'SELECT COUNT(*)::int count FROM research.command_receipts WHERE command_key=$1',
            [cancelKey],
          )
        ).rows[0]?.count,
      ).toBe(1);
    } finally {
      if (blockerOpen) await blocker.query('ROLLBACK');
      await workerCycle?.catch(() => undefined);
      await cancellation?.catch(() => undefined);
      blocker.release();
      await worker.close();
    }
  });

  it('serializes completed delivery before a concurrent policy kill', async () => {
    const browser = await new Browser().login();
    await browser.activateAndHandoff();
    const accepted = (await browser.question(
      'Почему бумага падает?',
    )) as unknown as ResearchAnswerRun;
    const worker = new ResearchWorker(databaseUrl, dataKey);
    try {
      await worker.cycle();
    } finally {
      await worker.close();
    }

    const blocker = await admin.connect();
    const updater = await admin.connect();
    let blockerOpen = false;
    let policyUpdate: Promise<unknown> | undefined;
    try {
      await blocker.query('BEGIN');
      blockerOpen = true;
      await blocker.query('LOCK TABLE research.answer_delivery_events IN SHARE MODE');
      const delivery = app.inject({
        method: 'GET',
        url: `/v1/research/answers/${accepted.id}/events?cursor=1`,
        headers: { cookie: browser.cookie, origin: family.origin },
      });
      await waitForBlockedQuery("'ANSWER_COMPLETED'");

      let policySettled = false;
      policyUpdate = updater
        .query(
          "UPDATE research.policy_versions SET active=false,kill_epoch=kill_epoch+1 WHERE id='synthetic-m3-v1'",
        )
        .then(() => {
          policySettled = true;
        });
      await waitForBlockedQuery('UPDATE research.policy_versions SET active=false,kill_epoch');
      expect(policySettled).toBe(false);

      await blocker.query('COMMIT');
      blockerOpen = false;
      expect((await delivery).statusCode).toBe(200);
      await policyUpdate;
      expect(
        (
          await admin.query<{ status: string }>(
            'SELECT status FROM research.answer_runs WHERE id=$1',
            [accepted.id],
          )
        ).rows[0]?.status,
      ).toBe('COMPLETED');
      await browser.request('research', `answers/${accepted.id}`, undefined, 403);
    } finally {
      if (blockerOpen) await blocker.query('ROLLBACK');
      await policyUpdate?.catch(() => undefined);
      blocker.release();
      updater.release();
    }
  });

  it('reads both legacy M3 artifact hash shapes without disabling integrity checks', async () => {
    const browser = await new Browser().login();
    await browser.activateAndHandoff();
    const accepted = (await browser.question(
      'Почему бумага падает?',
    )) as unknown as ResearchAnswerRun;
    const worker = new ResearchWorker(databaseUrl, dataKey);
    try {
      await worker.cycle();
    } finally {
      await worker.close();
    }
    const approved = (await browser.request(
      'research',
      `answers/${accepted.id}`,
    )) as unknown as ResearchAnswerRun;
    await admin.query(
      "UPDATE research.approved_answer_artifacts SET schema_version='approved-answer-m3-v1' WHERE answer_run_id=$1",
      [accepted.id],
    );
    await browser.request('research', `answers/${accepted.id}`, undefined, 503);

    const legacyVersionId = '10000000-0000-4000-8000-000000000091';
    const legacyVersionKey = 'legacy-test-paper-shapes';
    const sourceChallenge = approved.answer!.challenge;
    const versionHash = contentHash({
      id: legacyVersionId,
      key: legacyVersionKey,
      version: 1,
      kind: sourceChallenge.kind,
      title: sourceChallenge.title,
      goal: sourceChallenge.goal,
      durationMinutes: sourceChallenge.durationMinutes,
      materials: sourceChallenge.materials,
      steps: sourceChallenge.steps,
      ageBands: sourceChallenge.ageBands,
    });
    await admin.query(
      `INSERT INTO research.challenge_versions(
        id,key,version,kind,title,goal,duration_minutes,resume_window_minutes,
        materials,steps,age_bands,risk_class,supervision_requirement,origin,
        distribution_scope,status,policy_version,content_hash,reviewed_by,published_at
       ) VALUES($1,$2,1,$3,$4,$5,$6,NULL,$7,$8,$9,'MINIMAL_RISK','NONE','CURATED',
        'CATALOG','PUBLISHED','synthetic-m3-v1',$10,'legacy-test-fixture',now())
       ON CONFLICT(key,version) DO NOTHING`,
      [
        legacyVersionId,
        legacyVersionKey,
        sourceChallenge.kind,
        sourceChallenge.title,
        sourceChallenge.goal,
        sourceChallenge.durationMinutes,
        JSON.stringify(sourceChallenge.materials),
        JSON.stringify(sourceChallenge.steps),
        JSON.stringify(sourceChallenge.ageBands),
        versionHash,
      ],
    );
    const recentV1Challenge = {
      ...sourceChallenge,
      versionId: legacyVersionId,
      version: 1,
      contentHash: versionHash,
    };
    const recentV1Hash = contentHash({
      explanation: approved.answer!.explanation,
      roleNotice: approved.answer!.roleNotice,
      challenge: recentV1Challenge,
    });
    await admin.query(
      `UPDATE research.challenge_offers SET challenge_version_id=$2 WHERE answer_run_id=$1`,
      [accepted.id, legacyVersionId],
    );
    await admin.query(
      `UPDATE research.approved_answer_artifacts
       SET schema_version='approved-answer-m3-v1',content_hash=$2 WHERE answer_run_id=$1`,
      [accepted.id, recentV1Hash],
    );
    const recentV1 = (await browser.request(
      'research',
      `answers/${accepted.id}`,
    )) as unknown as ResearchAnswerRun;
    expect(recentV1.answer?.challenge.riskClass).toBe('MINIMAL_RISK');

    const { ageBands, riskClass, supervisionRequirement, ...legacyChallenge } = recentV1Challenge;
    expect(ageBands).toBeDefined();
    expect(riskClass).toBe('MINIMAL_RISK');
    expect(supervisionRequirement).toBe('NONE');
    const legacyHash = contentHash({
      explanation: approved.answer!.explanation,
      roleNotice: approved.answer!.roleNotice,
      challenge: legacyChallenge,
    });
    await admin.query(
      'UPDATE research.approved_answer_artifacts SET content_hash=$2 WHERE answer_run_id=$1',
      [accepted.id, legacyHash],
    );
    const legacy = (await browser.request(
      'research',
      `answers/${accepted.id}`,
    )) as unknown as ResearchAnswerRun;
    expect(legacy.answer?.challenge).toMatchObject({
      ageBands: ['8_10', '11_12', '13_14'],
      riskClass: 'MINIMAL_RISK',
      supervisionRequirement: 'NONE',
    });

    await admin.query(
      "UPDATE research.approved_answer_artifacts SET content_hash=repeat('0',64) WHERE answer_run_id=$1",
      [accepted.id],
    );
    await browser.request('research', `answers/${accepted.id}`, undefined, 503);
  });

  it('does not append a terminal event when cancelling a completed run', async () => {
    const browser = await new Browser().login();
    await browser.activateAndHandoff();
    const accepted = (await browser.question(
      'Почему бумага падает?',
    )) as unknown as ResearchAnswerRun;
    const worker = new ResearchWorker(databaseUrl, dataKey);
    try {
      await worker.cycle();
    } finally {
      await worker.close();
    }
    await app.inject({
      method: 'GET',
      url: `/v1/research/answers/${accepted.id}/events?cursor=1`,
      headers: { cookie: browser.cookie, origin: family.origin },
    });
    const before = await admin.query<{ count: number }>(
      'SELECT COUNT(*)::int count FROM research.answer_delivery_events WHERE answer_run_id=$1',
      [accepted.id],
    );
    await admin.query(
      "UPDATE research.policy_versions SET kill_epoch=kill_epoch+1 WHERE id='synthetic-m3-v1'",
    );
    const cancelKey = randomUUID();
    const completed = (await browser.request('research', `answers/${accepted.id}/cancel`, {
      idempotencyKey: cancelKey,
    })) as unknown as ResearchAnswerRun;
    const after = await admin.query<{ count: number }>(
      'SELECT COUNT(*)::int count FROM research.answer_delivery_events WHERE answer_run_id=$1',
      [accepted.id],
    );
    expect(completed.status).toBe('COMPLETED');
    expect(completed.answer).toBeUndefined();
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
    await admin.query(
      "UPDATE research.policy_versions SET kill_epoch=1 WHERE id='synthetic-m3-v1'",
    );
    const replayed = (await browser.request('research', `answers/${accepted.id}/cancel`, {
      idempotencyKey: cancelKey,
    })) as unknown as ResearchAnswerRun;
    expect(replayed.status).toBe('COMPLETED');
    expect(replayed.answer).toBeUndefined();
  });

  it('reports NFKC-expanded input length separately from safety blocking', async () => {
    const browser = await new Browser().login();
    await browser.activateAndHandoff();
    const denied = (await browser.question(
      'ﬃ'.repeat(200),
      randomUUID(),
      200,
    )) as unknown as ResearchAnswerRun;
    expect(denied).toMatchObject({ status: 'DENIED', failureCode: 'INPUT_TOO_LONG' });
    expect((await admin.query('SELECT * FROM research.outbox')).rowCount).toBe(0);
  });

  it('rejects malformed SSE identifiers before hijacking the response', async () => {
    const browser = await new Browser().login();
    await browser.activateAndHandoff();
    const response = await app.inject({
      method: 'GET',
      url: '/v1/research/answers/not-a-uuid/events',
      headers: { cookie: browser.cookie, origin: family.origin },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: 'INVALID_REQUEST' });
  });

  it('does not disclose another family answer run', async () => {
    const aurora = await new Browser().login('aurora');
    await aurora.activateAndHandoff();
    const run = (await aurora.question('Почему бумага падает?')) as unknown as ResearchAnswerRun;
    const comet = await new Browser().login('comet');
    await comet.activateAndHandoff();
    await comet.request('research', `answers/${run.id}`, undefined, 404);
  });
});
