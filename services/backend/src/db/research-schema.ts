import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  type PgTableExtraConfigValue,
} from 'drizzle-orm/pg-core';

import {
  childrenInFamily,
  familiesInFamily,
  registrationsInIdentity,
  sessionsInIdentity,
} from './family-schema.js';

export const research = pgSchema('research');

const tenantPolicy = () =>
  pgPolicy('tenant', {
    as: 'permissive',
    for: 'all',
    to: ['probyu_family_runtime'],
    using: sql`family_id::text = current_setting('app.family_id', true)`,
    withCheck: sql`family_id::text = current_setting('app.family_id', true)`,
  });

export const researchPolicyVersions = research.table('policy_versions', {
  id: text().primaryKey().notNull(),
  active: boolean().default(true).notNull(),
  killEpoch: integer('kill_epoch').default(1).notNull(),
  effectiveAt: timestamp('effective_at', { withTimezone: true, mode: 'string' })
    .defaultNow()
    .notNull(),
});

export const answerRuns = research.table(
  'answer_runs',
  {
    id: uuid().primaryKey().notNull(),
    familyId: uuid('family_id').notNull(),
    childId: uuid('child_id').notNull(),
    sessionId: uuid('session_id').notNull(),
    registrationId: uuid('registration_id').notNull(),
    idempotencyKey: uuid('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    inputCiphertext: text('input_ciphertext'),
    inputHash: text('input_hash'),
    status: text().default('RECEIVED').notNull(),
    safetyAction: text('safety_action'),
    failureCode: text('failure_code'),
    accessEpoch: integer('access_epoch').notNull(),
    childAccessEpoch: integer('child_access_epoch').notNull(),
    sessionPrivilegeEpoch: integer('session_privilege_epoch').notNull(),
    policyVersion: text('policy_version').notNull(),
    killEpoch: integer('kill_epoch').notNull(),
    adapterVersion: text('adapter_version').notNull(),
    fence: integer().default(0).notNull(),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true, mode: 'string' }),
  },
  (table): PgTableExtraConfigValue[] => [
    tenantPolicy(),
    foreignKey({
      columns: [table.familyId],
      foreignColumns: [familiesInFamily.id],
      name: 'answer_runs_family_id_fkey',
    }),
    foreignKey({
      columns: [table.familyId, table.childId],
      foreignColumns: [childrenInFamily.familyId, childrenInFamily.id],
      name: 'answer_runs_family_child_fkey',
    }),
    foreignKey({
      columns: [table.sessionId],
      foreignColumns: [sessionsInIdentity.id],
      name: 'answer_runs_session_id_fkey',
    }),
    foreignKey({
      columns: [table.registrationId],
      foreignColumns: [registrationsInIdentity.id],
      name: 'answer_runs_registration_id_fkey',
    }),
    foreignKey({
      columns: [table.policyVersion],
      foreignColumns: [researchPolicyVersions.id],
      name: 'answer_runs_policy_version_fkey',
    }),
    unique('answer_runs_family_child_key_unique').on(
      table.familyId,
      table.childId,
      table.idempotencyKey,
    ),
    unique('answer_runs_scope_unique').on(table.familyId, table.childId, table.id),
    index('answer_runs_queue_idx').on(table.status, table.leaseExpiresAt, table.createdAt),
    check(
      'answer_runs_hashes_check',
      sql`
      request_hash ~ '^[a-f0-9]{64}$'
      AND (input_hash IS NULL OR input_hash ~ '^[a-f0-9]{64}$')
    `,
    ),
    check(
      'answer_runs_epoch_check',
      sql`
      access_epoch > 0 AND child_access_epoch > 0 AND session_privilege_epoch > 0
      AND kill_epoch > 0 AND fence >= 0
    `,
    ),
    check(
      'answer_runs_status_check',
      sql`status = ANY (ARRAY[
      'RECEIVED','INPUT_APPROVED','QUEUED','GENERATING','OUTPUT_VALIDATING',
      'APPROVED','DELIVERING','COMPLETED','DENIED','FAILED_SAFE','CANCELLED'
    ])`,
    ),
    check(
      'answer_runs_safety_action_check',
      sql`
      safety_action IS NULL OR safety_action = ANY (ARRAY[
        'ALLOW','SAFE_TRANSFORM','PARENT_GATE','SAFETY_RESPONSE','BLOCK'
      ])
    `,
    ),
  ],
);

