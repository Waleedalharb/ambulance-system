/**
 * Chat Integration Module — منصة الجنوب
 * Provides: Cross-page WebSocket, Toast Notifications, Unread badge, Browser notifications
 * v2: WebSocket-based INSTANT delivery (replaces polling)
 */
const ChatIntegration = {
    unreadCount: 0,
    ws: null,
    connected: false,
    reconnectAttempts: 0,
    maxReconnectDelay: 30000,
    heartbeatInterval: null,
    lastNotifiedId: null,
    notifiedMessages: {},

    /**
     * Initialize — connect WebSocket for instant delivery
     */
    async init() {
        if (!this.isAuthenticated()) {
            setTimeout(() => this.init(), 2000);
            return;
        }

        // Request browser notification permission
        if ('Notification' in window && Notification.permission === 'default') {
            Notification.requestPermission();
        }

        // Connect WebSocket for INSTANT delivery
        this.connectWebSocket();

        // Initial badge update (fallback)
        await this.updateBadge();

        console.log('[ChatIntegration] Initialized with WebSocket');
    },

    /**
     * Check if user is authenticated
     */
    isAuthenticated() {
        const token = localStorage.getItem('authToken');
        return !!token;
    },

    /**
     * Connect WebSocket for real-time message delivery on ALL pages
     */
    connectWebSocket() {
        const token = localStorage.getItem('authToken');
        if (!token) return;

        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        // Include auth token (server rejects tokenless connections with 1008 — same pattern as websocket-sync.js)
        const wsUrl = protocol + '//' + location.host + '/ws?token=' + encodeURIComponent(token);

        try {
            this.ws = new WebSocket(wsUrl);
            const self = this;

            this.ws.onopen = function() {
                self.connected = true;
                self.reconnectAttempts = 0;
                console.log('[ChatIntegration] WebSocket connected');
                self.startHeartbeat();
                // Send presence
                self.ws.send(JSON.stringify({ type: 'chat_presence' }));
            };

            this.ws.onmessage = function(event) {
                try {
                    const data = JSON.parse(event.data);
                    self.handleWebSocketMessage(data);
                } catch (e) {
                    console.error('[ChatIntegration] WS parse error:', e);
                }
            };

            this.ws.onerror = function(err) {
                console.error('[ChatIntegration] WS error:', err);
                self.connected = false;
            };

            this.ws.onclose = function() {
                self.connected = false;
                self.stopHeartbeat();
                const delay = Math.min(1000 * Math.pow(2, self.reconnectAttempts), self.maxReconnectDelay);
                self.reconnectAttempts++;
                console.log('[ChatIntegration] Disconnected, reconnecting in', delay, 'ms');
                setTimeout(() => self.connectWebSocket(), delay);
            };
        } catch (e) {
            console.error('[ChatIntegration] WS init error:', e);
        }
    },

    /**
     * Handle WebSocket messages — KEY for instant notifications
     */
    handleWebSocketMessage(data) {
        // Ignore ping/pong
        if (data.type === 'pong' || data.type === 'ping' || data.type === 'connected') return;
        if (data.type === 'online_users_list') return;

        // NEW: Handle incoming chat messages — INSTANT NOTIFICATION
        if (data.type === 'chat_message' && data.message && data.conversationId) {
            this.handleIncomingMessage(data.message, data.conversationId);
            return;
        }

        // Update badge on read receipts
        if (data.type === 'chat_read') {
            this.updateBadge();
            return;
        }
    },

    /**
     * Handle incoming message — show Toast + Browser notification for EVERY message
     */
    handleIncomingMessage(message, conversationId) {
        const currentUser = this.getCurrentUserId();

        // Don't notify for own messages
        if (currentUser && String(message.sender_id) === String(currentUser)) {
            return;
        }

        // Don't notify if already on chat.html viewing this conversation
        if (window.location.pathname.includes('chat.html')) {
            return; // chat.js will handle it
        }

        // Prevent duplicate notification for same message
        if (this.notifiedMessages[message.id]) return;
        this.notifiedMessages[message.id] = true;

        // Update badge
        this.updateBadge();

        // Show Toast notification (bottom-right popup) — EVERY message gets one
        this.showToastNotification(message, conversationId);

        // Show browser notification
        this.showBrowserNotification(
            message.sender_name || 'رسالة جديدة',
            message.content || '',
            message.sender_id,
            message.id
        );

        // Notify other tabs via BroadcastChannel
        try {
            if (typeof BroadcastChannel !== 'undefined') {
                const bc = new BroadcastChannel('chat_sync');
                bc.postMessage({ type: 'chat_badge_update', unreadTotal: this.unreadCount });
                bc.close();
            }
        } catch(e) {}
    },

    /**
     * Show Toast notification (bottom-right popup) — ONE PER MESSAGE
     */
    showToastNotification(message, conversationId) {
        // Ensure container exists
        var container = document.getElementById('chatToastContainer');
        if (!container) {
            container = document.createElement('div');
            container.id = 'chatToastContainer';
            container.setAttribute('dir', 'rtl');
            container.style.cssText = 'position:fixed;bottom:20px;left:20px;z-index:99999;display:flex;flex-direction:column;gap:8px;pointer-events:none;direction:rtl;';
            document.body.appendChild(container);
        }

        var senderName = message.sender_name || 'مستخدم';
        var initials = senderName.split(' ').map(function(w) { return w[0]; }).join('').substring(0, 2);
        var colors = ['#0D9488','#3B82F6','#8B5CF6','#EC4899','#F59E0B','#10B981'];
        var color = colors[senderName.charCodeAt(0) % colors.length];
        var time = this.formatTime(message.created_at);
        var preview = this.escapeHtml(message.content || '').substring(0, 55);
        if ((message.content || '').length > 55) preview += '...';

        var toast = document.createElement('div');
        toast.style.cssText = 'display:flex;align-items:flex-start;gap:10px;padding:12px 14px;background:#fff;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,0.12),0 0 0 1px rgba(0,0,0,0.04);cursor:pointer;pointer-events:all;min-width:280px;max-width:340px;opacity:0;transform:translateX(-100px);transition:all 0.3s ease;border-right:3px solid ' + color + ';direction:rtl;margin-bottom:6px;';

        toast.innerHTML = '<div style="width:38px;height:38px;border-radius:50%;background:' + color + ';display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:0.8rem;flex-shrink:0;">' + initials + '</div>' +
            '<div style="flex:1;min-width:0;">' +
                '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px;">' +
                    '<span style="font-weight:600;font-size:0.82rem;color:#0F172A;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:160px;">' + this.escapeHtml(senderName) + '</span>' +
                    '<span style="font-size:0.65rem;color:#94A3B8;flex-shrink:0;">' + time + '</span>' +
                '</div>' +
                '<div style="font-size:0.78rem;color:#64748B;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + preview + '</div>' +
            '</div>' +
            '<button style="background:none;border:none;color:#94A3B8;cursor:pointer;font-size:1.1rem;padding:0;width:20px;height:20px;display:flex;align-items:center;justify-content:center;border-radius:50%;flex-shrink:0;" onclick="event.stopPropagation();this.parentElement.remove();">&times;</button>';

        container.appendChild(toast);
        requestAnimationFrame(function() {
            toast.style.opacity = '1';
            toast.style.transform = 'translateX(0)';
        });

        // Click to open conversation
        toast.addEventListener('click', function() {
            sessionStorage.setItem('chat_target_conversation', conversationId);
            window.location.href = 'chat.html?conv=' + conversationId;
        });

        // Auto remove after 6 seconds
        setTimeout(function() {
            toast.style.opacity = '0';
            toast.style.transform = 'translateX(-100px)';
            setTimeout(function() { if (toast.parentNode) toast.remove(); }, 300);
        }, 6000);
    },

    /**
     * Fetch conversations and update the unread badge
     */
    async updateBadge() {
        try {
            const token = localStorage.getItem('authToken');
            if (!token) return;

            const res = await fetch('/api/chat/conversations', {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            if (!res.ok) return;

            const data = await res.json();
            const conversations = data.conversations || data || [];

            let unread = 0;
            conversations.forEach(conv => {
                const unreadInConv = (conv.unread_count || conv.unreadCount || 0);
                unread += unreadInConv;
            });

            this.unreadCount = unread;
            this.renderBadge(unread);
        } catch (err) {
            console.log('[ChatIntegration] updateBadge error:', err.message);
        }
    },

    /**
     * Update the DOM badge element
     */
    renderBadge(count) {
        const badge = document.getElementById('chatBadge');
        if (!badge) return;

        if (count > 0) {
            badge.textContent = count > 99 ? '99+' : count;
            badge.style.display = 'flex';
        } else {
            badge.style.display = 'none';
        }
    },

    /**
     * Show a browser notification (if permitted) — UNIQUE tag per message
     */
    showBrowserNotification(title, body, senderId, messageId) {
        if (!('Notification' in window)) return;
        if (Notification.permission !== 'granted') return;
        try {
            new Notification(title, {
                body: body ? body.substring(0, 100) : 'لديك رسالة جديدة',
                icon: '/logo.png',
                badge: '/logo.png',
                tag: 'chat-msg-' + (messageId || Date.now()),
                requireInteraction: false
            });
        } catch (e) {}
    },

    /**
     * Format timestamp to relative time
     */
    formatTime(timestamp) {
        if (!timestamp) return '';
        const date = new Date(timestamp);
        const now = new Date();
        const diff = Math.floor((now - date) / 1000);
        if (diff < 60) return 'الآن';
        if (diff < 3600) return `${Math.floor(diff / 60)} د`;
        if (diff < 86400) return `${Math.floor(diff / 3600)} س`;
        return `${Math.floor(diff / 86400)} ي`;
    },

    /**
     * Escape HTML to prevent XSS
     */
    escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    },

    /**
     * Get current user ID
     */
    getCurrentUserId() {
        try {
            const user = localStorage.getItem('currentUser');
            if (user) {
                const parsed = JSON.parse(user);
                return parsed.id;
            }
        } catch (e) {}
        return null;
    },

    /**
     * Heartbeat to keep connection alive
     */
    startHeartbeat() {
        this.stopHeartbeat();
        const self = this;
        this.heartbeatInterval = setInterval(function() {
            if (self.connected && self.ws && self.ws.readyState === WebSocket.OPEN) {
                self.ws.send(JSON.stringify({ type: 'ping' }));
            }
        }, 25000);
    },

    stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    },

    /**
     * Toggle chat preview dropdown panel
     */
    toggleChatPreview(event) {
        event && event.stopPropagation();
        const panel = document.getElementById('chatPreviewPanel');
        if (!panel) return;

        const isVisible = panel.style.display === 'block';

        // Close other panels
        const notifPanel = document.getElementById('notificationPanel');
        if (notifPanel) notifPanel.style.display = 'none';

        panel.style.display = isVisible ? 'none' : 'block';

        if (!isVisible) {
            this.loadChatPreview();
        }
    },

    /**
     * Load recent messages for preview panel
     */
    async loadChatPreview() {
        const list = document.getElementById('chatPreviewList');
        if (!list) return;

        list.innerHTML = '<p style="text-align:center; color:var(--gray-400); padding:16px; font-size:0.85rem;"><i class="fas fa-spinner fa-spin"></i> جاري التحميل...</p>';

        try {
            const token = localStorage.getItem('authToken');
            if (!token) {
                list.innerHTML = '<p style="text-align:center; color:var(--gray-400); padding:16px; font-size:0.85rem;">يرجى تسجيل الدخول</p>';
                return;
            }

            const res = await fetch('/api/chat/conversations', {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            if (!res.ok) {
                list.innerHTML = '<p style="text-align:center; color:var(--gray-400); padding:16px; font-size:0.85rem;">لا توجد رسائل حديثة</p>';
                return;
            }

            const data = await res.json();
            const conversations = data.conversations || data || [];

            if (!conversations || conversations.length === 0) {
                list.innerHTML = '<p style="text-align:center; color:var(--gray-400); padding:16px; font-size:0.85rem;">لا توجد رسائل حديثة</p>';
                return;
            }

            // Sort by updated_at desc and take first 5
            const sortedConvs = conversations
                .filter(conv => conv.last_message)
                .sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0))
                .slice(0, 5);

            list.innerHTML = sortedConvs.map(conv => {
                const lastMsg = conv.last_message;
                const unread = conv.unread_count || conv.unreadCount || 0;
                const time = lastMsg ? this.formatTime(lastMsg.created_at) : '';
                const snippet = lastMsg ? (lastMsg.content || '').substring(0, 60) : 'لا توجد رسائل';
                const sender = lastMsg ? (lastMsg.sender_name || 'مستخدم') : '';

                return `<a href="chat.html?conv=${conv.id}" style="display:block; padding:10px 14px; border-bottom:1px solid var(--gray-200); text-decoration:none; color:inherit; transition:background 0.15s;" onmouseover="this.style.background='var(--gray-50)'" onmouseout="this.style.background='transparent'">` +
                    `<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">` +
                        `<span style="font-weight:600; font-size:0.8rem; color:var(--text);">${this.escapeHtml(conv.title || 'محادثة')}</span>` +
                        (unread > 0 ? `<span style="background:#EF4444; color:white; font-size:0.6rem; font-weight:700; min-width:16px; height:16px; border-radius:8px; display:flex; align-items:center; justify-content:center; padding:0 4px;">${unread}</span>` : '') +
                    `</div>` +
                    `<div style="font-size:0.75rem; color:var(--gray-500); direction:rtl; text-align:right;">` +
                        (sender ? `<strong>${this.escapeHtml(sender)}:</strong> ` : '') + this.escapeHtml(snippet) + (lastMsg && lastMsg.content && lastMsg.content.length > 60 ? '...' : '') +
                    `</div>` +
                    (time ? `<div style="font-size:0.65rem; color:var(--gray-400); margin-top:3px; text-align:left;">${time}</div>` : '') +
                `</a>`;
            }).join('');
        } catch (err) {
            list.innerHTML = '<p style="text-align:center; color:var(--gray-400); padding:16px; font-size:0.85rem;">لا توجد رسائل حديثة</p>';
        }
    },

    /**
     * Destroy on logout
     */
    destroy() {
        this.stopHeartbeat();
        if (this.ws) {
            try { this.ws.close(); } catch(e) {}
        }
    }
};

// Global helper for backward compatibility
function updateChatBadge() {
    if (typeof ChatIntegration !== 'undefined' && ChatIntegration.updateBadge) {
        ChatIntegration.updateBadge();
    }
}

// Auto-init when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => ChatIntegration.init(), 1000);
});

// Listen for cross-tab chat updates via BroadcastChannel
if (typeof BroadcastChannel !== 'undefined') {
    try {
        const chatBC = new BroadcastChannel('chat_sync');
        chatBC.onmessage = function(ev) {
            if (ev.data && ev.data.type === 'chat_badge_update') {
                ChatIntegration.updateBadge();
            }
        };
    } catch(e) {}
}

// Also listen for storage events (fallback for older browsers)
window.addEventListener('storage', function(e) {
    if (e.key === 'chat_badge_trigger') {
        ChatIntegration.updateBadge();
    }
});