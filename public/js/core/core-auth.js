/**
 * AuthCore - Shared Authentication Core (page-agnostic)
 * منصة إدارة العمليات الإسعافية – قطاع جنوب الرياض
 *
 * Generalized from public/js/auth-manager.js so that pages which do NOT load
 * the full AuthManager can still share the exact same token logic:
 * - SAME storage keys: 'auth_access_token' (primary) + legacy 'authToken'
 * - SAME refresh endpoint: POST /api/auth/refresh (body: { refreshToken })
 * - Writes BOTH token keys on refresh for backward compatibility
 *
 * Unlike auth-manager.js this module does NOT override window.fetch and does
 * NOT show any login UI; it is a dependency-free helper only.
 *
 * Load order: core-auth.js → core-toast.js → core-time.js
 *
 * Global API: window.AuthCore
 *   - getToken()                  → string|null (new key first, legacy fallback)
 *   - authHeaders(extra)          → headers object with Bearer token (if any)
 *   - apiRequest(url, options)    → fetch with Bearer + one 401→refresh→retry
 *   - setTokens(a, r, expiresIn)  → store tokens in BOTH keys
 *   - refresh()                   → manual token refresh (single-flight)
 */
(function(global) {
    'use strict';

    // ==========================================
    // CONSTANTS (identical to auth-manager.js)
    // ==========================================
    var STORAGE_KEYS = {
        ACCESS_TOKEN: 'auth_access_token',
        REFRESH_TOKEN: 'auth_refresh_token',
        TOKEN_EXPIRES: 'auth_token_expires'
    };

    // Backward compatibility: old system used 'authToken' key
    var LEGACY_TOKEN_KEY = 'authToken';

    var API_BASE = '';
    var TOKEN_REFRESH_MARGIN = 5 * 60 * 1000; // 5 minutes before expiry (كما في auth-manager)
    var PROACTIVE_CHECK_MS = 60 * 1000;       // فحص دقيق كل دقيقة في الخلفية

    // ==========================================
    // STATE
    // ==========================================
    var _originalFetch = global.fetch.bind(global);
    var _isRefreshing = false;
    var _refreshPromise = null;
    var _proactiveTimer = null;

    // ==========================================
    // PRIVATE HELPERS
    // ==========================================

    function _getStorageItem(key) {
        try {
            return localStorage.getItem(key);
        } catch (e) {
            return null;
        }
    }

    function _setStorageItem(key, value) {
        try {
            localStorage.setItem(key, value);
        } catch (e) {
            // Storage full or disabled
        }
    }

    function _isAuthEndpoint(url) {
        if (typeof url !== 'string') return false;
        return url.indexOf('/api/auth/login') !== -1 ||
               url.indexOf('/api/auth/refresh') !== -1 ||
               url.indexOf('/api/auth/logout') !== -1;
    }

    function _parseJwt(token) {
        try {
            var base64Url = token.split('.')[1];
            var base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
            var jsonPayload = decodeURIComponent(atob(base64).split('').map(function(c) {
                return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
            }).join(''));
            return JSON.parse(jsonPayload);
        } catch (e) {
            return null;
        }
    }

    // هل الـ access token منتهٍ أو على وشك (ضمن الهامش)؟ — JWT أولًا ثم الختم المخزن
    function _isAccessExpiringSoon() {
        var token = _getAccessToken();
        if (!token) return true;
        var payload = _parseJwt(token);
        if (payload && payload.exp) return (payload.exp * 1000 - Date.now()) < TOKEN_REFRESH_MARGIN;
        var stored = _getStorageItem(STORAGE_KEYS.TOKEN_EXPIRES);
        if (stored) return (parseInt(stored, 10) - Date.now()) < TOKEN_REFRESH_MARGIN;
        return false;
    }

    // ==========================================
    // TOKEN MANAGEMENT
    // ==========================================

    function _getAccessToken() {
        // Try new key first, then fall back to legacy key (same as auth-manager.js)
        var token = _getStorageItem(STORAGE_KEYS.ACCESS_TOKEN);
        if (!token) {
            token = _getStorageItem(LEGACY_TOKEN_KEY);
            if (token) {
                // Migrate legacy token to new key (same as auth-manager.js)
                _setStorageItem(STORAGE_KEYS.ACCESS_TOKEN, token);
            }
        }
        return token;
    }

    function _setTokens(accessToken, refreshToken, expiresIn) {
        _setStorageItem(STORAGE_KEYS.ACCESS_TOKEN, accessToken);
        // Also store in legacy key for backward compatibility with old pages
        _setStorageItem(LEGACY_TOKEN_KEY, accessToken);
        if (refreshToken) {
            _setStorageItem(STORAGE_KEYS.REFRESH_TOKEN, refreshToken);
        }
        var expiresAt = Date.now() + ((expiresIn || 900) * 1000);
        _setStorageItem(STORAGE_KEYS.TOKEN_EXPIRES, expiresAt.toString());
    }

    // ==========================================
    // REFRESH TOKEN (single-flight, same flow as auth-manager.js)
    // ==========================================

    function _doRefresh() {
        if (_isRefreshing) {
            return _refreshPromise;
        }

        var refreshToken = _getStorageItem(STORAGE_KEYS.REFRESH_TOKEN);
        if (!refreshToken) {
            return Promise.reject(new Error('No refresh token'));
        }

        _isRefreshing = true;

        _refreshPromise = _originalFetch(API_BASE + '/api/auth/refresh', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken: refreshToken })
        }).then(function(response) {
            if (!response.ok) {
                // 401/403 = refresh token نفسه منتهٍ/ملغى/الجلسة غير نشطة — فشل نهائي
                // (يميَّز بـ code حتى لا يُعامل كعطل شبكة عابر ولا يُعاد بصمت للأبد)
                var err = new Error('Refresh failed: ' + response.status);
                if (response.status === 401 || response.status === 403) err.code = 'REFRESH_INVALID';
                throw err;
            }
            return response.json();
        }).then(function(data) {
            if (data.success && data.accessToken) {
                // Writes BOTH 'auth_access_token' and legacy 'authToken'
                _setTokens(data.accessToken, data.refreshToken, data.expiresIn || 900);
                _isRefreshing = false;
                return data.accessToken;
            }
            throw new Error(data.error || 'Refresh failed');
        }).catch(function(error) {
            _isRefreshing = false;
            throw error;
        });

        return _refreshPromise;
    }

    // ==========================================
    // PROACTIVE REFRESH — تجديد استباقي في الخلفية (بقرار المالك)
    // كل دقيقة: إن كان الـ access token منتهيًا/قارب ويوجد refresh token صالح
    // ⇒ جدّد بصمت. الأعطال العابرة تُتجاهل وتُعاد المحاولة بعد دقيقة؛
    // لا رسالة ولا خروج طالما الـ refresh token صالح.
    // ==========================================
    function startProactiveRefresh() {
        if (_proactiveTimer) return; // مؤقت واحد فقط
        _proactiveTimer = setInterval(function() {
            try {
                if (!_getStorageItem(STORAGE_KEYS.REFRESH_TOKEN)) return;
                if (!_isAccessExpiringSoon()) return;
                _doRefresh().catch(function() { /* عابر — يُعاد تلقائيًا بعد دقيقة */ });
            } catch (e) { /* لا شيء — الخلفية لا تسقط الصفحة */ }
        }, PROACTIVE_CHECK_MS);
        // فحص فوري عند التشغيل (تغطية فتح صفحة بتوكن منتهٍ)
        try {
            if (_getStorageItem(STORAGE_KEYS.REFRESH_TOKEN) && _isAccessExpiringSoon()) {
                _doRefresh().catch(function() { /* عابر */ });
            }
        } catch (e) { /* تجاهل */ }
    }

    // ==========================================
    // API REQUEST (Bearer + one 401→refresh→retry)
    // ==========================================

    function _buildOptions(options) {
        options = options || {};
        var headers = Object.assign({}, options.headers || {});
        var token = _getAccessToken();
        if (token) {
            headers['Authorization'] = 'Bearer ' + token;
        }
        if (!headers['Content-Type'] && options.body && typeof options.body === 'string') {
            headers['Content-Type'] = 'application/json';
        }
        return Object.assign({}, options, { headers: headers });
    }

    function _apiRequest(url, options) {
        return _originalFetch(url, _buildOptions(options)).then(function(response) {
            // 401 - attempt ONE refresh then retry once (skip for auth endpoints)
            if (response.status === 401 && !_isAuthEndpoint(url)) {
                if (!_getStorageItem(STORAGE_KEYS.REFRESH_TOKEN)) {
                    // No refresh token available: return the 401 response unchanged
                    return response;
                }
                return _doRefresh().then(function() {
                    // Retry once with the fresh token
                    return _originalFetch(url, _buildOptions(options));
                }).catch(function() {
                    // Refresh failed: return the original 401 response unchanged
                    return response;
                });
            }
            return response;
        });
    }

    // ==========================================
    // PUBLIC API
    // ==========================================

    global.AuthCore = {
        getToken: function() {
            return _getAccessToken();
        },

        authHeaders: function(extra) {
            var headers = {};
            var token = _getAccessToken();
            if (token) {
                headers['Authorization'] = 'Bearer ' + token;
            }
            if (extra) {
                for (var k in extra) {
                    if (Object.prototype.hasOwnProperty.call(extra, k)) {
                        headers[k] = extra[k];
                    }
                }
            }
            return headers;
        },

        apiRequest: function(url, options) {
            return _apiRequest(url, options);
        },

        setTokens: function(accessToken, refreshToken, expiresIn) {
            _setTokens(accessToken, refreshToken, expiresIn);
        },

        refresh: function() {
            return _doRefresh();
        },

        // --- Require Auth (page gate) ---
        // No token → redirect to the main page (which shows the login overlay).
        requireAuth: function(redirectTo) {
            if (!_getAccessToken()) {
                global.location.href = redirectTo || '/';
                return false;
            }
            startProactiveRefresh(); // بوابة الصفحة = انطلاق التجديد الاستباقي أيضًا
            return true;
        },

        // --- Proactive background refresh (idempotent) ---
        startProactiveRefresh: startProactiveRefresh
    };

    // انطلاق تلقائي عند تحميل الوحدة إن وُجدت جلسة — أي صفحة تضمّن core-auth
    // تحصل على التجديد الاستباقي بلا أي سطر إضافي
    try {
        if (_getStorageItem(STORAGE_KEYS.REFRESH_TOKEN)) startProactiveRefresh();
    } catch (e) { /* تجاهل */ }

})(window);
