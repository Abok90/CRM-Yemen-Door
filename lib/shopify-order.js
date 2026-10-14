// منطق تحويل أوردر شوبيفاي لصف في جدول orders — مصدر واحد يستخدمه الـ webhook والمزامنة
// (كانوا نسختين منفصلتين وبدأوا يختلفوا عن بعض).

const STORE_KEY = 'yemen_door';
const SHOPIFY_API_VERSION = '2026-01';

function normalizePhone(raw) {
  if (!raw) return '';
  let p = String(raw).replace(/[\s\-\(\)\.]/g, '');
  if (p.startsWith('+20')) p = '0' + p.slice(3);
  else if (p.startsWith('0020')) p = '0' + p.slice(4);
  else if (p.startsWith('+2')) p = '0' + p.slice(2);
  return p;
}

function findNoteAttr(noteAttrs, keys) {
  if (!noteAttrs || !noteAttrs.length) return '';
  for (const key of keys) {
    const found = noteAttrs.find(a => a.name && a.name.toLowerCase().includes(key.toLowerCase()));
    if (found && found.value) return String(found.value).trim();
  }
  return '';
}

// الكمية الفعلية للصنف بعد أي حذف من تعديل الأوردر أو استرجاع.
// شوبيفاي بيسيب الصنف المحذوف في line_items بس بيخلّي current_quantity = 0.
function effectiveQty(order, it) {
  if (Number.isFinite(it.current_quantity)) return it.current_quantity;
  const refunded = (order.refunds || []).reduce((sum, r) =>
    sum + (r.refund_line_items || [])
      .filter(rl => rl.line_item_id === it.id)
      .reduce((a, rl) => a + (rl.quantity || 0), 0), 0);
  return Math.max(0, (it.quantity || 0) - refunded);
}

function activeLineItems(order) {
  return (order.line_items || [])
    .map(it => ({ ...it, qty: effectiveQty(order, it) }))
    .filter(it => it.qty > 0);
}

function buildItemSummary(order) {
  const items = activeLineItems(order);
  const itemText = items.map(it => {
    const variant = it.variant_title && it.variant_title !== 'Default Title' ? it.variant_title : '';
    const name = variant ? `${it.title} - ${variant}` : it.title;
    return it.qty > 1 ? `${name} ×${it.qty}` : name;
  }).join('\n');
  const totalQty = items.reduce((sum, it) => sum + it.qty, 0);
  return { itemText, totalQty };
}

// إجمالي المنتجات بعد الخصومات والحذف (قبل الشحن)
function computeProductPrice(order) {
  const subtotalRaw = order.current_subtotal_price != null ? order.current_subtotal_price : order.subtotal_price;
  if (subtotalRaw != null && subtotalRaw !== '') {
    const subtotal = parseFloat(subtotalRaw);
    if (!isNaN(subtotal) && subtotal >= 0) return subtotal;
  }
  const items = activeLineItems(order);
  const gross = items.reduce((sum, it) => sum + parseFloat(it.price || 0) * it.qty, 0);
  const lineDiscounts = items.reduce((sum, it) =>
    sum + (it.discount_allocations || []).reduce((a, d) => a + parseFloat(d.amount || 0), 0), 0);
  const orderDiscounts = parseFloat(order.current_total_discounts || order.total_discounts || 0);
  return Math.max(0, gross - (lineDiscounts > 0 ? lineDiscounts : orderDiscounts));
}

function shippingPrice(order) {
  const set = order.total_shipping_price_set && order.total_shipping_price_set.shop_money;
  if (set && set.amount != null) return parseFloat(set.amount) || 0;
  return (order.shipping_lines || []).reduce((s, l) => s + (parseFloat(l.price) || 0), 0);
}

// فورمات الطلب (COD forms) كتير بتحفظ الشارع/العمارة/الشقة في حقول إضافية على الأوردر
// (note_attributes) وتسيب خانة العنوان في شوبيفاي فيها المدينة بس.
const ADDRESS_ATTR_KEYS = ['address', 'addr', 'street', 'building', 'apartment', 'apt', 'floor', 'landmark',
  'district', 'area', 'عنوان', 'العنوان', 'شارع', 'الشارع', 'عمارة', 'العمارة', 'برج', 'شقة', 'الشقة',
  'دور', 'الدور', 'علامة', 'مميزة', 'حي', 'الحي', 'منطقة', 'المنطقة', 'تفاصيل'];
