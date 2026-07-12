// ============================================
// Chat Toast Notification System
// Professional toast notifications for new chat messages
// Features: Smart filtering, sound alerts, click-to-open, stacking
// ============================================

(function() {
    'use strict';

    // ===== Configuration & State =====
    var ToastConfig = {
        duration: 6000,           // Toast visible for 6 seconds
        maxStack: 5,              // Max 5 toasts stacked
        soundEnabled: true,       // Sound on by default
        position: 'bottom-right', // Fixed position
        showAvatar: true,
        showTime: true,
        previewLength: 60         // Characters of message preview
    };

    // Load saved settings
    function loadSettings() {
        try {
            var saved = localStorage.getItem('chatToastSettings');
            if (saved) {
                var parsed = JSON.parse(saved);
                ToastConfig.soundEnabled = parsed.soundEnabled !== false;
            }
        } catch(e) {}
    }
    loadSettings();

    // Track current state
    var toastStack = [];
    var toastContainer = null;
    var currentConversationId = null;
    var currentPage = window.location.pathname;
    var soundUnlocked = false;

    // ===== Audio for notification sound =====
    // Generate a pleasant notification sound using Web Audio API
    function createNotificationSound() {
        try {
            var AudioContext = window.AudioContext || window.webkitAudioContext;
            if (!AudioContext) return null;
            var ctx = new AudioContext();
            
            return function play() {
                if (!ToastConfig.soundEnabled) return;
                if (!soundUnlocked) return; // Require user interaction first
                
                try {
                    var now = ctx.currentTime;
                    
                    // Two-tone notification (similar to WhatsApp)
                    // First tone
                    var osc1 = ctx.createOscillator();
                    var gain1 = ctx.createGain();
                    osc1.connect(gain1);
                    gain1.connect(ctx.destination);
                    osc1.frequency.setValueAtTime(800, now);
                    osc1.frequency.setValueAtTime(600, now + 0.1);
                    gain1.gain.setValueAtTime(0.3, now);
                    gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
                    osc1.start(now);
                    osc1.stop(now + 0.3);
                    
                    // Second tone (slightly delayed)
                    var osc2 = ctx.createOscillator();
                    var gain2 = ctx.createGain();
                    osc2.connect(gain2);
                    gain2.connect(ctx.destination);
                    osc2.frequency.setValueAtTime(1000, now + 0.15);
                    osc2.frequency.setValueAtTime(800, now + 0.25);
                    gain2.gain.setValueAtTime(0.25, now + 0.15);
                    gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.45);
                    osc2.start(now + 0.15);
                    osc2.stop(now + 0.45);
                    
                } catch(e) {
                    console.log('[Toast] Sound play error:', e.message);
                }
            };
        } catch(e) {
            console.log('[Toast] Audio not supported');
            return null;
        }
    }

    var playSound = createNotificationSound();

    // ===== Unlock audio on first user interaction =====
    function unlockAudio() {
        if (soundUnlocked) return;
        soundUnlocked = true;
        // Resume audio context if suspended
        try {
            var AudioContext = window.AudioContext || window.webkitAudioContext;
            if (AudioContext) {
                var ctx = new AudioContext();
                if (ctx.state === 'suspended') {
                    ctx.resume();
                }
            }
        } catch(e) {}
    }
    document.addEventListener('click', unlockAudio, { once: true });
    document.addEventListener('keydown', unlockAudio, { once: true });
    document.addEventListener('touchstart', unlockAudio, { once: true });

    // ===== Create Toast Container =====
    function ensureContainer() {
        if (toastContainer) return;
        
        toastContainer = document.createElement('div');
        toastContainer.id = 'chatToastContainer';
        toastContainer.className = 'chat-toast-container';
        toastContainer.setAttribute('dir', 'rtl');
        document.body.appendChild(toastContainer);
    }

    // ===== Format relative time =====
    function formatToastTime(dateStr) {
        if (!dateStr) return 'الآن';
        var d = new Date(dateStr);
        if (isNaN(d.getTime())) return 'الآن';
        return d.toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit', hour12: false });
    }

    // ===== Escape HTML =====
    function escapeHtml(text) {
        if (!text) return '';
        var div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // ===== Get initials from name =====
    function getInitials(name) {
        if (!name) return '?';
        return name.split(' ').map(function(w) { return w[0]; }).join('').substring(0, 2);
    }

    // ===== Generate avatar color from name =====
    function getAvatarColor(name) {
        var colors = ['#0D9488', '#3B82F6', '#8B5CF6', '#EC4899', '#F59E0B', '#10B981', '#6366F1', '#14B8A6'];
        var hash = 0;
        for (var i = 0; i < (name || '').length; i++) {
            hash = name.charCodeAt(i) + ((hash << 5) - hash);
        }
        return colors[Math.abs(hash) % colors.length];
    }

    // ===== Show Toast Notification =====
    function showToast(data) {
        ensureContainer();

        var senderName = data.senderName || 'مستخدم';
        var senderId = data.senderId || '';
        var conversationId = data.conversationId;
        var messageContent = data.content || '';
        var messageId = data.messageId;
        var timestamp = data.timestamp || new Date().toISOString();
        var senderAvatar = data.senderAvatar || null;

        // Smart filtering: Don't show toast if user is currently viewing this conversation
        if (isViewingConversation(conversationId)) {
            return;
        }

        // Smart filtering: Don't show toast for messages sent by current user
        if (senderId === getCurrentUserId()) {
            return;
        }

        // Remove oldest toast if stack is full
        if (toastStack.length >= ToastConfig.maxStack) {
            var oldest = toastStack.shift();
            if (oldest && oldest.element) {
                removeToastElement(oldest.element);
            }
        }

        // Create toast element
        var toast = document.createElement('div');
        toast.className = 'chat-toast';
        toast.dataset.conversationId = conversationId;
        toast.dataset.messageId = messageId;

        var initials = getInitials(senderName);
        var avatarColor = getAvatarColor(senderName);
        var time = formatToastTime(timestamp);
        var preview = escapeHtml(messageContent).substring(0, ToastConfig.previewLength);
        if (messageContent.length > ToastConfig.previewLength) {
            preview += '...';
        }

        toast.innerHTML =
            '<div class="chat-toast-avatar" style="background:' + avatarColor + '">' +
                (senderAvatar ? '<img src="' + senderAvatar + '" alt="">' : '<span>' + initials + '</span>') +
            '</div>' +
            '<div class="chat-toast-body">' +
                '<div class="chat-toast-header">' +
                    '<span class="chat-toast-name">' + escapeHtml(senderName) + '</span>' +
                    '<span class="chat-toast-time">' + time + '</span>' +
                '</div>' +
                '<div class="chat-toast-preview">' + preview + '</div>' +
            '</div>' +
            '<button class="chat-toast-close" title="إغلاق">&times;</button>';

        // Click toast to open conversation
        toast.addEventListener('click', function(e) {
            if (e.target.closest('.chat-toast-close')) return;
            openConversation(conversationId);
            removeToastElement(toast);
        });

        // Close button
        var closeBtn = toast.querySelector('.chat-toast-close');
        closeBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            removeToastElement(toast);
        });

        // Add to container
        toastContainer.appendChild(toast);

        // Force reflow for animation
        toast.offsetHeight;
        toast.classList.add('chat-toast-visible');

        // Track in stack
        var toastObj = {
            element: toast,
            conversationId: conversationId,
            messageId: messageId,
            timestamp: Date.now()
        };
        toastStack.push(toastObj);

        // Play sound
        if (playSound) playSound();

        // Auto remove after duration
        setTimeout(function() {
            removeToastElement(toast);
        }, ToastConfig.duration);
    }

    // ===== Remove Toast Element =====
    function removeToastElement(element) {
        if (!element) return;
        element.classList.remove('chat-toast-visible');
        element.classList.add('chat-toast-hiding');
        setTimeout(function() {
            if (element.parentNode) {
                element.parentNode.removeChild(element);
            }
            // Remove from stack
            toastStack = toastStack.filter(function(t) { return t.element !== element; });
        }, 300);
    }

    // ===== Check if user is viewing a specific conversation =====
    function isViewingConversation(conversationId) {
        // On chat page and viewing the same conversation
        if (currentPage.indexOf('chat.html') !== -1) {
            if (currentConversationId && String(currentConversationId) === String(conversationId)) {
                return true;
            }
        }
        return false;
    }

    // ===== Open conversation =====
    function openConversation(conversationId) {
        if (!conversationId) return;

        if (currentPage.indexOf('chat.html') !== -1) {
            // Already on chat page - open the conversation
            if (typeof openConversation === 'function' && typeof chatState !== 'undefined') {
                try {
                    window.openConversation(conversationId);
                } catch(e) {
                    console.error('[Toast] Error opening conversation:', e);
                }
            } else {
                // Store target conversation and reload if needed
                sessionStorage.setItem('chat_target_conversation', conversationId);
                window.location.reload();
            }
        } else {
            // Navigate to chat page with conversation
            sessionStorage.setItem('chat_target_conversation', conversationId);
            window.location.href = 'chat.html?conv=' + conversationId;
        }
    }

    // ===== Get current user ID =====
    function getCurrentUserId() {
        try {
            // Try to get from chatState if available
            if (typeof chatState !== 'undefined' && chatState.currentUser) {
                return chatState.currentUser.id;
            }
            // Try from localStorage
            var user = localStorage.getItem('currentUser');
            if (user) {
                var parsed = JSON.parse(user);
                return parsed.id;
            }
        } catch(e) {}
        return null;
    }

    // ===== Settings Panel =====
    function createSettingsPanel() {
        var panel = document.createElement('div');
        panel.id = 'chatToastSettings';
        panel.className = 'chat-toast-settings';
        panel.style.display = 'none';
        panel.innerHTML =
            '<div class="chat-toast-settings-header">' +
                '<h3><i class="fas fa-bell"></i> إعدادات الإشعارات</h3>' +
                '<button class="chat-toast-settings-close">&times;</button>' +
            '</div>' +
            '<div class="chat-toast-settings-body">' +
                '<div class="chat-toast-setting-row">' +
                    '<label>تفعيل صوت الإشعارات</label>' +
                    '<label class="chat-toast-switch">' +
                        '<input type="checkbox" id="toastSoundToggle" ' + (ToastConfig.soundEnabled ? 'checked' : '') + '>' +
                        '<span class="chat-toast-slider"></span>' +
                    '</label>' +
                '</div>' +
                '<div class="chat-toast-setting-row">' +
                    '<label>مدة عرض الإشعار (ثواني)</label>' +
                    '<select id="toastDurationSelect">' +
                        '<option value="3000" ' + (ToastConfig.duration === 3000 ? 'selected' : '') + '>3</option>' +
                        '<option value="5000" ' + (ToastConfig.duration === 5000 ? 'selected' : '') + '>5</option>' +
                        '<option value="6000" ' + (ToastConfig.duration === 6000 ? 'selected' : '') + '>6</option>' +
                        '<option value="10000" ' + (ToastConfig.duration === 10000 ? 'selected' : '') + '>10</option>' +
                    '</select>' +
                '</div>' +
                '<div class="chat-toast-setting-row">' +
                    '<button class="btn btn-sm btn-primary" id="toastTestSound">' +
                        '<i class="fas fa-volume-up"></i> اختبار الصوت' +
                    '</button>' +
                '</div>' +
            '</div>';

        document.body.appendChild(panel);

        // Event handlers
        panel.querySelector('.chat-toast-settings-close').addEventListener('click', function() {
            panel.style.display = 'none';
        });

        panel.querySelector('#toastSoundToggle').addEventListener('change', function(e) {
            ToastConfig.soundEnabled = e.target.checked;
            saveSettings();
        });

        panel.querySelector('#toastDurationSelect').addEventListener('change', function(e) {
            ToastConfig.duration = parseInt(e.target.value);
            saveSettings();
        });

        panel.querySelector('#toastTestSound').addEventListener('click', function() {
            if (playSound) playSound();
        });

        // Close on backdrop click
        panel.addEventListener('click', function(e) {
            if (e.target === panel) panel.style.display = 'none';
        });

        return panel;
    }

    var settingsPanel = null;

    function showSettings() {
        if (!settingsPanel) {
            settingsPanel = createSettingsPanel();
        }
        settingsPanel.style.display = 'flex';
    }

    function saveSettings() {
        try {
            localStorage.setItem('chatToastSettings', JSON.stringify({
                soundEnabled: ToastConfig.soundEnabled,
                duration: ToastConfig.duration
            }));
        } catch(e) {}
    }

    // ===== Public API =====
    window.ChatToast = {
        show: showToast,
        showSettings: showSettings,
        setCurrentConversation: function(convId) {
            currentConversationId = convId;
        },
        setSoundEnabled: function(enabled) {
            ToastConfig.soundEnabled = enabled;
            saveSettings();
        },
        isSoundEnabled: function() {
            return ToastConfig.soundEnabled;
        },
        clearAll: function() {
            toastStack.forEach(function(t) {
                removeToastElement(t.element);
            });
            toastStack = [];
        },
        getUnreadCount: function() {
            return toastStack.length;
        }
    };

    // Check for target conversation on page load
    function checkTargetConversation() {
        var target = sessionStorage.getItem('chat_target_conversation');
        if (target) {
            sessionStorage.removeItem('chat_target_conversation');
            // Wait for chat.js to initialize
            setTimeout(function() {
                if (typeof window.openConversation === 'function') {
                    try {
                        window.openConversation(parseInt(target));
                    } catch(e) {}
                }
            }, 500);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', checkTargetConversation);
    } else {
        checkTargetConversation();
    }

    console.log('[ChatToast] Toast notification system loaded');
})();