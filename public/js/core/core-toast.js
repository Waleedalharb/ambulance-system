/**
 * ToastCore - Canonical Toast Notifications (page-agnostic)
 * منصة إدارة العمليات الإسعافية – قطاع جنوب الرياض
 *
 * One canonical showToast(message, type) implementation, consolidated from
 * the many per-page copies (app.js / operations-command.html / etc.).
 *
 * - RTL Arabic safe (inherits document direction, logical text alignment)
 * - Zero external dependencies (own container + own injected styles)
 * - XSS safe (uses textContent, never innerHTML for messages)
 *
 * Load order: core-auth.js → core-toast.js → core-time.js
 *
 * Global API:
 *   - window.showToast(message, type, durationMs)
 *   - window.ToastCore.show(message, type, durationMs)  (explicit namespace,
 *     use this from page-local wrappers that keep the name `showToast`)
 *
 * type: 'success' | 'error' | 'warning' | 'alert' | 'info'  ('alert' → 'warning')
 */
(function(global) {
    'use strict';

    var CONTAINER_ID = 'toastCoreContainer';
    var STYLE_ID = 'toastCoreStyles';
    var DEFAULT_DURATION = 4000;

    var TYPE_COLORS = {
        success: '#22c55e',
        error: '#ef4444',
        warning: '#f59e0b',
        info: '#3b82f6'
    };

    function _normalizeType(type) {
        if (type === 'alert') return 'warning';
        return TYPE_COLORS[type] ? type : 'info';
    }

    function _ensureStyles() {
        if (document.getElementById(STYLE_ID)) return;
        var style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent =
            '#' + CONTAINER_ID + ' {' +
            '  position: fixed;' +
            '  bottom: 24px;' +
            '  left: 50%;' +
            '  transform: translateX(-50%);' +
            '  display: flex;' +
            '  flex-direction: column;' +
            '  align-items: center;' +
            '  gap: 8px;' +
            '  z-index: 99999;' +
            '  pointer-events: none;' +
            '  max-width: min(90vw, 480px);' +
            '}' +
            '.toast-core {' +
            '  pointer-events: auto;' +
            '  display: flex;' +
            '  align-items: center;' +
            '  gap: 10px;' +
            '  background: rgba(30, 30, 34, 0.95);' +
            '  color: #f3f4f6;' +
            '  padding: 12px 18px;' +
            '  border-radius: 10px;' +
            '  border: 1px solid rgba(255,255,255,0.08);' +
            '  border-inline-start: 4px solid #3b82f6;' +
            '  box-shadow: 0 8px 24px rgba(0,0,0,0.35);' +
            '  font-family: inherit;' +
            '  font-size: 14px;' +
            '  line-height: 1.6;' +
            '  text-align: start;' +
            '  direction: inherit;' +
            '  max-width: 100%;' +
            '  word-break: break-word;' +
            '  opacity: 0;' +
            '  transform: translateY(10px);' +
            '  transition: opacity 0.25s ease, transform 0.25s ease;' +
            '}' +
            '.toast-core.toast-core-visible {' +
            '  opacity: 1;' +
            '  transform: translateY(0);' +
            '}' +
            '.toast-core .toast-core-dot {' +
            '  flex: 0 0 auto;' +
            '  width: 10px;' +
            '  height: 10px;' +
            '  border-radius: 50%;' +
            '  background: #3b82f6;' +
            '}' +
            '.toast-core .toast-core-close {' +
            '  flex: 0 0 auto;' +
            '  margin-inline-start: 6px;' +
            '  cursor: pointer;' +
            '  opacity: 0.6;' +
            '  font-size: 16px;' +
            '  line-height: 1;' +
            '  border: none;' +
            '  background: transparent;' +
            '  color: inherit;' +
            '  padding: 0 2px;' +
            '}' +
            '.toast-core .toast-core-close:hover { opacity: 1; }';
        (document.head || document.documentElement).appendChild(style);
    }

    function _ensureContainer() {
        var container = document.getElementById(CONTAINER_ID);
        if (!container) {
            container = document.createElement('div');
            container.id = CONTAINER_ID;
            container.setAttribute('aria-live', 'polite');
            document.body.appendChild(container);
        }
        return container;
    }

    /**
     * Canonical toast.
     * @param {string} message   Text to display (rendered as plain text)
     * @param {string} [type]    'success' | 'error' | 'warning' | 'alert' | 'info'
     * @param {number} [durationMs]  Auto-remove delay (default 4000)
     * @returns {HTMLElement} the toast element
     */
    function showToast(message, type, durationMs) {
        var normalized = _normalizeType(type);
        var duration = (typeof durationMs === 'number' && durationMs > 0) ? durationMs : DEFAULT_DURATION;

        _ensureStyles();
        var container = _ensureContainer();

        var toast = document.createElement('div');
        toast.className = 'toast-core';
        toast.style.borderInlineStartColor = TYPE_COLORS[normalized];

        var dot = document.createElement('span');
        dot.className = 'toast-core-dot';
        dot.style.background = TYPE_COLORS[normalized];
        toast.appendChild(dot);

        var text = document.createElement('span');
        text.textContent = (message == null) ? '' : String(message);
        toast.appendChild(text);

        var close = document.createElement('button');
        close.className = 'toast-core-close';
        close.type = 'button';
        close.setAttribute('aria-label', 'إغلاق');
        close.textContent = '×';
        close.addEventListener('click', function() {
            if (toast.parentElement) toast.remove();
        });
        toast.appendChild(close);

        container.appendChild(toast);

        // Trigger entrance transition
        setTimeout(function() { toast.classList.add('toast-core-visible'); }, 10);

        setTimeout(function() {
            if (toast.parentElement) toast.remove();
        }, duration);

        return toast;
    }

    // Explicit namespace (safe to call from page-local `showToast` wrappers)
    global.ToastCore = { show: showToast };

    // Canonical global
    global.showToast = showToast;

})(window);
