// ============================================
// Chat Module — منصة الجنوب
// Vanilla JS, modular functions, RTL
// ============================================

(function() {
    'use strict';

    // ===== Auth Token =====
    var authToken = localStorage.getItem('authToken');
    if (!authToken) {
        location.href = 'index.html';
        return;
    }

    // ===== Global State =====
    var chatState = {
        conversations: [],
        currentConversation: null,
        messages: [],
        users: [],
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

    // ===== Toast =====
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
        }
    };

    // ===== WebSocket =====
    var ChatSocket = {
        ws: null,
        connected: false,
        messageCallbacks: [],
        typingCallbacks: [],

        connect: function() {
            var protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
            var wsUrl = protocol + '//' + location.host + '/ws';
            try {
                this.ws = new WebSocket(wsUrl);
                var self = this;

                this.ws.onopen = function() {
                    self.connected = true;
                    console.log('Chat WS: connected');
                    // Subscribe to current conversation if any
                    if (chatState.currentConversation) {
                        self.subscribe(chatState.currentConversation.id);
                    }
                };

                this.ws.onmessage = function(event) {
                    try {
                        var data = JSON.parse(event.data);
                        self.handleMessage(data);
                    } catch (e) {
                        console.error('Chat WS parse error:', e);
                    }
                };

                this.ws.onerror = function(err) {
                    console.error('Chat WS error:', err);
                };

                this.ws.onclose = function() {
                    self.connected = false;
                    console.log('Chat WS: closed, reconnecting in 5s...');
                    setTimeout(function() { self.connect(); }, 5000);
                };
            } catch (e) {
                console.error('Chat WS init error:', e);
            }
        },

        handleMessage: function(data) {
            if (data.type === 'connected') {
                console.log('Chat WS:', data.message);
                return;
            }
            if (data.type === 'chat_message') {
                this.messageCallbacks.forEach(function(cb) { cb(data); });
            } else if (data.type === 'chat_typing') {
                this.typingCallbacks.forEach(function(cb) { cb(data); });
            }
        },

        onMessage: function(callback) {
            this.messageCallbacks.push(callback);
        },

        onTyping: function(callback) {
            this.typingCallbacks.push(callback);
        },

        sendTyping: function(conversationId) {
            if (!this.connected || !this.ws) return;
            this.ws.send(JSON.stringify({
                type: 'chat_typing',
                conversationId: conversationId
            }));
        },

        subscribe: function(conversationId) {
            if (!this.connected || !this.ws) return;
            this.ws.send(JSON.stringify({
                type: 'subscribe',
                conversationId: conversationId
            }));
        }
    };

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

            html += '<div class="conversation-item ' + activeClass + '" data-id="' + conv.id + '" onclick="openConversation(' + conv.id + ')">' +
                '<div class="conversation-avatar ' + (conv.type === 'group' ? 'group' : '') + '">' +
                    '<i class="fas ' + avatarIcon + '"></i>' +
                    (conv.type === 'private' ? '<span class="avatar-status"></span>' : '') +
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
        // Update document title
        if (total > 0) {
            document.title = '(' + total + ') المراسلات – منصة إدارة العمليات الإسعافية';
        } else {
            document.title = 'الدردشة – منصة إدارة العمليات الإسعافية';
        }
    }

    function renderMessageBubble(message, isMine) {
        var bubbleClass = isMine ? 'sent' : 'received';
        var time = formatTime(message.created_at);
        var readStatus = '';
        if (isMine) {
            var isRead = message.read_by && message.read_by.length > 1;
            readStatus = '<span class="message-read">' + (isRead ? '<i class="fas fa-check-double"></i>' : '<i class="fas fa-check"></i>') + '</span>';
        }
        var content = escapeHtml(message.content).replace(/\n/g, '<br>');

        return '<div class="message-row ' + (isMine ? 'mine' : 'theirs') + '">' +
            '<div class="message-bubble ' + bubbleClass + '">' +
                '<div class="message-content">' + content + '</div>' +
                '<div class="message-time">' + readStatus + ' ' + time + '</div>' +
            '</div>' +
        '</div>';
    }

    function renderTypingIndicator(userName) {
        userName = userName || 'يكتب';
        $('typingText').textContent = userName + '...';
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

            html += '<div class="user-item ' + selectedClass + '" data-id="' + user.id + '" data-name="' + escapeHtml(user.name || user.username) + '">' +
                '<div class="user-item-avatar"><i class="fas fa-user"></i></div>' +
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
        $('chatHeaderStatusText').textContent = conv.type === 'group' ? conv.participants.length + ' عضو' : 'متصل';

        // Subscribe to WS
        ChatSocket.subscribe(convId);

        // Load messages
        await loadMessages(convId, 1);

        // Mark unread as read
        if (conv.unread_count > 0) {
            markConversationRead(conv);
        }

        // On mobile, close sidebar
        if (window.innerWidth <= 768) {
            closeSidebar();
        }
    };

    async function loadMessages(convId, page) {
        if (chatState.isLoadingMessages) return;
        chatState.isLoadingMessages = true;
        $('messagesLoader').style.display = 'flex';

        try {
            var data = await ChatAPI.getMessages(convId, page);
            var newMessages = data.messages || [];
            chatState.hasMoreMessages = data.hasMore === true;

            if (page === 1) {
                chatState.messages = newMessages;
                $('messagesList').innerHTML = renderMessagesList(chatState.messages);
                scrollToBottom();
            } else {
                // Prepend older messages
                var oldScrollHeight = $('chatMessages').scrollHeight;
                chatState.messages = newMessages.concat(chatState.messages);
                $('messagesList').innerHTML = renderMessagesList(chatState.messages);
                // Restore scroll position
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
            var isMine = msg.sender_id === currentUserId;
            html += renderMessageBubble(msg, isMine);
        });

        return html;
    }

    function scrollToBottom() {
        var container = $('chatMessages');
        container.scrollTop = container.scrollHeight;
    }

    async function markConversationRead(conv) {
        if (!conv || !conv.last_message) return;
        try {
            await ChatAPI.markRead(conv.last_message.id);
            conv.unread_count = 0;
            renderConversationList(chatState.conversations);
        } catch (e) {
            console.error('markConversationRead:', e);
        }
    }

    async function markMessageRead(messageId) {
        try {
            await ChatAPI.markRead(messageId);
        } catch (e) {
            console.error('markMessageRead:', e);
        }
    }

    // ===== Sending Messages =====
    async function sendMessage() {
        var input = $('messageInput');
        var content = input.value.trim();
        if (!content || !chatState.currentConversation) return;

        var convId = chatState.currentConversation.id;
        var tempMsg = {
            id: 'temp-' + Date.now(),
            sender_id: chatState.currentUser ? chatState.currentUser.id : null,
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

        try {
            var data = await ChatAPI.sendMessage(convId, { content: content, type: 'text' });
            if (data.success && data.message) {
                // Replace temp message with real one
                var idx = chatState.messages.findIndex(function(m) { return m.id === tempMsg.id; });
                if (idx !== -1) {
                    chatState.messages[idx] = data.message;
                    $('messagesList').innerHTML = renderMessagesList(chatState.messages);
                }
            }
        } catch (e) {
            console.error('sendMessage:', e);
            showToast('تعذر إرسال الرسالة', 'error');
            // Remove temp message
            chatState.messages = chatState.messages.filter(function(m) { return m.id !== tempMsg.id; });
            $('messagesList').innerHTML = renderMessagesList(chatState.messages);
        }
    }

    function handleTyping() {
        if (!chatState.currentConversation) return;
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
                // Add to list if not exists
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

    // ===== WebSocket Handlers =====
    function onIncomingMessage(data) {
        var msg = data.message;
        var convId = data.conversationId;
        if (!msg || !convId) return;

        // Update conversation preview
        var conv = chatState.conversations.find(function(c) { return c.id === convId; });
        if (conv) {
            conv.last_message = { content: msg.content, sender_id: msg.sender_id, created_at: msg.created_at };
            conv.updated_at = msg.created_at;
            if (chatState.currentConversation && chatState.currentConversation.id === convId) {
                // Add to current messages
                chatState.messages.push(msg);
                $('messagesList').innerHTML = renderMessagesList(chatState.messages);
                scrollToBottom();
                // Mark as read
                markMessageRead(msg.id);
            } else {
                conv.unread_count = (conv.unread_count || 0) + 1;
            }
            // Move to top
            chatState.conversations.sort(function(a, b) {
                return new Date(b.updated_at || 0) - new Date(a.updated_at || 0);
            });
            renderConversationList(chatState.conversations);
        } else {
            // New conversation - reload list
            loadConversations();
        }
    }

    function onIncomingTyping(data) {
        if (!chatState.currentConversation) return;
        if (data.conversationId !== chatState.currentConversation.id) return;

        renderTypingIndicator(data.user ? data.user.name : 'يكتب');

        // Hide after 3 seconds
        if (chatState.typingTimeout) clearTimeout(chatState.typingTimeout);
        chatState.typingTimeout = setTimeout(hideTypingIndicator, 3000);
    }

    // ===== Current User =====
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

    // ===== Event Listeners =====
    function bindEvents() {
        // Send button
        $('sendBtn').addEventListener('click', sendMessage);

        // Enter to send, Shift+Enter for new line
        $('messageInput').addEventListener('keydown', function(e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });

        // Auto-resize textarea
        $('messageInput').addEventListener('input', function() {
            this.style.height = 'auto';
            this.style.height = Math.min(this.scrollHeight, 120) + 'px';
            $('sendBtn').disabled = !this.value.trim();
            handleTyping();
        });

        // Scroll pagination
        $('chatMessages').addEventListener('scroll', debounce(handleMessagesScroll, 200));

        // New chat / group buttons
        $('newChatBtn').addEventListener('click', openNewChatModal);
        $('newGroupBtn').addEventListener('click', openNewGroupModal);

        // Mobile toggle
        $('mobileSidebarToggle').addEventListener('click', openSidebar);
        $('chatHeaderBack').addEventListener('click', function() {
            chatState.currentConversation = null;
            $('chatActive').style.display = 'none';
            $('chatEmpty').style.display = 'flex';
            renderConversationList(chatState.conversations);
            openSidebar();
        });
        $('sidebarOverlay').addEventListener('click', closeSidebar);

        // User search in new chat modal
        $('userSearchInput').addEventListener('input', function() {
            filterUsers(this.value, 'userList', false);
        });

        // Click user in new chat modal
        $('userList').addEventListener('click', function(e) {
            var item = e.target.closest('.user-item');
            if (!item) return;
            var userId = item.dataset.id;
            startPrivateChat(userId);
        });

        // Group user search
        $('groupUserSearchInput').addEventListener('input', function() {
            filterUsers(this.value, 'groupUserList', true);
        });

        // Click user in group modal
        $('groupUserList').addEventListener('click', function(e) {
            var item = e.target.closest('.user-item');
            if (!item) return;
            var userId = item.dataset.id;
            var userName = item.dataset.name;
            toggleUserSelection(userId, userName);
        });

        // Create group
        $('createGroupBtn').addEventListener('click', createGroup);

        // Conversation search
        $('conversationSearch').addEventListener('input', function() {
            handleConversationSearch(this.value);
        });

        // Attach button (placeholder)
        $('attachBtn').addEventListener('click', function() {
            showToast('سيتم دعم إرفاق الملفات قريباً', 'info');
        });

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
    async function init() {
        bindEvents();
        await loadCurrentUser();
        await loadUsers();
        await loadConversations();

        // Connect WebSocket
        ChatSocket.connect();
        ChatSocket.onMessage(onIncomingMessage);
        ChatSocket.onTyping(onIncomingTyping);
    }

    // Start
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
