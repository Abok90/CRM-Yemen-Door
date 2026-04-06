const crypto = require('crypto');

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verifyHmac(rawBody, receivedHmac, secret) {
  const computed = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  try {
    const a = Buffer.from(computed);
    const b = Buffer.from(receivedHmac);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

function normalizePhone(raw) {
  if (!raw) return '';
  let p = raw.replace(/[\s\-\(\)\.]/g, '');
  if (p.startsWith('+20')) p = '0' + p.slice(3);
  else if (p.startsWith('0020')) p = '0' + p.slice(4);
  else if (p.startsWith('+2')) p = '0' + p.slice(2);
  return p;
}

function findNoteAttr(noteAttrs, keys) {
  if (!noteAttrs || !noteAttrs.length) return '';
  for (const key of keys) {
    const found = noteAttrs.find(a => a.name && a.name.toLowerCase().includes(key.toLowerCase()));
    if (found && found.value) return found.value.trim();
  }
  return '';
}

function extractOrderCustomer(order) {
  const b = order.billing_address || {};
  const s = order.shipping_address || {};
  const c = order.customer || {};
  const d = c.default_address || {};
  const noteAttrs = order.note_attributes || [];

  const customer =
    s.name ||
    b.name ||
    (s.first_name ? `${s.first_name} ${s.last_name || ''}`.trim() : '') ||
    (b.first_name ? `${b.first_name} ${b.last_name || ''}`.trim() : '') ||
    d.name ||
    (d.first_name ? `${d.first_name} ${d.last_name || ''}`.trim() : '') ||
    (c.first_name ? `${c.first_name} ${c.last_name || ''}`.trim() : '') ||
    findNoteAttr(noteAttrs, ['name', 'اسم', 'الاسم', 'customer']) ||
    'عميل Shopify';

  const phone = normalizePhone(
    s.phone || b.phone || order.phone || c.phone || d.phone ||
    findNoteAttr(noteAttrs, ['phone', 'mobile', 'موبايل', 'الموبايل', 'هاتف', 'رقم']) ||
    ''
  );

  const address =
    s.address1 || b.address1 || d.address1 ||
    (s.city ? `${s.city}${s.province ? ' - ' + s.province : ''}` : '') ||
    (b.city ? `${b.city}${b.province ? ' - ' + b.province : ''}` : '') ||
    d.city ||
    findNoteAttr(noteAttrs, ['address', 'عنوان', 'العنوان', 'المنطقة']) ||
    '';

  return { customer, phone, address };
}

async function supabaseRequest(method, path, body) {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: 'return=minimal',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Supabase ${method} failed: ${res.status} — ${await res.text()}`);
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody = await readRawBody(req).catch(() => null);
  if (!rawBody) return res.status(400).json({ error: 'Failed to read body' });

  const shopDomain = req.headers['x-shopify-shop-domain'] || '';
  const receivedHmac = req.headers['x-shopify-hmac-sha256'] || '';
  const topic = req.headers['x-shopify-topic'] || '';

  console.log(`[webhook] topic=${topic} shop=${shopDomain} bytes=${rawBody.length}`);

  const d = shopDomain.toLowerCase();
  const isYemenDoor = d.includes('yemens-door') || d.includes('jet6t9-zg') || d.includes('yemens_door');
  if (!isYemenDoor) {
    console.warn(`[webhook] Unknown domain: ${shopDomain}`);
    return res.status(200).json({ ok: true });
  }

  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[webhook] Missing SHOPIFY_WEBHOOK_SECRET');
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  if (!verifyHmac(rawBody, receivedHmac, secret)) {
    console.warn(`[webhook] HMAC failed for ${shopDomain}`);
    return res.status(401).json({ error: 'Invalid HMAC' });
  }

  let order;
  try { order = JSON.parse(rawBody.toString('utf8')); }
  catch { return res.status(400).json({ error: 'Invalid JSON' }); }

  try {
    if (topic === 'orders/create') {
      const lineItems = order.line_items || [];
      const ship = (order.shipping_lines || [])[0] || {};
      const orderId = order.name || `#${order.order_number}`;
      const { customer, phone, address } = extractOrderCustomer(order);

      const itemText = lineItems.map(it => {
        const name = it.variant_title ? `${it.title} - ${it.variant_title}` : it.title;
        return it.quantity > 1 ? `${name} ×${it.quantity}` : name;
      }).join('\n');
      const totalQty = lineItems.reduce((sum, it) => sum + (it.quantity || 1), 0);
      const totalPrice = lineItems.reduce((sum, it) => sum + parseFloat(it.price || 0) * (it.quantity || 1), 0);

      await supabaseRequest('POST', 'orders', {
        id: orderId, customer, phone, address,
        item: itemText, quantity: totalQty, productPrice: totalPrice,
        shippingPrice: parseFloat(ship.price || 0),
        notes: order.note || '',
        status: 'جاري التحضير',
        page: 'يمن دور ويب',
        shopify_order_id: order.id,
        shopify_store: 'yemen_door',
        source: 'shopify',
        date: new Date().toLocaleDateString('ar-EG'),
      });
      console.log(`[webhook] Inserted order ${orderId} (${lineItems.length} items)`);

    } else if (topic === 'orders/paid') {
      await supabaseRequest('PATCH', `orders?shopify_order_id=eq.${order.id}&shopify_store=eq.yemen_door`, { status: 'تم' });
      console.log(`[webhook] paid ${order.id} → تم`);

    } else if (topic === 'orders/fulfilled') {
      await supabaseRequest('PATCH', `orders?shopify_order_id=eq.${order.id}&shopify_store=eq.yemen_door`, { status: 'الشحن' });
      console.log(`[webhook] fulfilled ${order.id} → الشحن`);

    } else if (topic === 'orders/updated') {
      const { customer, phone, address } = extractOrderCustomer(order);
      const patch = {};

      // تحديث الحالة
      const tags = (order.tags || '').split(',').map(t => t.trim().toLowerCase());
      if (tags.includes('collected')) patch.status = 'تم';
      else if (tags.includes('cancelled_order') || order.cancelled_at || order.financial_status === 'refunded') patch.status = 'الغاء';
      else if (order.fulfillment_status === 'fulfilled') patch.status = 'الشحن';

      // تحديث بيانات العميل لو جت في الـ update (الأوردر بيتعمل قبل ما العميل يكمل بياناته)
      if (customer && customer !== 'عميل Shopify') patch.customer = customer;
      if (phone) patch.phone = phone;
      if (address) patch.address = address;

      if (Object.keys(patch).length > 0) {
        await supabaseRequest('PATCH', `orders?shopify_order_id=eq.${order.id}&shopify_store=eq.yemen_door`, patch);
        console.log(`[webhook] updated ${order.id}`, Object.keys(patch));
      }

    } else if (topic === 'orders/cancelled') {
      await supabaseRequest('PATCH', `orders?shopify_order_id=eq.${order.id}&shopify_store=eq.yemen_door`, { status: 'الغاء' });
      console.log(`[webhook] cancelled ${order.id}`);

    } else {
      console.log(`[webhook] Ignored topic: ${topic}`);
    }
  } catch (err) {
    console.error(`[webhook] Error: ${err.message}`);
    return res.status(200).json({ ok: false, error: err.message });
  }

  return res.status(200).json({ ok: true });
}

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
