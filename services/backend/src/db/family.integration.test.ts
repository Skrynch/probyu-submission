import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type {
  FamilyAction,
  FamilyChallenge,
  FamilyReauthResponse,
  FamilySession,
} from '@probyu/contracts/types';
import { buildApp } from '../app.js';
import { FamilyService, type FamilyConfig } from '../modules/family/service.js';
import { POLICY } from '../modules/family/policy.js';

const config: FamilyConfig = {
  mode: 'synthetic',
  environment: 'test',
  origin: 'http://127.0.0.1:4174',
  key: randomBytes(32).toString('base64url'),
  databaseUrl: 'postgresql://probyu:probyu_local@127.0.0.1:54329/probyu_m2_test',
};
const admin = new Pool({ connectionString: config.databaseUrl });
const service = new FamilyService({
  ...config,
  databaseUrl: config.databaseUrl + '?application_name=m2_worker',
});
let app: FastifyInstance;
class Browser {
  cookie = '';
  csrf = '';
  token() {
    return this.cookie.split('=')[1]!;
  }
  async request(
    path: string,
    body?: unknown,
    expected = 200,
    method: 'GET' | 'POST' = 'POST',
    extra: Record<string, string> = {},
  ) {
    const options: InjectOptions = {
      method,
      url: `/v1/family/${path}`,
      headers: {
        origin: config.origin,
        cookie: this.cookie,
        'x-csrf-token': this.csrf,
        'x-probyu-bootstrap': '1',
        ...extra,
      },
      ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
    };
    const r = await app.inject(options);
    expect(r.statusCode, `${path}: ${r.body}`).toBe(expected);
    const setCookie = r.headers['set-cookie'];
    if (typeof setCookie === 'string') this.cookie = setCookie.split(';')[0]!;
    const value = r.json<Record<string, unknown>>();
    if (typeof value.csrfToken === 'string') this.csrf = value.csrfToken;
    return value;
  }
  async login(identity: 'aurora' | 'comet' = 'aurora') {
    await this.request('bootstrap');
    const c = await this.request('login/challenge', { identity });
    await this.request('login', { challengeId: c.challengeId, code: c.devCode });
    return this;
  }
  async receipt(action: FamilyAction) {
    const c = (await this.request('reauth/challenge', { action })) as unknown as FamilyChallenge;
    return (
      (await this.request('reauth', {
        challengeId: c.challengeId,
        code: c.devCode,
      })) as unknown as FamilyReauthResponse
    ).receiptId;
  }
  async command(action: FamilyAction, expected = 200, key = randomUUID()) {
    const receiptId = await this.receipt(action);
    const result = await this.request(
      'commands',
      { action, receiptId, idempotencyKey: key },
      expected,
    );
    if (expected === 200 && action.kind !== 'REVOKE_BROWSER') {
      await this.view();
    }
    return result;
  }
  async view() {
    return (await this.request('session', undefined, 200, 'GET')) as unknown as FamilySession;
  }
  async activate(history = false) {
    await this.command({
      kind: 'ACTIVATE',
      documentVersion: POLICY,
      ageBand: '8_10',
      text: true,
      history,
    });
    return (await this.view()).child!.id;
  }
}
const activate: FamilyAction = {
  kind: 'ACTIVATE',
  documentVersion: POLICY,
  ageBand: '8_10',
  text: true,
  history: false,
};
beforeEach(async () => {
  if (app) await app.close();
  await admin.query(
    'TRUNCATE identity.auth_budgets,family.families,identity.parents,identity.registrations,identity.sessions,identity.proofs,family.memberships,family.representatives,family.children,family.reauth_receipts,family.consent_receipts,family.consent_projections,family.command_receipts,ops.family_outbox,family.processing_authorizations CASCADE',
  );
  app = await buildApp({ family: config });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await service.pool.end();
  await admin.end();
});

