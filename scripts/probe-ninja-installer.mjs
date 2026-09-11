#!/usr/bin/env node
/**
 * Probe the NinjaOne installer endpoint before trusting it in production.
 *
 * Per the probe-first rule in DMSP-Integration-Build-Standard: the installer
 * path and response shape used by netlify/functions/onboard.mjs are taken from
 * the NinjaOne API reference, not from a confirmed call against the us2 tenant.
 * This script makes that call and prints exactly what comes back, so the
 * function can be corrected from evidence rather than assumption.
 *
 * It is READ-ONLY. Generating an installer URL does not enroll anything — a
 * device only appears in NinjaOne once the installer is actually run.
 *
 * Usage:
 *   node scripts/probe-ninja-installer.mjs              # lists orgs, then probes the first
 *   node scripts/probe-ninja-installer.mjs --org 42
 *   node scripts/probe-ninja-installer.mjs --org 42 --location 7
 *
 * Env:
 *   NINJA_CLIENT_ID, NINJA_CLIENT_SECRET
 * Optional:
 *   NINJA_BASE  defaults to https://us2.ninjarmm.com
 */

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(`--${n}`); return i !== -1 ? args[i + 1] : undefined; };

const BASE = process.env.NINJA_BASE || 'https://us2.ninjarmm.com';
const ID = process.env.NINJA_CLIENT_ID;
const SECRET = process.env.NINJA_CLIENT_SECRET;

if (!ID || !SECRET) {
  console.error('✗ NINJA_CLIENT_ID and NINJA_CLIENT_SECRET must be set.');
  process.exit(1);
}

async function token() {
  const res = await fetch(`${BASE}/ws/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: ID,
      client_secret: SECRET,
      scope: 'management',
    }),
  });
  if (!res.ok) throw new Error(`token -> ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

const t = await token();
console.log('✓ got access token\n');

const get = (path) =>
  fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${t}`, Accept: 'application/json' },
    redirect: 'manual',
  });

let orgId = arg('org');
if (!orgId) {
  const orgs = await (await get('/v2/organizations')).json();
  console.log(`organizations (${orgs.length}):`);
  for (const o of orgs.slice(0, 15)) console.log(`   ${o.id}\t${o.name}`);
  if (!orgs.length) process.exit(1);
  orgId = orgs[0].id;
  console.log(`\n→ probing with org ${orgId}\n`);
}

let locationId = arg('location');
if (!locationId) {
  const locs = await (await get(`/v2/organization/${orgId}/locations`)).json();
  console.log(`locations for org ${orgId} (${locs.length}):`);
  for (const l of locs.slice(0, 15)) console.log(`   ${l.id}\t${l.name}`);
  locationId = locs[0]?.id;
  console.log('');
}

/* Candidate paths, most specific first. Whichever returns 2xx/3xx is the one to
   hard-code in onboard.mjs. */
const candidates = [
  locationId && `/v2/organization/${orgId}/location/${locationId}/installer/WINDOWS_MSI`,
  `/v2/organization/${orgId}/installer/WINDOWS_MSI`,
  locationId && `/v2/organization/${orgId}/location/${locationId}/installer`,
].filter(Boolean);

for (const path of candidates) {
  process.stdout.write(`GET ${path}\n`);
  try {
    const res = await get(path);
    const body = await res.text();
    console.log(`   status   ${res.status}`);
    if (res.headers.get('location')) console.log(`   location ${res.headers.get('location')}`);
    console.log(`   body     ${body.slice(0, 400)}`);
  } catch (err) {
    console.log(`   ✗ ${err.message}`);
  }
  console.log('');
}

console.log('Correct installerPath() in netlify/functions/onboard.mjs to match whichever succeeded.');
