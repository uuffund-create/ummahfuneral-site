// UUFFUNDS payments server
// ------------------------------------------------------------------
// The one small piece that has to run on a server, because it uses the
// Stripe SECRET key. It runs on Google Cloud (Cloud Run functions) inside
// the Firebase project "united-ummah-funeral-funds".
//
// What it does
//   POST /donate      anyone       starts a donation and returns its client secret
//   POST /card        contributor  saves a card for equal shares; when joining they can
//                                  add optional donations, one to the funeral fund (we
//                                  suggest $10) and one to support the platform, charged
//                                  once with the same card
//   POST /card/done   contributor  after Stripe confirms: makes it the main card
//   GET  /card        contributor  saved card, unpaid funeral shares and credit
//   POST /share/pay   contributor  pay an unpaid funeral share (returns its client secret)
//   POST /share/done  contributor  after Stripe confirms the late payment
//   GET  /admin/cards admin only   saved card and credit for every contributor
//   POST /admin/charge-shares      admin only: charges a funeral's equal share (plus
//                                  Stripe's fee) to every listed contributor's saved card,
//                                  covers declined cards by splitting them among the
//                                  others, and emails the people whose card was declined
//   GET  /admin/owed  admin only   unpaid shares and their reminder emails
//   POST /admin/test-email         admin only: sends a test email to the admin
//   POST /admin/run-reminders      admin only: sends any reminder emails that are due now
//   POST /tasks/reminders          Google Cloud Scheduler only (every 15 minutes): same
//
// What the site's terms promise when a card is declined (and what this does):
//   - the share is reassigned right away across the other contributors, so the
//     funeral is paid in full;
//   - the person still owes it and is emailed right away, then reminded at 8, 16,
//     24 and 32 hours; after 32 hours it is written off (no more reminders);
//   - if they pay after the others covered it, it counts as credit toward their
//     next equal share (it is not refunded).
//
// Card numbers never reach this server. The browser sends them straight to
// Stripe, and Stripe gives us back only the brand and the last 4 digits.
//
// Settings (Cloud Run > stripe-api > Variables & Secrets):
//   STRIPE_SECRET_KEY_LIVE   sk_live_... or rk_live_...
//   STRIPE_SECRET_KEY_TEST   sk_test_... or rk_test_...
//   RESEND_API_KEY           re_...  (resend.com; sends the reminder emails)
// Every request says which Stripe mode to use with ?mode=live or ?mode=test.
//
// Where things are recorded: only in Stripe (payment metadata), so there is no
// second database to keep in step. Credit is worked out from the payments
// themselves, so it can never be counted twice.

const crypto = require('node:crypto');

const PROJECT_ID = 'united-ummah-funeral-funds';
const ADMIN_EMAIL = 'uuffund@gmail.com';
const SITE_URL = 'https://ummahfuneral.org';
const OLD_JOIN_DONATION_CENTS = 1000; // pages from before the donation became optional always showed $10
const DONATION_MIN_CENTS = 100; // $1
const DONATION_MAX_CENTS = 1000000; // $10,000
const ALLOWED_ORIGINS = ['https://ummahfuneral.org', 'https://www.ummahfuneral.org'];
// Stripe's US card price (2.9% + 30c). Each funeral share includes it, so the
// fund receives the full share. Whole cents only, rounded up.
const FEE_FIXED_CENTS = 30;
const FEE_KEEP_PER_THOUSAND = 971; // 1000 - 29 (2.9%)
const withFee = (shareCents) => Math.ceil(((shareCents + FEE_FIXED_CENTS) * 1000) / FEE_KEEP_PER_THOUSAND);
const MAX_SHARE_CENTS = 500000; // $5,000 per person, as a safety limit
const MIN_NET_CENTS = 18; // withFee(18) = 50c, the smallest card charge Stripe allows
const DAY = 86400;
const HOUR = 3600;
// The same funeral name charged again within 30 days is the same funeral:
// anyone already charged for it is skipped, so nobody pays twice.
const SAME_CASE_SECONDS = 30 * DAY;
// Reminder emails, in hours after the declined charge (the first goes right away).
const REMINDER_HOURS = [0, 8, 16, 24, 32];
const WRITE_OFF_SECONDS = 32 * HOUR;
const SHOW_OWED_SECONDS = 30 * DAY; // unpaid shares stay payable in My Account for 30 days
const OWED_STATUSES = ['requires_payment_method', 'requires_action', 'requires_confirmation'];

// Email (resend.com). The domain ummahfuneral.org must be verified in Resend.
const EMAIL_FROM = process.env.EMAIL_FROM || 'UUFFUNDS <reminders@ummahfuneral.org>';
const EMAIL_REPLY_TO = ADMIN_EMAIL;

// Cloud Scheduler calls POST /tasks/reminders with a token signed by Google for
// this project's default service account. Nobody else can make that token.
const SERVICE_URL = 'https://stripe-api-783984253394.us-central1.run.app';
const TASKS_SERVICE_ACCOUNT = process.env.TASKS_SERVICE_ACCOUNT || '783984253394-compute@developer.gserviceaccount.com';

const DESTINATIONS = {
  funeral: 'Funeral fund',
  platform: 'Platform support',
  split: 'Split between both'
};

// ---- small helpers ---------------------------------------------------

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  return err;
}

const cleanText = (value, max) =>
  String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function cleanEmail(value) {
  const email = cleanText(value, 254).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

const nowSeconds = () => Math.floor(Date.now() / 1000);
const cents = (value) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const sum = (list) => list.reduce((a, b) => a + b, 0);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const money = (c) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

async function inBatches(items, size, fn) {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(fn));
  }
}

function modeOf(req) {
  const mode = (req.query && req.query.mode) || (req.body && req.body.mode);
  if (mode === 'live' || mode === 'test') return mode;
  throw httpError(400, 'Missing payment mode.');
}

// Very small per-instance rate limit, to slow down anyone trying to test
// stolen cards through the donation form. Stripe Radar is the main defense.
const hits = new Map();
function tooMany(key, limit, windowMs) {
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) {
    for (const [k, times] of hits) if (!times.some((t) => now - t < windowMs)) hits.delete(k);
  }
  return recent.length > limit;
}

const clientIp = (req) =>
  String((req.get && req.get('x-forwarded-for')) || req.ip || 'unknown').split(',')[0].trim();

// ---- Stripe (plain HTTPS calls, no extra packages) --------------------

