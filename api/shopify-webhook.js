const crypto = require('crypto');
const {
  buildOrderRow, applyShopifyUpdate, fetchShopifyOrder,
  supabaseRequest, orderFilter, statusFilter, isCancelled,
} = require('../lib/shopify-order');

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

// أوردر جديد: upsert عشان لو شوبيفاي كرر الإرسال (retry) ميطلعش خطأ تكرار
async function insertOrder(order) {
  const row = buildOrderRow(order);
  await supabaseRequest('POST', 'orders?on_conflict=id', row, 'resolution=ignore-duplicates,return=minimal');
  // لو كان موجود قبل كده (retry أو سباق مع orders/updated) نحدّث بياناته من شوبيفاي
  await applyShopifyUpdate(order);
  return row.id;
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

  let payload;
  try { payload = JSON.parse(rawBody.toString('utf8')); }
  catch { return res.status(400).json({ error: 'Invalid JSON' }); }

  try {
    if (topic === 'orders/create') {
      const id = await insertOrder(payload);
      console.log(`[webhook] created ${id}`);

    } else if (topic === 'orders/updated' || topic === 'orders/cancelled' || topic === 'orders/fulfilled' || topic === 'orders/partially_fulfilled') {
      // تشخيص بدون قيم شخصية: هل الـ payload فيه تفاصيل العنوان؟
      const sa = payload.shipping_address || {};
      console.log(`[webhook] addr-diag ${payload.name} shipping=[${Object.keys(sa).filter(k => sa[k] != null && String(sa[k]).trim() !== '')}]`);
      await applyShopifyUpdate(payload);
      console.log(`[webhook] ${topic} ${payload.id}${isCancelled(payload) ? ' (cancelled)' : ''}`);

    } else if (topic === 'orders/edited') {
      // الـ payload هنا ملخص التعديل بس — بنجيب الأوردر كامل بعد التعديل (المنتجات المحذوفة/المضافة)
      const orderId = payload.order_edit && payload.order_edit.order_id;
      if (orderId) {
        const order = await fetchShopifyOrder(orderId);
        if (order) await applyShopifyUpdate(order);
        console.log(`[webhook] edited ${orderId}`);
      }

    } else if (topic === 'orders/paid') {
      // الدفع بعد الشحن = تحصيل → تم. الدفع أونلاين وقت الشراء ميغيّرش الحالة
      // (كان بيحوّل الأوردر "تم" قبل ما يتجهز ويختفي من قائمة التحضير)
      await supabaseRequest('PATCH', orderFilter(payload.id) + statusFilter({ in: ['الشحن'] }), { status: 'تم' });
      console.log(`[webhook] paid ${payload.id}`);

    } else if (topic === 'orders/delete') {
      await supabaseRequest('PATCH', orderFilter(payload.id) + statusFilter({ notIn: ['الغاء'] }), { status: 'الغاء' });
      console.log(`[webhook] deleted on Shopify ${payload.id} → الغاء`);

    } else {
      console.log(`[webhook] Ignored topic: ${topic}`);
    }
  } catch (err) {
    console.error(`[webhook] ${topic} error: ${err.message}`);
    // 500 → شوبيفاي يعيد المحاولة تلقائياً بدل ما التحديث يضيع
    return res.status(500).json({ ok: false, error: err.message });
  }

  return res.status(200).json({ ok: true });
}

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
