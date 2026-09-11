#!/usr/bin/env node
/**
 * Mint a customer onboarding code.
 *
 * Generates a short Crockford base32 code, stores only its SHA-256 hash, and
 * prints the code once. The plaintext exists in this output and nowhere else,
 * so a database leak yields no usable codes. Lost a code? Revoke the row and
 * mint a new one.
 *
 * The intended shape is ONE STANDING CODE PER CLIENT ORG, long-lived and
 * multi-use, so a new PC lands in the right organization on first check-in with
 * no holding pen and no org move. Keep a short-lived single-use code for the
 * cases that warrant one.
 *
 * Usage:
 *   # standing code for a client (the common case)
 *   node scripts/mint-onboard-token.mjs --org 42 --prefix ACME \
 *        --label "Acme Corp - standing" --days 365 --uses 50
 *
 *   # generic fallback into the ONBOARDING org, for walk-ins
 *   node scripts/mint-onboard-token.mjs --org 99 --label "ONBOARDING - walk-ins" \
 *        --days 365 --uses 500
 *
 *   # one-shot code for a single machine
 *   node scripts/mint-onboard-token.mjs --org 42 --label "Smith - new Dell XPS"
 *
 * Env:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 * Optional:
 *   ONBOARD_BASE_URL   defaults to https://onboarding.kanepc.com
 */

import { generateCode, formatCode, hashCode, normalizeCode } from '../lib/onboard-code.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback = undefined) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BASE = process.env.ONBOARD_BASE_URL || 'https://onboarding.kanepc.com';

if (!SB_URL || !SB_KEY) {
  console.error('✗ SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
  process.exit(1);
}

const orgId = Number(arg('org'));
const label = arg('label');
if (!orgId || !label) {
  console.error('✗ --org <ninjaOrgId> and --label "<who this is for>" are required.');
  process.exit(1);
}

const locationId = arg('location') ? Number(arg('location')) : null;
const days = Number(arg('days', '7'));
const maxUses = Number(arg('uses', '1'));
const installerType = arg('type', 'WINDOWS_MSI');
const prefix = normalizeCode(arg('prefix', ''));
const length = Number(arg('length', '8'));
const createdBy = process.env.USER || process.env.USERNAME || 'unknown';

const code = generateCode({ prefix, length });
const expiresAt = new Date(Date.now() + days * 86400000).toISOString();

const res = await fetch(`${SB_URL}/rest/v1/onboarding_tokens`, {
  method: 'POST',
  headers: {
    apikey: SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
    'content-type': 'application/json',
    Prefer: 'return=representation',
  },
  body: JSON.stringify({
    token_hash: hashCode(code),
    label,
    org_id: orgId,
    location_id: locationId,
    installer_type: installerType,
    expires_at: expiresAt,
    max_uses: maxUses,
    created_by: createdBy,
  }),
});

if (!res.ok) {
  console.error(`✗ insert failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}

const [row] = await res.json();
const pretty = formatCode(code, prefix.length);

console.log('');
console.log('  ✓ Onboarding code created');
console.log('');
console.log(`      code      ${pretty}`);
console.log(`      go to     ${BASE}`);
console.log('');
console.log(`      prefilled ${BASE}/?c=${code}`);
console.log('');
console.log(`      for       ${label}`);
console.log(`      ninja org ${orgId}${locationId ? ` / location ${locationId}` : ''}`);
console.log(`      installer ${installerType}`);
console.log(`      expires   ${expiresAt.slice(0, 10)} (${days}d)`);
console.log(`      uses      ${maxUses}`);
console.log(`      row id    ${row.id}`);
console.log('');
console.log('      This is the only time the code is shown. To revoke:');
console.log(`      update onboarding_tokens set revoked_at = now() where id = '${row.id}';`);
console.log('');
