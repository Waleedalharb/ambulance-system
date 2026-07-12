// ============================================
// Chat Diagnostic Tool v2 — تشغيل في Console المتصفح
// اختبار شامل لجميع ميزات نظام الدردشة المحدث
// ============================================

(function() {
    'use strict';
    
    console.log('%c🔍 Chat Diagnostic Tool v2', 'font-size:20px; font-weight:bold; color:#0D9488');
    console.log('%cاختبار شامل لنظام الدردشة المحدث', 'font-size:14px; color:#64748B');
    console.log('====================================================');
    
    var results = { pass: 0, fail: 0, warnings: [] };
    
    function pass(msg) { console.log('%c✅ ' + msg, 'color:#10B981; font-weight:600'); results.pass++; }
    function fail(msg) { console.log('%c❌ ' + msg, 'color:#EF4444; font-weight:bold'); results.fail++; }
    function warn(msg) { console.log('%c⚠️ ' + msg, 'color:#F59E0B'); results.warnings.push(msg); }
    function info(msg) { console.log('%cℹ️ ' + msg, 'color:#3B82F6'); }
    function section(msg) { console.log('\n%c' + msg, 'font-weight:bold; font-size:13px; color:#0F172A; background:#F1F5F9; padding:4px 12px; border-radius:6px;'); }
    
    // ========== TEST 1: WebSocket Connection ==========
    section('1️⃣  WebSocket Connection');
    try {
        if (typeof ChatSocket !== 'undefined') {
            if (ChatSocket.connected) {
                pass('WebSocket متصل');
                info('readyState: ' + (ChatSocket.ws ? ChatSocket.ws.readyState : 'N/A') + ' (1=OPEN)');
                info('Reconnect attempts: ' + ChatSocket.reconnectAttempts);
            } else {
                fail('WebSocket غير متصل!');
                warn('حالة الاتصال: ' + (ChatSocket.ws ? ChatSocket.ws.readyState : 'لا يوجد ws'));
                warn('readyState: 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOLOSED');
            }
        } else {
            fail('ChatSocket غير معرف! هل تم تحميل chat.js؟');
        }
    } catch(e) { fail('خطأ في فحص WebSocket: ' + e.message); }
    
    // ========== TEST 2: Authentication ==========
    section('2️⃣  Authentication');
    try {
        var token = localStorage.getItem('authToken');
        if (token) {
            pass('Token موجود في localStorage');
            info('Token length: ' + token.length);
        } else {
            fail('لا يوجد authToken!');
        }
        
        if (typeof chatState !== 'undefined' && chatState.currentUser) {
            pass('المستخدم الحالي محمل: ' + (chatState.currentUser.name || chatState.currentUser.username));
            info('User ID: ' + chatState.currentUser.id);
        } else {
            fail('currentUser غير محمل!');
        }
    } catch(e) { fail('خطأ في فحص Auth: ' + e.message); }
    
    // ========== TEST 3: Conversations ==========
    section('3️⃣  Conversations');
    try {
        if (typeof chatState !== 'undefined') {
            var convs = chatState.conversations || [];
            if (convs.length > 0) {
                pass('تم تحميل ' + convs.length + ' محادثة');
                convs.forEach(function(c) {
                    var onlineStatus = '';
                    if (c.type === 'private') {
                        var other = c.participants.find(function(p) {
                            return p.user_id !== (chatState.currentUser ? chatState.currentUser.id : null);
                        });
                        if (other) {
                            var isOnline = chatState.onlineUsers.includes(other.user_id);
                            onlineStatus = isOnline ? ' 🟢' : ' ⚪';
                        }
                    }
                    info('  - [' + c.type + '] ' + c.title + ' (unread=' + (c.unread_count||0) + ')' + onlineStatus);
                });
            } else {
                warn('لا توجد محادثات محملة');
            }
        } else {
            fail('chatState غير معرف!');
        }
    } catch(e) { fail('خطأ في فحص المحادثات: ' + e.message); }
    
    // ========== TEST 4: WebSocket Subscriptions ==========
    section('4️⃣  WebSocket Subscriptions');
    try {
        if (ChatSocket.ws && ChatSocket.connected) {
            // Try subscribing to test conversation
            ChatSocket.subscribe(999999);
            pass('تم إرسال أمر اشتراك (اختبار)');
            
            // Check how many conversations are subscribed
            if (chatState.conversations) {
                info('المحادثات المحملة: ' + chatState.conversations.length);
                info('يجب أن تكون جميعها مشتركة في WebSocket');
            }
        } else {
            fail('لا يمكن الاختبار - WebSocket غير متصل');
        }
    } catch(e) { fail('خطأ في فحص الاشتراكات: ' + e.message); }
    
    // ========== TEST 5: Toast Notification System ==========
    section('5️⃣  Toast Notification System');
    try {
        // Check if ToastSystem exists in chat.js
        if (typeof ToastSystem !== 'undefined') {
            pass('نظام Toast محمل');
            
            // Check if container exists
            var toastContainer = document.getElementById('chatToastContainer');
            if (toastContainer) {
                pass('حاوية Toast موجودة في DOM');
            } else {
                warn('حاوية Toast غير موجودة - ستُنشأ عند أول رسالة');
            }
            
            // Test showing a toast
            info('جاري اختبار Toast...');
            ToastSystem.show({
                senderName: 'اختبار النظام',
                senderId: 'test',
                conversationId: 999,
                content: 'هذه رسالة اختبار لنظام الإشعارات',
                messageId: 'test-' + Date.now(),
                timestamp: new Date().toISOString()
            });
            pass('تم عرض Toast اختبار (أسفل يسار الشاشة)');
        } else {
            // Check for ChatToast (from chat-toast.js or inline)
            if (typeof ChatToast !== 'undefined') {
                pass('ChatToast module محمل');
                ChatToast.show({
                    senderName: 'اختبار',
                    conversationId: 999,
                    content: 'رسالة اختبار',
                    messageId: 'test',
                    timestamp: new Date().toISOString()
                });
                pass('تم عرض Toast اختبار');
            } else {
                warn('Toast system غير محمل - ستظهر الإشعارات في شريط العنوان فقط');
            }
        }
    } catch(e) { fail('خطأ في فحص Toast: ' + e.message); }
    
    // ========== TEST 6: Sound Notifications ==========
    section('6️⃣  Sound Notifications');
    try {
        // Check Web Audio API
        var AudioContext = window.AudioContext || window.webkitAudioContext;
        if (AudioContext) {
            pass('Web Audio API متوفر');
            
            // Check if audio is unlocked
            info('لاختبار الصوت، انقر على الزر التالي:');
            console.log('%c[ اضغط هنا لاختبار الصوت ]', 'background:#0D9488; color:white; padding:6px 16px; border-radius:8px; cursor:pointer; font-size:12px;');
            
            // Add clickable test
            var testSound = function() {
                try {
                    var ctx = new AudioContext();
                    if (ctx.state === 'suspended') ctx.resume();
                    var now = ctx.currentTime;
                    var osc = ctx.createOscillator();
                    var gain = ctx.createGain();
                    osc.connect(gain);
                    gain.connect(ctx.destination);
                    osc.type = 'sine';
                    osc.frequency.setValueAtTime(830, now);
                    osc.frequency.setValueAtTime(660, now + 0.08);
                    gain.gain.setValueAtTime(0.3, now);
                    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
                    osc.start(now);
                    osc.stop(now + 0.25);
                    console.log('%c🔊 الصوت يعمل!', 'color:#10B981; font-weight:bold');
                } catch(e) {
                    console.log('%c❌ فشل تشغيل الصوت', 'color:#EF4444');
                }
            };
            
            // Make it clickable in console
            window._testChatSound = testSound;
            console.log('أو شغل: %c_testChatSound()', 'color:#3B82F6; font-family:monospace;');
        } else {
            fail('Web Audio API غير مدعوم في هذا المتصفح');
        }
    } catch(e) { fail('خطأ في فحص الصوت: ' + e.message); }
    
    // ========== TEST 7: Browser Notifications ==========
    section('7️⃣  Browser Notifications');
    try {
        if ('Notification' in window) {
            info('Notification API متوفر');
            info('الحالة الحالية: ' + Notification.permission);
            if (Notification.permission === 'granted') {
                pass('إذن الإشعارات مُمنح');
            } else if (Notification.permission === 'denied') {
                fail('إذن الإشعارات مرفوض! فعّله من إعدادات المتصفح');
            } else {
                warn('إذن الإشعارات: default (لم يُطلب بعد)');
                console.log('للطلب: %cNotification.requestPermission()', 'color:#3B82F6; font-family:monospace;');
            }
        } else {
            fail('Notification API غير مدعوم');
        }
    } catch(e) { fail('خطأ في فحص الإشعارات: ' + e.message); }
    
    // ========== TEST 8: Read Receipts ==========
    section('8️⃣  Read Receipts (مؤشرات القراءة)');
    try {
        if (typeof chatState !== 'undefined' && chatState.messages && chatState.messages.length > 0) {
            var lastMsg = chatState.messages[chatState.messages.length - 1];
            if (lastMsg.read_by) {
                pass('مؤشرات القراءة متوفرة في الرسائل');
                info('آخر رسالة - read_by: ' + JSON.stringify(lastMsg.read_by));
            } else {
                warn('لا توجد بيانات قراءة للرسائل (قد تكون الرسالة قديمة)');
            }
            
            // Check visual indicators exist
            var readStatusEl = document.querySelector('.message-read-status');
            if (readStatusEl) {
                pass('عناصر مؤشر القراءة مرئية في DOM');
                var classes = readStatusEl.className;
                if (classes.indexOf('sent') !== -1) info('الحالة: ✓ تم الإرسال');
                else if (classes.indexOf('delivered') !== -1) info('الحالة: ✓✓ تم التسليم');
                else if (classes.indexOf('read') !== -1) info('الحالة: ✓✓ تم القراءة');
            } else {
                warn('لا توجد مؤشرات قراءة مرئية (افتح محادثة أولاً)');
            }
        } else {
            warn('لا توجد رسائل محملة لاختبار مؤشرات القراءة');
        }
    } catch(e) { fail('خطأ في فحص مؤشرات القراءة: ' + e.message); }
    
    // ========== TEST 9: Online Status ==========
    section('9️⃣  Online Status (حالة الاتصال)');
    try {
        if (typeof chatState !== 'undefined') {
            var onlineCount = (chatState.onlineUsers || []).length;
            pass('المستخدمون المتصلون: ' + onlineCount);
            
            if (chatState.onlineUsers && chatState.onlineUsers.length > 0) {
                info('المتصلون: ' + chatState.onlineUsers.join(', '));
            }
            
            // Check avatar status dots
            var statusDots = document.querySelectorAll('.avatar-status.online');
            if (statusDots.length > 0) {
                pass('مؤشرات المتصلين مرئية في قائمة المحادثات: ' + statusDots.length);
            } else {
                info('لا توجد مؤشرات متصلين مرئية حالياً');
            }
            
            // Check if other users show online correctly
            if (ChatSocket && ChatSocket.connected) {
                info('WebSocket يرسل حالة presence كل 30 ثانية');
            }
        } else {
            fail('chatState غير معرف');
        }
    } catch(e) { fail('خطأ في فحص حالة الاتصال: ' + e.message); }
    
    // ========== TEST 10: Cross-Tab Communication ==========
    section('🔟  Cross-Tab Communication');
    try {
        if (typeof BroadcastChannel !== 'undefined') {
            pass('BroadcastChannel مدعوم');
        } else {
            warn('BroadcastChannel غير مدعوم - fallback إلى localStorage events');
        }
        
        // Test sending a message
        try {
            if (typeof BroadcastChannel !== 'undefined') {
                var bc = new BroadcastChannel('chat_sync');
                bc.postMessage({ type: 'test', data: 'diagnostic' });
                bc.close();
                pass('تم إرسال رسالة اختبار بين الألسنة');
            }
        } catch(e) {
            warn('فشل اختبار BroadcastChannel');
        }
    } catch(e) { fail('خطأ في فحص الاتصال بين الألسنة: ' + e.message); }
    
    // ========== TEST 11: Message Delivery Simulation ==========
    section('1️⃣1️⃣  Message Delivery Test');
    try {
        if (ChatSocket && ChatSocket.connected) {
            pass('WebSocket جاهز لاستقبال الرسائل');
            
            info('لاختبار استقبال رسالة فورية:');
            info('1. افتح نافذة متصفح أخرى (وضع التصفح المتخفي)');
            info('2. سجل دخول بحساب مختلف');
            info('3. أرسل رسالة من الحساب الثاني إلى هذا الحساب');
            info('4. يجب أن تظهر الرسالة فوراً بدون تحديث');
            
            // Check message handler
            if (ChatSocket.messageCallbacks && ChatSocket.messageCallbacks.length > 0) {
                pass('معالج الرسائل مسجل (' + ChatSocket.messageCallbacks.length + ' callback)');
            } else {
                warn('لا يوجد معالج مسجل للرسائل الواردة');
            }
        } else {
            fail('WebSocket غير متصل - لن تصل الرسائل فورياً');
        }
    } catch(e) { fail('خطأ في فحص توصيل الرسائل: ' + e.message); }
    
    // ========== TEST 12: Settings Persistence ==========
    section('1️⃣2️⃣  Settings Persistence');
    try {
        var soundSettings = localStorage.getItem('chat_sound_settings');
        if (soundSettings) {
            var parsed = JSON.parse(soundSettings);
            pass('إعدادات الصوت محفوظة: ' + (parsed.enabled !== false ? 'مفعل' : 'معطل'));
        } else {
            info('لم يتم حفظ إعدادات الصوت بعد (الافتراضي: مفعل)');
        }
        
        var toastSettings = localStorage.getItem('chatToastSettings');
        if (toastSettings) {
            pass('إعدادات Toast محفوظة');
        }
    } catch(e) { warn('خطأ في فحص الإعدادات: ' + e.message); }
    
    // ========== SUMMARY ==========
    setTimeout(function() {
        console.log('\n====================================================');
        console.log('%c📊 ملخص نتائج الفحص:', 'font-size:16px; font-weight:bold');
        console.log('%c✅ ناجح: ' + results.pass, 'color:#10B981; font-weight:bold');
        console.log('%c❌ فاشل: ' + results.fail, 'color:#EF4444; font-weight:bold');
        if (results.warnings.length > 0) {
            console.log('%c⚠️ تحذيرات: ' + results.warnings.length, 'color:#F59E0B; font-weight:bold');
        }
        
        if (results.fail === 0) {
            console.log('%c🎉 جميع الفحوصات ناجحة! النظام يعمل بشكل صحيح.', 'font-size:15px; color:#10B981; font-weight:bold');
        } else {
            console.log('%c🔧 يوجد ' + results.fail + ' مشكلة/مشاكل تحتاج إصلاحاً.', 'font-size:15px; color:#EF4444; font-weight:bold');
            console.log('\n%cأولوية الإصلاح:', 'font-weight:bold');
            console.log('1. تأكد من أن WebSocket متصل');
            console.log('2. تأكد من تسجيل الدخول (token صالح)');
            console.log('3. انقر على الصفحة مرة واحدة لتفعيل الصوت');
            console.log('4. اسمح بإشعارات المتصفح إذا طُلب');
        }
        
        // Show useful commands
        console.log('\n%c🔧 أوامر مفيدة للتشخيص:', 'font-weight:bold; color:#0F172A; background:#F1F5F9; padding:4px 12px; border-radius:6px;');
        console.log('  ChatSocket.connected             // هل الـ WS متصل؟');
        console.log('  ChatSocket.ws.readyState         // حالة الاتصال (1=متصل)');
        console.log('  chatState.conversations          // قائمة المحادثات');
        console.log('  chatState.onlineUsers            // المستخدمون المتصلون');
        console.log('  chatState.unreadTotal            // عدد غير المقروء');
        console.log('  chatState.messages               // الرسائل الحالية');
        console.log('  localStorage.authToken           // التوكن');
        console.log('  Notification.permission          // حالة إذن الإشعارات');
        console.log('  _testChatSound()                 // اختبار صوت الإشعار');
        console.log('  ToastSystem.show({...})          // اختبار Toast يدوياً');
        console.log('\n%c🧪 اختبار متعدد المستخدمين:', 'font-weight:bold; color:#0F172A;');
        console.log('  1. افتح chat.html في تبويبين مختلفين');
        console.log('  2. سجل دخول بحسابين مختلفين');
        console.log('  3. افتح نفس المحادثة في التبويبين');
        console.log('  4. أرسل رسالة من حساب - يجب أن تظهر فوراً في الحساب الآخر');
        console.log('  5. شاهد مؤشرات القراءة تتحدث لحظياً');
    }, 500);
})();