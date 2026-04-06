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

// تحويل الموبايل: إزالة +20 أو 0020 والحفاظ على صيغة 01xxxxxxxxx
function normalizePhone(raw) {
  if (!raw) return '';
  let p = raw.replace(/[\s\-\(\)\.]/g, '');
  if (p.startsWith('+20')) p = '0' + p.slice(3);
  else if (p.startsWith('0020')) p = '0' + p.slice(4);
  else if (p.startsWith('+2')) p = '0' + p.slice(2);
  return p;
}

// البحث في note_attributes عن قيمة بأكثر من اسم ممكن
function findNoteAttr(noteAttrs, keys) {
  if (!noteAttrs || !noteAttrs.length) return '';
  for (const key of keys) {
    const found = noteAttrs.find(a => a.name && a.name.toLowerCase().includes(key.toLowerCase()));
    if (found && found.value) return found.value.trim();
  }
  return '';
}

// استخراج كل بيانات العميل من أي مكان ممكن في أوردر Shopify
function extractOrderCustomer(order) {
  const b = order.billing_address || {};
  const s = order.shipping_address || {};
  const c = order.customer || {};
  const d = c.default_address || {};
  const noteAttrs = order.note_attributes || [];

  // الاسم: ندور في كل الأماكن الممكنة
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

  // الموبايل: ندور في كل الأماكن الممكنة
  const phone = normalizePhone(
    s.phone || b.phone || order.phone || c.phone || d.phone ||
    findNoteAttr(noteAttrs, ['phone', 'mobile', 'موبايل', 'الموبايل', 'هاتف', 'رقم']) ||
    ''
  );

  // العنوان: ندور في كل الأماكن الممكنة
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
  const headers = {
    'Content-Type': 'application/json',
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    Prefer: 'return=minimal',
  };
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers,
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
      const shippingPrice = parseFloat(ship.price || 0);

      // دمج كل المنتجات في سطر واحد
      const itemText = lineItems.map(it => {
        const name = it.variant_title ? `${it.title} - ${it.variant_title}` : it.title;
        return it.quantity > 1 ? `${name} ×${it.quantity}` : name;
      }).join('\n');
      const totalQty = lineItems.reduce((s, it) => s + (it.quantity || 1), 0);
      const totalPrice = lineItems.reduce((s, it) => s + parseFloat(it.price || 0) * (it.quantity || 1), 0);

      await supabaseRequest('POST', 'orders', {
        id: orderId,
        customer,
        phone,
        address,
        item: itemText,
        quantity: totalQty,
        productPrice: totalPrice,
        shippingPrice,
        notes: order.note || '',
        status: 'جاري التحضير',
        page: 'يمن دور ويب',
        shopify_order_id: order.id,
        shopify_store: 'yemen_door',
        source: 'shopify',
        date: new Date().toLocaleDateString('ar-EG'),
      });
      console.log(`[webhook] Inserted order ${orderId} with ${lineItems.length} item(s)`);

    } else if (topic === 'orders/paid') {
      await supabaseRequest('PATCH', `orders?shopify_order_id=eq.${order.id}&shopify_store=eq.yemen_door`, { status: 'تم' });
      console.log(`[webhook] Order paid ${order.id} → تم`);

    } else if (topic === 'orders/fulfilled') {
      await supabaseRequest('PATCH', `orders?shopify_order_id=eq.${order.id}&shopify_store=eq.yemen_door`, { status: 'الشحن' });
      console.log(`[webhook] Order fulfilled ${order.id} → الشحن`);

    } else if (topic === 'orders/updated') {
      let newStatus = null;
      const tags = (order.tags || '').split(',').map(t => t.trim().toLowerCase());
      if (tags.includes('collected')) newStatus = 'تم';
      else if (tags.includes('cancelled_order') || order.cancelled_at || order.financial_status === 'refunded') newStatus = 'الغاء';
      else if (order.fulfillment_status === 'fulfilled') newStatus = 'الشحن';
      if (newStatus) {
        await supabaseRequest('PATCH', `orders?shopify_order_id=eq.${order.id}&shopify_store=eq.yemen_door`, { status: newStatus });
        console.log(`[webhook] Updated order ${order.id} → ${newStatus}`);
      }
    } else if (topic === 'orders/cancelled') {
      await supabaseRequest('PATCH', `orders?shopify_order_id=eq.${order.id}&shopify_store=eq.yemen_door`, { status: 'الغاء' });
      console.log(`[webhook] Cancelled order ${order.id}`);
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
      const b = order.billing_address || {};
      const s = order.shipping_address || {};
      const item = (order.line_items || [])[0] || {};
      const ship = (order.shipping_lines || [])[0] || {};

      await supabaseRequest('POST', 'orders', {
        id: order.name || `#${order.order_number}` || `YD-${Date.now().toString(36).toUpperCase()}`,
        customer: b.name || s.name || `${order.customer?.first_name || ''} ${order.customer?.last_name || ''}`.trim() || 'عميل Shopify',
        phone: order.phone || b.phone || s.phone || '',
        address: s.address1 || b.address1 || '',
        item: item.variant_title ? `${item.title} - ${item.variant_title}` : (item.title || ''),
        quantity: item.quantity || 1,
        productPrice: parseFloat(order.subtotal_price || 0),
        shippingPrice: parseFloat(ship.price || 0),
        notes: order.note || '',
        status: 'جاري التحضير',
        page: 'يمن دور ويب',
        shopify_order_id: order.id,
        shopify_store: 'yemen_door',
        source: 'shopify',
        date: new Date().toLocaleDateString('ar-EG'),
      });
      console.log(`[webhook] Inserted Yemen Door order ${order.id}`);

    } else if (topic === 'orders/paid') {
      // capture payment → تم
      await supabaseRequest('PATCH', `orders?shopify_order_id=eq.${order.id}&shopify_store=eq.yemen_door`, { status: 'تم' });
      console.log(`[webhook] Order paid ${order.id} → تم`);

    } else if (topic === 'orders/fulfilled') {
      // order fulfilled → الشحن
      await supabaseRequest('PATCH', `orders?shopify_order_id=eq.${order.id}&shopify_store=eq.yemen_door`, { status: 'الشحن' });
      console.log(`[webhook] Order fulfilled ${order.id} → الشحن`);

    } else if (topic === 'orders/updated') {
      let newStatus = null;
      const tags = (order.tags || '').split(',').map(t => t.trim().toLowerCase());
      if (tags.includes('collected')) newStatus = 'تم';
      else if (tags.includes('cancelled_order') || order.cancelled_at || order.financial_status === 'refunded') newStatus = 'الغاء';
      else if (order.fulfillment_status === 'fulfilled') newStatus = 'الشحن';
      if (newStatus) {
        await supabaseRequest('PATCH', `orders?shopify_order_id=eq.${order.id}&shopify_store=eq.yemen_door`, { status: newStatus });
        console.log(`[webhook] Updated order ${order.id} → ${newStatus}`);
      }
    } else if (topic === 'orders/cancelled') {
      await supabaseRequest('PATCH', `orders?shopify_order_id=eq.${order.id}&shopify_store=eq.yemen_door`, { status: 'الغاء' });
      console.log(`[webhook] Cancelled order ${order.id}`);
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
