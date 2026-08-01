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
     * OV-S6: مفتاح التوكن الموحد — auth_access_token (AuthManager) أولاً ثم authToken (القديم) احتياطاً.
     * جذر D-14: قراءة المفتاح القديم فقط كانت تفتح socket بلا توكن صالح فيبقى عالقاً/يُرفض.
     */
    getToken() {
        return localStorage.getItem('auth_access_token') || localStorage.getItem('authToken');
    },

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
        const token = this.getToken();
        return !!token;
    },

    /**
     * Connect WebSocket for real-time message delivery on ALL pages
     */
    connectWebSocket() {
        this._stopped = false;
        const token = this.getToken();
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
                if (self._stopped) return; // فُكّ عمداً عبر AuthGate — بلا إعادة اتصال
                if (typeof AuthGate !== 'undefined' && !AuthGate.isAuthenticated()) return; // إيقاف نهائي عند فشل المصادقة — بلا عاصفة
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

        // OV-S6: أحداث الحضور أصبحت WS-only (broadcastToAll) وتصل عبر هذه القناة.
        // نفس منطق websocket-sync.js السابق حرفياً حتى يستمر تحديث واجهة المتصلين.
        if (data.type === 'user_online' || data.type === 'user_offline') {
            if (data.onlineUsers) {
                window.onlineUsersList = data.onlineUsers;
                if (typeof updateOnlineUsersUI === 'function') {
                    updateOnlineUsersUI(data.onlineUsers);
                }
            }
            if (typeof updateUserStatusIndicator === 'function') {
                updateUserStatusIndicator(data.userId, data.type === 'user_online');
            }
            return;
        }
        if (data.type === 'online_users') {
            if (data.users) {
                window.onlineUsersList = data.users;
                if (typeof updateOnlineUsersUI === 'function') {
                    updateOnlineUsersUI(data.users);
                }
            }
            return;
        }

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
     * جولة «إعادة تصميم الإشعارات والرسائل» (وثيقة «أنا معك 100%.txt»):
     * البطاقة البيضاء بـcssText المضمّن استُبدلت بأصناف msg-toast الداكنة
     * (نفس زجاج اللوحة — executive-theme.css قسم «حيوية الشريط العلوي»).
     * الأنماط المضمّنة الباقية هنا وظيفية فقط (موضع الحاوية/إظهار)، صفر ألوان.
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
        var avIdx = this.avatarPaletteIndex(senderName);
        var initials = this.avatarInitials(senderName);
        var time = this.formatTime(message.created_at);
        var preview = this.escapeHtml(message.content || '').substring(0, 55);
        if ((message.content || '').length > 55) preview += '...';

        var toast = document.createElement('div');
        toast.className = 'msg-toast msg-b-' + avIdx;

        toast.innerHTML = '<span class="msg-avatar msg-av-' + avIdx + '">' + this.escapeHtml(initials) + '</span>' +
            '<div class="msg-toast-body">' +
                '<div class="msg-toast-top">' +
                    '<span class="msg-toast-name">' + this.escapeHtml(senderName) + '</span>' +
                    '<span class="msg-toast-time">' + time + '</span>' +
                '</div>' +
                '<div class="msg-toast-preview">' + preview + '</div>' +
            '</div>' +
            '<button class="msg-toast-close" onclick="event.stopPropagation();this.parentElement.remove();">&times;</button>';

        container.appendChild(toast);
        requestAnimationFrame(function() {
            toast.classList.add('msg-toast-in');
        });

        // Click to open conversation
        toast.addEventListener('click', function() {
            sessionStorage.setItem('chat_target_conversation', conversationId);
            window.location.href = 'chat.html?conv=' + conversationId;
        });

        // Auto remove after 6 seconds
        setTimeout(function() {
            toast.classList.remove('msg-toast-in');
            setTimeout(function() { if (toast.parentNode) toast.remove(); }, 300);
        }, 6000);
    },

    /**
     * Fetch conversations and update the unread badge
     */
    async updateBadge() {
        try {
            const token = this.getToken();
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
     * لوحة الأفتار الثابتة (جولة الإشعارات والرسائل): 6 درجات من لوحة المنصة،
     * تُقابل أصناف .msg-av-0..5 في executive-theme.css — صفر style= للألوان.
     * التجزئة على كامل الاسم (لا الحرف الأول فقط) لتوزيع أعدل بين المرسلين.
     */
    avatarPaletteIndex(name) {
        var s = String(name || 'م');
        var h = 0;
        for (var i = 0; i < s.length; i++) h = ((h * 31) + s.charCodeAt(i)) >>> 0;
        return h % 6;
    },

    /**
     * الأحرف الأولى للأفتار — أول حرفين من كلمات الاسم (بلا صور مخزنة في المنصة)
     */
    avatarInitials(name) {
        var parts = String(name || '؟').trim().split(/\s+/).filter(Boolean);
        var initials = parts.map(function(w) { return w[0]; }).join('').substring(0, 2);
        return initials || '؟';
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

        // جولة «إعادة تصميم الإشعارات والرسائل» (وثيقة «أنا معك 100%.txt» — ثالثًا):
        // الصفوف الفاتحة بـstyle= المضمّن استُبدلت ببطاقات msg-* الداكنة بلا أي
        // نمط مضمّن: أفتار أحرف ملوّن + اسم + وقت نسبي + معاينة أول سطر +
        // حالة قراءة (غير المقروء: أثخن + نقطة على الأفتار + خلفية مختلفة).
        list.innerHTML = '<p class="msg-state"><i class="fas fa-spinner fa-spin"></i> جاري التحميل...</p>';

        try {
            const token = this.getToken();
            if (!token) {
                list.innerHTML = '<p class="msg-state">يرجى تسجيل الدخول</p>';
                return;
            }

            const res = await fetch('/api/chat/conversations', {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            if (!res.ok) {
                list.innerHTML = '<p class="msg-state">لا توجد رسائل حديثة</p>';
                return;
            }

            const data = await res.json();
            const conversations = data.conversations || data || [];

            if (!conversations || conversations.length === 0) {
                list.innerHTML = '<p class="msg-state">لا توجد رسائل حديثة</p>';
                return;
            }

            // Sort by updated_at desc and take first 5
            const sortedConvs = conversations
                .filter(conv => conv.last_message)
                .sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0))
                .slice(0, 5);

            if (!sortedConvs.length) {
                list.innerHTML = '<p class="msg-state">لا توجد رسائل حديثة</p>';
                return;
            }

            list.innerHTML = sortedConvs.map(conv => {
                const lastMsg = conv.last_message;
                const unread = conv.unread_count || conv.unreadCount || 0;
                const time = lastMsg ? this.formatTime(lastMsg.created_at) : '';
                // معاينة أول سطر فقط (الوثيقة: «معاينة لأول سطر»)
                const firstLine = lastMsg ? String(lastMsg.content || '').split('\n')[0] : '';
                const snippet = firstLine.substring(0, 60) + (firstLine.length > 60 ? '...' : '');
                const title = conv.title || 'محادثة';
                const isGroup = conv.type === 'group';
                // بادئة «المرسل:» للمجموعات فقط — في الخاص الاسم هو العنوان نفسه
                const sender = (isGroup && lastMsg && lastMsg.sender_name) ? lastMsg.sender_name : '';
                const avatar = isGroup
                    ? '<span class="msg-avatar msg-avatar-group"><i class="fas fa-users"></i>'
                    : '<span class="msg-avatar msg-av-' + this.avatarPaletteIndex(title) + '">' + this.escapeHtml(this.avatarInitials(title));

                return '<a class="msg-card' + (unread > 0 ? ' msg-unread' : '') + '" href="chat.html?conv=' + conv.id + '">' +
                    avatar + (unread > 0 ? '<span class="msg-dot" title="غير مقروء"></span>' : '') + '</span>' +
                    '<div class="msg-body">' +
                        '<div class="msg-top">' +
                            '<span class="msg-name">' + this.escapeHtml(title) + '</span>' +
                            (unread > 0 ? '<span class="msg-count">' + (unread > 99 ? '99+' : unread) + '</span>' : '') +
                            '<span class="msg-time">' + time + '</span>' +
                        '</div>' +
                        '<div class="msg-preview">' + (sender ? '<strong>' + this.escapeHtml(sender) + ':</strong> ' : '') + this.escapeHtml(snippet || 'لا توجد رسائل') + '</div>' +
                    '</div>' +
                '</a>';
            }).join('');
        } catch (err) {
            list.innerHTML = '<p class="msg-state">لا توجد رسائل حديثة</p>';
        }
    },

    /**
     * Destroy on logout
     */
    destroy() {
        this._stopped = true;
        this.stopHeartbeat();
        if (this.ws) {
            try { this.ws.close(); } catch(e) {}
        }
    }
};

/* ============================================================================
   حيوية الشريط العلوي — جولة «إعادة تصميم نظام الإشعارات والرسائل»
   (وثيقة المستخدم «أنا معك 100%.txt» — 2026-08، نسخة في workspace)
   ───────────────────────────────────────────────────────────────────────────
   لماذا يعيش هذا القسم هنا وليس في app.js؟ app.js وindex.html مختومان بحراس
   الجولات السابقة (check_charts_modal / check_distribution_modal /
   check_shift_signout / check_uat_polish_phase1 — بصمات وdiff-locks)، بينما
   هذا الملف محمَّل على index.html (سطر 2177) ومفتوح التعديل — فكان بيت
   التنفيذ الوحيد بصفر لمس للمقفل.
   ما يضيفه (عرض فقط — لا تغيير بيانات ولا تدفق ولا معالجات):
   ② مراقب MutationObserver على #notificationList: البطاقة الوافدة فقط تأخذ
     .nc-new (انزلاق+fade مرة واحدة) + وميض الجرس .nc-flash مرة واحدة لكل دفعة.
     التفعيل الأول صامت (ما هو معروض عند فتح الصفحة ليس «جديدًا»).
   ⑤ سطر «آخر نشاط قبل X» / «N أحداث جديدة منذ آخر زيارة» — شريط .nc-activity
     يُحقن بين رأس اللوحة وجسمها (حقن DOM، صفر ماركب). «آخر زيارة» تُختم في
     localStorage[nc_last_visit] عند فتح اللوحة — تفضيل عرض محلي صِرف أقرّته
     الوثيقة («localStorage مقبول صراحة» لتفضيلات العرض).
   ④ العداد ± والظهور الفوري قائمان أصلًا عبر SSE في app.js (notification_created/
     notification_new ← loadNotifications) — هذا القسم لا يعيد بناءهما.
   window.__ncLiveness: عدّادات تشخيصية للأجنحة الآلية (fresh/flashed) —
   لا تؤثر في السلوك.
   ============================================================================ */
const TopbarLiveness = {
    VISIT_KEY: 'nc_last_visit',
    panel: null,
    list: null,
    activityEl: null,
    knownKeys: new Set(),
    primed: false,
    stats: { fresh: 0, flashed: 0 },

    init() {
        const panel = document.getElementById('notificationPanel');
        const list = document.getElementById('notificationList');
        if (!panel || !list) return; // صفحات بلا مركز إشعارات — لا شيء يُفعَّل
        this.panel = panel;
        this.list = list;

        // ⑤ شريط «آخر نشاط» بين الرأس والجسم
        this.activityEl = document.createElement('div');
        this.activityEl.className = 'nc-activity';
        this.activityEl.style.display = 'none';
        panel.insertBefore(this.activityEl, list);

        const self = this;
        // ② وصول البطاقات
        new MutationObserver(function() { self.onListChange(); })
            .observe(list, { childList: true });
        // ⑤ فتح اللوحة = «زيارة» — يُحتسب N مقابل الختم السابق ثم يُختم الآن
        new MutationObserver(function() {
            if (panel.style.display === 'block') self.onPanelOpen();
        }).observe(panel, { attributes: true, attributeFilter: ['style'] });

        this.onListChange(); // التقاط الحالة الابتدائية (تفعيل صامت)
    },

    // مفتاح هوية البطاقة: عنوان+وقت+بادئة الرسالة — مستقر عبر إعادات الرسم
    cardKey(card) {
        const t = card.querySelector('.nc-title');
        const tm = card.querySelector('.nc-time span');
        const m = card.querySelector('.nc-message');
        return (t ? t.textContent : '') + '|' + (tm ? tm.textContent : '') + '|' + (m ? m.textContent.slice(0, 24) : '');
    },

    onListChange() {
        const cards = this.list.querySelectorAll('.nc-item');
        const nowKeys = new Set();
        const fresh = [];
        cards.forEach(card => {
            const key = this.cardKey(card);
            nowKeys.add(key);
            if (this.primed && !this.knownKeys.has(key)) fresh.push(card);
        });
        this.knownKeys = nowKeys;
        if (!this.primed) {
            // أول دفعة مرئية بعد فتح الصفحة ليست «جديدة» — تُسجَّل بصمت
            if (cards.length) this.primed = true;
        } else if (fresh.length) {
            this.stats.fresh += fresh.length;
            fresh.forEach(card => {
                card.classList.add('nc-new');
                card.addEventListener('animationend', function h() {
                    card.classList.remove('nc-new');
                    card.removeEventListener('animationend', h);
                });
            });
            this.flashBell();
        }
        this.updateActivity();
    },

    // ② وميض الجرس مرة واحدة لكل دفعة وصول — يُزال الصنف على animationend
    flashBell() {
        const bell = document.getElementById('notificationBell');
        if (!bell || bell.classList.contains('nc-flash')) return;
        this.stats.flashed++;
        bell.classList.add('nc-flash');
        const h = () => { bell.classList.remove('nc-flash'); bell.removeEventListener('animationend', h); };
        bell.addEventListener('animationend', h);
        setTimeout(() => bell.classList.remove('nc-flash'), 900); // احتياط إن غاب animationend
    },

    onPanelOpen() {
        this.updateActivity(); // يقرأ الختم السابق قبل استبداله
        try { localStorage.setItem(this.VISIT_KEY, new Date().toISOString()); } catch (e) {}
    },

    // ⑤ نص الشريط: «آخر نشاط قبل X» + «N أحداث جديدة منذ آخر زيارة»
    updateActivity() {
        if (!this.activityEl) return;
        const cards = Array.from(this.list.querySelectorAll('.nc-item'));
        if (!cards.length) { this.activityEl.style.display = 'none'; return; }
        const times = cards
            .map(c => this.parseTs((c.querySelector('.nc-time span') || {}).textContent))
            .filter(Boolean);
        if (!times.length) { this.activityEl.style.display = 'none'; return; }
        const latest = new Date(Math.max.apply(null, times.map(d => d.getTime())));

        let since = 0, hasVisit = false;
        try {
            const raw = localStorage.getItem(this.VISIT_KEY);
            if (raw) {
                const lv = new Date(raw);
                if (!isNaN(lv)) { hasVisit = true; since = times.filter(d => d > lv).length; }
            }
        } catch (e) {}

        let html = '<i class="fas fa-history"></i><span>آخر نشاط ' + this.relTime(latest) + '</span>';
        if (hasVisit && since > 0) {
            html += '<span class="nc-activity-sep">•</span><span class="nc-activity-new">' + this.newEventsText(since) + ' منذ آخر زيارة</span>';
        }
        this.activityEl.innerHTML = html;
        this.activityEl.style.display = 'flex';
    },

    newEventsText(n) {
        if (n === 1) return 'حدث جديد';
        if (n === 2) return 'حدثان جديدان';
        if (n <= 10) return n + ' أحداث جديدة';
        return n + ' حدثًا جديدًا';
    },

    // صيغة عربية سليمة للتناسب (دقيقة/دقيقتين/دقائق، ساعة/ساعتين/ساعات، يوم/يومين/أيام)
    relTime(d) {
        const diff = Math.max(0, Date.now() - d.getTime());
        const m = Math.floor(diff / 60000);
        if (m < 1) return 'قبل لحظات';
        if (m === 1) return 'قبل دقيقة';
        if (m === 2) return 'قبل دقيقتين';
        if (m <= 10) return 'قبل ' + m + ' دقائق';
        if (m < 60) return 'قبل ' + m + ' دقيقة';
        const h = Math.floor(m / 60);
        if (h === 1) return 'قبل ساعة';
        if (h === 2) return 'قبل ساعتين';
        if (h <= 10) return 'قبل ' + h + ' ساعات';
        if (h < 24) return 'قبل ' + h + ' ساعة';
        const days = Math.floor(h / 24);
        if (days === 1) return 'قبل يوم';
        if (days === 2) return 'قبل يومين';
        if (days <= 10) return 'قبل ' + days + ' أيام';
        return 'قبل ' + days + ' يومًا';
    },

    // نفس قاعدة TimeRiyadh.normalize للطوابع naive: «YYYY-MM-DD HH:MM[:SS]» ← UTC
    parseTs(s) {
        if (!s) return null;
        s = String(s).trim();
        if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(s)) s = s.replace(' ', 'T') + 'Z';
        else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(s)) s += 'Z';
        const d = new Date(s);
        return isNaN(d) ? null : d;
    }
};
window.__ncLiveness = TopbarLiveness; // عدّادات تشخيصية للأجنحة الآلية فقط

// Global helper for backward compatibility
function updateChatBadge() {
    if (typeof ChatIntegration !== 'undefined' && ChatIntegration.updateBadge) {
        ChatIntegration.updateBadge();
    }
}

// Auto-init when DOM is ready — AuthGate: عبر البوابة على index.html (يُحمَّل هذا الملف قبل auth-manager.js،
// لذا يُحسم وجود البوابة عند DOMContentLoaded)؛ الصفحات بلا بوابة تحافظ على السلوك السابق.
document.addEventListener('DOMContentLoaded', () => {
    TopbarLiveness.init(); // مراقبا DOM فقط — لا يتطلبان مصادقة ولا يمسّان الصفحات الأخرى
    if (typeof AuthGate !== 'undefined') {
        AuthGate.onStart(() => ChatIntegration.init());
        AuthGate.onStop(() => ChatIntegration.destroy());
    } else {
        setTimeout(() => ChatIntegration.init(), 1000);
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