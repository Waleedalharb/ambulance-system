/* ============================================================
   app-capacitor.js — جسر الكشف عن بيئة التطبيق الأصلي (المرحلة 1)
   - يكشف هل نعمل داخل Capacitor (iOS/Android) أم متصفح عادي
   - يضيف class على <html>: is-capacitor أو is-browser
   - يضبط نمط شريط الحالة على iOS عند توفر البلجن
   - لا يفعل شيئًا داخل المتصفح (آمن تمامًا)
   ============================================================ */
(function () {
    'use strict';

    var isNative = false;
    var platform = 'browser';

    try {
        if (window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function') {
            isNative = !!window.Capacitor.isNativePlatform();
            platform = (window.Capacitor.getPlatform && window.Capacitor.getPlatform()) || 'native';
        }
    } catch (_) { /* المتصفح العادي — لا شيء */ }

    var root = document.documentElement;
    root.classList.add(isNative ? 'is-capacitor' : 'is-browser');
    root.dataset.platform = platform;

    /* واجهة عامة بسيطة للصفحات */
    window.AppShell = {
        isNative: isNative,
        platform: platform,
        isIOS: platform === 'ios'
    };

    if (!isNative) return;

    /* نمط شريط الحالة: محتوى فاتح فوق خلفيتنا الداكنة */
    function setupStatusBar() {
        try {
            var plugins = window.Capacitor && window.Capacitor.Plugins;
            var sb = plugins && plugins.StatusBar;
            if (!sb) return;
            if (sb.setStyle) sb.setStyle({ style: 'DARK' });      // DARK = نصوص فاتحة
            if (sb.setOverlaysWebView) sb.setOverlaysWebView({ overlay: true });
            if (sb.setBackgroundColor) sb.setBackgroundColor({ color: '#070F20' });
        } catch (_) { /* البلجن غير مثبت بعد — لا مشكلة */ }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setupStatusBar);
    } else {
        setupStatusBar();
    }
})();
