/* ============================================================
   app-capacitor.js — جسر الكشف عن بيئة التطبيق الأصلي (المرحلة 1)
   - يكشف هل نعمل داخل Capacitor (iOS/Android) أم متصفح عادي
   - يقيس Safe Area الفعلية ويحقنها كقيم px مضمونة في :root
   - يعالج لوحة المفاتيح عبر visualViewport (العناصر .kb-aware)
   - يضبط نمط شريط الحالة على iOS عند توفر البلجن
   - لا يفعل شيئًا ضارًا داخل المتصفح (آمن تمامًا)
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

    /* ===== قياس Safe Area الفعلية وحقنها كقيم px =====
       env() قد يرجع 0 في بعض السياقات؛ القياس الفعلي يضمن القيمة الحقيقية */
    function probeSafeArea() {
        try {
            var el = document.createElement('div');
            el.style.cssText = 'position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;' +
                'padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom);' +
                'padding-left:env(safe-area-inset-left);padding-right:env(safe-area-inset-right);';
            document.body.appendChild(el);
            var cs = getComputedStyle(el);
            var rs = root.style;
            rs.setProperty('--sa-top', cs.paddingTop);
            rs.setProperty('--sa-bottom', cs.paddingBottom);
            rs.setProperty('--sa-left', cs.paddingLeft);
            rs.setProperty('--sa-right', cs.paddingRight);
            el.parentNode.removeChild(el);
        } catch (_) { /* fallback: تبقى env() في المتغيرات */ }
    }

    /* ===== معالجة لوحة المفاتيح (iOS WebView لا يصغّر العناصر fixed) ===== */
    function bindKeyboard() {
        if (!window.visualViewport) return;
        var baseH = window.innerHeight;
        var apply = function () {
            var vv = window.visualViewport;
            root.style.setProperty('--vv-h', vv.height + 'px');
            var open = vv.height < baseH * 0.78;
            root.classList.toggle('kb-open', open);
            var els = document.querySelectorAll('.kb-aware');
            for (var i = 0; i < els.length; i++) {
                if (open) {
                    els[i].style.height = vv.height + 'px';
                    els[i].style.top = (vv.offsetTop || 0) + 'px';
                    els[i].style.bottom = 'auto';
                } else {
                    els[i].style.height = '';
                    els[i].style.top = '';
                    els[i].style.bottom = '';
                }
            }
        };
        window.visualViewport.addEventListener('resize', apply);
        window.visualViewport.addEventListener('scroll', apply);
    }

    function boot() {
        probeSafeArea();
        bindKeyboard();
        if (!isNative) return;
        /* نمط شريط الحالة: محتوى فاتح فوق خلفيتنا الداكنة */
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
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }

    /* إعادة القياس عند تدوير الجهاز أو تغيير الحجم */
    window.addEventListener('orientationchange', function () { setTimeout(probeSafeArea, 250); });
    window.addEventListener('resize', probeSafeArea);
})();
