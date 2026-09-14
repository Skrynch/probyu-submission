// SQL migration 0002 owns deferred constraints, FORCE RLS and role grants.
// Composite foreign key order verified against pg_constraint (Drizzle pull reverses some keys).
import {
  pgSchema,
  index,
  check,
  text,
  timestamp,
  type PgTableExtraConfigValue,
  foreignKey,
  unique,
  pgPolicy,
  uuid,
  integer,
  boolean,
  primaryKey,
  jsonb,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const family = pgSchema('family');
export const identity = pgSchema('identity');
export const ops = pgSchema('ops');

export const authBudgetsInIdentity = identity.table(
  'auth_budgets',
  {
    key: text().primaryKey().notNull(),
    attempts: integer().notNull(),
    windowStart: timestamp('window_start', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (): PgTableExtraConfigValue[] => [
    pgPolicy('maintenance_read', {
      for: 'select',
      to: ['probyu_family_maintenance'],
      using: sql`true`,
    }),
    pgPolicy('maintenance_delete', {
      for: 'delete',
      to: ['probyu_family_maintenance'],
      using: sql`true`,
    }),
    check('auth_budgets_key_check', sql`key ~ '^[a-f0-9]{64}$'::text`),
    pgPolicy('budget_scope', {
      for: 'all',
      to: ['public'],
      using: sql`key = current_setting('app.budget_key',true)`,
      withCheck: sql`key = current_setting('app.budget_key',true)`,
    }),
  ],
);

export const consentDocumentsInFamily = family.table(
  'consent_documents',
  {
    version: text().primaryKey().notNull(),
    textBody: text('text_body').notNull(),
    historyBody: text('history_body').notNull(),
    contentHash: text('content_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (): PgTableExtraConfigValue[] => [
    check('consent_documents_content_hash_check', sql`content_hash ~ '^[a-f0-9]{64}$'::text`),
  ],
);

export const familiesInFamily = family.table(
  'families',
  {
    id: uuid().primaryKey().notNull(),
    ownerId: uuid('owner_id').notNull(),
    status: text().default('ACTIVE').notNull(),
    accessEpoch: integer('access_epoch').default(1).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.ownerId],
      foreignColumns: [parentsInIdentity.id],
      name: 'families_owner_id_fkey',
    }),
    foreignKey({
      columns: [table.id, table.ownerId],
      foreignColumns: [membershipsInFamily.familyId, membershipsInFamily.parentId],
      name: 'family_has_owner',
    }),
    unique('families_id_owner_id_key').on(table.id, table.ownerId),
    pgPolicy('tenant', {
      as: 'permissive',
      for: 'all',
      to: ['public'],
      using: sql`((id)::text = current_setting('app.family_id'::text, true))`,
      withCheck: sql`((id)::text = current_setting('app.family_id'::text, true))`,
    }),
    check('families_status_check', sql`status = ANY (ARRAY['ACTIVE'::text, 'CLOSED'::text])`),
    check('families_access_epoch_check', sql`access_epoch > 0`),
  ],
);

export const parentsInIdentity = identity.table(
  'parents',
  {
    id: uuid().primaryKey().notNull(),
    syntheticKey: text('synthetic_key').notNull(),
    status: text().default('ACTIVE').notNull(),
    attempts: integer().default(0).notNull(),
    attemptWindow: timestamp('attempt_window', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    unique('parents_synthetic_key_key').on(table.syntheticKey),
    pgPolicy('identity_scope', {
      as: 'permissive',
      for: 'all',
      to: ['public'],
      using: sql`(((id)::text = current_setting('app.family_id'::text, true)) OR (synthetic_key = current_setting('app.login_identity'::text, true)))`,
      withCheck: sql`((synthetic_key = current_setting('app.login_identity'::text, true)) OR ((id)::text = current_setting('app.family_id'::text, true)))`,
    }),
    check(
      'parents_synthetic_key_check',
      sql`synthetic_key = ANY (ARRAY['aurora'::text, 'comet'::text])`,
    ),
    check(
      'parents_status_check',
      sql`status = ANY (ARRAY['ACTIVE'::text, 'SUSPENDED'::text, 'CLOSED'::text])`,
    ),
  ],
);

export const registrationsInIdentity = identity.table(
  'registrations',
  {
    id: uuid().primaryKey().notNull(),
    familyId: uuid('family_id').notNull(),
    parentId: uuid('parent_id').notNull(),
    status: text().default('ACTIVE').notNull(),
    privilegeEpoch: integer('privilege_epoch').default(1).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    pgPolicy('maintenance_read', {
      for: 'select',
      to: ['probyu_family_maintenance'],
      using: sql`true`,
    }),
    pgPolicy('maintenance_delete', {
      for: 'delete',
      to: ['probyu_family_maintenance'],
      using: sql`true`,
    }),
    foreignKey({
      columns: [table.familyId, table.parentId],
      foreignColumns: [membershipsInFamily.familyId, membershipsInFamily.parentId],
      name: 'registrationsInIdentity_membership_fk',
    }),
    index('registrationsInIdentity_family_idx').on(table.familyId),
    foreignKey({
      columns: [table.familyId],
      foreignColumns: [familiesInFamily.id],
      name: 'registrations_family_id_fkey',
    }),
    foreignKey({
      columns: [table.parentId],
      foreignColumns: [parentsInIdentity.id],
      name: 'registrations_parent_id_fkey',
    }),
    unique('registrations_family_id_id_key').on(table.familyId, table.id),
    pgPolicy('registration_scope', {
      as: 'permissive',
      for: 'all',
      to: ['public'],
      using: sql`((family_id)::text = current_setting('app.family_id'::text, true))`,
      withCheck: sql`((family_id)::text = current_setting('app.family_id'::text, true))`,
    }),
    check('registrations_status_check', sql`status = ANY (ARRAY['ACTIVE'::text, 'REVOKED'::text])`),
  ],
);

export const sessionsInIdentity = identity.table(
  'sessions',
  {
    id: uuid().primaryKey().notNull(),
    digest: text().notNull(),
    familyId: uuid('family_id'),
    parentId: uuid('parent_id'),
    registrationId: uuid('registration_id'),
    childId: uuid('child_id'),
    mode: text().notNull(),
    privilegeEpoch: integer('privilege_epoch').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    lastSeen: timestamp('last_seen', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    parentSeen: timestamp('parent_seen', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'string' }),
    attempts: integer().default(0).notNull(),
    attemptWindow: timestamp('attempt_window', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    pgPolicy('maintenance_read', {
      for: 'select',
      to: ['probyu_family_maintenance'],
      using: sql`true`,
    }),
    pgPolicy('maintenance_delete', {
      for: 'delete',
      to: ['probyu_family_maintenance'],
      using: sql`true`,
    }),
    foreignKey({
      columns: [table.familyId, table.parentId],
      foreignColumns: [membershipsInFamily.familyId, membershipsInFamily.parentId],
      name: 'sessionsInIdentity_membership_fk',
    }),
    index('sessionsInIdentity_family_idx').on(table.familyId),
    index('sessions_registration_idx').on(table.registrationId),
    foreignKey({
      columns: [table.familyId],
      foreignColumns: [familiesInFamily.id],
      name: 'sessions_family_id_fkey',
    }),
    foreignKey({
      columns: [table.parentId],
      foreignColumns: [parentsInIdentity.id],
      name: 'sessions_parent_id_fkey',
    }),
    foreignKey({
      columns: [table.familyId, table.registrationId],
      foreignColumns: [registrationsInIdentity.familyId, registrationsInIdentity.id],
      name: 'sessions_family_id_registration_id_fkey',
    }),
    foreignKey({
      columns: [table.familyId, table.childId],
      foreignColumns: [childrenInFamily.familyId, childrenInFamily.id],
      name: 'sessions_family_id_child_id_fkey',
    }),
    unique('sessions_digest_key').on(table.digest),
    pgPolicy('session_scope', {
      as: 'permissive',
      for: 'all',
      to: ['public'],
      using: sql`((digest = current_setting('app.session_digest'::text, true)) OR ((family_id)::text = current_setting('app.family_id'::text, true)))`,
      withCheck: sql`((digest = current_setting('app.session_digest'::text, true)) OR ((family_id)::text = current_setting('app.family_id'::text, true)))`,
    }),
    check('sessions_digest_check', sql`digest ~ '^[a-f0-9]{64}$'::text`),
    check(
      'sessions_mode_check',
      sql`mode = ANY (ARRAY['ANONYMOUS'::text, 'PARENT'::text, 'CHILD'::text])`,
    ),
    check(
      'sessions_check',
      sql`((mode = 'ANONYMOUS'::text) AND (family_id IS NULL) AND (parent_id IS NULL) AND (registration_id IS NULL) AND (child_id IS NULL)) OR ((mode = 'PARENT'::text) AND (family_id IS NOT NULL) AND (parent_id IS NOT NULL) AND (registration_id IS NOT NULL) AND (child_id IS NULL)) OR ((mode = 'CHILD'::text) AND (family_id IS NOT NULL) AND (parent_id IS NOT NULL) AND (registration_id IS NOT NULL) AND (child_id IS NOT NULL))`,
    ),
  ],
);

export const proofsInIdentity = identity.table(
  'proofs',
  {
    id: uuid().primaryKey().notNull(),
    sessionId: uuid('session_id').notNull(),
    purpose: text().notNull(),
    syntheticKey: text('synthetic_key'),
    actionHash: text('action_hash'),
    codeDigest: text('code_digest').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    attempts: integer().default(0).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'string' }),
  },
  (table): PgTableExtraConfigValue[] => [
    pgPolicy('maintenance_read', {
      for: 'select',
      to: ['probyu_family_maintenance'],
      using: sql`true`,
    }),
    pgPolicy('maintenance_delete', {
      for: 'delete',
      to: ['probyu_family_maintenance'],
      using: sql`true`,
    }),
    index('proofs_session_idx').on(table.sessionId),
    foreignKey({
      columns: [table.sessionId],
      foreignColumns: [sessionsInIdentity.id],
      name: 'proofs_session_id_fkey',
    }),
    pgPolicy('proof_scope', {
      as: 'permissive',
      for: 'all',
      to: ['public'],
      using: sql`((session_id)::text = current_setting('app.session_id'::text, true))`,
      withCheck: sql`((session_id)::text = current_setting('app.session_id'::text, true))`,
    }),
    check('proofs_purpose_check', sql`purpose = ANY (ARRAY['LOGIN'::text, 'REAUTH'::text])`),
  ],
);

export const representativesInFamily = family.table(
  'representatives',
  {
    familyId: uuid('family_id').primaryKey().notNull(),
    parentId: uuid('parent_id').notNull(),
    method: text().notNull(),
    policyVersion: text('policy_version').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.familyId],
      foreignColumns: [familiesInFamily.id],
      name: 'representatives_family_id_fkey',
    }),
    foreignKey({
      columns: [table.familyId, table.parentId],
      foreignColumns: [membershipsInFamily.familyId, membershipsInFamily.parentId],
      name: 'representatives_family_id_parent_id_fkey',
    }),
    pgPolicy('tenant', {
      as: 'permissive',
      for: 'all',
      to: ['public'],
      using: sql`((family_id)::text = current_setting('app.family_id'::text, true))`,
      withCheck: sql`((family_id)::text = current_setting('app.family_id'::text, true))`,
    }),
    check('representatives_method_check', sql`method = 'SYNTHETIC'::text`),
  ],
);

