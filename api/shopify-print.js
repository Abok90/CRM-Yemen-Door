// بيانات الطباعة (قائمة التجهيز + الفواتير) من شوبيفاي مباشرة:
// أسعار كل صنف، المتغير، صورة المنتج، العنوان الكامل وبيانات المتجر — بدل تخمينها من نص الأوردر.
const SHOPIFY_GRAPHQL_VERSION = '2026-01';

const QUERY = `query PrintOrders($ids: [ID!]!) {
  shop { name email contactEmail shopAddress { address1 address2 city province zip country phone } }
  nodes(ids: $ids) {
    ... on Order {
      legacyResourceId
      name
      createdAt
      shippingAddress { name address1 address2 city province zip country phone }
      billingAddress { name address1 address2 city province zip country phone }
      currentSubtotalPriceSet { shopMoney { amount } }
      totalShippingPriceSet { shopMoney { amount } }
      currentTotalTaxSet { shopMoney { amount } }
      currentTotalPriceSet { shopMoney { amount } }
      totalReceivedSet { shopMoney { amount } }
      totalOutstandingSet { shopMoney { amount } }
      lineItems(first: 100) {
        nodes {
          title
          variantTitle
          currentQuantity
          image { url(transform: { maxWidth: 240 }) }
          originalUnitPriceSet { shopMoney { amount } }
        }
      }
    }
  }
}`;

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const money = (set) => {
  const n = parseFloat(set && set.shopMoney && set.shopMoney.amount);
  return isNaN(n) ? 0 : n;
};

const addressLines = (a) => {
  if (!a) return [];
  return [a.name, a.address1, a.address2, a.city, a.province, a.zip, a.country]
    .map(x => (x == null ? '' : String(x)).trim())
    .filter(x => x && x !== '-');
};

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const authToken = req.headers['x-crm-auth'] || '';
  if (!authToken) return res.status(401).json({ error: 'Unauthorized' });
  const authRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${authToken}` },
  });
  if (!authRes.ok) return res.status(401).json({ error: 'Invalid session' });

  let body;
  try { body = JSON.parse((await readRawBody(req)).toString('utf8')); }
  catch { return res.status(400).json({ error: 'Invalid JSON' }); }

  const ids = Array.from(new Set((body && body.ids || []).map(x => String(x).trim()).filter(x => /^\d+$/.test(x))));
  if (!ids.length) return res.status(400).json({ error: 'Missing: ids' });

  const storeUrl = process.env.SHOPIFY_STORE_URL;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!storeUrl || !token) return res.status(500).json({ error: 'Store credentials not configured' });

  try {
    let shop = null;
    const orders = [];
    // nodes() بيقبل لحد 250 ID، بنقسمها 50 عشان تكلفة الاستعلام تفضل قليلة
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50).map(id => `gid://shopify/Order/${id}`);
      const r = await fetch(`https://${storeUrl}/admin/api/${SHOPIFY_GRAPHQL_VERSION}/graphql.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify({ query: QUERY, variables: { ids: chunk } }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.errors) throw new Error(`Shopify ${r.status}: ${JSON.stringify(data.errors || data).slice(0, 300)}`);

      if (!shop && data.data.shop) {
        const s = data.data.shop;
        const a = s.shopAddress || {};
        shop = {
          name: s.name,
          email: s.contactEmail || s.email || '',
          city: a.city || a.address1 || '',
          lines: [s.name, a.address1, a.address2, a.city, a.province, a.zip, a.country, a.phone]
            .map(x => (x == null ? '' : String(x)).trim()).filter(Boolean),
        };
      }

      for (const o of data.data.nodes || []) {
        if (!o || !o.legacyResourceId) continue;
        const ship = o.shippingAddress || o.billingAddress;
        orders.push({
          shopifyOrderId: String(o.legacyResourceId),
          name: o.name,
          createdAt: o.createdAt,
          shipTo: addressLines(o.shippingAddress || o.billingAddress),
          billTo: addressLines(o.billingAddress || o.shippingAddress),
          phone: (ship && ship.phone) || '',
          subtotal: money(o.currentSubtotalPriceSet),
          shipping: money(o.totalShippingPriceSet),
          tax: money(o.currentTotalTaxSet),
          total: money(o.currentTotalPriceSet),
          paid: money(o.totalReceivedSet),
          outstanding: money(o.totalOutstandingSet),
          items: (o.lineItems.nodes || [])
            .filter(li => li.currentQuantity > 0)
            .map(li => ({
              title: li.title,
              variant: li.variantTitle && li.variantTitle !== 'Default Title' ? li.variantTitle : '',
              qty: li.currentQuantity,
              unitPrice: money(li.originalUnitPriceSet),
              image: (li.image && li.image.url) || '',
            })),
        });
      }
    }
    return res.status(200).json({ ok: true, shop, orders });
  } catch (err) {
    console.error(`[print] Error: ${err.message}`);
    return res.status(200).json({ ok: false, error: err.message });
  }
}

module.exports = handler;
