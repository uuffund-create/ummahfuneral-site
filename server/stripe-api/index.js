// UUFFUNDS payments server
// ------------------------------------------------------------------
// The one small piece that has to run on a server, because it uses the
// Stripe SECRET key. It runs on Google Cloud (Cloud Run functions) inside
// the Firebase project "united-ummah-funeral-funds".
//
// What it does
//   POST /donate      anyone       starts a donation and returns its client secret
//   POST /card        contributor  starts the card step: the first time it is a
//                                  $10 Sadaqah donation that also checks the card
//                                  and saves it; after that it saves a new card with
//                                  no charge
//   POST /card/done   contributor  after Stripe confirms: makes it the main card
//   GET  /card        contributor  which card is saved (brand + last 4 digits)
//   GET  /admin/cards admin only   saved card for every contributor, by login id
//   POST /admin/charge-shares      admin only: charges a funeral's equal share (plus
//                                  Stripe's fee) to every listed contributor's saved card
//
// Card numbers never reach this server. The browser sends them straight to
// Stripe, and Stripe gives us back only the brand and the last 4 digits.
//
// Secrets (stored in Google Secret Manager, given to this server as settings):
//   STRIPE_SECRET_KEY_LIVE   sk_live_... or rk_live_...
//   STRIPE_SECRET_KEY_TEST   sk_test_... or rk_test_...
// Every request says which one to use with ?mode=live or ?mode=test.

const crypto = require('node:crypto');

const PROJECT_ID = 'united-ummah-funeral-funds';
const ADMIN_EMAIL = 'uuffund@gmail.com';
const JOIN_DONATION_CENTS = 1000; // $10 Sadaqah when a contributor first adds a card
const DONATION_MIN_CENTS = 100; // $1
const DONATION_MAX_CENTS = 1000000; // $10,000
const ALLOWED_ORIGINS = ['https://ummahfuneral.org', 'https://www.ummahfuneral.org'];
// Stripe's US card price (2.9% + 30c). Each funeral share includes it, so the
// fund receives the full share. Whole cents only, rounded up.
const FEE_FIXED_CENTS = 30;
const FEE_KEEP_PER_THOUSAND = 971; // 1000 - 29 (2.9%)
const withFee = (shareCents) => Math.ceil(((shareCents + FEE_FIXED_CENTS) * 1000) / FEE_KEEP_PER_THOUSAND);
const MAX_SHARE_CENTS = 500000; // $5,000 per person, as a safety limit

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