export const childrenInFamily = family.table(
  'children',
  {
    id: uuid().primaryKey().notNull(),
    familyId: uuid('family_id').notNull(),
    nickname: text().notNull(),
    ageBand: text('age_band').notNull(),
    status: text().default('ACTIVE').notNull(),
    accessEpoch: integer('access_epoch').default(1).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.familyId],
      foreignColumns: [familiesInFamily.id],
      name: 'children_family_id_fkey',
    }),
    unique('children_family_id_id_key').on(table.familyId, table.id),
    pgPolicy('tenant', {
      as: 'permissive',
      for: 'all',
      to: ['public'],
      using: sql`((family_id)::text = current_setting('app.family_id'::text, true))`,
      withCheck: sql`((family_id)::text = current_setting('app.family_id'::text, true))`,
    }),
    check('children_nickname_check', sql`nickname = 'Исследователь'::text`),
    check(
      'children_age_band_check',
      sql`age_band = ANY (ARRAY['8_10'::text, '11_12'::text, '13_14'::text])`,
    ),
    check('children_status_check', sql`status = ANY (ARRAY['ACTIVE'::text, 'PAUSED'::text])`),
    check('children_access_epoch_check', sql`access_epoch > 0`),
  ],
);

export const reauthReceiptsInFamily = family.table(
  'reauth_receipts',
  {
    id: uuid().primaryKey().notNull(),
    method: text().default('SYNTHETIC').notNull(),
    assurance: text().default('TEST_ONLY').notNull(),
    adultExclusive: boolean('adult_exclusive').default(false).notNull(),
    familyId: uuid('family_id').notNull(),
    parentId: uuid('parent_id').notNull(),
    sessionId: uuid('session_id').notNull(),
    registrationId: uuid('registration_id').notNull(),
    actionHash: text('action_hash').notNull(),
    policyVersion: text('policy_version').notNull(),
    privilegeEpoch: integer('privilege_epoch').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'string' }),
  },
  (table): PgTableExtraConfigValue[] => [
    pgPolicy('maintenance_read', {
      for: 'select',
      to: ['probyu_family_maintenance'],
      using: sql`true`,
    }),
    pgPolicy('maintenance_delete', {
      for: 'delete',
      to: ['probyu_family_maintenance'],
      using: sql`true`,
    }),
    check(
      'reauth_synthetic_only',
      sql`method = 'SYNTHETIC' AND assurance = 'TEST_ONLY' AND NOT adult_exclusive`,
    ),
    foreignKey({
      columns: [table.familyId],
      foreignColumns: [familiesInFamily.id],
      name: 'reauth_receipts_family_id_fkey',
    }),
    foreignKey({
      columns: [table.parentId],
      foreignColumns: [parentsInIdentity.id],
      name: 'reauth_receipts_parent_id_fkey',
    }),
    foreignKey({
      columns: [table.sessionId],
      foreignColumns: [sessionsInIdentity.id],
      name: 'reauth_receipts_session_id_fkey',
    }),
    foreignKey({
      columns: [table.registrationId],
      foreignColumns: [registrationsInIdentity.id],
      name: 'reauth_receipts_registration_id_fkey',
    }),
    pgPolicy('tenant', {
      as: 'permissive',
      for: 'all',
      to: ['public'],
      using: sql`((family_id)::text = current_setting('app.family_id'::text, true))`,
      withCheck: sql`((family_id)::text = current_setting('app.family_id'::text, true))`,
    }),
  ],
);

