// ============================================
// Chat Integration Module for EMS Platform
// Provides: Cross-page WebSocket, Toast Notifications,
//           Unread badge, Browser notifications
// ============================================
const ChatIntegration = {
    unreadCount: 0,
    ws: null,
    connected: false,
    reconnectAttempts: 0,
    maxReconnectDelay: 30000,
    heartbeatInterval: null,
    lastNotifiedId: null,
    currentPage: window.location.pathname,

    /**
     * Initialize the chat integration
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

        // Connect WebSocket for instant delivery
        this.connectWebSocket();

        // Initial badge update
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
        const wsUrl = protocol + '//' + location.host + '/ws';

        try {
            this.ws = new WebSocket(wsUrl, token);
            const self = this;

            this.ws.onopen = function() {
                self.connected = true;
                self.reconnectAttempts = 0;
                console.log('[ChatIntegration] WebSocket connected');
                self.startHeartbeat();
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
     * Handle WebSocket messages - this is the KEY for instant notifications
     */
    handleWebSocketMessage(data) {
        // Ignore ping/pong
        if (data.type === 'pong' || data.type === 'ping') return;
        if (data.type === 'connected') return;
        if (data.type === 'online_users_list') return;

        // NEW: Handle incoming chat messages - INSTANT NOTIFICATION
        if (data.type === 'chat_message' && data.message && data.conversationId) {
            this.handleIncomingMessage(data.message, data.conversationId);
            return;
        }

        // Update badge on read receipts (messages were read)
        if (data.type === 'chat_read') {
            this.updateBadge();
            return;
        }

        // Handle online/offline for any UI that shows user status
        if (data.type === 'user_online' || data.type === 'user_offline') {
            // Could update any online status indicators on the current page
            return;
        }
    },

    /**
     * Handle incoming message - show toast and update badge
     */
    handleIncomingMessage(message, conversationId) {
        const currentUserId = this.getCurrentUserId();

        // Don't notify for own messages
        if (currentUserId && String(message.sender_id) === String(currentUserId)) {
            return;
        }

        // Update badge immediately
        this.updateBadge();

        // Show toast notification (ONLY if not on chat.html viewing this conversation)
        const isOnChatPage = this.currentPage.indexOf('chat.html') !== -1;
        if (!isOnChatPage) {
            this.showToastNotification(message, conversationId);
        }

        // Show browser notification
        this.showBrowserNotification(
            message.sender_name || 'رسالة جديدة',
            message.content || '',
            message.sender_id,
            conversationId
        );

        // Notify other tabs via BroadcastChannel
        try {
            if (typeof BroadcastChannel !== 'undefined') {
                const bc = new BroadcastChannel('chat_sync');
                bc.postMessage({
                    type: 'new_message',
                    message: message,
                    conversationId: conversationId
                });
                bc.close();
            }
        } catch(e) {}
    },

    /**
     * Show toast notification (bottom-right popup)
     */
    showToastNotification(message, conversationId) {
        // Use the global ChatToast if available, otherwise create inline toast
        if (typeof ChatToast !== 'undefined' && ChatToast.show) {
            ChatToast.show({
                senderName: message.sender_name || 'مستخدم',
                senderId: message.sender_id,
                conversationId: conversationId,
                content: message.content,
                messageId: message.id,
                timestamp: message.created_at
            });
            return;
        }

        // Fallback: create inline toast
        this.createInlineToast(message, conversationId);
    },

    /**
     * Create inline toast (fallback when ChatToast module not loaded)
     */
    createInlineToast(message, conversationId) {
        let container = document.getElementById('chatInlineToastContainer');
        if (!container) {
            container = document.createElement('div');
            container.id = 'chatInlineToastContainer';
            container.style.cssText = 'position:fixed;bottom:24px;left:24px;z-index:99999;display:flex;flex-direction:column;gap:8px;pointer-events:none;direction:rtl;';
            document.body.appendChild(container);
        }

        const toast = document.createElement('div');
        const colors = ['#0D9488', '#3B82F6', '#8B5CF6', '#EC4899', '#F59E0B', '#10B981'];
        const color = colors[(message.sender_name || '').charCodeAt(0) % colors.length];
        const initials = (message.sender_name || 'مستخدم').split(' ').map(w => w[0]).join('').substring(0, 2);

        toast.style.cssText = `
            display:flex;align-items:flex-start;gap:12px;padding:14px 16px;
            background:linear-gradient(135deg, #FFFFFF 0%, #F8FAFC 100%);
            border-radius:16px;box-shadow: 0 20px 25px -5px rgba(0,0,0,0.1), 0 0 0 1px rgba(0,0,0,0.04);
            cursor:pointer;pointer-events:all;min-width:300px;max-width:380px;
            opacity:0;transform:translateX(-120%) scale(0.9);transition:all 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
            position:relative;overflow:hidden;
        `;
        toast.innerHTML = `
            <div style="position:absolute;right:0;top:0;bottom:0;width:4px;background:linear-gradient(180deg, ${color} 0%, #14B8A6 100%);"></div>
            <div style="width:44px;height:44px;border-radius:50%;background:${color};display:flex;align-items:center;justify-content:center;color:white;font-weight:600;font-size:0.85rem;flex-shrink:0;box-shadow:0 2px 8px rgba(0,0,0,0.12);">
                <span style="line-height:1;">${initials}</span>
            </div>
            <div style="flex:1;min-width:0;text-align:right;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;gap:8px;">
                    <span style="font-weight:700;font-size:0.85rem;color:#0F172A;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${this.escapeHtml(message.sender_name || 'مستخدم')}</span>
                    <span style="font-size:0.7rem;color:#94A3B8;flex-shrink:0;">${this.formatTime(message.created_at)}</span>
                </div>
                <div style="font-size:0.8rem;color:#64748B;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word;">
                    ${this.escapeHtml(message.content || '').substring(0, 60)}${(message.content || '').length > 60 ? '...' : ''}
                </div>
            </div>
            <button style="background:none;border:none;color:#94A3B8;cursor:pointer;font-size:1.2rem;padding:0;width:24px;height:24px;display:flex;align-items:center;justify-content:center;border-radius:50%;transition:all 0.2s;flex-shrink:0;margin-top:-2px;" onclick="event.stopPropagation();this.parentElement.remove();">&times;</button>
        `;

        toast.addEventListener('click', () => {
            sessionStorage.setItem('chat_target_conversation', conversationId);
            window.location.href = 'chat.html?conv=' + conversationId;
        });

        container.appendChild(toast);
        requestAnimationFrame(() => {
            toast.style.opacity = '1';
            toast.style.transform = 'translateX(0) scale(1)';
        });

        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateX(-120%) scale(0.9)';
            setTimeout(() => toast.remove(), 300);
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

            // Count unread messages
            let unread = 0;
            let latestUnreadMessage = null;

            conversations.forEach(conv => {
                const unreadInConv = (conv.unread_count || conv.unreadCount || 0);
                unread += unreadInConv;
                if (unreadInConv > 0 && conv.last_message) {
                    if (!latestUnreadMessage || new Date(conv.last_message.created_at) > new Date(latestUnreadMessage.created_at)) {
                        latestUnreadMessage = conv.last_message;
                    }
                }
            });

            this.unreadCount = unread;
            this.renderBadge(unread);

            // Browser notification for latest unread (only if different from last)
            if (latestUnreadMessage && latestUnreadMessage.id !== this.lastNotifiedId) {
                this.lastNotifiedId = latestUnreadMessage.id;
            }
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
     * Open chat.html with a pre-filled share context
     */
    shareToChat(context) {
        if (!context) return;
        const url = `chat.html?share=${encodeURIComponent(JSON.stringify(context))}`;
        window.open(url, '_blank');
    },

    /**
     * Toggle the chat preview dropdown
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
     * Load recent messages for the preview panel
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

                return `
                    <a href="chat.html?conv=${conv.id}" style="display:block; padding:10px 14px; border-bottom:1px solid var(--gray-200); text-decoration:none; color:inherit; transition:background 0.15s;" onmouseover="this.style.background='var(--gray-50)'" onmouseout="this.style.background='transparent'">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                            <span style="font-weight:600; font-size:0.8rem; color:var(--text);">${this.escapeHtml(conv.title || 'محادثة')}</span>
                            ${unread > 0 ? `<span style="background:#EF4444; color:white; font-size:0.6rem; font-weight:700; min-width:16px; height:16px; border-radius:8px; display:flex; align-items:center; justify-content:center; padding:0 4px;">${unread}</span>` : ''}
                        </div>
                        <div style="font-size:0.75rem; color:var(--gray-500); direction:rtl; text-align:right;">
                            ${sender ? `<strong>${this.escapeHtml(sender)}:</strong> ` : ''}${this.escapeHtml(snippet)}${lastMsg && lastMsg.content && lastMsg.content.length > 60 ? '...' : ''}
                        </div>
                        ${time ? `<div style="font-size:0.65rem; color:var(--gray-400); margin-top:3px; text-align:left;">${time}</div>` : ''}
                    </a>
                `;
            }).join('');
        } catch (err) {
            list.innerHTML = '<p style="text-align:center; color:var(--gray-400); padding:16px; font-size:0.85rem;">لا توجد رسائل حديثة</p>';
        }
    },

    /**
     * Show a browser notification (if permitted)
     */
    showBrowserNotification(title, body, senderId, conversationId) {
        if (!('Notification' in window)) return;
        if (Notification.permission !== 'granted') return;

        try {
            const notif = new Notification(title, {
                body: body ? body.substring(0, 100) : 'لديك رسالة جديدة',
                icon: '/logo.png',
                badge: '/logo.png',
                tag: 'chat-' + (conversationId || senderId || 'msg'),
                requireInteraction: false,
                data: { conversationId: conversationId, senderId: senderId }
            });

            notif.onclick = function() {
                window.focus();
                if (conversationId) {
                    sessionStorage.setItem('chat_target_conversation', conversationId);
                    window.location.href = 'chat.html?conv=' + conversationId;
                }
                notif.close();
            };
        } catch (e) {
            // Fallback for older browsers
        }
    },

    /**
     * Format timestamp to relative time
     */
    formatTime(timestamp) {
        if (!timestamp) return '';
        const date = new Date(timestamp);
        if (isNaN(date.getTime())) return '';
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
     * Get current user ID from localStorage
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
     * Public API for external modules
     */
    updateBadgeFromWebSocket() {
        this.updateBadge();
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

// Close chat preview when clicking outside
document.addEventListener('click', (e) => {
    const panel = document.getElementById('chatPreviewPanel');
    const btn = document.getElementById('chatToolbarBtn');
    if (panel && !panel.contains(e.target) && e.target !== btn && btn && !btn.contains(e.target)) {
        panel.style.display = 'none';
    }
});

// Listen for cross-tab chat updates via BroadcastChannel
if (typeof BroadcastChannel !== 'undefined') {
    try {
        const chatBC = new BroadcastChannel('chat_sync');
        chatBC.onmessage = function(ev) {
            if (ev.data && ev.data.type === 'chat_badge_update') {
                ChatIntegration.updateBadge();
            }
            if (ev.data && ev.data.type === 'new_message') {
                // Another tab received a message - update badge
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