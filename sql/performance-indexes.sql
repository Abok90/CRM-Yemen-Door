-- ============================================================
--  فهارس تسريع قاعدة بيانات CRM Yemen Door
--  الهدف: إنهاء بطء التحميل و "statement timeout" على جدول orders
--
--  طريقة التشغيل:
--   Supabase Dashboard → SQL Editor → الصق الكود كله → Run
--   (شغّله مرة واحدة. آمن لإعادة التشغيل بسبب IF NOT EXISTS)
-- ============================================================

-- امتداد البحث النصّي السريع (لازم للبحث بـ ILIKE)
create extension if not exists pg_trgm;

-- 1) ترتيب وفلترة الأوردرات بالتاريخ (القائمة الرئيسية + فلتر آخر 90 يوم)
create index if not exists idx_orders_created_at
  on public.orders (created_at desc);

-- 2) إحصائيات الحالة (count حسب status + إيرادات "تم")
create index if not exists idx_orders_status
  on public.orders (status);

-- 3) فلتر صلاحيات الموظف (page) + الترتيب
create index if not exists idx_orders_page_created
  on public.orders (page, created_at desc);

-- 4) فهرس مركّب يغطي قائمة الحالة مع الترتيب
create index if not exists idx_orders_status_created
  on public.orders (status, created_at desc);

-- 5) فهارس البحث السريع (ILIKE %...%) — trigram GIN
create index if not exists idx_orders_customer_trgm
  on public.orders using gin (customer gin_trgm_ops);
create index if not exists idx_orders_phone_trgm
  on public.orders using gin (phone gin_trgm_ops);
create index if not exists idx_orders_item_trgm
  on public.orders using gin (item gin_trgm_ops);
create index if not exists idx_orders_tracking_trgm
  on public.orders using gin ("trackingNumber" gin_trgm_ops);
create index if not exists idx_orders_id_trgm
  on public.orders using gin (id gin_trgm_ops);

-- 6) سجل النشاطات والسجلات المالية (ترتيب بالتاريخ)
create index if not exists idx_activity_logs_created
  on public.activity_logs (created_at desc);
create index if not exists idx_finance_records_date
  on public.finance_records (date desc);

-- تحديث إحصائيات المخطِّط بعد إنشاء الفهارس
analyze public.orders;
analyze public.activity_logs;
analyze public.finance_records;
