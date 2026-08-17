# Kane PC website — v7 migration notes

**Date:** 2026-08-17 · **Prepared by:** Claude (Cowork) for Bill Kane

This repo has been restructured from the flat v6.2 layout into the v7 Netlify
build described in `DEPLOY.md`. The gallery, all demos, and every standalone
client page were preserved. The pieces the v7 bundle was missing have been
regenerated.

---

## SOLVED — v7 site assembled into a deployable Netlify build

**PROBLEM**
The v7 zip was a *partial* of the bundle `DEPLOY.md` describes. It shipped the
new `index.html`, `404.html`, `og-image.png`, `build.mjs`, and `DEPLOY.md`, but
not the build wiring (`netlify.toml`), the form backend (`contact.mjs`), or the
icon/manifest/robots/sitemap set the new page links to. The new `index.html`
also assumes a build step it wasn't getting: it carries a `__TURNSTILE_SITE_KEY__`
placeholder and POSTs the contact form to `/api/contact`. Dropped into the old
flat repo and served as-is, the contact form would have gone dead (broken
Turnstile widget + a 404 on `/api/contact`) and several icon links would 404 —
a regression from a currently-working form. Separately, the strict Content-
Security-Policy the build generates would have blanked out all 12 demo apps
(Chart.js from a CDN, inline `onclick` handlers) and several dashboards.

**FIX**
- Restructured the repo to the `DEPLOY.md` layout: site content into `src/`,
  `build.mjs` into `scripts/`, form backend into `netlify/functions/`, config
  at the root.
- Generated the missing files (see manifest below), matching `DEPLOY.md`.
- Wrote `netlify/functions/contact.mjs` — Cloudflare Turnstile verify → Resend
  send — routed to `/api/contact`, with origin allow-listing, honeypot, and
  `_site`-based brand routing (kanepc / kaneav / kanefire).
- Enhanced `scripts/build.mjs` so the strict hash-based CSP stays on the clean
  pages (homepage, 404) but a **scoped, relaxed CSP is auto-emitted** for the
  demos and the dashboard/configurator pages that need CDN scripts or inline
  handlers. The build detects these automatically and prints which pages got
  the relaxed policy, so a future page that needs it won't silently break.
- Preserved the six standalone client pages your local clone was missing
  (`Lamport-Estimate-Configurator`, `Lamport-Facilities-Dashboard`,
  `Lamport-Lighting-Configurator`, `beldonsquare`, `thank-you`, `demo`).
- Dropped the obsolete `__forms.html` (Netlify Forms detector) — the form is a
  function now, not a Netlify Form.

**Verified**
- `node scripts/build.mjs src dist` → site key injected, 19 inline-script
  hashes pinned, relaxed CSP scoped to 16 sub-pages, homepage/404 strict.
- Gallery audit: 13 items, categories (`webapps`, `cameras`, `pos`) all match
  filter buttons, **no missing images**.
- Every local asset the homepage references resolves in `dist/`.
- `contact.mjs` and `build.mjs` pass `node --check`.

**HAND-OFF — remaining steps before this goes live (yours to do)**
1. **Cloudflare Turnstile** and **Resend** — set up per `DEPLOY.md` §1–2.
2. **Netlify env vars** — set them (`DEPLOY.md` §3): `TURNSTILE_SITE_KEY`,
   `TURNSTILE_SECRET_KEY`, `RESEND_API_KEY`, `CONTACT_FROM`, `CONTACT_TO_KANEPC`,
   `ALLOWED_ORIGINS`. The form returns a "Server not configured" message until
   these exist. `netlify.toml` sets the build command/publish/functions
   automatically on the next deploy — no UI change needed there.
3. **GitHub Pages must be turned off.** The repo currently *also* deploys via
   GitHub Pages (`kpc.kanepc.com`). GitHub Pages can't run the build or the
   function — and after this restructure there's no `index.html` at the repo
   root for it to serve, so `kpc.kanepc.com` would break. Disable it
   (GitHub ▸ Settings ▸ Pages) and serve that hostname from Netlify, or retire
   it. Going forward, Netlify is the only deploy path.
4. **Verify live** — run the `curl` header + form checks in `DEPLOY.md` §5, and
   additionally confirm the per-path CSP took effect on a demo:
   `curl -sI https://<site>/demo/hvac-dashboard/ | grep -i content-security`
   should show the *relaxed* policy (with `unsafe-inline`), while the homepage
   shows the strict hash policy. Netlify applies the most specific `_headers`
   rule, so `/demo/*` overrides `/*` — worth eyeballing once.
5. **Mobile QA** — the by-hand checklist at the bottom of `DEPLOY.md`.

> Note on your local clone: the folder on `k2` was behind `origin/main` and
> missing several pages. This build was made from current `origin` (`494d220`),
> so commit *this* to GitHub (your actual deploy source) rather than pushing
> from the stale local clone.

---

## File manifest

### New / regenerated
```
netlify.toml                      build + functions config (auto-applies on deploy)
.gitignore                        ignores dist/, node_modules/, .netlify/
scripts/build.mjs                 enhanced: scoped CSP + existing key/hash injection
netlify/functions/contact.mjs     Turnstile verify → Resend send, /api/contact
src/index.html                    v7 homepage (from your zip)
src/404.html                      v7 branded 404 (from your zip)
src/og-image.png                  social card (from your zip)
src/favicon.svg                   brand mark, scalable
src/favicon-32.png                legacy favicon
src/icon-180.png                  iOS home screen (apple-touch)
src/icon-192.png                  Android / PWA
src/icon-512.png                  PWA / schema.org logo
src/icon-512.svg                  maskable source
src/site.webmanifest              PWA manifest
src/robots.txt                    allows all, points to sitemap
src/sitemap.xml                   homepage
```
Icons/favicons were derived from your existing brand mark (the ring-and-"K"
from the 404 page) — swap in official artwork if you have it.

### Preserved (moved into src/)
`gallery.json`, `images/`, `demo/` (12 apps), the three `Lamport-*` pages,
`beldonsquare.html`, `thank-you.html`, `demo.html`, and the legacy root demo
JPGs.

### Removed
`__forms.html` — obsolete now that the form is a serverless function.

### Generated at deploy, never committed
`dist/` — the published output of `build.mjs`.
