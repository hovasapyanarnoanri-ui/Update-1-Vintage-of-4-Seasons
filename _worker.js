// Cloudflare Pages worker for Vintage of 4 Seasons
// /api/checkout and /api/stripe-webhook

const checkoutHandler = (() => {
const CATALOG = {
  "Handcrafted Winter Angel": {"p":67.99},
  "Vintage Carousel Horse Drum Ornament": {"p":59.99},
  "Gold Leaf Teardrop Ornament": {"p":47.99},
  "Antique Carriage Ornament": {"p":99.99},
  "Guitar Ornament": {"p":63.99},
  "Chandelier Ornament": {"p":91.99},
  "High Heel Ornament": {"p":49.95},
  "Medallion Ornament": {"p":64.95},
  "Large Medallion Ornament": {"p":107.99},
  "Mother Mary Ornament": {"p":63.99},
  "Doves & Crown Ornament": {"p":63.99},
  "Throne Ornament": {"p":59.99},
  "Peacock Ornament": {"p":99.95},
  "Ornament Gift Box": {"box":true},
  "Jeweled Bow Ornament": {"p":67.99},
  "Praying Mary Ornament": {"p":63.99},
  "Angel Ornament": {"p":67.99},
  "Sapphire Cameo Ornament": {"p":67.99},
  "Angel of Eternal Love Ornament": {"p":64.95},
  "Ballet Slippers Ornament": {"p":67.99},
  "Ballerina Ornament": {"p":67.99},
  "Masquerade Mask Ornament": {"p":67.99},
  "Horse Head Ornament": {"p":67.99},
  "Carousel Horse Medallion": {"p":59.99},
  "Jeweled Filigree Ornament": {"p":67.99},
  "Jeweled Pearl Ornament": {"p":67.99},
  "Rose Cameo Ornament": {"p":67.99},
  "Framed Ballerina Ornament": {"p":67.99},
  "Crystal Teardrop Ornament": {"p":59.99},
};

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function priceFor(name, variant) {
  if (!has(CATALOG, name)) return null;
  const item = CATALOG[name];
  if (item.sizes) {
    const size = String(variant).split(' · ').pop();
    return has(item.sizes, size) ? item.sizes[size] : null;
  }
  return item.p;
}

// Base $5 for first item, +$1 per extra item/line.
// Zone fee: $0.60 × steps the ZIP first digit is from 9 (West Coast).
function shippingCost(lineCount, zip) {
  if (!lineCount) return 0;
  const base = 5, perExtra = 1, extra = (lineCount - 1) * perExtra;
  const digit = zip && /^\d/.test(String(zip)) ? Number(String(zip)[0]) : null;
  let zoneFee = 0;
  if (digit !== null) {
    zoneFee = Math.round(Math.abs(9 - digit) * 0.6 * 10) / 10;
  }
  return Math.round((base + extra + zoneFee) * 100) / 100;
}

const clean = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : '');

const BOX_FEE_CENTS = 0, BOX_FREE_AT = 3, BOX_MAX_ITEMS = 12, BOX_MAX_LINES = 8;
function boxQuote(items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > BOX_MAX_LINES) return null;
  let cents = BOX_FEE_CENTS, count = 0;
  const parts = [];
  for (const it of items) {
    const [n, c, q] = Array.isArray(it) ? it : [];
    const quantity = Number(q);
    if (typeof n !== 'string' || !has(CATALOG, n) || CATALOG[n].box || typeof CATALOG[n].p !== 'number') return null;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > BOX_MAX_ITEMS) return null;
    count += quantity;
    if (count > BOX_MAX_ITEMS) return null;
    cents += Math.round(CATALOG[n].p * 100) * quantity;
    parts.push(quantity + 'x ' + n.replace(/ Ornament$/, '') + ' (' + clean(typeof c === 'string' ? c : '', 20) + ')');
  }
  return { cents, count, free: count >= BOX_FREE_AT, contents: parts.join(', ') };
}
const say = (message, status) =>
  new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== 'GET' && request.method !== 'POST') return say('Method not allowed', 405);
  if (!env.STRIPE_SECRET_KEY) return say('Server misconfiguration: STRIPE_SECRET_KEY is missing.', 500);
  const siteUrl = env.SITE_URL;
  if (!siteUrl || !/^https?:\/\//.test(siteUrl)) {
    return say('Server misconfiguration: SITE_URL is missing or must start with https://', 500);
  }

  let q;
  if (request.method === 'GET') {
    const p = new URL(request.url).searchParams;
    q = { cart: p.get('cart'), zip: p.get('zip'), email: p.get('email'), name: p.get('name'), phone: p.get('phone'), addr: p.get('addr') };
  } else {
    try { q = await request.json(); } catch (e) { return say('Invalid request body.', 400); }
    if (!q || typeof q !== 'object') return say('Invalid request body.', 400);
  }

  let cart;
  try { cart = typeof q.cart === 'string' ? JSON.parse(q.cart) : q.cart; } catch (e) { cart = null; }
  if (!Array.isArray(cart) || cart.length < 1 || cart.length > 30) {
    return say('Your cart looks empty. Please go back and try again.', 400);
  }

  const rows = cart.map((r) => (r && typeof r === 'object' && !Array.isArray(r) ? [r.name, r.color, r.qty, r.items] : r));

  const form = new URLSearchParams();
  form.append('mode', 'payment');
  let n = 0;
  for (const row of rows) {
    const [name, variant, qty, boxItems] = Array.isArray(row) ? row : [];
    const quantity = Number(qty);
    let unitCents, label;
    if (typeof name === 'string' && has(CATALOG, name) && CATALOG[name].box) {
      const box = boxQuote(boxItems);
      if (box === null) return say('Your gift box could not be read. Please go back and rebuild it.', 400);
      unitCents = box.cents;
      label = clean(name, 60) + ' — ' + clean(String(variant), 30) + ' — contains ' + box.contents + (box.free ? ' + FREE separate gift box' : '');
      label = label.length > 250 ? label.slice(0, 247) + '...' : label;
    } else {
      const price = typeof name === 'string' ? priceFor(name, variant) : null;
      if (typeof price !== 'number') return say('One of the items in your cart could not be found. Please go back and try again.', 400);
      unitCents = Math.round(price * 100);
      label = clean(name, 100) + ' — ' + clean(String(variant), 60);
    }
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50) {
      return say('One of the items in your cart could not be found. Please go back and try again.', 400);
    }
    form.append(`line_items[${n}][price_data][currency]`, 'usd');
    form.append(`line_items[${n}][price_data][product_data][name]`, label);
    form.append(`line_items[${n}][price_data][unit_amount]`, String(unitCents));
    form.append(`line_items[${n}][quantity]`, String(quantity));
    n++;
  }

  const zip = /^\d{5}$/.test(clean(q.zip, 5)) ? clean(q.zip, 5) : '';
  const ship = shippingCost(cart.length, zip);
  form.append(`line_items[${n}][price_data][currency]`, 'usd');
  form.append(`line_items[${n}][price_data][product_data][name]`, 'Shipping (estimate)');
  form.append(`line_items[${n}][price_data][unit_amount]`, String(Math.round(ship * 100)));
  form.append(`line_items[${n}][quantity]`, '1');

  const email = clean(q.email, 200);
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) form.append('customer_email', email);
  form.append('shipping_address_collection[allowed_countries][0]', 'US');
  form.append('phone_number_collection[enabled]', 'true');
  form.append('metadata[name]', clean(q.name, 200));
  form.append('metadata[phone]', clean(q.phone, 40));
  form.append('metadata[address]', clean(q.addr, 300));
  form.append('metadata[zip]', zip);
  form.append('success_url', siteUrl + (siteUrl.includes('?') ? '&' : '?') + 'paid=1');
  form.append('cancel_url', siteUrl);

  let data = {};
  let ok = false;
  try {
    const resp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    data = await resp.json().catch(() => ({}));
    ok = resp.ok && !!data.url;
    if (!ok) console.error('Stripe error', resp.status, data && data.error && data.error.message);
  } catch (e) {
    console.error('Could not reach Stripe', e && e.message);
  }
  if (!ok) return say('Something went wrong starting checkout. Please go back and try again.', 500);

  if (request.method === 'POST') {
    return new Response(JSON.stringify({ url: data.url }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return new Response(null, { status: 303, headers: { Location: data.url } });
}

  return onRequest;
})();

