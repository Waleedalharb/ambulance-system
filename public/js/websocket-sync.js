// ============================================
// WebSocket Sync Client — جميع الصفحات
// يتصل بالخادم ويستقبل broadcast updates
// ============================================
(function() {
    var authToken = localStorage.getItem('authToken');
    if (!authToken) {
        console.log('Sync: no authToken, skipping WebSocket');
        return;
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
                case 'connected':
                    // handshake, ignore
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
