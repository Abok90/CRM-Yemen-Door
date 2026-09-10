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

// اكتشاف أعمدة جدول products الفعلية (عشان ما نفترضش وجود عمود غير موجود)
async function getTableColumns(table) {
  try {
    const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/`, {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    });
    if (!res.ok) return null;
    const spec = await res.json();
    const props = spec && spec.definitions && spec.definitions[table] && spec.definitions[table].properties;
    if (props) return new Set(Object.keys(props));
  } catch { /* تجاهل */ }
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

// تحويل منتج شوبيفاي لصيغة جدول products في السيستم (كل الحقول الممكنة، وبعدين نفلتر الموجود منها)
function mapProduct(p, storeUrl) {
  const image = (p.image && p.image.src) || (p.images && p.images[0] && p.images[0].src) || '';
  const firstVariant = (p.variants && p.variants[0]) || {};
  const price = parseFloat(firstVariant.price || 0) || 0;

  const options = p.options || [];
  const pick = (keys) => {
    const opt = options.find(o => o.name && keys.some(k => o.name.toLowerCase().includes(k)));
    if (!opt || !opt.values) return '';
    const vals = opt.values.filter(v => v && v.toLowerCase() !== 'default title');
    return vals.join(',');
  };
  const sizes = pick(['size', 'مقاس', 'حجم', 'وزن', 'gr', 'gm']);
  const colors = pick(['color', 'colour', 'لون']);

  const stock_qty = (p.variants || []).reduce((s, v) =>
    s + (Number.isFinite(v.inventory_quantity) ? v.inventory_quantity : 0), 0);

  const link = p.handle ? `https://${storeUrl}/products/${p.handle}` : '';

  return { name: String(p.title || '').trim(), price, colors, sizes, image, stock_qty, link };
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
    // الأعمدة الموجودة فعلاً — لو تعذّر معرفتها نكتفي بالأساسي المضمون
    const cols = await getTableColumns('products');
    const has = (c) => (cols ? cols.has(c) : ['id', 'name', 'image'].includes(c));
    // نتعامل فقط مع الحقول الموجودة (الاسم والصورة أساسيان دائماً)
    const writable = ['name', 'image', 'price', 'colors', 'sizes', 'stock_qty', 'link'].filter(has);
    const onlyCols = (obj) => {
      const out = {};
      for (const k of writable) if (obj[k] !== undefined) out[k] = obj[k];
      return out;
    };

    const shopifyProducts = await fetchAllShopifyProducts(storeUrl, token);
    const mapped = shopifyProducts
      .map(p => mapProduct(p, storeUrl))
      .filter(p => p.name);

    // المنتجات الموجودة حالياً (للمطابقة بالاسم) — نختار الأعمدة الموجودة فقط
    const selectCols = ['id', 'name', 'image', 'price', 'link', 'sizes', 'colors'].filter(has);
    if (!selectCols.includes('id')) selectCols.unshift('id');
    if (!selectCols.includes('name')) selectCols.push('name');
    const existing = await supabaseRequest('GET', `products?select=${selectCols.join(',')}`);
    const byName = new Map();
    (existing || []).forEach(p => byName.set(normName(p.name), p));

    const toInsert = [];
    let inserted = 0, updated = 0, skipped = 0;

    for (const prod of mapped) {
      const found = byName.get(normName(prod.name));
      if (!found) {
        toInsert.push(onlyCols(prod));
        continue;
      }
      // موجود: حدّث الصورة (الهدف الأساسي) وأكمل الناقص فقط، مع الحفاظ على البيانات اليدوية
      const patch = {};
      if (has('image') && prod.image && prod.image !== found.image) patch.image = prod.image;
      if (has('link') && prod.link && !found.link) patch.link = prod.link;
      if (has('sizes') && prod.sizes && !found.sizes) patch.sizes = prod.sizes;
      if (has('colors') && prod.colors && !found.colors) patch.colors = prod.colors;
      if (has('price') && prod.price && !(Number(found.price) > 0)) patch.price = prod.price;
      if (Object.keys(patch).length > 0) {
        await supabaseRequest('PATCH', `products?id=eq.${found.id}`, patch);
        updated++;
      } else {
        skipped++;
      }
    }

    if (toInsert.length > 0) {
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
