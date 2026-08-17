# Kane PC v7 — Deploy & Security Runbook

## Complete file manifest

Everything below is in this bundle **except the two lines marked YOU SUPPLY**.

```
KANEPC23/
├─ netlify.toml                    build + redirect config
├─ .gitignore
├─ DEPLOY.md                       this file
├─ scripts/
│  └─ build.mjs                    injects site key, generates CSP, audits gallery
├─ netlify/functions/
│  └─ contact.mjs                  Turnstile verify → Resend send
└─ src/
   ├─ index.html                   the site
   ├─ 404.html                     branded not-found page
   ├─ favicon.svg                  modern browsers
   ├─ favicon-32.png               legacy fallback
   ├─ icon-180.png                 iOS home screen
   ├─ icon-192.png / icon-512.png  Android / PWA
   ├─ icon-512.svg                 maskable source
   ├─ og-image.png                 1200×630 social card
   ├─ site.webmanifest
   ├─ robots.txt
   ├─ sitemap.xml
   ├─ gallery.json                 ← YOU SUPPLY (copy from live v6.2 site)
   └─ images/                      ← YOU SUPPLY (copy from live v6.2 site)
```

`dist/` is generated on every build — never commit it, never edit it.

---

## 0. Pre-flight — the gallery does NOT come across on its own

The Work section fetches `/gallery.json` at runtime. **That file and the images
are not in this bundle** — they live on the current v6.2 site. Copy both into
`src/` before the first build:

```
src/gallery.json      ← from the live site
src/images/           ← from the live site
```

Without them the Work section renders *"Gallery is temporarily unavailable."*
The build now warns you rather than letting that ship silently:

```
⚠  no gallery.json in the build — the Work section will show "Gallery is temporarily unavailable."
⚠  3 gallery image(s) not found in build: /images/foo.jpg
⚠  categories with no matching filter button: control4-av
```

**If any gallery image is hosted off-site** (Supabase Storage, a CDN), set
`EXTRA_IMG_HOSTS` in Netlify or CSP will block it and the tiles render empty:

```
EXTRA_IMG_HOSTS = https://vwjsunupqgendxzclhro.supabase.co
```

The build warns about this too. Treat every ⚠ as a blocker.

### Category names must match

The filter buttons expect exactly: `cameras` · `control4` · `msp` · `pos` ·
`webapps`. These match your existing manifest. Any other value renders the tile
under "All work" only, and the build will name it.

---

## 1. Cloudflare Turnstile (5 min)

1. Cloudflare dashboard ▸ **Turnstile** ▸ Add widget
2. Name: `kanepc.com` · Domains: `kanepc.com`, `www.kanepc.com`, `kanepc.netlify.app`
3. Widget mode: **Managed**
4. Copy the **Site Key** (public) and **Secret Key** (private)

Restricting the domain list matters — it stops someone embedding your site key
on their own page and burning your quota.

## 2. Resend (10 min)

1. resend.com ▸ **Domains** ▸ Add `kanepc.com`
2. Resend gives you DKIM + SPF records → add them in **Cloudflare DNS as
   "DNS only" (grey cloud)**
3. Wait for **Verified**
4. **API Keys** ▸ Create, scope **Sending access only** — not full access

Sender must be on the verified domain: `Kane PC <website@kanepc.com>`.
Using a Gmail/Outlook address as `from` gets you filed as spam by DMARC.

## 3. Netlify environment variables

Site configuration ▸ Environment variables. Mark each **Secret** where noted.

| Key | Value | Secret |
|---|---|---|
| `TURNSTILE_SITE_KEY` | `0x4AAA…` | no (public by design) |
| `TURNSTILE_SECRET_KEY` | `0x4AAA…` | **yes** |
| `RESEND_API_KEY` | `re_…` | **yes** |
| `CONTACT_TO_KANEPC` | `info@kanepc.com` | no |
| `CONTACT_FROM` | `Kane PC <website@kanepc.com>` | no |
| `ALLOWED_ORIGINS` | `https://kanepc.com,https://www.kanepc.com` | no |

Add `CONTACT_TO_KANEAV` / `CONTACT_TO_KANEFIRE` when those brands go live —
the same function already routes them off the form's hidden `_site` field.

## 4. DNS cutover (do last)

Currently `kanepc.com` serves the old GoDaddy WordPress site; v6.2 lives at
`kpc.kanepc.com`. To cut the apex over:

