// ============================================
// Chat Module — منصة الجنوب (Enhanced v2)
// Features: Instant WebSocket, Toast Notifications, Read Receipts,
//           Real-time Online Status, Sound Alerts, Smart Filtering
// ============================================

(function() {
    'use strict';

    // ===== Auth Token =====
    var authToken = localStorage.getItem('authToken');
    if (!authToken) {
        location.href = 'index.html';
        return;
    }

    // ===== Sound / Notification State =====
    var audioContextUnlocked = false;
    var notificationPermission = false;
    var soundSettings = {
        enabled: true,
        volume: 0.3
    };

    // Load sound settings
    (function loadSoundSettings() {
        try {
            var saved = localStorage.getItem('chat_sound_settings');
            if (saved) {
                var parsed = JSON.parse(saved);
                soundSettings.enabled = parsed.enabled !== false;
                soundSettings.volume = parsed.volume || 0.3;
            }
        } catch(e) {}
    })();

    var chatState = {
        conversations: [],
        currentConversation: null,
        messages: [],
        users: [],
        onlineUsers: [], // Array of user IDs
        unreadTotal: 0,
        isTyping: false,
        currentUser: null,
        typingTimeout: null,
        messagePage: 1,
        hasMoreMessages: false,
        isLoadingMessages: false,
        selectedParticipants: new Set()
    };

    // ===== DOM Cache =====
    var $ = function(id) { return document.getElementById(id); };

    // ===== Helpers =====
    function getAuthHeaders() {
        return {
            'Authorization': 'Bearer ' + authToken,
            'Content-Type': 'application/json'
        };
    }

    function formatTime(dateStr) {
        if (!dateStr) return '';
        var d = new Date(dateStr);
        if (isNaN(d.getTime())) return '';
        var now = new Date();
        var isToday = d.toDateString() === now.toDateString();
        if (isToday) {
            return d.toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit', hour12: false });
        }
        var yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
        if (d.toDateString() === yesterday.toDateString()) return 'أمس';
        return d.toLocaleDateString('ar-SA', { month: 'short', day: 'numeric' });
    }

    function formatDateDivider(dateStr) {
        if (!dateStr) return '';
        var d = new Date(dateStr);
        if (isNaN(d.getTime())) return '';
        var now = new Date();
        var isToday = d.toDateString() === now.toDateString();
        if (isToday) return 'اليوم';
        var yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
        if (d.toDateString() === yesterday.toDateString()) return 'أمس';
        return d.toLocaleDateString('ar-SA', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    }

    function escapeHtml(text) {
        if (!text) return '';
        var div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function debounce(fn, ms) {
        var t;
        return function() {
            clearTimeout(t);
            t = setTimeout(fn.bind.apply(fn, [this].concat(Array.prototype.slice.call(arguments))), ms);
        };
    }

    // ===== Sound System (Web Audio API) =====
    var audioCtx = null;

    function getAudioContext() {
        if (!audioCtx) {
            var AudioContext = window.AudioContext || window.webkitAudioContext;
            if (AudioContext) {
                audioCtx = new AudioContext();
            }
        }
        return audioCtx;
    }

    function unlockAudio() {
        if (audioContextUnlocked) return;
        audioContextUnlocked = true;
        var ctx = getAudioContext();
        if (ctx && ctx.state === 'suspended') {
            ctx.resume();
        }
    }

    // Unlock audio on first user interaction
    document.addEventListener('click', unlockAudio, { once: true });
    document.addEventListener('keydown', unlockAudio, { once: true });

    function playNotificationSound() {
        if (!soundSettings.enabled) return;
        if (!audioContextUnlocked) return;
        
        try {
            var ctx = getAudioContext();
            if (!ctx) return;
            var now = ctx.currentTime;

            // Two-tone notification (WhatsApp-like)
            var osc1 = ctx.createOscillator();
            var gain1 = ctx.createGain();
            osc1.connect(gain1);
            gain1.connect(ctx.destination);
            osc1.type = 'sine';
            osc1.frequency.setValueAtTime(830, now);
            osc1.frequency.setValueAtTime(660, now + 0.08);
            gain1.gain.setValueAtTime(soundSettings.volume, now);
            gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
            osc1.start(now);
            osc1.stop(now + 0.25);

            var osc2 = ctx.createOscillator();
            var gain2 = ctx.createGain();
            osc2.connect(gain2);
            gain2.connect(ctx.destination);
            osc2.type = 'sine';
            osc2.frequency.setValueAtTime(1047, now + 0.12);
            osc2.frequency.setValueAtTime(830, now + 0.2);
            gain2.gain.setValueAtTime(soundSettings.volume * 0.8, now + 0.12);
            gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
            osc2.start(now + 0.12);
            osc2.stop(now + 0.4);
        } catch(e) {
            console.log('[Chat] Sound error:', e.message);
        }
    }

    function playSentSound() {
        if (!soundSettings.enabled) return;
        if (!audioContextUnlocked) return;
        try {
            var ctx = getAudioContext();
            if (!ctx) return;
            var now = ctx.currentTime;
            var osc = ctx.createOscillator();
            var gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.type = 'sine';
            osc.frequency.setValueAtTime(600, now);
            gain.gain.setValueAtTime(soundSettings.volume * 0.4, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
            osc.start(now);
            osc.stop(now + 0.1);
        } catch(e) {}
    }

    // ===== Toast Notification System =====
    var ToastSystem = {
        container: null,
        stack: [],
        maxStack: 5,
        duration: 6000,

        init: function() {
            this.container = document.createElement('div');
            this.container.id = 'chatToastContainer';
            this.container.className = 'chat-toast-container';
            this.container.setAttribute('dir', 'rtl');
            document.body.appendChild(this.container);
        },

        show: function(data) {
            if (!this.container) this.init();

            var senderName = data.senderName || 'مستخدم';
            var senderId = data.senderId || '';
            var conversationId = data.conversationId;
            var messageContent = data.content || '';
            var messageId = data.messageId;
            var timestamp = data.timestamp || new Date().toISOString();

            // Smart filter: Don't show if viewing this conversation
            if (chatState.currentConversation &&
                String(chatState.currentConversation.id) === String(conversationId)) {
                return;
            }

            // Smart filter: Don't show own messages
            if (senderId && chatState.currentUser && String(senderId) === String(chatState.currentUser.id)) {
                return;
            }

            // Limit stack
            if (this.stack.length >= this.maxStack) {
                var oldest = this.stack.shift();
                this._remove(oldest.el);
            }

            var toast = this._createElement(senderName, messageContent, timestamp, conversationId);
            this.container.appendChild(toast);

            // Animate in
            requestAnimationFrame(function() {
                toast.classList.add('chat-toast-visible');
            });

            var obj = { el: toast, conversationId: conversationId, messageId: messageId };
            this.stack.push(obj);

            // Play sound
            playNotificationSound();

            // Auto remove
            setTimeout(function() {
                ToastSystem._remove(toast);
            }, this.duration);
        },

        _createElement: function(senderName, content, timestamp, conversationId) {
            var toast = document.createElement('div');
            toast.className = 'chat-toast';
            toast.dataset.conversationId = conversationId;

            var initials = senderName.split(' ').map(function(w) { return w[0]; }).join('').substring(0, 2);
            var colors = ['#0D9488', '#3B82F6', '#8B5CF6', '#EC4899', '#F59E0B', '#10B981'];
            var color = colors[senderName.charCodeAt(0) % colors.length];
            var time = formatTime(timestamp);
            var preview = escapeHtml(content).substring(0, 60);
            if (content.length > 60) preview += '...';

            toast.innerHTML =
                '<div class="chat-toast-avatar" style="background:' + color + '"><span>' + initials + '</span></div>' +
                '<div class="chat-toast-body">' +
                    '<div class="chat-toast-header">' +
                        '<span class="chat-toast-name">' + escapeHtml(senderName) + '</span>' +
                        '<span class="chat-toast-time">' + time + '</span>' +
                    '</div>' +
                    '<div class="chat-toast-preview">' + preview + '</div>' +
                '</div>' +
                '<button class="chat-toast-close" title="إغلاق">&times;</button>';

            // Click to open conversation
            toast.addEventListener('click', function(e) {
                if (e.target.closest('.chat-toast-close')) return;
                window.openConversation(conversationId);
                ToastSystem._remove(toast);
            });

            toast.querySelector('.chat-toast-close').addEventListener('click', function(e) {
                e.stopPropagation();
                ToastSystem._remove(toast);
            });

            return toast;
        },

        _remove: function(el) {
            if (!el || !el.parentNode) return;
            el.classList.remove('chat-toast-visible');
            el.classList.add('chat-toast-hiding');
            setTimeout(function() {
                if (el.parentNode) el.parentNode.removeChild(el);
                ToastSystem.stack = ToastSystem.stack.filter(function(t) { return t.el !== el; });
            }, 300);
        },

        clearAll: function() {
            this.stack.forEach(function(t) { ToastSystem._remove(t.el); });
            this.stack = [];
        }
    };

    // ===== API =====
    var ChatAPI = {
        getConversations: async function() {
            var res = await fetch('/api/chat/conversations', { headers: { 'Authorization': 'Bearer ' + authToken } });
            if (!res.ok) throw new Error('Failed to load conversations');
            return res.json();
        },
        getMessages: async function(convId, page) {
            page = page || 1;
            var res = await fetch('/api/chat/conversations/' + encodeURIComponent(convId) + '/messages?page=' + page, {
                headers: { 'Authorization': 'Bearer ' + authToken }
            });
            if (!res.ok) throw new Error('Failed to load messages');
            return res.json();
        },
        sendMessage: async function(convId, data) {
            var res = await fetch('/api/chat/conversations/' + encodeURIComponent(convId) + '/messages', {
                method: 'POST',
                headers: getAuthHeaders(),
                body: JSON.stringify(data)
            });
            if (!res.ok) throw new Error('Failed to send message');
            return res.json();
        },
        markRead: async function(messageId) {
            var res = await fetch('/api/chat/messages/' + encodeURIComponent(messageId) + '/read', {
                method: 'PUT',
                headers: { 'Authorization': 'Bearer ' + authToken }
            });
            if (!res.ok) throw new Error('Failed to mark read');
            return res.json();
        },
        markConversationRead: async function(convId) {
            // Mark all messages in conversation as read
            if (!chatState.messages || chatState.messages.length === 0) return;
            var unreadMessages = chatState.messages.filter(function(m) {
                return m.sender_id !== chatState.currentUser.id && !isMessageReadByMe(m);
            });
            for (var i = 0; i < unreadMessages.length; i++) {
                try { await ChatAPI.markRead(unreadMessages[i].id); } catch(e) {}
            }
        },
        createGroup: async function(title, participantIds) {
            var res = await fetch('/api/chat/conversations', {
                method: 'POST',
                headers: getAuthHeaders(),
                body: JSON.stringify({ type: 'group', title: title, participant_ids: participantIds })
            });
            if (!res.ok) throw new Error('Failed to create group');
            return res.json();
        },
        startPrivateChat: async function(userId) {
            var res = await fetch('/api/chat/conversations/private', {
                method: 'POST',
                headers: getAuthHeaders(),
                body: JSON.stringify({ user_id: userId })
            });
            if (!res.ok) throw new Error('Failed to start chat');
            return res.json();
        },
        getUsers: async function() {
            var res = await fetch('/api/chat/users', { headers: { 'Authorization': 'Bearer ' + authToken } });
            if (!res.ok) throw new Error('Failed to load users');
            return res.json();
        },
        getOnlineUsers: async function() {
            var res = await fetch('/api/chat/online', { headers: { 'Authorization': 'Bearer ' + authToken } });
            if (!res.ok) throw new Error('Failed to load online users');
            return res.json();
        }
    };

    // ===== Check if message is read by current user =====
    function isMessageReadByMe(message) {
        if (!message.read_by || !Array.isArray(message.read_by)) return false;
        if (!chatState.currentUser) return false;
        return message.read_by.some(function(r) {
            var rId = r.user_id !== undefined ? r.user_id : r.userId;
            return String(rId) === String(chatState.currentUser.id);
        });
    }

    // ===== WebSocket (Enhanced) =====
    var ChatSocket = {
        ws: null,
        connected: false,
        reconnectAttempts: 0,
        maxReconnectDelay: 30000,
        heartbeatInterval: null,
        messageCallbacks: [],
        typingCallbacks: [],
        readCallbacks: [],
        presenceCallbacks: [],

        connect: function() {
            var protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
            var wsUrl = protocol + '//' + location.host + '/ws';
            // Include token in the WebSocket protocol header for auth
            try {
                this.ws = new WebSocket(wsUrl, authToken);
                var self = this;

                this.ws.onopen = function() {
                    self.connected = true;
                    self.reconnectAttempts = 0;
                    console.log('[ChatSocket] Connected');
                    
                    // Subscribe to current conversation if any
                    if (chatState.currentConversation) {
                        self.subscribe(chatState.currentConversation.id);
                    }
                    // Subscribe to all conversations for instant delivery
                    chatState.conversations.forEach(function(conv) {
                        self.subscribe(conv.id);
                    });
                    
                    // Start heartbeat
                    self.startHeartbeat();
                    
                    // Send presence
                    self.sendPresence();
                    
                    // Update connection status indicator
                    updateConnectionStatus(true);
                };

                this.ws.onmessage = function(event) {
                    try {
                        var data = JSON.parse(event.data);
                        self.handleMessage(data);
                    } catch (e) {
                        console.error('[ChatSocket] Parse error:', e);
                    }
                };

                this.ws.onerror = function(err) {
                    console.error('[ChatSocket] Error:', err);
                    updateConnectionStatus(false);
                };

                this.ws.onclose = function() {
                    self.connected = false;
                    self.stopHeartbeat();
                    updateConnectionStatus(false);
                    
                    // Exponential backoff reconnect
                    var delay = Math.min(1000 * Math.pow(2, self.reconnectAttempts), self.maxReconnectDelay);
                    self.reconnectAttempts++;
                    console.log('[ChatSocket] Disconnected, reconnecting in', delay, 'ms (attempt', self.reconnectAttempts, ')');
                    setTimeout(function() { self.connect(); }, delay);
                };
            } catch (e) {
                console.error('[ChatSocket] Init error:', e);
            }
        },

        startHeartbeat: function() {
            this.stopHeartbeat();
            var self = this;
            this.heartbeatInterval = setInterval(function() {
                if (self.connected && self.ws && self.ws.readyState === WebSocket.OPEN) {
                    self.ws.send(JSON.stringify({ type: 'ping' }));
                }
            }, 25000);
        },

        stopHeartbeat: function() {
            if (this.heartbeatInterval) {
                clearInterval(this.heartbeatInterval);
                this.heartbeatInterval = null;
            }
        },

        handleMessage: function(data) {
            // Heartbeat response
            if (data.type === 'pong' || data.type === 'ping') {
                return;
            }
            if (data.type === 'connected') {
                console.log('[ChatSocket]:', data.message);
                // Update online users list from server
                if (data.onlineUsers) {
                    chatState.onlineUsers = data.onlineUsers.map(function(u) { return u.id; });
                    updateAllOnlineStatuses();
                }
                return;
            }
            if (data.type === 'online_users_list') {
                if (data.users) {
                    chatState.onlineUsers = data.users.map(function(u) { return u.id; });
                    updateAllOnlineStatuses();
                }
                return;
            }
            if (data.type === 'chat_message') {
                this.messageCallbacks.forEach(function(cb) { cb(data); });
            } else if (data.type === 'chat_typing') {
                this.typingCallbacks.forEach(function(cb) { cb(data); });
            } else if (data.type === 'chat_read') {
                this.readCallbacks.forEach(function(cb) { cb(data); });
            } else if (data.type === 'user_online') {
                // Add to online users
                if (data.userId && !chatState.onlineUsers.includes(data.userId)) {
                    chatState.onlineUsers.push(data.userId);
                }
                this.presenceCallbacks.forEach(function(cb) {
                    cb({ userId: data.userId, name: data.name, status: 'online', timestamp: data.timestamp });
                });
            } else if (data.type === 'user_offline') {
                // Remove from online users
                chatState.onlineUsers = chatState.onlineUsers.filter(function(id) {
                    return id !== data.userId;
                });
                this.presenceCallbacks.forEach(function(cb) {
                    cb({ userId: data.userId, name: data.name, status: 'offline', timestamp: data.timestamp });
                });
            } else if (data.type === 'chat_presence_ack') {
                // Server acknowledged our presence - we're online
                return;
            }
        },

        onMessage: function(callback) {
            this.messageCallbacks.push(callback);
        },

        onTyping: function(callback) {
            this.typingCallbacks.push(callback);
        },

        onRead: function(callback) {
            this.readCallbacks.push(callback);
        },

        onPresence: function(callback) {
            this.presenceCallbacks.push(callback);
        },

        sendTyping: function(conversationId) {
            if (!this.connected || !this.ws) return;
            this.ws.send(JSON.stringify({
                type: 'chat_typing',
                conversationId: conversationId,
                user: chatState.currentUser ? { id: chatState.currentUser.id, name: chatState.currentUser.name } : null
            }));
        },

        subscribe: function(conversationId) {
            if (!this.connected || !this.ws) return;
            this.ws.send(JSON.stringify({
                type: 'chat_subscribe',
                conversationId: conversationId
            }));
        },

        unsubscribe: function(conversationId) {
            if (!this.connected || !this.ws) return;
            this.ws.send(JSON.stringify({
                type: 'chat_unsubscribe',
                conversationId: conversationId
            }));
        },

        sendPresence: function() {
            if (!this.connected || !this.ws) return;
            this.ws.send(JSON.stringify({
                type: 'chat_presence',
                userId: chatState.currentUser ? chatState.currentUser.id : null,
                name: chatState.currentUser ? chatState.currentUser.name : null
            }));
        },

        sendLogout: function() {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ type: 'logout' }));
            }
        }
    };

    // ===== Connection Status Indicator =====
    function updateConnectionStatus(isConnected) {
        var statusEl = $('sidebarUserStatus');
        if (!statusEl) return;
        
        if (isConnected) {
            statusEl.innerHTML = '<span class="status-dot online"></span> متصل';
        } else {
            statusEl.innerHTML = '<span class="status-dot offline" style="background:#EF4444"></span> جاري الاتصال...';
        }
    }

    // ===== UI Components =====
    function renderConversationList(conversations) {
        var list = $('conversationList');
        if (!conversations || conversations.length === 0) {
            list.innerHTML = '<div class="sidebar-empty"><i class="fas fa-inbox"></i><span>لا توجد محادثات</span></div>';
            return;
        }

        var html = '';
        conversations.forEach(function(conv) {
            var isActive = chatState.currentConversation && chatState.currentConversation.id === conv.id;
            var lastMsg = conv.last_message;
            var preview = lastMsg ? lastMsg.content : 'لا توجد رسائل';
            var time = lastMsg ? formatTime(lastMsg.created_at) : formatTime(conv.updated_at);
            var unread = conv.unread_count || 0;
            var avatarIcon = conv.type === 'group' ? 'fa-users' : 'fa-user';
            var activeClass = isActive ? 'active' : '';

            // Check if other participant is online (for private chats)
            var otherOnline = false;
            if (conv.type === 'private') {
                var otherParticipant = conv.participants.find(function(p) {
                    return p.user_id !== (chatState.currentUser ? chatState.currentUser.id : null);
                });
                if (otherParticipant) {
                    otherOnline = chatState.onlineUsers.includes(otherParticipant.user_id);
                }
            }

            html += '<div class="conversation-item ' + activeClass + '" data-id="' + conv.id + '" onclick="openConversation(' + conv.id + ')">' +
                '<div class="conversation-avatar ' + (conv.type === 'group' ? 'group' : '') + '">' +
                    '<i class="fas ' + avatarIcon + '"></i>' +
                    (conv.type === 'private' ? '<span class="avatar-status ' + (otherOnline ? 'online' : 'offline') + '"></span>' : '') +
                '</div>' +
                '<div class="conversation-info">' +
                    '<div class="conversation-top">' +
                        '<span class="conversation-name">' + escapeHtml(conv.title) + '</span>' +
                        '<span class="conversation-time">' + time + '</span>' +
                    '</div>' +
                    '<div class="conversation-bottom">' +
                        '<span class="conversation-preview">' + escapeHtml(preview) + '</span>' +
                        (unread > 0 ? '<span class="conversation-unread">' + unread + '</span>' : '') +
                    '</div>' +
                '</div>' +
            '</div>';
        });

        list.innerHTML = html;
        updateUnreadTotal(conversations);
    }

    function updateUnreadTotal(conversations) {
        var total = 0;
        if (conversations) {
            conversations.forEach(function(c) { total += (c.unread_count || 0); });
        }
        chatState.unreadTotal = total;
        if (total > 0) {
            document.title = '(' + total + ') المراسلات \u2013 منصة إدارة العمليات الإسعافية';
        } else {
            document.title = 'الدردشة \u2013 منصة إدارة العمليات الإسعافية';
        }
    }

    // ===== Read Receipt Status =====
    function getReadStatusHtml(message, isMine) {
        if (!isMine) return '';

        var readCount = 0;
        var totalParticipants = (chatState.currentConversation && chatState.currentConversation.participants
            ? chatState.currentConversation.participants.length : 2);
        var otherReaders = 0;

        if (message.read_by && Array.isArray(message.read_by)) {
            message.read_by.forEach(function(r) {
                var rId = r.user_id !== undefined ? r.user_id : r.userId;
                if (String(rId) !== String(message.sender_id)) otherReaders++;
            });
            readCount = message.read_by.length;
        }

        // Check if message has temp- prefix (not yet confirmed by server)
        var isTemp = message.id && String(message.id).startsWith('temp-');

        var statusClass = '';
        var icon = '';
        var title = '';

        if (isTemp) {
            // Sending...
            icon = '<i class="fas fa-clock"></i>';
            statusClass = 'sending';
            title = 'جاري الإرسال...';
        } else if (otherReaders === 0) {
            // Sent (single checkmark)
            icon = '<i class="fas fa-check"></i>';
            statusClass = 'sent';
            title = 'تم الإرسال';
        } else if (otherReaders < totalParticipants - 1) {
            // Delivered to some (double checkmark gray)
            icon = '<i class="fas fa-check-double"></i>';
            statusClass = 'delivered';
            title = 'تم التسليم';
        } else {
            // Read by all (double checkmark blue)
            icon = '<i class="fas fa-check-double"></i>';
            statusClass = 'read';
            title = 'تم القراءة';
        }

        return '<span class="message-read-status ' + statusClass + '" title="' + title + '">' + icon + '</span>';
    }

    function renderMessageBubble(message, isMine) {
        var bubbleClass = isMine ? 'sent' : 'received';
        var time = formatTime(message.created_at);
        var readStatus = getReadStatusHtml(message, isMine);
        var content = escapeHtml(message.content).replace(/\n/g, '<br>');

        var senderName = !isMine && message.sender_name
            ? '<div class="message-sender">' + escapeHtml(message.sender_name) + '</div>' : '';

        return '<div class="message-row ' + (isMine ? 'mine' : 'theirs') + '" data-message-id="' + message.id + '">' +
            '<div class="message-bubble ' + bubbleClass + '">' +
                senderName +
                '<div class="message-content">' + content + '</div>' +
                '<div class="message-meta">' +
                    '<span class="message-time">' + time + '</span>' +
                    readStatus +
                '</div>' +
            '</div>' +
        '</div>';
    }

    function renderTypingIndicator(userName) {
        $('typingText').textContent = (userName || 'يكتب') + '...';
        $('typingIndicator').style.display = 'flex';
    }

    function hideTypingIndicator() {
        $('typingIndicator').style.display = 'none';
    }

    function renderUserList(users, containerId, selectable) {
        var container = $(containerId);
        if (!users || users.length === 0) {
            container.innerHTML = '<div class="sidebar-empty"><span>لا يوجد مستخدمون</span></div>';
            return;
        }

        var currentUserId = chatState.currentUser ? chatState.currentUser.id : null;
        var html = '';
        users.forEach(function(user) {
            if (user.id === currentUserId) return;
            var isSelected = selectable && chatState.selectedParticipants.has(user.id);
            var selectedClass = isSelected ? 'selected' : '';
            var checkHtml = selectable ? '<div class="user-item-check"><i class="fas fa-check"></i></div>' : '';

            // Check online status
            var isOnline = chatState.onlineUsers.includes(user.id);

            html += '<div class="user-item ' + selectedClass + '" data-id="' + user.id + '" data-name="' + escapeHtml(user.name || user.username) + '">' +
                '<div class="user-item-avatar ' + (isOnline ? 'online' : '') + '"><i class="fas fa-user"></i></div>' +
                '<div class="user-item-info">' +
                    '<div class="user-item-name">' + escapeHtml(user.name || user.username) + '</div>' +
                    '<div class="user-item-role">' + escapeHtml(user.role || 'مستخدم') + '</div>' +
                '</div>' +
                checkHtml +
            '</div>';
        });

        container.innerHTML = html;
    }

    // ===== Conversations =====
    async function loadConversations() {
        try {
            var data = await ChatAPI.getConversations();
            chatState.conversations = data.conversations || [];
            renderConversationList(chatState.conversations);
            // Subscribe to all conversations
            chatState.conversations.forEach(function(conv) {
                ChatSocket.subscribe(conv.id);
            });
        } catch (e) {
            console.error('loadConversations:', e);
            showToast('تعذر تحميل المحادثات', 'error');
        }
    }

    window.openConversation = async function(convId) {
        var conv = chatState.conversations.find(function(c) { return c.id === convId; });
        if (!conv) return;

        chatState.currentConversation = conv;
        chatState.messages = [];
        chatState.messagePage = 1;
        chatState.hasMoreMessages = false;
        chatState.isLoadingMessages = false;

        // Update UI
        renderConversationList(chatState.conversations);
        $('chatEmpty').style.display = 'none';
        $('chatActive').style.display = 'flex';

        // Header
        $('chatHeaderName').textContent = conv.title;
        $('chatHeaderAvatar').innerHTML = conv.type === 'group' ? '<i class="fas fa-users"></i>' : '<i class="fas fa-user"></i>';
        $('chatHeaderAvatar').style.background = conv.type === 'group'
            ? 'linear-gradient(135deg, #3B82F6, #60A5FA)'
            : 'linear-gradient(135deg, #0D9488, #14B8A6)';

        // Update header status
        updateChatHeaderStatus(conv);

        // Subscribe to WS
        ChatSocket.subscribe(convId);

        // Load messages
        await loadMessages(convId, 1);

        // Mark unread as read
        if (conv.unread_count > 0) {
            try {
                await ChatAPI.markConversationRead(convId);
                conv.unread_count = 0;
                renderConversationList(chatState.conversations);
            } catch(e) {
                console.error('markConversationRead error:', e);
            }
        }

        // On mobile, close sidebar
        if (window.innerWidth <= 768) {
            closeSidebar();
        }

        // Notify toast system about current conversation
        ToastSystem.currentConversationId = convId;
    };

    function updateChatHeaderStatus(conv) {
        if (!conv) return;
        var statusText = $('chatHeaderStatusText');
        
        if (conv.type === 'group') {
            statusText.textContent = (conv.participants ? conv.participants.length : 0) + ' عضو';
            statusText.classList.remove('online');
        } else {
            // Private chat - check if other participant is online
            var other = conv.participants.find(function(p) {
                return p.user_id !== (chatState.currentUser ? chatState.currentUser.id : null);
            });
            if (other && chatState.onlineUsers.includes(other.user_id)) {
                statusText.textContent = 'متصل الآن';
                statusText.classList.add('online');
            } else {
                statusText.textContent = 'غير متصل';
                statusText.classList.remove('online');
            }
        }
    }

    async function loadMessages(convId, page) {
        if (chatState.isLoadingMessages) return;
        chatState.isLoadingMessages = true;
        $('messagesLoader').style.display = 'flex';

        try {
            var data = await ChatAPI.getMessages(convId, page);
            var newMessages = data.messages || [];
            chatState.hasMoreMessages = newMessages.length >= (data.limit || 50);

            if (page === 1) {
                chatState.messages = newMessages.reverse(); // Oldest first
                $('messagesList').innerHTML = renderMessagesList(chatState.messages);
                scrollToBottom();
            } else {
                var oldScrollHeight = $('chatMessages').scrollHeight;
                chatState.messages = newMessages.reverse().concat(chatState.messages);
                $('messagesList').innerHTML = renderMessagesList(chatState.messages);
                var newScrollHeight = $('chatMessages').scrollHeight;
                $('chatMessages').scrollTop = newScrollHeight - oldScrollHeight;
            }
        } catch (e) {
            console.error('loadMessages:', e);
            showToast('تعذر تحميل الرسائل', 'error');
        } finally {
            chatState.isLoadingMessages = false;
            $('messagesLoader').style.display = 'none';
        }
    }

    function renderMessagesList(messages) {
        if (!messages || messages.length === 0) {
            return '<div class="sidebar-empty" style="padding:40px 20px;"><span>لا توجد رسائل بعد</span></div>';
        }

        var html = '';
        var lastDate = null;
        var currentUserId = chatState.currentUser ? chatState.currentUser.id : null;

        messages.forEach(function(msg) {
            var msgDate = new Date(msg.created_at).toDateString();
            if (msgDate !== lastDate) {
                html += '<div class="date-divider">' + formatDateDivider(msg.created_at) + '</div>';
                lastDate = msgDate;
            }
            var isMine = String(msg.sender_id) === String(currentUserId);
            html += renderMessageBubble(msg, isMine);
        });

        return html;
    }

    function scrollToBottom() {
        var container = $('chatMessages');
        container.scrollTop = container.scrollHeight;
    }

    // ===== Sending Messages =====
    async function sendMessage() {
        var input = $('messageInput');
        var content = input.value.trim();
        if (!content || !chatState.currentConversation) return;

        var convId = chatState.currentConversation.id;
        var tempId = 'temp-' + Date.now();
        var tempMsg = {
            id: tempId,
            sender_id: chatState.currentUser ? chatState.currentUser.id : null,
            sender_name: chatState.currentUser ? chatState.currentUser.name : null,
            content: content,
            created_at: new Date().toISOString(),
            read_by: []
        };

        // Optimistic UI
        chatState.messages.push(tempMsg);
        $('messagesList').innerHTML = renderMessagesList(chatState.messages);
        scrollToBottom();
        input.value = '';
        input.style.height = 'auto';
        $('sendBtn').disabled = true;

        // Play sent sound
        playSentSound();

        try {
            var data = await ChatAPI.sendMessage(convId, { content: content, type: 'text' });
            if (data.success && data.message) {
                // Replace temp message with real one
                var idx = chatState.messages.findIndex(function(m) { return m.id === tempId; });
                if (idx !== -1) {
                    chatState.messages[idx] = data.message;
                    $('messagesList').innerHTML = renderMessagesList(chatState.messages);
                }
                
                // The server will broadcast the message to all participants
                // But also update the conversation list immediately
                conv.last_message = {
                    content: data.message.content,
                    sender_id: data.message.sender_id,
                    created_at: data.message.created_at,
                    sender_name: data.message.sender_name
                };
                conv.updated_at = data.message.created_at;
                chatState.conversations.sort(function(a, b) {
                    return new Date(b.updated_at || 0) - new Date(a.updated_at || 0);
                });
                renderConversationList(chatState.conversations);
            }
        } catch (e) {
            console.error('sendMessage:', e);
            showToast('تعذر إرسال الرسالة', 'error');
            // Mark as failed
            var failIdx = chatState.messages.findIndex(function(m) { return m.id === tempId; });
            if (failIdx !== -1) {
                chatState.messages[failIdx]._failed = true;
                $('messagesList').innerHTML = renderMessagesList(chatState.messages);
            }
        }
    }

    function handleTyping() {
        if (!chatState.currentConversation) return;
        var now = Date.now();
        if (chatState.lastTypingSent && (now - chatState.lastTypingSent) < 2000) return;
        chatState.lastTypingSent = now;
        ChatSocket.sendTyping(chatState.currentConversation.id);
    }

    // ===== Pagination on Scroll =====
    function handleMessagesScroll() {
        var container = $('chatMessages');
        if (container.scrollTop < 50 && chatState.hasMoreMessages && !chatState.isLoadingMessages) {
            chatState.messagePage++;
            loadMessages(chatState.currentConversation.id, chatState.messagePage);
        }
    }

    // ===== Users & Modals =====
    async function loadUsers() {
        try {
            var data = await ChatAPI.getUsers();
            chatState.users = data.users || [];
        } catch (e) {
            console.error('loadUsers:', e);
            showToast('تعذر تحميل قائمة المستخدمين', 'error');
        }
    }

    function openNewChatModal() {
        renderUserList(chatState.users, 'userList', false);
        $('newChatModal').style.display = 'flex';
        $('userSearchInput').value = '';
        $('userSearchInput').focus();
    }

    function openNewGroupModal() {
        chatState.selectedParticipants.clear();
        updateSelectedUsers();
        renderUserList(chatState.users, 'groupUserList', true);
        $('newGroupModal').style.display = 'flex';
        $('groupTitleInput').value = '';
        $('groupUserSearchInput').value = '';
        $('groupTitleInput').focus();
    }

    window.closeModal = function(modalId) {
        $(modalId).style.display = 'none';
    };

    function filterUsers(query, listId, selectable) {
        query = (query || '').toLowerCase().trim();
        if (!query) {
            renderUserList(chatState.users, listId, selectable);
            return;
        }
        var filtered = chatState.users.filter(function(u) {
            var name = (u.name || u.username || '').toLowerCase();
            return name.indexOf(query) !== -1;
        });
        renderUserList(filtered, listId, selectable);
    }

    function toggleUserSelection(userId, userName) {
        if (chatState.selectedParticipants.has(userId)) {
            chatState.selectedParticipants.delete(userId);
        } else {
            chatState.selectedParticipants.add(userId);
        }
        updateSelectedUsers();
        renderUserList(chatState.users, 'groupUserList', true);
    }

    function updateSelectedUsers() {
        var container = $('selectedUsers');
        var count = $('selectedCount');
        if (chatState.selectedParticipants.size === 0) {
            container.innerHTML = '<span style="color:#94A3B8; font-size:0.75rem;">لم يتم اختيار أحد</span>';
            count.textContent = '0';
            return;
        }
        count.textContent = chatState.selectedParticipants.size;
        var html = '';
        chatState.selectedParticipants.forEach(function(id) {
            var user = chatState.users.find(function(u) { return u.id === id; });
            if (!user) return;
            var name = user.name || user.username;
            html += '<span class="selected-user-chip">' + escapeHtml(name) +
                '<button onclick="removeSelectedUser(' + id + ')" title="إزالة"><i class="fas fa-times"></i></button></span>';
        });
        container.innerHTML = html;
    }

    window.removeSelectedUser = function(userId) {
        chatState.selectedParticipants.delete(userId);
        updateSelectedUsers();
        renderUserList(chatState.users, 'groupUserList', true);
    };

    async function startPrivateChat(userId) {
        closeModal('newChatModal');
        try {
            var data = await ChatAPI.startPrivateChat(userId);
            if (data.success && data.conversation) {
                var exists = chatState.conversations.some(function(c) { return c.id === data.conversation.id; });
                if (!exists) {
                    chatState.conversations.unshift(data.conversation);
                }
                renderConversationList(chatState.conversations);
                openConversation(data.conversation.id);
                showToast('تم بدء المحادثة', 'success');
            }
        } catch (e) {
            console.error('startPrivateChat:', e);
            showToast('تعذر بدء المحادثة', 'error');
        }
    }

    async function createGroup() {
        var title = $('groupTitleInput').value.trim();
        if (!title) {
            showToast('يرجى إدخال اسم المجموعة', 'warning');
            return;
        }
        if (chatState.selectedParticipants.size === 0) {
            showToast('يرجى اختيار عضو واحد على الأقل', 'warning');
            return;
        }

        var ids = Array.from(chatState.selectedParticipants);
        closeModal('newGroupModal');

        try {
            var data = await ChatAPI.createGroup(title, ids);
            if (data.success && data.conversation) {
                chatState.conversations.unshift(data.conversation);
                renderConversationList(chatState.conversations);
                openConversation(data.conversation.id);
                showToast('تم إنشاء المجموعة بنجاح', 'success');
            }
        } catch (e) {
            console.error('createGroup:', e);
            showToast('تعذر إنشاء المجموعة', 'error');
        }
    }

    // ===== Mobile Sidebar =====
    function openSidebar() {
        $('chatSidebar').classList.add('open');
        $('sidebarOverlay').style.display = 'block';
    }

    function closeSidebar() {
        $('chatSidebar').classList.remove('open');
        $('sidebarOverlay').style.display = 'none';
    }

    // ===== Update all online statuses across the UI =====
    function updateAllOnlineStatuses() {
        // Update conversation list
        renderConversationList(chatState.conversations);
        
        // Update current conversation header
        if (chatState.currentConversation) {
            updateChatHeaderStatus(chatState.currentConversation);
        }
        
        // Update user lists if modals are open
        if ($('userList') && $('userList').children.length > 0) {
            renderUserList(chatState.users, 'userList', false);
        }
        if ($('groupUserList') && $('groupUserList').children.length > 0) {
            renderUserList(chatState.users, 'groupUserList', true);
        }
    }

    // ===== WebSocket Handlers =====
    function onIncomingMessage(data) {
        var msg = data.message;
        var convId = data.conversationId;
        if (!msg || !convId) return;

        var isMine = chatState.currentUser && String(msg.sender_id) === String(chatState.currentUser.id);

        // Update conversation list preview
        var conv = chatState.conversations.find(function(c) { return c.id === convId; });
        if (conv) {
            conv.last_message = {
                content: msg.content,
                sender_id: msg.sender_id,
                created_at: msg.created_at,
                sender_name: msg.sender_name
            };
            conv.updated_at = msg.created_at;

            // If this is the current conversation, add message to view
            if (chatState.currentConversation && chatState.currentConversation.id === convId) {
                // Check for duplicate
                var existingIdx = chatState.messages.findIndex(function(m) {
                    return String(m.id) === String(msg.id);
                });
                if (existingIdx === -1) {
                    // Check if this replaces a temp message
                    var tempIdx = chatState.messages.findIndex(function(m) {
                        return String(m.id).startsWith('temp-') &&
                            m.content === msg.content &&
                            String(m.sender_id) === String(msg.sender_id);
                    });
                    if (tempIdx !== -1) {
                        chatState.messages[tempIdx] = msg;
                    } else {
                        chatState.messages.push(msg);
                    }
                    $('messagesList').innerHTML = renderMessagesList(chatState.messages);
                    scrollToBottom();
                }

                // Auto-mark as read if not mine
                if (!isMine) {
                    try {
                        ChatAPI.markRead(msg.id);
                        // Optimistically add read_by
                        if (!msg.read_by) msg.read_by = [];
                        var alreadyRead = msg.read_by.some(function(r) {
                            var rId = r.user_id !== undefined ? r.user_id : r.userId;
                            return String(rId) === String(chatState.currentUser.id);
                        });
                        if (!alreadyRead) {
                            msg.read_by.push({ user_id: chatState.currentUser.id, read_at: new Date().toISOString() });
                            $('messagesList').innerHTML = renderMessagesList(chatState.messages);
                        }
                    } catch(e) {}
                }
            } else {
                // Not viewing this conversation - increment unread
                if (!isMine) {
                    conv.unread_count = (conv.unread_count || 0) + 1;
                    
                    // Show toast notification
                    ToastSystem.show({
                        senderName: msg.sender_name || 'مستخدم',
                        senderId: msg.sender_id,
                        conversationId: convId,
                        content: msg.content,
                        messageId: msg.id,
                        timestamp: msg.created_at
                    });
                }
            }

            // Move to top
            chatState.conversations.sort(function(a, b) {
                return new Date(b.updated_at || 0) - new Date(a.updated_at || 0);
            });
            renderConversationList(chatState.conversations);

            // Notify other pages via BroadcastChannel
            try {
                if (typeof BroadcastChannel !== 'undefined') {
                    var bc = new BroadcastChannel('chat_sync');
                    bc.postMessage({ type: 'chat_badge_update', unreadTotal: chatState.unreadTotal });
                    bc.close();
                }
            } catch(e) {}
        } else {
            // New conversation - reload list
            loadConversations();
        }
    }

    function onIncomingRead(data) {
        var messageId = data.messageId;
        var userId = data.userId;
        var readAt = data.readAt || new Date().toISOString();
        if (!messageId) return;

        // Find message and update read_by
        var msg = chatState.messages.find(function(m) { return String(m.id) === String(messageId); });
        if (msg) {
            if (!msg.read_by) msg.read_by = [];
            var alreadyRead = msg.read_by.some(function(r) {
                var rId = r.user_id !== undefined ? r.user_id : r.userId;
                return String(rId) === String(userId);
            });
            if (!alreadyRead) {
                msg.read_by.push({ user_id: userId, read_at: readAt });
                // Re-render if this message is visible
                if (chatState.currentConversation) {
                    $('messagesList').innerHTML = renderMessagesList(chatState.messages);
                }
            }
        }
    }

    function onIncomingTyping(data) {
        if (!chatState.currentConversation) return;
        if (data.conversationId !== chatState.currentConversation.id) return;
        if (data.user && chatState.currentUser && data.user.id == chatState.currentUser.id) return;

        renderTypingIndicator(data.user ? data.user.name : 'يكتب');

        if (chatState.typingTimeout) clearTimeout(chatState.typingTimeout);
        chatState.typingTimeout = setTimeout(hideTypingIndicator, 3000);
    }

    function onIncomingPresence(data) {
        if (!data.userId) return;
        
        var isOnline = data.status === 'online';
        
        // Update online users array
        if (isOnline) {
            if (!chatState.onlineUsers.includes(data.userId)) {
                chatState.onlineUsers.push(data.userId);
            }
        } else {
            chatState.onlineUsers = chatState.onlineUsers.filter(function(id) {
                return id !== data.userId;
            });
        }
        
        // Update all UI elements
        updateAllOnlineStatuses();
    }

    async function loadCurrentUser() {
        try {
            var res = await fetch('/api/auth/me', { headers: { 'Authorization': 'Bearer ' + authToken } });
            var data = await res.json();
            if (data.user) {
                chatState.currentUser = data.user;
                $('currentUserName').textContent = data.user.name || data.user.username;
            }
        } catch (e) {
            console.error('loadCurrentUser:', e);
        }
    }

    // ===== Conversation Search =====
    function handleConversationSearch(query) {
        query = (query || '').toLowerCase().trim();
        if (!query) {
            renderConversationList(chatState.conversations);
            return;
        }
        var filtered = chatState.conversations.filter(function(c) {
            var title = (c.title || '').toLowerCase();
            var preview = c.last_message ? (c.last_message.content || '').toLowerCase() : '';
            return title.indexOf(query) !== -1 || preview.indexOf(query) !== -1;
        });
        renderConversationList(filtered);
    }

    // ===== Toast (in-page) =====
    function showToast(message, type) {
        type = type || 'info';
        var container = $('toastContainer');
        var toast = document.createElement('div');
        toast.className = 'toast ' + type;
        var icon = type === 'success' ? 'fa-check-circle' : type === 'error' ? 'fa-exclamation-circle' : type === 'warning' ? 'fa-exclamation-triangle' : 'fa-info-circle';
        toast.innerHTML = '<i class="fas ' + icon + '"></i> ' + escapeHtml(message);
        container.appendChild(toast);
        setTimeout(function() {
            toast.classList.add('toast-exit');
            setTimeout(function() { toast.remove(); }, 300);
        }, 3000);
    }

    // ===== Sound Settings Panel =====
    function toggleSoundSettings() {
        var panel = $('soundSettingsPanel');
        panel.style.display = panel.style.display === 'flex' ? 'none' : 'flex';
    }

    window.toggleSoundMaster = function(checkbox) {
        soundSettings.enabled = checkbox.checked;
        localStorage.setItem('chat_sound_settings', JSON.stringify(soundSettings));
    };

    // ===== Event Listeners =====
    function bindEvents() {
        $('sendBtn').addEventListener('click', sendMessage);

        $('messageInput').addEventListener('keydown', function(e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });

        $('messageInput').addEventListener('input', function() {
            this.style.height = 'auto';
            this.style.height = Math.min(this.scrollHeight, 120) + 'px';
            $('sendBtn').disabled = !this.value.trim();
            handleTyping();
        });

        $('chatMessages').addEventListener('scroll', debounce(handleMessagesScroll, 200));

        $('newChatBtn').addEventListener('click', openNewChatModal);
        $('newGroupBtn').addEventListener('click', openNewGroupModal);

        $('mobileSidebarToggle').addEventListener('click', openSidebar);
        $('chatHeaderBack').addEventListener('click', function() {
            chatState.currentConversation = null;
            ToastSystem.currentConversationId = null;
            $('chatActive').style.display = 'none';
            $('chatEmpty').style.display = 'flex';
            renderConversationList(chatState.conversations);
            openSidebar();
        });
        $('sidebarOverlay').addEventListener('click', closeSidebar);

        $('userSearchInput').addEventListener('input', function() {
            filterUsers(this.value, 'userList', false);
        });

        $('userList').addEventListener('click', function(e) {
            var item = e.target.closest('.user-item');
            if (!item) return;
            var userId = item.dataset.id;
            startPrivateChat(userId);
        });

        $('groupUserSearchInput').addEventListener('input', function() {
            filterUsers(this.value, 'groupUserList', true);
        });

        $('groupUserList').addEventListener('click', function(e) {
            var item = e.target.closest('.user-item');
            if (!item) return;
            var userId = item.dataset.id;
            var userName = item.dataset.name;
            toggleUserSelection(userId, userName);
        });

        $('createGroupBtn').addEventListener('click', createGroup);

        $('conversationSearch').addEventListener('input', function() {
            handleConversationSearch(this.value);
        });

        $('attachBtn').addEventListener('click', function() {
            showToast('سيتم دعم إرفاق الملفات قريباً', 'info');
        });

        // Sound settings
        var soundToggleBtn = document.getElementById('soundToggleBtn');
        if (soundToggleBtn) {
            soundToggleBtn.addEventListener('click', toggleSoundSettings);
        }

        // Close modal on backdrop click
        document.querySelectorAll('.modal').forEach(function(modal) {
            modal.addEventListener('click', function(e) {
                if (e.target === modal) {
                    modal.style.display = 'none';
                }
            });
        });
    }

    // ===== Init =====
    async function loadOnlineUsers() {
        try {
            var data = await ChatAPI.getOnlineUsers();
            if (data.success && data.onlineUsers) {
                chatState.onlineUsers = data.onlineUsers.map(function(u) { return u.id; });
                updateAllOnlineStatuses();
                console.log('[chat] Online users loaded:', data.onlineUsers.length);
            }
        } catch (e) {
            console.log('[chat] Failed to load online users:', e);
        }
    }

    // Check for target conversation from URL or sessionStorage
    function getTargetConversationId() {
        // From URL ?conv=xxx
        var urlParams = new URLSearchParams(window.location.search);
        var convId = urlParams.get('conv');
        if (convId) return parseInt(convId);
        
        // From sessionStorage (set by toast click from other pages)
        var stored = sessionStorage.getItem('chat_target_conversation');
        if (stored) {
            sessionStorage.removeItem('chat_target_conversation');
            return parseInt(stored);
        }
        return null;
    }

    async function init() {
        bindEvents();
        await loadCurrentUser();
        await loadUsers();
        await loadOnlineUsers();
        await loadConversations();

        // Connect WebSocket
        ChatSocket.connect();
        ChatSocket.onMessage(onIncomingMessage);
        ChatSocket.onTyping(onIncomingTyping);
        ChatSocket.onRead(onIncomingRead);
        ChatSocket.onPresence(onIncomingPresence);

        // Handle target conversation
        var targetConvId = getTargetConversationId();
        if (targetConvId) {
            setTimeout(function() {
                var conv = chatState.conversations.find(function(c) { return c.id === targetConvId; });
                if (conv) {
                    openConversation(targetConvId);
                }
            }, 300);
        }

        // Send offline on page unload
        window.addEventListener('beforeunload', function() {
            ChatSocket.sendLogout();
        });

        // Request browser notification permission
        if ('Notification' in window && Notification.permission === 'default') {
            Notification.requestPermission();
        }

        // Periodic presence ping
        setInterval(function() {
            if (ChatSocket.connected) {
                ChatSocket.sendPresence();
            }
        }, 30000);
    }

    // Start
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();