export const approvedAnswerArtifacts = research.table(
  'approved_answer_artifacts',
  {
    id: uuid().primaryKey().notNull(),
    familyId: uuid('family_id').notNull(),
    childId: uuid('child_id').notNull(),
    answerRunId: uuid('answer_run_id').notNull(),
    ciphertext: text().notNull(),
    contentHash: text('content_hash').notNull(),
    schemaVersion: text('schema_version').notNull(),
    outputDecision: text('output_decision').notNull(),
    ageBand: text('age_band').notNull(),
    policyVersion: text('policy_version').notNull(),
    approvedAt: timestamp('approved_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    tenantPolicy(),
    foreignKey({
      columns: [table.familyId, table.childId, table.answerRunId],
      foreignColumns: [answerRuns.familyId, answerRuns.childId, answerRuns.id],
      name: 'approved_answer_artifacts_run_scope_fkey',
    }),
    foreignKey({
      columns: [table.policyVersion],
      foreignColumns: [researchPolicyVersions.id],
      name: 'approved_answer_artifacts_policy_fkey',
    }),
    unique('approved_answer_artifacts_answer_run_unique').on(table.answerRunId),
    unique('approved_answer_artifacts_scope_unique').on(table.familyId, table.childId, table.id),
    check('approved_answer_artifacts_content_hash_check', sql`content_hash ~ '^[a-f0-9]{64}$'`),
    check('approved_answer_artifacts_decision_check', sql`output_decision = 'ALLOW'`),
    check(
      'approved_answer_artifacts_age_check',
      sql`age_band = ANY (ARRAY['8_10','11_12','13_14'])`,
    ),
  ],
);

export const answerDeliveryEvents = research.table(
  'answer_delivery_events',
  {
    familyId: uuid('family_id').notNull(),
    childId: uuid('child_id').notNull(),
    answerRunId: uuid('answer_run_id').notNull(),
    sequence: integer().notNull(),
    eventType: text('event_type').notNull(),
    artifactId: uuid('artifact_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    tenantPolicy(),
    primaryKey({ columns: [table.answerRunId, table.sequence] }),
    foreignKey({
      columns: [table.familyId, table.childId, table.answerRunId],
      foreignColumns: [answerRuns.familyId, answerRuns.childId, answerRuns.id],
      name: 'answer_delivery_events_run_scope_fkey',
    }),
    foreignKey({
      columns: [table.familyId, table.childId, table.artifactId],
      foreignColumns: [
        approvedAnswerArtifacts.familyId,
        approvedAnswerArtifacts.childId,
        approvedAnswerArtifacts.id,
      ],
      name: 'answer_delivery_events_artifact_scope_fkey',
    }),
    check('answer_delivery_events_sequence_check', sql`sequence > 0`),
    check(
      'answer_delivery_events_type_check',
      sql`event_type = ANY (ARRAY['QUESTION_ACCEPTED','ANSWER_APPROVED','ANSWER_COMPLETED','TERMINAL'])`,
    ),
  ],
);

export const challengeVersions = research.table(
  'challenge_versions',
  {
    id: uuid().primaryKey().notNull(),
    key: text().notNull(),
    version: integer().notNull(),
    kind: text().notNull(),
    title: text().notNull(),
    goal: text().notNull(),
    durationMinutes: integer('duration_minutes').notNull(),
    resumeWindowMinutes: integer('resume_window_minutes'),
    materials: jsonb().notNull(),
    steps: jsonb().notNull(),
    ageBands: jsonb('age_bands').notNull(),
    riskClass: text('risk_class').notNull(),
    supervisionRequirement: text('supervision_requirement').notNull(),
    origin: text().notNull(),
    distributionScope: text('distribution_scope').notNull(),
    status: text().notNull(),
    policyVersion: text('policy_version').notNull(),
    contentHash: text('content_hash').notNull(),
    reviewedBy: text('reviewed_by').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.policyVersion],
      foreignColumns: [researchPolicyVersions.id],
      name: 'challenge_versions_policy_fkey',
    }),
    unique('challenge_versions_key_version_unique').on(table.key, table.version),
    check('challenge_versions_version_check', sql`version > 0`),
    check('challenge_versions_hash_check', sql`content_hash ~ '^[a-f0-9]{64}$'`),
    check(
      'challenge_versions_kind_check',
      sql`kind = ANY (ARRAY['MICRO_PROBE','EXPERIENCE','PROJECT'])`,
    ),
    check(
      'challenge_versions_curated_check',
      sql`origin='CURATED' AND distribution_scope='CATALOG' AND status='PUBLISHED' AND risk_class='MINIMAL_RISK' AND supervision_requirement='NONE'`,
    ),
    check('challenge_versions_duration_check', sql`duration_minutes BETWEEN 1 AND 20`),
    check(
      'challenge_versions_resume_window_check',
      sql`(version = 1 AND resume_window_minutes IS NULL) OR (version > 1 AND resume_window_minutes BETWEEN duration_minutes AND 10080)`,
    ),
  ],
);

