/**
 * Kane PC onboarding endpoint — token gate → Turnstile → NinjaOne installer.
 *
 * Netlify Functions v2 (ESM), routed to /api/onboard via `config.path`.
 *
 * Why this exists rather than a plain download link: a NinjaOne agent installer
 * is full remote control of a machine. Published at a stable URL on a
 * legitimately-branded HTTPS domain, it becomes an ideal tech-support-scam lure
 * ("download the support agent from kanepc.com"). So the installer URL is
 * generated server-side, per request, only for a caller holding an unexpired
 * single-use token, and is never reusable.
 *
 * Mirrors the credential posture of DiamondMSP's ninja-proxy: vendor secrets
 * live ONLY in function env vars; the browser never holds them and never calls
 * NinjaOne directly.
 *
 * Required env (Netlify ▸ Site configuration ▸ Environment variables):
 *   SUPABASE_URL                        https://vwjsunupqgendxzclhro.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY (secret)  bypasses RLS on the onboarding tables
 *   TURNSTILE_SECRET_KEY      (secret)  shared with the contact form
 *   NINJA_CLIENT_ID           (secret)
 *   NINJA_CLIENT_SECRET       (secret)
 *   ALLOWED_ORIGINS                     shared with the contact form
 * Optional:
 *   NINJA_BASE                          defaults to https://us2.ninjarmm.com
 */

import { hashCode } from '../../lib/onboard-code.mjs';

export const config = { path: '/api/onboard' };

const NINJA_BASE = process.env.NINJA_BASE || 'https://us2.ninjarmm.com';
const TOKEN_URL = `${NINJA_BASE}/ws/oauth/token`;

/* The onboarding client only ever generates installers. Scope it to the minimum
   NinjaOne will accept rather than reusing ninja-proxy's broader credential. */
const SCOPE = 'management';

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

/* Deliberately vague for the caller — a precise reason ("expired" vs "already
   used" vs "no such token") is a probing oracle. The real reason is logged. */
const REJECT = 'That code was not recognized. Please check it and try again, or call Kane PC at 914.607.3313.';

/* ---------- Supabase (raw REST; no SDK dependency, matching contact.mjs) ---------- */
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const sbHeaders = () => ({
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  'content-type': 'application/json',
});

async function consumeToken(tokenHash) {
  const res = await fetch(`${SB_URL}/rest/v1/rpc/consume_onboarding_token`, {
    method: 'POST',
    headers: sbHeaders(),
    body: JSON.stringify({ p_token_hash: tokenHash }),
  });
  if (!res.ok) throw new Error(`consume_onboarding_token -> ${res.status} ${await res.text()}`);
  const rows = await res.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

/* Short codes are guessable in a way 32-byte tokens are not, so throttling is
   load-bearing rather than decorative. Counted server-side off the rejection log
   (see the onboard_rate_limit migration) — an in-memory counter would reset on
   every cold start and reward an attacker for spreading requests out. */
async function rateLimited(ip) {
  if (!ip) return false;
  try {
    const res = await fetch(`${SB_URL}/rest/v1/rpc/onboard_rate_limited`, {
      method: 'POST',
      headers: sbHeaders(),
      body: JSON.stringify({ p_ip: ip }),
    });
    if (!res.ok) return false;
    return (await res.json()) === true;
  } catch (err) {
    // Fail open: a throttle outage must not block legitimate onboarding.
    console.error('rate limit check failed:', err.message);
    return false;
  }
}

/* The audit trail is half the reason for storing tokens at all — but never let a
   logging failure take down the onboarding itself. */
async function logEvent(row) {
  try {
    await fetch(`${SB_URL}/rest/v1/onboarding_events`, {
      method: 'POST',
      headers: { ...sbHeaders(), Prefer: 'return=minimal' },
      body: JSON.stringify(row),
    });
  } catch (err) {
    console.error('onboarding_events insert failed:', err.message);
  }
}

/* ---------- NinjaOne ---------- */
let cachedToken = null;
let tokenExpiry = 0;

async function getNinjaToken() {
  if (cachedToken && Date.now() < tokenExpiry - 60000) return cachedToken;
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.NINJA_CLIENT_ID,
      client_secret: process.env.NINJA_CLIENT_SECRET,
      scope: SCOPE,
    }),
  });
  if (!res.ok) throw new Error(`NinjaOne token failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;
  return cachedToken;
}

/* PROBE-FIRST (per DMSP-Integration-Build-Standard): the path and response shape
   below come from the NinjaOne API reference operations `getInstaller` /
   `getInstallerForLocation`, but have NOT been confirmed against the us2 tenant.
   Run `node scripts/probe-ninja-installer.mjs` with the credentials before
   trusting this in production, and correct here if it differs. */
const installerPath = (orgId, locationId, type) =>
  locationId
    ? `/v2/organization/${orgId}/location/${locationId}/installer/${type}`
    : `/v2/organization/${orgId}/installer/${type}`;

async function generateInstaller({ org_id, location_id, installer_type }) {
  const token = await getNinjaToken();
  const path = installerPath(org_id, location_id, installer_type);
  const res = await fetch(`${NINJA_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    redirect: 'manual',
  });

  // Some NinjaOne installer routes 302 straight at the artifact.
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location');
    if (loc) return loc;
  }
  if (!res.ok) throw new Error(`NinjaOne installer ${path} -> ${res.status} ${await res.text()}`);

  const data = await res.json();
  const url = data?.url || data?.downloadUrl || data?.installerUrl || data?.link;
  if (!url) throw new Error(`NinjaOne installer returned no URL: ${JSON.stringify(data).slice(0, 300)}`);
  return url;
}

