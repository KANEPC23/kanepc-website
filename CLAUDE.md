# Kane PC website (v7)

Static site built from `src/` into `dist/` by `scripts/build.mjs`, deployed on
Netlify. Serverless functions in `netlify/functions/` (v2, ESM, Node 20). Some
state in Supabase project `KANEPC-WEBSITE` (`vwjsunupqgendxzclhro`).

```bash
node scripts/build.mjs src dist   # what Netlify runs
```

`dist/` is generated on every deploy. Never commit it.

## Security rules

These two are the house rules. They exist because we got bitten, not in theory.

### 1. Scripts ask for credentials — they never require exported env vars

Any script a human runs by hand resolves each credential in this order:

1. Use the environment variable if it is already set.
2. Otherwise prompt interactively, **masking secret values as they are typed**.
3. Otherwise fail with a message naming the variable and how to set it.

Never make an exported env var the only way in. Use `lib/prompt-secret.mjs`
(`requireEnv(name, { secret, label })` and `credentialNotice()`); copy that
helper into other repos rather than re-inventing the muted-stdin handling.

Validate CLI arguments *before* prompting, so a missing `--org` fails
immediately instead of after someone has typed a service key.

Never echo, log, or write a prompted value to disk.

**Why:** an exported secret lands in shell history, in the environment of every
child process, and in whatever crash reporter dumps env. A prompted one stays in
the process.

### 2. Probe before writing a vendor API call

Do not write a call to a third-party API from documentation alone. Write a probe
script first, run it against the real tenant, and build from the response you
actually got. If a call ships unverified, mark it `PROBE-FIRST` in a comment and
say so in the PR.

`scripts/probe-ninja-installer.mjs` is the pattern. Probes stay read-only.

**Why:** vendor docs drift, and a wrong endpoint fails at the worst moment —
in front of a customer, on a new machine, with no fallback. Originally from
`DMSP-Integration-Build-Standard.md` in the DiamondMSP repo.

### Credential posture

Vendor secrets live only in function env vars. The browser never holds them and
never calls a vendor API directly — it calls our function, which calls the
vendor. This closed the 2026-05-27 breach vector (client-side OAuth plus an
anon-readable credential table); do not reintroduce it.

Prefer a **separate** API client per surface over reusing one. The website is
more exposed than an internal app, so a website compromise should cost one
credential rotation, not the whole integration.

## Netlify environment variables

Getting the secret flag wrong breaks deploys in a way that is hard to undo.

- **Never mark a variable secret if the build injects it into HTML.**
  `TURNSTILE_SITE_KEY` is written into `dist/` by `build.mjs`; marking it secret
  makes Netlify's secret scan fail every deploy. The flag **cannot be removed
  once set** — you would have to delete and recreate the variable.
- Site keys are public by design. Secret keys are not.
- Secrets get **Functions** scope; build-time values get **Builds** scope.

## CSP

`build.mjs` generates `dist/_headers` with a strict, hash-pinned CSP, and
auto-relaxes only pages that need it.

**A page with inline `on*=` handlers gets dropped onto the relaxed policy.** Use
`addEventListener` so new pages stay strict. After adding a page, check the
build output: it lists which pages were relaxed. If yours is on that list and
you did not intend it, that is a bug.

Third-party scripts are blocked unless the host is in `TRUSTED_SCRIPT_HOSTS`.

## Supabase

Tables here are reached only by functions using the service role. RLS is enabled
with **no policies** — deny-all by design. The `rls_enabled_no_policy` advisor
notice is the intended state, not something to "fix" by adding a policy.

Commit every migration under `supabase/migrations/`. Applying SQL through the
dashboard or MCP without committing it is how schema drift starts.

## Conventions

- Functions use raw `fetch`, not vendor SDKs — keeps them dependency-free.
- Shared logic goes in `lib/` and is imported by both scripts and functions, so
  the two cannot drift. `lib/onboard-code.mjs` is the example: if minting and
  verifying disagreed about hashing, every code would fail silently.
- Error messages shown to users stay vague about *why* something was rejected;
  the real reason goes to the log. A precise rejection is a probing oracle.
- Phone number in user-facing copy: 914.607.3313.
