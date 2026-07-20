// ============================================
// Sync Client (SSE) — جميع الصفحات
// OV-S6 (قناة لحظية واحدة): النقل حُوّل من WebSocket إلى Server-Sent Events
// على /api/sse — نفس قناة app.js. WebSocket أصبح محجوزاً حصرياً للشات.
// يستقبل broadcast updates + يعرض إشعارات + يحدث البيانات
// عقد المعالجة الخارجي لم يتغير: syncUpdate، showSyncToast،
// updateConnectionStatusUI، وكل فروع switch لأنواع الأحداث كما هي.
// ============================================
(function() {
    // لا إنهاء مبكر عند غياب التوكن هنا: هذا الملف يُحمَّل قبل تسجيل الدخول،
    // والخروج المبكر كان يمنع تسجيل AuthGate.onStart فلا يتصل SSE بعد الدخول إلا بإعادة تحميل.
    // الفحص الفعلي للتوكن يتم داخل connect() وعبر بوابة AuthGate.

    // =====================
    // إشعارات — أضف للجرس إذا كان متوفر، وإلا Toast fallback
    // =====================
    function showSyncToast(message, type) {
        var catMap = {
            'new_report': 'report', 'shift_started': 'shift', 'shift_updated': 'shift',
            'shift_deleted': 'shift', 'ops_file_deleted': 'file', 'ops_files_uploaded': 'file',
            'audit_log_added': 'system', 'file_deleted': 'file', 'file_uploaded': 'file',
            'peak_mission': 'peak', 'peak_resolve': 'peak', 'control_notes_updated': 'system',
            'vacations_updated': 'system', 'theme_uploaded': 'theme', 'user_login': 'user',
            'chat_message': 'chat'
        };
        var titleMap = {
            'new_report': 'بلاغ جديد', 'shift_started': 'مناوبة جديدة', 'shift_updated': 'تحديث مناوبة',
            'shift_deleted': 'حذف مناوبة', 'ops_file_deleted': 'حذف ملف', 'ops_files_uploaded': 'رفع ملف',
            'audit_log_added': 'سجل عمليات', 'peak_mission': 'مهمة ذروة', 'peak_resolve': 'إنجاز مهمة',
            'control_notes_updated': 'تحديث ملاحظات', 'vacations_updated': 'تحديث إجازات',
            'theme_uploaded': 'تحديث ثيم', 'user_login': 'دخول مستخدم', 'chat_message': 'رسالة جديدة'
        };
        var cat = catMap[type] || 'system';
        var title = titleMap[type] || (type ? type.replace(/_/g, ' ') : 'إشعار');
        if (typeof addNotification === 'function') {
            addNotification(title, message, cat);
            return;
        }
        if (typeof showNotification === 'function') {
            showNotification('تحديث', message, 'info', 3000);
            return;
        }
        if (typeof showToast === 'function') {
            try { showToast(message, 'info'); return; } catch(e) {}
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

    // OV-S6: مفتاح التوكن الموحد — auth_access_token (AuthManager) أولاً ثم authToken (القديم) احتياطاً
    function getSyncToken() {
        return localStorage.getItem('auth_access_token') || localStorage.getItem('authToken');
    }

    var es = null;
    var sseConnected = false;
    var reconnectAttempts = 0;
    var maxReconnectAttempts = 10;
    var reconnectDelay = 3000;
    var stopped = false; // AuthGate: إيقاف نهائي — بلا إعادة اتصال بعد الخروج/انتهاء الجلسة

    function connect() {
        if (stopped) return;
        // Include auth token in SSE connection (same contract as app.js /api/sse?token=)
        var token = getSyncToken();
        if (!token) {
            console.log('Sync: no auth token, skipping SSE connect');
            return;
        }
        try {
            if (es) {
                try { es.close(); } catch(e) {}
                es = null;
            }
            es = new EventSource('/api/sse?token=' + encodeURIComponent(token));
        } catch(e) {
            console.error('SSE creation failed:', e);
            scheduleReconnect();
            return;
        }

        es.onopen = function() {
            sseConnected = true;
            reconnectAttempts = 0;
            console.log('✅ Sync SSE connected');
            // Update UI status indicator
            if (typeof updateConnectionStatusUI === 'function') {
                updateConnectionStatusUI(true);
            }
        };

        es.onmessage = function(event) {
            try {
                var data = JSON.parse(event.data);
                console.log('📡 Sync received:', data.type, data.message || '');

                if (data.type === 'ping' || data.type === 'pong') {
                    return;
                }

                if (data.type === 'connected') {
                    console.log('SSE:', data.message);
                    return;
                }

                // عرض إشعار
                if (data.message) {
                    showSyncToast(data.message, data.type);
                }

                // syncUpdate() في كل صفحة
                if (typeof syncUpdate === 'function') {
                    console.log('🔄 Calling syncUpdate() for type:', data.type);
                    syncUpdate();
                }

                // fallback: الدوال القديمة + الأنواع الجديدة
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
                    case 'control_notes_cleared':
                        if (typeof loadControlNotes === 'function') loadControlNotes();
                        break;
                    case 'vacations_updated':
                    case 'vacations_cleared':
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
                    case 'peak_mission_deleted':
                        if (typeof checkForAlerts === 'function') checkForAlerts();
                        if (typeof loadPeakPlans === 'function') loadPeakPlans();
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
                    case 'monthly_table_deleted':
                        if (typeof loadSavedTable === 'function') loadSavedTable(true);
                        if (typeof loadData === 'function') loadData();
                        break;
                    case 'identity_uploaded':
                        if (typeof loadData === 'function') loadData();
                        break;
                    case 'theme_updated':
                    case 'theme_removed':
                        if (typeof applyGlobalTheme === 'function') applyGlobalTheme();
                        if (typeof loadTheme === 'function') loadTheme();
                        break;
                    case 'report_entry_added':
                    case 'report_entry_deleted':
                    case 'report_entry_cleared':
                        if (typeof getRecords === 'function') getRecords();
                        if (typeof loadReports === 'function') loadReports();
                        if (typeof loadData === 'function') loadData();
                        if (typeof loadAllData === 'function') loadAllData();
                        break;
                    case 'schedule_employees_updated':
                    case 'schedule_employees_cleared':
                        // F6/D4: إعادة الجلب من المصدر الرسمي (JSON /api/schedule/employees) بدل loadFromServer العلائقية الفارغة
                        if (typeof fetchEmployeesFromServerSilent === 'function') {
                            fetchEmployeesFromServerSilent().then(function(list) {
                                if (list && typeof adoptServerEmployees === 'function') adoptServerEmployees(list);
                            });
                        }
                        if (typeof loadEmployees === 'function') loadEmployees();
                        if (typeof loadData === 'function') loadData();
                        if (typeof loadAllData === 'function') loadAllData();
                        break;
                    case 'schedule_files_updated':
                        if (typeof loadSavedFiles === 'function') loadSavedFiles();
                        if (typeof loadFiles === 'function') loadFiles();
                        if (typeof loadData === 'function') loadData();
                        break;
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
                    case 'peak_plan_updated':
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
                    case 'chat_message':
                        if (typeof ChatIntegration !== 'undefined' && ChatIntegration.updateBadge) {
                            ChatIntegration.updateBadge();
                        }
                        if (typeof updateChatBadge === 'function') {
                            updateChatBadge();
                        }
                        if (data.message && data.message.sender_name) {
                            showSyncToast('رسالة جديدة من ' + data.message.sender_name + ': ' + (data.message.content || ''), 'chat_message');
                        }
                        break;
                    case 'chat_read':
                        if (typeof ChatIntegration !== 'undefined' && ChatIntegration.updateBadge) {
                            ChatIntegration.updateBadge();
                        }
                        if (typeof updateChatBadge === 'function') {
                            updateChatBadge();
                        }
                        break;
                    case 'chat_typing':
                        break;
                    case 'report_undone':
                        if (typeof loadReports === 'function') loadReports();
                        if (typeof loadData === 'function') loadData();
                        if (typeof loadAllData === 'function') loadAllData();
                        break;
                    case 'completion_updated':
                    case 'team_status_changed':
                        // Completion/Radio status updated — refresh workforce and distribution
                        // Update readyTeamNames directly from the event data for instant reflection
                        if (data.teamId && data.status) {
                            window.readyTeamNames = window.readyTeamNames || {};
                            var tid = data.teamId;
                            var isOperational = (/^rapid_[1-5]$/.test(tid) || /^جنوب [1-9]$/.test(tid) || /^جنوب 1[0-6]$/.test(tid));
                            if (data.status === 'ready' && isOperational) {
                                window.readyTeamNames[tid] = true;
                                // Add name variants for distribution indicator matching
                                if (/^rapid_[1-5]$/.test(tid)) {
                                    var num = tid.replace('rapid_', '');
                                    window.readyTeamNames['سريع ' + num] = true;
                                    window.readyTeamNames['تدخل سريع ' + num] = true;
                                    window.readyTeamNames['rapid ' + num] = true;
                                }
                                if (/^جنوب [1-9]$/.test(tid) || /^جنوب 1[0-6]$/.test(tid)) {
                                    var num = tid.replace('جنوب ', '');
                                    window.readyTeamNames['جنوب ' + num] = true;
                                    window.readyTeamNames['south ' + num] = true;
                                }
                            } else {
                                delete window.readyTeamNames[tid];
                                // Remove name variants
                                if (/^rapid_[1-5]$/.test(tid)) {
                                    var num = tid.replace('rapid_', '');
                                    delete window.readyTeamNames['سريع ' + num];
                                    delete window.readyTeamNames['تدخل سريع ' + num];
                                    delete window.readyTeamNames['rapid ' + num];
                                }
                                if (/^جنوب [1-9]$/.test(tid) || /^جنوب 1[0-6]$/.test(tid)) {
                                    var num = tid.replace('جنوب ', '');
                                    delete window.readyTeamNames['جنوب ' + num];
                                    delete window.readyTeamNames['south ' + num];
                                }
                            }
                        }
                        if (typeof refreshReadyTeamNames === 'function') {
                            refreshReadyTeamNames(function() {
                                if (typeof updateWorkforceStats === 'function') updateWorkforceStats();
                                if (typeof buildCentersTable === 'function') buildCentersTable();
                                if (typeof calculateWorkforceStatsLocally === 'function') calculateWorkforceStatsLocally();
                                if (typeof updateDistributionIndicator === 'function') updateDistributionIndicator();
                                if (typeof renderAdvancedDistribution === 'function') renderAdvancedDistribution();
                                if (typeof loadData === 'function') loadData();
                                if (typeof loadAllData === 'function') loadAllData();
                            });
                        } else {
                            if (typeof updateWorkforceStats === 'function') updateWorkforceStats();
                            if (typeof buildCentersTable === 'function') buildCentersTable();
                            if (typeof calculateWorkforceStatsLocally === 'function') calculateWorkforceStatsLocally();
                            if (typeof updateDistributionIndicator === 'function') updateDistributionIndicator();
                            if (typeof renderAdvancedDistribution === 'function') renderAdvancedDistribution();
                            if (typeof loadData === 'function') loadData();
                            if (typeof loadAllData === 'function') loadAllData();
                        }
                        break;
                    case 'password_changed':
                        break;
                    case 'user_online':
                    case 'user_offline':
                        // أحداث حضور (شات) — لا تصل هنا بعد OV-S6 (أصبحت WS-only عبر broadcastToAll)
                        // يبقى الفرع للتوافق إن عاد الحدث عبر القناة العامة مستقبلاً
                        if (data.onlineUsers) {
                            window.onlineUsersList = data.onlineUsers;
                            if (typeof updateOnlineUsersUI === 'function') {
                                updateOnlineUsersUI(data.onlineUsers);
                            }
                        }
                        if (typeof updateUserStatusIndicator === 'function') {
                            updateUserStatusIndicator(data.userId, data.type === 'user_online');
                        }
                        break;
                    case 'online_users':
                        // Full list of online users
                        if (data.users) {
                            window.onlineUsersList = data.users;
                            if (typeof updateOnlineUsersUI === 'function') {
                                updateOnlineUsersUI(data.users);
                            }
                        }
                        break;
                    default:
                        console.log('Sync: unknown type', data.type);
                }
            } catch(e) {
                console.error('Sync SSE parse error:', e);
            }
        };

        es.onerror = function(err) {
            var wasConnected = sseConnected;
            sseConnected = false;
            if (typeof updateConnectionStatusUI === 'function') {
                updateConnectionStatusUI(false);
            }
            if (stopped) {
                try { es && es.close(); } catch(e) {}
                return; // أُغلق عمداً عبر AuthGate — بلا إعادة اتصال
            }
            // إيقاف نهائي: رفض الخادم الاتصال (401/403 ⇒ readyState=CLOSED) — بلا عاصفة إعادة اتصال.
            // تجديد التوكن مسؤولية AuthManager وحدها (fetch الملفوف يعالج 401)،
            // وبوابة المصادقة تعيد التطبيق لحالة anonymous عبر مسار AuthManager.
            if (es && es.readyState === EventSource.CLOSED) {
                console.log('🔴 Sync SSE: connection refused (auth failure) — terminal halt, no reconnect');
                try { es.close(); } catch(e) {}
                es = null;
                return;
            }
            // خطأ عابر: نغلق يدوياً ونعيد الاتصال بتراجع تدريجي (نفس سياسة WS السابقة)
            console.log('❌ Sync SSE error' + (wasConnected ? ' (was connected)' : '') + ', scheduling reconnect...');
            try { es && es.close(); } catch(e) {}
            es = null;
            scheduleReconnect();
        };
    }

    function disconnect() {
        stopped = true;
        sseConnected = false;
        reconnectAttempts = 0;
        if (es) {
            try { es.close(); } catch(e) {}
            es = null;
        }
    }

    function scheduleReconnect() {
        if (stopped) return;
        if (typeof AuthGate !== 'undefined' && !AuthGate.isAuthenticated()) return; // لا إعادة اتصال خارج البوابة
        reconnectAttempts++;
        if (reconnectAttempts <= maxReconnectAttempts) {
            var delay = Math.min(reconnectDelay * reconnectAttempts, 30000);
            console.log('Sync SSE closed, reconnecting in ' + delay + 'ms (attempt ' + reconnectAttempts + '/' + maxReconnectAttempts + ')');
            setTimeout(connect, delay);
        } else {
            console.log('Sync SSE: max reconnect attempts reached, falling back to polling');
            startFallbackPolling();
        }
    }

    function startFallbackPolling() {
        console.log('🔄 Starting fallback polling (30s)');
        var poll = function() {
            if (typeof syncUpdate === 'function') {
                syncUpdate();
            }
        };
        if (typeof AuthGate !== 'undefined') {
            AuthGate.setInterval(poll, 30000); // يُمسح تلقائياً عند الخروج/انتهاء الجلسة
        } else {
            setInterval(poll, 30000);
        }
    }

    // AuthGate: الاتصال فقط عند المصادقة والفك عند الخروج (index.html).
    // يُحسم عند DOMContentLoaded لأن هذا الملف يُحمَّل قبل auth-manager.js.
    // الصفحات بلا AuthGate (report-entry, operations-command) تحافظ على السلوك السابق.
    function boot() {
        if (typeof AuthGate !== 'undefined') {
            AuthGate.onStart(function() {
                stopped = false;
                connect();
            });
            AuthGate.onStop(disconnect);
        } else {
            connect();
        }
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