function formEncode(value, prefix, out) {
  out = out || [];
  if (value === undefined || value === null) return out;
  if (Array.isArray(value)) {
    value.forEach((item, i) => formEncode(item, `${prefix}[${i}]`, out));
  } else if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) formEncode(v, prefix ? `${prefix}[${k}]` : k, out);
  } else {
    out.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`);
  }
  return out;
}

const keyLooksRight = (mode, key) => (mode === 'live' ? /^(sk|rk)_live_/.test(key) : /^(sk|rk)_test_/.test(key));
const rawKey = (mode) => String((mode === 'live' ? process.env.STRIPE_SECRET_KEY_LIVE : process.env.STRIPE_SECRET_KEY_TEST) || '').trim();
const modeReady = (mode) => keyLooksRight(mode, rawKey(mode));

function secretKey(mode) {
  const key = rawKey(mode);
  if (!keyLooksRight(mode, key)) {
    throw httpError(503, mode === 'live' ? 'Card payments are not switched on yet.' : 'Test payments are not set up.');
  }
  return key;
}

async function stripe(mode, method, path, params, idempotencyKey) {
  const key = secretKey(mode);
  const query = params ? formEncode(params).join('&') : '';
  let url = `https://api.stripe.com/v1${path}`;
  const init = { method, headers: { Authorization: `Bearer ${key}` } };
  if (method === 'GET') {
    if (query) url += `?${query}`;
  } else {
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = query;
    if (idempotencyKey) init.headers['Idempotency-Key'] = idempotencyKey;
  }
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Stripe ${method} ${path} failed: ${(data.error && data.error.message) || res.status}`);
    err.status = 502;
    err.stripeError = data.error || {};
    throw err;
  }
  return data;
}

const isIdempotencyClash = (err) => !!(err && err.stripeError && err.stripeError.type === 'idempotency_error');

// Every payment of one Stripe customer, newest first (up to 500).
async function customerIntents(mode, customerId) {
  const out = [];
  let startingAfter;
  for (let page = 0; page < 5; page += 1) {
    const list = await stripe(mode, 'GET', '/payment_intents', { customer: customerId, limit: 100, starting_after: startingAfter });
    out.push(...list.data);
    if (!list.has_more || !list.data.length) break;
    startingAfter = list.data[list.data.length - 1].id;
  }
  return out;
}

// Stripe Search (a minute or so behind, which is fine for reminders and lists).
async function searchIntents(mode, query, expand) {
  const out = [];
  let page;
  for (let i = 0; i < 10; i += 1) {
    const res = await stripe(mode, 'GET', '/payment_intents/search', { query, limit: 100, page, expand });
    out.push(...res.data);
    if (!res.has_more || !res.next_page) break;
    page = res.next_page;
  }
  return out;
}

// ---- Google-signed tokens (Firebase log-ins and Cloud Scheduler) ------

const FIREBASE_CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
const GOOGLE_OIDC_CERTS_URL = 'https://www.googleapis.com/oauth2/v1/certs';
const certCaches = {};

async function googleCerts(url, force) {
  const cache = certCaches[url];
  if (!force && cache && Date.now() < cache.expires) return cache.certs;
  const res = await fetch(url);
  if (!res.ok) throw httpError(503, 'Could not check your log-in. Please try again.');
  const certs = await res.json();
  const maxAge = /max-age=(\d+)/.exec((res.headers && res.headers.get && res.headers.get('cache-control')) || '');
  certCaches[url] = { certs, expires: Date.now() + (maxAge ? Number(maxAge[1]) : 3600) * 1000 };
  return certs;
}

const fromB64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

// Checks the signature, the expiry and the issue time. Returns the claims.
async function verifyGoogleJwt(token, certsUrl, bad) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw bad();
  let header;
  let claims;
  try {
    header = JSON.parse(fromB64url(parts[0]).toString('utf8'));
    claims = JSON.parse(fromB64url(parts[1]).toString('utf8'));
  } catch (_) {
    throw bad();
  }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw bad();
  let certs = await googleCerts(certsUrl, false);
  if (!certs[header.kid]) certs = await googleCerts(certsUrl, true);
  const pem = certs[header.kid];
  if (!pem) throw bad();
  let publicKey;
  try {
    publicKey = new crypto.X509Certificate(pem).publicKey;
  } catch (_) {
    throw bad();
  }
  const signedPart = Buffer.from(`${parts[0]}.${parts[1]}`);
  if (!crypto.verify('RSA-SHA256', signedPart, publicKey, fromB64url(parts[2]))) throw bad();
  const now = nowSeconds();
  const skew = 300;
  if (!(typeof claims.exp === 'number' && claims.exp > now)) throw bad();
  if (!(typeof claims.iat === 'number' && claims.iat <= now + skew)) throw bad();
  return claims;
}

async function verifyIdToken(token) {
  const bad = () => httpError(401, 'Please log in again.');
  const claims = await verifyGoogleJwt(token, FIREBASE_CERTS_URL, bad);
  const now = nowSeconds();
  if (claims.aud !== PROJECT_ID) throw bad();
  if (claims.iss !== `https://securetoken.google.com/${PROJECT_ID}`) throw bad();
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 128) throw bad();
  if (claims.auth_time !== undefined && !(claims.auth_time <= now + 300)) throw bad();
  return {
    uid: claims.sub,
    email: String(claims.email || '').toLowerCase(),
    emailVerified: claims.email_verified === true
  };
}

const bearerOf = (req) => {
  const match = /^Bearer\s+(.+)$/i.exec(String((req.get && req.get('authorization')) || ''));
  return match ? match[1].trim() : '';
};

async function requireUser(req) {
  const token = bearerOf(req);
  if (!token) throw httpError(401, 'Please log in first.');
  const user = await verifyIdToken(token);
  if (!user.email) throw httpError(401, 'Please log in again.');
  return user;
}

async function requireAdmin(req) {
  const user = await requireUser(req);
  if (user.email !== ADMIN_EMAIL || !user.emailVerified) throw httpError(403, 'For the fund administrator only.');
  return user;
}

// Only Google Cloud Scheduler, using this project's service account.
async function requireScheduler(req) {
  const bad = () => httpError(401, 'Not allowed.');
  const token = bearerOf(req);
  if (!token) throw bad();
  const claims = await verifyGoogleJwt(token, GOOGLE_OIDC_CERTS_URL, bad);
  if (claims.iss !== 'https://accounts.google.com' && claims.iss !== 'accounts.google.com') throw bad();
  if (claims.aud !== SERVICE_URL && claims.aud !== `${SERVICE_URL}/tasks/reminders`) throw bad();
  if (claims.email !== TASKS_SERVICE_ACCOUNT || claims.email_verified === false) throw bad();
}

