// _worker.js  -  ONE file that does everything, for Cloudflare Pages "drag and drop" uploads.
//   /api/checkout        creates the Stripe payment page (holds the real prices)
//   /api/stripe-webhook  emails each paid order (optional; needs the extra settings in the README)
//   everything else      is served from the website files next to this file
// (The separate functions/ folder isn't supported by drag and drop, so both are combined here.)

const checkoutHandler = (() => {
// functions/api/checkout.js  —  Cloudflare Pages Function for Vintage of 4 Seasons
// It answers at the web address  /api/checkout
//
// The website sends the CART (product names, colors/sizes, quantities) — NEVER prices.
// This file looks up the real prices below, so a customer can't change what they pay,
// then asks Stripe for a hosted checkout page and sends the customer there.
// No extra libraries needed: it talks to Stripe's web API directly.
//
// Settings (Cloudflare dashboard > your Pages project > Settings > Variables and secrets):
//   STRIPE_SECRET_KEY  your Stripe secret key (starts with sk_test_ or sk_live_)  <- make it a Secret
//   SITE_URL           your real site address, starting with https://

// ---------------------------------------------------------------
// PRICE LIST (US dollars). When Luso changes a price, change it here AND on the website.
// ---------------------------------------------------------------
const CATALOG = {
  "Handcrafted Winter Angel": {"p":67},
  "Vintage Carousel Horse Drum Ornament": {"p":59},
  "Gold Leaf Teardrop Ornament": {"p":47},
  "Antique Carriage Ornament": {"p":99},
  "Guitar Ornament": {"p":63},
  "Chandelier Ornament": {"p":91},
  "High Heel Ornament": {"p":49},
  "Medallion Ornament": {"p":64},
  "Large Medallion Ornament": {"p":107},
  "Mother Mary Ornament": {"p":63},
  "Doves & Crown Ornament": {"p":63},
  "Throne Ornament": {"p":59},
  "Peacock Ornament": {"p":99},
  "Ornament Gift Box": {"box":true},
  "Jeweled Bow Ornament": {"p":67},
  "Praying Mary Ornament": {"p":63},
  "Angel Ornament": {"p":67},
  "Sapphire Cameo Ornament": {"p":67},
  "Angel of Eternal Love Ornament": {"p":64},
  "Ballet Slippers Ornament": {"p":67},
  "Ballerina Ornament": {"p":67},
  "Masquerade Mask Ornament": {"p":67},
  "Horse Head Ornament": {"p":67},
  "Carousel Horse Medallion": {"p":59},
  "Jeweled Filigree Ornament": {"p":67},
  "Jeweled Pearl Ornament": {"p":67},
  "Rose Cameo Ornament": {"p":67},
  "Framed Ballerina Ornament": {"p":67},
  "Crystal Teardrop Ornament": {"p":59},
};

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// Price for a product + variant. Variants look like "Red" or "Cream · Large";
// for products with sizes, the text after the last " · " picks the price.
function priceFor(name, variant) {
  if (!has(CATALOG, name)) return null;
  const item = CATALOG[name];
  if (item.sizes) {
    const size = String(variant).split(' · ').pop();
    return has(item.sizes, size) ? item.sizes[size] : null;
  }
  return item.p;
}

// Shipping is free on every order (kept as a function so it is easy to change later).
function shippingCost(lineCount, zip) {
  return 0; // free shipping on every order
}

const clean = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : '');

// Gift Box: the price is the ornaments chosen inside it (box included). 3 or more ornaments = a free separate gift box.
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

  // Read the details (address bar for GET, JSON body for POST)
  let q;
  if (request.method === 'GET') {
    const p = new URL(request.url).searchParams;
    q = { cart: p.get('cart'), zip: p.get('zip'), email: p.get('email'), name: p.get('name'), phone: p.get('phone'), addr: p.get('addr'), gift: p.get('gift') };
  } else {
    try { q = await request.json(); } catch (e) { return say('Invalid request body.', 400); }
    if (!q || typeof q !== 'object') return say('Invalid request body.', 400);
  }

  let cart;
  try { cart = typeof q.cart === 'string' ? JSON.parse(q.cart) : q.cart; } catch (e) { cart = null; }
  if (!Array.isArray(cart) || cart.length < 1 || cart.length > 30) {
    return say('Your cart looks empty. Please go back and try again.', 400);
  }

  // The website sends each line as {priceId, name, color, qty, items?}. The Stripe price ID rides along,
  // but the price actually charged always comes from CATALOG above (never from the browser).
  const rows = cart.map((r) => (r && typeof r === 'object' && !Array.isArray(r) ? [r.name, r.color, r.qty, r.items] : r));

  // Build the form Stripe expects (every price comes from CATALOG above)
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

  const email = clean(q.email, 200);
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) form.append('customer_email', email);
  // Ships free to most countries worldwide. To limit it, edit this list (or set it to ['US'] for the United States only).
  const SHIP_COUNTRIES = 'AD,AE,AF,AG,AI,AL,AM,AO,AR,AT,AU,AW,AX,AZ,BA,BB,BD,BE,BF,BG,BH,BI,BJ,BL,BM,BN,BO,BQ,BR,BS,BT,BW,BZ,CA,CD,CF,CG,CH,CI,CK,CL,CM,CN,CO,CR,CV,CW,CY,CZ,DE,DJ,DK,DM,DO,DZ,EC,EE,EG,EH,ER,ES,ET,FI,FJ,FK,FO,FR,GA,GB,GD,GE,GF,GG,GH,GI,GL,GM,GN,GP,GQ,GR,GT,GU,GW,GY,HK,HN,HR,HT,HU,ID,IE,IL,IM,IN,IQ,IS,IT,JE,JM,JO,JP,KE,KG,KH,KI,KM,KN,KR,KW,KY,KZ,LA,LB,LC,LI,LK,LR,LS,LT,LU,LV,LY,MA,MC,MD,ME,MF,MG,MK,ML,MM,MN,MO,MQ,MR,MS,MT,MU,MV,MW,MX,MY,MZ,NA,NC,NE,NG,NI,NL,NO,NP,NR,NU,NZ,OM,PA,PE,PF,PG,PH,PK,PL,PM,PN,PR,PS,PT,PY,QA,RE,RO,RS,RW,SA,SB,SC,SE,SG,SH,SI,SJ,SK,SL,SM,SN,SO,SR,SS,ST,SV,SX,SZ,TC,TD,TG,TH,TJ,TK,TL,TM,TN,TO,TR,TT,TV,TW,TZ,UA,UG,US,UY,UZ,VA,VC,VE,VG,VN,VU,WF,WS,XK,YE,YT,ZA,ZM,ZW'.split(',');
  SHIP_COUNTRIES.forEach((c, i) => form.append(`shipping_address_collection[allowed_countries][${i}]`, c));
  form.append('phone_number_collection[enabled]', 'true');
  form.append('metadata[name]', clean(q.name, 200));
  form.append('metadata[phone]', clean(q.phone, 40));
  form.append('metadata[address]', clean(q.addr, 300));
  form.append('metadata[zip]', zip);
  // Optional free gift note: kept with the order so it can be written on a card (line breaks kept, 300 characters max)
  const gift = typeof q.gift === 'string' ? q.gift.replace(/\r/g, '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').replace(/[ \t]+/g, ' ').trim().slice(0, 300) : '';
  if (gift) form.append('metadata[gift_message]', gift);
  form.append('success_url', siteUrl + (siteUrl.includes('?') ? '&' : '?') + 'paid=1');
  form.append('cancel_url', siteUrl);

  // Ask Stripe for the hosted checkout page
  let data = {};
  let ok = false;
  try {
    const callStripe = () => fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    let resp = await callStripe();
    data = await resp.json().catch(() => ({}));
    // Safety net: if Stripe does not accept the country list, fall back to the US only so checkout never breaks.
    if (!resp.ok && /allowed_countries|shipping_address_collection/i.test((data && data.error && (data.error.param || '') + ' ' + (data.error.message || '')) || '')) {
      console.error('Stripe rejected the country list, retrying with US only:', data.error && data.error.message);
      for (const k of [...form.keys()]) if (k.startsWith('shipping_address_collection')) form.delete(k);
      form.append('shipping_address_collection[allowed_countries][0]', 'US');
      resp = await callStripe();
      data = await resp.json().catch(() => ({}));
    }
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
// functions/api/stripe-webhook.js  —  Cloudflare Pages Function
// It answers at the web address  /api/stripe-webhook
//
// What it does: Stripe calls this address after every successful payment.
// We check the call really came from Stripe, then email the order details
// (items, total, customer, shipping address) to the shop's email address.
//
// Settings (Cloudflare dashboard > your Pages project > Settings > Variables and secrets):
//   STRIPE_SECRET_KEY       your Stripe secret key (same one the checkout uses)
//   STRIPE_WEBHOOK_SECRET   the "Signing secret" Stripe shows for this webhook (starts with whsec_)
//   RESEND_API_KEY          your Resend API key (starts with re_)
//   ORDER_EMAIL             where order emails go, for example lisaabrahamian38@gmail.com
//   ORDER_FROM              (optional) the "from" line, once you have a verified domain,
//                           for example  Vintage of 4 Seasons <orders@yourdomain.com>

const say = (message, status) =>
  new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

const money = (cents) => '$' + (Number(cents || 0) / 100).toFixed(2);

// ---- check the call is really from Stripe (signature check, no libraries needed) ----
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
  if (Math.abs(nowSeconds - Number(timestamp)) > 300) return false; // older than 5 minutes: reject
  const expected = await hmacHex(secret, timestamp + '.' + rawBody);
  return signatures.some((s) => sameText(s, expected));
}