const webhookHandler = (() => {
const say = (message, status) =>
  new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

const money = (cents) => '$' + (Number(cents || 0) / 100).toFixed(2);

const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
}

function sameText(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function isFromStripe(rawBody, header, secret, nowSeconds = Date.now() / 1000) {
  if (!header) return false;
  let timestamp = '';
  const signatures = [];
  for (const piece of header.split(',')) {
    const [k, v] = piece.split('=');
    if (k === 't') timestamp = v;
    if (k === 'v1' && v) signatures.push(v);
  }
  if (!timestamp || signatures.length === 0) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > 300) return false;
  const expected = await hmacHex(secret, timestamp + '.' + rawBody);
  return signatures.some((s) => sameText(s, expected));
}

function buildEmail(session) {
  const customer = session.customer_details || {};
  const collected = (session.collected_information && session.collected_information.shipping_details) || session.shipping_details || {};
  const a = collected.address || customer.address || {};
  const shipTo = [
    collected.name || customer.name,
    a.line1,
    a.line2,
    [a.city, a.state, a.postal_code].filter(Boolean).join(' '),
    a.country,
  ].filter(Boolean).join('\n');
  const lines = ((session.line_items && session.line_items.data) || [])
    .map((li) => '- ' + li.quantity + ' x ' + li.description + '   ' + money(li.amount_total))
    .join('\n');
  const meta = session.metadata || {};
  const who = customer.name || meta.name || 'customer';
  const payment = session.payment_intent
    ? 'https://dashboard.stripe.com/payments/' + session.payment_intent
    : 'https://dashboard.stripe.com/payments';
  const text = [
    'NEW PAID ORDER',
    '',
    'Customer: ' + who,
    'Email: ' + (customer.email || '(none)'),
    'Phone: ' + (customer.phone || meta.phone || '(none)'),
    '',
    'SHIP TO',
    shipTo || '(no address collected)',
    '',
    'ITEMS',
    lines || '(could not read items - check Stripe)',
    '',
    'TOTAL PAID: ' + money(session.amount_total),
    '',
    meta.address ? 'Address typed on the website: ' + meta.address : '',
    'See it in Stripe: ' + payment,
  ].filter((l, i, all) => !(l === '' && all[i - 1] === '')).join('\n');
  return { subject: 'New order ' + money(session.amount_total) + ' - ' + who, text };
}

async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') return say('Method not allowed', 405);
  for (const name of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'RESEND_API_KEY', 'ORDER_EMAIL']) {
    if (!env[name]) return say('Server misconfiguration: ' + name + ' is missing.', 500);
  }

  const raw = await request.text();
  if (!(await isFromStripe(raw, request.headers.get('Stripe-Signature'), env.STRIPE_WEBHOOK_SECRET))) {
    return say('Bad signature', 400);
  }
  let event;
  try { event = JSON.parse(raw); } catch (e) { return say('Bad body', 400); }

  if (event.type !== 'checkout.session.completed') return say('Ignored', 200);
  const done = event.data && event.data.object;
  if (!done || !done.id) return say('No session', 400);
  if (done.payment_status !== 'paid') return say('Not paid yet', 200);

  const got = await fetch('https://api.stripe.com/v1/checkout/sessions/' + encodeURIComponent(done.id) + '?expand%5B%5D=line_items', {
    headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY },
  }).catch(() => null);
  if (!got || !got.ok) { console.error('Could not read the order from Stripe'); return say('Could not read order', 500); }
  const session = await got.json();

  const { subject, text } = buildEmail(session);
  const sent = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.ORDER_FROM || 'Vintage of 4 Seasons <onboarding@resend.dev>',
      to: [env.ORDER_EMAIL],
      subject,
      text,
    }),
  }).catch(() => null);
  if (!sent || !sent.ok) { console.error('Order email failed'); return say('Email failed', 500); }
  return say('ok', 200);
}

  return onRequest;
})();

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/checkout') return checkoutHandler({ request, env });
    if (pathname === '/api/stripe-webhook') return webhookHandler({ request, env });
    return env.ASSETS.fetch(request);
  },
};
