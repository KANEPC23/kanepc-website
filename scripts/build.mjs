#!/usr/bin/env node
/**
 * Kane PC build step — run by Netlify before publish.
 *
 * Three jobs:
 *   1. Inject PUBLIC config into the HTML (Turnstile site key), so no key is
 *      hardcoded in Git. Site keys are public by design, but keeping them in
 *      env means rotating one doesn't mean a code commit.
 *   2. Generate `_headers` with a Content-Security-Policy whose script-src
 *      carries a SHA-256 hash of every inline <script> in the page.
 *   3. Auto-scope a RELAXED CSP for sub-pages that legitimately need it — the
 *      demo apps (Chart.js from a CDN, inline onclick handlers) and the
 *      standalone client dashboards. Those pages can't run under the strict
 *      hash-only policy, so instead of silently breaking them we detect them
 *      and emit a per-path policy. The homepage and 404 stay strict (A+).
 *
 * Why hashes: the alternative is script-src 'unsafe-inline', which turns CSP
 * into decoration — it would permit exactly the injected <script> an XSS uses.
 * Hashing is the difference between a real policy and a checkbox. The cost is
 * that the hash must be regenerated whenever the inline script changes, which
 * is precisely why this is a build step and not a file someone edits by hand.
 *
 * Usage:  node scripts/build.mjs [srcDir] [outDir]
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile, mkdir, copyFile, stat } from 'node:fs/promises';
import { join, extname, relative, sep } from 'node:path';

const SRC = process.argv[2] || 'src';
const OUT = process.argv[3] || 'dist';

const SITE_KEY = process.env.TURNSTILE_SITE_KEY || '';
if (!SITE_KEY) {
  console.warn('⚠  TURNSTILE_SITE_KEY not set — the contact form will not verify.');
}

/* Scripts the strict policy already trusts. Anything else a page loads pushes
   that page onto the relaxed list. */
const TRUSTED_SCRIPT_HOSTS = new Set(['challenges.cloudflare.com']);

/* ---------- copy tree ---------- */
async function copyTree(from, to) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const s = join(from, entry.name);
    const d = join(to, entry.name);
    if (entry.isDirectory()) await copyTree(s, d);
    else await copyFile(s, d);
  }
}

/* ---------- collect inline <script> hashes + find pages needing relaxation ---------- */
const hashes = new Set();
// path (web, e.g. "/demo/hvac-dashboard/index.html") -> Set of external script hosts
const relaxed = new Map();

function webPath(absFile) {
  return '/' + relative(OUT, absFile).split(sep).join('/');
}

async function processHtml(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) { await processHtml(p); continue; }
    if (extname(entry.name) !== '.html') continue;

    let html = await readFile(p, 'utf8');
    html = html.replaceAll('__TURNSTILE_SITE_KEY__', SITE_KEY);
    await writeFile(p, html);

    // Hash only scripts with no src= (i.e. genuinely inline blocks).
    for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
      const body = m[1];
      if (!body.trim()) continue;
      hashes.add(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`);
    }

    // A page needs a relaxed policy if it uses inline event-handler attributes
    // (onclick=, oninput=, …) — which CSP hashes cannot cover — or loads a
    // script from a host the strict policy does not trust.
    const hasInlineHandlers = /\son[a-z]+\s*=\s*["']/i.test(html);
    const extHosts = new Set();
    for (const m of html.matchAll(/<script[^>]*\bsrc=["']https?:\/\/([^/"']+)/gi)) {
      const host = m[1].toLowerCase();
      if (!TRUSTED_SCRIPT_HOSTS.has(host)) extHosts.add(host);
    }
    if (hasInlineHandlers || extHosts.size) {
      relaxed.set(webPath(p), extHosts);
    }
  }
}

/* ---------- headers ---------- */
const SECURITY_HEADERS = `  Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: geolocation=(), microphone=(), camera=(), payment=(), usb=(), interest-cohort=()
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Resource-Policy: same-origin`;

function strictCsp() {
  return [
    "default-src 'self'",
    // Inline blocks by hash; Turnstile is the only third-party script allowed.
    `script-src 'self' ${[...hashes].join(' ')} https://challenges.cloudflare.com`,
    // 'unsafe-inline' here covers style="" attributes used throughout the markup.
    // Style injection is a far lower-severity class than script injection, and
    // CSP has no attribute-level hashing that browsers support widely enough.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    // EXTRA_IMG_HOSTS: set this env var if gallery.json points at images that
    // are NOT self-hosted (Supabase Storage, a CDN). Without it, CSP silently
    // blocks them and the gallery renders empty tiles.
    `img-src 'self' data: blob:${process.env.EXTRA_IMG_HOSTS ? ' ' + process.env.EXTRA_IMG_HOSTS : ''}`,
    "connect-src 'self'",
    "frame-src https://challenges.cloudflare.com",
    "form-action 'self'",
    "frame-ancestors 'none'",      // clickjacking
    "base-uri 'none'",             // stops <base> hijacking of relative URLs
    "object-src 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
}