export const consentReceiptsInFamily = family.table(
  'consent_receipts',
  {
    id: uuid().primaryKey().notNull(),
    familyId: uuid('family_id').notNull(),
    childId: uuid('child_id').notNull(),
    parentId: uuid('parent_id').notNull(),
    reauthId: uuid('reauth_id').notNull(),
    documentVersion: text('document_version').notNull(),
    purpose: text().notNull(),
    granted: boolean().notNull(),
    priorId: uuid('prior_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    pgPolicy('maintenance_read', {
      for: 'select',
      to: ['probyu_family_maintenance'],
      using: sql`true`,
    }),
    foreignKey({
      columns: [table.parentId],
      foreignColumns: [parentsInIdentity.id],
      name: 'consent_receipts_parent_id_fkey',
    }),
    foreignKey({
      columns: [table.reauthId],
      foreignColumns: [reauthReceiptsInFamily.id],
      name: 'consent_receipts_reauth_id_fkey',
    }),
    foreignKey({
      columns: [table.documentVersion],
      foreignColumns: [consentDocumentsInFamily.version],
      name: 'consent_receipts_document_version_fkey',
    }),
    foreignKey({
      columns: [table.priorId],
      foreignColumns: [table.id],
      name: 'consent_receipts_prior_id_fkey',
    }),
    foreignKey({
      columns: [table.familyId, table.childId],
      foreignColumns: [childrenInFamily.familyId, childrenInFamily.id],
      name: 'consent_receipts_family_id_child_id_fkey',
    }),
    unique('consent_receipts_family_id_child_id_id_key').on(
      table.childId,
      table.familyId,
      table.id,
    ),
    pgPolicy('tenant', {
      as: 'permissive',
      for: 'all',
      to: ['public'],
      using: sql`((family_id)::text = current_setting('app.family_id'::text, true))`,
      withCheck: sql`((family_id)::text = current_setting('app.family_id'::text, true))`,
    }),
    check(
      'consent_receipts_purpose_check',
      sql`purpose = ANY (ARRAY['TEXT'::text, 'HISTORY'::text])`,
    ),
  ],
);