const CITY_ATTR_KEYS = ['city', 'governorate', 'province', 'state', 'مدينة', 'المدينة', 'محافظة', 'المحافظة'];
const NON_ADDRESS_ATTR_KEYS = ['email', 'mail', 'phone', 'mobile', 'whatsapp', 'name', 'اسم', 'الاسم',
  'موبايل', 'هاتف', 'تليفون', 'واتس', 'ملاحظ', 'note', 'coupon', 'كوبون', 'utm', 'source', 'ip'];

const attrHas = (name, keys) => keys.some(k => name.includes(k));
function attrValues(noteAttrs, keys) {
  return (noteAttrs || [])
    .filter(a => a && a.name && a.value != null)
    .filter(a => {
      const n = String(a.name).toLowerCase();
      return attrHas(n, keys) && !attrHas(n, NON_ADDRESS_ATTR_KEYS);
    })
    .map(a => String(a.value).trim());
}

// دمج أجزاء العنوان بدون تكرار: جزء موجود جوه جزء أطول بيتشال
function mergeAddressParts(list) {
  const out = [];
  for (const raw of list) {
    const p = (raw == null ? '' : String(raw)).replace(/\s+/g, ' ').trim();
    if (!p || p === '-' || p === '.') continue;
    const lp = p.toLowerCase();
    if (out.some(x => x.toLowerCase() === lp || (lp.length >= 3 && x.toLowerCase().includes(lp)))) continue;
    for (let i = out.length - 1; i >= 0; i--) {
      const lx = out[i].toLowerCase();
      if (lx.length >= 3 && lp.includes(lx)) out.splice(i, 1);
    }
    out.push(p);
  }
  return out.join(' - ');
}

const hasAddr = (a) => a && (a.address1 || a.address2 || a.city || a.province);

// العنوان الكامل: تفاصيل العنوان + الحقول الإضافية + المدينة + المحافظة
function buildFullAddress(s, b, d, noteAttrs) {
  const a = hasAddr(s) ? s : hasAddr(b) ? b : hasAddr(d) ? d : {};
  const cityParts = [a.city, a.province];
  if (!a.city && !a.province) cityParts.push(...attrValues(noteAttrs, CITY_ATTR_KEYS));
  return mergeAddressParts([a.address1, a.address2, ...attrValues(noteAttrs, ADDRESS_ATTR_KEYS), ...cityParts, a.zip]);
}

// المنطقة (لخانة المنطقة في شيت الشحن): المدينة + المحافظة
function buildRegion(s, b, d, noteAttrs) {
  const a = hasAddr(s) ? s : hasAddr(b) ? b : hasAddr(d) ? d : {};
  const parts = [a.city, a.province];
  if (!a.city && !a.province) parts.push(...attrValues(noteAttrs, CITY_ATTR_KEYS));
  return mergeAddressParts(parts);
}

function extractCustomer(order) {
  const b = order.billing_address || {};
  const s = order.shipping_address || {};
  const c = order.customer || {};
  const d = c.default_address || {};
  const noteAttrs = order.note_attributes || [];
  const full = (x) => (x && x.first_name ? `${x.first_name} ${x.last_name || ''}`.trim() : '');

  const customer = s.name || b.name || full(s) || full(b) || d.name || full(d) || full(c) ||
    findNoteAttr(noteAttrs, ['name', 'اسم', 'الاسم', 'customer']) || 'عميل Shopify';
  const phone = normalizePhone(
    s.phone || b.phone || order.phone || c.phone || d.phone ||
    findNoteAttr(noteAttrs, ['phone', 'mobile', 'موبايل', 'الموبايل', 'هاتف', 'رقم']) || ''
  );
  const address = buildFullAddress(s, b, d, noteAttrs);
  return { customer, phone, address };
}

function isCancelled(order) {
  const tags = String(order.tags || '').split(',').map(t => t.trim().toLowerCase());
  return !!order.cancelled_at || tags.includes('cancelled_order');
}

// تاريخ الأوردر بصيغة YYYY-MM-DD بتوقيت القاهرة (نفس صيغة باقي السيستم)
function orderDate(order) {
  const dt = order.created_at ? new Date(order.created_at) : new Date();
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(dt);
  } catch {
    return dt.toISOString().slice(0, 10);
  }
}

