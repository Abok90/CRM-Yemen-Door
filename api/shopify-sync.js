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
    const chunks = [];
    await new Promise((resolve, reject) => {
      req.on('data', c => chunks.push(c));
      req.on('end', resolve);
      req.on('error', reject);
    });
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
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

    let updated = 0, skipped = 0;

    for (const order of orders) {
      const b = order.billing_address || {};
      const s = order.shipping_address || {};
      const lineItems = order.line_items || [];
      const ship = (order.shipping_lines || [])[0] || {};
      const phone = normalizePhone(order.phone || b.phone || s.phone || '');

      // دمج كل المنتجات في سطر واحد
      const itemText = lineItems.map(it => {
        const name = it.variant_title ? `${it.title} - ${it.variant_title}` : it.title;
        return it.quantity > 1 ? `${name} ×${it.quantity}` : name;
      }).join('\n');
      const totalQty = lineItems.reduce((sum, it) => sum + (it.quantity || 1), 0);
      const totalPrice = lineItems.reduce((sum, it) => sum + parseFloat(it.price || 0) * (it.quantity || 1), 0);
      const shippingPrice = parseFloat(ship.price || 0);

      // تحديث الأوردرات الموجودة بنفس shopify_order_id (سواء كانت #1000 أو #1000-1 #1000-2 إلخ)
      const existing = await supabaseRequest('GET',
        `orders?shopify_order_id=eq.${order.id}&shopify_store=eq.yemen_door&select=id`
      );

      if (!existing || existing.length === 0) {
        skipped++;
        continue;
      }

      if (existing.length === 1) {
        // أوردر واحد: تحديث البيانات مباشرة
        await supabaseRequest('PATCH',
          `orders?shopify_order_id=eq.${order.id}&shopify_store=eq.yemen_door`,
          { phone, item: itemText, quantity: totalQty, productPrice: totalPrice, shippingPrice }
        );
        updated++;
      } else {
        // أكثر من أوردر مرتبط (الأوردرات المنفصلة القديمة #1000-1 #1000-2):
        // احذفهم وأدخل أوردر واحد صح
        const currentStatus = existing[0]?.status || 'جاري التحضير';
        const orderId = order.name || `#${order.order_number}`;
        const customer = b.name || s.name || `${order.customer?.first_name || ''} ${order.customer?.last_name || ''}`.trim() || 'عميل Shopify';
        const address = s.address1 || b.address1 || '';

        await supabaseRequest('DELETE',
          `orders?shopify_order_id=eq.${order.id}&shopify_store=eq.yemen_door`
        );
        await supabaseRequest('POST', 'orders', {
          id: orderId,
          customer, phone, address,
          item: itemText,
          quantity: totalQty,
          productPrice: totalPrice,
          shippingPrice,
          notes: order.note || '',
          status: currentStatus,
          page: 'يمن دور ويب',
          shopify_order_id: order.id,
          shopify_store: 'yemen_door',
          source: 'shopify',
          date: new Date(order.created_at).toLocaleDateString('ar-EG'),
        });
        updated++;
      }
    }

    return res.status(200).json({ ok: true, orders: orders.length, updated, skipped });
  } catch (err) {
    console.error(`[sync] Error: ${err.message}`);
    return res.status(200).json({ ok: false, error: err.message });
  }
}

module.exports = handler;