export const familyOutboxInOps = ops.table(
  'family_outbox',
  {
    id: uuid().primaryKey().notNull(),
    familyId: uuid('family_id').notNull(),
    eventType: text('event_type').notNull(),
    accessEpoch: integer('access_epoch').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    state: text().default('PENDING').notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.familyId],
      foreignColumns: [familiesInFamily.id],
      name: 'family_outbox_family_id_fkey',
    }),
    pgPolicy('tenant', {
      as: 'permissive',
      for: 'all',
      to: ['public'],
      using: sql`((family_id)::text = current_setting('app.family_id'::text, true))`,
      withCheck: sql`((family_id)::text = current_setting('app.family_id'::text, true))`,
    }),
    check(
      'family_outbox_state_check',
      sql`state = ANY (ARRAY['PENDING'::text, 'PROCESSED'::text])`,
    ),
  ],
);

export const processingAuthorizationsInFamily = family.table(
  'processing_authorizations',
  {
    id: uuid().primaryKey().notNull(),
    familyId: uuid('family_id').notNull(),
    childId: uuid('child_id').notNull(),
    purpose: text().notNull(),
    accessEpoch: integer('access_epoch').notNull(),
    policyVersion: text('policy_version').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    pgPolicy('maintenance_read', {
      for: 'select',
      to: ['probyu_family_maintenance'],
      using: sql`true`,
    }),
    pgPolicy('maintenance_delete', {
      for: 'delete',
      to: ['probyu_family_maintenance'],
      using: sql`true`,
    }),
    foreignKey({
      columns: [table.familyId, table.childId],
      foreignColumns: [childrenInFamily.familyId, childrenInFamily.id],
      name: 'processing_authorizations_family_id_child_id_fkey',
    }),
    pgPolicy('tenant', {
      as: 'permissive',
      for: 'all',
      to: ['public'],
      using: sql`((family_id)::text = current_setting('app.family_id'::text, true))`,
      withCheck: sql`((family_id)::text = current_setting('app.family_id'::text, true))`,
    }),
    check(
      'processing_authorizations_purpose_check',
      sql`purpose = ANY (ARRAY['TEXT'::text, 'HISTORY'::text])`,
    ),
  ],
);

