/* ============================================================
   مثال — انسخه إلى map-config.local.js (خارج Git) وعدّل القيم
   ------------------------------------------------------------
   provider:    'mapbox' لتفعيل رسم Mapbox، 'leaflet' للوضع القائم.
   accessToken: مفتاح Mapbox العام (pk.) مقيّد بنطاق المنصة —
                لا يُدرج في Git ولا يُخلط مع مفتاح تكامل CAD.
   style:       اختياري. بدون مفتاح يُستخدم النمط المؤقت المخفَّت
                المدمج في map-adapter.js (إثبات محلي فقط).
   ============================================================ */
window.SMAP_MAP_CONFIG = {
    provider: 'mapbox',
    accessToken: 'pk.PUT_YOUR_RESTRICTED_PUBLIC_TOKEN_HERE',
    style: 'mapbox://styles/mapbox/light-v11'
};
