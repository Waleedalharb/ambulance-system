/* ==========================================
   shift-detail.js
   Shift Detail Page Logic
   منصة الجنوب - Ambulance Dispatch Platform
   ========================================== */

(function() {
    'use strict';

    var currentShiftId = null;
    var shiftData = null;
    var ws = null;

    // ==========================================
    // Auth Helpers
    // ==========================================
    function getAuthToken() {
        return localStorage.getItem('authToken') || '';
    }

    function getCurrentUser() {
        try {
            var user = localStorage.getItem('currentUser');
            return user ? JSON.parse(user) : null;
        } catch (e) {
            return null;
        }
    }

    function fetchWithAuth(url) {
        var token = getAuthToken();
        return fetch(url, {
            headers: token ? { 'Authorization': 'Bearer ' + token } : {}
        }).then(function(res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
        });
    }

    function postWithAuth(url, body) {
        var token = getAuthToken();
        return fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + token
            },
            body: JSON.stringify(body)
        }).then(function(res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
        });
    }

    // ==========================================
    // Toast
    // ==========================================
    function showShiftToast(message, type) {
        var container = document.getElementById('toastContainer');
        if (!container) return;
        var toast = document.createElement('div');
        toast.className = 'toast ' + (type || 'info');
        var icon = type === 'success' ? 'fa-check-circle' : type === 'error' ? 'fa-exclamation-circle' : 'fa-info-circle';
        toast.innerHTML = '<i class="fas ' + icon + '"></i><span>' + message + '</span>';
        container.appendChild(toast);
        setTimeout(function() { toast.remove(); }, 4000);
    }

    // ==========================================
    // URL Parsing
    // ==========================================
    function getShiftIdFromURL() {
        var params = new URLSearchParams(window.location.search);
        return params.get('id');
    }

    // ==========================================
    // Formatting Helpers
    // ==========================================
    function formatDate(dateStr) {
        if (!dateStr) return '—';
        var d = new Date(dateStr);
        if (isNaN(d.getTime())) return dateStr;
        return d.toLocaleDateString('ar-SA', { year: 'numeric', month: 'long', day: 'numeric' });
    }

    function formatDateTime(dateStr) {
        if (!dateStr) return '—';
        var d = new Date(dateStr);
        if (isNaN(d.getTime())) return dateStr;
        return d.toLocaleDateString('ar-SA', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    }

    function formatDuration(hours) {
        if (hours == null || hours === 0) return '—';
        return hours + ' ساعة';
    }

    function escapeHtml(text) {
        if (text == null) return '';
        var div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // ==========================================
    // Loading State
    // ==========================================
    function setLoading(id, loading) {
        var el = document.getElementById(id);
        if (!el) return;
        if (loading) {
            el.innerHTML = '<div class="loading-spinner"><div class="spinner"></div><span>جاري التحميل...</span></div>';
        }
    }

    // ==========================================
    // Init
    // ==========================================
    function init() {
        currentShiftId = getShiftIdFromURL();
        if (!currentShiftId) {
            showShiftToast('لم يتم تحديد معرف المناوبة', 'error');
            document.getElementById('shiftDetailContainer').innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-circle" style="color:var(--danger);"></i><h2>معرف المناوبة غير موجود</h2><p>الرجاء تحديد معرف المناوبة في عنوان URL: ?id=123</p></div>';
            return;
        }
        loadShiftDetail();
        initWebSocket();
    }

    // ==========================================
    // Load Shift Detail
    // ==========================================
    function loadShiftDetail() {
        var container = document.getElementById('shiftDetailContainer');
        if (container) container.style.display = 'block';

        setLoading('kpiSection', true);
        setLoading('shiftInfoSection', true);

        fetchWithAuth('/api/shifts/' + currentShiftId + '/detail')
            .then(function(data) {
                if (!data.success && !data.shift) {
                    showShiftToast(data.error || 'فشل في تحميل بيانات المناوبة', 'error');
                    return;
                }
                shiftData = data;
                renderPage(data);
                // Lazy load remaining sections
                setTimeout(function() {
                    renderTimeline(data.timeline || []);
                    renderAuditTrail(data.audit_trail || []);
                    renderAlerts(data.alerts || []);
                    renderFiles(data.files || []);
                }, 100);
            })
            .catch(function(err) {
                showShiftToast('فشل في الاتصال بالسيرفر', 'error');
                console.error('Load shift detail error:', err);
            });
    }

    // ==========================================
    // Render Full Page
    // ==========================================
    function renderPage(data) {
        var shift = data.shift || {};
        var metrics = data.metrics || {};

        document.getElementById('shiftTitle').textContent = 'تفاصيل المناوبة #' + escapeHtml(currentShiftId);

        // Shift badge in title
        var badge = document.getElementById('shiftBadge');
        if (badge) {
            badge.textContent = escapeHtml(shift.shift_type || 'غير محدد');
            badge.className = 'shift-badge badge ' + (shift.shift_type && shift.shift_type.includes('ليل') ? 'badge-purple' : 'badge-info');
        }

        renderKPIs(metrics);
        renderShiftInfo(shift, metrics);
        renderStaffTeamsVehicles(data.completions || []);
        renderReports(data.reports || []);
        renderCompletions(data.completions || []);
        renderForms(data.forms || []);
        renderHealthScore(metrics);
        renderNotes(data.timeline || []);
    }

    // ==========================================
    // KPI Cards (13 cards)
    // ==========================================
    function renderKPIs(metrics) {
        var container = document.getElementById('kpiSection');
        if (!container) return;

        var kpis = [
            { label: 'إجمالي البلاغات', value: metrics.total_reports || 0, icon: 'fa-ambulance', color: 'info', key: 'total_reports' },
            { label: 'المكتملة', value: metrics.completed_reports || 0, icon: 'fa-check-circle', color: 'success', key: 'completed_reports' },
            { label: 'المعلقة', value: metrics.pending_reports || 0, icon: 'fa-clock', color: 'warning', key: 'pending_reports' },
            { label: 'المعلقة مؤقتاً', value: metrics.suspended_reports || 0, icon: 'fa-pause-circle', color: 'danger', key: 'suspended_reports' },
            { label: 'التكميلات', value: metrics.total_completions || 0, icon: 'fa-clipboard-check', color: 'purple', key: 'total_completions' },
            { label: 'النماذج', value: metrics.total_forms || 0, icon: 'fa-file-alt', color: 'info', key: 'total_forms' },
            { label: 'الكادر', value: metrics.staff_count || 0, icon: 'fa-users', color: 'success', key: 'staff_count' },
            { label: 'الفرق', value: metrics.team_count || 0, icon: 'fa-people-arrows', color: 'warning', key: 'team_count' },
            { label: 'المركبات', value: metrics.vehicle_count || 0, icon: 'fa-car', color: 'info', key: 'vehicle_count' },
            { label: 'معدل الإنجاز', value: (metrics.completion_rate || 0) + '%', icon: 'fa-chart-pie', color: metrics.completion_rate >= 80 ? 'success' : metrics.completion_rate >= 50 ? 'warning' : 'danger', key: 'completion_rate' },
            { label: 'متوسط الاستجابة', value: metrics.avg_response_time ? (metrics.avg_response_time + ' د') : '—', icon: 'fa-stopwatch', color: 'info', key: 'avg_response_time' },
            { label: 'متوسط الإغلاق', value: metrics.avg_closure_time ? (metrics.avg_closure_time + ' د') : '—', icon: 'fa-hourglass-end', color: 'warning', key: 'avg_closure_time' },
            { label: 'الحالات الحرجة', value: metrics.critical_cases || 0, icon: 'fa-exclamation-triangle', color: 'danger', key: 'critical_cases' }
        ];

        var html = '<div class="kpi-grid">';
        kpis.forEach(function(kpi) {
            html += '<div class="kpi-card ' + kpi.color + '">';
            html += '<div class="kpi-icon"><i class="fas ' + kpi.icon + '"></i></div>';
            html += '<div class="kpi-label">' + escapeHtml(kpi.label) + '</div>';
            html += '<div class="kpi-value">' + escapeHtml(String(kpi.value)) + '</div>';
            html += '</div>';
        });
        html += '</div>';
        container.innerHTML = html;
    }

    // ==========================================
    // Shift Info Card
    // ==========================================
    function renderShiftInfo(shift, metrics) {
        var container = document.getElementById('shiftInfoSection');
        if (!container) return;

        var html = '<div class="info-card">';
        html += '<div class="info-item"><i class="fas fa-calendar-alt"></i><div><div class="info-label">التاريخ</div><div class="info-value">' + escapeHtml(formatDate(shift.date)) + '</div></div></div>';
        html += '<div class="info-item"><i class="fas fa-clock"></i><div><div class="info-label">نوع المناوبة</div><div class="info-value">' + escapeHtml(shift.shift_type || '—') + '</div></div></div>';
        html += '<div class="info-item"><i class="fas fa-user-tie"></i><div><div class="info-label">المشرف</div><div class="info-value">' + escapeHtml(shift.supervisor || '—') + '</div></div></div>';
        html += '<div class="info-item"><i class="fas fa-hospital"></i><div><div class="info-label">المركز</div><div class="info-value">' + escapeHtml(shift.center || '—') + '</div></div></div>';
        html += '<div class="info-item"><i class="fas fa-hourglass-half"></i><div><div class="info-label">المدة</div><div class="info-value">' + escapeHtml(formatDuration(shift.duration)) + '</div></div></div>';
        html += '<div class="info-item"><i class="fas fa-chart-line"></i><div><div class="info-label">النتيجة الصحية</div><div class="info-value">' + (metrics.health_score || 0) + '/100</div></div></div>';
        html += '<div class="info-item"><i class="fas fa-database"></i><div><div class="info-label">اكتمال البيانات</div><div class="info-value">' + (metrics.data_completeness || 0) + '%</div></div></div>';
        html += '<div class="info-item"><i class="fas fa-sticky-note"></i><div><div class="info-label">الملاحظات</div><div class="info-value">' + (metrics.notes_count || 0) + '</div></div></div>';
        html += '</div>';
        container.innerHTML = html;
    }

    // ==========================================
    // Staff / Teams / Vehicles
    // ==========================================
    function renderStaffTeamsVehicles(completions) {
        var container = document.getElementById('staffSection');
        if (!container) return;

        // Extract staff from completions teams_data
        var staffList = [];
        var vehiclesList = [];
        var teamsList = [];

        completions.forEach(function(comp) {
            try {
                var teamsData = comp.teams_data ? JSON.parse(comp.teams_data) : [];
                teamsData.forEach(function(team) {
                    if (team.teamName && teamsList.indexOf(team.teamName) === -1) {
                        teamsList.push(team.teamName);
                    }
                    if (team.members) {
                        team.members.forEach(function(m) {
                            if (m.name && !staffList.some(function(s) { return s.name === m.name; })) {
                                staffList.push({ name: m.name, role: m.role || '—', team: team.teamName || '—' });
                            }
                        });
                    }
                    if (team.vehicle && vehiclesList.indexOf(team.vehicle) === -1) {
                        vehiclesList.push(team.vehicle);
                    }
                });
            } catch (e) {
                // ignore parse errors
            }
        });

        var html = '';

        // Staff grid
        if (staffList.length > 0) {
            html += '<div class="section-subtitle"><i class="fas fa-users"></i> الكادر (' + staffList.length + ')</div>';
            html += '<div class="staff-grid">';
            staffList.forEach(function(s) {
                html += '<div class="staff-card">';
                html += '<div class="staff-avatar">' + escapeHtml(s.name.charAt(0)) + '</div>';
                html += '<div class="staff-info">';
                html += '<div class="staff-name">' + escapeHtml(s.name) + '</div>';
                html += '<div class="staff-role">' + escapeHtml(s.role) + ' • ' + escapeHtml(s.team) + '</div>';
                html += '</div></div>';
            });
            html += '</div>';
        } else {
            html += '<div class="empty-state" style="padding:20px;"><i class="fas fa-users"></i><p>لا يوجد كادر مسجل</p></div>';
        }

        // Vehicles
        if (vehiclesList.length > 0) {
            html += '<div class="section-subtitle" style="margin-top:16px;"><i class="fas fa-car"></i> المركبات (' + vehiclesList.length + ')</div>';
            html += '<div>';
            vehiclesList.forEach(function(v) {
                html += '<span class="vehicle-chip"><i class="fas fa-ambulance"></i> ' + escapeHtml(v) + '</span>';
            });
            html += '</div>';
        }

        // Teams
        if (teamsList.length > 0) {
            html += '<div class="section-subtitle" style="margin-top:16px;"><i class="fas fa-people-arrows"></i> الفرق (' + teamsList.length + ')</div>';
            html += '<div>';
            teamsList.forEach(function(t) {
                html += '<span class="vehicle-chip" style="background:#FEF3C7;border-color:#FDE68A;color:#D97706;"><i class="fas fa-users"></i> ' + escapeHtml(t) + '</span>';
            });
            html += '</div>';
        }

        container.innerHTML = html;
    }

    // ==========================================
    // Reports (Tabs)
    // ==========================================
    function renderReports(reports) {
        var container = document.getElementById('reportsSection');
        if (!container) return;

        var all = reports || [];
        var completed = all.filter(function(r) { return r.status === 'completed'; });
        var pending = all.filter(function(r) { return r.status === 'pending'; });
        var suspended = all.filter(function(r) { return r.status === 'suspended'; });

        var html = '<div class="tabs-header">';
        html += '<button class="tab-btn active" onclick="switchReportTab(this, \'all\')">الكل (' + all.length + ')</button>';
        html += '<button class="tab-btn" onclick="switchReportTab(this, \'completed\')">مكتمل (' + completed.length + ')</button>';
        html += '<button class="tab-btn" onclick="switchReportTab(this, \'pending\')">معلق (' + pending.length + ')</button>';
        html += '<button class="tab-btn" onclick="switchReportTab(this, \'suspended\')">معلق مؤقتاً (' + suspended.length + ')</button>';
        html += '</div>';

        html += '<div id="tab-all" class="tab-panel active">' + renderReportTable(all) + '</div>';
        html += '<div id="tab-completed" class="tab-panel">' + renderReportTable(completed) + '</div>';
        html += '<div id="tab-pending" class="tab-panel">' + renderReportTable(pending) + '</div>';
        html += '<div id="tab-suspended" class="tab-panel">' + renderReportTable(suspended) + '</div>';

        container.innerHTML = html;
    }

    function renderReportTable(list) {
        if (list.length === 0) return '<div class="empty-state" style="padding:20px;"><i class="fas fa-inbox"></i><p>لا توجد بلاغات</p></div>';
        var html = '<div class="table-container"><table class="data-table">';
        html += '<thead><tr><th>المعرف</th><th>النوع</th><th>الحالة</th><th>الوقت</th><th>الموقع</th><th>المسند</th></tr></thead><tbody>';
        list.forEach(function(r) {
            var statusClass = r.status === 'completed' ? 'badge-success' : r.status === 'pending' ? 'badge-warning' : 'badge-danger';
            var statusLabel = r.status === 'completed' ? 'مكتمل' : r.status === 'pending' ? 'معلق' : 'معلق مؤقتاً';
            html += '<tr>';
            html += '<td>' + escapeHtml(String(r.id || '')) + '</td>';
            html += '<td>' + escapeHtml(r.report_type || '—') + '</td>';
            html += '<td><span class="badge ' + statusClass + '">' + statusLabel + '</span></td>';
            html += '<td>' + escapeHtml(formatDateTime(r.created_at)) + '</td>';
            html += '<td>' + escapeHtml(r.location || '—') + '</td>';
            html += '<td>' + escapeHtml(r.assigned_to || '—') + '</td>';
            html += '</tr>';
        });
        html += '</tbody></table></div>';
        return html;
    }

    window.switchReportTab = function(btn, tabName) {
        var parent = btn.parentElement;
        parent.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
        btn.classList.add('active');
        parent.parentElement.querySelectorAll('.tab-panel').forEach(function(p) { p.classList.remove('active'); });
        var panel = document.getElementById('tab-' + tabName);
        if (panel) panel.classList.add('active');
    };

    // ==========================================
    // Completions (Radio)
    // ==========================================
    function renderCompletions(completions) {
        var container = document.getElementById('completionsSection');
        if (!container) return;

        if (!completions || completions.length === 0) {
            container.innerHTML = '<div class="empty-state" style="padding:20px;"><i class="fas fa-clipboard-list"></i><p>لا توجد تكميلات</p></div>';
            return;
        }

        var html = '<div class="table-container"><table class="data-table">';
        html += '<thead><tr><th>المعرف</th><th>الفريق</th><th>الحالة</th><th>الوقت</th><th>الملاحظات</th></tr></thead><tbody>';
        completions.forEach(function(c) {
            var statusClass = c.status === 'ready' ? 'badge-success' : c.status === 'pending' ? 'badge-warning' : 'badge-muted';
            var statusLabel = c.status === 'ready' ? 'جاهز' : c.status === 'pending' ? 'معلق' : '—';
            html += '<tr>';
            html += '<td>' + escapeHtml(String(c.id || '')) + '</td>';
            html += '<td>' + escapeHtml(c.team_name || '—') + '</td>';
            html += '<td><span class="badge ' + statusClass + '">' + statusLabel + '</span></td>';
            html += '<td>' + escapeHtml(formatDateTime(c.created_at)) + '</td>';
            html += '<td>' + escapeHtml(c.notes || '—') + '</td>';
            html += '</tr>';
        });
        html += '</tbody></table></div>';
        container.innerHTML = html;
    }

    // ==========================================
    // Forms
    // ==========================================
    function renderForms(forms) {
        var container = document.getElementById('formsSection');
        if (!container) return;

        if (!forms || forms.length === 0) {
            container.innerHTML = '<div class="empty-state" style="padding:20px;"><i class="fas fa-file-alt"></i><p>لا توجد نماذج</p></div>';
            return;
        }

        var html = '<div class="table-container"><table class="data-table">';
        html += '<thead><tr><th>المعرف</th><th>النوع</th><th>الوقت</th><th>الحالة</th><th>المسجل</th></tr></thead><tbody>';
        forms.forEach(function(f) {
            html += '<tr>';
            html += '<td>' + escapeHtml(String(f.id || '')) + '</td>';
            html += '<td>' + escapeHtml(f.form_type || '—') + '</td>';
            html += '<td>' + escapeHtml(formatDateTime(f.created_at)) + '</td>';
            html += '<td><span class="badge ' + (f.status === 'submitted' ? 'badge-success' : 'badge-warning') + '">' + (f.status === 'submitted' ? 'مُقدم' : 'مسودة') + '</span></td>';
            html += '<td>' + escapeHtml(f.created_by || '—') + '</td>';
            html += '</tr>';
        });
        html += '</tbody></table></div>';
        container.innerHTML = html;
    }

    // ==========================================
    // Timeline
    // ==========================================
    function renderTimeline(timeline) {
        if (window.ShiftTimeline && window.ShiftTimeline.render) {
            window.ShiftTimeline.render('timelineSection', timeline);
        } else {
            var container = document.getElementById('timelineSection');
            if (!container) return;
            container.innerHTML = '<div class="empty-state" style="padding:20px;"><i class="fas fa-history"></i><p>لا توجد أحداث مسجلة</p></div>';
        }
    }

    // ==========================================
    // Audit Trail
    // ==========================================
    function renderAuditTrail(audit) {
        if (window.ShiftAudit && window.ShiftAudit.render) {
            window.ShiftAudit.render('auditTrailSection', audit);
        } else {
            var container = document.getElementById('auditTrailSection');
            if (!container) return;
            container.innerHTML = '<div class="empty-state" style="padding:20px;"><i class="fas fa-clipboard-list"></i><p>لا توجد سجلات تدقيق</p></div>';
        }
    }

    // ==========================================
    // Files & Attachments
    // ==========================================
    function renderFiles(files) {
        var container = document.getElementById('filesSection');
        if (!container) return;

        if (!files || files.length === 0) {
            container.innerHTML = '<div class="empty-state" style="padding:20px;"><i class="fas fa-folder-open"></i><p>لا توجد ملفات مرفقة</p></div>';
            return;
        }

        var html = '<div class="file-list">';
        files.forEach(function(f) {
            var icon = f.file_type && f.file_type.includes('pdf') ? 'fa-file-pdf' : f.file_type && f.file_type.includes('image') ? 'fa-file-image' : 'fa-file';
            html += '<div class="file-item" onclick="window.open(\'' + escapeHtml(f.file_path || '#') + '\', \'_blank\')">';
            html += '<i class="fas ' + icon + '"></i>';
            html += '<div><div class="file-name">' + escapeHtml(f.file_name || 'ملف') + '</div>';
            html += '<div class="file-meta">' + escapeHtml(f.file_type || '') + ' • ' + escapeHtml(formatDateTime(f.created_at)) + '</div></div>';
            html += '</div>';
        });
        html += '</div>';
        container.innerHTML = html;
    }

    // ==========================================
    // Health Score
    // ==========================================
    function renderHealthScore(metrics) {
        var container = document.getElementById('healthScoreSection');
        if (!container) return;

        var score = Math.round(metrics.health_score || 0);
        var color = score >= 80 ? '#10B981' : score >= 60 ? '#2563EB' : score >= 40 ? '#F59E0B' : '#EF4444';
        var statusClass = score >= 80 ? 'excellent' : score >= 60 ? 'good' : score >= 40 ? 'fair' : 'poor';
        var statusLabel = score >= 80 ? 'ممتاز' : score >= 60 ? 'جيد' : score >= 40 ? 'مقبول' : 'يحتاج تحسين';

        var html = '<div class="health-gauge-container">';
        html += '<div class="health-gauge-wrapper">';
        html += '<canvas id="healthGaugeChart"></canvas>';
        html += '<div class="health-gauge-value" style="color:' + color + ';">' + score + '</div>';
        html += '</div>';
        html += '<div class="health-gauge-label">درجة الصحة العملياتية</div>';
        html += '<div class="health-gauge-status ' + statusClass + '"><i class="fas fa-heartbeat"></i> ' + statusLabel + '</div>';

        // Components breakdown
        html += '<div class="health-components">';
        html += renderHealthComponent('اكتمال البيانات', metrics.data_completeness || 0, '#2563EB');
        html += renderHealthComponent('معدل الإنجاز', metrics.completion_rate || 0, '#10B981');
        html += renderHealthComponent('الاستجابة', metrics.avg_response_time ? Math.min(100, 100 / metrics.avg_response_time) : 0, '#F59E0B');
        html += renderHealthComponent('الملاحظات', Math.min(100, (metrics.notes_count || 0) * 10), '#8B5CF6');
        html += renderHealthComponent('الأحداث', Math.min(100, (metrics.event_count || 0) * 10), '#3B82F6');
        html += '</div>';
        html += '</div>';

        container.innerHTML = html;

        // Init gauge chart after DOM insertion
        setTimeout(function() {
            if (window.ShiftCharts && window.ShiftCharts.initGaugeChart) {
                window.ShiftCharts.initGaugeChart('healthGaugeChart', score, 'الصحة', color);
            }
        }, 50);
    }

    function renderHealthComponent(label, value, color) {
        var val = Math.round(value || 0);
        return '<div class="health-component">' +
            '<div class="component-label">' + escapeHtml(label) + '</div>' +
            '<div class="component-bar"><div class="component-bar-fill" style="width:' + val + '%;background:' + color + ';"></div></div>' +
            '<div class="component-value">' + val + '%</div>' +
            '</div>';
    }

    // ==========================================
    // Notes
    // ==========================================
    function renderNotes(timeline) {
        var container = document.getElementById('notesSection');
        if (!container) return;

        // Extract note events from timeline
        var notes = (timeline || []).filter(function(e) {
            return e.event_type === 'note_added' || e.event_type === 'note';
        });

        if (notes.length === 0) {
            container.innerHTML = '<div class="empty-state" style="padding:20px;"><i class="fas fa-sticky-note"></i><p>لا توجد ملاحظات</p></div>';
            return;
        }

        var html = '<div class="notes-list">';
        notes.forEach(function(n) {
            html += '<div class="note-item ' + (n.event_data && n.event_data.includes('حرج') ? 'critical' : 'operational') + '">';
            html += '<div class="note-header">';
            html += '<span class="note-author"><i class="fas fa-user"></i> ' + escapeHtml(n.created_by_name || n.created_by || '—') + '</span>';
            html += '<span class="note-time">' + escapeHtml(formatDateTime(n.event_time || n.created_at)) + '</span>';
            html += '</div>';
            html += '<div class="note-text">' + escapeHtml(n.event_description || n.event_title || '—') + '</div>';
            html += '</div>';
        });
        html += '</div>';
        container.innerHTML = html;
    }

    // ==========================================
    // Alerts
    // ==========================================
    function renderAlerts(alerts) {
        if (window.ShiftAlerts && window.ShiftAlerts.render) {
            window.ShiftAlerts.render('alertsSection', alerts);
        } else {
            var container = document.getElementById('alertsSection');
            if (!container) return;
            container.innerHTML = '<div class="empty-state" style="padding:20px;"><i class="fas fa-bell"></i><p>لا توجد تنبيهات</p></div>';
        }
    }

    // ==========================================
    // Actions
    // ==========================================
    function recalculateMetrics() {
        if (!currentShiftId) return;
        showShiftToast('جاري إعادة حساب المؤشرات...', 'info');
        postWithAuth('/api/shifts/' + currentShiftId + '/metrics/calculate', {})
            .then(function(data) {
                if (data.success) {
                    showShiftToast('تم إعادة حساب المؤشرات بنجاح', 'success');
                    loadShiftDetail();
                } else {
                    showShiftToast(data.error || 'فشل في إعادة الحساب', 'error');
                }
            })
            .catch(function(err) {
                showShiftToast('فشل في الاتصال بالسيرفر', 'error');
                console.error('Recalculate metrics error:', err);
            });
    }

    function calculateAlerts() {
        if (!currentShiftId) return;
        showShiftToast('جاري حساب التنبيهات...', 'info');
        if (window.ShiftAlerts && window.ShiftAlerts.calculate) {
            window.ShiftAlerts.calculate(currentShiftId)
                .then(function() {
                    loadShiftDetail();
                })
                .catch(function() {});
        }
    }

    function exportToPDF() {
        if (window.ShiftExport && window.ShiftExport.exportShiftDetailToPDF) {
            window.ShiftExport.exportShiftDetailToPDF(currentShiftId);
        } else {
            showShiftToast('مكتبة التصدير غير متوفرة', 'error');
        }
    }

    function exportToExcel() {
        if (window.ShiftExport && window.ShiftExport.exportShiftDetailToExcel) {
            window.ShiftExport.exportShiftDetailToExcel(shiftData);
        } else {
            showShiftToast('مكتبة التصدير غير متوفرة', 'error');
        }
    }

    // ==========================================
    // WebSocket
    // ==========================================
    function initWebSocket() {
        try {
            var protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            var wsUrl = protocol + '//' + window.location.host + '/ws';
            ws = new WebSocket(wsUrl);

            ws.onopen = function() {
                console.log('✅ WebSocket connected');
            };

            ws.onmessage = function(event) {
                try {
                    var msg = JSON.parse(event.data);
                    if (msg.type === 'shift_detail_updated' && msg.shift_id == currentShiftId) {
                        showShiftToast('تم تحديث بيانات المناوبة', 'info');
                        loadShiftDetail();
                    }
                    if (msg.type === 'shift_metrics_calculated' && msg.shift_id == currentShiftId) {
                        showShiftToast('تم تحديث المؤشرات', 'success');
                        renderKPIs(msg.metrics || {});
                    }
                    if (msg.type === 'shift_alert_new' && msg.shift_id == currentShiftId) {
                        showShiftToast('تنبيه جديد: ' + (msg.message || ''), 'warning');
                        loadShiftDetail();
                    }
                    if (msg.type === 'shift_audit_trail_new' && msg.shift_id == currentShiftId) {
                        if (window.ShiftAudit && window.ShiftAudit.addEntry) {
                            window.ShiftAudit.addEntry('auditTrailSection', msg.entry);
                        }
                    }
                } catch (e) {
                    // ignore non-JSON messages
                }
            };

            ws.onclose = function() {
                console.log('WebSocket closed, reconnecting in 5s...');
                setTimeout(initWebSocket, 5000);
            };

            ws.onerror = function(err) {
                console.error('WebSocket error:', err);
            };
        } catch (e) {
            console.error('WebSocket init failed:', e);
        }
    }

    // ==========================================
    // Live Clock
    // ==========================================
    function updateLiveClock() {
        var el = document.getElementById('liveClock');
        if (!el) return;
        var now = new Date();
        el.textContent = now.toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    // ==========================================
    // Expose functions to window
    // ==========================================
    window.recalculateMetrics = recalculateMetrics;
    window.calculateAlerts = calculateAlerts;
    window.exportShiftDetailToPDF = exportToPDF;
    window.exportShiftDetailToExcel = exportToExcel;
    window.showShiftToast = showShiftToast;

    // Init
    document.addEventListener('DOMContentLoaded', function() {
        init();
        setInterval(updateLiveClock, 1000);
        updateLiveClock();
    });

})();