// ---- contributors in Stripe ------------------------------------------
// One Stripe customer per contributor, matched by their Firebase login id
// (metadata.firebaseUID), never by email alone.

async function findCustomer(mode, user, expandCard) {
  const list = await stripe(mode, 'GET', '/customers', {
    email: user.email,
    limit: 100,
    expand: expandCard ? ['data.invoice_settings.default_payment_method'] : undefined
  });
  return list.data.find((c) => c.metadata && c.metadata.firebaseUID === user.uid) || null;
}

async function findOrCreateCustomer(mode, user, name) {
  const found = await findCustomer(mode, user, false);
  if (found) {
    if (name && !found.name) return stripe(mode, 'POST', `/customers/${found.id}`, { name });
    return found;
  }
  return stripe(mode, 'POST', '/customers', {
    email: user.email,
    name: name || undefined,
    metadata: { firebaseUID: user.uid, source: 'ummahfuneral.org' }
  });
}

const cardOf = (pm) => (pm && pm.card ? { brand: pm.card.brand, last4: pm.card.last4 } : null);
const BRANDS = { visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express', discover: 'Discover', diners: 'Diners Club', jcb: 'JCB', unionpay: 'UnionPay' };
const cardLabel = (card) => (card ? `${BRANDS[card.brand] || 'Card'} ending ${card.last4}` : '');

// A card can be saved without being marked as the main one (for example if
// the page was closed right after paying). Fix that up when we notice it.
async function ensureDefaultCard(mode, customer) {
  const current = customer.invoice_settings && customer.invoice_settings.default_payment_method;
  if (current && typeof current === 'object') return cardOf(current);
  const pms = await stripe(mode, 'GET', `/customers/${customer.id}/payment_methods`, { type: 'card', limit: 1 });
  const pm = pms.data[0];
  if (!pm) return null;
  await stripe(mode, 'POST', `/customers/${customer.id}`, { invoice_settings: { default_payment_method: pm.id } });
  return cardOf(pm);
}

async function joinDonationPaid(mode, customer, intents) {
  if (customer.metadata && customer.metadata.joinDonationPaid === 'true') return true;
  const list = intents || (await stripe(mode, 'GET', '/payment_intents', { customer: customer.id, limit: 20 })).data;
  const paid = list.some((pi) => pi.status === 'succeeded' && pi.metadata && pi.metadata.type === 'joining_donation');
  if (paid) await stripe(mode, 'POST', `/customers/${customer.id}`, { metadata: { joinDonationPaid: 'true' } });
  return paid;
}

// ---- funeral shares: what is owed, and credit ------------------------

const metaOf = (pi) => (pi && pi.metadata) || {};
const isShare = (pi) => metaOf(pi).type === 'funeral_share';
// An equal share that was declined and is not paid yet.
const isOwedShare = (pi) => isShare(pi) && OWED_STATUSES.includes(pi.status) && metaOf(pi).creditOnly !== 'yes';
const dueOf = (pi) => {
  const m = metaOf(pi);
  return m.dueCents !== undefined ? cents(m.dueCents) : Math.max(0, cents(m.shareCents) - cents(m.creditUsedCents));
};

// Credit = late payments of shares the others had already covered, minus
// credit already used on later shares. `skip` leaves out the funeral being
// charged right now, so trying the same funeral again gives the same numbers.
function creditFrom(intents, skip) {
  let earned = 0;
  let used = 0;
  for (const pi of intents) {
    if (!isShare(pi)) continue;
    const m = metaOf(pi);
    if (pi.status === 'succeeded' && m.covered === 'yes') earned += dueOf(pi);
    if (!(skip && skip(pi))) used += cents(m.creditUsedCents);
  }
  return Math.max(0, earned - used);
}

// How much credit goes toward a share. A card charge can't be under 50c, so
// if only a few cents would be left to charge, a little credit is kept back.
function creditToUse(credit, shareCents) {
  if (credit >= shareCents) return shareCents;
  if (shareCents - credit < MIN_NET_CENTS) return Math.max(0, shareCents - MIN_NET_CENTS);
  return credit;
}

// Why a charge did not go through, for the admin.
function declineReason(e) {
  e = e || {};
  const code = e.decline_code || e.code || '';
  if (code === 'authentication_required') return 'Their bank wants them to approve it. They can pay from My Account.';
  if (code === 'insufficient_funds') return 'Not enough money on the card.';
  if (code === 'expired_card') return 'The card has expired.';
  if (code === 'card_declined' || code === 'generic_decline' || code === 'do_not_honor') return 'The card was declined.';
  return e.message || 'The charge did not go through.';
}

// Why it did not go through, for the contributor (never says lost, stolen or fraud).
function memberReason(e) {
  const code = (e && (e.decline_code || e.code)) || '';
  if (code === 'authentication_required') return 'your bank wanted you to approve it first';
  if (code === 'insufficient_funds' || code === 'card_velocity_exceeded' || code === 'withdrawal_count_limit_exceeded') return 'there wasn’t enough available on the card';
  if (code === 'expired_card') return 'the card has expired';
  if (code) return 'your bank declined it';
  return '';
}

const failedCardOf = (pi) => {
  const pm = pi && pi.last_payment_error && pi.last_payment_error.payment_method;
  return pm && typeof pm === 'object' ? cardOf(pm) : null;
};

// ---- email (Resend) -----------------------------------------------------

const emailReady = () => /^re_/.test(String(process.env.RESEND_API_KEY || '').trim());

async function sendEmail({ to, subject, text, html, key }) {
  const apiKey = String(process.env.RESEND_API_KEY || '').trim();
  if (!/^re_/.test(apiKey)) return { ok: false, notReady: true };
  let res;
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({ from: EMAIL_FROM, to: [to], reply_to: EMAIL_REPLY_TO, subject, text, html })
    });
  } catch (err) {
    console.error('email: could not reach Resend:', err.message);
    return { ok: false };
  }
  // 409 = this exact email was already sent (same Idempotency-Key), so nothing to do.
  if (res.ok || res.status === 409) return { ok: true };
  const data = await res.json().catch(() => ({}));
  console.error('email: Resend refused it:', res.status, data.name || '', data.message || '');
  return { ok: false, status: res.status, error: data.message || '' };
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const firstNameOf = (name) => cleanText(name, 100).split(' ')[0] || '';

