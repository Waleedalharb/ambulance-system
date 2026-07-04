// ============================================
// نظام المستخدمين والمصادقة
// ============================================
var currentUser = null;
var authToken = localStorage.getItem('authToken') || null;

function showNotification(title, message, type, duration) {
    var container = document.getElementById('toastContainer');
    if (!container) { console.log('[' + type + '] ' + title + ': ' + message); return; }
    var toast = document.createElement('div');
    toast.className = 'toast-notification ' + (type || 'info');
    var iconMap = { success: '\u2713', error: '\u2715', warning: '\u26a0', info: '\u2139' };
    var icon = iconMap[type] || iconMap.info;
    toast.innerHTML = '<div class="toast-icon">' + icon + '</div><div class="toast-content"><div class="toast-title">' + (title || '') + '</div><div class="toast-message">' + message + '</div></div>';
    container.appendChild(toast);
    setTimeout(function() { toast.classList.add('toast-exit'); setTimeout(function() { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 300); }, duration || 3000);
    if (type === 'success' && typeof playSuccessSound === 'function') playSuccessSound();
    else if (type === 'error' && typeof playErrorSound === 'function') playErrorSound();
    else if (typeof playAlertSound === 'function') playAlertSound();
}

// ============================================
// نظام تسجيل الدخول (من inline.js)
// ============================================
document.addEventListener('DOMContentLoaded', function() {
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
            var res = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            var data = await res.json();
            if (data.success && data.token) {
                localStorage.setItem('authToken', data.token);
                localStorage.setItem('currentUser', JSON.stringify(data.user));
                currentUser = data.user;
                authToken = data.token;
                hideLogin();
                applyUserPermissions(data.user);
                if (userDisplay) userDisplay.textContent = (data.user.name || 'مستخدم') + ' (' + (data.user.role === 'admin' ? 'مدير' : data.user.role === 'director' ? 'مدير عمليات' : 'مستخدم') + ')';
                loadAllData();
            } else {
                loginError.textContent = data.error || 'فشل في تسجيل الدخول';
                loginError.style.display = 'block';
            }
        } catch (e) {
            loginError.textContent = 'خطأ في الاتصال بالسيرفر';
            loginError.style.display = 'block';
        }
    }

    function doLogout() {
        localStorage.removeItem('authToken');
        localStorage.removeItem('currentUser');
        currentUser = null;
        authToken = null;
        location.reload();
    }

    if (loginBtn) loginBtn.addEventListener('click', doLogin);
    if (logoutBtn) logoutBtn.addEventListener('click', doLogout);

    if (loginPassword) {
        loginPassword.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') doLogin();
        });
    }

    if (authToken) {
        fetch('/api/auth/me', { headers: { 'Authorization': 'Bearer ' + authToken } })
        .then(function(r) { return r.json(); })
        .then(function(data) {
            if (data.success) {
                currentUser = data.user;
                hideLogin();
                applyUserPermissions(data.user);
                if (userDisplay) userDisplay.textContent = (data.user.name || 'مستخدم') + ' (' + (data.user.role === 'admin' ? 'مدير' : data.user.role === 'director' ? 'مدير عمليات' : 'مستخدم') + ')';
                loadAllData();
            } else {
                showLogin();
            }
        })
        .catch(function() { showLogin(); });
    } else {
        showLogin();
    }
    
    // Update shift status immediately based on time (don't wait for server)
    updateShiftStatus();
});


// ============================================
// دوال الوقت السعودي (Asia/Riyadh)
// ============================================
var saudiFormatter = new Intl.DateTimeFormat('ar-SA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' });
var saudiTimeFormatter = new Intl.DateTimeFormat('ar-SA', { timeZone: 'Asia/Riyadh', hour: '2-digit', minute: '2-digit', second: '2-digit' });
var saudiFullFormatter = new Intl.DateTimeFormat('ar-SA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
var saudiDayFormatter = new Intl.DateTimeFormat('ar-SA', { timeZone: 'Asia/Riyadh', weekday: 'long' });
var sauditMonthYearFormatter = new Intl.DateTimeFormat('ar-SA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit' });

function getSaudiDate() {
    return saudiFormatter.format(new Date());
}
function getSaudiTime() {
    return saudiTimeFormatter.format(new Date());
}
function getSaudiDateTime() {
    return saudiFullFormatter.format(new Date());
}
function getSaudiDay() {
    return saudiDayFormatter.format(new Date());
}
function getSaudiMonthYear() {
    return sauditMonthYearFormatter.format(new Date());
}

// ============================================
// نظام النوبة التلقائي (Auto-Shift)
// ============================================
function getCurrentShiftType() {
    const now = new Date();
    // Get UTC time first, then add Saudi offset (+3)
    const utc = now.getTime() + (now.getTimezoneOffset() * 60 * 1000);
    const saudiTime = new Date(utc + (3 * 60 * 60 * 1000));
    const hour = saudiTime.getHours();
    // صباح: 05:00 - 17:00 | ليل: 17:00 - 05:00
    return (hour >= 5 && hour < 17) ? 'صباح' : 'ليل';
}