describe('M2 PostgreSQL authorization boundary', () => {
  it('keeps public demo available during a family database outage and denies private operations', async () => {
    const unavailable = await buildApp({
      family: { ...config, databaseUrl: 'postgresql://unavailable@127.0.0.1:1/unavailable' },
    });
    try {
      await unavailable.ready();
      const demo = await unavailable.inject('/v1/demo/scenarios/paper-fall');
      expect(demo.statusCode).toBe(200);
      expect(demo.headers['x-frame-options']).toBe('DENY');
      const privateResponse = await unavailable.inject({
        method: 'POST',
        url: '/v1/family/bootstrap',
        headers: { origin: config.origin, 'x-probyu-bootstrap': '1' },
      });
      expect(privateResponse.statusCode).toBe(503);
      expect(privateResponse.json()).toEqual({ code: 'UNAVAILABLE' });
      expect(privateResponse.headers['set-cookie']).toBeUndefined();
    } finally {
      await unavailable.close();
    }
  });
  it('cannot exhaust another adult session from child challenge or verification paths', async () => {
    const childBrowser = await new Browser().login();
    const child = await childBrowser.activate();
    await childBrowser.command({ kind: 'HANDOFF', childId: child });
    for (const action of [{ kind: 'PAUSE', childId: child }, { kind: 'REVOKE_BROWSER' }])
      await childBrowser.request('reauth/challenge', { action }, 403);
    const returnProof = await childBrowser.request('reauth/challenge', {
      action: { kind: 'RETURN' },
    });
    for (let n = 0; n < 30; n++)
      await childBrowser.request('login/challenge', { identity: 'aurora' }, 403);
    // Bogus proof ids and wrong purpose must not touch an adult's limiter either.
    for (let n = 0; n < 29; n++)
      await childBrowser.request(
        n % 2 ? 'login' : 'reauth',
        { challengeId: randomUUID(), code: '000000' },
        403,
      );
    await childBrowser.request(
      'reauth',
      { challengeId: returnProof.challengeId, code: returnProof.devCode },
      429,
    );
    const adult = await new Browser().login();
    await adult.command({ kind: 'PAUSE', childId: child });
    await adult.command({
      kind: 'CONSENT',
      childId: child,
      documentVersion: POLICY,
      purpose: 'TEXT',
      granted: false,
    });
    expect((await childBrowser.view()).child?.textAllowed).toBe(false);
    await adult.command({ kind: 'REVOKE_BROWSER' });
  });
  it('does not disclose a prior command across receipt, browser, mode or privilege expiry', async () => {
    const b = await new Browser().login();
    const receiptId = await b.receipt(activate),
      key = randomUUID();
    const body = { action: activate, receiptId, idempotencyKey: key };
    await b.request('commands', body);
    await b.request('commands', body); // exact legitimate retry
    await admin.query("UPDATE family.representatives SET expires_at=now()-interval '1 second'");
    await b.request('commands', body, 403);
    await admin.query("UPDATE family.representatives SET expires_at=now()+interval '1 day'");
    await b.request('commands', { ...body, receiptId: randomUUID() }, 403);
    const other = await new Browser().login();
    await other.request('commands', body, 403);
    await service.context(b.token(), async ({ client, session }) => {
      await client.query(
        "UPDATE identity.sessions SET parent_seen=now()-interval '6 minutes' WHERE id=$1",
        [session.id],
      );
    });
    await b.request('commands', body, 403);
    await b.command({ kind: 'RETURN' });
    const child = (await b.view()).child!.id;
    await b.command({ kind: 'HANDOFF', childId: child });
    await b.request('commands', body, 403);
    expect((await admin.query('SELECT * FROM family.children')).rowCount).toBe(1);
    const payload = (await b.view()).child!;
    expect(payload).not.toHaveProperty('textGranted');
    expect(payload).not.toHaveProperty('historyGranted');
    expect(payload).not.toHaveProperty('textExpiresAt');
  });
  it('renews synthetic representation on a new verified login but never silently renews consent', async () => {
    const b = await new Browser().login(),
      child = await b.activate();
    await admin.query("UPDATE family.representatives SET expires_at=now()-interval '1 second'");
    await admin.query("UPDATE family.consent_projections SET expires_at=now()-interval '1 second'");
    await b.command({ kind: 'PAUSE', childId: child }, 403);
    const renewed = await new Browser().login();
    expect(
      (await admin.query('SELECT * FROM family.representatives WHERE expires_at>now()')).rowCount,
    ).toBe(1);
    expect((await renewed.view()).child!.textAllowed).toBe(false);
    expect((await admin.query('SELECT * FROM family.consent_receipts')).rowCount).toBe(2);
    await renewed.command({
      kind: 'CONSENT',
      childId: child,
      purpose: 'TEXT',
      granted: true,
      documentVersion: POLICY,
    });
    expect((await renewed.view()).child!.textAllowed).toBe(true);
  });
  it('bounds identity issuance across anonymous sessions while an issued code remains verifiable', async () => {
    const first = new Browser();
    await first.request('bootstrap');
    const issued = await first.request('login/challenge', { identity: 'aurora' });
    for (let n = 0; n < 29; n++) {
      const b = new Browser();
      await b.request('bootstrap');
      await b.request('login/challenge', { identity: 'aurora' });
    }
    const denied = new Browser();
    await denied.request('bootstrap');
    await denied.request('login/challenge', { identity: 'aurora' }, 429);
    await first.request('login', { challengeId: issued.challengeId, code: issued.devCode });
    expect((await first.view()).mode).toBe('PARENT');
    const budgets = await admin.query<{ key: string }>('SELECT key FROM identity.auth_budgets');
    expect(budgets.rows.every((b) => /^[a-f0-9]{64}$/.test(b.key))).toBe(true);
    await expect(
      service.transaction((c) => c.query('SELECT * FROM identity.auth_budgets')),
    ).resolves.toMatchObject({ rowCount: 0 });
  });
  it('limits bootstrap before creating rows and does not trust X-Forwarded-For', async () => {
    for (let n = 0; n < 120; n++) await new Browser().request('bootstrap');
    const before = (await admin.query('SELECT * FROM identity.sessions')).rowCount;
    await new Browser().request('bootstrap', undefined, 429, 'POST', {
      'x-forwarded-for': '203.0.113.99',
    });
    expect((await admin.query('SELECT * FROM identity.sessions')).rowCount).toBe(before);
  });
  it('prunes expired ephemeral credentials without deleting consent evidence or granting DELETE', async () => {
    const b = await new Browser().login();
    await b.activate();
    await b.receipt({ kind: 'RETURN' }); // unreferenced receipt can be pruned
    await new Browser().request('bootstrap');
    await admin.query("UPDATE identity.proofs SET expires_at=now()-interval '1 second'");
    await admin.query("UPDATE family.reauth_receipts SET expires_at=now()-interval '1 second'");
    await admin.query("UPDATE identity.sessions SET expires_at=now()-interval '1 second'");
    await service.pruneExpired();
    expect((await admin.query('SELECT * FROM identity.proofs')).rowCount).toBe(0);
    expect((await admin.query('SELECT * FROM family.reauth_receipts')).rowCount).toBe(1);
    expect((await admin.query('SELECT * FROM identity.sessions')).rowCount).toBe(1);
    expect((await admin.query('SELECT * FROM family.consent_receipts')).rowCount).toBe(2);
    await expect(
      service.transaction((c) => c.query('DELETE FROM identity.sessions')),
    ).rejects.toThrow();
    await b.request('session', undefined, 401, 'GET');
  });
  it('uses a restricted maintenance owner and bounds cleanup while retaining active sessions', async () => {
    const owner = (
      await admin.query<
        Record<string, string | boolean>
      >(`SELECT r.rolname,r.rolsuper,r.rolbypassrls,r.rolcanlogin,r.rolcreaterole,r.rolcreatedb,r.rolreplication,r.rolinherit
      FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid='identity.prune_expired_auth()'::regprocedure`)
    ).rows[0];
    expect(owner).toEqual({
      rolname: 'probyu_family_maintenance',
      rolsuper: false,
      rolbypassrls: false,
      rolcanlogin: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolreplication: false,
      rolinherit: false,
    });
    const privileges = (
      await admin.query<Record<string, boolean>>(`SELECT
      pg_has_role('probyu_family_runtime','probyu_family_maintenance','MEMBER') AS member,
      has_schema_privilege('probyu_family_maintenance','identity','CREATE') AS can_create,
      has_table_privilege('probyu_family_maintenance','family.consent_receipts','DELETE') AS can_delete_evidence,
      has_column_privilege('probyu_family_maintenance','identity.sessions','digest','SELECT') AS can_read_secret`)
    ).rows[0];
    expect(privileges).toEqual({
      member: false,
      can_create: false,
      can_delete_evidence: false,
      can_read_secret: false,
    });
    // SET ROLE permission follows session_user, so drop the synthetic admin identity too.
    const runtime = await admin.connect();
    try {
      await runtime.query('SET SESSION AUTHORIZATION probyu_family_runtime');
      await expect(runtime.query('SET ROLE probyu_family_maintenance')).rejects.toThrow();
      await expect(runtime.query('DELETE FROM identity.sessions')).rejects.toThrow();
    } finally {
      await runtime.query('RESET SESSION AUTHORIZATION');
      runtime.release();
    }
    const active = new Browser();
    await active.request('bootstrap');
    await admin.query(`INSERT INTO identity.sessions(id,digest,mode,expires_at)
      SELECT gen_random_uuid(),repeat(md5(i::text),2),'ANONYMOUS',now()-interval '1 day' FROM generate_series(1,1002) i`);
    await service.pruneExpired();
    expect((await admin.query('SELECT * FROM identity.sessions')).rowCount).toBe(3);
    expect((await active.view()).mode).toBe('ANONYMOUS');
    await service.pruneExpired();
    expect((await admin.query('SELECT * FROM identity.sessions')).rowCount).toBe(1);
  });
  it('requires the configured proxy assertion and isolates normalized client IP budgets', async () => {
    const proxyKey = randomBytes(32).toString('hex');
    const proxied = await buildApp({ family: { ...config, proxyKey } });
    const request = (ip: string, key: string | undefined = proxyKey, remoteAddress = '127.0.0.1') =>
      proxied.inject({
        method: 'POST',
        url: '/v1/family/bootstrap',
        remoteAddress,
        headers: {
          origin: config.origin,
          'x-probyu-bootstrap': '1',
          'x-probyu-client-ip': ip,
          ...(key ? { 'x-probyu-proxy-key': key } : {}),
          'x-forwarded-for': '192.0.2.99',
        },
      });
    try {
      await proxied.ready();
      for (const ip of ['not-an-ip', '192.0.2.1,192.0.2.2', 'fe80::1%lo0'])
        expect((await request(ip)).statusCode).toBe(403);
      expect((await request('192.0.2.1', '')).statusCode).toBe(403);
      expect((await request('192.0.2.1', '0'.repeat(64))).statusCode).toBe(403);
      expect((await request('192.0.2.1', proxyKey, '192.0.2.200')).statusCode).toBe(403);
      expect((await admin.query('SELECT * FROM identity.auth_budgets')).rowCount).toBe(0);
      expect((await request('192.0.2.1')).statusCode).toBe(200);
      expect((await request('192.0.2.2')).statusCode).toBe(200);
      await admin.query('UPDATE identity.auth_budgets SET attempts=120');
      expect((await request('::ffff:c000:201')).statusCode).toBe(429);
      expect((await request('192.0.2.3')).statusCode).toBe(200);
      expect((await proxied.inject('/v1/demo/scenarios/paper-fall')).statusCode).toBe(200);
      expect((await proxied.inject('/v1/family/session')).statusCode).toBe(403);
    } finally {
      await proxied.close();
    }
  });
  it('renews child idle only after an admitted user operation and never extends absolute expiry', async () => {
    const b = await new Browser().login(),
      child = await b.activate();
    await b.command({ kind: 'HANDOFF', childId: child });
    let now = new Date();
    const timed = new FamilyService(config, () => now);
    try {
      const t0 = now.getTime();
      now = new Date(t0 + 29 * 60_000);
      await timed.admit(b.token(), child, 'TEXT');
      now = new Date(t0 + 31 * 60_000);
      expect((await timed.view(b.token())).mode).toBe('CHILD');
      await expect(timed.admit(b.token(), randomUUID(), 'TEXT')).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      now = new Date(t0 + 59 * 60_000);
      await expect(timed.view(b.token())).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
      await admin.query(
        "UPDATE identity.sessions SET last_seen=now()+interval '12 hours' WHERE revoked_at IS NULL",
      );
      now = new Date(t0 + 12 * 60 * 60_000);
      await expect(timed.admit(b.token(), child, 'TEXT')).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });
    } finally {
      await timed.pool.end();
    }
  });
  it('activates without history, rotates all registration lineages, and requires fresh return proof', async () => {
    const b = await new Browser().login();
    const child = await b.activate();
    const parentCookie = b.cookie;
    await b.command({ kind: 'HANDOFF', childId: child });
    expect((await b.view()).mode).toBe('CHILD');
    expect((await b.view()).familyId).toBeUndefined();
    expect(b.cookie).not.toBe(parentCookie);
    const stale = new Browser();
    stale.cookie = parentCookie;
    await stale.request('session', undefined, 401, 'GET');
    const id = await service.admit(b.token(), child, 'TEXT');
    expect(await service.deliver(b.token(), id)).toBe(true);
    await expect(service.admit(b.token(), child, 'HISTORY')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await b.request(
      'reauth/challenge',
      {
        action: {
          kind: 'CONSENT',
          childId: child,
          documentVersion: POLICY,
          purpose: 'HISTORY',
          granted: true,
        },
      },
      403,
    );
    await b.command({ kind: 'RETURN' });
    expect((await b.view()).mode).toBe('PARENT');
  });
  it('rejects login-CSRF, missing tokens, duplicate cookies, unknown fields and production synthetic configuration', async () => {
    const b = new Browser();
    await b.request('bootstrap', undefined, 403, 'POST', { origin: 'https://attacker.invalid' });
    await b.request('bootstrap');
    await b.request('login/challenge', { identity: 'aurora' }, 403, 'POST', {
      'x-csrf-token': 'wrong',
    });
    await b.request('login/challenge', { identity: 'aurora', parent: true }, 400);
    await b.request('session', undefined, 401, 'GET', { cookie: `${b.cookie}; ${b.cookie}` });
    expect(() => new FamilyService({ ...config, environment: 'production' as 'test' })).toThrow();
    const disabled = await buildApp();
    expect(
      (await disabled.inject({ method: 'POST', url: '/v1/family/bootstrap' })).statusCode,
    ).toBe(404);
    await disabled.close();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/family/bootstrap',
          headers: { origin: config.origin, 'x-probyu-bootstrap': '1' },
        })
      ).headers['set-cookie'],
    ).toMatch(/Secure; HttpOnly; SameSite=Lax; Path=\//);
  });
  it('bounds failed attempts, expires and consumes credentials without rollback of attempt counters', async () => {
    const b = new Browser();
    await b.request('bootstrap');
    const c = await b.request('login/challenge', { identity: 'aurora' });
    for (let i = 0; i < 5; i++)
      await b.request('login', { challengeId: c.challengeId, code: '000000' }, 403);
    await b.request('login', { challengeId: c.challengeId, code: c.devCode }, 403);
    const c2 = await b.request('login/challenge', { identity: 'aurora' });
    await admin.query(
      "UPDATE identity.proofs SET expires_at=now()-interval '1 second' WHERE id=$1",
      [c2.challengeId],
    );
    await b.request('login', { challengeId: c2.challengeId, code: c2.devCode }, 403);
    const c3 = await b.request('login/challenge', { identity: 'aurora' });
    const oldCookie = b.cookie;
    await b.request('login', { challengeId: c3.challengeId, code: c3.devCode });
    await b.request('login', { challengeId: c3.challengeId, code: c3.devCode }, 403);
    await b.request('session', undefined, 401, 'GET', { cookie: oldCookie });
    const a = await b.receipt(activate);
    await admin.query(
      "UPDATE family.reauth_receipts SET expires_at=now()-interval '1 second' WHERE id=$1",
      [a],
    );
    await b.request(
      'commands',
      { action: activate, receiptId: a, idempotencyKey: randomUUID() },
      403,
    );
  });
  it('does not promote stale parent privileges; checks absolute and idle expiry on every read', async () => {
    const b = await new Browser().login();
    await b.activate();
    await admin.query(
      "UPDATE identity.sessions SET parent_seen=now()-interval '6 minutes' WHERE digest IS NOT NULL AND revoked_at IS NULL",
    );
    const locked = await b.view();
    expect(locked.mode).toBe('LOCKED');
    expect(locked.child).toBeUndefined();
    await b.command({ kind: 'RETURN' });
    expect((await b.view()).mode).toBe('PARENT');
    await admin.query(
      "UPDATE identity.sessions SET last_seen=now()-interval '31 minutes' WHERE revoked_at IS NULL",
    );
    await b.request('session', undefined, 401, 'GET');
    await b.request('bootstrap');
    await admin.query(
      "UPDATE identity.sessions SET expires_at=now()-interval '1 second' WHERE revoked_at IS NULL",
    );
    await b.request('session', undefined, 401, 'GET');
  });
  it('binds one-use proof to exact action and browser; atomically deduplicates commands and outbox', async () => {
    const a = await new Browser().login();
    const b = await new Browser().login();
    const receipt = await a.receipt(activate),
      key = randomUUID();
    await b.request('commands', { action: activate, receiptId: receipt, idempotencyKey: key }, 403);
    await a.request(
      'commands',
      { action: { ...activate, history: true }, receiptId: receipt, idempotencyKey: key },
      403,
    );
    const body = { action: activate, receiptId: receipt, idempotencyKey: key };
    await Promise.all([a.request('commands', body), a.request('commands', body)]);
    expect((await admin.query('SELECT * FROM family.children')).rowCount).toBe(1);
    expect((await admin.query('SELECT * FROM ops.family_outbox')).rowCount).toBe(1);
    expect((await admin.query('SELECT * FROM family.consent_receipts')).rowCount).toBe(2);
    await a.request('commands', { ...body, idempotencyKey: randomUUID() }, 403);
    await a.request('commands', { ...body, action: { ...activate, history: true } }, 403);
  });
  it('denies cross-family and sibling read/write at both service and RLS boundaries', async () => {
    const a = await new Browser().login(),
      childA = await a.activate();
    const b = await new Browser().login('comet'),
      childB = await b.activate();
    await a.command({ kind: 'PAUSE', childId: childB }, 403);
    await a.command({ kind: 'HANDOFF', childId: childA });
    await expect(service.admit(a.token(), childB, 'TEXT')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const familyA = (
      await admin.query<{ family_id: string }>(
        'SELECT family_id FROM family.children WHERE id=$1',
        [childA],
      )
    ).rows[0]!.family_id;
    const sibling = randomUUID();
    await admin.query(
      "INSERT INTO family.children(id,family_id,nickname,age_band) VALUES($1,$2,'Исследователь','13_14')",
      [sibling, familyA],
    );
    expect((await a.view()).child!.id).toBe(childA);
    await expect(service.admit(a.token(), sibling, 'TEXT')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await service.transaction(async (c) => {
      expect((await c.query('SELECT * FROM family.children')).rowCount).toBe(0);
      await c.query("SELECT set_config('app.family_id',$1,true)", [familyA]);
      expect((await c.query('SELECT * FROM family.children WHERE id=$1', [childB])).rowCount).toBe(
        0,
      );
      expect(
        (await c.query("UPDATE family.children SET status='PAUSED' WHERE id=$1", [childB]))
          .rowCount,
      ).toBe(0);
      expect(
        (await c.query<{ current_user: string }>('SELECT current_user')).rows[0]!.current_user,
      ).toBe('probyu_family_runtime');
    });
    await expect(
      service.transaction(async (c) => {
        await c.query("SELECT set_config('app.family_id',$1,true)", [familyA]);
        await c.query('UPDATE family.children SET family_id=$1 WHERE id=$2', [
          randomUUID(),
          childA,
        ]);
      }),
    ).rejects.toThrow();
  });
  it('keeps receipts immutable and rejects a family without an owner at commit', async () => {
    const b = await new Browser().login();
    await b.activate();
    const family = (await b.view()).familyId!;
    await expect(
      service.transaction(async (c) => {
        await c.query("SELECT set_config('app.family_id',$1,true)", [family]);
        await c.query('UPDATE family.consent_receipts SET granted=false');
      }),
    ).rejects.toThrow();
    const id = randomUUID();
    await expect(
      service.transaction(async (c) => {
        await c.query("SELECT set_config('app.family_id',$1,true)", [id]);
        await c.query('INSERT INTO family.families(id,owner_id) VALUES($1,$2)', [id, family]);
      }),
    ).rejects.toThrow();
    await b.command({ ...activate, text: false }, 403);
    expect((await admin.query('SELECT * FROM ops.family_outbox')).rowCount).toBe(1);
  });
  it('serializes revoke before admission and denies previously admitted delivery after revoke', async () => {
    const parent = await new Browser().login();
    const child = await parent.activate();
    const device = await new Browser().login();
    await device.command({ kind: 'HANDOFF', childId: child });
    const authorization = await service.admit(device.token(), child, 'TEXT');
    const action: FamilyAction = {
      kind: 'CONSENT',
      childId: child,
      documentVersion: POLICY,
      purpose: 'TEXT',
      granted: false,
    };
    const receipt = await parent.receipt(action);
    const familyId = (await parent.view()).familyId;
    const hold = await admin.connect();
    await hold.query('BEGIN');
    await hold.query('SELECT id FROM family.families WHERE id=$1 FOR UPDATE', [familyId]);
    const revoke = parent.request('commands', {
      action,
      receiptId: receipt,
      idempotencyKey: randomUUID(),
    });
    try {
      // Wait for the API to actually queue on the PostgreSQL lock, not a timing guess.
      await expect
        .poll(async () =>
          Number(
            (
              await admin.query<{ count: string }>(
                "SELECT count(*) FROM pg_stat_activity WHERE datname='probyu_m2_test' AND wait_event_type='Lock' AND application_name<>'m2_worker'",
              )
            ).rows[0]!.count,
          ),
        )
        .toBeGreaterThan(0);
      const admission = service.admit(device.token(), child, 'TEXT').then(
        () => 'ALLOWED',
        () => 'DENIED',
      );
      await expect
        .poll(async () =>
          Number(
            (
              await admin.query<{ count: string }>(
                "SELECT count(*) FROM pg_stat_activity WHERE datname='probyu_m2_test' AND wait_event_type='Lock' AND application_name='m2_worker'",
              )
            ).rows[0]!.count,
          ),
        )
        .toBeGreaterThan(0);
      await hold.query('COMMIT');
      await revoke;
      expect(await admission).toBe('DENIED');
    } finally {
      await hold.query('ROLLBACK');
      hold.release();
    }
    await expect(service.deliver(device.token(), authorization)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect((await device.view()).child!.textAllowed).toBe(false);
  });
  it('rolls back consent, used reauth and command receipt when the outbox cannot commit', async () => {
    const b = await new Browser().login();
    const child = await b.activate();
    const action: FamilyAction = {
      kind: 'CONSENT',
      childId: child,
      documentVersion: POLICY,
      purpose: 'TEXT',
      granted: false,
    };
    const receipt = await b.receipt(action),
      key = randomUUID();
    await admin.query('REVOKE INSERT ON ops.family_outbox FROM probyu_family_runtime');
    try {
      await b.request('commands', { action, receiptId: receipt, idempotencyKey: key }, 503);
    } finally {
      await admin.query('GRANT INSERT ON ops.family_outbox TO probyu_family_runtime');
    }
    expect((await b.view()).child!.textAllowed).toBe(true);
    expect((await admin.query('SELECT id FROM family.consent_receipts')).rowCount).toBe(2);
    await b.request('commands', { action, receiptId: receipt, idempotencyKey: key });
    expect((await b.view()).child!.textAllowed).toBe(false);
  });
  it('enforces a session attempt budget and never returns the rotated session secret in JSON', async () => {
    const b = await new Browser().login();
    const child = await b.activate();
    await admin.query(
      'UPDATE identity.sessions SET attempts=30,attempt_window=now() WHERE revoked_at IS NULL',
    );
    await b.request('reauth/challenge', { action: { kind: 'RETURN' } }, 429);
    await admin.query('UPDATE identity.sessions SET attempts=0');
    const result = await b.command({ kind: 'HANDOFF', childId: child });
    expect(Object.keys(result)).toEqual(['ok']);
    expect(JSON.stringify(result)).not.toContain(b.token());
    await admin.query("UPDATE family.consent_projections SET document_version='obsolete'");
    await expect(service.admit(b.token(), child, 'TEXT')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
  it('revokes a registration and fails closed when policy or representative expires', async () => {
    const b = await new Browser().login();
    const child = await b.activate();
    await b.command({ kind: 'PAUSE', childId: child });
    await b.command({ kind: 'HANDOFF', childId: child }, 403);
    await b.command({ kind: 'RESUME', childId: child });
    await admin.query("UPDATE family.representatives SET expires_at=now()-interval '1 second'");
    await b.command({ kind: 'HANDOFF', childId: child }, 403);
    await admin.query("UPDATE family.representatives SET expires_at=now()+interval '1 day'");
    await b.command({ kind: 'REVOKE_BROWSER' });
    await b.request('session', undefined, 401, 'GET');
  });
});
