const { requireApprovedUser } = require('../lib/auth');
const {
  STORE_KEY, SHOPIFY_API_VERSION, buildOrderRow, shopifyOwnedFields, statusUpdates, orderDate,
  supabaseRequest, orderFilter,
} = require('../lib/shopify-order');

function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

async function shopifyGet(url, token) {
  const r = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
  if (!r.ok) throw new Error(`Shopify API error: ${r.status}`);
  const link = r.headers.get('link') || '';
  const next = link.match(/<([^>]+)>;\s*rel="next"/);
  return { data: await r.json(), next: next ? next[1] : null };
}

// جلب أوردرات مع دعم الصفحات (لحد maxPages × 250)
async function fetchOrders(storeUrl, token, params, maxPages) {
  const all = [];
  let url = `https://${storeUrl}/admin/api/${SHOPIFY_API_VERSION}/orders.json?${params}`;
  for (let page = 0; url && page < maxPages; page++) {
    const { data, next } = await shopifyGet(url, token);
    all.push(...(data.orders || []));
    url = next;
  }
  return all;
}

// تنفيذ مهام بالتوازي بحد أقصى (أسرع بكتير من واحدة واحدة ومن غير ما نضغط على Supabase)
async function runPool(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx]); }
  });
  await Promise.all(workers);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ROW_COLUMNS = 'id,status,date,shopify_order_id,item,quantity,productPrice,shippingPrice,customer,phone,address';

// الفرق بين بيانات شوبيفاي الحالية والصف في السيستم
function diffPatch(order, row) {
  const patch = {};
  for (const [k, v] of Object.entries(shopifyOwnedFields(order))) {
    const cur = row[k];
    const same = typeof v === 'number' ? Number(cur) === v : String(cur == null ? '' : cur) === String(v);
    if (!same) patch[k] = v;
  }
  const rule = statusUpdates(order);
  if (rule && row.status !== rule.status) {
    const allowed = rule.in ? rule.in.includes(row.status) : !rule.notIn.includes(row.status);
    if (allowed) patch.status = rule.status;
  }
  // إصلاح التواريخ القديمة اللي اتسجلت بصيغة عربي (بتبوّظ الفلترة بالتاريخ)
  if (!ISO_DATE.test(String(row.date || ''))) patch.date = orderDate(order);
  return patch;
}

async function processOrders(orders, mode) {
  const counts = { inserted: 0, updated: 0, merged: 0, skipped: 0 };
  if (!orders.length) return counts;

  // كل الأوردرات الموجودة في السيستم للمجموعة دي بطلب واحد
  const existingByShopify = new Map();
  const ids = orders.map(o => o.id);
  for (let i = 0; i < ids.length; i += 150) {
    const chunk = ids.slice(i, i + 150).join(',');
    const rows = await supabaseRequest('GET',
      `orders?shopify_store=eq.${STORE_KEY}&shopify_order_id=in.(${chunk})&select=${ROW_COLUMNS}`);
    for (const r of rows || []) {
      const k = String(r.shopify_order_id);
      if (!existingByShopify.has(k)) existingByShopify.set(k, []);
      existingByShopify.get(k).push(r);
    }
  }

  const toInsert = [];
  const toUpdate = [];
  const toMerge = [];
  for (const order of orders) {
    const existing = existingByShopify.get(String(order.id)) || [];
    if (existing.length === 0) toInsert.push(buildOrderRow(order));
    else if (mode === 'missing') counts.skipped++;
    else if (existing.length === 1) toUpdate.push({ order, row: existing[0] });
    else toMerge.push({ order, rows: existing });
  }

  if (toInsert.length) {
    for (let i = 0; i < toInsert.length; i += 100) {
      await supabaseRequest('POST', 'orders?on_conflict=id', toInsert.slice(i, i + 100),
        'resolution=ignore-duplicates,return=minimal');
    }
    counts.inserted = toInsert.length;
  }

  // بنحدّث بس الأوردرات اللي اتغيرت فعلاً — عشان المزامنة التلقائية المتكررة تفضل خفيفة
  await runPool(toUpdate, 8, async ({ order, row }) => {
    const patch = diffPatch(order, row);
    if (Object.keys(patch).length === 0) { counts.skipped++; return; }
    await supabaseRequest('PATCH', orderFilter(order.id), patch);
    counts.updated++;
  });

  // أكتر من صف لنفس أوردر شوبيفاي (#1000-1, #1000-2): ندمجهم في صف واحد ونحافظ على الحالة
  for (const { order, rows } of toMerge) {
    const row = buildOrderRow(order);
    const status = (rows[0] && rows[0].status) || row.status;
    await supabaseRequest('DELETE', orderFilter(order.id));
    await supabaseRequest('POST', 'orders', { ...row, status });
    counts.merged++;
  }

  return counts;
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const auth = await requireApprovedUser(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const storeUrl = process.env.SHOPIFY_STORE_URL;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!storeUrl || !token) return res.status(500).json({ error: 'Store credentials not configured' });

  const body = await readJsonBody(req);
  // 'update' | 'missing' | 'specific' | 'recent' | 'debug'
  const mode = body.mode || 'update';

  try {
    let orders = [];

    if (mode === 'debug' || mode === 'specific') {
      const orderName = String(body.orderName || '').replace('#', '').trim();
      if (mode === 'specific' && !orderName) return res.status(400).json({ error: 'orderName مطلوب' });
      const params = orderName
        ? `status=any&name=${encodeURIComponent('#' + orderName)}&limit=5`
        : 'status=any&limit=1&order=created_at+desc';
      orders = await fetchOrders(storeUrl, token, params, 1);
      if (mode === 'debug') {
        const o = orders[0];
        if (!o) return res.status(200).json({ ok: false, error: 'لا توجد أوردرات' });
        const { line_items, ...orderWithoutItems } = o;
        return res.status(200).json({ ok: true, debug: orderWithoutItems, line_items_count: (line_items || []).length });
      }
    } else if (mode === 'recent') {
      // المزامنة التلقائية: أي أوردر اتعدّل على شوبيفاي في آخر X ساعة (إلغاء، حذف منتج، تعديل سعر/عنوان)
      const hours = Math.min(Math.max(Number(body.hours) || 72, 1), 24 * 30);
      const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
      orders = await fetchOrders(storeUrl, token,
        `status=any&limit=250&updated_at_min=${encodeURIComponent(since)}&order=updated_at+desc`, 4);
    } else {
      const limit = Math.min(Number(body.limit) || 250, 250);
      orders = await fetchOrders(storeUrl, token, `status=any&limit=${limit}&order=created_at+desc`, 1);
    }

    const counts = await processOrders(orders, mode);
    return res.status(200).json({ ok: true, total: orders.length, ...counts });
  } catch (err) {
    console.error(`[sync] Error: ${err.message}`);
    return res.status(200).json({ ok: false, error: err.message });
  }
}

module.exports = handler;
