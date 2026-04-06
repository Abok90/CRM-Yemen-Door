const SHOPIFY_API_VERSION = '2024-01';

function normalizePhone(raw) {
  if (!raw) return '';
  let p = raw.replace(/[\s\-\(\)\.]/g, '');
  if (p.startsWith('+20')) p = '0' + p.slice(3);
  else if (p.startsWith('0020')) p = '0' + p.slice(4);
  else if (p.startsWith('+2')) p = '0' + p.slice(2);
  return p;
}

async function supabaseRequest(method, path, body) {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: method === 'GET' ? 'return=representation' : 'return=minimal',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Supabase ${method} failed: ${res.status} — ${await res.text()}`);
  if (method === 'GET') return res.json();
  return null;
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // التحقق من الجلسة
  const authToken = req.headers['x-crm-auth'] || '';
  if (!authToken) return res.status(401).json({ error: 'Unauthorized' });
  const authRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${authToken}` },
  });
  if (!authRes.ok) return res.status(401).json({ error: 'Invalid session' });

  const storeUrl = process.env.SHOPIFY_STORE_URL;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!storeUrl || !token) return res.status(500).json({ error: 'Store credentials not configured' });

  let limit = 14;
  try {
    const raw = await req.text?.() || '';
    const body = JSON.parse(raw || '{}');
    if (body.limit) limit = Math.min(Number(body.limit) || 14, 50);
  } catch {}

  try {
    // جلب آخر N أوردر من Shopify
    const shopifyRes = await fetch(
      `https://${storeUrl}/admin/api/${SHOPIFY_API_VERSION}/orders.json?limit=${limit}&status=any&order=created_at+desc`,
      { headers: { 'X-Shopify-Access-Token': token } }
    );
    if (!shopifyRes.ok) throw new Error(`Shopify API error: ${shopifyRes.status}`);
    const { orders } = await shopifyRes.json();

    let inserted = 0, deleted = 0;

    for (const order of orders) {
      const b = order.billing_address || {};
      const s = order.shipping_address || {};
      const lineItems = order.line_items || [];
      const ship = (order.shipping_lines || [])[0] || {};
      const baseId = order.name || `#${order.order_number}`;
      const customer = b.name || s.name || `${order.customer?.first_name || ''} ${order.customer?.last_name || ''}`.trim() || 'عميل Shopify';
      const phone = normalizePhone(order.phone || b.phone || s.phone || '');
      const address = s.address1 || b.address1 || '';
      const shippingPrice = parseFloat(ship.price || 0);
      const notes = order.note || '';
      const date = new Date(order.created_at).toLocaleDateString('ar-EG');

      // تحديد الحالة الحالية في السيستم قبل الحذف
      let currentStatus = 'جاري التحضير';
      try {
        const existing = await supabaseRequest('GET', `orders?shopify_order_id=eq.${order.id}&shopify_store=eq.yemen_door&select=status&limit=1`);
        if (existing && existing.length > 0) currentStatus = existing[0].status || 'جاري التحضير';
      } catch {}

      // حذف الأوردرات القديمة الخاطئة
      await supabaseRequest('DELETE', `orders?shopify_order_id=eq.${order.id}&shopify_store=eq.yemen_door`);
      deleted++;

      // إعادة الإدخال الصحيح - أوردر لكل منتج
      for (let i = 0; i < lineItems.length; i++) {
        const item = lineItems[i];
        const orderId = lineItems.length > 1 ? `${baseId}-${i + 1}` : baseId;
        await supabaseRequest('POST', 'orders', {
          id: orderId,
          customer,
          phone,
          address,
          item: item.variant_title ? `${item.title} - ${item.variant_title}` : (item.title || ''),
          quantity: item.quantity || 1,
          productPrice: parseFloat(item.price || 0) * (item.quantity || 1),
          shippingPrice: i === 0 ? shippingPrice : 0,
          notes,
          status: currentStatus,
          page: 'يمن دور ويب',
          shopify_order_id: order.id,
          shopify_store: 'yemen_door',
          source: 'shopify',
          date,
        });
        inserted++;
      }
    }

    return res.status(200).json({ ok: true, orders: orders.length, deleted, inserted });
  } catch (err) {
    console.error(`[sync] Error: ${err.message}`);
    return res.status(200).json({ ok: false, error: err.message });
  }
}

module.exports = handler;