// ---- the thank-you email the customer receives (plain text; only sent once ORDER_FROM is set to a verified domain) ----
function buildCustomerEmail(session) {
  const customer = session.customer_details || {};
  const meta = session.metadata || {};
  const collected = (session.collected_information && session.collected_information.shipping_details) || session.shipping_details || {};
  const a = collected.address || customer.address || {};
  const shipTo = [
    collected.name || customer.name,
    a.line1,
    a.line2,
    [a.city, a.state, a.postal_code].filter(Boolean).join(' '),
  ].filter(Boolean).join('\n');
  const first = String(customer.name || meta.name || '').trim().split(/\s+/)[0].replace(/[^\p{L}'\-]/gu, '').slice(0, 40);
  const lines = ((session.line_items && session.line_items.data) || [])
    .map((li) => '- ' + li.quantity + ' x ' + li.description + '   ' + money(li.amount_total))
    .join('\n');
  const text = [
    first ? 'Hi ' + first + ',' : 'Hello,',
    '',
    'Thank you for your order from Vintage of 4 Seasons. Luso is making your ornament by hand, and it will ship in about 3 days (custom and engraved orders take 4 to 5 days).',
    '',
    'YOUR ORDER',
    lines || '(see your Stripe receipt)',
    '',
    'Total paid: ' + money(session.amount_total) + '  (no sales tax)',
    '',
    shipTo ? 'SHIPPING TO\n' + shipTo + '\n' : '',
    meta.gift_message ? 'YOUR GIFT NOTE (we will include it on a card)\n' + meta.gift_message + '\n' : '',
    'Each ornament is handmade and one of a kind, so small natural differences are part of its charm. You have 5 days after it arrives to return it.',
    '',
    'Questions, or need to change something? Just reply to this email.',
    '',
    'With gratitude,',
    'Luso',
    'Vintage of 4 Seasons',
    'vintageof4seasons.com',
  ].filter((l, i, all) => !(l === '' && all[i - 1] === '')).join('\n');
  return { subject: 'Thank you for your order from Vintage of 4 Seasons', text };
}

// ---- write the email (plain text on purpose: nothing a customer typed can run as code) ----
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
    meta.gift_message ? '*** GIFT NOTE - write this on a card and include it ***\n' + meta.gift_message + '\n' : '',
    meta.address ? 'Address typed on the website: ' + meta.address : '',
    'See it in Stripe: ' + payment,
  ].filter((l, i, all) => !(l === '' && all[i - 1] === '')).join('\n');
  return { subject: (meta.gift_message ? '[GIFT NOTE] ' : '') + 'New order ' + money(session.amount_total) + ' - ' + who, text };
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

  // We only care about finished payments; anything else is fine to ignore.
  if (event.type !== 'checkout.session.completed') return say('Ignored', 200);
  const done = event.data && event.data.object;
  if (!done || !done.id) return say('No session', 400);
  if (done.payment_status !== 'paid') return say('Not paid yet', 200);

  // Ask Stripe for the full order (the event itself does not list the items)
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
  // If the email fails we answer 500 so Stripe automatically tries again later.
  if (!sent || !sent.ok) { console.error('Order email failed'); return say('Email failed', 500); }
  // Thank-you email to the customer. Only when a verified sending address is set; a failure here never makes Stripe retry.
  const buyer = session.customer_details && session.customer_details.email;
  if (env.ORDER_FROM && buyer) {
    const mine = buildCustomerEmail(session);
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.ORDER_FROM, to: [buyer], reply_to: env.ORDER_EMAIL, subject: mine.subject, text: mine.text }),
    }).then((r) => { if (!r.ok) console.error('Customer email failed'); }).catch(() => console.error('Customer email failed'));
  }
  return say('ok', 200);
}

  return onRequest;
})();