function secretKey(mode) {
  const key = String((mode === 'live' ? process.env.STRIPE_SECRET_KEY_LIVE : process.env.STRIPE_SECRET_KEY_TEST) || '').trim();
  const looksRight = mode === 'live' ? /^(sk|rk)_live_/.test(key) : /^(sk|rk)_test_/.test(key);
  if (!looksRight) {
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

// ---- Firebase log-in check (Firebase ID token, RS256) -----------------

const CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
let certCache = { certs: null, expires: 0 };

async function googleCerts(force) {
  if (!force && certCache.certs && Date.now() < certCache.expires) return certCache.certs;
  const res = await fetch(CERTS_URL);
  if (!res.ok) throw httpError(503, 'Could not check your log-in. Please try again.');
  const certs = await res.json();
  const maxAge = /max-age=(\d+)/.exec(res.headers.get('cache-control') || '');
  certCache = { certs, expires: Date.now() + (maxAge ? Number(maxAge[1]) : 3600) * 1000 };
  return certs;
}

const fromB64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

async function verifyIdToken(token) {
  const bad = () => httpError(401, 'Please log in again.');
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
  let certs = await googleCerts(false);
  if (!certs[header.kid]) certs = await googleCerts(true);
  const pem = certs[header.kid];
  if (!pem) throw bad();
  const publicKey = new crypto.X509Certificate(pem).publicKey;
  const signedPart = Buffer.from(`${parts[0]}.${parts[1]}`);
  if (!crypto.verify('RSA-SHA256', signedPart, publicKey, fromB64url(parts[2]))) throw bad();

  const now = Math.floor(Date.now() / 1000);
  const skew = 300;
  if (claims.aud !== PROJECT_ID) throw bad();
  if (claims.iss !== `https://securetoken.google.com/${PROJECT_ID}`) throw bad();
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 128) throw bad();
  if (!(typeof claims.exp === 'number' && claims.exp > now)) throw bad();
  if (!(typeof claims.iat === 'number' && claims.iat <= now + skew)) throw bad();
  if (claims.auth_time !== undefined && !(claims.auth_time <= now + skew)) throw bad();
  return {
    uid: claims.sub,
    email: String(claims.email || '').toLowerCase(),
    emailVerified: claims.email_verified === true
  };
}

async function requireUser(req) {
  const auth = String((req.get && req.get('authorization')) || '');
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  if (!match) throw httpError(401, 'Please log in first.');
  const user = await verifyIdToken(match[1].trim());
  if (!user.email) throw httpError(401, 'Please log in again.');
  return user;
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

async function joinDonationPaid(mode, customer) {
  if (customer.metadata && customer.metadata.joinDonationPaid === 'true') return true;
  const intents = await stripe(mode, 'GET', '/payment_intents', { customer: customer.id, limit: 20 });
  const paid = intents.data.some((pi) => pi.status === 'succeeded' && pi.metadata && pi.metadata.type === 'joining_donation');
  if (paid) await stripe(mode, 'POST', `/customers/${customer.id}`, { metadata: { joinDonationPaid: 'true' } });
  return paid;
}

// ---- routes ------------------------------------------------------------

async function startDonation(mode, req) {
  if (tooMany(`donate:${clientIp(req)}`, 10, 10 * 60 * 1000)) {
    throw httpError(429, 'Too many tries. Please wait a few minutes and try again.');
  }
  const body = req.body || {};
  const cents = Math.round(Number(body.amount) * 100);
  if (!Number.isFinite(cents) || cents < DONATION_MIN_CENTS || cents > DONATION_MAX_CENTS) {
    throw httpError(400, 'Please enter an amount between $1 and $10,000.');
  }
  const destination = Object.prototype.hasOwnProperty.call(DESTINATIONS, body.destination) ? body.destination : 'funeral';
  const anonymous = body.anonymous === true;
  const name = anonymous ? '' : cleanText(body.name, 100);
  const email = cleanEmail(body.email);
  if (!email) throw httpError(400, 'Please enter a valid email address for your receipt.');

  const intent = await stripe(mode, 'POST', '/payment_intents', {
    amount: cents,
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

async function startCardStep(mode, req) {
  const user = await requireUser(req);
  if (tooMany(`card:${user.uid}`, 10, 10 * 60 * 1000)) {
    throw httpError(429, 'Too many tries. Please wait a few minutes and try again.');
  }
  const body = req.body || {};
  const name = cleanText(body.name, 100);
  const customer = await findOrCreateCustomer(mode, user, name);
  const metadata = { firebaseUID: user.uid, source: 'ummahfuneral.org' };

  // Saving a new card with no charge is only for people who already gave
  // the joining donation.
  if (body.want === 'setup' && (await joinDonationPaid(mode, customer))) {
    const setup = await stripe(mode, 'POST', '/setup_intents', {
      customer: customer.id,
      usage: 'off_session',
      payment_method_types: ['card'],
      metadata: Object.assign({ type: 'card_update' }, metadata)
    });
    return { kind: 'setup', clientSecret: setup.client_secret };
  }
  if (body.want === 'setup') throw httpError(409, 'The joining donation is needed first.');

  const intent = await stripe(mode, 'POST', '/payment_intents', {
    amount: JOIN_DONATION_CENTS,
    currency: 'usd',
    customer: customer.id,
    setup_future_usage: 'off_session',
    payment_method_types: ['card'],
    description: 'Sadaqah donation - joining',
    receipt_email: user.email,
    metadata: Object.assign({ type: 'joining_donation' }, metadata)
  });
  return { kind: 'payment', amount: JOIN_DONATION_CENTS, clientSecret: intent.client_secret };
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

async function cardStatus(mode, req) {
  const user = await requireUser(req);
  const customer = await findCustomer(mode, user, true);
  if (!customer) return { card: null, joinPaid: false };
  const card = await ensureDefaultCard(mode, customer);
  const joinPaid = await joinDonationPaid(mode, customer);
  return { card, joinPaid };
}

async function requireAdmin(req) {
  const user = await requireUser(req);
  if (user.email !== ADMIN_EMAIL || !user.emailVerified) throw httpError(403, 'For the fund administrator only.');
  return user;
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
  for (const [uid, entry] of Object.entries(byUid)) cards[uid] = { card: entry.card, joinPaid: entry.joinPaid };
  return { cards };
}

function declineReason(err) {
  const e = (err && err.stripeError) || {};
  const code = e.decline_code || e.code || '';
  if (code === 'authentication_required') return 'Their bank wants them to approve it. Ask them to pay on the website.';
  if (code === 'insufficient_funds') return 'Not enough money on the card.';
  if (code === 'expired_card') return 'The card has expired.';
  if (code === 'card_declined' || code === 'generic_decline' || code === 'do_not_honor') return 'The card was declined.';
  return e.message || 'The charge did not go through.';
}

// Charge one funeral's equal share to every listed contributor's saved card.
// The admin page sends the Active contributors and the per-person amount it
// showed in the preview; the server works the amount out again and refuses
// if they differ, so nobody is charged a number the admin did not see.
async function chargeShares(mode, req) {
  await requireAdmin(req);
  const body = req.body || {};
  const caseName = cleanText(body.caseName, 60);
  const caseId = String(body.caseId || '');
  const totalCents = Number(body.totalCents);
  const donationCents = Number(body.donationCents || 0);
  const uids = Array.isArray(body.uids) ? [...new Set(body.uids.map(String))] : [];
  if (!caseName) throw httpError(400, 'Please name the funeral (for example, Funeral of [name]).');
  if (!/^case_[A-Za-z0-9_-]{6,60}$/.test(caseId)) throw httpError(400, 'Missing case id.');
  if (!Number.isInteger(totalCents) || totalCents < 100) throw httpError(400, 'Please enter the total funeral cost.');
  if (!Number.isInteger(donationCents) || donationCents < 0) throw httpError(400, 'Donations to apply must be $0 or more.');
  if (donationCents >= totalCents) throw httpError(400, 'Donations already cover this cost, so nobody needs to be charged.');
  if (!uids.length || uids.length > 2000) throw httpError(400, 'No contributors to charge.');

  const byUid = await contributorCards(mode);
  const eligible = uids.filter((uid) => byUid[uid] && byUid[uid].card && byUid[uid].pmId);
  if (!eligible.length) throw httpError(400, 'None of these contributors has a saved card.');
  const shareCents = Math.ceil((totalCents - donationCents) / eligible.length);
  const chargeCents = withFee(shareCents);
  if (chargeCents > MAX_SHARE_CENTS) throw httpError(400, 'Each share would be over $5,000. Please check the amount.');
  if (Number(body.expectedChargeCents) !== chargeCents || Number(body.expectedCount) !== eligible.length) {
    const err = httpError(409, 'The numbers changed since your preview (someone added or removed a card). Please preview again.');
    throw err;
  }

  const results = [];
  const chargeOne = async (uid) => {
    const { customer, pmId } = byUid[uid];
    try {
      const intent = await stripe(mode, 'POST', '/payment_intents', {
        amount: chargeCents,
        currency: 'usd',
        customer: customer.id,
        payment_method: pmId,
        payment_method_types: ['card'],
        off_session: 'true',
        confirm: 'true',
        description: `Funeral equal share - ${caseName}`,
        receipt_email: customer.email || undefined,
        metadata: {
          type: 'funeral_share',
          caseId,
          caseName,
          shareCents: String(shareCents),
          feeCents: String(chargeCents - shareCents),
          firebaseUID: uid,
          source: 'ummahfuneral.org admin'
        }
      }, `${caseId}-${uid}`);
      const ok = intent.status === 'succeeded' || intent.status === 'processing';
      results.push({ uid, status: ok ? 'charged' : 'failed', amountCents: chargeCents, reason: ok ? '' : 'The charge did not go through.' });
    } catch (err) {
      if (!err.stripeError) console.error('charge-shares:', err.message);
      results.push({ uid, status: 'failed', amountCents: chargeCents, reason: declineReason(err) });
    }
  };
  for (let i = 0; i < eligible.length; i += 5) {
    await Promise.all(eligible.slice(i, i + 5).map(chargeOne));
  }
  const charged = results.filter((r) => r.status === 'charged');
  return {
    caseId,
    shareCents,
    chargeCents,
    feeCents: chargeCents - shareCents,
    charged: charged.length,
    failed: results.length - charged.length,
    collectedCents: charged.length * chargeCents,
    results
  };
}

const ROUTES = {
  'POST /donate': startDonation,
  'POST /card': startCardStep,
  'POST /card/done': finishCardStep,
  'GET /card': cardStatus,
  'GET /admin/cards': adminCards,
  'POST /admin/charge-shares': chargeShares
};

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
  const route = ROUTES[`${req.method} ${path}`];
  if (!route) {
    res.status(404).json({ error: 'Not found.' });
    return;
  }
  try {
    const mode = modeOf(req);
    res.status(200).json(await route(mode, req));
  } catch (err) {
    const status = err.status || 500;
    if (!err.expose) console.error(`${req.method} ${path}:`, err.message);
    res.status(status).json({ error: err.expose ? err.message : 'Something went wrong on our side. Please try again.' });
  }
}

exports.stripeApi = handler;
try {
  // Registers the function when running on Google Cloud.
  require('@google-cloud/functions-framework').http('stripeApi', handler);
} catch (_) {
  // Not installed (for example in local tests); exports.stripeApi still works.
}
