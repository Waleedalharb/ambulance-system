/**
 * Chat Integration Module for EMS Platform
 * Provides: unread badge polling, browser notifications, share-to-chat
 */
const ChatIntegration = {
  unreadCount: 0,
  pollInterval: null,
  lastNotifiedId: null,

  /**
   * Initialize the chat integration
   */
  async init() {
    // Wait for auth to be ready
    if (!this.isAuthenticated()) {
      // Retry after a short delay if auth isn't ready yet
      setTimeout(() => this.init(), 2000);
      return;
    }

    // Request browser notification permission
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }

    // Initial badge update
    await this.updateBadge();

    // Start polling every 30 seconds
    this.pollInterval = setInterval(() => this.updateBadge(), 30000);

    console.log('[ChatIntegration] Initialized, polling every 30s');
  },

  /**
   * Check if user is authenticated
   */
  isAuthenticated() {
    const token = localStorage.getItem('authToken');
    return !!token;
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

      if (!res.ok) {
        // API may not exist yet; silently fail
        return;
      }

      const data = await res.json();
      const conversations = data.conversations || data || [];

      // Count unread messages across all conversations
      let unread = 0;
      let latestUnreadMessage = null;

      conversations.forEach(conv => {
        // Support both snake_case (API) and camelCase (fallback)
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

      // Show browser notification for new messages
      if (latestUnreadMessage && latestUnreadMessage.id !== this.lastNotifiedId) {
        this.lastNotifiedId = latestUnreadMessage.id;
        this.showNotification(
          'رسالة جديدة',
          latestUnreadMessage.content || 'لديك رسالة جديدة في الدردشة'
        );
      }
    } catch (err) {
      // Silently fail if endpoint isn't ready
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
   * @param {Object} context - { type: 'shift'|'completion'|'report', id, title }
   */
  shareToChat(context) {
    if (!context) return;
    const url = `chat.html?share=${encodeURIComponent(JSON.stringify(context))}`;
    window.open(url, '_blank');
  },

  /**
   * Show a browser notification (if permitted)
   */
  showNotification(title, body) {
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;

    try {
      new Notification(title, {
        body: body || '',
        icon: '/logo.png',
        badge: '/logo.png',
        tag: 'chat-message',
        requireInteraction: false
      });
    } catch (e) {
      // Fallback for older browsers
    }
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
        list.innerHTML = '<p style="text-align:center; color:var(--gray-400); padding:16px; font-size:0.85rem;">⚠️ يرجى تسجيل الدخول</p>';
        return;
      }

      const res = await fetch('/api/chat/conversations', {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (!res.ok) {
        list.innerHTML = '<p style="text-align:center; color:var(--gray-400); padding:16px; font-size:0.85rem;">📭 لا توجد رسائل حديثة</p>';
        return;
      }

      const data = await res.json();
      const conversations = data.conversations || data || [];

      if (!conversations || conversations.length === 0) {
        list.innerHTML = '<p style="text-align:center; color:var(--gray-400); padding:16px; font-size:0.85rem;">📭 لا توجد رسائل حديثة</p>';
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
      list.innerHTML = '<p style="text-align:center; color:var(--gray-400); padding:16px; font-size:0.85rem;">📭 لا توجد رسائل حديثة</p>';
    }
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
    if (diff < 3600) return `${Math.floor(diff / 60)} دقيقة`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} ساعة`;
    return `${Math.floor(diff / 86400)} يوم`;
  },

  /**
   * Public API for external modules to trigger badge update
   * Called from websocket-sync.js when chat_message event arrives
   */
  updateBadgeFromWebSocket() {
    this.updateBadge();
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
   * Stop polling (useful on logout)
   */
  destroy() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }
};

// Global helper for websocket-sync.js and other modules
function updateChatBadge() {
  if (typeof ChatIntegration !== 'undefined' && ChatIntegration.updateBadge) {
    ChatIntegration.updateBadge();
  }
}

// Auto-init when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  // Small delay to ensure auth systems are ready
  setTimeout(() => ChatIntegration.init(), 1000);
});

// Close chat preview when clicking outside
document.addEventListener('click', (e) => {
  const panel = document.getElementById('chatPreviewPanel');
  const btn = document.getElementById('chatToolbarBtn');
  if (panel && !panel.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
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
    };
  } catch(e) {}
}

// Also listen for storage events (fallback for older browsers)
window.addEventListener('storage', function(e) {
  if (e.key === 'chat_badge_trigger') {
    ChatIntegration.updateBadge();
  }
});
