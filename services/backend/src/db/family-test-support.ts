import { Pool } from 'pg';

export async function expireSyntheticConsent() {
  const pool = new Pool({
    connectionString: 'postgresql://probyu:probyu_local@127.0.0.1:54329/probyu_m2_test',
  });
  try {
    await pool.query(
      "UPDATE family.consent_projections SET expires_at=now()-interval '1 day' WHERE granted",
    );
  } finally {
    await pool.end();
  }
}

export async function expireSyntheticParentPrivilege() {
  const pool = new Pool({
    connectionString: 'postgresql://probyu:probyu_local@127.0.0.1:54329/probyu_m2_test',
  });
  try {
    await pool.query(
      "UPDATE identity.sessions SET parent_seen=now()-interval '6 minutes' WHERE mode='PARENT' AND revoked_at IS NULL",
    );
  } finally {
    await pool.end();
  }
}

export async function resetSyntheticFamilyDatabase() {
  const pool = new Pool({
    connectionString: 'postgresql://probyu:probyu_local@127.0.0.1:54329/probyu_m2_test',
  });
  try {
    await pool.query(
      'TRUNCATE identity.auth_budgets,family.families,identity.parents,identity.registrations,identity.sessions,identity.proofs,family.memberships,family.representatives,family.children,family.reauth_receipts,family.consent_receipts,family.consent_projections,family.command_receipts,ops.family_outbox,family.processing_authorizations CASCADE',
    );
  } finally {
    await pool.end();
  }
}
