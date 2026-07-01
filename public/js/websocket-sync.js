// ============================================
// WebSocket Sync Client — جميع الصفحات
// يتصل بالخادم ويستقبل broadcast updates + يعرض إشعارات + يحدث البيانات
// ============================================
(function() {
    var authToken = localStorage.getItem('authToken');
    if (!authToken) {
        console.log('Sync: no authToken, skipping WebSocket');
        return;
    }

    // =====================
    // إشعارات بسيطة تعمل في جميع الصفحات
    // =====================
    function showSyncToast(message) {
        if (typeof showToast === 'function') {
            showToast('info', 'تحديث', message);
            return;
        }
        if (typeof showNotification === 'function') {
            showNotification('تحديث', message, 'info', 3000);
            return;
        }
        var toast = document.createElement('div');
        toast.textContent = message;
        toast.style.cssText = 'position:fixed; top:20px; left:50%; transform:translateX(-50%); z-index:99999; background:#1E3A5F; color:#fff; padding:10px 20px; border-radius:8px; font-size:14px; box-shadow:0 4px 12px rgba(0,0,0,0.3); animation:slideDown 0.3s ease; direction:rtl;';
        document.body.appendChild(toast);
        setTimeout(function() { toast.remove(); }, 3000);
    }

    if (!document.getElementById('sync-toast-style')) {
        var style = document.createElement('style');
        style.id = 'sync-toast-style';
        style.textContent = '@keyframes slideDown { from { opacity:0; transform:translate(-50%, -20px); } to { opacity:1; transform:translate(-50%, 0); } }';
        document.head.appendChild(style);
    }

    var wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var ws = new WebSocket(wsProtocol + '//' + location.host + '/ws');
    var wsConnected = false;

    ws.onopen = function() {
        wsConnected = true;
        console.log('✅ Sync WebSocket connected');
    };

    ws.onmessage = function(event) {
        try {
            var data = JSON.parse(event.data);
            console.log('📡 Sync received:', data.type, data.message || '');

            if (data.type === 'connected') {
                console.log('WS:', data.message);
                return;
            }

            // عرض إشعار
            if (data.message) {
                showSyncToast(data.message);
            }

            // ✅ الطريقة الجديدة: syncUpdate() في كل صفحة
            if (typeof syncUpdate === 'function') {
                console.log('🔄 Calling syncUpdate() for type:', data.type);
                syncUpdate();
                return;
            }

            // fallback: الدوال القديمة
            switch(data.type) {
                case 'new_report':
                    if (typeof refreshReports === 'function') refreshReports();
                    if (typeof loadData === 'function') loadData();
                    if (typeof loadAllData === 'function') loadAllData();
                    break;
                case 'shift_started':
                case 'shift_updated':
                case 'shift_deleted':
                    if (typeof loadShifts === 'function') loadShifts();
                    if (typeof loadData === 'function') loadData();
                    if (typeof loadAllData === 'function') loadAllData();
                    break;
                case 'control_notes_updated':
                    if (typeof loadControlNotes === 'function') loadControlNotes();
                    break;
                case 'vacations_updated':
                    if (typeof loadVacations === 'function') loadVacations();
                    if (typeof renderControlList === 'function') renderControlList(false);
                    break;
                case 'air_ambulance_saved':
                case 'air_ambulance_deleted':
                case 'air_ambulance_cleared':
                    if (typeof loadAirRecords === 'function') loadAirRecords();
                    break;
                case 'peak_mission_added':
                case 'peak_alert_resolved':
                    if (typeof checkForAlerts === 'function') checkForAlerts();
                    break;
                case 'doc_uploaded':
                case 'doc_deleted':
                    if (typeof loadDocsData === 'function') loadDocsData();
                    break;
                case 'ops_files_uploaded':
                case 'ops_file_deleted':
                    if (typeof opsLoadData === 'function') opsLoadData();
                    if (typeof renderFiles === 'function') renderFiles();
                    break;
                case 'monthly_table_uploaded':
                    if (typeof loadSavedTable === 'function') loadSavedTable(true);
                    if (typeof loadData === 'function') loadData();
                    break;
                case 'identity_uploaded':
                    if (typeof loadData === 'function') loadData();
                    break;
                case 'theme_updated':
                    if (typeof applyGlobalTheme === 'function') applyGlobalTheme();
                    break;
                default:
                    console.log('Sync: unknown type', data.type);
            }
        } catch(e) {
            console.error('Sync WS parse error:', e);
        }
    };

    ws.onerror = function(err) {
        console.error('Sync WebSocket error:', err);
    };

    ws.onclose = function() {
        wsConnected = false;
        console.log('Sync WebSocket closed, reconnecting in 5s...');
        setTimeout(function() {
            location.reload();
        }, 5000);
    };
})();
