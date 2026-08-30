// ============================================
// نظام المستخدمين والمصادقة
// ============================================
var currentUser = null;
// auth state managed by AuthManager — always get fresh token

// ============================================
// إدارة المناوبات (Shift Management)
// Phase 2+3: Fetched from server API, NOT localStorage
// ============================================
var currentShiftId = null;
var currentShiftStatus = null;  // 'active' | 'pending_handover' | 'archived' | 'none'

// ── Fetch active shift from server on load ──
// OV-S5: التخزين المحلي cache غير موثوق — المصدر الوحيد للحقيقة هو الخادم.
// يُكتب localStorage.currentShiftId فقط بعد تأكيد الخادم، ويُمسح فوراً عند
// تأكيد «لا مناوبة نشطة» أو اختلاف المعرّف.
// D-28: رقم تسلسلي للطلبات — ردّ متأخر من استدعاء أقدم لا يُطبَّق أبداً
// (كان رد «لا مناوبة» القديم يمسح الـ cache بعد أن كتبته مناوبة بدأت للتو).
var loadCurrentShiftSeq = 0;
async function loadCurrentShift() {
    var mySeq = ++loadCurrentShiftSeq;
    try {
        const token = localStorage.getItem('auth_access_token') || localStorage.getItem('authToken');
        const res = await fetch('/api/current-shift', {
            headers: token ? { 'Authorization': 'Bearer ' + token } : {}
        });
        const data = await res.json();
        // D-28: تجاهل أي رد وصل بعد بدء طلب أحدث — الأحدث وحده يكتب الحالة
        if (mySeq !== loadCurrentShiftSeq) {
            console.log('[Shift] D-28: stale response ignored (seq ' + mySeq + ' < ' + loadCurrentShiftSeq + ')');
            return;
        }
        if (data.success && data.shift && data.shift.id) {
            currentShiftId = data.shift.id;
            currentShiftStatus = data.shift.status || 'active';
            // كتابة بعد تأكيد الخادم فقط — تُصحّح أي معرّف بائت أو مختلف في الـ cache
            try { localStorage.setItem('currentShiftId', String(currentShiftId)); } catch(e) {}
            console.log('[Shift] Loaded from server:', currentShiftId, 'status:', currentShiftStatus);
        } else if (data.success) {
            // Server confirmed: no active shift — honest empty state
            currentShiftId = null;
            currentShiftStatus = 'none';
            // الخادم أكّد عدم وجود مناوبة نشطة ⇒ مسح الـ cache البائت فوراً
            try { localStorage.removeItem('currentShiftId'); } catch(e) {}
        }
        // OV-S3-03: button/display always re-rendered from the state variable
        if (typeof updateShiftStatus === 'function') updateShiftStatus();
    } catch (e) {
        // OV-S3-03: network failure must NOT destroy the last known truth —
        // keep previous state instead of nulling it into a false "no shift"
        console.error('[Shift] Failed to load current shift (keeping last known state):', e);
    }
}
// AuthGate: لا جلب تشغيلي قبل المصادقة — التشغيل الفوري عند start والتكرار عبر البوابة
AuthGate.onStart(function() { loadCurrentShift(); });
AuthGate.setInterval(loadCurrentShift, 60000); // Refresh every minute
var allShifts = [];
var isViewingArchiveShift = false;
var currentViewingShift = null;
var viewingShiftId = null;
var currentViewingShiftData = null;

function getCurrentUserName() {
    return (currentUser && currentUser.name) || (currentUser && currentUser.username) || 'غير معروف';
}

// سجل إجراءات الـToast — يُملأ عند الإنشاء ويُستدعى من onclick
var TOAST_ACTIONS = {};
var TOAST_ACTION_SEQ = 0;
function toastActionRun(key) {
    var fn = TOAST_ACTIONS[key];
    if (fn) { try { fn(); } catch (e) {} }
}

// (شكل التنبيه الجديد — اعتماد المالك 2026-08-28): الـToast السفلي يبقى في
// مكانه ووظيفته؛ تغيّر الشكل فقط. كل تنبيه: وسم نوع + أيقونة + عنوان + وصف +
// وقت + إجراء مرتبط (إن وُجدت وجهة آمنة في هذه الصفحة) + إغلاق يدوي.
// التوقيع لم يتغير (title, message, type, duration) — كل المواضع القائمة تعمل.
function showNotification(title, message, type, duration) {
    var container = document.getElementById('toastContainer');
    if (!container) { console.log('[' + type + '] ' + title + ': ' + message); return; }
    // تطبيع النوع: danger/urgent/error → error، alert → warning
    var t = String(type || 'info');
    if (t === 'danger' || t === 'urgent') t = 'error';
    if (t === 'alert') t = 'warning';
    if (['success', 'error', 'warning', 'info'].indexOf(t) < 0) t = 'info';
    var esc = (typeof nc2Esc === 'function') ? nc2Esc : function (v) { return (v === null || v === undefined) ? '' : String(v); };
    title = (title === null || title === undefined) ? '' : String(title);
    message = (message === null || message === undefined) ? '' : String(message);
    // النوع التشغيلي من النص — بنفسجي=بلاغ، برتقالي=مستشفى، أخضر=تكميل، أزرق=حالة
    var src = (typeof notifSourceOf === 'function') ? notifSourceOf({ title: title, message: message }) : 'النظام';
    var kindMap = {
        'البلاغات':   { cls: 'tk-report',     icon: 'fa-file-medical-alt', label: 'بلاغ جديد' },
        'المستشفيات': { cls: 'tk-hospital',   icon: 'fa-hospital',         label: 'تنبيه مستشفى' },
        'التكميل':    { cls: 'tk-completion', icon: 'fa-users',            label: 'تحديث تكميل' },
        'سير العمل':  { cls: 'tk-status',     icon: 'fa-sync-alt',         label: 'تحديث حالة' },
        'المناوبات':  { cls: 'tk-status',     icon: 'fa-sync-alt',         label: 'تحديث حالة' },
        'المركبات':   { cls: 'tk-status',     icon: 'fa-sync-alt',         label: 'تحديث حالة' },
        'التمركزات':  { cls: 'tk-status',     icon: 'fa-map-marker-alt',   label: 'تحديث تمركز' }
    };
    var kind = kindMap[src] || null;
    var typeIcon = { success: 'fa-check-circle', error: 'fa-times-circle', warning: 'fa-exclamation-triangle', info: 'fa-info-circle' }[t];
    var kindLabel = kind ? kind.label : { success: 'تم بنجاح', error: 'تنبيه مهم', warning: 'تنبيه تشغيلي', info: 'تنبيه تشغيلي' }[t];
    // الإجراء المرتبط — فقط إن كانت دوال الوجهة موجودة فعلًا في هذه الصفحة
    var actionsHtml = '';
    if (kind && typeof notifActionFor === 'function') {
        var act = notifActionFor(src);
        if (act) {
            var depsOk = true;
            if (src === 'البلاغات') depsOk = (typeof openModalById === 'function') && (typeof renderAdvancedDistribution === 'function');
            else if (src === 'التمركزات') depsOk = !!document.querySelector('.ops-map-section');
            else depsOk = (typeof navigateToPage === 'function');
            if (depsOk) {
                var key = 'ta' + (++TOAST_ACTION_SEQ);
                TOAST_ACTIONS[key] = act.run;
                actionsHtml = '<div class="toast-actions"><button class="toast-action-btn primary" onclick="toastActionRun(\'' + key + '\')"><i class="fas fa-external-link-alt"></i>' + act.label + '</button></div>';
            }
        }
    }
    var toast = document.createElement('div');
    toast.className = 'toast-notification ' + t + (kind ? ' ' + kind.cls : '');
    toast.innerHTML = '<div class="toast-icon"><i class="fas ' + (kind ? kind.icon : typeIcon) + '"></i></div>' +
        '<div class="toast-body">' +
            '<div class="toast-head"><span class="toast-kind">' + kindLabel + '</span><span class="toast-time">الآن</span></div>' +
            '<div class="toast-title">' + (esc(title) || 'تنبيه') + '</div>' +
            (message ? '<div class="toast-message">' + esc(message) + '</div>' : '') +
            actionsHtml +
        '</div>' +
        '<button class="toast-close" title="إغلاق"><i class="fas fa-times"></i></button>';
    toast.querySelector('.toast-close').addEventListener('click', function () {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
    });
    container.appendChild(toast);
    // الحرج/التحذيري يبقى أطول (8ث)، والمعلوماتي يختفي سريعًا — وكلها تبقى في مركز الإشعارات
    var ttl = duration || ((t === 'error' || t === 'warning') ? 8000 : 4000);
    setTimeout(function() { toast.classList.add('toast-exit'); setTimeout(function() { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 300); }, ttl);
    if (t === 'success' && typeof playSuccessSound === 'function') playSuccessSound();
    else if (t === 'error' && typeof playErrorSound === 'function') playErrorSound();
    else if (typeof playAlertSound === 'function') playAlertSound();
}
// ============================================
// Online Status System — Real-time connection status
// ============================================
var onlineUsersList = [];

function updateConnectionStatusUI(isConnected) {
    var el = document.getElementById('connectionStatus');
    var dot = document.getElementById('statusDot');
    var text = document.getElementById('statusText');
    if (!el) return;
    if (isConnected) {
        if (dot) dot.style.background = '#10B981';
        if (text) text.textContent = 'متصل';
        el.title = 'متصل بالسيرفر';
    } else {
        if (dot) dot.style.background = '#EF4444';
        if (text) text.textContent = 'غير متصل';
        el.title = 'انقطع الاتصال بالسيرفر';
    }
}

function updateOnlineUsersUI(users) {
    onlineUsersList = users || [];
    // Update any UI elements that show online users count
    var onlineCountEls = document.querySelectorAll('.online-users-count');
    onlineCountEls.forEach(function(el) {
        el.textContent = onlineUsersList.length;
    });
}

function updateUserStatusIndicator(userId, isOnline) {
    // Update status dot for a specific user in chat/user lists
    var dots = document.querySelectorAll('[data-user-status="' + userId + '"]');
    dots.forEach(function(dot) {
        dot.style.background = isOnline ? '#10B981' : '#9CA3AF';
        dot.title = isOnline ? 'متصل' : 'غير متصل';
    });
}

function isUserOnline(userId) {
    return onlineUsersList.some(function(u) { return u.id == userId; });
}

// Global skeleton loading helpers (used inside and outside DOMContentLoaded)
function showSkeleton() {
    var sk = document.getElementById('skeletonScreen');
    if (sk) sk.style.display = 'flex';
}
function hideSkeleton() {
    var sk = document.getElementById('skeletonScreen');
    if (sk) sk.style.display = 'none';
}

// ============================================
// نظام تسجيل الدخول (من inline.js)
// ============================================
document.addEventListener('DOMContentLoaded', function() {
    if (typeof AuthManager !== 'undefined') {
        AuthManager.init();
    }
    var loginScreen = document.getElementById('loginScreen');
    var loginBtn = document.getElementById('loginBtn');
    var loginUsername = document.getElementById('loginUsername');
    var loginPassword = document.getElementById('loginPassword');
    var loginError = document.getElementById('loginError');
    var logoutBtn = document.getElementById('logoutBtn');
    var userDisplay = document.getElementById('userDisplay');

    function showLogin() {
        if (loginScreen) loginScreen.style.display = 'flex';
        document.body.style.overflow = 'hidden';
    }
    function hideLogin() {
        if (loginScreen) loginScreen.style.display = 'none';
        document.body.style.overflow = '';
    }

    async function doLogin() {
        var username = loginUsername.value.trim();
        var password = loginPassword.value.trim();
        if (!username || !password) {
            loginError.textContent = 'الرجاء إدخال اسم المستخدم وكلمة المرور';
            loginError.style.display = 'block';
            return;
        }
        try {
            var data = await AuthManager.login(username, password);
            currentUser = data.user;
            hideLogin();
            applyUserPermissions(data.user);
            if (userDisplay) userDisplay.textContent = (data.user.name || 'مستخدم') + ' (' + roleLabel(data.user.role) + ')';
            AuthGate.start(); // الإقلاع التشغيلي الموحّد (loadAllData + loadNotifications + SSE + المؤقتات) عبر البوابة
            addAuditEntry('system', 'تسجيل دخول', 'المستخدم ' + (data.user.name || data.user.username || 'غير معروف') + ' سجل الدخول إلى النظام', getCurrentUserName());
        } catch (e) {
            loginError.textContent = e.message || 'فشل في تسجيل الدخول';
            loginError.style.display = 'block';
        }
    }

    function doLogout() {
        addAuditEntry('system', 'تسجيل خروج', 'المستخدم ' + getCurrentUserName() + ' سجل الخروج من النظام', getCurrentUserName());
        AuthManager.logout();
    }

    if (loginBtn) loginBtn.addEventListener('click', doLogin);
    if (logoutBtn) logoutBtn.addEventListener('click', doLogout);

    if (loginPassword) {
        loginPassword.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') doLogin();
        });
    }

    if (AuthManager.isLoggedIn()) {
        showSkeleton();
        var user = AuthManager.getUser();
        if (user) {
            currentUser = user;
            hideLogin();
            applyUserPermissions(user);
            if (userDisplay) userDisplay.textContent = (user.name || 'مستخدم') + ' (' + roleLabel(user.role) + ')';
            AuthGate.start(); // جلسة صالحة عند تحميل الصفحة — الإقلاع التشغيلي عبر البوابة
        } else {
            hideSkeleton();
            showLogin();
        }
    } else {
        // If currentUser exists but authToken is missing, clear inconsistent state
        if (localStorage.getItem('currentUser')) {
            localStorage.removeItem('currentUser');
            currentUser = null;
        }
        showLogin();
    }
    
    // Update shift status immediately based on time (don't wait for server)
    updateShiftStatus();
});


// ============================================
// دوال الوقت السعودي (Asia/Riyadh)
// أغلفة رقيقة — كل التحويل مفوَّض للطبقة المركزية /js/time-riyadh.js (window.TimeRiyadh)
// ============================================
var saudiFormatter = { format: function(v) { return TimeRiyadh.formatDate(v); } };
var saudiTimeFormatter = { format: function(v) { return TimeRiyadh.formatTimeSec(v); } };
var saudiFullFormatter = { format: function(v) { return TimeRiyadh.formatDateTimeSec(v); } };
var saudiDayFormatter = { format: function(v) { return TimeRiyadh.formatDayName(v); } };
var sauditMonthYearFormatter = { format: function(v) { return TimeRiyadh.formatMonthYear(v); } };

function getSaudiDate() {
    return TimeRiyadh.formatDate(new Date());
}
function getSaudiTime() {
    return TimeRiyadh.formatTimeSec(new Date());
}
function getSaudiDateTime() {
    return TimeRiyadh.formatDateTimeSec(new Date());
}
// قيمة حقول datetime-local بالتوقيت الجداري للرياض (YYYY-MM-DDTHH:MM) —
// تفويض «المرحلة الأخيرة قبل الاعتماد الرسمي» (2026-08): توحيد التوقيت؛ كانت
// toISOString().slice(0,16) (جدارية UTC — ٣ ساعات فرق) تُخزَّن كأنها توقيت الرياض.
function getRiyadhLocalInputValue(d) {
    var p = TimeRiyadh.riyadhParts(d || new Date());
    return p.year + '-' + p.month + '-' + p.day + 'T' + p.hour + ':' + p.minute;
}
function getSaudiDay() {
    return saudiDayFormatter.format(new Date());
}
function getSaudiMonthYear() {
    return sauditMonthYearFormatter.format(new Date());
}

// ============================================
// نظام النوبة التلقائي (Auto-Shift)
// المنطق نفسه — مكوّنات الوقت من TimeRiyadh.riyadhParts (بلا إزاحة يدوية +3)
// ============================================
function getCurrentShiftType() {
    const p = TimeRiyadh.riyadhParts(new Date());
    const hour = parseInt(p.hour, 10);
    // صباح: 05:00 - 17:00 | ليل: 17:00 - 05:00
    return (hour >= 5 && hour < 17) ? 'صباح' : 'ليل';
}

function getCurrentShiftDate() {
    const p = TimeRiyadh.riyadhParts(new Date());
    const hour = parseInt(p.hour, 10);

    // تاريخ محلي مؤقت لمجرد حساب «اليوم السابق» — لا يُعرض ولا يُحوَّل
    let shiftDate = new Date(parseInt(p.year, 10), parseInt(p.month, 10) - 1, parseInt(p.day, 10));

    // Night shift runs from 17:00 to 05:00 next day
    // If time is between 00:00 and 05:00, we are in the night shift that started yesterday
    if (hour >= 0 && hour < 5) {
        shiftDate.setDate(shiftDate.getDate() - 1);
    }

    const shiftYear = shiftDate.getFullYear();
    const shiftMonth = (shiftDate.getMonth() + 1).toString().padStart(2, '0');
    const shiftDay = shiftDate.getDate().toString().padStart(2, '0');
    return `${shiftYear}-${shiftMonth}-${shiftDay}`;
}


// ============================================
// نظام الأصوات التفاعلية
// ============================================

var soundSettings = JSON.parse(localStorage.getItem('soundSettings') || '{"master": false, "click": true, "alert": true, "success": true}');

function initSoundSettings() {
    var masterToggle = document.getElementById('soundMasterToggle');
    var clickToggle = document.getElementById('soundClickToggle');
    var alertToggle = document.getElementById('soundAlertToggle');
    var successToggle = document.getElementById('soundSuccessToggle');
    if (masterToggle) masterToggle.checked = soundSettings.master;
    if (clickToggle) clickToggle.checked = soundSettings.click;
    if (alertToggle) alertToggle.checked = soundSettings.alert;
    if (successToggle) successToggle.checked = soundSettings.success;
    updateSoundIcon();
}

function toggleSoundMaster(el) {
    soundSettings.master = el.checked;
    saveSoundSettings();
    updateSoundIcon();
    if (soundSettings.master) {
        playClickSound();
        if (typeof showNotification === 'function') {
            showNotification('الأصوات', 'تم تفعيل الأصوات', 'success', 2000);
        }
    }
}

function saveSoundSettings() {
    localStorage.setItem('soundSettings', JSON.stringify(soundSettings));
}

function updateSoundIcon() {
    var icon = document.getElementById('soundIcon');
    if (!icon) return;
    icon.className = soundSettings.master ? 'fas fa-volume-up' : 'fas fa-volume-mute';
}

// أصوات باستخدام Web Audio API
function playClickSound() {
    if (!soundSettings.master || !soundSettings.click) return;
    try {
        var audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        var oscillator = audioCtx.createOscillator();
        var gainNode = audioCtx.createGain();
        oscillator.connect(gainNode);
        gainNode.connect(audioCtx.destination);
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(800, audioCtx.currentTime);
        oscillator.frequency.exponentialRampToValueAtTime(1200, audioCtx.currentTime + 0.05);
        gainNode.gain.setValueAtTime(0.1, audioCtx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.1);
        oscillator.start(audioCtx.currentTime);
        oscillator.stop(audioCtx.currentTime + 0.1);
    } catch(e) {}
}

function playAlertSound() {
    if (!soundSettings.master || !soundSettings.alert) return;
    try {
        var audioCtx = new (window.AudioContext || window.webkitAudioContext)();

        // نغمة تنبيه مزدوجة
        var osc1 = audioCtx.createOscillator();
        var osc2 = audioCtx.createOscillator();
        var gain = audioCtx.createGain();

        osc1.connect(gain);
        osc2.connect(gain);
        gain.connect(audioCtx.destination);

        osc1.type = 'sine';
        osc2.type = 'sine';
        osc1.frequency.setValueAtTime(880, audioCtx.currentTime);
        osc1.frequency.setValueAtTime(1100, audioCtx.currentTime + 0.15);
        osc2.frequency.setValueAtTime(660, audioCtx.currentTime);
        osc2.frequency.setValueAtTime(880, audioCtx.currentTime + 0.15);

        gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
        gain.gain.setValueAtTime(0.15, audioCtx.currentTime + 0.15);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.35);

        osc1.start(audioCtx.currentTime);
        osc2.start(audioCtx.currentTime);
        osc1.stop(audioCtx.currentTime + 0.35);
        osc2.stop(audioCtx.currentTime + 0.35);
    } catch(e) {}
}

function playSuccessSound() {
    if (!soundSettings.master || !soundSettings.success) return;
    try {
        var audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        var osc = audioCtx.createOscillator();
        var gain = audioCtx.createGain();
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.type = 'sine';

        // نغمة نجاح تصاعدية
        var now = audioCtx.currentTime;
        osc.frequency.setValueAtTime(523, now);       // C5
        osc.frequency.setValueAtTime(659, now + 0.1); // E5
        osc.frequency.setValueAtTime(784, now + 0.2); // G5
        osc.frequency.setValueAtTime(1047, now + 0.3); // C6

        gain.gain.setValueAtTime(0.15, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.5);

        osc.start(now);
        osc.stop(now + 0.5);
    } catch(e) {}
}

function playErrorSound() {
    if (!soundSettings.master) return;
    try {
        var audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        var osc = audioCtx.createOscillator();
        var gain = audioCtx.createGain();
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(200, audioCtx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(100, audioCtx.currentTime + 0.3);
        gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.3);
        osc.start(audioCtx.currentTime);
        osc.stop(audioCtx.currentTime + 0.3);
    } catch(e) {}
}

// ربط الأصوات بالأحداث
document.addEventListener('DOMContentLoaded', function() {
    var soundSettingsBtn = document.getElementById('soundSettingsBtn');
    if (soundSettingsBtn) {
        soundSettingsBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            var panel = document.getElementById('soundSettingsPanel');
            if (panel) {
                panel.classList.toggle('active');
            }
            playClickSound();
        });
    }

    // إغلاق panel عند النقر خارجها
    document.addEventListener('click', function(e) {
        var panel = document.getElementById('soundSettingsPanel');
        var btn = document.getElementById('soundSettingsBtn');
        if (panel && !panel.contains(e.target) && btn && !btn.contains(e.target)) {
            panel.classList.remove('active');
        }
    });

    // إضافة أصوات على الأزرار
    document.querySelectorAll('.btn, .click-sound').forEach(function(btn) {
        btn.addEventListener('click', playClickSound);
    });
    // ربط أصوات النجاح والخطأ بالإشعارات — تم إزالة الـ override لتجنب الدائرة مع showToast
    // الصوت الآن مُضاف في showNotification الأصلية
});

// ============================================
// PWA - Service Worker Registration (تعطيل مؤقت لتجنب Caching)
// ============================================
// ⭐ إلغاء تسجيل أي Service Worker قديم + حذف Cache
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(function(regs) {
        regs.forEach(function(reg) { reg.unregister(); console.log('SW unregistered'); });
    });
    if ('caches' in window) {
        caches.keys().then(function(names) {
            names.forEach(function(name) { caches.delete(name); console.log('Cache deleted:', name); });
        });
    }
}
// لتفعيل SW لاحقاً:
/*
if ('serviceWorker' in navigator) {
    window.addEventListener('load', function() {
        navigator.serviceWorker.register('/sw.js').then(function(registration) {
            console.log('Service Worker registered:', registration.scope);
        }).catch(function(error) {
            console.log('Service Worker failed:', error);
        });
    });
}
*/

// ============================================
// PWA - Push Notifications
// ============================================
function requestPushNotification() {
    if (!('Notification' in window)) {
        showNotification('غير مدعوم', 'المتصفح لا يدعم الإشعارات', 'warning', 3000);
        return;
    }

    Notification.requestPermission().then(function(permission) {
        if (permission === 'granted') {
            showNotification('تم التفعيل', 'الإشعارات الفورية مفعلة', 'success', 3000);
            // إشعار ترحيبي
            new Notification('منصة الجنوب', {
                body: 'مرحباً! الإشعارات مفعلة بنجاح',
                icon: '/favicon.ico'
            });
        } else {
            showNotification('تم الرفض', 'لم يتم منح إذن الإشعارات', 'warning', 3000);
        }
    });
}

// اختبار إشعار
function testPushNotification(title, body) {
    if (Notification.permission === 'granted') {
        new Notification(title || 'منصة الجنوب', {
            body: body || 'هذا إشعار تجريبي',
            icon: '/favicon.ico',
            badge: '/favicon.ico',
            tag: 'janoub-' + Date.now()
        });
    }
}

// ============================================
// SSE + Polling - تحديث فوري ومستقر
// ============================================
var sseSource = null;
var sseConnected = false;
var wsFallbackInterval = null; // اسم متغير للتوافق مع الكود القديم

function connectSSE() {
    try {
        var token = AuthManager.getToken();
        if (!token) {
            console.log('🔴 SSE: no token, using polling only');
            startFallbackInterval();
            return;
        }
        var sseUrl = AuthManager.getSSEUrl('/api/sse');
        
        // Close existing connection if any
        if (sseSource) {
            try { sseSource.close(); } catch(e) {}
        }
        
        sseSource = new EventSource(sseUrl);
        
        sseSource.onopen = function() {
            sseConnected = true;
            console.log('✅ SSE connected');
            // إيقاف fallback عند الاتصال الناجح
            if (wsFallbackInterval) {
                clearInterval(wsFallbackInterval);
                wsFallbackInterval = null;
                console.log('🛑 Fallback polling stopped - SSE active');
            }
            // دورة حياة الخريطة من مصدر الحالة (اعتماد المالك 2026-08-25): عند كل
            // اتصال ناجح — وأهمها إعادة الاتصال بعد انقطاع — نعيد جلب ملخص البلاغات
            // كاملًا من الخادم، فأي إغلاق/إلغاء فُوِّت أثناء الانقطاع يُصحَّح فورًا
            // من مصدر الحقيقة بدل انتظار أول حدث جديد صدفةً
            if (typeof fetchIncidentSummarySafe === 'function') fetchIncidentSummarySafe();
        };
        
        sseSource.onmessage = function(event) {
            try {
                var data = JSON.parse(event.data);
                console.log('📡 SSE received:', data.type);
                handleSSEEvent(data);
            } catch(e) {
                console.error('SSE parse error:', e);
            }
        };
        
        sseSource.onerror = function(err) {
            sseConnected = false;
            // إيقاف نهائي: رفض الخادم الاتصال (401/403 ⇒ readyState=CLOSED) — بلا عاصفة إعادة اتصال
            if (sseSource && sseSource.readyState === EventSource.CLOSED) {
                console.log('🔴 SSE: connection refused (auth failure) — terminal halt, no reconnect');
                try { sseSource.close(); } catch(e) {}
                sseSource = null;
                return; // بوابة المصادقة تعيد التطبيق لحالة anonymous عبر مسار 401 في AuthManager
            }
            // لا إعادة اتصال خارج حالة المصادقة
            if (typeof AuthGate !== 'undefined' && !AuthGate.isAuthenticated()) return;
            console.log('❌ SSE error, reconnecting...');
            // Close and reconnect manually after delay
            setTimeout(function() {
                if (typeof AuthGate !== 'undefined' && !AuthGate.isAuthenticated()) return;
                if (sseSource) {
                    try { sseSource.close(); } catch(e) {}
                }
                connectSSE();
            }, 3000);
        };
    } catch(e) {
        console.log('SSE not supported, using polling');
        startFallbackInterval();
    }
}

// AuthGate: فكّ اتصال SSE والاستطلاع الاحتياطي عند الخروج/انتهاء الجلسة
AuthGate.onStop(function() {
    if (sseSource) {
        try { sseSource.close(); } catch(e) {}
        sseSource = null;
    }
    sseConnected = false;
    if (wsFallbackInterval) {
        clearInterval(wsFallbackInterval);
        wsFallbackInterval = null;
    }
});

// Reconnect SSE on token refresh
AuthManager.onAuthEvent(function(event, data) {
    if (event === 'refresh') {
        if (typeof AuthGate !== 'undefined' && !AuthGate.isAuthenticated()) return; // لا اتصال خارج البوابة
        console.log('Token refreshed, reconnecting SSE...');
        connectSSE();
    }
});

function handleSSEEvent(data) {
    // OV-S6: بعد إزالة websocket-sync.js من index.html أصبحت هذه القناة (SSE) هي
    // الناقل الوحيد للأحداث التشغيلية على الصفحة الرئيسية. الفروع أدناه تغطي
    // بالضبط الأنواع التي كانت تستهلكها الصفحة عبر websocket-sync (أي أن
    // معالجاتها معرّفة فعلاً في app.js) وتستدعي نفس المعالجات الموجودة.
    // Phase D (خطاف عام معتمد): بثّ كل حدث SSE كـ CustomEvent 'ops:sse' على document — قناة الاشتراك الصريحة للوحات العرض. فشله لا يؤثر على الـ switch أدناه.
    try { document.dispatchEvent(new CustomEvent('ops:sse', { detail: data })); } catch(e) {}
    switch(data.type) {
        case 'new_report':
            showNotification('بلاغ جديد', data.message, 'info', 5000);
            refreshReports();
            refreshIncidentMapFromServer(); // طبقة البلاغات على الخريطة — فوري عبر نفس القناة
            break;
        case 'report_undone':
            refreshReports();
            refreshIncidentMapFromServer();
            break;
        case 'theme_updated':
            showNotification('تم التحديث', 'تم تحديث الثيم من قبل مشرف آخر', 'info', 3000);
            applyGlobalTheme();
            break;
        case 'theme_removed':
            applyGlobalTheme();
            break;
        case 'shift_archived':
            // OV-S5: الأرشفة تُبث لحظياً — التقارب الفوري بدل انتظار استطلاع الـ 60ث
            showNotification('أرشفة مناوبة', data.message || 'تمت أرشفة المناوبة', 'info', 5000);
            loadCurrentShift();
            break;
        case 'shift_started':
            // OV-S5: بدء مناوبة جديدة (من أي عميل) — جلب الحقيقة من الخادم فوراً
            loadCurrentShift();
            loadShifts();
            loadAllData();
            refreshIncidentMapFromServer(); // خريطة المناوبة الجديدة (تصفير صادق إن لا بلاغات)
            break;
        case 'shift_updated':
        case 'shift_deleted':
            loadShifts();
            loadAllData();
            break;
        case 'vacations_updated':
        case 'vacations_cleared':
            loadVacations();
            renderControlList(false);
            break;
        case 'air_ambulance_saved':
        case 'air_ambulance_deleted':
        case 'air_ambulance_cleared':
            loadAirRecords();
            break;
        case 'peak_mission_added':
        case 'peak_alert_resolved':
        case 'peak_mission_deleted':
            checkForAlerts();
            loadPeakPlans();
            break;
        case 'peak_plan_added':
        case 'peak_plan_updated':
        case 'peak_plan_deleted':
            loadPeakPlans();
            checkForAlerts();
            break;
        case 'doc_uploaded':
        case 'doc_deleted':
            loadDocsData();
            break;
        case 'ops_files_uploaded':
        case 'ops_file_deleted':
            opsLoadData();
            break;
        case 'monthly_table_uploaded':
        case 'monthly_table_deleted':
            loadSavedTable(true);
            break;
        case 'report_entry_added':
        case 'report_entry_deleted':
        case 'report_entry_cleared':
            loadAllData();
            break;
        case 'incident_added':
        case 'incident_deleted':
            loadIncidentRecords();
            loadAllData();
            break;
        case 'senior_shift_added':
        case 'senior_shift_deleted':
            loadSeniorShifts();
            loadAllData();
            break;
        case 'e_case_added':
        case 'e_case_deleted':
            loadERecords();
            loadAllData();
            break;
        case 'escalation_added':
        case 'escalation_deleted':
            loadEscalationRecords();
            loadAllData();
            break;
        case 'daily_report_added':
        case 'daily_report_deleted':
            loadDailyRecords();
            loadAllData();
            break;
        case 'shift_absence_added':
        case 'shift_absence_deleted':
            loadAbsenceRecords();
            break;
        // SR-1: القوى البشرية/المركبات — أي حدث في السجل الرسمي يُعيد جلب
        // المؤشرات من /api/staffing/state (المصدر الوحيد). لا حساب محلي.
        case 'staffing_events_updated':
        case 'completion_updated':
        case 'team_status_changed':
        case 'vehicles_updated':
        case 'roster_synced': // SR-2: مزامنة الجدولة ← القاعدة
            refreshWorkforceFromServer(data.shiftId);
            break;
        case 'timeline_updated':
        case 'announcements_updated':
        case 'announcement_deleted':
            // المنطقة 3: تحديث شريط الأحداث النشطة فورًا من نفس القناة
            refreshEventsAux();
            break;
        case 'shift_note_added':
        case 'shift_note_deleted':
            loadShiftNotes();
            break;
        case 'audit_log_added':
            renderAuditLog();
            break;
        case 'notification_created':
        case 'notification_new':
            // D-21: إشعار موجه وصل عبر SSE — تحديث جرس الإشعارات فوراً
            // بدل انتظار إعادة التحميل (كان النوعان بلا معالج إطلاقاً)
            loadNotifications();
            // OV-S4-03: ربط حدث الإشعار الفعلي بالصوت عبر showNotification —
            // كانت هذه الأحداث تصل صامتة تماماً (لا toast ولا صوت) رغم
            // soundSettings.master. الصوت يمر عبر دوال play* التي تحترم
            // master/toggles، فلا صوت إلا بموافقة المستخدم.
            var _n = data.notification || data.payload || {};
            // النوع الحقيقي يصل مع الحمولة (danger/warning/success/info) —
            // كان يُرمى ويُعرض info دائمًا (تشخيص جولة شكل التنبيه 2026-08-28)
            showNotification(_n.title || 'إشعار جديد', _n.message || data.message || '', _n.type || 'info', 0);
            break;
        case 'connected':
            console.log('SSE:', data.message);
            break;
    }
    // توازن الإشعارات مع سلوك websocket-sync السابق: أي حدث يحمل message
    // كان يُظهر Toast عاماً (showNotification fallback) — باستثناء الأنواع
    // التي لها إشعارها الخاص أعلاه حتى لا يتضاعف الإشعار.
    if (data.message && data.type !== 'new_report' && data.type !== 'theme_updated' && data.type !== 'shift_archived' && data.type !== 'connected') {
        showNotification('تحديث', data.message, 'info', 3000);
    }
}

function refreshReports() {
    loadAllData();
}

// الخريطة التشغيلية الذكية: تحديث طبقة البلاغات فور وصول الأحداث عبر قناة SSE
// الموجودة (تشخيص المالك 2026-08-20: الطبقة كانت بلا فرع تحديث ولا ترسم إلا
// كأثر جانبي لفتح أقسام أخرى). debounced بنمط refreshWorkforceFromServer
// حتى دفعة أحداث بلاغ واحد متعدد الفرق تولّد جلبًا واحدًا — لا polling إطلاقًا.
var _smapRefreshTimer = null;
function refreshIncidentMapFromServer() {
    if (_smapRefreshTimer) clearTimeout(_smapRefreshTimer);
    _smapRefreshTimer = setTimeout(function () {
        _smapRefreshTimer = null;
        fetchIncidentSummarySafe(); // تجلب /api/cad-reports ثم renderSmartMap داخليًا
    }, 400);
}

// ============================================
// Fallback - تحديث دوري لو SSE غير متوفر
// ============================================
function startFallbackInterval() {
    if (wsFallbackInterval) return;
    console.log('⏱️ Starting fallback polling (3s)');
    wsFallbackInterval = setInterval(function() {
        if (!sseConnected) {
            console.log('🔄 Fallback: refreshing data...');
            loadAllData();
            applyGlobalTheme();
            // دورة حياة الخريطة من مصدر الحالة (اعتماد المالك 2026-08-25): بلا SSE
            // لا تصل أحداث الإغلاق/الإلغاء إطلاقًا — الوضع الاحتياطي يجلب ملخص
            // البلاغات من الخادم مع كل دورة حتى يختفي المنتهي من الخريطة ولا
            // تبقى علامته عالقة (الجلب خفيف ومشروط بانقطاع القناة فقط)
            if (typeof fetchIncidentSummarySafe === 'function') fetchIncidentSummarySafe();
        }
    }, 3000);
}

// ============================================
// تحميل الشعار المخصص
// ============================================
function loadBrandLogo() {
    try {
        var savedLogo = localStorage.getItem('brandLogo') || sessionStorage.getItem('brandLogo');
        if (savedLogo) {
            var img = document.getElementById('brandLogoImage');
            var svg = document.getElementById('defaultLogo');
            if (img && svg) {
                img.src = savedLogo;
                img.style.display = 'block';
                img.style.width = '100%';
                img.style.height = '100%';
                img.style.objectFit = 'contain';
                img.style.borderRadius = '4px';
                svg.style.display = 'none';
                console.log('✅ تم تحميل الشعار المخصص');
            }
        }
    } catch(e) { console.log('⚠️ لم يتم تحميل الشعار المخصص'); }
}

// ============================================
// نظام الثيمات
// ============================================
function applyHeaderBackground(dataUrl, fileType) {
    var header = document.getElementById('mainHeader');
    if (!header) return;
    header.style.backgroundImage = 'none';
    header.style.backgroundColor = '#1E3A5F';
    header.classList.remove('has-bg-image');
    var oldVideo = header.querySelector('.header-bg-video');
    if (oldVideo) oldVideo.remove();
    if (fileType && fileType.startsWith('video/')) {
        var video = document.createElement('video');
        video.className = 'header-bg-video';
        video.src = dataUrl;
        video.autoplay = true;
        video.loop = true;
        video.muted = true;
        video.playsInline = true;
        video.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: cover; z-index: 0; opacity: 0.4;';
        header.prepend(video);
        video.load();
        video.play().catch(() => {});
        header.style.background = 'none';
    } else if (dataUrl) {
        header.style.backgroundImage = 'url(' + dataUrl + ')';
        header.style.backgroundSize = 'cover';
        header.style.backgroundPosition = 'center';
        header.style.backgroundRepeat = 'no-repeat';
        header.classList.add('has-bg-image');
    }
}

var el_headerBgFile=document.getElementById("headerBgFile");if(el_headerBgFile)el_headerBgFile.addEventListener('change', function(e) {
    var file = e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function(event) {
        var dataUrl = event.target.result;
        localStorage.setItem('headerBackground', dataUrl);
        localStorage.setItem('headerBgType', file.type);
        applyHeaderBackground(dataUrl, file.type);
        var previewDiv = document.getElementById('headerBgPreview');
        previewDiv.style.display = 'block';
        if (file.type.startsWith('video/')) {
            var video = document.getElementById('headerBgPreviewVideo');
            var img = document.getElementById('headerBgPreviewImg');
            img.style.display = 'none';
            video.style.display = 'block';
            video.src = dataUrl;
            video.load();
        } else {
            var img = document.getElementById('headerBgPreviewImg');
            var video = document.getElementById('headerBgPreviewVideo');
            video.style.display = 'none';
            img.style.display = 'block';
            img.src = dataUrl;
        }
        alert('✅ تم رفع خلفية الشريط العلوي بنجاح!');
    };
    reader.readAsDataURL(file);
});

function removeHeaderBg() {
    localStorage.removeItem('headerBackground');
    localStorage.removeItem('headerBgType');
    var header = document.getElementById('mainHeader');
    if (header) {
        header.style.backgroundImage = '';
        header.style.background = '';
        header.style.backgroundColor = '';
        header.classList.remove('has-bg-image');
        var video = header.querySelector('.header-bg-video');
        if (video) video.remove();
    }
    var el_headerBgPreview_d1 = document.getElementById('headerBgPreview'); if (el_headerBgPreview_d1) el_headerBgPreview_d1.style.display = 'none';
    alert('✅ تم إزالة خلفية الشريط');
}

function applySectorLogo(dataUrl) {
    var logoImg = document.getElementById('sectorLogoImage');
    if (!logoImg) return;
    if (dataUrl) {
        logoImg.src = dataUrl;
        logoImg.style.display = 'block';
        logoImg.style.width = '100%';
        logoImg.style.height = '100%';
        logoImg.style.objectFit = 'contain';
        logoImg.style.borderRadius = '4px';
        var svg = document.getElementById('defaultLogo');
        if (svg) svg.style.display = 'none';
        var defaultImg = document.getElementById('brandLogoImage');
        if (defaultImg) defaultImg.style.display = 'none';
    } else {
        logoImg.style.display = 'none';
        logoImg.src = '';
        var svg = document.getElementById('defaultLogo');
        if (svg) svg.style.display = 'block';
    }
}

var el_sectorLogoFile=document.getElementById("sectorLogoFile");if(el_sectorLogoFile)el_sectorLogoFile.addEventListener('change', function(e) {
    var file = e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function(event) {
        var dataUrl = event.target.result;
        localStorage.setItem('sectorLogo', dataUrl);
        applySectorLogo(dataUrl);
        var previewDiv = document.getElementById('sectorLogoPreview');
        previewDiv.style.display = 'block';
        document.getElementById('sectorLogoPreviewImg').src = dataUrl;
        alert('✅ تم رفع شعار القطاع بنجاح!');
    };
    reader.readAsDataURL(file);
});

async function removeSectorLogo() {
    if (!confirm('⚠️ هل أنت متأكد من إزالة شعار القطاع؟')) return;

    // حذف من السيرفر أولاً
    try {
        var response = await AuthManager.apiRequest('/api/remove-theme', { method: 'DELETE' });
        var result = await response.json();
        if (result.success) {
            console.log('✅ تم حذف الشعار من السيرفر');
        }
    } catch (err) {
        console.log('⚠️ فشل حذف الشعار من السيرفر');
    }

    // حذف من localStorage
    localStorage.removeItem('sectorLogo');
    applySectorLogo(null);
    var el_sectorLogoPreview_d2 = document.getElementById('sectorLogoPreview'); if (el_sectorLogoPreview_d2) el_sectorLogoPreview_d2.style.display = 'none';
    alert('✅ تم إزالة شعار القطاع');
}




// ============================================
// لوحة التحكم المتقدمة (Analytics Dashboard)
// ============================================

var el_analyticsBtn=document.getElementById("analyticsBtn");if(el_analyticsBtn)el_analyticsBtn.addEventListener('click', function() {
    openModalById('analyticsModal');
    renderAnalyticsDashboard();
});

function renderAnalyticsDashboard() {
    renderKPIs();
    renderHeatmap();
    renderPeakPrediction();
}

function renderKPIs() {
    var container = document.getElementById('analyticsKPIs');
    if (!container) return;
    
    var totalReports = 0;
    var activeUnits = 0;
    var topUnit = '-';
    var topCount = 0;
    
    for (var key in reports) {
        var count = (reports[key] && reports[key].count) || 0;
        totalReports += count;
        if (count > 0) activeUnits++;
        if (count > topCount) {
            topCount = count;
            topUnit = key.split('|')[1] || key;
        }
    }
    
    var avgPerUnit = activeUnits > 0 ? (totalReports / activeUnits).toFixed(1) : 0;
    
    var kpis = [
        { icon: '&#x1F4CA;', value: totalReports, label: 'إجمالي البلاغات', trend: '&#x25B2; نشط' },
        { icon: '&#x1F691;', value: activeUnits, label: 'فرق نشطة', trend: 'من ' + Object.keys(centersData).length + ' مركز' },
        { icon: '&#x1F3C6;', value: topUnit, label: 'الأكثر نشاطاً', trend: topCount + ' بلاغ' },
        { icon: '&#x1F4C8;', value: avgPerUnit, label: 'متوسط البلاغات', trend: 'لكل فرقة' }
    ];
    
    var html = '';
    for (var i = 0; i < kpis.length; i++) {
        var kpi = kpis[i];
        html += 
            '<div class="kpi-card">' +
                '<div class="kpi-icon">' + kpi.icon + '</div>' +
                '<div class="kpi-value">' + kpi.value + '</div>' +
                '<div class="kpi-label">' + kpi.label + '</div>' +
                '<div class="kpi-trend">' + kpi.trend + '</div>' +
            '</div>';
    }
    container.innerHTML = html;
}

function renderHeatmap() {
    var grid = document.getElementById('heatmapGrid');
    if (!grid) return;
    grid.innerHTML = '';

    var colors = ['rgba(255,255,255,0.04)', 'rgba(16,181,134,0.18)', 'rgba(16,181,134,0.30)', 'rgba(16,181,134,0.42)', 'rgba(16,181,134,0.55)', 'rgba(16,181,134,0.70)', 'rgba(245,158,11,0.55)', 'rgba(245,158,11,0.75)', 'rgba(239,68,68,0.65)', 'rgba(239,68,68,0.85)'];

    // F5b: هيستوغرام ساعي حقيقي من مرآة بلاغات المناوبة الجارية (reports[key].times — نفس تجميع getPeakHour)
    var hourCounts = new Array(24).fill(0);
    var maxCount = 0;
    for (var key in reports) {
        var r = reports[key];
        if (r && r.times) {
            for (var i = 0; i < r.times.length; i++) {
                // ساعة الرياض (كانت getHours بمنطقة الجهاز — تزيح الحقول خارج السعودية)
                var hp = TimeRiyadh.riyadhParts(r.times[i]);
                var h = hp ? parseInt(hp.hour, 10) : NaN;
                if (!isNaN(h)) {
                    hourCounts[h]++;
                    if (hourCounts[h] > maxCount) maxCount = hourCounts[h];
                }
            }
        }
    }

    for (var hour = 0; hour < 24; hour++) {
        var cell = document.createElement('div');
        cell.className = 'heatmap-cell';
        cell.setAttribute('data-hour', hour + ':00');
        cell.title = hour + ':00 — ' + hourCounts[hour] + ' بلاغ';

        // 0 بلاغ ← الفهرس 0؛ وإلا تدرج نسبي 1..9 من الأعلى (maxCount)
        var intensity = hourCounts[hour] === 0 ? 0 : Math.min(9, 1 + Math.floor((hourCounts[hour] / maxCount) * 8));
        cell.style.background = colors[intensity] || colors[0];

        grid.appendChild(cell);
    }
}

function renderPeakPrediction() {
    var container = document.getElementById('peakPrediction');
    if (!container) return;
    
    var now = new Date();
    // ساعة الرياض الجدارية (كانت getHours بمنطقة الجهاز — توقّع ذروة خاطئ خارج السعودية)
    var hour = parseInt(TimeRiyadh.riyadhParts(now).hour, 10);
    var predictedPeak = (hour >= 16 && hour <= 22) ? 'الآن (وقت الذروة!)' : 
                        (hour >= 10 && hour < 16) ? 'متوقع: 4 مساءً' : 'متوقع: 8 مساءً';
    
    var riskLevel = (hour >= 16 && hour <= 22) ? '&#x1F534; عالية' : 
                    (hour >= 10 && hour < 16) ? '&#x1F7E1; متوسطة' : '&#x1F7E2; منخفضة';
    
    var riskColor = (hour >= 16 && hour <= 22) ? '#EF4444' :
                    (hour >= 10 && hour < 16) ? '#F59E0B' : '#10B981';
    
    container.innerHTML = 
        '<div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap:15px;">' +
            '<div style="text-align:center; padding:15px; background:white; border-radius:8px;">' +
                '<div style="font-size:0.7rem; color:var(--gray-600); margin-bottom:5px;">&#x23F0; توقع الذروة القادمة</div>' +
                '<div style="font-size:1.2rem; font-weight:700; color:var(--primary-700);">' + predictedPeak + '</div>' +
            '</div>' +
            '<div style="text-align:center; padding:15px; background:white; border-radius:8px;">' +
                '<div style="font-size:0.7rem; color:var(--gray-600); margin-bottom:5px;">&#x26A0;️ مستوى الخطورة</div>' +
                '<div style="font-size:1.2rem; font-weight:700; color:' + riskColor + ';">' + riskLevel + '</div>' +
            '</div>' +
            '<div style="text-align:center; padding:15px; background:white; border-radius:8px;">' +
                '<div style="font-size:0.7rem; color:var(--gray-600); margin-bottom:5px;">&#x1F691; فرق التدخل السريع</div>' +
                '<div style="font-size:1.2rem; font-weight:700; color:var(--teal);">مطلوبة</div>' +
            '</div>' +
        '</div>';
}

function refreshAnalytics() {
    renderAnalyticsDashboard();
    showNotification('تم التحديث', 'تم تحديث لوحة التحكم بنجاح', 'success', 2000);
}

// ============================================
// سجل العمليات (Audit Log)
// ============================================

var auditLog = [];  // Phase 1: Fetched from server API, not localStorage
var currentAuditFilter = 'all';

var el_auditLogBtn=document.getElementById("auditLogBtn");if(el_auditLogBtn)el_auditLogBtn.addEventListener('click', function() {
    openModalById('auditLogModal');
    renderAuditLog();
});

function addAuditEntry(type, action, detail, user) {
    var entry = {
        id: Date.now().toString(),
        type: type || 'system',
        action: action || '',
        detail: detail || '',
        user: user || getCurrentUserName(),
        timestamp: new Date().toISOString(),
        shift_id: currentShiftId || null
    };

    auditLog.unshift(entry);
    if (auditLog.length > 200) auditLog = auditLog.slice(0, 200);

    // Phase 1: Audit log saved to server, not localStorage

    // Fire-and-forget server-side logging
    try {
        if (AuthManager.isLoggedIn()) {
            AuthManager.apiRequest('/api/audit-log', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(entry)
            }).catch(function() {});
        }
    } catch(e) {}
}

function renderAuditLog() {
    var container = document.getElementById('auditLogContainer');
    if (!container) return;

    var filtered = currentAuditFilter === 'all' ? auditLog : auditLog.filter(function(e) {
        return e.type === currentAuditFilter;
    });

    if (filtered.length === 0) {
        container.innerHTML = '<div class="audit-empty">&#x1F4ED; لا توجد سجلات ' + (currentAuditFilter !== 'all' ? 'في هذا القسم' : 'بعد') + '</div>';
        return;
    }

    var icons = {
        report: '&#x1F4CA;',
        shift: '&#x1F4CB;',
        theme: '&#x1F3A8;',
        file: '&#x1F4C1;',
        alert: '&#x1F514;',
        system: '&#x2699;&#xFE0F;'
    };

    var html = '';
    for (var i = 0; i < filtered.length; i++) {
        var entry = filtered[i];
        var date = new Date(entry.timestamp);
        var timeStr = saudiTimeFormatter.format(date);
        var typeLabels = {
            report: 'بلاغ', shift: 'مناوبة', theme: 'تصميم',
            file: 'ملف', alert: 'تنبيه', system: 'نظام'
        };
        var typeLabel = typeLabels[entry.type] || 'نظام';
        var typeColors = {
            report: '#EF4444', shift: '#3B82F6', theme: '#8B5CF6',
            file: '#F59E0B', alert: '#10B981', system: '#6B7280'
        };
        var color = typeColors[entry.type] || '#6B7280';

        html +=
            '<div class="audit-card" style="display:flex; align-items:center; gap:12px; padding:12px 16px; border-radius:10px; border:1px solid var(--gray-200); background:var(--white); margin-bottom:8px; transition:all 0.2s;">' +
                '<div style="width:40px; height:40px; border-radius:10px; background:' + color + '15; display:flex; align-items:center; justify-content:center; font-size:1.2rem; flex-shrink:0; color:' + color + ';">' + 
                    (icons[entry.type] || '&#x2699;&#xFE0F;') + 
                '</div>' +
                '<div style="flex:1; min-width:0; text-align:right;">' +
                    '<div style="font-size:0.9rem; font-weight:600; color:var(--gray-800); margin-bottom:2px;">' + entry.action + '</div>' +
                    '<div style="font-size:0.8rem; color:var(--gray-500); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' + (entry.detail || '') + '</div>' +
                '</div>' +
                '<div style="text-align:left; flex-shrink:0; min-width:100px;">' +
                    '<div style="font-size:0.75rem; color:var(--gray-400); margin-bottom:2px;">' + timeStr + '</div>' +
                    '<div style="display:flex; align-items:center; gap:4px;">' +
                        '<div style="font-size:0.7rem; color:' + color + '; background:' + color + '15; padding:2px 8px; border-radius:6px; display:inline-block; font-weight:500;">' + typeLabel + '</div>' +
                        '<div style="font-size:0.7rem; color:var(--gray-400); background:var(--gray-100); padding:2px 8px; border-radius:6px; display:inline-block;">' + (entry.user || 'غير معروف') + '</div>' +
                    '</div>' +
                '</div>' +
            '</div>';
    }

    container.innerHTML = html;
}

function filterAuditLog(type, btn) {
    currentAuditFilter = type;
    document.querySelectorAll('.audit-filter-btn').forEach(function(b) {
        b.classList.remove('active');
    });
    btn.classList.add('active');
    renderAuditLog();
}

function clearAuditLog() {
    if (!confirm('&#x26A0;&#xFE0F; هل أنت متأكد من مسح جميع السجلات؟')) return;
    auditLog = [];
    // Phase 1: Audit log cleared from server
    renderAuditLog();
    showNotification('تم المسح', 'تم مسح سجل العمليات بنجاح', 'success', 2000);
}

function openAuditLogModal() {
    openModalById('auditLogModal');
    renderAuditLog();
}

function closeAuditLogModal() {
    closeModalById('auditLogModal');
}

function refreshAuditLog() {
    auditLog = [];  // Phase 1: Will be populated from server
    renderAuditLog();
}

function exportAuditLog() {
    var csv = 'الوقت,النوع,الإجراء,التفاصيل,المستخدم\n';
    for (var i = 0; i < auditLog.length; i++) {
        var e = auditLog[i];
        csv += e.timestamp + ',' + e.type + ',' + (e.action || '') + ',' + (e.detail || '') + ',' + (e.user || '') + '\n';
    }

    var blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    var link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'سجل_العمليات_' + getSaudiDate() /* تاريخ الرياض لاسم الملف (كان UTC) */ + '.csv';
    link.click();

    showNotification('تم التصدير', 'تم تصدير سجل العمليات بنجاح', 'success', 3000);
}

// تسجيل أحداث تلقائية
function setupAutoAuditLogging() {
    // تسجيل فتح المناوبة
    var origStartNewShift = startNewShift;
    if (typeof startNewShift === 'function') {
        startNewShift = function() {
            var result = origStartNewShift.apply(this, arguments);
            addAuditEntry('shift', 'بدء مناوبة جديدة', '', getCurrentUserName());
            return result;
        };
    }

    // تسجيل البلاغات
    var origAddReport = addReportToServer;
    if (typeof addReportToServer === 'function') {
        addReportToServer = function(center, unit) {
            var result = origAddReport.apply(this, arguments);
            addAuditEntry('report', 'تسجيل بلاغ', center + ' - ' + unit, getCurrentUserName());
            return result;
        };
    }

    // تسجيل رفع الملفات التشغيلية
    var origOpsUploadFiles = opsUploadFiles;
    if (typeof opsUploadFiles === 'function') {
        opsUploadFiles = async function() {
            var result = await origOpsUploadFiles.apply(this, arguments);
            addAuditEntry('file', 'رفع ملفات تشغيلية', 'تم رفع ملفات إلى التحديثات التشغيلية', getCurrentUserName());
            return result;
        };
    }

    // تسجيل فتح صفحة المستندات
    var origOpenDocsPage = openDocsPage;
    if (typeof openDocsPage === 'function') {
        openDocsPage = function() {
            addAuditEntry('system', 'فتح صفحة المستندات', 'المستخدم فتح صفحة التحديثات والمستندات', getCurrentUserName());
            return origOpenDocsPage.apply(this, arguments);
        };
    }

    // تسجيل فتح غرفة العمليات
    var origOpenOperationsRoom = openOperationsRoom;
    if (typeof openOperationsRoom === 'function') {
        openOperationsRoom = function() {
            addAuditEntry('system', 'فتح غرفة العمليات', 'المستخدم فتح غرفة العمليات', getCurrentUserName());
            return origOpenOperationsRoom.apply(this, arguments);
        };
    }

    // تسجيل فتح وقت الذروة
    var origOpenPeakTimeModal = openPeakTimeModal;
    if (typeof openPeakTimeModal === 'function') {
        openPeakTimeModal = function() {
            addAuditEntry('system', 'فتح وقت الذروة', 'المستخدم فتح نافذة وقت الذروة', getCurrentUserName());
            return origOpenPeakTimeModal.apply(this, arguments);
        };
    }

    // تسجيل فتح نافذة المناوبة
    var origOpenShiftModal = openShiftModal;
    if (typeof openShiftModal === 'function') {
        openShiftModal = function() {
            addAuditEntry('system', 'فتح نافذة المناوبة', 'المستخدم فتح نافذة المناوبة', getCurrentUserName());
            return origOpenShiftModal.apply(this, arguments);
        };
    }

    // تسجيل فتح أرشيف المناوبات
    var origOpenShiftArchiveModal = openShiftArchiveModal;
    if (typeof openShiftArchiveModal === 'function') {
        openShiftArchiveModal = function() {
            addAuditEntry('system', 'فتح أرشيف المناوبات', 'المستخدم فتح أرشيف المناوبات', getCurrentUserName());
            return origOpenShiftArchiveModal.apply(this, arguments);
        };
    }

    // تسجيل فتح سجل العمليات
    var origOpenAuditLogModal = openAuditLogModal;
    if (typeof openAuditLogModal === 'function') {
        openAuditLogModal = function() {
            addAuditEntry('system', 'فتح سجل العمليات', 'المستخدم فتح سجل العمليات', getCurrentUserName());
            return origOpenAuditLogModal.apply(this, arguments);
        };
    }

    // تسجيل فتح الجدول الشهري
    var monthlyTableBtn = document.getElementById('monthlyTableBtn');
    if (monthlyTableBtn) {
        monthlyTableBtn.addEventListener('click', function() {
            addAuditEntry('system', 'فتح الجدول الشهري', 'المستخدم فتح الجدول الشهري', getCurrentUserName());
        });
    }

    // تسجيل فتح لوحة التحكم
    var controlBtn = document.getElementById('controlBtn');
    if (controlBtn) {
        controlBtn.addEventListener('click', function() {
            addAuditEntry('system', 'فتح لوحة التحكم', 'المستخدم فتح لوحة التحكم والتنسيق', getCurrentUserName());
        });
    }

    // تسجيل تلقائي عند فتح الخريطة
    var mapBtn = document.getElementById('mapBtn');
    if (mapBtn) {
        mapBtn.addEventListener('click', function() {
            addAuditEntry('system', 'فتح الخريطة', 'المستخدم فتح الخريطة', getCurrentUserName());
        });
    }
}

// ============================================
// نظام التنبيهات
// ============================================
function showMainAlert(title, message) {
    var alertBar = document.getElementById('alertBar');
    var alertTitle = document.getElementById('alertTitle');
    var alertMessage = document.getElementById('alertMessage');
    if (alertBar && alertTitle && alertMessage) {
        alertTitle.textContent = title || 'تنبيه جديد';
        alertMessage.textContent = message || 'يوجد تنبيه جديد في نظام وقت الذروة';
        alertBar.style.display = 'block';
        try {
            var audio = new Audio('data:audio/wav;base64,UklGRnoAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoAAACBhYqNlZuZn52hoaOko6SjpKGfnZiWkJGMi4mGg4B9ent5d3V0dHJwcXBwcnN0dXZ3eHp7fH5/gIGChIWHiYqLjI2Oj5CRkpOUlZaXmJmam5ydnp+goaKjpKWmp6ipqqusra6vsLGys7S1tre4ubq7vL2+v8DBwsPExcbHyMnKy8zNzs/Q0dLT1NXW19jZ2tvc3d7f4OHi4+Tl5ufo6err7O3u7/Dx8vP09fb3+Pn6+/z9/v8=');
            audio.play().catch(() => {});
        } catch(e) {}
    }
}

function dismissAlert() {
    var el_alertBar_d5 = document.getElementById('alertBar'); if (el_alertBar_d5) el_alertBar_d5.style.display = 'none';
    localStorage.setItem('alertDismissed', 'true');
}

// ============================================
// نظام الإشعارات — التصميم ④ المعتمد (2026-08-28)
// شريط تشغيلي بالـTopbar + مركز إشعارات (غير مقروء/مقروء/الكل).
// عرض فقط فوق GET /api/notifications — لا تغيير بيانات ولا مخطط.
// الأولوية تُشتق من type، والمصدر من عنوان/نص الإشعار (اشتقاق عرض حرفي).
// ============================================
var notifications = [];
var unreadNotificationsCount = 0;
var notificationActiveTab = 'unread';
var notifStripDismissedId = null;   // آخر إشعار أخفاه المستخدم من الشريط يدويًا
var notifStripTimer = null;         // مؤقّت الإخفاء التلقائي للإشعارات المعلوماتية

// تهريب HTML — صفر undefined/null ولا حقن (متطلب التصميم ④)
function nc2Esc(v) {
    if (v === null || v === undefined) return '';
    return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// وقت نسبي واعي بـUTC (created_at يُخزَّن UTC بنمط naive) — getTimeAgo القديم
// كان يحلّله كتوقيت محلي فيزيحه 3 ساعات؛ هنا نفس تطبيع TimeRiyadh.
function notifTimeAgo(v) {
    if (!v) return '—';
    var s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(s)) s = s.replace(' ', 'T') + 'Z';
    else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(s)) s += 'Z';
    var past = new Date(s);
    if (isNaN(past.getTime())) return '—';
    var diff = Math.floor((Date.now() - past.getTime()) / 1000);
    if (diff < 0) diff = 0;
    if (diff < 60) return 'الآن';
    if (diff < 3600) return 'منذ ' + Math.floor(diff / 60) + ' د';
    if (diff < 86400) return 'منذ ' + Math.floor(diff / 3600) + ' س';
    return 'منذ ' + Math.floor(diff / 86400) + ' يوم';
}

// الأولوية من النوع: الأحمر=يتطلب إجراء، الأصفر=مراقبة، الأخضر=معلومات/طبيعي
function notifPriorityOf(typeKey) {
    if (typeKey === 'danger')  return { key: 'danger',  label: 'يتطلب إجراء' };
    if (typeKey === 'warning') return { key: 'warning', label: 'مراقبة' };
    if (typeKey === 'success') return { key: 'success', label: 'طبيعي' };
    return { key: 'info', label: 'معلومات' };
}

// اشتقاق مصدر الحدث من العنوان/الرسالة (عرض فقط — لا بيانات جديدة)
function notifSourceOf(n) {
    var text = ((n.title || '') + ' ' + (n.message || ''));
    if (/بلاغ/.test(text)) return 'البلاغات';
    if (/تمركز/.test(text)) return 'التمركزات';
    if (/مستشفى|منشأة/.test(text)) return 'المستشفيات';
    if (/مركبة/.test(text)) return 'المركبات';
    if (/سير العمل|اعتماد/.test(text)) return 'سير العمل';
    if (/تكميل/.test(text)) return 'التكميل';
    if (/جدول|مناوبة/.test(text)) return 'المناوبات';
    if (/مستند|ملف/.test(text)) return 'الملفات';
    if (/دخول/.test(text)) return 'الدخول';
    if (/دعم/.test(text)) return 'الدعم';
    return 'النظام';
}

// الإجراء المرتبط بالمصدر (فتح الوجهة المناسبة) — null إن لا وجهة آمنة
function notifActionFor(source) {
    var map = {
        'البلاغات':   { label: 'فتح التوزيع',  run: function () { openModalById('distributionModal'); renderAdvancedDistribution(); } },
        'التمركزات':  { label: 'الخريطة',      run: function () { var m = document.querySelector('.ops-map-section'); if (m) m.scrollIntoView({ behavior: 'smooth', block: 'start' }); } },
        'التكميل':    { label: 'فتح التكميل',  run: function () { navigateToPage('radio-completion.html?v=41'); } },
        'سير العمل':  { label: 'فتح الجداول',  run: function () { navigateToPage('smart-schedule.html?v=41'); } },
        'المناوبات':  { label: 'سجل المناوبات', run: function () { navigateToPage('operations-dashboard.html'); } },
        'المستشفيات': { label: 'سجل المناوبات', run: function () { navigateToPage('operations-dashboard.html'); } }
    };
    return map[source] || null;
}
var NOTIF_ACTIONS = {}; // id → دالة الإجراء (تُملأ عند الرسم)

function loadNotifications() {
    if (!AuthManager.isLoggedIn()) return;
    AuthManager.apiRequest('/api/notifications')
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (data.success && Array.isArray(data.notifications)) {
                notifications = dedupeNotifications(data.notifications);
                unreadNotificationsCount = notifications.filter(function(n) { return !(n.read || n.is_read); }).length;
                updateNotificationBadge();
                renderNotifications();
                updateNotifStrip();
            }
        })
        .catch(function() {});
}

// منع تكرار نفس الإشعار (SSE/تداخل تحميل): بالمعرف أولًا ثم ببصمة العنوان+الرسالة
function dedupeNotifications(list) {
    var byId = {}, out = [], fp = {};
    for (var i = 0; i < list.length; i++) {
        var n = list[i];
        if (!n) continue;
        if (n.id !== undefined && n.id !== null) {
            if (byId[n.id]) continue;
            byId[n.id] = true;
        } else {
            var key = (n.title || '') + '|' + (n.message || '');
            if (fp[key]) continue;
            fp[key] = true;
        }
        out.push(n);
    }
    return out;
}

function updateNotificationBadge() {
    var badge = document.getElementById('notificationBadge');
    var count = document.getElementById('notificationCount');
    if (badge) {
        if (unreadNotificationsCount > 0) {
            badge.style.display = 'flex';
            badge.textContent = unreadNotificationsCount;
        } else {
            badge.style.display = 'none';
        }
    }
    if (count) count.textContent = unreadNotificationsCount;
    var uc = document.getElementById('nc2UnreadCount');
    if (uc) uc.textContent = unreadNotificationsCount + ' غير مقروء';
}

function markNotificationsRead() {
    if (!AuthManager.isLoggedIn()) return;
    AuthManager.apiRequest('/api/notifications/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    })
    .then(function(res) { return res.json(); })
    .then(function(data) {
        if (data.success) {
            notifications.forEach(function(n) { n.read = true; });
            unreadNotificationsCount = 0;
            updateNotificationBadge();
            renderNotifications();
            updateNotifStrip();
        }
    })
    .catch(function() {});
}

function showNotificationPanel() {
    var panel = document.getElementById('notificationPanel');
    if (panel) {
        panel.style.display = panel.style.display === 'none' || panel.style.display === '' ? 'flex' : 'none';
        if (panel.style.display !== 'none') {
            loadNotifications();
        }
    }
}

function toggleNotificationPanel(event) {
    if (event) event.stopPropagation();
    showNotificationPanel();
}

// تبويبات المركز: غير مقروء / مقروء / الكل
function setNotificationTab(tab, event) {
    if (event) event.stopPropagation();
    notificationActiveTab = tab;
    var tabs = document.querySelectorAll('#nc2Tabs .nc2-tab');
    for (var i = 0; i < tabs.length; i++) {
        tabs[i].classList.toggle('active', tabs[i].getAttribute('data-nc2tab') === tab);
    }
    renderNotifications();
}

function renderNotifications() {
    var list = document.getElementById('notificationList');
    if (!list) return;
    var filtered = notifications.filter(function (n) {
        var isRead = !!(n.read || n.is_read);
        if (notificationActiveTab === 'unread') return !isRead;
        if (notificationActiveTab === 'read') return isRead;
        return true;
    });
    if (filtered.length === 0) {
        var emptyText = notificationActiveTab === 'unread' ? 'لا توجد إشعارات غير مقروءة'
            : notificationActiveTab === 'read' ? 'لا توجد إشعارات مقروءة' : 'لا توجد إشعارات';
        list.innerHTML = '<div class="notification-empty"><i class="fas fa-bell-slash"></i><span>' + emptyText + '</span></div>';
        return;
    }
    NOTIF_ACTIONS = {};
    var html = '';
    for (var i = 0; i < filtered.length; i++) {
        var n = filtered[i];
        // عرض فقط: النوع (type) يصل جاهزًا ضمن حمولة GET /api/notifications — لا تغيير منطق/بيانات
        var typeKey = renderNotifications.TYPE_META[n.type] ? n.type : 'info';
        var meta = renderNotifications.TYPE_META[typeKey];
        var prio = notifPriorityOf(typeKey);
        var source = notifSourceOf(n);
        var isRead = !!(n.read || n.is_read);
        var timeText = TimeRiyadh.formatDateTime(n.created_at || n.createdAt || n.time);
        var agoText = notifTimeAgo(n.created_at || n.createdAt || n.time);
        var action = notifActionFor(source);
        var nid = (n.id !== undefined && n.id !== null) ? n.id : ('x' + i);
        if (action) NOTIF_ACTIONS[nid] = action.run;
        html += '<div class="nc-item nc-' + prio.key + (isRead ? ' is-read' : '') + '" onclick="markNotificationRead(' + (typeof nid === 'number' ? nid : "'" + nid + "'") + ')">' +
            '<div class="nc-icon"><i class="fas ' + meta.icon + '"></i></div>' +
            '<div class="nc-body">' +
                '<div class="nc-head">' +
                    '<span class="nc-title">' + (nc2Esc(n.title) || 'إشعار') + '</span>' +
                    '<span class="nc-chip">' + prio.label + '</span>' +
                    '<span class="nc-source"><i class="fas fa-link" style="font-size:0.55rem;margin-inline-end:3px;"></i>' + source + '</span>' +
                '</div>' +
                (n.message ? '<div class="nc-message">' + nc2Esc(n.message) + '</div>' : '') +
                '<div class="nc-meta">' +
                    '<span class="nc-time" title="' + nc2Esc(timeText) + '"><i class="far fa-clock"></i><span>' + agoText + '</span></span>' +
                    (action ? '<button class="nc-action" onclick="notifActionRun(' + (typeof nid === 'number' ? nid : "'" + nid + "'") + ', event)"><i class="fas fa-external-link-alt"></i>' + action.label + '</button>' : '') +
                '</div>' +
            '</div>' +
            (isRead ? '' : '<span class="nc-dot" title="غير مقروء"></span>') +
        '</div>';
    }
    list.innerHTML = html;
}

// تشغيل إجراء الإشعار: يعلّمه مقروءًا ثم يفتح وجهته
function notifActionRun(id, event) {
    if (event) event.stopPropagation();
    if (typeof id === 'number') markNotificationRead(id);
    var fn = NOTIF_ACTIONS[id];
    var panel = document.getElementById('notificationPanel');
    if (panel) panel.style.display = 'none';
    if (fn) { try { fn(); } catch (e) {} }
}

// ── الشريط التشغيلي بالـTopbar ──
// يعرض آخر إشعار غير مقروء حديث (≤ 30 دقيقة — إشعار قديم لا يظهر كأنه جديد).
// الحرج/المراقبة يبقيان حتى القراءة أو الإخفاء اليدوي؛ المعلوماتي يختفي بعد 12 ث.
function updateNotifStrip() {
    var strip = document.getElementById('notifStrip');
    if (!strip) return;
    if (notifStripTimer) { clearTimeout(notifStripTimer); notifStripTimer = null; }
    var cutoff = Date.now() - 30 * 60 * 1000;
    var latest = null;
    for (var i = 0; i < notifications.length; i++) {
        var n = notifications[i];
        if (n.read || n.is_read) continue;
        if (n.id !== undefined && n.id !== null && n.id === notifStripDismissedId) continue;
        var t = new Date(String(n.created_at || '').replace(' ', 'T') + 'Z').getTime();
        if (isNaN(t) || t < cutoff) continue; // قديم — لا يظهر كأنه جديد
        latest = n;
        break; // القائمة مرتبة تنازليًا من الخادم
    }
    if (!latest) { strip.style.display = 'none'; return; }
    var typeKey = renderNotifications.TYPE_META[latest.type] ? latest.type : 'info';
    var meta = renderNotifications.TYPE_META[typeKey];
    var prio = notifPriorityOf(typeKey);
    strip.className = 'notif-strip ns-' + prio.key;
    document.getElementById('notifStripIcon').innerHTML = '<i class="fas ' + meta.icon + '"></i>';
    document.getElementById('notifStripText').textContent = (latest.title || 'إشعار') + (latest.message ? ' — ' + latest.message : '');
    document.getElementById('notifStripTime').textContent = notifTimeAgo(latest.created_at);
    strip.style.display = 'inline-flex';
    strip.setAttribute('data-nid', latest.id !== undefined && latest.id !== null ? latest.id : '');
    // المعلوماتي يختفي تلقائيًا من الشريط ويبقى في المركز — الحرج/المراقبة يبقيان
    if (prio.key === 'info' || prio.key === 'success') {
        notifStripTimer = setTimeout(function () { strip.style.display = 'none'; }, 12000);
    }
}

function notifStripClick(event) {
    if (event) event.stopPropagation();
    var panel = document.getElementById('notificationPanel');
    if (panel && panel.style.display === 'none') toggleNotificationPanel(event);
}

function notifStripDismiss(event) {
    if (event) event.stopPropagation();
    var strip = document.getElementById('notifStrip');
    if (!strip) return;
    var nid = strip.getAttribute('data-nid');
    notifStripDismissedId = nid ? parseInt(nid, 10) : null;
    strip.style.display = 'none';
}

// خريطة عرض النوع (عرض فقط): تُرجمة عمود type المخزّن في جدول notifications
// إلى أيقونة/لون/وسم — بلا أي تغيير في البيانات أو التدفق أو المعالجات.
renderNotifications.TYPE_META = {
    success: { icon: 'fa-check-circle',         label: 'نجاح'    },
    warning: { icon: 'fa-exclamation-triangle', label: 'تنبيه'   },
    info:    { icon: 'fa-info-circle',          label: 'معلومات' },
    danger:  { icon: 'fa-exclamation-circle',   label: 'عاجل'    },
    urgent:  { icon: 'fa-exclamation-circle',   label: 'عاجل'    },
    error:   { icon: 'fa-exclamation-circle',   label: 'عاجل'    }
};

function markNotificationRead(id) {
    if (!AuthManager.isLoggedIn() || id === undefined) return;
    if (typeof id !== 'number') return; // عناصر بلا معرف خادم: لا endpoint لها
    AuthManager.apiRequest('/api/notifications/read/' + id, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    })
    .then(function() {
        var n = notifications.find(function(x) { return x.id === id; });
        if (n && !n.read) {
            n.read = true;
            unreadNotificationsCount = Math.max(0, unreadNotificationsCount - 1);
            updateNotificationBadge();
            renderNotifications();
            updateNotifStrip();
        }
    })
    .catch(function() {});
}

function markAllNotificationsRead() {
    markNotificationsRead();
}

function clearAllNotifications() {
    if (!AuthManager.isLoggedIn()) return;
    if (!confirm('هل أنت متأكد من مسح جميع الإشعارات؟')) return;
    AuthManager.apiRequest('/api/notifications/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    })
    .then(function() {
        notifications = [];
        unreadNotificationsCount = 0;
        updateNotificationBadge();
        renderNotifications();
        updateNotifStrip();
    })
    .catch(function() {});
}

// إغلاق قائمة الإشعارات عند النقر خارجها — الزر الفعلي notificationBell
// (كان المعالج يبحث عن notificationBellBtn غير الموجود فلا يعمل إطلاقًا)
document.addEventListener('click', function(e) {
    var panel = document.getElementById('notificationPanel');
    var bell = document.getElementById('notificationBell');
    var strip = document.getElementById('notifStrip');
    if (panel && panel.style.display !== 'none' && panel.style.display !== '') {
        if (!panel.contains(e.target) && (!bell || !bell.contains(e.target)) && (!strip || !strip.contains(e.target))) {
            panel.style.display = 'none';
        }
    }
});

function goToPeakTime() {
    var el_alertBar_d6 = document.getElementById('alertBar'); if (el_alertBar_d6) el_alertBar_d6.style.display = 'none';
    openPeakTimeModal();
}

function checkForAlerts() {
    AuthManager.apiRequest('/api/peak-data')
        .then(res => res.json())
        .then(result => {
            if (result.success) {
                var alerts = result.data.alerts || [];
                var activeAlerts = alerts.filter(a => a.status === 'نشط');
                var dismissed = localStorage.getItem('alertDismissed') === 'true';
                var shownAlert = localStorage.getItem('lastShownPeakAlert');
                
                if (activeAlerts.length > 0 && !dismissed) {
                    var latestAlert = activeAlerts[0];
                    if (latestAlert.id !== shownAlert) {
                        showPeakAlert({
                            unit: latestAlert.unit || latestAlert.title?.replace('تمركز مطلوب لـ ', '') || '-',
                            location: latestAlert.location || '-',
                            startTime: latestAlert.startTime || '-',
                            endTime: latestAlert.endTime || '-',
                            notes: latestAlert.notes || 'لا توجد ملاحظات',
                            lat: latestAlert.lat || 24.7136,
                            lng: latestAlert.lng || 46.6753,
                            radius: latestAlert.radius || 5000,
                            id: latestAlert.id,
                            details: latestAlert.details
                        });
                        localStorage.setItem('lastShownPeakAlert', latestAlert.id);
                    }
                }
            }
        })
        .catch(() => {});
}

// ============================================
// تنبيه وقت الذروة - منبثق مع خريطة
// ============================================
var peakAlertMap = null;
var currentPeakAlert = null;
var currentPeakAlertId = null;

function showPeakAlert(alertData) {
    currentPeakAlert = alertData;
    currentPeakAlertId = alertData.id;

    var el_peakAlertUnit = document.getElementById('peakAlertUnit'); if (el_peakAlertUnit) el_peakAlertUnit.innerText = alertData.unit || '-';
    var el_peakAlertLocation = document.getElementById('peakAlertLocation'); if (el_peakAlertLocation) el_peakAlertLocation.innerText = alertData.location || '-';
    var el_peakAlertStart = document.getElementById('peakAlertStart'); if (el_peakAlertStart) el_peakAlertStart.innerText = alertData.startTime || '-';
    var el_peakAlertEnd = document.getElementById('peakAlertEnd'); if (el_peakAlertEnd) el_peakAlertEnd.innerText = alertData.endTime || '-';
    var el_peakAlertNotes = document.getElementById('peakAlertNotes'); if (el_peakAlertNotes) el_peakAlertNotes.innerText = alertData.notes || '\u0644\u0627 \u062A\u0648\u062C\u062F \u0645\u0644\u0627\u062D\u0638\u0627\u062A';
    var el_peakAlertTime = document.getElementById('peakAlertTime'); if (el_peakAlertTime) el_peakAlertTime.innerText = '\uD83D\uDD52 ' + getSaudiDateTime();

    // Priority badge
    var priority = alertData.priority || '\u0639\u0627\u0644\u064A\u0629';
    var badgeHTML = '';
    if (priority === '\u0639\u0627\u0644\u064A\u0629' || priority === '\u0639\u0627\u062C\u0644') {
        badgeHTML = '<span class="priority-badge priority-high">\uD83D\uDD34 \u0639\u0627\u062C\u0644 - \u062A\u0645\u0631\u0643\u0632 \u0641\u0648\u0631\u064A</span>';
    } else if (priority === '\u0645\u062A\u0648\u0633\u0637\u0629' || priority === '\u0645\u062A\u0648\u0633\u0637') {
        badgeHTML = '<span class="priority-badge priority-medium">\uD83D\uDFE1 \u0645\u0647\u0645 - \u062A\u0645\u0631\u0643\u0632 \u0633\u0631\u064A\u0639</span>';
    } else {
        badgeHTML = '<span class="priority-badge priority-low">\uD83D\uDD35 \u0639\u0627\u062F\u064A - \u062A\u0645\u0631\u0643\u0632 \u0631\u0648\u062A\u064A\u0646\u064A</span>';
    }
    var el_peakAlertPriorityBadge_h1 = document.getElementById('peakAlertPriorityBadge'); if (el_peakAlertPriorityBadge_h1) el_peakAlertPriorityBadge_h1.innerHTML = badgeHTML;

    // Hide rating initially
    var el_peakRatingSection_d7 = document.getElementById('peakRatingSection'); if (el_peakRatingSection_d7) el_peakRatingSection_d7.style.display = 'none';

    openModalById('peakAlertModal');

    // Play alert sound and flash screen
    playPeakSound('alert');
    showPeakAlertFlash();

    // Start countdown
    startPeakAlertCountdown(alertData.startTime, alertData.endTime);

    // Init map
    setTimeout(function() {
        initPeakAlertMap(alertData);
    }, 300);

    // Play urgent sound
    playUrgentAlertSound();

    // Vibrate if supported
    if (navigator.vibrate) navigator.vibrate([500, 200, 500, 200, 500]);

    // Browser notification
    if (Notification.permission === 'granted') {
        new Notification('\uD83D\uDEA8 \u062A\u0646\u0628\u064A\u0647 \u0648\u0642\u062A \u0627\u0644\u0630\u0631\u0648\u0629', {
            body: '\u0641\u0631\u0642\u0629 ' + (alertData.unit || '-') + ' \u0645\u0637\u0644\u0648\u0628\u0629 \u0641\u064A ' + (alertData.location || '-'),
            icon: '/favicon.ico',
            tag: 'peak-alert-' + alertData.id,
            requireInteraction: true
        });
    }
}

function initPeakAlertMap(alertData) {
    var container = document.getElementById('peakAlertMap');
    if (!container) return;
    if (typeof L === 'undefined') { setTimeout(function() { initPeakAlertMap(alertData); }, 500); return; }
    
    // IMPORTANT: دائماً ندمر الخريطة القديمة وننشئ واحدة جديدة
    if (peakAlertMap) {
        peakAlertMap.remove();
        peakAlertMap = null;
        container.innerHTML = '';
    }
    
    try {
        var centerLat = parseFloat(alertData.lat) || 24.7136;
        var centerLng = parseFloat(alertData.lng) || 46.6753;
        
        peakAlertMap = L.map('peakAlertMap').setView([centerLat, centerLng], 13);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap'
        }).addTo(peakAlertMap);
        
        var marker = L.marker([centerLat, centerLng]).addTo(peakAlertMap);
        marker.bindPopup('<b>' + escapeHtml(alertData.unit) + '</b><br>' + escapeHtml(alertData.location) + '<br>⏰ ' + (alertData.startTime || '')).openPopup();
        
        if (alertData.radius) {
            L.circle([centerLat, centerLng], {
                radius: alertData.radius,
                color: '#EF4444',
                fillColor: '#EF4444',
                fillOpacity: 0.15,
                weight: 2
            }).addTo(peakAlertMap);
        }
        
        setTimeout(function() { peakAlertMap.invalidateSize(); }, 500);
    } catch (error) {
        console.error('خطأ في تهيئة خريطة التنبيه:', error);
    }
}

function closePeakAlert() {
    closeModalById('peakAlertModal');
    if (peakCountdownInterval) {
        clearInterval(peakCountdownInterval);
        peakCountdownInterval = null;
    }
    if (peakAlertMap) {
        peakAlertMap.remove();
        peakAlertMap = null;
        var container = document.getElementById('peakAlertMap');
        if (container) container.innerHTML = '';
    }
}

async function resolvePeakAlertFromModal() {
    if (!currentPeakAlertId) {
        closePeakAlert();
        return;
    }
    if (!confirm('⚠️ هل أنت متأكد من إنهاء هذا التنبيه؟')) return;
    try {
        var response = await fetch('/api/peak-resolve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ alertId: currentPeakAlertId })
        });
        var result = await response.json();
        if (result.success) {
            closePeakAlert();
            showToast('✅ تم إنهاء التنبيه', 'success');
        }
    } catch (error) {
        alert('❌ خطأ في الاتصال');
    }
}

// ============================================
// نظام وقت الذروة (Map Modal Support)
// ============================================
var peakMissions = [];
var selectedPeakLocation = null;
var peakMap = null;


function openPeakMap() {
    openModalById('peakMapModal');
    setTimeout(initPeakMap, 500);
}

function closePeakMap() {
    closeModalById('peakMapModal');
    if (peakMap) peakMap.invalidateSize();
}

function initPeakMap() {
    var container = document.getElementById('peakMap');
    if (!container) return;
    if (typeof L === 'undefined') { setTimeout(initPeakMap, 500); return; }
    if (peakMap) { setTimeout(function() { peakMap.invalidateSize(); }, 300); return; }
    try {
        peakMap = L.map('peakMap').setView([24.7136, 46.6753], 13);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(peakMap);
        var marker = null;
        peakMap.on('click', function(e) {
            var lat = e.latlng.lat;
            var lng = e.latlng.lng;
            if (marker) peakMap.removeLayer(marker);
            marker = L.marker([lat, lng]).addTo(peakMap);
            var el_peakSelectedLocation_h2 = document.getElementById('peakSelectedLocation'); if (el_peakSelectedLocation_h2) el_peakSelectedLocation_h2.innerHTML = '<strong>' + lat.toFixed(6) + ', ' + lng.toFixed(6) + '</strong>';
            selectedPeakLocation = { lat: lat, lng: lng };
        });
        setTimeout(function() { peakMap.invalidateSize(); }, 300);
    } catch (error) { console.error('خطأ في تهيئة الخريطة:', error); }
}

function confirmPeakLocation() {
    if (!selectedPeakLocation) { alert('⚠️ الرجاء تحديد موقع على الخريطة'); return; }
    var lat = selectedPeakLocation.lat;
    var lng = selectedPeakLocation.lng;
    var el_peakLocation_v1 = document.getElementById('peakLocation'); if (el_peakLocation_v1) el_peakLocation_v1.value = lat.toFixed(6) + ', ' + lng.toFixed(6);
    var el_peakLat_v2 = document.getElementById('peakLat'); if (el_peakLat_v2) el_peakLat_v2.value = lat;
    var el_peakLng_v3 = document.getElementById('peakLng'); if (el_peakLng_v3) el_peakLng_v3.value = lng;
    closePeakMap();
    alert('✅ تم تحديد الموقع بنجاح');
}


// ============================================
// عداد تنازلي + أولوية + تقييم
// ============================================
var peakCountdownInterval = null;
var peakCountdownTotalSeconds = 0;
var peakCountdownRemaining = 0;

function startPeakAlertCountdown(startTime, endTime) {
    // Clear old interval
    if (peakCountdownInterval) {
        clearInterval(peakCountdownInterval);
        peakCountdownInterval = null;
    }

    var now = new Date().getTime();
    var start = new Date(startTime).getTime();
    var end = new Date(endTime).getTime();

    if (isNaN(start) || isNaN(end)) return;

    peakCountdownTotalSeconds = Math.max(1, Math.floor((end - start) / 1000));

    function update() {
        var currentNow = new Date().getTime();
        peakCountdownRemaining = Math.max(0, Math.floor((end - currentNow) / 1000));

        var hours = Math.floor(peakCountdownRemaining / 3600);
        var minutes = Math.floor((peakCountdownRemaining % 3600) / 60);
        var seconds = peakCountdownRemaining % 60;
        var timerText =
            (hours < 10 ? '0' : '') + hours + ':' +
            (minutes < 10 ? '0' : '') + minutes + ':' +
            (seconds < 10 ? '0' : '') + seconds;

        var timerEl = document.getElementById('peakCountdownTimer');
        if (timerEl) timerEl.textContent = timerText;

        // Progress bar
        var progress = peakCountdownTotalSeconds > 0 ? (peakCountdownRemaining / peakCountdownTotalSeconds) * 100 : 0;
        var progressEl = document.getElementById('peakCountdownProgress');
        if (progressEl) progressEl.style.width = progress + '%';

        // Colors based on remaining time
        if (timerEl) {
            timerEl.classList.remove('urgent', 'warning');
            if (peakCountdownRemaining <= 300) timerEl.classList.add('urgent'); // 5 min
            else if (peakCountdownRemaining <= 900) timerEl.classList.add('warning'); // 15 min
        }

        // Show rating when time is up
        if (peakCountdownRemaining <= 0) {
            clearInterval(peakCountdownInterval);
            peakCountdownInterval = null;
            var rating = document.getElementById('peakRatingSection');
            if (rating) rating.style.display = 'block';
            if (timerEl) timerEl.textContent = '\u23F0 \u0627\u0646\u062A\u0647\u0649 \u0627\u0644\u0648\u0642\u062A';
        }
    }

    update();
    peakCountdownInterval = setInterval(update, 1000);
}

function ratePeakResponse(rating) {
    var alertId = currentPeakAlertId;
    var unit = currentPeakAlert ? currentPeakAlert.unit : '-';

    // Save rating locally
    var ratings = JSON.parse(localStorage.getItem('peakRatings') || '{}');
    ratings[alertId] = { rating: rating, unit: unit, time: new Date().toISOString() };
    localStorage.setItem('peakRatings', JSON.stringify(ratings));

    // Hide rating section
    var el_peakRatingSection_d12 = document.getElementById('peakRatingSection'); if (el_peakRatingSection_d12) el_peakRatingSection_d12.style.display = 'none';

    var messages = {
        5: '\u2705 \u0645\u0645\u062A\u0627\u0632! \u0648\u0635\u0644 \u0641\u064A \u0627\u0644\u0648\u0642\u062A \u0627\u0644\u0645\u062D\u062F\u062F +10 \u0646\u0642\u0627\u0637',
        3: '\u26A0\uFE0F \u062C\u064A\u062F. \u062A\u0623\u062E\u0631 \u0642\u0644\u064A\u0644\u0627\u064B +5 \u0646\u0642\u0627\u0637',
        1: '\u274C \u064A\u062D\u062A\u0627\u062C \u062A\u062D\u0633\u064A\u0646. \u0645\u0627 \u0648\u0635\u0644'
    };
    showNotification('\u062A\u0645 \u0627\u0644\u062A\u0642\u064A\u064A\u0645', messages[rating] || '\u2713 \u062A\u0645', 'success', 4000);

    // Add audit log
    addAuditEntry('system', '\u062A\u0642\u064A\u064A\u0645 \u0627\u0633\u062A\u062C\u0627\u0628\u0629', unit + ' - ' + rating + ' \u0646\u062C\u0648\u0645', '\u0627\u0644\u0645\u0634\u0631\u0641');
}

function playUrgentAlertSound() {
    try {
        var audioCtx = new (window.AudioContext || window.webkitAudioContext)();

        // Three-tone alarm pattern
        function beep(freq, start, duration, vol) {
            var osc = audioCtx.createOscillator();
            var gain = audioCtx.createGain();
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.type = 'square';
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(vol, audioCtx.currentTime + start);
            gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + start + duration);
            osc.start(audioCtx.currentTime + start);
            osc.stop(audioCtx.currentTime + start + duration);
        }

        // Emergency pattern: high-low-high
        beep(880, 0, 0.3, 0.3);
        beep(440, 0.35, 0.3, 0.3);
        beep(880, 0.7, 0.3, 0.3);
        beep(440, 1.05, 0.3, 0.3);
        beep(880, 1.4, 0.5, 0.3);
    } catch(e) {}
}

// ============================================
// نافذة توزيع البلاغات المتطورة
// ============================================
// أنواع البلاغات
// ============================================
var REPORT_TYPE_DEFS = {
    traffic:   { emoji: '🚗', label: 'حوادث مرورية', color: '#EF4444' },
    medical:   { emoji: '🤒', label: 'حالات مرضية', color: '#3B82F6' },
    injury:    { emoji: '🚨', label: 'إصابات', color: '#F97316' },
    cardiac:   { emoji: '❤️', label: 'توقف قلب', color: '#DC2626' },
    birth:     { emoji: '👶', label: 'ولادة', color: '#EC4899' },
    fire:      { emoji: '🔥', label: 'حريق', color: '#F59E0B' },
    death:     { emoji: '⚰️', label: 'وفاة', color: '#6B7280' },
    transport: { emoji: '🚑', label: 'نقل مريض', color: '#10B981' },
    other:     { emoji: '📦', label: 'حالات أخرى', color: '#8B5CF6' }
};
var selectedReportType = 'medical';

function getUnitTypeBreakdown(center, unit) {
    var key = center + '|' + unit;
    return (reports && reports[key] && reports[key].types) || {};
}
function getShiftTypeBreakdown() {
    var totals = {};
    for (var key in reports) {
        var types = (reports[key] && reports[key].types) || {};
        for (var type in types) {
            totals[type] = (totals[type] || 0) + types[type];
        }
    }
    return totals;
}
// جلب ملخص محرك البلاغات برقم البلاغ — قراءة تكميلية لا تعطّل العرض عند الفشل
async function fetchIncidentSummarySafe() {
    if (!AuthManager.isLoggedIn()) return null;
    try {
        var res = await AuthManager.apiRequest('/api/cad-reports');
        var data = await res.json();
        if (data && data.success) {
            // العداد الرئيسي وشريط الأحداث = البلاغات الفريدة من المحرك (قرار 2026-08-22)
            cadReportsTotal = (typeof data.total === 'number') ? data.total : null;
            updateTotal();
            if (cadReportsTotal !== null) { lastReportsTotal = cadReportsTotal; if (typeof renderEventsStrip === 'function') renderEventsStrip(); }
            renderSmartMap(data); return data;
        }
    } catch (e) { /* تجاهل — تبقى الإحصائية القديمة */ }
    return null;
}
// إحصائية المواقع بالحي المشتق من عنوان CAD بدل المركز الخام «CAD» (قرار المالك 2026-08-20):
// كل بلاغ CAD يُحسب مرة واحدة تحت حيّه، ومراكز الإدخال اليدوي تبقى كما هي
function mergeDistrictStats(sectorStats, byDistrict) {
    if (!byDistrict) return sectorStats;
    var merged = {};
    for (var c in sectorStats) {
        if (c !== 'CAD') merged[c] = sectorStats[c];
    }
    for (var d in byDistrict) {
        merged[d] = (merged[d] || 0) + byDistrict[d];
    }
    return merged;
}
function getSmartColorClass(count) {
    if (count < 5) return 'smart-color-green';
    if (count <= 10) return 'smart-color-yellow';
    if (count <= 15) return 'smart-color-orange';
    return 'smart-color-red';
}
function getSectorSmartColorClass(count) {
    if (count < 5) return 'sector-smart-green';
    if (count <= 10) return 'sector-smart-yellow';
    if (count <= 15) return 'sector-smart-orange';
    return 'sector-smart-red';
}
function getActivityBarWidth(count) {
    // Max expected is ~20, so scale proportionally
    return Math.min((count / 20) * 100, 100) + '%';
}
function getActivityBarColor(count) {
    if (count < 5) return '#10B981';
    if (count <= 10) return '#F59E0B';
    if (count <= 15) return '#F97316';
    return '#EF4444';
}
function getLastReportTime() {
    var lastTime = null;
    for (var key in reports) {
        var r = reports[key];
        if (r && r.times && r.times.length > 0) {
            var t = new Date(r.times[r.times.length - 1]);
            if (!lastTime || t > lastTime) lastTime = t;
        }
    }
    return lastTime;
}
function getPeakHour() {
    var hourCounts = {};
    for (var key in reports) {
        var r = reports[key];
        if (r && r.times) {
            for (var i = 0; i < r.times.length; i++) {
                // ساعة الرياض (كانت getHours بمنطقة الجهاز)
                var hp = TimeRiyadh.riyadhParts(r.times[i]);
                var h = hp ? parseInt(hp.hour, 10) : NaN;
                if (isNaN(h)) continue;
                hourCounts[h] = (hourCounts[h] || 0) + 1;
            }
        }
    }
    var maxHour = -1, maxCount = 0;
    for (var h in hourCounts) {
        if (hourCounts[h] > maxCount) {
            maxCount = hourCounts[h];
            maxHour = parseInt(h);
        }
    }
    if (maxHour < 0) return '-';
    return maxHour.toString().padStart(2, '0') + ':00';
}

// ============================================
// نافذة توزيع البلاغات المتطورة
// ============================================
// ═══ الإلغاء اليدوي لمشاركة فرقة من توزيع البلاغات (اعتماد المالك 2026-08-24) ═══
// مشاركة سُجّلت بالخطأ تُعلَّم manual_cancelled في الخادم — لا حذف: تخرج فورًا
// من كل العدّادات والمؤشرات وتبقى موثقة في التفاصيل والتدقيق مع السبب والفاعل.
async function cancelCrewRegistration(number, unit, restore) {
    if (!restore) {
        var reason = window.prompt('إلغاء تسجيل «' + unit + '» من البلاغ ' + number + '؟\nستُستبعد الفرقة فورًا من جميع العدّادات والمؤشرات، ويبقى السجل محفوظًا في التاريخ والتدقيق.\n\nسبب الإلغاء (اختياري):', '');
        if (reason === null) return; // ألغى المستخدم العملية
    } else if (!window.confirm('استعادة مشاركة «' + unit + '» في البلاغ ' + number + ' ضمن العدّادات؟')) {
        return;
    }
    try {
        var url = '/api/cad-reports/' + encodeURIComponent(number) + '/crews/' + encodeURIComponent(unit) + (restore ? '/restore' : '/cancel');
        var res = await AuthManager.apiRequest(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(restore ? {} : { reason: (reason || '').trim() || null })
        });
        var data = await res.json().catch(function() { return {}; });
        if (res.ok && data.success) {
            if (typeof showToast === 'function') showToast(restore ? '↩ استُعيدت مشاركة «' + unit + '»' : '🚫 أُلغي تسجيل «' + unit + '» — مستبعدة من العدّادات ومحفوظة في السجل', 'success');
            renderAdvancedDistribution(); // إعادة الرسم من المصدر مباشرة
        } else {
            if (typeof showToast === 'function') showToast('❌ ' + (data.error || ('HTTP ' + res.status)), 'error'); else alert(data.error || ('HTTP ' + res.status));
        }
    } catch (e) {
        if (typeof showToast === 'function') showToast('❌ تعذر الاتصال بالخادم', 'error');
    }
}

async function renderAdvancedDistribution() {
    var container = document.getElementById('distributionContainer');
    if (!container) return;
    container.innerHTML = '<div class="dm-loading"><i class="fas fa-spinner fa-spin dm-loading-icon"></i>جاري تحميل البيانات...</div>';
    
    // ─── Fetch completion data: only ready teams ───
    var readyTeams = {};
    var teamParamedics = {};
    var hasCompletion = false;
    
    try {
        var shiftDate = '';
        var shiftType = '';
        try {
            if (typeof getCurrentShiftDate === 'function') shiftDate = getCurrentShiftDate();
            else shiftDate = getSaudiDate(); // تاريخ الرياض (كان toISOString UTC)
        } catch(e) { shiftDate = getSaudiDate(); }
        try {
            if (typeof getCurrentShiftType === 'function') shiftType = getCurrentShiftType();
            else shiftType = 'صباح';
        } catch(e) { shiftType = 'صباح'; }
        
        if (AuthManager.isLoggedIn()) {
            // OV-S6-01: عند معرفة المناوبة النشطة نقرأ بـ shift_id (مقاوم لأخطاء الختم التاريخية)،
            // ويبقى استعلام date+type مساراً احتياطياً في وضع التحضير
            var completionUrl = '/api/completion/latest?shiftDate=' + encodeURIComponent(shiftDate) + '&shiftType=' + encodeURIComponent(shiftType);
            if (currentShiftId) completionUrl += '&shift_id=' + encodeURIComponent(currentShiftId);
            var response = await AuthManager.apiRequest(completionUrl);
            var data = await response.json();
            if (data.success && data.completion && data.completion.teams) {
                hasCompletion = true;
                for (var teamId in data.completion.teams) {
                    var team = data.completion.teams[teamId];
                    if (team.status === 'ready') {
                        readyTeams[teamId] = true;
                        teamParamedics[teamId] = team.paramedics || [];
                    }
                }
            }
        }
    } catch (e) {
        console.log('[renderAdvancedDistribution] Could not fetch completion:', e);
    }
    
    // If no completion saved yet, show message
    if (!hasCompletion) {
        container.innerHTML = '<div class="dm-empty">' +
            '<i class="fas fa-clipboard-check dm-empty-icon"></i>' +
            '<div class="dm-empty-title">لم يتم تسجيل تكميل المناوبة</div>' +
            '<div class="dm-empty-sub">الرجاء إكمال التكميل السريع أولاً لعرض الفرق الجاهزة.</div>' +
            '</div>';
        return;
    }
    
    container.innerHTML = '';
    container.className = 'distribution-advanced';
    
    var allReports = reports || {};
    
    // ─── Part 2: Live Stats Dashboard ───
    var totalReports = 0;
    var typeBreakdown = getShiftTypeBreakdown();
    var unitStats = {};
    var sectorStats = {};
    var lastTime = getLastReportTime();
    
    for (var key in allReports) {
        var r = allReports[key];
        if (r && r.count > 0) {
            totalReports += r.count;
            var parts = key.split('|');
            var center = parts[0];
            var unit = parts[1];
            if (unit) unitStats[unit] = (unitStats[unit] || 0) + r.count;
            if (center) sectorStats[center] = (sectorStats[center] || 0) + r.count;
        }
    }
    
    // محرك التوزيع برقم البلاغ (2026-08-20): الإجمالي والأنواع من ملخص المحرك —
    // الإجمالي = أرقام بلاغات فريدة + ضغطات يدوية · النوع مرة واحدة لكل بلاغ ·
    // وعدّادات الفرق أدناه تبقى «مشاركات» كما هي
    var incidentSummary = await fetchIncidentSummarySafe();
    if (incidentSummary) {
        totalReports = incidentSummary.total;
        typeBreakdown = incidentSummary.byType || typeBreakdown;
        // «آخر بلاغ» يعكس وقت الإنشاء الفعلي في CAD لا وقت الإدخال المتأخر (قرار المالك 2026-08-20)
        if (incidentSummary.lastReportTs) lastTime = new Date(incidentSummary.lastReportTs);
        // إحصائية المواقع بالحي المشتق بدل مركز «CAD» الخام (قرار المالك 2026-08-20)
        sectorStats = mergeDistrictStats(sectorStats, incidentSummary.byDistrict);
    }
    
    var sortedUnits = Object.entries(unitStats).sort(function(a, b) { return b[1] - a[1]; });
    var mostActiveTeam = sortedUnits.length > 0 ? sortedUnits[0][0] : '-';
    var mostActiveTeamCount = sortedUnits.length > 0 ? sortedUnits[0][1] : 0;
    
    var sortedSectors = Object.entries(sectorStats).sort(function(a, b) { return b[1] - a[1]; });
    var mostActiveCity = sortedSectors.length > 0 ? sortedSectors[0][0] : '-';
    var mostActiveCityCount = sortedSectors.length > 0 ? sortedSectors[0][1] : 0;
    
    var statsHtml = '<div class="distribution-stats-dashboard">' +
        '<div class="stats-dashboard-header">' +
            '<i class="fas fa-chart-pie"></i>' +
            '<h3 class="stats-dashboard-title">📊 لوحة الإحصائيات الحية</h3>' +
        '</div>' +
        '<div class="stats-dashboard-grid">' +
            '<div class="stat-card">' +
                '<div class="stat-card-icon">📊</div>' +
                '<div class="stat-card-value">' + totalReports + '</div>' +
                '<div class="stat-card-label">إجمالي البلاغات</div>' +
            '</div>' +
            '<div class="stat-card">' +
                '<div class="stat-card-icon">🏆</div>' +
                '<div class="stat-card-value">' + mostActiveTeam + '</div>' +
                '<div class="stat-card-label">أكثر فرقة (' + mostActiveTeamCount + ')</div>' +
            '</div>' +
            '<div class="stat-card">' +
                '<div class="stat-card-icon">📍</div>' +
                '<div class="stat-card-value">' + mostActiveCity + '</div>' +
                '<div class="stat-card-label">أكثر مدينة (' + mostActiveCityCount + ')</div>' +
            '</div>' +
            '<div class="stat-card time">' +
                '<div class="stat-card-icon">🕐</div>' +
                '<div class="stat-card-value">' + (lastTime ? TimeRiyadh.formatTime(lastTime) : '-') + '</div>' +
                '<div class="stat-card-label">آخر بلاغ</div>' +
            '</div>';

    // مؤشر زمن الاستجابة للقطاع (تعريف المالك 2026-08-20): من إنشاء البلاغ في CAD ← الوصول/المباشرة
    if (incidentSummary && incidentSummary.responseTime) {
        var rtA = incidentSummary.responseTime.arrival || { avg: null, count: 0 };
        var rtM = incidentSummary.responseTime.mubashara || { avg: null, count: 0 };
        statsHtml += '<div class="stat-card">' +
                '<div class="stat-card-icon">⏱️</div>' +
                '<div class="stat-card-value">' + (rtA.count ? rtA.avg + ' د' : '—') + '</div>' +
                '<div class="stat-card-label">زمن الاستجابة حتى الوصول (من ' + rtA.count + ' بلاغ)</div>' +
            '</div>' +
            '<div class="stat-card">' +
                '<div class="stat-card-icon">🩺</div>' +
                '<div class="stat-card-value">' + (rtM.count ? rtM.avg + ' د' : '—') + '</div>' +
                '<div class="stat-card-label">زمن البلاغ حتى المباشرة (من ' + rtM.count + ' بلاغ)</div>' +
            '</div>';
    }
    
    // Add type counts
    for (var t in REPORT_TYPE_DEFS) {
        var typeCount = typeBreakdown[t] || 0;
        if (typeCount > 0) {
            statsHtml += '<div class="stat-card">' +
                '<div class="stat-card-icon">' + REPORT_TYPE_DEFS[t].emoji + '</div>' +
                '<div class="stat-card-value">' + typeCount + '</div>' +
                '<div class="stat-card-label">' + REPORT_TYPE_DEFS[t].label + '</div>' +
            '</div>';
        }
    }
    statsHtml += '</div></div>';
    
    var statsDiv = document.createElement('div');
    statsDiv.innerHTML = statsHtml;
    container.appendChild(statsDiv.firstElementChild);
    
    // سجل البلاغات المرقمة من CAD: كل بلاغ برقمه ونوعه وفرقه وأزمنتها الخام
    // (أسماء الأزمنة كما في CAD؛ وزمن الاستجابة المحسوب من إنشاء البلاغ ← الوصول/المباشرة)
    if (incidentSummary && incidentSummary.incidents && incidentSummary.incidents.length) {
        var phaseMap = [['التحرك','تحرك'],['البحث','وصول'],['العلاج','مباشرة']];
        var logHtml = '<div style="margin-top:14px; background:rgba(46,139,122,.08); border:1px solid rgba(46,139,122,.35); border-radius:12px; padding:12px 14px;">' +
            '<div style="font-weight:700; color:#2E8B7A; margin-bottom:8px;">🧾 سجل البلاغات برقم البلاغ: <b>' + incidentSummary.incidentsCount + '</b>' +
            ' <span style="font-weight:400; font-size:.75rem; opacity:.7;">(كل رقم يُحسب مرة واحدة مهما تعددت فرقه · المشاركة اليدوية تُحسب بلاغًا مستقلًا · الفرقة التي لم تتحرك لا تدخل عدّادها ولا مؤشر الزمن)</span></div>' +
            incidentSummary.incidents.map(function(ic) {
                var td = (typeof REPORT_TYPE_DEFS !== 'undefined' && REPORT_TYPE_DEFS[ic.type]) ? REPORT_TYPE_DEFS[ic.type].emoji + ' ' + REPORT_TYPE_DEFS[ic.type].label : ic.type;
                var crews = ic.crews.map(function(c) {
                    var ph = c.phases || {};
                    var times = Object.keys(ph).filter(function(k) { return ph[k]; }).map(function(k) {
                        var m = phaseMap.find(function(p) { return p[0] === k; });
                        return k + ' ' + ph[k] + (m ? ' ← ' + m[1] : '');
                    }).join(' · ');
                    var respTxt = (c.respArrivalMin != null ? ' ⏱' + c.respArrivalMin + ' د للوصول' : '') +
                                  (c.respMubasharaMin != null ? ' · ' + c.respMubasharaMin + ' د للمباشرة' : '');
                    var notCounted = c.counted === false; // مُسندة وأُلغيت قبل التحرك — تبقى موثقة ولا تدخل العدّاد
                    var manualCancelled = c.manualCancelled === true; // أُلغيت يدويًا من هذه النافذة — مستبعدة ومحفوظة (2026-08-24)
                    var chipStyle = manualCancelled
                        ? 'display:inline-block; background:rgba(239,68,68,.07); border:1px dashed rgba(239,68,68,.5); border-radius:6px; padding:2px 9px; margin:2px; font-size:.8rem; opacity:.8;'
                        : notCounted
                        ? 'display:inline-block; background:rgba(148,163,184,.08); border:1px dashed rgba(148,163,184,.45); border-radius:6px; padding:2px 9px; margin:2px; font-size:.8rem; opacity:.75;'
                        : 'display:inline-block; background:rgba(46,139,122,.15); border:1px solid rgba(46,139,122,.4); border-radius:6px; padding:2px 9px; margin:2px; font-size:.8rem;';
                    var cancelTitle = manualCancelled && c.manualCancelledBy
                        ? 'أُلغيت يدويًا بواسطة ' + c.manualCancelledBy + (c.manualCancelReason ? ' — ' + c.manualCancelReason : '')
                        : '';
                    var _opsSt = window.__opsPermsState;
                    var canDispatch = !!(_opsSt && _opsSt.loaded && (_opsSt.star || _opsSt.perms.indexOf('ops.dispatch') !== -1));
                    var actionBtn = canDispatch
                        ? (manualCancelled
                            ? ' <button onclick="cancelCrewRegistration(\'' + ic.number + '\', \'' + String(c.unit).replace(/'/g, "\\'") + '\', true)" title="استعادة المشاركة في العدّادات" style="background:none;border:none;color:#2E8B7A;cursor:pointer;font-size:.75rem;padding:0 2px;">↩ استعادة</button>'
                            : ' <button onclick="cancelCrewRegistration(\'' + ic.number + '\', \'' + String(c.unit).replace(/'/g, "\\'") + '\', false)" title="إلغاء تسجيل الفرقة من هذا البلاغ (تُستبعد من العدّادات وتبقى في السجل)" style="background:none;border:none;color:#EF4444;cursor:pointer;font-size:.8rem;padding:0 2px;">✕</button>')
                        : '';
                    // الاختيار الجماعي (اعتماد المالك 2026-08-25): checkbox على الشارة
                    // في وضع التحديد فقط — الملغاة يدويًا أصلًا لا تحتاج إجراء فلا تُحدَّد
                    var batchCbx = (window.CrewBatchCancel && !manualCancelled)
                        ? window.CrewBatchCancel.chipCheckboxHtml(ic.number, c.unit) : '';
                    return '<span style="' + chipStyle + '"' + (cancelTitle ? ' title="' + cancelTitle + '"' : '') + '>' + batchCbx + '🚑 ' + c.unit +
                        (manualCancelled ? ' <small style="color:#EF4444;">(أُلغيت يدويًا — مستبعدة)</small>' :
                          notCounted ? ' <small style="opacity:.9;">(مُسندة — لم تتحرك)</small>' : '') +
                        (times ? ' <small style="opacity:.75;">(' + times + ')</small>' : '') +
                        (respTxt ? ' <small style="color:#2E8B7A; font-weight:700;">' + respTxt + '</small>' : '') +
                        actionBtn + '</span>';
                }).join('');
                // شريط أدوات الاختيار الجماعي لبطاقة البلاغ (اعتماد المالك 2026-08-25) —
                // فارغ بلا صلاحية ops.dispatch أو خارج وضع التحديد (زر ☑ تحديد يبقى)
                var batchControls = window.CrewBatchCancel ? window.CrewBatchCancel.incidentControlsHtml(ic) : '';
                return '<div style="padding:6px 4px; border-top:1px solid rgba(255,255,255,.06); font-size:.86rem;">' +
                    '<b style="direction:ltr; display:inline-block;">' + ic.number + '</b> — ' + td +
                    (ic.code ? ' <small style="opacity:.7;">(' + ic.code + ')</small>' : '') +
                    (ic.district ? ' <small style="color:#2E8B7A;">📍 ' + ic.district + '</small>' : '') +
                    (ic.cadCreatedAt ? ' <small style="opacity:.7;">· أُنشئ ' + ic.cadCreatedAt + '</small>' : '') +
                    batchControls +
                    '<div style="margin-top:4px;">' + crews + '</div>' +
                    '<div class="pi-sugg-slot" data-num="' + ic.number + '"></div></div>';
            }).join('') + '</div>';
        var logDiv = document.createElement('div');
        logDiv.innerHTML = logHtml;
        container.appendChild(logDiv.firstElementChild);
        // PI-7 (اعتماد المالك 2026-08-30): تعبئة «هوية الموقع» لكل بلاغ — قراءة
        // فقط، وفشلها/403 لا يمس السجل. المعروض تلميح خارجي غير معتمد.
        if (window.PlaceSuggestion) window.PlaceSuggestion.hydrate(logDiv);
    }
    
    // ─── Sector cards: ONLY ready teams ───
    for (var center in centersData) {
        var sectorDiv = document.createElement('div');
        sectorDiv.className = 'distribution-sector-card';
        
        var totalSectorReports = 0;
        var sectorUnits = centersData[center] || [];
        
        // Filter to ready teams only
        var visibleUnits = [];
        for (var i = 0; i < sectorUnits.length; i++) {
            if (readyTeams[sectorUnits[i]]) {
                visibleUnits.push(sectorUnits[i]);
            }
        }
        if (visibleUnits.length === 0) continue;
        
        for (var i = 0; i < visibleUnits.length; i++) {
            var key = center + '|' + visibleUnits[i];
            if (allReports[key] && allReports[key].count) {
                totalSectorReports += allReports[key].count;
            }
        }
        
        var sectorColorClass = getSectorSmartColorClass(totalSectorReports);
        
        var headerHtml = '<div class="distribution-sector-header ' + sectorColorClass + '">' +
            '<span class="sector-name"><i class="fas fa-map-pin"></i> ' + center + '</span>' +
            '<span class="sector-total">📊 ' + totalSectorReports + '</span>' +
            '</div>';
        
        var gridHtml = '<div class="distribution-unit-grid">';
        for (var j = 0; j < visibleUnits.length; j++) {
            var unit2 = visibleUnits[j];
            var key2 = center + '|' + unit2;
            var info = allReports[key2] || { count: 0, times: [] };
            var isZero = info.count === 0;
            var location = unitLocationAddresses[unit2] || 'لم يتم تحديد موقع';
            var smartColorClass = isZero ? '' : getSmartColorClass(info.count);
            var types = getUnitTypeBreakdown(center, unit2);
            
            // Build type breakdown HTML
            var typeBreakdownHtml = '';
            var typeEntries = Object.entries(types).sort(function(a, b) { return b[1] - a[1]; });
            if (typeEntries.length > 0) {
                typeBreakdownHtml = '<div class="unit-type-breakdown">';
                for (var ti = 0; ti < typeEntries.length; ti++) {
                    var td = REPORT_TYPE_DEFS[typeEntries[ti][0]];
                    typeBreakdownHtml += '<span class="type-tag">' + (td ? td.emoji : '📦') + ' ' + typeEntries[ti][1] + '</span>';
                }
                typeBreakdownHtml += '</div>';
            }
            
            // Activity bar
            var activityBarHtml = '';
            if (info.count > 0) {
                activityBarHtml = '<div class="activity-bar">' +
                    '<div class="activity-bar-fill ab-' + smartColorClass.replace('smart-color-', '') + '" data-w="' + getActivityBarWidth(info.count) + '"></div>' +
                    '</div>';
            }
            
            // Paramedics names
            var paramedics = teamParamedics[unit2] || [];
            var paramedicsHtml = '';
            if (paramedics.length > 0) {
                paramedicsHtml = '<div class="unit-paramedics">👤 ' + paramedics.join('، ') + '</div>';
            }
            
            gridHtml += '<div class="distribution-unit-item ' + smartColorClass + '" id="unit-' + center.replace(/\s/g, '') + '-' + unit2.replace(/\s/g, '') + '">' +
                (info.count > 0 ? '<span class="unit-badge">' + info.count + '</span>' : '') +
                '<div class="unit-name">' + unit2 + '</div>' +
                paramedicsHtml +
                '<div class="unit-count ' + (isZero ? 'zero' : '') + '" id="count-' + center.replace(/\s/g, '') + '-' + unit2.replace(/\s/g, '') + '">' + info.count + '</div>' +
                activityBarHtml +
                typeBreakdownHtml +
                '<div class="unit-actions">' +
                '<button class="btn btn-primary report-btn unit-action-btn" data-center="' + center + '" data-unit="' + unit2 + '"><i class="fas fa-plus-circle"></i></button>' +
                (info.count > 0 ? '<button class="btn btn-coral undo-btn unit-action-btn is-visible" data-center="' + center + '" data-unit="' + unit2 + '"><i class="fas fa-undo-alt"></i></button>' : '<button class="btn btn-coral undo-btn unit-action-btn is-hidden" data-center="' + center + '" data-unit="' + unit2 + '"><i class="fas fa-undo-alt"></i></button>') +
                '<button class="btn btn-outline preview-btn unit-action-btn" data-unit="' + unit2 + '" data-location="' + location + '"><i class="fas fa-map-marker-alt"></i></button>' +
                '</div>' +
                '</div>';
        }
        gridHtml += '</div>';
        
        sectorDiv.innerHTML = headerHtml + gridHtml;
        container.appendChild(sectorDiv);
        
        // عرض شريط النشاط يُضبط برمجيًا (data-w → style.width) ليبقى الماركب المبني بلا style مضمّن
        sectorDiv.querySelectorAll('.activity-bar-fill[data-w]').forEach(function(el) {
            el.style.width = el.getAttribute('data-w');
        });
        
        // ربط الأحداث
        sectorDiv.querySelectorAll('.report-btn').forEach(function(btn) {
            btn.addEventListener('click', function() {
                var center = this.getAttribute('data-center');
                var unit = this.getAttribute('data-unit');
                if (center && unit) {
                    addReportToServer(center, unit);
                }
            });
        });
        
        sectorDiv.querySelectorAll('.undo-btn').forEach(function(btn) {
            btn.addEventListener('click', function() {
                var center = this.getAttribute('data-center');
                var unit = this.getAttribute('data-unit');
                if (center && unit) {
                    undoLastReport(center, unit);
                }
            });
        });
        
        sectorDiv.querySelectorAll('.preview-btn').forEach(function(btn) {
            btn.addEventListener('click', function() {
                var unit = this.getAttribute('data-unit');
                var location = this.getAttribute('data-location');
                if (unit) {
                    openMapPreview(unit, location || 'لم يتم تحديد موقع');
                }
            });
        });
    }

}

// ============================================
// دوال الخريطة
// ============================================


// ============================================
// عناوين الفرق (للعرض النصي)
var unitLocationAddresses = {
    "جنوب 1": "طريق الملك فهد، الرياض",
    "جنوب 2": "حي المنصورة، الرياض",
    "جنوب 3": "الخالدية، الرياض",
    "جنوب 4": "الدار البيضاء، الرياض",
    "جنوب 5": "البساتين، الرياض",
    "جنوب 6": "الشفاء، الرياض",
    "جنوب 7": "طرة، الرياض",
    "جنوب 8": "المريوطية، الرياض",
    "جنوب 9": "عكاظ، الرياض",
    "جنوب 10": "المناخ، الرياض",
    "جنوب 11": "حي الواحات، الرياض",
    "جنوب 12": "جاكسو، الرياض",
    "جنوب 13": "الخليفة، الرياض",
    "جنوب 14": "المطرية، الرياض",
    "جنوب 15": "الدار البيضاء، الرياض",
    "جنوب 16": "المنصورة، الرياض",
    "جنوب 17": "الشفاء، الرياض",
    "جنوب 18": "طريق الملك فهد، الرياض",
    "جنوب 19": "الخالدية، الرياض",
    "سريع 1": "مستشفى الملك خالد، الرياض",
    "سريع 2": "الشفاء، الرياض",
    "سريع 3": "الدار البيضاء، الرياض",
    "سريع 4": "المنصورة، الرياض"
};

// ============================================================
// الإحداثيات التشغيلية الفعلية لمراكز قطاع جنوب الرياض — مصدر التموضع
// الوحيد (بلا أي منطق تشغيلي). كل فرقة ترث موقع مركزها التشغيلي عبر
// teamCenterMap؛ لا إحداثيات مستقلة للفرق، ولا إحداثيات تجريبية.
// ============================================================
var operationalCenters = {
    "المنصورة":      [24.614143, 46.75111],
    "الخالدية":      [24.6199444071494, 46.7549224197865],
    "منفوحه":        [24.6083812713623, 46.7229347229004],
    "الدار البيضاء": [24.56692, 46.76842],
    "الإسكان":       [24.560406, 46.84616],
    "الشفا":         [24.5608158111572, 46.695240020752],
    "عكاظ":          [24.5301020455377, 46.6545581817627],
    "ديراب":         [24.44628, 46.617017],
    "الحائر":        [24.418611, 46.842628]
};

// Mapping: رمز الفرقة ← مركزها التشغيلي الفعلي
var teamCenterMap = {
    "جنوب 1": "المنصورة",      "سريع 4": "المنصورة",
    "جنوب 2": "الخالدية",      "سريع 3": "الخالدية",
    "جنوب 3": "منفوحه",
    "جنوب 4": "الدار البيضاء", "جنوب 5": "الدار البيضاء", "سريع 1": "الدار البيضاء",
    "جنوب 6": "الإسكان",
    "جنوب 7": "الحائر",
    "جنوب 8": "الشفا",         "سريع 2": "الشفا",
    "جنوب 9": "عكاظ",
    "جنوب 10": "ديراب"
};

// توافق للميزات القائمة (معاينة الموقع/أقرب فرقة): يُبنى من الجدولين
// الفعليين أعلاه — حُذفت الإحداثيات التجريبية القديمة نهائيًا.
var unitLocations = (function () {
    var out = {};
    for (var team in teamCenterMap) {
        if (!teamCenterMap.hasOwnProperty(team)) continue;
        var c = teamCenterMap[team];
        if (!operationalCenters[c]) continue;
        if (!out[c]) out[c] = {};
        out[c][team] = operationalCenters[c];
    }
    return out;
})();

var map = null;
var mapMarkers = [];

function openMapPreview(unit, location) {
    var el_mapModalTitle = document.getElementById('mapModalTitle'); if (el_mapModalTitle) el_mapModalTitle.innerText = '📍 معاينة موقع ' + unit;
    var el_mapLocationText = document.getElementById('mapLocationText'); if (el_mapLocationText) el_mapLocationText.innerText = '📍 الموقع: ' + location;
    var el_nearestUnitResult_h3 = document.getElementById('nearestUnitResult'); if (el_nearestUnitResult_h3) el_nearestUnitResult_h3.innerHTML = '';
    openModalById('mapModal');

    setTimeout(function() {
        initLeafletMap(unit);
    }, 200);
}

function initLeafletMap(focusUnit) {
    var mapFrame = document.getElementById('mapFrame');
    var mapLeaflet = document.getElementById('mapLeaflet');

    if (!map) {
        mapFrame.style.display = 'none';
        mapLeaflet.style.display = 'block';
        mapLeaflet.style.width = '100%';
        mapLeaflet.style.height = '350px';

        map = L.map('mapLeaflet').setView([24.7136, 46.6753], 11);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap'
        }).addTo(map);
    }

    // مسح العلامات القديمة
    mapMarkers.forEach(function(m) { map.removeLayer(m); });
    mapMarkers = [];

    // إضافة علامات لكل الفرق
    var bounds = [];
    for (var center in unitLocations) {
        for (var unit in unitLocations[center]) {
            var loc = unitLocations[center][unit];
            if (loc && loc[0] && loc[1]) {
                var marker = L.marker(loc).addTo(map);
                marker.bindPopup('<b>' + unit + '</b><br>' + center);
                mapMarkers.push(marker);
                bounds.push(loc);

                if (focusUnit && unit === focusUnit) {
                    marker.openPopup();
                    map.setView(loc, 14);
                }
            }
        }
    }

    if (!focusUnit && bounds.length > 0) {
        map.fitBounds(bounds, { padding: [30, 30] });
    }

    setTimeout(function() { map.invalidateSize(); }, 300);
}

function closeMapPreview() {
    closeModalById('mapModal');
    document.getElementById('mapFrame').src = '';
    var el_nearestUnitResult_h4 = document.getElementById('nearestUnitResult'); if (el_nearestUnitResult_h4) el_nearestUnitResult_h4.innerHTML = '';
}

// ============================================
// تحديد أقرب فرقة إسعافية
// ============================================

function findNearestUnit() {
    if (!navigator.geolocation) {
        showNotification('غير مدعوم', 'المتصفح لا يدعم تحديد الموقع', 'warning', 3000);
        return;
    }

    showNotification('جاري البحث', 'يتم تحديد موقعك...', 'info', 2000);

    navigator.geolocation.getCurrentPosition(function(position) {
        var userLat = position.coords.latitude;
        var userLng = position.coords.longitude;

        // تجميع مواقع جميع الفرق
        var units = [];
        for (var center in unitLocations) {
            for (var unit in unitLocations[center]) {
                var loc = unitLocations[center][unit];
                if (loc && loc[0] && loc[1]) {
                    var dist = calculateDistance(userLat, userLng, loc[0], loc[1]);
                    units.push({
                        center: center,
                        unit: unit,
                        distance: dist,
                        location: loc
                    });
                }
            }
        }

        if (units.length === 0) {
            showNotification('لا توجد فرق', 'لم يتم العثور على فرق قريبة', 'warning', 3000);
            return;
        }

        units.sort(function(a, b) { return a.distance - b.distance; });
        var nearest = units[0];

        // عرض النتيجة
        var resultDiv = document.getElementById('nearestUnitResult');
        if (resultDiv) {
            resultDiv.innerHTML =
                '<div class="nearest-unit-result">' +
                    '<div class="result-title">أقرب فرقة إسعافية لموقعك</div>' +
                    '<div class="result-unit">🚑 ' + nearest.unit + '</div>' +
                    '<div class="result-center">' + nearest.center + '</div>' +
                    '<div class="result-distance">📍 المسافة: ~' + nearest.distance.toFixed(1) + ' كم</div>' +
                    '<button onclick="showUnitOnMap(\'' + nearest.center + '\', \'' + nearest.unit + '\')" class="btn btn-teal" style="margin-top:10px; font-size:0.75rem;">' +
                        '<i class="fas fa-map-marker-alt"></i> عرض على الخريطة' +
                    '</button>' +
                '</div>';
        }

        showNotification('تم العثور', 'أقرب فرقة: ' + nearest.unit + ' (' + nearest.distance.toFixed(1) + ' كم)', 'success', 4000);

        // تسجيل
        if (typeof addAuditEntry === 'function') {
            addAuditEntry('system', 'البحث عن أقرب فرقة', nearest.unit + ' - ' + nearest.center, 'المشرف');
        }

    }, function(error) {
        showNotification('خطأ', 'تعذر تحديد الموقع: ' + (error.message || ''), 'error', 3000);
    });
}

function calculateDistance(lat1, lng1, lat2, lng2) {
    var R = 6371;
    var dLat = (lat2 - lat1) * Math.PI / 180;
    var dLng = (lng2 - lng1) * Math.PI / 180;
    var a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng/2) * Math.sin(dLng/2);
    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

function showUnitOnMap(center, unit) {
    var loc = unitLocations[center] && unitLocations[center][unit];
    if (!loc || !map) return;

    map.setView(loc, 15);

    // البحث عن الـ marker المناسب وفتح popup
    mapMarkers.forEach(function(marker) {
        var popup = marker.getPopup();
        if (popup && popup.getContent().indexOf(unit) !== -1) {
            marker.openPopup();
        }
    });
}

// ============================================
// رسم دوائر مناطق التغطية
// ============================================

var coverageCircles = [];

function drawCoverageCircles() {
    if (!map) return;

    // إزالة الدوائر القديمة
    coverageCircles.forEach(function(c) { map.removeLayer(c); });
    coverageCircles = [];

    var colors = {
        'جاكسو': '#EF4444',
        'المنصورة': '#2980B9',
        'الشيخ زايد': '#27AE60',
        'حي الواحات': '#8E44AD',
        'المناخ': '#D35400',
        'المريوطية': '#16A085',
        'طرة': '#C0392B',
        'مطرية': '#F39C12',
        'البساتين': '#1ABC9C',
        'الخليفة': '#3498DB'
    };

    for (var center in unitLocations) {
        var color = colors[center] || '#2563EB';
        for (var unit in unitLocations[center]) {
            var loc = unitLocations[center][unit];
            if (loc && loc[0] && loc[1]) {
                var circle = L.circle(loc, {
                    radius: 2000,
                    color: color,
                    fillColor: color,
                    fillOpacity: 0.1,
                    weight: 1,
                    dashArray: '5, 5'
                }).addTo(map).bindTooltip(unit + ' - منطقة تغطية 2 كم', {
                    permanent: false,
                    direction: 'top'
                });
                coverageCircles.push(circle);
            }
        }
    }

    showNotification('تم الرسم', 'تم رسم مناطق التغطية على الخريطة', 'success', 2000);
}

// ============================================
// ربط أزرار التوزيع
// ============================================
var el_distributionBtn=document.getElementById("distributionBtn");if(el_distributionBtn)el_distributionBtn.addEventListener('click', function() {
    openModalById('distributionModal');
    renderAdvancedDistribution();
});

// ============================================
// المؤشرات الأساسية
// ============================================
var centersData = {};
var reports = {};
var lastKnownUpdate = 0;
// currentShiftId already declared at top of file
currentShiftId = currentShiftId || null;
allShifts = [];
isViewingArchiveShift = false;
currentViewingShift = null;
viewingShiftId = null;
currentViewingShiftData = null;
var uploadedDocs = [];
var filteredDocs = [];
var currentDocsPage = 1;
var docsPerPage = 10;
var selectedFiles = [];
var docsViewMode = 'list';
var centerNumbers = Array.from({length: 19}, function(_, i) { return i + 1; });
var centerList = centerNumbers.map(function(n) { return 'جنوب ' + n; });

var rapidTeams = [
    { name: 'سريع 1', displayName: 'سريع 1', code: 'R1' },
    { name: 'سريع 2', displayName: 'سريع 2', code: 'R2' },
    { name: 'سريع 3', displayName: 'سريع 3', code: 'R3' },
    { name: 'سريع 4', displayName: 'سريع 4', code: 'R4' }
];

var currentSheetIndex = 0;
var currentSheetIndex = 0;
var workbookData = null;
var controlData = [
    { code: "4252", name: "سلطان ابراهيم يوسف اليوسف التميمي", role: "تنسيق استجابة", vacationStart: "", vacationEnd: "" },
    { code: "101353", name: "هيثم حويكم هليل العنزي", role: "تحكم عملياتي", vacationStart: "", vacationEnd: "" },
    { code: "102462", name: "وليد معلا الحربي", role: "تحكم عملياتي", vacationStart: "", vacationEnd: "" },
    { code: "11120", name: "عوض عبدالعزيز عوض الاسمري", role: "تنسيق استجابة", vacationStart: "", vacationEnd: "" },
    { code: "102752", name: "محمد نايف صنهات العتيبي", role: "تنسيق استجابة", vacationStart: "", vacationEnd: "" },
    { code: "10717", name: "عطاالله خالد عطوي الرويلي", role: "تنسيق استجابة", vacationStart: "", vacationEnd: "" },
    { code: "101915", name: "مبارك هذال مبارك ال بريك", role: "تحكم عملياتي", vacationStart: "", vacationEnd: "" },
    { code: "8323", name: "تركي عتيق الله خيرالله المطيري", role: "تحكم عملياتي", vacationStart: "", vacationEnd: "" },
    { code: "10373", name: "سامي صالح عناد العنزي", role: "تنسيق استجابة", vacationStart: "", vacationEnd: "" }
];
var isEditMode = false;
// ملاحظة: airRecords يُعرَّف مرة واحدة في قسم نماذج التشغيلية (مصدره الخادم)

// ============================================
// دوال العرض الرئيسية
// ============================================
// showToast: alias لـ showNotification (للتوافق معية الاستدعاءات القديمة)
function showToast(message, type) {
    if (type === 'alert') type = 'warning';
    showNotification('', message, type, 5000);
}

async function loadAllData() {
    try {
        var response = await AuthManager.apiRequest('/api/data');
        var result = await response.json();
        // Protect centersData: don't overwrite with empty from server
        if (result.centers && Object.keys(result.centers).length > 0) {
            centersData = result.centers;
        } else if (Object.keys(centersData).length === 0) {
            centersData = result.centers || {};
        }
        // Otherwise keep existing centersData (has team-to-center mapping)
        
        // Build default centersData if still empty (e.g. new shift, first load)
        if (Object.keys(centersData).length === 0) {
            centersData = {
                "المنصورة": ["جنوب 1", "جنوب 11", "جنوب 12", "سريع 3"],
                "الخالدية": ["جنوب 2"],
                "منفوحة": ["جنوب 3"],
                "الدار البيضاء": ["جنوب 4", "جنوب 5", "سريع 1"],
                "الإسكان": ["جنوب 6"],
                "الحائر": ["جنوب 7"],
                "ديراب": ["جنوب 10"],
                "عكاظ": ["جنوب 9"],
                "الشفاء": ["جنوب 8", "سريع 2"],
                "الفرق الإضافية": ["سريع 4", "جنوب 13", "جنوب 14", "جنوب 15", "جنوب 16", "جنوب 17", "جنوب 18", "جنوب 19"]
            };
        }
        if (result.centers && Object.keys(result.centers).length > 0) {
            centersData = result.centers;
        } else if (Object.keys(centersData).length === 0) {
            centersData = result.centers || {};
        }
        // Otherwise keep existing centersData (has team-to-center mapping)
        if (!isViewingArchiveShift) {
            reports = result.data;
            updateTotal();
            calculateLiveReportStats();
            updateWorkforceStats();
            updateDistributionIndicator();
            
            var distModal = document.getElementById('distributionModal');
            if (distModal && distModal.style.display === 'flex') {
                renderAdvancedDistribution();
            }
        }
        currentShiftId = result.currentShiftId || null;
        if (currentShiftId) {
            // Phase 2+3: currentShiftId is server-managed
        }
        updateShiftStatus();
        document.getElementById("updateStatus").innerHTML = '<i class="fas fa-circle" style="color:#34D399;font-size:7px;"></i> متصل | آخر تحديث: ' + getSaudiTime();

        // Hide skeleton loading screen when data is loaded
        hideSkeleton();
    } catch (error) {
        console.error('خطأ في تحميل البيانات:', error);
        hideSkeleton();
    }
}

// إجمالي البلاغات الفريدة من ملخص المحرك (قرار المالك 2026-08-22): بلاغ واحد بأربع
// فرق = بلاغ واحد. يُملأ من /api/cad-reports؛ وNULL قبل وصوله = السقوط للسلوك القديم
var cadReportsTotal = null;

function updateTotal() {
    var total = 0;
    for (var key in reports) { if (reports[key] && reports[key].count) total += reports[key].count; }
    var grandTotalEl = document.getElementById("grandTotal");
    // مجموع reports.count = «مشاركات الفرق» — مقام توزيع الفرق فقط، لا يُعرض عددَ بلاغات.
    if (grandTotalEl) grandTotalEl.innerText = (cadReportsTotal !== null) ? cadReportsTotal : total;
}

function updateShiftStatus() {
    try {
        var status = document.getElementById('shiftStatus');
        if (status) status.style.display = 'none';
        
        // Always show current time-based shift type
        var currentType = (typeof getCurrentShiftType === 'function') ? getCurrentShiftType() : 'صباح';
        
        // ============================================
        // Update SMART-TOPBAR button (currentShiftBtn)
        // ============================================
        var currentShiftBtn = document.getElementById('currentShiftBtn');
        var currentShiftDisplay = document.getElementById('currentShiftDisplay');
        
        if (currentShiftBtn) {
            currentShiftBtn.disabled = false;
            currentShiftBtn.style.cursor = 'pointer';
            currentShiftBtn.style.opacity = '1';
            currentShiftBtn.style.display = 'inline-flex';
            currentShiftBtn.onclick = function() { startNewShift(); };
            // Add visual class based on shift state
            if (currentShiftId) {
                currentShiftBtn.classList.remove('qa-btn-inactive');
                currentShiftBtn.classList.add('qa-btn-active');
            } else {
                currentShiftBtn.classList.remove('qa-btn-active');
                currentShiftBtn.classList.add('qa-btn-inactive');
            }
        }
        
        if (currentShiftDisplay) {
            if (currentShiftId) {
                var shift = null;
                if (Array.isArray(allShifts) && allShifts.length > 0) {
                    shift = allShifts.find(function(s) { return s.id === currentShiftId; });
                }
                if (shift) {
                    currentShiftDisplay.innerHTML = '<span style="font-size:0.8rem; opacity:0.8;">' + (shift.shiftDate || '') + '</span><br><strong>✅ ' + (shift.shiftType || 'مناوبة') + ' نشطة</strong>';
                } else {
                    currentShiftDisplay.innerHTML = '<strong>✅ مناوبة نشطة</strong>';
                }
            } else {
                currentShiftDisplay.innerHTML = '<strong>➕ مناوبة جديدة (' + currentType + ')</strong>';
            }
        }
        
        // ============================================
        // Update OLD TOOLBAR button (newShiftBtn) if it exists
        // ============================================
        var btn = document.getElementById('newShiftBtn');
        var btnDot = document.getElementById('newShiftDot');
        var btnText = document.getElementById('newShiftText');
        
        if (btn && btnDot && btnText) {
            btn.disabled = false;
            btn.style.cursor = 'pointer';
            btn.style.opacity = '1';
            btn.style.display = 'inline-flex';
            
            if (currentShiftId) {
                var shift = null;
                if (Array.isArray(allShifts) && allShifts.length > 0) {
                    shift = allShifts.find(function(s) { return s.id === currentShiftId; });
                }
                btn.className = 'btn btn-shift-status on';
                btnDot.style.display = 'inline-block';
                if (shift) {
                    btnText.textContent = '✅ ' + (shift.shiftType || 'مناوبة') + ' نشطة';
                } else {
                    btnText.textContent = '✅ مناوبة نشطة';
                }
            } else {
                btn.className = 'btn btn-shift-status off';
                btnDot.style.display = 'inline-block';
                btnText.textContent = 'مناوبة جديدة (' + currentType + ')';
            }
        }
        
        updateShiftsHistoryWidget();
    } catch (err) {
        console.error('[updateShiftStatus] Error:', err);
    }
}

function updateShiftsHistoryWidget() {
    var select = document.getElementById('archiveModalSelect');
    if (!select) return;
    
    // Clear and add default option
    select.innerHTML = '<option value="">-- اختر التاريخ --</option>';
    
    if (!Array.isArray(allShifts) || allShifts.length === 0) {
        return;
    }
    
    // Add previous shifts (exclude current active)
    var previousShifts = allShifts.filter(function(s) { return s.id !== currentShiftId; });
    previousShifts.sort(function(a, b) { return b.id - a.id; });
    
    previousShifts.forEach(function(shift) {
        var option = document.createElement('option');
        option.value = shift.id;
        var typeLabel = (shift.shiftType === 'صباحية' || shift.shiftType === 'morning') ? 'صباحي' : 'ليلي';
        var date = shift.shiftDate || '';
        var total = shift.totalReports || 0;
        option.textContent = typeLabel + ' - ' + date + ' (' + total + ' بلاغ)';
        select.appendChild(option);
    });
}

function openShiftArchiveModal() {
    var el_shiftArchiveModal_d16 = document.getElementById('shiftArchiveModal'); if (el_shiftArchiveModal_d16) el_shiftArchiveModal_d16.style.display = 'flex';
    updateShiftsHistoryWidget();
    clearArchiveSummary();
}

function clearArchiveSummary() {
    var area = document.getElementById('archiveTabContentArea');
    if (area) {
        area.style.display = 'none';
        area.innerHTML = '';
    }
    window._currentArchiveData = null;
    // Reset tab buttons
    document.querySelectorAll('.archive-tab-btn').forEach(function(btn) {
        btn.classList.remove('active');
    });
    var summaryBtn = document.querySelector('.archive-tab-btn[data-tab="summary"]');
    if (summaryBtn) summaryBtn.classList.add('active');
}

function editSelectedArchiveShift() {
    var select = document.getElementById('archiveModalSelect');
    if (!select || !select.value) {
        alert('الرجاء اختيار مناوبة من القائمة');
        return;
    }
    var shiftId = parseInt(select.value);
    var shift = allShifts.find(function(s) { return s.id === shiftId; });
    if (!shift) {
        alert('المناوبة غير موجودة');
        return;
    }
    // Redirect to radio-completion with date and type
    var shiftType = shift.shiftType || 'صباح';
    var shiftDate = shift.shiftDate || '';
    var url = 'radio-completion.html?v=34';
    if (shiftDate) {
        url += '&date=' + encodeURIComponent(shiftDate) + '&type=' + encodeURIComponent(shiftType);
    }
    window.location.href = url;
}

async function viewSelectedArchiveShift() {
    var select = document.getElementById('archiveModalSelect');
    if (!select || !select.value) {
        alert('الرجاء اختيار مناوبة من القائمة');
        return;
    }
    var shiftId = parseInt(select.value);
    
    // Show loading state
    var contentArea = document.getElementById('archiveTabContentArea');
    if (contentArea) {
        contentArea.innerHTML = '<div style="text-align:center; padding:40px; color:var(--gray-500);"><i class="fas fa-spinner fa-spin" style="font-size:1.5rem; margin-bottom:10px; display:block;"></i>جاري تحميل البيانات...</div>';
    }
    
    try {
        var response = await AuthManager.apiRequest('/api/shifts/' + shiftId);
        var result = await response.json();
        if (!result || !result.shift) {
            alert('المناوبة غير موجودة');
            return;
        }
        
        // Store data for tab switching
        window._currentArchiveData = result;
        
        // Show content area
        if (contentArea) contentArea.style.display = 'block';
        
        // Switch to summary tab by default
        switchArchiveTab('summary');
        
    } catch (err) {
        console.error('Error loading archive shift data:', err);
        alert('❌ فشل في تحميل بيانات المناوبة');
    }
}

function switchArchiveTab(tabName) {
    var data = window._currentArchiveData;
    if (!data) return;
    
    // Update tab buttons
    document.querySelectorAll('.archive-tab-btn').forEach(function(btn) {
        btn.classList.remove('active');
    });
    var activeBtn = document.querySelector('.archive-tab-btn[data-tab="' + tabName + '"]');
    if (activeBtn) activeBtn.classList.add('active');
    
    var container = document.getElementById('archiveTabContentArea');
    if (!container) return;
    
    var shift = data.shift || {};
    var totalReports = data.total || Object.keys(data.reports || {}).reduce(function(sum, key) { return sum + ((data.reports[key] && data.reports[key].count) || 0); }, 0);
    
    switch(tabName) {
        case 'summary':
            renderArchiveSummaryTab(container, shift, totalReports);
            break;
        case 'reports':
            renderArchiveReportsTab(container, data.reports, totalReports);
            break;
        case 'completion':
            renderArchiveCompletionTab(container, data.completions, shift);
            break;
        case 'forms':
            renderArchiveFormsTab(container, data.forms);
            break;
        case 'audit':
            renderArchiveAuditTab(container, data.audit_log);
            break;
        case 'files':
            renderArchiveFilesTab(container, data.files);
            break;
    }
}

function renderArchiveSummaryTab(container, shift, totalReports) {
    var typeLabel = (shift.shiftType === 'صباح' || shift.shiftType === 'morning' || shift.shiftType === 'صباحية') ? 'صباحي' : 'ليلي';
    var date = shift.shiftDate || '-';
    var createdAt = shift.createdAt ? TimeRiyadh.formatDateTimeSec(shift.createdAt) : '-';
    var updatedAt = shift.updatedAt ? TimeRiyadh.formatDateTimeSec(shift.updatedAt) : '-';
    
    container.innerHTML = 
        '<div class="archive-tab-content">' +
            '<div class="archive-summary-grid">' +
                '<div class="archive-summary-card">' +
                    '<div class="archive-summary-icon"><i class="fas fa-calendar-alt"></i></div>' +
                    '<div class="archive-summary-value">' + date + '</div>' +
                    '<div class="archive-summary-label">تاريخ المناوبة</div>' +
                '</div>' +
                '<div class="archive-summary-card">' +
                    '<div class="archive-summary-icon"><i class="fas fa-sun"></i></div>' +
                    '<div class="archive-summary-value">' + typeLabel + '</div>' +
                    '<div class="archive-summary-label">نوع المناوبة</div>' +
                '</div>' +
                '<div class="archive-summary-card">' +
                    '<div class="archive-summary-icon"><i class="fas fa-file-alt"></i></div>' +
                    '<div class="archive-summary-value">' + totalReports + '</div>' +
                    '<div class="archive-summary-label">إجمالي البلاغات</div>' +
                '</div>' +
                '<div class="archive-summary-card">' +
                    '<div class="archive-summary-icon"><i class="fas fa-clock"></i></div>' +
                    '<div class="archive-summary-value">' + createdAt + '</div>' +
                    '<div class="archive-summary-label">تاريخ الإنشاء</div>' +
                '</div>' +
            '</div>' +
            '<div class="archive-section">' +
                '<h4><i class="fas fa-sticky-note"></i> ملاحظات المناوبة</h4>' +
                '<div class="archive-notes-box">' + (shift.generalNotes || 'لا توجد ملاحظات') + '</div>' +
            '</div>' +
        '</div>';
}

function renderArchiveReportsTab(container, reports, totalReports) {
    if (!reports || Object.keys(reports).length === 0) {
        container.innerHTML = '<div class="archive-tab-content"><div class="archive-empty"><i class="fas fa-inbox"></i><p>لا توجد بلاغات في هذه المناوبة</p></div></div>';
        return;
    }
    
    var rows = '';
    var keys = Object.keys(reports).sort();
    for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        var r = reports[key];
        if (!r || r.count === 0) continue;
        var parts = key.split('|');
        var center = parts[0] || '-';
        var unit = parts[1] || '-';
        rows += 
            '<tr>' +
                '<td>' + (i + 1) + '</td>' +
                '<td>' + center + '</td>' +
                '<td>' + unit + '</td>' +
                '<td><span class="archive-badge archive-badge-primary">' + r.count + '</span></td>' +
            '</tr>';
    }
    
    container.innerHTML = 
        '<div class="archive-tab-content">' +
            '<div class="archive-table-wrapper">' +
                '<table class="archive-table">' +
                    '<thead>' +
                        '<tr>' +
                            '<th>#</th>' +
                            '<th>المركز</th>' +
                            '<th>الفرقة</th>' +
                            '<th>العدد</th>' +
                        '</tr>' +
                    '</thead>' +
                    '<tbody>' + rows + '</tbody>' +
                '</table>' +
            '</div>' +
            '<div class="archive-footer-stats">إجمالي البلاغات: <strong>' + totalReports + '</strong></div>' +
        '</div>';

    // P1-S7: فرز الأعمدة (العدد رقمي تلقائياً) — الترتيب الافتراضي لا يتغير إلا بنقرة صريحة
    if (window.TableSort) TableSort.makeSortable(container.querySelector('table.archive-table'));
}

function renderArchiveCompletionTab(container, completion, shift) {
    // Treat empty arrays as falsy so shift.centersData can be used as fallback
    var hasCompletion = completion && !(Array.isArray(completion) && completion.length === 0);
    if (!hasCompletion && !shift.centersData) {
        container.innerHTML = '<div class="archive-tab-content"><div class="archive-empty"><i class="fas fa-inbox"></i><p>لا توجد بيانات تكميل لهذه المناوبة</p></div></div>';
        return;
    }
    
    var data = (hasCompletion ? completion : null) || shift.centersData || {};
    var rows = '';
    var keys = Object.keys(data).sort();
    for (var i = 0; i < keys.length; i++) {
        var team = keys[i];
        var teamData = data[team];
        if (!teamData) continue;
        var status = teamData.status || (teamData.staffCount && parseInt(teamData.staffCount) > 0 ? 'ready' : teamData.vehicleStatus === 'offline' || teamData.vehicleStatus === 'عاطلة' ? 'offline' : 'missing');
        var statusLabels = { ready: '✅ جاهز', missing: '⚠️ ناقص', offline: '🔴 خارج الخدمة' };
        var statusClass = 'archive-badge-' + status;
        rows += 
            '<tr>' +
                '<td>' + team + '</td>' +
                '<td>' + (teamData.staffCount || '-') + '</td>' +
                '<td>' + (teamData.carsCount || '-') + '</td>' +
                '<td><span class="archive-badge ' + statusClass + '">' + (statusLabels[status] || status) + '</span></td>' +
            '</tr>';
    }
    
    container.innerHTML = 
        '<div class="archive-tab-content">' +
            '<div class="archive-table-wrapper">' +
                '<table class="archive-table">' +
                    '<thead>' +
                        '<tr>' +
                            '<th>الفريق</th>' +
                            '<th>المسعفين</th>' +
                            '<th>المركبات</th>' +
                            '<th>الحالة</th>' +
                        '</tr>' +
                    '</thead>' +
                    '<tbody>' + rows + '</tbody>' +
                '</table>' +
            '</div>' +
        '</div>';
}

function renderArchiveFormsTab(container, forms) {
    if (!forms || forms.length === 0) {
        container.innerHTML = '<div class="archive-tab-content"><div class="archive-empty"><i class="fas fa-inbox"></i><p>لا توجد نماذج في هذه المناوبة</p></div></div>';
        return;
    }
    
    var rows = '';
    for (var i = 0; i < forms.length; i++) {
        var f = forms[i];
        rows += 
            '<tr>' +
                '<td>' + (f.name || f.title || 'نموذج') + '</td>' +
                '<td>' + (f.createdAt ? TimeRiyadh.formatDateTimeSec(f.createdAt) : '-') + '</td>' +
                '<td>' + (f.status || 'مكتمل') + '</td>' +
            '</tr>';
    }
    
    container.innerHTML = 
        '<div class="archive-tab-content">' +
            '<div class="archive-table-wrapper">' +
                '<table class="archive-table">' +
                    '<thead>' +
                        '<tr>' +
                            '<th>اسم النموذج</th>' +
                            '<th>التاريخ</th>' +
                            '<th>الحالة</th>' +
                        '</tr>' +
                    '</thead>' +
                    '<tbody>' + rows + '</tbody>' +
                '</table>' +
            '</div>' +
        '</div>';
}

function renderArchiveAuditTab(container, auditLog) {
    if (!auditLog || auditLog.length === 0) {
        container.innerHTML = '<div class="archive-tab-content"><div class="archive-empty"><i class="fas fa-inbox"></i><p>لا توجد سجلات عمليات في هذه المناوبة</p></div></div>';
        return;
    }
    
    var rows = '';
    for (var i = 0; i < auditLog.length; i++) {
        var e = auditLog[i];
        var time = e.timestamp ? TimeRiyadh.formatDateTimeSec(e.timestamp) : '-';
        rows += 
            '<tr>' +
                '<td>' + (e.action || '-') + '</td>' +
                '<td>' + (e.detail || '-') + '</td>' +
                '<td>' + (e.user || '-') + '</td>' +
                '<td>' + time + '</td>' +
            '</tr>';
    }
    
    container.innerHTML = 
        '<div class="archive-tab-content">' +
            '<div class="archive-table-wrapper">' +
                '<table class="archive-table">' +
                    '<thead>' +
                        '<tr>' +
                            '<th>الإجراء</th>' +
                            '<th>التفاصيل</th>' +
                            '<th>المستخدم</th>' +
                            '<th>الوقت</th>' +
                        '</tr>' +
                    '</thead>' +
                    '<tbody>' + rows + '</tbody>' +
                '</table>' +
            '</div>' +
        '</div>';
}

function renderArchiveFilesTab(container, files) {
    if (!files || files.length === 0) {
        container.innerHTML = '<div class="archive-tab-content"><div class="archive-empty"><i class="fas fa-inbox"></i><p>لا توجد ملفات في هذه المناوبة</p></div></div>';
        return;
    }
    
    var rows = '';
    for (var i = 0; i < files.length; i++) {
        var f = files[i];
        rows += 
            '<tr>' +
                '<td><i class="fas fa-file" style="color:var(--primary-700); margin-left:6px;"></i>' + (f.name || f.fileName || '-') + '</td>' +
                '<td>' + (f.category || 'عام') + '</td>' +
                '<td>' + (f.size ? (f.size > 1024 ? (f.size/1024).toFixed(1) + ' KB' : f.size + ' B') : '-') + '</td>' +
                '<td>' + (f.createdAt ? TimeRiyadh.formatDateTimeSec(f.createdAt) : '-') + '</td>' +
            '</tr>';
    }
    
    container.innerHTML = 
        '<div class="archive-tab-content">' +
            '<div class="archive-table-wrapper">' +
                '<table class="archive-table">' +
                    '<thead>' +
                        '<tr>' +
                            '<th>اسم الملف</th>' +
                            '<th>التصنيف</th>' +
                            '<th>الحجم</th>' +
                            '<th>التاريخ</th>' +
                        '</tr>' +
                    '</thead>' +
                    '<tbody>' + rows + '</tbody>' +
                '</table>' +
            '</div>' +
        '</div>';
}

function selectShiftFromHistory(shiftId) {
    if (!shiftId) {
        // Return to current shift view
        viewingShiftId = null;
        isViewingArchiveShift = false;
        var badge = document.getElementById('viewingBadge');
        if (badge) badge.style.display = 'none';
        var returnBtn = document.getElementById('returnToCurrentBtn');
        if (returnBtn) returnBtn.style.display = 'none';
        loadAllData();
        updateShiftStatus();
        return;
    }
    
    var shiftIdNum = parseInt(shiftId);
    var shift = allShifts.find(function(s) { return s.id === shiftIdNum; });
    if (!shift) return;
    
    // Set viewing mode
    viewingShiftId = shiftIdNum;
    isViewingArchiveShift = true;
    
    // Update badge
    var badge = document.getElementById('viewingBadge');
    if (badge) {
        badge.style.display = 'inline-block';
        badge.textContent = '📂 تعرض: ' + (shift.shiftType || 'مناوبة') + ' - ' + (shift.shiftDate || '');
    }
    var returnBtn = document.getElementById('returnToCurrentBtn');
    if (returnBtn) returnBtn.style.display = 'inline-block';
    
    // Load shift data including reports from server
    AuthManager.apiRequest('/api/shifts/' + shiftIdNum)
        .then(function(r) { return r.json(); })
        .then(function(result) {
            if (result.shift) {
                // Update global data
                currentViewingShift = result.shift;
                currentViewingShiftData = result;
                reports = result.reports || {};
                // Don't overwrite centersData with shift form data (different structure)
                // centersData from /api/data is the unit mapping {center: [units]}
                // shift.centersData is form data {center: {staffCount, carsCount, ...}}
                // Keep the global centersData which is already loaded from /api/data
                
                // Update UI
                updateTotal();
                calculateLiveReportStats();
                updateWorkforceStats();
                updateDistributionIndicator();
                
                // Update archive summary card
                var totalReports = result.total || Object.keys(result.reports || {}).reduce(function(sum, key) { return sum + (result.reports[key]?.count || 0); }, 0);
                updateArchiveSummaryCard(result.shift, totalReports);
                
                // Open shift modal with the selected shift data
                var el_shiftModal_d18 = document.getElementById('shiftModal'); if (el_shiftModal_d18) el_shiftModal_d18.style.display = 'flex';
                loadShiftToForm(result.shift);
                
                // Refresh distribution if open
                var distModal = document.getElementById('distributionModal');
                if (distModal && distModal.style.display === 'flex') {
                    renderAdvancedDistribution();
                }
                
                // Refresh charts if open
                var chartsModal = document.getElementById('chartsModal');
                if (chartsModal && chartsModal.style.display === 'flex') {
                    renderAllCharts();
                }
                
                showNotification('✅ تم تحميل بيانات المناوبة', 'success');
            }
        })
        .catch(function(err) {
            console.error('Error loading shift data:', err);
            showNotification('⚠️ خطأ في تحميل بيانات المناوبة', 'warning');
        });
}

function loadShiftArchive(shiftId) {
    // Compatibility function for direct clicks
    selectShiftFromHistory(shiftId);
}

// Archive summary card for past shifts
function updateArchiveSummaryCard(shift, totalReports) {
    var card = document.getElementById('archiveSummaryCard');
    if (!card) return;
    if (!shift) {
        card.style.display = 'none';
        return;
    }
    card.style.display = 'block';
    var typeLabel = (shift.shiftType === 'صباح' || shift.shiftType === 'morning' || shift.shiftType === 'صباحية') ? 'صباحي' : 'ليلي';
    var date = shift.shiftDate || '-';
    var total = totalReports || shift.totalReports || 0;
    card.innerHTML = 
        '<div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px;">' +
            '<div style="display:flex; align-items:center; gap:16px; flex-wrap:wrap;">' +
                '<div style="display:flex; align-items:center; gap:8px;">' +
                    '<span style="background:var(--primary-700); color:#fff; padding:6px 12px; border-radius:var(--radius-md); font-size:0.8rem; font-weight:700;">' + typeLabel + '</span>' +
                    '<span style="font-weight:600; color:var(--gray-800);"><i class="far fa-calendar-alt" style="color:var(--primary-700); margin-left:6px;"></i>' + date + '</span>' +
                '</div>' +
                '<div style="display:flex; align-items:center; gap:6px; background:var(--primary-50); padding:4px 12px; border-radius:var(--radius-md);">' +
                    '<i class="fas fa-file-alt" style="color:var(--primary-700); font-size:0.8rem;"></i>' +
                    '<span style="font-weight:700; color:var(--primary-700); font-size:0.9rem;">' + total + '</span>' +
                    '<span style="font-size:0.75rem; color:var(--gray-600);">بلاغ</span>' +
                '</div>' +
            '</div>' +
            '<button onclick="openShiftArchiveModalForCurrentView()" class="btn btn-primary" style="padding:6px 16px; font-size:0.8rem;">' +
                '<i class="fas fa-eye"></i> عرض التفاصيل الكاملة' +
            '</button>' +
        '</div>';
}

function openShiftArchiveModalForCurrentView() {
    if (!viewingShiftId || !currentViewingShift) {
        alert('الرجاء اختيار مناوبة أولاً');
        return;
    }
    // Pre-select the current viewing shift in the archive modal
    var archiveModalSelect = document.getElementById('archiveModalSelect');
    if (archiveModalSelect) archiveModalSelect.value = viewingShiftId;
    openShiftArchiveModal();
    // Auto-load the selected shift data
    setTimeout(function() {
        viewSelectedArchiveShift();
    }, 100);
}

function openShiftArchiveModalForShift(shiftId) {
    if (!shiftId) {
        openShiftArchiveModal();
        return;
    }
    var archiveModalSelect = document.getElementById('archiveModalSelect');
    if (archiveModalSelect) archiveModalSelect.value = shiftId;
    openShiftArchiveModal();
    setTimeout(function() {
        viewSelectedArchiveShift();
    }, 100);
}

function updateUnitCounter(center, unit) {
    var key = center + '|' + unit;
    var count = reports[key] ? reports[key].count : 0;
    
    var unitId = 'count-' + center.replace(/\s/g, '') + '-' + unit.replace(/\s/g, '');
    var countElement = document.getElementById(unitId);
    if (countElement) {
        countElement.textContent = count;
        countElement.className = 'unit-count' + (count === 0 ? ' zero' : '');
    }
    
    var badgeId = 'unit-' + center.replace(/\s/g, '') + '-' + unit.replace(/\s/g, '') + ' .unit-badge';
    var badgeElement = document.querySelector(badgeId);
    if (badgeElement) {
        if (count > 0) {
            badgeElement.textContent = count;
            badgeElement.style.display = 'inline-block';
        } else {
            badgeElement.style.display = 'none';
        }
    }
    
    var unitItem = document.getElementById('unit-' + center.replace(/\s/g, '') + '-' + unit.replace(/\s/g, ''));
    if (unitItem) {
        var undoBtn = unitItem.querySelector('.undo-btn');
        if (undoBtn) {
            if (count > 0) {
                undoBtn.style.display = 'inline-flex';
            } else {
                undoBtn.style.display = 'none';
            }
        }
    }
}

function calculateLiveReportStats() {
    var container = document.getElementById('liveReportStats');
    if (!container) return;
    var total = 0;
    var unitStats = {};
    for (var key in reports) {
        var report = reports[key];
        if (report && report.count > 0) {
            total += report.count;
            var parts = key.split('|');
            var unit = parts.length > 1 ? parts[1] : key;
            if (unit && unit.trim() !== '' && unit !== 'undefined' && unit !== 'null') {
                unitStats[unit] = (unitStats[unit] || 0) + report.count;
            }
        }
    }
    if (total === 0) { container.style.display = 'none'; return; }
    container.style.display = 'block';
    var el_liveTotalReports = document.getElementById('liveTotalReports'); if (el_liveTotalReports) el_liveTotalReports.innerText = total;
    var sortedUnits = Object.entries(unitStats).sort(function(a, b) { return b[1] - a[1]; });
    var topUnit = sortedUnits.length > 0 ? sortedUnits[0][0] : '-';
    var topCount = sortedUnits.length > 0 ? sortedUnits[0][1] : 0;
    var el_liveTopUnit = document.getElementById('liveTopUnit'); if (el_liveTopUnit) el_liveTopUnit.innerText = topUnit;
    var el_liveTopUnitCount = document.getElementById('liveTopUnitCount'); if (el_liveTopUnitCount) el_liveTopUnitCount.innerText = topCount;

    // Type breakdown
    var typeBreakdown = getShiftTypeBreakdown();
    var typeListContainer = document.getElementById('liveTypeList');
    if (typeListContainer) {
        typeListContainer.innerHTML = '';
        var typeEntries = Object.entries(typeBreakdown).sort(function(a, b) { return b[1] - a[1]; });
        if (typeEntries.length === 0) {
            typeListContainer.innerHTML = '<div class="distribution-empty"><i class="fas fa-inbox"></i><span>لا توجد بيانات</span></div>';
        } else {
            typeEntries.forEach(function(item, index) {
                var td = REPORT_TYPE_DEFS[item[0]];
                var percentage = total > 0 ? Math.round((item[1] / total) * 100) : 0;
                var color = td ? td.color : '#60A5FA';
                var div = document.createElement('div');
                div.className = 'distribution-item';
                div.innerHTML = '<div class="distribution-item-rank rank-other">' + (td ? td.emoji : '📦') + '</div>' +
                    '<div class="distribution-item-info">' +
                        '<div class="distribution-item-name">' + (td ? td.label : item[0]) + '</div>' +
                        '<div class="distribution-item-bar-track">' +
                            '<div class="distribution-item-bar-fill" style="width:' + percentage + '%; background:' + color + ';"></div>' +
                        '</div>' +
                    '</div>' +
                    '<div class="distribution-item-meta">' +
                        '<span class="distribution-item-count">' + item[1] + '</span>' +
                        '<span class="distribution-item-percent">' + percentage + '%</span>' +
                    '</div>';
                typeListContainer.appendChild(div);
            });
        }
    }

    var listContainer = document.getElementById('liveUnitList');
    listContainer.innerHTML = '';
    if (sortedUnits.length === 0) {
        listContainer.innerHTML = '<div class="distribution-empty"><i class="fas fa-inbox"></i><span>لا توجد بيانات</span></div>';
        return;
    }
    var colors = ['#60A5FA', '#10B586', '#F59E0B', '#EF4444', '#C4B5FD', '#67E8F9', '#FCD34D'];
    var grandTotal = total;
    sortedUnits.forEach(function(item, index) {
        var percentage = Math.round((item[1] / grandTotal) * 100);
        var color = colors[index % colors.length];
        var rankClass = index === 0 ? 'rank-1' : index === 1 ? 'rank-2' : index === 2 ? 'rank-3' : 'rank-other';
        var rankNum = index + 1;
        var div = document.createElement('div');
        div.className = 'distribution-item';
        div.innerHTML = '<div class="distribution-item-rank ' + rankClass + '">' + rankNum + '</div>' +
            '<div class="distribution-item-info">' +
                '<div class="distribution-item-name">' + item[0] + '</div>' +
                '<div class="distribution-item-bar-track">' +
                    '<div class="distribution-item-bar-fill" style="width:' + percentage + '%; background:' + color + ';"></div>' +
                '</div>' +
            '</div>' +
            '<div class="distribution-item-meta">' +
                '<span class="distribution-item-count">' + item[1] + '</span>' +
                '<span class="distribution-item-percent">' + percentage + '%</span>' +
            '</div>';
        listContainer.appendChild(div);
    });
}

// ============================================
// مؤشرات القوى العاملة
// ============================================
// VA: مرآة لحظية لشاشة التكميل من نفس المصدر (SSOT) — GET /api/staffing/state
// يعيد workforce المشتق سيرفريًا (totalStaff/totalCars/readinessRate/missingTeams).
// لا حساب محلي إطلاقًا هنا: الأرقام تُعرض كما تصل، و«—» الصادقة عند غياب البيانات.
var workforceStateTeams = null; // مرآة فرق مشتقة سيرفريًا (تُقرأ فقط — لا تُحسب)

function updateWorkforceStats() {
    if (!AuthManager.isLoggedIn()) { updateWorkforceStatsFallback(); return; }
    var url = '/api/staffing/state';
    if (currentShiftId) url += '?shift_id=' + encodeURIComponent(currentShiftId);
    AuthManager.apiRequest(url)
    .then(function(r) { return r.json(); })
    .then(function(data) {
        if (data && data.success && data.workforce) {
            workforceStateTeams = data.teams || null;
            updateWorkforceDisplay(data.workforce);
            lastWorkforce = data.workforce;
            renderResourcesStrip();
            renderOperationalFocus();
            updateOperationalMap();
        } else {
            updateWorkforceStatsFallback();
        }
    })
    .catch(function(e) {
        console.log('[updateWorkforceStats] staffing state fetch failed, using fallback:', e);
        updateWorkforceStatsFallback();
    });
}

function updateWorkforceStatsFallback() {
    // F5b/VA: لا مصدر حقيقي متاح ⇒ الحالة الصادقة «—» (لا افتراضي مختلق إطلاقًا)
    workforceStateTeams = null;
    updateWorkforceDisplay(null);
    lastWorkforce = null;
    renderResourcesStrip();
    renderOperationalFocus();
    updateOperationalMap();
}

// VA: مُنعش موحّد من المصدر الواحد — يحل محل الحساب المحلي المحذوف نهائيًا.
// مُهرب (debounced) حتى لا يُجهد الخادم عند الاستدعاءات المتتالية (أحداث SSE).
var _wfRefreshTimer = null;
function refreshWorkforceFromServer(shiftId) {
    if (_wfRefreshTimer) clearTimeout(_wfRefreshTimer);
    _wfRefreshTimer = setTimeout(function() {
        _wfRefreshTimer = null;
        refreshResourcesAux(); // مرافق لتحديث القوى: يجلب الدعم المتاح ومؤشرات المركبات
        refreshEventsAux();    // مرافق للأحداث: يجلب الخط الزمني والإعلانات
        updateWorkforceStats();
    }, 400);
}

// SR-1: العرض من كائن workforce المشتق سيرفريًا حرفيًا — بلا أهداف مختلقة
// (حُذفت «/30 هدف» و«/20 هدف» و«/10 مركز» ومقارنات «الأسبوع الماضي»).
// UAT-1: التقسيم الجديد — قسم «القوى البشرية» (المجدول/الحاضر/الغياب/الدعم
// المؤقت) وقسم «الجاهزية التشغيلية» (الفرق المطلوبة/الجاهزة/نسبة الجاهزية).
// نسبة الجاهزية = operationalReadinessRate سيرفريًا (الجاهزة ÷ المطلوبة).
function updateWorkforceDisplay(wf) {
    var honest = !wf || wf.operationalReadinessRate == null;
    var scheduledStaff = honest ? '—' : (wf.scheduledStaff != null ? wf.scheduledStaff : '—');
    var totalStaff = honest ? '—' : wf.totalStaff;
    var totalCars = honest ? '—' : wf.totalCars;
    var readiness = honest ? 0 : wf.operationalReadinessRate;
    var missingTeams = honest ? '—' : (wf.missingTeams || 0);
    var requiredTeams = honest ? 0 : (wf.requiredTeams || 0);
    var scheduledNum = (!honest && typeof wf.scheduledStaff === 'number') ? wf.scheduledStaff : 0;
    var totalTeams = honest ? 0 : ((wf.readyTeams || 0) + (wf.missingTeams || 0) + (wf.offlineTeams || 0) + (wf.pendingTeams || 0));

    // قسم القوى البشرية
    animateValue('wfScheduledStaff', scheduledStaff);
    animateValue('wfTotalStaff', totalStaff);
    animateValue('wfAbsentees', honest ? '—' : (wf.absentees || 0));
    animateValue('wfSupporters', honest ? '—' : (wf.supporters || 0));

    // قسم الجاهزية التشغيلية
    animateValue('wfRequiredTeams', honest ? '—' : requiredTeams);
    animateValue('wfReadyTeams', honest ? '—' : (wf.readyTeams || 0));
    var el_wfReadiness = document.getElementById('wfReadiness'); if (el_wfReadiness) el_wfReadiness.innerText = honest ? '—' : readiness + '%';
    var el_wfMissingCenters = document.getElementById('wfMissingCenters'); if (el_wfMissingCenters) el_wfMissingCenters.innerText = missingTeams;
    animateValue('wfTotalCars', totalCars);

    var staffPct = (honest || scheduledNum <= 0) ? 0 : Math.min((wf.totalStaff / scheduledNum) * 100, 100);
    var missingPct = (honest || totalTeams <= 0) ? 0 : Math.min(((wf.missingTeams || 0) / totalTeams) * 100, 100);

    var el_wfStaffProgress = document.getElementById('wfStaffProgress'); if (el_wfStaffProgress) el_wfStaffProgress.style.width = staffPct + '%';
    var el_wfReadinessProgress = document.getElementById('wfReadinessProgress'); if (el_wfReadinessProgress) el_wfReadinessProgress.style.width = (honest ? 0 : readiness) + '%';
    var el_wfMissingProgress = document.getElementById('wfMissingProgress'); if (el_wfMissingProgress) el_wfMissingProgress.style.width = missingPct + '%';
    // السيارات: لا مقام حقيقي متاح في workforce ⇒ يُخفى الشريط ويُعرض العدد نصًا فقط
    var el_wfCarsProgress = document.getElementById('wfCarsProgress');
    if (el_wfCarsProgress && el_wfCarsProgress.parentElement) el_wfCarsProgress.parentElement.style.display = 'none';

    var el_wfStaffProgressText = document.getElementById('wfStaffProgressText'); if (el_wfStaffProgressText) el_wfStaffProgressText.innerText = honest ? '—' : (scheduledNum > 0 ? wf.totalStaff + ' حاضر من ' + scheduledNum + ' مجدول' : wf.totalStaff + ' حاضر');
    var el_wfCarsProgressText = document.getElementById('wfCarsProgressText'); if (el_wfCarsProgressText) el_wfCarsProgressText.innerText = honest ? '—' : wf.totalCars + ' مركبة عاملة';
    var el_wfReadinessProgressText = document.getElementById('wfReadinessProgressText'); if (el_wfReadinessProgressText) el_wfReadinessProgressText.innerText = honest ? '—' : readiness + '% جاهز (' + (wf.readyTeams || 0) + '/' + requiredTeams + ' فرقة)';
    var el_wfMissingProgressText = document.getElementById('wfMissingProgressText'); if (el_wfMissingProgressText) el_wfMissingProgressText.innerText = honest ? '—' : (wf.missingTeams || 0) + ' فرقة ناقصة';

    // الاتجاهات: لا مقارنة حقيقية متاحة ⇒ «—» محايد دائمًا (حُذفت خطوط الأساس المختلقة)
    var trendIds = ['wfStaffTrend', 'wfCarsTrend', 'wfReadinessTrend', 'wfMissingTrend'];
    for (var ti = 0; ti < trendIds.length; ti++) {
        var trendEl = document.getElementById(trendIds[ti]);
        if (trendEl) { trendEl.className = 'wf-card-trend neutral'; trendEl.innerText = '—'; }
    }

    var el_wfLastUpdate = document.getElementById('wfLastUpdate'); if (el_wfLastUpdate) el_wfLastUpdate.innerText = getSaudiTime();
}

// بؤرة التركيز التشغيلي — مركز قرار: تعرض حالات الفرق المشتقة سيرفريًا حرفيًا
// من مرآة workforceStateTeams (state.teams). كل ملاحظة تجيب سؤالين:
// «ما الذي يحدث؟» (الحالة السيرفرية) و«ما الإجراء؟» (زر فعل يقود لشاشة التكميل).
// التصنيف اللوني عرضي بحت: أحمر=إجراء فوري، أصفر=متابعة، أخضر=طبيعي —
// لا حساب جاهزية محلي إطلاقًا، وترتيب الفرق = ترتيب الخادم نفسه.
function renderOperationalFocus() {
    var listEl = document.getElementById('opsFocusList');
    var summaryEl = document.getElementById('opsFocusSummary');
    var summaryTxt = document.getElementById('opsFocusSummaryText');
    var badge = document.getElementById('opsFocusBadge');
    if (!listEl || !summaryEl || !badge) return;

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    var teams = workforceStateTeams;
    if (!teams) {
        // الحالة الصادقة: لا مصدر ⇒ «—» بلا افتراضي مختلق
        listEl.innerHTML = '';
        summaryEl.className = 'ops-focus-summary unknown';
        if (summaryTxt) summaryTxt.textContent = '— بانتظار بيانات الحالة';
        badge.className = 'ops-focus-badge';
        badge.textContent = '—';
        updateSidebarIndicators(null);
        return;
    }

    var missing = [], offline = [], pending = [], vehicle = [];
    for (var name in teams) {
        if (!teams.hasOwnProperty(name)) continue;
        var t = teams[name];
        if (!t) continue;
        if (t.status === 'missing') missing.push({ name: name, t: t });
        else if (t.status === 'offline') offline.push({ name: name, t: t });
        else if (t.status === 'pending') pending.push({ name: name, t: t });
        if (t.vehicleOk === false) vehicle.push({ name: name, t: t });
    }

    var critical = missing.length + offline.length + vehicle.length; // إجراء فوري
    var monitor = pending.length;                                     // متابعة
    var total = critical + monitor;

    // الملخص التنفيذي — جملة قرار واحدة بثلاث حالات
    if (total === 0) {
        summaryEl.className = 'ops-focus-summary green';
        if (summaryTxt) summaryTxt.textContent = 'لا توجد ملاحظات تشغيلية';
        badge.className = 'ops-focus-badge stable';
        badge.textContent = 'مستقر';
    } else if (critical > 0) {
        summaryEl.className = 'ops-focus-summary red';
        if (summaryTxt) {
            var critText = critical === 1 ? 'ملاحظة حرجة واحدة تتطلب إجراءً فوريًا'
                         : critical + ' ملاحظات حرجة تتطلب إجراءً فوريًا';
            if (monitor > 0) critText += ' — و' + monitor + ' للمتابعة';
            summaryTxt.textContent = critText;
        }
        badge.className = 'ops-focus-badge attention';
        badge.textContent = total + ' يتطلب الانتباه';
    } else {
        summaryEl.className = 'ops-focus-summary yellow';
        if (summaryTxt) summaryTxt.textContent = monitor === 1
            ? 'عنصر تشغيلي واحد يتطلب المتابعة'
            : monitor + ' عناصر تشغيلية تتطلب المتابعة';
        badge.className = 'ops-focus-badge monitor';
        badge.textContent = total + ' للمتابعة';
    }

    // مؤشرات الشريط الجانبي الذكي — من نفس تصنيف مركز القرار (لا حساب جديد)
    updateSidebarIndicators(critical, monitor);

    // كل عنصر = ما الذي يحدث + الإجراء (النقر يفتح شاشة التكميل مباشرة)
    function group(title, cls, icon, items, actLabel) {
        if (!items.length) return '';
        var h = '<div class="ops-focus-group">';
        h += '<div class="ops-focus-group-title ' + cls + '"><i class="fas ' + icon + '"></i>' + title + '<span class="ops-focus-count">' + items.length + '</span></div>';
        h += '<div class="ops-focus-items">';
        for (var i = 0; i < items.length; i++) {
            h += '<div class="ops-focus-item ' + cls + '" onclick="navigateToPage(\'radio-completion.html?v=41\')" title="الانتقال إلى تكميل المراكز الإسعافية">'
               + '<span class="ops-focus-item-name">' + esc(items[i].name) + '</span>'
               + '<span class="ops-focus-item-detail">' + esc(items[i].detail) + '</span>'
               + '<span class="ops-focus-item-act">' + actLabel + '<i class="fas fa-chevron-left"></i></span></div>';
        }
        h += '</div></div>';
        return h;
    }

    var html = '';
    html += group('فرق ناقصة', 'red', 'fa-exclamation-circle', missing.map(function (m) {
        var d = [];
        if (m.t.reason) d.push(m.t.reason);
        if (m.t.vacant > 0) d.push('ينقصها ' + m.t.vacant);
        return { name: m.name, detail: d.join(' — ') || 'ناقصة' };
    }), 'التكميل والدعم');
    html += group('خارج الخدمة', 'red', 'fa-power-off', offline.map(function (m) {
        return { name: m.name, detail: m.t.reason || 'خارج الخدمة' };
    }), 'مراجعة السبب');
    html += group('بانتظار قرار التكميل', 'gold', 'fa-hourglass-half', pending.map(function (m) {
        return { name: m.name, detail: (m.t.activeCount || 0) + '/' + (m.t.requiredPersonnel || 0) + ' حاضر' };
    }), 'اتخاذ القرار');
    html += group('مركبات تحتاج انتباه', 'blue', 'fa-ambulance', vehicle.map(function (m) {
        return { name: m.name, detail: m.t.vehicleStatus ? 'المركبة: ' + m.t.vehicleStatus : 'حالة المركبة غير جاهزة' };
    }), 'مراجعة المركبة');

    listEl.innerHTML = html;
}

// ============================================================
// الخريطة التشغيلية الذكية — أعيد بناؤها بالكامل في js/smart-map.js
// (قرار المالك 2026-08-20 ليلًا). هذه مفوّضات رفيعة تحافظ على
// الأسلاك القائمة: SSE (new_report/IncidentEnriched/shift_started)
// ← refreshIncidentMapFromServer ← fetchIncidentSummarySafe ← renderSmartMap
// وتحديث حالة الفرق ← updateWorkforceStats ← updateOperationalMap.
// ============================================================
var _incidentLayerBooted = false; // إقلاع طبقة البلاغات عند فتح الصفحة (لا تنتظر SSE)

function updateOperationalMap() {
    if (window.SmartMap) SmartMap.renderTeams(workforceStateTeams);
    if (!_incidentLayerBooted) {
        fetchIncidentSummarySafe().then(function (d) { if (d) _incidentLayerBooted = true; });
    }
}

function renderSmartMap(summary) {
    if (window.SmartMap) SmartMap.renderIncidents(summary);
}

function toggleSmapExpanded() {
    if (window.SmartMap) SmartMap.toggleExpand();
}


function animateValue(elementId, value) {
    var el = document.getElementById(elementId);
    if (!el) return;
    // F5b: القيمة النصية («—» الحالة الصادقة) تُعرض مباشرة بلا مقارنة رقمية
    if (typeof value !== 'number' || !isFinite(value)) {
        el.innerText = value;
        return;
    }
    var current = parseInt(el.innerText) || 0;
    if (current === value) return;
    el.innerText = value;
    el.classList.add('pop');
    setTimeout(function() { el.classList.remove('pop'); }, 500);
}

function refreshWorkforceStats() {
    updateWorkforceStats();
    showToast('🔄 تم تحديث مؤشرات القوى العاملة', 'success');
}

// ============================================
// مؤشر توزيع البلاغات
// ============================================
function updateDistributionIndicator() {
    var container = document.getElementById('distList');
    if (!container) return;
    var total = 0;
    var unitStats = {};
    for (var key in reports) {
        var report = reports[key];
        if (report && report.count > 0) {
            total += report.count;
            var parts = key.split('|');
            var unit = parts.length > 1 ? parts[1] : key;
            if (unit && unit.trim() !== '' && unit !== 'undefined' && unit !== 'null') {
                unitStats[unit] = (unitStats[unit] || 0) + report.count;
            }
        }
    }
    var el_distTotal = document.getElementById('distTotal'); if (el_distTotal) el_distTotal.innerText = total + ' بلاغ';
    updateSidebarReportsBadge(total);
    // شريط الأحداث «البلاغات» = الفريدة من المحرك إن وصلت، وإلا مشاركات الفرق كسقوط مؤقت
    lastReportsTotal = (cadReportsTotal !== null) ? cadReportsTotal : total;
    renderEventsStrip();
    var sorted = Object.entries(unitStats).sort(function(a, b) { return b[1] - a[1]; });
    if (sorted.length === 0) {
        container.innerHTML = '<div class="distribution-empty"><i class="fas fa-inbox"></i><span>لا توجد بلاغات مسجلة</span></div>';
        return;
    }
    var html = '';
    var colors = ['#60A5FA', '#10B586', '#F59E0B', '#EF4444', '#C4B5FD', '#67E8F9', '#FCD34D'];
    sorted.forEach(function(item, index) {
        var percentage = Math.round((item[1] / total) * 100);
        var color = colors[index % colors.length];
        var rankClass = index === 0 ? 'rank-1' : index === 1 ? 'rank-2' : index === 2 ? 'rank-3' : 'rank-other';
        var rankNum = index + 1;
        html += '<div class="distribution-item">' +
            '<div class="distribution-item-rank ' + rankClass + '">' + rankNum + '</div>' +
            '<div class="distribution-item-info">' +
                '<div class="distribution-item-name">' + item[0] + '</div>' +
                '<div class="distribution-item-bar-track">' +
                    '<div class="distribution-item-bar-fill" style="width:' + percentage + '%; background:' + color + ';"></div>' +
                '</div>' +
            '</div>' +
            '<div class="distribution-item-meta">' +
                '<span class="distribution-item-count">' + item[1] + '</span>' +
                '<span class="distribution-item-percent">' + percentage + '%</span>' +
            '</div>' +
        '</div>';
    });
    container.innerHTML = html;
}

// ============================================
// دوال الإسعاف الجوي
// ============================================
// الخادم هو مصدر الحقيقة — الترحيل يحاول مرة واحدة لكل تحميل صفحة
var airRecordsMigrated = false;

// ترحيل سجلات الجوي من localStorage — لا يُحذف المفتاح إلا بعد نجاح رفع جميع العناصر
async function migrateLocalAirRecords() {
    var raw = localStorage.getItem('airRecords');
    if (!raw) return;
    var items;
    try { items = JSON.parse(raw); } catch (e) { items = null; }
    if (!Array.isArray(items)) { console.warn('⚠️ تعذر تحليل سجلات الجوي المحلية — تُرك المفتاح كما هو'); return; }
    if (items.length === 0) { localStorage.removeItem('airRecords'); return; }
    try {
        for (var i = 0; i < items.length; i++) {
            var migRes = await AuthManager.apiRequest('/api/save-air-ambulance', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(items[i])
            });
            if (!migRes.ok) throw new Error('status=' + migRes.status);
        }
        localStorage.removeItem('airRecords'); // نجح رفع الكل
    } catch (e) {
        console.warn('⚠️ فشل ترحيل سجلات الجوي المحلية — تُعاد المحاولة عند التحميل القادم', e);
    }
}

// جلب سجلات الجوي من الخدمة ثم تحديث معاينة النموذج (يبقي على اسم خطاف المزامنة loadAirRecords)
async function loadAirRecords() {
    try {
        if (!airRecordsMigrated) {
            airRecordsMigrated = true;
            await migrateLocalAirRecords(); // الترحيل أولاً ثم الجلب
        }
        var response = await AuthManager.apiRequest('/api/air-ambulance');
        if (!response.ok) throw new Error('status=' + response.status);
        var result = await response.json();
        if (result && result.success) { airRecords = result.records || []; renderAirPreview(); }
    } catch (error) { console.error("خطأ في تحميل سجلات الإسعاف الجوي:", error); }
}

// ============================================
// دوال المناوبات
// ============================================
function openShiftModal() {
    var tbody = document.getElementById('centersTableBody');
    if (tbody && tbody.children.length === 0) {
        buildCentersTable();
    }
    var el_shiftModal_d19 = document.getElementById('shiftModal'); if (el_shiftModal_d19) el_shiftModal_d19.style.display = 'flex';
    // Scroll to top of modal content
    var modalContent = document.querySelector('#shiftModal .modal-content');
    if (modalContent) {
        modalContent.scrollTop = 0;
    }
    // Update badge immediately so it doesn't show "جاري التحميل"
    var typeBadge = document.getElementById('shiftModalTypeBadge');
    if (typeBadge) {
        var shiftType = (getCurrentShiftType ? getCurrentShiftType() : 'صباح');
        var shiftDate = (getCurrentShiftDate ? getCurrentShiftDate() : getSaudiDate());
        typeBadge.innerHTML = '<span style="background:var(--gold);color:#333;padding:2px 8px;border-radius:12px;font-size:0.75rem;font-weight:600;">' + shiftType + '</span> ' + shiftDate + ' — تسجيل بيانات تكميل النوبة';
    }
    loadShifts().then(function() {
        // Auto-load current shift data if available
        if (currentShiftId && allShifts && allShifts.length > 0) {
            var currentShift = null;
            for (var i = 0; i < allShifts.length; i++) {
                if (allShifts[i].id === currentShiftId) {
                    currentShift = allShifts[i];
                    break;
                }
            }
            if (currentShift) {
                // OV-S6-01: الشارة تفضّل نوع/تاريخ المناوبة النشطة (SSOT) على اشتقاق ساعة الجدار
                var typeBadgeActive = document.getElementById('shiftModalTypeBadge');
                if (typeBadgeActive && currentShift.shiftType) {
                    typeBadgeActive.innerHTML = '<span style="background:var(--gold);color:#333;padding:2px 8px;border-radius:12px;font-size:0.75rem;font-weight:600;">' + currentShift.shiftType + '</span> ' + (currentShift.shiftDate || '') + ' — تسجيل بيانات تكميل النوبة';
                }
                loadShiftToForm(currentShift);
            } else {
                clearShiftForm();
                var el_shiftDate = document.getElementById('shiftDate'); if (el_shiftDate) el_shiftDate.innerText = getSaudiDate();
            }
        } else {
            clearShiftForm();
            var el_shiftDate = document.getElementById('shiftDate'); if (el_shiftDate) el_shiftDate.innerText = getSaudiDate();
        }
    });
}

async function loadShifts() {
    try {
        var response = await AuthManager.apiRequest('/api/shifts');
        var data = await response.json();
        if (Array.isArray(data)) {
            allShifts = data;
        } else if (data && Array.isArray(data.shifts)) {
            allShifts = data.shifts;
        } else {
            allShifts = [];
            console.log('⚠️ /api/shifts returned unexpected format:', data);
        }
        var archiveSelect = document.getElementById('archiveSelect');
        if (archiveSelect) {
            archiveSelect.innerHTML = '<option value="">-- مناوبة جديدة --</option>';
            allShifts.forEach(function(shift) {
                var option = document.createElement('option');
                option.value = shift.id;
                var date = shift.shiftDate || getSaudiDate();
                var total = shift.totalReports || 0;
                var type = shift.shiftType || 'مناوبة';
                option.textContent = type + ' - ' + date + ' (' + total + ' بلاغ)';
                if (shift.id === currentShiftId) { option.textContent += ' ⬅️ الحالية'; }
                archiveSelect.appendChild(option);
            });
        }
        var shiftArchiveSelect = document.getElementById('shiftArchiveSelect');
        if (shiftArchiveSelect) {
            shiftArchiveSelect.innerHTML = '<option value="">-- اختر المناوبة --</option>';
            allShifts.forEach(function(shift) {
                var option = document.createElement('option');
                option.value = shift.id;
                option.textContent = (shift.shiftType || 'مناوبة') + ' - ' + (shift.shiftDate || '') + ' (' + (shift.totalReports || 0) + ' بلاغ)';
                shiftArchiveSelect.appendChild(option);
            });
        }
        updateShiftStatus();
    } catch (err) {
        console.error('⚠️ loadShifts error:', err);
        allShifts = [];
        updateShiftStatus();
    }
}

function showShiftTypeDialog() {
    return new Promise(function(resolve) {
        var modal = document.createElement('div');
        modal.className = 'modal';
        modal.style.display = 'flex';
        modal.innerHTML = '<div class="modal-content" style="min-width:500px; width:60%; max-width:700px; padding:30px;"><h3 style="text-align:center; font-size:1.5rem; margin-bottom:20px;">📋 بدء مناوبة جديدة</h3><p style="text-align:center; color:#666; margin:15px 0; font-size:1.1rem;">اختر نوع المناوبة الجديدة:</p><div style="display:flex; gap:20px; justify-content:center; margin:30px 0;"><button id="shiftMorningBtn" style="padding:15px 35px; border:2px solid #000; background:#e8f5e9; cursor:pointer; font-weight:bold; border-radius:10px; font-size:1.1rem; transition:transform 0.2s;">🌅 صباحي</button><button id="shiftNightBtn" style="padding:15px 35px; border:2px solid #000; background:#e3f2fd; cursor:pointer; font-weight:bold; border-radius:10px; font-size:1.1rem; transition:transform 0.2s;">🌙 ليلي</button></div><div style="display:flex; justify-content:center; gap:10px; margin-top:20px;"><button id="cancelShiftBtn" style="padding:10px 25px; border:1px solid #000; background:white; cursor:pointer; border-radius:8px; font-size:1rem;">إلغاء</button></div></div>';
        document.body.appendChild(modal);
        modal.querySelector('#shiftMorningBtn').onclick = function() { modal.remove(); resolve('صباحية'); };
        modal.querySelector('#shiftNightBtn').onclick = function() { modal.remove(); resolve('ليلية'); };
        modal.querySelector('#cancelShiftBtn').onclick = function() { modal.remove(); resolve(null); };
        modal.onclick = function(e) { if (e.target === modal) { modal.remove(); resolve(null); } };
    });
}

function canStartNewShift() {
    // If no active shift, always allow starting a new one
    if (!currentShiftId) {
        return { allowed: true };
    }
    
    // Get current Saudi time — من الطبقة المركزية (بلا إزاحة يدوية +3)
    var p = TimeRiyadh.riyadhParts(new Date());
    var hour = parseInt(p.hour, 10);
    var minute = parseInt(p.minute, 10);
    var currentTimeDecimal = hour + (minute / 60);
    
    // Grace period: first 2 hours of each shift window
    // Morning shift grace: 05:00 - 07:00
    // Night shift grace: 17:00 - 19:00
    var isMorningGrace = (currentTimeDecimal >= 5 && currentTimeDecimal < 7);
    var isNightGrace = (currentTimeDecimal >= 17 && currentTimeDecimal < 19);
    
    if (isMorningGrace || isNightGrace) {
        return { allowed: true, inGracePeriod: true };
    }
    
    // Not in grace period — block and show next shift time
    var nextShiftTime;
    if (hour >= 5 && hour < 17) {
        // Currently in morning shift period, next is night at 17:00
        nextShiftTime = '5:00 مساءً';
    } else {
        // Currently in night shift period, next is morning at 05:00
        nextShiftTime = '5:00 صباحاً';
    }
    
    return {
        allowed: false,
        message: '⚠️ المناوبة الحالية نشطة.\n\nلا يمكن بدء مناوبة جديدة إلا خلال أول ساعتين من بداية المناوبة (5:00 - 7:00 صباحًا أو 5:00 - 7:00 مساءً).\n\nالمناوبة القادمة تبدأ الساعة ' + nextShiftTime + '.'
    };
}

async function startNewShift() {
    // Check time-window protection
    var check = canStartNewShift();
    if (!check.allowed) {
        alert(check.message);
        return;
    }
    
    var shiftType = await showShiftTypeDialog();
    if (!shiftType) return;
    
    // Normalize shift type for API (صباحية → صباح, ليلية → ليل)
    var normalizedType = shiftType;
    if (shiftType === 'صباحية') normalizedType = 'صباح';
    if (shiftType === 'ليلية') normalizedType = 'ليل';
    
    if (!confirm('⚠️ هل أنت متأكد؟\n\nسيتم أرشفة المناوبة الحالية بالكامل، وبدء مناوبة ' + (normalizedType === 'صباح' ? 'صباحية' : 'ليلية') + ' جديدة.\n\nجميع البيانات التشغيلية ستبدأ من الصفر.')) return;
    
    try {
        var response = await AuthManager.apiRequest('/api/start-new-shift', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shiftType: normalizedType }) });
        var result = await response.json();
        // OV-S3-03: «نشطة» فقط بعد نجاح مؤكد من السيرفر (success + shiftId)
        if (result.success && result.shiftId) {
            // ============================================
            // STEP 1: Store new shift ID
            // ============================================
            // OV-S5-02: التقط معرّف المناوبة السابقة قبل الاستبدال — تنظيف
            // مفاتيح reportTypes_ أدناه يجب أن يحذف مفتاح القديمة لا الجديدة
            var previousShiftId = currentShiftId;
            currentShiftId = result.shiftId;
            try { localStorage.setItem('currentShiftId', String(currentShiftId)); } catch(e) {}
            
            // ============================================
            // STEP 2: Clear ALL operational data locally
            // ============================================
            reports = {};
            // Keep centersData — static team-to-center mapping, not shift-specific
            // centersData = {};
            lastKnownUpdate = 0;
            
            // OV-S5-02: تنظيف مفاتيح إحصاءات أنواع البلاغات للمناوبة السابقة
            // (كان الكود يحذف مفتاح المناوبة الجديدة بعد كتابة currentShiftId
            // فتتراكم مفاتيح المناوبات القديمة يتيمةً في localStorage)
            try {
                if (previousShiftId && previousShiftId !== result.shiftId) {
                    localStorage.removeItem('reportTypes_' + previousShiftId);
                }
            } catch(e) {}
            
            // ============================================
            // STEP 3: Update UI to show zero state
            // ============================================
            updateTotal();
            calculateLiveReportStats();
            updateWorkforceStats();
            updateDistributionIndicator();
            updateShiftStatus();
            
            // Hide distribution card on main page until teams are ready
            var distributionIndicator = document.getElementById('distributionIndicator');
            if (distributionIndicator) distributionIndicator.style.display = 'none';
            
            // Close any open modals
            var distributionModal = document.getElementById('distributionModal');
            closeModalById('distributionModal');
            var shiftModal = document.getElementById('shiftModal');
            if (shiftModal) shiftModal.style.display = 'none';
            
            // ============================================
            // STEP 4: Reload data from server (should be empty)
            // ============================================
            await loadShifts();
            await loadAllData();
            
            showNotification('مناوبة جديدة', 'تم بدء المناوبة ' + (normalizedType === 'صباح' ? 'الصباحية' : 'الليلية') + ' بنجاح. جميع البيانات تبدأ من الصفر.', 'success', 5000);
        } else {
            alert("❌ فشل في بدء المناوبة: " + (result.error || "خطأ غير معروف"));
            // OV-S3-03: لا كتابة متفائلة أصلاً (currentShiftId/localStorage لا يُكتبان إلا بعد النجاح المؤكد)
            // — نعيد مزامنة الزر/العرض مع حقيقة السيرفر فوراً لإغلاق أي حالة وسطية
            await loadCurrentShift();
        }
    } catch (error) {
        alert("❌ خطأ في الاتصال: " + error.message);
        // OV-S3-03: فشل أوفلاين — نعيد قراءة الحقيقة من السيرفر ونعكس أي عرض وسطي
        try { await loadCurrentShift(); } catch(e2) {}
        if (typeof updateShiftStatus === 'function') updateShiftStatus();
    }
}

// ============================================
// دوال إضافة البلاغات (من التوزيع)
// ============================================
async function addReportToServer(center, unit) {
    if (isViewingArchiveShift) {
        alert("⚠️ أنت تستعرض مناوبة سابقة. الرجاء العودة للمناوبة الحالية لتسجيل بلاغات جديدة.");
        return;
    }
    if (!currentShiftId) {
        alert("⚠️ لا توجد مناوبة نشطة. الرجاء بدء مناوبة جديدة أولاً.");
        return;
    }
    if (!center || !unit) {
        alert("⚠️ بيانات ناقصة");
        return;
    }
    
    // Ensure we have the latest selected type from the dropdown
    var typeSelect = document.getElementById('reportTypeSelect');
    if (typeSelect) selectedReportType = typeSelect.value;
    var typeInfo = REPORT_TYPE_DEFS[selectedReportType] || REPORT_TYPE_DEFS.medical;
    
    try {
        var reportBody = { center: center.trim(), unit: unit.trim(), type: selectedReportType };
        if (currentShiftId) reportBody.shiftId = currentShiftId;
        var response = await fetch('/api/report', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(reportBody)
        });
        var result = await response.json();
        if (result.success) {
            await loadAllData();
            updateUnitCounter(center, unit);
            calculateLiveReportStats();
            updateWorkforceStats();
            updateDistributionIndicator();
            updateTotal();
            
            showNotification('بلاغ جديد', typeInfo.emoji + ' ' + typeInfo.label + ' — ' + unit + ' (' + center + ')', 'success', 2500);
            
            var distModal = document.getElementById('distributionModal');
            if (distModal.style.display === 'flex') {
                renderAdvancedDistribution();
            }
        } else {
            alert("❌ فشل في تسجيل البلاغ: " + (result.error || "خطأ غير معروف"));
        }
    } catch (error) {
        alert("❌ فشل في الاتصال بالخادم");
    }
}

async function undoLastReport(center, unit) {
    if (isViewingArchiveShift) {
        alert("⚠️ لا يمكن التراجع عن بلاغات مناوبة سابقة.");
        return;
    }
    if (!center || !unit) {
        alert("⚠️ بيانات ناقصة");
        return;
    }
    if (!currentShiftId) {
        alert("⚠️ لا توجد مناوبة نشطة. الرجاء بدء مناوبة جديدة أولاً.");
        return;
    }
    
    try {
        var undoBody = { center: center.trim(), unit: unit.trim() };
        if (currentShiftId) undoBody.shiftId = currentShiftId;
        var response = await fetch('/api/undo', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(undoBody)
        });
        var result = await response.json();
        if (result.success) {
            await loadAllData();
            updateUnitCounter(center, unit);
            calculateLiveReportStats();
            updateWorkforceStats();
            updateDistributionIndicator();
            updateTotal();
            
            var distModal = document.getElementById('distributionModal');
            if (distModal.style.display === 'flex') {
                renderAdvancedDistribution();
            }
        } else if (result.error) {
            alert(result.error);
        }
    } catch (error) {
        alert("❌ فشل في التراجع");
    }
}

// ============================================
// تقرير المناوبة التلقائي
// ============================================
async function generateShiftReport() {
    var allReports = reports || {};
    var totalReports = 0;
    var typeBreakdown = getShiftTypeBreakdown();
    var unitStats = {};
    var sectorStats = {};
    var lastTime = getLastReportTime();
    var peakHour = getPeakHour();
    
    for (var key in allReports) {
        var r = allReports[key];
        if (r && r.count > 0) {
            totalReports += r.count;
            var parts = key.split('|');
            var center = parts[0];
            var unit = parts[1];
            if (unit) unitStats[unit] = (unitStats[unit] || 0) + r.count;
            if (center) sectorStats[center] = (sectorStats[center] || 0) + r.count;
        }
    }
    
    // إحصائية المواقع بالحي المشتق من محرك البلاغات بدل مركز «CAD» الخام (قرار المالك 2026-08-20)
    var incidentSummary = await fetchIncidentSummarySafe();
    sectorStats = mergeDistrictStats(sectorStats, incidentSummary && incidentSummary.byDistrict);
    
    var sortedUnits = Object.entries(unitStats).sort(function(a, b) { return b[1] - a[1]; });
    var mostActiveTeam = sortedUnits.length > 0 ? sortedUnits[0][0] : '-';
    var mostActiveTeamCount = sortedUnits.length > 0 ? sortedUnits[0][1] : 0;
    
    var sortedSectors = Object.entries(sectorStats).sort(function(a, b) { return b[1] - a[1]; });
    var mostActiveCity = sortedSectors.length > 0 ? sortedSectors[0][0] : '-';
    var mostActiveCityCount = sortedSectors.length > 0 ? sortedSectors[0][1] : 0;
    
    var shiftType = currentShiftId ? (allShifts.find(function(s) { return s.id === currentShiftId; }) || {}).shiftType || 'مناوبة' : 'مناوبة';
    var shiftDate = getSaudiDate();
    
    var html = '<div class="shift-report-section shift-report-highlight">' +
        '<h3><i class="fas fa-clipboard-list"></i> ملخص المناوبة</h3>' +
        '<div class="shift-report-grid">' +
            '<div class="shift-report-item"><span class="label">📅 التاريخ:</span><span class="value">' + shiftDate + '</span></div>' +
            '<div class="shift-report-item"><span class="label">🌙 النوع:</span><span class="value">' + shiftType + '</span></div>' +
            '<div class="shift-report-item"><span class="label">📊 إجمالي البلاغات:</span><span class="value">' + totalReports + '</span></div>' +
            '<div class="shift-report-item"><span class="label">🕐 آخر بلاغ:</span><span class="value">' + (lastTime ? TimeRiyadh.formatTime(lastTime) : '-') + '</span></div>' +
        '</div>' +
    '</div>';
    
    // Type breakdown
    html += '<div class="shift-report-section">' +
        '<h3><i class="fas fa-tags"></i> توزيع البلاغات حسب النوع</h3>' +
        '<div class="shift-report-grid">';
    for (var t in REPORT_TYPE_DEFS) {
        var tc = typeBreakdown[t] || 0;
        html += '<div class="shift-report-item"><span class="label">' + REPORT_TYPE_DEFS[t].emoji + ' ' + REPORT_TYPE_DEFS[t].label + ':</span><span class="value">' + tc + '</span></div>';
    }
    html += '</div></div>';
    
    // Sector breakdown
    html += '<div class="shift-report-section">' +
        '<h3><i class="fas fa-map-marker-alt"></i> توزيع البلاغات حسب المدينة/القطاع</h3>' +
        '<div class="shift-report-grid">';
    for (var i = 0; i < sortedSectors.length; i++) {
        html += '<div class="shift-report-item"><span class="label">📍 ' + sortedSectors[i][0] + ':</span><span class="value">' + sortedSectors[i][1] + '</span></div>';
    }
    html += '</div></div>';
    
    // Team breakdown
    html += '<div class="shift-report-section">' +
        '<h3><i class="fas fa-ambulance"></i> توزيع البلاغات حسب الفرقة</h3>' +
        '<div class="shift-report-grid">';
    for (var i = 0; i < sortedUnits.length; i++) {
        html += '<div class="shift-report-item"><span class="label">🚑 ' + sortedUnits[i][0] + ':</span><span class="value">' + sortedUnits[i][1] + '</span></div>';
    }
    html += '</div></div>';
    
    // Highlights
    html += '<div class="shift-report-section shift-report-highlight">' +
        '<h3><i class="fas fa-star"></i> أبرز الإحصائيات</h3>' +
        '<div class="shift-report-grid">' +
            '<div class="shift-report-item"><span class="label">🏆 أكثر فرقة:</span><span class="value">' + mostActiveTeam + ' (' + mostActiveTeamCount + ')</span></div>' +
            '<div class="shift-report-item"><span class="label">📍 أكثر مدينة:</span><span class="value">' + mostActiveCity + ' (' + mostActiveCityCount + ')</span></div>' +
            '<div class="shift-report-item"><span class="label">⏰ وقت الذروة:</span><span class="value">' + peakHour + '</span></div>' +
        '</div>' +
    '</div>';
    
    var body = document.getElementById('shiftReportBody');
    if (body) body.innerHTML = html;

    openModalById('shiftReportModal');
}

async function downloadShiftReport() {
    var allReports = reports || {};
    var totalReports = 0;
    var typeBreakdown = getShiftTypeBreakdown();
    var unitStats = {};
    var sectorStats = {};
    var lastTime = getLastReportTime();
    var peakHour = getPeakHour();
    
    for (var key in allReports) {
        var r = allReports[key];
        if (r && r.count > 0) {
            totalReports += r.count;
            var parts = key.split('|');
            var center = parts[0];
            var unit = parts[1];
            if (unit) unitStats[unit] = (unitStats[unit] || 0) + r.count;
            if (center) sectorStats[center] = (sectorStats[center] || 0) + r.count;
        }
    }
    
    // إحصائية المواقع بالحي المشتق من محرك البلاغات بدل مركز «CAD» الخام (قرار المالك 2026-08-20)
    var incidentSummary = await fetchIncidentSummarySafe();
    sectorStats = mergeDistrictStats(sectorStats, incidentSummary && incidentSummary.byDistrict);
    
    var sortedUnits = Object.entries(unitStats).sort(function(a, b) { return b[1] - a[1]; });
    var mostActiveTeam = sortedUnits.length > 0 ? sortedUnits[0][0] : '-';
    var mostActiveTeamCount = sortedUnits.length > 0 ? sortedUnits[0][1] : 0;
    
    var sortedSectors = Object.entries(sectorStats).sort(function(a, b) { return b[1] - a[1]; });
    var mostActiveCity = sortedSectors.length > 0 ? sortedSectors[0][0] : '-';
    var mostActiveCityCount = sortedSectors.length > 0 ? sortedSectors[0][1] : 0;
    
    var shiftType = currentShiftId ? (allShifts.find(function(s) { return s.id === currentShiftId; }) || {}).shiftType || 'مناوبة' : 'مناوبة';
    var shiftDate = getSaudiDate();
    
    var text = '📋 تقرير المناوبة\n';
    text += '══════════════════════════\n';
    text += '📅 التاريخ: ' + shiftDate + '\n';
    text += '🌙 النوع: ' + shiftType + '\n';
    text += '📊 إجمالي البلاغات: ' + totalReports + '\n';
    text += '🕐 آخر بلاغ: ' + (lastTime ? TimeRiyadh.formatTime(lastTime) : '-') + '\n\n';
    
    text += '🏷️ توزيع حسب النوع:\n';
    for (var t in REPORT_TYPE_DEFS) {
        text += '  ' + REPORT_TYPE_DEFS[t].emoji + ' ' + REPORT_TYPE_DEFS[t].label + ': ' + (typeBreakdown[t] || 0) + '\n';
    }
    text += '\n📍 توزيع حسب المدينة/القطاع:\n';
    for (var i = 0; i < sortedSectors.length; i++) {
        text += '  ' + sortedSectors[i][0] + ': ' + sortedSectors[i][1] + '\n';
    }
    text += '\n🚑 توزيع حسب الفرقة:\n';
    for (var i = 0; i < sortedUnits.length; i++) {
        text += '  ' + sortedUnits[i][0] + ': ' + sortedUnits[i][1] + '\n';
    }
    text += '\n⭐ أبرز الإحصائيات:\n';
    text += '  🏆 أكثر فرقة: ' + mostActiveTeam + ' (' + mostActiveTeamCount + ')\n';
    text += '  📍 أكثر مدينة: ' + mostActiveCity + ' (' + mostActiveCityCount + ')\n';
    text += '  ⏰ وقت الذروة: ' + peakHour + '\n';
    text += '══════════════════════════\n';
    text += 'منصة إدارة العمليات الإسعافية – قطاع جنوب الرياض\n';
    
    var blob = new Blob(['\uFEFF' + text], { type: 'text/plain;charset=utf-8;' });
    var link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'تقرير_المناوبة_' + shiftDate + '.txt';
    link.click();
    showNotification('تم التحميل', 'تم تحميل التقرير بنجاح', 'success', 3000);
}

async function saveShiftReportToArchive() {
    var allReports = reports || {};
    var totalReports = 0;
    var typeBreakdown = getShiftTypeBreakdown();
    var unitStats = {};
    var sectorStats = {};
    var lastTime = getLastReportTime();
    var peakHour = getPeakHour();
    
    for (var key in allReports) {
        var r = allReports[key];
        if (r && r.count > 0) {
            totalReports += r.count;
            var parts = key.split('|');
            var center = parts[0];
            var unit = parts[1];
            if (unit) unitStats[unit] = (unitStats[unit] || 0) + r.count;
            if (center) sectorStats[center] = (sectorStats[center] || 0) + r.count;
        }
    }
    
    // إحصائية المواقع بالحي المشتق من محرك البلاغات بدل مركز «CAD» الخام (قرار المالك 2026-08-20)
    var incidentSummary = await fetchIncidentSummarySafe();
    sectorStats = mergeDistrictStats(sectorStats, incidentSummary && incidentSummary.byDistrict);
    
    var sortedUnits = Object.entries(unitStats).sort(function(a, b) { return b[1] - a[1]; });
    var mostActiveTeam = sortedUnits.length > 0 ? sortedUnits[0][0] : '-';
    var mostActiveTeamCount = sortedUnits.length > 0 ? sortedUnits[0][1] : 0;
    
    var sortedSectors = Object.entries(sectorStats).sort(function(a, b) { return b[1] - a[1]; });
    var mostActiveCity = sortedSectors.length > 0 ? sortedSectors[0][0] : '-';
    var mostActiveCityCount = sortedSectors.length > 0 ? sortedSectors[0][1] : 0;
    
    var shiftType = currentShiftId ? (allShifts.find(function(s) { return s.id === currentShiftId; }) || {}).shiftType || 'مناوبة' : 'مناوبة';
    var shiftDate = getSaudiDate();
    
    var report = {
        id: Date.now(),
        date: shiftDate,
        shiftType: shiftType,
        shiftId: currentShiftId,
        totalReports: totalReports,
        typeBreakdown: typeBreakdown,
        sectorStats: sectorStats,
        unitStats: unitStats,
        mostActiveTeam: mostActiveTeam,
        mostActiveTeamCount: mostActiveTeamCount,
        mostActiveCity: mostActiveCity,
        mostActiveCityCount: mostActiveCityCount,
        peakHour: peakHour,
        lastReportTime: lastTime ? lastTime.toISOString() : null,
        generatedAt: new Date().toISOString()
    };
    
    try {
        var archive = JSON.parse(localStorage.getItem('shiftReportArchive') || '[]');
        archive.unshift(report);
        if (archive.length > 50) archive = archive.slice(0, 50);
        localStorage.setItem('shiftReportArchive', JSON.stringify(archive));
        showNotification('تم الحفظ', 'تم حفظ التقرير في الأرشيف المحلي', 'success', 3000);
    } catch (e) {
        showNotification('خطأ', 'فشل في حفظ التقرير', 'error', 3000);
    }
}

// ============================================
// دوال المناوبة (view, return, save, delete)
// ============================================
async function viewShiftReports() {
    var select = document.getElementById('archiveSelect');
    var shiftId = parseInt(select.value);
    if (!shiftId) { alert("الرجاء اختيار مناوبة من القائمة"); return; }
    try {
        var response = await AuthManager.apiRequest('/api/shifts/' + shiftId);
        var result = await response.json();
        if (result && result.shift) {
            currentViewingShift = result.shift;
            currentViewingShiftData = result;
            isViewingArchiveShift = true;
            viewingShiftId = shiftId;
            reports = result.reports || {};
            updateTotal();
            loadShiftToForm(result.shift);
            displayShiftReportStats(result.reports);
            calculateLiveReportStats();
            updateWorkforceStats();
            updateDistributionIndicator();
            var totalReports = result.total || Object.keys(result.reports || {}).reduce(function(sum, key) { return sum + (result.reports[key]?.count || 0); }, 0);
            var el_viewingBadge_d20 = document.getElementById('viewingBadge'); if (el_viewingBadge_d20) el_viewingBadge_d20.style.display = 'inline-block';
            var el_returnToCurrentBtn_d21 = document.getElementById('returnToCurrentBtn'); if (el_returnToCurrentBtn_d21) el_returnToCurrentBtn_d21.style.display = 'inline-block';
            var el_viewingBadge_h5 = document.getElementById('viewingBadge'); if (el_viewingBadge_h5) el_viewingBadge_h5.innerHTML = '📂 تستعرض: ' + (result.shift.shiftType || 'مناوبة') + ' - ' + (result.shift.shiftDate || '') + ' (' + totalReports + ' بلاغ)';
            var el_updateStatus_h6 = document.getElementById('updateStatus'); if (el_updateStatus_h6) el_updateStatus_h6.innerHTML = '<i class="fas fa-circle" style="color:#FBBF24;font-size:7px;"></i> تستعرض مناوبة سابقة | آخر تحديث: ' + getSaudiTime();
            var el_shiftModal_d22 = document.getElementById('shiftModal'); if (el_shiftModal_d22) el_shiftModal_d22.style.display = 'flex';
            // Show archive summary card
            updateArchiveSummaryCard(result.shift, totalReports);
        } else { alert("لا توجد بيانات في هذه المناوبة"); }
    } catch (error) { console.error(error); alert("❌ فشل في تحميل المناوبة"); }
}

async function returnToCurrentShift() {
    isViewingArchiveShift = false;
    currentViewingShift = null;
    currentViewingShiftData = null;
    viewingShiftId = null;
    await loadAllData();
    calculateLiveReportStats();
    updateWorkforceStats();
    updateDistributionIndicator();
    var el_viewingBadge_d23 = document.getElementById('viewingBadge'); if (el_viewingBadge_d23) el_viewingBadge_d23.style.display = 'none';
    var el_returnToCurrentBtn_d24 = document.getElementById('returnToCurrentBtn'); if (el_returnToCurrentBtn_d24) el_returnToCurrentBtn_d24.style.display = 'none';
    var el_archiveSummaryCard = document.getElementById('archiveSummaryCard'); if (el_archiveSummaryCard) el_archiveSummaryCard.style.display = 'none';
    var el_archiveSelect_v4 = document.getElementById('archiveSelect'); if (el_archiveSelect_v4) el_archiveSelect_v4.value = '';
    var el_updateStatus_h7 = document.getElementById('updateStatus'); if (el_updateStatus_h7) el_updateStatus_h7.innerHTML = '<i class="fas fa-circle" style="color:#34D399;font-size:7px;"></i> متصل | تحديث تلقائي مفعل | آخر تحديث: ' + getSaudiTime();
    var el_shiftModal_d25 = document.getElementById('shiftModal'); if (el_shiftModal_d25) el_shiftModal_d25.style.display = 'none';
}

// ============================================
// نظام الحفظ التلقائي (Draft Auto-Save)
// ============================================
function getShiftDraftKey() {
    var shiftDate = getCurrentShiftDate ? getCurrentShiftDate() : getSaudiDate();
    var shiftType = getCurrentShiftType ? getCurrentShiftType() : 'صباح';
    return 'shiftDraft_' + shiftDate + '_' + shiftType;
}

function getShiftDraftKeyFor(date, type) {
    return 'shiftDraft_' + date + '_' + type;
}

function saveShiftDraft() {
    try {
        var shiftData = getShiftFromForm();
        var shiftDate = getCurrentShiftDate ? getCurrentShiftDate() : getSaudiDate();
        var shiftType = getCurrentShiftType ? getCurrentShiftType() : 'صباح';
        var draft = {
            shiftDate: shiftDate,
            shiftType: shiftType,
            timestamp: Date.now(),
            data: shiftData
        };
        localStorage.setItem(getShiftDraftKey(), JSON.stringify(draft));
        console.log('[DRAFT] Saved draft for', shiftDate, shiftType);
    } catch(e) { console.error('[DRAFT] Failed to save draft:', e); }
}

function loadShiftDraft() {
    try {
        var key = getShiftDraftKey();
        var draftJson = localStorage.getItem(key);
        if (!draftJson) return null;
        var draft = JSON.parse(draftJson);
        // Only use draft if it's from the same shift (same date & type)
        var currentDate = getCurrentShiftDate ? getCurrentShiftDate() : getSaudiDate();
        var currentType = getCurrentShiftType ? getCurrentShiftType() : 'صباح';
        if (draft.shiftDate !== currentDate || draft.shiftType !== currentType) {
            console.log('[DRAFT] Draft expired (different shift), ignoring');
            return null;
        }
        console.log('[DRAFT] Loaded draft for', currentDate, currentType);
        return draft.data;
    } catch(e) { console.error('[DRAFT] Failed to load draft:', e); return null; }
}

function loadShiftDraftFor(date, type) {
    try {
        var key = getShiftDraftKeyFor(date, type);
        var draftJson = localStorage.getItem(key);
        if (!draftJson) return null;
        var draft = JSON.parse(draftJson);
        return draft.data;
    } catch(e) { return null; }
}

function clearShiftDraft() {
    try {
        localStorage.removeItem(getShiftDraftKey());
        console.log('[DRAFT] Cleared draft');
    } catch(e) {}
}

function clearShiftDraftFor(date, type) {
    try {
        localStorage.removeItem(getShiftDraftKeyFor(date, type));
    } catch(e) {}
}

function hasShiftDraft() {
    return loadShiftDraft() !== null;
}

function loadDraftToForm(draftData) {
    if (!draftData || !draftData.centersData) return;
    console.log('[DRAFT] Loading draft data into form');
    
    // Load shift type
    if (draftData.shiftType) {
        document.querySelectorAll('input[name="shiftType"]').forEach(function(radio) {
            radio.checked = (radio.value === draftData.shiftType);
        });
    }
    
    // Load rapid response teams
    for (var r = 0; r < rapidTeams.length; r++) {
        var rapid = rapidTeams[r];
        var data = draftData.centersData[rapid.name] || {};
        var staffInput = document.getElementById('rapid_staff_' + r);
        var carsInput = document.getElementById('rapid_cars_' + r);
        var notesInput = document.getElementById('rapid_notes_' + r);
        var backupParamedicInput = document.getElementById('backup_paramedic_rapid_' + r);
        if (staffInput) staffInput.value = data.staffCount || '';
        if (carsInput) carsInput.value = data.carsCount || '';
        if (notesInput) notesInput.value = data.notes || '';
        if (backupParamedicInput) backupParamedicInput.value = data.backupParamedic || '';
        updateRapidStatusIcon(r);
    }
    
    // Load centers
    for (var i = 0; i < centerList.length; i++) {
        var center = centerList[i];
        var data = draftData.centersData[center] || {};
        var staffInput = document.getElementById('staff_' + i);
        var carsInput = document.getElementById('cars_' + i);
        var notesInput = document.getElementById('notes_' + i);
        var vehicleSel = document.getElementById('vehicle_' + i);
        var fuelSel = document.getElementById('fuel_' + i);
        var backupParamedicInput = document.getElementById('backup_paramedic_' + i);
        if (staffInput) staffInput.value = data.staffCount || '';
        if (carsInput) carsInput.value = data.carsCount || '';
        if (notesInput) notesInput.value = data.notes || '';
        if (vehicleSel) vehicleSel.value = data.vehicleStatus || '';
        if (fuelSel) fuelSel.value = data.fuelLevel || '';
        if (backupParamedicInput) backupParamedicInput.value = data.backupParamedic || '';
        updateStatusIcon(i);
    }
    
    // Load general notes
    if (draftData.generalNotes) {
        document.getElementById('generalNotes').value = draftData.generalNotes;
    }
    
    refreshWorkforceFromServer();
    updateShiftKPIs();
}


// ============================================
// فحص تغيير حدود المناوبة (Boundary Check)
// ============================================
function startShiftBoundaryCheck() {
    if (shiftBoundaryCheckInterval) clearInterval(shiftBoundaryCheckInterval);
    lastShiftType = getCurrentShiftType ? getCurrentShiftType() : 'صباح';
    shiftBoundaryCheckInterval = setInterval(function() {
        var modal = document.getElementById('shiftModal');
        if (!modal || modal.style.display === 'none') {
            clearInterval(shiftBoundaryCheckInterval);
            shiftBoundaryCheckInterval = null;
            return;
        }
        var currentType = getCurrentShiftType ? getCurrentShiftType() : 'صباح';
        if (currentType !== lastShiftType) {
            console.log('[SHIFT-BOUNDARY] Shift changed from', lastShiftType, 'to', currentType, '- refreshing modal');
            lastShiftType = currentType;
            // Refresh the modal with new shift
            var typeBadge = document.getElementById('shiftModalTypeBadge');
            if (typeBadge) {
                var shiftDate = getCurrentShiftDate ? getCurrentShiftDate() : getSaudiDate();
                typeBadge.innerHTML = '<span style="background:var(--gold);color:#333;padding:2px 8px;border-radius:12px;font-size:0.75rem;font-weight:600;">' + currentType + '</span> ' + shiftDate + ' — تسجيل بيانات تكميل النوبة';
            }
            // Reload shifts and switch to correct shift
            currentShiftId = null;
            viewingShiftId = null;
            isViewingArchiveShift = false;
            loadShifts().then(function() {
                var currentDate = getCurrentShiftDate ? getCurrentShiftDate() : getSaudiDate();
                var currentShift = null;
                if (allShifts && allShifts.length > 0) {
                    for (var i = 0; i < allShifts.length; i++) {
                        if (allShifts[i].shiftDate === currentDate && allShifts[i].shiftType === currentType) {
                            currentShift = allShifts[i];
                            currentShiftId = allShifts[i].id;
                            break;
                        }
                    }
                }
                if (currentShift) {
                    loadShiftToForm(currentShift);
                    showToast('🔄 تم تغيير المناوبة تلقائياً إلى ' + currentType, 'info');
                } else {
                    clearShiftForm();
                    document.getElementById('shiftDate').innerText = getSaudiDate();
                    showToast('🔄 تم تغيير نوع المناوبة إلى ' + currentType + ' - ابدأ تكميل جديد', 'info');
                }
            });
        }
    }, 30000); // Check every 30 seconds
}

function stopShiftBoundaryCheck() {
    if (shiftBoundaryCheckInterval) {
        clearInterval(shiftBoundaryCheckInterval);
        shiftBoundaryCheckInterval = null;
    }
}

async function saveShiftData(silent) {
    var shiftData = getShiftFromForm();
    var targetId = viewingShiftId || currentShiftId;
    var shiftDate = getCurrentShiftDate ? getCurrentShiftDate() : getSaudiDate();
    var shiftType = getCurrentShiftType ? getCurrentShiftType() : shiftData.shiftType;
    try {
        var body = { shiftData: shiftData };
        if (targetId) body.shiftId = targetId;
        else { body.shiftDate = shiftDate; body.shiftType = shiftType; }
        var response = await AuthManager.apiRequest('/api/update-shift-data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        var result = await response.json();
        if (result.success) {
            if (result.shiftId) {
                currentShiftId = result.shiftId;
                // Persist currentShiftId to localStorage to survive page refreshes
                try { localStorage.setItem('currentShiftId', String(currentShiftId)); } catch(e) {}
            }
            
            // Save a copy to localStorage as lastSavedShift (for recovery after refresh)
            try {
                var savedData = {
                    shiftId: currentShiftId,
                    shiftDate: shiftDate,
                    shiftType: shiftType,
                    data: shiftData,
                    timestamp: Date.now()
                };
                localStorage.setItem('lastSavedShift_' + shiftDate + '_' + shiftType, JSON.stringify(savedData));
                // Clear draft since we have a saved version
                clearShiftDraft();
            } catch(e) {}
            
            if (!silent) {
                // Manual save: reload UI and show confirmation
                alert("✅ تم حفظ بيانات التكميل بنجاح");
                await loadShifts();
                await loadAllData();
                calculateLiveReportStats();
                updateWorkforceStats();
                updateDistributionIndicator();
                if (viewingShiftId) {
                    var viewResponse = await AuthManager.apiRequest('/api/shifts/' + viewingShiftId);
                    var viewResult = await viewResponse.json();
                    if (viewResult && viewResult.shift) { loadShiftToForm(viewResult.shift); }
                }
                // Add audit log for manual save
                try {
                    if (typeof addAuditEntry === 'function') {
                        await addAuditEntry('shift', 'حفظ تكميل النوبة', 'تم حفظ بيانات تكميل النوبة يدوياً', getCurrentUserName());
                    }
                } catch(e) {}
            } else {
                // Auto-save: don't reload form to avoid race condition
                // The SSE broadcast will update other UI elements
                // Form inputs keep their current values (user is still typing)
                // Add audit log for auto-save (throttled — only log every 5 minutes to avoid spam)
                try {
                    if (typeof addAuditEntry === 'function') {
                        var now = Date.now();
                        if (!window._lastAutoSaveAudit || (now - window._lastAutoSaveAudit) > 300000) {
                            window._lastAutoSaveAudit = now;
                            addAuditEntry('shift', 'حفظ تلقائي للتكميل', 'تم حفظ بيانات تكميل النوبة تلقائياً', getCurrentUserName());
                        }
                    }
                } catch(e) {}
            }
            return true;
        } else { if (!silent) alert("❌ فشل في حفظ البيانات: " + (result.error || "خطأ غير معروف")); return false; }
    } catch (error) { if (!silent) alert("❌ خطأ في الاتصال: " + error.message); return false; }
}

async function deleteCurrentShift() {
    var targetId = viewingShiftId || currentShiftId;
    if (!targetId) { alert("لا توجد مناوبة محددة للحذف"); return; }
    if (!confirm("⚠️ هل أنت متأكد من حذف هذه المناوبة؟")) return;
    try {
        var response = await fetch('/api/shifts/' + targetId, { method: 'DELETE' });
        var result = await response.json();
        if (result.success) {
            // S7: إشعار غير حاجب بدل alert الأصلي
            showNotification('حذف المناوبة', 'تم حذف المناوبة بنجاح', 'success', 4000);
            if (targetId === currentShiftId) { currentShiftId = null; }
            if (targetId === viewingShiftId) {
                viewingShiftId = null;
                isViewingArchiveShift = false;
                var el_viewingBadge_d26 = document.getElementById('viewingBadge'); if (el_viewingBadge_d26) el_viewingBadge_d26.style.display = 'none';
                var el_returnToCurrentBtn_d27 = document.getElementById('returnToCurrentBtn'); if (el_returnToCurrentBtn_d27) el_returnToCurrentBtn_d27.style.display = 'none';
            }
            clearShiftForm();
            await loadShifts();
            await loadAllData();
            calculateLiveReportStats();
            updateWorkforceStats();
            updateDistributionIndicator();
            var el_shiftModal_d28 = document.getElementById('shiftModal'); if (el_shiftModal_d28) el_shiftModal_d28.style.display = 'none';
        } else { alert("❌ فشل في الحذف"); }
    } catch (error) { alert("❌ خطأ في الاتصال"); }
}

function loadShiftToForm(shift) {
    if (!shift) return;
    viewingShiftId = shift.id;
    document.getElementById('shiftDate').innerText = shift.shiftDate || getSaudiDate();
    document.querySelectorAll('input[name="shiftType"]').forEach(function(radio) { radio.checked = (radio.value === shift.shiftType); });
    // Update shift type badge in header
    var typeBadge = document.getElementById('shiftModalTypeBadge');
    if (typeBadge) {
        var type = shift.shiftType || (getCurrentShiftType ? getCurrentShiftType() : 'صباح');
        var date = shift.shiftDate || getSaudiDate();
        typeBadge.innerHTML = '<span style="background:var(--gold);color:#333;padding:2px 8px;border-radius:12px;font-size:0.75rem;font-weight:600;">' + type + '</span> ' + date + ' — تسجيل بيانات تكميل النوبة';
    }
    
    // Load rapid response teams data
    for (var r = 0; r < rapidTeams.length; r++) {
        var rapid = rapidTeams[r];
        var data = (shift.centersData && shift.centersData[rapid.name]) || { staffCount: '', carsCount: '', notes: '' };
        var staffInput = document.getElementById('rapid_staff_' + r);
        var carsInput = document.getElementById('rapid_cars_' + r);
        var notesInput = document.getElementById('rapid_notes_' + r);
        if (staffInput) staffInput.value = data.staffCount || '';
        if (carsInput) carsInput.value = data.carsCount || '';
        if (notesInput) notesInput.value = data.notes || '';
        var backupParamedicInput = document.getElementById('backup_paramedic_rapid_' + r);
        if (backupParamedicInput) backupParamedicInput.value = data.backupParamedic || '';
        // Restore cached paramedic data if available
        if (shift.id && data.assignedParamedics && data.assignedParamedics.length > 0) {
            teamParamedicData[shift.id + '_' + rapid.name] = data.assignedParamedics;
            renderTeamParamedics(rapid.name, 'rapid', r, data.assignedParamedics);
        }
        updateRapidStatusIcon(r);
    }
    
    for (var i = 0; i < centerList.length; i++) {
        var center = centerList[i];
        var data = (shift.centersData && shift.centersData[center]) || { staffCount: '', carsCount: '', notes: '', vehicleStatus: '', fuelLevel: '' };
        var staffInput = document.getElementById('staff_' + i);
        var carsInput = document.getElementById('cars_' + i);
        var notesInput = document.getElementById('notes_' + i);
        var vehicleSel = document.getElementById('vehicle_' + i);
        var fuelSel = document.getElementById('fuel_' + i);
        if (staffInput) staffInput.value = data.staffCount || '';
        if (carsInput) carsInput.value = data.carsCount || '';
        if (notesInput) notesInput.value = data.notes || '';
        if (vehicleSel) vehicleSel.value = data.vehicleStatus || '';
        if (fuelSel) fuelSel.value = data.fuelLevel || '';
        var backupParamedicInput = document.getElementById('backup_paramedic_' + i);
        if (backupParamedicInput) backupParamedicInput.value = data.backupParamedic || '';
        // Restore cached paramedic data if available
        if (shift.id && data.assignedParamedics && data.assignedParamedics.length > 0) {
            teamParamedicData[shift.id + '_' + center] = data.assignedParamedics;
            renderTeamParamedics(center, 'center', i, data.assignedParamedics);
        }
        updateStatusIcon(i);
    }
    document.getElementById('generalNotes').value = shift.generalNotes || '';
    initShiftProgressBar();
    loadShiftEventLog();
    loadAbsenceRecords();
    loadShiftNotes();
    updateShiftKPIs();
    loadShiftComparison();
    initAutoSave();
    if (shift.id) {
        loadTeamParamedics(shift.id);
    }
}

// ============================================
// Paramedic display helpers
// ============================================

var teamParamedicData = {};

function safeTeamId(teamName) {
    return teamName.replace(/\s+/g, '_');
}

function renderTeamParamedics(teamName, type, index, paramedics) {
    var safeName = safeTeamId(teamName);
    var container = document.getElementById('paramedics_' + safeName);
    var countDisplay = document.getElementById('staffCountDisplay_' + safeName);
    var staffInputId = type === 'rapid' ? 'rapid_staff_' + index : 'staff_' + index;
    var staffInput = document.getElementById(staffInputId);
    var fallbackDiv = document.getElementById('fallback_' + staffInputId);

    if (!container) return;

    // VA: عداد الفرقة من اشتقاق الخادم (state.teams[teamName].activeCount) —
    // لا اشتقاق محلي من رموز الإكسل. حالة كل مسعف (النقطة) من حقل status
    // الذي يوفره الخادم نفسه في /api/shift-completion/:shiftId/:teamName.
    var derivedTeam = (workforceStateTeams && workforceStateTeams[teamName]) || null;
    var presentCount = 0;
    var html = '';

    if (paramedics.length === 0) {
        html = '<div class="paramedic-no-data">لا يوجد مسعفين مسندين</div>';
        if (fallbackDiv) fallbackDiv.style.display = 'block';
    } else {
        if (fallbackDiv) fallbackDiv.style.display = 'none';
        for (var i = 0; i < paramedics.length; i++) {
            var p = paramedics[i];
            var isPresent = p.status ? (p.status === 'حاضر') : !!(p.shift_code && p.shift_code !== '-');
            if (isPresent) presentCount++;
            var dotClass = isPresent ? 'present' : 'absent';
            var statusText = isPresent ? 'حاضر' : 'غائب';
            var code = p.shift_code || '-';
            html += '<div class="paramedic-item" title="' + (p.name || '') + ' — ' + statusText + '">';
            html += '<span class="paramedic-dot ' + dotClass + '"></span>';
            html += '<span class="paramedic-name">' + (p.name || 'غير معروف') + '</span>';
            html += '<span class="paramedic-code">' + code + '</span>';
            html += '</div>';
        }
    }

    container.innerHTML = html;

    if (countDisplay) {
        countDisplay.textContent = (derivedTeam ? derivedTeam.activeCount : presentCount) + ' حاضر';
    }

    if (staffInput) {
        // تعبئة تلقائية لحقل النموذج (يظل قابلًا للتحرير ويُحفظ ضمن centersData)
        staffInput.value = derivedTeam ? derivedTeam.activeCount : presentCount;
    }

    if (type === 'rapid') {
        updateRapidStatusIcon(index);
    } else {
        updateStatusIcon(index);
    }
    refreshWorkforceFromServer();
    updateShiftKPIs();
}

async function fetchTeamParamedics(shiftId, teamName, type, index) {
    var cacheKey = shiftId + '_' + teamName;
    try {
        var response = await AuthManager.apiRequest('/api/shift-completion/' + shiftId + '/' + encodeURIComponent(teamName) + '?_=' + Date.now());
        var data = await response.json();
        console.log('[PARAMEDICS] Team:', teamName, 'ShiftType:', data.shiftType, 'Count:', data.paramedics.length, 'Codes:', data.paramedics.map(function(p) { return p.shift_code; }));
        var paramedics = data.paramedics || [];
        teamParamedicData[cacheKey] = paramedics;
        renderTeamParamedics(teamName, type, index, paramedics);
    } catch (error) {
        console.error('Failed to fetch paramedics for', teamName, error);
        renderTeamParamedics(teamName, type, index, []);
    }
}

async function loadTeamParamedics(shiftId) {
    if (!shiftId) return;
    // VA: جلب اشتقاق الفرق من المصدر الواحد أولًا — عدادات الأفراد لكل فرقة
    // (staffCountDisplay_*) تُعرض من state.teams[teamName].activeCount المشتق
    // سيرفريًا، لا من اشتقاق محلي لرموز الإكسل.
    try {
        var stRes = await AuthManager.apiRequest('/api/staffing/state?shift_id=' + encodeURIComponent(shiftId));
        var stData = await stRes.json();
        if (stData && stData.success && stData.teams) workforceStateTeams = stData.teams;
    } catch (e) { /* عرض فقط — الفشل صامت */ }
    var teams = [];
    for (var r = 0; r < rapidTeams.length; r++) {
        teams.push({ name: rapidTeams[r].name, type: 'rapid', index: r });
    }
    for (var i = 0; i < centerList.length; i++) {
        teams.push({ name: centerList[i], type: 'center', index: i });
    }
    teams.forEach(function(t) {
        var safeName = safeTeamId(t.name);
        var container = document.getElementById('paramedics_' + safeName);
        if (container) {
            container.innerHTML = '<div class="paramedic-no-data"><i class="fas fa-spinner fa-spin"></i> جاري التحميل...</div>';
        }
    });
    // Add timeout to prevent hanging forever
    var timeoutMs = 8000; // 8 seconds
    var fetchPromises = teams.map(function(team) {
        return fetchTeamParamedics(shiftId, team.name, team.type, team.index);
    });
    var timeoutPromise = new Promise(function(resolve) {
        setTimeout(function() { resolve('timeout'); }, timeoutMs);
    });
    await Promise.race([Promise.all(fetchPromises), timeoutPromise]);
    // If timeout occurred, ensure remaining containers show fallback
    teams.forEach(function(t) {
        var safeName = safeTeamId(t.name);
        var container = document.getElementById('paramedics_' + safeName);
        if (container && container.innerHTML.indexOf('fa-spinner') !== -1) {
            container.innerHTML = '<div class="paramedic-no-data">لا يوجد بيانات (فشل الاتصال)</div>';
        }
    });
}

function normalizeShiftType(type) {
    if (!type) return 'صباح';
    if (type === 'صباحية' || type === 'صباح') return 'صباح';
    if (type === 'ليلية' || type === 'ليل') return 'ليل';
    return type;
}

function getShiftFromForm() {
    var shiftTypeEl = document.querySelector('input[name="shiftType"]:checked');
    var shiftType = shiftTypeEl ? shiftTypeEl.value : (getCurrentShiftType ? getCurrentShiftType() : 'صباح');
    
    // Read rapid response teams data
    var rapidData = {};
    for (var r = 0; r < rapidTeams.length; r++) {
        var rapid = rapidTeams[r];
        var staffInput = document.getElementById('rapid_staff_' + r);
        var carsInput = document.getElementById('rapid_cars_' + r);
        var notesInput = document.getElementById('rapid_notes_' + r);
        rapidData[rapid.name] = {
            staffCount: (staffInput && staffInput.value) ? staffInput.value : '',
            carsCount: (carsInput && carsInput.value) ? carsInput.value : '',
            notes: (notesInput && notesInput.value) ? notesInput.value : '',
            isRapid: true
        };
    }
    
    var centersDataForm = {};
    // Add rapid response data to centersData
    for (var r = 0; r < rapidTeams.length; r++) {
        var rapid = rapidTeams[r];
        var staffInput = document.getElementById('rapid_staff_' + r);
        var carsInput = document.getElementById('rapid_cars_' + r);
        var notesInput = document.getElementById('rapid_notes_' + r);
        var assignedParamedics = teamParamedicData[viewingShiftId + '_' + rapid.name] || [];
        var backupParamedicInput = document.getElementById('backup_paramedic_rapid_' + r);
        centersDataForm[rapid.name] = {
            staffCount: (staffInput && staffInput.value) ? staffInput.value : '',
            carsCount: (carsInput && carsInput.value) ? carsInput.value : '',
            notes: (notesInput && notesInput.value) ? notesInput.value : '',
            vehicleStatus: '',
            fuelLevel: '',
            isRapid: true,
            assignedParamedics: assignedParamedics,
            backupParamedic: (backupParamedicInput && backupParamedicInput.value) ? backupParamedicInput.value : ''
        };
    }
    
    for (var i = 0; i < centerList.length; i++) {
        var center = centerList[i];
        var staffInput = document.getElementById('staff_' + i);
        var carsInput = document.getElementById('cars_' + i);
        var notesInput = document.getElementById('notes_' + i);
        var vehicleSel = document.getElementById('vehicle_' + i);
        var fuelSel = document.getElementById('fuel_' + i);
        var assignedParamedics = teamParamedicData[viewingShiftId + '_' + center] || [];
        var backupParamedicInput = document.getElementById('backup_paramedic_' + i);
        centersDataForm[center] = {
            staffCount: (staffInput && staffInput.value) ? staffInput.value : '',
            carsCount: (carsInput && carsInput.value) ? carsInput.value : '',
            notes: (notesInput && notesInput.value) ? notesInput.value : '',
            vehicleStatus: (vehicleSel && vehicleSel.value) ? vehicleSel.value : '',
            fuelLevel: (fuelSel && fuelSel.value) ? fuelSel.value : '',
            isRapid: false,
            assignedParamedics: assignedParamedics,
            backupParamedic: (backupParamedicInput && backupParamedicInput.value) ? backupParamedicInput.value : ''
        };
    }
    return { shiftType: shiftType, rapidLocations: {}, centersData: centersDataForm, generalNotes: document.getElementById('generalNotes').value };
}

function clearShiftForm() {
    viewingShiftId = null; // Reset to prevent saving to wrong shift
    document.getElementById('shiftDate').innerText = getSaudiDate();
    // Auto-select current shift type based on time
    var currentShiftType = getCurrentShiftType ? getCurrentShiftType() : 'صباح';
    document.querySelectorAll('input[name="shiftType"]').forEach(function(radio) { 
        radio.checked = (radio.value === currentShiftType); 
    });
    // Update badge to current automatic shift
    var typeBadge = document.getElementById('shiftModalTypeBadge');
    if (typeBadge) {
        var shiftType = getCurrentShiftType ? getCurrentShiftType() : 'صباح';
        var shiftDate = getCurrentShiftDate ? getCurrentShiftDate() : getSaudiDate();
        typeBadge.innerHTML = '<span style="background:var(--gold);color:#333;padding:2px 8px;border-radius:12px;font-size:0.75rem;font-weight:600;">' + shiftType + '</span> ' + shiftDate + ' — تسجيل بيانات تكميل النوبة';
    }
    // Clear rapid response teams
    for (var r = 0; r < rapidTeams.length; r++) {
        var staffInput = document.getElementById('rapid_staff_' + r);
        var carsInput = document.getElementById('rapid_cars_' + r);
        var notesInput = document.getElementById('rapid_notes_' + r);
        if (staffInput) staffInput.value = '';
        if (carsInput) carsInput.value = '';
        if (notesInput) notesInput.value = '';
        var backupParamedicInputRapid = document.getElementById('backup_paramedic_rapid_' + r);
        if (backupParamedicInputRapid) backupParamedicInputRapid.value = '';
        var container = document.getElementById('paramedics_' + safeTeamId(rapidTeams[r].name));
        var countDisplay = document.getElementById('staffCountDisplay_' + safeTeamId(rapidTeams[r].name));
        var fallbackDiv = document.getElementById('fallback_rapid_staff_' + r);
        if (container) container.innerHTML = '<div class="paramedic-no-data">اضغط تكميل لتحميل المسعفين</div>';
        if (countDisplay) countDisplay.textContent = '-';
        if (fallbackDiv) fallbackDiv.style.display = 'none';
        updateRapidStatusIcon(r);
    }
    for (var i = 0; i < centerList.length; i++) {
        var staffInput = document.getElementById('staff_' + i);
        var carsInput = document.getElementById('cars_' + i);
        var notesInput = document.getElementById('notes_' + i);
        var vehicleSel = document.getElementById('vehicle_' + i);
        var fuelSel = document.getElementById('fuel_' + i);
        if (staffInput) staffInput.value = '';
        if (carsInput) carsInput.value = '';
        if (notesInput) notesInput.value = '';
        if (vehicleSel) vehicleSel.value = '';
        var backupParamedicInput = document.getElementById('backup_paramedic_' + i);
        if (backupParamedicInput) backupParamedicInput.value = '';
        var safeName = safeTeamId(centerList[i]);
        var container = document.getElementById('paramedics_' + safeName);
        var countDisplay = document.getElementById('staffCountDisplay_' + safeName);
        var fallbackDiv = document.getElementById('fallback_staff_' + i);
        if (container) container.innerHTML = '<div class="paramedic-no-data">اضغط تكميل لتحميل المسعفين</div>';
        if (countDisplay) countDisplay.textContent = '-';
        if (fallbackDiv) fallbackDiv.style.display = 'none';
        updateStatusIcon(i);
    }
    // Clear paramedic cache for current viewing shift
    if (viewingShiftId) {
        for (var key in teamParamedicData) {
            if (key.indexOf(viewingShiftId + '_') === 0) {
                delete teamParamedicData[key];
            }
        }
    }
    document.getElementById('generalNotes').value = '';
    document.getElementById('workforceStats').style.display = 'none';
    document.getElementById('shiftReportStats').style.display = 'none';
}

function displayShiftReportStats(reportsData) {
    var container = document.getElementById('shiftReportStats');
    var listContainer = document.getElementById('unitReportList');
    if (!reportsData || Object.keys(reportsData).length === 0) { container.style.display = 'none'; return; }
    var total = 0;
    var unitStats = {};
    for (var key in reportsData) {
        var report = reportsData[key];
        if (report && report.count > 0) {
            total += report.count;
            var parts = key.split('|');
            var unit = parts.length > 1 ? parts[1] : key;
            if (unit && unit.trim() !== '' && unit !== 'undefined' && unit !== 'null') {
                unitStats[unit] = (unitStats[unit] || 0) + report.count;
            }
        }
    }
    if (total === 0) { container.style.display = 'none'; return; }
    container.style.display = 'block';
    var el_shiftTotalReports = document.getElementById('shiftTotalReports'); if (el_shiftTotalReports) el_shiftTotalReports.innerText = total;
    var sortedUnits = Object.entries(unitStats).sort(function(a, b) { return b[1] - a[1]; });
    var topUnit = sortedUnits.length > 0 ? sortedUnits[0][0] : '-';
    var topCount = sortedUnits.length > 0 ? sortedUnits[0][1] : 0;
    var el_topUnit = document.getElementById('topUnit'); if (el_topUnit) el_topUnit.innerText = topUnit;
    var el_topUnitCount = document.getElementById('topUnitCount'); if (el_topUnitCount) el_topUnitCount.innerText = topCount;
    listContainer.innerHTML = '<div class="title">توزيع البلاغات على الفرق</div>';
    if (sortedUnits.length === 0) {
        listContainer.innerHTML += '<p style="text-align:center; color:var(--gray-400); font-size:0.7rem;">لا توجد بيانات كافية</p>';
        return;
    }
    sortedUnits.forEach(function(item) {
        var percentage = Math.round((item[1] / total) * 100);
        var div = document.createElement('div');
        div.className = 'distribution-bar';
        div.innerHTML = '<span class="name">' + item[0] + '</span><span class="count" style="color:#F1F5F9;">' + item[1] + '</span><div class="bar-track"><div class="bar-fill" style="width:' + percentage + '%; background:#10B586;"></div></div><span class="percent">' + percentage + '%</span>';
        listContainer.appendChild(div);
    });
}

// ============================================
// دوال كبار المسعفين
// ============================================
function renderSeniorRecords() {
    var container = document.getElementById('seniorRecordsList');
    var section = document.getElementById('seniorSavedRecords');
    if (!container || !section) return;
    if (seniorRecords.length === 0) { section.style.display = 'none'; return; }
    section.style.display = 'block';
    var html = '';
    seniorRecords.forEach(function(record, index) {
        var date = getSaudiDateTime();
        var locations = record.locations && record.locations.length ? record.locations.join('، ') : 'لا يوجد';
        html += '<div class="record-item"><div class="record-info"><strong>🚑 ' + (record.activeCars || 0) + '</strong><span style="margin:0 5px;">|</span><span>🔧 ' + (record.brokenCars || 0) + '</span><span style="margin:0 5px;">|</span><span>🔄 ' + (record.reserveCars || 0) + '</span><span style="margin:0 5px;">|</span><span>📊 ' + (record.overlapTeams || 0) + '</span><span style="margin:0 5px;">|</span><span class="rec-locations">📍 ' + locations + '</span><span class="rec-date">🕒 ' + date + '</span>' + (record.assistantName ? '<span style="font-size:0.6rem; color:var(--primary-700);">👤 ' + record.assistantName + '</span>' : '') + '</div><div class="record-actions"><button onclick="deleteSeniorRecord(\'' + record.id + '\')">🗑️ حذف</button></div></div>';
    });
    container.innerHTML = html;
}

function getSeniorShiftData() {
    var activeCars = parseInt(document.getElementById('seniorActiveCars').value) || 0;
    var brokenCars = parseInt(document.getElementById('seniorBrokenCars').value) || 0;
    var reserveCars = parseInt(document.getElementById('seniorReserveCars').value) || 0;
    var overlapTeams = parseInt(document.getElementById('seniorOverlapTeams').value) || 0;
    var locations = [];
    document.querySelectorAll('.senior-location:checked').forEach(function(cb) { locations.push(cb.value); });
    var notes = document.getElementById('seniorNotes').value.trim();
    var assistantName = document.getElementById('seniorAssistantName').value.trim();
    var assistantSignature = document.getElementById('seniorAssistantSignature').value.trim();
    var chiefName = document.getElementById('seniorChiefName').value.trim();
    var chiefSignature = document.getElementById('seniorChiefSignature').value.trim();
    var leaderName = document.getElementById('seniorRegionLeaderName').value.trim();
    var leaderSignature = document.getElementById('seniorRegionLeaderSignature').value.trim();
    return { activeCars: activeCars, brokenCars: brokenCars, reserveCars: reserveCars, overlapTeams: overlapTeams, locations: locations, notes: notes, assistantName: assistantName, assistantSignature: assistantSignature, chiefName: chiefName, chiefSignature: chiefSignature, leaderName: leaderName, leaderSignature: leaderSignature };
}

// حفظ مناوبة كبار المسعفين (واجهة المودال) عبر المصدر الواحد — بنفس مخطط هذه الواجهة كما هو
async function saveSeniorRecordToLocal(data) {
    if (data.activeCars === 0 && data.brokenCars === 0 && data.reserveCars === 0 && data.overlapTeams === 0) { alert('⚠️ الرجاء إدخال بيانات المناوبة (على الأقل قيمة واحدة)'); return false; }
    try {
        var response = await AuthManager.apiRequest('/api/senior-shifts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ activeCars: data.activeCars, brokenCars: data.brokenCars, reserveCars: data.reserveCars, overlapTeams: data.overlapTeams, locations: data.locations, notes: data.notes, assistantName: data.assistantName, assistantSignature: data.assistantSignature, chiefName: data.chiefName, chiefSignature: data.chiefSignature, leaderName: data.leaderName, leaderSignature: data.leaderSignature })
        });
        if (!response.ok) throw new Error('status=' + response.status);
    } catch (e) {
        console.error('❌ فشل في حفظ مناوبة كبار المسعفين:', e);
        alert('❌ فشل في الحفظ — تحقق من الاتصال');
        return false;
    }
    await loadSeniorShifts(); // يحدّث قائمتي الواجهتين معاً
    return true;
}

function clearSeniorShiftForm() {
    var el_seniorActiveCars_v7 = document.getElementById('seniorActiveCars'); if (el_seniorActiveCars_v7) el_seniorActiveCars_v7.value = 0;
    var el_seniorBrokenCars_v8 = document.getElementById('seniorBrokenCars'); if (el_seniorBrokenCars_v8) el_seniorBrokenCars_v8.value = 0;
    var el_seniorReserveCars_v9 = document.getElementById('seniorReserveCars'); if (el_seniorReserveCars_v9) el_seniorReserveCars_v9.value = 0;
    var el_seniorOverlapTeams_v10 = document.getElementById('seniorOverlapTeams'); if (el_seniorOverlapTeams_v10) el_seniorOverlapTeams_v10.value = 0;
    document.querySelectorAll('.senior-location').forEach(function(cb) { cb.checked = false; });
    var el_seniorNotes_v11 = document.getElementById('seniorNotes'); if (el_seniorNotes_v11) el_seniorNotes_v11.value = '';
    var el_seniorAssistantName_v12 = document.getElementById('seniorAssistantName'); if (el_seniorAssistantName_v12) el_seniorAssistantName_v12.value = '';
    var el_seniorAssistantSignature_v13 = document.getElementById('seniorAssistantSignature'); if (el_seniorAssistantSignature_v13) el_seniorAssistantSignature_v13.value = '';
    var el_seniorChiefName_v14 = document.getElementById('seniorChiefName'); if (el_seniorChiefName_v14) el_seniorChiefName_v14.value = '';
    var el_seniorChiefSignature_v15 = document.getElementById('seniorChiefSignature'); if (el_seniorChiefSignature_v15) el_seniorChiefSignature_v15.value = '';
    var el_seniorRegionLeaderName_v16 = document.getElementById('seniorRegionLeaderName'); if (el_seniorRegionLeaderName_v16) el_seniorRegionLeaderName_v16.value = '';
    var el_seniorRegionLeaderSignature_v17 = document.getElementById('seniorRegionLeaderSignature'); if (el_seniorRegionLeaderSignature_v17) el_seniorRegionLeaderSignature_v17.value = '';
}

function formatWhatsAppMessage(data) {
    var now = new Date();
    var dateStr = getSaudiDate();
    var timeStr = getSaudiTime();
    var locationsStr = data.locations && data.locations.length > 0 ? data.locations.join('، ') : 'لا يوجد';
    var message = '';
    message += 'تقرير مناوبة كبار المسعفين\n';
    message += '═══════════════════════════\n';
    message += 'التاريخ: ' + dateStr + '\n';
    message += 'الوقت: ' + timeStr + '\n\n';
    message += 'المركبات العاملة: ' + data.activeCars + '\n';
    message += 'المركبات المتعطلة: ' + data.brokenCars + '\n';
    message += 'مركبات الاحتياط: ' + data.reserveCars + '\n';
    message += 'فرق الاوفر لاب: ' + data.overlapTeams + '\n';
    message += 'مناطق التمركز: ' + locationsStr + '\n\n';
    if (data.notes) { message += 'الملاحظات: ' + data.notes + '\n\n'; }
    message += '═══════════════════════════\n';
    message += 'التسليم والاستلام\n';
    message += 'مساعد كبير المسعفين: ' + (data.assistantName || '———') + '\n';
    message += 'كبير المسعفين: ' + (data.chiefName || '———') + '\n';
    message += 'قائد المنطقة: ' + (data.leaderName || '———') + '\n';
    message += '═══════════════════════════\n';
    message += 'تم الإرسال: ' + dateStr + ' ' + timeStr;
    return message;
}

function sendWhatsAppMessage(message) {
    var encodedMessage = encodeURIComponent(message);
    window.open('https://wa.me/?text=' + encodedMessage, '_blank');
}

var el_seniorShiftBtn=document.getElementById("seniorShiftBtn");if(el_seniorShiftBtn)el_seniorShiftBtn.addEventListener('click', function() {
    var now = new Date();
    var dateStr = getSaudiDate();
    var el_seniorAssistantDate = document.getElementById('seniorAssistantDate'); if (el_seniorAssistantDate) el_seniorAssistantDate.innerText = dateStr;
    var el_seniorChiefDate = document.getElementById('seniorChiefDate'); if (el_seniorChiefDate) el_seniorChiefDate.innerText = dateStr;
    var el_seniorRegionLeaderDate = document.getElementById('seniorRegionLeaderDate'); if (el_seniorRegionLeaderDate) el_seniorRegionLeaderDate.innerText = dateStr;
    var el_seniorPrintDate = document.getElementById('seniorPrintDate'); if (el_seniorPrintDate) el_seniorPrintDate.innerText = dateStr + ' - ' + getSaudiTime();
    openModalById('seniorShiftModal');
    loadSeniorShifts(); // جلب طازج من الخادم (يحدّث قائمة المودال وقائمة النموذج معاً)
});

var el_closeSeniorShift = document.getElementById("closeSeniorShift"); if(el_closeSeniorShift) el_closeSeniorShift.addEventListener('click', function() { closeModalById('seniorShiftModal'); });
var el_saveSeniorShift=document.getElementById("saveSeniorShift");if(el_saveSeniorShift)el_saveSeniorShift.addEventListener('click', async function() {
    var data = getSeniorShiftData();
    if (data.activeCars === 0 && data.brokenCars === 0 && data.reserveCars === 0 && data.overlapTeams === 0) { alert('⚠️ الرجاء إدخال بيانات المناوبة (على الأقل قيمة واحدة)'); return; }
    if (await saveSeniorRecordToLocal(data)) { alert('✅ تم حفظ مناوبة كبار المسعفين بنجاح'); clearSeniorShiftForm(); renderSeniorRecords(); }
});

var el_sendWhatsAppSeniorShift=document.getElementById("sendWhatsAppSeniorShift");if(el_sendWhatsAppSeniorShift)el_sendWhatsAppSeniorShift.addEventListener('click', function() {
    var data = getSeniorShiftData();
    if (data.activeCars === 0 && data.brokenCars === 0 && data.reserveCars === 0 && data.overlapTeams === 0) { alert('⚠️ الرجاء إدخال بيانات المناوبة قبل الإرسال'); return; }
    saveSeniorRecordToLocal(data); // حفظ صامت في الخلفية ثم يفتح واتساب فوراً (نفس السلوك القديم)
    var message = formatWhatsAppMessage(data);
    sendWhatsAppMessage(message);
});

// ============================================
// نظام النماذج الموحدة - JavaScript
// ============================================

// تعريف النماذج المتاحة
var FORM_DEFINITIONS = [
    {
        id: 'senior',
        name: 'كبار المسعفين',
        icon: 'fa-user-md',
        color: '#8B5CF6',
        file: 'form-senior.html',
        description: 'سجلات كبار المسعفين والتخصصات'
    },
    {
        id: 'air',
        name: 'الإسعاف الجوي',
        icon: 'fa-helicopter',
        color: '#10B981',
        file: 'form-air.html',
        description: 'تسجيل بلاغات الإسعاف الجوي'
    },
    {
        id: 'escalation',
        name: 'التصعيد',
        icon: 'fa-arrow-up',
        color: '#EF4444',
        file: 'form-escalation.html',
        description: 'تسجيل بلاغات التصعيد'
    },
    {
        id: 'e',
        name: 'حالات E',
        icon: 'fa-heartbeat',
        color: '#C0392B',
        file: 'form-e.html',
        description: 'حالات توقف قلب وتنفس'
    },
    {
        id: 'incident',
        name: 'بلاغ حادث',
        icon: 'fa-exclamation-circle',
        color: '#F59E0B',
        file: 'form-incident.html',
        description: 'تسجيل بلاغات الحوادث'
    },
    {
        id: 'daily',
        name: 'تقرير يومي',
        icon: 'fa-calendar-day',
        color: '#2563EB',
        file: 'form-daily.html',
        description: 'التقرير اليومي للعمليات'
    }
];

var currentFormId = null;
var loadedForms = {};

function loadFormsList() {
    var container = document.getElementById('formsSidebar');
    if (!container) return;

    var html = '';
    FORM_DEFINITIONS.forEach(form => {
        html += `
            <div onclick="loadForm('${form.id}')" 
                 class="forms-sidebar-item"
                 data-form-id="${form.id}">
                <div class="icon" style="background:${form.color}22; color:${form.color};">
                    <i class="fas ${form.icon}"></i>
                </div>
                <div class="text">
                    <div class="name">${form.name}</div>
                    <div class="desc">${form.description}</div>
                </div>
            </div>
        `;
    });
    container.innerHTML = html;
}

async function loadForm(formId) {
    if (loadedForms[formId]) {
        showFormContent(formId);
        return;
    }

    var formDef = FORM_DEFINITIONS.find(f => f.id === formId);
    if (!formDef) {
        alert('❌ النموذج غير موجود');
        return;
    }

    var el_formLoading_d36 = document.getElementById('formLoading'); if (el_formLoading_d36) el_formLoading_d36.style.display = 'block';
    var el_formContent_h8 = document.getElementById('formContent'); if (el_formContent_h8) el_formContent_h8.innerHTML = '';

    try {
        var response = await fetch(`/forms/${formDef.file}`);
        if (!response.ok) throw new Error('فشل في تحميل النموذج');
        
        var html = await response.text();
        loadedForms[formId] = html;
        showFormContent(formId);
        
    } catch (error) {
        console.error('خطأ في تحميل النموذج:', error);
        var loadingEl = document.getElementById('formLoading');
        if (loadingEl) loadingEl.style.display = 'none';
        var el_formContent_h9 = document.getElementById('formContent'); if (el_formContent_h9) el_formContent_h9.innerHTML = `
            <div style="text-align:center; padding:40px 0; color:var(--coral);">
                <i class="fas fa-exclamation-triangle" style="font-size:2rem;"></i>
                <p style="margin-top:10px;">❌ فشل في تحميل النموذج: ${error.message}</p>
                <button onclick="loadForm('${formId}')" class="btn btn-primary" style="margin-top:10px; padding:8px 24px; border-radius:30px; background:var(--primary-700); color:white; border:none; cursor:pointer;">
                    <i class="fas fa-sync"></i> إعادة المحاولة
                </button>
            </div>
        `;
    }
}

function showFormContent(formId) {
    var content = document.getElementById('formContent');
    var loading = document.getElementById('formLoading');
    var html = loadedForms[formId];
    
    if (html) {
        loading.style.display = 'none';
        content.innerHTML = html;
        currentFormId = formId;
        
        // Update sidebar active state
        document.querySelectorAll('.forms-sidebar-item').forEach(el => {
            el.classList.remove('active');
        });
        var formDef = FORM_DEFINITIONS.find(f => f.id === formId);
        if (formDef) {
            var activeItem = document.querySelector('.forms-sidebar-item[data-form-id="' + formId + '"]');
            if (activeItem) {
                activeItem.classList.add('active');
            }
        }
        
        // Execute init function after content is loaded
        executeFormScripts(formId);
    } else {
        if (loading) loading.style.display = 'none';
        content.innerHTML = '<div style="text-align:center; padding:40px 0; color:var(--gray-400);"><i class="fas fa-inbox" style="font-size:2rem;"></i><p style="margin-top:10px;">الرجاء اختيار نموذج من القائمة</p></div>';
    }
}

function closeFormsModal() {
    closeModalById('formsModal');
}

function closeAnalyticsModal() {
    closeModalById('analyticsModal');
}

function closeChartsModal() {
    closeModalById('chartsModal');
}

function executeFormScripts(formId) {
    setTimeout(function() {
        var fn = window['initForm_' + formId.replace(/-/g, '_')];
        if (typeof fn === 'function') {
            try { fn(); } catch(e) { console.error('initForm error:', e); }
        }
        var fn2 = window['initForm_' + formId];
        if (typeof fn2 === 'function') {
            try { fn2(); } catch(e) { console.error('initForm error:', e); }
        }
    }, 200);
}

// ============================================
// FORM FUNCTIONS - نماذج التشغيلية
// ============================================

// ----- نموذج بلاغ حادث (incident) -----
// الخادم هو مصدر الحقيقة الوحيد — تُحمَّل السجلات من الخدمة عبر loadIncidentRecords
var incidentRecords = [];

// الترحيل يحاول مرة واحدة لكل تحميل صفحة — لا يُحذف المفتاح إلا بعد نجاح رفع الكل
var incidentRecordsMigrated = false;
async function migrateLocalIncidentRecords() {
    var raw = localStorage.getItem('incidentRecords');
    if (!raw) return;
    var items;
    try { items = JSON.parse(raw); } catch (e) { items = null; }
    if (!Array.isArray(items)) { console.warn('⚠️ تعذر تحليل بلاغات الحوادث المحلية — تُرك المفتاح كما هو'); return; }
    if (items.length === 0) { localStorage.removeItem('incidentRecords'); return; }
    try {
        for (var i = 0; i < items.length; i++) {
            var migRes = await AuthManager.apiRequest('/api/incidents', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(items[i])
            });
            if (!migRes.ok) throw new Error('status=' + migRes.status);
        }
        localStorage.removeItem('incidentRecords');
    } catch (e) {
        console.warn('⚠️ فشل ترحيل بلاغات الحوادث المحلية — تُعاد المحاولة عند التحميل القادم', e);
    }
}

// جلب البلاغات من الخدمة ثم تحديث المعاينة (اسم الخطاف للمزامنة اللحظية)
async function loadIncidentRecords() {
    try {
        if (!incidentRecordsMigrated) {
            incidentRecordsMigrated = true;
            await migrateLocalIncidentRecords();
        }
        var response = await AuthManager.apiRequest('/api/incidents');
        if (!response.ok) throw new Error('status=' + response.status);
        var data = await response.json();
        incidentRecords = (data && data.records) || [];
        renderIncidentPreview();
    } catch (e) {
        console.error('❌ فشل تحميل بلاغات الحوادث:', e);
    }
}

function initForm_incident() {
    var dt = getRiyadhLocalInputValue(); // جدارية الرياض (كانت toISOString UTC)
    var el = document.getElementById('incDateTime');
    if (el) el.value = dt;
    renderIncidentPreview();
    loadIncidentRecords();
}

async function saveIncident() {
    var reportNumber = (document.getElementById('incReportNumber') || {}).value || '';
    var dateTime = (document.getElementById('incDateTime') || {}).value || '';
    var type = (document.getElementById('incType') || {}).value || '';
    var location = (document.getElementById('incLocation') || {}).value || '';
    var unit = (document.getElementById('incUnit') || {}).value || '';
    var center = (document.getElementById('incCenter') || {}).value || '';
    var patientName = (document.getElementById('incPatientName') || {}).value || '';
    var age = (document.getElementById('incAge') || {}).value || '';
    var gender = (document.getElementById('incGender') || {}).value || '';
    var description = (document.getElementById('incDescription') || {}).value || '';
    var actions = (document.getElementById('incActions') || {}).value || '';

    if (!reportNumber || !type || !location) {
        alert('⚠️ الرجاء ملء الحقول المطلوبة (رقم البلاغ، نوع الحادث، الموقع)');
        return;
    }

    // نفس الكائن الذي كانت الواجهة تخزنه محلياً (الخادم يختم createdAt)
    var record = {
        reportNumber: reportNumber.trim(),
        dateTime: dateTime,
        type: type,
        location: location.trim(),
        unit: unit,
        center: center,
        patientName: patientName.trim(),
        age: age,
        gender: gender,
        description: description.trim(),
        actions: actions.trim()
    };
    try {
        var response = await AuthManager.apiRequest('/api/incidents', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(record)
        });
        if (!response.ok) throw new Error('status=' + response.status);
    } catch (e) {
        console.error('❌ فشل في حفظ بلاغ الحادث:', e);
        alert('❌ فشل في الحفظ — تحقق من الاتصال');
        return;
    }
    alert('✅ تم حفظ بلاغ الحادث');
    clearIncidentForm();
    await loadIncidentRecords();
}

function clearIncidentForm() {
    var ids = ['incReportNumber','incLocation','incPatientName','incAge','incDescription','incActions'];
    ids.forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.value = '';
    });
    var typeEl = document.getElementById('incType');
    if (typeEl) typeEl.selectedIndex = 0;
    var unitEl = document.getElementById('incUnit');
    if (unitEl) unitEl.selectedIndex = 0;
    var centerEl = document.getElementById('incCenter');
    if (centerEl) centerEl.selectedIndex = 0;
    var genderEl = document.getElementById('incGender');
    if (genderEl) genderEl.selectedIndex = 0;
    var dtEl = document.getElementById('incDateTime');
    if (dtEl) dtEl.value = getRiyadhLocalInputValue(); // جدارية الرياض (كانت UTC)
}

function sendIncidentWhatsApp() {
    var reportNumber = (document.getElementById('incReportNumber') || {}).value || '';
    var dateTime = (document.getElementById('incDateTime') || {}).value || '';
    var type = (document.getElementById('incType') || {}).value || '';
    var location = (document.getElementById('incLocation') || {}).value || '';
    var unit = (document.getElementById('incUnit') || {}).value || '';
    var center = (document.getElementById('incCenter') || {}).value || '';
    var patientName = (document.getElementById('incPatientName') || {}).value || '';
    var age = (document.getElementById('incAge') || {}).value || '';
    var gender = (document.getElementById('incGender') || {}).value || '';
    var description = (document.getElementById('incDescription') || {}).value || '';
    var actions = (document.getElementById('incActions') || {}).value || '';

    if (!reportNumber || !type || !location) {
        alert('⚠️ الرجاء ملء الحقول المطلوبة');
        return;
    }

    var msg = '🚨 *بلاغ حادث*\n';
    msg += '═══════════════════\n';
    msg += 'رقم البلاغ: ' + reportNumber + '\n';
    msg += 'التاريخ: ' + (dateTime ? dateTime.replace('T', ' ') : '-') + '\n';
    msg += 'نوع الحادث: ' + type + '\n';
    msg += 'الموقع: ' + location + '\n';
    if (unit) msg += 'الفرقة: ' + unit + '\n';
    if (center) msg += 'المركز: ' + center + '\n';
    if (patientName) msg += 'المريض: ' + patientName + ' (' + age + ' سنة، ' + gender + ')\n';
    if (description) msg += 'الوصف: ' + description + '\n';
    if (actions) msg += 'الإجراءات: ' + actions + '\n';
    msg += '═══════════════════\n';
    msg += 'تم الإرسال: ' + TimeRiyadh.formatDateTimeSec(new Date());

    window.open('https://wa.me/?text=' + encodeURIComponent(msg), '_blank');
}

function renderIncidentPreview() {
    var container = document.getElementById('incidentPreviewList');
    if (!container) return;
    if (!incidentRecords || incidentRecords.length === 0) {
        container.innerHTML = '<p style="text-align:center; color:var(--gray-400); padding:20px;">📭 لا توجد بلاغات محفوظة</p>';
        return;
    }
    var html = '';
    incidentRecords.forEach(function(rec, i) {
        var date = TimeRiyadh.formatDateTimeSec(rec.createdAt);
        html += '<div style="border:1px solid var(--gray-200); border-radius:8px; padding:10px; margin-bottom:8px; background:var(--white);">';
        html += '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">';
        html += '<strong style="color:var(--primary-700);">' + (rec.reportNumber || 'بدون رقم') + '</strong>';
        html += '<span style="font-size:0.7rem; color:var(--gray-400);">' + date + '</span></div>';
        html += '<div style="font-size:0.8rem; color:var(--gray-600);">';
        html += '📍 ' + (rec.location || '-') + ' | ' + (rec.type || '-') + ' | ' + (rec.unit || '-') + '</div>';
        if (rec.patientName) html += '<div style="font-size:0.8rem; color:var(--gray-600);">👤 ' + rec.patientName + '</div>';
        html += '<div style="display:flex; gap:6px; margin-top:8px;">';
        html += '<button onclick="deleteIncidentRecord(\'' + rec.id + '\')" style="padding:4px 10px; font-size:0.7rem; border-radius:4px; border:1px solid var(--coral); background:var(--coral-50); color:var(--coral); cursor:pointer;">🗑️ حذف</button>';
        html += '</div></div>';
    });
    container.innerHTML = html;
}

// حذف بالمعرف عبر المصدر الواحد ثم إعادة الجلب
async function deleteIncidentRecord(id) {
    if (!confirm('⚠️ هل أنت متأكد من الحذف؟')) return;
    try {
        var response = await AuthManager.apiRequest('/api/incidents/' + encodeURIComponent(id), { method: 'DELETE' });
        if (!response.ok) throw new Error('status=' + response.status);
    } catch (e) {
        console.error('❌ فشل في حذف بلاغ الحادث:', e);
        alert('❌ فشل في الحذف — تحقق من الاتصال');
        return;
    }
    await loadIncidentRecords();
}

// ----- نموذج تسليم مناوبة كبار المسعفين (senior) -----
// الخادم هو مصدر الحقيقة الوحيد — تُحمَّل السجلات من الخدمة عبر loadSeniorShifts
var seniorRecords = [];

// الترحيل يحاول مرة واحدة لكل تحميل صفحة — يُرفع كل سجل كما هو (مخططا الواجهتين موجودان ميدانياً)
var seniorRecordsMigrated = false;
async function migrateLocalSeniorShiftRecords() {
    var raw = localStorage.getItem('seniorShiftRecords');
    if (!raw) return;
    var items;
    try { items = JSON.parse(raw); } catch (e) { items = null; }
    if (!Array.isArray(items)) { console.warn('⚠️ تعذر تحليل مناوبات كبار المسعفين المحلية — تُرك المفتاح كما هو'); return; }
    if (items.length === 0) { localStorage.removeItem('seniorShiftRecords'); return; }
    try {
        for (var i = 0; i < items.length; i++) {
            var migRes = await AuthManager.apiRequest('/api/senior-shifts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(items[i])
            });
            if (!migRes.ok) throw new Error('status=' + migRes.status);
        }
        localStorage.removeItem('seniorShiftRecords');
    } catch (e) {
        console.warn('⚠️ فشل ترحيل مناوبات كبار المسعفين المحلية — تُعاد المحاولة عند التحميل القادم', e);
    }
}

// جلب المناوبات من الخدمة ثم تحديث قائمتي الواجهتين (المودال + النموذج) — اسم الخطاف للمزامنة اللحظية
async function loadSeniorShifts() {
    try {
        if (!seniorRecordsMigrated) {
            seniorRecordsMigrated = true;
            await migrateLocalSeniorShiftRecords();
        }
        var response = await AuthManager.apiRequest('/api/senior-shifts');
        if (!response.ok) throw new Error('status=' + response.status);
        var data = await response.json();
        seniorRecords = (data && data.records) || [];
        renderSeniorRecords();
        renderSeniorPreview();
    } catch (e) {
        console.error('❌ فشل تحميل مناوبات كبار المسعفين:', e);
    }
}

function initForm_senior() {
    var today = TimeRiyadh.formatDate(new Date());
    var dtEls = ['senAsstDate', 'senChiefDate', 'senCmdrDate'];
    dtEls.forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.value = today;
    });
    renderSeniorPreview();
    loadSeniorShifts();
}

async function saveSenior() {
    var workingCars = (document.getElementById('senWorkingCars') || {}).value || '0';
    var brokenCars = (document.getElementById('senBrokenCars') || {}).value || '0';
    var reserveCars = (document.getElementById('senReserveCars') || {}).value || '0';
    var overlapTeams = (document.getElementById('senOverlapTeams') || {}).value || '0';

    var areas = [];
    if ((document.getElementById('senAreaShifa') || {}).checked) areas.push('الشفاء');
    if ((document.getElementById('senAreaOkaz') || {}).checked) areas.push('عكاظ');
    if ((document.getElementById('senAreaDar') || {}).checked) areas.push('الدار البيضاء');
    if ((document.getElementById('senAreaIskan') || {}).checked) areas.push('الإسكان');
    if ((document.getElementById('senAreaMansoura') || {}).checked) areas.push('المنصورة');

    var notes = (document.getElementById('senNotes') || {}).value || '';

    var asstName = (document.getElementById('senAsstName') || {}).value || '';
    var asstSign = (document.getElementById('senAsstSign') || {}).value || '';
    var asstDate = (document.getElementById('senAsstDate') || {}).value || '';

    var chiefName = (document.getElementById('senChiefName') || {}).value || '';
    var chiefSign = (document.getElementById('senChiefSign') || {}).value || '';
    var chiefDate = (document.getElementById('senChiefDate') || {}).value || '';

    var cmdrName = (document.getElementById('senCmdrName') || {}).value || '';
    var cmdrSign = (document.getElementById('senCmdrSign') || {}).value || '';
    var cmdrDate = (document.getElementById('senCmdrDate') || {}).value || '';

    if (!asstName || !chiefName) {
        alert('⚠️ الرجاء ملء أسماء مساعد كبير المسعفين وكبير المسعفين');
        return;
    }

    // نفس مخطط هذه الواجهة كما هو (الخادم يختم createdAt) — يُحفظ عبر المصدر الواحد
    var record = {
        workingCars: workingCars,
        brokenCars: brokenCars,
        reserveCars: reserveCars,
        overlapTeams: overlapTeams,
        overlapAreas: areas,
        notes: notes.trim(),
        asstName: asstName.trim(),
        asstSign: asstSign.trim(),
        asstDate: asstDate,
        chiefName: chiefName.trim(),
        chiefSign: chiefSign.trim(),
        chiefDate: chiefDate,
        cmdrName: cmdrName.trim(),
        cmdrSign: cmdrSign.trim(),
        cmdrDate: cmdrDate
    };
    try {
        var response = await AuthManager.apiRequest('/api/senior-shifts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(record)
        });
        if (!response.ok) throw new Error('status=' + response.status);
    } catch (e) {
        console.error('❌ فشل في حفظ مناوبة كبار المسعفين:', e);
        alert('❌ فشل في الحفظ — تحقق من الاتصال');
        return;
    }
    alert('✅ تم حفظ مناوبة كبار المسعفين');
    clearSeniorForm();
    await loadSeniorShifts();
}

function clearSeniorForm() {
    var numberIds = ['senWorkingCars', 'senBrokenCars', 'senReserveCars', 'senOverlapTeams'];
    numberIds.forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.value = '0';
    });

    var checkIds = ['senAreaShifa', 'senAreaOkaz', 'senAreaDar', 'senAreaIskan', 'senAreaMansoura'];
    checkIds.forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.checked = false;
    });

    var textIds = ['senNotes', 'senAsstName', 'senAsstSign', 'senChiefName', 'senChiefSign', 'senCmdrName', 'senCmdrSign'];
    textIds.forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.value = '';
    });

    var today = TimeRiyadh.formatDate(new Date());
    var dtIds = ['senAsstDate', 'senChiefDate', 'senCmdrDate'];
    dtIds.forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.value = today;
    });
}

function sendSeniorWhatsApp() {
    var workingCars = (document.getElementById('senWorkingCars') || {}).value || '0';
    var brokenCars = (document.getElementById('senBrokenCars') || {}).value || '0';
    var reserveCars = (document.getElementById('senReserveCars') || {}).value || '0';
    var overlapTeams = (document.getElementById('senOverlapTeams') || {}).value || '0';

    var areas = [];
    if ((document.getElementById('senAreaShifa') || {}).checked) areas.push('الشفاء');
    if ((document.getElementById('senAreaOkaz') || {}).checked) areas.push('عكاظ');
    if ((document.getElementById('senAreaDar') || {}).checked) areas.push('الدار البيضاء');
    if ((document.getElementById('senAreaIskan') || {}).checked) areas.push('الإسكان');
    if ((document.getElementById('senAreaMansoura') || {}).checked) areas.push('المنصورة');

    var notes = (document.getElementById('senNotes') || {}).value || '';
    var asstName = (document.getElementById('senAsstName') || {}).value || '';
    var chiefName = (document.getElementById('senChiefName') || {}).value || '';
    var cmdrName = (document.getElementById('senCmdrName') || {}).value || '';

    if (!asstName || !chiefName) {
        alert('⚠️ الرجاء ملء أسماء مساعد كبير المسعفين وكبير المسعفين');
        return;
    }

    var msg = '📋 *تسليم مناوبة كبار المسعفين*\n';
    msg += '═══════════════════\n';
    msg += '🚑 المركبات العاملة: ' + workingCars + '\n';
    msg += '🔧 المركبات المتعطلة: ' + brokenCars + '\n';
    msg += '📦 مركبات الاحتياط: ' + reserveCars + '\n';
    msg += '🔗 فرق الاوفر لاب: ' + overlapTeams + '\n';
    if (areas.length > 0) msg += '📍 مناطق التمركز: ' + areas.join('، ') + '\n';
    if (notes) msg += '📝 ملاحظات: ' + notes + '\n';
    msg += '═══════════════════\n';
    msg += '👤 مساعد كبير المسعفين: ' + asstName + '\n';
    msg += '👨‍⚕️ كبير المسعفين: ' + chiefName + '\n';
    if (cmdrName) msg += '👮 قائد المنطقة: ' + cmdrName + '\n';
    msg += '═══════════════════\n';
    msg += 'تم الإرسال: ' + TimeRiyadh.formatDateTimeSec(new Date());

    window.open('https://wa.me/?text=' + encodeURIComponent(msg), '_blank');
}

function renderSeniorPreview() {
    var container = document.getElementById('seniorPreviewList');
    if (!container) return;
    if (!seniorRecords || seniorRecords.length === 0) {
        container.innerHTML = '<p style="text-align:center; color:var(--gray-400); padding:20px;">📭 لا توجد مناوبات محفوظة</p>';
        return;
    }
    var html = '';
    seniorRecords.forEach(function(rec, i) {
        var date = TimeRiyadh.formatDateTimeSec(rec.createdAt);
        var totalCars = (parseInt(rec.workingCars) || 0) + (parseInt(rec.reserveCars) || 0);
        html += '<div style="border:1px solid var(--gray-200); border-radius:8px; padding:10px; margin-bottom:8px; background:var(--white);">';
        html += '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">';
        html += '<strong style="color:var(--primary-700);">🚑 المركبات: ' + totalCars + ' (عاملة: ' + (rec.workingCars || 0) + ')</strong>';
        html += '<span style="font-size:0.7rem; color:var(--gray-400);">' + date + '</span></div>';
        html += '<div style="font-size:0.8rem; color:var(--gray-600);">';
        html += '👤 ' + (rec.asstName || '-') + ' ← ' + (rec.chiefName || '-') + '</div>';
        if (rec.overlapAreas && rec.overlapAreas.length > 0) {
            html += '<div style="font-size:0.8rem; color:var(--gray-600);">📍 ' + rec.overlapAreas.join('، ') + '</div>';
        }
        html += '<div style="display:flex; gap:6px; margin-top:8px;">';
        html += '<button onclick="deleteSeniorRecord(\'' + rec.id + '\')" style="padding:4px 10px; font-size:0.7rem; border-radius:4px; border:1px solid var(--coral); background:var(--coral-50); color:var(--coral); cursor:pointer;">🗑️ حذف</button>';
        html += '</div></div>';
    });
    container.innerHTML = html;
}

// حذف بالمعرف عبر المصدر الواحد — يحدّث قائمتي الواجهتين معاً
async function deleteSeniorRecord(id) {
    if (!confirm('⚠️ هل أنت متأكد من الحذف؟')) return;
    try {
        var response = await AuthManager.apiRequest('/api/senior-shifts/' + encodeURIComponent(id), { method: 'DELETE' });
        if (!response.ok) throw new Error('status=' + response.status);
    } catch (e) {
        console.error('❌ فشل في حذف مناوبة كبار المسعفين:', e);
        alert('❌ فشل في الحذف — تحقق من الاتصال');
        return;
    }
    await loadSeniorShifts();
}

// ----- نموذج الإسعاف الجوي (air) -----
// الخادم هو مصدر الحقيقة الوحيد — تُحمَّل السجلات من الخدمة عبر loadAirRecords
var airRecords = [];

function initForm_air() {
    var el = document.getElementById('airDateTime');
    if (el) el.value = getRiyadhLocalInputValue(); // جدارية الرياض (كانت UTC)
    renderAirPreview();
    loadAirRecords();
}

// قراءة حقول النموذج من حاويته فقط — يمنع أي التباس مع عناصر أخرى بنفس المعرف
function fq(id) { return document.querySelector('#formContent #' + id); }

async function saveAirAmbulance() {
    var reportNumber = (fq('airReportNumber') || {}).value || '';
    var dateTime = (fq('airDateTime') || {}).value || '';
    var pickupLocation = (fq('airPickupLocation') || {}).value || '';
    var destinationHospital = (fq('airDestinationHospital') || {}).value || '';
    var diagnosis = (fq('airDiagnosis') || {}).value || '';
    var reason = (fq('airReason') || {}).value || '';
    var patientName = (fq('airPatientName') || {}).value || '';
    var patientAge = (fq('airPatientAge') || {}).value || '';
    var unit = (fq('airUnit') || {}).value || '';
    var paramedic = (fq('airParamedic') || {}).value || '';

    if (!reportNumber || !pickupLocation || !destinationHospital || !unit) {
        alert('⚠️ الرجاء ملء الحقول المطلوبة');
        return;
    }

    // نفس الكائن الذي كانت الواجهة تخزنه محلياً (الخادم يختم createdAt ويشتق الحقول التوافقية)
    var record = {
        reportNumber: reportNumber.trim(),
        dateTime: dateTime,
        pickupLocation: pickupLocation.trim(),
        destinationHospital: destinationHospital.trim(),
        diagnosis: diagnosis.trim(),
        reason: reason.trim(),
        patientName: patientName.trim(),
        patientAge: patientAge,
        unit: unit,
        paramedic: paramedic.trim()
    };
    try {
        var response = await AuthManager.apiRequest('/api/save-air-ambulance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(record)
        });
        if (!response.ok) throw new Error('status=' + response.status);
    } catch (e) {
        console.error('❌ فشل في حفظ طلب الإسعاف الجوي:', e);
        alert('❌ فشل في الحفظ — تحقق من الاتصال');
        return;
    }
    alert('✅ تم حفظ طلب الإسعاف الجوي');
    clearAirForm();
    await loadAirRecords();
}

function clearAirForm() {
    var ids = ['airReportNumber','airPickupLocation','airDestinationHospital','airDiagnosis','airReason','airPatientName','airPatientAge','airParamedic'];
    ids.forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.value = '';
    });
    var unitEl = document.getElementById('airUnit');
    if (unitEl) unitEl.value = '';
    var dtEl = document.getElementById('airDateTime');
    if (dtEl) dtEl.value = getRiyadhLocalInputValue(); // جدارية الرياض (كانت UTC)
}

function sendAirWhatsApp() {
    var reportNumber = (document.getElementById('airReportNumber') || {}).value || '';
    var dateTime = (document.getElementById('airDateTime') || {}).value || '';
    var pickupLocation = (document.getElementById('airPickupLocation') || {}).value || '';
    var destinationHospital = (document.getElementById('airDestinationHospital') || {}).value || '';
    var diagnosis = (document.getElementById('airDiagnosis') || {}).value || '';
    var reason = (document.getElementById('airReason') || {}).value || '';
    var patientName = (document.getElementById('airPatientName') || {}).value || '';
    var patientAge = (document.getElementById('airPatientAge') || {}).value || '';
    var unit = (document.getElementById('airUnit') || {}).value || '';
    var paramedic = (document.getElementById('airParamedic') || {}).value || '';

    if (!reportNumber || !pickupLocation || !destinationHospital || !unit) {
        alert('⚠️ الرجاء ملء الحقول المطلوبة');
        return;
    }

    var msg = '🚁 *طلب إسعاف جوي*\n';
    msg += '═══════════════════\n';
    msg += 'رقم البلاغ: ' + reportNumber + '\n';
    msg += 'التاريخ: ' + (dateTime ? dateTime.replace('T', ' ') : '-') + '\n';
    msg += 'موقع الإخلاء: ' + pickupLocation + '\n';
    msg += 'المستشفى: ' + destinationHospital + '\n';
    msg += 'التشخيص: ' + diagnosis + '\n';
    msg += 'السبب: ' + reason + '\n';
    msg += 'المريض: ' + patientName + ' (' + patientAge + ' سنة)\n';
    msg += 'الفرقة: ' + unit + '\n';
    msg += 'المسعف: ' + paramedic + '\n';
    msg += '═══════════════════\n';
    msg += 'تم الإرسال: ' + TimeRiyadh.formatDateTimeSec(new Date());

    window.open('https://wa.me/?text=' + encodeURIComponent(msg), '_blank');
}

function renderAirPreview() {
    var container = document.getElementById('airPreviewList');
    if (!container) return;
    if (!airRecords || airRecords.length === 0) {
        container.innerHTML = '<p style="text-align:center; color:var(--gray-400); padding:20px;">📭 لا توجد طلبات محفوظة</p>';
        return;
    }
    var html = '';
    airRecords.forEach(function(rec, i) {
        var date = TimeRiyadh.formatDateTimeSec(rec.createdAt);
        html += '<div style="border:1px solid var(--gray-200); border-radius:8px; padding:10px; margin-bottom:8px; background:var(--white);">';
        html += '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">';
        html += '<strong style="color:var(--primary-700);">' + (rec.reportNumber || 'بدون رقم') + '</strong>';
        html += '<span style="font-size:0.7rem; color:var(--gray-400);">' + date + '</span></div>';
        html += '<div style="font-size:0.8rem; color:var(--gray-600);">';
        html += '🚁 ' + (rec.pickupLocation || '-') + ' → ' + (rec.destinationHospital || '-') + '</div>';
        html += '<div style="display:flex; gap:6px; margin-top:8px;">';
        html += '<button onclick="deleteAirRecord(\'' + rec.id + '\')" style="padding:4px 10px; font-size:0.7rem; border-radius:4px; border:1px solid var(--coral); background:var(--coral-50); color:var(--coral); cursor:pointer;">🗑️ حذف</button>';
        html += '</div></div>';
    });
    container.innerHTML = html;
}

// حذف بالمعرف عبر المصدر الواحد ثم إعادة الجلب
async function deleteAirRecord(id) {
    if (!confirm('⚠️ هل أنت متأكد من الحذف؟')) return;
    try {
        var response = await AuthManager.apiRequest('/api/delete-air-ambulance/' + encodeURIComponent(id), { method: 'DELETE' });
        if (!response.ok) throw new Error('status=' + response.status);
    } catch (e) {
        console.error('❌ فشل في حذف بلاغ الإسعاف الجوي:', e);
        alert('❌ فشل في الحذف — تحقق من الاتصال');
        return;
    }
    await loadAirRecords();
}

// ----- نموذج التقرير اليومي (daily) -----
// الخادم هو مصدر الحقيقة الوحيد — تُحمَّل السجلات من الخدمة عبر loadDailyRecords
var dailyRecords = [];

// الترحيل يحاول مرة واحدة لكل تحميل صفحة — لا يُحذف المفتاح إلا بعد نجاح رفع الكل
var dailyRecordsMigrated = false;
async function migrateLocalDailyRecords() {
    var raw = localStorage.getItem('dailyRecords');
    if (!raw) return;
    var items;
    try { items = JSON.parse(raw); } catch (e) { items = null; }
    if (!Array.isArray(items)) { console.warn('⚠️ تعذر تحليل التقارير اليومية المحلية — تُرك المفتاح كما هو'); return; }
    if (items.length === 0) { localStorage.removeItem('dailyRecords'); return; }
    try {
        for (var i = 0; i < items.length; i++) {
            var migRes = await AuthManager.apiRequest('/api/daily-reports', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(items[i])
            });
            if (!migRes.ok) throw new Error('status=' + migRes.status);
        }
        localStorage.removeItem('dailyRecords');
    } catch (e) {
        console.warn('⚠️ فشل ترحيل التقارير اليومية المحلية — تُعاد المحاولة عند التحميل القادم', e);
    }
}

// جلب التقارير من الخدمة ثم تحديث المعاينة (اسم الخطاف للمزامنة اللحظية)
async function loadDailyRecords() {
    try {
        if (!dailyRecordsMigrated) {
            dailyRecordsMigrated = true;
            await migrateLocalDailyRecords();
        }
        var response = await AuthManager.apiRequest('/api/daily-reports');
        if (!response.ok) throw new Error('status=' + response.status);
        var data = await response.json();
        dailyRecords = (data && data.records) || [];
        renderDailyPreview();
    } catch (e) {
        console.error('❌ فشل تحميل التقارير اليومية:', e);
    }
}

function initForm_daily() {
    var el = document.getElementById('dailyDate');
    if (el) el.value = TimeRiyadh.formatDate(new Date());
    renderDailyPreview();
    loadDailyRecords(); // حلّ محل القراءة الكسولة من localStorage
}

function renderDailyPreview() {
    var container = document.getElementById('dailyPreviewList');
    if (!container) return;
    if (!dailyRecords || dailyRecords.length === 0) {
        container.innerHTML = '<p style="text-align:center; color:var(--gray-400); padding:20px;">📭 لا توجد تقارير محفوظة</p>';
        return;
    }
    var html = '';
    dailyRecords.forEach(function(rec, i) {
        var date = TimeRiyadh.formatDateTimeSec(rec.createdAt);
        var paths = rec.paths && rec.paths.length ? rec.paths.join('، ') : 'لا يوجد';
        html += '<div style="border:1px solid var(--gray-200); border-radius:8px; padding:10px; margin-bottom:8px; background:var(--white);">';
        html += '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">';
        html += '<strong style="color:var(--primary-700);">' + (rec.reportNumber || 'بدون رقم') + '</strong>';
        html += '<span style="font-size:0.7rem; color:var(--gray-400);">' + date + '</span></div>';
        html += '<div style="font-size:0.8rem; color:var(--gray-600);">';
        html += '📅 ' + (rec.date || '-') + ' | 🚑 ' + (rec.responseTeams || 0) + ' | ✈️ ' + (rec.air || 0) + '</div>';
        if (rec.borderReports) html += '<div style="font-size:0.8rem; color:var(--gray-600);">🌐 ' + rec.borderReports + '</div>';
        html += '<div style="font-size:0.75rem; color:var(--gray-500);">🛣️ ' + paths + '</div>';
        html += '<div style="display:flex; gap:6px; margin-top:8px;">';
        html += '<button onclick="deleteDailyRecord(\'' + rec.id + '\')" style="padding:4px 10px; font-size:0.7rem; border-radius:4px; border:1px solid var(--coral); background:var(--coral-50); color:var(--coral); cursor:pointer;">🗑️ حذف</button>';
        html += '</div></div>';
    });
    container.innerHTML = html;
}

async function saveDailyReport() {
    var reportNumber = (document.getElementById('dailyReportNumber') || {}).value || '';
    var date = (document.getElementById('dailyDate') || {}).value || '';
    var responseTeams = (document.getElementById('dailyResponseTeams') || {}).value || 0;
    var air = (document.getElementById('dailyAir') || {}).value || 0;
    var borderReports = (document.getElementById('dailyBorderReports') || {}).value || '';
    var formFill = (document.getElementById('dailyFormFill') || {}).value || '';
    var summary = (document.getElementById('dailySummary') || {}).value || '';
    var paths = [];
    ['dailyPath1','dailyPath2','dailyPath3','dailyPath4','dailyPath5','dailyPath6','dailyPath7','dailyPath8'].forEach(function(id) {
        var cb = document.getElementById(id);
        if (cb && cb.checked) paths.push(cb.value);
    });

    if (!reportNumber || !date) {
        alert('⚠️ الرجاء ملء رقم التقرير والتاريخ');
        return;
    }

    // نفس الكائن الذي كانت الواجهة تخزنه محلياً (الخادم يختم createdAt)
    var record = {
        reportNumber: reportNumber.trim(),
        date: date,
        responseTeams: parseInt(responseTeams) || 0,
        air: parseInt(air) || 0,
        borderReports: borderReports.trim(),
        paths: paths,
        formFill: formFill.trim(),
        summary: summary.trim()
    };
    try {
        var response = await AuthManager.apiRequest('/api/daily-reports', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(record)
        });
        if (!response.ok) throw new Error('status=' + response.status);
    } catch (e) {
        console.error('❌ فشل في حفظ التقرير اليومي:', e);
        alert('❌ فشل في الحفظ — تحقق من الاتصال');
        return;
    }
    alert('✅ تم حفظ التقرير اليومي');
    clearDailyForm();
    await loadDailyRecords();
}

// حذف بالمعرف عبر المصدر الواحد ثم إعادة الجلب
async function deleteDailyRecord(id) {
    if (!confirm('⚠️ هل أنت متأكد من الحذف؟')) return;
    try {
        var response = await AuthManager.apiRequest('/api/daily-reports/' + encodeURIComponent(id), { method: 'DELETE' });
        if (!response.ok) throw new Error('status=' + response.status);
    } catch (e) {
        console.error('❌ فشل في حذف التقرير اليومي:', e);
        alert('❌ فشل في الحذف — تحقق من الاتصال');
        return;
    }
    await loadDailyRecords();
}

function clearDailyForm() {
    var ids = ['dailyReportNumber','dailyBorderReports','dailyFormFill','dailySummary'];
    ids.forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.value = '';
    });
    var el_dailyResponseTeams_v18 = document.getElementById('dailyResponseTeams'); if (el_dailyResponseTeams_v18) el_dailyResponseTeams_v18.value = 0;
    var el_dailyAir_v19 = document.getElementById('dailyAir'); if (el_dailyAir_v19) el_dailyAir_v19.value = 0;
    var el_dailyDate_v20 = document.getElementById('dailyDate'); if (el_dailyDate_v20) el_dailyDate_v20.value = TimeRiyadh.formatDate(new Date());
    ['dailyPath1','dailyPath2','dailyPath3','dailyPath4','dailyPath5','dailyPath6','dailyPath7','dailyPath8'].forEach(function(id) {
        var cb = document.getElementById(id);
        if (cb) cb.checked = false;
    });
}

function sendDailyWhatsApp() {
    var reportNumber = (document.getElementById('dailyReportNumber') || {}).value || '';
    var date = (document.getElementById('dailyDate') || {}).value || '';
    var responseTeams = (document.getElementById('dailyResponseTeams') || {}).value || 0;
    var air = (document.getElementById('dailyAir') || {}).value || 0;
    var borderReports = (document.getElementById('dailyBorderReports') || {}).value || '';
    var formFill = (document.getElementById('dailyFormFill') || {}).value || '';
    var summary = (document.getElementById('dailySummary') || {}).value || '';
    var paths = [];
    ['dailyPath1','dailyPath2','dailyPath3','dailyPath4','dailyPath5','dailyPath6','dailyPath7','dailyPath8'].forEach(function(id) {
        var cb = document.getElementById(id);
        if (cb && cb.checked) paths.push(cb.value);
    });

    if (!reportNumber || !date) {
        alert('⚠️ الرجاء ملء رقم التقرير والتاريخ');
        return;
    }

    var msg = '📋 *التقرير اليومي*\n';
    msg += '═══════════════════════════════════\n';
    msg += 'رقم التقرير: ' + reportNumber + '\n';
    msg += 'التاريخ: ' + date + '\n';
    msg += 'عدد الفرق المستجيبة: ' + responseTeams + '\n';
    msg += 'بلاغات الإسعاف الجوي: ' + air + '\n';
    if (borderReports) msg += 'البلاغات الحدودية: ' + borderReports + '\n';
    if (paths.length > 0) msg += 'المسارات المفعلة: ' + paths.join('، ') + '\n';
    if (formFill) msg += 'تعبئة النموذج: ' + formFill + '\n';
    if (summary) msg += 'الملخص: ' + summary + '\n';
    msg += '═══════════════════════════════════\n';
    msg += 'تم الإرسال: ' + TimeRiyadh.formatDateTimeSec(new Date());

    window.open('https://wa.me/?text=' + encodeURIComponent(msg), '_blank');
}

// ----- نموذج E - حالات توقف قلب وتنفس (e) -----
// الخادم هو مصدر الحقيقة الوحيد — تُحمَّل السجلات من الخدمة عبر loadERecords
var eRecords = [];

// الترحيل يحاول مرة واحدة لكل تحميل صفحة — لا يُحذف المفتاح إلا بعد نجاح رفع الكل
var eRecordsMigrated = false;
async function migrateLocalERecords() {
    var raw = localStorage.getItem('eRecords');
    if (!raw) return;
    var items;
    try { items = JSON.parse(raw); } catch (e) { items = null; }
    if (!Array.isArray(items)) { console.warn('⚠️ تعذر تحليل حالات E المحلية — تُرك المفتاح كما هو'); return; }
    if (items.length === 0) { localStorage.removeItem('eRecords'); return; }
    try {
        for (var i = 0; i < items.length; i++) {
            var migRes = await AuthManager.apiRequest('/api/e-cases', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(items[i])
            });
            if (!migRes.ok) throw new Error('status=' + migRes.status);
        }
        localStorage.removeItem('eRecords');
    } catch (e) {
        console.warn('⚠️ فشل ترحيل حالات E المحلية — تُعاد المحاولة عند التحميل القادم', e);
    }
}

// جلب الحالات من الخدمة ثم تحديث المعاينة (اسم الخطاف للمزامنة اللحظية)
async function loadERecords() {
    try {
        if (!eRecordsMigrated) {
            eRecordsMigrated = true;
            await migrateLocalERecords();
        }
        var response = await AuthManager.apiRequest('/api/e-cases');
        if (!response.ok) throw new Error('status=' + response.status);
        var data = await response.json();
        eRecords = (data && data.records) || [];
        renderEPreview();
    } catch (e) {
        console.error('❌ فشل تحميل حالات E:', e);
    }
}

function initForm_e() {
    var el = document.getElementById('eDateTime');
    if (el) el.value = getRiyadhLocalInputValue(); // جدارية الرياض (كانت UTC)
    renderEPreview();
    loadERecords();
}

async function saveE() {
    var reportNumber = (document.getElementById('eReportNumber') || {}).value || '';
    var dateTime = (document.getElementById('eDateTime') || {}).value || '';
    var location = (document.getElementById('eLocation') || {}).value || '';
    var age = (document.getElementById('eAge') || {}).value || '';
    var gender = (document.getElementById('eGender') || {}).value || '';
    var unit = (document.getElementById('eUnit') || {}).value || '';
    var responseTime = (document.getElementById('eResponseTime') || {}).value || '';
    var hospital = (document.getElementById('eHospital') || {}).value || '';
    var outcome = (document.getElementById('eOutcome') || {}).value || '';
    var notes = (document.getElementById('eNotes') || {}).value || '';

    if (!reportNumber || !location || !unit) {
        alert('⚠️ الرجاء ملء الحقول المطلوبة (رقم البلاغ، الموقع، الفرقة)');
        return;
    }

    // نفس الكائن الذي كانت الواجهة تخزنه محلياً (الخادم يختم createdAt)
    var record = {
        reportNumber: reportNumber.trim(),
        dateTime: dateTime,
        location: location.trim(),
        age: age,
        gender: gender,
        unit: unit,
        responseTime: responseTime,
        hospital: hospital.trim(),
        outcome: outcome,
        notes: notes.trim()
    };
    try {
        var response = await AuthManager.apiRequest('/api/e-cases', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(record)
        });
        if (!response.ok) throw new Error('status=' + response.status);
    } catch (e) {
        console.error('❌ فشل في حفظ حالة E:', e);
        alert('❌ فشل في الحفظ — تحقق من الاتصال');
        return;
    }
    alert('✅ تم حفظ حالة E');
    clearEForm();
    await loadERecords();
}

function clearEForm() {
    var ids = ['eReportNumber','eLocation','eAge','eResponseTime','eHospital','eNotes'];
    ids.forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.value = '';
    });
    ['eGender','eUnit','eOutcome'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.value = '';
    });
    var dtEl = document.getElementById('eDateTime');
    if (dtEl) dtEl.value = getRiyadhLocalInputValue(); // جدارية الرياض (كانت UTC)
}

function sendEWhatsApp() {
    var reportNumber = (document.getElementById('eReportNumber') || {}).value || '';
    var dateTime = (document.getElementById('eDateTime') || {}).value || '';
    var location = (document.getElementById('eLocation') || {}).value || '';
    var age = (document.getElementById('eAge') || {}).value || '';
    var gender = (document.getElementById('eGender') || {}).value || '';
    var unit = (document.getElementById('eUnit') || {}).value || '';
    var responseTime = (document.getElementById('eResponseTime') || {}).value || '';
    var hospital = (document.getElementById('eHospital') || {}).value || '';
    var outcome = (document.getElementById('eOutcome') || {}).value || '';
    var notes = (document.getElementById('eNotes') || {}).value || '';

    if (!reportNumber || !location || !unit) {
        alert('⚠️ الرجاء ملء الحقول المطلوبة');
        return;
    }

    var msg = '❤️ *حالة توقف قلب وتنفس (E)*\n';
    msg += '═══════════════════════════════════\n';
    msg += 'رقم البلاغ: ' + reportNumber + '\n';
    msg += 'التاريخ والوقت: ' + (dateTime ? dateTime.replace('T', ' ') : '-') + '\n';
    msg += 'الموقع: ' + location + '\n';
    if (age) msg += 'العمر: ' + age + ' سنة\n';
    if (gender) msg += 'الجنس: ' + gender + '\n';
    msg += 'الفرقة المستجيبة: ' + unit + '\n';
    if (responseTime) msg += 'وقت الاستجابة: ' + responseTime + ' دقيقة\n';
    if (hospital) msg += 'المستشفى المستلم: ' + hospital + '\n';
    if (outcome) msg += 'الحالة النهائية: ' + outcome + '\n';
    if (notes) msg += 'الملاحظات: ' + notes + '\n';
    msg += '═══════════════════════════════════\n';
    msg += 'تم الإرسال: ' + TimeRiyadh.formatDateTimeSec(new Date());

    window.open('https://wa.me/?text=' + encodeURIComponent(msg), '_blank');
}

function renderEPreview() {
    var container = document.getElementById('ePreviewList');
    if (!container) return;
    if (!eRecords || eRecords.length === 0) {
        container.innerHTML = '<p style="text-align:center; color:var(--gray-400); padding:20px;">📭 لا توجد حالات محفوظة</p>';
        return;
    }
    var html = '';
    eRecords.forEach(function(rec, i) {
        var date = TimeRiyadh.formatDateTimeSec(rec.createdAt);
        html += '<div style="border:1px solid var(--gray-200); border-radius:8px; padding:10px; margin-bottom:8px; background:var(--white);">';
        html += '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">';
        html += '<strong style="color:var(--primary-700);">' + (rec.reportNumber || 'بدون رقم') + '</strong>';
        html += '<span style="font-size:0.7rem; color:var(--gray-400);">' + date + '</span></div>';
        html += '<div style="font-size:0.8rem; color:var(--gray-600);">';
        html += '📍 ' + (rec.location || '-') + ' | ' + (rec.unit || '-') + '</div>';
        if (rec.outcome) html += '<div style="font-size:0.8rem; color:var(--gray-600);">✅ ' + rec.outcome + '</div>';
        html += '<div style="display:flex; gap:6px; margin-top:8px;">';
        html += '<button onclick="deleteERecord(\'' + rec.id + '\')" style="padding:4px 10px; font-size:0.7rem; border-radius:4px; border:1px solid var(--coral); background:var(--coral-50); color:var(--coral); cursor:pointer;">🗑️ حذف</button>';
        html += '</div></div>';
    });
    container.innerHTML = html;
}

// حذف بالمعرف عبر المصدر الواحد ثم إعادة الجلب
async function deleteERecord(id) {
    if (!confirm('⚠️ هل أنت متأكد من الحذف؟')) return;
    try {
        var response = await AuthManager.apiRequest('/api/e-cases/' + encodeURIComponent(id), { method: 'DELETE' });
        if (!response.ok) throw new Error('status=' + response.status);
    } catch (e) {
        console.error('❌ فشل في حذف حالة E:', e);
        alert('❌ فشل في الحذف — تحقق من الاتصال');
        return;
    }
    await loadERecords();
}

// ----- نموذج التصعيد (escalation) -----
// الخادم هو مصدر الحقيقة الوحيد — تُحمَّل السجلات من الخدمة عبر loadEscalationRecords
var escalationRecords = [];

// الترحيل يحاول مرة واحدة لكل تحميل صفحة — لا يُحذف المفتاح إلا بعد نجاح رفع الكل
var escalationRecordsMigrated = false;
async function migrateLocalEscalationRecords() {
    var raw = localStorage.getItem('escalationRecords');
    if (!raw) return;
    var items;
    try { items = JSON.parse(raw); } catch (e) { items = null; }
    if (!Array.isArray(items)) { console.warn('⚠️ تعذر تحليل بلاغات التصعيد المحلية — تُرك المفتاح كما هو'); return; }
    if (items.length === 0) { localStorage.removeItem('escalationRecords'); return; }
    try {
        for (var i = 0; i < items.length; i++) {
            var migRes = await AuthManager.apiRequest('/api/escalations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(items[i])
            });
            if (!migRes.ok) throw new Error('status=' + migRes.status);
        }
        localStorage.removeItem('escalationRecords');
    } catch (e) {
        console.warn('⚠️ فشل ترحيل بلاغات التصعيد المحلية — تُعاد المحاولة عند التحميل القادم', e);
    }
}

// جلب البلاغات من الخدمة ثم تحديث المعاينة (اسم الخطاف للمزامنة اللحظية)
async function loadEscalationRecords() {
    try {
        if (!escalationRecordsMigrated) {
            escalationRecordsMigrated = true;
            await migrateLocalEscalationRecords();
        }
        var response = await AuthManager.apiRequest('/api/escalations');
        if (!response.ok) throw new Error('status=' + response.status);
        var data = await response.json();
        escalationRecords = (data && data.records) || [];
        renderEscalationPreview();
    } catch (e) {
        console.error('❌ فشل تحميل بلاغات التصعيد:', e);
    }
}

function initForm_escalation() {
    var el = document.getElementById('escDateTime');
    if (el) el.value = getRiyadhLocalInputValue(); // جدارية الرياض (كانت UTC)
    renderEscalationPreview();
    loadEscalationRecords();
}

async function saveEscalation() {
    var reportNumber = (document.getElementById('escReportNumber') || {}).value || '';
    var dateTime = (document.getElementById('escDateTime') || {}).value || '';
    var location = (document.getElementById('escLocation') || {}).value || '';
    var eventType = (document.getElementById('escEventType') || {}).value || '';
    var injuries = (document.getElementById('escInjuries') || {}).value || 0;
    var deaths = (document.getElementById('escDeaths') || {}).value || 0;
    var details = (document.getElementById('escDetails') || {}).value || '';
    var agencies = [];
    document.querySelectorAll('.esc-agency:checked').forEach(function(cb) {
        agencies.push(cb.value);
    });

    if (!reportNumber || !location || !eventType) {
        alert('⚠️ الرجاء ملء الحقول المطلوبة (رقم البلاغ، الموقع، نوع الحدث)');
        return;
    }

    // نفس الكائن الذي كانت الواجهة تخزنه محلياً (الخادم يختم createdAt)
    var record = {
        reportNumber: reportNumber.trim(),
        dateTime: dateTime,
        location: location.trim(),
        eventType: eventType,
        injuries: parseInt(injuries) || 0,
        deaths: parseInt(deaths) || 0,
        agencies: agencies,
        details: details.trim()
    };
    try {
        var response = await AuthManager.apiRequest('/api/escalations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(record)
        });
        if (!response.ok) throw new Error('status=' + response.status);
    } catch (e) {
        console.error('❌ فشل في حفظ بلاغ التصعيد:', e);
        alert('❌ فشل في الحفظ — تحقق من الاتصال');
        return;
    }
    alert('✅ تم حفظ بلاغ التصعيد');
    clearEscalationForm();
    await loadEscalationRecords();
}

function clearEscalationForm() {
    var ids = ['escReportNumber','escLocation','escInjuries','escDeaths','escDetails'];
    ids.forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.value = '';
    });
    var typeEl = document.getElementById('escEventType');
    if (typeEl) typeEl.value = '';
    document.querySelectorAll('.esc-agency').forEach(function(cb) { cb.checked = false; });
    var dtEl = document.getElementById('escDateTime');
    if (dtEl) dtEl.value = getRiyadhLocalInputValue(); // جدارية الرياض (كانت UTC)
}

function sendEscalationWhatsApp() {
    var reportNumber = (document.getElementById('escReportNumber') || {}).value || '';
    var dateTime = (document.getElementById('escDateTime') || {}).value || '';
    var location = (document.getElementById('escLocation') || {}).value || '';
    var eventType = (document.getElementById('escEventType') || {}).value || '';
    var injuries = (document.getElementById('escInjuries') || {}).value || 0;
    var deaths = (document.getElementById('escDeaths') || {}).value || 0;
    var details = (document.getElementById('escDetails') || {}).value || '';
    var agencies = [];
    document.querySelectorAll('.esc-agency:checked').forEach(function(cb) {
        agencies.push(cb.value);
    });

    if (!reportNumber || !location || !eventType) {
        alert('⚠️ الرجاء ملء الحقول المطلوبة');
        return;
    }

    var msg = '📢 *بلاغ تصعيد*\n';
    msg += '═══════════════════════════════════\n';
    msg += 'رقم البلاغ: ' + reportNumber + '\n';
    msg += 'التاريخ والوقت: ' + (dateTime ? dateTime.replace('T', ' ') : '-') + '\n';
    msg += 'الموقع: ' + location + '\n';
    msg += 'نوع الحدث: ' + eventType + '\n';
    msg += 'عدد المصابين: ' + injuries + '\n';
    msg += 'عدد الوفيات: ' + deaths + '\n';
    if (agencies.length > 0) msg += 'الجهات المشاركة: ' + agencies.join('، ') + '\n';
    if (details) msg += 'التفاصيل: ' + details + '\n';
    msg += '═══════════════════════════════════\n';
    msg += 'تم الإرسال: ' + TimeRiyadh.formatDateTimeSec(new Date());

    window.open('https://wa.me/?text=' + encodeURIComponent(msg), '_blank');
}

function renderEscalationPreview() {
    var container = document.getElementById('escalationPreviewList');
    if (!container) return;
    if (!escalationRecords || escalationRecords.length === 0) {
        container.innerHTML = '<p style="text-align:center; color:var(--gray-400); padding:20px;">📭 لا توجد بلاغات محفوظة</p>';
        return;
    }
    var html = '';
    escalationRecords.forEach(function(rec, i) {
        var date = TimeRiyadh.formatDateTimeSec(rec.createdAt);
        html += '<div style="border:1px solid var(--gray-200); border-radius:8px; padding:10px; margin-bottom:8px; background:var(--white);">';
        html += '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">';
        html += '<strong style="color:var(--primary-700);">' + (rec.reportNumber || 'بدون رقم') + '</strong>';
        html += '<span style="font-size:0.7rem; color:var(--gray-400);">' + date + '</span></div>';
        html += '<div style="font-size:0.8rem; color:var(--gray-600);">';
        html += '📍 ' + (rec.location || '-') + ' | ' + (rec.eventType || '-') + '</div>';
        html += '<div style="font-size:0.8rem; color:var(--gray-600);">👥 ' + rec.injuries + ' مصاب / ' + rec.deaths + ' وفاة</div>';
        html += '<div style="display:flex; gap:6px; margin-top:8px;">';
        html += '<button onclick="deleteEscalationRecord(\'' + rec.id + '\')" style="padding:4px 10px; font-size:0.7rem; border-radius:4px; border:1px solid var(--coral); background:var(--coral-50); color:var(--coral); cursor:pointer;">🗑️ حذف</button>';
        html += '</div></div>';
    });
    container.innerHTML = html;
}

// حذف بالمعرف عبر المصدر الواحد ثم إعادة الجلب
async function deleteEscalationRecord(id) {
    if (!confirm('⚠️ هل أنت متأكد من الحذف؟')) return;
    try {
        var response = await AuthManager.apiRequest('/api/escalations/' + encodeURIComponent(id), { method: 'DELETE' });
        if (!response.ok) throw new Error('status=' + response.status);
    } catch (e) {
        console.error('❌ فشل في حذف بلاغ التصعيد:', e);
        alert('❌ فشل في الحذف — تحقق من الاتصال');
        return;
    }
    await loadEscalationRecords();
}

// ============================================
var el_formsBtn=document.getElementById("formsBtn");if(el_formsBtn)el_formsBtn.addEventListener('click', function() {
    var modal = document.getElementById('formsModal');
    modal.style.display = 'flex';
    
    var sidebar = document.getElementById('formsSidebar');
    if (sidebar && !sidebar.children.length) {
        loadFormsList();
    }
    
    if (!currentFormId && FORM_DEFINITIONS.length > 0) {
        loadForm(FORM_DEFINITIONS[0].id);
    } else if (currentFormId) {
        showFormContent(currentFormId);
    }
});

// ============================================
// ============================================
// نظام الجداول الاحترافي
// ============================================
var currentTableData = []; // صفوف الجدول الحالي للبحث
var isTableFullscreen = false;

async function loadSavedTable() {
    var container = document.getElementById('excelTableContainer');
    var status = document.getElementById('tableStatus');
    try {
        var response = await AuthManager.apiRequest('/api/check-monthly-table');
        var result = await response.json();
        if (result.exists) {
            status.innerHTML = '⏳ جاري التحميل...';
            var fileResponse = await AuthManager.apiRequest('/api/get-monthly-table');
            var blob = await fileResponse.blob();
            var reader = new FileReader();
            reader.onload = function(event) {
                try {
                    var data = new Uint8Array(event.target.result);
                    workbookData = XLSX.read(data, { type: 'array', cellFormula: true, cellHTML: false, cellNF: true, cellStyles: true });
                    currentSheetIndex = 0;
                    renderAllSheets(workbookData);
                    status.innerHTML = '✅ جاهز';
                    var el_tableStatsBar_d40 = document.getElementById('tableStatsBar'); if (el_tableStatsBar_d40) el_tableStatsBar_d40.style.display = 'flex';
                    updateTableStats();
                } catch (error) {
                    container.innerHTML = '<p style="text-align:center; color:var(--coral); padding:30px 0;">❌ خطأ: ' + error.message + '</p>';
                    status.innerHTML = '❌ خطأ';
                }
            };
            reader.readAsArrayBuffer(blob);
        } else {
            container.innerHTML = '<p style="text-align:center; color:var(--gray-400); padding:30px 0;">📂 لا يوجد جدول محفوظ. يرجى رفع ملف Excel.</p>';
            status.innerHTML = '📂 لا يوجد جدول';
            var el_tableStatsBar_d41 = document.getElementById('tableStatsBar'); if (el_tableStatsBar_d41) el_tableStatsBar_d41.style.display = 'none';
        }
    } catch (error) {
        container.innerHTML = '<p style="text-align:center; color:var(--coral); padding:30px 0;">❌ خطأ في الاتصال</p>';
        status.innerHTML = '❌ خطأ في الاتصال';
    }
}

function renderAllSheets(workbook) {
    // Sheet tabs
    var tabsContainer = document.getElementById('sheetTabsContainer');
    var tabsHtml = '<div class="sheet-tabs-bar">';
    workbook.SheetNames.forEach(function(name, index) {
        var active = index === currentSheetIndex ? 'active' : '';
        tabsHtml += '<button class="sheet-tab-new ' + active + '" onclick="switchSheet(' + index + ')">' +
            '<i class="fas fa-table" style="font-size:0.65rem; margin-left:4px; opacity:0.6;"></i>' +
            escapeHtml(name) + '</button>';
    });
    tabsHtml += '</div>';
    tabsContainer.innerHTML = tabsHtml;

    // Render current sheet
    renderSheet(workbook, currentSheetIndex);
    updateTableStats();
}

function switchSheet(index) {
    currentSheetIndex = index;
    var el_tableSearchInput_v21 = document.getElementById('tableSearchInput'); if (el_tableSearchInput_v21) el_tableSearchInput_v21.value = '';
    clearTableSearch();
    renderAllSheets(workbookData);
}

function renderSheet(workbook, sheetIndex) {
    var container = document.getElementById('excelTableContainer');
    var sheetName = workbook.SheetNames[sheetIndex];
    var sheet = workbook.Sheets[sheetName];

    // Convert to JSON for search and manipulation
    var jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    currentTableData = jsonData;

    if (jsonData.length === 0) {
        container.innerHTML = '<p style="text-align:center; color:var(--gray-400); padding:30px 0;">📭 الورقة فارغة</p>';
        return;
    }

    // Detect column types
    var colTypes = detectColumnTypes(jsonData);

    // Build HTML table
    var html = '<div class="pro-table-wrapper"><table class="pro-table" id="proDataTable"><thead><tr>';

    // Row number column header
    html += '<th>#</th>';

    // Headers from first row (or generate A, B, C...)
    var headers = jsonData[0] || [];
    var maxCols = Math.max(headers.length, jsonData.length > 1 ? jsonData[1].length : 0);
    for (var c = 0; c < maxCols; c++) {
        var h = headers[c] || '';
        if (!h && jsonData.length > 0) h = String.fromCharCode(65 + c); // A, B, C...
        html += '<th>' + escapeHtml(String(h)) + '</th>';
    }
    html += '</tr></thead><tbody>';

    // Data rows
    for (var r = 1; r < jsonData.length; r++) {
        html += '<tr>';
        html += '<td class="row-num">' + r + '</td>';
        for (var c = 0; c < maxCols; c++) {
            var val = jsonData[r][c];
            var displayVal = val !== undefined && val !== '' ? String(val) : '';
            var typeClass = colTypes[c] || 'type-text';
            if (displayVal === '') typeClass = 'type-empty';
            html += '<td class="' + typeClass + '">' + escapeHtml(displayVal) + '</td>';
        }
        html += '</tr>';
    }

    html += '</tbody></table></div>';
    container.innerHTML = html;
}

function detectColumnTypes(data) {
    if (data.length < 2) return [];
    var types = [];
    var maxCols = 0;
    for (var r = 0; r < data.length; r++) {
        if (data[r] && data[r].length > maxCols) maxCols = data[r].length;
    }
    for (var c = 0; c < maxCols; c++) {
        var numCount = 0, dateCount = 0, textCount = 0, total = 0;
        for (var r = 1; r < Math.min(data.length, 50); r++) {
            var val = data[r] ? data[r][c] : '';
            if (val === undefined || val === '') continue;
            total++;
            var s = String(val).trim();
            if (!isNaN(parseFloat(s)) && isFinite(s)) numCount++;
            else if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(s) || /^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}$/.test(s)) dateCount++;
            else textCount++;
        }
        if (total === 0) { types.push('type-text'); continue; }
        if (numCount / total > 0.7) types.push('type-number');
        else if (dateCount / total > 0.5) types.push('type-date');
        else types.push('type-text');
    }
    return types;
}

function escapeHtml(text) {
    if (!text) return '';
    var div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// بحث في الجدول
function searchTable(query) {
    if (!query) { clearTableSearch(); return; }
    var table = document.getElementById('proDataTable');
    if (!table) return;
    var rows = table.querySelectorAll('tbody tr');
    var found = 0;
    var q = query.toLowerCase();
    rows.forEach(function(row) {
        var cells = row.querySelectorAll('td');
        var rowMatch = false;
        cells.forEach(function(cell) {
            cell.classList.remove('search-highlight');
            if (cell.textContent.toLowerCase().indexOf(q) !== -1) {
                cell.classList.add('search-highlight');
                rowMatch = true;
            }
        });
        row.style.display = rowMatch ? '' : 'none';
        if (rowMatch) found++;
    });
    document.getElementById('statFound').textContent = found;
    var el_clearSearchBtn_d42 = document.getElementById('clearSearchBtn'); if (el_clearSearchBtn_d42) el_clearSearchBtn_d42.style.display = found > 0 ? 'block' : 'none';
}

function clearTableSearch() {
    var table = document.getElementById('proDataTable');
    if (!table) return;
    table.querySelectorAll('td').forEach(function(cell) {
        cell.classList.remove('search-highlight');
    });
    table.querySelectorAll('tbody tr').forEach(function(row) {
        row.style.display = '';
    });
    document.getElementById('statFound').textContent = '0';
    var clearBtn = document.getElementById('clearSearchBtn');
    if (clearBtn) clearBtn.style.display = 'none';
}

function updateTableStats() {
    if (!workbookData) return;
    document.getElementById('statSheets').textContent = workbookData.SheetNames.length;
    var sheet = workbookData.Sheets[workbookData.SheetNames[currentSheetIndex]];
    var json = XLSX.utils.sheet_to_json(sheet, { header: 1 });
    document.getElementById('statRows').textContent = Math.max(0, json.length - 1);
    var maxCols = 0;
    json.forEach(function(r) { if (r && r.length > maxCols) maxCols = r.length; });
    document.getElementById('statCols').textContent = maxCols;
    document.getElementById('statModified').textContent = getSaudiTime();
}

function fitTableWidth() {
    var container = document.getElementById('excelTableContainer');
    if (!container) return;
    container.style.maxHeight = '85vh';
    container.scrollLeft = 0;
    var table = container.querySelector('table');
    if (table) {
        table.style.width = '100%';
        table.style.minWidth = '100%';
    }
    showNotification('تم', 'تم تكبير الجدول', 'success', 1500);
}

function toggleTableFullscreen() {
    var modal = document.getElementById('monthlyTableModal');
    isTableFullscreen = !isTableFullscreen;
    if (isTableFullscreen) {
        modal.classList.add('table-fullscreen');
    } else {
        modal.classList.remove('table-fullscreen');
    }
}

// تصدير PDF
function exportTableToPDF() {
    var table = document.getElementById('proDataTable');
    if (!table) { showNotification('لا يوجد جدول', 'يرجى تحميل جدول أولاً', 'warning', 3000); return; }
    var wrapper = document.createElement('div');
    wrapper.style.cssText = 'padding:20px;direction:rtl;font-family:Arial;';
    wrapper.innerHTML = '<h2 style="text-align:center;color:#2563EB;">جدول المناوبات الشهري - جنوب الرياض</h2>' +
        '<p style="text-align:center;color:#999;font-size:0.8rem;">' + getSaudiDate() + '</p>' +
        '<hr style="border-color:#2563EB;margin:15px 0;">';
    var clone = table.cloneNode(true);
    clone.style.cssText = 'width:100%;border-collapse:collapse;font-size:0.65rem;direction:rtl;';
    clone.querySelectorAll('th,td').forEach(function(c) { c.style.border = '1px solid #ddd'; c.style.padding = '4px'; c.style.textAlign = 'center'; });
    clone.querySelectorAll('th').forEach(function(c) { c.style.background = '#2563EB'; c.style.color = 'white'; });
    wrapper.appendChild(clone);
    document.body.appendChild(wrapper);
    html2pdf().set({ margin: 10, filename: 'جدول_شهري_' + getSaudiDate() /* تاريخ الرياض لاسم الملف (كان UTC) */ + '.pdf', html2canvas: { scale: 2 }, jsPDF: { unit: 'mm', format: 'a4', orientation: 'landscape' } }).from(wrapper).save().then(function() { document.body.removeChild(wrapper); showNotification('تم', 'تم تصدير PDF بنجاح', 'success', 3000); });
}

// تصدير CSV
function exportTableToCSV() {
    if (!workbookData) { showNotification('لا يوجد جدول', 'يرجى تحميل جدول أولاً', 'warning', 3000); return; }
    var sheet = workbookData.Sheets[workbookData.SheetNames[currentSheetIndex]];
    var csv = XLSX.utils.sheet_to_csv(sheet);
    var blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    var link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = workbookData.SheetNames[currentSheetIndex] + '_' + getSaudiDate() /* تاريخ الرياض لاسم الملف (كان UTC) */ + '.csv';
    link.click();
    showNotification('تم', 'تم تصدير CSV بنجاح', 'success', 3000);
}

// تصدير كصورة
function exportTableToImage() {
    var container = document.getElementById('excelTableContainer');
    if (!container || !container.querySelector('table')) { showNotification('لا يوجد جدول', 'يرجى تحميل جدول أولاً', 'warning', 3000); return; }
    showNotification('جاري التصدير', 'يتم إنشاء الصورة...', 'info', 2000);
    html2canvas(container, { scale: 2, useCORS: true }).then(function(canvas) {
        var link = document.createElement('a');
        link.href = canvas.toDataURL('image/png');
        link.download = 'جدول_' + getSaudiDate() /* تاريخ الرياض لاسم الملف (كان UTC) */ + '.png';
        link.click();
        showNotification('تم', 'تم تصدير الصورة بنجاح', 'success', 3000);
    }).catch(function() { showNotification('خطأ', 'فشل في تصدير الصورة', 'error', 3000); });
}

// رفع ملف
var el_uploadExcelBtn = document.getElementById("uploadExcelBtn"); if(el_uploadExcelBtn) el_uploadExcelBtn.addEventListener('click', function() { document.getElementById('excelFileInput').click(); });
var el_excelFileInput=document.getElementById("excelFileInput");if(el_excelFileInput)el_excelFileInput.addEventListener('change', function(e) {
    var file = e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = async function(event) {
        try {
            var data = new Uint8Array(event.target.result);
            workbookData = XLSX.read(data, { type: 'array', cellFormula: true, cellHTML: false, cellNF: true, cellStyles: true });
            currentSheetIndex = 0;
            renderAllSheets(workbookData);
            var base64 = btoa(String.fromCharCode.apply(null, data));
            var response = await fetch('/api/upload-monthly-table', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileData: base64 }) });
            var result = await response.json();
            if (result.success) {
                var el_tableStatus_h10 = document.getElementById('tableStatus'); if (el_tableStatus_h10) el_tableStatus_h10.innerHTML = '✅ تم الحفظ';
                var el_tableStatsBar_d43 = document.getElementById('tableStatsBar'); if (el_tableStatsBar_d43) el_tableStatsBar_d43.style.display = 'flex';
                updateTableStats();
                showNotification('تم الرفع', 'تم رفع وحفظ الجدول بنجاح', 'success', 3000);
                addAuditEntry('file', 'رفع جدول إكسل', 'تم رفع وحفظ الجدول الشهري بنجاح', getCurrentUserName());
            } else {
                showNotification('فشل', 'فشل في حفظ الجدول', 'error', 3000);
            }
        } catch (error) { showNotification('خطأ', error.message, 'error', 3000); }
    };
    reader.readAsArrayBuffer(file);
});

// ============================================
// دوال التحكم والتنسيق
// ============================================
async function loadVacations() {
    try {
        var response = await AuthManager.apiRequest('/api/vacations');
        var data = await response.json();
        if (Array.isArray(data) && data.length > 0) {
            data.forEach(function(item, index) { if (controlData[index]) { controlData[index].vacationStart = item.vacationStart || ''; controlData[index].vacationEnd = item.vacationEnd || ''; } });
        }
    } catch (error) { console.error("خطأ في تحميل الإجازات:", error); }
}

function renderControlList(editable) {
    editable = editable || false;
    var container = document.getElementById('controlList');
    if (!container) return;
    var html = '<div style="display:grid; grid-template-columns: 1fr; gap:8px;">';
    var colors = ['#1e466e', '#2a7f3e', '#c0392b', '#f39c12', '#2980b9', '#8e44ad', '#27ae60', '#d35400', '#16a085'];
    controlData.forEach(function(person, index) {
        var initials = person.name.split(' ').slice(0, 2).map(function(n) { return n[0]; }).join('');
        var color = colors[index % colors.length];
        var startDate = person.vacationStart || '';
        var endDate = person.vacationEnd || '';
        var vacationDisplay = startDate && endDate ? '📅 ' + formatDate(startDate) + ' → ' + formatDate(endDate) : '📅 لا توجد إجازة';
        html += '<div class="control-person"><div class="control-avatar" style="background:' + color + ';">' + initials + '</div><div class="control-info"><div class="name">' + person.name + '</div><div class="role">📌 ' + person.role + ' | كود: ' + person.code + '</div></div><div class="control-vacation">' + (editable ? '<div class="edit"><input type="date" id="start_' + index + '" value="' + startDate + '"><span>→</span><input type="date" id="end_' + index + '" value="' + endDate + '"></div>' : '<div class="display">' + vacationDisplay + '</div>') + '</div><div class="control-role-badge">' + (person.role === 'تحكم عملياتي' ? '🎛️ تحكم' : '📞 تنسيق') + '</div></div>';
    });
    html += '</div>';
    container.innerHTML = html;
}

function formatDate(dateString) {
    if (!dateString) return '';
    var parts = dateString.split('-');
    return parts[2] + '/' + parts[1] + '/' + parts[0];
}

var el_editVacationsBtn = document.getElementById("editVacationsBtn"); if(el_editVacationsBtn) el_editVacationsBtn.addEventListener('click', function() { openModalById('passwordModal'); var el_passwordInput_v22 = document.getElementById('passwordInput'); if (el_passwordInput_v22) el_passwordInput_v22.value = ''; document.getElementById('passwordInput').focus(); });
var el_confirmPasswordBtn=document.getElementById("confirmPasswordBtn");if(el_confirmPasswordBtn)el_confirmPasswordBtn.addEventListener('click', async function() {
    var password = document.getElementById('passwordInput').value;
    try {
        var response = await AuthManager.apiRequest('/api/get-password');
        var result = await response.json();
        var storedPassword = result.password || '1234';
        if (password === storedPassword) {
            isEditMode = true;
            closeModalById('passwordModal');
            var el_passwordInput_v23 = document.getElementById('passwordInput'); if (el_passwordInput_v23) el_passwordInput_v23.value = '';
            renderControlList(true);
            var el_saveVacationsBtn_d46 = document.getElementById('saveVacationsBtn'); if (el_saveVacationsBtn_d46) el_saveVacationsBtn_d46.style.display = 'inline-block';
            var el_editVacationsBtn_d47 = document.getElementById('editVacationsBtn'); if (el_editVacationsBtn_d47) el_editVacationsBtn_d47.style.display = 'none';
            alert('✅ تم تفعيل وضع التعديل');
        } else { alert('❌ الرقم السري غير صحيح'); var el_passwordInput_v24 = document.getElementById('passwordInput'); if (el_passwordInput_v24) el_passwordInput_v24.value = ''; document.getElementById('passwordInput').focus(); }
    } catch (error) { alert('❌ خطأ في التحقق من الرقم السري'); }
});

var el_cancelPasswordBtn = document.getElementById("cancelPasswordBtn"); if(el_cancelPasswordBtn) el_cancelPasswordBtn.addEventListener('click', function() { closeModalById('passwordModal'); var el_passwordInput_v25 = document.getElementById('passwordInput'); if (el_passwordInput_v25) el_passwordInput_v25.value = ''; });
var el_saveVacationsBtn=document.getElementById("saveVacationsBtn");if(el_saveVacationsBtn)el_saveVacationsBtn.addEventListener('click', async function() {
    controlData.forEach(function(person, index) {
        var startInput = document.getElementById('start_' + index);
        var endInput = document.getElementById('end_' + index);
        if (startInput && endInput) { person.vacationStart = startInput.value; person.vacationEnd = endInput.value; }
    });
    try {
        var response = await fetch('/api/save-vacations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vacations: controlData }) });
        var result = await response.json();
        if (result.success) {
            alert('✅ تم حفظ الإجازات بنجاح');
            isEditMode = false;
            renderControlList(false);
            var el_saveVacationsBtn_d49 = document.getElementById('saveVacationsBtn'); if (el_saveVacationsBtn_d49) el_saveVacationsBtn_d49.style.display = 'none';
            var el_editVacationsBtn_d50 = document.getElementById('editVacationsBtn'); if (el_editVacationsBtn_d50) el_editVacationsBtn_d50.style.display = 'inline-block';
        } else { alert('❌ فشل في حفظ الإجازات'); }
    } catch (error) { alert('❌ خطأ في الاتصال: ' + error.message); }
});

// ============================================
// دوال التحديثات التشغيلية
// ============================================
function openDocsPage() {
    var el_docsPage_d51 = document.getElementById('docsPage'); if (el_docsPage_d51) el_docsPage_d51.style.display = 'block';
    document.body.style.overflow = 'hidden';
    loadDocsData();
}

function closeDocsPage() {
    var el_docsPage_d52 = document.getElementById('docsPage'); if (el_docsPage_d52) el_docsPage_d52.style.display = 'none';
    document.body.style.overflow = 'auto';
}

async function loadDocsData() {
    try {
        var response = await AuthManager.apiRequest('/api/docs');
        var result = await response.json();
        if (result.success) {
            uploadedDocs = result.docs || [];
            filteredDocs = [].concat(uploadedDocs);
            renderDocsList();
            updateStats();
            var el_docsTotalCount = document.getElementById('docsTotalCount'); if (el_docsTotalCount) el_docsTotalCount.innerText = uploadedDocs.length;
        }
    } catch (error) { console.error('خطأ في تحميل التحديثات:', error); }
}

function renderDocsList() {
    var container = document.getElementById('docsListContainer');
    var sortedDocs = filteredDocs.slice().sort(function(a, b) { return new Date(b.uploadDate) - new Date(a.uploadDate); });
    var start = (currentDocsPage - 1) * docsPerPage;
    var end = start + docsPerPage;
    var pageDocs = sortedDocs.slice(start, end);
    if (pageDocs.length === 0) {
        container.innerHTML = '<div style="text-align:center; padding:60px 20px; background:white; border-radius:var(--radius-lg); border:2px dashed var(--gray-200);"><i class="fas fa-inbox" style="font-size:4rem; display:block; margin-bottom:15px; color:var(--gray-400);"></i><h3 style="color:var(--gray-400);">📭 لا توجد تحديثات</h3><p style="color:var(--gray-400);">قم برفع أول تحديث باستخدام زر "تحديث جديد"</p><button onclick="openUploadModal()" class="btn btn-primary" style="margin-top:10px;"><i class="fas fa-plus"></i> رفع تحديث</button></div>';
        var el_docsPagination_h11 = document.getElementById('docsPagination'); if (el_docsPagination_h11) el_docsPagination_h11.innerHTML = '';
        var el_docsFilterCount = document.getElementById('docsFilterCount'); if (el_docsFilterCount) el_docsFilterCount.innerText = '0 تحديث';
        return;
    }
    var isGrid = docsViewMode === 'grid';
    container.style.display = 'grid';
    container.style.gridTemplateColumns = isGrid ? 'repeat(auto-fill, minmax(320px, 1fr))' : '1fr';
    container.style.gap = '14px';
    var html = '';
    pageDocs.forEach(function(doc) {
        var date = getSaudiDateTime();
        var timeAgo = getTimeAgo(doc.uploadDate);
        var icon = getFileIcon(doc.filename);
        var category = doc.category || 'أخرى';
        var priority = doc.priority || 'normal';
        var color = getCategoryColor(category);
        var priorityColor = getPriorityColor(priority);
        html += '<div style="background:white; border-radius:var(--radius-md); padding:16px 20px; border-right:4px solid ' + color + '; box-shadow:var(--shadow-sm); transition:all 0.2s; position:relative; ' + (isGrid ? 'height:100%;' : '') + '">' +
            (priority === 'urgent' ? '<div style="position:absolute; top:-6px; left:16px; background:' + priorityColor + '; color:white; padding:2px 12px; border-radius:20px; font-size:0.6rem; font-weight:700;"><i class="fas fa-exclamation-triangle"></i> عاجل</div>' : '') +
            (priority === 'important' ? '<div style="position:absolute; top:-6px; left:16px; background:' + priorityColor + '; color:white; padding:2px 12px; border-radius:20px; font-size:0.6rem; font-weight:700;"><i class="fas fa-star"></i> مهم</div>' : '') +
            '<div style="display:flex; gap:14px; align-items:flex-start; margin-top:' + (priority !== 'normal' ? '12px' : '0') + ';">' +
            '<div style="width:48px; height:48px; border-radius:50%; background:' + color + '22; display:flex; align-items:center; justify-content:center; font-size:1.6rem; flex-shrink:0;">' + icon + '</div>' +
            '<div style="flex:1; min-width:0;">' +
            '<div style="display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin-bottom:4px;">' +
            '<span style="font-size:0.6rem; background:' + color + '22; color:' + color + '; padding:2px 10px; border-radius:20px; font-weight:600;">' + category + '</span>' +
            '<span style="font-size:0.6rem; color:var(--gray-400);"><i class="far fa-clock"></i> ' + timeAgo + '</span>' +
            '</div>' +
            '<h3 style="margin:0; font-size:0.95rem; color:var(--gray-800);">' + doc.filename + '</h3>' +
            (doc.description ? '<p style="margin:4px 0 0; color:var(--gray-600); font-size:0.8rem; line-height:1.5;">' + doc.description + '</p>' : '') +
            '<div style="display:flex; gap:12px; margin-top:8px; font-size:0.65rem; color:var(--gray-400); flex-wrap:wrap;">' +
            '<span><i class="far fa-calendar-alt"></i> ' + date + '</span>' +
            '<span><i class="fas fa-user"></i> ' + (doc.uploader || 'المشرف') + '</span>' +
            '</div>' +
            '</div>' +
            '</div>' +
            '<div style="display:flex; gap:8px; margin-top:12px; padding-top:12px; border-top:1px solid var(--gray-100); flex-wrap:wrap;">' +
            '<button onclick="openDocPreview(\'' + doc.id + '\')" class="btn" style="padding:4px 14px; font-size:0.7rem; background:var(--primary-100); border-color:var(--primary-200);"><i class="fas fa-eye"></i> عرض</button>' +
            '<button onclick="downloadDoc(\'' + doc.id + '\')" class="btn" style="padding:4px 14px; font-size:0.7rem; border-color:var(--gray-300);"><i class="fas fa-download"></i> تحميل</button>' +
            '<button onclick="deleteDoc(\'' + doc.id + '\')" class="btn" style="padding:4px 14px; font-size:0.7rem; border-color:var(--coral); color:var(--coral); margin-right:auto;"><i class="fas fa-trash"></i></button>' +
            '</div>' +
            '</div>';
    });
    container.innerHTML = html;
    updatePagination(filteredDocs.length);
    var el_docsFilterCount = document.getElementById('docsFilterCount'); if (el_docsFilterCount) el_docsFilterCount.innerText = filteredDocs.length + ' تحديث (من ' + uploadedDocs.length + ')';
}

function updatePagination(total) {
    var totalPages = Math.ceil(total / docsPerPage);
    var container = document.getElementById('docsPagination');
    if (totalPages <= 1) { container.innerHTML = ''; return; }
    var html = '<button onclick="goToDocsPage(' + (currentDocsPage - 1) + ')" class="btn" ' + (currentDocsPage === 1 ? 'disabled style="opacity:0.5;"' : '') + '><i class="fas fa-chevron-right"></i></button>';
    for (var i = 1; i <= totalPages; i++) {
        html += '<button onclick="goToDocsPage(' + i + ')" class="btn ' + (i === currentDocsPage ? 'btn-primary' : '') + '" style="padding:4px 12px; min-width:32px;">' + i + '</button>';
    }
    html += '<button onclick="goToDocsPage(' + (currentDocsPage + 1) + ')" class="btn" ' + (currentDocsPage === totalPages ? 'disabled style="opacity:0.5;"' : '') + '><i class="fas fa-chevron-left"></i></button>';
    container.innerHTML = html;
}

function goToDocsPage(page) {
    var totalPages = Math.ceil(filteredDocs.length / docsPerPage);
    if (page < 1 || page > totalPages) return;
    currentDocsPage = page;
    renderDocsList();
    document.getElementById('docsListContainer').scrollIntoView({ behavior: 'smooth' });
}

function filterDocs() {
    var searchTerm = document.getElementById('searchDocsInput').value.toLowerCase();
    var category = document.getElementById('filterDocsCategory').value;
    var timeFilter = document.getElementById('filterDocsTime').value;
    filteredDocs = uploadedDocs.filter(function(doc) {
        var matchesSearch = doc.filename.toLowerCase().includes(searchTerm) || (doc.description || '').toLowerCase().includes(searchTerm);
        var matchesCategory = category === 'all' || doc.category === category;
        var now = new Date();
        var docDate = new Date(doc.uploadDate);
        var matchesTime = true;
        switch(timeFilter) {
            case 'today': matchesTime = docDate.toDateString() === now.toDateString(); break;
            case 'week': var weekAgo = new Date(now); weekAgo.setDate(weekAgo.getDate() - 7); matchesTime = docDate >= weekAgo; break;
            case 'month': var monthAgo = new Date(now); monthAgo.setMonth(monthAgo.getMonth() - 1); matchesTime = docDate >= monthAgo; break;
            case 'year': var yearAgo = new Date(now); yearAgo.setFullYear(yearAgo.getFullYear() - 1); matchesTime = docDate >= yearAgo; break;
            default: matchesTime = true;
        }
        return matchesSearch && matchesCategory && matchesTime;
    });
    currentDocsPage = 1;
    renderDocsList();
}

function updateStats() {
    var total = uploadedDocs.length;
    var instructions = uploadedDocs.filter(function(d) { return d.category === 'تعليمات'; }).length;
    var alerts = uploadedDocs.filter(function(d) { return d.category === 'تنبيه'; }).length;
    var notifications = uploadedDocs.filter(function(d) { return d.category === 'إشعار'; }).length;
    var el_statTotal = document.getElementById('statTotal'); if (el_statTotal) el_statTotal.innerText = total;
    var el_statInstructions = document.getElementById('statInstructions'); if (el_statInstructions) el_statInstructions.innerText = instructions;
    var el_statAlerts = document.getElementById('statAlerts'); if (el_statAlerts) el_statAlerts.innerText = alerts;
    var el_statNotifications = document.getElementById('statNotifications'); if (el_statNotifications) el_statNotifications.innerText = notifications;
}

function getTimeAgo(dateString) {
    var now = new Date();
    var past = new Date(dateString);
    var diff = Math.floor((now - past) / 1000);
    if (diff < 60) return 'الآن';
    if (diff < 3600) return 'منذ ' + Math.floor(diff / 60) + ' دقيقة';
    if (diff < 86400) return 'منذ ' + Math.floor(diff / 3600) + ' ساعة';
    if (diff < 604800) return 'منذ ' + Math.floor(diff / 86400) + ' يوم';
    if (diff < 2592000) return 'منذ ' + Math.floor(diff / 604800) + ' أسبوع';
    return 'منذ ' + Math.floor(diff / 2592000) + ' شهر';
}

function getFileIcon(filename) {
    if (filename.match(/\.(pdf)$/i)) return '📄';
    if (filename.match(/\.(doc|docx)$/i)) return '📝';
    if (filename.match(/\.(xls|xlsx)$/i)) return '📊';
    if (filename.match(/\.(png|jpg|jpeg|gif|svg)$/i)) return '🖼️';
    if (filename.match(/\.(txt)$/i)) return '📃';
    if (filename.match(/\.(zip|rar|7z)$/i)) return '📦';
    return '📎';
}

function getCategoryColor(category) {
    var colors = { 'تعليمات': '#2563EB', 'إشعار': '#F59E0B', 'تقرير': '#10B981', 'جدول': '#3B82F6', 'تنبيه': '#EF4444', 'أخرى': '#64748B' };
    return colors[category] || '#64748B';
}

function getPriorityColor(priority) {
    var colors = { 'normal': '#64748B', 'important': '#F59E0B', 'urgent': '#EF4444' };
    return colors[priority] || '#64748B';
}

function changeViewMode() {
    docsViewMode = document.getElementById('docsViewMode').value;
    renderDocsList();
}

function openUploadModal() {
    alert('📤 سيتم فتح نافذة رفع التحديثات الجديدة');
}

function openUrgentUploadModal() {
    alert('🚨 سيتم فتح نافذة رفع تحديث عاجل');
}

async function downloadDoc(docId) { try { window.open('/api/download-doc/' + docId, '_blank'); } catch (error) { alert('❌ فشل في تحميل التحديث'); } }

async function deleteDoc(docId) {
    if (!confirm('⚠️ هل أنت متأكد من حذف هذا التحديث؟')) return;
    try {
        var response = await fetch('/api/delete-doc/' + docId, { method: 'DELETE' });
        var result = await response.json();
        if (result.success) { await loadDocsData(); } else { alert('❌ فشل في حذف التحديث'); }
    } catch (error) { alert('❌ خطأ في الاتصال'); }
}

// ============================================
// وظائف بناء الجدول
// ============================================
function updateRapidStatusIcon(index) {
    var staffInput = document.getElementById('rapid_staff_' + index);
    var carsInput = document.getElementById('rapid_cars_' + index);
    var iconSpan = document.getElementById('rapid_status_' + index);
    var backupParamedicInput = document.getElementById('backup_paramedic_rapid_' + index);
    var hasBackupParamedic = backupParamedicInput && backupParamedicInput.value.trim().length > 0;
    if (staffInput && carsInput && iconSpan) {
        var staffCount = parseInt(staffInput.value) || 0;
        var carsCount = parseInt(carsInput.value) || 0;
        if ((staffCount >= 1 || hasBackupParamedic) && carsCount >= 1) { 
            iconSpan.innerHTML = '✅'; 
            iconSpan.className = 'status-icon status-ok'; 
        } else { 
            iconSpan.innerHTML = '❌'; 
            iconSpan.className = 'status-icon status-not'; 
        }
    }
}

function setRapidComplete(index) {
    var staffInput = document.getElementById('rapid_staff_' + index);
    var carsInput = document.getElementById('rapid_cars_' + index);
    if (staffInput) staffInput.value = 1;
    if (carsInput) carsInput.value = 1;
    updateRapidStatusIcon(index);
    refreshWorkforceFromServer();
    updateShiftKPIs();
    var countDisplay = document.getElementById('staffCountDisplay_' + safeTeamId(rapidTeams[index].name));
    if (countDisplay) countDisplay.textContent = '1 حاضر';
}

function setRapidIncomplete(index) {
    var staffInput = document.getElementById('rapid_staff_' + index);
    var carsInput = document.getElementById('rapid_cars_' + index);
    if (staffInput) staffInput.value = 0;
    if (carsInput) carsInput.value = 0;
    updateRapidStatusIcon(index);
    refreshWorkforceFromServer();
    updateShiftKPIs();
    var countDisplay = document.getElementById('staffCountDisplay_' + safeTeamId(rapidTeams[index].name));
    if (countDisplay) countDisplay.textContent = '0 حاضر';
}


function buildCentersTable() {
    var tbody = document.getElementById('centersTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';
    
    // Add Rapid Response Teams first
    for (var r = 0; r < rapidTeams.length; r++) {
        var rapid = rapidTeams[r];
        var tr = document.createElement('tr');
        tr.id = 'rapid-row-' + r;
        tr.className = 'rapid-team-row';
        tr.style.background = 'rgba(255, 193, 7, 0.05)';
        
        var statusHtml = '<span id="rapid_status_' + r + '" class="status-icon status-not" style="font-size:1.4rem;">❌</span>';
        
        var actionHtml = `
            <div style="display:flex; gap:4px; justify-content:center; flex-wrap:wrap;">
                <button onclick="setRapidComplete(${r})" class="btn btn-success" style="padding:2px 10px; font-size:0.6rem; background:#2a7f3e; color:white; border:none; border-radius:12px; cursor:pointer;">
                    ✅ مكتمل
                </button>
                <button onclick="setRapidIncomplete(${r})" class="btn btn-danger" style="padding:2px 10px; font-size:0.6rem; background:#c0392b; color:white; border:none; border-radius:12px; cursor:pointer;">
                    ❌ ناقص
                </button>
            </div>
        `;
        
        var safeName = rapid.name.replace(/\s+/g, '_');
        tr.innerHTML = `
            <td style="font-weight:bold; font-size:0.75rem; text-align:center; color:var(--gold);">⚡ تدخل سريع</td>
            <td style="font-weight:600; font-size:0.75rem; text-align:center;">${rapid.displayName}</td>
            <td style="text-align:center;">${statusHtml}</td>
            <td style="min-width:130px; padding:4px;">
                <div class="paramedic-box" id="paramedic-box-rapid-${r}">
                    <div class="paramedic-list" id="paramedics_${safeName}">
                        <div class="paramedic-no-data">اضغط تكميل لتحميل المسعفين</div>
                    </div>
                    <div class="staff-count-display" id="staffCountDisplay_${safeName}">-</div>
                </div>
                <input type="hidden" id="rapid_staff_${r}" value="">
                <div class="fallback-staff-input" id="fallback_rapid_staff_${r}" style="display:none;">
                    <input type="number" id="fallback_rapid_staff_input_${r}" style="width:50px; text-align:center; padding:4px; border:1px solid var(--gray-200); border-radius:4px;" min="0" max="1" value="" placeholder="1">
                </div>
                <div style="margin-top:4px;">
                    <input type="text" id="backup_paramedic_rapid_${r}" style="width:100%; font-size:0.7rem; padding:4px; border:1px solid var(--gray-200); border-radius:4px;" placeholder="اسم المسعف الاحتياطي (تغطية يدوية)...">
                </div>
            </td>
            <td><input type="number" id="rapid_cars_${r}" style="width:50px; text-align:center; padding:4px; border:1px solid var(--gray-200); border-radius:4px;" min="0" max="1" value="" placeholder="1"></td>
            <td style="text-align:center;">${actionHtml}</td>
            <td><input type="text" id="rapid_notes_${r}" style="width:100%; font-size:0.7rem; padding:4px; border:1px solid var(--gray-200); border-radius:4px;" placeholder="تأخير / غياب..."></td>
            <td style="text-align:center; color:var(--gray-400); font-size:0.7rem;">-</td>
            <td style="text-align:center; color:var(--gray-400); font-size:0.7rem;">-</td>
        `;
        
        var carsInput = tr.querySelector('#rapid_cars_' + r);
        var fallbackStaffInput = tr.querySelector('#fallback_rapid_staff_input_' + r);
        
        if (fallbackStaffInput) {
            fallbackStaffInput.addEventListener('input', function(idx) { 
                return function() { 
                    var hidden = document.getElementById('rapid_staff_' + idx);
                    if (hidden) hidden.value = this.value;
                    updateRapidStatusIcon(idx); 
                    refreshWorkforceFromServer(); 
                    updateShiftKPIs();
                };
            }(r));
        }
        
        // Backup paramedic input for rapid teams
        var backupParamedicInputRapid = tr.querySelector('#backup_paramedic_rapid_' + r);
        if (backupParamedicInputRapid) {
            backupParamedicInputRapid.addEventListener('input', function(idx) { 
                return function() { 
                    var hidden = document.getElementById('rapid_staff_' + idx);
                    var backupValue = this.value.trim();
                    if (backupValue) {
                        var currentStaff = parseInt(hidden ? hidden.value : '0') || 0;
                        if (currentStaff < 1) {
                            if (hidden) hidden.value = '1';
                        }
                    }
                    updateRapidStatusIcon(idx); 
                    refreshWorkforceFromServer(); 
                    updateShiftKPIs();
                };
            }(r));
        }
        
        carsInput.addEventListener('input', function(idx) { 
            return function() { 
                updateRapidStatusIcon(idx); 
                refreshWorkforceFromServer(); 
            };
        }(r));
        
        tbody.appendChild(tr);
    }
    
    // Add separator row
    var sepTr = document.createElement('tr');
    sepTr.innerHTML = '<td colspan="9" style="background:var(--gray-100); height:8px; padding:0;"></td>';
    tbody.appendChild(sepTr);
    
    // Add Regular Centers
    for (var i = 0; i < centerList.length; i++) {
        var tr = document.createElement('tr');
        tr.id = 'center-row-' + i;
        
        var statusHtml = '<span id="status_' + i + '" class="status-icon status-not" style="font-size:1.4rem;">❌</span>';
        
        var actionHtml = `
            <div style="display:flex; gap:4px; justify-content:center; flex-wrap:wrap;">
                <button onclick="setCenterComplete(${i})" class="btn btn-success" style="padding:2px 10px; font-size:0.6rem; background:#2a7f3e; color:white; border:none; border-radius:12px; cursor:pointer;">
                    ✅ مكتمل
                </button>
                <button onclick="setCenterIncomplete(${i})" class="btn btn-danger" style="padding:2px 10px; font-size:0.6rem; background:#c0392b; color:white; border:none; border-radius:12px; cursor:pointer;">
                    ❌ ناقص
                </button>
            </div>
        `;
        
        var safeName = centerList[i].replace(/\s+/g, '_');
        tr.innerHTML = `
            <td style="font-weight:bold; font-size:0.75rem; text-align:center; color:var(--primary);">🏥 مركز</td>
            <td style="font-weight:600; font-size:0.75rem; text-align:center;">${centerList[i]}</td>
            <td style="text-align:center;">${statusHtml}</td>
            <td style="min-width:130px; padding:4px;">
                <div class="paramedic-box" id="paramedic-box-${i}">
                    <div class="paramedic-list" id="paramedics_${safeName}">
                        <div class="paramedic-no-data">اضغط تكميل لتحميل المسعفين</div>
                    </div>
                    <div class="staff-count-display" id="staffCountDisplay_${safeName}">-</div>
                </div>
                <input type="hidden" id="staff_${i}" value="">
                <div class="fallback-staff-input" id="fallback_staff_${i}" style="display:none;">
                    <input type="number" id="fallback_staff_input_${i}" style="width:50px; text-align:center; padding:4px; border:1px solid var(--gray-200); border-radius:4px;" min="0" max="4" value="" placeholder="2+">
                </div>
                <div style="margin-top:4px;">
                    <input type="text" id="backup_paramedic_${i}" style="width:100%; font-size:0.7rem; padding:4px; border:1px solid var(--gray-200); border-radius:4px;" placeholder="اسم المسعف الاحتياطي (تغطية يدوية)...">
                </div>
            </td>
            <td><input type="number" id="cars_${i}" style="width:50px; text-align:center; padding:4px; border:1px solid var(--gray-200); border-radius:4px;" min="0" max="2" value="" placeholder="1+"></td>
            <td style="text-align:center;">${actionHtml}</td>
            <td><input type="text" id="notes_${i}" style="width:100%; font-size:0.7rem; padding:4px; border:1px solid var(--gray-200); border-radius:4px;" placeholder="تأخير / غياب..."></td>
            <td><select id="vehicle_${i}" style="width:80px; font-size:0.7rem; padding:3px; border:1px solid var(--gray-200); border-radius:4px;">
                <option value="">--</option><option value="ready">✅ جاهزة</option><option value="maintenance">🔧 صيانة</option><option value="broken">❌ معطلة</option>
            </select></td>
            <td><select id="fuel_${i}" style="width:80px; font-size:0.7rem; padding:3px; border:1px solid var(--gray-200); border-radius:4px;">
                <option value="">--</option><option value="full">✅ ممتلئ</option><option value="half">🟡 نصف</option><option value="low">🔴 منخفض</option>
            </select></td>
        `;
        
        var carsInput = tr.querySelector('#cars_' + i);
        var fallbackStaffInput = tr.querySelector('#fallback_staff_input_' + i);
        
        if (fallbackStaffInput) {
            fallbackStaffInput.addEventListener('input', function(idx) { 
                return function() { 
                    var hidden = document.getElementById('staff_' + idx);
                    if (hidden) hidden.value = this.value;
                    updateStatusIcon(idx); 
                    refreshWorkforceFromServer(); 
                    updateShiftKPIs();
                };
            }(i));
        }
        
        // Backup paramedic input for manual coverage
        var backupParamedicInput = tr.querySelector('#backup_paramedic_' + i);
        if (backupParamedicInput) {
            backupParamedicInput.addEventListener('input', function(idx) { 
                return function() { 
                    var hidden = document.getElementById('staff_' + idx);
                    var backupValue = this.value.trim();
                    if (backupValue) {
                        // If backup paramedic entered, set staff to at least 1 (or current + 1)
                        var currentStaff = parseInt(hidden ? hidden.value : '0') || 0;
                        if (currentStaff < 1) {
                            if (hidden) hidden.value = '1';
                        }
                    }
                    updateStatusIcon(idx); 
                    refreshWorkforceFromServer(); 
                    updateShiftKPIs();
                };
            }(i));
        }
        
        carsInput.addEventListener('input', function(idx) { 
            return function() { 
                updateStatusIcon(idx); 
                refreshWorkforceFromServer(); 
            };
        }(i));
        
        var vehicleSelect = tr.querySelector('#vehicle_' + i);
        var fuelSelect = tr.querySelector('#fuel_' + i);

        if (vehicleSelect) {
            vehicleSelect.addEventListener('change', function(idx) {
                return function() { updateVehicleStatusIcon(idx); };
            }(i));
        }
        tbody.appendChild(tr);
    }
}

function updateStatusIcon(index) {
    var staffInput = document.getElementById('staff_' + index);
    var carsInput = document.getElementById('cars_' + index);
    var iconSpan = document.getElementById('status_' + index);
    if (staffInput && carsInput && iconSpan) {
        var staffCount = parseInt(staffInput.value) || 0;
        var carsCount = parseInt(carsInput.value) || 0;
        if (staffCount >= 2 && carsCount >= 1) { 
            iconSpan.innerHTML = '✅'; 
            iconSpan.className = 'status-icon status-ok'; 
        } else { 
            iconSpan.innerHTML = '❌'; 
            iconSpan.className = 'status-icon status-not'; 
        }
    }
}

// ===== تطويرات نظام تكميل النوبة =====
// ============================================================
// تطويرات نظام تكميل النوبة - كود JavaScript جديد
// يُضاف بعد buildCentersTable() وقبل updateWorkforceStats()
// ES5 compatible - var فقط، function declarations، لا arrow functions
// ============================================================

// ===== 1. شريط تقدم المناوبة =====
var shiftStartTime = null;
var shiftDurationMinutes = 720; // 12 ساعة

function initShiftProgressBar() {
    // يُستدعى عند فتح نموذج المناوبة
    updateShiftProgress();
    // تحديث كل دقيقة
    if (window._shiftProgressInterval) clearInterval(window._shiftProgressInterval);
    window._shiftProgressInterval = setInterval(updateShiftProgress, 60000);
}

function updateShiftProgress() {
    if (!currentShiftId) return;

    // جلب وقت بداية المناوبة من allShifts
    var shift = null;
    for (var i = 0; i < allShifts.length; i++) {
        if (allShifts[i].id === currentShiftId) {
            shift = allShifts[i];
            break;
        }
    }
    if (!shift || !shift.startTime) return;

    var start = new Date(shift.startTime);
    var now = new Date();
    var elapsedMs = now - start;
    var elapsedMinutes = Math.floor(elapsedMs / 60000);
    var percent = Math.min((elapsedMinutes / shiftDurationMinutes) * 100, 100);

    var elapsedHours = Math.floor(elapsedMinutes / 60);
    var elapsedMins = elapsedMinutes % 60;
    var remainingMinutes = Math.max(shiftDurationMinutes - elapsedMinutes, 0);
    var remainingHours = Math.floor(remainingMinutes / 60);
    var remainingMins = remainingMinutes % 60;

    // تحديث DOM
    var fill = document.getElementById('shiftProgressFill');
    if (fill) {
        fill.style.width = percent + '%';
        fill.className = 'shift-progress-bar-fill';
        if (percent >= 90) fill.classList.add('danger');
        else if (percent >= 70) fill.classList.add('warning');
    }

    var timeEl = document.getElementById('shiftProgressTime');
    if (timeEl) {
        timeEl.textContent = pad2(elapsedHours) + ':' + pad2(elapsedMins) + ' / ' + pad2(remainingHours) + ':' + pad2(remainingMins);
    }

    var elapsedEl = document.getElementById('shiftElapsedHours');
    if (elapsedEl) elapsedEl.textContent = elapsedHours + ':' + pad2(elapsedMins);

    var remainingEl = document.getElementById('shiftRemainingHours');
    if (remainingEl) remainingEl.textContent = remainingHours + ':' + pad2(remainingMins);

    var percentEl = document.getElementById('shiftPercentComplete');
    if (percentEl) percentEl.textContent = Math.round(percent) + '%';
}

function pad2(n) { return n < 10 ? '0' + n : n; }


// ===== 2. سجل أحداث المناوبة =====
var shiftEventLog = [];

function toggleComparison() {
    var content = document.getElementById('comparisonContent');
    var icon = document.getElementById('comparisonToggleIcon');
    if (!content || !icon) return;
    if (content.style.display === 'none') {
        content.style.display = 'block';
        icon.style.transform = 'rotate(180deg)';
    } else {
        content.style.display = 'none';
        icon.style.transform = 'rotate(0deg)';
    }
}

function toggleEventLog() {
    var content = document.getElementById('eventLogContent');
    var icon = document.getElementById('eventLogToggleIcon');
    if (!content || !icon) return;
    if (content.style.display === 'none') {
        content.style.display = 'block';
        icon.style.transform = 'rotate(180deg)';
    } else {
        content.style.display = 'none';
        icon.style.transform = 'rotate(0deg)';
    }
}

function loadShiftEventLog() {
    var section = document.getElementById('shiftEventLogSection');
    var container = document.getElementById('shiftEventLog');
    if (!section || !container) return;

    var key = 'shiftEventLog_' + (currentShiftId || 'temp');
    var stored = localStorage.getItem(key);
    shiftEventLog = stored ? JSON.parse(stored) : [];

    if (shiftEventLog.length > 0) section.style.display = 'block';

    container.innerHTML = '';
    for (var i = 0; i < shiftEventLog.length; i++) {
        renderEventItem(shiftEventLog[i]);
    }
}

function addShiftEvent(type, text, source) {
    if (!currentShiftId) return;
    var evt = {
        time: getSaudiTime(),
        type: type,      // 'complete', 'incomplete', 'note', 'report'
        text: text,
        source: source || 'auto'  // 'auto' or 'manual'
    };
    shiftEventLog.push(evt);
    var key = 'shiftEventLog_' + currentShiftId;
    localStorage.setItem(key, JSON.stringify(shiftEventLog));

    var section = document.getElementById('shiftEventLogSection');
    if (section) section.style.display = 'block';
    renderEventItem(evt);

    // scroll to bottom
    var container = document.getElementById('shiftEventLog');
    if (container) container.scrollTop = container.scrollHeight;
}

function renderEventItem(evt) {
    var container = document.getElementById('shiftEventLog');
    if (!container) return;
    var div = document.createElement('div');
    div.className = 'shift-event-item type-' + evt.type;
    var typeLabels = { complete: '\u2705 تكميل', incomplete: '\u274c ناقص', note: '\ud83d\udcdd ملاحظة', report: '\ud83d\udcca بلاغ' };
    var badgeText = evt.source === 'auto' ? 'تلقائي' : 'يدوي';
    div.innerHTML =
        '<span class="shift-event-time">' + evt.time + '</span>' +
        '<span class="shift-event-text">' + escapeHtml(evt.text) + '</span>' +
        '<span class="shift-event-badge ' + evt.source + '">' + badgeText + '</span>';
    container.appendChild(div);
}

function addManualShiftEvent() {
    var input = document.getElementById('manualEventInput');
    if (!input || !input.value.trim()) return;
    addShiftEvent('note', input.value.trim(), 'manual');
    input.value = '';
}

function clearShiftEventLog() {
    if (!confirm('\u26a0\ufe0f هل أنت متأكد من مسح سجل الأحداث؟')) return;
    shiftEventLog = [];
    var key = 'shiftEventLog_' + (currentShiftId || 'temp');
    localStorage.removeItem(key);
    var container = document.getElementById('shiftEventLog');
    if (container) container.innerHTML = '';
    var section = document.getElementById('shiftEventLogSection');
    if (section) section.style.display = 'none';
}

// ربط الأحداث التلقائية
function onCenterStatusChanged(centerName, isComplete) {
    addShiftEvent(
        isComplete ? 'complete' : 'incomplete',
        centerName + (isComplete ? ' تم التكميل' : ' بحاجة إلى تكميل'),
        'auto'
    );
}


// ===== 3. تتبع الغياب والتأخير =====
var absenceRecords = [];
var ABSENCE_TYPE_LABELS = {
    absence: { text: 'غياب', class: 'type-absence', emoji: '\u274c' },
    delay: { text: 'تأخير', class: 'type-delay', emoji: '\u23f0' },
    checkout: { text: 'تسجيل خروج', class: 'type-permission', emoji: '\uD83D\uDE82' },
    early: { text: 'خروج مبكر', class: 'type-early', emoji: '\uD83C\uDFC3' },
    late_exit: { text: 'خروج متأخر', class: 'type-delay', emoji: '\uD83D\uDEAA' },
    permission: { text: 'إذن', class: 'type-permission', emoji: '\uD83D\uDCDD' }
};
var ABSENCE_REASON_LABELS = {
    sick: '\ud83e\udd12 مرضي',
    vacation: '\ud83c\udfd6\ufe0f إجازة',
    permission: '\ud83d\udccb إذن رسمي',
    emergency: '\ud83d\udea8 حالة طارئة',
    personal: '\ud83d\udc64 شخصي',
    other: '\u2753 أخرى'
};

function addAbsenceRecord() {
    var nameEl = document.getElementById('absenceName');
    var typeEl = document.getElementById('absenceType');
    var reasonEl = document.getElementById('absenceReason');
    var fromEl = document.getElementById('absenceFromTime');
    var toEl = document.getElementById('absenceToTime');

    var name = nameEl ? nameEl.value.trim() : '';
    var type = typeEl ? typeEl.value : 'absence';
    var reason = reasonEl ? reasonEl.value : '';
    var fromTime = fromEl ? fromEl.value : '';
    var toTime = toEl ? toEl.value : '';

    if (!name) { showToast('\u26a0\ufe0f الرجاء إدخال اسم الشخص', 'warning'); return; }

    var record = {
        id: Date.now(),
        name: name,
        type: type,
        reason: reason,
        fromTime: fromTime,
        toTime: toTime,
        timestamp: getSaudiTime(),
        shiftId: currentShiftId
    };

    absenceRecords.push(record);
    saveAbsenceRecords();
    renderAbsenceRecords();
    updateAbsenceSummary();

    // مسح الحقول
    if (nameEl) nameEl.value = '';
    if (reasonEl) reasonEl.value = '';
    if (fromEl) fromEl.value = '';
    if (toEl) toEl.value = '';

    // تسجيل في سجل الأحداث
    var typeInfo = ABSENCE_TYPE_LABELS[type] || ABSENCE_TYPE_LABELS.absence;
    var reasonText = reason ? (' (' + (ABSENCE_REASON_LABELS[reason] || reason) + ')') : '';
    addShiftEvent('note', typeInfo.emoji + ' ' + typeInfo.text + ': ' + name + reasonText, 'manual');

    showToast('\u2705 تم تسجيل ' + typeInfo.text, 'success');
}

function deleteAbsenceRecord(id) {
    var filtered = [];
    for (var i = 0; i < absenceRecords.length; i++) {
        if (absenceRecords[i].id !== id) filtered.push(absenceRecords[i]);
    }
    absenceRecords = filtered;
    saveAbsenceRecords();
    renderAbsenceRecords();
    updateAbsenceSummary();
}

function updateAbsenceFormFields() {
    var type = document.getElementById('absenceType').value;
    var fromLabel = document.getElementById('absenceFromLabel');
    var toLabel = document.getElementById('absenceToLabel');
    var toTime = document.getElementById('absenceToTime');
    if (!fromLabel || !toLabel) return;
    if (type === 'delay') {
        fromLabel.textContent = 'وقت الوصول:';
        toLabel.style.display = 'none';
        toTime.style.display = 'none';
    } else if (type === 'checkout') {
        fromLabel.textContent = 'وقت الخروج:';
        toLabel.style.display = 'none';
        toTime.style.display = 'none';
    } else {
        fromLabel.textContent = 'من:';
        toLabel.style.display = 'inline';
        toTime.style.display = 'inline';
    }
}

function renderAbsenceRecords() {
    var container = document.getElementById('absenceList');
    if (!container) return;

    if (absenceRecords.length === 0) {
        container.innerHTML = '<p style="text-align:center; color:var(--gray-400); padding:10px; font-size:0.7rem;">لا توجد سجلات</p>';
        return;
    }

    container.innerHTML = '';
    for (var i = 0; i < absenceRecords.length; i++) {
        var rec = absenceRecords[i];
        var typeInfo = ABSENCE_TYPE_LABELS[rec.type] || ABSENCE_TYPE_LABELS.absence;
        var reasonText = rec.reason ? (' <span style="color:var(--gray-600);">' + (ABSENCE_REASON_LABELS[rec.reason] || rec.reason) + '</span>') : '';
        var timeDisplay;
        if (rec.type === 'delay') {
            timeDisplay = '<span class="time-display">وصول: ' + (rec.fromTime || '--:--') + '</span>';
        } else if (rec.type === 'checkout') {
            timeDisplay = '<span class="time-display">خروج: ' + (rec.fromTime || '--:--') + '</span>';
        } else {
            timeDisplay = '<span class="time-display">' + (rec.fromTime ? rec.fromTime : '--:--') + ' → ' + (rec.toTime ? rec.toTime : '--:--') + '</span>';
        }

        var div = document.createElement('div');
        div.className = 'absence-item';
        div.innerHTML =
            '<span class="type-badge ' + typeInfo.class + '">' + typeInfo.emoji + ' ' + typeInfo.text + '</span>' +
            '<strong style="flex:1;">' + escapeHtml(rec.name) + '</strong>' +
            reasonText +
            '<span style="color:var(--gray-600); font-family:monospace; font-size:0.65rem;">' + timeDisplay + '</span>' +
            '<span style="color:var(--gray-500); font-size:0.6rem;">' + rec.timestamp + '</span>' +
            '<button onclick="deleteAbsenceRecord(' + rec.id + ')" style="background:none; border:none; color:#c0392b; cursor:pointer; font-size:0.7rem;"><i class="fas fa-trash"></i></button>';
        container.appendChild(div);
    }
}

function updateAbsenceSummary() {
    var counts = { absence: 0, delay: 0, checkout: 0, early: 0, late_exit: 0, permission: 0 };
    for (var i = 0; i < absenceRecords.length; i++) {
        var t = absenceRecords[i].type;
        counts[t] = (counts[t] || 0) + 1;
    }

    var totalEl = document.getElementById('absenceTotal');
    var badgeEl = document.getElementById('absenceCountBadge');
    if (totalEl) totalEl.textContent = absenceRecords.length;
    if (badgeEl) badgeEl.textContent = absenceRecords.length + ' سجل';

    var absEl = document.getElementById('absenceAbsenceCount');
    var delEl = document.getElementById('absenceDelayCount');
    var chkEl = document.getElementById('absenceCheckoutCount');
    var earEl = document.getElementById('absenceEarlyCount');
    var lateEl = document.getElementById('absenceLateExitCount');
    var perEl = document.getElementById('absencePermissionCount');
    if (absEl) absEl.textContent = counts.absence;
    if (delEl) delEl.textContent = counts.delay;
    if (chkEl) chkEl.textContent = counts.checkout;
    if (earEl) earEl.textContent = counts.early;
    if (lateEl) lateEl.textContent = counts.late_exit;
    if (perEl) perEl.textContent = counts.permission;
}

function saveAbsenceRecords() {
    if (currentShiftId) {
        localStorage.setItem('absenceRecords_' + currentShiftId, JSON.stringify(absenceRecords));
    }
}

function loadAbsenceRecords() {
    if (currentShiftId) {
        var stored = localStorage.getItem('absenceRecords_' + currentShiftId);
        absenceRecords = stored ? JSON.parse(stored) : [];
    } else {
        absenceRecords = [];
    }
    renderAbsenceRecords();
    updateAbsenceSummary();
}


// ===== 4. حالة المعدات والمركبات =====
function updateVehicleStatusIcon(index) {
    var select = document.getElementById('vehicle_' + index);
    var row = document.getElementById('center-row-' + index);
    if (!select || !row) return;

    var val = select.value;
    row.classList.remove('vehicle-ready', 'vehicle-maintenance', 'vehicle-broken');

    if (val === 'ready') row.classList.add('vehicle-ready');
    else if (val === 'maintenance') row.classList.add('vehicle-maintenance');
    else if (val === 'broken') row.classList.add('vehicle-broken');

    // إذا تغيرت الحالة، سجل في الأحداث
    if (val) {
        var labels = { ready: '\u2705 جاهزة', maintenance: '\ud83d\udd27 صيانة', broken: '\u274c معطلة' };
        var centerName = centerList[index] || ('مركز ' + index);
        addShiftEvent('note', '\ud83d\ude97 ' + centerName + ': حالة المركبة \u2192 ' + labels[val], 'auto');
    }
}


// ===== 5. Presets السريعة =====
function applyPreset(preset) {
    if (preset !== 'start' && !confirm('\u26a0\ufe0f سيتم تطبيق "' + getPresetLabel(preset) + '" على جميع المراكز. هل أنت متأكد؟')) return;

    for (var i = 0; i < centerList.length; i++) {
        var staffInput = document.getElementById('staff_' + i);
        var carsInput = document.getElementById('cars_' + i);
        var notesInput = document.getElementById('notes_' + i);
        var vehicleSelect = document.getElementById('vehicle_' + i);

        switch (preset) {
            case 'full':
                if (staffInput) staffInput.value = 2;
                if (carsInput) carsInput.value = 1;
                if (notesInput) notesInput.value = notesInput.value || '\u2705 مكتمل (preset)';
                if (vehicleSelect) vehicleSelect.value = 'ready';
                break;
            case 'emergency':
                if (staffInput) staffInput.value = 3;
                if (carsInput) carsInput.value = 2;
                if (notesInput) notesInput.value = notesInput.value || '\ud83d\udea8 حالة طوارئ - جاهزية كاملة';
                if (vehicleSelect) vehicleSelect.value = 'ready';
                break;
            case 'maintenance':
                if (staffInput) staffInput.value = 1;
                if (carsInput) carsInput.value = 0;
                if (notesInput) notesInput.value = notesInput.value || '\ud83d\udd27 صيانة دورية - نقص مؤقت';
                if (vehicleSelect) vehicleSelect.value = 'maintenance';
                break;
            case 'start':
                if (staffInput) staffInput.value = '';
                if (carsInput) carsInput.value = '';
                if (notesInput) notesInput.value = '';
                if (vehicleSelect) vehicleSelect.value = '';
                break;
        }
        updateStatusIcon(i);
        if (vehicleSelect) updateVehicleStatusIcon(i);
    }

    refreshWorkforceFromServer();
    addShiftEvent('note', '\u26a1 تم تطبيق: ' + getPresetLabel(preset), 'manual');
    showToast('\u2705 تم تطبيق "' + getPresetLabel(preset) + '"', 'success');
}

function getPresetLabel(preset) {
    var labels = { full: 'تكميل كامل', emergency: 'حالة طوارئ', maintenance: 'صيانة دورية', start: 'بداية مناوبة' };
    return labels[preset] || preset;
}


// ===== 6. مؤشرات كفاءة المناوبة =====
function updateShiftKPIs() {
    if (!currentShiftId) return;
    var section = document.getElementById('shiftKPIs');
    if (!section) return;

    section.style.display = 'block';

    // معدل الاستجابة: بلاغات ÷ ساعات منقضية
    var totalReports = 0;
    for (var key in reports) {
        if (reports[key] && reports[key].count) totalReports += reports[key].count;
    }

    var shift = null;
    for (var i = 0; i < allShifts.length; i++) {
        if (allShifts[i].id === currentShiftId) {
            shift = allShifts[i];
            break;
        }
    }
    var elapsedHours = 1; // minimum to avoid division by zero
    if (shift && shift.startTime) {
        elapsedHours = Math.max((new Date() - new Date(shift.startTime)) / 3600000, 0.5);
    }

    var responseRate = (totalReports / elapsedHours).toFixed(1);
    var kpiRate = document.getElementById('kpiResponseRate');
    if (kpiRate) kpiRate.textContent = responseRate;

    // أكثر مركز نشاطاً
    var centerCounts = {};
    for (var k in reports) {
        var parts = k.split('|');
        if (parts[0]) centerCounts[parts[0]] = (centerCounts[parts[0]] || 0) + (reports[k].count || 0);
    }
    var topCenter = '-';
    var topCount = 0;
    for (var c in centerCounts) {
        if (centerCounts[c] > topCount) { topCenter = c; topCount = centerCounts[c]; }
    }
    var kpiCenter = document.getElementById('kpiTopCenter');
    if (kpiCenter) kpiCenter.textContent = topCenter;

    // متوسط بلاغ لكل فرقة
    var unitCount = 0;
    for (var _k in reports) { unitCount++; }
    if (unitCount === 0) unitCount = 1;
    var avgPerUnit = (totalReports / unitCount).toFixed(1);
    var kpiAvg = document.getElementById('kpiAvgPerUnit');
    if (kpiAvg) kpiAvg.textContent = avgPerUnit;
}


// ===== 7. حفظ تلقائي =====
var _autoSaveTimer = null;
var _pendingChanges = false;

function initAutoSave() {
    if (_autoSaveTimer) clearInterval(_autoSaveTimer);
    _autoSaveTimer = setInterval(function() {
        if (_pendingChanges && currentShiftId) {
            autoSaveShift();
        }
    }, 30000); // كل 30 ثانية

    // مراقبة التغييرات
    var container = document.getElementById('shiftModal');
    if (container) {
        container.addEventListener('input', function() { _pendingChanges = true; });
        container.addEventListener('change', function() { _pendingChanges = true; });
    }
}

async function autoSaveShift() {
    if (!currentShiftId) return;
    try {
        var shiftData = getShiftFromForm();
        if (!shiftData.shiftType) return;

        await fetch('/api/update-shift-data', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ shiftId: currentShiftId, shiftData: shiftData })
        });

        _pendingChanges = false;
        showAutoSaveIndicator();
    } catch (e) { /* silently fail */ }
}

function showAutoSaveIndicator() {
    var indicator = document.getElementById('autoSaveIndicator');
    if (!indicator) {
        indicator = document.createElement('div');
        indicator.id = 'autoSaveIndicator';
        indicator.style.cssText = 'position:fixed; bottom:20px; left:20px; background:var(--teal); color:white; padding:6px 14px; border-radius:20px; font-size:0.7rem; z-index:99999; opacity:0; transition:opacity 0.5s;';
        document.body.appendChild(indicator);
    }
    indicator.textContent = '\u2713 تم الحفظ التلقائي ' + getSaudiTime();
    indicator.style.opacity = '1';
    setTimeout(function() { indicator.style.opacity = '0'; }, 3000);
}

// تحذير عند الإغلاق مع تغييرات
window.addEventListener('beforeunload', function(e) {
    if (_pendingChanges && currentShiftId) {
        e.preventDefault();
        e.returnValue = '';
    }
});


// ===== 8. مقارنة مع المناوبة السابقة =====
function loadShiftComparison() {
    var section = document.getElementById('shiftComparison');
    var content = document.getElementById('shiftComparisonContent');
    if (!section || !content || !currentShiftId) return;

    var currentShift = null;
    for (var i = 0; i < allShifts.length; i++) {
        if (allShifts[i].id === currentShiftId) {
            currentShift = allShifts[i];
            break;
        }
    }
    if (!currentShift) return;

    // ابحث عن المناوبة السابقة من نفس النوع
    var sameTypeShifts = [];
    for (var j = 0; j < allShifts.length; j++) {
        if (allShifts[j].shiftType === currentShift.shiftType && allShifts[j].id !== currentShiftId) {
            sameTypeShifts.push(allShifts[j]);
        }
    }
    if (sameTypeShifts.length === 0) return;

    var prevShift = sameTypeShifts[sameTypeShifts.length - 1]; // آخر مناوبة من نفس النوع

    var currentTotal = currentShift.totalReports || 0;
    var prevTotal = prevShift.totalReports || 0;
    var diffTotal = currentTotal - prevTotal;
    var diffPercent = prevTotal > 0 ? Math.round((diffTotal / prevTotal) * 100) : 0;

    section.style.display = 'block';
    content.innerHTML =
        '<div style="text-align:center;"><div style="font-size:0.65rem; color:var(--gray-600);">البلاغات السابقة</div><div style="font-size:1.2rem; font-weight:700;">' + prevTotal + '</div></div>' +
        '<div style="text-align:center;"><div style="font-size:0.65rem; color:var(--gray-600);">البلاغات الحالية</div><div style="font-size:1.2rem; font-weight:700;">' + currentTotal + '</div></div>' +
        '<div style="text-align:center;"><div style="font-size:0.65rem; color:var(--gray-600);">الفرق</div><div style="font-size:1.2rem; font-weight:700; color:' + (diffTotal >= 0 ? '#c0392b' : '#2a7f3e') + ';">' + (diffTotal >= 0 ? '+' : '') + diffTotal + ' (' + diffPercent + '%)</div></div>' +
        '<div style="text-align:center;"><div style="font-size:0.65rem; color:var(--gray-600);">تاريخ المقارنة</div><div style="font-size:0.8rem; font-weight:600;">' + (prevShift.shiftDate || '-') + '</div></div>';
}


// ===== 9. تحسين نظام الملاحظات =====
var shiftNotes = [];

function addStructuredNote() {
    var textEl = document.getElementById('generalNotes');
    var catEl = document.getElementById('noteCategory');
    var priEl = document.getElementById('notePriority');

    var text = textEl ? textEl.value.trim() : '';
    var category = catEl ? catEl.value : 'general';
    var priority = priEl ? priEl.value : 'normal';
    if (!text) return;

    var note = {
        id: Date.now(),
        text: text,
        category: category,
        priority: priority,
        timestamp: getSaudiTime(),
        resolved: false,
        shiftId: currentShiftId
    };
    shiftNotes.push(note);
    saveShiftNotes();
    renderShiftNotes();
    if (textEl) textEl.value = '';
}

function renderShiftNotes() {
    var container = document.getElementById('savedNotesList');
    if (!container) return;
    if (shiftNotes.length === 0) { container.innerHTML = ''; return; }

    var catLabels = { operational: '\u2699\ufe0f', administrative: '\ud83d\udccb', emergency: '\ud83d\udea8', general: '\ud83d\udcdd' };
    var priColors = { normal: '#2980b9', important: '#f39c12', urgent: '#c0392b' };

    container.innerHTML = '';
    for (var i = 0; i < shiftNotes.length; i++) {
        var note = shiftNotes[i];
        var div = document.createElement('div');
        div.style.cssText = 'padding:6px 10px; border-radius:6px; margin-bottom:4px; font-size:0.7rem; border-right:3px solid ' + (priColors[note.priority] || '#2980b9') + '; background:' + (note.resolved ? '#e8f5e9' : 'white') + ';';
        div.innerHTML =
            '<span style="opacity:0.7;">' + (catLabels[note.category] || '\ud83d\udcdd') + '</span> ' +
            '<span style="text-decoration:' + (note.resolved ? 'line-through' : 'none') + ';">' + escapeHtml(note.text) + '</span> ' +
            '<span style="color:var(--gray-500); font-size:0.6rem;">' + note.timestamp + '</span>' +
            '<button onclick="toggleNoteResolved(' + note.id + ')" style="background:none; border:none; cursor:pointer; font-size:0.7rem; margin-right:5px;">' + (note.resolved ? '\u21a9\ufe0f' : '\u2713') + '</button>';
        container.appendChild(div);
    }
}

async function loadShiftNotes() {
    if (currentShiftId) {
        try {
            var res = await AuthManager.apiRequest('/api/shift-notes/' + currentShiftId);
            var data = await res.json();
            shiftNotes = data && data.notes ? data.notes : (Array.isArray(data) ? data : []);
        } catch (e) {
            shiftNotes = [];
        }
    } else {
        shiftNotes = [];
    }
    renderShiftNotes();
}

function toggleNoteResolved(id) {
    var note = null;
    for (var i = 0; i < shiftNotes.length; i++) {
        if (shiftNotes[i].id === id) {
            note = shiftNotes[i];
            break;
        }
    }
    if (note) {
        note.resolved = !note.resolved;
        saveShiftNotes();
        renderShiftNotes();
    }
}

function saveShiftNotes() {
    if (currentShiftId) localStorage.setItem('shiftNotes_' + currentShiftId, JSON.stringify(shiftNotes));
}




// ============================================
// إجراءات التكميل السريع للمراكز
// ============================================

// تعيين المركز كمكتمل (2 مسعف + 1 سيارة)
function setCenterComplete(index) {
    var staffInput = document.getElementById('staff_' + index);
    var carsInput = document.getElementById('cars_' + index);
    var notesInput = document.getElementById('notes_' + index);
    var centerName = centerList[index] || 'المركز';
    
    if (staffInput) staffInput.value = 2;
    if (carsInput) carsInput.value = 1;
    if (notesInput) {
        if (!notesInput.value.trim()) {
            notesInput.value = '✅ مكتمل';
        }
    }
    
    updateStatusIcon(index);
    refreshWorkforceFromServer();
    
    var row = document.getElementById('center-row-' + index);
    if (row) {
        row.style.transition = 'background 0.5s';
        row.style.background = '#e8f5e9';
        setTimeout(function() {
            row.style.background = '';
        }, 1000);
    }
    
    onCenterStatusChanged(centerName, true);
    showToast('✅ ' + centerName + ' تم التكميل بنجاح', 'success');
}

// تعيين المركز كناقص (فارغ)
function setCenterIncomplete(index) {
    var staffInput = document.getElementById('staff_' + index);
    var carsInput = document.getElementById('cars_' + index);
    var notesInput = document.getElementById('notes_' + index);
    var centerName = centerList[index] || 'المركز';
    
    if (staffInput) staffInput.value = '';
    if (carsInput) carsInput.value = '';
    if (notesInput) {
        if (!notesInput.value.trim()) {
            notesInput.value = '❌ بحاجة إلى تكميل';
        }
    }
    
    updateStatusIcon(index);
    refreshWorkforceFromServer();
    
    var row = document.getElementById('center-row-' + index);
    if (row) {
        row.style.transition = 'background 0.5s';
        row.style.background = '#ffebee';
        setTimeout(function() {
            row.style.background = '';
        }, 1000);
    }
    
    onCenterStatusChanged(centerName, false);
    showToast('⚠️ ' + centerName + ' بحاجة إلى تكميل', 'alert');
}

// تعيين جميع المراكز كمكتملة
function setAllCentersComplete() {
    if (!confirm('⚠️ هل أنت متأكد من تعيين جميع المراكز كمكتملة؟')) return;
    
    for (var i = 0; i < centerList.length; i++) {
        var staffInput = document.getElementById('staff_' + i);
        var carsInput = document.getElementById('cars_' + i);
        var notesInput = document.getElementById('notes_' + i);
        
        if (staffInput) staffInput.value = 2;
        if (carsInput) carsInput.value = 1;
        if (notesInput) {
            if (!notesInput.value.trim()) {
                notesInput.value = '✅ مكتمل (تلقائي)';
            }
        }
        updateStatusIcon(i);
    }
    refreshWorkforceFromServer();
    addShiftEvent('complete', 'تم تكميل جميع المراكز تلقائياً', 'auto');
    showToast('✅ تم تعيين جميع المراكز كمكتملة', 'success');
}

// تعيين جميع المراكز كناقصة
function setAllCentersIncomplete() {
    if (!confirm('⚠️ هل أنت متأكد من تعيين جميع المراكز كناقصة؟')) return;
    
    for (var i = 0; i < centerList.length; i++) {
        var staffInput = document.getElementById('staff_' + i);
        var carsInput = document.getElementById('cars_' + i);
        var notesInput = document.getElementById('notes_' + i);
        
        if (staffInput) staffInput.value = '';
        if (carsInput) carsInput.value = '';
        if (notesInput) {
            if (!notesInput.value.trim()) {
                notesInput.value = '❌ بحاجة إلى تكميل';
            }
        }
        updateStatusIcon(i);
    }
    refreshWorkforceFromServer();
    showToast('⚠️ تم تعيين جميع المراكز كناقصة', 'alert');
}

// ============================================
// طباعة المناوبة المباشرة
// ============================================
function printShift() {
    console.log('[PRINT] printShift called, centerList.length=' + (typeof centerList !== 'undefined' ? centerList.length : 'undefined'));

    // 1. نوع وتاريخ المناوبة
    var shiftType = '';
    var radios = document.querySelectorAll('input[name="shiftType"]');
    for (var i = 0; i < radios.length; i++) {
        if (radios[i].checked) { shiftType = radios[i].value; break; }
    }
    var shiftDateEl = document.getElementById('shiftDate');
    var shiftDate = (shiftDateEl && shiftDateEl.innerText) ? shiftDateEl.innerText : getSaudiDate();

    // 2. المراكز - نستخدم نفس طريقة buildCentersTable: نقرأ inputs مباشرة بالـ id
    var centersHtml = '';
    var totalStaff = 0, totalCars = 0, readyCount = 0;
    // نحاول نستخدم centerList لو موجود، وإلا نحسب من inputs
    var centerCount = (typeof centerList !== 'undefined' && centerList.length) ? centerList.length : 0;
    for (var idx = 0; idx < centerCount; idx++) {
        var staffEl = document.getElementById('staff_' + idx);
        var carsEl  = document.getElementById('cars_' + idx);
        var notesEl = document.getElementById('notes_' + idx);
        var vehSel  = document.getElementById('vehicle_' + idx);
        var fuelSel = document.getElementById('fuel_' + idx);

        var staff = (staffEl && staffEl.value) ? staffEl.value : '';
        var cars  = (carsEl  && carsEl.value)  ? carsEl.value  : '';
        var notes = (notesEl && notesEl.value) ? notesEl.value : '';
        var vehicle = (vehSel  && vehSel.value)  ? vehSel.value  : '';
        var fuel    = (fuelSel && fuelSel.value) ? fuelSel.value : '';

        var status = '❌ ناقص';
        if (parseInt(staff) >= 2 && parseInt(cars) >= 1) { status = '✅ مكتمل'; readyCount++; }
        else if (staff || cars) { status = '⚠️ جزئي'; }
        totalStaff += parseInt(staff) || 0;
        totalCars  += parseInt(cars)  || 0;

        var vehLabel = '';
        if (vehicle === 'ready')       vehLabel = '✅ جاهزة';
        else if (vehicle === 'maintenance') vehLabel = '🔧 صيانة';
        else if (vehicle === 'broken')      vehLabel = '❌ معطلة';

        var fuelLabel = '';
        if (fuel === 'full') fuelLabel = '✅ ممتلئ';
        else if (fuel === 'half') fuelLabel = '🟡 نصف';
        else if (fuel === 'low')  fuelLabel = '🔴 منخفض';

        var notesDisplay = notes || '-';

        centersHtml += '<tr>' +
            '<td style="border:1px solid #000;padding:5px;font-weight:bold;text-align:center;">' + centerList[idx] + '</td>' +
            '<td style="border:1px solid #000;padding:5px;text-align:center;">' + status + '</td>' +
            '<td style="border:1px solid #000;padding:5px;text-align:center;">' + (staff || '-') + '</td>' +
            '<td style="border:1px solid #000;padding:5px;text-align:center;">' + (cars || '-') + '</td>' +
            '<td style="border:1px solid #000;padding:5px;text-align:center;font-size:0.75rem;">' + (vehLabel || '-') + '</td>' +
            '<td style="border:1px solid #000;padding:5px;text-align:center;font-size:0.75rem;">' + (fuelLabel || '-') + '</td>' +
            '<td style="border:1px solid #000;padding:5px;font-size:0.75rem;">' + notesDisplay + '</td>' +
            '</tr>';
    }

    // 3. فرق التدخل السريع
    var rapidHtml = '';
    var rapidInputs = document.querySelectorAll('.rapid-location');
    for (var j = 0; j < rapidInputs.length; j++) {
        if (rapidInputs[j] && rapidInputs[j].value) {
            var unitName = rapidInputs[j].dataset.unit || ('سريع ' + (j+1));
            rapidHtml += '<tr>' +
                '<td style="border:1px solid #000;padding:5px;font-weight:bold;text-align:center;">' + unitName + '</td>' +
                '<td style="border:1px solid #000;padding:5px;text-align:center;">' + rapidInputs[j].value + '</td>' +
                '</tr>';
        }
    }

    // 4. الملاحظات العامة
    var genNotesEl = document.getElementById('generalNotes');
    var generalNotes = (genNotesEl && genNotesEl.value) ? genNotesEl.value : '';
    console.log('[PRINT] generalNotes length=' + generalNotes.length + ' value=' + generalNotes.substring(0, 50));

    // 5. سجل أحداث المناوبة
    var eventLogHtml = '';
    var eventContainer = document.getElementById('shiftEventLog');
    if (eventContainer && eventContainer.children && eventContainer.children.length > 0) {
        var items = eventContainer.querySelectorAll('.shift-event-item');
        for (var e = 0; e < items.length && e < 30; e++) {
            var timeSpan = items[e].querySelector('.shift-event-time');
            var textSpan = items[e].querySelector('.shift-event-text');
            eventLogHtml += '<tr>' +
                '<td style="border:1px solid #000;padding:4px;font-size:0.7rem;text-align:center;white-space:nowrap;">' + (timeSpan ? timeSpan.innerText : '') + '</td>' +
                '<td style="border:1px solid #000;padding:4px;font-size:0.75rem;">' + (textSpan ? textSpan.innerText : '') + '</td>' +
                '</tr>';
        }
    }

    // 6. الغياب والتأخير
    var absenceHtml = '';
    var absenceContainer = document.getElementById('absenceList');
    if (absenceContainer && absenceContainer.children && absenceContainer.children.length > 0) {
        var absItems = absenceContainer.querySelectorAll('.absence-item');
        for (var a = 0; a < absItems.length && a < 20; a++) {
            var badgeEl = absItems[a].querySelector('.type-badge');
            var nameStrong = absItems[a].querySelector('strong');
            var allSpans = absItems[a].querySelectorAll('span');
            var timeVal = '';
            for (var s = 0; s < allSpans.length; s++) {
                if (allSpans[s].style.fontFamily === 'monospace') { timeVal = allSpans[s].innerText; break; }
            }
            absenceHtml += '<tr>' +
                '<td style="border:1px solid #000;padding:4px;font-size:0.75rem;text-align:center;">' + (badgeEl ? badgeEl.innerText : '') + '</td>' +
                '<td style="border:1px solid #000;padding:4px;font-size:0.75rem;text-align:center;">' + (nameStrong ? nameStrong.innerText : '') + '</td>' +
                '<td style="border:1px solid #000;padding:4px;font-size:0.7rem;text-align:center;">' + timeVal + '</td>' +
                '</tr>';
        }
    }

    // 7. إجمالي البلاغات
    var totalReports = 0;
    for (var key in reports) { if (reports[key] && reports[key].count) totalReports += reports[key].count; }
    var totalCentersCount = (typeof centerList !== 'undefined' && centerList.length) ? centerList.length : 0;
    var readinessStr = totalCentersCount > 0 ? (readyCount + ' / ' + totalCentersCount) : '-';
    var readinessPercent = totalCentersCount > 0 ? Math.round((readyCount / totalCentersCount) * 100) + '%' : '0%';

    // 8. بناء صفحة الطباعة
    var cssRules = 'body{font-family:Arial,sans-serif;padding:15px 20px;direction:rtl;color:#000;font-size:10pt}' +
        '.header{text-align:center;border-bottom:3px solid #2563EB;padding-bottom:12px;margin-bottom:15px}' +
        '.header h1{margin:0;font-size:1.5rem;color:#1E293B}' +
        '.header .meta{color:#64748B;font-size:0.85rem;margin-top:4px}' +
        'table{width:100%;border-collapse:collapse;margin:8px 0;font-size:0.8rem}' +
        'th{background:#e8e8e8;border:1px solid #333;padding:5px;font-weight:bold;text-align:center}' +
        'td{border:1px solid #333;padding:5px}' +
        '.stats{display:flex;gap:10px;margin:12px 0;padding:10px;background:#f0f0f0;border-radius:4px;text-align:center}' +
        '.stat{flex:1}' +
        '.stat .num{font-size:1.3rem;font-weight:800;color:#2563EB;display:block}' +
        '.stat .label{font-size:0.65rem;color:#64748B}' +
        '.section-title{font-size:1rem;font-weight:700;color:#2563EB;margin:15px 0 6px;border-right:4px solid #2563EB;padding-right:8px}' +
        '.notes-box{border:1px solid #333;padding:8px;margin-top:8px;min-height:50px;font-size:0.8rem;background:#fafafa;white-space:pre-wrap}' +
        '.footer{margin-top:20px;text-align:center;font-size:0.7rem;color:#666;border-top:1px solid #ccc;padding-top:8px}' +
        '.empty-msg{color:#999;font-style:italic;text-align:center;padding:8px;font-size:0.75rem}' +
        '@media print{body{padding:0 .5cm}}';

    var printHtml = '<!DOCTYPE html><html dir="rtl"><head><meta charset="UTF-8"><title>تكميل النوبة - ' + escapeHtml(shiftType) + '</title>' +
        '<style>' + cssRules + '</style></head><body>' +
        '<div class="header"><h1>تكميل النوبة</h1><div class="meta">' + escapeHtml(shiftType) + ' | ' + escapeHtml(shiftDate) + ' | ' + getSaudiTime() + '</div></div>' +
        '<div class="stats">' +
        '<div class="stat"><span class="num">' + readinessStr + '</span><span class="label">جاهزية (' + readinessPercent + ')</span></div>' +
        '<div class="stat"><span class="num">' + totalStaff + '</span><span class="label">مسعفين</span></div>' +
        '<div class="stat"><span class="num">' + totalCars + '</span><span class="label">سيارات</span></div>' +
        '<div class="stat"><span class="num">' + totalReports + '</span><span class="label">بلاغات</span></div>' +
        '</div>';

    // المراكز الإسعافية
    printHtml += '<div class="section-title">المراكز الإسعافية (' + totalCentersCount + ' مركز)</div>' +
        '<table><thead><tr><th>المركز</th><th>الحالة</th><th>مسعفين</th><th>سيارات</th><th>مركبة</th><th>وقود</th><th>ملاحظات</th></tr></thead><tbody>';
    if (centersHtml) {
        printHtml += centersHtml;
    } else {
        printHtml += '<tr><td colspan="7" class="empty-msg">لا توجد بيانات - ابدأ تكميل المراكز</td></tr>';
    }
    printHtml += '</tbody></table>';

    // فرق التدخل السريع
    if (rapidHtml) {
        printHtml += '<div class="section-title">فرق التدخل السريع</div>' +
            '<table><thead><tr><th>الفرقة</th><th>التمركز</th></tr></thead><tbody>' + rapidHtml + '</tbody></table>';
    }

    // سجل الغياب والتأخير
    if (absenceHtml) {
        printHtml += '<div class="section-title">سجل الغياب والتأخير</div>' +
            '<table><thead><tr><th>النوع</th><th>الاسم</th><th>الوقت</th></tr></thead><tbody>' + absenceHtml + '</tbody></table>';
    }

    // سجل أحداث المناوبة
    if (eventLogHtml) {
        printHtml += '<div class="section-title">سجل أحداث المناوبة</div>' +
            '<table><thead><tr><th>الوقت</th><th>الحدث</th></tr></thead><tbody>' + eventLogHtml + '</tbody></table>';
    }

    // الملاحظات العامة
    if (generalNotes && generalNotes.trim()) {
        var notesForPrint = escapeHtml(generalNotes).replace(/\n/g, '<br>');
        printHtml += '<div class="section-title">الملاحظات العامة</div><div class="notes-box">' + notesForPrint + '</div>';
    }

    // توقيعات
    printHtml += '<div style="margin-top:40px;display:flex;justify-content:space-between;font-size:0.85rem;">' +
        '<div style="text-align:center;"><div style="border-top:1px solid #000;padding-top:8px;width:160px;font-weight:bold;">توقيع المسؤول</div></div>' +
        '<div style="text-align:center;"><div style="border-top:1px solid #000;padding-top:8px;width:160px;font-weight:bold;">توقيع المراجع</div></div>' +
        '</div>';

    printHtml += '<div class="footer">منصة الجنوب - قطاع جنوب الرياض | ' + getSaudiDate() + ' ' + getSaudiTime() + '</div>' +
        '</body></html>';

    // فتح وطباعة
    var win = window.open('', '_blank');
    if (!win) { showToast('⚠️ يرجى السماح بفتح النوافذ المنبثقة', 'warning'); return; }
    win.document.open();
    win.document.write(printHtml);
    win.document.close();
    setTimeout(function() { win.focus(); win.print(); }, 500);
}

// ============================================
// تصدير PDF (html2pdf.js)
// ============================================

function exportShiftPDF() {
    var shiftData = getShiftFromForm();
    var shiftTypeLabel = '';
    var radios = document.querySelectorAll('input[name="shiftType"]');
    for (var i = 0; i < radios.length; i++) {
        if (radios[i].checked) {
            shiftTypeLabel = radios[i].value;
            break;
        }
    }
    if (!shiftTypeLabel) {
        showNotification('تنبيه', 'الرجاء اختيار نوع المناوبة أولاً', 'warning', 3000);
        return;
    }

    var targetShift = null;
    var targetId = viewingShiftId || currentShiftId;
    if (targetId && allShifts) {
        for (var i = 0; i < allShifts.length; i++) {
            if (allShifts[i].id === targetId) {
                targetShift = allShifts[i];
                break;
            }
        }
    }

    var dateStr = document.getElementById('shiftDate').innerText || getSaudiDate();
    var dayOfWeek = getSaudiDay();

    var container = document.createElement('div');
    container.className = 'pdf-export-container';
    container.style.direction = 'rtl';
    container.style.position = 'absolute';
    container.style.left = '-9999px';
    document.body.appendChild(container);

    // Rapid teams rows
    var rapidRows = '';
    var rapidUnits = ['سريع 1', 'سريع 2', 'سريع 3', 'سريع 4'];
    for (var i = 0; i < rapidUnits.length; i++) {
        var loc = shiftData.rapidLocations[rapidUnits[i]] || '-';
        rapidRows += '<tr><td>' + rapidUnits[i] + '</td><td>' + loc + '</td></tr>';
    }

    // Centers rows
    var centersRows = '';
    var completeCount = 0;
    var incompleteCount = 0;
    for (var i = 0; i < centerList.length; i++) {
        var center = centerList[i];
        var cData = shiftData.centersData[center] || {};
        var staff = cData.staffCount || '-';
        var cars = cData.carsCount || '-';
        var notes = cData.notes || '-';
        var status = '-';
        if (notes.indexOf('✅') !== -1 || (staff && parseInt(staff) > 0)) {
            status = '✅ مكتمل';
            completeCount++;
        } else if (notes.indexOf('❌') !== -1 || notes.indexOf('بحاجة') !== -1) {
            status = '❌ ناقص';
            incompleteCount++;
        }
        centersRows += '<tr><td>' + center + '</td><td>' + status + '</td><td>' + staff + '</td><td>' + cars + '</td><td>' + notes + '</td></tr>';
    }

    // Workforce stats
    var totalStaff = 0;
    var totalCars = 0;
    for (var i = 0; i < centerList.length; i++) {
        var cData = shiftData.centersData[centerList[i]] || {};
        if (cData.staffCount) totalStaff += parseInt(cData.staffCount) || 0;
        if (cData.carsCount) totalCars += parseInt(cData.carsCount) || 0;
    }

    var shiftTypeDisplay = shiftTypeLabel;
    var shiftIcon = shiftTypeLabel === 'صباحية' ? '🌅' : '🌙';

    container.innerHTML =
        '<div class="pdf-header">' +
            '<h1>تقرير تكميل النوبة</h1>' +
            '<div class="subtitle">منصة الجنوب - إدارة العمليات الإسعافية</div>' +
            '<div class="date">' + dayOfWeek + ' ' + dateStr + ' | مناوبة ' + shiftIcon + ' ' + shiftTypeDisplay + '</div>' +
        '</div>' +
        '<div class="pdf-section">' +
            '<h3>معلومات المناوبة</h3>' +
            '<table class="pdf-table">' +
                '<tr><th>نوع المناوبة</th><th>التاريخ</th><th>المراكز المكتملة</th><th>المراكز الناقصة</th></tr>' +
                '<tr><td>' + shiftTypeDisplay + '</td><td>' + dateStr + '</td><td>' + completeCount + '</td><td>' + incompleteCount + '</td></tr>' +
            '</table>' +
        '</div>' +
        '<div class="pdf-section">' +
            '<h3>فرق التدخل السريع</h3>' +
            '<table class="pdf-table">' +
                '<tr><th>الفرقة</th><th>التمركز</th></tr>' +
                rapidRows +
            '</table>' +
        '</div>' +
        '<div class="pdf-section">' +
            '<h3>المراكز الإسعافية</h3>' +
            '<table class="pdf-table">' +
                '<tr><th>المركز</th><th>الحالة</th><th>المسعفين</th><th>السيارات</th><th>ملاحظات</th></tr>' +
                centersRows +
            '</table>' +
        '</div>' +
        '<div class="pdf-section">' +
            '<h3>إحصائيات القوى العاملة</h3>' +
            '<table class="pdf-table">' +
                '<tr><th>إجمالي المسعفين</th><th>إجمالي السيارات</th><th>المراكز المكتملة</th><th>المراكز الناقصة</th></tr>' +
                '<tr><td>' + totalStaff + '</td><td>' + totalCars + '</td><td>' + completeCount + '</td><td>' + incompleteCount + '</td></tr>' +
            '</table>' +
        '</div>' +
        (shiftData.generalNotes ?
        '<div class="pdf-section">' +
            '<h3>الملاحظات العامة</h3>' +
            '<div style="background:#f9f9f9; border:1px solid #ddd; padding:10px; border-radius:5px; font-size:0.8rem;">' + shiftData.generalNotes.replace(/\n/g, '<br>') + '</div>' +
        '</div>' : '') +
        '<div class="pdf-footer">' +
            '<div class="pdf-stamp">تم التصدير إلكترونياً</div>' +
            '<div style="margin-top:10px;">' + getSaudiDateTime() + '</div>' +
            '<div>منصة الجنوب - جميع الحقوق محفوظة</div>' +
        '</div>';

    var filename = 'تكميل_' + (shiftTypeLabel || 'نوبة') + '_' + dateStr.replace(/\//g, '-') + '.pdf';

    var opt = {
        margin: 10,
        filename: filename,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
    };

    showNotification('جاري التصدير', 'يتم إنشاء ملف PDF...', 'info', 2000);

    html2pdf().set(opt).from(container).save().then(function() {
        document.body.removeChild(container);
        showNotification('تم التصدير', 'تم تصدير التقرير بنجاح', 'success', 3000);
        addAuditEntry('file', 'تصدير PDF', 'تقرير تكميل ' + shiftTypeLabel, 'المشرف');
    }).catch(function(err) {
        document.body.removeChild(container);
        console.error(err);
        showNotification('خطأ', 'فشل في تصدير PDF', 'error', 3000);
    });
}

function exportAllShiftsPDF() {
    if (!allShifts || allShifts.length === 0) {
        showNotification('لا توجد مناوبات', 'لا توجد مناوبات للتصدير', 'warning', 3000);
        return;
    }

    var container = document.createElement('div');
    container.className = 'pdf-export-container';
    container.style.direction = 'rtl';
    container.style.position = 'absolute';
    container.style.left = '-9999px';
    document.body.appendChild(container);

    var shiftsHtml = '';
    for (var i = 0; i < allShifts.length; i++) {
        var shift = allShifts[i];
        var date = shift.shiftDate || getSaudiDate();
        var type = shift.shiftType || 'مناوبة';
        var total = shift.totalReports || 0;

        // Count centers from shift data
        var cComplete = 0;
        var cIncomplete = 0;
        if (shift.centersData) {
            for (var center in shift.centersData) {
                var cData = shift.centersData[center];
                if (cData && (cData.staffCount || (cData.notes && cData.notes.indexOf('✅') !== -1))) {
                    cComplete++;
                } else {
                    cIncomplete++;
                }
            }
        }

        shiftsHtml +=
            '<div style="page-break-inside:avoid; margin-bottom:20px;">' +
                '<h3 style="color:#2563EB; font-size:0.9rem;">' + type + ' - ' + date + '</h3>' +
                '<table class="pdf-table">' +
                    '<tr><th>المركز</th><th>المسعفين</th><th>السيارات</th><th>الملاحظات</th></tr>';

        if (shift.centersData) {
            for (var center in shift.centersData) {
                var cData = shift.centersData[center];
                shiftsHtml += '<tr><td>' + center + '</td><td>' + (cData.staffCount || '-') + '</td><td>' + (cData.carsCount || '-') + '</td><td>' + (cData.notes || '-') + '</td></tr>';
            }
        }

        shiftsHtml += '</table>' +
                '<div style="font-size:0.7rem; color:#64748B; margin-top:5px;">' +
                    'البلاغات: ' + total + ' | المراكز المكتملة: ' + cComplete + ' | الناقصة: ' + cIncomplete +
                '</div>' +
            '</div>';
    }

    container.innerHTML =
        '<div class="pdf-header">' +
            '<h1>جميع تقارير التكميل</h1>' +
            '<div class="subtitle">منصة الجنوب - إدارة العمليات الإسعافية</div>' +
            '<div class="date">' + getSaudiDate() + '</div>' +
        '</div>' + shiftsHtml +
        '<div class="pdf-footer"><div class="pdf-stamp">تم التصدير إلكترونياً</div></div>';

    var opt = {
        margin: 10,
        filename: 'جميع_التقارير_' + getSaudiDate() /* تاريخ الرياض لاسم الملف (كان UTC) */ + '.pdf',
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
    };

    showNotification('جاري التصدير', 'يتم إنشاء ملف PDF...', 'info', 3000);

    html2pdf().set(opt).from(container).save().then(function() {
        document.body.removeChild(container);
        showNotification('تم التصدير', 'تم تصدير جميع التقارير', 'success', 3000);
        addAuditEntry('file', 'تصدير PDF', 'جميع تقارير التكميل', 'المشرف');
    }).catch(function(err) {
        document.body.removeChild(container);
        console.error(err);
        showNotification('خطأ', 'فشل في تصدير PDF', 'error', 3000);
    });
}

// ============================================
// P1-S9: أُزيل نظام الإنجازات والتحفيز (Gamification) بالكامل — قرار المالك ADR-003 #1
// (المصفوفة، العدّادات، مفاتيح التخزين المحلي، دوال العرض ومساعداتها — بلا يتيم)
// ============================================

// ============================================
// Helper Functions
// ============================================


// ============================================
// ربط الأحداث الرئيسية
// ============================================
document.addEventListener('DOMContentLoaded', async function() {
    // ── ربط واجهة خالص (لا شبكة) — يبقى كما هو قبل المصادقة ──
    loadBrandLogo();
    initSoundSettings();
    var currentDateEl = document.getElementById("currentDate");
    if (currentDateEl) currentDateEl.innerText = getSaudiDate();
    buildCentersTable();
    setupAutoAuditLogging();
    // ── الإقلاع التشغيلي — خلف AuthGate فقط (لا يعمل قبل المصادقة) ──
    AuthGate.onStart(function() {
        connectSSE();
        loadShifts();
        loadAllData();
        loadNotifications();
        AuthGate.setTimeout(checkForAlerts, 1000);
    });
    // ربط أزرار toolbar بعد اكتمال DOM
    var btn = document.getElementById("newShiftBtn"); if (btn) btn.onclick = startNewShift;
    btn = document.getElementById("shiftBtn"); if (btn) btn.onclick = function() { location.href='radio-completion.html?v=34'; };
    btn = document.getElementById("closeShiftBtn"); if (btn) btn.onclick = function() { var el_shiftModal_d55 = document.getElementById('shiftModal'); if (el_shiftModal_d55) el_shiftModal_d55.style.display = 'none'; };
    btn = document.getElementById("monthlyTableBtn"); if (btn) btn.onclick = function() { var el_monthlyTableModal_d56 = document.getElementById('monthlyTableModal'); if (el_monthlyTableModal_d56) el_monthlyTableModal_d56.style.display = 'flex'; loadSavedTable(); };
    btn = document.getElementById("closeMonthlyTableBtn"); if (btn) btn.onclick = function() { var el_monthlyTableModal_d57 = document.getElementById('monthlyTableModal'); if (el_monthlyTableModal_d57) el_monthlyTableModal_d57.style.display = 'none'; };
    btn = document.getElementById("controlBtn"); if (btn) btn.onclick = function() { openModalById('controlModal'); loadVacations().then(function() { renderControlList(false); }); };
    btn = document.getElementById("closeControlBtn"); if (btn) btn.onclick = function() {
        closeModalById('controlModal');
        isEditMode = false;
        var el_saveVacationsBtn_d60 = document.getElementById('saveVacationsBtn'); if (el_saveVacationsBtn_d60) el_saveVacationsBtn_d60.style.display = 'none';
        var el_editVacationsBtn_d61 = document.getElementById('editVacationsBtn'); if (el_editVacationsBtn_d61) el_editVacationsBtn_d61.style.display = 'inline-block';
    };
    btn = document.getElementById("saveShiftBtn"); if (btn) btn.onclick = saveShiftData;
    btn = document.getElementById("deleteShiftBtn"); if (btn) btn.onclick = deleteCurrentShift;
    btn = document.getElementById("viewShiftBtn"); if (btn) btn.onclick = viewShiftReports;
    btn = document.getElementById("returnToCurrentBtn"); if (btn) btn.onclick = returnToCurrentShift;
});

// فحص التنبيهات كل 10 ثواني — عبر AuthGate (لا يعمل قبل المصادقة ويتوقف عند الخروج)
AuthGate.setInterval(checkForAlerts, 10000);

// ============================================
// تغيير الرقم السري
// ============================================
var el_changePasswordBtn=document.getElementById("changePasswordBtn");if(el_changePasswordBtn)el_changePasswordBtn.addEventListener('click', function() {
    openModalById('changePasswordModal');
});

var el_confirmChangePasswordBtn=document.getElementById("confirmChangePasswordBtn");if(el_confirmChangePasswordBtn)el_confirmChangePasswordBtn.addEventListener('click', async function() {
    var oldPassword = document.getElementById('oldPasswordInput').value;
    var newPassword = document.getElementById('newPasswordInput').value;
    var confirmNew = document.getElementById('confirmNewPasswordInput').value;

    if (!oldPassword || !newPassword || !confirmNew) {
        alert('⚠️ الرجاء ملء جميع الحقول');
        return;
    }

    if (newPassword !== confirmNew) {
        alert('❌ الرقم السري الجديد وتأكيده غير متطابقين');
        return;
    }

    if (newPassword.length < 4) {
        alert('❌ الرقم السري الجديد يجب أن يكون 4 أحرف على الأقل');
        return;
    }

    try {
        var response = await fetch('/api/change-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ oldPassword, newPassword })
        });
        var result = await response.json();
        if (result.success) {
            alert('✅ تم تغيير الرقم السري بنجاح');
            closeModalById('changePasswordModal');
            var el_oldPasswordInput_v26 = document.getElementById('oldPasswordInput'); if (el_oldPasswordInput_v26) el_oldPasswordInput_v26.value = '';
            var el_newPasswordInput_v27 = document.getElementById('newPasswordInput'); if (el_newPasswordInput_v27) el_newPasswordInput_v27.value = '';
            var el_confirmNewPasswordInput_v28 = document.getElementById('confirmNewPasswordInput'); if (el_confirmNewPasswordInput_v28) el_confirmNewPasswordInput_v28.value = '';
        } else {
            alert('❌ ' + (result.error || 'فشل في تغيير الرقم السري'));
        }
    } catch (error) {
        alert('❌ خطأ في الاتصال');
    }
});

var el_cancelChangePasswordBtn=document.getElementById("cancelChangePasswordBtn");if(el_cancelChangePasswordBtn)el_cancelChangePasswordBtn.addEventListener('click', function() {
    closeModalById('changePasswordModal');
    var el_oldPasswordInput_v29 = document.getElementById('oldPasswordInput'); if (el_oldPasswordInput_v29) el_oldPasswordInput_v29.value = '';
    var el_newPasswordInput_v30 = document.getElementById('newPasswordInput'); if (el_newPasswordInput_v30) el_newPasswordInput_v30.value = '';
    var el_confirmNewPasswordInput_v31 = document.getElementById('confirmNewPasswordInput'); if (el_confirmNewPasswordInput_v31) el_confirmNewPasswordInput_v31.value = '';
});

// ============================================
// F5b: حُذفت منظومة QR Codes بالكامل (قرار المالك) —
// كانت البطاقات تقود إلى GET /api/report?center&unit (مسار معدوم).
// CSS الخاص بالمودال في smart-toolbar.css يبقى موثقاً كدين مؤجل.
// ============================================

// ============================================
// P1-S6: آلية موحدة لفتح/إغلاق المودالات الحية
// الفتح = display:flex — الإغلاق = display:none (سلوك مطابق تماماً للسابق)
// ============================================
function openModalById(id) { var m = document.getElementById(id); if (m) m.style.display = 'flex'; }
function closeModalById(id) { var m = document.getElementById(id); if (m) m.style.display = 'none'; }

// إغلاق النوافذ بالضغط خارجها
// ============================================
window.onclick = function(e) {
    // P1-S6: المعرفات الحية فقط — أُسقطت المعدومة (shiftModal, monthlyTableModal, uploadDocsModal, docPreviewModal, themeModal) لأنها no-op أصلاً
    // P1-S9: أُسقط achievementsModal مع إزالة منظومة الجاميفيكيشن كاملة
    var modals = ['controlModal', 'passwordModal', 'changePasswordModal', 'seniorShiftModal', 'peakTimeModal', 'peakMapModal', 'distributionModal', 'mapModal', 'peakAlertModal', 'formsModal', 'operationsRoomModal', 'analyticsModal', 'chartsModal', 'hospitalModal'];
    modals.forEach(function(id) {
        if (e.target === document.getElementById(id)) { closeModalById(id); }
    });
};

// ============================================
// تحديث تلقائي كل 3 ثواني — عبر AuthGate (لا يعمل قبل المصادقة ويتوقف عند الخروج)
// ============================================
AuthGate.setInterval(function() {
    if (!isViewingArchiveShift) { 
        checkForUpdates(); 
        console.log('🔄 تحديث تلقائي للبيانات - ' + getSaudiTime());
    }
}, 3000);  // 3 ثواني

async function checkForUpdates() {
    if (isViewingArchiveShift) return;
    try {
        var response = await fetch('/api/last-update');
        var data = await response.json();
        if (data.lastUpdate > lastKnownUpdate) {
            lastKnownUpdate = data.lastUpdate;
            await loadAllData();
            calculateLiveReportStats();
            updateWorkforceStats();
            updateDistributionIndicator();
        }
    } catch (error) {}
}

console.log('✅ منصة الجنوب - الصفحة الرئيسية المتطورة');
console.log('📊 مؤشرات القوى العاملة تعكس بيانات التكميل');
console.log('🌐 نظام وقت الذروة يعمل على الخادم (Server-based)');
console.log('📍 تنبيهات وقت الذروة تظهر مع خريطة الموقع');
console.log('🗺️ معاينة الخريطة للفرق متاحة من نافذة التوزيع');
console.log('📋 النماذج الموحدة (الإسعاف الجوي، التصعيد، E، الحوادث، التقرير اليومي)');
// ============================================
// غرفة العمليات التشغيلية
// ============================================

var opsMetadata = [];

// التبديل بين التبويبات
function opsSwitchTab(tab) {
    // إخفاء كل المحتويات
    document.querySelectorAll('.ops-tab-content').forEach(function(el) {
        el.style.display = 'none';
    });
    // إظهار المحتوى المستهدف
    var target = document.getElementById('ops-' + tab);
    target.style.display = 'block';
    // إعادة تشغيل animation
    target.style.animation = 'none';
    void target.offsetWidth;
    target.style.animation = '';
    
    document.querySelectorAll('.ops-tab-btn').forEach(el => el.classList.remove('active'));
    document.querySelector('.ops-tab-btn[data-tab="' + tab + '"]').classList.add('active');
    
    if (tab === 'files') opsRenderFiles();
    if (tab === 'dashboard') opsLoadDashboard();
}

// تحميل البيانات
async function opsLoadData() {
    try {
        var res = await AuthManager.apiRequest('/api/operational-files');
        var data = await res.json();
        opsMetadata = data.files || [];
        return opsMetadata;
    } catch (e) {
        console.error('خطأ في تحميل البيانات:', e);
        return [];
    }
}

// عداد متحرك للأرقام
function opsCountUp(el, target, duration) {
    if (!el) return;
    var start = 0;
    var increment = target / (duration / 16);
    var current = 0;
    el.classList.add('counting');
    function step() {
        current += increment;
        if (current >= target) {
            el.textContent = target;
            el.classList.remove('counting');
            return;
        }
        el.textContent = Math.floor(current);
        requestAnimationFrame(step);
    }
    step();
}

// عرض لوحة القيادة
async function opsLoadDashboard() {
    var files = await opsLoadData();
    var totalEl = document.getElementById('opsStatTotal');
    var monthEl = document.getElementById('opsStatMonth');
    var lastEl = document.getElementById('opsStatLast');
    
    // Count up animations for numeric stats
    opsCountUp(totalEl, files.length, 800);
    
    var monthCount = files.filter(f => {
        var d = new Date(f.uploadDate);
        var now = new Date();
        return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    }).length;
    opsCountUp(monthEl, monthCount, 800);
    
    if (files.length > 0) {
        var last = new Date(files[0].uploadDate);
        lastEl.textContent = saudiFormatter.format(new Date(last)) + ' - ' + saudiTimeFormatter.format(new Date(last));
        lastEl.style.opacity = '0';
        lastEl.style.transform = 'translateY(8px)';
        lastEl.style.transition = 'all 0.4s ease';
        setTimeout(function() {
            lastEl.style.opacity = '1';
            lastEl.style.transform = 'translateY(0)';
        }, 50);
    }
    
    var recent = files.slice(0, 5);
    var container = document.getElementById('opsRecentList');
    container.innerHTML = recent.map(f => opsFileCardHTML(f)).join('');
}

// عرض الأرشيف
async function opsRenderFiles() {
    var files = await opsLoadData();
    var container = document.getElementById('opsFileList');
    container.innerHTML = files.map(f => opsFileCardHTML(f)).join('');
}

// بطاقة الملف
function opsFileCardHTML(file) {
    var icon = file.icon || '📄';
    var date = getSaudiDateTime();
    var badgeClass = file.category === 'عاجل' ? 'urgent' : '';
    return `
        <div class="ops-file-card">
            <div class="file-info">
                <span class="file-icon">${icon}</span>
                <div>
                    <div class="file-name">${file.filename}</div>
                    <div class="file-meta">${file.uploader || 'المشرف'} · ${date} ${file.note ? '· ' + file.note : ''}</div>
                </div>
            </div>
            <div style="display:flex; gap:6px; align-items:center;">
                <span class="file-badge ${badgeClass}">${file.category || 'عام'}</span>
                <button onclick="opsPreviewFile('${file.id}', '${file.filename}')" class="btn" style="background:rgba(0,212,255,0.1); color:#00D4FF; border:1px solid rgba(0,212,255,0.1); padding:4px 10px; font-size:0.6rem;" title="عرض الملف">
                    <i class="fas fa-eye"></i>
                </button>
                <button onclick="opsDownloadFile('${file.id}')" class="btn" style="background:rgba(255,255,255,0.05); color:rgba(255,255,255,0.6); border:1px solid rgba(255,255,255,0.05); padding:4px 10px; font-size:0.6rem;" title="تحميل الملف">
                    <i class="fas fa-download"></i>
                </button>
                <button onclick="opsDeleteFile('${file.id}')" class="btn" style="background:rgba(255,0,0,0.05); color:rgba(255,100,100,0.6); border:1px solid rgba(255,0,0,0.05); padding:4px 10px; font-size:0.6rem;" title="حذف الملف">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
        </div>
    `;
}

// متغير global لمنع رفع مكرر
var opsIsUploading = false;

// عرض مسبق للملفات المختارة
function opsPreviewSelectedFiles() {
    var input = document.getElementById('opsFileInput');
    var previewContainer = document.getElementById('opsFilePreview');
    if (!input.files || input.files.length === 0) {
        if (previewContainer) {
            previewContainer.innerHTML = '';
            previewContainer.style.display = 'none';
        }
        return;
    }
    if (!previewContainer) return;
    var icons = { image: '🖼️', video: '🎬', audio: '🎵', pdf: '📄', doc: '📄', default: '📄' };
    var previewHTML = '<div style="margin:10px 0; padding:10px; background:rgba(0,212,170,0.06); border-radius:8px; border:1px solid rgba(0,212,170,0.2);"><div style="font-size:0.78rem; color:#00D4AA; margin-bottom:8px; font-weight:600;">📋 الملفات المختارة (' + input.files.length + '):</div>';
    for (var i = 0; i < input.files.length; i++) {
        var f = input.files[i];
        var typeKey = f.type.split('/')[0];
        var icon = icons[typeKey] || icons.default;
        var sizeKB = (f.size / 1024).toFixed(1);
        var sizeText = sizeKB > 1024 ? (sizeKB / 1024).toFixed(2) + ' MB' : sizeKB + ' KB';
        previewHTML += '<div style="display:flex; align-items:center; gap:8px; padding:4px 0; font-size:0.72rem; color:rgba(255,255,255,0.88); border-bottom:1px solid rgba(255,255,255,0.05);"><span style="font-size:1rem;">' + icon + '</span><span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + f.name + '</span><span style="color:rgba(255,255,255,0.45); font-size:0.65rem;">' + sizeText + '</span></div>';
    }
    previewHTML += '</div>';
    previewContainer.innerHTML = previewHTML;
    previewContainer.style.display = 'block';
}

// رفع الملفات
async function opsUploadFiles() {
    if (opsIsUploading) {
        console.log('⏳ عملية رفع جارية بالفعل');
        return;
    }

    var input = document.getElementById('opsFileInput');
    var category = document.getElementById('opsCategorySelect').value;
    var note = document.getElementById('opsFileNote').value.trim();

    if (!input.files || input.files.length === 0) {
        alert('⚠️ الرجاء اختيار ملف أولاً');
        return;
    }

    opsIsUploading = true;

    var formData = new FormData();
    for (var i = 0; i < input.files.length; i++) {
        formData.append('files', input.files[i]);
    }
    formData.append('category', category);
    formData.append('note', note);
    formData.append('uploader', 'المشرف');
    if (currentShiftId) formData.append('shiftId', String(currentShiftId));

    var progressBar = document.getElementById('opsUploadProgress');
    var progressDiv = progressBar.querySelector('div');
    var statusEl = document.getElementById('opsUploadStatus');

    progressBar.style.display = 'block';
    progressDiv.style.width = '0%';
    progressDiv.style.transition = 'width 0.3s ease';
    statusEl.innerHTML = '<span style="color:rgba(255,255,255,0.95); font-size:0.85rem;">⏳ جاري الرفع...</span>';

    try {
        var progress = 0;
        var progressInterval = setInterval(function() {
            progress += Math.random() * 15;
            if (progress > 90) progress = 90;
            progressDiv.style.width = progress + '%';
        }, 300);

        var res = await fetch('/api/upload-operational', {
            method: 'POST',
            body: formData
        });

        clearInterval(progressInterval);
        progressDiv.style.width = '100%';

        var result = await res.json();

        setTimeout(function() {
            progressBar.style.display = 'none';
        }, 600);

        if (result.success) {
            statusEl.innerHTML = '<span style="color:#00D4AA; font-weight:700; font-size:0.9rem; text-shadow:0 0 10px rgba(0,212,170,0.3);">✅ تم رفع ' + result.count + ' ملف/ملفات بنجاح</span>';
            input.value = '';
            var el_opsFileNote_v32 = document.getElementById('opsFileNote'); if (el_opsFileNote_v32) el_opsFileNote_v32.value = '';
            var previewContainer = document.getElementById('opsFilePreview');
            if (previewContainer) {
                previewContainer.innerHTML = '';
                previewContainer.style.display = 'none';
            }
            await opsLoadData();
            opsRenderFiles();
            opsLoadDashboard();
        } else {
            statusEl.innerHTML = '<span style="color:#FF6B6B; font-weight:600; font-size:0.85rem;">❌ فشل في الرفع: ' + (result.error || 'خطأ غير معروف') + '</span>';
        }
    } catch (e) {
        progressBar.style.display = 'none';
        statusEl.innerHTML = '<span style="color:#FF6B6B; font-weight:600; font-size:0.85rem;">❌ خطأ في الاتصال بالخادم</span>';
        console.error('❌ خطأ في الرفع:', e);
    } finally {
        opsIsUploading = false;
    }
}

// تحميل ملف
function opsDownloadFile(id) {
    window.open(`/api/download-operational/${id}`, '_blank');
}

// حذف ملف
async function opsDeleteFile(id) {
    if (!confirm('⚠️ هل أنت متأكد من حذف هذا الملف؟')) return;
    try {
        var res = await fetch(`/api/delete-operational/${id}`, { method: 'DELETE' });
        var result = await res.json();
        if (result.success) {
            await opsLoadData();
            opsRenderFiles();
            opsLoadDashboard();
        }
    } catch (e) {
        alert('❌ فشل في الحذف');
    }
}

// ============================================
// نظام معاينة الملفات
// ============================================
var opsPreviewBlobUrl = null;

function opsClosePreview() {
    var modal = document.getElementById('opsPreviewModal');
    if (modal) modal.classList.remove('active');
    if (opsPreviewBlobUrl) {
        URL.revokeObjectURL(opsPreviewBlobUrl);
        opsPreviewBlobUrl = null;
    }
}

function opsCopyPreviewText() {
    var pre = document.getElementById('opsPreviewText');
    if (!pre) return;
    var text = pre.textContent;
    var textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
        document.execCommand('copy');
        var btn = document.getElementById('opsCopyTextBtn');
        if (btn) {
            var original = btn.innerHTML;
            btn.innerHTML = '<i class="fas fa-check"></i> تم النسخ';
            btn.style.background = 'rgba(0,255,0,0.15)';
            btn.style.color = '#00FF00';
            setTimeout(function() {
                btn.innerHTML = original;
                btn.style.background = 'rgba(0,212,255,0.15)';
                btn.style.color = '#00D4FF';
            }, 2000);
        }
    } catch (e) {
        alert('❌ فشل في النسخ');
    }
    document.body.removeChild(textarea);
}

function opsGetFileExtension(filename) {
    if (!filename) return '';
    var parts = filename.split('.');
    if (parts.length < 2) return '';
    return parts.pop().toLowerCase();
}

function opsFormatFileSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    var k = 1024;
    var sizes = ['B', 'KB', 'MB', 'GB'];
    var i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

async function opsPreviewFile(id, filename) {
    var modal = document.getElementById('opsPreviewModal');
    var body = document.getElementById('opsPreviewBody');
    var nameEl = document.getElementById('opsPreviewName');
    var sizeEl = document.getElementById('opsPreviewSize');

    if (!modal || !body) return;

    // إغلاق أي معاينة سابقة
    if (opsPreviewBlobUrl) {
        URL.revokeObjectURL(opsPreviewBlobUrl);
        opsPreviewBlobUrl = null;
    }

    // عرض النافذة مع حالة التحميل
    nameEl.textContent = filename || '-';
    sizeEl.textContent = 'جاري التحميل...';
    body.innerHTML = '<div class="loading-preview"><i class="fas fa-spinner fa-spin"></i><div>جاري تحميل الملف...</div></div>';
    modal.classList.add('active');

    var ext = opsGetFileExtension(filename);

    // أنواع الملفات المدعومة مباشرة
    var imageTypes = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'bmp', 'webp', 'ico'];
    var videoTypes = ['mp4', 'webm', 'ogg', 'ogv'];
    var audioTypes = ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac'];
    var textTypes = ['txt', 'json', 'csv', 'js', 'html', 'css', 'xml', 'md', 'log', 'sql', 'py', 'java', 'cpp', 'c', 'h', 'php', 'rb', 'go', 'rs', 'ts', 'jsx', 'tsx', 'yaml', 'yml'];
    var pdfTypes = ['pdf'];
    var officeTypes = ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'];

    try {
        var response = await fetch('/api/download-operational/' + id);

        if (!response.ok) {
            body.innerHTML = '<div class="unsupported-preview"><i class="fas fa-exclamation-circle"></i><div class="msg">❌ تعذر تحميل الملف</div></div>';
            sizeEl.textContent = '';
            return;
        }

        var blob = await response.blob();
        var contentLength = blob.size;
        sizeEl.textContent = opsFormatFileSize(contentLength);

        // معالجة حسب نوع الملف
        if (imageTypes.indexOf(ext) !== -1) {
            // صور
            opsPreviewBlobUrl = URL.createObjectURL(blob);
            body.innerHTML = '<img src="' + opsPreviewBlobUrl + '" alt="' + (filename || '') + '" style="max-width:100%; max-height:75vh; border-radius:8px; display:block; margin:0 auto;">';

        } else if (videoTypes.indexOf(ext) !== -1) {
            // فيديو
            opsPreviewBlobUrl = URL.createObjectURL(blob);
            body.innerHTML = '<video controls autoplay style="max-width:100%; max-height:75vh; border-radius:8px; display:block; margin:0 auto;"><source src="' + opsPreviewBlobUrl + '" type="' + (blob.type || 'video/mp4') + '">متصفحك لا يدعم تشغيل الفيديو</video>';

        } else if (pdfTypes.indexOf(ext) !== -1) {
            // PDF
            opsPreviewBlobUrl = URL.createObjectURL(blob);
            body.innerHTML = '<iframe src="' + opsPreviewBlobUrl + '" style="width:100%; height:75vh; border:none; border-radius:8px; background:white;"></iframe>';

        } else if (audioTypes.indexOf(ext) !== -1) {
            // صوت
            opsPreviewBlobUrl = URL.createObjectURL(blob);
            body.innerHTML = '<div class="audio-preview"><i class="fas fa-music"></i><div class="audio-name">' + (filename || '') + '</div><audio controls><source src="' + opsPreviewBlobUrl + '" type="' + (blob.type || 'audio/mpeg') + '">متصفحك لا يدعم تشغيل الصوت</audio></div>';

        } else if (textTypes.indexOf(ext) !== -1) {
            // ملفات نصية
            var text = '';
            try {
                text = await blob.text();
            } catch (e) {
                text = '❌ تعذر قراءة محتوى الملف';
            }
            // تجهيز النص للعرض
            var escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            body.innerHTML = '<div style="display:flex; justify-content:flex-end; margin-bottom:8px;"><button id="opsCopyTextBtn" onclick="opsCopyPreviewText()" class="btn" style="background:rgba(0,212,255,0.15); color:#00D4FF; border:1px solid rgba(0,212,255,0.15); padding:6px 16px; font-size:0.75rem;"><i class="fas fa-copy"></i> نسخ الكل</button></div><pre class="text-preview" id="opsPreviewText">' + escaped + '</pre>';

        } else if (officeTypes.indexOf(ext) !== -1) {
            // ملفات Office
            body.innerHTML = '<div class="unsupported-preview"><i class="fas fa-file-word"></i><div class="msg">📄 ملف Office - غير قابل للمعاينة المباشرة</div><a href="/api/download-operational/' + id + '" target="_blank" class="btn" style="background:rgba(0,212,255,0.15); color:#00D4FF; border:1px solid rgba(0,212,255,0.15); padding:10px 24px; text-decoration:none; display:inline-block; margin-top:10px;"><i class="fas fa-download"></i> تحميل الملف</a></div>';

        } else {
            // غير معروف
            body.innerHTML = '<div class="unsupported-preview"><i class="fas fa-file"></i><div class="msg">❓ الملف غير قابل للمعاينة</div><a href="/api/download-operational/' + id + '" target="_blank" class="btn" style="background:rgba(0,212,255,0.15); color:#00D4FF; border:1px solid rgba(0,212,255,0.15); padding:10px 24px; text-decoration:none; display:inline-block; margin-top:10px;"><i class="fas fa-download"></i> تحميل الملف</a></div>';
        }

    } catch (e) {
        console.error('خطأ في المعاينة:', e);
        body.innerHTML = '<div class="unsupported-preview"><i class="fas fa-exclamation-circle"></i><div class="msg">❌ خطأ في تحميل الملف</div></div>';
        sizeEl.textContent = '';
    }
}

// البحث
function opsSearchFiles() {
    var term = document.getElementById('opsSearchInput').value.toLowerCase();
    var category = document.getElementById('opsFilterCategory').value;
    var container = document.getElementById('opsFileList');
    
    var filtered = opsMetadata;
    if (term) filtered = filtered.filter(f => f.filename.toLowerCase().includes(term) || (f.note || '').toLowerCase().includes(term));
    if (category !== 'all') filtered = filtered.filter(f => f.category === category);
    
    container.innerHTML = filtered.map(f => opsFileCardHTML(f)).join('');
}

// سحب وإفلات
document.addEventListener('DOMContentLoaded', function() {
    var dropZone = document.getElementById('opsDropZone');
    if (dropZone) {
        dropZone.addEventListener('dragover', function(e) {
            e.preventDefault();
            this.classList.add('dragover');
        });
        dropZone.addEventListener('dragleave', function(e) {
            e.preventDefault();
            this.classList.remove('dragover');
        });
        dropZone.addEventListener('drop', function(e) {
            e.preventDefault();
            this.classList.remove('dragover');
            var files = e.dataTransfer.files;
            var input = document.getElementById('opsFileInput');
            var dt = new DataTransfer();
            for (var f of files) dt.items.add(f);
            input.files = dt.files;
            opsPreviewSelectedFiles();
        });
        dropZone.addEventListener('click', function() {
            document.getElementById('opsFileInput').click();
        });
        // مستمع تغيير الملفات - عرض مسبق
        var opsFileInputEl = document.getElementById('opsFileInput');
        if (opsFileInputEl) {
            opsFileInputEl.addEventListener('change', opsPreviewSelectedFiles);
        }
    }
});

// إغلاق الغرفة مع إزالة active class
function opsCloseModal() {
    var modal = document.getElementById('operationsRoomModal');
    modal.classList.remove('active');
    modal.style.display = 'none';
}

console.log('✅ غرفة العمليات التشغيلية جاهزة');
// ============================================
// رفع الثيمات إلى السيرفر (لجميع المستخدمين)
// ============================================

async function uploadTheme() {
    var fileInput = document.getElementById('headerBgFile');
    var file = fileInput.files[0];
    
    if (!file) {
        alert('⚠️ الرجاء اختيار ملف أولاً');
        return;
    }
    
    // التحقق من نوع الملف
    var validTypes = ['image/gif', 'image/png', 'image/jpeg', 'image/jpg', 'video/mp4', 'video/webm'];
    if (!validTypes.includes(file.type)) {
        alert('⚠️ نوع الملف غير مدعوم. يرجى اختيار صورة أو فيديو.');
        return;
    }
    
    var formData = new FormData();
    formData.append('file', file);
    formData.append('type', 'background');
    
    try {
        var response = await fetch('/api/upload-theme', {
            method: 'POST',
            body: formData
        });
        var result = await response.json();
        
        if (result.success) {
            alert('✅ تم رفع الثيم بنجاح لجميع المستخدمين');
            // حفظ في localStorage كاحتياطي
            var reader = new FileReader();
            reader.onload = function(ev) {
                var dataUrl = ev.target.result;
                localStorage.setItem('headerBackground', dataUrl);
                localStorage.setItem('headerBgType', file.type);
            };
            reader.readAsDataURL(file);
            await applyGlobalTheme();
            fileInput.value = '';
            // تحديث المعاينة
            var previewDiv = document.getElementById('headerBgPreview');
            if (previewDiv) {
                previewDiv.style.display = 'block';
                if (file.type.startsWith('video/')) {
                    var video = document.getElementById('headerBgPreviewVideo');
                    var img = document.getElementById('headerBgPreviewImg');
                    if (video) {
                        img.style.display = 'none';
                        video.style.display = 'block';
                        video.src = URL.createObjectURL(file);
                        video.load();
                    }
                } else {
                    var img = document.getElementById('headerBgPreviewImg');
                    var video = document.getElementById('headerBgPreviewVideo');
                    if (img) {
                        video.style.display = 'none';
                        img.style.display = 'block';
                        img.src = URL.createObjectURL(file);
                    }
                }
            }
        } else {
            alert('❌ فشل في رفع الثيم: ' + (result.error || 'خطأ غير معروف'));
        }
    } catch (error) {
        console.error('❌ خطأ في الاتصال:', error);
        alert('❌ خطأ في الاتصال بالسيرفر');
    }
}

// ============================================
// تطبيق الثيم من السيرفر
// ============================================
async function applyGlobalTheme() {
    try {
        var response = await AuthManager.apiRequest('/api/theme-settings');
        var data = await response.json();
        
        if (data.fileName) {
            var header = document.getElementById('mainHeader');
            
            // إزالة أي فيديو قديم
            var oldVideo = header.querySelector('.header-bg-video');
            if (oldVideo) oldVideo.remove();
            
            // إزالة أي خلفية سابقة
            header.style.backgroundImage = '';
            header.style.background = '';
            
            if (data.fileType && data.fileType.startsWith('video/')) {
                // فيديو
                header.style.backgroundImage = 'none';
                header.style.backgroundColor = '#1E293B';
                
                var video = document.createElement('video');
                video.className = 'header-bg-video';
                video.src = '/uploads/' + data.fileName;
                video.autoplay = true;
                video.loop = true;
                video.muted = true;
                video.playsInline = true;
                video.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: cover; z-index: 0; opacity: 0.4;';
                header.prepend(video);
                video.load();
                video.play().catch(function() {});
                header.classList.remove('has-bg-image');
            } else {
                // صورة
                header.style.backgroundImage = "url('/uploads/" + data.fileName + "')";
                header.style.backgroundSize = 'cover';
                header.style.backgroundPosition = 'center';
                header.style.backgroundRepeat = 'no-repeat';
                header.classList.add('has-bg-image');
            }
        }
        
        // تطبيق الشعار
        if (data.logoFileName) {
            var logoImg = document.getElementById('brandLogoImage');
            if (logoImg) {
                logoImg.src = '/uploads/' + data.logoFileName;
                logoImg.style.display = 'block';
                var svg = document.getElementById('defaultLogo');
                if (svg) svg.style.display = 'none';
            }
        }
    } catch (error) {
        console.error('خطأ في تطبيق الثيم:', error);
    }
}

// ============================================
// إزالة الثيم العام
// ============================================
async function removeGlobalTheme() {
    if (!confirm('⚠️ هل أنت متأكد من إزالة الثيم العام؟')) return;
    
    try {
        var response = await AuthManager.apiRequest('/api/remove-theme', { method: 'DELETE' });
        var result = await response.json();
        if (result.success) {
            alert('✅ تم إزالة الثيم العام');
            // إعادة الخلفية الافتراضية
            var header = document.getElementById('mainHeader');
            header.style.backgroundImage = '';
            header.style.background = '';
            header.style.backgroundColor = '';
            header.classList.remove('has-bg-image');
            var video = header.querySelector('.header-bg-video');
            if (video) video.remove();
            // إخفاء المعاينة
            var el_headerBgPreview_d66 = document.getElementById('headerBgPreview'); if (el_headerBgPreview_d66) el_headerBgPreview_d66.style.display = 'none';
            // حذف من localStorage أيضاً
            localStorage.removeItem('headerBackground');
            localStorage.removeItem('headerBgType');
        }
    } catch (error) {
        alert('❌ خطأ في الاتصال');
    }
}

// ============================================
// رفع شعار القطاع
// ============================================
async function uploadSectorLogo() {
    var fileInput = document.getElementById('sectorLogoFile');
    var file = fileInput.files[0];
    
    if (!file) {
        alert('⚠️ الرجاء اختيار شعار أولاً');
        return;
    }
    
    var validTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/svg+xml'];
    if (!validTypes.includes(file.type)) {
        alert('⚠️ نوع الملف غير مدعوم. يرجى اختيار صورة PNG أو JPG أو SVG.');
        return;
    }
    
    var formData = new FormData();
    formData.append('file', file);
    formData.append('type', 'logo');
    
    try {
        var response = await fetch('/api/upload-theme', {
            method: 'POST',
            body: formData
        });
        var result = await response.json();
        
        if (result.success) {
            alert('✅ تم رفع الشعار بنجاح لجميع المستخدمين');
            // حفظ في localStorage كاحتياطي
            var reader = new FileReader();
            reader.onload = function(ev) {
                var dataUrl = ev.target.result;
                localStorage.setItem('sectorLogo', dataUrl);
                applySectorLogo(dataUrl);
            };
            reader.readAsDataURL(file);
            fileInput.value = '';
            // تحديث المعاينة
            var previewDiv = document.getElementById('sectorLogoPreview');
            if (previewDiv) {
                previewDiv.style.display = 'block';
                var logoImg = document.getElementById('sectorLogoPreviewImg');
                if (logoImg) {
                    logoImg.src = URL.createObjectURL(file);
                }
            }
            // تحديث الشعار في الهيدر مباشرة
            setTimeout(async function() {
                await applyGlobalTheme();
            }, 500);
        } else {
            alert('❌ فشل في رفع الشعار: ' + (result.error || 'خطأ غير معروف'));
        }
    } catch (error) {
        console.error('❌ خطأ في الاتصال:', error);
        alert('❌ خطأ في الاتصال بالسيرفر');
    }
}


// ============================================
// الرسوم البيانية (Charts)
// ============================================
var chartInstances = {};

var el_chartsBtn=document.getElementById("chartsBtn");if(el_chartsBtn)el_chartsBtn.addEventListener('click', function() {
    openModalById('chartsModal');
    setTimeout(renderAllCharts, 300);
});

function renderAllCharts() {
    renderHourlyChart();
    renderCenterChart();
    renderTopUnitsChart();
    renderWeeklyChart();
    renderChartsSummary();
}

function renderHourlyChart() {
    var ctx = document.getElementById('hourlyChart');
    if (!ctx) return;

    var hours = [];
    var data = [];
    // F5b: بيانات حقيقية من مرآة بلاغات المناوبة الجارية (reports[key].times — نفس تجميع getPeakHour)
    var hourCounts = {};
    for (var key in reports) {
        var r = reports[key];
        if (r && r.times) {
            for (var j = 0; j < r.times.length; j++) {
                // ساعة الرياض (كانت getHours بمنطقة الجهاز)
                var hp = TimeRiyadh.riyadhParts(r.times[j]);
                var hh = hp ? parseInt(hp.hour, 10) : NaN;
                if (!isNaN(hh)) hourCounts[hh] = (hourCounts[hh] || 0) + 1;
            }
        }
    }
    for (var i = 0; i < 24; i++) {
        hours.push(i + ':00');
        data.push(hourCounts[i] || 0);
    }

    if (chartInstances.hourly) chartInstances.hourly.destroy();

    chartInstances.hourly = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: hours,
            datasets: [{
                label: 'عدد البلاغات',
                data: data,
                backgroundColor: 'rgba(16, 181, 134, 0.55)',
                borderColor: '#10B586',
                borderWidth: 1,
                borderRadius: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: { backgroundColor: '#101B30', titleColor: '#F1F5F9', bodyColor: '#A9BACD', borderColor: 'rgba(255,255,255,0.08)', borderWidth: 1 }
            },
            scales: {
                y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.06)' }, ticks: { color: '#A9BACD' } },
                x: { grid: { display: false }, ticks: { color: '#A9BACD' } }
            }
        }
    });
}

function renderCenterChart() {
    var ctx = document.getElementById('centerChart');
    if (!ctx) return;

    var centerNames = [];
    var centerData = [];
    var colors = ['#60A5FA', '#10B586', '#F59E0B', '#EF4444', '#C4B5FD', '#67E8F9', '#93C5FD', '#4FBF9A', '#FCD34D', '#FCA5A5'];

    for (var center in centersData) {
        centerNames.push(center);
        var total = 0;
        for (var i = 0; i < centersData[center].length; i++) {
            var unit = centersData[center][i];
            var key = center + '|' + unit;
            total += (reports[key] && reports[key].count) || 0;
        }
        centerData.push(total);
    }
    
    if (chartInstances.center) chartInstances.center.destroy();
    
    chartInstances.center = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: centerNames,
            datasets: [{
                data: centerData,
                backgroundColor: colors,
                borderWidth: 2,
                borderColor: '#101B30'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'right', labels: { font: { size: 10 }, boxWidth: 12, color: '#A9BACD' } },
                tooltip: { backgroundColor: '#101B30', titleColor: '#F1F5F9', bodyColor: '#A9BACD', borderColor: 'rgba(255,255,255,0.08)', borderWidth: 1 }
            }
        }
    });
}

function renderTopUnitsChart() {
    var ctx = document.getElementById('topUnitsChart');
    if (!ctx) return;
    
    var unitStats = [];
    for (var key in reports) {
        if (reports[key] && reports[key].count > 0) {
            var parts = key.split('|');
            unitStats.push({ unit: parts[1] || key, count: reports[key].count });
        }
    }
    unitStats.sort(function(a, b) { return b.count - a.count; });
    unitStats = unitStats.slice(0, 10);
    
    var labels = unitStats.map(function(u) { return u.unit; });
    var data = unitStats.map(function(u) { return u.count; });
    
    if (chartInstances.topUnits) chartInstances.topUnits.destroy();
    
    chartInstances.topUnits = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'البلاغات',
                data: data,
                backgroundColor: 'rgba(239, 68, 68, 0.50)',
                borderColor: '#EF4444',
                borderWidth: 1,
                borderRadius: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            indexAxis: 'y',
            plugins: { legend: { display: false }, tooltip: { backgroundColor: '#101B30', titleColor: '#F1F5F9', bodyColor: '#A9BACD', borderColor: 'rgba(255,255,255,0.08)', borderWidth: 1 } },
            scales: {
                x: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.06)' }, ticks: { color: '#A9BACD' } },
                y: { grid: { display: false }, ticks: { color: '#A9BACD' } }
            }
        }
    });
}

function renderWeeklyChart() {
    var ctx = document.getElementById('weeklyChart');
    if (!ctx) return;

    var days = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

    // F5b: بيانات حقيقية من حزمة المؤشرات (/api/indicators/dashboard — dailySeries آخر 30 يوماً)
    // مجمّعة حسب اليوم-من-الأسبوع (getDay: 0=الأحد .. 6=السبت). عند فشل الجلب: لا رسم إطلاقاً (لا خط صفري مضلل).
    if (!AuthManager.isLoggedIn()) return;
    AuthManager.apiRequest('/api/indicators/dashboard')
    .then(function(res) { return res.json(); })
    .then(function(bundle) {
        var data = [0, 0, 0, 0, 0, 0, 0];
        var series = (bundle && bundle.dailySeries) || {};
        var labels = series.labels || [];
        var values = series.values || [];
        for (var i = 0; i < labels.length; i++) {
            // labels نصوص YYYY-MM-DD (تواريخ الرياض من الخادم) — اليوم-من-الأسبوع
            // بحساب UTC صريح (كان getDay بمنطقة الجهاز فيزيح التجميع يومًا كاملًا)
            var d = new Date(labels[i] + 'T00:00:00Z');
            if (isNaN(d)) continue;
            data[d.getUTCDay()] += values[i] || 0;
        }

        if (chartInstances.weekly) chartInstances.weekly.destroy();

        chartInstances.weekly = new Chart(ctx, {
            type: 'line',
            data: {
                labels: days,
                datasets: [{
                    label: 'إجمالي البلاغات',
                    data: data,
                    borderColor: '#F59E0B',
                    backgroundColor: 'rgba(245, 158, 11, 0.12)',
                    borderWidth: 3,
                    fill: true,
                    tension: 0.4,
                    pointBackgroundColor: '#F59E0B',
                    pointRadius: 5
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false }, tooltip: { backgroundColor: '#101B30', titleColor: '#F1F5F9', bodyColor: '#A9BACD', borderColor: 'rgba(255,255,255,0.08)', borderWidth: 1 } },
                scales: {
                    y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.06)' }, ticks: { color: '#A9BACD' } },
                    x: { grid: { display: false }, ticks: { color: '#A9BACD' } }
                }
            }
        });
    })
    .catch(function(e) { console.warn('[renderWeeklyChart] تعذر جلب حزمة المؤشرات:', e); });
}

function renderChartsSummary() {
    var container = document.getElementById('chartsSummary');
    if (!container) return;
    
    var total = 0;
    for (var key in reports) {
        total += (reports[key] && reports[key].count) || 0;
    }
    
    var topUnit = '-';
    var topCount = 0;
    for (var key2 in reports) {
        if (reports[key2] && reports[key2].count > topCount) {
            topCount = reports[key2].count;
            topUnit = key2.split('|')[1] || key2;
        }
    }
    
    var activeCenters = 0;
    for (var center in centersData) {
        if (centersData[center].length > 0) activeCenters++;
    }
    
    container.innerHTML = 
        '<div class="charts-summary-card"><div class="icon cs-icon-blue"><i class="fas fa-chart-bar"></i></div><div class="info"><div class="value">' + total + '</div><div class="label">إجمالي البلاغات</div></div></div>' +
        '<div class="charts-summary-card"><div class="icon cs-icon-gold"><i class="fas fa-trophy"></i></div><div class="info"><div class="value">' + topUnit + '</div><div class="label">الأكثر نشاطاً</div></div></div>' +
        '<div class="charts-summary-card"><div class="icon cs-icon-teal"><i class="fas fa-hashtag"></i></div><div class="info"><div class="value">' + topCount + '</div><div class="label">بلاغات ' + topUnit + '</div></div></div>' +
        '<div class="charts-summary-card"><div class="icon cs-icon-coral"><i class="fas fa-hospital"></i></div><div class="info"><div class="value">' + activeCenters + '</div><div class="label">مراكز نشطة</div></div></div>';
}

function exportChartData() {
    var data = [];
    for (var key in reports) {
        var parts = key.split('|');
        data.push({ center: parts[0], unit: parts[1], count: (reports[key] && reports[key].count) || 0 });
    }
    
    var csv = 'المركز,الوحدة,عدد البلاغات\n';
    for (var i = 0; i < data.length; i++) {
        csv += (data[i].center || '') + ',' + (data[i].unit || '') + ',' + (data[i].count || 0) + '\n';
    }
    
    var blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    var link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'بلاغات_' + getSaudiDate() /* تاريخ الرياض لاسم الملف (كان UTC) */ + '.csv';
    link.click();
    
    showNotification('تم التصدير', 'تم تصدير بيانات البلاغات بنجاح', 'success', 3000);
}

// ============================================
// لوحة التحكم المتقدمة (Analytics Dashboard)
// ============================================

var el_analyticsBtn=document.getElementById("analyticsBtn");if(el_analyticsBtn)el_analyticsBtn.addEventListener('click', function() {
    openModalById('analyticsModal');
    renderAnalyticsDashboard();
});






// ============================================
// سجل العمليات (Audit Log)
// ============================================

var auditLog = [];  // Phase 1: Fetched from server API, not localStorage
var currentAuditFilter = 'all';

var el_auditLogBtn=document.getElementById("auditLogBtn");if(el_auditLogBtn)el_auditLogBtn.addEventListener('click', function() {
    openModalById('auditLogModal');
    renderAuditLog();
});







// ============================================
// تصدير PDF (html2pdf.js)
// ============================================



// ============================================
// خرائط متقدمة (أقرب فرقة + مناطق تغطية)
// ============================================

var map = null;
var mapMarkers = [];
var coverageCircles = [];






// ============================================
// SSE - تحديث فوري
// ============================================
var sseSource = null;
var sseConnected = false;



// ============================================
// PWA - Push Notifications
// ============================================



// ============================================
// نظام تحليلات وإحصائيات التنبيهات (Analytics)
// ============================================
var peakAnalyticsModal = null;

function showPeakAnalytics() {
    var container = document.createElement('div');
    container.id = 'peakAnalyticsOverlay';
    container.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.5); z-index:99999; display:flex; align-items:center; justify-content:center;';
    
    var ratings = JSON.parse(localStorage.getItem('peakRatings') || '{}');
    var totalRatings = Object.keys(ratings).length;
    var avgRating = 0;
    var excellent = 0, good = 0, poor = 0;
    
    for (var id in ratings) {
        var r = ratings[id].rating;
        avgRating += r;
        if (r >= 5) excellent++;
        else if (r >= 3) good++;
        else poor++;
    }
    if (totalRatings > 0) avgRating = (avgRating / totalRatings).toFixed(1);
    
    var totalAlerts = 0;
    var activeAlerts = 0;
    var resolvedAlerts = totalAlerts - activeAlerts;
    
    container.innerHTML = 
        '<div style="background:white; border-radius:16px; padding:25px; max-width:500px; width:90%; max-height:80vh; overflow-y:auto; direction:rtl;">' +
            '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">' +
                '<h2 style="margin:0; color:#2563EB;"><i class="fas fa-chart-bar"></i> تحليلات التنبيهات</h2>' +
                '<button onclick="document.getElementById(\'peakAnalyticsOverlay\').remove()" class="btn"><i class="fas fa-times"></i></button>' +
            '</div>' +
            '<div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px; margin-bottom:20px;">' +
                '<div style="background:linear-gradient(135deg, #1E293B, #2563EB); color:white; padding:15px; border-radius:12px; text-align:center;">' +
                    '<div style="font-size:2rem; font-weight:800;">' + totalAlerts + '</div>' +
                    '<div style="font-size:0.75rem; opacity:0.8;">إجمالي التنبيهات</div>' +
                '</div>' +
                '<div style="background:linear-gradient(135deg, #10B981, #2563EB); color:white; padding:15px; border-radius:12px; text-align:center;">' +
                    '<div style="font-size:2rem; font-weight:800;">' + resolvedAlerts + '</div>' +
                    '<div style="font-size:0.75rem; opacity:0.8;">تم التنفيذ</div>' +
                '</div>' +
                '<div style="background:linear-gradient(135deg, #EF4444, #D35400); color:white; padding:15px; border-radius:12px; text-align:center;">' +
                    '<div style="font-size:2rem; font-weight:800;">' + activeAlerts + '</div>' +
                    '<div style="font-size:0.75rem; opacity:0.8;">نشطة الآن</div>' +
                '</div>' +
                '<div style="background:linear-gradient(135deg, #F59E0B, #D4B03A); color:#1A2633; padding:15px; border-radius:12px; text-align:center;">' +
                    '<div style="font-size:2rem; font-weight:800;">' + avgRating + '/5</div>' +
                    '<div style="font-size:0.75rem; opacity:0.8;">متوسط التقييم</div>' +
                '</div>' +
            '</div>' +
            '<h3 style="font-size:0.9rem; color:#2563EB; margin-bottom:10px;">توزيع التقييمات</h3>' +
            '<div style="margin-bottom:8px;"><span style="display:inline-block; width:80px; font-size:0.8rem;">✅ ممتاز</span><div style="display:inline-block; width:200px; height:20px; background:#EDF1F7; border-radius:10px; overflow:hidden; vertical-align:middle;"><div style="width:' + (totalRatings > 0 ? (excellent/totalRatings*100) : 0) + '%; height:100%; background:#27AE60;"></div></div> <span style="font-size:0.75rem;">' + excellent + '</span></div>' +
            '<div style="margin-bottom:8px;"><span style="display:inline-block; width:80px; font-size:0.8rem;">⚠️ جيد</span><div style="display:inline-block; width:200px; height:20px; background:#EDF1F7; border-radius:10px; overflow:hidden; vertical-align:middle;"><div style="width:' + (totalRatings > 0 ? (good/totalRatings*100) : 0) + '%; height:100%; background:#F59E0B;"></div></div> <span style="font-size:0.75rem;">' + good + '</span></div>' +
            '<div style="margin-bottom:8px;"><span style="display:inline-block; width:80px; font-size:0.8rem;">❌ يحتاج تحسين</span><div style="display:inline-block; width:200px; height:20px; background:#EDF1F7; border-radius:10px; overflow:hidden; vertical-align:middle;"><div style="width:' + (totalRatings > 0 ? (poor/totalRatings*100) : 0) + '%; height:100%; background:#EF4444;"></div></div> <span style="font-size:0.75rem;">' + poor + '</span></div>' +
        '</div>';
    
    document.body.appendChild(container);
    container.onclick = function(e) { if (e.target === container) container.remove(); };
}

// ============================================
// إشعارات متعددة القنوات (Multi-Channel)
// ============================================
function sendMultiChannelNotification(title, body, options) {
    options = options || {};
    
    // 1. Browser Push Notification
    if (Notification.permission === 'granted') {
        new Notification(title, {
            body: body,
            icon: options.icon || '/favicon.ico',
            badge: options.badge || '/favicon.ico',
            tag: options.tag || 'janoub-' + Date.now(),
            requireInteraction: options.requireInteraction || false,
            silent: options.silent || false
        });
    }
    
    // 2. Vibration (mobile)
    if (navigator.vibrate && options.vibrate !== false) {
        navigator.vibrate(options.vibratePattern || [300, 100, 300, 100, 500]);
    }
    
    // 3. Screen flash effect
    if (options.flash !== false) {
        flashScreenNotification(options.flashColor || '#EF4444');
    }
    
    // 4. Sound (via our sound system)
    if (options.sound !== false && soundSettings.master) {
        playUrgentAlertSound();
    }
}

function flashScreenNotification(color) {
    var flash = document.createElement('div');
    flash.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:' + color + '; opacity:0.3; z-index:99998; pointer-events:none; animation:flashFade 0.5s ease-out forwards;';
    document.body.appendChild(flash);
    setTimeout(function() { if (flash.parentNode) flash.parentNode.removeChild(flash); }, 500);
}

// Add flash animation to CSS
var flashStyle = document.createElement('style');
flashStyle.textContent = '@keyframes flashFade { from { opacity: 0.3; } to { opacity: 0; } }';
document.head.appendChild(flashStyle);

// ============================================
// تحديث checkForAlerts ليستخدم الإشعارات المتعددة
// ============================================
var originalCheckForAlerts = checkForAlerts;
checkForAlerts = function() {
    AuthManager.apiRequest('/api/peak-data')
        .then(function(res) { return res.json(); })
        .then(function(result) {
            if (result.success) {
                var alerts = result.data.alerts || [];
                var activeAlerts = alerts.filter(function(a) { return a.status === 'نشط'; });
                var dismissed = localStorage.getItem('alertDismissed') === 'true';
                var shownAlert = localStorage.getItem('lastShownPeakAlert');
                
                // Update stats bar if visible
                var statAlerts = document.getElementById('statAlerts');
                if (statAlerts) statAlerts.textContent = activeAlerts.length;
                
                if (activeAlerts.length > 0 && !dismissed) {
                    var latestAlert = activeAlerts[0];
                    if (latestAlert.id !== shownAlert) {
                        // Show the alert modal
                        showPeakAlert({
                            unit: latestAlert.unit || (latestAlert.title ? latestAlert.title.replace('تمركز مطلوب لـ ', '') : '-') || '-',
                            location: latestAlert.location || '-',
                            startTime: latestAlert.startTime || '-',
                            endTime: latestAlert.endTime || '-',
                            notes: latestAlert.notes || 'لا توجد ملاحظات',
                            lat: latestAlert.lat || 24.7136,
                            lng: latestAlert.lng || 46.6753,
                            radius: latestAlert.radius || 5000,
                            id: latestAlert.id,
                            priority: latestAlert.priority || 'عالية',
                            details: latestAlert.details
                        });
                        localStorage.setItem('lastShownPeakAlert', latestAlert.id);
                        
                        // Multi-channel notification
                        sendMultiChannelNotification(
                            '\uD83D\uDEA8 تنبيه تمركز - ' + (latestAlert.unit || '-'),
                            'موقع: ' + (latestAlert.location || '-') + ' | من ' + (latestAlert.startTime || '-') + ' إلى ' + (latestAlert.endTime || '-'),
                            {
                                tag: 'peak-' + latestAlert.id,
                                requireInteraction: true,
                                vibratePattern: [500, 200, 500, 200, 500, 200, 1000],
                                flashColor: latestAlert.priority === 'عالية' ? '#EF4444' : '#F59E0B'
                            }
                        );
                    }
                }
            }
        })
        .catch(function() {});
};

// ============================================
// Smart Toolbar System
// ============================================

function toggleSidebar() {
    var sidebar = document.getElementById('smartSidebar');
    var overlay = document.getElementById('sidebarOverlay');
    if (!sidebar) return;
    sidebar.classList.toggle('open');
    if (overlay) overlay.classList.toggle('active');
    document.body.style.overflow = sidebar.classList.contains('open') ? 'hidden' : '';
}

function closeSidebarOnMobile() {
    var sidebar = document.getElementById('smartSidebar');
    var overlay = document.getElementById('sidebarOverlay');
    if (window.innerWidth < 768 && sidebar) {
        sidebar.classList.remove('open');
        if (overlay) overlay.classList.remove('active');
        document.body.style.overflow = '';
    }
}

function toggleGroup(header) {
    if (!header) return;
    var group = header.parentElement;
    if (!group) return;
    group.classList.toggle('collapsed');
    var arrow = header.querySelector('.group-arrow');
    if (arrow) {
        arrow.style.transform = group.classList.contains('collapsed') ? 'rotate(-90deg)' : 'rotate(0deg)';
    }
}

function openOperationsRoom() {
    var modal = document.getElementById('operationsRoomModal');
    if (modal) {
        modal.style.display = 'flex';
        document.body.style.overflow = 'hidden';
        switchOpsTab('protocols');
    }
}

function closeOperationsRoom() {
    var modal = document.getElementById('operationsRoomModal');
    if (modal) {
        modal.style.display = 'none';
        document.body.style.overflow = '';
    }
}

function switchOpsTab(tabName) {
    var tabs = document.querySelectorAll('.ops-tab-content');
    for (var i = 0; i < tabs.length; i++) {
        tabs[i].classList.remove('active');
    }
    var buttons = document.querySelectorAll('.ops-tab');
    for (var i = 0; i < buttons.length; i++) {
        buttons[i].classList.remove('active');
    }
    var targetTab = document.getElementById('ops-tab-' + tabName);
    if (targetTab) targetTab.classList.add('active');
    var activeBtn = document.querySelector('.ops-tab[data-tab="' + tabName + '"]');
    if (activeBtn) activeBtn.classList.add('active');
}

function refreshOperationsData() {
    var icon = document.querySelector('.operations-header .ops-btn .fa-sync-alt');
    if (icon) {
        icon.classList.add('fa-spin');
        setTimeout(function() { icon.classList.remove('fa-spin'); }, 1000);
    }
    // F5b: «عمليات نشطة» = عدد مفاتيح المرآة ذات count>0 (فرقة لها بلاغ ≥1 في المناوبة الحالية — نفس تعريف renderKPIs)
    var kpiActive = document.getElementById('opsKpiActive');
    if (kpiActive) {
        var activeUnits = 0;
        for (var key in reports) { if (reports[key] && reports[key].count > 0) activeUnits++; }
        kpiActive.textContent = activeUnits;
    }
}

document.addEventListener('click', function(e) {
    var modal = document.getElementById('operationsRoomModal');
    if (modal && e.target === modal) {
        closeOperationsRoom();
    }
});

document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
        closeOperationsRoom();
        var sidebar = document.getElementById('smartSidebar');
        var overlay = document.getElementById('sidebarOverlay');
        if (sidebar) sidebar.classList.remove('open');
        if (overlay) overlay.classList.remove('active');
        document.body.style.overflow = '';
    }
});

function initSmartToolbar() {
    var toggleBtn = document.getElementById('sidebarToggle');
    if (toggleBtn) toggleBtn.addEventListener('click', toggleSidebar);
    
    var closeBtn = document.getElementById('sidebarClose');
    if (closeBtn) closeBtn.addEventListener('click', toggleSidebar);
    
    var overlay = document.getElementById('sidebarOverlay');
    if (overlay) overlay.addEventListener('click', toggleSidebar);
    
    var qaNewShift = document.getElementById('qaNewShift');
    if (qaNewShift) qaNewShift.onclick = startNewShift;
    
    var qaShift = document.getElementById('qaShift');
    if (qaShift) qaShift.onclick = openShiftModal;
    
    var qaDistribution = document.getElementById('qaDistribution');
    if (qaDistribution) qaDistribution.onclick = function() { openModalById('distributionModal'); };

    var qaForms = document.getElementById('qaForms');
    if (qaForms) qaForms.onclick = function() { openModalById('formsModal'); };

    var qaStats = document.getElementById('qaStats');
    if (qaStats) qaStats.onclick = function() { openModalById('chartsModal'); setTimeout(renderAllCharts, 300); };
    
    var sidebarNewShift = document.getElementById('sidebarNewShift');
    if (sidebarNewShift) sidebarNewShift.onclick = function() { toggleSidebar(); startNewShift(); };
    
    var sidebarShift = document.getElementById('sidebarShift');
    if (sidebarShift) sidebarShift.onclick = function() { toggleSidebar(); openShiftModal(); };
    
    var sidebarDistribution = document.getElementById('sidebarDistribution');
    if (sidebarDistribution) sidebarDistribution.onclick = function() { toggleSidebar(); openModalById('distributionModal'); };
    
    var sidebarTable = document.getElementById('sidebarTable');
    if (sidebarTable) sidebarTable.onclick = function() { toggleSidebar(); var el_monthlyTableModal_d74 = document.getElementById('monthlyTableModal'); if (el_monthlyTableModal_d74) el_monthlyTableModal_d74.style.display = 'flex'; loadSavedTable(); };
    
    var sidebarSenior = document.getElementById('sidebarSenior');
    if (sidebarSenior) sidebarSenior.onclick = function() { toggleSidebar(); openModalById('seniorShiftModal'); };

    var sidebarControl = document.getElementById('sidebarControl');
    if (sidebarControl) sidebarControl.onclick = function() { toggleSidebar(); openModalById('controlModal'); loadVacations().then(function() { renderControlList(false); }); };

    var sidebarForms = document.getElementById('sidebarForms');
    if (sidebarForms) sidebarForms.onclick = function() { toggleSidebar(); openModalById('formsModal'); };

    var sidebarPeak = document.getElementById('sidebarPeak');
    if (sidebarPeak) sidebarPeak.onclick = function() { toggleSidebar(); openModalById('peakTimeModal'); };

    var sidebarCharts = document.getElementById('sidebarCharts');
    if (sidebarCharts) sidebarCharts.onclick = function() { toggleSidebar(); openModalById('chartsModal'); setTimeout(renderAllCharts, 300); };

    var sidebarAnalytics = document.getElementById('sidebarAnalytics');
    if (sidebarAnalytics) sidebarAnalytics.onclick = function() { toggleSidebar(); openModalById('analyticsModal'); };

    var sidebarAudit = document.getElementById('sidebarAudit');
    if (sidebarAudit) sidebarAudit.onclick = function() { toggleSidebar(); openModalById('auditLogModal'); };
    
    var sidebarTheme = document.getElementById('sidebarTheme');
    if (sidebarTheme) sidebarTheme.onclick = function() { toggleSidebar(); var el_themeModal_d83 = document.getElementById('themeModal'); if (el_themeModal_d83) el_themeModal_d83.style.display = 'flex'; };
    
    var sidebarDarkMode = document.getElementById('sidebarDarkMode');
    
    var sidebarThemeMode = document.getElementById('sidebarThemeMode');
    
    var sidebarSound = document.getElementById('sidebarSound');
    if (sidebarSound) sidebarSound.onclick = function() { toggleSidebar(); var el_soundSettingsModal_d84 = document.getElementById('soundSettingsModal'); if (el_soundSettingsModal_d84) el_soundSettingsModal_d84.style.display = 'flex'; };
    
    var sidebarNotifications = document.getElementById('sidebarNotifications');
    if (sidebarNotifications) sidebarNotifications.onclick = function() { toggleSidebar(); requestPushNotification(); };
    
    var sidebarOpsProtocols = document.getElementById('sidebarOpsProtocols');
    if (sidebarOpsProtocols) sidebarOpsProtocols.onclick = function() { toggleSidebar(); openOperationsRoom(); switchOpsTab('protocols'); };
    
    var sidebarOpsUpdates = document.getElementById('sidebarOpsUpdates');
    if (sidebarOpsUpdates) sidebarOpsUpdates.onclick = function() { toggleSidebar(); openOperationsRoom(); switchOpsTab('updates'); };
    
    var sidebarOpsKPIs = document.getElementById('sidebarOpsKPIs');
    if (sidebarOpsKPIs) sidebarOpsKPIs.onclick = function() { toggleSidebar(); openOperationsRoom(); switchOpsTab('kpis'); };
    
    var operationsRoomBtn = document.getElementById('operationsRoomBtn');
    if (operationsRoomBtn) operationsRoomBtn.onclick = openOperationsRoom;
    
    var sidebarItems = document.querySelectorAll('.sidebar-item');
    for (var i = 0; i < sidebarItems.length; i++) {
        sidebarItems[i].addEventListener('click', closeSidebarOnMobile);
    }
    
    var currentDateTop = document.getElementById('currentDateTop');
    if (currentDateTop) currentDateTop.textContent = getSaudiDate();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
        initSmartToolbar();
        initShiftModalSmartFeatures();
    });
} else {
    initSmartToolbar();
    initShiftModalSmartFeatures();
}

// ===== Smart ShiftModal Features =====
function initShiftModalSmartFeatures() {
    // Animate numbers on modal open
    var shiftModal = document.getElementById('shiftModal');
    if (!shiftModal) return;
    
    // Observe when modal becomes visible
    var observer = new MutationObserver(function(mutations) {
        mutations.forEach(function(mutation) {
            if (mutation.target.style.display === 'flex') {
                animateShiftModalNumbers();
                animateShiftProgressBar();
            }
        });
    });
    
    observer.observe(shiftModal, { attributes: true, attributeFilter: ['style'] });
    
    // Add hover effects to table rows
    var tableRows = shiftModal.querySelectorAll('.shift-table tbody tr');
    tableRows.forEach(function(row) {
        row.addEventListener('mouseenter', function() {
            this.style.zIndex = '10';
        });
        row.addEventListener('mouseleave', function() {
            this.style.zIndex = '1';
        });
    });
    
    // Add focus effects to inputs
    var inputs = shiftModal.querySelectorAll('.shift-table tbody input, .shift-table tbody select');
    inputs.forEach(function(input) {
        input.addEventListener('focus', function() {
            this.closest('tr').style.background = 'rgba(232,237,243,0.95)';
        });
        input.addEventListener('blur', function() {
            this.closest('tr').style.background = '';
        });
    });
}

// Animate numbers counting up
function animateShiftModalNumbers() {
    var valueElements = document.querySelectorAll('#shiftModal .shift-kpi-value, #shiftModal .shift-report-value, #shiftModal .shift-circle-value, #shiftModal .shift-progress-stat .value');
    
    valueElements.forEach(function(el) {
        var finalValue = el.textContent;
        var numericValue = parseFloat(finalValue.replace(/[^0-9.]/g, ''));
        if (isNaN(numericValue) || numericValue === 0) return;
        
        var suffix = finalValue.replace(/[0-9.]/g, '');
        var duration = 1500;
        var startTime = null;
        
        function animate(currentTime) {
            if (!startTime) startTime = currentTime;
            var progress = Math.min((currentTime - startTime) / duration, 1);
            var easeProgress = 1 - Math.pow(1 - progress, 3); // ease-out cubic
            var currentValue = Math.floor(easeProgress * numericValue);
            el.textContent = currentValue + suffix;
            
            if (progress < 1) {
                requestAnimationFrame(animate);
            } else {
                el.textContent = finalValue;
            }
        }
        
        requestAnimationFrame(animate);
    });
}

// Animate progress bar with smart color
function animateShiftProgressBar() {
    var progressBar = document.getElementById('shiftProgressFill');
    if (!progressBar) return;
    
    var targetWidth = progressBar.style.width || '0%';
    var percent = parseInt(targetWidth);
    
    // Set color based on percentage
    if (percent < 30) {
        progressBar.style.background = 'linear-gradient(90deg, #EF4444, #F0907A)';
    } else if (percent < 70) {
        progressBar.style.background = 'linear-gradient(90deg, #F59E0B, #F5D96A)';
    } else {
        progressBar.style.background = 'linear-gradient(90deg, #10B981, #3DB39A)';
    }
    
    // Animate from 0 to target
    progressBar.style.width = '0%';
    setTimeout(function() {
        progressBar.style.width = targetWidth;
    }, 300);
}

// Add ripple effect to preset buttons
document.addEventListener('click', function(e) {
    var btn = e.target.closest('.shift-preset-btn');
    if (!btn) return;
    
    var ripple = document.createElement('span');
    ripple.style.cssText = 'position:absolute;border-radius:50%;background:rgba(255,255,255,0.4);transform:scale(0);animation:shiftRipple 0.6s ease-out;pointer-events:none;';
    
    var rect = btn.getBoundingClientRect();
    var size = Math.max(rect.width, rect.height);
    ripple.style.width = ripple.style.height = size + 'px';
    ripple.style.left = (e.clientX - rect.left - size / 2) + 'px';
    ripple.style.top = (e.clientY - rect.top - size / 2) + 'px';
    
    btn.style.position = 'relative';
    btn.style.overflow = 'hidden';
    btn.appendChild(ripple);
    
    setTimeout(function() { ripple.remove(); }, 600);
});

// Add ripple animation keyframes
var shiftRippleStyle = document.createElement('style');
shiftRippleStyle.textContent = '@keyframes shiftRipple { to { transform: scale(4); opacity: 0; } }';
document.head.appendChild(shiftRippleStyle);




// ============================================
// applyUserPermissions (من inline.js)
// ============================================
// خريطة تسميات الأدوار (إصلاح موحد 2026-08-18): الأدوار الخمسة الجديدة + القديمة للتوافق
function roleLabel(role) {
    var map = {
        sysadmin: 'مدير النظام',
        ops_supervisor: 'مشرف العمليات',
        field_leadership: 'القيادة الميدانية',
        operator: 'مستخدم تشغيل',
        viewer: 'مستخدم قراءة',
        admin: 'مدير',
        director: 'مدير عمليات',
        user: 'مستخدم'
    };
    return map[role] || 'مستخدم';
}

function applyUserPermissions(user) {
    if (!user) user = currentUser;
    if (!user) return;
    // sysadmin = نجمة بحكم config/permissions → يرى عناصر .admin-only كالمدير القديم (إصلاح موحد 2026-08-18)
    var isAdmin = user.role === 'admin' || user.role === 'sysadmin';
    var isDirector = user.role === 'director';
    var isUser = user.role === 'user';
    var adminOnly = document.querySelectorAll('.admin-only');
    adminOnly.forEach(function(el) { el.style.display = isAdmin ? '' : 'none'; });
    if (isUser) {
        var newShiftBtn = document.getElementById('newShiftBtn');
        if (newShiftBtn) { newShiftBtn.disabled = true; newShiftBtn.style.opacity = '0.5'; newShiftBtn.title = 'ليس لديك الصلاحية'; }
        var shiftBtn = document.getElementById('shiftBtn');
        if (shiftBtn) { shiftBtn.disabled = true; shiftBtn.style.opacity = '0.5'; }
        var distributionBtn = document.getElementById('distributionBtn');
        if (distributionBtn) { distributionBtn.disabled = true; distributionBtn.style.opacity = '0.5'; }
    }
}

// ============================================
// fetch interceptor: إضافة Bearer token تلقائياً (من inline.js)
// ============================================
// ⚠️ حماية من التعديل المزدوج عند تحميل app.js عدة مرات
if (!window.__fetchInterceptorInstalled) {
    window.__fetchInterceptorInstalled = true;
    var originalFetch = window.fetch;
    window.fetch = function(url, options) {
        options = options || {};
        options.headers = options.headers || {};
        var token = AuthManager.getToken();
        if (token && typeof url === 'string' && url.startsWith('/api/')) {
            options.headers['Authorization'] = 'Bearer ' + token;
        }
        return originalFetch(url, options);
    };
}


// ============================================
// PEAK TIME SYSTEM v2 — نظام إدارة وقت الذروة
// ============================================

// الخادم هو مصدر الحقيقة الوحيد — تُحمَّل الخطط من الخدمة عبر loadPeakPlans (لا localStorage)
var peakPlans = [];
var peakAssignments = JSON.parse(localStorage.getItem('peakAssignments') || '[]');
var peakCurrentTab = 'dashboard';
var peakCountdownIntervals = {};

var PEAK_TEAM_TYPES = {
    advanced: 'إسعاف متقدم',
    basic: 'إسعاف أساسي',
    rapid: 'تدخل سريع',
    commander: 'قائد ميداني',
    support: 'دعم إضافي'
};

var PEAK_PLAN_TYPES = {
    peak: { label: 'وقت ذروة', icon: '⏰', color: 'var(--coral)' },
    event: { label: 'فعالية', icon: '🎉', color: 'var(--teal)' },
    temporary: { label: 'دعم مؤقت', icon: '🔄', color: 'var(--gold)' },
    incident: { label: 'حادث', icon: '⚠️', color: 'var(--primary-700)' },
    emergency: { label: 'طوارئ', icon: '🚨', color: '#DC2626' }
};

var PEAK_UNITS = ['سريع 1','سريع 2','سريع 3','سريع 4','جنوب 1','جنوب 2','جنوب 3','جنوب 4','جنوب 5','جنوب 6','جنوب 7','جنوب 8','جنوب 9','جنوب 10','جنوب 11','جنوب 12','جنوب 13','جنوب 14','جنوب 15','جنوب 16','جنوب 17','جنوب 18','جنوب 19'];

// ----- التحميل من الخادم (المصدر الوحيد للحقيقة) -----
var peakPlansMigrated = false; // محاولة ترحيل localStorage مرة واحدة فقط لكل تحميل صفحة

// ترحيل خطط localStorage القديمة إلى الخادم — لا يُحذف المفتاح إلا بعد نجاح رفع جميع العناصر (لا نفقد بيانات محلية أبداً)
async function migrateLocalPeakPlans() {
    var raw = localStorage.getItem('peakPlans');
    if (!raw) return;
    var items;
    try { items = JSON.parse(raw); } catch (e) { items = null; }
    if (!Array.isArray(items)) {
        console.warn('⚠️ تعذر تحليل خطط التمركز المحلية — تُرك المفتاح كما هو');
        return;
    }
    if (items.length === 0) { localStorage.removeItem('peakPlans'); return; }
    try {
        for (var i = 0; i < items.length; i++) {
            var migRes = await AuthManager.apiRequest('/api/peak-plans', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(items[i])
            });
            if (!migRes.ok) throw new Error('status=' + migRes.status);
        }
        localStorage.removeItem('peakPlans'); // نجح رفع الكل — أمكن حذف النسخة المحلية بأمان
    } catch (e) {
        console.warn('⚠️ فشل ترحيل خطط التمركز المحلية — تُعاد المحاولة عند التحميل القادم', e);
    }
}

// جلب الخطط من الخدمة ثم تحديث كل العروض (عرض فقط — لا منطق تشغيلي هنا)
async function loadPeakPlans() {
    try {
        if (!peakPlansMigrated) {
            peakPlansMigrated = true;
            await migrateLocalPeakPlans(); // الترحيل أولاً ثم الجلب للحصول على القائمة الكاملة
        }
        var response = await AuthManager.apiRequest('/api/peak-plans');
        if (!response.ok) throw new Error('status=' + response.status);
        var data = await response.json();
        peakPlans = Array.isArray(data.plans) ? data.plans : [];
        refreshPeakDashboard();
        renderPeakDeployments();
        renderPeakArchive();
    } catch (e) {
        console.error('❌ فشل تحميل خطط التمركز:', e);
    }
}

// ----- Modal Open/Close -----
function openPeakTimeModal() {
    openModalById('peakTimeModal');
    switchPeakTab('dashboard');
    refreshPeakDashboard();
    initPeakFormDefaults();
}

function closePeakTimeModal() {
    closeModalById('peakTimeModal');
}

// Replace the old event listener
var el_peakTimeBtn = document.getElementById('peakTimeBtn');
if (el_peakTimeBtn) {
    el_peakTimeBtn.onclick = function() { openPeakTimeModal(); };
}

// ربط إرسال نموذج خطة التمركز (ينوب عن ربط الوحدة المضمّنة المحذوفة من index.html)
function bindPeakPlanForm() {
    var el_peakPlanForm = document.getElementById('peakPlanForm');
    if (el_peakPlanForm) {
        el_peakPlanForm.addEventListener('submit', function(e) {
            e.preventDefault();
            savePeakPlan();
        });
    }
}
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindPeakPlanForm);
} else {
    bindPeakPlanForm();
}

// ----- Tab Switching -----
function switchPeakTab(tabName) {
    peakCurrentTab = tabName;
    document.querySelectorAll('.peak-tab').forEach(function(t) {
        t.classList.toggle('active', t.dataset.tab === tabName);
    });
    document.querySelectorAll('.peak-tab-content').forEach(function(c) {
        c.style.display = c.id === 'peakTab-' + tabName ? 'block' : 'none';
    });
    if (tabName === 'dashboard') refreshPeakDashboard();
    if (tabName === 'deployments') renderPeakDeployments();
    if (tabName === 'archive') renderPeakArchive();
}

// ----- Form Defaults -----
function initPeakFormDefaults() {
    // القيم الافتراضية بالتوقيت الجداري للرياض عبر الطبقة المركزية
    // (كانت مكوّنات منطقة الجهاز — تظهر أوقاتًا غير سعودية على الأجهزة الأجنبية)
    var p = TimeRiyadh.riyadhParts(new Date());
    var startStr = p.year + '-' + p.month + '-' + p.day + 'T' + p.hour + ':' + p.minute;
    var pe = TimeRiyadh.riyadhParts(new Date(Date.now() + 2*60*60*1000));
    var endStr = pe.year + '-' + pe.month + '-' + pe.day + 'T' + pe.hour + ':' + pe.minute;
    var elStart = document.getElementById('peakStartTime');
    if (elStart) elStart.value = startStr;
    var elEnd = document.getElementById('peakEndTime');
    if (elEnd) elEnd.value = endStr;
}

// ----- Save Plan -----
async function savePeakPlan() {
    var title = document.getElementById('peakPlanTitle').value.trim();
    var planType = document.getElementById('peakPlanType').value;
    var location = document.getElementById('peakLocation').value.trim();
    var unit = document.getElementById('peakUnit').value;
    var startTime = document.getElementById('peakStartTime').value;
    var endTime = document.getElementById('peakEndTime').value;
    var priority = document.getElementById('peakPriority').value;
    var notes = document.getElementById('peakNotes').value.trim();
    var lat = document.getElementById('peakLat').value;
    var lng = document.getElementById('peakLng').value;
    var teamType = document.querySelector('input[name="peakTeamType"]:checked');
    teamType = teamType ? teamType.value : 'advanced';

    if (!title || !unit || !startTime || !endTime) {
        alert('⚠️ الرجاء ملء الحقول المطلوبة (العنوان، الفرقة، البداية، النهاية)');
        return;
    }

    // نفس مجموعة الحقول التي كانت الواجهة تبنيها سابقاً — الخادم يملك id/status/createdAt
    var plan = {
        id: 'plan_' + Date.now(),
        title: title,
        planType: planType,
        location: location,
        unit: unit,
        teamType: teamType,
        startTime: startTime,
        endTime: endTime,
        priority: priority,
        notes: notes,
        lat: lat,
        lng: lng,
        status: 'active',
        arrivalTime: null,
        departureTime: null,
        createdAt: new Date().toISOString()
    };

    var savedPlan;
    try {
        var response = await AuthManager.apiRequest('/api/peak-plans', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(plan)
        });
        if (!response.ok) {
            alert('❌ فشل في حفظ خطة التمركز');
            return;
        }
        var data = await response.json();
        savedPlan = (data && data.plan) || plan; // الخطة الراجعة من الخادم (بالمعرف الرسمي)
    } catch (e) {
        console.error('❌ فشل في حفظ خطة التمركز:', e);
        alert('❌ فشل في حفظ خطة التمركز');
        return;
    }

    clearPeakForm();
    alert('✅ تم حفظ خطة التمركز');
    switchPeakTab('dashboard');
    startPeakReminders(savedPlan);
    await loadPeakPlans();
}

function clearPeakForm() {
    var ids = ['peakPlanTitle','peakLocation','peakNotes','peakLat','peakLng'];
    ids.forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.value = '';
    });
    var unitEl = document.getElementById('peakUnit');
    if (unitEl) unitEl.value = '';
    var typeEl = document.getElementById('peakPlanType');
    if (typeEl) typeEl.value = 'peak';
    var priorityEl = document.getElementById('peakPriority');
    if (priorityEl) priorityEl.value = 'high';
    var teamTypeEl = document.querySelector('input[name="peakTeamType"][value="advanced"]');
    if (teamTypeEl) teamTypeEl.checked = true;
    initPeakFormDefaults();
}

function sendPeakAlert() {
    var unit = document.getElementById('peakUnit').value;
    var location = document.getElementById('peakLocation').value.trim();
    if (!unit || !location) {
        alert('⚠️ الرجاء اختيار الفرقة والموقع أولاً');
        return;
    }
    var startTime = document.getElementById('peakStartTime').value;
    var endTime = document.getElementById('peakEndTime').value;
    var priority = document.getElementById('peakPriority').value;
    var priorityEmoji = priority === 'high' ? '🔴' : priority === 'medium' ? '🟡' : '🟢';
    var msg = '🚨 *تنبيه تمركز*\n';
    msg += '═══════════════════\n';
    msg += 'الفرقة: ' + unit + '\n';
    msg += 'الموقع: ' + location + '\n';
    msg += 'الأولوية: ' + priorityEmoji + ' ' + priority + '\n';
    msg += 'البداية: ' + (startTime ? startTime.replace('T',' ') : '-') + '\n';
    msg += 'النهاية: ' + (endTime ? endTime.replace('T',' ') : '-') + '\n';
    msg += '═══════════════════\n';
    msg += 'تم الإرسال: ' + TimeRiyadh.formatDateTimeSec(new Date());
    window.open('https://wa.me/?text=' + encodeURIComponent(msg), '_blank');
}

// ----- Dashboard -----
function refreshPeakDashboard() {
    updatePeakKPIs();
    renderPeakDashboardDeployments();
    renderPeakDashboardAlerts();
}

function updatePeakKPIs() {
    var now = new Date();
    var active = 0, late = 0, arrived = 0;
    peakPlans.forEach(function(p) {
        if (p.status === 'active') {
            active++;
            var start = new Date(p.startTime);
            if (now > start && !p.arrivalTime) late++;
        }
        if (p.arrivalTime && !p.departureTime) arrived++;
    });
    var kpiActive = document.getElementById('peakKpiActive');
    if (kpiActive) kpiActive.textContent = active;
    var kpiLate = document.getElementById('peakKpiLate');
    if (kpiLate) kpiLate.textContent = late;
    var kpiArrived = document.getElementById('peakKpiArrived');
    if (kpiArrived) kpiArrived.textContent = arrived;
    var kpiTotal = document.getElementById('peakKpiTotal');
    if (kpiTotal) kpiTotal.textContent = peakPlans.length;
}

function renderPeakDashboardDeployments() {
    var container = document.getElementById('peakDashboardDeployments');
    if (!container) return;
    var activePlans = peakPlans.filter(function(p) { return p.status === 'active'; });
    if (activePlans.length === 0) {
        container.innerHTML = '<p style="text-align:center; color:var(--gray-400); padding:20px;">📭 لا توجد تمركزات نشطة</p>';
        return;
    }
    var html = '';
    activePlans.slice(0, 5).forEach(function(plan) {
        html += buildPeakDeploymentRow(plan, true);
    });
    container.innerHTML = html;
    activePlans.forEach(function(plan) { startPeakCountdown(plan.id); });
}

function renderPeakDashboardAlerts() {
    var container = document.getElementById('peakDashboardAlerts');
    if (!container) return;
    var recentAlerts = peakPlans.filter(function(p) {
        return p.status === 'active' && new Date(p.startTime) <= new Date();
    }).slice(0, 3);
    if (recentAlerts.length === 0) {
        container.innerHTML = '<p style="text-align:center; color:var(--gray-400); padding:20px;">📭 لا توجد تنبيهات حالية</p>';
        return;
    }
    var html = '';
    recentAlerts.forEach(function(plan) {
        var pt = PEAK_PLAN_TYPES[plan.planType] || PEAK_PLAN_TYPES.peak;
        html += '<div style="display:flex; justify-content:space-between; align-items:center; padding:8px 12px; border:1px solid var(--gray-200); border-radius:var(--radius-sm); margin-bottom:6px; background:var(--white);">';
        html += '<div><span style="font-weight:600; font-size:0.85rem;">' + pt.icon + ' ' + plan.title + '</span>';
        html += '<span style="font-size:0.7rem; color:var(--gray-500); display:block;">🚑 ' + plan.unit + ' | 📍 ' + (plan.location || '-') + '</span></div>';
        html += '<span class="peak-countdown" id="peakCountdown_' + plan.id + '">--:--</span>';
        html += '</div>';
    });
    container.innerHTML = html;
    recentAlerts.forEach(function(plan) { startPeakCountdown(plan.id); });
}

// ----- Deployments Tab -----
function renderPeakDeployments() {
    var container = document.getElementById('peakDeploymentsList');
    if (!container) return;
    var activePlans = peakPlans.filter(function(p) { return p.status === 'active'; });
    if (activePlans.length === 0) {
        container.innerHTML = '<p style="text-align:center; color:var(--gray-400); padding:20px;">📭 لا توجد تمركزات نشطة</p>';
        return;
    }
    var html = '';
    activePlans.forEach(function(plan) {
        html += buildPeakDeploymentRow(plan, false);
    });
    container.innerHTML = html;
    activePlans.forEach(function(plan) { startPeakCountdown(plan.id); });
}

function buildPeakDeploymentRow(plan, compact) {
    var pt = PEAK_PLAN_TYPES[plan.planType] || PEAK_PLAN_TYPES.peak;
    var statusClass = plan.arrivalTime ? 'status-arrived' : new Date() > new Date(plan.startTime) ? 'status-late' : 'status-active';
    var statusBadge = plan.arrivalTime ? '<span class="peak-status-badge peak-status-arrived">✅ وصل</span>' : 
                      new Date() > new Date(plan.startTime) ? '<span class="peak-status-badge peak-status-late">⏰ متأخر</span>' : 
                      '<span class="peak-status-badge peak-status-active">🟡 قادم</span>';
    var priorityClass = 'peak-badge-priority-' + (plan.priority || 'medium');
    var priorityLabel = plan.priority === 'high' ? '🔴 عالية' : plan.priority === 'medium' ? '🟡 متوسطة' : '🟢 منخفضة';
    var teamLabel = PEAK_TEAM_TYPES[plan.teamType] || plan.teamType;
    var html = '<div class="peak-deployment-item ' + statusClass + '">';
    if (compact) {
        html += '<div><div style="font-weight:600; font-size:0.85rem;">' + pt.icon + ' ' + plan.title + '</div>';
        html += '<div style="font-size:0.75rem; color:var(--gray-500);">🚑 ' + plan.unit + ' | ' + teamLabel + ' | ' + priorityLabel + '</div></div>';
        html += '<div style="display:flex; align-items:center; gap:8px;">' + statusBadge;
        html += '<span class="peak-countdown" id="peakCountdown_' + plan.id + '">--:--</span></div>';
    } else {
        html += '<div style="flex:1;"><div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">';
        html += '<span style="font-weight:600; font-size:0.9rem;">' + pt.icon + ' ' + plan.title + '</span>';
        html += '<span class="peak-badge ' + priorityClass + '">' + priorityLabel + '</span>';
        html += '<span class="peak-badge peak-badge-type-' + plan.planType + '">' + pt.label + '</span>';
        html += '</div>';
        html += '<div style="font-size:0.8rem; color:var(--gray-600); margin-top:4px;">';
        html += '🚑 ' + plan.unit + ' | ' + teamLabel + ' | 📍 ' + (plan.location || '-') + '</div>';
        html += '<div style="font-size:0.75rem; color:var(--gray-500); margin-top:2px;">';
        // تفويض «المرحلة الأخيرة قبل الاعتماد الرسمي» (2026-08): البداية/النهاية
        // تُعرضان عبر الطبقة المركزية TimeRiyadh (التخزين UTC ISO قانوني) — لا نص خام.
        html += '⏰ ' + (plan.startTime ? TimeRiyadh.formatDateTime(plan.startTime) : '-') + ' → ' + (plan.endTime ? TimeRiyadh.formatDateTime(plan.endTime) : '-') + '</div>';
        if (plan.notes) html += '<div style="font-size:0.75rem; color:var(--gray-500); margin-top:2px;">📝 ' + plan.notes + '</div>';
        html += '</div>';
        html += '<div style="display:flex; flex-direction:column; align-items:flex-end; gap:6px;">';
        html += '<div style="display:flex; align-items:center; gap:6px;">' + statusBadge;
        html += '<span class="peak-countdown" id="peakCountdown_' + plan.id + '">--:--</span></div>';
        html += '<div style="display:flex; gap:4px;">';
        if (!plan.arrivalTime) {
            html += '<button onclick="confirmPeakArrival(\'' + plan.id + '\')" class="btn btn-teal" style="padding:3px 10px; font-size:0.7rem;"><i class="fas fa-check"></i> وصول</button>';
        } else if (!plan.departureTime) {
            html += '<button onclick="confirmPeakDeparture(\'' + plan.id + '\')" class="btn btn-warning" style="padding:3px 10px; font-size:0.7rem;"><i class="fas fa-sign-out-alt"></i> مغادرة</button>';
        }
        html += '<button onclick="resolvePeakPlan(\'' + plan.id + '\')" class="btn" style="padding:3px 10px; font-size:0.7rem;"><i class="fas fa-check-double"></i> إنهاء</button>';
        html += '</div></div>';
    }
    html += '</div>';
    return html;
}

async function confirmPeakArrival(planId) {
    var plan = peakPlans.find(function(p) { return p.id === planId; });
    if (!plan) return;
    var arrivalTime = new Date().toISOString(); // نفس الحقل والصيغة اللذين كانت الواجهة تخزنهما
    try {
        var response = await AuthManager.apiRequest('/api/peak-plans/' + encodeURIComponent(planId), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ arrivalTime: arrivalTime })
        });
        if (!response.ok) throw new Error('status=' + response.status);
    } catch (e) {
        console.error('❌ فشل تأكيد وصول التمركز:', e);
        return;
    }
    await loadPeakPlans();
    showToast('✅ تم تأكيد وصول ' + plan.unit, 'success');
    playPeakSound('arrival');
}

async function confirmPeakDeparture(planId) {
    var plan = peakPlans.find(function(p) { return p.id === planId; });
    if (!plan) return;
    var departureTime = new Date().toISOString(); // نفس الحقل والصيغة اللذين كانت الواجهة تخزنهما
    try {
        var response = await AuthManager.apiRequest('/api/peak-plans/' + encodeURIComponent(planId), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ departureTime: departureTime })
        });
        if (!response.ok) throw new Error('status=' + response.status);
    } catch (e) {
        console.error('❌ فشل تأكيد مغادرة التمركز:', e);
        return;
    }
    await loadPeakPlans();
    showToast('✅ تم تأكيد مغادرة ' + plan.unit, 'success');
}

async function resolvePeakPlan(planId) {
    if (!confirm('⚠️ هل أنت متأكد من إنهاء هذه الخطة؟')) return;
    var plan = peakPlans.find(function(p) { return p.id === planId; });
    if (!plan) return;
    // نفس التعديلات القديمة حرفياً: status = 'completed' مع الإبقاء على departureTime إن وُجد
    var departureTime = plan.departureTime || new Date().toISOString();
    try {
        var response = await AuthManager.apiRequest('/api/peak-plans/' + encodeURIComponent(planId), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'completed', departureTime: departureTime })
        });
        if (!response.ok) throw new Error('status=' + response.status);
    } catch (e) {
        console.error('❌ فشل إنهاء خطة التمركز:', e);
        return;
    }
    stopPeakCountdown(planId);
    await loadPeakPlans();
    showToast('✅ تم إنهاء الخطة', 'success');
}

function filterPeakDeployments(filter) {
    var container = document.getElementById('peakDeploymentsList');
    if (!container) return;
    var now = new Date();
    var filtered = peakPlans.filter(function(p) {
        if (p.status !== 'active') return false;
        if (filter === 'all') return true;
        if (filter === 'late') return now > new Date(p.startTime) && !p.arrivalTime;
        if (filter === 'arrived') return !!p.arrivalTime;
        if (filter === 'active') return !p.arrivalTime && now <= new Date(p.startTime);
        return true;
    });
    if (filtered.length === 0) {
        container.innerHTML = '<p style="text-align:center; color:var(--gray-400); padding:20px;">📭 لا توجد نتائج</p>';
        return;
    }
    var html = '';
    filtered.forEach(function(plan) { html += buildPeakDeploymentRow(plan, false); });
    container.innerHTML = html;
    filtered.forEach(function(plan) { startPeakCountdown(plan.id); });
}

// ----- Countdown -----
function startPeakCountdown(planId) {
    stopPeakCountdown(planId);
    var plan = peakPlans.find(function(p) { return p.id === planId; });
    if (!plan || plan.status !== 'active') return;
    updatePeakCountdown(planId);
    peakCountdownIntervals[planId] = setInterval(function() { updatePeakCountdown(planId); }, 1000);
}

function stopPeakCountdown(planId) {
    if (peakCountdownIntervals[planId]) {
        clearInterval(peakCountdownIntervals[planId]);
        delete peakCountdownIntervals[planId];
    }
}

function updatePeakCountdown(planId) {
    var el = document.getElementById('peakCountdown_' + planId);
    if (!el) return;
    var plan = peakPlans.find(function(p) { return p.id === planId; });
    if (!plan) { stopPeakCountdown(planId); return; }
    var now = new Date();
    var start = new Date(plan.startTime);
    var end = new Date(plan.endTime);
    if (plan.departureTime) {
        el.textContent = '✅ منتهي';
        el.className = 'peak-countdown safe';
        stopPeakCountdown(planId);
        return;
    }
    if (plan.arrivalTime) {
        var remaining = end - now;
        if (remaining <= 0) {
            el.textContent = '⏰ انتهى';
            el.className = 'peak-countdown urgent';
        } else {
            var h = Math.floor(remaining / 3600000);
            var m = Math.floor((remaining % 3600000) / 60000);
            var s = Math.floor((remaining % 60000) / 1000);
            el.textContent = String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
            el.className = 'peak-countdown safe';
        }
        return;
    }
    if (now < start) {
        var toStart = start - now;
        var h = Math.floor(toStart / 3600000);
        var m = Math.floor((toStart % 3600000) / 60000);
        var s = Math.floor((toStart % 60000) / 1000);
        el.textContent = '-' + String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
        el.className = 'peak-countdown safe';
    } else {
        var overdue = now - start;
        var h = Math.floor(overdue / 3600000);
        var m = Math.floor((overdue % 3600000) / 60000);
        var s = Math.floor((overdue % 60000) / 1000);
        el.textContent = '+' + String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
        el.className = 'peak-countdown urgent';
    }
}

// ----- Reminders & Notifications -----
function startPeakReminders(plan) {
    var start = new Date(plan.startTime);
    var now = new Date();
    var times = [30, 15, 5];
    times.forEach(function(minutes) {
        var reminderTime = new Date(start.getTime() - minutes * 60000);
        if (reminderTime > now) {
            var delay = reminderTime - now;
            setTimeout(function() {
                if (plan.status === 'active') {
                    var isUrgent = minutes <= 5;
                    showToast('⏰ تذكير: ' + plan.unit + ' - ' + minutes + ' دقيقة للتمركز', isUrgent ? 'error' : 'warning');
                    if (isUrgent) {
                        playPeakSound('alert');
                        showPeakAlertFlash();
                    } else {
                        playPeakSound('reminder');
                    }
                }
            }, delay);
        }
    });
    // Also alert when start time is reached and team hasn't arrived
    var startDelay = start - now;
    if (startDelay > 0) {
        setTimeout(function() {
            var p = peakPlans.find(function(x) { return x.id === plan.id; });
            if (p && p.status === 'active' && !p.arrivalTime) {
                playPeakSound('alert');
                showPeakAlertFlash();
                showToast('🚨 ' + plan.unit + ' تجاوز وقت التمركز!', 'error');
            }
        }, startDelay);
    }
}

function showPeakAlertFlash() {
    var overlay = document.createElement('div');
    overlay.className = 'peak-alert-overlay';
    document.body.appendChild(overlay);
    setTimeout(function() {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }, 3000);
}

function playPeakSound(type) {
    try {
        var ctx = new (window.AudioContext || window.webkitAudioContext)();
        
        if (type === 'alert') {
            // Emergency siren - more distinctive and urgent
            var t = ctx.currentTime;
            
            // First oscillator - main siren tone
            var osc1 = ctx.createOscillator();
            var gain1 = ctx.createGain();
            osc1.connect(gain1);
            gain1.connect(ctx.destination);
            osc1.type = 'sawtooth';
            gain1.gain.setValueAtTime(0.15, t);
            gain1.gain.exponentialRampToValueAtTime(0.05, t + 2.5);
            
            // Siren wobble effect
            osc1.frequency.setValueAtTime(800, t);
            osc1.frequency.linearRampToValueAtTime(1200, t + 0.5);
            osc1.frequency.linearRampToValueAtTime(800, t + 1.0);
            osc1.frequency.linearRampToValueAtTime(1200, t + 1.5);
            osc1.frequency.linearRampToValueAtTime(800, t + 2.0);
            osc1.frequency.linearRampToValueAtTime(600, t + 2.5);
            
            osc1.start(t);
            osc1.stop(t + 2.5);
            
            // Second oscillator - higher harmonic
            var osc2 = ctx.createOscillator();
            var gain2 = ctx.createGain();
            osc2.connect(gain2);
            gain2.connect(ctx.destination);
            osc2.type = 'square';
            gain2.gain.setValueAtTime(0.08, t);
            gain2.gain.exponentialRampToValueAtTime(0.02, t + 2.5);
            
            osc2.frequency.setValueAtTime(1600, t);
            osc2.frequency.linearRampToValueAtTime(2400, t + 0.5);
            osc2.frequency.linearRampToValueAtTime(1600, t + 1.0);
            osc2.frequency.linearRampToValueAtTime(2400, t + 1.5);
            osc2.frequency.linearRampToValueAtTime(1600, t + 2.0);
            osc2.frequency.linearRampToValueAtTime(1200, t + 2.5);
            
            osc2.start(t);
            osc2.stop(t + 2.5);
            
            // Third oscillator - low bass thump
            var osc3 = ctx.createOscillator();
            var gain3 = ctx.createGain();
            osc3.connect(gain3);
            gain3.connect(ctx.destination);
            osc3.type = 'sine';
            gain3.gain.setValueAtTime(0.2, t);
            
            osc3.frequency.setValueAtTime(200, t);
            osc3.frequency.exponentialRampToValueAtTime(50, t + 0.3);
            osc3.frequency.setValueAtTime(200, t + 0.5);
            osc3.frequency.exponentialRampToValueAtTime(50, t + 0.8);
            osc3.frequency.setValueAtTime(200, t + 1.0);
            osc3.frequency.exponentialRampToValueAtTime(50, t + 1.3);
            osc3.frequency.setValueAtTime(200, t + 1.5);
            osc3.frequency.exponentialRampToValueAtTime(50, t + 1.8);
            osc3.frequency.setValueAtTime(200, t + 2.0);
            osc3.frequency.exponentialRampToValueAtTime(50, t + 2.3);
            
            gain3.gain.exponentialRampToValueAtTime(0.01, t + 2.5);
            osc3.start(t);
            osc3.stop(t + 2.5);
            
        } else if (type === 'reminder') {
            // Gentle reminder chime
            var t = ctx.currentTime;
            var notes = [523, 659, 784, 1047]; // C major arpeggio
            notes.forEach(function(freq, i) {
                var osc = ctx.createOscillator();
                var gain = ctx.createGain();
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.type = 'sine';
                osc.frequency.value = freq;
                gain.gain.setValueAtTime(0.1, t + i * 0.15);
                gain.gain.exponentialRampToValueAtTime(0.001, t + i * 0.15 + 0.3);
                osc.start(t + i * 0.15);
                osc.stop(t + i * 0.15 + 0.3);
            });
            
        } else if (type === 'arrival') {
            // Success confirmation sound
            var t = ctx.currentTime;
            var notes = [784, 1047, 1319]; // G5, C6, E6
            notes.forEach(function(freq, i) {
                var osc = ctx.createOscillator();
                var gain = ctx.createGain();
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.type = 'sine';
                osc.frequency.value = freq;
                gain.gain.setValueAtTime(0.15, t + i * 0.1);
                gain.gain.exponentialRampToValueAtTime(0.001, t + i * 0.1 + 0.4);
                osc.start(t + i * 0.1);
                osc.stop(t + i * 0.1 + 0.4);
            });
        }
    } catch (e) { console.log('Sound not supported'); }
}

// ----- AI Suggestions -----
function updatePeakAiSuggestions() {
    var unit = document.getElementById('peakUnit').value;
    var location = document.getElementById('peakLocation').value;
    var container = document.getElementById('peakAiSuggestions');
    var analysis = document.getElementById('peakAiAnalysis');
    if (!container || !analysis) return;
    if (!unit || !location) {
        container.innerHTML = '<p style="text-align:center; color:var(--gray-400); padding:20px;">🤖 املأ الحقول لعرض الاقتراحات</p>';
        analysis.textContent = '--';
        return;
    }
    var usedUnits = peakPlans.filter(function(p) { return p.status === 'active'; }).map(function(p) { return p.unit; });
    var availableUnits = PEAK_UNITS.filter(function(u) { return usedUnits.indexOf(u) === -1; });
    var html = '';
    if (availableUnits.length > 0) {
        html += '<div style="margin-bottom:8px; font-weight:600; font-size:0.8rem; color:var(--primary-700);"><i class="fas fa-lightbulb"></i> فرق متاحة بديلة:</div>';
        html += '<div style="display:flex; flex-wrap:wrap; gap:4px;">';
        availableUnits.slice(0, 5).forEach(function(u) {
            html += '<span style="padding:3px 8px; background:var(--teal-50); color:var(--teal); border-radius:12px; font-size:0.75rem; cursor:pointer;" onclick="document.getElementById(\'peakUnit\').value=\'' + u + '\'">' + u + '</span>';
        });
        html += '</div>';
    }
    var sameAreaPlans = peakPlans.filter(function(p) { return p.status === 'active' && p.location && location && p.location.indexOf(location) !== -1; });
    if (sameAreaPlans.length > 0) {
        html += '<div style="margin-top:8px; font-size:0.75rem; color:var(--gold);"><i class="fas fa-exclamation-triangle"></i> يوجد ' + sameAreaPlans.length + ' تمركز في نفس المنطقة</div>';
    }
    container.innerHTML = html || '<p style="text-align:center; color:var(--gray-400); padding:10px;">جميع الفرق مشغولة</p>';
    analysis.textContent = '💡 تحليل: ' + usedUnits.length + ' فرق مشغولة من ' + PEAK_UNITS.length + ' | ' + availableUnits.length + ' فرق متاحة';
}

// Add listeners to form fields for AI suggestions
setTimeout(function() {
    var unitEl = document.getElementById('peakUnit');
    var locEl = document.getElementById('peakLocation');
    if (unitEl) unitEl.addEventListener('change', updatePeakAiSuggestions);
    if (locEl) locEl.addEventListener('input', updatePeakAiSuggestions);
}, 1000);

// ----- Archive -----
function renderPeakArchive() {
    var container = document.getElementById('peakArchiveList');
    if (!container) return;
    var search = (document.getElementById('peakArchiveSearch') || {}).value || '';
    var filter = (document.getElementById('peakArchiveFilter') || {}).value || 'all';
    var archived = peakPlans.filter(function(p) {
        if (p.status === 'active') return false;
        if (filter !== 'all' && p.planType !== filter) return false;
        if (search && p.title.indexOf(search) === -1 && p.unit.indexOf(search) === -1) return false;
        return true;
    });
    if (archived.length === 0) {
        container.innerHTML = '<p style="text-align:center; color:var(--gray-400); padding:20px;">📭 لا توجد سجلات</p>';
        return;
    }
    var html = '';
    archived.forEach(function(plan) {
        var pt = PEAK_PLAN_TYPES[plan.planType] || PEAK_PLAN_TYPES.peak;
        var statusBadge = plan.status === 'completed' ? '<span class="peak-status-badge peak-status-arrived">✅ منتهي</span>' : '<span class="peak-status-badge peak-status-active">🟡 ملغى</span>';
        html += '<div class="peak-archive-item">';
        html += '<div><div style="font-weight:600; font-size:0.85rem;">' + pt.icon + ' ' + plan.title + '</div>';
        html += '<div style="font-size:0.75rem; color:var(--gray-500);">🚑 ' + plan.unit + ' | ' + (plan.location || '-') + '</div>';
        html += '<div style="font-size:0.75rem; color:var(--gray-500);">⏰ ' + (plan.startTime ? TimeRiyadh.formatDateTime(plan.startTime) : '-') + '</div></div>';
        html += '<div style="display:flex; flex-direction:column; align-items:flex-end; gap:4px;">' + statusBadge;
        html += '<span class="peak-badge peak-badge-type-' + plan.planType + '">' + pt.label + '</span></div>';
        html += '</div>';
    });
    container.innerHTML = html;
}

function searchPeakArchive() { renderPeakArchive(); }
function filterPeakArchive() { renderPeakArchive(); }

function exportPeakArchive() {
    var csv = 'العنوان,النوع,الفرقة,التصنيف,الموقع,البداية,النهاية,الحالة\n';
    peakPlans.forEach(function(p) {
        var pt = PEAK_PLAN_TYPES[p.planType] || PEAK_PLAN_TYPES.peak;
        csv += (p.title || '') + ',' + pt.label + ',' + (p.unit || '') + ',' + (PEAK_TEAM_TYPES[p.teamType] || '') + ',' + (p.location || '') + ',' + (p.startTime ? TimeRiyadh.formatDateTime(p.startTime) : '') + ',' + (p.endTime ? TimeRiyadh.formatDateTime(p.endTime) : '') + ',' + (p.status === 'active' ? 'نشط' : 'منتهي') + '\n';
    });
    var blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    var link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'تمركزات_' + getSaudiDate() /* تاريخ الرياض لاسم الملف (كان UTC) */ + '.csv';
    link.click();
    showToast('✅ تم التصدير', 'success');
}

// ----- التحميل الأولي من الخادم -----
// كنس الخطط المنتهية انتقل إلى الخدمة (PositioningService.list) — لا منطق تشغيلي في الواجهة
// AuthGate: التحميل الأولي عند المصادقة فقط — لا جلب قبل تسجيل الدخول
AuthGate.onStart(function() { loadPeakPlans(); });

// Update the sidebar button
var sidebarPeak = document.getElementById('sidebarPeak');
if (sidebarPeak) sidebarPeak.onclick = function() { toggleSidebar(); openPeakTimeModal(); };

// ============================================================
// Executive Navigation: تمييز الصفحة الحالية بمؤشر هادئ (active).
// المطابقة من مسار الصفحة الحالية مقابل أهداف navigateToPage —
// عرض فقط، بلا أي تغيير في الروابط أو المنطق.
// ============================================================
(function markActiveSidebarItem() {
    var path = (window.location.pathname || '').toLowerCase();
    var isHome = path.endsWith('/') || path.endsWith('index.html');
    var items = document.querySelectorAll('.smart-sidebar .sidebar-item');
    for (var i = 0; i < items.length; i++) {
        var item = items[i];
        var onclick = item.getAttribute('onclick') || '';
        var m = onclick.match(/navigateToPage\('([^'?]+)/);
        var target = m ? m[1].toLowerCase() : '';
        if ((isHome && item.id === 'sidebarHomeItem') || (target && path.endsWith(target))) {
            item.classList.add('active');
            item.setAttribute('aria-current', 'page');
        }
    }
})();


// ============================================================
// الشريط الجانبي الذكي — مؤشرات حالة حية على عناصر القائمة.
// البيانات من نفس تصنيف مركز القرار (renderOperationalFocus)
// ومن عداد البلاغات القائم — صفر حساب محلي جديد.
// ============================================================
function updateSidebarIndicators(critical, monitor) {
    var sev = (critical == null) ? '' : (critical > 0 ? 'red' : (monitor > 0 ? 'yellow' : 'green'));
    ['sbStatusCompletion', 'sbStatusOps'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.className = 'sidebar-item-status' + (sev ? ' ' + sev : '');
    });
}

function updateSidebarReportsBadge(total) {
    var el = document.getElementById('sbBadgeReports');
    if (!el) return;
    el.textContent = total;
    el.style.display = (typeof total === 'number' && total > 0) ? '' : 'none';
}

// مرآة شارة الدردشة القائمة (#chatBadge) إلى عنصر «الرسائل» — عرض فقط
(function mirrorChatBadge() {
    var src = document.getElementById('chatBadge');
    var dst = document.getElementById('sbBadgeChat');
    if (!src || !dst || typeof MutationObserver === 'undefined') return;
    function sync() {
        var n = parseInt(src.textContent, 10) || 0;
        var visible = src.style.display !== 'none' && n > 0;
        dst.textContent = src.textContent;
        dst.style.display = visible ? '' : 'none';
    }
    new MutationObserver(sync).observe(src, { childList: true, attributes: true, attributeFilter: ['style'] });
    sync();
})();


// ============================================================
// المنطقة 2: شريط الموارد المتاحة — تغطية/دعم/مركبات.
// كل قيمة من مصدر خادم قائم: كائن workforce (مرآة staffing/state)،
// /api/staffing/available-support، /api/vehicles/indicators.
// صفر حساب محلي — تجميع عرض فقط لما اشتقّه الخادم.
// ============================================================
var lastWorkforce = null;
var resourcesSupport = null;   // null = لا مصدر بعد ⇒ الحالة الصادقة «—»
var resourcesVehicles = null;  // كذلك

function resEsc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function refreshResourcesAux() {
    if (!AuthManager.isLoggedIn()) {
        resourcesSupport = null;
        resourcesVehicles = null;
        renderResourcesStrip();
        return;
    }
    var qs = currentShiftId ? '?shift_id=' + encodeURIComponent(currentShiftId) : '';
    AuthManager.apiRequest('/api/staffing/available-support' + qs)
        .then(function(r) { return r.json(); })
        .then(function(d) { resourcesSupport = (d && d.success && Array.isArray(d.supporters)) ? d.supporters : null; })
        .catch(function() { resourcesSupport = null; })
        .then(function() { renderResourcesStrip(); });
    AuthManager.apiRequest('/api/vehicles/indicators' + qs)
        .then(function(r) { return r.json(); })
        .then(function(d) { resourcesVehicles = (d && d.success && d.vehiclesByStatus) ? d.vehiclesByStatus : null; })
        .catch(function() { resourcesVehicles = null; })
        .then(function() { renderResourcesStrip(); });
}

function renderResourcesStrip() {
    var covEl = document.getElementById('resCoverageValue');
    var supEl = document.getElementById('resSupportValue');
    var vehEl = document.getElementById('resVehiclesValue');
    if (!covEl && !supEl && !vehEl) return;

    // ① التغطية — readyTeams/requiredTeams كما اشتقّها الخادم حرفيًا
    if (covEl) {
        if (!lastWorkforce || lastWorkforce.requiredTeams == null) {
            covEl.textContent = '—';
            covEl.className = 'ops-resources-value';
        } else {
            var ready = lastWorkforce.readyTeams || 0;
            var req = lastWorkforce.requiredTeams || 0;
            covEl.textContent = ready + ' من ' + req + ' جاهزة';
            covEl.className = 'ops-resources-value' + (req > 0 ? (ready >= req ? ' ok' : ' warn') : '');
        }
    }

    // ② الدعم المتاح — قائمة الخادم كما هي (عدّ عرض فقط)
    if (supEl) {
        if (!resourcesSupport) {
            supEl.textContent = '—';
            supEl.className = 'ops-resources-value';
        } else {
            supEl.textContent = resourcesSupport.length === 0 ? 'لا دعم متاح' : resourcesSupport.length + ' متاح';
            supEl.className = 'ops-resources-value' + (resourcesSupport.length > 0 ? ' ok' : '');
        }
        renderResourcesSupportList();
    }

    // ③ المركبات — vehiclesByStatus المشتقة سيرفريًا من operational_events
    if (vehEl) {
        if (!resourcesVehicles) {
            vehEl.textContent = '—';
            vehEl.className = 'ops-resources-value';
        } else {
            var vs = resourcesVehicles;
            var active = vs.active || 0;
            var stopped = (vs.breakdown || 0) + (vs.out_of_service || 0);
            var reserve = vs.reserve || 0;
            var parts = [];
            if (active > 0 || stopped === 0) parts.push(active + ' عاملة');
            if (stopped > 0) parts.push(stopped + ' متوقفة');
            if (reserve > 0) parts.push(reserve + ' احتياط');
            if (!parts.length) parts.push('لا مركبات');
            vehEl.textContent = parts.join(' · ');
            vehEl.className = 'ops-resources-value' + (stopped > 0 ? ' warn' : (active > 0 ? ' ok' : ''));
        }
    }
}

var resourcesSupportListOpen = false;
function toggleResourcesSupportList() {
    resourcesSupportListOpen = !resourcesSupportListOpen;
    renderResourcesSupportList();
}

function renderResourcesSupportList() {
    var list = document.getElementById('resSupportList');
    var caret = document.getElementById('resSupportCaret');
    if (!list) return;
    if (caret) caret.classList.toggle('open', resourcesSupportListOpen);
    if (!resourcesSupportListOpen) { list.style.display = 'none'; return; }
    list.style.display = '';
    if (!resourcesSupport) {
        list.innerHTML = '<div class="ops-resources-support-empty">— بانتظار بيانات الدعم</div>';
        return;
    }
    if (resourcesSupport.length === 0) {
        list.innerHTML = '<div class="ops-resources-support-empty">لا توجد قوى متاحة للدعم حاليًا</div>';
        return;
    }
    var h = '';
    for (var i = 0; i < resourcesSupport.length; i++) {
        var s = resourcesSupport[i];
        var meta = [];
        if (s.jobTitle) meta.push(s.jobTitle);
        if (s.employeeCode) meta.push(s.employeeCode);
        if (s.sourceUnit) meta.push(s.sourceUnit);
        h += '<div class="ops-resources-supporter">'
           + '<span class="sup-name">' + resEsc(s.name) + '</span>'
           + '<span class="sup-meta">' + resEsc(meta.join(' · ')) + '</span>'
           + '</div>';
    }
    h += '<button class="ops-resources-support-cta" onclick="navigateToPage(\'radio-completion.html?v=41\')"><i class="fas fa-clipboard-list"></i> فتح التكميل لتنفيذ الدعم</button>';
    list.innerHTML = h;
}


// ============================================================
// المنطقة 3: شريط الأحداث النشطة — بلاغات/آخر حدث/إعلانات.
// البلاغات: نفس إجمالي توزيع البلاغات (distTotal) المعتمد.
// الخط الزمني والإعلانات: /api/timeline و/api/announcements
// (نفس مصدرَي «غرفة العمليات الذكية»). صفر حساب محلي —
// اختيار/عدّ عرض فقط، و«—» الصادقة عند غياب المصدر.
// ============================================================
var lastReportsTotal = null;
var eventsTimeline = null;
var eventsAnnouncements = null;

function refreshEventsAux() {
    if (!AuthManager.isLoggedIn()) {
        eventsTimeline = null;
        eventsAnnouncements = null;
        renderEventsStrip();
        return;
    }
    AuthManager.apiRequest('/api/timeline')
        .then(function(r) { return r.json(); })
        .then(function(d) { eventsTimeline = (d && d.success && Array.isArray(d.data)) ? d.data : null; })
        .catch(function() { eventsTimeline = null; })
        .then(function() { renderEventsStrip(); });
    AuthManager.apiRequest('/api/announcements')
        .then(function(r) { return r.json(); })
        .then(function(d) { eventsAnnouncements = (d && d.success && Array.isArray(d.data)) ? d.data : null; })
        .catch(function() { eventsAnnouncements = null; })
        .then(function() { renderEventsStrip(); });
}

function latestTimelineEvent(list) {
    // اختيار عرض فقط: الأحدث بتاريخ/وقت الخادم؛ آخر عنصر عند غياب التواريخ
    var best = null;
    for (var i = 0; i < list.length; i++) {
        var e = list[i];
        if (!e || !e.title) continue;
        if (!best) { best = e; continue; }
        var ke = String(e.date || '') + ' ' + String(e.time || '');
        var kb = String(best.date || '') + ' ' + String(best.time || '');
        if (ke >= kb) best = e;
    }
    return best || (list.length ? list[list.length - 1] : null);
}

function renderEventsStrip() {
    var repEl = document.getElementById('evReportsValue');
    var tlEl = document.getElementById('evTimelineValue');
    var anEl = document.getElementById('evAnnounceValue');
    if (!repEl && !tlEl && !anEl) return;

    // ① البلاغات — مرآة إجمالي التوزيع القائم
    if (repEl) {
        if (lastReportsTotal == null) {
            repEl.textContent = '—';
            repEl.className = 'ops-events-value';
        } else if (lastReportsTotal === 0) {
            repEl.textContent = 'لا بلاغات';
            repEl.className = 'ops-events-value';
        } else {
            repEl.textContent = lastReportsTotal + ' بلاغ';
            repEl.className = 'ops-events-value ok';
        }
    }

    // ② آخر حدث — من الخط الزمني
    if (tlEl) {
        if (!eventsTimeline) {
            tlEl.textContent = '—';
            tlEl.className = 'ops-events-value ops-events-value-wide';
        } else {
            var ev = latestTimelineEvent(eventsTimeline);
            if (!ev) {
                tlEl.textContent = 'لا أحداث';
                tlEl.className = 'ops-events-value ops-events-value-wide';
            } else {
                tlEl.textContent = ev.title + (ev.date ? ' · ' + ev.date : '');
                tlEl.className = 'ops-events-value ops-events-value-wide';
            }
        }
    }

    // ③ الإعلانات — العدد + وسم العاجل إن وُجد
    if (anEl) {
        if (!eventsAnnouncements) {
            anEl.textContent = '—';
            anEl.className = 'ops-events-value';
        } else if (eventsAnnouncements.length === 0) {
            anEl.textContent = 'لا إعلانات';
            anEl.className = 'ops-events-value';
        } else {
            var urgent = 0;
            for (var i = 0; i < eventsAnnouncements.length; i++) {
                if (eventsAnnouncements[i] && eventsAnnouncements[i].priority === 'urgent') urgent++;
            }
            anEl.textContent = eventsAnnouncements.length + ' إعلان' + (urgent ? ' · ' + urgent + ' عاجل' : '');
            anEl.className = 'ops-events-value' + (urgent ? ' warn' : '');
        }
    }
}

// ═══ بوابات صلاحيات العمليات — مرحلة ربط العمليات (معتمدة 2026-08-17) ═══
// الحسم خادمي: كل مسارات التنفيذ محمية بـ authorizePerm ← 403.
// هذا اللفّ ردع بصري موثّق لا حماية — يمنع المحاولة مبكرًا برسالة واضحة
// بعد تحميل الصلاحيات؛ وإن سبق النقرُ التحميلَ يحسم الخادم.
(function () {
    function opsGuard(name, perm) {
        var orig = window[name];
        if (typeof orig !== 'function') return;
        window[name] = function () {
            var st = window.__opsPermsState;
            if (st && st.loaded && !st.star && st.perms.indexOf(perm) === -1) {
                var msg = '⛔ لا تملك صلاحية: ' + perm;
                if (typeof showToast === 'function') showToast(msg, 'error'); else alert(msg);
                return Promise.resolve(false);
            }
            return orig.apply(this, arguments);
        };
    }
    document.addEventListener('DOMContentLoaded', function () {
        try {
            var token = (window.AuthCore && AuthCore.getToken) ? AuthCore.getToken() : (localStorage.getItem('auth_access_token') || localStorage.getItem('authToken'));
            if (!token) return;
            fetch('/api/auth/me', { headers: { 'Authorization': 'Bearer ' + token } })
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (d) {
                    if (!d || !d.success) return;
                    window.__opsPermsState = { loaded: true, perms: Array.isArray(d.permissions) ? d.permissions : [], star: d.permissions_star === true };
                    // التوزيع والتراجع
                    opsGuard('addReportToServer', 'ops.dispatch');
                    opsGuard('undoLastReport', 'ops.report_revert');
                    // النماذج الستة
                    opsGuard('saveIncident', 'ops.forms');
                    opsGuard('saveSenior', 'ops.forms');
                    opsGuard('saveAirAmbulance', 'ops.forms');
                    opsGuard('saveDailyReport', 'ops.forms');
                    opsGuard('saveE', 'ops.forms');
                    opsGuard('saveEscalation', 'ops.forms');
                    // التمركزات
                    opsGuard('savePeakPlan', 'ops.deployments');
                })
                .catch(function () { /* فشل القراءة: الحسم خادمي */ });
        } catch (_) { }
    });
})();