// A plain, safe HTML email. `button` ({ label, href, after }) goes after paragraph number `after`.
function emailHtml(paragraphs, button) {
  const p = (t) => `<p style="margin:0 0 14px;font:15px/1.55 Arial,Helvetica,sans-serif;color:#23241f">${escapeHtml(t)}</p>`;
  const btn = button
    ? `<p style="margin:4px 0 18px"><a href="${escapeHtml(button.href)}" style="display:inline-block;background:#1f4436;color:#ffffff;text-decoration:none;font:600 15px Arial,Helvetica,sans-serif;padding:12px 20px;border-radius:4px">${escapeHtml(button.label)}</a></p>`
    : '';
  const parts = paragraphs.map(p);
  if (btn) parts.splice(Math.min(button.after + 1, parts.length), 0, btn);
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f2e9">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:6px;padding:28px 26px">
${parts.join('\n')}
</div></body></html>`;
}

// The email about one declined share. step: 0 = right away, 1-4 = the 8, 16, 24 and 32 hour reminders.
function shareEmail(mode, pi, customer, step) {
  const m = metaOf(pi);
  const first = firstNameOf(customer && !customer.deleted ? customer.name : '');
  const amount = money(pi.amount);
  const caseName = m.caseName || 'a funeral';
  const covered = m.covered === 'yes';
  const last = step >= REMINDER_HOURS.length - 1;
  const card = cardLabel(failedCardOf(pi));
  const why = memberReason(pi.last_payment_error);
  const link = `${SITE_URL}/?${mode === 'test' ? 'stripe=test&' : ''}account=pay`;
  const subject = `${mode === 'test' ? '[TEST] ' : ''}${step === 0
    ? 'Your funeral share didn’t go through'
    : last ? 'Last reminder: your funeral share is unpaid' : 'Reminder: your funeral share is still unpaid'}`;
  const top = [
    `As-salamu alaykum${first ? ` ${first}` : ''},`,
    step === 0
      ? `We tried to charge your card${card ? ` (${card})` : ''} for your equal share of ${caseName}, but it didn’t go through${why ? ` because ${why}` : ''}.`
      : `Your equal share of ${caseName} is still unpaid. The charge to your card${card ? ` (${card})` : ''} didn’t go through${why ? ` because ${why}` : ''}.`,
    covered
      ? `The other contributors covered your share for now, so the funeral is paid in full. You still owe your share of ${amount}. When you pay it, it counts toward your next equal share.`
      : `Please pay your share of ${amount}.`
  ];
  const howText = `To pay, open ${link} and log in. Your account will show “Pay now”. You can use a different card, and it will be saved for future shares.`;
  const howHtml = 'To pay, log in to your account. It will show “Pay now”. You can use a different card, and it will be saved for future shares.';
  const bottom = [
    last
      ? 'This is our last reminder. After this, the unpaid amount is written off and we won’t remind you again, as our terms describe.'
      : 'We’ll remind you again in 8 hours. After 32 hours, the unpaid amount is written off, as our terms describe.',
    'Questions? Just reply to this email.',
    'UUFFUNDS · United Ummah Funeral Funds'
  ];
  return {
    subject,
    text: `${[...top, howText, ...bottom].join('\n\n')}\n${SITE_URL}\n`,
    html: emailHtml([...top, howHtml, ...bottom], { label: `Log in and pay ${amount}`, href: link, after: top.length })
  };
}

async function emailAboutShare(mode, pi, customer, step) {
  const to = cleanEmail(pi.receipt_email || (customer && customer.email));
  if (!to) return { ok: false, noAddress: true };
  const content = shareEmail(mode, pi, customer, step);
  return sendEmail(Object.assign({ to, key: `${pi.id}-email-${step}` }, content));
}

// ---- routes ------------------------------------------------------------

async function startDonation(mode, req) {
  if (tooMany(`donate:${clientIp(req)}`, 10, 10 * 60 * 1000)) {
    throw httpError(429, 'Too many tries. Please wait a few minutes and try again.');
  }
  const body = req.body || {};
  const amount = Math.round(Number(body.amount) * 100);
  if (!Number.isFinite(amount) || amount < DONATION_MIN_CENTS || amount > DONATION_MAX_CENTS) {
    throw httpError(400, 'Please enter an amount between $1 and $10,000.');
  }
  const destination = Object.prototype.hasOwnProperty.call(DESTINATIONS, body.destination) ? body.destination : 'funeral';
  const anonymous = body.anonymous === true;
  const name = anonymous ? '' : cleanText(body.name, 100);
  const email = cleanEmail(body.email);
  if (!email) throw httpError(400, 'Please enter a valid email address for your receipt.');

  const intent = await stripe(mode, 'POST', '/payment_intents', {
    amount,
    currency: 'usd',
    payment_method_types: ['card'],
    description: `Sadaqah donation - ${DESTINATIONS[destination]}`,
    receipt_email: email,
    metadata: {
      type: 'donation',
      destination,
      anonymous: anonymous ? 'yes' : 'no',
      donorName: anonymous ? 'Anonymous' : name,
      source: 'ummahfuneral.org'
    }
  });
  return { clientSecret: intent.client_secret };
}

// One optional donation amount: 0, or $1 to $10,000, in cents.
function donationPart(value) {
  if (value === undefined || value === null) return 0;
  const amount = Number(value);
  if (!Number.isInteger(amount) || (amount !== 0 && (amount < DONATION_MIN_CENTS || amount > DONATION_MAX_CENTS))) {
    throw httpError(400, 'Please choose a donation between $1 and $10,000, or no donation.');
  }
  return amount;
}

// Saving a card. With donations (optional, chosen when joining: one to the
// funeral fund, one to the platform) the card is charged their total once and
// saved; without any it is only saved.
async function startCardStep(mode, req) {
  const user = await requireUser(req);
  if (tooMany(`card:${user.uid}`, 10, 10 * 60 * 1000)) {
    throw httpError(429, 'Too many tries. Please wait a few minutes and try again.');
  }
  const body = req.body || {};
  let fund = donationPart(body.donationCents);
  const platform = donationPart(body.platformCents);
  if ((body.donationCents === undefined || body.donationCents === null) && body.platformCents === undefined && body.want === 'payment') {
    fund = OLD_JOIN_DONATION_CENTS; // a page from before the donation became optional
  }
  const donation = fund + platform;
  if (donation > DONATION_MAX_CENTS) throw httpError(400, 'Please choose donations of $10,000 or less in total.');
  const name = cleanText(body.name, 100);
  const customer = await findOrCreateCustomer(mode, user, name);
  const metadata = { firebaseUID: user.uid, source: 'ummahfuneral.org' };

  if (!donation) {
    const setup = await stripe(mode, 'POST', '/setup_intents', {
      customer: customer.id,
      usage: 'off_session',
      payment_method_types: ['card'],
      metadata: Object.assign({ type: 'card_save' }, metadata)
    });
    return { kind: 'setup', clientSecret: setup.client_secret };
  }

  const destination = fund && platform ? 'both' : platform ? 'platform' : 'funeral';
  const where = { both: 'Funeral fund and platform support', platform: 'Platform support', funeral: 'Funeral fund' }[destination];
  const intent = await stripe(mode, 'POST', '/payment_intents', {
    amount: donation,
    currency: 'usd',
    customer: customer.id,
    setup_future_usage: 'off_session',
    payment_method_types: ['card'],
    description: `Sadaqah donation - joining - ${where}`,
    receipt_email: user.email,
    metadata: Object.assign({
      type: 'joining_donation',
      destination,
      fundCents: String(fund),
      platformCents: String(platform)
    }, metadata)
  });
  return { kind: 'payment', amount: donation, clientSecret: intent.client_secret };
}

async function finishCardStep(mode, req) {
  const user = await requireUser(req);
  const id = String((req.body && req.body.intentId) || '');
  if (!/^(pi|seti)_[A-Za-z0-9]+$/.test(id)) throw httpError(400, 'Missing payment id.');
  const isPayment = id.startsWith('pi_');
  const intent = await stripe(mode, 'GET', `${isPayment ? '/payment_intents/' : '/setup_intents/'}${id}`, {
    expand: ['payment_method']
  });
  if (!intent.metadata || intent.metadata.firebaseUID !== user.uid || !intent.customer) {
    throw httpError(403, 'This card step belongs to another account.');
  }
  if (intent.status !== 'succeeded') throw httpError(409, 'Your card was not confirmed yet.');
  const pm = intent.payment_method;
  const update = { invoice_settings: { default_payment_method: pm.id } };
  if (isPayment && intent.metadata.type === 'joining_donation') update.metadata = { joinDonationPaid: 'true' };
  await stripe(mode, 'POST', `/customers/${intent.customer}`, update);
  return { card: cardOf(pm) };
}

function owedView(pi, now) {
  const m = metaOf(pi);
  return {
    id: pi.id,
    caseName: m.caseName || 'Funeral share',
    amountCents: pi.amount,
    created: pi.created,
    covered: m.covered === 'yes',
    writtenOff: now - pi.created >= WRITE_OFF_SECONDS
  };
}

async function cardStatus(mode, req) {
  const user = await requireUser(req);
  const customer = await findCustomer(mode, user, true);
  if (!customer) return { card: null, joinPaid: false, owed: [], creditCents: 0 };
  const card = await ensureDefaultCard(mode, customer);
  const intents = await customerIntents(mode, customer.id);
  const joinPaid = await joinDonationPaid(mode, customer, intents);
  const now = nowSeconds();
  const owed = intents
    .filter((pi) => isOwedShare(pi) && now - pi.created < SHOW_OWED_SECONDS)
    .map((pi) => owedView(pi, now));
  return { card, joinPaid, owed, creditCents: creditFrom(intents) };
}

// The contributor pays a declined share themselves (any card; it is saved).
async function startSharePayment(mode, req) {
  const user = await requireUser(req);
  if (tooMany(`pay:${user.uid}`, 10, 10 * 60 * 1000)) {
    throw httpError(429, 'Too many tries. Please wait a few minutes and try again.');
  }
  const id = String((req.body && req.body.intentId) || '');
  if (!/^pi_[A-Za-z0-9]+$/.test(id)) throw httpError(400, 'Missing payment id.');
  const pi = await stripe(mode, 'GET', `/payment_intents/${id}`);
  const m = metaOf(pi);
  if (m.firebaseUID !== user.uid || !isShare(pi) || m.creditOnly === 'yes' || !pi.customer) {
    throw httpError(403, 'This share belongs to another account.');
  }
  if (pi.status === 'succeeded' || pi.status === 'processing') throw httpError(409, 'This share is already paid. Thank you!');
  if (!OWED_STATUSES.includes(pi.status)) throw httpError(409, 'This share can no longer be paid here. Please reply to one of our emails.');
  if (pi.setup_future_usage !== 'off_session') {
    await stripe(mode, 'POST', `/payment_intents/${id}`, { setup_future_usage: 'off_session' });
  }
  return { clientSecret: pi.client_secret, amountCents: pi.amount };
}

async function finishSharePayment(mode, req) {
  const user = await requireUser(req);
  const id = String((req.body && req.body.intentId) || '');
  if (!/^pi_[A-Za-z0-9]+$/.test(id)) throw httpError(400, 'Missing payment id.');
  const pi = await stripe(mode, 'GET', `/payment_intents/${id}`, { expand: ['payment_method'] });
  const m = metaOf(pi);
  if (m.firebaseUID !== user.uid || !isShare(pi) || !pi.customer) throw httpError(403, 'This share belongs to another account.');
  if (pi.status !== 'succeeded' && pi.status !== 'processing') throw httpError(409, 'Your payment was not confirmed yet.');
  const pm = pi.payment_method && typeof pi.payment_method === 'object' ? pi.payment_method : null;
  const update = {};
  if (pm) update.invoice_settings = { default_payment_method: pm.id };
  if (m.covered === 'yes') update.metadata = { hasCredit: 'yes' };
  if (Object.keys(update).length) await stripe(mode, 'POST', `/customers/${pi.customer}`, update);
  if (m.latePaid !== 'yes') await stripe(mode, 'POST', `/payment_intents/${id}`, { metadata: { latePaid: 'yes' } });
  const intents = await customerIntents(mode, pi.customer);
  return { card: cardOf(pm), covered: m.covered === 'yes', creditCents: creditFrom(intents) };
}

// Every contributor's Stripe customer and saved card, by Firebase login id.
async function contributorCards(mode) {
  const byUid = {};
  let startingAfter;
  for (let page = 0; page < 20; page += 1) {
    const list = await stripe(mode, 'GET', '/customers', {
      limit: 100,
      starting_after: startingAfter,
      expand: ['data.invoice_settings.default_payment_method']
    });
    for (const customer of list.data) {
      const uid = customer.metadata && customer.metadata.firebaseUID;
      if (!uid) continue;
      const card = await ensureDefaultCard(mode, customer);
      const current = customer.invoice_settings && customer.invoice_settings.default_payment_method;
      const pmId = current && typeof current === 'object' ? current.id : null;
      if (card || !byUid[uid]) {
        byUid[uid] = { customer, card, pmId, joinPaid: customer.metadata.joinDonationPaid === 'true' };
      }
    }
    if (!list.has_more || !list.data.length) break;
    startingAfter = list.data[list.data.length - 1].id;
  }
  return byUid;
}

async function adminCards(mode, req) {
  await requireAdmin(req);
  const byUid = await contributorCards(mode);
  const cards = {};
  const entries = Object.entries(byUid);
  await inBatches(entries, 5, async ([uid, entry]) => {
    let creditCents = 0;
    if (entry.customer.metadata.hasCredit === 'yes') {
      creditCents = creditFrom(await customerIntents(mode, entry.customer.id));
    }
    cards[uid] = { card: entry.card, joinPaid: entry.joinPaid, creditCents };
  });
  return { cards };
}

// ---- charging a funeral's equal share ------------------------------------

const caseIdFor = (caseName) => `case_${sha(cleanText(caseName, 60).toLowerCase()).slice(0, 24)}`;

function shareResult(person) {
  return {
    uid: person.uid,
    status: person.status,
    already: !!person.already,
    amountCents: person.amountCents || 0,
    creditUsedCents: person.creditUsed || 0,
    reason: person.reason || ''
  };
}

// Fill in a person from a payment for this funeral that already exists.
async function useExistingShare(mode, person, pi) {
  const m = metaOf(pi);
  person.share = pi;
  person.already = true;
  person.creditUsed = cents(m.creditUsedCents);
  person.due = dueOf(pi);
  if (m.creditOnly === 'yes') {
    person.status = 'credit';
    person.amountCents = 0;
    if (pi.status !== 'canceled') await cancelPlaceholder(mode, pi.id);
  } else if (pi.status === 'succeeded' || pi.status === 'processing') {
    person.status = 'charged';
    person.amountCents = pi.amount;
  } else if (OWED_STATUSES.includes(pi.status)) {
    person.status = 'failed';
    person.amountCents = pi.amount;
    person.reason = declineReason(pi.last_payment_error);
  } else {
    person.status = 'canceled';
    person.amountCents = 0;
    person.reason = 'This share was canceled in Stripe.';
  }
}

async function cancelPlaceholder(mode, id) {
  try {
    await stripe(mode, 'POST', `/payment_intents/${id}/cancel`, { cancellation_reason: 'abandoned' });
  } catch (err) {
    console.error('charge-shares: could not cancel the credit record', id, err.message);
  }
}

async function findShareFor(mode, person, caseId, since) {
  const intents = await customerIntents(mode, person.customer.id);
  person.intents = intents;
  return intents.find((pi) => isShare(pi) && metaOf(pi).caseId === caseId && pi.created >= since) || null;
}

// Charge one funeral's equal share to every listed contributor's saved card.
// The admin page sends the Active contributors and the per-person amount it
// showed in the preview; the server works the amount out again and refuses
// if they differ, so nobody is charged a number the admin did not see.
async function chargeShares(mode, req) {
  await requireAdmin(req);
  const body = req.body || {};
  const caseName = cleanText(body.caseName, 60);
  const totalCents = Number(body.totalCents);
  const donationCents = Number(body.donationCents || 0);
  const cover = body.cover !== false; // the terms: a declined share is covered by the others right away
  const uids = Array.isArray(body.uids) ? [...new Set(body.uids.map(String))] : [];
  if (!caseName) throw httpError(400, 'Please name the funeral (for example, Funeral of [name]).');
  if (!Number.isInteger(totalCents) || totalCents < 100) throw httpError(400, 'Please enter the total funeral cost.');
  if (!Number.isInteger(donationCents) || donationCents < 0) throw httpError(400, 'Donations to apply must be $0 or more.');
  if (donationCents >= totalCents) throw httpError(400, 'Donations already cover this cost, so nobody needs to be charged.');
  if (!uids.length || uids.length > 2000) throw httpError(400, 'No contributors to charge.');
  const caseId = caseIdFor(caseName);

  const byUid = await contributorCards(mode);
  const eligible = uids.filter((uid) => byUid[uid] && byUid[uid].card && byUid[uid].pmId);
  if (!eligible.length) throw httpError(400, 'None of these contributors has a saved card.');
  const shareCents = Math.ceil((totalCents - donationCents) / eligible.length);
  const chargeCents = withFee(shareCents);
  if (chargeCents > MAX_SHARE_CENTS) throw httpError(400, 'Each share would be over $5,000. Please check the amount.');
  if (shareCents < MIN_NET_CENTS) throw httpError(400, 'Each share would be under Stripe’s smallest charge (50¢). Please check the amount.');
  if (Number(body.expectedChargeCents) !== chargeCents || Number(body.expectedCount) !== eligible.length) {
    throw httpError(409, 'The numbers changed since your preview (someone added or removed a card). Please preview again.');
  }

  const since = nowSeconds() - SAME_CASE_SECONDS;
  const isThisCase = (pi) => metaOf(pi).caseId === caseId && pi.created >= since;
  const people = eligible.map((uid) => ({ uid, customer: byUid[uid].customer, pmId: byUid[uid].pmId }));
  const shareMeta = (person, use, due, extra) => Object.assign({
    type: 'funeral_share',
    caseId,
    caseName,
    shareCents: String(shareCents),
    creditUsedCents: String(use),
    dueCents: String(due),
    firebaseUID: person.uid,
    source: 'ummahfuneral.org admin'
  }, extra);

  // 1) Everyone's equal share (credit first, then the card).
  await inBatches(people, 5, async (person) => {
    const key = `${caseId}-${person.uid}`;
    try {
      const existing = await findShareFor(mode, person, caseId, since);
      if (existing) return useExistingShare(mode, person, existing);
      const use = creditToUse(creditFrom(person.intents, isThisCase), shareCents);
      const due = shareCents - use;
      person.creditUsed = use;
      person.due = due;
      if (due === 0) {
        // Paid in full from credit. A canceled $0.50 placeholder records it, so
        // the same credit can never be used twice. Nothing is charged.
        const record = await stripe(mode, 'POST', '/payment_intents', {
          amount: 50,
          currency: 'usd',
          customer: person.customer.id,
          payment_method_types: ['card'],
          description: `Funeral equal share - ${caseName} (paid from credit, nothing charged)`,
          metadata: shareMeta(person, use, 0, { feeCents: '0', creditOnly: 'yes' })
        }, key);
        await cancelPlaceholder(mode, record.id);
        person.share = record;
        person.status = 'credit';
        person.amountCents = 0;
        return undefined;
      }
      const amount = withFee(due);
      const intent = await stripe(mode, 'POST', '/payment_intents', {
        amount,
        currency: 'usd',
        customer: person.customer.id,
        payment_method: person.pmId,
        payment_method_types: ['card'],
        off_session: 'true',
        confirm: 'true',
        description: `Funeral equal share - ${caseName}`,
        receipt_email: person.customer.email || undefined,
        metadata: shareMeta(person, use, due, { feeCents: String(amount - due) })
      }, key);
      person.share = intent;
      person.amountCents = amount;
      person.status = intent.status === 'succeeded' || intent.status === 'processing' ? 'charged' : 'failed';
      if (person.status === 'failed') person.reason = 'The charge did not go through.';
    } catch (err) {
      if (isIdempotencyClash(err)) {
        // Started earlier with different numbers: use what really happened then.
        const existing = await findShareFor(mode, person, caseId, since).catch(() => null);
        if (existing) return useExistingShare(mode, person, existing);
      }
      const declined = err.stripeError && err.stripeError.payment_intent;
      if (declined && declined.id) {
        person.share = declined;
        person.status = 'failed';
        person.amountCents = declined.amount || person.amountCents || 0;
        person.reason = declineReason(err.stripeError);
      } else {
        if (!err.stripeError) console.error('charge-shares:', err.message);
        person.status = 'error';
        person.reason = err.expose ? err.message : 'Could not reach Stripe for this person. Nothing was charged to them. Press "Try again".';
      }
    }
    return undefined;
  });

  // 2) Declined shares are split among everyone whose share went through.
  const uncovered = people.filter((p) => p.status === 'failed' && p.share && !metaOf(p.share).covered);
  const coverers = people.filter((p) => p.status === 'charged' || p.status === 'credit');
  let coverInfo = null;
  let coveredMark = 'no';
  let roundKey = '';
  if (uncovered.length) {
    const shortfall = sum(uncovered.map((p) => p.due || 0));
    const coverShare = coverers.length ? Math.max(Math.ceil(shortfall / coverers.length), MIN_NET_CENTS) : 0;
    if (!cover) {
      coverInfo = { skipped: 'off', shortfallCents: shortfall };
    } else if (!coverers.length) {
      coverInfo = { skipped: 'nobody', shortfallCents: shortfall };
    } else if (coverShare > shareCents) {
      // Too many cards declined: never charge anyone more than double their share automatically.
      coverInfo = { skipped: 'too_many', shortfallCents: shortfall };
    } else {
      roundKey = sha(uncovered.map((p) => p.share.id).sort().join(',')).slice(0, 12);
      const coverCharge = withFee(coverShare);
      const results = [];
      await inBatches(coverers, 5, async (person) => {
        const done = (person.intents || []).find((pi) => metaOf(pi).type === 'funeral_share_cover' && metaOf(pi).round === roundKey && isThisCase(pi));
        if (done && (done.status === 'succeeded' || done.status === 'processing')) {
          results.push({ uid: person.uid, status: 'charged', already: true, amountCents: done.amount, reason: '' });
          return;
        }
        try {
          const intent = await stripe(mode, 'POST', '/payment_intents', {
            amount: coverCharge,
            currency: 'usd',
            customer: person.customer.id,
            payment_method: person.pmId,
            payment_method_types: ['card'],
            off_session: 'true',
            confirm: 'true',
            description: `Funeral share cover - ${caseName}`,
            receipt_email: person.customer.email || undefined,
            metadata: {
              type: 'funeral_share_cover',
              caseId,
              caseName,
              coverShareCents: String(coverShare),
              feeCents: String(coverCharge - coverShare),
              covers: String(uncovered.length),
              round: roundKey,
              firebaseUID: person.uid,
              source: 'ummahfuneral.org admin'
            }
          }, `${caseId}-cover-${roundKey}-${person.uid}`);
          const ok = intent.status === 'succeeded' || intent.status === 'processing';
          results.push({ uid: person.uid, status: ok ? 'charged' : 'failed', already: false, amountCents: coverCharge, reason: ok ? '' : 'The charge did not go through.' });
        } catch (err) {
          if (!err.stripeError) console.error('charge-shares cover:', err.message);
          results.push({ uid: person.uid, status: 'failed', already: false, amountCents: coverCharge, reason: declineReason(err.stripeError) });
        }
      });
      const coverOk = results.filter((r) => r.status === 'charged').length;
      coveredMark = coverOk === coverers.length ? 'yes' : 'partial';
      coverInfo = {
        shortfallCents: shortfall,
        coverShareCents: coverShare,
        coverChargeCents: coverCharge,
        charged: coverOk,
        failed: results.length - coverOk,
        results
      };
    }
  }

  // 3) Record it on each declined share and send the first email.
  const emails = { ready: emailReady(), sent: 0, failed: 0 };
  for (const person of uncovered) {
    const pi = person.share;
    let sent = false;
    if (emails.ready) {
      if (emails.sent + emails.failed > 0) await sleep(600); // Resend allows a couple of emails a second
      const withMark = Object.assign({}, pi, { metadata: Object.assign({}, metaOf(pi), { covered: coveredMark }) });
      const result = await emailAboutShare(mode, withMark, person.customer, 0);
      sent = result.ok;
      if (sent) emails.sent += 1;
      else emails.failed += 1;
    }
    const metadata = { covered: coveredMark, emailsSent: sent ? '1' : '0' };
    if (roundKey) metadata.coverRound = roundKey;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await stripe(mode, 'POST', `/payment_intents/${pi.id}`, { metadata });
        break;
      } catch (err) {
        console.error('charge-shares: could not mark', pi.id, err.message);
      }
    }
  }

  const charged = people.filter((p) => p.status === 'charged');
  const newlyCharged = charged.filter((p) => !p.already);
  return {
    caseId,
    caseName,
    shareCents,
    chargeCents,
    feeCents: chargeCents - shareCents,
    charged: newlyCharged.length,
    already: people.filter((p) => p.already).length,
    allAlready: people.every((p) => p.already),
    failed: people.filter((p) => p.status === 'failed' || p.status === 'error').length,
    fromCredit: people.filter((p) => p.status === 'credit' && !p.already).length,
    collectedCents: sum(newlyCharged.map((p) => p.amountCents)),
    results: people.map(shareResult),
    cover: coverInfo,
    emails
  };
}

// ---- reminders ---------------------------------------------------------

// Which email is due for a share declined `age` seconds ago (0 to 4).
function dueStep(age) {
  let step = 0;
  REMINDER_HOURS.forEach((h, i) => { if (age >= h * HOUR) step = i; });
  return step;
}

async function runReminders(mode) {
  const summary = { mode, checked: 0, sent: 0, failed: 0, ready: emailReady() };
  if (!summary.ready || !modeReady(mode)) return summary;
  const now = nowSeconds();
  const since = now - (Math.max(...REMINDER_HOURS) + 8) * HOUR;
  for (const status of ['requires_payment_method', 'requires_action']) {
    const found = await searchIntents(mode, `metadata["type"]:"funeral_share" AND status:"${status}" AND created>${since}`, ['data.customer']);
    for (const pi of found) {
      if (!isOwedShare(pi)) continue; // paid since (search can be a minute behind)
      summary.checked += 1;
      const age = now - pi.created;
      if (age < 5 * 60) continue; // the charge itself sends the first email
      const step = dueStep(age);
      const sentSoFar = cents(metaOf(pi).emailsSent);
      if (sentSoFar > step || sentSoFar >= REMINDER_HOURS.length) continue;
      const customer = pi.customer && typeof pi.customer === 'object' ? pi.customer : null;
      const result = await emailAboutShare(mode, pi, customer, step);
      if (result.ok) {
        summary.sent += 1;
        try {
          await stripe(mode, 'POST', `/payment_intents/${pi.id}`, { metadata: { emailsSent: String(step + 1) } });
        } catch (err) {
          console.error('reminders: could not record the email on', pi.id, err.message);
        }
      } else {
        summary.failed += 1;
      }
      await sleep(600); // Resend allows a couple of emails a second
    }
  }
  return summary;
}

async function scheduledReminders(_mode, req) {
  await requireScheduler(req);
  const runs = [];
  for (const mode of ['live', 'test']) {
    try {
      runs.push(await runReminders(mode));
    } catch (err) {
      console.error(`reminders (${mode}):`, err.message);
      runs.push({ mode, error: true });
    }
  }
  console.log('reminders:', JSON.stringify(runs));
  return { runs };
}

async function adminRunReminders(mode, req) {
  await requireAdmin(req);
  return runReminders(mode);
}

async function adminTestEmail(mode, req) {
  const admin = await requireAdmin(req);
  if (tooMany(`test-email:${admin.uid}`, 5, 10 * 60 * 1000)) throw httpError(429, 'Too many test emails. Please wait a few minutes.');
  if (!emailReady()) throw httpError(503, 'Email is not set up yet: RESEND_API_KEY is missing on the payments server.');
  const paragraphs = [
    'As-salamu alaykum,',
    'This is a test email from the UUFFUNDS payments server. If you can read it, payment reminder emails are working.',
    'UUFFUNDS · United Ummah Funeral Funds'
  ];
  const result = await sendEmail({
    to: ADMIN_EMAIL,
    subject: 'UUFFUNDS test email',
    text: `${paragraphs.join('\n\n')}\n`,
    html: emailHtml(paragraphs, null),
    key: `test-${Date.now()}`
  });
  if (!result.ok) {
    throw httpError(502, `Resend did not send it${result.error ? `: ${result.error}` : ''}. Check that ummahfuneral.org shows as Verified in Resend.`);
  }
  return { sentTo: ADMIN_EMAIL };
}

// Unpaid shares (last 30 days) and late payments, for the admin page.
async function adminOwed(mode, req) {
  await requireAdmin(req);
  const now = nowSeconds();
  const since = now - SHOW_OWED_SECONDS;
  const owed = [];
  for (const status of ['requires_payment_method', 'requires_action']) {
    const found = await searchIntents(mode, `metadata["type"]:"funeral_share" AND status:"${status}" AND created>${since}`);
    for (const pi of found) {
      if (!isOwedShare(pi)) continue;
      const m = metaOf(pi);
      const sent = Math.min(cents(m.emailsSent), REMINDER_HOURS.length);
      const next = sent < REMINDER_HOURS.length ? pi.created + REMINDER_HOURS[sent] * HOUR : null;
      owed.push(Object.assign(owedView(pi, now), {
        uid: m.firebaseUID || '',
        emailsSent: sent,
        nextEmailAt: next,
        reason: declineReason(pi.last_payment_error)
      }));
    }
  }
  const paid = (await searchIntents(mode, `metadata["type"]:"funeral_share" AND metadata["latePaid"]:"yes" AND created>${since}`))
    .filter((pi) => pi.status === 'succeeded' || pi.status === 'processing')
    .map((pi) => ({ id: pi.id, uid: metaOf(pi).firebaseUID || '', caseName: metaOf(pi).caseName || '', amountCents: pi.amount, created: pi.created, covered: metaOf(pi).covered === 'yes' }));
  owed.sort((a, b) => b.created - a.created);
  paid.sort((a, b) => b.created - a.created);
  return { emailReady: emailReady(), owed, paid };
}

const ROUTES = {
  'POST /donate': startDonation,
  'POST /card': startCardStep,
  'POST /card/done': finishCardStep,
  'GET /card': cardStatus,
  'POST /share/pay': startSharePayment,
  'POST /share/done': finishSharePayment,
  'GET /admin/cards': adminCards,
  'POST /admin/charge-shares': chargeShares,
  'GET /admin/owed': adminOwed,
  'POST /admin/test-email': adminTestEmail,
  'POST /admin/run-reminders': adminRunReminders,
  'POST /tasks/reminders': scheduledReminders
};
// Routes that work for both payment modes at once.
const NO_MODE = new Set(['POST /tasks/reminders']);

async function handler(req, res) {
  const origin = (req.get && req.get('origin')) || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Max-Age', '3600');
  }
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }
  res.set('Cache-Control', 'no-store');
  const path = String(req.path || '/').replace(/\/+$/, '') || '/';
  const name = `${req.method} ${path}`;
  const route = ROUTES[name];
  if (!route) {
    res.status(404).json({ error: 'Not found.' });
    return;
  }
  try {
    const mode = NO_MODE.has(name) ? null : modeOf(req);
    res.status(200).json(await route(mode, req));
  } catch (err) {
    const status = err.status || 500;
    if (!err.expose) console.error(`${req.method} ${path}:`, err.message);
    res.status(status).json({ error: err.expose ? err.message : 'Something went wrong on our side. Please try again.' });
  }
}

exports.stripeApi = handler;
// For tests.
exports._internals = { withFee, creditFrom, creditToUse, dueStep, shareEmail, caseIdFor, memberReason };
try {
  // Registers the function when running on Google Cloud.
  require('@google-cloud/functions-framework').http('stripeApi', handler);
} catch (_) {
  // Not installed (for example in local tests); exports.stripeApi still works.
}
