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

    } else if (topic === 'orders/updated') {
      let newStatus = null;
      const tags = (order.tags || '').split(',').map(t => t.trim().toLowerCase());
      if (order.fulfillment_status === 'fulfilled') newStatus = 'الشحن';
      else if (tags.includes('collected')) newStatus = 'تم';
      else if (order.cancelled_at || order.financial_status === 'refunded') newStatus = 'الغاء';
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