function getCurrentShiftDate() {
    const now = new Date();
    const utc = now.getTime() + (now.getTimezoneOffset() * 60 * 1000);
    const saudiTime = new Date(utc + (3 * 60 * 60 * 1000));
    const year = saudiTime.getFullYear();
    const month = saudiTime.getMonth();
    const day = saudiTime.getDate();
    const hour = saudiTime.getHours();
    
    let shiftDate = new Date(year, month, day);
    
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
// WebSocket - تحديث فوري
// ============================================
var ws = null;
var wsConnected = false;
var wsFallbackInterval = null;

function initWebSocket() {
    try {
        var protocol = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
        var wsUrl = protocol + window.location.host + '/ws';
        ws = new WebSocket(wsUrl);
        
        ws.onopen = function() {
            wsConnected = true;
            console.log('✅ WebSocket connected to', wsUrl);
            showNotification('متصل', 'تم الاتصال بالتحديثات الفورية', 'success', 2000);
            // إيقاف fallback عند الاتصال الناجح
            if (wsFallbackInterval) {
                clearInterval(wsFallbackInterval);
                wsFallbackInterval = null;
                console.log('🛑 Fallback interval stopped - WebSocket active');
            }
        };
        
        ws.onmessage = function(event) {
            try {
                var data = JSON.parse(event.data);
                handleWebSocketMessage(data);
            } catch(e) {
                console.error('WS parse error:', e);
            }
        };
        
        ws.onclose = function() {
            wsConnected = false;
            console.log('❌ WebSocket disconnected');
            // إعادة الاتصال بعد 5 ثواني
            setTimeout(initWebSocket, 5000);
            // تشغيل fallback إذا لم يكن يعمل
            if (!wsFallbackInterval) {
                startFallbackInterval();
            }
        };
        
        ws.onerror = function(err) {
            console.error('WebSocket error:', err);
        };
    } catch(e) {
        console.log('WebSocket not supported');
        // تشغيل fallback لو WebSocket غير مدعوم
        startFallbackInterval();
    }
}

function handleWebSocketMessage(data) {
    switch(data.type) {
        case 'new_report':
            showNotification('بلاغ جديد', data.message, 'info', 5000);
            refreshReports();
            break;
        case 'theme_updated':
            showNotification('تم التحديث', 'تم تحديث الثيم من قبل مشرف آخر', 'info', 3000);
            applyGlobalTheme();
            break;
        case 'connected':
            console.log('WS:', data.message);
            break;
    }
}

function refreshReports() {
    loadAllData();
}

// ============================================
// Fallback - تحديث دوري لو WebSocket غير متوفر
// ============================================
function startFallbackInterval() {
    if (wsFallbackInterval) return;
    console.log('⏱️ Starting fallback polling (30s)');
    wsFallbackInterval = setInterval(function() {
        if (!wsConnected) {
            console.log('🔄 Fallback: refreshing data...');
            loadAllData();
            applyGlobalTheme();
        }
    }, 30000);
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
        var response = await fetch('/api/remove-theme', { method: 'DELETE' });
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
    var el_analyticsModal_d3 = document.getElementById('analyticsModal'); if (el_analyticsModal_d3) el_analyticsModal_d3.style.display = 'flex';
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
    
    var colors = ['#e8f5e9', '#c8e6c9', '#a5d6a7', '#81c784', '#66bb6a', '#ffb74d', '#ffa726', '#f57c00', '#e57373', '#c62828'];
    
    for (var hour = 0; hour < 24; hour++) {
        var cell = document.createElement('div');
        cell.className = 'heatmap-cell';
        cell.setAttribute('data-hour', hour + ':00');
        
        var intensity = Math.floor(Math.random() * 10);
        cell.style.background = colors[intensity] || colors[0];
        
        grid.appendChild(cell);
    }
}

function renderPeakPrediction() {
    var container = document.getElementById('peakPrediction');
    if (!container) return;
    
    var now = new Date();
    var hour = now.getHours();
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

var auditLog = JSON.parse(localStorage.getItem('auditLog') || '[]');
var currentAuditFilter = 'all';

var el_auditLogBtn=document.getElementById("auditLogBtn");if(el_auditLogBtn)el_auditLogBtn.addEventListener('click', function() {
    var el_auditLogModal_d4 = document.getElementById('auditLogModal'); if (el_auditLogModal_d4) el_auditLogModal_d4.style.display = 'flex';
    renderAuditLog();
});

function addAuditEntry(type, action, detail, user) {
    var entry = {
        id: Date.now().toString(),
        type: type || 'system',
        action: action || '',
        detail: detail || '',
        user: user || 'المشرف',
        timestamp: new Date().toISOString()
    };

    auditLog.unshift(entry);
    if (auditLog.length > 200) auditLog = auditLog.slice(0, 200);

    localStorage.setItem('auditLog', JSON.stringify(auditLog));
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

        html +=
            '<div class="audit-entry">' +
                '<span class="audit-time">' + timeStr + '</span>' +
                '<span class="audit-icon ' + entry.type + '">' + (icons[entry.type] || '&#x2699;&#xFE0F;') + '</span>' +
                '<div class="audit-content">' +
                    '<div class="audit-action">' + entry.action + '</div>' +
                    '<div class="audit-detail">' + entry.detail + '</div>' +
                '</div>' +
                '<span class="audit-user">' + entry.user + '</span>' +
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
    localStorage.removeItem('auditLog');
    renderAuditLog();
    showNotification('تم المسح', 'تم مسح سجل العمليات بنجاح', 'success', 2000);
}

function openAuditLogModal() {
    var el = document.getElementById('auditLogModal');
    if (el) el.style.display = 'flex';
    renderAuditLog();
}

function closeAuditLogModal() {
    var el = document.getElementById('auditLogModal');
    if (el) el.style.display = 'none';
}

function refreshAuditLog() {
    auditLog = JSON.parse(localStorage.getItem('auditLog') || '[]');
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
    link.download = 'سجل_العمليات_' + new Date().toISOString().slice(0, 10) + '.csv';
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
            addAuditEntry('shift', 'بدء مناوبة جديدة', '', 'المشرف');
            return result;
        };
    }

    // تسجيل البلاغات
    var origAddReport = addReportToServer;
    if (typeof addReportToServer === 'function') {
        addReportToServer = function(center, unit) {
            var result = origAddReport.apply(this, arguments);
            addAuditEntry('report', 'تسجيل بلاغ', center + ' - ' + unit, 'المشرف');
            return result;
        };
    }

    // تسجيل تلقائي عند فتح الخريطة
    var mapBtn = document.getElementById('mapBtn');
    if (mapBtn) {
        mapBtn.addEventListener('click', function() {
            gamificationStats.mapOpens = (gamificationStats.mapOpens || 0) + 1;
            localStorage.setItem('gamificationStats', JSON.stringify(gamificationStats));
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

function goToPeakTime() {
    var el_alertBar_d6 = document.getElementById('alertBar'); if (el_alertBar_d6) el_alertBar_d6.style.display = 'none';
    openPeakTimeModal();
}

function checkForAlerts() {
    fetch('/api/peak-data', { headers: { 'Authorization': 'Bearer ' + authToken } })
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

    var el_peakAlertModal_d8 = document.getElementById('peakAlertModal'); if (el_peakAlertModal_d8) el_peakAlertModal_d8.style.display = 'flex';

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
    var el_peakAlertModal_d9 = document.getElementById('peakAlertModal'); if (el_peakAlertModal_d9) el_peakAlertModal_d9.style.display = 'none';
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
    var el_peakMapModal_d10 = document.getElementById('peakMapModal'); if (el_peakMapModal_d10) el_peakMapModal_d10.style.display = 'flex';
    setTimeout(initPeakMap, 500);
}

function closePeakMap() {
    var el_peakMapModal_d11 = document.getElementById('peakMapModal'); if (el_peakMapModal_d11) el_peakMapModal_d11.style.display = 'none';
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
function renderAdvancedDistribution() {
    var container = document.getElementById('distributionContainer');
    if (!container) return;
    container.innerHTML = '';
    container.className = 'distribution-advanced';
    
    var allReports = reports || {};
    
    for (var center in centersData) {
        var sectorDiv = document.createElement('div');
        sectorDiv.className = 'distribution-sector-card';
        
        var totalSectorReports = 0;
        var sectorUnits = centersData[center] || [];
        
        for (var i = 0; i < sectorUnits.length; i++) {
            var unit = sectorUnits[i];
            var key = center + '|' + unit;
            if (allReports[key] && allReports[key].count) {
                totalSectorReports += allReports[key].count;
            }
        }
        
        var headerHtml = '<div class="distribution-sector-header">' +
            '<span class="sector-name"><i class="fas fa-map-pin" style="color:var(--primary-500);"></i> ' + center + '</span>' +
            '<span class="sector-total">📊 ' + totalSectorReports + '</span>' +
            '</div>';
        
        var gridHtml = '<div class="distribution-unit-grid">';
        for (var j = 0; j < sectorUnits.length; j++) {
            var unit2 = sectorUnits[j];
            var key2 = center + '|' + unit2;
            var info = allReports[key2] || { count: 0, times: [] };
            var isZero = info.count === 0;
            var location = unitLocationAddresses[unit2] || 'لم يتم تحديد موقع';
            
            gridHtml += '<div class="distribution-unit-item" id="unit-' + center.replace(/\s/g, '') + '-' + unit2.replace(/\s/g, '') + '">' +
                (info.count > 0 ? '<span class="unit-badge">' + info.count + '</span>' : '') +
                '<div class="unit-name">' + unit2 + '</div>' +
                '<div class="unit-count ' + (isZero ? 'zero' : '') + '" id="count-' + center.replace(/\s/g, '') + '-' + unit2.replace(/\s/g, '') + '">' + info.count + '</div>' +
                '<div class="unit-actions">' +
                '<button class="btn btn-primary report-btn" style="padding:2px 8px; font-size:0.55rem; border-radius:12px;" data-center="' + center + '" data-unit="' + unit2 + '"><i class="fas fa-plus-circle"></i></button>' +
                (info.count > 0 ? '<button class="btn btn-coral undo-btn" style="padding:2px 8px; font-size:0.55rem; border-radius:12px; display:inline-flex;" data-center="' + center + '" data-unit="' + unit2 + '"><i class="fas fa-undo-alt"></i></button>' : '<button class="btn btn-coral undo-btn" style="padding:2px 8px; font-size:0.55rem; border-radius:12px; display:none;" data-center="' + center + '" data-unit="' + unit2 + '"><i class="fas fa-undo-alt"></i></button>') +
                '<button class="btn btn-outline preview-btn" style="padding:2px 8px; font-size:0.55rem; border-radius:12px;" data-unit="' + unit2 + '" data-location="' + location + '"><i class="fas fa-map-marker-alt"></i></button>' +
                '</div>' +
                '</div>';
        }
        gridHtml += '</div>';
        
        sectorDiv.innerHTML = headerHtml + gridHtml;
        container.appendChild(sectorDiv);
        
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

// إحداثيات الفرق حسب المركز [lat, lng]
var unitLocations = {
    "جاكسو": {
        "جنوب 12": [24.6234, 46.7256]
    },
    "المنصورة": {
        "جنوب 2": [24.6789, 46.7123],
        "جنوب 16": [24.6812, 46.7198],
        "سريع 4": [24.6756, 46.7089]
    },
    "الشيخ زايد": {
        "جنوب 3": [24.7234, 46.6845],
        "جنوب 19": [24.7289, 46.6912]
    },
    "حي الواحات": {
        "جنوب 11": [24.7123, 46.7567]
    },
    "المناخ": {
        "جنوب 10": [24.6987, 46.7321]
    },
    "المريوطية": {
        "جنوب 8": [24.6543, 46.6789]
    },
    "طرة": {
        "جنوب 7": [24.6678, 46.7234]
    },
    "مطرية": {
        "جنوب 14": [24.6890, 46.7456]
    },
    "البساتين": {
        "جنوب 5": [24.7345, 46.7234]
    },
    "الخليفة": {
        "جنوب 13": [24.6456, 46.7123]
    },
    "الشفاء": {
        "جنوب 6": [24.7456, 46.6890],
        "جنوب 17": [24.7512, 46.6945],
        "سريع 2": [24.7398, 46.6834],
        "سريع 3": [24.7489, 46.6876]
    },
    "عكاظ": {
        "جنوب 9": [24.6890, 46.7678]
    },
    "الدار البيضاء": {
        "جنوب 4": [24.7567, 46.7123],
        "جنوب 15": [24.7623, 46.7189]
    },
    "طريق الملك فهد": {
        "جنوب 1": [24.7890, 46.6890],
        "جنوب 18": [24.7956, 46.6956]
    },
    "مستشفى الملك خالد": {
        "سريع 1": [24.7345, 46.7012]
    }
};

var map = null;
var mapMarkers = [];

function openMapPreview(unit, location) {
    var modal = document.getElementById('mapModal');
    var el_mapModalTitle = document.getElementById('mapModalTitle'); if (el_mapModalTitle) el_mapModalTitle.innerText = '📍 معاينة موقع ' + unit;
    var el_mapLocationText = document.getElementById('mapLocationText'); if (el_mapLocationText) el_mapLocationText.innerText = '📍 الموقع: ' + location;
    var el_nearestUnitResult_h3 = document.getElementById('nearestUnitResult'); if (el_nearestUnitResult_h3) el_nearestUnitResult_h3.innerHTML = '';
    modal.style.display = 'flex';

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
    var el_mapModal_d13 = document.getElementById('mapModal'); if (el_mapModal_d13) el_mapModal_d13.style.display = 'none';
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
    var el_distributionModal_d14 = document.getElementById('distributionModal'); if (el_distributionModal_d14) el_distributionModal_d14.style.display = 'flex';
    renderAdvancedDistribution();
});

// ============================================
// المؤشرات الأساسية
// ============================================
var centersData = {};
var reports = {};
var lastKnownUpdate = 0;
var currentShiftId = null;
var allShifts = [];
var isViewingArchiveShift = false;
var currentViewingShift = null;
var viewingShiftId = null;
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
var airRecords = [];

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
        var response = await fetch('/api/data', { headers: { 'Authorization': 'Bearer ' + authToken } });
        var result = await response.json();
        centersData = result.centers;
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
        updateShiftStatus();
        document.getElementById("updateStatus").innerHTML = "🟢 متصل | آخر تحديث: " + getSaudiTime();
        
        // تحديث الإنجازات ولوحة الصدارة
        var el_achievementsModal_d15 = document.getElementById('achievementsModal');
        if (el_achievementsModal_d15 && el_achievementsModal_d15.style.display == 'flex') {
            renderAchievements();
            renderLeaderboard();
        }
    } catch (error) {
        console.error('خطأ في تحميل البيانات:', error);
    }
}

function updateTotal() {
    var total = 0;
    for (var key in reports) { if (reports[key] && reports[key].count) total += reports[key].count; }
    var grandTotalEl = document.getElementById("grandTotal");
    if (grandTotalEl) grandTotalEl.innerText = total;
}

function updateShiftStatus() {
    var status = document.getElementById('shiftStatus');
    var btn = document.getElementById('newShiftBtn');
    var btnDot = document.getElementById('newShiftDot');
    var btnText = document.getElementById('newShiftText');
    
    if (status) status.style.display = 'none';
    
    if (!btn || !btnDot || !btnText) return;
    
    // Always show current time-based shift type
    var currentType = getCurrentShiftType ? getCurrentShiftType() : 'صباح';
    
    // Update quick-action current shift button too
    var currentShiftBtn = document.getElementById('currentShiftBtn');
    var currentShiftDisplay = document.getElementById('currentShiftDisplay');
    if (currentShiftDisplay) {
        var nowTime = getSaudiTime ? getSaudiTime() : '';
        currentShiftDisplay.innerHTML = '<span style="font-size:0.8rem; opacity:0.8;">' + nowTime + '</span><br><strong>' + (currentShiftId ? 'مناوبة نشطة' : currentType) + '</strong>';
    }
    if (currentShiftBtn) { currentShiftBtn.disabled = false; currentShiftBtn.style.cursor = 'pointer'; }
    
    // Enable the newShiftBtn so it's clickable (was disabled in HTML)
    if (btn) { btn.disabled = false; btn.style.cursor = 'pointer'; btn.style.opacity = '1'; }
    
    if (currentShiftId) {
        var shift = allShifts.find(function(s) { return s.id === currentShiftId; });
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
    
    updateShiftsHistoryWidget();
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
}

function openShiftArchiveModal() {
    var el_shiftArchiveModal_d16 = document.getElementById('shiftArchiveModal'); if (el_shiftArchiveModal_d16) el_shiftArchiveModal_d16.style.display = 'flex';
    updateShiftsHistoryWidget();
    clearArchiveSummary();
}

function clearArchiveSummary() {
    var area = document.getElementById('archiveSummaryArea');
    if (area) area.style.display = 'none';
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
    var url = 'radio-completion.html?v=17';
    if (shiftDate) {
        url += '&date=' + encodeURIComponent(shiftDate) + '&type=' + encodeURIComponent(shiftType);
    }
    window.location.href = url;
}

function viewSelectedArchiveShift() {
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
    
    // Show summary inline
    var area = document.getElementById('archiveSummaryArea');
    if (area) area.style.display = 'block';
    
    // Update title
    var title = document.getElementById('archiveSummaryTitle');
    if (title) {
        var typeLabel = (shift.shiftType === 'صباحية' || shift.shiftType === 'morning' || shift.shiftType === 'صباح') ? 'صباحي' : 'ليلي';
        title.textContent = 'ملخص المناوبة — ' + typeLabel + ' ' + (shift.shiftDate || '');
    }
    
    // Build stats grid
    var statsGrid = document.getElementById('archiveStatsGrid');
    if (statsGrid) {
        // Calculate counts from shift completion data if available
        var ready = 0, missing = 0, offline = 0, pending = 0;
        var totalReports = shift.totalReports || 0;
        
        // Try to get completion data from shift.centersData
        if (shift.centersData) {
            Object.keys(shift.centersData).forEach(function(team) {
                var data = shift.centersData[team];
                if (data) {
                    // Infer status from data
                    if (data.staffCount && parseInt(data.staffCount) > 0) ready++;
                    else if (data.vehicleStatus === 'offline' || data.vehicleStatus === 'عاطلة') offline++;
                    else missing++;
                }
            });
        }
        
        statsGrid.innerHTML = 
            '<div style="background:var(--green-50); border-radius:8px; padding:12px; text-align:center;"><div style="font-size:1.8rem; font-weight:700; color:var(--green);">' + ready + '</div><div style="font-size:0.75rem; color:var(--gray-600);">✅ جاهز</div></div>' +
            '<div style="background:var(--yellow-50); border-radius:8px; padding:12px; text-align:center;"><div style="font-size:1.8rem; font-weight:700; color:var(--gold);">' + missing + '</div><div style="font-size:0.75rem; color:var(--gray-600);">⚠️ ناقص</div></div>' +
            '<div style="background:var(--red-50); border-radius:8px; padding:12px; text-align:center;"><div style="font-size:1.8rem; font-weight:700; color:var(--red);">' + offline + '</div><div style="font-size:0.75rem; color:var(--gray-600);">🔴 خارج الخدمة</div></div>';
    }
    
    // Reports stats
    var reportsStats = document.getElementById('archiveReportsStats');
    if (reportsStats) {
        var totalReports = shift.totalReports || 0;
        var reportsHtml = '<div style="display:grid; grid-template-columns:repeat(2,1fr); gap:8px;">' +
            '<div><strong>إجمالي البلاغات:</strong> ' + totalReports + '</div>';
        
        // Top unit
        var topUnit = '-';
        var topCount = 0;
        if (shift.savedReports) {
            Object.keys(shift.savedReports).forEach(function(key) {
                var r = shift.savedReports[key];
                if (r && r.count > topCount) {
                    topCount = r.count;
                    topUnit = key.split('|')[1] || key;
                }
            });
        }
        reportsHtml += '<div><strong>أكثر فرقة:</strong> ' + topUnit + ' (' + topCount + ')</div>';
        reportsHtml += '</div>';
        reportsStats.innerHTML = reportsHtml;
    }
    
    // Notes
    var notesContent = document.getElementById('archiveNotesContent');
    if (notesContent) {
        notesContent.textContent = shift.generalNotes || '—';
    }
    
    // Also try to fetch completion data from server for more accurate stats
    var token = localStorage.getItem('authToken');
    if (token && shift.shiftDate && shift.shiftType) {
        var shiftTypeNorm = (shift.shiftType === 'صباحية' || shift.shiftType === 'morning' || shift.shiftType === 'صباح') ? 'صباح' : 'ليل';
        fetch('/api/shift-completion/latest?shiftDate=' + encodeURIComponent(shift.shiftDate) + '&shiftType=' + encodeURIComponent(shiftTypeNorm), {
            headers: { 'Authorization': 'Bearer ' + token }
        })
        .then(function(r) { return r.json(); })
        .then(function(result) {
            if (result.success && result.completion && result.completion.teams) {
                var teams = result.completion.teams;
                var ready = 0, missing = 0, offline = 0;
                Object.keys(teams).forEach(function(k) {
                    var st = teams[k].status;
                    if (st === 'ready') ready++;
                    else if (st === 'missing') missing++;
                    else if (st === 'offline') offline++;
                });
                if (statsGrid) {
                    statsGrid.innerHTML = 
                        '<div style="background:var(--green-50); border-radius:8px; padding:12px; text-align:center;"><div style="font-size:1.8rem; font-weight:700; color:var(--green);">' + ready + '</div><div style="font-size:0.75rem; color:var(--gray-600);">✅ جاهز</div></div>' +
                        '<div style="background:var(--yellow-50); border-radius:8px; padding:12px; text-align:center;"><div style="font-size:1.8rem; font-weight:700; color:var(--gold);">' + missing + '</div><div style="font-size:0.75rem; color:var(--gray-600);">⚠️ ناقص</div></div>' +
                        '<div style="background:var(--red-50); border-radius:8px; padding:12px; text-align:center;"><div style="font-size:1.8rem; font-weight:700; color:var(--red);">' + offline + '</div><div style="font-size:0.75rem; color:var(--gray-600);">🔴 خارج الخدمة</div></div>';
                }
                if (notesContent && result.completion.notes) {
                    notesContent.textContent = result.completion.notes;
                }
            }
        })
        .catch(function(e) { console.log('No completion data for this shift'); });
    }
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
    fetch('/api/shifts/' + shiftIdNum, { headers: { 'Authorization': 'Bearer ' + authToken } })
        .then(function(r) { return r.json(); })
        .then(function(result) {
            if (result.shift) {
                // Update global data
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
    var listContainer = document.getElementById('liveUnitList');
    listContainer.innerHTML = '';
    if (sortedUnits.length === 0) {
        listContainer.innerHTML = '<div class="distribution-empty"><i class="fas fa-inbox"></i><span>لا توجد بيانات</span></div>';
        return;
    }
    var colors = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#64748B', '#EC4899'];
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
    // ═══ مزامنة بيانات إدخال بلاغات الفرق ═══
    syncReportEntryData();
}

// ============================================
// مزامنة بيانات إدخال بلاغات الفرق
// ============================================
function syncReportEntryData() {
    try {
        var stored = localStorage.getItem('reportEntryRecords');
        if (!stored) return;
        var records = JSON.parse(stored);
        if (!records || !records.length) return;
        var today = new Date().toISOString().split('T')[0];
        var todayRecords = records.filter(function(r) { return r.date === today; });
        if (todayRecords.length === 0) return;
        // دمج مع البيانات الموجودة
        var entryTotal = todayRecords.length;
        var entryUnitStats = {};
        todayRecords.forEach(function(r) {
            if (r.unit) {
                entryUnitStats[r.unit] = (entryUnitStats[r.unit] || 0) + 1;
            }
        });
        // تحديث الإجمالي
        var totalEl = document.getElementById('liveTotalReports');
        if (totalEl) {
            var currentTotal = parseInt(totalEl.innerText) || 0;
            totalEl.innerText = currentTotal + entryTotal;
        }
        // تحديث قائمة الفرق
        var listContainer = document.getElementById('liveUnitList');
        if (listContainer && Object.keys(entryUnitStats).length > 0) {
            var syncHeader = document.createElement('div');
            syncHeader.className = 'live-report-sync-header';
            syncHeader.innerHTML = '<i class="fas fa-clipboard-check"></i><span>من نظام إدخال البلاغات (' + entryTotal + ')</span>';
            listContainer.appendChild(syncHeader);
            Object.entries(entryUnitStats).sort(function(a,b){return b[1]-a[1];}).forEach(function(item, index){
                var div = document.createElement('div');
                div.className = 'distribution-item';
                div.style.borderLeft = '3px solid var(--teal)';
                div.innerHTML = '<div class="distribution-item-rank rank-other"><i class="fas fa-check" style="font-size:0.6rem;"></i></div>' +
                    '<div class="distribution-item-info">' +
                        '<div class="distribution-item-name" style="color:var(--teal);">' + item[0] + '</div>' +
                        '<div class="distribution-item-bar-track">' +
                            '<div class="distribution-item-bar-fill" style="width:100%; background:linear-gradient(90deg, var(--teal), #34D399);"></div>' +
                        '</div>' +
                    '</div>' +
                    '<div class="distribution-item-meta">' +
                        '<span class="distribution-item-count" style="color:var(--teal);">' + item[1] + '</span>' +
                        '<span class="distribution-item-percent">جديد</span>' +
                    '</div>';
                listContainer.appendChild(div);
            });
        }
    } catch(e) { console.log('Report Entry sync error:', e); }
}

// ============================================
// مؤشرات القوى العاملة
// ============================================
function updateWorkforceStats() {
    var shiftData = null;
    if (currentShiftId) {
        var shift = allShifts.find(function(s) { return s.id === currentShiftId; });
        if (shift && shift.centersData) {
            shiftData = shift.centersData;
        }
    }
    
    if (shiftData && Object.keys(shiftData).length > 0) {
        updateWorkforceFromShiftData(shiftData);
        return;
    }
    
    var totalUnits = 0;
    for (var center in centersData) {
        totalUnits += centersData[center].length;
    }
    var totalStaff = totalUnits * 2 + Math.floor(Math.random() * 10);
    var totalCars = totalUnits + Math.floor(Math.random() * 5);
    var readiness = Math.floor(Math.random() * 30 + 70);
    var missingCenters = Math.floor(Math.random() * 5);
    
    updateWorkforceDisplay(totalStaff, totalCars, readiness, missingCenters);
}

function updateWorkforceFromShiftData(shiftData) {
    var totalStaff = 0;
    var totalCars = 0;
    var readyCenters = 0;
    var missingCenters = 0;
    var centerCount = 0;
    
    for (var center in shiftData) {
        var data = shiftData[center];
        var staff = parseInt(data.staffCount) || 0;
        var cars = parseInt(data.carsCount) || 0;
        totalStaff += staff;
        totalCars += cars;
        centerCount++;
        if (staff >= 2 && cars >= 1) {
            readyCenters++;
        } else {
            missingCenters++;
        }
    }
    
    var readiness = centerCount > 0 ? Math.round((readyCenters / centerCount) * 100) : 0;
    updateWorkforceDisplay(totalStaff, totalCars, readiness, missingCenters);
}

function updateWorkforceDisplay(totalStaff, totalCars, readiness, missingCenters) {
    animateValue('wfTotalStaff', totalStaff);
    animateValue('wfTotalCars', totalCars);
    var el_wfReadiness = document.getElementById('wfReadiness'); if (el_wfReadiness) el_wfReadiness.innerText = readiness + '%';
    var el_wfMissingCenters = document.getElementById('wfMissingCenters'); if (el_wfMissingCenters) el_wfMissingCenters.innerText = missingCenters;
    
    var staffPct = Math.min((totalStaff / 30) * 100, 100);
    var carsPct = Math.min((totalCars / 20) * 100, 100);
    var missingPct = Math.min((missingCenters / 10) * 100, 100);
    
    var el_wfStaffProgress = document.getElementById('wfStaffProgress'); if (el_wfStaffProgress) el_wfStaffProgress.style.width = staffPct + '%';
    var el_wfCarsProgress = document.getElementById('wfCarsProgress'); if (el_wfCarsProgress) el_wfCarsProgress.style.width = carsPct + '%';
    var el_wfReadinessProgress = document.getElementById('wfReadinessProgress'); if (el_wfReadinessProgress) el_wfReadinessProgress.style.width = readiness + '%';
    var el_wfMissingProgress = document.getElementById('wfMissingProgress'); if (el_wfMissingProgress) el_wfMissingProgress.style.width = missingPct + '%';
    
    var el_wfStaffProgressText = document.getElementById('wfStaffProgressText'); if (el_wfStaffProgressText) el_wfStaffProgressText.innerText = totalStaff + ' / 30 هدف';
    var el_wfCarsProgressText = document.getElementById('wfCarsProgressText'); if (el_wfCarsProgressText) el_wfCarsProgressText.innerText = totalCars + ' / 20 هدف';
    var el_wfReadinessProgressText = document.getElementById('wfReadinessProgressText'); if (el_wfReadinessProgressText) el_wfReadinessProgressText.innerText = readiness + '% جاهز';
    var el_wfMissingProgressText = document.getElementById('wfMissingProgressText'); if (el_wfMissingProgressText) el_wfMissingProgressText.innerText = missingCenters + ' / 10 مركز';
    
    updateTrend('wfStaffTrend', totalStaff, 20);
    updateTrend('wfCarsTrend', totalCars, 15);
    updateTrend('wfReadinessTrend', readiness, 70);
    updateTrend('wfMissingTrend', missingCenters, 3);
    
    var el_wfLastUpdate = document.getElementById('wfLastUpdate'); if (el_wfLastUpdate) el_wfLastUpdate.innerText = getSaudiTime();
}

function animateValue(elementId, value) {
    var el = document.getElementById(elementId);
    if (!el) return;
    var current = parseInt(el.innerText) || 0;
    if (current === value) return;
    el.innerText = value;
    el.classList.add('pop');
    setTimeout(function() { el.classList.remove('pop'); }, 500);
}

function updateTrend(elementId, current, baseline) {
    var el = document.getElementById(elementId);
    if (!el) return;
    var diff = current - baseline;
    var percent = baseline > 0 ? Math.round((diff / baseline) * 100) : 0;
    el.className = 'wf-card-trend';
    var arrow = '', valClass = '';
    if (percent > 5) {
        el.classList.add('up');
        arrow = '▲';
        valClass = 'up';
    } else if (percent < -5) {
        el.classList.add('down');
        arrow = '▼';
        valClass = 'down';
    } else {
        el.classList.add('neutral');
        arrow = '—';
        valClass = 'neutral';
    }
    var label = percent > 5 || percent < -5 ? Math.abs(percent) + '%' : 'مستقر';
    var suffix = 'عن الأسبوع الماضي';
    el.innerHTML = '<span class="wf-trend-arrow">' + arrow + '</span><span class="wf-trend-value">' + label + '</span><span class="wf-trend-label">' + suffix + '</span>';
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
    var sorted = Object.entries(unitStats).sort(function(a, b) { return b[1] - a[1]; });
    if (sorted.length === 0) {
        container.innerHTML = '<div class="distribution-empty"><i class="fas fa-inbox"></i><span>لا توجد بلاغات مسجلة</span></div>';
        return;
    }
    var html = '';
    var colors = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#64748B', '#EC4899'];
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
async function loadAirRecords() {
    try {
        var response = await fetch('/api/air-ambulance', { headers: { 'Authorization': 'Bearer ' + authToken } });
        var result = await response.json();
        if (result.success) { airRecords = result.records || []; renderAirRecords(); }
    } catch (error) { console.error("خطأ في تحميل سجلات الإسعاف الجوي:", error); }
}

function renderAirRecords() {
    var container = document.getElementById('airRecordsList');
    var section = document.getElementById('airSavedRecords');
    if (!container || !section) return;
    if (airRecords.length === 0) { section.style.display = 'none'; return; }
    section.style.display = 'block';
    var html = '';
    airRecords.forEach(function(record) {
        var date = getSaudiDateTime();
        var notes = record.notes || 'لا توجد ملاحظات';
        html += '<div class="record-item"><div class="record-info"><strong>' + (record.reportNumber || 'بدون رقم') + '</strong><span style="margin:0 5px;">|</span><span>' + (record.unit || '-') + '</span><span style="margin:0 5px;">|</span><span>' + (record.hospital || '-') + '</span><span style="margin:0 5px;">|</span><span style="font-size:0.6rem; color:var(--gray-600); display:block;">📝 ' + notes + '</span><span class="rec-date">🕒 ' + date + '</span></div><div class="record-actions"><button onclick="deleteAirRecord(\'' + record.id + '\')">🗑️ حذف</button></div></div>';
    });
    container.innerHTML = html;
}

async function deleteAirRecord(recordId) {
    if (!confirm('⚠️ هل أنت متأكد من حذف هذا البلاغ؟')) return;
    try {
        var response = await fetch('/api/delete-air-ambulance/' + recordId, { method: 'DELETE' });
        var result = await response.json();
        if (result.success) { await loadAirRecords(); } else { alert('❌ فشل في حذف البلاغ'); }
    } catch (error) { alert('❌ خطأ في الاتصال'); }
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
        var response = await fetch('/api/shifts', { headers: { 'Authorization': 'Bearer ' + authToken } });
        var data = await response.json();
        if (Array.isArray(data)) {
            allShifts = data;
        } else {
            allShifts = [];
            console.log('⚠️ /api/shifts returned non-array:', data);
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
    
    // Get current Saudi time
    var now = new Date();
    var utc = now.getTime() + (now.getTimezoneOffset() * 60 * 1000);
    var saudiTime = new Date(utc + (3 * 60 * 60 * 1000));
    var hour = saudiTime.getHours();
    var minute = saudiTime.getMinutes();
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
    
    // Auto-save current shift data silently before starting new one
    if (currentShiftId && typeof saveShiftData === 'function') {
        try {
            await saveShiftData(true);
            console.log('✅ تم حفظ بيانات المناوبة الحالية تلقائياً قبل بدء الجديدة');
        } catch (e) {
            console.error('⚠️ فشل الحفظ التلقائي للمناوبة الحالية:', e);
        }
    }
    
    var shiftType = await showShiftTypeDialog();
    if (!shiftType) return;
    
    // Normalize shift type for API (صباحية → صباح, ليلية → ليل)
    var normalizedType = shiftType;
    if (shiftType === 'صباحية') normalizedType = 'صباح';
    if (shiftType === 'ليلية') normalizedType = 'ليل';
    
    if (!confirm('⚠️ هل أنت متأكد؟\n\nسيتم حفظ البلاغات الحالية في المناوبة السابقة، وبدء مناوبة ' + (normalizedType === 'صباح' ? 'صباحية' : 'ليلية') + ' جديدة.')) return;
    try {
        var response = await fetch('/api/start-new-shift', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shiftType: normalizedType }) });
        var result = await response.json();
        if (result.success) {
            currentShiftId = result.shiftId;
            // Persist to localStorage so it survives refreshes
            try { localStorage.setItem('currentShiftId', String(currentShiftId)); } catch(e) {}
            alert('✅ تم بدء المناوبة ' + (normalizedType === 'صباح' ? 'الصباحية' : 'الليلية') + ' بنجاح');
            await loadShifts();
            await loadAllData();
            calculateLiveReportStats();
            updateWorkforceStats();
            updateDistributionIndicator();
            // إذا كان مربع التكميل مفتوح، حدثه تلقائياً بالمناوبة الجديدة
            var shiftModal = document.getElementById('shiftModal');
            if (shiftModal && shiftModal.style.display === 'flex') {
                openShiftModal();
            } else if (shiftModal) {
                shiftModal.style.display = 'none';
            }
        } else { alert("❌ فشل في بدء المناوبة: " + (result.error || "خطأ غير معروف")); }
    } catch (error) { alert("❌ خطأ في الاتصال: " + error.message); }
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
    
    try {
        var response = await fetch('/api/report', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ center: center.trim(), unit: unit.trim() })
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
    
    try {
        var response = await fetch('/api/undo', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ center: center.trim(), unit: unit.trim() })
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
// دوال المناوبة (view, return, save, delete)
// ============================================
async function viewShiftReports() {
    var select = document.getElementById('archiveSelect');
    var shiftId = parseInt(select.value);
    if (!shiftId) { alert("الرجاء اختيار مناوبة من القائمة"); return; }
    try {
        var response = await fetch('/api/shifts/' + shiftId);
        var result = await response.json();
        if (result && result.shift) {
            currentViewingShift = result.shift;
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
            var el_updateStatus_h6 = document.getElementById('updateStatus'); if (el_updateStatus_h6) el_updateStatus_h6.innerHTML = '🟡 تستعرض مناوبة سابقة | آخر تحديث: ' + getSaudiTime();
            var el_shiftModal_d22 = document.getElementById('shiftModal'); if (el_shiftModal_d22) el_shiftModal_d22.style.display = 'flex';
        } else { alert("لا توجد بيانات في هذه المناوبة"); }
    } catch (error) { console.error(error); alert("❌ فشل في تحميل المناوبة"); }
}

async function returnToCurrentShift() {
    isViewingArchiveShift = false;
    currentViewingShift = null;
    viewingShiftId = null;
    await loadAllData();
    calculateLiveReportStats();
    updateWorkforceStats();
    updateDistributionIndicator();
    var el_viewingBadge_d23 = document.getElementById('viewingBadge'); if (el_viewingBadge_d23) el_viewingBadge_d23.style.display = 'none';
    var el_returnToCurrentBtn_d24 = document.getElementById('returnToCurrentBtn'); if (el_returnToCurrentBtn_d24) el_returnToCurrentBtn_d24.style.display = 'none';
    var el_archiveSelect_v4 = document.getElementById('archiveSelect'); if (el_archiveSelect_v4) el_archiveSelect_v4.value = '';
    var el_updateStatus_h7 = document.getElementById('updateStatus'); if (el_updateStatus_h7) el_updateStatus_h7.innerHTML = '🟢 متصل | تحديث تلقائي مفعل | آخر تحديث: ' + getSaudiTime();
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
    
    calculateWorkforceStatsLocally();
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
        var response = await fetch('/api/update-shift-data', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authToken }, body: JSON.stringify(body) });
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
                    var viewResponse = await fetch('/api/shifts/' + viewingShiftId, { headers: { 'Authorization': 'Bearer ' + authToken } });
                    var viewResult = await viewResponse.json();
                    if (viewResult && viewResult.shift) { loadShiftToForm(viewResult.shift); }
                }
                // Add audit log for manual save
                try {
                    if (typeof addAuditEntry === 'function') {
                        await addAuditEntry('shift', 'حفظ تكميل النوبة', 'تم حفظ بيانات تكميل النوبة يدوياً', currentUser && currentUser.name);
                    }
                } catch(e) {}
            } else {
                // Auto-save: don't reload form to avoid race condition
                // The WebSocket broadcast will update other UI elements
                // Form inputs keep their current values (user is still typing)
                // Add audit log for auto-save (throttled — only log every 5 minutes to avoid spam)
                try {
                    if (typeof addAuditEntry === 'function') {
                        var now = Date.now();
                        if (!window._lastAutoSaveAudit || (now - window._lastAutoSaveAudit) > 300000) {
                            window._lastAutoSaveAudit = now;
                            addAuditEntry('shift', 'حفظ تلقائي للتكميل', 'تم حفظ بيانات تكميل النوبة تلقائياً', currentUser && currentUser.name);
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
            alert("✅ تم حذف المناوبة");
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

function safeTeamId(teamName) {
    return teamName.replace(/\s+/g, '_');
}

function isParamedicPresent(shiftCode) {
    if (!shiftCode || shiftCode === '-' || shiftCode === '') return false;
    var absentCodes = ['V', 'VC', 'E', 'EV', 'WO', 'C'];
    return absentCodes.indexOf(shiftCode.toString().toUpperCase()) === -1;
}

function renderTeamParamedics(teamName, type, index, paramedics) {
    var safeName = safeTeamId(teamName);
    var container = document.getElementById('paramedics_' + safeName);
    var countDisplay = document.getElementById('staffCountDisplay_' + safeName);
    var staffInputId = type === 'rapid' ? 'rapid_staff_' + index : 'staff_' + index;
    var staffInput = document.getElementById(staffInputId);
    var fallbackDiv = document.getElementById('fallback_' + staffInputId);
    
    if (!container) return;
    
    var presentCount = 0;
    var html = '';
    
    if (paramedics.length === 0) {
        html = '<div class="paramedic-no-data">لا يوجد مسعفين مسندين</div>';
        if (fallbackDiv) fallbackDiv.style.display = 'block';
    } else {
        if (fallbackDiv) fallbackDiv.style.display = 'none';
        for (var i = 0; i < paramedics.length; i++) {
            var p = paramedics[i];
            var isPresent = isParamedicPresent(p.shift_code);
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
        countDisplay.textContent = presentCount + ' حاضر';
    }
    
    if (staffInput) {
        staffInput.value = presentCount;
    }
    
    if (type === 'rapid') {
        updateRapidStatusIcon(index);
    } else {
        updateStatusIcon(index);
    }
    calculateWorkforceStatsLocally();
    updateShiftKPIs();
}

async function fetchTeamParamedics(shiftId, teamName, type, index) {
    var cacheKey = shiftId + '_' + teamName;
    // Always fetch fresh data (cache-busting)
    try {
        var response = await fetch('/api/shift-completion/' + shiftId + '/' + encodeURIComponent(teamName) + '?_=' + Date.now(), {
            headers: { 'Authorization': 'Bearer ' + authToken }
        });
        var data = await response.json();
        console.log('[PARAMEDICS] Team:', teamName, 'ShiftType:', data.shiftType, 'Count:', data.paramedics.length, 'Codes:', data.paramedics.map(p => p.shift_code));
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
    
    await Promise.all(teams.map(function(team) {
        return fetchTeamParamedics(shiftId, team.name, team.type, team.index);
    }));
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
    setTimeout(calculateWorkforceStatsLocally, 100);
    if (shift.id) { 
        loadWorkforceStats(shift.id); 
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

function isParamedicPresent(shiftCode) {
    if (!shiftCode || shiftCode === '-' || shiftCode === '') return false;
    var absentCodes = ['V', 'VC', 'E', 'EV', 'WO', 'C'];
    return absentCodes.indexOf(shiftCode.toString().toUpperCase()) === -1;
}

function renderTeamParamedics(teamName, type, index, paramedics) {
    var safeName = safeTeamId(teamName);
    var container = document.getElementById('paramedics_' + safeName);
    var countDisplay = document.getElementById('staffCountDisplay_' + safeName);
    var staffInputId = type === 'rapid' ? 'rapid_staff_' + index : 'staff_' + index;
    var staffInput = document.getElementById(staffInputId);
    var fallbackDiv = document.getElementById('fallback_' + staffInputId);
    
    if (!container) return;
    
    var presentCount = 0;
    var html = '';
    
    if (paramedics.length === 0) {
        html = '<div class="paramedic-no-data">لا يوجد مسعفين مسندين</div>';
        if (fallbackDiv) fallbackDiv.style.display = 'block';
    } else {
        if (fallbackDiv) fallbackDiv.style.display = 'none';
        for (var i = 0; i < paramedics.length; i++) {
            var p = paramedics[i];
            var isPresent = isParamedicPresent(p.shift_code);
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
        countDisplay.textContent = presentCount + ' حاضر';
    }
    
    if (staffInput) {
        staffInput.value = presentCount;
    }
    
    if (type === 'rapid') {
        updateRapidStatusIcon(index);
    } else {
        updateStatusIcon(index);
    }
    calculateWorkforceStatsLocally();
    updateShiftKPIs();
}

async function fetchTeamParamedics(shiftId, teamName, type, index) {
    var cacheKey = shiftId + '_' + teamName;
    try {
        var response = await fetch('/api/shift-completion/' + shiftId + '/' + encodeURIComponent(teamName) + '?_=' + Date.now(), {
            headers: { 'Authorization': 'Bearer ' + authToken }
        });
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
    calculateWorkforceStatsLocally();
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
    calculateWorkforceStatsLocally();
    updateShiftKPIs();
    var countDisplay = document.getElementById('staffCountDisplay_' + safeTeamId(rapidTeams[index].name));
    if (countDisplay) countDisplay.textContent = '0 حاضر';
}

function updateStatusIcon(index) {
    var staffInput = document.getElementById('staff_' + index);
    var carsInput = document.getElementById('cars_' + index);
    var iconSpan = document.getElementById('status_' + index);
    var backupParamedicInput = document.getElementById('backup_paramedic_' + index);
    var hasBackupParamedic = backupParamedicInput && backupParamedicInput.value.trim().length > 0;
    if (staffInput && carsInput && iconSpan) {
        var staffCount = parseInt(staffInput.value) || 0;
        var carsCount = parseInt(carsInput.value) || 0;
        if ((staffCount >= 2 || hasBackupParamedic) && carsCount >= 1) { 
            iconSpan.innerHTML = '✅'; 
            iconSpan.className = 'status-icon status-ok'; 
        } else { 
            iconSpan.innerHTML = '❌'; 
            iconSpan.className = 'status-icon status-not'; 
        }
    }
}

function calculateWorkforceStatsLocally() {
    var centerRows = document.querySelectorAll('#centersTableBody tr');
    var totalStaff = 0, totalCars = 0, readyCenters = 0, missingCenters = 0, centerCount = 0;
    var distribution = {}, carDistribution = {};
    centerRows.forEach(function(tr) {
        var centerName = tr.querySelector('td:nth-child(2)')?.innerText || '';
        var isRapid = tr.classList.contains('rapid-team-row');
        var staffInput = tr.querySelector('input[id^="staff_"], input[id^="rapid_staff_"]');
        var carsInput = tr.querySelector('input[id^="cars_"], input[id^="rapid_cars_"]');
        if (staffInput && carsInput) {
            var staffCount = parseInt(staffInput.value) || 0;
            var carsCount = parseInt(carsInput.value) || 0;
            var backupParamedicInput = isRapid ? tr.querySelector('input[id^="backup_paramedic_rapid_"]') : tr.querySelector('input[id^="backup_paramedic_"]');
            var hasBackupParamedic = backupParamedicInput && backupParamedicInput.value.trim().length > 0;
            if (hasBackupParamedic) {
                staffCount = Math.max(staffCount, 1);
            }
            totalStaff += staffCount; totalCars += carsCount; centerCount++;
            distribution[centerName] = staffCount; carDistribution[centerName] = carsCount;
            if (isRapid) {
                if ((staffCount >= 1 || hasBackupParamedic) && carsCount >= 1) readyCenters++; else missingCenters++;
            } else {
                if ((staffCount >= 2 || hasBackupParamedic) && carsCount >= 1) readyCenters++; else missingCenters++;
            }
        }
    });
    var readinessRate = centerCount > 0 ? Math.round((readyCenters / centerCount) * 100) : 0;
    var elWorkforceStats = document.getElementById('workforceStats');
    if (elWorkforceStats) elWorkforceStats.style.display = 'block';
    var elTotalStaffDisplay = document.getElementById('totalStaffDisplay');
    if (elTotalStaffDisplay) elTotalStaffDisplay.innerText = totalStaff;
    var elTotalCarsDisplay = document.getElementById('totalCarsDisplay');
    if (elTotalCarsDisplay) elTotalCarsDisplay.innerText = totalCars;
    var elMissingCentersDisplay = document.getElementById('missingCentersDisplay');
    if (elMissingCentersDisplay) elMissingCentersDisplay.innerText = missingCenters;
    var elStaffSubText = document.getElementById('staffSubText');
    if (elStaffSubText) elStaffSubText.innerText = 'موزعين على ' + centerCount + ' فريق';
    var elCarsSubText = document.getElementById('carsSubText');
    if (elCarsSubText) elCarsSubText.innerText = 'إجمالي السيارات';
    var elMissingSubText = document.getElementById('missingSubText');
    if (elMissingSubText) elMissingSubText.innerText = missingCenters === 1 ? 'فريق ناقص' : missingCenters + ' فرق ناقصة';
    var elReadinessSubText = document.getElementById('readinessSubText');
    if (elReadinessSubText) elReadinessSubText.innerText = readyCenters + ' / ' + centerCount + ' فريق جاهز';
    var circumference = 2 * Math.PI * 42;
    var offset = circumference - (readinessRate / 100) * circumference;
    var circle = document.getElementById('readinessCircle');
    var text = document.getElementById('readinessText');
    var color = '#c0392b';
    if (readinessRate >= 80) color = '#2a7f3e';
    else if (readinessRate >= 50) color = '#f39c12';
    if (circle) {
        circle.setAttribute('stroke', color);
        circle.style.strokeDashoffset = offset;
    }
    if (text) text.textContent = readinessRate + '%';
    var distList = document.getElementById('distributionList');
    if (distList) {
        distList.innerHTML = '';
        var total = totalStaff || 1;
        for (var center in distribution) {
            var count = distribution[center];
            var barWidth = Math.round((count / total) * 100);
            var isRapidTeam = center.indexOf('سريع') !== -1;
            var isReady = isRapidTeam ? (count >= 1) : (count >= 2);
            var div = document.createElement('div');
            div.className = 'distribution-bar';
            div.innerHTML = '<span class="name">' + center + '</span><span class="count" style="' + (isReady ? 'color:#2a7f3e;' : 'color:#c0392b;') + '">' + count + '</span><div class="bar-track"><div class="bar-fill" style="width:' + barWidth + '%; background:' + (isReady ? '#2a7f3e' : '#c0392b') + ';"></div></div><span class="percent">' + barWidth + '%</span>';
            distList.appendChild(div);
        }
    }
    var carDistList = document.getElementById('carDistributionList');
    if (carDistList) {
        carDistList.innerHTML = '';
        var totalCarsValue = totalCars || 1;
        for (var center2 in carDistribution) {
            var count2 = carDistribution[center2];
            var barWidth2 = Math.round((count2 / totalCarsValue) * 100);
            var isRapidTeam2 = center2.indexOf('سريع') !== -1;
            var hasCar = isRapidTeam2 ? (count2 >= 1) : (count2 >= 1);
            var div2 = document.createElement('div');
            div2.className = 'distribution-bar';
            div2.innerHTML = '<span class="name">' + center2 + '</span><span class="count" style="' + (hasCar ? 'color:#2a7f3e;' : 'color:#c0392b;') + '">' + count2 + '</span><div class="bar-track"><div class="bar-fill" style="width:' + barWidth2 + '%; background:' + (hasCar ? '#2a7f3e' : '#c0392b') + ';"></div></div><span class="percent">' + barWidth2 + '%</span>';
            carDistList.appendChild(div2);
        }
    }
    if (totalStaff > 0 || totalCars > 0) {
        updateWorkforceDisplay(totalStaff, totalCars, readinessRate, missingCenters);
    }
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
        div.innerHTML = '<span class="name">' + item[0] + '</span><span class="count" style="color:#1e466e;">' + item[1] + '</span><div class="bar-track"><div class="bar-fill" style="width:' + percentage + '%; background:#1e466e;"></div></div><span class="percent">' + percentage + '%</span>';
        listContainer.appendChild(div);
    });
}

async function loadWorkforceStats(shiftId) {
    try {
        var response = await fetch('/api/workforce-stats/' + shiftId);
        var stats = await response.json();
        if (stats.error) { var el_workforceStats_d31 = document.getElementById('workforceStats'); if (el_workforceStats_d31) el_workforceStats_d31.style.display = 'none'; return; }
        var el_workforceStats_d32 = document.getElementById('workforceStats'); if (el_workforceStats_d32) el_workforceStats_d32.style.display = 'block';
        var el_totalStaffDisplay = document.getElementById('totalStaffDisplay'); if (el_totalStaffDisplay) el_totalStaffDisplay.innerText = stats.totalStaff;
        var el_totalCarsDisplay = document.getElementById('totalCarsDisplay'); if (el_totalCarsDisplay) el_totalCarsDisplay.innerText = stats.totalCars;
        var el_missingCentersDisplay = document.getElementById('missingCentersDisplay'); if (el_missingCentersDisplay) el_missingCentersDisplay.innerText = stats.missingCenters;
        var el_staffSubText = document.getElementById('staffSubText'); if (el_staffSubText) el_staffSubText.innerText = 'موزعين على ' + stats.centerCount + ' مركز';
        var el_carsSubText = document.getElementById('carsSubText'); if (el_carsSubText) el_carsSubText.innerText = 'إجمالي السيارات';
        var el_missingSubText = document.getElementById('missingSubText'); if (el_missingSubText) el_missingSubText.innerText = stats.missingCenters === 1 ? 'مركز ناقص (بحاجة 2 مسعف + سيارة)' : stats.missingCenters + ' مراكز ناقصة (بحاجة 2 مسعف + سيارة)';
        var el_readinessSubText = document.getElementById('readinessSubText'); if (el_readinessSubText) el_readinessSubText.innerText = stats.readyCenters + ' / ' + stats.centerCount + ' مركز جاهز';
        var circumference = 2 * Math.PI * 42;
        var offset = circumference - (stats.readinessRate / 100) * circumference;
        var circle = document.getElementById('readinessCircle');
        var text = document.getElementById('readinessText');
        var color = '#c0392b';
        if (stats.readinessRate >= 80) color = '#2a7f3e';
        else if (stats.readinessRate >= 50) color = '#f39c12';
        circle.setAttribute('stroke', color);
        circle.style.strokeDashoffset = offset;
        text.textContent = stats.readinessRate + '%';
        var distList = document.getElementById('distributionList');
        distList.innerHTML = '';
        var total = stats.totalStaff || 1;
        for (var center in stats.distribution) {
            var count = stats.distribution[center];
            var barWidth = Math.round((count / total) * 100);
            var isReady = count >= 2;
            var div = document.createElement('div');
            div.className = 'distribution-bar';
            div.innerHTML = '<span class="name">' + center + '</span><span class="count" style="' + (isReady ? 'color:#2a7f3e;' : 'color:#c0392b;') + '">' + count + '</span><div class="bar-track"><div class="bar-fill" style="width:' + barWidth + '%; background:' + (isReady ? '#2a7f3e' : '#c0392b') + ';"></div></div><span class="percent">' + barWidth + '%</span>';
            distList.appendChild(div);
        }
        var carDistList = document.getElementById('carDistributionList');
        carDistList.innerHTML = '';
        var totalCars = stats.totalCars || 1;
        for (var center2 in stats.carDistribution) {
            var count2 = stats.carDistribution[center2];
            var barWidth2 = Math.round((count2 / totalCars) * 100);
            var hasCar = count2 >= 1;
            var div2 = document.createElement('div');
            div2.className = 'distribution-bar';
            div2.innerHTML = '<span class="name">' + center2 + '</span><span class="count" style="' + (hasCar ? 'color:#2a7f3e;' : 'color:#c0392b;') + '">' + count2 + '</span><div class="bar-track"><div class="bar-fill" style="width:' + barWidth2 + '%; background:' + (hasCar ? '#2980b9' : '#c0392b') + ';"></div></div><span class="percent">' + barWidth2 + '%</span>';
            carDistList.appendChild(div2);
        }
    } catch (error) { console.error(error); var el_workforceStats_d33 = document.getElementById('workforceStats'); if (el_workforceStats_d33) el_workforceStats_d33.style.display = 'none'; }
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
        html += '<div class="record-item"><div class="record-info"><strong>🚑 ' + (record.activeCars || 0) + '</strong><span style="margin:0 5px;">|</span><span>🔧 ' + (record.brokenCars || 0) + '</span><span style="margin:0 5px;">|</span><span>🔄 ' + (record.reserveCars || 0) + '</span><span style="margin:0 5px;">|</span><span>📊 ' + (record.overlapTeams || 0) + '</span><span style="margin:0 5px;">|</span><span class="rec-locations">📍 ' + locations + '</span><span class="rec-date">🕒 ' + date + '</span>' + (record.assistantName ? '<span style="font-size:0.6rem; color:var(--primary-700);">👤 ' + record.assistantName + '</span>' : '') + '</div><div class="record-actions"><button onclick="deleteSeniorRecord(' + index + ')">🗑️ حذف</button></div></div>';
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

function saveSeniorRecordToLocal(data) {
    if (data.activeCars === 0 && data.brokenCars === 0 && data.reserveCars === 0 && data.overlapTeams === 0) { alert('⚠️ الرجاء إدخال بيانات المناوبة (على الأقل قيمة واحدة)'); return false; }
    seniorRecords.unshift({ activeCars: data.activeCars, brokenCars: data.brokenCars, reserveCars: data.reserveCars, overlapTeams: data.overlapTeams, locations: data.locations, notes: data.notes, assistantName: data.assistantName, assistantSignature: data.assistantSignature, chiefName: data.chiefName, chiefSignature: data.chiefSignature, leaderName: data.leaderName, leaderSignature: data.leaderSignature, createdAt: new Date().toISOString() });
    localStorage.setItem('seniorShiftRecords', JSON.stringify(seniorRecords));
    renderSeniorRecords();
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

function deleteSeniorRecord(index) {
    if (!confirm('⚠️ هل أنت متأكد من حذف هذه المناوبة؟')) return;
    seniorRecords.splice(index, 1);
    localStorage.setItem('seniorShiftRecords', JSON.stringify(seniorRecords));
    renderSeniorRecords();
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
    var el_seniorShiftModal_d34 = document.getElementById('seniorShiftModal'); if (el_seniorShiftModal_d34) el_seniorShiftModal_d34.style.display = 'flex';
    renderSeniorRecords();
});

var el_closeSeniorShift = document.getElementById("closeSeniorShift"); if(el_closeSeniorShift) el_closeSeniorShift.addEventListener('click', function() { var el_seniorShiftModal_d35 = document.getElementById('seniorShiftModal'); if (el_seniorShiftModal_d35) el_seniorShiftModal_d35.style.display = 'none'; });
var el_saveSeniorShift=document.getElementById("saveSeniorShift");if(el_saveSeniorShift)el_saveSeniorShift.addEventListener('click', function() {
    var data = getSeniorShiftData();
    if (data.activeCars === 0 && data.brokenCars === 0 && data.reserveCars === 0 && data.overlapTeams === 0) { alert('⚠️ الرجاء إدخال بيانات المناوبة (على الأقل قيمة واحدة)'); return; }
    if (saveSeniorRecordToLocal(data)) { alert('✅ تم حفظ مناوبة كبار المسعفين بنجاح'); clearSeniorShiftForm(); renderSeniorRecords(); }
});

var el_sendWhatsAppSeniorShift=document.getElementById("sendWhatsAppSeniorShift");if(el_sendWhatsAppSeniorShift)el_sendWhatsAppSeniorShift.addEventListener('click', function() {
    var data = getSeniorShiftData();
    if (data.activeCars === 0 && data.brokenCars === 0 && data.reserveCars === 0 && data.overlapTeams === 0) { alert('⚠️ الرجاء إدخال بيانات المناوبة قبل الإرسال'); return; }
    saveSeniorRecordToLocal(data);
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
    var el_formsModal_d37 = document.getElementById('formsModal'); if (el_formsModal_d37) el_formsModal_d37.style.display = 'none';
}

function closeAnalyticsModal() {
    var el_analyticsModal_d38 = document.getElementById('analyticsModal'); if (el_analyticsModal_d38) el_analyticsModal_d38.style.display = 'none';
}

function closeChartsModal() {
    var el_chartsModal_d39 = document.getElementById('chartsModal'); if (el_chartsModal_d39) el_chartsModal_d39.style.display = 'none';
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
var incidentRecords = JSON.parse(localStorage.getItem('incidentRecords') || '[]');

function initForm_incident() {
    var now = new Date();
    var dt = now.toISOString().slice(0, 16);
    var el = document.getElementById('incDateTime');
    if (el) el.value = dt;
    renderIncidentPreview();
}

function saveIncident() {
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

    incidentRecords.unshift({
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
        actions: actions.trim(),
        createdAt: new Date().toISOString()
    });
    localStorage.setItem('incidentRecords', JSON.stringify(incidentRecords));
    alert('✅ تم حفظ بلاغ الحادث');
    clearIncidentForm();
    renderIncidentPreview();
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
    if (dtEl) dtEl.value = new Date().toISOString().slice(0, 16);
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
    msg += 'تم الإرسال: ' + new Date().toLocaleString('ar-SA');

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
        var date = new Date(rec.createdAt).toLocaleString('ar-SA');
        html += '<div style="border:1px solid var(--gray-200); border-radius:8px; padding:10px; margin-bottom:8px; background:var(--white);">';
        html += '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">';
        html += '<strong style="color:var(--primary-700);">' + (rec.reportNumber || 'بدون رقم') + '</strong>';
        html += '<span style="font-size:0.7rem; color:var(--gray-400);">' + date + '</span></div>';
        html += '<div style="font-size:0.8rem; color:var(--gray-600);">';
        html += '📍 ' + (rec.location || '-') + ' | ' + (rec.type || '-') + ' | ' + (rec.unit || '-') + '</div>';
        if (rec.patientName) html += '<div style="font-size:0.8rem; color:var(--gray-600);">👤 ' + rec.patientName + '</div>';
        html += '<div style="display:flex; gap:6px; margin-top:8px;">';
        html += '<button onclick="deleteIncidentRecord(' + i + ')" style="padding:4px 10px; font-size:0.7rem; border-radius:4px; border:1px solid var(--coral); background:var(--coral-50); color:var(--coral); cursor:pointer;">🗑️ حذف</button>';
        html += '</div></div>';
    });
    container.innerHTML = html;
}

function deleteIncidentRecord(index) {
    if (!confirm('⚠️ هل أنت متأكد من الحذف؟')) return;
    incidentRecords.splice(index, 1);
    localStorage.setItem('incidentRecords', JSON.stringify(incidentRecords));
    renderIncidentPreview();
}

// ----- نموذج تسليم مناوبة كبار المسعفين (senior) -----
var seniorRecords = JSON.parse(localStorage.getItem('seniorShiftRecords') || '[]');

function initForm_senior() {
    var today = new Date().toISOString().slice(0, 10);
    var dtEls = ['senAsstDate', 'senChiefDate', 'senCmdrDate'];
    dtEls.forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.value = today;
    });
    renderSeniorPreview();
}

function saveSenior() {
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

    seniorRecords.unshift({
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
        cmdrDate: cmdrDate,
        createdAt: new Date().toISOString()
    });
    localStorage.setItem('seniorShiftRecords', JSON.stringify(seniorRecords));
    alert('✅ تم حفظ مناوبة كبار المسعفين');
    clearSeniorForm();
    renderSeniorPreview();
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

    var today = new Date().toISOString().slice(0, 10);
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
    msg += 'تم الإرسال: ' + new Date().toLocaleString('ar-SA');

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
        var date = new Date(rec.createdAt).toLocaleString('ar-SA');
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
        html += '<button onclick="deleteSeniorRecord(' + i + ')" style="padding:4px 10px; font-size:0.7rem; border-radius:4px; border:1px solid var(--coral); background:var(--coral-50); color:var(--coral); cursor:pointer;">🗑️ حذف</button>';
        html += '</div></div>';
    });
    container.innerHTML = html;
}

function deleteSeniorRecord(index) {
    if (!confirm('⚠️ هل أنت متأكد من الحذف؟')) return;
    seniorRecords.splice(index, 1);
    localStorage.setItem('seniorShiftRecords', JSON.stringify(seniorRecords));
    renderSeniorPreview();
}

// ----- نموذج الإسعاف الجوي (air) -----
var airRecords = JSON.parse(localStorage.getItem('airRecords') || '[]');

function initForm_air() {
    var el = document.getElementById('airDateTime');
    if (el) el.value = new Date().toISOString().slice(0, 16);
    renderAirPreview();
}

function saveAirAmbulance() {
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

    airRecords.unshift({
        reportNumber: reportNumber.trim(),
        dateTime: dateTime,
        pickupLocation: pickupLocation.trim(),
        destinationHospital: destinationHospital.trim(),
        diagnosis: diagnosis.trim(),
        reason: reason.trim(),
        patientName: patientName.trim(),
        patientAge: patientAge,
        unit: unit,
        paramedic: paramedic.trim(),
        createdAt: new Date().toISOString()
    });
    localStorage.setItem('airRecords', JSON.stringify(airRecords));
    alert('✅ تم حفظ طلب الإسعاف الجوي');
    clearAirForm();
    renderAirPreview();
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
    if (dtEl) dtEl.value = new Date().toISOString().slice(0, 16);
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
    msg += 'تم الإرسال: ' + new Date().toLocaleString('ar-SA');

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
        var date = new Date(rec.createdAt).toLocaleString('ar-SA');
        html += '<div style="border:1px solid var(--gray-200); border-radius:8px; padding:10px; margin-bottom:8px; background:var(--white);">';
        html += '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">';
        html += '<strong style="color:var(--primary-700);">' + (rec.reportNumber || 'بدون رقم') + '</strong>';
        html += '<span style="font-size:0.7rem; color:var(--gray-400);">' + date + '</span></div>';
        html += '<div style="font-size:0.8rem; color:var(--gray-600);">';
        html += '🚁 ' + (rec.pickupLocation || '-') + ' → ' + (rec.destinationHospital || '-') + '</div>';
        html += '<div style="display:flex; gap:6px; margin-top:8px;">';
        html += '<button onclick="deleteAirRecord(' + i + ')" style="padding:4px 10px; font-size:0.7rem; border-radius:4px; border:1px solid var(--coral); background:var(--coral-50); color:var(--coral); cursor:pointer;">🗑️ حذف</button>';
        html += '</div></div>';
    });
    container.innerHTML = html;
}

function deleteAirRecord(index) {
    if (!confirm('⚠️ هل أنت متأكد من الحذف؟')) return;
    airRecords.splice(index, 1);
    localStorage.setItem('airRecords', JSON.stringify(airRecords));
    renderAirPreview();
}

// ----- نموذج التقرير اليومي (daily) -----
var dailyRecords = [];

function initForm_daily() {
    try {
        var saved = localStorage.getItem('dailyRecords');
        dailyRecords = saved ? JSON.parse(saved) : [];
    } catch (e) { dailyRecords = []; }
    var el = document.getElementById('dailyDate');
    if (el) el.value = new Date().toISOString().split('T')[0];
    renderDailyPreview();
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
        var date = new Date(rec.createdAt).toLocaleString('ar-SA');
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
        html += '<button onclick="deleteDailyRecord(' + i + ')" style="padding:4px 10px; font-size:0.7rem; border-radius:4px; border:1px solid var(--coral); background:var(--coral-50); color:var(--coral); cursor:pointer;">🗑️ حذف</button>';
        html += '</div></div>';
    });
    container.innerHTML = html;
}

function saveDailyReport() {
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

    dailyRecords.unshift({
        reportNumber: reportNumber.trim(),
        date: date,
        responseTeams: parseInt(responseTeams) || 0,
        air: parseInt(air) || 0,
        borderReports: borderReports.trim(),
        paths: paths,
        formFill: formFill.trim(),
        summary: summary.trim(),
        createdAt: new Date().toISOString()
    });
    localStorage.setItem('dailyRecords', JSON.stringify(dailyRecords));
    alert('✅ تم حفظ التقرير اليومي');
    clearDailyForm();
    renderDailyPreview();
}

function deleteDailyRecord(index) {
    if (!confirm('⚠️ هل أنت متأكد من الحذف؟')) return;
    dailyRecords.splice(index, 1);
    localStorage.setItem('dailyRecords', JSON.stringify(dailyRecords));
    renderDailyPreview();
}

function clearDailyForm() {
    var ids = ['dailyReportNumber','dailyBorderReports','dailyFormFill','dailySummary'];
    ids.forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.value = '';
    });
    var el_dailyResponseTeams_v18 = document.getElementById('dailyResponseTeams'); if (el_dailyResponseTeams_v18) el_dailyResponseTeams_v18.value = 0;
    var el_dailyAir_v19 = document.getElementById('dailyAir'); if (el_dailyAir_v19) el_dailyAir_v19.value = 0;
    var el_dailyDate_v20 = document.getElementById('dailyDate'); if (el_dailyDate_v20) el_dailyDate_v20.value = new Date().toISOString().split('T')[0];
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
    msg += 'تم الإرسال: ' + new Date().toLocaleString('ar-SA');

    window.open('https://wa.me/?text=' + encodeURIComponent(msg), '_blank');
}

// ----- نموذج E - حالات توقف قلب وتنفس (e) -----
var eRecords = JSON.parse(localStorage.getItem('eRecords') || '[]');

function initForm_e() {
    var el = document.getElementById('eDateTime');
    if (el) el.value = new Date().toISOString().slice(0, 16);
    renderEPreview();
}

function saveE() {
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

    eRecords.unshift({
        reportNumber: reportNumber.trim(),
        dateTime: dateTime,
        location: location.trim(),
        age: age,
        gender: gender,
        unit: unit,
        responseTime: responseTime,
        hospital: hospital.trim(),
        outcome: outcome,
        notes: notes.trim(),
        createdAt: new Date().toISOString()
    });
    localStorage.setItem('eRecords', JSON.stringify(eRecords));
    alert('✅ تم حفظ حالة E');
    clearEForm();
    renderEPreview();
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
    if (dtEl) dtEl.value = new Date().toISOString().slice(0, 16);
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
    msg += 'تم الإرسال: ' + new Date().toLocaleString('ar-SA');

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
        var date = new Date(rec.createdAt).toLocaleString('ar-SA');
        html += '<div style="border:1px solid var(--gray-200); border-radius:8px; padding:10px; margin-bottom:8px; background:var(--white);">';
        html += '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">';
        html += '<strong style="color:var(--primary-700);">' + (rec.reportNumber || 'بدون رقم') + '</strong>';
        html += '<span style="font-size:0.7rem; color:var(--gray-400);">' + date + '</span></div>';
        html += '<div style="font-size:0.8rem; color:var(--gray-600);">';
        html += '📍 ' + (rec.location || '-') + ' | ' + (rec.unit || '-') + '</div>';
        if (rec.outcome) html += '<div style="font-size:0.8rem; color:var(--gray-600);">✅ ' + rec.outcome + '</div>';
        html += '<div style="display:flex; gap:6px; margin-top:8px;">';
        html += '<button onclick="deleteERecord(' + i + ')" style="padding:4px 10px; font-size:0.7rem; border-radius:4px; border:1px solid var(--coral); background:var(--coral-50); color:var(--coral); cursor:pointer;">🗑️ حذف</button>';
        html += '</div></div>';
    });
    container.innerHTML = html;
}

function deleteERecord(index) {
    if (!confirm('⚠️ هل أنت متأكد من الحذف؟')) return;
    eRecords.splice(index, 1);
    localStorage.setItem('eRecords', JSON.stringify(eRecords));
    renderEPreview();
}

// ----- نموذج التصعيد (escalation) -----
var escalationRecords = JSON.parse(localStorage.getItem('escalationRecords') || '[]');

function initForm_escalation() {
    var el = document.getElementById('escDateTime');
    if (el) el.value = new Date().toISOString().slice(0, 16);
    renderEscalationPreview();
}

function saveEscalation() {
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

    escalationRecords.unshift({
        reportNumber: reportNumber.trim(),
        dateTime: dateTime,
        location: location.trim(),
        eventType: eventType,
        injuries: parseInt(injuries) || 0,
        deaths: parseInt(deaths) || 0,
        agencies: agencies,
        details: details.trim(),
        createdAt: new Date().toISOString()
    });
    localStorage.setItem('escalationRecords', JSON.stringify(escalationRecords));
    alert('✅ تم حفظ بلاغ التصعيد');
    clearEscalationForm();
    renderEscalationPreview();
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
    if (dtEl) dtEl.value = new Date().toISOString().slice(0, 16);
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
    msg += 'تم الإرسال: ' + new Date().toLocaleString('ar-SA');

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
        var date = new Date(rec.createdAt).toLocaleString('ar-SA');
        html += '<div style="border:1px solid var(--gray-200); border-radius:8px; padding:10px; margin-bottom:8px; background:var(--white);">';
        html += '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">';
        html += '<strong style="color:var(--primary-700);">' + (rec.reportNumber || 'بدون رقم') + '</strong>';
        html += '<span style="font-size:0.7rem; color:var(--gray-400);">' + date + '</span></div>';
        html += '<div style="font-size:0.8rem; color:var(--gray-600);">';
        html += '📍 ' + (rec.location || '-') + ' | ' + (rec.eventType || '-') + '</div>';
        html += '<div style="font-size:0.8rem; color:var(--gray-600);">👥 ' + rec.injuries + ' مصاب / ' + rec.deaths + ' وفاة</div>';
        html += '<div style="display:flex; gap:6px; margin-top:8px;">';
        html += '<button onclick="deleteEscalationRecord(' + i + ')" style="padding:4px 10px; font-size:0.7rem; border-radius:4px; border:1px solid var(--coral); background:var(--coral-50); color:var(--coral); cursor:pointer;">🗑️ حذف</button>';
        html += '</div></div>';
    });
    container.innerHTML = html;
}

