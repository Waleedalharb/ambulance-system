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

    // ==========================================
    // STATE
    // ==========================================
    var _originalFetch = global.fetch.bind(global);
    var _isRefreshing = false;
    var _refreshPromise = null;

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
                throw new Error('Refresh failed: ' + response.status);
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
        }
    };

})(window);