/* ---------- handler ---------- */
export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed.' });

  const allowed = (process.env.ALLOWED_ORIGINS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.get('origin') || '';
  if (allowed.length && origin && !allowed.includes(origin)) {
    return json(403, { error: 'Forbidden origin.' });
  }

  let form;
  try { form = await req.formData(); }
  catch { return json(400, { error: 'Could not read the form.' }); }
  const f = (k) => (form.get(k) || '').toString().trim();

  if (f('bot-field')) return json(200, { ok: true });

  const ip = (req.headers.get('x-nf-client-connection-ip') ||
              req.headers.get('x-forwarded-for') || '').split(',')[0].trim();
  const userAgent = req.headers.get('user-agent') || '';

  const rawCode = f('code');
  if (!rawCode) return json(400, { error: 'Please enter your setup code.' });

  // --- Turnstile ---
  const captcha = f('cf-turnstile-response');
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return json(500, { error: 'Server not configured. Please call 914.607.3313.' });
  if (!captcha) return json(400, { error: 'Verification failed. Please try again.' });
  try {
    const body = new URLSearchParams({ secret, response: captcha });
    if (ip) body.set('remoteip', ip);
    const vr = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!(await vr.json()).success) {
      return json(400, { error: 'Verification failed. Please try again.' });
    }
  } catch {
    return json(502, { error: 'Verification service unavailable. Please try again.' });
  }

  const intake = {
    intake_name: f('name') || null,
    intake_email: f('email') || null,
    asset_tag: f('asset_tag') || null,
    department: f('department') || null,
    ip: ip || null,
    user_agent: userAgent || null,
  };

  // --- throttle before spending a lookup on a guessed code ---
  if (await rateLimited(ip)) {
    await logEvent({ ...intake, token_id: null, outcome: 'rejected', reason: 'rate limited' });
    return json(429, { error: 'Too many attempts. Please wait 15 minutes, or call Kane PC at 914.607.3313.' });
  }

  // --- code gate (atomic validate + increment) ---
  let tk;
  try {
    tk = await consumeToken(hashCode(rawCode));
  } catch (err) {
    console.error('code consume failed:', err.message);
    return json(502, { error: 'Could not verify that code. Please try again.' });
  }

  if (!tk) {
    await logEvent({ ...intake, token_id: null, outcome: 'rejected', reason: 'invalid/expired/used/revoked' });
    return json(403, { error: REJECT });
  }

  // --- generate the installer ---
  try {
    const url = await generateInstaller(tk);
    await logEvent({ ...intake, token_id: tk.id, outcome: 'issued', reason: null });
    return json(200, { ok: true, url, label: tk.label });
  } catch (err) {
    console.error('installer generation failed:', err.message);
    await logEvent({ ...intake, token_id: tk.id, outcome: 'rejected', reason: `installer error: ${err.message}`.slice(0, 500) });
    return json(502, { error: 'Could not prepare your installer. Please call Kane PC at 914.607.3313.' });
  }
};