// ---------------------------------------------------------------
// REAL PRODUCT PAGES: each ornament has its own web address, /ornament/<name>.
// The site file is the same for all of them; this fills in the page title, description,
// share image and Google product data so every ornament can be found on its own.
// ---------------------------------------------------------------
const PAGES = {
 "handcrafted-winter-angel": {
  "n": "Handcrafted Winter Angel",
  "t": "Handcrafted Winter Angel | Vintage of 4 Seasons",
  "m": "Handmade handcrafted winter angel, one of a kind and made to be remembered. Soft-painted wings, ready for engraving. Engraving $1 a letter. Free shipping. No sales tax. Ships in about 3 days.",
  "d": "Soft-painted wings, ready for engraving.",
  "p": 67,
  "box": false,
  "cat": "Character, Religious"
 },
 "vintage-carousel-horse-drum-ornament": {
  "n": "Vintage Carousel Horse Drum Ornament",
  "t": "Vintage Carousel Horse Drum Ornament | Vintage of 4 Seasons",
  "m": "Handmade vintage carousel horse drum ornament, one of a kind and made to be remembered. A nostalgic carousel horse in soft, hand-painted colors. Engraving $1 a letter. Free shipping. No sales tax. Ships in about 3 days.",
  "d": "A nostalgic carousel horse in soft, hand-painted colors.",
  "p": 59,
  "box": false,
  "cat": "Winter"
 },
 "gold-leaf-teardrop-ornament": {
  "n": "Gold Leaf Teardrop Ornament",
  "t": "Gold Leaf Teardrop Ornament | Vintage of 4 Seasons",
  "m": "Handmade gold leaf teardrop ornament, one of a kind and made to be remembered. A smooth teardrop shape finished in antique gold leaf. Engraving $1 a letter. Free shipping. No sales tax. Ships in about 3 days.",
  "d": "A smooth teardrop shape finished in antique gold leaf.",
  "p": 47,
  "box": false,
  "cat": "Vintage"
 },
 "antique-carriage-ornament": {
  "n": "Antique Carriage Ornament",
  "t": "Antique Carriage Ornament | Vintage of 4 Seasons",
  "m": "Handmade antique carriage ornament, one of a kind and made to be remembered. A detailed miniature carriage with an aged-gold finish. Engraving $1 a letter. Free shipping. No sales tax. Ships in about 3 days.",
  "d": "A detailed miniature carriage with an aged-gold finish.",
  "p": 99,
  "box": false,
  "cat": "Limited Edition"
 },
 "guitar-ornament": {
  "n": "Guitar Ornament",
  "t": "Guitar Ornament, Handmade Christmas Ornament | Vintage of 4 Seasons",
  "m": "Handmade guitar ornament, one of a kind and made to be remembered. A miniature guitar with jeweled detailing and a hanging ribbon. Engraving $1 a letter. Free shipping. No sales tax. Ships in about 3 days.",
  "d": "A miniature guitar with jeweled detailing and a hanging ribbon.",
  "p": 63,
  "box": false,
  "cat": "Vintage"
 },
 "chandelier-ornament": {
  "n": "Chandelier Ornament",
  "t": "Chandelier Ornament | Vintage of 4 Seasons",
  "m": "Handmade chandelier ornament, one of a kind and made to be remembered. A tiny crystal chandelier set on a hand-finished cushion base. Engraving $1 a letter. Free shipping. No sales tax. Ships in about 3 days.",
  "d": "A tiny crystal chandelier set on a hand-finished cushion base.",
  "p": 91,
  "box": false,
  "cat": "Vintage"
 },
 "high-heel-ornament": {
  "n": "High Heel Ornament",
  "t": "High Heel Ornament, Handmade Christmas Ornament | Vintage of 4 Seasons",
  "m": "Handmade high heel ornament, one of a kind and made to be remembered. A pair of tiny jeweled high heels, each tied with a satin bow. Sold as. Engraving $1 a letter. Free shipping. No sales tax. Ships in about 3 days.",
  "d": "A pair of tiny jeweled high heels, each tied with a satin bow. Sold as a pair.",
  "p": 49,
  "box": false,
  "cat": "Vintage"
 },
 "medallion-ornament": {
  "n": "Medallion Ornament",
  "t": "Medallion Ornament, Handmade Christmas Ornament | Vintage of 4 Seasons",
  "m": "Handmade medallion ornament, one of a kind and made to be remembered. An opening keepsake medallion with a clock face framed in jewels and p. Engraving $1 a letter. Free shipping. No sales tax. Ships in about 3 days.",
  "d": "An opening keepsake medallion with a clock face framed in jewels and pearls.",
  "p": 64,
  "box": false,
  "cat": "Limited Edition"
 },
 "large-medallion-ornament": {
  "n": "Large Medallion Ornament",
  "t": "Large Medallion Ornament | Vintage of 4 Seasons",
  "m": "Handmade large medallion ornament, one of a kind and made to be remembered. A large opening keepsake medallion with a clock face framed in jewels. Engraving $1 a letter. Free shipping. No sales tax. Ships in about 3 days.",
  "d": "A large opening keepsake medallion with a clock face framed in jewels and pearls. A statement piece for the tree.",
  "p": 107,
  "box": false,
  "cat": "Limited Edition"
 },
 "mother-mary-ornament": {
  "n": "Mother Mary Ornament",
  "t": "Mother Mary Ornament | Vintage of 4 Seasons",
  "m": "Handmade mother mary ornament, one of a kind and made to be remembered. A raised figure of Mother Mary framed in a floral wreath, edged with p. Engraving $1 a letter. Free shipping. No sales tax. Ships in about 3 days.",
  "d": "A raised figure of Mother Mary framed in a floral wreath, edged with pearls. The back of this ornament shows Mother Mary and Baby Jesus.",
  "p": 63,
  "box": false,
  "cat": "Character, Religious"
 },
 "doves-and-crown-ornament": {
  "n": "Doves & Crown Ornament",
  "t": "Doves & Crown Ornament | Vintage of 4 Seasons",
  "m": "Handmade doves & crown ornament, one of a kind and made to be remembered. Two white doves above a crown, edged with pearls. The back of this orn. Engraving $1 a letter. Free shipping. No sales tax. Ships in about 3 days.",
  "d": "Two white doves above a crown, edged with pearls. The back of this ornament is the Cross.",
  "p": 63,
  "box": false,
  "cat": "Winter, Religious"
 },
 "throne-ornament": {
  "n": "Throne Ornament",
  "t": "Throne Ornament, Handmade Christmas Ornament | Vintage of 4 Seasons",
  "m": "Handmade throne ornament, one of a kind and made to be remembered. A miniature Gothic-style throne with jeweled detail and a satin bow. Engraving $1 a letter. Free shipping. No sales tax. Ships in about 3 days.",
  "d": "A miniature Gothic-style throne with jeweled detail and a satin bow.",
  "p": 59,
  "box": false,
  "cat": "Vintage"
 },
 "peacock-ornament": {
  "n": "Peacock Ornament",
  "t": "Peacock Ornament, Handmade Christmas Ornament | Vintage of 4 Seasons",
  "m": "Handmade peacock ornament, one of a kind and made to be remembered. A jeweled peacock on a filigree cage, with a feathered tail and satin. Engraving $1 a letter. Free shipping. No sales tax. Ships in about 3 days.",
  "d": "A jeweled peacock on a filigree cage, with a feathered tail and satin bow.",
  "p": 99,
  "box": false,
  "cat": "Character"
 },
 "ornament-gift-box": {
  "n": "Ornament Gift Box",
  "t": "Ornament Gift Box | Vintage of 4 Seasons",
  "m": "Handmade ornament gift box, one of a kind and made to be remembered. A velvet keepsake gift box filled with the ornaments you choose. It is. Engraving $1 a letter. Free shipping. No sales tax. Ships in about 3 days.",
  "d": "A velvet keepsake gift box filled with the ornaments you choose. It is priced by what you put inside, and 3 or more ornaments come with a second, separate gift box free.",
  "p": 0,
  "box": true,
  "cat": "Vintage"
 },
 "jeweled-bow-ornament": {
  "n": "Jeweled Bow Ornament",
  "t": "Jeweled Bow Ornament | Vintage of 4 Seasons",
  "m": "Handmade jeweled bow ornament, one of a kind and made to be remembered. A silk-covered ornament topped with a satin bow, finished with a jewel. Engraving $1 a letter. Free shipping. No sales tax. Ships in about 3 days.",
  "d": "A silk-covered ornament topped with a satin bow, finished with a jeweled brooch, pearls, and a hand-tied tassel.",
  "p": 67,
  "box": false,
  "cat": "Vintage, Winter"
 },
 "praying-mary-ornament": {
  "n": "Praying Mary Ornament",
  "t": "Praying Mary Ornament | Vintage of 4 Seasons",
  "m": "Handmade praying mary ornament, one of a kind and made to be remembered. Mother Mary in prayer, framed in pearls and finished with a hand-tied. Engraving $1 a letter. Free shipping. No sales tax. Ships in about 3 days.",
  "d": "Mother Mary in prayer, framed in pearls and finished with a hand-tied tassel.",
  "p": 63,
  "box": false,
  "cat": "Character, Religious"
 },
 "angel-ornament": {
  "n": "Angel Ornament",
  "t": "Angel Ornament, Handmade Christmas Ornament | Vintage of 4 Seasons",
  "m": "Handmade angel ornament, one of a kind and made to be remembered. A sleeping winged cherub resting on soft velvet, edged with pearls and. Engraving $1 a letter. Free shipping. No sales tax. Ships in about 3 days.",
  "d": "A sleeping winged cherub resting on soft velvet, edged with pearls and a hand-tied tassel.",
  "p": 67,
  "box": false,
  "cat": "Character, Winter"
 },
 "sapphire-cameo-ornament": {
  "n": "Sapphire Cameo Ornament",
  "t": "Sapphire Cameo Ornament | Vintage of 4 Seasons",
  "m": "Handmade sapphire cameo ornament, one of a kind and made to be remembered. A hand-finished cameo portrait framed in jewels and pearls, with a han. Engraving $1 a letter. Free shipping. No sales tax. Ships in about 3 days.",
  "d": "A hand-finished cameo portrait framed in jewels and pearls, with a hand-tied tassel.",
  "p": 67,
  "box": false,
  "cat": "Vintage"
 },
 "angel-of-eternal-love-ornament": {
  "n": "Angel of Eternal Love Ornament",
  "t": "Angel of Eternal Love Ornament | Vintage of 4 Seasons",
  "m": "Handmade angel of eternal love ornament, one of a kind and made to be remembered. A little cherub holding a heart, set in an ornate frame under a satin. Engraving $1 a letter. Free shipping. No sales tax. Ships in about 3 days.",
  "d": "A little cherub holding a heart, set in an ornate frame under a satin bow.",
  "p": 64,
  "box": false,
  "cat": "Character, Winter"
 },
 "ballet-slippers-ornament": {
  "n": "Ballet Slippers Ornament",
  "t": "Ballet Slippers Ornament | Vintage of 4 Seasons",
  "m": "Handmade ballet slippers ornament, one of a kind and made to be remembered. A pair of satin ballet slippers in a jeweled frame with roses and a sa. Engraving $1 a letter. Free shipping. No sales tax. Ships in about 3 days.",
  "d": "A pair of satin ballet slippers in a jeweled frame with roses and a satin bow.",
  "p": 67,
  "box": false,
  "cat": "Character"
 },
 "ballerina-ornament": {
  "n": "Ballerina Ornament",
  "t": "Ballerina Ornament, Handmade Christmas Ornament | Vintage of 4 Seasons",
  "m": "Handmade ballerina ornament, one of a kind and made to be remembered. A hand-posed ballerina in a jeweled tutu on soft velvet, with a pearl. Engraving $1 a letter. Free shipping. No sales tax. Ships in about 3 days.",
  "d": "A hand-posed ballerina in a jeweled tutu on soft velvet, with a pearl and tassel.",
  "p": 67,
  "box": false,
  "cat": "Character"
 },
 "masquerade-mask-ornament": {
  "n": "Masquerade Mask Ornament",
  "t": "Masquerade Mask Ornament | Vintage of 4 Seasons",
  "m": "Handmade masquerade mask ornament, one of a kind and made to be remembered. A jeweled masquerade mask under a satin bow, set on soft velvet with a. Engraving $1 a letter. Free shipping. No sales tax. Ships in about 3 days.",
  "d": "A jeweled masquerade mask under a satin bow, set on soft velvet with a hand-tied tassel.",
  "p": 67,
  "box": false,
  "cat": "Vintage"
 },
 "horse-head-ornament": {
  "n": "Horse Head Ornament",
  "t": "Horse Head Ornament | Vintage of 4 Seasons",
  "m": "Handmade horse head ornament, one of a kind and made to be remembered. A sculpted horse head framed in filigree and pearls, with a hand-tied. Engraving $1 a letter. Free shipping. No sales tax. Ships in about 3 days.",
  "d": "A sculpted horse head framed in filigree and pearls, with a hand-tied tassel.",
  "p": 67,
  "box": false,
  "cat": "Winter"
 },
 "carousel-horse-medallion": {
  "n": "Carousel Horse Medallion",
  "t": "Carousel Horse Medallion | Vintage of 4 Seasons",
  "m": "Handmade carousel horse medallion, one of a kind and made to be remembered. A carousel horse on a round velvet medallion, edged with pearls and fi. Engraving $1 a letter. Free shipping. No sales tax. Ships in about 3 days.",
  "d": "A carousel horse on a round velvet medallion, edged with pearls and finished with a tassel.",
  "p": 59,
  "box": false,
  "cat": "Winter"
 },
 "jeweled-filigree-ornament": {
  "n": "Jeweled Filigree Ornament",
  "t": "Jeweled Filigree Ornament | Vintage of 4 Seasons",
  "m": "Handmade jeweled filigree ornament, one of a kind and made to be remembered. A velvet-covered ornament with hand-set filigree and jewels, topped wi. Engraving $1 a letter. Free shipping. No sales tax. Ships in about 3 days.",
  "d": "A velvet-covered ornament with hand-set filigree and jewels, topped with a satin bow and finished with a tassel.",
  "p": 67,
  "box": false,
  "cat": "Vintage"
 },
 "jeweled-pearl-ornament": {
  "n": "Jeweled Pearl Ornament",
  "t": "Jeweled Pearl Ornament | Vintage of 4 Seasons",
  "m": "Handmade jeweled pearl ornament, one of a kind and made to be remembered. A silk-wrapped ornament with panels of jewels and pearls, topped with. Engraving $1 a letter. Free shipping. No sales tax. Ships in about 3 days.",
  "d": "A silk-wrapped ornament with panels of jewels and pearls, topped with a satin bow and finished with a tassel.",
  "p": 67,
  "box": false,
  "cat": "Vintage, Winter"
 },
 "rose-cameo-ornament": {
  "n": "Rose Cameo Ornament",
  "t": "Rose Cameo Ornament | Vintage of 4 Seasons",
  "m": "Handmade rose cameo ornament, one of a kind and made to be remembered. A hand-finished cameo portrait framed in gold and set with satin roses. Engraving $1 a letter. Free shipping. No sales tax. Ships in about 3 days.",
  "d": "A hand-finished cameo portrait framed in gold and set with satin roses, under a satin bow with a hand-tied tassel.",
  "p": 67,
  "box": false,
  "cat": "Vintage"
 },
 "framed-ballerina-ornament": {
  "n": "Framed Ballerina Ornament",
  "t": "Framed Ballerina Ornament | Vintage of 4 Seasons",
  "m": "Handmade framed ballerina ornament, one of a kind and made to be remembered. A hand-posed ballerina inside an ornate jeweled frame, set on soft vel. Engraving $1 a letter. Free shipping. No sales tax. Ships in about 3 days.",
  "d": "A hand-posed ballerina inside an ornate jeweled frame, set on soft velvet under a satin bow.",
  "p": 67,
  "box": false,
  "cat": "Character"
 },
 "crystal-teardrop-ornament": {
  "n": "Crystal Teardrop Ornament",
  "t": "Crystal Teardrop Ornament | Vintage of 4 Seasons",
  "m": "Handmade crystal teardrop ornament, one of a kind and made to be remembered. A teardrop-shaped ornament wrapped in satin and edged with crystals, w. Engraving $1 a letter. Free shipping. No sales tax. Ships in about 3 days.",
  "d": "A teardrop-shaped ornament wrapped in satin and edged with crystals, with a jeweled cap and a hand-tied tassel.",
  "p": 59,
  "box": false,
  "cat": "Vintage"
 }
};
const SITE = 'https://vintageof4seasons.com';
const SHIP_LD = {"@type":"OfferShippingDetails","shippingRate":{"@type":"MonetaryAmount","value":"0.00","currency":"USD"},"shippingDestination":{"@type":"DefinedRegion","addressCountry":"US"},"deliveryTime":{"@type":"ShippingDeliveryTime","handlingTime":{"@type":"QuantitativeValue","minValue":0,"maxValue":3,"unitCode":"DAY"},"transitTime":{"@type":"QuantitativeValue","minValue":2,"maxValue":5,"unitCode":"DAY"}}};
const RETURN_LD = {"@type":"MerchantReturnPolicy","applicableCountry":"US","returnPolicyCategory":"https://schema.org/MerchantReturnFiniteReturnWindow","merchantReturnDays":5,"returnMethod":"https://schema.org/ReturnByMail"};

