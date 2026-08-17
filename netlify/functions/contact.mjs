/**
 * Kane PC contact endpoint — Cloudflare Turnstile verify → Resend send.
 *
 * Netlify Functions v2 (ESM). Routed to /api/contact via `config.path` below,
 * so no redirect rule is needed. The homepage form POSTs a urlencoded body here.
 *
 * Required env (Netlify ▸ Site configuration ▸ Environment variables — see DEPLOY.md §3):
 *   TURNSTILE_SECRET_KEY   (secret)   Cloudflare Turnstile secret
 *   RESEND_API_KEY         (secret)   Resend sending key
 *   CONTACT_FROM                      e.g. "Kane PC <website@kanepc.com>"  (must be on a Resend-verified domain)
 *   CONTACT_TO_KANEPC                 e.g. "info@kanepc.com"
 *   ALLOWED_ORIGINS                   e.g. "https://kanepc.com,https://www.kanepc.com"
 * Optional (brand routing off the form's hidden _site field):
 *   CONTACT_TO_KANEAV                 routes _site=kaneav
 *   CONTACT_TO_KANEFIRE               routes _site=kanefire
 */

export const config = { path: '/api/contact' };

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const esc = (s = '') =>
  String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed.' });

  // Origin allowlist — stops the endpoint being POSTed from someone else's page.
  const allowed = (process.env.ALLOWED_ORIGINS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.get('origin') || '';
  if (allowed.length && origin && !allowed.includes(origin)) {
    return json(403, { error: 'Forbidden origin.' });
  }

  // Parse the form body (urlencoded or multipart).
  let form;
  try { form = await req.formData(); }
  catch { return json(400, { error: 'Could not read the form.' }); }
  const f = (k) => (form.get(k) || '').toString().trim();

  // Honeypot — real users never fill bot-field. Silently accept and drop.
  if (f('bot-field')) return json(200, { ok: true });

  const name = f('name'), email = f('email'), message = f('message');
  if (!name || !email || !message) {
    return json(400, { error: 'Please include your name, a valid email, and a message.' });
  }

  // --- Cloudflare Turnstile ---
  const token = f('cf-turnstile-response');
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return json(500, { error: 'Server not configured. Please call 914.607.3313.' });
  if (!token) return json(400, { error: 'Verification failed. Please try again.' });

  try {
    const ip = req.headers.get('x-nf-client-connection-ip') || req.headers.get('x-forwarded-for') || '';
    const body = new URLSearchParams({ secret, response: token });
    if (ip) body.set('remoteip', ip.split(',')[0].trim());
    const vr = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const v = await vr.json();
    if (!v.success) return json(400, { error: 'Verification failed. Please try again.' });
  } catch {
    return json(502, { error: 'Verification service unavailable. Please try again.' });
  }

  // --- route recipient by the hidden _site field ---
  const site = (f('_site') || 'kanepc').toLowerCase();
  const routed =
    site === 'kaneav'   ? process.env.CONTACT_TO_KANEAV :
    site === 'kanefire' ? process.env.CONTACT_TO_KANEFIRE :
                          process.env.CONTACT_TO_KANEPC;
  const recipient = routed || process.env.CONTACT_TO_KANEPC;
  const from = process.env.CONTACT_FROM;
  const apiKey = process.env.RESEND_API_KEY;
  if (!recipient || !from || !apiKey) {
    return json(500, { error: 'Server not configured. Please call 914.607.3313.' });
  }

  const company = f('company'), phone = f('phone'), need = f('need');
  const rows = [
    ['Name', name], ['Company', company], ['Email', email],
    ['Phone', phone], ['Need', need], ['Site', site],
  ].filter(([, v]) => v);

  const text = rows.map(([k, v]) => `${k}: ${v}`).join('\n') + `\n\nMessage:\n${message}`;
  const html =
    `<table style="font-family:Arial,sans-serif;font-size:14px;border-collapse:collapse">` +
    rows.map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#1B5E20"><strong>${esc(k)}</strong></td><td style="padding:4px 0">${esc(v)}</td></tr>`).join('') +
    `</table><p style="font-family:Arial,sans-serif;font-size:14px;white-space:pre-wrap;margin-top:12px">${esc(message)}</p>`;

  try {
    const rr = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [recipient],
        reply_to: email,
        subject: `New website enquiry — ${name}${company ? ' (' + company + ')' : ''}`,
        text,
        html,
      }),
    });
    if (!rr.ok) return json(502, { error: 'Could not send right now. Please call 914.607.3313.' });
  } catch {
    return json(502, { error: 'Could not send right now. Please call 914.607.3313.' });
  }

  return json(200, { ok: true });
};
