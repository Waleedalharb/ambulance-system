// ============================================
// Chat Module v3 — Complete Rewrite (Modular)
// منصة الجنوب — نظام الدردشة المتكامل
// Features: Toast, Smart Scroll, Voice, Context Menu,
//           Reply/Edit/Delete, Pin/Mute, Search, Settings
// ============================================

(function() {
    'use strict';

    var authToken = AuthCore.getToken();
    if (!authToken) { location.href = 'index.html'; return; }

    // ============================================
    // STATE MANAGER
    // ============================================
    var State = {
        conversations: [],
        currentConversation: null,
        messages: [],
        users: [],
        onlineUsers: [],
        unreadTotal: 0,
        isTyping: false,
        currentUser: null,
        typingTimeout: null,
        messagePage: 1,
        hasMoreMessages: false,
        isLoadingMessages: false,
        selectedParticipants: new Set(),
        isScrolledToBottom: true,
        newMessageCount: 0,
        soundEnabled: true,
        replyTo: null,
        editingMessageId: null,
        searchQuery: '',
        settings: {
            sound: true,
            readReceipts: true,
            lastSeen: true,
            typingIndicator: true
        }
    };

    // Load settings
    try {
        var saved = localStorage.getItem('chat_settings');
        if (saved) State.settings = JSON.parse(saved);
        State.soundEnabled = State.settings.sound;
    } catch(e) {}

    function saveSettings() {
        State.settings.sound = State.soundEnabled;
        try { localStorage.setItem('chat_settings', JSON.stringify(State.settings)); } catch(e) {}
    }

    // ============================================
    // DOM HELPERS
    // ============================================
    function $(id) { return document.getElementById(id); }
    function escapeHtml(t) { if(!t)return'';var d=document.createElement('div');d.textContent=t;return d.innerHTML; }
    function formatTime(d) { if(!d)return'';var n=new Date(),x=new Date(d);if(isNaN(x))return'';return x.toDateString()===n.toDateString()?x.toLocaleTimeString('ar-SA',{hour:'2-digit',minute:'2-digit',hour12:false}):x.toLocaleDateString('ar-SA',{month:'short',day:'numeric'}); }
    function debounce(fn,ms){var t;return function(){clearTimeout(t);t=setTimeout(fn.bind.apply(fn,[this].concat(Array.prototype.slice.call(arguments))),ms);};}

    // ============================================
    // AUDIO SYSTEM
    // ============================================
    var notifyAudio = null;
    function playSound() {
        if (!State.soundEnabled) return;
        try {
            if (!notifyAudio) {
                notifyAudio = new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBjiR1/LDciUFLIHO8tiJNwgZaLvt559NEAxQp+PwtmMcBjiR1/LMeSwFJHfH8N2QQAoUXrTp66hVFApGn+DyvmwhBTGH0fPTgjMGHm7A7+OZURE');
                notifyAudio.volume = 0.3;
            }
            notifyAudio.cloneNode().play().catch(function(){});
        } catch(e){}
    }

    // ============================================
    // IN-PAGE TOAST (top-center for feedback)
    // ============================================
    function showToast(message, type) {
        ToastCore.show(message, type || 'info', 3000);
    }

    // ============================================
    // TOAST NOTIFICATION SYSTEM (bottom-right popup)
    // ============================================
    var Toast = {
        stack: [],
        maxStack: 5,
        duration: 6000,

        show: function(data) {
            var senderName = data.senderName || 'مستخدم';
            var conversationId = data.conversationId;
            var content = data.content || '';
            var timestamp = data.timestamp || new Date().toISOString();

            // Don't show if viewing same conversation
            if (State.currentConversation && String(State.currentConversation.id) === String(conversationId)) return;
            // Don't show own messages
            if (data.senderId && State.currentUser && String(data.senderId) === String(State.currentUser.id)) return;

            var container = $('chatToastContainer') || this._createContainer();

            // Stack limit
            if (this.stack.length >= this.maxStack) {
                var old = this.stack.shift();
                if (old && old.parentNode) old.remove();
            }

            var toast = this._createToast(senderName, content, timestamp, conversationId);
            container.appendChild(toast);
            requestAnimationFrame(function(){ toast.style.opacity='1'; toast.style.transform='translateX(0)'; });
            this.stack.push(toast);

            setTimeout(function(){ toast.style.opacity='0'; toast.style.transform='translateX(-100px)'; setTimeout(function(){if(toast.parentNode)toast.remove();},300); }, this.duration);

            playSound();
        },

        _createContainer: function() {
            var c = document.createElement('div');
            c.id = 'chatToastContainer';
            c.setAttribute('dir','rtl');
            c.style.cssText = 'position:fixed;bottom:20px;left:20px;z-index:99999;display:flex;flex-direction:column;gap:8px;pointer-events:none;direction:rtl;';
            document.body.appendChild(c);
            return c;
        },

        _createToast: function(name, content, time, convId) {
            var t = document.createElement('div');
            var initials = name.split(' ').map(function(w){return w[0]}).join('').substring(0,2);
            var colors = ['#0D9488','#3B82F6','#8B5CF6','#EC4899','#F59E0B','#10B981'];
            var color = colors[name.charCodeAt(0)%colors.length];
            var preview = escapeHtml(content).substring(0,55);
            if (content.length > 55) preview += '...';

            t.style.cssText = 'display:flex;align-items:flex-start;gap:10px;padding:12px 14px;background:#fff;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,0.12),0 0 0 1px rgba(0,0,0,0.04);cursor:pointer;pointer-events:all;min-width:280px;max-width:340px;opacity:0;transform:translateX(-100px);transition:all 0.3s ease;border-right:3px solid '+color+';direction:rtl;margin-bottom:6px;';
            t.innerHTML = '<div style="width:38px;height:38px;border-radius:50%;background:'+color+';display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:0.8rem;flex-shrink:0;">'+initials+'</div><div style="flex:1;min-width:0;"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px;"><span style="font-weight:600;font-size:0.82rem;color:#0F172A;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:160px;">'+escapeHtml(name)+'</span><span style="font-size:0.65rem;color:#94A3B8;flex-shrink:0;">'+formatTime(time)+'</span></div><div style="font-size:0.78rem;color:#64748B;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">'+preview+'</div></div><button style="background:none;border:none;color:#94A3B8;cursor:pointer;font-size:1.1rem;padding:0;width:20px;height:20px;display:flex;align-items:center;justify-content:center;border-radius:50%;flex-shrink:0;" onclick="event.stopPropagation();this.parentElement.remove();">&times;</button>';

            t.addEventListener('click', function(){ window.openConversation(convId); });
            return t;
        },

        clearAll: function() { this.stack.forEach(function(t){if(t.parentNode)t.remove();}); this.stack=[]; }
    };

    // ============================================
    // SMART SCROLL SYSTEM
    // ============================================
    var Scroll = {
        toBottom: function() {
            var c = $('chatMessages');
            c.scrollTop = c.scrollHeight;
            State.isScrolledToBottom = true;
            State.newMessageCount = 0;
            this._hideBtn();
        },

        smart: function() {
            if (State.isScrolledToBottom) {
                this.toBottom();
            } else {
                State.newMessageCount++;
                this._showBtn(State.newMessageCount);
            }
        },

        track: function() {
            var c = $('chatMessages');
            var atBottom = (c.scrollHeight - c.scrollTop - c.clientHeight) < 100;
            State.isScrolledToBottom = atBottom;
            if (atBottom && State.newMessageCount > 0) {
                State.newMessageCount = 0;
                this._hideBtn();
            }
        },

        _showBtn: function(count) {
            var btn = $('scrollToBottomBtn');
            if (!btn) {
                btn = document.createElement('button');
                btn.id = 'scrollToBottomBtn';
                btn.className = 'scroll-to-bottom-btn';
                btn.innerHTML = '<i class="fas fa-arrow-down"></i> <span></span>';
                btn.addEventListener('click', this.toBottom.bind(this));
                $('chatActive').style.position = 'relative';
                $('chatActive').appendChild(btn);
            }
            btn.querySelector('span').textContent = count + ' رسالة جديدة';
            btn.style.display = 'flex';
        },

        _hideBtn: function() {
            var btn = $('scrollToBottomBtn');
            if (btn) btn.style.display = 'none';
        }
    };

    // ============================================
    // API
    // ============================================
    var API = {
        _headers: function() { return { 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' }; },
        getConversations: function() { return fetch('/api/chat/conversations', { headers: { 'Authorization': 'Bearer ' + authToken } }).then(function(r){return r.json();}); },
        getMessages: function(convId, page) { return fetch('/api/chat/conversations/' + encodeURIComponent(convId) + '/messages?page=' + (page||1), { headers: { 'Authorization': 'Bearer ' + authToken } }).then(function(r){return r.json();}); },
        sendMessage: function(convId, data) { return fetch('/api/chat/conversations/' + encodeURIComponent(convId) + '/messages', { method: 'POST', headers: this._headers(), body: JSON.stringify(data) }).then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json().catch(function(){return {success:true};}); }); },
        markRead: function(msgId) { return fetch('/api/chat/messages/' + encodeURIComponent(msgId) + '/read', { method: 'PUT', headers: { 'Authorization': 'Bearer ' + authToken } }).then(function(r){return r.json();}); },
        createGroup: function(title, ids) { return fetch('/api/chat/conversations', { method: 'POST', headers: this._headers(), body: JSON.stringify({ type: 'group', title: title, participant_ids: ids }) }).then(function(r){return r.json();}); },
        startPrivate: function(userId) { return fetch('/api/chat/conversations/private', { method: 'POST', headers: this._headers(), body: JSON.stringify({ user_id: userId }) }).then(function(r){return r.json();}); },
        getUsers: function() { return fetch('/api/chat/users', { headers: { 'Authorization': 'Bearer ' + authToken } }).then(function(r){return r.json();}); },
        editMessage: function(msgId, content) { return fetch('/api/chat/messages/' + encodeURIComponent(msgId), { method: 'PUT', headers: this._headers(), body: JSON.stringify({ content: content }) }).then(function(r){return r.json();}); },
        deleteMessage: function(msgId, scope) { return fetch('/api/chat/messages/' + encodeURIComponent(msgId), { method: 'DELETE', headers: this._headers(), body: JSON.stringify({ scope: scope }) }).then(function(r){return r.json();}); },
        pinConversation: function(convId) { return fetch('/api/chat/conversations/' + encodeURIComponent(convId) + '/pin', { method: 'POST', headers: { 'Authorization': 'Bearer ' + authToken } }).then(function(r){return r.json();}); },
        muteConversation: function(convId) { return fetch('/api/chat/conversations/' + encodeURIComponent(convId) + '/mute', { method: 'POST', headers: { 'Authorization': 'Bearer ' + authToken } }).then(function(r){return r.json();}); },
        deleteConversation: function(convId) { return fetch('/api/chat/conversations/' + encodeURIComponent(convId), { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + authToken } }).then(function(r){return r.json();}); }
    };

    // ============================================
    // MESSAGE RENDERER (with 3-state receipts + reply + edit)
    // ============================================
    function renderBubble(msg, isMine) {
        var bubbleClass = isMine ? 'sent' : 'received';
        var time = formatTime(msg.created_at);
        var readStatus = '';

        if (isMine) {
            var totalOthers = State.currentConversation && State.currentConversation.participants
                ? State.currentConversation.participants.filter(function(p){return p.user_id !== msg.sender_id;}).length : 1;
            var otherReaders = 0;
            if (msg.read_by && Array.isArray(msg.read_by)) {
                msg.read_by.forEach(function(r){ var rId = r.user_id !== undefined ? r.user_id : r.userId; if (String(rId) !== String(msg.sender_id)) otherReaders++; });
            }
            var otherDelivered = 0;
            if (msg.delivered_to && Array.isArray(msg.delivered_to)) {
                msg.delivered_to.forEach(function(d){ var dId = d.user_id !== undefined ? d.user_id : d.userId; if (String(dId) !== String(msg.sender_id)) otherDelivered++; });
            }

            if (otherReaders >= totalOthers && totalOthers > 0) {
                readStatus = '<span class="message-read read" title="تم القراءة"><i class="fas fa-check-double"></i></span>';
            } else if (otherReaders > 0 || otherDelivered > 0) {
                readStatus = '<span class="message-read delivered" title="تم التسليم"><i class="fas fa-check-double"></i></span>';
            } else {
                readStatus = '<span class="message-read" title="تم الإرسال"><i class="fas fa-check"></i></span>';
            }
        }

        // Voice message rendering
        var messageHtml = '';
        if (msg.type === 'voice' || (msg.content && msg.content.startsWith('data:audio'))) {
            var dur = msg.duration || 0;
            var mins = Math.floor(dur / 60).toString().padStart(2, '0');
            var secs = (dur % 60).toString().padStart(2, '0');
            messageHtml = '<div class="voice-message"><button class="voice-play-btn" onclick="window.Voice.playVoice(\'' + msg.content + '\', this)"><i class="fas fa-play"></i></button><div class="voice-progress"><div class="voice-progress-bar"></div></div><span class="voice-time">' + mins + ':' + secs + '</span></div>';
        } else {
            messageHtml = '<div class="message-content">' + escapeHtml(msg.content).replace(/\n/g, '<br>') + '</div>';
        }

        var senderName = !isMine && msg.sender_name ? '<div class="message-sender">' + escapeHtml(msg.sender_name) + '</div>' : '';
        var editedFlag = msg.is_edited ? '<span class="message-edited">(تم التعديل)</span>' : '';
        var replyHtml = '';
        if (msg.reply_to) {
            replyHtml = '<div class="message-reply"><i class="fas fa-reply"></i> <span>' + escapeHtml((msg.reply_to.sender_name || 'مستخدم') + ': ' + msg.reply_to.content.substring(0, 40)) + (msg.reply_to.content.length > 40 ? '...' : '') + '</span></div>';
        }

        return '<div class="message-row ' + (isMine ? 'mine' : 'theirs') + '" data-msg-id="' + msg.id + '" data-is-mine="' + isMine + '">' +
            '<div class="message-bubble ' + bubbleClass + '">' + replyHtml + senderName +
                messageHtml + editedFlag +
                '<div class="message-time">' + readStatus + ' ' + time + '</div>' +
            '</div>' +
        '</div>';
    }

    function renderMessages(msgs) {
        if (!msgs || msgs.length === 0) return '<div class="sidebar-empty" style="padding:40px 20px;"><span>لا توجد رسائل بعد</span></div>';
        var html = '', lastDate = null;
        var myId = State.currentUser ? State.currentUser.id : null;
        msgs.forEach(function(msg) {
            var msgDate = new Date(msg.created_at).toDateString();
            if (msgDate !== lastDate) {
                html += '<div class="date-divider">' + formatDateDivider(msg.created_at) + '</div>';
                lastDate = msgDate;
            }
            html += renderBubble(msg, String(msg.sender_id) === String(myId));
        });
        return html;
    }

    function formatDateDivider(d) {
        if (!d) return '';
        var x = new Date(d);
        if (isNaN(x)) return '';
        var n = new Date();
        if (x.toDateString() === n.toDateString()) return 'اليوم';
        var y = new Date(n); y.setDate(y.getDate()-1);
        if (x.toDateString() === y.toDateString()) return 'أمس';
        return x.toLocaleDateString('ar-SA', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    }

    // ============================================
    // MESSAGE CONTEXT MENU
    // ============================================
    var messageMenu = null;
    function showMessageMenu(e, msgId, isMine) {
        e.preventDefault(); e.stopPropagation(); closeMessageMenu();
        var msg = State.messages.find(function(m){return m.id === msgId;});
        if (!msg) return;

        var menu = document.createElement('div');
        menu.className = 'message-context-menu';
        menu.style.cssText = 'position:fixed;z-index:1000;background:#fff;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.15),0 0 0 1px rgba(0,0,0,0.05);padding:6px 0;min-width:180px;direction:rtl;animation:menuIn 0.15s ease;overflow:hidden;';

        var items = [
            { icon: 'fa-reply', label: 'رد', action: function(){ startReply(msgId); } },
            { icon: 'fa-copy', label: 'نسخ', action: function(){ copyMsg(msg.content); } }
        ];
        if (isMine) {
            items.push({ icon: 'fa-edit', label: 'تعديل', action: function(){ startEdit(msgId); } });
            items.push({ icon: 'fa-trash', label: 'حذف', action: function(){ deleteMsg(msgId, 'me'); }, danger: true });
            items.push({ icon: 'fa-trash-alt', label: 'حذف للجميع', action: function(){ deleteMsg(msgId, 'all'); }, danger: true });
        }

        items.forEach(function(item){
            var div = document.createElement('div');
            div.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px 16px;cursor:pointer;font-size:0.8rem;color:'+(item.danger?'#EF4444':'#1E293B')+';transition:background 0.1s;white-space:nowrap;';
            div.innerHTML = '<i class="fas '+item.icon+'" style="width:16px;text-align:center;color:'+(item.danger?'#EF4444':'#64748B')+';"></i> '+item.label;
            div.addEventListener('click', function(ev){ ev.stopPropagation(); item.action(); closeMessageMenu(); });
            div.addEventListener('mouseenter', function(){div.style.background='#F8FAFC';});
            div.addEventListener('mouseleave', function(){div.style.background='transparent';});
            menu.appendChild(div);
        });

        document.body.appendChild(menu); messageMenu = menu;
        var x = e.clientX, y = e.clientY;
        var rect = menu.getBoundingClientRect();
        if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 10;
        if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 10;
        menu.style.left = x + 'px'; menu.style.top = y + 'px';
        setTimeout(function(){document.addEventListener('click', closeMessageMenu, {once:true});}, 10);
    }
    function closeMessageMenu(){ if(messageMenu){messageMenu.remove();messageMenu=null;} }

    function copyMsg(text) {
        navigator.clipboard.writeText(text).then(function(){showToast('تم النسخ','success');}).catch(function(){
            var ta = document.createElement('textarea'); ta.value=text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); showToast('تم النسخ','success');
        });
    }

    function startReply(msgId) {
        var msg = State.messages.find(function(m){return m.id===msgId;});
        if(!msg)return;
        State.replyTo = {id:msgId, content:msg.content, sender:msg.sender_name||'مستخدم'};
        State.editingMessageId = null;
        showReplyBar();
    }
    function startEdit(msgId) {
        var msg = State.messages.find(function(m){return m.id===msgId;});
        if(!msg)return;
        State.editingMessageId = msgId;
        State.replyTo = null;
        $('messageInput').value = msg.content;
        $('messageInput').focus();
        showEditBar();
    }
    function deleteMsg(msgId, scope) {
        if(!confirm(scope==='all'?'حذف الرسالة عند الجميع؟':'حذف الرسالة من عندك فقط؟'))return;
        State.messages = State.messages.filter(function(m){return m.id!==msgId;});
        $('messagesList').innerHTML = renderMessages(State.messages);
        API.deleteMessage(msgId, scope).catch(function(e){console.error(e);});
        showToast('تم الحذف','success');
    }

    function showReplyBar() {
        var bar = $('replyBar');
        if(!bar){ bar = document.createElement('div'); bar.id='replyBar'; bar.className='reply-bar'; $('chatInputArea').insertBefore(bar, $('chatInputArea').firstChild); }
        bar.innerHTML = '<div class="reply-bar-content"><i class="fas fa-reply"></i> <span>رد على: '+escapeHtml(State.replyTo.content.substring(0,40))+(State.replyTo.content.length>40?'...':'')+'</span></div><button onclick="window._cancelReply()"><i class="fas fa-times"></i></button>';
        bar.style.display='flex';
    }
    function showEditBar() {
        var bar = $('editBar');
        if(!bar){ bar = document.createElement('div'); bar.id='editBar'; bar.className='reply-bar edit-bar'; $('chatInputArea').insertBefore(bar, $('chatInputArea').firstChild); }
        bar.innerHTML = '<div class="reply-bar-content"><i class="fas fa-edit"></i> <span>تعديل الرسالة</span></div><button onclick="window._cancelEdit()"><i class="fas fa-times"></i></button>';
        bar.style.display='flex';
    }
    window._cancelReply = function(){ State.replyTo=null; var bar=$('replyBar'); if(bar)bar.style.display='none'; };
    window._cancelEdit = function(){ State.editingMessageId=null; $('messageInput').value=''; var bar=$('editBar'); if(bar)bar.style.display='none'; };

    // ============================================
    // VOICE MESSAGE SYSTEM
    // ============================================
    var Voice = {
        mediaRecorder: null,
        audioChunks: [],
        isRecording: false,
        recordingTime: 0,
        recordingInterval: null,

        startRecording: function() {
            if (this.isRecording) return;
            var self = this;
            navigator.mediaDevices.getUserMedia({ audio: true }).then(function(stream) {
                self.mediaRecorder = new MediaRecorder(stream);
                self.audioChunks = [];
                self.isRecording = true;
                self.recordingTime = 0;

                self.mediaRecorder.ondataavailable = function(e) { self.audioChunks.push(e.data); };
                self.mediaRecorder.onstop = function() {
                    var blob = new Blob(self.audioChunks, { type: 'audio/webm' });
                    self._showPreview(blob);
                    stream.getTracks().forEach(function(t){t.stop();});
                };

                self.mediaRecorder.start();
                self._showRecordingUI();
                self.recordingInterval = setInterval(function(){ self.recordingTime++; self._updateTimer(); }, 1000);
            }).catch(function(err){ showToast('لا يمكن الوصول للميكروفون','error'); console.error(err); });
        },

        stopRecording: function() {
            if (!this.isRecording || !this.mediaRecorder) return;
            this.mediaRecorder.stop();
            this.isRecording = false;
            clearInterval(this.recordingInterval);
            this._hideRecordingUI();
        },

        cancelRecording: function() {
            if (!this.isRecording) return;
            this.mediaRecorder.stop();
            this.isRecording = false;
            clearInterval(this.recordingInterval);
            this.audioChunks = [];
            this._hideRecordingUI();
        },

        _showRecordingUI: function() {
            var panel = $('voiceRecordingPanel');
            if (!panel) {
                panel = document.createElement('div');
                panel.id = 'voiceRecordingPanel';
                panel.className = 'voice-recording-panel';
                panel.innerHTML = '<div class="voice-recording-inner"><div class="voice-recording-wave"><span></span><span></span><span></span><span></span><span></span></div><div class="voice-recording-timer" id="voiceTimer">00:00</div><div class="voice-recording-actions"><button class="voice-btn voice-cancel" onclick="window.Voice.cancelRecording()" title="إلغاء"><i class="fas fa-trash"></i></button><button class="voice-btn voice-stop" onclick="window.Voice.stopRecording()" title="إرسال"><i class="fas fa-check"></i></button></div></div>';
                $('chatInputArea').insertBefore(panel, $('chatInputArea').firstChild);
            }
            panel.style.display = 'block';
            $('messageInputWrap').style.display = 'none';
        },

        _hideRecordingUI: function() {
            var panel = $('voiceRecordingPanel');
            if (panel) panel.style.display = 'none';
            $('messageInputWrap').style.display = 'flex';
        },

        _updateTimer: function() {
            var m = Math.floor(this.recordingTime / 60).toString().padStart(2, '0');
            var s = (this.recordingTime % 60).toString().padStart(2, '0');
            var el = $('voiceTimer');
            if (el) el.textContent = m + ':' + s;
        },

        _showPreview: function(blob) {
            var self = this;
            var reader = new FileReader();
            reader.onloadend = function() {
                var audioUrl = reader.result;
                var duration = self.recordingTime;
                self._sendVoiceMessage(audioUrl, duration);
            };
            reader.readAsDataURL(blob);
        },

        _sendVoiceMessage: function(audioUrl, duration) {
            if (!State.currentConversation) return;
            var conv = State.currentConversation;
            var convId = conv.id;
            var tempId = 'temp-voice-' + Date.now();
            var tempMsg = {
                id: tempId,
                sender_id: State.currentUser.id,
                sender_name: State.currentUser.name,
                content: audioUrl,
                type: 'voice',
                duration: duration,
                created_at: new Date().toISOString(),
                read_by: []
            };

            State.messages.push(tempMsg);
            $('messagesList').innerHTML = renderMessages(State.messages);
            Scroll.toBottom();

            // Send to server
            API.sendMessage(convId, {
                content: audioUrl,
                type: 'voice',
                duration: duration
            }).then(function(data) {
                // Server accepted the message (HTTP 200/201)
                // Update temp message to real one if server returned it
                if (data && data.message) {
                    var idx = State.messages.findIndex(function(m) { return m.id === tempId; });
                    if (idx !== -1) State.messages[idx] = data.message;
                    $('messagesList').innerHTML = renderMessages(State.messages);
                }
                // Update conversation preview
                conv.last_message = { content: '\uD83C\uDFA4 رسالة صوتية', sender_id: State.currentUser.id, created_at: new Date().toISOString(), sender_name: State.currentUser.name };
                conv.updated_at = new Date().toISOString();
                State.conversations.sort(function(a, b) { return new Date(b.updated_at || 0) - new Date(a.updated_at || 0); });
                renderConversationList(State.conversations);
                showToast('\uD83C\uDFA4 تم إرسال الرسالة الصوتية', 'success');
            }).catch(function(e) {
                // Only show error if fetch actually failed (network error or HTTP 4xx/5xx)
                showToast('تعذر إرسال الرسالة الصوتية', 'error');
                console.error('[Voice] Send error:', e.message);
            });
        },

        // Playback
        playVoice: function(url, btn) {
            var audio = new Audio(url);
            var progress = btn.parentNode.querySelector('.voice-progress-bar');
            var timeEl = btn.parentNode.querySelector('.voice-time');

            audio.addEventListener('timeupdate', function() {
                var pct = (audio.currentTime / audio.duration) * 100;
                if (progress) progress.style.width = pct + '%';
                if (timeEl) timeEl.textContent = formatTime(audio.currentTime);
            });
            audio.addEventListener('ended', function() {
                btn.innerHTML = '<i class="fas fa-play"></i>';
                if (progress) progress.style.width = '0%';
            });

            audio.play();
            btn.innerHTML = '<i class="fas fa-pause"></i>';
        }
    };
    window.Voice = Voice;

    // ============================================
    // WEBSOCKET MANAGER
    // ============================================
    var WS = {
        ws: null, connected: false, reconnectAttempts: 0, maxDelay: 30000, heartbeat: null,

        connect: function() {
            // Include auth token (server rejects tokenless connections with 1008 — same pattern as websocket-sync.js)
            var token = localStorage.getItem('authToken');
            if (!token) return;
            var protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
            var url = protocol + '//' + location.host + '/ws?token=' + encodeURIComponent(token);
            try {
                this.ws = new WebSocket(url);
                var self = this;
                this.ws.onopen = function() {
                    self.connected = true; self.reconnectAttempts = 0;
                    console.log('[Chat WS] connected');
                    self.startHeartbeat();
                    if (State.currentConversation) self.subscribe(State.currentConversation.id);
                    self.ws.send(JSON.stringify({ type: 'chat_presence' }));
                };
                this.ws.onmessage = function(ev) {
                    try { self._handle(JSON.parse(ev.data)); } catch(e) {}
                };
                this.ws.onerror = function() { self.connected = false; };
                this.ws.onclose = function() {
                    self.connected = false; self.stopHeartbeat();
                    var delay = Math.min(1000 * Math.pow(2, self.reconnectAttempts), self.maxDelay);
                    self.reconnectAttempts++;
                    console.log('[Chat WS] closed, reconnecting in', delay, 'ms...');
                    setTimeout(function(){self.connect();}, delay);
                };
            } catch(e) { console.error('[Chat WS] init error:', e); }
        },

        startHeartbeat: function() {
            this.stopHeartbeat();
            var self = this;
            this.heartbeat = setInterval(function() {
                if (self.connected && self.ws && self.ws.readyState === WebSocket.OPEN) {
                    self.ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
                }
            }, 25000);
        },

        stopHeartbeat: function() { if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; } },

        subscribe: function(convId) { if (this.connected && this.ws) this.ws.send(JSON.stringify({ type: 'chat_subscribe', conversationId: convId })); },
        unsubscribe: function(convId) { if (this.connected && this.ws) this.ws.send(JSON.stringify({ type: 'chat_unsubscribe', conversationId: convId })); },
        sendTyping: function(convId) { if (this.connected && this.ws) this.ws.send(JSON.stringify({ type: 'chat_typing', conversationId: convId, user: State.currentUser })); },

        _handle: function(data) {
            if (data.type === 'pong' || data.type === 'connected' || data.type === 'online_users_list') return;

            if (data.type === 'chat_message') {
                onIncomingMessage(data);
            } else if (data.type === 'chat_typing') {
                if (State.currentConversation && data.conversationId === State.currentConversation.id) {
                    if (data.user && State.currentUser && data.user.id == State.currentUser.id) return;
                    $('typingIndicator').style.display = 'flex';
                    $('typingText').textContent = (data.user ? data.user.name : 'مستخدم') + ' يكتب...';
                    clearTimeout(State.typingTimeout);
                    State.typingTimeout = setTimeout(function(){ $('typingIndicator').style.display = 'none'; }, 3000);
                }
            } else if (data.type === 'chat_read') {
                var msg = State.messages.find(function(m){return m.id === data.messageId;});
                if (msg) {
                    if (!msg.read_by) msg.read_by = [];
                    var already = msg.read_by.some(function(r){ var rId = r.user_id !== undefined ? r.user_id : r.userId; return String(rId) === String(data.userId); });
                    if (!already) { msg.read_by.push({ user_id: data.userId, read_at: data.readAt || new Date().toISOString() }); $('messagesList').innerHTML = renderMessages(State.messages); }
                }
            } else if (data.type === 'chat_delivered') {
                var msg = State.messages.find(function(m){return m.id === data.messageId;});
                if (msg) {
                    if (!msg.delivered_to) msg.delivered_to = [];
                    var already = msg.delivered_to.some(function(d){ var dId = d.user_id !== undefined ? d.user_id : d.userId; return String(dId) === String(data.userId); });
                    if (!already) { msg.delivered_to.push({ user_id: data.userId, delivered_at: new Date().toISOString() }); $('messagesList').innerHTML = renderMessages(State.messages); }
                }
            } else if (data.type === 'user_online') {
                if (data.userId && !State.onlineUsers.includes(data.userId)) State.onlineUsers.push(data.userId);
                updateOnlineStatus();
            } else if (data.type === 'user_offline') {
                State.onlineUsers = State.onlineUsers.filter(function(id){return id !== data.userId;});
                updateOnlineStatus();
            }
        }
    };

    // ============================================
    // INCOMING MESSAGE HANDLER
    // ============================================
    function onIncomingMessage(data) {
        var msg = data.message; var convId = data.conversationId;
        if (!msg || !convId) return;

        var existingIdx = State.messages.findIndex(function(m){
            return m.id === msg.id || (m.id && m.id.toString().startsWith('temp-') && m.content === msg.content && m.sender_id === msg.sender_id);
        });
        if (existingIdx !== -1) {
            State.messages[existingIdx] = msg;
            if (State.currentConversation && State.currentConversation.id === convId) {
                $('messagesList').innerHTML = renderMessages(State.messages);
                Scroll.smart();
            }
        }

        var conv = State.conversations.find(function(c){return c.id === convId;});
        if (conv) {
            conv.last_message = { content: msg.content, sender_id: msg.sender_id, created_at: msg.created_at, sender_name: msg.sender_name };
            conv.updated_at = msg.created_at;

            if (State.currentConversation && State.currentConversation.id === convId) {
                if (existingIdx === -1) {
                    State.messages.push(msg);
                    $('messagesList').innerHTML = renderMessages(State.messages);
                    Scroll.smart();
                }
                if (msg.sender_id !== State.currentUser.id) API.markRead(msg.id).catch(function(e){});
                // Broadcast delivered
                if (WS.connected) WS.ws.send(JSON.stringify({ type: 'chat_delivered', messageId: msg.id, conversationId: convId, userId: State.currentUser ? State.currentUser.id : null }));
            } else {
                // Different conversation — Toast + Notification
                conv.unread_count = (conv.unread_count || 0) + 1;
                if (WS.connected) WS.ws.send(JSON.stringify({ type: 'chat_delivered', messageId: msg.id, conversationId: convId, userId: State.currentUser ? State.currentUser.id : null }));
                Toast.show({ senderName: msg.sender_name || 'مستخدم', senderId: msg.sender_id, conversationId: convId, content: msg.content, messageId: msg.id, timestamp: msg.created_at });
                browserNotify(msg.sender_name || 'رسالة جديدة', msg.content || '', msg.sender_id, msg.id);
            }

            State.conversations.sort(function(a,b){return new Date(b.updated_at||0)-new Date(a.updated_at||0);});
            renderConversationList(State.conversations);

            try { if (typeof BroadcastChannel !== 'undefined') { var bc = new BroadcastChannel('chat_sync'); bc.postMessage({ type: 'chat_badge_update' }); bc.close(); } } catch(e){}
        } else {
            loadConversations();
        }
    }

    function browserNotify(title, body, senderId, messageId) {
        if (!('Notification' in window)) return;
        if (Notification.permission !== 'granted') return;
        try {
            new Notification(title, { body: body.substring(0, 100), icon: '/logo.png', tag: 'chat-msg-' + (messageId || Date.now()), requireInteraction: false });
        } catch(e){}
    }

    // ============================================
    // CONVERSATION MANAGEMENT
    // ============================================
    async function loadConversations() {
        try {
            var data = await API.getConversations();
            State.conversations = data.conversations || [];
            renderConversationList(State.conversations);
            State.conversations.forEach(function(conv){ WS.subscribe(conv.id); });
        } catch(e) { showToast('تعذر تحميل المحادثات', 'error'); }
    }

    window.openConversation = async function(convId) {
        var conv = State.conversations.find(function(c){return c.id === convId;});
        if (!conv) return;
        State.currentConversation = conv;
        State.messages = [];
        State.messagePage = 1;
        State.hasMoreMessages = false;
        State.isLoadingMessages = false;
        State.newMessageCount = 0;
        State.replyTo = null;
        State.editingMessageId = null;
        window._cancelReply();
        window._cancelEdit();

        renderConversationList(State.conversations);
        $('chatEmpty').style.display = 'none';
        $('chatActive').style.display = 'flex';
        $('chatHeaderName').textContent = conv.title;
        $('chatHeaderAvatar').innerHTML = conv.type === 'group' ? '<i class="fas fa-users"></i>' : '<i class="fas fa-user"></i>';
        $('chatHeaderAvatar').style.background = conv.type === 'group' ? 'linear-gradient(135deg, #3B82F6, #60A5FA)' : 'linear-gradient(135deg, #0D9488, #14B8A6)';

        updateHeaderStatus(conv);
        WS.subscribe(convId);
        await loadMessages(convId, 1);
        if (conv.unread_count > 0) { conv.unread_count = 0; renderConversationList(State.conversations); }
        if (window.innerWidth <= 768) { $('chatSidebar').classList.remove('open'); $('sidebarOverlay').style.display = 'none'; }
        Scroll.toBottom();
    };

    async function loadMessages(convId, page) {
        if (State.isLoadingMessages) return;
        State.isLoadingMessages = true;
        $('messagesLoader').style.display = 'flex';
        try {
            var data = await API.getMessages(convId, page);
            var newMsgs = data.messages || [];
            State.hasMoreMessages = newMsgs.length >= (data.limit || 50);
            if (page === 1) {
                State.messages = newMsgs.reverse();
                $('messagesList').innerHTML = renderMessages(State.messages);
                Scroll.toBottom();
            } else {
                var oldH = $('chatMessages').scrollHeight;
                State.messages = newMsgs.reverse().concat(State.messages);
                $('messagesList').innerHTML = renderMessages(State.messages);
                $('chatMessages').scrollTop = $('chatMessages').scrollHeight - oldH;
            }
        } catch(e) { showToast('تعذر تحميل الرسائل', 'error'); }
        finally { State.isLoadingMessages = false; $('messagesLoader').style.display = 'none'; }
    }

    function renderConversationList(conversations) {
        var list = $('conversationList');
        if (!conversations || conversations.length === 0) { list.innerHTML = '<div class="sidebar-empty"><i class="fas fa-inbox"></i><span>لا توجد محادثات</span></div>'; return; }

        var html = '';
        conversations.forEach(function(conv) {
            var isActive = State.currentConversation && State.currentConversation.id === conv.id;
            var lastMsg = conv.last_message;
            var preview = lastMsg ? lastMsg.content : 'لا توجد رسائل';
            var time = lastMsg ? formatTime(lastMsg.created_at) : formatTime(conv.updated_at);
            var unread = conv.unread_count || 0;
            var avatarIcon = conv.type === 'group' ? 'fa-users' : 'fa-user';
            var pinnedClass = conv.is_pinned ? 'pinned' : '';
            var mutedClass = conv.is_muted ? 'muted' : '';

            var otherOnline = false;
            if (conv.type === 'private') {
                var other = conv.participants.find(function(p){return p.user_id !== (State.currentUser ? State.currentUser.id : null);});
                if (other) otherOnline = State.onlineUsers.includes(other.user_id);
            }

            html += '<div class="conversation-item ' + (isActive?'active ':'') + pinnedClass + ' ' + mutedClass + '" data-id="' + conv.id + '" onclick="openConversation(' + conv.id + ')">' +
                '<div class="conversation-avatar ' + (conv.type==='group'?'group':'') + '"><i class="fas ' + avatarIcon + '"></i>' + (conv.type==='private' ? '<span class="avatar-status ' + (otherOnline?'online':'offline') + '"></span>' : '') + '</div>' +
                '<div class="conversation-info"><div class="conversation-top"><span class="conversation-name">' + escapeHtml(conv.title) + '</span><span class="conversation-time">' + time + '</span></div>' +
                '<div class="conversation-bottom"><span class="conversation-preview">' + escapeHtml(preview) + '</span>' + (unread>0?'<span class="conversation-unread">' + unread + '</span>':'') + '</div></div>' +
                '</div>';
        });
        list.innerHTML = html;

        var total = 0;
        conversations.forEach(function(c){total += (c.unread_count||0);});
        if (total > 0) document.title = '(' + total + ') المراسلات \u2013 منصة إدارة العمليات الإسعافية';
        else document.title = 'الدردشة \u2013 منصة إدارة العمليات الإسعافية';
    }

    function updateHeaderStatus(conv) {
        if (!conv) return;
        var statusText = $('chatHeaderStatusText');
        if (conv.type === 'group') { statusText.textContent = (conv.participants ? conv.participants.length : 0) + ' عضو'; statusText.classList.remove('online'); }
        else {
            var other = conv.participants.find(function(p){return p.user_id !== (State.currentUser ? State.currentUser.id : null);});
            if (other && State.onlineUsers.includes(other.user_id)) { statusText.textContent = 'متصل الآن'; statusText.classList.add('online'); }
            else { statusText.textContent = 'غير متصل'; statusText.classList.remove('online'); }
        }
    }

    function updateOnlineStatus() {
        renderConversationList(State.conversations);
        if (State.currentConversation) updateHeaderStatus(State.currentConversation);
    }

    // ============================================
    // SETTINGS PANEL
    // ============================================
    window.toggleSettings = function() {
        var panel = $('settingsPanel');
        if (!panel) {
            panel = document.createElement('div');
            panel.id = 'settingsPanel';
            panel.className = 'settings-panel';
            panel.innerHTML = '<div class="settings-panel-header"><h3><i class="fas fa-cog"></i> إعدادات الدردشة</h3><button onclick="toggleSettings()" style="background:none;border:none;color:#64748B;cursor:pointer;width:28px;height:28px;border-radius:50%;"><i class="fas fa-times"></i></button></div>' +
                '<div class="settings-panel-body">' +
                '<div class="settings-row"><div class="settings-row-label"><i class="fas fa-volume-up"></i> صوت الإشعارات</div><label class="toggle-switch"><input type="checkbox" id="settingSound" ' + (State.soundEnabled ? 'checked' : '') + ' onchange="updateSetting(\'sound\', this.checked)"><span class="toggle-slider"></span></label></div>' +
                '<div class="settings-row"><div class="settings-row-label"><i class="fas fa-check-double"></i> مؤشرات القراءة</div><label class="toggle-switch"><input type="checkbox" id="settingReadReceipts" ' + (State.settings.readReceipts ? 'checked' : '') + ' onchange="updateSetting(\'readReceipts\', this.checked)"><span class="toggle-slider"></span></label></div>' +
                '<div class="settings-row"><div class="settings-row-label"><i class="fas fa-eye"></i> آخر ظهور</div><label class="toggle-switch"><input type="checkbox" id="settingLastSeen" ' + (State.settings.lastSeen ? 'checked' : '') + ' onchange="updateSetting(\'lastSeen\', this.checked)"><span class="toggle-slider"></span></label></div>' +
                '<div class="settings-row"><div class="settings-row-label"><i class="fas fa-keyboard"></i> مؤشر الكتابة</div><label class="toggle-switch"><input type="checkbox" id="settingTyping" ' + (State.settings.typingIndicator ? 'checked' : '') + ' onchange="updateSetting(\'typingIndicator\', this.checked)"><span class="toggle-slider"></span></label></div>' +
                '</div>';
            document.body.appendChild(panel);
        }
        panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
    };

    window.updateSetting = function(key, value) {
        State.settings[key] = value;
        if (key === 'sound') State.soundEnabled = value;
        saveSettings();
        showToast('تم حفظ الإعدادات', 'success');
    };

    // ============================================
    // SEARCH WITHIN CONVERSATION
    // ============================================
    window.toggleSearch = function() {
        var searchBox = $('messageSearchBox');
        if (!searchBox) {
            searchBox = document.createElement('div');
            searchBox.id = 'messageSearchBox';
            searchBox.style.cssText = 'position:absolute;top:0;left:0;right:0;background:#fff;padding:10px 20px;border-bottom:1px solid #E2E8F0;z-index:60;display:flex;gap:10px;align-items:center;direction:rtl;';
            searchBox.innerHTML = '<i class="fas fa-search" style="color:#94A3B8;"></i><input type="text" id="messageSearchInput" placeholder="البحث في الرسائل..." style="flex:1;border:none;outline:none;font-family:inherit;font-size:0.85rem;background:transparent;"><button onclick="toggleSearch()" style="background:none;border:none;color:#94A3B8;cursor:pointer;"><i class="fas fa-times"></i></button>';
            $('chatActive').insertBefore(searchBox, $('chatHeader').nextSibling);
            $('messageSearchInput').addEventListener('input', debounce(searchMessages, 300));
        }
        var isVisible = searchBox.style.display !== 'none';
        searchBox.style.display = isVisible ? 'none' : 'flex';
        if (!isVisible) { $('messageSearchInput').value = ''; $('messageSearchInput').focus(); searchMessages(); }
    };

    function searchMessages() {
        var query = ($('messageSearchInput') ? $('messageSearchInput').value : '').toLowerCase().trim();
        if (!query) {
            $('messagesList').innerHTML = renderMessages(State.messages);
            return;
        }
        var filtered = State.messages.filter(function(m){return (m.content || '').toLowerCase().includes(query);});
        $('messagesList').innerHTML = renderMessages(filtered);
    }

    // ============================================
    // SEND MESSAGE (with reply + edit support)
    // ============================================
    async function sendMessage() {
        var input = $('messageInput');
        var content = input.value.trim();
        if (!content || !State.currentConversation) return;

        var convId = State.currentConversation.id;

        // Handle edit
        if (State.editingMessageId) {
            try {
                await API.editMessage(State.editingMessageId, content);
                var msg = State.messages.find(function(m){return m.id === State.editingMessageId;});
                if (msg) { msg.content = content; msg.is_edited = true; $('messagesList').innerHTML = renderMessages(State.messages); }
                window._cancelEdit();
                showToast('تم التعديل', 'success');
            } catch(e) { showToast('تعذر التعديل', 'error'); }
            return;
        }

        var tempId = 'temp-' + Date.now();
        var replyData = State.replyTo ? { reply_to_id: State.replyTo.id, reply_preview: State.replyTo.content.substring(0, 50) } : null;
        var tempMsg = { id: tempId, sender_id: State.currentUser.id, sender_name: State.currentUser.name, content: content, created_at: new Date().toISOString(), read_by: [], reply_to: State.replyTo };

        State.messages.push(tempMsg);
        $('messagesList').innerHTML = renderMessages(State.messages);
        Scroll.toBottom();
        input.value = ''; input.style.height = 'auto'; $('sendBtn').disabled = true;
        window._cancelReply();

        try {
            var payload = { content: content, type: 'text' };
            if (replyData) payload.reply_to = replyData;
            var data = await API.sendMessage(convId, payload);
            if (data.success && data.message) {
                var idx = State.messages.findIndex(function(m){return m.id === tempId;});
                if (idx !== -1) State.messages[idx] = data.message;
                $('messagesList').innerHTML = renderMessages(State.messages);
                conv.last_message = { content: data.message.content, sender_id: data.message.sender_id, created_at: data.message.created_at, sender_name: data.message.sender_name };
                conv.updated_at = data.message.created_at;
                State.conversations.sort(function(a,b){return new Date(b.updated_at||0)-new Date(a.updated_at||0);});
                renderConversationList(State.conversations);
            }
        } catch(e) { showToast('تعذر الإرسال', 'error'); }
    }

    function handleTyping() {
        if (!State.currentConversation) return;
        var now = Date.now();
        if (State.lastTypingSent && (now - State.lastTypingSent) < 2000) return;
        State.lastTypingSent = now;
        WS.sendTyping(State.currentConversation.id);
    }

    // ============================================
    // VOICE BUTTON
    // ============================================
    function setupVoiceButton() {
        var attachBtn = $('attachBtn');
        if (attachBtn) {
            attachBtn.innerHTML = '<i class="fas fa-microphone"></i>';
            attachBtn.title = 'رسالة صوتية';
            attachBtn.onclick = function() { Voice.startRecording(); };
        }
    }

    // ============================================
    // EVENT BINDINGS
    // ============================================
    function bindEvents() {
        $('sendBtn').addEventListener('click', sendMessage);
        $('messageInput').addEventListener('keydown', function(e){ if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
        $('messageInput').addEventListener('input', function(){ this.style.height = 'auto'; this.style.height = Math.min(this.scrollHeight, 120) + 'px'; $('sendBtn').disabled = !this.value.trim(); handleTyping(); });
        $('chatMessages').addEventListener('scroll', debounce(handleMessagesScroll, 200));
        $('chatMessages').addEventListener('scroll', debounce(function(){Scroll.track();}, 100));
        $('messagesList').addEventListener('contextmenu', function(e){
            var row = e.target.closest('.message-row');
            if (row) { var msgId = parseInt(row.dataset.msgId); var isMine = row.dataset.isMine === 'true'; showMessageMenu(e, msgId, isMine); }
        });
        $('newChatBtn').addEventListener('click', openNewChatModal);
        $('newGroupBtn').addEventListener('click', openNewGroupModal);
        $('mobileSidebarToggle').addEventListener('click', function(){$('chatSidebar').classList.add('open'); $('sidebarOverlay').style.display='block';});
        $('chatHeaderBack').addEventListener('click', function(){State.currentConversation=null; $('chatActive').style.display='none'; $('chatEmpty').style.display='flex'; renderConversationList(State.conversations); $('chatSidebar').classList.add('open'); $('sidebarOverlay').style.display='block';});
        $('sidebarOverlay').addEventListener('click', function(){$('chatSidebar').classList.remove('open'); this.style.display='none';});
        $('userSearchInput').addEventListener('input', function(){filterUsers(this.value, 'userList', false);});
        $('userList').addEventListener('click', function(e){var item=e.target.closest('.user-item'); if(item) startPrivateChat(item.dataset.id);});
        $('groupUserSearchInput').addEventListener('input', function(){filterUsers(this.value, 'groupUserList', true);});
        $('groupUserList').addEventListener('click', function(e){var item=e.target.closest('.user-item'); if(item) toggleUserSelection(item.dataset.id, item.dataset.name);});
        $('createGroupBtn').addEventListener('click', createGroup);
        $('conversationSearch').addEventListener('input', function(){var q=this.value.toLowerCase().trim(); if(!q){renderConversationList(State.conversations);return;} var f=State.conversations.filter(function(c){return (c.title||'').toLowerCase().includes(q) || (c.last_message && (c.last_message.content||'').toLowerCase().includes(q));}); renderConversationList(f);});
        $('chatHeaderSearch').addEventListener('click', function(){toggleSearch();});

        setupVoiceButton();

        document.querySelectorAll('.modal').forEach(function(m){m.addEventListener('click', function(e){if(e.target===m)m.style.display='none';});});
    }

    function handleMessagesScroll() { var c=$('chatMessages'); if(c.scrollTop<50 && State.hasMoreMessages && !State.isLoadingMessages){State.messagePage++; loadMessages(State.currentConversation.id, State.messagePage);} }

    async function loadCurrentUser() { try { var r=await fetch('/api/auth/me',{headers:{'Authorization':'Bearer '+authToken}}); var d=await r.json(); if(d.user){State.currentUser=d.user; $('currentUserName').textContent=d.user.name||d.user.username;} } catch(e){} }
    async function loadUsers() { try { var d=await API.getUsers(); State.users=d.users||[]; } catch(e){showToast('تعذر تحميل المستخدمين','error');} }

    // --- Modal functions ---
    window.closeModal=function(id){$(id).style.display='none';};
    function openNewChatModal(){renderUserList(State.users,'userList',false); $('newChatModal').style.display='flex'; $('userSearchInput').value=''; $('userSearchInput').focus();}
    function openNewGroupModal(){State.selectedParticipants.clear(); updateSelectedUsers(); renderUserList(State.users,'groupUserList',true); $('newGroupModal').style.display='flex'; $('groupTitleInput').value=''; $('groupUserSearchInput').value=''; $('groupTitleInput').focus();}
    async function startPrivateChat(userId){closeModal('newChatModal'); try{var d=await API.startPrivate(userId); if(d.success&&d.conversation){var exists=State.conversations.some(function(c){return c.id===d.conversation.id;}); if(!exists)State.conversations.unshift(d.conversation); renderConversationList(State.conversations); openConversation(d.conversation.id); showToast('تم بدء المحادثة','success');}}catch(e){showToast('تعذر بدء المحادثة','error');}}
    async function createGroup(){var t=$('groupTitleInput').value.trim(); if(!t){showToast('أدخل اسم المجموعة','warning');return;} if(State.selectedParticipants.size===0){showToast('اختر عضواً واحداً على الأقل','warning');return;} var ids=Array.from(State.selectedParticipants); closeModal('newGroupModal'); try{var d=await API.createGroup(t,ids); if(d.success&&d.conversation){State.conversations.unshift(d.conversation); renderConversationList(State.conversations); openConversation(d.conversation.id); showToast('تم إنشاء المجموعة','success');}}catch(e){showToast('تعذر إنشاء المجموعة','error');}}
    function filterUsers(q,listId,sel){q=(q||'').toLowerCase().trim(); if(!q){renderUserList(State.users,listId,sel);return;} var f=State.users.filter(function(u){return(u.name||u.username||'').toLowerCase().includes(q);}); renderUserList(f,listId,sel);}
    function toggleUserSelection(id,name){if(State.selectedParticipants.has(id))State.selectedParticipants.delete(id);else State.selectedParticipants.add(id); updateSelectedUsers(); renderUserList(State.users,'groupUserList',true);}
    function updateSelectedUsers(){var c=$('selectedUsers'); var n=$('selectedCount'); if(State.selectedParticipants.size===0){c.innerHTML='<span style="color:#94A3B8;font-size:0.75rem;">لم يتم اختيار أحد</span>'; n.textContent='0';return;} n.textContent=State.selectedParticipants.size; var h=''; State.selectedParticipants.forEach(function(id){var u=State.users.find(function(x){return x.id===id;}); if(!u)return; var nm=u.name||u.username; h+='<span class="selected-user-chip">'+escapeHtml(nm)+'<button onclick="window._removeSelected('+id+')" title="إزالة"><i class="fas fa-times"></i></button></span>';}); c.innerHTML=h;}
    window._removeSelected=function(id){State.selectedParticipants.delete(id); updateSelectedUsers(); renderUserList(State.users,'groupUserList',true);};
    function renderUserList(users,containerId,sel){var c=$(containerId); if(!users||users.length===0){c.innerHTML='<div class="sidebar-empty"><span>لا يوجد مستخدمون</span></div>';return;} var myId=State.currentUser?State.currentUser.id:null; var h=''; users.forEach(function(u){if(u.id===myId)return; var isSel=sel&&State.selectedParticipants.has(u.id); h+='<div class="user-item '+(isSel?'selected':'')+'" data-id="'+u.id+'" data-name="'+escapeHtml(u.name||u.username)+'"><div class="user-item-avatar '+(State.onlineUsers.includes(u.id)?'online':'')+'"><i class="fas fa-user"></i></div><div class="user-item-info"><div class="user-item-name">'+escapeHtml(u.name||u.username)+'</div><div class="user-item-role">'+escapeHtml(u.role||'مستخدم')+'</div></div>'+(sel?'<div class="user-item-check"><i class="fas fa-check"></i></div>':'')+'</div>';}); c.innerHTML=h;}

    // ============================================
    // INIT
    // ============================================
    async function init() {
        bindEvents();
        await loadCurrentUser();
        await loadUsers();
        await loadConversations();
        WS.connect();
        if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
        window.addEventListener('beforeunload', function(){ if(WS.ws) try{WS.ws.close();}catch(e){} });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();