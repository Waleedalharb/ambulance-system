/**
 * Frontend Error Reporter — EMS Platform
 * يلتقط كل أخطاء JavaScript في المتصفح ويرسلها للسيرفر
 * يُحمّل في صفحة index.html
 */
(function() {
    'use strict';

    // ==========================
    // التكوين
    // ==========================
    var CONFIG = {
        endpoint: '/api/frontend-errors',
        batchSize: 5,           // عدد الأخطاء قبل الإرسال
        flushInterval: 10000,   // إرسال كل 10 ثواني
        maxQueue: 50,           // الحد الأقصى للأخطاء المخزنة
        debounceMs: 1000        // تجميع الأخطاء المتكررة خلال ثانية
    };

    var queue = [];
    var seenErrors = {};       // dedup: error message → last timestamp
    var flushTimer = null;
    var sessionId = generateSessionId();

    // ==========================
    // أدوات مساعدة
    // ==========================
    function generateSessionId() {
        return 'fe_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 6);
    }

    function getAuthToken() {
        if (typeof AuthManager !== 'undefined' && AuthManager.getToken) {
            return AuthManager.getToken() || '';
        }
        return '';
    }

    function getPageInfo() {
        return {
            url: window.location.href,
            path: window.location.pathname,
            userAgent: navigator.userAgent,
            screen: screen.width + 'x' + screen.height,
            language: navigator.language,
            online: navigator.onLine,
            timestamp: new Date().toISOString()
        };
    }

    // ==========================
    // إرسال الأخطاء
    // ==========================
    async function flushErrors() {
        if (queue.length === 0) return;
        // AuthGate: لا إرسال قبل المصادقة — تبقى الأخطاء في الطابور حتى تسجيل الدخول
        if (!getAuthToken()) return;
        var batch = queue.splice(0, queue.length);

        try {
            var payload = { errors: batch, sessionId: sessionId };
            await AuthManager.apiRequest(CONFIG.endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        } catch (e) {
            // لو فشل الإرسال، أعد الأخطاء للـ queue
            if (queue.length + batch.length <= CONFIG.maxQueue) {
                queue.unshift.apply(queue, batch);
            }
        }
    }

    function scheduleFlush() {
        if (flushTimer) return;
        flushTimer = setTimeout(function() {
            flushTimer = null;
            flushErrors();
        }, CONFIG.flushInterval);
    }

    function enqueue(error) {
        // Dedup: لو نفس الخطأ ظهر قبل أقل من debounceMs، تخطاه
        var key = error.message + '|' + error.file + '|' + error.line;
        var now = Date.now();
        if (seenErrors[key] && (now - seenErrors[key]) < CONFIG.debounceMs) return;
        seenErrors[key] = now;

        queue.push(error);
        if (queue.length >= CONFIG.batchSize) {
            flushErrors();
        } else {
            scheduleFlush();
        }
    }

    // ==========================
    // التقاط الأخطاء
    // ==========================

    // 1. window.onerror — SyntaxError, ReferenceError, TypeError
    window.onerror = function(message, file, line, col, error) {
        enqueue({
            type: 'window.onerror',
            message: message,
            file: file,
            line: line,
            column: col,
            stack: error && error.stack ? error.stack : null,
            page: getPageInfo()
        });
        // لا نمنع المعالج الأصلي
        return false;
    };

    // 2. window.addEventListener('error') — أخطاء الموارد
    window.addEventListener('error', function(event) {
        var target = event.target;
        var isResourceError = target && (target.tagName === 'IMG' || target.tagName === 'SCRIPT' || target.tagName === 'LINK');
        enqueue({
            type: isResourceError ? 'resource_error' : 'event_error',
            message: event.message || (isResourceError ? 'Failed to load ' + target.tagName + ': ' + (target.src || target.href) : 'Unknown error'),
            file: event.filename || (isResourceError ? (target.src || target.href) : null),
            line: event.lineno || null,
            column: event.colno || null,
            stack: event.error && event.error.stack ? event.error.stack : null,
            page: getPageInfo()
        });
    }, true);

    // 3. unhandledrejection — Promises مرفوضة
    window.addEventListener('unhandledrejection', function(event) {
        var reason = event.reason;
        var message = reason instanceof Error ? reason.message : String(reason);
        enqueue({
            type: 'unhandledrejection',
            message: message,
            file: null,
            line: null,
            column: null,
            stack: reason instanceof Error ? reason.stack : null,
            page: getPageInfo()
        });
    });

    // 4. console.error override — تتبع console.error
    var originalConsoleError = console.error;
    console.error = function() {
        var args = Array.prototype.slice.call(arguments);
        var message = args.map(function(a) {
            return typeof a === 'object' ? JSON.stringify(a).substring(0, 500) : String(a);
        }).join(' ');

        enqueue({
            type: 'console.error',
            message: message.substring(0, 500),
            file: null,
            line: null,
            column: null,
            stack: null,
            page: getPageInfo()
        });

        originalConsoleError.apply(console, args);
    };

    // 5. AuthManager event tracking — تتبع أحداث المصادقة
    if (typeof AuthManager !== 'undefined' && AuthManager.onAuthEvent) {
        AuthManager.onAuthEvent(function(event) {
            enqueue({
                type: 'auth_event',
                message: 'Auth event: ' + event.type,
                file: null,
                line: null,
                column: null,
                stack: event.detail ? JSON.stringify(event.detail).substring(0, 500) : null,
                page: getPageInfo()
            });
        });
    }

    // 6. WebSocket errors — أخطاء الـ WebSocket
    var OriginalWebSocket = window.WebSocket;
    window.WebSocket = function(url, protocols) {
        var ws = protocols ? new OriginalWebSocket(url, protocols) : new OriginalWebSocket(url);
        ws.addEventListener('error', function(event) {
            enqueue({
                type: 'websocket_error',
                message: 'WebSocket error on ' + url,
                file: null,
                line: null,
                column: null,
                stack: null,
                page: getPageInfo()
            });
        });
        return ws;
    };

    // ==========================
    // إرسال قبل إغلاق الصفحة
    // ==========================
    window.addEventListener('beforeunload', function() {
        if (queue.length > 0) {
            // استخدم sendBeacon لو متاح
            if (navigator.sendBeacon) {
                var token = getAuthToken();
                var payload = { errors: queue, sessionId: sessionId };
                if (token) payload.token = token;
                navigator.sendBeacon(CONFIG.endpoint, JSON.stringify(payload));
            }
        }
    });

    // ==========================
    // فحص دوري للـ API errors
    // ==========================
    // يراقب لوحة التحكم في console.errors
    setInterval(function() {
        // تنظيف seenErrors القديمة (>5 دقايق)
        var now = Date.now();
        for (var key in seenErrors) {
            if (now - seenErrors[key] > 300000) delete seenErrors[key];
        }
    }, 300000);

    // ==========================
    // Fix 7: مسح الـ cache القديم في localStorage (>30 يوم)
    // ==========================
    function clearOldCache() {
        var thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
        var cacheKeys = [];
        var knownCachePrefixes = ['_cache', 'cached_', 'temp_', '_tmp', 'old_'];
        for (var i = 0; i < localStorage.length; i++) {
            var key = localStorage.key(i);
            if (!key) continue;
            var isCacheKey = false;
            for (var p = 0; p < knownCachePrefixes.length; p++) {
                if (key.indexOf(knownCachePrefixes[p]) === 0) {
                    isCacheKey = true;
                    break;
                }
            }
            if (!isCacheKey) continue;
            try {
                var item = localStorage.getItem(key);
                var parsed = JSON.parse(item);
                if (parsed && parsed.timestamp && parsed.timestamp < thirtyDaysAgo) {
                    cacheKeys.push(key);
                }
            } catch (e) {
                // Not JSON or no timestamp, skip
            }
        }
        for (var j = 0; j < cacheKeys.length; j++) {
            localStorage.removeItem(cacheKeys[j]);
        }
        if (cacheKeys.length > 0) {
            console.log('[FrontendMonitor] Cleared old cache items:', cacheKeys);
        }
    }

    // Run cache cleanup on startup and every 24 hours
    clearOldCache();
    setInterval(clearOldCache, 24 * 60 * 60 * 1000);

    console.log('[FrontendMonitor] Initialized | Session:', sessionId);
})();
