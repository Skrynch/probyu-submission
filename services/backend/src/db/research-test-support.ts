import { Pool } from 'pg';

const databaseUrl = 'postgresql://probyu:probyu_local@127.0.0.1:54329/probyu_m3_test';

export async function resetSyntheticResearchDatabase(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query(
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
    await pool.query(
      "UPDATE research.policy_versions SET active=true,kill_epoch=1 WHERE id='synthetic-m3-v1'",
    );
  } finally {
    await pool.end();
  }
}

export async function killSyntheticResearch(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query(
      "UPDATE research.policy_versions SET kill_epoch=kill_epoch+1 WHERE id='synthetic-m3-v1'",
    );
  } finally {
    await pool.end();
  }
}
