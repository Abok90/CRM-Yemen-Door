const { buildFullAddress, buildRegion, extractCustomer, SHOPIFY_API_VERSION } = require('../lib/shopify-order');
const { requireApprovedUser } = require('../lib/auth');
// بيانات الطباعة (قائمة التجهيز + الفواتير + شيت الشحن) من شوبيفاي مباشرة.
//
// الأصناف (أسعار/متغيرات/صور) من GraphQL، أما بيانات العميل والعنوان فمن REST:
// على خطة Basic شوبيفاي بيرفض طلب بيانات العميل الشخصية في GraphQL بخطأ، لكن في REST
// بيرجّع الأوردر عادي (مع إخفاء الحقول الشخصية). الحقول الإضافية (note_attributes)
// وملاحظة الأوردر بيوصلوا في الحالتين، وغالباً فيهم العنوان التفصيلي من فورم الطلب.

const QUERY = `query PrintOrders($ids: [ID!]!) {
  shop { name email contactEmail shopAddress { address1 address2 city province zip country phone } }
  nodes(ids: $ids) {
    ... on Order {
      legacyResourceId
      name
      createdAt
      cancelledAt
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

const REST_FIELDS = 'id,name,cancelled_at,phone,email,note,note_attributes,shipping_address,billing_address,customer';

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

// تشخيص (بدون أي قيم شخصية): أنهي حقول عنوان فيها بيانات، وأسماء الحقول الإضافية
function addressDiag(o) {
  const keys = (a) => a ? Object.keys(a).filter(k => a[k] != null && String(a[k]).trim() !== '') : [];
  const attrs = (o.note_attributes || []).map(a => `${a && a.name}(${a && a.value != null ? String(a.value).length : 0})`);
  return `order=${o.name} shipping=[${keys(o.shipping_address)}] billing=[${keys(o.billing_address)}] ` +
    `default=[${keys(o.customer && o.customer.default_address)}] note_attrs=[${attrs}] note_len=${(o.note || '').length}`;
}

async function fetchGraphql(storeUrl, token, ids) {
  const r = await fetch(`https://${storeUrl}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query: QUERY, variables: { ids } }),
  });
  const data = await r.json().catch(() => ({}));
  // أخطاء جزئية (حقل مرفوض) مش بتوقّع الطلب كله — نستخدم اللي رجع
  if (!r.ok || !data.data) throw new Error(`Shopify ${r.status}: ${JSON.stringify(data.errors || data).slice(0, 300)}`);
  if (data.errors) console.warn(`[print] GraphQL partial errors: ${JSON.stringify(data.errors).slice(0, 300)}`);
  return data.data;
}

async function fetchRest(storeUrl, token, ids) {
  const url = `https://${storeUrl}/admin/api/${SHOPIFY_API_VERSION}/orders.json?status=any&limit=250&ids=${ids.join(',')}&fields=${REST_FIELDS}`;
  const r = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
  if (!r.ok) throw new Error(`Shopify REST ${r.status}`);
  const data = await r.json().catch(() => ({}));
  return data.orders || [];
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const auth = await requireApprovedUser(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

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
    const byId = new Map();

    // (1) العميل والعنوان من REST
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const restOrders = await fetchRest(storeUrl, token, chunk);
      if (i === 0 && restOrders[0]) console.log(`[print] addr-diag ${addressDiag(restOrders[0])}`);
      for (const o of restOrders) {
        const { customer, phone, address } = extractCustomer(o);
        const s = o.shipping_address, b = o.billing_address, d = o.customer && o.customer.default_address;
        byId.set(String(o.id), {
          shopifyOrderId: String(o.id),
          name: o.name,
          cancelled: !!o.cancelled_at,
          customer: customer === 'عميل Shopify' ? '' : customer,
          phone,
          fullAddress: address,
          region: buildRegion(s, b, d, o.note_attributes),
          note: o.note || '',
          items: [], subtotal: 0, shipping: 0, tax: 0, total: 0, paid: 0, outstanding: 0,
        });
      }
    }

    // (2) الأصناف والمبالغ من GraphQL (لو فشل كله نكمل ببيانات REST بس)
    try {
      for (let i = 0; i < ids.length; i += 50) {
        const chunk = ids.slice(i, i + 50).map(id => `gid://shopify/Order/${id}`);
        const data = await fetchGraphql(storeUrl, token, chunk);
        if (!shop && data.shop) {
          const s = data.shop;
          const a = s.shopAddress || {};
          shop = {
            name: s.name,
            email: s.contactEmail || s.email || '',
            city: a.city || a.address1 || '',
            lines: [s.name, a.address1, a.address2, a.city, a.province, a.zip, a.country, a.phone]
              .map(x => (x == null ? '' : String(x)).trim()).filter(Boolean),
          };
        }
        for (const o of data.nodes || []) {
          if (!o || !o.legacyResourceId) continue;
          const row = byId.get(String(o.legacyResourceId)) || { shopifyOrderId: String(o.legacyResourceId), name: o.name, customer: '', phone: '', fullAddress: '', region: '', note: '' };
          Object.assign(row, {
            name: o.name || row.name,
            createdAt: o.createdAt,
            cancelled: row.cancelled || !!o.cancelledAt,
            subtotal: money(o.currentSubtotalPriceSet),
            shipping: money(o.totalShippingPriceSet),
            tax: money(o.currentTotalTaxSet),
            total: money(o.currentTotalPriceSet),
            paid: money(o.totalReceivedSet),
            outstanding: money(o.totalOutstandingSet),
            items: ((o.lineItems && o.lineItems.nodes) || [])
              .filter(li => li.currentQuantity > 0)
              .map(li => ({
                title: li.title,
                variant: li.variantTitle && li.variantTitle !== 'Default Title' ? li.variantTitle : '',
                qty: li.currentQuantity,
                unitPrice: money(li.originalUnitPriceSet),
                image: (li.image && li.image.url) || '',
              })),
          });
          byId.set(String(o.legacyResourceId), row);
        }
      }
    } catch (gqlErr) {
      console.error(`[print] GraphQL failed, using REST data only: ${gqlErr.message}`);
    }

    const orders = Array.from(byId.values()).map(o => ({
      ...o,
      shipTo: [o.customer, o.fullAddress].filter(Boolean),
      billTo: [o.customer, o.fullAddress].filter(Boolean),
      hasItems: o.items.length > 0,
    }));
    return res.status(200).json({ ok: true, shop, orders });
  } catch (err) {
    console.error(`[print] Error: ${err.message}`);
    return res.status(200).json({ ok: false, error: err.message });
  }
}

module.exports = handler;
