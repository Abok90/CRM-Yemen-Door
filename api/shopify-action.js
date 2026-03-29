const SHOPIFY_API_VERSION = '2024-01';

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function shopify(method, path, token, storeUrl, body) {
  const res = await fetch(`https://${storeUrl}/admin/api/${SHOPIFY_API_VERSION}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Shopify ${method} ${path} → ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function fulfill(token, storeUrl, orderId) {
  const { fulfillment_orders = [] } = await shopify('GET', `/orders/${orderId}/fulfillment_orders.json`, token, storeUrl);
  for (const fo of fulfillment_orders) {
    if (fo.status === 'open') {
      await shopify('POST', '/fulfillments.json', token, storeUrl, {
        fulfillment: { line_items_by_fulfillment_order: [{ fulfillment_order_id: fo.id }], notify_customer: false },
      });
    }
  }
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const authToken = req.headers['x-crm-auth'] || '';
  if (!authToken) return res.status(401).json({ error: 'Unauthorized' });

  const authRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${authToken}` },
  });
  if (!authRes.ok) return res.status(401).json({ error: 'Invalid session' });

  let body;
  try {
    const raw = await readRawBody(req);
    body = JSON.parse(raw.toString('utf8'));
  } catch { return res.status(400).json({ error: 'Invalid JSON' }); }

  const { action, shopifyOrderId } = body || {};
  if (!action || !shopifyOrderId) return res.status(400).json({ error: 'Missing: action, shopifyOrderId' });

  const storeUrl = process.env.SHOPIFY_STORE_URL;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!storeUrl || !token) return res.status(500).json({ error: 'Store credentials not configured' });

  try {
    if (action === 'fulfill') {
      await fulfill(token, storeUrl, shopifyOrderId);
    } else if (action === 'cancel') {
      await shopify('POST', `/orders/${shopifyOrderId}/cancel.json`, token, storeUrl, {});
    } else if (action === 'complete') {
      // Shopify yghleq tlqyna bwd alshn
    } else {
      return res.status(400).json({ error: `Unknown action: ${action}` });
    }
    console.log(`[action] ${action} on ${shopifyOrderId} OK`);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(`[action] Error: ${err.message}`);
    return res.status(200).json({ ok: false, error: err.message });
  }
}

module.exports = handler;