export const membershipsInFamily = family.table(
  'memberships',
  {
    familyId: uuid('family_id').notNull(),
    parentId: uuid('parent_id').notNull(),
    role: text().notNull(),
    status: text().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.familyId],
      foreignColumns: [familiesInFamily.id],
      name: 'memberships_family_id_fkey',
    }),
    foreignKey({
      columns: [table.parentId],
      foreignColumns: [parentsInIdentity.id],
      name: 'memberships_parent_id_fkey',
    }),
    foreignKey({
      columns: [table.familyId, table.parentId],
      foreignColumns: [familiesInFamily.id, familiesInFamily.ownerId],
      name: 'memberships_family_id_parent_id_fkey',
    }),
    primaryKey({ columns: [table.familyId, table.parentId], name: 'memberships_pkey' }),
    unique('memberships_family_id_key').on(table.familyId),
    pgPolicy('tenant', {
      as: 'permissive',
      for: 'all',
      to: ['public'],
      using: sql`((family_id)::text = current_setting('app.family_id'::text, true))`,
      withCheck: sql`((family_id)::text = current_setting('app.family_id'::text, true))`,
    }),
    check('memberships_role_check', sql`role = 'OWNER'::text`),
    check('memberships_status_check', sql`status = 'ACTIVE'::text`),
  ],
);

export const commandReceiptsInFamily = family.table(
  'command_receipts',
  {
    familyId: uuid('family_id').notNull(),
    parentId: uuid('parent_id').notNull(),
    commandKey: uuid('command_key').notNull(),
    reauthId: uuid('reauth_id'),
    actionHash: text('action_hash').notNull(),
    result: jsonb().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.familyId],
      foreignColumns: [familiesInFamily.id],
      name: 'command_receipts_family_id_fkey',
    }),
    foreignKey({
      columns: [table.parentId],
      foreignColumns: [parentsInIdentity.id],
      name: 'command_receipts_parent_id_fkey',
    }),
    primaryKey({
      columns: [table.commandKey, table.familyId, table.parentId],
      name: 'command_receipts_pkey',
    }),
    pgPolicy('tenant', {
      as: 'permissive',
      for: 'all',
      to: ['public'],
      using: sql`((family_id)::text = current_setting('app.family_id'::text, true))`,
      withCheck: sql`((family_id)::text = current_setting('app.family_id'::text, true))`,
    }),
  ],
);

export const consentProjectionsInFamily = family.table(
  'consent_projections',
  {
    familyId: uuid('family_id').notNull(),
    childId: uuid('child_id').notNull(),
    purpose: text().notNull(),
    receiptId: uuid('receipt_id').notNull(),
    granted: boolean().notNull(),
    documentVersion: text('document_version').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.familyId, table.childId, table.receiptId],
      foreignColumns: [
        consentReceiptsInFamily.familyId,
        consentReceiptsInFamily.childId,
        consentReceiptsInFamily.id,
      ],
      name: 'consent_projections_family_id_child_id_receipt_id_fkey',
    }),
    primaryKey({
      columns: [table.childId, table.familyId, table.purpose],
      name: 'consent_projections_pkey',
    }),
    pgPolicy('tenant', {
      as: 'permissive',
      for: 'all',
      to: ['public'],
      using: sql`((family_id)::text = current_setting('app.family_id'::text, true))`,
      withCheck: sql`((family_id)::text = current_setting('app.family_id'::text, true))`,
    }),
    check(
      'consent_projections_purpose_check',
      sql`purpose = ANY (ARRAY['TEXT'::text, 'HISTORY'::text])`,
    ),
  ],
);
