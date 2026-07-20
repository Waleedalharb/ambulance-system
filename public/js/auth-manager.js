/**
 * Auth Manager - Central Authentication Manager
 * منصة إدارة العمليات الإسعافية – قطاع جنوب الرياض
 *
 * المسؤوليات:
 * - المصدر الوحيد لجميع حالات المصادقة في التطبيق
 * - اعتراض جميع طلبات fetch تلقائياً
 * - إدارة Access Token + Refresh Token
 * - معالجة 401/403 بشكل مركزي
 * - منع الطلبات المتكررة عند انتهاء الجلسة
 * - إصدار الأحداث للمكونات الأخرى
 *
 * لا يسمح لأي ملف آخر بالتعامل مباشرة مع التوكن.
 * جميع أجزاء النظام يجب أن تمر عبر هذا المدير.
 */

(function(global) {
    'use strict';

    // ==========================================
    // CONSTANTS
    // ==========================================
    var STORAGE_KEYS = {
        ACCESS_TOKEN: 'auth_access_token',
        REFRESH_TOKEN: 'auth_refresh_token',
        USER: 'auth_user',
        TOKEN_EXPIRES: 'auth_token_expires'
    };

    // Backward compatibility: old system used 'authToken' key
    var LEGACY_TOKEN_KEY = 'authToken';
    var LEGACY_USER_KEY = 'currentUser';

    var API_BASE = '';
    var TOKEN_REFRESH_MARGIN = 5 * 60 * 1000; // 5 minutes before expiry

    // ==========================================
    // STATE
    // ==========================================
    var _originalFetch = global.fetch.bind(global);
    var _isRefreshing = false;
    var _refreshPromise = null;
    var _pendingRequests = [];
    var _sessionExpired = false;
    var _authEventListeners = [];

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

    function _removeStorageItem(key) {
        try {
            localStorage.removeItem(key);
        } catch (e) {
            // Ignore
        }
    }

    function _emitEvent(type, detail) {
        var timestamp = new Date().toISOString();
        var event = { type: type, detail: detail || {}, timestamp: timestamp };
        for (var i = 0; i < _authEventListeners.length; i++) {
            try {
                _authEventListeners[i](event);
            } catch (e) {
                // Ignore listener errors
            }
        }
    }

    function _isTokenExpiringSoon() {
        var expiresAt = _getStorageItem(STORAGE_KEYS.TOKEN_EXPIRES);
        if (!expiresAt) return false;
        var expiresTime = parseInt(expiresAt, 10);
        return (expiresTime - Date.now()) < TOKEN_REFRESH_MARGIN;
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

    function _isAuthEndpoint(url) {
        if (typeof url !== 'string') return false;
        return url.indexOf('/api/auth/login') !== -1 ||
               url.indexOf('/api/auth/refresh') !== -1 ||
               url.indexOf('/api/auth/logout') !== -1;
    }

    // ==========================================
    // TOKEN MANAGEMENT
    // ==========================================

    function _getAccessToken() {
        // Try new key first, then fall back to legacy key
        var token = _getStorageItem(STORAGE_KEYS.ACCESS_TOKEN);
        if (!token) {
            token = _getStorageItem(LEGACY_TOKEN_KEY);
            if (token) {
                // Migrate legacy token to new key
                _setStorageItem(STORAGE_KEYS.ACCESS_TOKEN, token);
                console.log('[AuthManager] Migrated legacy token to new storage key');
            }
        }
        return token;
    }

    function _getRefreshToken() {
        return _getStorageItem(STORAGE_KEYS.REFRESH_TOKEN);
    }

    function _setTokens(accessToken, refreshToken, expiresIn) {
        _setStorageItem(STORAGE_KEYS.ACCESS_TOKEN, accessToken);
        // Also store in legacy key for backward compatibility with other pages
        _setStorageItem(LEGACY_TOKEN_KEY, accessToken);
        if (refreshToken) {
            _setStorageItem(STORAGE_KEYS.REFRESH_TOKEN, refreshToken);
        }
        var expiresAt = Date.now() + (expiresIn * 1000);
        _setStorageItem(STORAGE_KEYS.TOKEN_EXPIRES, expiresAt.toString());
    }

    function _clearTokens() {
        _removeStorageItem(STORAGE_KEYS.ACCESS_TOKEN);
        _removeStorageItem(LEGACY_TOKEN_KEY);
        _removeStorageItem(STORAGE_KEYS.REFRESH_TOKEN);
        _removeStorageItem(STORAGE_KEYS.USER);
        _removeStorageItem(LEGACY_USER_KEY);
        _removeStorageItem(STORAGE_KEYS.TOKEN_EXPIRES);
    }

    // ==========================================
    // LOGIN SCREEN
    // ==========================================

    function _showLoginScreen(message) {
        _sessionExpired = true;
        AuthGate.stop(); // فشل مصادقة نهائي — تفكيك كل الأنظمة التشغيلية
        _emitEvent('session_expired', { message: message || 'Session expired' });

        var loginScreen = document.getElementById('loginScreen');
        if (loginScreen) {
            var loginError = document.getElementById('loginError');
            if (loginError && message) {
                loginError.textContent = message;
                loginError.style.display = 'block';
            }
            loginScreen.style.display = 'flex';
        } else {
            if (confirm((message || 'انتهت صلاحية الجلسة') + '\nهل تريد تسجيل الدخول مرة أخرى؟')) {
                location.reload();
            }
        }
    }

    // ==========================================
    // REFRESH TOKEN
    // ==========================================

    function _doRefresh() {
        if (_isRefreshing) {
            return _refreshPromise;
        }

        var refreshToken = _getRefreshToken();
        if (!refreshToken) {
            _emitEvent('token_invalid', { reason: 'no_refresh_token' });
            return Promise.reject(new Error('No refresh token'));
        }

        _isRefreshing = true;

        _refreshPromise = _originalFetch(API_BASE + '/api/auth/refresh', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken: refreshToken })
        }).then(function(response) {
            if (!response.ok) {
                if (response.status === 401) {
                    _emitEvent('token_invalid', { reason: 'refresh_token_invalid', status: response.status });
                }
                throw new Error('Refresh failed: ' + response.status);
            }
            return response.json();
        }).then(function(data) {
            if (data.success && data.accessToken) {
                _setTokens(data.accessToken, data.refreshToken, data.expiresIn || 900);
                _isRefreshing = false;
                _sessionExpired = false;
                _emitEvent('refresh', { success: true });

                // Retry all pending requests
                var pending = _pendingRequests.slice();
                _pendingRequests = [];
                for (var i = 0; i < pending.length; i++) {
                    pending[i].resolve();
                }
                return data.accessToken;
            } else {
                throw new Error(data.error || 'Refresh failed');
            }
        }).catch(function(error) {
            _isRefreshing = false;
            _sessionExpired = true;
            _emitEvent('session_expired', { reason: error.message });

            // Reject all pending requests
            var pending = _pendingRequests.slice();
            _pendingRequests = [];
            for (var i = 0; i < pending.length; i++) {
                pending[i].reject(error);
            }

            _showLoginScreen('انتهت صلاحية الجلسة، يرجى تسجيل الدخول مرة أخرى');
            throw error;
        });

        return _refreshPromise;
    }

    // ==========================================
    // API REQUEST HANDLER (used by overridden fetch)
    // ==========================================

    function _apiRequest(url, options) {
        options = options || {};

        // If session is known to be expired, reject immediately (except auth endpoints)
        if (_sessionExpired && !_isAuthEndpoint(url)) {
            return Promise.reject(new Error('Session expired'));
        }

        // If a refresh is already in progress, queue this request (except auth endpoints)
        if (_isRefreshing && !_isAuthEndpoint(url)) {
            return new Promise(function(resolve, reject) {
                _pendingRequests.push({
                    resolve: function() {
                        _apiRequest(url, options).then(resolve).catch(reject);
                    },
                    reject: reject
                });
            });
        }

        var token = _getAccessToken();
        var headers = Object.assign({}, options.headers || {});

        if (token) {
            headers['Authorization'] = 'Bearer ' + token;
        }

        if (!headers['Content-Type'] && options.body && typeof options.body === 'string') {
            headers['Content-Type'] = 'application/json';
        }

        var fetchOptions = Object.assign({}, options, { headers: headers });

        return _originalFetch(url, fetchOptions).then(function(response) {
            // 403 - reject immediately, do NOT attempt refresh
            if (response.status === 403) {
                _emitEvent('access_denied', { url: url, status: 403 });
                return response.json().catch(function() {
                    return {};
                }).then(function(data) {
                    // إبطال/عدم صلاحية التوكن = نهاية جلسة نهائية (وليس رفض صلاحية عادي)
                    if (data.code === 'TOKEN_REVOKED' || data.code === 'TOKEN_INVALID') {
                        _clearTokens();
                        _showLoginScreen('انتهت الجلسة، يرجى تسجيل الدخول مرة أخرى');
                    }
                    return Promise.reject(new Error(data.error || 'Access denied'));
                });
            }

            // 401 - queue request and attempt ONE refresh (skip for auth endpoints)
            if (response.status === 401 && !_isAuthEndpoint(url)) {
                return new Promise(function(resolve, reject) {
                    _pendingRequests.push({
                        resolve: function() {
                            _apiRequest(url, options).then(resolve).catch(reject);
                        },
                        reject: reject
                    });
                    _doRefresh().catch(function() {
                        // Refresh failed; pending requests will be rejected by _doRefresh
                    });
                });
            }

            return response;
        }).catch(function(error) {
            if (error.message === 'Session expired') {
                _showLoginScreen('انتهت صلاحية الجلسة');
                throw error;
            }

            // Detect network errors from native fetch
            if (error.name === 'TypeError' ||
                error.message.indexOf('NetworkError') !== -1 ||
                error.message.indexOf('Failed to fetch') !== -1) {
                return Promise.reject(new Error('Network error: unable to connect to server. Please check your connection.'));
            }

            throw error;
        });
    }

    // ==========================================
    // AUTH GATE — مالك الإقلاع التشغيلي الموحّد
    // لا يعمل أي نظام تشغيلي (جلب، مؤقتات، SSE/WS) قبل المصادقة،
    // ويُفكَّك كل شيء عند الخروج أو انتهاء الجلسة.
    // ==========================================
    var AuthGate = (function() {
        var _state = 'anonymous'; // 'anonymous' | 'authenticated'
        var _startCallbacks = [];
        var _stopCallbacks = [];
        var _intervals = []; // { fn, ms, id }
        var _timeouts = [];  // { fn, ms, id, fired }

        function _armTimeout(rec) {
            rec.id = setTimeout(function() {
                rec.fired = true;
                rec.id = null;
                try { rec.fn(); } catch (e) { console.error('[AuthGate] timeout callback error:', e); }
            }, rec.ms);
        }

        function start() {
            if (_state === 'authenticated') return; // مرة واحدة بالضبط لكل تسجيل دخول
            _state = 'authenticated';
            var i;
            for (i = 0; i < _intervals.length; i++) {
                if (_intervals[i].id === null) {
                    _intervals[i].id = setInterval(_intervals[i].fn, _intervals[i].ms);
                }
            }
            for (i = 0; i < _timeouts.length; i++) {
                if (!_timeouts[i].fired && _timeouts[i].id === null) {
                    _armTimeout(_timeouts[i]);
                }
            }
            for (i = 0; i < _startCallbacks.length; i++) {
                try { _startCallbacks[i](); } catch (e) { console.error('[AuthGate] start callback error:', e); }
            }
        }

        function stop() {
            if (_state !== 'authenticated') return;
            _state = 'anonymous';
            var i;
            for (i = 0; i < _intervals.length; i++) {
                if (_intervals[i].id !== null) {
                    clearInterval(_intervals[i].id);
                    _intervals[i].id = null;
                }
            }
            for (i = 0; i < _timeouts.length; i++) {
                if (_timeouts[i].id !== null) {
                    clearTimeout(_timeouts[i].id);
                    _timeouts[i].id = null;
                }
            }
            for (i = 0; i < _stopCallbacks.length; i++) {
                try { _stopCallbacks[i](); } catch (e) { console.error('[AuthGate] stop callback error:', e); }
            }
        }

        return {
            start: start,
            stop: stop,
            isAuthenticated: function() { return _state === 'authenticated'; },
            onStart: function(fn) {
                _startCallbacks.push(fn);
                if (_state === 'authenticated') {
                    try { fn(); } catch (e) { console.error('[AuthGate] start callback error:', e); }
                }
            },
            onStop: function(fn) {
                _stopCallbacks.push(fn);
            },
            setInterval: function(fn, ms) {
                var rec = { fn: fn, ms: ms, id: null };
                _intervals.push(rec);
                if (_state === 'authenticated') rec.id = setInterval(fn, ms);
                return rec;
            },
            setTimeout: function(fn, ms) {
                var rec = { fn: fn, ms: ms, id: null, fired: false };
                _timeouts.push(rec);
                if (_state === 'authenticated') _armTimeout(rec);
                return rec;
            }
        };
    })();

    // ==========================================
    // PUBLIC API
    // ==========================================

    var AuthManager = {

        // --- Login ---
        login: function(username, password) {
            return _apiRequest(API_BASE + '/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: username, password: password })
            }).then(function(response) {
                return response.json().then(function(data) {
                    if (data.success && data.accessToken) {
                        _setTokens(data.accessToken, data.refreshToken, data.expiresIn || 900);
                        _setStorageItem(STORAGE_KEYS.USER, JSON.stringify(data.user));
                        _sessionExpired = false;
                        _emitEvent('login', { user: data.user });
                        return data;
                    } else {
                        throw new Error(data.error || 'فشل في تسجيل الدخول');
                    }
                });
            });
        },

        // --- Logout ---
        logout: function() {
            var token = _getAccessToken();
            var user = _getStorageItem(STORAGE_KEYS.USER);
            var userName = 'unknown';
            try {
                if (user) {
                    var parsed = JSON.parse(user);
                    userName = parsed.name || parsed.username || 'unknown';
                }
            } catch (e) {
                // Ignore parse error
            }

            _emitEvent('logout', { user: userName });
            AuthGate.stop(); // تسجيل الخروج — تفكيك كل الأنظمة التشغيلية قبل إعادة التحميل

            // Notify server to deactivate this session
            if (token) {
                _apiRequest(API_BASE + '/api/auth/logout', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
                }).catch(function() {
                    // Ignore errors on logout
                });
            }

            _clearTokens();
            _sessionExpired = true;
            _isRefreshing = false;
            _refreshPromise = null;
            _pendingRequests = [];

            // مزامنة الخروج مع بقية التبويبات المفتوحة
            if (_authChannel) {
                try { _authChannel.postMessage({ type: 'logout' }); } catch (e) {}
            }

            setTimeout(function() {
                location.reload();
            }, 500);
        },

        // --- API Request ---
        apiRequest: function(url, options) {
            return _apiRequest(url, options);
        },

        // --- Check Session ---
        checkSession: function() {
            var token = _getAccessToken();
            if (!token) {
                return Promise.resolve({ valid: false, reason: 'no_token' });
            }

            return _originalFetch(API_BASE + '/api/auth/me', {
                headers: { 'Authorization': 'Bearer ' + token }
            }).then(function(response) {
                if (response.ok) {
                    return response.json().then(function(data) {
                        return { valid: true, user: data.user };
                    });
                } else if (response.status === 401) {
                    return _doRefresh().then(function() {
                        return { valid: true, refreshed: true };
                    }).catch(function() {
                        return { valid: false, reason: 'expired' };
                    });
                } else {
                    return { valid: false, reason: 'error', status: response.status };
                }
            }).catch(function() {
                return { valid: false, reason: 'network' };
            });
        },

        // --- Get Token ---
        getToken: function() {
            return _getAccessToken();
        },

        // --- Get User ---
        getUser: function() {
            try {
                var user = _getStorageItem(STORAGE_KEYS.USER);
                return user ? JSON.parse(user) : null;
            } catch (e) {
                return null;
            }
        },

        // --- Is Logged In ---
        isLoggedIn: function() {
            return !!_getAccessToken() && !_sessionExpired;
        },

        // --- On Auth Event ---
        onAuthEvent: function(callback) {
            _authEventListeners.push(callback);
            return function() {
                var idx = _authEventListeners.indexOf(callback);
                if (idx !== -1) {
                    _authEventListeners.splice(idx, 1);
                }
            };
        },

        // --- Get SSE URL ---
        getSSEUrl: function(baseUrl) {
            var token = _getAccessToken();
            if (!token) {
                return baseUrl;
            }
            var separator = baseUrl.indexOf('?') !== -1 ? '&' : '?';
            return baseUrl + separator + 'token=' + encodeURIComponent(token);
        },

        // --- Initialize ---
        init: function() {
            var token = _getAccessToken();
            if (token) {
                var payload = _parseJwt(token);
                var expiresAt = null;

                if (payload && payload.exp) {
                    expiresAt = payload.exp * 1000;
                } else {
                    var storedExpires = _getStorageItem(STORAGE_KEYS.TOKEN_EXPIRES);
                    if (storedExpires) {
                        expiresAt = parseInt(storedExpires, 10);
                    }
                }

                if (expiresAt && Date.now() > expiresAt - TOKEN_REFRESH_MARGIN) {
                    _doRefresh().catch(function() {
                        _showLoginScreen('انتهت صلاحية الجلسة');
                    });
                }
            }
            _emitEvent('init', {});
        },

        // --- Manual Refresh ---
        refresh: function() {
            return _doRefresh();
        }

    };

    // ==========================================
    // CROSS-TAB LOGOUT SYNC
    // ==========================================
    // خروج من تبويب آخر ⇒ إنهاء الجلسة محلياً فوراً (الجلسة أُبطلت في السيرفر أصلاً)
    function _handleExternalLogout() {
        _clearTokens();
        _showLoginScreen('تم تسجيل الخروج من تبويب آخر');
    }

    var _authChannel = null;
    try {
        if (typeof BroadcastChannel !== 'undefined') {
            _authChannel = new BroadcastChannel('auth');
            _authChannel.onmessage = function(event) {
                if (event.data && event.data.type === 'logout') {
                    _handleExternalLogout();
                }
            };
        }
    } catch (e) {
        _authChannel = null;
    }

    // Fallback للمتصفحات بلا BroadcastChannel: إزالة مفتاح التوكن في تبويب آخر
    global.addEventListener('storage', function(event) {
        if (event.key === STORAGE_KEYS.ACCESS_TOKEN && event.newValue === null) {
            _handleExternalLogout();
        }
    });

    // ==========================================
    // OVERRIDE window.fetch
    // ==========================================
    // ALL fetch calls in the application automatically go through AuthManager
    global.fetch = function(url, options) {
        return _apiRequest(url, options);
    };

    // Expose globally
    global.AuthManager = AuthManager;
    global.AuthGate = AuthGate;

})(window);