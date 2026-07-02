/* ========================================
   NANO AI BOT - EMS South Sector Platform
   Animated AI Assistant JavaScript
   ======================================== */

(function() {
    'use strict';

    // Bot Configuration
    const NANO_CONFIG = {
        name: 'نــانــو',
        role: 'المساعد الذكي',
        avatar: '/images/nano_animated_v3.webp',
        greetingDelay: 2000,
        tipInterval: 300000, // 5 minutes
        wsReconnectInterval: 5000
    };

    // Page-specific guidance
    const PAGE_GUIDANCE = {
        'index.html': {
            welcome: 'أهلاً بك في لوحة التحكم الرئيسية! يمكنك متابعة جميع العمليات الإسعافية من هنا.',
            tips: [
                '💡 تلميح: اضغط على زر "تكميل" لبدء تسجيل بيانات المناوبة.',
                '💡 تلميح: أرقام البلاغات تُحدّث فوراً مع كل بلاغ جديد.',
                '💡 تلميح: يمكنك اختيار مناوبة سابقة من الأرشيف للمقارنة.',
                '💡 تلميح: شريط التنبيهات يظهر التنبيهات العاجلة فور وصولها.',
                '💡 تلميح: مؤشرات القوى العاملة تساعدك في تحديد المراكز الناقصة.'
            ],
            actions: ['تسجيل بلاغ', 'تكميل النوبة', 'عرض الإحصائيات', 'فتح الخريطة']
        },
        'operations-command.html': {
            welcome: 'مرحباً في غرفة العمليات الذكية! هنا يمكنك إدارة الملفات والبروتوكولات.',
            tips: [
                '💡 تلميح: اسحب الملفات مباشرة لرفعها.',
                '💡 تلميح: صنّف الملفات حسب الأهمية (عاجل/عام/تقرير/بروتوكول).',
                '💡 تلميح: راجع البروتوكولات التشغيلية بشكل دوري.',
                '💡 تلميح: التحديثات التشغيلية تظهر هنا أولاً.'
            ],
            actions: ['رفع ملف', 'عرض البروتوكولات', 'قراءة التحديثات']
        },
        'report-entry.html': {
            welcome: 'صفحة تسجيل البلاغات! سجل كل بلاغ بضغطة زر.',
            tips: [
                '💡 تلميح: اضغط + لإضافة بلاغ فوراً مع التاريخ والوقت.',
                '💡 تلميح: يمكنك التراجع عن آخر بلاغ بالضغط على "تراجع".',
                '💡 تلميح: الإجمالي يُحدّث تلقائياً لجميع المستخدمين.',
                '💡 تلميح: إحصائيات البلاغات تظهر أنواع الحالات (تصادم، سقوط، حريق...).'
            ],
            actions: ['إضافة بلاغ', 'تراجع', 'عرض التوزيع']
        },
        'smart-schedule.html': {
            welcome: 'نظام الجداول! إدارة الجداول التشغيلية بسهولة.',
            tips: [
                '💡 تلميح: استورد الجداول من Excel مباشرة.',
                '💡 تلميح: صدّر الجدول كـ PDF أو Excel.',
                '💡 تلميح: أنشئ QR Code للمشاركة السريعة.',
                '💡 تلميح: استخدم OCR لتحويل صور الجداول إلى بيانات.'
            ],
            actions: ['استيراد Excel', 'تصدير PDF', 'إنشاء QR Code']
        },
        'form-e.html': {
            welcome: 'نموذج حالات توقف القلب والتنفس! أدخل البيانات بدقة.',
            tips: [
                '💡 تلميح: سجل زمن الاستجابة بدقة (كل دقيقة مهمة).',
                '💡 تلميح: أدخل النتيجة النهائية للحالة (استعادة نبض/وفاة).',
                '💡 تلميح: الملاحظات تساعد في مراجعات الجودة.'
            ],
            actions: ['حفظ النموذج', 'عرض الأرشيف']
        },
        'form-incident.html': {
            welcome: 'بلاغ الحادث! سجل تفاصيل الحادث بدقة.',
            tips: [
                '💡 تلميح: حدد نوع الحادث (مروري، صناعي، منزلي...).',
                '💡 تلميح: أدخل عدد الإصابات والوفيات بدقة.',
                '💡 تلميح: حدد المستشفى الوجهة للنقل.'
            ],
            actions: ['حفظ البلاغ', 'طباعة']
        },
        'form-escalation.html': {
            welcome: 'بلاغ التصعيد! للحالات التي تتطلب تدخلاً إضافياً.',
            tips: [
                '💡 تلميح: حدد الجهات المشاركة (الدفاع المدني، المرور...).',
                '💡 تلميح: وصف التفاصيل يساعد في التحقيقات المستقبلية.'
            ],
            actions: ['حفظ البلاغ', 'إرسال تنبيه']
        },
        'form-daily.html': {
            welcome: 'التقرير اليومي! ملخص العمليات اليومية.',
            tips: [
                '💡 تلميح: راجع الفرق المستجيبة قبل التقديم.',
                '💡 تلميح: أدخل ملخصاً واضحاً لليوم.'
            ],
            actions: ['حفظ التقرير', 'عرض السابق']
        },
        'form-air.html': {
            welcome: 'بلاغ الإسعاف الجوي! للحالات التي تتطلب نقلاً جوياً.',
            tips: [
                '💡 تلميح: حدد المستشفى الوجهة بدقة.',
                '💡 تلميح: أدخل الملاحظات حسب الحالة.'
            ],
            actions: ['حفظ البلاغ', 'إرسال واتساب']
        },
        'form-senior.html': {
            welcome: 'توقيع كبار المسعفين! تأكيد صحة بيانات المناوبة.',
            tips: [
                '💡 تلميح: راجع بيانات التكميل قبل التوقيع.',
                '💡 تلميح: التوقيع الرقمي يُربط بالمناوبة الحالية.'
            ],
            actions: ['توقيع', 'حفظ']
        },
        'upload-logo.html': {
            welcome: 'رفع الشعار! تخصيص الهوية البصرية للمنصة.',
            tips: [
                '💡 تلميح: استخدم صورة بجودة عالية (PNG أو SVG).',
                '💡 تلميح: الشعار يظهر في جميع الصفحات.'
            ],
            actions: ['رفع صورة', 'حفظ']
        }
    };

    // Generic tips for any page
    const GENERIC_TIPS = [
        '💡 تلميح: يمكنك تغيير الوضع الداكن/الفاتح من الإعدادات.',
        '💡 تلميح: البيانات تُحفظ تلقائياً في قاعدة البيانات.',
        '💡 تلميح: استخدم الإشعارات للبقاء على اطلاع بالتنبيهات.',
        '💡 تلميح: راجع سجل العمليات بشكل دوري للتدقيق.',
        '💡 تلميح: في حالة وجود مشكلة، تحقق من اتصالك بالإنترنت.'
    ];

    // Emergency alerts
    const EMERGENCY_ALERTS = [
        '⚠️ تنبيه: تأكد من تحديث بيانات التكميل قبل نهاية المناوبة.',
        '⚠️ تنبيه: راجع حالة الوقود للمركبات بشكل دوري.',
        '⚠️ تنبيه: لا تنسَ تسجيل البلاغات فور استلامها.',
        '⚠️ تنبيه: تحقق من جاهزية الفرق قبل بدء المناوبة.'
    ];

    class NanoBot {
        constructor() {
            this.container = null;
            this.chatWindow = null;
            this.messages = [];
            this.currentPage = this.detectPage();
            this.pageConfig = this.getPageConfig();
            this.ws = null;
            this.isOpen = false;
            this.notificationCount = 0;
            this.init();
        }

        detectPage() {
            const path = window.location.pathname;
            const filename = path.split('/').pop() || 'index.html';
            return filename;
        }

        getPageConfig() {
            return PAGE_GUIDANCE[this.currentPage] || {
                welcome: 'مرحباً بك في منصة قطاع الجنوب!',
                tips: GENERIC_TIPS,
                actions: ['عرض المساعدة']
            };
        }

        init() {
            this.createBotUI();
            this.bindEvents();
            this.connectWebSocket();
            
            // Greeting after delay
            setTimeout(() => {
                this.showGreeting();
            }, NANO_CONFIG.greetingDelay);

            // Periodic tips
            setInterval(() => {
                this.showRandomTip();
            }, NANO_CONFIG.tipInterval);

            // Check for notifications
            this.checkNotifications();
        }

        createBotUI() {
            // Create container
            this.container = document.createElement('div');
            this.container.className = 'nano-bot-container';
            this.container.id = 'nanoBotContainer';

            // Create avatar
            const avatar = document.createElement('div');
            avatar.className = 'nano-bot-avatar idle';
            avatar.id = 'nanoBotAvatar';
            avatar.innerHTML = `
                <img src="${NANO_CONFIG.avatar}" alt="${NANO_CONFIG.name}" onerror="this.src='/images/nano-character.png'">
                <div class="nano-bot-badge" id="nanoBadge" style="display:none">0</div>
                <div class="nano-bot-tooltip">مرحباً! أنا ${NANO_CONFIG.name}</div>
            `;

            // Create chat window
            this.chatWindow = document.createElement('div');
            this.chatWindow.className = 'nano-chat-window';
            this.chatWindow.id = 'nanoChatWindow';
            this.chatWindow.innerHTML = `
                <div class="nano-chat-header">
                    <div class="nano-header-avatar">
                        <img src="${NANO_CONFIG.avatar}" alt="${NANO_CONFIG.name}" onerror="this.src='/images/nano-character.png'">
                    </div>
                    <div class="nano-header-info">
                        <h4>${NANO_CONFIG.name}</h4>
                        <span>${NANO_CONFIG.role}</span>
                    </div>
                    <button class="nano-close-btn" id="nanoCloseBtn">&times;</button>
                </div>
                <div class="nano-chat-messages" id="nanoChatMessages"></div>
                <div class="nano-quick-actions" id="nanoQuickActions"></div>
                <div class="nano-chat-input-area">
                    <input type="text" class="nano-chat-input" id="nanoChatInput" placeholder="اكتب رسالتك هنا...">
                    <button class="nano-send-btn" id="nanoSendBtn">&#10148;</button>
                </div>
            `;

            this.container.appendChild(this.chatWindow);
            this.container.appendChild(avatar);
            document.body.appendChild(this.container);

            // Cache elements
            this.elements = {
                avatar: document.getElementById('nanoBotAvatar'),
                chatWindow: document.getElementById('nanoChatWindow'),
                messages: document.getElementById('nanoChatMessages'),
                quickActions: document.getElementById('nanoQuickActions'),
                input: document.getElementById('nanoChatInput'),
                sendBtn: document.getElementById('nanoSendBtn'),
                closeBtn: document.getElementById('nanoCloseBtn'),
                badge: document.getElementById('nanoBadge')
            };
        }

        bindEvents() {
            // Avatar click
            this.elements.avatar.addEventListener('click', () => {
                this.toggleChat();
            });

            // Close button
            this.elements.closeBtn.addEventListener('click', () => {
                this.closeChat();
            });

            // Send button
            this.elements.sendBtn.addEventListener('click', () => {
                this.sendUserMessage();
            });

            // Enter key
            this.elements.input.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    this.sendUserMessage();
                }
            });

            // Close on outside click
            document.addEventListener('click', (e) => {
                if (this.isOpen && !this.container.contains(e.target)) {
                    this.closeChat();
                }
            });
        }

        toggleChat() {
            if (this.isOpen) {
                this.closeChat();
            } else {
                this.openChat();
            }
        }

        openChat() {
            this.isOpen = true;
            this.chatWindow.classList.add('open');
            this.elements.avatar.classList.remove('idle');
            this.elements.avatar.classList.add('greeting');
            
            // Reset badge
            this.notificationCount = 0;
            this.elements.badge.style.display = 'none';
            this.elements.avatar.classList.remove('has-notification');
            
            setTimeout(() => {
                this.elements.avatar.classList.remove('greeting');
                this.elements.avatar.classList.add('idle');
            }, 2000);
        }

        closeChat() {
            this.isOpen = false;
            this.chatWindow.classList.remove('open');
        }

        showGreeting() {
            this.addMessage('bot', this.pageConfig.welcome);
            this.showQuickActions();
        }

        showRandomTip() {
            if (!this.isOpen) return;
            const tips = this.pageConfig.tips || GENERIC_TIPS;
            const randomTip = tips[Math.floor(Math.random() * tips.length)];
            this.addMessage('tip', randomTip);
        }

        showEmergencyAlert() {
            const alert = EMERGENCY_ALERTS[Math.floor(Math.random() * EMERGENCY_ALERTS.length)];
            this.addMessage('alert', alert);
            this.incrementNotification();
        }

        incrementNotification() {
            this.notificationCount++;
            this.elements.badge.textContent = this.notificationCount;
            this.elements.badge.style.display = 'flex';
            this.elements.avatar.classList.add('has-notification');
            
            // Play notification sound if enabled
            this.playNotificationSound();
        }

        playNotificationSound() {
            // Check if sound is enabled in localStorage
            const soundEnabled = localStorage.getItem('nanoSoundEnabled') !== 'false';
            if (soundEnabled) {
                const audio = new Audio('/sounds/notification.mp3');
                audio.volume = 0.3;
                audio.play().catch(() => {}); // Ignore autoplay errors
            }
        }

        addMessage(type, text) {
            const message = document.createElement('div');
            message.className = `nano-message ${type}`;
            
            const time = new Date().toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' });
            message.innerHTML = `${text}<span class="nano-msg-time">${time}</span>`;
            
            this.elements.messages.appendChild(message);
            this.elements.messages.scrollTop = this.elements.messages.scrollHeight;
        }

        showTyping() {
            const typing = document.createElement('div');
            typing.className = 'nano-typing';
            typing.id = 'nanoTyping';
            typing.innerHTML = '<span></span><span></span><span></span>';
            this.elements.messages.appendChild(typing);
            this.elements.messages.scrollTop = this.elements.messages.scrollHeight;
        }

        hideTyping() {
            const typing = document.getElementById('nanoTyping');
            if (typing) typing.remove();
        }

        sendUserMessage() {
            const text = this.elements.input.value.trim();
            if (!text) return;
            
            this.addMessage('user', text);
            this.elements.input.value = '';
            
            this.showTyping();
            
            // Simulate response
            setTimeout(() => {
                this.hideTyping();
                this.handleUserMessage(text);
            }, 1000);
        }

        handleUserMessage(text) {
            const lowerText = text.toLowerCase();
            let response = '';

            if (lowerText.includes('مرحب') || lowerText.includes('هلا') || lowerText.includes('سلام')) {
                response = 'أهلاً وسهلاً! أنا نانو، مساعدك الذكي في المنصة. كيف يمكنني مساعدتك اليوم؟';
            } else if (lowerText.includes('مساعد') || lowerText.includes('help') || lowerText.includes('?' )) {
                response = 'يمكنني مساعدتك في:\n• شرح آلية عمل أي نظام\n• تقديم نصائح تشغيلية\n• تذكيرك بالإجراءات المهمة\n• الإجابة على استفساراتك العامة';
            } else if (lowerText.includes('بلاغ') || lowerText.includes('تسجيل')) {
                response = 'لتسجيل بلاغ:\n1. اضغط على + أمام الفرقة المطلوبة\n2. سيُسجل البلاغ تلقائياً مع الوقت\n3. يمكنك التراجع بالضغط على "تراجع"';
            } else if (lowerText.includes('تكميل') || lowerText.includes('مناوبة')) {
                response = 'لتكميل المناوبة:\n1. اضغط على "تكميل النوبة"\n2. أدخل بيانات المسعفين والسيارات\n3. حدد حالة كل مركز\n4. اضغط حفظ';
            } else if (lowerText.includes('خريطة') || lowerText.includes('موقع')) {
                response = 'الخريطة تساعدك في تحديد أقرب فرقة للموقع. لاحظ أن النظام يحتاج لتطوير إضافي ليكتمل.';
            } else if (lowerText.includes('إحصائ') || lowerText.includes('تقرير')) {
                response = 'الإحصائيات تُظهر توزيع البلاغات وأنواع الحالات (تصادم، سقوط، حريق...) ويمكن تصديرها كـ CSV.';
            } else if (lowerText.includes('إشعار') || lowerText.includes('تنبيه')) {
                response = 'الإشعارات تظهر فوراً عند حدوث أحداث مهمة. يمكنك تخصيص الصوت من الإعدادات.';
            } else if (lowerText.includes('شكر') || lowerText.includes('تسلم')) {
                response = 'عفواً! سعيد بمساعدتك. لا تتردد في طلب المساعدة في أي وقت. 🚑';
            } else {
                response = 'شكراً لرسالتك! يمكنك سؤالي عن:\n• كيفية تسجيل البلاغات\n• آلية التكميل\n• الإحصائيات والتقارير\n• أو أي استفسار آخر';
            }

            this.addMessage('bot', response);
        }

        showQuickActions() {
            const actions = this.pageConfig.actions || ['عرض المساعدة'];
            this.elements.quickActions.innerHTML = '';
            
            actions.forEach(action => {
                const btn = document.createElement('button');
                btn.className = 'nano-quick-btn';
                btn.textContent = action;
                btn.addEventListener('click', () => {
                    this.handleQuickAction(action);
                });
                this.elements.quickActions.appendChild(btn);
            });
        }

        handleQuickAction(action) {
            let response = '';
            switch(action) {
                case 'تسجيل بلاغ':
                    response = 'انتقل لصفحة تسجيل البلاغات واضغط + أمام الفرقة المطلوبة.';
                    break;
                case 'تكميل النوبة':
                    response = 'اضغط على "تكميل النوبة" وأدخل بيانات القوى العاملة.';
                    break;
                case 'عرض الإحصائيات':
                    response = 'اضغط على "إحصائيات" لعرض الرسوم البيانية والتوزيع.';
                    break;
                case 'رفع ملف':
                    response = 'اسحب الملفات مباشرة إلى منطقة الرفع أو اضغط "اختر ملف".';
                    break;
                case 'حفظ النموذج':
                    response = 'أكمل جميع الحقول المطلوبة ثم اضغط "حفظ".';
                    break;
                default:
                    response = 'سأساعدك في ذلك! هل تحتاج شرحاً أكثر تفصيلاً؟';
            }
            this.addMessage('bot', response);
        }

        connectWebSocket() {
            const wsUrl = (window.location.protocol === 'https:' ? 'wss://' : 'ws://') + window.location.host;
            
            try {
                this.ws = new WebSocket(wsUrl);
                
                this.ws.onopen = () => {
                    console.log('[NANO] WebSocket connected');
                };
                
                this.ws.onmessage = (event) => {
                    try {
                        const data = JSON.parse(event.data);
                        this.handleWebSocketMessage(data);
                    } catch (e) {
                        console.log('[NANO] WS message:', event.data);
                    }
                };
                
                this.ws.onclose = () => {
                    console.log('[NANO] WebSocket disconnected, reconnecting...');
                    setTimeout(() => this.connectWebSocket(), NANO_CONFIG.wsReconnectInterval);
                };
                
                this.ws.onerror = (error) => {
                    console.error('[NANO] WebSocket error:', error);
                };
            } catch (e) {
                console.log('[NANO] WebSocket not available');
            }
        }

        handleWebSocketMessage(data) {
            // Handle notifications from server
            if (data.type === 'notification' || data.type === 'alert') {
                this.addMessage('alert', data.message || 'تنبيه جديد!');
                this.incrementNotification();
            } else if (data.type === 'tip') {
                this.addMessage('tip', data.message);
            } else if (data.type === 'report_added') {
                this.addMessage('bot', `تم تسجيل بلاغ جديد! الفرقة: ${data.team || 'غير محددة'}`);
                this.incrementNotification();
            }
        }

        checkNotifications() {
            // Check for any existing notifications from localStorage or API
            // This is a placeholder for real notification checking
        }
    }

    // Initialize bot when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            window.nanoBot = new NanoBot();
        });
    } else {
        window.nanoBot = new NanoBot();
    }

})();