function deleteEscalationRecord(index) {
    if (!confirm('⚠️ هل أنت متأكد من الحذف؟')) return;
    escalationRecords.splice(index, 1);
    localStorage.setItem('escalationRecords', JSON.stringify(escalationRecords));
    renderEscalationPreview();
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
        var response = await fetch('/api/check-monthly-table', { headers: { 'Authorization': 'Bearer ' + authToken } });
        var result = await response.json();
        if (result.exists) {
            status.innerHTML = '⏳ جاري التحميل...';
            var fileResponse = await fetch('/api/get-monthly-table', { headers: { 'Authorization': 'Bearer ' + authToken } });
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
    html2pdf().set({ margin: 10, filename: 'جدول_شهري_' + new Date().toISOString().slice(0,10) + '.pdf', html2canvas: { scale: 2 }, jsPDF: { unit: 'mm', format: 'a4', orientation: 'landscape' } }).from(wrapper).save().then(function() { document.body.removeChild(wrapper); showNotification('تم', 'تم تصدير PDF بنجاح', 'success', 3000); });
}

// تصدير CSV
function exportTableToCSV() {
    if (!workbookData) { showNotification('لا يوجد جدول', 'يرجى تحميل جدول أولاً', 'warning', 3000); return; }
    var sheet = workbookData.Sheets[workbookData.SheetNames[currentSheetIndex]];
    var csv = XLSX.utils.sheet_to_csv(sheet);
    var blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    var link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = workbookData.SheetNames[currentSheetIndex] + '_' + new Date().toISOString().slice(0,10) + '.csv';
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
        link.download = 'جدول_' + new Date().toISOString().slice(0,10) + '.png';
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
        var response = await fetch('/api/vacations', { headers: { 'Authorization': 'Bearer ' + authToken } });
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

var el_editVacationsBtn = document.getElementById("editVacationsBtn"); if(el_editVacationsBtn) el_editVacationsBtn.addEventListener('click', function() { var el_passwordModal_d44 = document.getElementById('passwordModal'); if (el_passwordModal_d44) el_passwordModal_d44.style.display = 'flex'; var el_passwordInput_v22 = document.getElementById('passwordInput'); if (el_passwordInput_v22) el_passwordInput_v22.value = ''; document.getElementById('passwordInput').focus(); });
var el_confirmPasswordBtn=document.getElementById("confirmPasswordBtn");if(el_confirmPasswordBtn)el_confirmPasswordBtn.addEventListener('click', async function() {
    var password = document.getElementById('passwordInput').value;
    try {
        var response = await fetch('/api/get-password', { headers: { 'Authorization': 'Bearer ' + authToken } });
        var result = await response.json();
        var storedPassword = result.password || '1234';
        if (password === storedPassword) {
            isEditMode = true;
            var el_passwordModal_d45 = document.getElementById('passwordModal'); if (el_passwordModal_d45) el_passwordModal_d45.style.display = 'none';
            var el_passwordInput_v23 = document.getElementById('passwordInput'); if (el_passwordInput_v23) el_passwordInput_v23.value = '';
            renderControlList(true);
            var el_saveVacationsBtn_d46 = document.getElementById('saveVacationsBtn'); if (el_saveVacationsBtn_d46) el_saveVacationsBtn_d46.style.display = 'inline-block';
            var el_editVacationsBtn_d47 = document.getElementById('editVacationsBtn'); if (el_editVacationsBtn_d47) el_editVacationsBtn_d47.style.display = 'none';
            alert('✅ تم تفعيل وضع التعديل');
        } else { alert('❌ الرقم السري غير صحيح'); var el_passwordInput_v24 = document.getElementById('passwordInput'); if (el_passwordInput_v24) el_passwordInput_v24.value = ''; document.getElementById('passwordInput').focus(); }
    } catch (error) { alert('❌ خطأ في التحقق من الرقم السري'); }
});

var el_cancelPasswordBtn = document.getElementById("cancelPasswordBtn"); if(el_cancelPasswordBtn) el_cancelPasswordBtn.addEventListener('click', function() { var el_passwordModal_d48 = document.getElementById('passwordModal'); if (el_passwordModal_d48) el_passwordModal_d48.style.display = 'none'; var el_passwordInput_v25 = document.getElementById('passwordInput'); if (el_passwordInput_v25) el_passwordInput_v25.value = ''; });
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
        var response = await fetch('/api/docs', { headers: { 'Authorization': 'Bearer ' + authToken } });
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
    calculateWorkforceStatsLocally();
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
    calculateWorkforceStatsLocally();
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
                    calculateWorkforceStatsLocally(); 
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
                    calculateWorkforceStatsLocally(); 
                    updateShiftKPIs();
                };
            }(r));
        }
        
        carsInput.addEventListener('input', function(idx) { 
            return function() { 
                updateRapidStatusIcon(idx); 
                calculateWorkforceStatsLocally(); 
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
                    calculateWorkforceStatsLocally(); 
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
                    calculateWorkforceStatsLocally(); 
                    updateShiftKPIs();
                };
            }(i));
        }
        
        carsInput.addEventListener('input', function(idx) { 
            return function() { 
                updateStatusIcon(idx); 
                calculateWorkforceStatsLocally(); 
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

function calculateWorkforceStatsLocally() {
    var centerRows = document.querySelectorAll('#centersTableBody tr');
    var totalStaff = 0, totalCars = 0, readyCenters = 0, missingCenters = 0, centerCount = 0;
    var distribution = {}, carDistribution = {};
    centerRows.forEach(function(tr) {
        var centerName = tr.querySelector('td:first-child')?.innerText || '';
        var staffInput = tr.querySelector('input[id^="staff_"]');
        var carsInput = tr.querySelector('input[id^="cars_"]');
        if (staffInput && carsInput) {
            var staffCount = parseInt(staffInput.value) || 0;
            var carsCount = parseInt(carsInput.value) || 0;
            totalStaff += staffCount; totalCars += carsCount; centerCount++;
            distribution[centerName] = staffCount; carDistribution[centerName] = carsCount;
            if (staffCount >= 2 && carsCount >= 1) readyCenters++; else missingCenters++;
        }
    });
    var readinessRate = centerCount > 0 ? Math.round((readyCenters / centerCount) * 100) : 0;
    var el_workforceStats_d53 = document.getElementById('workforceStats'); if (el_workforceStats_d53) el_workforceStats_d53.style.display = 'block';
    var el_totalStaffDisplay = document.getElementById('totalStaffDisplay'); if (el_totalStaffDisplay) el_totalStaffDisplay.innerText = totalStaff;
    var el_totalCarsDisplay = document.getElementById('totalCarsDisplay'); if (el_totalCarsDisplay) el_totalCarsDisplay.innerText = totalCars;
    var el_missingCentersDisplay = document.getElementById('missingCentersDisplay'); if (el_missingCentersDisplay) el_missingCentersDisplay.innerText = missingCenters;
    var el_staffSubText = document.getElementById('staffSubText'); if (el_staffSubText) el_staffSubText.innerText = 'موزعين على ' + centerCount + ' مركز';
    var el_carsSubText = document.getElementById('carsSubText'); if (el_carsSubText) el_carsSubText.innerText = 'إجمالي السيارات';
    var el_missingSubText = document.getElementById('missingSubText'); if (el_missingSubText) el_missingSubText.innerText = missingCenters === 1 ? 'مركز ناقص (بحاجة 2 مسعف + سيارة)' : missingCenters + ' مراكز ناقصة (بحاجة 2 مسعف + سيارة)';
    var el_readinessSubText = document.getElementById('readinessSubText'); if (el_readinessSubText) el_readinessSubText.innerText = readyCenters + ' / ' + centerCount + ' مركز جاهز';
    var circumference = 2 * Math.PI * 42;
    var offset = circumference - (readinessRate / 100) * circumference;
    var circle = document.getElementById('readinessCircle');
    var text = document.getElementById('readinessText');
    var color = '#c0392b';
    if (readinessRate >= 80) color = '#2a7f3e';
    else if (readinessRate >= 50) color = '#f39c12';
    circle.setAttribute('stroke', color);
    circle.style.strokeDashoffset = offset;
    text.textContent = readinessRate + '%';
    var distList = document.getElementById('distributionList');
    distList.innerHTML = '';
    var total = totalStaff || 1;
    for (var center in distribution) {
        var count = distribution[center];
        var barWidth = Math.round((count / total) * 100);
        var isReady = count >= 2;
        var div = document.createElement('div');
        div.className = 'distribution-bar';
        div.innerHTML = '<span class="name">' + center + '</span><span class="count" style="' + (isReady ? 'color:#2a7f3e;' : 'color:#c0392b;') + '">' + count + '</span><div class="bar-track"><div class="bar-fill" style="width:' + barWidth + '%; background:' + (isReady ? '#2a7f3e' : '#c0392b') + ';"></div></div><span class="percent">' + barWidth + '%</span>';
        distList.appendChild(div);
    }
    var carDistList = document.getElementById('carDistributionList');
    carDistList.innerHTML = '';
    var totalCarsValue = totalCars || 1;
    for (var center2 in carDistribution) {
        var count2 = carDistribution[center2];
        var barWidth2 = Math.round((count2 / totalCarsValue) * 100);
        var hasCar = count2 >= 1;
        var div2 = document.createElement('div');
        div2.className = 'distribution-bar';
        div2.innerHTML = '<span class="name">' + center2 + '</span><span class="count" style="' + (hasCar ? 'color:#2a7f3e;' : 'color:#c0392b;') + '">' + count2 + '</span><div class="bar-track"><div class="bar-fill" style="width:' + barWidth2 + '%; background:' + (hasCar ? '#2980b9' : '#c0392b') + ';"></div></div><span class="percent">' + barWidth2 + '%</span>';
        carDistList.appendChild(div2);
    }
    if (totalStaff > 0 || totalCars > 0) {
        updateWorkforceDisplay(totalStaff, totalCars, readinessRate, missingCenters);
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

    calculateWorkforceStatsLocally();
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

async function loadShiftNotes() {
    if (currentShiftId) {
        try {
            var res = await apiFetch('/api/shift-notes/' + currentShiftId, { headers: { 'Authorization': 'Bearer ' + authToken } });
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

function renderShiftNotes() {
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
            var res = await apiFetch('/api/shift-notes/' + currentShiftId, { headers: { 'Authorization': 'Bearer ' + authToken } });
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
    calculateWorkforceStatsLocally();
    
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
    calculateWorkforceStatsLocally();
    
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
    calculateWorkforceStatsLocally();
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
    calculateWorkforceStatsLocally();
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
        filename: 'جميع_التقارير_' + new Date().toISOString().slice(0, 10) + '.pdf',
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
// نظام الوضع الليلي + الإنجازات (مقدماً قبل DOMContentLoaded)
// ============================================



// ============================================
// نظام الإنجازات والتحفيز (Gamification)
// ============================================

var achievements = [
    { id: 'first_report',  icon: '📊', name: 'أول بلاغ', desc: 'سجل أول بلاغ', check: function() { return getTotalReports() >= 1; }, max: 1 },
    { id: 'reports_10',    icon: '🔟', name: '10 بلاغات', desc: 'سجل 10 بلاغات', check: function() { return getTotalReports() >= 10; }, max: 10 },
    { id: 'reports_50',    icon: '📈', name: '50 بلاغ', desc: 'سجل 50 بلاغاً', check: function() { return getTotalReports() >= 50; }, max: 50 },
    { id: 'reports_100',   icon: '💯', name: '100 بلاغ', desc: 'سجل 100 بلاغ', check: function() { return getTotalReports() >= 100; }, max: 100 },
    { id: 'first_shift',  icon: '📋', name: 'أول مناوبة', desc: 'أكمل أول مناوبة', check: function() { return savedShifts.length >= 1; }, max: 1 },
    { id: 'shifts_10',    icon: '🌅', name: '10 مناوبات', desc: 'أكمل 10 مناوبات', check: function() { return savedShifts.length >= 10; }, max: 10 },
    { id: 'night_owl',    icon: '🦉', name: 'بومة الليل', desc: '5 مناوبات ليلية', check: function() { return countNightShifts() >= 5; }, max: 5 },
    { id: 'all_centers',  icon: '🏥', name: 'جميع المراكز', desc: 'سجل في 5 مراكز', check: function() { return getUniqueCenters() >= 5; }, max: 5 },
    { id: 'explorer',     icon: '🗺️', name: 'المستكشف', desc: 'افتح الخريطة 5 مرات', check: function() { return (gamificationStats.mapOpens || 0) >= 5; }, max: 5 },
    { id: 'pdf_master',   icon: '📄', name: 'سيد PDF', desc: 'صدر 3 تقارير PDF', check: function() { return (gamificationStats.pdfExports || 0) >= 3; }, max: 3 },
    { id: 'dark_mode',    icon: '🌙', name: 'وضع الليل', desc: 'فعّل الوضع الليلي', check: function() { return document.documentElement.getAttribute('data-theme') === 'dark'; }, max: 1 },
    { id: 'theme_master', icon: '🎨', name: 'سيد الثيمات', desc: 'ارفع ثيم مخصص', check: function() { return localStorage.getItem('headerBackground') !== null; }, max: 1 }
];

var gamificationStats = JSON.parse(localStorage.getItem('gamificationStats') || '{"mapOpens":0,"pdfExports":0,"notificationsSent":0}');
var unlockedAchievements = JSON.parse(localStorage.getItem('unlockedAchievements') || '[]');

var el_achievementsBtn=document.getElementById("achievementsBtn");if(el_achievementsBtn)el_achievementsBtn.addEventListener('click', function() {
    var el_achievementsModal_d54 = document.getElementById('achievementsModal'); if (el_achievementsModal_d54) el_achievementsModal_d54.style.display = 'flex';
    renderAchievements();
    renderLeaderboard();
});

function renderAchievements() {
    var grid = document.getElementById('achievementsGrid');
    if (!grid) return;
    
    grid.innerHTML = '';
    var unlockedCount = 0;
    
    // جلب إحصائيات الفرق
    var unitStats = getUnitStats();
    var topUnit = getTopUnit();
    
    console.log('[ACH] unitStats:', unitStats.length, 'topUnit:', topUnit.name, topUnit.count);
    
    for (var i = 0; i < achievements.length; i++) {
        var a = achievements[i];
        var isUnlocked = false;
        try { isUnlocked = a.check(); } catch(e) {}
        if (isUnlocked) unlockedCount++;
        
        var progress = 0;
        var extraInfo = '';
        
        if (a.id === 'first_report') { progress = Math.min(getTotalReports(), 1); extraInfo = unitStats.length > 0 ? '<div style="font-size:0.6rem;color:var(--teal);margin-top:3px;">📊 ' + getTotalReports() + ' بلاغ</div>' : ''; }
        else if (a.id === 'reports_10') { progress = Math.min(getTotalReports(), 10); extraInfo = unitStats.length > 0 ? '<div style="font-size:0.6rem;color:var(--teal);margin-top:3px;">📊 ' + getTotalReports() + ' بلاغ</div>' : ''; }
        else if (a.id === 'reports_50') { progress = Math.min(getTotalReports(), 50); extraInfo = unitStats.length > 0 ? '<div style="font-size:0.6rem;color:var(--teal);margin-top:3px;">📊 ' + getTotalReports() + ' بلاغ</div>' : ''; }
        else if (a.id === 'reports_100') { progress = Math.min(getTotalReports(), 100); extraInfo = unitStats.length > 0 ? '<div style="font-size:0.6rem;color:var(--teal);margin-top:3px;">📊 ' + getTotalReports() + ' بلاغ</div>' : ''; }
        else if (a.id === 'top_unit') { progress = topUnit.count > 0 ? 1 : 0; extraInfo = '<div style="font-size:0.6rem;color:var(--gold);margin-top:3px;">🏆 ' + escapeHtml(topUnit.name || '-') + ' (' + (topUnit.count || 0) + ')</div>'; }
        else if (a.id === 'unit_10') { progress = topUnit.count; extraInfo = '<div style="font-size:0.6rem;color:var(--gold);margin-top:3px;">🏆 ' + escapeHtml(topUnit.name || '-') + ' (' + (topUnit.count || 0) + ')</div>'; }
        else if (a.id === 'first_shift') progress = Math.min(savedShifts.length, 1);
        else if (a.id === 'shifts_10') progress = Math.min(savedShifts.length, 10);
        else if (a.id === 'night_owl') progress = Math.min(countNightShifts(), 5);
        else if (a.id === 'all_centers') { progress = Math.min(getUniqueCenters(), 5); extraInfo = '<div style="font-size:0.6rem;color:var(--primary-500);margin-top:3px;">📍 ' + getUniqueCenters() + ' مركز</div>'; }
        else if (a.id === 'explorer') progress = Math.min(gamificationStats.mapOpens || 0, 5);
        else if (a.id === 'pdf_master') progress = Math.min(gamificationStats.pdfExports || 0, 3);
        else if (a.id === 'dark_mode') progress = isUnlocked ? 1 : 0;
        else if (a.id === 'theme_master') progress = isUnlocked ? 1 : 0;
        else progress = isUnlocked ? 1 : 0;
        
        var percent = a.max > 0 ? Math.round((progress / a.max) * 100) : (isUnlocked ? 100 : 0);
        
        var card = document.createElement('div');
        card.className = 'achievement-card ' + (isUnlocked ? 'unlocked' : 'locked');
        card.innerHTML = 
            (isUnlocked ? '<span class="achievement-badge">✓</span>' : '') +
            '<span class="achievement-icon">' + a.icon + '</span>' +
            '<div class="achievement-name">' + a.name + '</div>' +
            '<div class="achievement-desc">' + a.desc + '</div>' +
            extraInfo +
            '<div class="achievement-progress">' +
                '<div class="achievement-progress-bar" style="width:' + percent + '%"></div>' +
            '</div>';
        
        grid.appendChild(card);
    }
    
    var totalPercent = achievements.length > 0 ? Math.round((unlockedCount / achievements.length) * 100) : 0;
    var progressPercentEl = document.getElementById('totalProgressPercent');
    var progressBarEl = document.getElementById('totalProgressBar');
    if (progressPercentEl) progressPercentEl.textContent = totalPercent + '%';
    if (progressBarEl) progressBarEl.style.width = totalPercent + '%';
    
    var newlyUnlocked = [];
    for (var j = 0; j < achievements.length; j++) {
        var achUnlocked = false;
        try { achUnlocked = achievements[j].check(); } catch(e) {}
        if (achUnlocked && unlockedAchievements.indexOf(achievements[j].id) === -1) {
            newlyUnlocked.push(achievements[j]);
            unlockedAchievements.push(achievements[j].id);
        }
    }
    localStorage.setItem('unlockedAchievements', JSON.stringify(unlockedAchievements));
    
    for (var k = 0; k < newlyUnlocked.length; k++) {
        showNotification('إنجاز جديد! 🎉', 'لقد حققت: ' + newlyUnlocked[k].name, 'success', 5000);
    }
}

function renderLeaderboard() {
    var tbody = document.querySelector('#leaderboardTable tbody');
    if (!tbody) return;
    
    // جلب إحصائيات الفرق الحقيقية من الـ reports
    var unitStats = getUnitStats();
    unitStats.sort(function(a, b) { return b.count - a.count; });
    
    console.log('[LB] unitStats count:', unitStats.length, 'units:', unitStats.map(function(u) { return u.name + ':' + u.count; }).join(', '));
    
    var html = '';
    
    if (unitStats.length === 0) {
        html = '<tr><td colspan="5" style="text-align:center;color:var(--gray-400);padding:20px;">📭 لا توجد بيانات بلاغات بعد.<br>سجل بلاغات من "الفرق الإسعافية" لتظهر الفرق هنا.</td></tr>';
    } else {
        for (var i = 0; i < Math.min(unitStats.length, 10); i++) {
            var u = unitStats[i];
            var rankIcon = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : (i + 1);
            var points = u.count * 10;
            html += '<tr>' +
                '<td style="text-align:center;font-size:1.2rem;">' + rankIcon + '</td>' +
                '<td><strong>' + escapeHtml(u.name) + '</strong></td>' +
                '<td style="color:var(--gray-600);font-size:0.8rem;">' + escapeHtml(u.center) + '</td>' +
                '<td style="text-align:center;"><strong style="color:var(--primary-700);">' + u.count + '</strong></td>' +
                '<td style="text-align:center;"><strong style="color:var(--gold);">' + points + '</strong></td>' +
            '</tr>';
        }
    }
    
    tbody.innerHTML = html;
}

function getUnitStats() {
    var stats = {};
    
    // مصدر 1: البلاغات الحالية (reports)
    for (var key in reports) {
        if (reports[key] && reports[key].count > 0) {
            var parts = key.split('|');
            var unit = parts.length > 1 ? parts[1] : key;
            var center = parts[0] || '';
            if (!stats[unit]) stats[unit] = { name: unit, center: center, count: 0 };
            stats[unit].count += reports[key].count;
        }
    }
    
    // مصدر 2: بلاغات المناوبات المحفوظة (allShifts)
    if (typeof allShifts !== 'undefined' && allShifts && allShifts.length > 0) {
        for (var i = 0; i < allShifts.length; i++) {
            var shift = allShifts[i];
            if (shift && shift.savedReports) {
                for (var sKey in shift.savedReports) {
                    var sReport = shift.savedReports[sKey];
                    if (sReport && sReport.count > 0) {
                        var sParts = sKey.split('|');
                        var sUnit = sParts.length > 1 ? sParts[1] : sKey;
                        var sCenter = sParts[0] || (shift.center || '');
                        if (!stats[sUnit]) stats[sUnit] = { name: sUnit, center: sCenter, count: 0 };
                        stats[sUnit].count += sReport.count;
                    }
                }
            }
        }
    }
    
    return Object.values(stats);
}

function getTopUnit() {
    var stats = getUnitStats();
    var top = { name: '-', count: 0, center: '' };
    for (var i = 0; i < stats.length; i++) {
        if (stats[i].count > top.count) top = stats[i];
    }
    return top;
}

function getTotalReports() {
    var total = 0;
    for (var key in reports) {
        total += (reports[key] && reports[key].count) || 0;
    }
    return total;
}

function countNightShifts() {
    var count = 0;
    for (var i = 0; i < savedShifts.length; i++) {
        if (savedShifts[i].shiftType === 'night') count++;
    }
    return count;
}

function getUniqueCenters() {
    var centers = {};
    for (var key in reports) {
        var parts = key.split('|');
        if (parts[0]) centers[parts[0]] = true;
    }
    return Object.keys(centers).length;
}

// ============================================
// Helper Functions
// ============================================


// ============================================
// ربط الأحداث الرئيسية
// ============================================
document.addEventListener('DOMContentLoaded', async function() {
    initWebSocket();
    loadBrandLogo();
    initSoundSettings();
    var currentDateEl = document.getElementById("currentDate");
    if (currentDateEl) currentDateEl.innerText = getSaudiDate();
    buildCentersTable();
    loadShifts();
    loadAllData();
    setupAutoAuditLogging();
    setTimeout(checkForAlerts, 1000);
    // ربط أزرار toolbar بعد اكتمال DOM
    var btn = document.getElementById("newShiftBtn"); if (btn) btn.onclick = startNewShift;
    btn = document.getElementById("shiftBtn"); if (btn) btn.onclick = function() { location.href='radio-completion.html?v=17'; };
    btn = document.getElementById("closeShiftBtn"); if (btn) btn.onclick = function() { var el_shiftModal_d55 = document.getElementById('shiftModal'); if (el_shiftModal_d55) el_shiftModal_d55.style.display = 'none'; };
    btn = document.getElementById("monthlyTableBtn"); if (btn) btn.onclick = function() { var el_monthlyTableModal_d56 = document.getElementById('monthlyTableModal'); if (el_monthlyTableModal_d56) el_monthlyTableModal_d56.style.display = 'flex'; loadSavedTable(); };
    btn = document.getElementById("closeMonthlyTableBtn"); if (btn) btn.onclick = function() { var el_monthlyTableModal_d57 = document.getElementById('monthlyTableModal'); if (el_monthlyTableModal_d57) el_monthlyTableModal_d57.style.display = 'none'; };
    btn = document.getElementById("controlBtn"); if (btn) btn.onclick = function() { var el_controlModal_d58 = document.getElementById('controlModal'); if (el_controlModal_d58) el_controlModal_d58.style.display = 'flex'; loadVacations().then(function() { renderControlList(false); }); };
    btn = document.getElementById("closeControlBtn"); if (btn) btn.onclick = function() {
        var el_controlModal_d59 = document.getElementById('controlModal'); if (el_controlModal_d59) el_controlModal_d59.style.display = 'none';
        isEditMode = false;
        var el_saveVacationsBtn_d60 = document.getElementById('saveVacationsBtn'); if (el_saveVacationsBtn_d60) el_saveVacationsBtn_d60.style.display = 'none';
        var el_editVacationsBtn_d61 = document.getElementById('editVacationsBtn'); if (el_editVacationsBtn_d61) el_editVacationsBtn_d61.style.display = 'inline-block';
    };
    btn = document.getElementById("saveShiftBtn"); if (btn) btn.onclick = saveShiftData;
    btn = document.getElementById("deleteShiftBtn"); if (btn) btn.onclick = deleteCurrentShift;
    btn = document.getElementById("viewShiftBtn"); if (btn) btn.onclick = viewShiftReports;
    btn = document.getElementById("returnToCurrentBtn"); if (btn) btn.onclick = returnToCurrentShift;
});

// فحص التنبيهات كل 10 ثواني
setInterval(checkForAlerts, 10000);

// ============================================
// تغيير الرقم السري
// ============================================
var el_changePasswordBtn=document.getElementById("changePasswordBtn");if(el_changePasswordBtn)el_changePasswordBtn.addEventListener('click', function() {
    var el_changePasswordModal_d62 = document.getElementById('changePasswordModal'); if (el_changePasswordModal_d62) el_changePasswordModal_d62.style.display = 'flex';
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
            var el_changePasswordModal_d63 = document.getElementById('changePasswordModal'); if (el_changePasswordModal_d63) el_changePasswordModal_d63.style.display = 'none';
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
    var el_changePasswordModal_d64 = document.getElementById('changePasswordModal'); if (el_changePasswordModal_d64) el_changePasswordModal_d64.style.display = 'none';
    var el_oldPasswordInput_v29 = document.getElementById('oldPasswordInput'); if (el_oldPasswordInput_v29) el_oldPasswordInput_v29.value = '';
    var el_newPasswordInput_v30 = document.getElementById('newPasswordInput'); if (el_newPasswordInput_v30) el_newPasswordInput_v30.value = '';
    var el_confirmNewPasswordInput_v31 = document.getElementById('confirmNewPasswordInput'); if (el_confirmNewPasswordInput_v31) el_confirmNewPasswordInput_v31.value = '';
});

// ============================================
// نظام QR Codes
// ============================================

var el_qrCodesBtn=document.getElementById("qrCodesBtn");if(el_qrCodesBtn)el_qrCodesBtn.addEventListener('click', function() {
    var el_qrModal_d65 = document.getElementById('qrModal'); if (el_qrModal_d65) el_qrModal_d65.style.display = 'flex';
    generateAllQRCodes();
});

function generateAllQRCodes() {
    var container = document.getElementById('qrCodesContainer');
    if (!container) return;
    container.innerHTML = '';
    
    // تجميع الفرق حسب المركز
    var centerGroups = {};
    for (var center in centersData) {
        centerGroups[center] = centersData[center];
    }
    
    for (var center in centerGroups) {
        var section = document.createElement('div');
        section.className = 'qr-section';
        
        var title = document.createElement('h3');
        title.innerHTML = '<i class="fas fa-hospital" style="color:var(--teal);"></i> ' + center;
        section.appendChild(title);
        
        var grid = document.createElement('div');
        grid.className = 'qr-grid';
        
        var units = centerGroups[center];
        for (var i = 0; i < units.length; i++) {
            var unit = units[i];
            var card = createQRCard(center, unit);
            grid.appendChild(card);
        }
        
        section.appendChild(grid);
        container.appendChild(section);
    }
}

function createQRCard(center, unit) {
    var card = document.createElement('div');
    card.className = 'qr-card';
    
    var qrDiv = document.createElement('div');
    qrDiv.className = 'qr-code-container';
    qrDiv.id = 'qr-' + unit.replace(/\s/g, '-');
    
    var unitName = document.createElement('div');
    unitName.className = 'qr-unit-name';
    unitName.textContent = unit;
    
    var centerName = document.createElement('div');
    centerName.className = 'qr-center-name';
    centerName.textContent = center;
    
    card.appendChild(qrDiv);
    card.appendChild(unitName);
    card.appendChild(centerName);
    
    // إنشاء QR Code بعد إضافة العنصر للـ DOM
    setTimeout(function() {
        var url = window.location.origin + '/api/report?center=' + encodeURIComponent(center) + '&unit=' + encodeURIComponent(unit);
        try {
            new QRCode(qrDiv, {
                text: url,
                width: 120,
                height: 120,
                colorDark: '#1E293B',
                colorLight: '#ffffff',
                correctLevel: QRCode.CorrectLevel.M
            });
        } catch(e) {
            qrDiv.innerHTML = '<div style="font-size:0.7rem; color:var(--coral);">خطأ في إنشاء QR</div>';
        }
    }, 100);
    
    // طباعة فردية
    card.addEventListener('click', function() {
        printQRCard(center, unit, card);
    });
    
    return card;
}

function printQRCard(center, unit, cardElement) {
    var printWindow = window.open('', '_blank');
    var url = window.location.origin + '/api/report?center=' + encodeURIComponent(center) + '&unit=' + encodeURIComponent(unit);
    
    printWindow.document.write('<html dir="rtl"><head><title>QR - ' + unit + '</title>');
    printWindow.document.write('<style>');
    printWindow.document.write('body { font-family: Arial; text-align: center; padding: 20px; }');
    printWindow.document.write('.qr-box { border: 2px solid #2563EB; border-radius: 12px; padding: 20px; display: inline-block; }');
    printWindow.document.write('h2 { color: #1E293B; margin: 0 0 5px; }');
    printWindow.document.write('p { color: #64748B; margin: 0 0 10px; font-size: 0.85rem; }');
    printWindow.document.write('</style></head><body>');
    printWindow.document.write('<div class="qr-box">');
    printWindow.document.write('<h2>' + unit + '</h2>');
    printWindow.document.write('<p>' + center + '</p>');
    printWindow.document.write(cardElement.querySelector('.qr-code-container').innerHTML);
    printWindow.document.write('<p style="font-size:0.7rem; margin-top:10px;">امسح الكود لتسجيل بلاغ</p>');
    printWindow.document.write('</div></body></html>');
    printWindow.document.close();
    
    setTimeout(function() {
        printWindow.print();
    }, 500);
}

function printAllQRCodes() {
    window.print();
}

// إغلاق النوافذ بالضغط خارجها
// ============================================
window.onclick = function(e) {
    var modals = ['shiftModal', 'airAmbulanceModal', 'monthlyTableModal', 'controlModal', 'passwordModal', 'changePasswordModal', 'seniorShiftModal', 'uploadDocsModal', 'docPreviewModal', 'peakTimeModal', 'peakMapModal', 'themeModal', 'distributionModal', 'mapModal', 'peakAlertModal', 'formsModal', 'operationsRoomModal', 'qrModal', 'analyticsModal', 'chartsModal', 'achievementsModal'];
    modals.forEach(function(id) {
        var modal = document.getElementById(id);
        if (e.target === modal) { modal.style.display = 'none'; }
    });
};

// ============================================
// تحديث تلقائي كل 3 ثواني
// ============================================
setInterval(function() {
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
        var res = await fetch('/api/operational-files', { headers: { 'Authorization': 'Bearer ' + authToken } });
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
        var response = await fetch('/api/theme-settings', { headers: { 'Authorization': 'Bearer ' + authToken } });
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
        var response = await fetch('/api/remove-theme', { method: 'DELETE' });
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
    var el_chartsModal_d67 = document.getElementById('chartsModal'); if (el_chartsModal_d67) el_chartsModal_d67.style.display = 'flex';
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
    for (var i = 0; i < 24; i++) {
        hours.push(i + ':00');
        var base = (i >= 16 && i <= 22) ? 15 : (i >= 8 && i <= 15) ? 8 : 3;
        data.push(base + Math.floor(Math.random() * 10));
    }

    if (chartInstances.hourly) chartInstances.hourly.destroy();

    chartInstances.hourly = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: hours,
            datasets: [{
                label: 'عدد البلاغات',
                data: data,
                backgroundColor: 'rgba(46, 139, 122, 0.7)',
                borderColor: '#10B981',
                borderWidth: 1,
                borderRadius: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false }
            },
            scales: {
                y: { beginAtZero: true, grid: { color: 'rgba(0,0,0,0.05)' } },
                x: { grid: { display: false } }
            }
        }
    });
}

function renderCenterChart() {
    var ctx = document.getElementById('centerChart');
    if (!ctx) return;

    var centerNames = [];
    var centerData = [];
    var colors = ['#2563EB', '#10B981', '#F59E0B', '#EF4444', '#2980B9', '#8E44AD', '#27AE60', '#D35400', '#16A085', '#C0392B'];

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
                borderColor: '#fff'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'right', labels: { font: { size: 10 }, boxWidth: 12 } }
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
                backgroundColor: 'rgba(232, 116, 97, 0.7)',
                borderColor: '#EF4444',
                borderWidth: 1,
                borderRadius: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            indexAxis: 'y',
            plugins: { legend: { display: false } },
            scales: {
                x: { beginAtZero: true, grid: { color: 'rgba(0,0,0,0.05)' } },
                y: { grid: { display: false } }
            }
        }
    });
}

function renderWeeklyChart() {
    var ctx = document.getElementById('weeklyChart');
    if (!ctx) return;
    
    var days = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
    var data = [];
    for (var i = 0; i < 7; i++) {
        data.push(Math.floor(Math.random() * 40) + 20);
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
                backgroundColor: 'rgba(232, 200, 74, 0.1)',
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
            plugins: { legend: { display: false } },
            scales: {
                y: { beginAtZero: true, grid: { color: 'rgba(0,0,0,0.05)' } },
                x: { grid: { display: false } }
            }
        }
    });
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
        '<div class="charts-summary-card"><div class="icon" style="background:var(--primary-100);color:var(--primary-700);"><i class="fas fa-chart-bar"></i></div><div class="info"><div class="value">' + total + '</div><div class="label">إجمالي البلاغات</div></div></div>' +
        '<div class="charts-summary-card"><div class="icon" style="background:var(--gold-50);color:var(--gold);"><i class="fas fa-trophy"></i></div><div class="info"><div class="value">' + topUnit + '</div><div class="label">الأكثر نشاطاً</div></div></div>' +
        '<div class="charts-summary-card"><div class="icon" style="background:var(--teal-50);color:var(--teal);"><i class="fas fa-hashtag"></i></div><div class="info"><div class="value">' + topCount + '</div><div class="label">بلاغات ' + topUnit + '</div></div></div>' +
        '<div class="charts-summary-card"><div class="icon" style="background:var(--coral-50);color:var(--coral);"><i class="fas fa-hospital"></i></div><div class="info"><div class="value">' + activeCenters + '</div><div class="label">مراكز نشطة</div></div></div>';
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
    link.download = 'بلاغات_' + new Date().toISOString().slice(0, 10) + '.csv';
    link.click();
    
    showNotification('تم التصدير', 'تم تصدير بيانات البلاغات بنجاح', 'success', 3000);
}

// ============================================
// لوحة التحكم المتقدمة (Analytics Dashboard)
// ============================================

var el_analyticsBtn=document.getElementById("analyticsBtn");if(el_analyticsBtn)el_analyticsBtn.addEventListener('click', function() {
    var el_analyticsModal_d68 = document.getElementById('analyticsModal'); if (el_analyticsModal_d68) el_analyticsModal_d68.style.display = 'flex';
    renderAnalyticsDashboard();
});






// ============================================
// سجل العمليات (Audit Log)
// ============================================

var auditLog = JSON.parse(localStorage.getItem('auditLog') || '[]');
var currentAuditFilter = 'all';

var el_auditLogBtn=document.getElementById("auditLogBtn");if(el_auditLogBtn)el_auditLogBtn.addEventListener('click', function() {
    var el_auditLogModal_d69 = document.getElementById('auditLogModal'); if (el_auditLogModal_d69) el_auditLogModal_d69.style.display = 'flex';
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
// WebSocket - تحديث فوري
// ============================================
var ws = null;
var wsConnected = false;



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
    fetch('/api/peak-data', { headers: { 'Authorization': 'Bearer ' + authToken } })
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
    var kpiActive = document.getElementById('opsKpiActive');
    if (kpiActive) kpiActive.textContent = Math.floor(Math.random() * 20 + 5);
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
    if (qaDistribution) qaDistribution.onclick = function() { var el_distributionModal_d70 = document.getElementById('distributionModal'); if (el_distributionModal_d70) el_distributionModal_d70.style.display = 'flex'; };
    
    var qaForms = document.getElementById('qaForms');
    if (qaForms) qaForms.onclick = function() { var el_formsModal_d71 = document.getElementById('formsModal'); if (el_formsModal_d71) el_formsModal_d71.style.display = 'flex'; };
    
    var qaStats = document.getElementById('qaStats');
    if (qaStats) qaStats.onclick = function() { var el_chartsModal_d72 = document.getElementById('chartsModal'); if (el_chartsModal_d72) el_chartsModal_d72.style.display = 'flex'; setTimeout(renderAllCharts, 300); };
    
    var sidebarNewShift = document.getElementById('sidebarNewShift');
    if (sidebarNewShift) sidebarNewShift.onclick = function() { toggleSidebar(); startNewShift(); };
    
    var sidebarShift = document.getElementById('sidebarShift');
    if (sidebarShift) sidebarShift.onclick = function() { toggleSidebar(); openShiftModal(); };
    
    var sidebarDistribution = document.getElementById('sidebarDistribution');
    if (sidebarDistribution) sidebarDistribution.onclick = function() { toggleSidebar(); var el_distributionModal_d73 = document.getElementById('distributionModal'); if (el_distributionModal_d73) el_distributionModal_d73.style.display = 'flex'; };
    
    var sidebarTable = document.getElementById('sidebarTable');
    if (sidebarTable) sidebarTable.onclick = function() { toggleSidebar(); var el_monthlyTableModal_d74 = document.getElementById('monthlyTableModal'); if (el_monthlyTableModal_d74) el_monthlyTableModal_d74.style.display = 'flex'; loadSavedTable(); };
    
    var sidebarSenior = document.getElementById('sidebarSenior');
    if (sidebarSenior) sidebarSenior.onclick = function() { toggleSidebar(); var el_seniorShiftModal_d75 = document.getElementById('seniorShiftModal'); if (el_seniorShiftModal_d75) el_seniorShiftModal_d75.style.display = 'flex'; };
    
    var sidebarControl = document.getElementById('sidebarControl');
    if (sidebarControl) sidebarControl.onclick = function() { toggleSidebar(); var el_controlModal_d76 = document.getElementById('controlModal'); if (el_controlModal_d76) el_controlModal_d76.style.display = 'flex'; loadVacations().then(function() { renderControlList(false); }); };
    
    var sidebarForms = document.getElementById('sidebarForms');
    if (sidebarForms) sidebarForms.onclick = function() { toggleSidebar(); var el_formsModal_d77 = document.getElementById('formsModal'); if (el_formsModal_d77) el_formsModal_d77.style.display = 'flex'; };
    
    var sidebarPeak = document.getElementById('sidebarPeak');
    if (sidebarPeak) sidebarPeak.onclick = function() { toggleSidebar(); var el_peakTimeModal_d78 = document.getElementById('peakTimeModal'); if (el_peakTimeModal_d78) el_peakTimeModal_d78.style.display = 'flex'; };
    
    var sidebarCharts = document.getElementById('sidebarCharts');
    if (sidebarCharts) sidebarCharts.onclick = function() { toggleSidebar(); var el_chartsModal_d79 = document.getElementById('chartsModal'); if (el_chartsModal_d79) el_chartsModal_d79.style.display = 'flex'; setTimeout(renderAllCharts, 300); };
    
    var sidebarAnalytics = document.getElementById('sidebarAnalytics');
    if (sidebarAnalytics) sidebarAnalytics.onclick = function() { toggleSidebar(); var el_analyticsModal_d80 = document.getElementById('analyticsModal'); if (el_analyticsModal_d80) el_analyticsModal_d80.style.display = 'flex'; };
    
    var sidebarAchievements = document.getElementById('sidebarAchievements');
    if (sidebarAchievements) sidebarAchievements.onclick = function() { toggleSidebar(); var el_achievementsModal_d81 = document.getElementById('achievementsModal'); if (el_achievementsModal_d81) el_achievementsModal_d81.style.display = 'flex'; };
    
    var sidebarAudit = document.getElementById('sidebarAudit');
    if (sidebarAudit) sidebarAudit.onclick = function() { toggleSidebar(); var el_auditLogModal_d82 = document.getElementById('auditLogModal'); if (el_auditLogModal_d82) el_auditLogModal_d82.style.display = 'flex'; };
    
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
function applyUserPermissions(user) {
    if (!user) user = currentUser;
    if (!user) return;
    var isAdmin = user.role === 'admin';
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
        var token = localStorage.getItem('authToken');
        if (token && typeof url === 'string' && url.startsWith('/api/')) {
            options.headers['Authorization'] = 'Bearer ' + token;
        }
        return originalFetch(url, options);
    };
}


// ============================================
// PEAK TIME SYSTEM v2 — نظام إدارة وقت الذروة
// ============================================

var peakPlans = JSON.parse(localStorage.getItem('peakPlans') || '[]');
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

// ----- Modal Open/Close -----
function openPeakTimeModal() {
    var el_peakTimeModal_d85 = document.getElementById('peakTimeModal'); if (el_peakTimeModal_d85) el_peakTimeModal_d85.style.display = 'flex';
    switchPeakTab('dashboard');
    refreshPeakDashboard();
    initPeakFormDefaults();
}

function closePeakTimeModal() {
    var el_peakTimeModal_d86 = document.getElementById('peakTimeModal'); if (el_peakTimeModal_d86) el_peakTimeModal_d86.style.display = 'none';
}

// Replace the old event listener
var el_peakTimeBtn = document.getElementById('peakTimeBtn');
if (el_peakTimeBtn) {
    el_peakTimeBtn.onclick = function() { openPeakTimeModal(); };
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
    var now = new Date();
    var yr = now.getFullYear();
    var mo = String(now.getMonth()+1).padStart(2,'0');
    var da = String(now.getDate()).padStart(2,'0');
    var hr = String(now.getHours()).padStart(2,'0');
    var mi = String(now.getMinutes()).padStart(2,'0');
    var startStr = yr + '-' + mo + '-' + da + 'T' + hr + ':' + mi;
    var end = new Date(now.getTime() + 2*60*60*1000);
    var ehr = String(end.getHours()).padStart(2,'0');
    var emi = String(end.getMinutes()).padStart(2,'0');
    var endStr = yr + '-' + mo + '-' + da + 'T' + ehr + ':' + emi;
    var elStart = document.getElementById('peakStartTime');
    if (elStart) elStart.value = startStr;
    var elEnd = document.getElementById('peakEndTime');
    if (elEnd) elEnd.value = endStr;
}

// ----- Save Plan -----
function savePeakPlan() {
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

    var planId = 'plan_' + Date.now();
    var plan = {
        id: planId,
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

    peakPlans.unshift(plan);
    localStorage.setItem('peakPlans', JSON.stringify(peakPlans));
    clearPeakForm();
    alert('✅ تم حفظ خطة التمركز');
    switchPeakTab('dashboard');
    refreshPeakDashboard();
    startPeakReminders(plan);
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
    msg += 'تم الإرسال: ' + new Date().toLocaleString('ar-SA');
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
        html += '⏰ ' + (plan.startTime ? plan.startTime.replace('T',' ') : '-') + ' → ' + (plan.endTime ? plan.endTime.replace('T',' ') : '-') + '</div>';
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

function confirmPeakArrival(planId) {
    var plan = peakPlans.find(function(p) { return p.id === planId; });
    if (!plan) return;
    plan.arrivalTime = new Date().toISOString();
    localStorage.setItem('peakPlans', JSON.stringify(peakPlans));
    renderPeakDeployments();
    refreshPeakDashboard();
    showToast('✅ تم تأكيد وصول ' + plan.unit, 'success');
    playPeakSound('arrival');
}

function confirmPeakDeparture(planId) {
    var plan = peakPlans.find(function(p) { return p.id === planId; });
    if (!plan) return;
    plan.departureTime = new Date().toISOString();
    localStorage.setItem('peakPlans', JSON.stringify(peakPlans));
    renderPeakDeployments();
    refreshPeakDashboard();
    showToast('✅ تم تأكيد مغادرة ' + plan.unit, 'success');
}

function resolvePeakPlan(planId) {
    if (!confirm('⚠️ هل أنت متأكد من إنهاء هذه الخطة؟')) return;
    var plan = peakPlans.find(function(p) { return p.id === planId; });
    if (!plan) return;
    plan.status = 'completed';
    plan.departureTime = plan.departureTime || new Date().toISOString();
    localStorage.setItem('peakPlans', JSON.stringify(peakPlans));
    stopPeakCountdown(planId);
    renderPeakDeployments();
    refreshPeakDashboard();
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
        html += '<div style="font-size:0.75rem; color:var(--gray-500);">⏰ ' + (plan.startTime ? plan.startTime.replace('T',' ') : '-') + '</div></div>';
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
        csv += (p.title || '') + ',' + pt.label + ',' + (p.unit || '') + ',' + (PEAK_TEAM_TYPES[p.teamType] || '') + ',' + (p.location || '') + ',' + (p.startTime || '') + ',' + (p.endTime || '') + ',' + (p.status === 'active' ? 'نشط' : 'منتهي') + '\n';
    });
    var blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    var link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'تمركزات_' + new Date().toISOString().slice(0,10) + '.csv';
    link.click();
    showToast('✅ تم التصدير', 'success');
}

// ----- Cleanup on load -----
function cleanupPeakPlans() {
    var now = new Date();
    peakPlans.forEach(function(p) {
        if (p.status === 'active' && p.endTime && new Date(p.endTime) < now) {
            p.status = 'completed';
        }
    });
    localStorage.setItem('peakPlans', JSON.stringify(peakPlans));
}

// Run cleanup on startup
cleanupPeakPlans();

// Update the sidebar button
var sidebarPeak = document.getElementById('sidebarPeak');
if (sidebarPeak) sidebarPeak.onclick = function() { toggleSidebar(); openPeakTimeModal(); };
