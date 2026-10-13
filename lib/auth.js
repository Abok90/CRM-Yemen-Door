// التحقق من مستخدم السيستم في الـ API: جلسة صالحة + حساب متوافق عليه من الإدارة.
// (قبل كده أي حد يعمل حساب جديد كان يقدر يكلّم الـ API قبل الموافقة — زي إلغاء أوردرات على شوبيفاي)
async function requireApprovedUser(req) {
  const token = req.headers['x-crm-auth'] || '';
  if (!token) return { ok: false, status: 401, error: 'Unauthorized' };

  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const userRes = await fetch(`${base}/auth/v1/user`, { headers: { apikey: key, Authorization: `Bearer ${token}` } });
  if (!userRes.ok) return { ok: false, status: 401, error: 'Invalid session' };
  const user = await userRes.json().catch(() => null);
  if (!user || !user.id) return { ok: false, status: 401, error: 'Invalid session' };

  const roleRes = await fetch(`${base}/rest/v1/user_roles?id=eq.${encodeURIComponent(user.id)}&select=id,role,is_approved`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  const rows = roleRes.ok ? await roleRes.json().catch(() => []) : [];
  const role = rows && rows[0];
  if (!role || !role.is_approved) return { ok: false, status: 403, error: 'الحساب لسه مستني موافقة الإدارة' };

  return { ok: true, user, role };
}

module.exports = { requireApprovedUser };