function productJsonLd(slug, pg) {
  const url = SITE + '/ornament/' + slug;
  const offer = pg.box
    ? { '@type': 'AggregateOffer', priceCurrency: 'USD', lowPrice: '47' }
    : { '@type': 'Offer', priceCurrency: 'USD', price: pg.p.toFixed(2) };
  Object.assign(offer, { availability: 'https://schema.org/InStock', itemCondition: 'https://schema.org/NewCondition', url, priceValidUntil: '2026-12-31', shippingDetails: SHIP_LD, hasMerchantReturnPolicy: RETURN_LD });
  return [
    { '@context': 'https://schema.org', '@type': 'Product', name: pg.n, description: pg.d, category: pg.cat || 'Ornaments', sku: slug, brand: { '@type': 'Brand', name: 'Vintage of 4 Seasons' }, image: SITE + '/img/' + slug + '.jpg', url, offers: offer },
    { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: SITE + '/' },
      { '@type': 'ListItem', position: 2, name: pg.n, item: url } ] },
  ];
}

async function productPage(request, env, slug) {
  const url = new URL(request.url);
  const pg = Object.prototype.hasOwnProperty.call(PAGES, slug) ? PAGES[slug] : null;
  if (!pg) return Response.redirect(url.origin + '/', 302);
  const res = await env.ASSETS.fetch(new Request(url.origin + '/', { method: 'GET', headers: request.headers }));
  if (typeof HTMLRewriter === 'undefined' || !res.ok) return res;
  const pageUrl = SITE + '/ornament/' + slug;
  const img = SITE + '/img/' + slug + '.jpg';
  const setContent = (v) => ({ element(e) { e.setAttribute('content', v); } });
  const ld = JSON.stringify(productJsonLd(slug, pg)).replace(/</g, '\\u003c');
  return new HTMLRewriter()
    .on('title', { element(e) { e.setInnerContent(pg.t); } })
    .on('meta[name="description"]', setContent(pg.m))
    .on('meta[property="og:title"]', setContent(pg.t))
    .on('meta[property="og:description"]', setContent(pg.m))
    .on('meta[property="og:url"]', setContent(pageUrl))
    .on('meta[property="og:image"]', setContent(img))
    .on('meta[name="twitter:title"]', setContent(pg.t))
    .on('meta[name="twitter:description"]', setContent(pg.m))
    .on('meta[name="twitter:image"]', setContent(img))
    .on('link[rel="canonical"]', { element(e) { e.setAttribute('href', pageUrl); } })
    .on('script[type="application/ld+json"]', { element(e) { e.remove(); } })
    .on('head', { element(e) { e.append('<script type="application/ld+json">' + ld + '</script>', { html: true }); } })
    .transform(res);
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/checkout') return checkoutHandler({ request, env });
    if (pathname === '/api/stripe-webhook') return webhookHandler({ request, env });
    if (pathname.startsWith('/ornament/') && (request.method === 'GET' || request.method === 'HEAD')) {
      const m = /^\/ornament\/([a-z0-9-]+)\/?$/.exec(pathname);
      return productPage(request, env, m ? m[1] : '');
    }
    return env.ASSETS.fetch(request);
  },
};
