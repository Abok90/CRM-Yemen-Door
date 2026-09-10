const SHOPIFY_API_VERSION = '2024-01';

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

// جلب كل المنتجات من شوبيفاي مع دعم الصفحات (cursor pagination عبر Link header)
async function fetchAllShopifyProducts(storeUrl, token) {
  const all = [];
  let url = `https://${storeUrl}/admin/api/${SHOPIFY_API_VERSION}/products.json?limit=250`;
  let guard = 0;
  while (url && guard < 50) {
    guard++;
    const r = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
    if (!r.ok) throw new Error(`Shopify API error: ${r.status}`);
    const data = await r.json();
    all.push(...(data.products || []));
    const link = r.headers.get('link') || r.headers.get('Link') || '';
    const m = link.match(/<([^>]+)>;\s*rel="next"/);
    url = m ? m[1] : null;
  }
  return all;
}

// تحويل منتج شوبيفاي لصيغة جدول products في السيستم
function mapProduct(p, storeUrl) {
  const image = (p.image && p.image.src) || (p.images && p.images[0] && p.images[0].src) || '';
  const firstVariant = (p.variants && p.variants[0]) || {};
  const price = parseFloat(firstVariant.price || 0) || 0;

  // استخراج المقاسات والألوان من خيارات المنتج
  const options = p.options || [];
  const pick = (keys) => {
    const opt = options.find(o => o.name && keys.some(k => o.name.toLowerCase().includes(k)));
    if (!opt || !opt.values) return '';
    const vals = opt.values.filter(v => v && v.toLowerCase() !== 'default title');
    return vals.join(',');
  };
  const sizes = pick(['size', 'مقاس', 'حجم', 'وزن', 'gr', 'gm']);
  const colors = pick(['color', 'colour', 'لون']);

  const stock = (p.variants || []).reduce((s, v) =>
    s + (Number.isFinite(v.inventory_quantity) ? v.inventory_quantity : 0), 0);

  const link = p.handle ? `https://${storeUrl}/products/${p.handle}` : '';

  return { name: String(p.title || '').trim(), price, colors, sizes, image, stock_qty: stock, link };
}

const normName = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // مصادقة: نفس أسلوب مزامنة الأوردرات
  const authToken = req.headers['x-crm-auth'] || '';
  if (!authToken) return res.status(401).json({ error: 'Unauthorized' });
  const authRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${authToken}` },
  });
  if (!authRes.ok) return res.status(401).json({ error: 'Invalid session' });

  const storeUrl = process.env.SHOPIFY_STORE_URL;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!storeUrl || !token) return res.status(500).json({ error: 'Store credentials not configured' });

  try {
    const shopifyProducts = await fetchAllShopifyProducts(storeUrl, token);
    const mapped = shopifyProducts
      .map(p => mapProduct(p, storeUrl))
      .filter(p => p.name);

    // المنتجات الموجودة حالياً في السيستم (للمطابقة بالاسم وتجنّب التكرار)
    const existing = await supabaseRequest('GET', 'products?select=id,name,image,price,colors,sizes,link');
    const byName = new Map();
    (existing || []).forEach(p => byName.set(normName(p.name), p));

    const toInsert = [];
    let inserted = 0, updated = 0, skipped = 0;

    for (const prod of mapped) {
      const found = byName.get(normName(prod.name));
      if (!found) {
        toInsert.push(prod);
        continue;
      }
      // موجود: حدّث الصورة (الهدف الأساسي) وأكمل الناقص فقط، مع الحفاظ على البيانات اليدوية
      const patch = {};
      if (prod.image && prod.image !== found.image) patch.image = prod.image;
      if (prod.link && !found.link) patch.link = prod.link;
      if (prod.sizes && !found.sizes) patch.sizes = prod.sizes;
      if (prod.colors && !found.colors) patch.colors = prod.colors;
      if (prod.price && !(Number(found.price) > 0)) patch.price = prod.price;
      if (Object.keys(patch).length > 0) {
        await supabaseRequest('PATCH', `products?id=eq.${found.id}`, patch);
        updated++;
      } else {
        skipped++;
      }
    }

    if (toInsert.length > 0) {
      // إدراج دفعة واحدة
      await supabaseRequest('POST', 'products', toInsert);
      inserted = toInsert.length;
    }

    return res.status(200).json({ ok: true, total: mapped.length, inserted, updated, skipped });
  } catch (err) {
    console.error(`[products-sync] Error: ${err.message}`);
    return res.status(200).json({ ok: false, error: err.message });
  }
}

module.exports = handler;
