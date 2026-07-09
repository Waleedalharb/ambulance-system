/* ==========================================
   shift-alerts.js
   Alerts Display and Acknowledgement
   منصة الجنوب - Ambulance Dispatch Platform
   ========================================== */

(function(window) {
    'use strict';

    var ShiftAlerts = {};

    // Alert type to Arabic label and icon
    var alertTypeMap = {
        high_pending: { label: 'بلاغات معلقة كثيرة', icon: 'fa-exclamation-triangle' },
        low_completion: { label: 'معدل إنجاز منخفض', icon: 'fa-chart-line' },
        staff_shortage: { label: 'نقص في الكادر', icon: 'fa-user-slash' },
        workload_spike: { label: 'ارتفاع حجم العمل', icon: 'fa-bolt' },
        closure_delay: { label: 'تأخر في الإغلاق', icon: 'fa-clock' },
        repeated_notes: { label: 'ملاحظات متكررة', icon: 'fa-sticky-note' }
    };

    // Severity to Arabic label and class
    var severityMap = {
        info: { label: 'معلومة', class: 'info' },
        warning: { label: 'تحذير', class: 'warning' },
        critical: { label: 'حرج', class: 'critical' }
    };

    // ==========================================
    // Render Alerts
    // ==========================================
    ShiftAlerts.render = function(containerId, alerts) {
        var container = document.getElementById(containerId);
        if (!container) return;

        if (!alerts || alerts.length === 0) {
            container.innerHTML = '<div class="empty-state"><i class="fas fa-check-circle" style="color:var(--success);"></i><p>لا توجد تنبيهات نشطة</p></div>';
            return;
        }

        // Sort: unacknowledged first, then by severity (critical > warning > info), then by date
        var sortedAlerts = alerts.slice().sort(function(a, b) {
            if (a.is_acknowledged !== b.is_acknowledged) {
                return (a.is_acknowledged ? 1 : 0) - (b.is_acknowledged ? 1 : 0);
            }
            var sevOrder = { critical: 0, warning: 1, info: 2 };
            var sevA = sevOrder[a.severity] || 3;
            var sevB = sevOrder[b.severity] || 3;
            if (sevA !== sevB) return sevA - sevB;
            return new Date(b.created_at || 0) - new Date(a.created_at || 0);
        });

        var html = '';
        sortedAlerts.forEach(function(alert) {
            var typeInfo = alertTypeMap[alert.alert_type] || { label: alert.alert_type, icon: 'fa-bell' };
            var sevInfo = severityMap[alert.severity] || { label: alert.severity, class: 'info' };
            var isAck = alert.is_acknowledged === 1 || alert.is_acknowledged === true;
            var ackClass = isAck ? 'alert-acknowledged' : '';
            var time = formatTime(alert.created_at);

            html += '<div class="alert-banner ' + sevInfo.class + ' ' + ackClass + '" data-alert-id="' + alert.id + '">';
            html += '<div class="alert-icon"><i class="fas ' + typeInfo.icon + '"></i></div>';
            html += '<div class="alert-content">';
            html += '<div class="alert-title">' + escapeHtml(typeInfo.label) + ' <span class="badge badge-' + sevInfo.class + '">' + escapeHtml(sevInfo.label) + '</span></div>';
            html += '<div class="alert-message">' + escapeHtml(alert.message || '') + '</div>';
            if (alert.suggested_reason) {
                html += '<div class="alert-message" style="font-style:italic;">' + escapeHtml(alert.suggested_reason) + '</div>';
            }
            html += '<div class="alert-meta">';
            html += '<span><i class="fas fa-clock"></i> ' + escapeHtml(time) + '</span>';
            if (isAck && alert.acknowledged_by) {
                html += '<span><i class="fas fa-check"></i> تم الإقرار بواسطة ' + escapeHtml(alert.acknowledged_by) + '</span>';
            }
            html += '</div>';
            html += '</div>';
            html += '<div class="alert-actions">';
            if (!isAck) {
                html += '<button class="btn btn-sm btn-success" onclick="ShiftAlerts.acknowledge(' + alert.id + ')">';
                html += '<i class="fas fa-check"></i> إقرار';
                html += '</button>';
            } else {
                html += '<span class="badge badge-success"><i class="fas fa-check-double"></i> تم الإقرار</span>';
            }
            html += '</div>';
            html += '</div>';
        });

        container.innerHTML = html;
    };

    // ==========================================
    // Acknowledge Alert
    // ==========================================
    ShiftAlerts.acknowledge = function(alertId) {
        var token = localStorage.getItem('authToken') || '';
        var user = localStorage.getItem('currentUser');
        var userName = 'مستخدم';
        try {
            if (user) userName = JSON.parse(user).name || 'مستخدم';
        } catch (e) {}

        fetch('/api/shifts/alerts/' + alertId + '/acknowledge', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + token
            },
            body: JSON.stringify({ acknowledged_by: userName })
        })
        .then(function(res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
        })
        .then(function(data) {
            if (data.success) {
                showShiftToast('تم إقرار التنبيه بنجاح', 'success');
                // Update UI
                var banner = document.querySelector('[data-alert-id="' + alertId + '"]');
                if (banner) {
                    banner.classList.add('alert-acknowledged');
                    var actions = banner.querySelector('.alert-actions');
                    if (actions) {
                        actions.innerHTML = '<span class="badge badge-success"><i class="fas fa-check-double"></i> تم الإقرار</span>';
                    }
                }
            } else {
                showShiftToast(data.error || 'فشل في إقرار التنبيه', 'error');
            }
        })
        .catch(function(err) {
            showShiftToast('فشل في الاتصال بالسيرفر', 'error');
            console.error('Acknowledge alert error:', err);
        });
    };

    // ==========================================
    // Calculate Alerts for a Shift
    // ==========================================
    ShiftAlerts.calculate = function(shiftId) {
        var token = localStorage.getItem('authToken') || '';

        return fetch('/api/shifts/alerts/calculate', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + token
            },
            body: JSON.stringify({ shift_id: shiftId })
        })
        .then(function(res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
        })
        .then(function(data) {
            if (data.success && data.alerts_generated && data.alerts_generated.length > 0) {
                showShiftToast('تم إنشاء ' + data.alerts_generated.length + ' تنبيه جديد', 'warning');
            }
            return data;
        })
        .catch(function(err) {
            showShiftToast('فشل في حساب التنبيهات', 'error');
            console.error('Calculate alerts error:', err);
            throw err;
        });
    };

    // ==========================================
    // Helpers
    // ==========================================
    function formatTime(dateStr) {
        if (!dateStr) return '—';
        var d = new Date(dateStr);
        if (isNaN(d.getTime())) return dateStr;
        return d.toLocaleDateString('ar-SA', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    function escapeHtml(text) {
        if (text == null) return '';
        var div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function showShiftToast(message, type) {
        if (typeof showToast === 'function') {
            showToast(message, type);
        } else {
            var container = document.getElementById('toastContainer');
            if (!container) return;
            var toast = document.createElement('div');
            toast.className = 'toast ' + type;
            var icon = type === 'success' ? 'fa-check-circle' : type === 'error' ? 'fa-exclamation-circle' : 'fa-info-circle';
            toast.innerHTML = '<i class="fas ' + icon + '"></i><span>' + message + '</span>';
            container.appendChild(toast);
            setTimeout(function() { toast.remove(); }, 3000);
        }
    }

    // Expose to window
    window.ShiftAlerts = ShiftAlerts;

})(window);
