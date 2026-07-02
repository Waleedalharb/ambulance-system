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
        // try showNotification first (app.js has this)
        if (typeof showNotification === 'function') {
            showNotification('تحديث', message, 'info', 3000);
            return;
        }
        // try showToast next (report-entry.html has showToast(message, type))
        if (typeof showToast === 'function') {
            try {
                showToast(message, 'info');
                return;
            } catch(e) {
                // showToast may have different signature, fallback
            }
        }
        // fallback DOM toast
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
                // لا return هنا — استمر في الـ switch للـ fallback
            }

            // fallback: الدوال القديمة + الأنواع الجديدة
            switch(data.type) {
                // التقارير القديمة
                case 'new_report':
                    if (typeof refreshReports === 'function') refreshReports();
                    if (typeof loadData === 'function') loadData();
                    if (typeof loadAllData === 'function') loadAllData();
                    break;
                // الورديات
                case 'shift_started':
                case 'shift_updated':
                case 'shift_deleted':
                    if (typeof loadShifts === 'function') loadShifts();
                    if (typeof loadData === 'function') loadData();
                    if (typeof loadAllData === 'function') loadAllData();
                    break;
                // ملاحظات التحكم
                case 'control_notes_updated':
                case 'control_notes_cleared':
                    if (typeof loadControlNotes === 'function') loadControlNotes();
                    break;
                // الإجازات
                case 'vacations_updated':
                case 'vacations_cleared':
                    if (typeof loadVacations === 'function') loadVacations();
                    if (typeof renderControlList === 'function') renderControlList(false);
                    break;
                // الطيران
                case 'air_ambulance_saved':
                case 'air_ambulance_deleted':
                case 'air_ambulance_cleared':
                    if (typeof loadAirRecords === 'function') loadAirRecords();
                    break;
                // الذروة القديمة
                case 'peak_mission_added':
                case 'peak_alert_resolved':
                case 'peak_mission_deleted':
                    if (typeof checkForAlerts === 'function') checkForAlerts();
                    if (typeof loadPeakPlans === 'function') loadPeakPlans();
                    break;
                // المستندات
                case 'doc_uploaded':
                case 'doc_deleted':
                    if (typeof loadDocsData === 'function') loadDocsData();
                    break;
                // ملفات العمليات
                case 'ops_files_uploaded':
                case 'ops_file_deleted':
                    if (typeof opsLoadData === 'function') opsLoadData();
                    if (typeof renderFiles === 'function') renderFiles();
                    break;
                // الجدول الشهري
                case 'monthly_table_uploaded':
                case 'monthly_table_deleted':
                    if (typeof loadSavedTable === 'function') loadSavedTable(true);
                    if (typeof loadData === 'function') loadData();
                    break;
                // الهوية
                case 'identity_uploaded':
                    if (typeof loadData === 'function') loadData();
                    break;
                // الثيم
                case 'theme_updated':
                case 'theme_removed':
                    if (typeof applyGlobalTheme === 'function') applyGlobalTheme();
                    if (typeof loadTheme === 'function') loadTheme();
                    break;

                // ====== الأنواع الجديدة: report-entry ======
                case 'report_entry_added':
                case 'report_entry_deleted':
                case 'report_entry_cleared':
                    if (typeof getRecords === 'function') getRecords();
                    if (typeof loadReports === 'function') loadReports();
                    if (typeof loadData === 'function') loadData();
                    if (typeof loadAllData === 'function') loadAllData();
                    break;

                // ====== الأنواع الجديدة: smart-schedule ======
                case 'schedule_employees_updated':
                case 'schedule_employees_cleared':
                    if (typeof loadFromServer === 'function') loadFromServer();
                    if (typeof loadEmployees === 'function') loadEmployees();
                    if (typeof loadData === 'function') loadData();
                    if (typeof loadAllData === 'function') loadAllData();
                    break;
                case 'schedule_files_updated':
                    if (typeof loadSavedFiles === 'function') loadSavedFiles();
                    if (typeof loadFiles === 'function') loadFiles();
                    if (typeof loadData === 'function') loadData();
                    break;

                // ====== الأنواع الجديدة: operations-command ======
                case 'dashboard_updated':
                    if (typeof renderDashboard === 'function') renderDashboard();
                    if (typeof loadDashboard === 'function') loadDashboard();
                    if (typeof loadData === 'function') loadData();
                    break;
                case 'hospitals_updated':
                    if (typeof renderHospitals === 'function') renderHospitals();
                    if (typeof loadHospitals === 'function') loadHospitals();
                    if (typeof loadData === 'function') loadData();
                    break;
                case 'references_updated':
                    if (typeof renderReferences === 'function') renderReferences();
                    if (typeof loadReferences === 'function') loadReferences();
                    if (typeof loadData === 'function') loadData();
                    break;
                case 'timeline_updated':
                    if (typeof renderTimeline === 'function') renderTimeline();
                    if (typeof loadTimeline === 'function') loadTimeline();
                    if (typeof loadData === 'function') loadData();
                    break;
                case 'announcements_updated':
                case 'announcement_deleted':
                case 'announcement_added':
                    if (typeof renderAnnouncements === 'function') renderAnnouncements();
                    if (typeof loadAnnouncements === 'function') loadAnnouncements();
                    if (typeof loadData === 'function') loadData();
                    break;
                case 'unit_location_updated':
                    if (typeof loadUnitLocations === 'function') loadUnitLocations();
                    if (typeof loadData === 'function') loadData();
                    if (typeof loadAllData === 'function') loadAllData();
                    break;
                case 'shift_auto_archived':
                    if (typeof loadAllData === 'function') loadAllData();
                    if (typeof loadShifts === 'function') loadShifts();
                    showNotification('نظام النوبات', data.message, 'info', 5000);
                    break;

                // ====== الأنواع الجديدة: app.js forms ======
                case 'incident_added':
                case 'incident_deleted':
                    if (typeof loadIncidents === 'function') loadIncidents();
                    if (typeof loadIncidentRecords === 'function') loadIncidentRecords();
                    if (typeof loadData === 'function') loadData();
                    if (typeof loadAllData === 'function') loadAllData();
                    break;
                case 'senior_shift_added':
                case 'senior_shift_deleted':
                    if (typeof loadSeniorShifts === 'function') loadSeniorShifts();
                    if (typeof loadShiftRecords === 'function') loadShiftRecords();
                    if (typeof loadData === 'function') loadData();
                    if (typeof loadAllData === 'function') loadAllData();
                    break;
                case 'e_case_added':
                case 'e_case_deleted':
                    if (typeof loadECases === 'function') loadECases();
                    if (typeof loadERecords === 'function') loadERecords();
                    if (typeof loadData === 'function') loadData();
                    if (typeof loadAllData === 'function') loadAllData();
                    break;
                case 'escalation_added':
                case 'escalation_deleted':
                    if (typeof loadEscalations === 'function') loadEscalations();
                    if (typeof loadEscalationRecords === 'function') loadEscalationRecords();
                    if (typeof loadData === 'function') loadData();
                    if (typeof loadAllData === 'function') loadAllData();
                    break;
                case 'daily_report_added':
                case 'daily_report_deleted':
                    if (typeof loadDailyReports === 'function') loadDailyReports();
                    if (typeof loadDailyRecords === 'function') loadDailyRecords();
                    if (typeof loadData === 'function') loadData();
                    if (typeof loadAllData === 'function') loadAllData();
                    break;

                // ====== الأنواع الجديدة: app.js logs ======
                case 'shift_event_added':
                case 'shift_event_deleted':
                    if (typeof loadShiftEvents === 'function') loadShiftEvents();
                    if (typeof loadEventLog === 'function') loadEventLog();
                    if (typeof loadData === 'function') loadData();
                    break;
                case 'shift_absence_added':
                case 'shift_absence_deleted':
                    if (typeof loadShiftAbsences === 'function') loadShiftAbsences();
                    if (typeof loadAbsenceRecords === 'function') loadAbsenceRecords();
                    if (typeof loadData === 'function') loadData();
                    break;
                case 'shift_note_added':
                case 'shift_note_deleted':
                    if (typeof loadShiftNotes === 'function') loadShiftNotes();
                    if (typeof loadNotes === 'function') loadNotes();
                    if (typeof loadData === 'function') loadData();
                    break;
                case 'peak_plan_added':
                case 'peak_plan_deleted':
                    if (typeof loadPeakPlans === 'function') loadPeakPlans();
                    if (typeof checkForAlerts === 'function') checkForAlerts();
                    if (typeof loadData === 'function') loadData();
                    break;
                case 'audit_log_added':
                    if (typeof loadAuditLog === 'function') loadAuditLog();
                    if (typeof renderAuditLog === 'function') renderAuditLog();
                    if (typeof loadData === 'function') loadData();
                    break;

                // ====== أنواع أخرى ======
                case 'report_undone':
                    if (typeof loadReports === 'function') loadReports();
                    if (typeof loadData === 'function') loadData();
                    if (typeof loadAllData === 'function') loadAllData();
                    break;
                case 'password_changed':
                    // no specific refresh needed, toast already shown
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
