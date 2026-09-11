/**
 * Onboarding code format — shared by the minter and the verifying function.
 *
 * Imported by BOTH scripts/mint-onboard-token.mjs and
 * netlify/functions/onboard.mjs (esbuild bundles it into the function) so the
 * two can never drift. A mismatch between how a code is hashed at mint time and
 * at redeem time would silently reject every valid code.
 *
 * Crockford base32: no I, L, O or U. The first three are dropped because they
 * are indistinguishable from 1 and 0 when read aloud or written by hand — which
 * is the entire point, since these codes get said over the phone and copied off
 * a work order. U is dropped so random codes cannot spell anything unfortunate.
 *
 * The database stores ONLY sha256(normalize(code)). The plaintext code exists
 * in the minting output and nowhere else, so this format can be changed at any
 * time: previously issued codes keep verifying, because verification never
 * parses the format — it only hashes. No migration is involved.
 */

import { randomBytes, createHash } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Fold what a human actually typed into its canonical form.
 * Generous on purpose: people add spaces, drop dashes, and type the letters
 * Crockford deliberately avoids.
 */
export function normalizeCode(input) {
  return String(input || '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')  // spaces, dashes, stray punctuation
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

export function hashCode(input) {
  return createHash('sha256').update(normalizeCode(input), 'utf8').digest('hex');
}

/**
 * `length` random Crockford characters, optionally behind a human-readable
 * prefix. The prefix is for the human ("which client is this?"); the random
 * tail is the actual secret, so a guessable prefix costs nothing.
 *
 * 256 % 32 === 0, so byte % 32 is uniform — no modulo bias to correct for.
 */
export function generateCode({ prefix = '', length = 8 } = {}) {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % 32];
  const clean = normalizeCode(prefix);
  return clean ? `${clean}${out}` : out;
}

/** Display form only — dashes every 4 chars. normalizeCode() strips them again. */
export function formatCode(code, prefixLen = 0) {
  const head = code.slice(0, prefixLen);
  const tail = code.slice(prefixLen);
  const grouped = tail.replace(/(.{4})(?=.)/g, '$1-');
  return head ? `${head}-${grouped}` : grouped;
}
