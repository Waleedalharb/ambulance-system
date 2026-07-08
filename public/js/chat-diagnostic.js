// ============================================
// Chat Diagnostic Tool — تشغيل في Console المتصفح
// انسخ هذا الكامل والصقه في Console (F12)
// ============================================

(function() {
    'use strict';
    
    console.log('%c🔍 Chat Diagnostic Tool', 'font-size:18px; font-weight:bold; color:#0D9488');
    console.log('==============================================');
    
    var results = { pass: 0, fail: 0, warnings: [] };
    
    function pass(msg) { console.log('%c✅ ' + msg, 'color:green'); results.pass++; }
    function fail(msg) { console.log('%c❌ ' + msg, 'color:red; font-weight:bold'); results.fail++; }
    function warn(msg) { console.log('%c⚠️ ' + msg, 'color:orange'); results.warnings.push(msg); }
    function info(msg) { console.log('%cℹ️ ' + msg, 'color:#3B82F6'); }
    
    // Test 1: WebSocket Connection
    console.log('\n%c[1/8] WebSocket Connection', 'font-weight:bold; color:#1E293B');
    try {
        if (typeof ChatSocket !== 'undefined') {
            if (ChatSocket.connected) {
                pass('WebSocket متصل');
                info('WS readyState: ' + (ChatSocket.ws ? ChatSocket.ws.readyState : 'N/A'));
            } else {
                fail('WebSocket غير متصل!');
                warn('حالة الاتصال: ' + (ChatSocket.ws ? ChatSocket.ws.readyState : 'لا يوجد ws'));
                warn('readyState: 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED');
            }
        } else {
            fail('ChatSocket غير معرف! الصفحة لم تحمل chat.js بشكل صحيح');
        }
    } catch(e) { fail('خطأ في فحص WebSocket: ' + e.message); }
    
    // Test 2: Auth Token
    console.log('\n%c[2/8] Authentication', 'font-weight:bold; color:#1E293B');
    try {
        var token = localStorage.getItem('authToken');
        if (token) {
            pass('Token موجود في localStorage');
            info('Token length: ' + token.length);
        } else {
            fail('لا يوجد authToken! قد يتم إعادة التوجيه');
        }
    } catch(e) { fail('خطأ في فحص Auth: ' + e.message); }
    
    // Test 3: Conversations Loaded
    console.log('\n%c[3/8] Conversations', 'font-weight:bold; color:#1E293B');
    try {
        if (typeof chatState !== 'undefined') {
            var convs = chatState.conversations || [];
            if (convs.length > 0) {
                pass('تم تحميل ' + convs.length + ' محادثة');
                convs.forEach(function(c) {
                    info('  - [' + c.type + '] ' + c.title + ' (id=' + c.id + ', unread=' + (c.unread_count||0) + ')');
                });
            } else {
                warn('لا توجد محادثات محملة');
            }
        } else {
            fail('chatState غير معرف!');
        }
    } catch(e) { fail('خطأ في فحص المحادثات: ' + e.message); }
    
    // Test 4: WebSocket Subscriptions
    console.log('\n%c[4/8] WebSocket Subscriptions', 'font-weight:bold; color:#1E293B');
    try {
        if (ChatSocket.ws) {
            // Try to check subscriptions by sending a test
            info('جاري محاولة الاشتراك في محادثة اختبار...');
            ChatSocket.subscribe(999999); // test subscription
            pass('تم إرسال أمر اشتراك (سيُرجع خطأ من السيرفر إذا لم يكن مشتركاً)');
        } else {
            fail('لا يمكن الاختبار - WebSocket غير متاح');
        }
    } catch(e) { fail('خطأ في فحص الاشتراكات: ' + e.message); }
    
    // Test 5: Notification Permission
    console.log('\n%c[5/8] Browser Notifications', 'font-weight:bold; color:#1E293B');
    try {
        if ('Notification' in window) {
            info('Notification API متوفر');
            info('الحالة الحالية: ' + Notification.permission);
            if (Notification.permission === 'granted') {
                pass('إذن الإشعارات مُمنح');
            } else if (Notification.permission === 'denied') {
                fail('إذن الإشعارات مرفوض! سيتعين تفعيله من إعدادات المتصفح');
            } else {
                warn('إذن الإشعارات: default (لم يُطلب بعد)');
                warn('يمكن طلب الإذن بتشغيل: Notification.requestPermission()');
            }
        } else {
            fail('Notification API غير مدعوم في هذا المتصفح');
        }
    } catch(e) { fail('خطأ في فحص الإشعارات: ' + e.message); }
    
    // Test 6: Audio Support
    console.log('\n%c[6/8] Audio / Sound Notifications', 'font-weight:bold; color:#1E293B');
    try {
        var audio = new Audio();
        if (audio.canPlayType) {
            pass('Audio API متوفر');
            info('canPlayType wav: ' + audio.canPlayType('audio/wav'));
            
            // Test autoplay policy
            var testAudio = new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2/LDciUFLIHO8tiJNwgZaLvt559NEAxQp+PwtmMcBjiR1/LMeSwFJHfH8N2QQAoUXrTp66hVFApGn+DyvmwhBTGH0fPTgjMGHm7A7+OZURE');
            var playPromise = testAudio.play();
            if (playPromise !== undefined) {
                playPromise.then(function() {
                    pass('✅ الصوت يعمل! (تم تفاعل المستخدم)');
                    testAudio.pause();
                }).catch(function(err) {
                    fail('❌ الصوت محظور! ' + err.name + ': ' + err.message);
                    warn('يجب على المستخدم النقر على الصفحة أولاً لتفعيل الصوت');
                });
            }
        } else {
            fail('Audio API غير مدعوم');
        }
    } catch(e) { fail('خطأ في فحص الصوت: ' + e.message); }
    
    // Test 7: Current User
    console.log('\n%c[7/8] Current User', 'font-weight:bold; color:#1E293B');
    try {
        if (chatState.currentUser) {
            pass('المستخدم: ' + (chatState.currentUser.name || chatState.currentUser.username));
            info('User ID: ' + chatState.currentUser.id);
        } else {
            fail('currentUser غير محمل!');
        }
    } catch(e) { fail('خطأ في فحص المستخدم: ' + e.message); }
    
    // Test 8: Service Worker / PWA
    console.log('\n%c[8/8] PWA / Service Worker', 'font-weight:bold; color:#1E293B');
    try {
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.getRegistration().then(function(reg) {
                if (reg) {
                    pass('Service Worker مسجل');
                    info('Scope: ' + reg.scope);
                } else {
                    warn('Service Worker غير مسجل');
                }
            });
        } else {
            warn('Service Worker غير مدعوم');
        }
    } catch(e) { warn('خطأ في فحص SW: ' + e.message); }
    
    // Summary
    setTimeout(function() {
        console.log('\n==============================================');
        console.log('%c📊 النتيجة:', 'font-size:16px; font-weight:bold');
        console.log('%c✅ ناجح: ' + results.pass, 'color:green; font-weight:bold');
        console.log('%c❌ فاشل: ' + results.fail, 'color:red; font-weight:bold');
        if (results.warnings.length > 0) {
            console.log('%c⚠️ تحذيرات: ' + results.warnings.length, 'color:orange; font-weight:bold');
        }
        
        if (results.fail === 0) {
            console.log('%c🎉 كل الفحوصات ناجحة! الإشعارات يجب أن تعمل.', 'font-size:16px; color:green; font-weight:bold');
        } else {
            console.log('%c🔧 يوجد ' + results.fail + ' مشكلة/مشاكل تحتاج إصلاحاً.', 'font-size:16px; color:red; font-weight:bold');
            console.log('\n%cأولوية الإصلاح:', 'font-weight:bold');
            console.log('1. تأكد من أن WebSocket متصل (قد تحتاج تحديث الصفحة)');
            console.log('2. تأكد من تسجيل الدخول (token صالح)');
            console.log('3. انقر على الصفحة مرة واحدة لتفعيل الصوت');
            console.log('4. اسمح بإشعارات المتصفح إذا طُلب');
        }
        
        // Show detailed instructions
        console.log('\n%c🔧 أوامر مفيدة للتشخيص:', 'font-weight:bold; color:#1E293B');
        console.log('  ChatSocket.connected          // هل الـ WS متصل؟');
        console.log('  ChatSocket.ws.readyState      // حالة الاتصال (1=متصل)');
        console.log('  chatState.conversations       // قائمة المحادثات');
        console.log('  chatState.unreadTotal         // عدد غير المقروء');
        console.log('  localStorage.authToken        // التوكن');
        console.log('  Notification.permission       // حالة الإذن');
    }, 500);
    
})();