// الحقول اللي شوبيفاي هو مصدرها — بتتحدث عند أي تعديل على الأوردر هناك
function shopifyOwnedFields(order) {
  const { customer, phone, address } = extractCustomer(order);
  const { itemText, totalQty } = buildItemSummary(order);
  // لو كل الأصناف اتشالت (غالباً أوردر ملغي) بنسيب المنتجات والسعر زي ما هما في السيستم
  // عشان يفضل معروف الأوردر كان فيه إيه — الحالة "الغاء" هي اللي بتوضح إنه اتلغى
  const fields = totalQty > 0
    ? { item: itemText, quantity: totalQty, productPrice: computeProductPrice(order), shippingPrice: shippingPrice(order) }
    : {};
  if (customer && customer !== 'عميل Shopify') fields.customer = customer;
  if (phone) fields.phone = phone;
  if (address) fields.address = address;
  return fields;
}

// صف كامل لأوردر جديد
function buildOrderRow(order) {
  const { customer, phone, address } = extractCustomer(order);
  let status = 'جاري التحضير';
  if (isCancelled(order)) status = 'الغاء';
  else if (order.fulfillment_status === 'fulfilled') status = 'الشحن';
  return {
    id: order.name || `#${order.order_number}`,
    customer, phone, address,
    ...shopifyOwnedFields(order),
    notes: order.note || '',
    status,
    page: 'يمن دور ويب',
    shopify_order_id: order.id,
    shopify_store: STORE_KEY,
    source: 'shopify',
    date: orderDate(order),
  };
}

// تحديث الحالة من شوبيفاي بدون ما نرجّع الأوردر لورا:
// الإلغاء بيتطبق دايماً (إلا لو اتعمله مرتجع/استبدال)، والشحن بس لو لسه قبل الشحن.
const PRE_SHIPPING = ['جاري التحضير', 'مراجعة', 'تاجيل'];
const NO_CANCEL_OVERRIDE = ['الغاء', 'مرتجع', 'استبدال'];

function statusUpdates(order) {
  const tags = String(order.tags || '').split(',').map(t => t.trim().toLowerCase());
  if (isCancelled(order)) return { status: 'الغاء', notIn: NO_CANCEL_OVERRIDE };
  if (tags.includes('collected')) return { status: 'تم', notIn: ['تم', 'الغاء', 'مرتجع', 'استبدال'] };
  if (order.fulfillment_status === 'fulfilled') return { status: 'الشحن', in: PRE_SHIPPING };
  return null;
}

// فلتر PostgREST لقائمة حالات (القيم عربي فلازم تتعمل encode)
const pgList = (arr) => `(${arr.map(v => `"${v}"`).join(',')})`;
function statusFilter(rule) {
  if (rule.in) return `&status=in.${encodeURIComponent(pgList(rule.in))}`;
  if (rule.notIn) return `&status=not.in.${encodeURIComponent(pgList(rule.notIn))}`;
  return '';
}

async function supabaseRequest(method, path, body, prefer) {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: prefer || (method === 'GET' ? 'return=representation' : 'return=minimal'),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Supabase ${method} failed: ${res.status} — ${await res.text()}`);
  if (method === 'GET') return res.json();
  return null;
}

const orderFilter = (shopifyId) => `orders?shopify_order_id=eq.${encodeURIComponent(shopifyId)}&shopify_store=eq.${STORE_KEY}`;

// تطبيق أي تعديل من شوبيفاي على أوردر موجود في السيستم (البيانات + الحالة بشروطها)
async function applyShopifyUpdate(order) {
  const fields = shopifyOwnedFields(order);
  if (Object.keys(fields).length) await supabaseRequest('PATCH', orderFilter(order.id), fields);
  const rule = statusUpdates(order);
  if (rule) await supabaseRequest('PATCH', orderFilter(order.id) + statusFilter(rule), { status: rule.status });
}

async function fetchShopifyOrder(orderId) {
  const r = await fetch(
    `https://${process.env.SHOPIFY_STORE_URL}/admin/api/${SHOPIFY_API_VERSION}/orders/${encodeURIComponent(orderId)}.json`,
    { headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN } }
  );
  if (!r.ok) throw new Error(`Shopify API error: ${r.status}`);
  const data = await r.json();
  return data.order;
}

module.exports = {
  STORE_KEY,
  SHOPIFY_API_VERSION,
  activeLineItems,
  buildItemSummary,
  computeProductPrice,
  extractCustomer,
  buildFullAddress,
  buildRegion,
  isCancelled,
  orderDate,
  shopifyOwnedFields,
  buildOrderRow,
  statusUpdates,
  statusFilter,
  supabaseRequest,
  orderFilter,
  applyShopifyUpdate,
  fetchShopifyOrder,
};