export const challengeOffers = research.table(
  'challenge_offers',
  {
    id: uuid().primaryKey().notNull(),
    familyId: uuid('family_id').notNull(),
    childId: uuid('child_id').notNull(),
    answerRunId: uuid('answer_run_id').notNull(),
    challengeVersionId: uuid('challenge_version_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    tenantPolicy(),
    foreignKey({
      columns: [table.familyId, table.childId, table.answerRunId],
      foreignColumns: [answerRuns.familyId, answerRuns.childId, answerRuns.id],
      name: 'challenge_offers_run_scope_fkey',
    }),
    foreignKey({
      columns: [table.challengeVersionId],
      foreignColumns: [challengeVersions.id],
      name: 'challenge_offers_version_fkey',
    }),
    unique('challenge_offers_answer_run_unique').on(table.answerRunId),
    unique('challenge_offers_scope_unique').on(table.familyId, table.childId, table.id),
  ],
);

export const challengeRuns = research.table(
  'challenge_runs',
  {
    id: uuid().primaryKey().notNull(),
    familyId: uuid('family_id').notNull(),
    childId: uuid('child_id').notNull(),
    answerRunId: uuid('answer_run_id').notNull(),
    offerId: uuid('offer_id').notNull(),
    challengeVersionId: uuid('challenge_version_id').notNull(),
    status: text().notNull(),
    rowVersion: integer('row_version').default(0).notNull(),
    currentStep: integer('current_step').default(0).notNull(),
    pausedAt: timestamp('paused_at', { withTimezone: true, mode: 'string' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    tenantPolicy(),
    foreignKey({
      columns: [table.familyId, table.childId, table.answerRunId],
      foreignColumns: [answerRuns.familyId, answerRuns.childId, answerRuns.id],
      name: 'challenge_runs_answer_scope_fkey',
    }),
    foreignKey({
      columns: [table.familyId, table.childId, table.offerId],
      foreignColumns: [challengeOffers.familyId, challengeOffers.childId, challengeOffers.id],
      name: 'challenge_runs_offer_scope_fkey',
    }),
    foreignKey({
      columns: [table.challengeVersionId],
      foreignColumns: [challengeVersions.id],
      name: 'challenge_runs_version_fkey',
    }),
    unique('challenge_runs_offer_unique').on(table.offerId),
    unique('challenge_runs_scope_unique').on(table.familyId, table.childId, table.id),
    check('challenge_runs_step_check', sql`current_step >= 0 AND row_version >= 0`),
    check('challenge_runs_expiry_check', sql`expires_at > created_at`),
    check(
      'challenge_runs_status_check',
      sql`status = ANY (ARRAY['IN_PROGRESS','DECLINED','ABANDONED','EXPIRED','BLOCKED_BY_POLICY'])`,
    ),
  ],
);

export const researchCommandReceipts = research.table(
  'command_receipts',
  {
    familyId: uuid('family_id').notNull(),
    childId: uuid('child_id').notNull(),
    commandKey: uuid('command_key').notNull(),
    actionHash: text('action_hash').notNull(),
    result: jsonb().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    tenantPolicy(),
    foreignKey({
      columns: [table.familyId, table.childId],
      foreignColumns: [childrenInFamily.familyId, childrenInFamily.id],
      name: 'research_command_receipts_child_scope_fkey',
    }),
    primaryKey({ columns: [table.familyId, table.childId, table.commandKey] }),
    check('research_command_receipts_hash_check', sql`action_hash ~ '^[a-f0-9]{64}$'`),
  ],
);

export const researchOutbox = research.table(
  'outbox',
  {
    id: uuid().primaryKey().notNull(),
    familyId: uuid('family_id').notNull(),
    childId: uuid('child_id').notNull(),
    answerRunId: uuid('answer_run_id').notNull(),
    eventType: text('event_type').notNull(),
    state: text().default('PENDING').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    tenantPolicy(),
    foreignKey({
      columns: [table.familyId, table.childId, table.answerRunId],
      foreignColumns: [answerRuns.familyId, answerRuns.childId, answerRuns.id],
      name: 'research_outbox_answer_scope_fkey',
    }),
    unique('research_outbox_answer_event_unique').on(table.answerRunId, table.eventType),
    check(
      'research_outbox_state_check',
      sql`state = ANY (ARRAY['PENDING','PROCESSING','PROCESSED','DEAD'])`,
    ),
  ],
);
