import { randomInt, randomUUID } from 'node:crypto';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import type { FamilyAction, FamilyChild, FamilySession } from '@probyu/contracts/types';
import { AccessError, actionHash, DOCUMENT, equalDigest, keyed, POLICY, secret } from './policy.js';

type Session = QueryResultRow & {
  id: string;
  digest: string;
  family_id: string | null;
  parent_id: string | null;
  registration_id: string | null;
  child_id: string | null;
  mode: 'ANONYMOUS' | 'PARENT' | 'CHILD';
  privilege_epoch: number;
  expires_at: Date;
  last_seen: Date;
  parent_seen: Date;
  revoked_at: Date | null;
};
type Child = QueryResultRow & {
  id: string;
  family_id: string;
  age_band: FamilyChild['ageBand'];
  status: FamilyChild['status'];
  access_epoch: number;
};
type Proof = {
  id: string;
  consumed_at: Date | null;
  expires_at: Date;
  purpose: string;
  attempts: number;
  code_digest: string;
  action_hash: string;
  synthetic_key: 'aurora' | 'comet';
};
type Reauth = {
  consumed_at: Date | null;
  expires_at: Date;
  action_hash: string;
  policy_version: string;
  privilege_epoch: number;
};
type Context = { client: PoolClient; session: Session; now: Date };
export type FamilyConfig = {
  mode: 'synthetic';
  environment: 'development' | 'test';
  origin: string;
  key: string;
  proxyKey?: string;
  databaseUrl: string;
};
export class FamilyService {
  readonly pool: Pool;
  constructor(
    readonly config: FamilyConfig,
    readonly clock: () => Date = () => new Date(),
  ) {
    if (
      process.env.NODE_ENV === 'production' ||
      !['development', 'test'].includes(config.environment) ||
      config.mode !== 'synthetic' ||
      config.key.length < 32 ||
      (config.proxyKey !== undefined && !/^[a-f0-9]{64}$/.test(config.proxyKey))
    )
      throw new Error('Synthetic family configuration rejected.');
    const origin = new URL(config.origin);
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) ||
      origin.origin !== config.origin
    )
      throw new Error('Synthetic family requires a loopback origin.');
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      max: 8,
      connectionTimeoutMillis: 1000,
    });
  }
  csrf(token: string) {
    return keyed(this.config.key, 'csrf', token);
  }
  async ingressBudget(scope: string, identity: string, maximum: number) {
    const key = keyed(this.config.key, 'rate-budget', `${scope}:${identity}`);
    const allowed = await this.transaction(async (client) => {
      await client.query("SELECT set_config('app.budget_key',$1,true)", [key]);
      const result = await client.query<{ attempts: number }>(
        `INSERT INTO identity.auth_budgets(key,attempts,window_start) VALUES($1,1,$2)
         ON CONFLICT(key) DO UPDATE SET
           attempts=CASE WHEN auth_budgets.window_start <= $2::timestamptz-interval '15 minutes' THEN 1 ELSE LEAST(auth_budgets.attempts+1,$3+1) END,
           window_start=CASE WHEN auth_budgets.window_start <= $2::timestamptz-interval '15 minutes' THEN $2 ELSE auth_budgets.window_start END
         RETURNING attempts`,
        [key, this.clock(), maximum],
      );
      return result.rows[0]!.attempts <= maximum;
    });
    if (!allowed) throw new AccessError('RATE_LIMITED', 429);
  }
  async pruneExpired() {
    await this.transaction((client) => client.query('SELECT identity.prune_expired_auth()'));
  }
  async transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE probyu_family_runtime');
      await client.query("SET LOCAL statement_timeout='5s'");
      const value = await run(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async context<T>(token: string, run: (ctx: Context) => Promise<T>): Promise<T> {
    return this.transaction(async (client) => {
      // Discover only the credential lineage; all family content is behind tenant RLS.
      await client.query("SELECT set_config('app.session_digest',$1,true)", [
        keyed(this.config.key, 'session', token),
      ]);
      const initial = await client.query<Session>(
        'SELECT * FROM identity.sessions WHERE digest=$1',
        [keyed(this.config.key, 'session', token)],
      );
      const candidate = initial.rows[0];
      if (!candidate) throw new AccessError('UNAUTHENTICATED', 401);
      if (candidate.family_id) {
        await client.query("SELECT set_config('app.family_id',$1,true)", [candidate.family_id]);
        const family = await client.query(
          "SELECT id FROM family.families WHERE id=$1 AND status='ACTIVE' FOR UPDATE",
          [candidate.family_id],
        );
        if (!family.rowCount) throw new AccessError('UNAUTHENTICATED', 401);
      }
      const session = (
        await client.query<Session>('SELECT * FROM identity.sessions WHERE id=$1 FOR UPDATE', [
          candidate.id,
        ])
      ).rows[0]!;
      await client.query("SELECT set_config('app.session_id',$1,true)", [session.id]);
      const now = this.clock();
      if (
        session.revoked_at ||
        session.expires_at <= now ||
        now.getTime() - session.last_seen.getTime() >= 30 * 60_000
      )
        throw new AccessError('UNAUTHENTICATED', 401);
      if (session.family_id) {
        const registration = await client.query(
          "SELECT id FROM identity.registrations WHERE id=$1 AND family_id=$2 AND status='ACTIVE' AND privilege_epoch=$3",
          [session.registration_id, session.family_id, session.privilege_epoch],
        );
        const member = await client.query(
          "SELECT m.parent_id FROM family.memberships m JOIN identity.parents p ON p.id=m.parent_id WHERE m.family_id=$1 AND m.parent_id=$2 AND p.status='ACTIVE'",
          [session.family_id, session.parent_id],
        );
        if (!registration.rowCount || !member.rowCount)
          throw new AccessError('UNAUTHENTICATED', 401);
      }
      return run({ client, session, now });
    });
  }
  parent(ctx: Context) {
    if (
      ctx.session.mode !== 'PARENT' ||
      ctx.now.getTime() - ctx.session.parent_seen.getTime() >= 5 * 60_000
    )
      throw new AccessError('FORBIDDEN');
  }
  async newSession(client: PoolClient, values: Partial<Session> = {}, absolute?: Date) {
    const token = secret(),
      id = randomUUID(),
      now = this.clock();
    await client.query("SELECT set_config('app.session_digest',$1,true)", [
      keyed(this.config.key, 'session', token),
    ]);
    await client.query(
      'INSERT INTO identity.sessions(id,digest,family_id,parent_id,registration_id,child_id,mode,privilege_epoch,created_at,last_seen,parent_seen,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$9,$10)',
      [
        id,
        keyed(this.config.key, 'session', token),
        values.family_id ?? null,
        values.parent_id ?? null,
        values.registration_id ?? null,
        values.child_id ?? null,
        values.mode ?? 'ANONYMOUS',
        values.privilege_epoch ?? 0,
        now,
        absolute ?? new Date(now.getTime() + 12 * 60 * 60_000),
      ],
    );
    return token;
  }
  async bootstrap(token?: string) {
    if (token) {
      try {
        return { token, view: await this.view(token) };
      } catch (e) {
        if (!(e instanceof AccessError)) throw e;
      }
    }
    const next = await this.transaction((c) =>
      this.newSession(c, {}, new Date(this.clock().getTime() + 15 * 60_000)),
    );
    return { token: next, view: await this.view(next) };
  }
  async allowed(client: PoolClient, childId: string, purpose: 'TEXT' | 'HISTORY', now: Date) {
    const result = await client.query(
      "SELECT 1 FROM family.consent_projections p JOIN family.consent_documents d ON d.version=p.document_version WHERE p.family_id::text=current_setting('app.family_id',true) AND p.child_id=$1 AND p.purpose=$2 AND p.granted AND p.document_version=$3 AND p.expires_at>$4 AND d.expires_at>$4 AND EXISTS(SELECT 1 FROM family.representatives r WHERE r.family_id=p.family_id AND r.expires_at>$4 AND r.policy_version=$3)",
      [childId, purpose, POLICY, now],
    );
    return result.rowCount === 1;
  }
  async view(token: string): Promise<FamilySession> {
    return this.context(token, async (ctx) => {
      const { client, session, now } = ctx;
      const result: FamilySession = {
        mode: session.mode,
        csrfToken: this.csrf(token),
        synthetic: true,
      };
      if (session.mode === 'ANONYMOUS') return result;
      if (
        session.mode === 'PARENT' &&
        now.getTime() - session.parent_seen.getTime() >= 5 * 60_000
      ) {
        result.mode = 'LOCKED';
        return result;
      }
      if (session.mode === 'PARENT') result.familyId = session.family_id!;
      const children = await client.query<Child>(
        'SELECT * FROM family.children WHERE family_id=$1 AND ($2::uuid IS NULL OR id=$2) ORDER BY id LIMIT 1',
        [session.family_id, session.child_id],
      );
      const child = children.rows[0];
      if (child) {
        const expiry: { textExpiresAt?: string; historyExpiresAt?: string } = {};
        if (session.mode === 'PARENT') {
          const rows = await client.query<{ purpose: 'TEXT' | 'HISTORY'; expires_at: Date }>(
            'SELECT purpose,expires_at FROM family.consent_projections WHERE family_id=$1 AND child_id=$2 AND granted',
            [session.family_id, child.id],
          );
          for (const row of rows.rows)
            expiry[row.purpose === 'TEXT' ? 'textExpiresAt' : 'historyExpiresAt'] =
              row.expires_at.toISOString();
        }
        result.child = {
          id: child.id,
          nickname: 'Исследователь',
          ageBand: child.age_band,
          status: child.status,
          textAllowed:
            child.status === 'ACTIVE' && (await this.allowed(client, child.id, 'TEXT', now)),
          historyAllowed:
            child.status === 'ACTIVE' && (await this.allowed(client, child.id, 'HISTORY', now)),
          ...(session.mode === 'PARENT'
            ? {
                ...expiry,
                textGranted: await this.allowed(client, child.id, 'TEXT', now),
                historyGranted: await this.allowed(client, child.id, 'HISTORY', now),
              }
            : {}),
        };
      }
      return result;
    });
  }
  async limit(ctx: Context) {
    const r = await ctx.client.query<{ attempts: number }>(
      `UPDATE identity.sessions SET attempts=CASE WHEN attempt_window<=$2::timestamptz-interval '15 minutes' THEN 1 ELSE attempts+1 END, attempt_window=CASE WHEN attempt_window<=$2::timestamptz-interval '15 minutes' THEN $2 ELSE attempt_window END WHERE id=$1 RETURNING attempts`,
      [ctx.session.id, ctx.now],
    );
    return Number(r.rows[0]?.attempts) <= 30;
  }
  async challenge(
    token: string,
    identity?: 'aurora' | 'comet',
    action?: FamilyAction,
    ip?: string,
  ) {
    // Shared across sessions/API instances. Issuance limits never prevent verifying a delivered code.
    if (identity) {
      await this.context(token, ({ session }) => {
        if (session.mode !== 'ANONYMOUS') throw new AccessError('FORBIDDEN');
        return Promise.resolve(true);
      });
      if (ip) await this.ingressBudget('login-ip', ip, 60);
      await this.ingressBudget('login-identity', identity, 30);
    }
    const result = await this.context(token, async (ctx) => {
      if (identity && ctx.session.mode !== 'ANONYMOUS') throw new AccessError('FORBIDDEN');
      if (action && !ctx.session.family_id) throw new AccessError('FORBIDDEN');
      if (action && ctx.session.mode === 'CHILD' && action.kind !== 'RETURN')
        throw new AccessError('FORBIDDEN');
      if (!(await this.limit(ctx))) return null;
      const id = randomUUID(),
        code = String(randomInt(100000, 1000000));
      // One outstanding proof per session; resending invalidates earlier codes.
      await ctx.client.query(
        'UPDATE identity.proofs SET consumed_at=$2 WHERE session_id=$1 AND consumed_at IS NULL',
        [ctx.session.id, ctx.now],
      );
      await ctx.client.query(
        'INSERT INTO identity.proofs(id,session_id,purpose,synthetic_key,action_hash,code_digest,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          id,
          ctx.session.id,
          identity ? 'LOGIN' : 'REAUTH',
          identity ?? null,
          action ? actionHash(action) : null,
          keyed(this.config.key, 'proof', `${id}:${code}`),
          new Date(ctx.now.getTime() + 5 * 60_000),
        ],
      );
      return { challengeId: id, devCode: code, synthetic: true as const };
    });
    if (!result) throw new AccessError('RATE_LIMITED', 429);
    return result;
  }
  async verify(token: string, id: string, code: string, purpose: 'LOGIN' | 'REAUTH') {
    const result = await this.context(token, async (ctx) => {
      const { client, session, now } = ctx;
      if (!(await this.limit(ctx))) return { error: 'RATE_LIMITED' as const };
      const p = (
        await client.query<Proof>(
          'SELECT * FROM identity.proofs WHERE id=$1 AND session_id=$2 FOR UPDATE',
          [id, session.id],
        )
      ).rows[0];
      if (!p || p.consumed_at || p.expires_at <= now || p.purpose !== purpose || p.attempts >= 5)
        return { error: 'EXPIRED_PROOF' as const };
      await client.query('UPDATE identity.proofs SET attempts=attempts+1 WHERE id=$1', [id]);
      if (!equalDigest(p.code_digest, keyed(this.config.key, 'proof', `${id}:${code}`)))
        return {
          error: p.attempts >= 4 ? ('EXPIRED_PROOF' as const) : ('INVALID_CODE' as const),
          remainingAttempts: Math.max(0, 4 - p.attempts),
        };
      await client.query('UPDATE identity.proofs SET consumed_at=$2 WHERE id=$1', [id, now]);
      if (purpose === 'REAUTH') {
        if (!session.family_id) throw new AccessError('FORBIDDEN');
        const receiptId = randomUUID();
        await client.query(
          'INSERT INTO family.reauth_receipts(id,family_id,parent_id,session_id,registration_id,action_hash,policy_version,privilege_epoch,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [
            receiptId,
            session.family_id,
            session.parent_id,
            session.id,
            session.registration_id,
            p.action_hash,
            POLICY,
            session.privilege_epoch,
            new Date(now.getTime() + 5 * 60_000),
          ],
        );
        return { receiptId };
      }
      if (session.mode !== 'ANONYMOUS') throw new AccessError('FORBIDDEN');
      // Serialize account creation even when logins happen in different API instances.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `synthetic-parent:${String(p.synthetic_key)}`,
      ]);
      await client.query("SELECT set_config('app.login_identity',$1,true)", [p.synthetic_key]);
      let parent = (
        await client.query<{ id: string }>(
          "SELECT id FROM identity.parents WHERE synthetic_key=$1 AND status='ACTIVE'",
          [p.synthetic_key],
        )
      ).rows[0];
      if (!parent) {
        parent = { id: randomUUID() };
        await client.query('INSERT INTO identity.parents(id,synthetic_key) VALUES($1,$2)', [
          parent.id,
          p.synthetic_key,
        ]);
      }
      // The synthetic parent has a stable deterministic family reference, not supplied by the client.
      const familyId = parent.id;
      await client.query("SELECT set_config('app.family_id',$1,true)", [familyId]);
      await client.query(
        'INSERT INTO family.families(id,owner_id) VALUES($1,$1) ON CONFLICT DO NOTHING',
        [familyId],
      );
      await client.query('SELECT id FROM family.families WHERE id=$1 FOR UPDATE', [familyId]);
      await client.query(
        "INSERT INTO family.memberships(family_id,parent_id,role,status) VALUES($1,$1,'OWNER','ACTIVE') ON CONFLICT DO NOTHING",
        [familyId],
      );
      await client.query(
        "INSERT INTO family.representatives(family_id,parent_id,method,policy_version,expires_at) VALUES($1,$1,'SYNTHETIC',$2,$3) ON CONFLICT(family_id) DO UPDATE SET policy_version=EXCLUDED.policy_version,expires_at=EXCLUDED.expires_at WHERE family.representatives.parent_id=EXCLUDED.parent_id AND family.representatives.method='SYNTHETIC'",
        [familyId, POLICY, new Date(now.getTime() + 30 * 86400_000)],
      );
      const registrationId = randomUUID();
      await client.query(
        'INSERT INTO identity.registrations(id,family_id,parent_id) VALUES($1,$2,$2)',
        [registrationId, familyId],
      );
      await client.query('UPDATE identity.sessions SET revoked_at=$2 WHERE id=$1', [
        session.id,
        now,
      ]);
      return {
        token: await this.newSession(client, {
          family_id: familyId,
          parent_id: familyId,
          registration_id: registrationId,
          mode: 'PARENT',
          privilege_epoch: 1,
        }),
      };
    });
    if ('error' in result)
      throw new AccessError(
        result.error,
        result.error === 'RATE_LIMITED' ? 429 : 403,
        'remainingAttempts' in result ? result.remainingAttempts : undefined,
      );
    return result;
  }
  async rotate(ctx: Context, mode: 'PARENT' | 'CHILD', childId: string | null) {
    const { client, session, now } = ctx;
    const epoch = session.privilege_epoch + 1;
    await client.query('UPDATE identity.registrations SET privilege_epoch=$2 WHERE id=$1', [
      session.registration_id,
      epoch,
    ]);
    await client.query(
      'UPDATE identity.sessions SET revoked_at=$2 WHERE registration_id=$1 AND revoked_at IS NULL',
      [session.registration_id, now],
    );
    return this.newSession(
      client,
      { ...session, mode, child_id: childId, privilege_epoch: epoch },
      session.expires_at,
    );
  }
  async command(token: string, action: FamilyAction, receiptId: string, idempotencyKey: string) {
    const hash = actionHash(action);
    return this.context(token, async (ctx) => {
      const { client, session, now } = ctx;
      if (!session.family_id) throw new AccessError('FORBIDDEN');
      if (action.kind !== 'RETURN' && session.mode !== 'PARENT') throw new AccessError('FORBIDDEN');
      const receipt = (
        await client.query<Reauth>(
          'SELECT * FROM family.reauth_receipts WHERE id=$1 AND family_id=$2 AND parent_id=$3 AND session_id=$4 AND registration_id=$5 FOR UPDATE',
          [receiptId, session.family_id, session.parent_id, session.id, session.registration_id],
        )
      ).rows[0];
      if (
        !receipt ||
        receipt.expires_at <= now ||
        receipt.action_hash !== hash ||
        receipt.policy_version !== POLICY ||
        receipt.privilege_epoch !== session.privilege_epoch
      )
        throw new AccessError('EXPIRED_PROOF');
      const rep = await client.query(
        'SELECT 1 FROM family.representatives WHERE family_id=$1 AND parent_id=$2 AND policy_version=$3 AND expires_at>$4',
        [session.family_id, session.parent_id, POLICY, now],
      );
      if (!rep.rowCount) throw new AccessError('FORBIDDEN');
      const prior = (
        await client.query<{ action_hash: string; reauth_id: string | null }>(
          'SELECT * FROM family.command_receipts WHERE family_id=$1 AND parent_id=$2 AND command_key=$3',
          [session.family_id, session.parent_id, idempotencyKey],
        )
      ).rows[0];
      if (prior) {
        this.parent(ctx);
        if (prior.reauth_id !== receiptId) throw new AccessError('FORBIDDEN');
        if (prior.action_hash !== hash) throw new AccessError('CONFLICT', 409);
        return { ok: true as const };
      }
      if (receipt.consumed_at) throw new AccessError('EXPIRED_PROOF');
      // A fresh action-bound proof can refresh an expired parent privilege without granting unrelated actions.
      if (action.kind === 'RETURN' && session.mode === 'ANONYMOUS')
        throw new AccessError('FORBIDDEN');
      let child: Child | undefined;
      const actionChildId = 'childId' in action ? action.childId : undefined;
      if (actionChildId) {
        child = (
          await client.query<Child>(
            'SELECT * FROM family.children WHERE family_id=$1 AND id=$2 FOR UPDATE',
            [session.family_id, actionChildId],
          )
        ).rows[0];
        if (!child) throw new AccessError('FORBIDDEN');
      }
      await client.query('UPDATE family.reauth_receipts SET consumed_at=$2 WHERE id=$1', [
        receiptId,
        now,
      ]);
      let rotated: string | undefined;
      if (action.kind === 'ACTIVATE') {
        if (!action.text) throw new AccessError('FORBIDDEN');
        if (
          (
            await client.query('SELECT id FROM family.children WHERE family_id=$1', [
              session.family_id,
            ])
          ).rowCount
        )
          throw new AccessError('CONFLICT', 409);
        const childId = randomUUID();
        await client.query(
          "INSERT INTO family.children(id,family_id,nickname,age_band) VALUES($1,$2,'Исследователь',$3)",
          [childId, session.family_id, action.ageBand],
        );
        await this.consent(ctx, childId, 'TEXT', true, receiptId);
        await this.consent(ctx, childId, 'HISTORY', action.history, receiptId);
      } else if (action.kind === 'CONSENT') {
        await this.consent(ctx, child!.id, action.purpose, action.granted, receiptId);
      } else if (action.kind === 'HANDOFF') {
        if (child!.status !== 'ACTIVE' || !(await this.allowed(client, child!.id, 'TEXT', now)))
          throw new AccessError('FORBIDDEN');
        rotated = await this.rotate(ctx, 'CHILD', child!.id);
      } else if (action.kind === 'RETURN') {
        rotated = await this.rotate(ctx, 'PARENT', null);
      } else if (action.kind === 'PAUSE' || action.kind === 'RESUME') {
        await client.query(
          'UPDATE family.children SET status=$2,access_epoch=access_epoch+1 WHERE id=$1',
          [child!.id, action.kind === 'PAUSE' ? 'PAUSED' : 'ACTIVE'],
        );
      } else if (action.kind === 'REVOKE_BROWSER') {
        await client.query(
          "UPDATE identity.registrations SET status='REVOKED',privilege_epoch=privilege_epoch+1 WHERE id=$1",
          [session.registration_id],
        );
        await client.query('UPDATE identity.sessions SET revoked_at=$2 WHERE registration_id=$1', [
          session.registration_id,
          now,
        ]);
      }
      const epoch = (
        await client.query<{ access_epoch: number }>(
          'UPDATE family.families SET access_epoch=access_epoch+1 WHERE id=$1 RETURNING access_epoch',
          [session.family_id],
        )
      ).rows[0]!.access_epoch;
      await client.query(
        'INSERT INTO ops.family_outbox(id,family_id,event_type,access_epoch) VALUES($1,$2,$3,$4)',
        [randomUUID(), session.family_id, action.kind, epoch],
      );
      await client.query(
        'INSERT INTO family.command_receipts(family_id,parent_id,command_key,action_hash,result,reauth_id) VALUES($1,$2,$3,$4,$5,$6)',
        [session.family_id, session.parent_id, idempotencyKey, hash, { ok: true }, receiptId],
      );
      await client.query('UPDATE identity.sessions SET last_seen=$2,parent_seen=$2 WHERE id=$1', [
        session.id,
        now,
      ]);
      return { ok: true as const, ...(rotated ? { token: rotated } : {}) };
    });
  }
  async consent(
    ctx: Context,
    childId: string,
    purpose: 'TEXT' | 'HISTORY',
    granted: boolean,
    reauthId: string,
  ) {
    const { client, session, now } = ctx;
    const doc = await client.query(
      'SELECT version FROM family.consent_documents WHERE version=$1 AND expires_at>$2',
      [POLICY, now],
    );
    if (!doc.rowCount) throw new AccessError('UNAVAILABLE', 503);
    const prior = (
      await client.query<{ receipt_id: string }>(
        'SELECT receipt_id FROM family.consent_projections WHERE child_id=$1 AND purpose=$2',
        [childId, purpose],
      )
    ).rows[0];
    const id = randomUUID(),
      expires = new Date(now.getTime() + 30 * 86400_000);
    await client.query(
      'INSERT INTO family.consent_receipts(id,family_id,child_id,parent_id,reauth_id,document_version,purpose,granted,prior_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [
        id,
        session.family_id,
        childId,
        session.parent_id,
        reauthId,
        POLICY,
        purpose,
        granted,
        prior?.receipt_id ?? null,
        expires,
      ],
    );
    await client.query(
      'INSERT INTO family.consent_projections(family_id,child_id,purpose,receipt_id,granted,document_version,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(child_id,family_id,purpose) DO UPDATE SET receipt_id=$4,granted=$5,document_version=$6,expires_at=$7',
      [session.family_id, childId, purpose, id, granted, POLICY, expires],
    );
    await client.query('UPDATE family.children SET access_epoch=access_epoch+1 WHERE id=$1', [
      childId,
    ]);
  }
  async logout(token: string) {
    return this.context(token, async ({ client, session, now }) => {
      await client.query('UPDATE identity.sessions SET revoked_at=$2 WHERE id=$1', [
        session.id,
        now,
      ]);
      return { ok: true as const };
    });
  }
  // M3 integration seam: admission and delivery both re-read current policy under the family lock.
  async admit(token: string, childId: string, purpose: 'TEXT' | 'HISTORY') {
    return this.context(token, async (ctx) => {
      await this.guardChild(ctx, childId, purpose);
      // Only an admitted user operation counts as activity; polling/delivery never extends idle.
      await ctx.client.query('UPDATE identity.sessions SET last_seen=$2 WHERE id=$1', [
        ctx.session.id,
        ctx.now,
      ]);
      const epoch = (
        await ctx.client.query<{ access_epoch: number }>(
          'SELECT access_epoch FROM family.families WHERE id=$1',
          [ctx.session.family_id],
        )
      ).rows[0]!.access_epoch;
      const id = randomUUID();
      await ctx.client.query(
        'INSERT INTO family.processing_authorizations(id,family_id,child_id,purpose,access_epoch,policy_version,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          id,
          ctx.session.family_id,
          childId,
          purpose,
          epoch,
          POLICY,
          new Date(ctx.now.getTime() + 60_000),
        ],
      );
      return id;
    });
  }
  async deliver(token: string, authorizationId: string) {
    return this.context(token, async (ctx) => {
      const auth = (
        await ctx.client.query<{ child_id: string; purpose: 'TEXT' | 'HISTORY' }>(
          'SELECT a.* FROM family.processing_authorizations a JOIN family.families f ON f.id=a.family_id AND f.access_epoch=a.access_epoch WHERE a.id=$1 AND a.policy_version=$2 AND a.expires_at>$3',
          [authorizationId, POLICY, ctx.now],
        )
      ).rows[0];
      if (!auth) throw new AccessError('FORBIDDEN');
      await this.guardChild(ctx, auth.child_id, auth.purpose);
      return true;
    });
  }
  async guardChild(ctx: Context, childId: string, purpose: 'TEXT' | 'HISTORY') {
    if (ctx.session.mode !== 'CHILD' || ctx.session.child_id !== childId)
      throw new AccessError('FORBIDDEN');
    const child = await ctx.client.query(
      "SELECT id FROM family.children WHERE id=$1 AND family_id=$2 AND status='ACTIVE'",
      [childId, ctx.session.family_id],
    );
    if (
      !child.rowCount ||
      !(await this.allowed(ctx.client, childId, 'TEXT', ctx.now)) ||
      !(await this.allowed(ctx.client, childId, purpose, ctx.now))
    )
      throw new AccessError('FORBIDDEN');
  }
  documents() {
    return DOCUMENT;
  }
}
