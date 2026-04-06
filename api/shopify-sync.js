const SHOPIFY_API_VERSION = '2024-01';

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

function extractCustomer(order) {
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

function buildOrderData(order) {
  const lineItems = order.line_items || [];
  const ship = (order.shipping_lines || [])[0] || {};
  const { customer, phone, address } = extractCustomer(order);

  const itemText = lineItems.map(it => {
    const name = it.variant_title ? `${it.title} - ${it.variant_title}` : it.title;
    return it.quantity > 1 ? `${name} ×${it.quantity}` : name;
  }).join('\n');

  const totalQty = lineItems.reduce((sum, it) => sum + (it.quantity || 1), 0);
  const totalPrice = lineItems.reduce((sum, it) => sum + parseFloat(it.price || 0) * (it.quantity || 1), 0);
  const shippingPrice = parseFloat(ship.price || 0);

  let status = 'جاري التحضير';
  if (order.cancelled_at) status = 'الغاء';
  else if (order.fulfillment_status === 'fulfilled') status = 'الشحن';
  else if (order.financial_status === 'paid') status = 'تم';

  return {
    id: order.name || `#${order.order_number}`,
    customer, phone, address,
    item: itemText,
    quantity: totalQty,
    productPrice: totalPrice,
    shippingPrice,
    notes: order.note || '',
    status,
    page: 'يمن دور ويب',
    shopify_order_id: order.id,
    shopify_store: 'yemen_door',
    source: 'shopify',
    date: new Date(order.created_at).toLocaleDateString('ar-EG'),
  };
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

async function fetchShopifyOrders(storeUrl, token, params) {
  const url = `https://${storeUrl}/admin/api/${SHOPIFY_API_VERSION}/orders.json?${params}`;
  const r = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
  if (!r.ok) throw new Error(`Shopify API error: ${r.status}`);
  return r.json();
}

async function processOrder(order, mode) {
  const existing = await supabaseRequest('GET',
    `orders?shopify_order_id=eq.${order.id}&shopify_store=eq.yemen_door&select=id,status`
  );
  const data = buildOrderData(order);

  if (!existing || existing.length === 0) {
    // غير موجود → أضفه
    await supabaseRequest('POST', 'orders', data);
    return 'inserted';
  }

  if (mode === 'missing') return 'skipped'; // وضع الناقصة: لا تحدث الموجود

  if (existing.length === 1) {
    // موجود: حدّث البيانات مع الحفاظ على الحالة الحالية
    const { status: _, ...updateData } = data;
    await supabaseRequest('PATCH',
      `orders?shopify_order_id=eq.${order.id}&shopify_store=eq.yemen_door`,
      updateData
    );
    return 'updated';
  }

  // أكثر من أوردر مرتبط (#1000-1, #1000-2): دمجهم في أوردر واحد
  const currentStatus = existing[0]?.status || data.status;
  await supabaseRequest('DELETE', `orders?shopify_order_id=eq.${order.id}&shopify_store=eq.yemen_door`);
  await supabaseRequest('POST', 'orders', { ...data, status: currentStatus });
  return 'merged';
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

  let body = {};
  try {
    const chunks = [];
    await new Promise((resolve, reject) => {
      req.on('data', c => chunks.push(c));
      req.on('end', resolve);
      req.on('error', reject);
    });
    body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {}

  const mode = body.mode || 'update'; // 'update' | 'missing' | 'specific' | 'debug'
  const counts = { inserted: 0, updated: 0, merged: 0, skipped: 0 };

  try {
    let orders = [];

    if (mode === 'debug') {
      // وضع التشخيص: يرجع البيانات الخام
      const orderName = String(body.orderName || '').replace('#', '').trim();
      let o;
      if (orderName) {
        const { orders: found } = await fetchShopifyOrders(storeUrl, token, `status=any&name=${encodeURIComponent('#' + orderName)}&limit=5`);
        o = (found || [])[0];
      } else {
        const { orders: found } = await fetchShopifyOrders(storeUrl, token, `status=any&limit=1&order=created_at+desc`);
        o = (found || [])[0];
      }
      if (!o) return res.status(200).json({ ok: false, error: 'لا توجد أوردرات' });
      // رجّع الأوردر كامل بدون line_items عشان ما يكونش كبير
      const { line_items, ...orderWithoutItems } = o;
      return res.status(200).json({ ok: true, debug: orderWithoutItems, line_items_count: (line_items || []).length });
    }

    if (mode === 'specific') {
      const orderName = String(body.orderName || '').replace('#', '').trim();
      if (!orderName) return res.status(400).json({ error: 'orderName مطلوب' });
      const { orders: found } = await fetchShopifyOrders(storeUrl, token, `status=any&name=${encodeURIComponent('#' + orderName)}&limit=5`);
      orders = found || [];
    } else {
      const limit = Math.min(Number(body.limit) || 250, 250);
      const { orders: found } = await fetchShopifyOrders(storeUrl, token, `status=any&limit=${limit}&order=created_at+desc`);
      orders = found || [];
    }

    for (const order of orders) {
      const result = await processOrder(order, mode);
      counts[result]++;
    }

    return res.status(200).json({ ok: true, total: orders.length, ...counts });
  } catch (err) {
    console.error(`[sync] Error: ${err.message}`);
    return res.status(200).json({ ok: false, error: err.message });
  }
}

module.exports = handler;
