#!/usr/bin/env node
/**
 * List onboarding codes and what they have been used for.
 *
 * Standing per-client codes are long-lived by design, which means the failure
 * mode is not "a code leaked" but "nobody remembers which codes exist." This is
 * the inventory: what is live, how much of each is spent, and what is about to
 * lapse. The codes themselves cannot be shown — only their hashes are stored —
 * so this lists them by label.
 *
 * Usage:
 *   node scripts/list-onboard-tokens.mjs              # live codes
 *   node scripts/list-onboard-tokens.mjs --all        # include dead ones
 *   node scripts/list-onboard-tokens.mjs --org 42
 *   node scripts/list-onboard-tokens.mjs --events     # recent redemptions
 *   node scripts/list-onboard-tokens.mjs --events --failures
 *
 * Env:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

const args = process.argv.slice(2);
const has = (n) => args.includes(`--${n}`);
const arg = (n) => { const i = args.indexOf(`--${n}`); return i !== -1 ? args[i + 1] : undefined; };

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SB_URL || !SB_KEY) {
  console.error('✗ SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
  process.exit(1);
}

const sb = async (path) => {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  if (!res.ok) {
    console.error(`✗ ${path} -> ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  return res.json();
};

const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n);
const day = (iso) => (iso ? String(iso).slice(0, 10) : '—');

function status(t) {
  if (t.revoked_at) return 'revoked';
  if (new Date(t.expires_at) < new Date()) return 'expired';
  if (t.used_count >= t.max_uses) return 'used up';
  return 'live';
}

/* ---------- events mode ---------- */
if (has('events')) {
  const onlyFailures = has('failures');
  const filter = onlyFailures ? '&outcome=eq.rejected' : '';
  const rows = await sb(
    `onboarding_events?select=created_at,outcome,reason,intake_name,asset_tag,ip,token_id` +
    `${filter}&order=created_at.desc&limit=${Number(arg('limit') || 40)}`
  );
  const tokens = await sb('onboarding_tokens?select=id,label');
  const labelOf = new Map(tokens.map((t) => [t.id, t.label]));

  if (!rows.length) { console.log('\n  no onboarding events recorded yet\n'); process.exit(0); }

  console.log('');
  console.log(`  ${pad('WHEN', 17)}${pad('OUTCOME', 10)}${pad('CODE', 26)}${pad('WHO / NOTE', 34)}IP`);
  console.log(`  ${'─'.repeat(100)}`);
  for (const e of rows) {
    const when = new Date(e.created_at).toISOString().replace('T', ' ').slice(0, 16);
    const who = e.outcome === 'issued'
      ? [e.intake_name, e.asset_tag].filter(Boolean).join(' · ') || '—'
      : (e.reason || '—');
    console.log(
      `  ${pad(when, 17)}${pad(e.outcome, 10)}${pad(labelOf.get(e.token_id) || '—', 26)}${pad(who, 34)}${e.ip || '—'}`
    );
  }
  console.log('');
  process.exit(0);
}

/* ---------- tokens mode ---------- */
const orgFilter = arg('org') ? `&org_id=eq.${Number(arg('org'))}` : '';
const tokens = await sb(`onboarding_tokens?select=*${orgFilter}&order=created_at.desc`);

const rows = has('all') ? tokens : tokens.filter((t) => status(t) === 'live');

if (!rows.length) {
  console.log(has('all') ? '\n  no onboarding codes exist yet\n' : '\n  no live onboarding codes (try --all)\n');
  process.exit(0);
}

console.log('');
console.log(`  ${pad('LABEL', 32)}${pad('ORG', 6)}${pad('USES', 10)}${pad('EXPIRES', 12)}${pad('STATUS', 9)}ID`);
console.log(`  ${'─'.repeat(104)}`);

const soon = Date.now() + 30 * 86400000;
for (const t of rows) {
  const st = status(t);
  const exp = day(t.expires_at);
  // Standing codes are set and forgotten — flag the ones about to lapse, since a
  // silently expired client code shows up as a confused customer, not an alert.
  const lapsing = st === 'live' && new Date(t.expires_at).getTime() < soon ? ' ←' : '';
  console.log(
    `  ${pad(t.label, 32)}${pad(t.org_id, 6)}${pad(`${t.used_count}/${t.max_uses}`, 10)}` +
    `${pad(exp + lapsing, 12)}${pad(st, 9)}${t.id}`
  );
}

const lapsingCount = rows.filter(
  (t) => status(t) === 'live' && new Date(t.expires_at).getTime() < soon
).length;

console.log('');
console.log(`  ${rows.length} code(s)${has('all') ? '' : ' live'}${lapsingCount ? ` · ${lapsingCount} expiring within 30 days (←)` : ''}`);
console.log('');
console.log("  revoke:  update onboarding_tokens set revoked_at = now() where id = '<id>';");
console.log('  history: node scripts/list-onboard-tokens.mjs --events');
console.log('');