1. Netlify ▸ Domain management ▸ Add `kanepc.com` + `www.kanepc.com`
2. Set the **primary** domain — Netlify 301s the other one automatically
3. In Cloudflare DNS:
   - `kanepc.com` → `ALIAS`/`CNAME` to `<site>.netlify.app` — **grey cloud**
   - `www` → `CNAME` to `<site>.netlify.app` — **grey cloud**
4. Wait for Netlify to show **HTTPS certificate provisioned**
5. **Do not touch the MX records.** Microsoft 365 mail flows through them.
   Changing the A/CNAME for the apex does not affect MX, but verify after.

> **Orange cloud breaks this.** Proxying through Cloudflare in front of
> Netlify's own CDN causes a double-CDN conflict and blocks SSL provisioning.
> Grey cloud, every time.

## 5. Verify (do not skip)

```bash
# headers present?
curl -sI https://kanepc.com | grep -iE 'content-security|strict-transport|x-frame|x-content'

# form actually works, end to end — should return the Turnstile rejection,
# which proves the gate is live and server-side
curl -s -X POST https://kanepc.com/api/contact \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data 'name=Test&email=test@example.com&message=hello'
# expect: {"error":"Verification failed. Please try again."}
```

Then submit the real form in a browser and confirm the email lands.

Grade the headers at <https://securityheaders.com> and the TLS config at
<https://www.ssllabs.com/ssltest/>. This configuration should score A/A+.

---

## What each header is doing

| Header | Stops |
|---|---|
| `Content-Security-Policy` | XSS — script must be self-hosted, hash-matched, or Turnstile |
| `Strict-Transport-Security` | SSL-strip downgrade; browser refuses plain HTTP for a year |
| `X-Frame-Options` / `frame-ancestors` | Clickjacking — your site in someone's hidden iframe |
| `X-Content-Type-Options` | MIME sniffing an upload into an executable type |
| `Referrer-Policy` | Leaking full URLs to third parties |
| `Permissions-Policy` | Silently claiming camera/mic/geolocation |
| `base-uri 'none'` | `<base>` injection re-pointing every relative URL |

**Before adding `preload` to HSTS**, understand it is effectively permanent —
browsers ship the list baked in and removal takes months. The header as written
is correct, but only submit to hstspreload.org once every Kane subdomain is
confirmed HTTPS-only. If anything internal still runs plain HTTP on a
`*.kanepc.com` name, it will break.

## Rotating a key

Turnstile or Resend key rotation is an env var change plus a redeploy. No code
change, nothing in Git history to scrub. That is the reason for this structure.

## When the inline script changes

The CSP contains a SHA-256 of the inline `<script>`. `scripts/build.mjs`
regenerates it on every deploy, so this is automatic — **but** if you ever edit
`index.html` and upload it by hand instead of pushing to Git, the hash will not
match and the page's JavaScript will silently stop running. Always deploy
through the build.


---

## Mobile QA — what was verified, and what you should tap

Fixed during this pass: **the hamburger button was inert.** Nav links hide below
780px and the button had no handler, so the site was unnavigable on a phone.
There is now a real slide-down menu with all six destinations, a tap-to-call
number, and the consultation CTA.

Verified in the markup:

| Area | Behaviour |
|---|---|
| Mobile menu | opens/closes, Escape closes, closes on link tap, auto-closes if rotated to desktop width |
| Every multi-column grid | collapses to one column — hero, stats, capability circle, switch, gallery, office, contact, footer |
| Capability circle | scales to 360px and stays tappable; detail panel stacks beneath |
| Gallery | 3 → 2 → 1 columns at 900 / 560 |
| Lightbox | prev/next move inside the frame below 1100px; thumbnails shrink to 46px |
| Tap targets | menu items, filter pills, buttons, lightbox controls all ≥44px |
| Horizontal scroll | `overflow-x:hidden` guard on `html, body` |
| Ticket timeline | timestamps stack above text below 560px instead of squeezing |

**Still test by hand on a real phone** before you point DNS — an emulator will
not catch these:

1. Tap the hamburger, tap a link, confirm it scrolls *and* the menu closes
2. Tap each of the five circle segments — the panel should swap
3. Open a gallery tile, swipe/tap through the Diamond Coach screens, close it
4. Submit the contact form on cellular, not office wifi — Turnstile behaves
   differently on mobile networks and this is the one thing worth proving live
5. Rotate to landscape mid-scroll and confirm nothing overflows

Run Lighthouse mobile on the deploy preview before promoting it.