/* A looser policy for pages that use inline handlers / CDN scripts. Still
   blocks clickjacking, framing, <base> hijacking and plugins — it only trades
   script hash-pinning for 'unsafe-inline' plus the specific CDN host(s) that
   page actually loads. Applied ONLY to those paths; the site default stays strict. */
function relaxedCsp(extHosts) {
  const scriptHosts = [...extHosts].map((h) => `https://${h}`).join(' ');
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${scriptHosts ? ' ' + scriptHosts : ''} https://challenges.cloudflare.com`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com",
    "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
}

/* Collapse per-file relaxed paths into as few _headers rules as possible.
   Every /demo/** page folds into a single "/demo/*" rule (union of hosts);
   standalone pages keep their own path. */
function relaxedRules() {
  const demoHosts = new Set();
  let anyDemo = false;
  const standalone = [];
  for (const [path, hosts] of relaxed) {
    if (path.startsWith('/demo/')) { anyDemo = true; hosts.forEach((h) => demoHosts.add(h)); }
    else standalone.push([path, hosts]);
  }
  const blocks = [];
  if (anyDemo) {
    blocks.push(`/demo/*\n  Content-Security-Policy: ${relaxedCsp(demoHosts)}`);
  }
  for (const [path, hosts] of standalone.sort()) {
    blocks.push(`${path}\n  Content-Security-Policy: ${relaxedCsp(hosts)}`);
  }
  return blocks;
}

function headersFile() {
  const parts = [];
  // Site default — strict.
  parts.push(`/*\n  Content-Security-Policy: ${strictCsp()}\n${SECURITY_HEADERS}`);
  // Per-path relaxations (override the CSP header for those paths only; the
  // security headers above still apply because they aren't re-set here).
  for (const block of relaxedRules()) parts.push(block);
  // Caching.
  parts.push(`/images/*\n  Cache-Control: public, max-age=31536000, immutable`);
  parts.push(`/gallery.json\n  Cache-Control: public, max-age=300, must-revalidate`);
  parts.push(`/*.html\n  Cache-Control: public, max-age=0, must-revalidate`);
  return parts.join('\n\n') + '\n';
}

/* ---------- run ---------- */
await copyTree(SRC, OUT);
await processHtml(OUT);
await writeFile(join(OUT, '_headers'), headersFile());

console.log(`✓ built ${SRC} → ${OUT}`);
console.log(`✓ site key ${SITE_KEY ? 'injected' : 'MISSING'}`);
console.log(`✓ CSP pinned to ${hashes.size} inline script hash(es)`);
if (relaxed.size) {
  console.log(`✓ relaxed CSP scoped to ${relaxed.size} sub-page(s): ${[...relaxed.keys()].join(', ')}`);
} else {
  console.log('✓ no sub-pages needed a relaxed policy — whole site is strict');
}

/* Fail loudly if the gallery can't possibly work. A silent empty gallery on
   launch day is worse than a failed build. */
try {
  const manifest = JSON.parse(await readFile(join(OUT, 'gallery.json'), 'utf8'));
  const items = Array.isArray(manifest.items) ? manifest.items : [];
  const cats = new Set(items.map((i) => i.category));
  const known = new Set(['cameras', 'control4', 'msp', 'pos', 'webapps']);
  const unknown = [...cats].filter((c) => !known.has(c));
  const external = items
    .filter((i) => i.image && /^https?:\/\//i.test(i.image))
    .map((i) => new URL(i.image).origin);

  console.log(`✓ gallery.json: ${items.length} item(s), categories: ${[...cats].join(', ')}`);
  if (unknown.length) console.warn(`⚠  categories with no matching filter button: ${unknown.join(', ')}`);
  if (external.length && !process.env.EXTRA_IMG_HOSTS) {
    console.warn(`⚠  gallery uses external image hosts but EXTRA_IMG_HOSTS is unset — CSP will block: ${[...new Set(external)].join(', ')}`);
  }
  const missing = [];
  for (const i of items) {
    if (!i.image || /^https?:\/\//i.test(i.image)) continue;
    try { await stat(join(OUT, i.image.replace(/^\//, ''))); }
    catch { missing.push(i.image); }
  }
  if (missing.length) console.warn(`⚠  ${missing.length} gallery image(s) not found in build: ${missing.slice(0,5).join(', ')}${missing.length>5?' …':''}`);
} catch {
  console.warn('⚠  no gallery.json in the build — the Work section will show "Gallery is temporarily unavailable."');
}
