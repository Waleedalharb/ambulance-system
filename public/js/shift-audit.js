/* ==========================================
   shift-audit.js
   Audit Trail Rendering for Shift Detail
   منصة الجنوب - Ambulance Dispatch Platform
   ========================================== */

(function(window) {
    'use strict';

    var ShiftAudit = {};

    // Action type to Arabic label and badge class
    var actionMap = {
        created: { label: 'إنشاء', class: 'created' },
        modified: { label: 'تعديل', class: 'modified' },
        reviewed: { label: 'مراجعة', class: 'data_added' },
        approved: { label: 'موافقة', class: 'approved' },
        deleted: { label: 'حذف', class: 'deleted' },
        data_added: { label: 'إضافة بيانات', class: 'data_added' },
        data_updated: { label: 'تحديث بيانات', class: 'data_updated' },
        export: { label: 'تصدير', class: 'export' },
        alert_acked: { label: 'إقرار تنبيه', class: 'approved' }
    };

    // ==========================================
    // Render Audit Trail
    // ==========================================
    ShiftAudit.render = function(containerId, entries) {
        var container = document.getElementById(containerId);
        if (!container) return;

        if (!entries || entries.length === 0) {
            container.innerHTML = '<div class="empty-state"><i class="fas fa-clipboard-list"></i><p>لا توجد سجلات تدقيق</p></div>';
            return;
        }

        // Sort by created_at descending
        var sortedEntries = entries.slice().sort(function(a, b) {
            return new Date(b.created_at || 0) - new Date(a.created_at || 0);
        });

        var html = '<div class="table-container">';
        html += '<table class="data-table audit-trail-table">';
        html += '<thead><tr>';
        html += '<th>الوقت</th>';
        html += '<th>الإجراء</th>';
        html += '<th>المستخدم</th>';
        html += '<th>التفاصيل</th>';
        html += '<th>البيانات السابقة / الجديدة</th>';
        html += '</tr></thead><tbody>';

        sortedEntries.forEach(function(entry) {
            var action = actionMap[entry.action_type] || { label: entry.action_type, class: 'muted' };
            var time = formatTime(entry.created_at);
            var actor = escapeHtml(entry.actor_name || entry.actor_id || '—');
            var detail = escapeHtml(entry.action_detail || '—');
            var oldData = entry.old_data ? formatData(entry.old_data) : '';
            var newData = entry.new_data ? formatData(entry.new_data) : '';

            html += '<tr>';
            html += '<td style="white-space:nowrap;">' + escapeHtml(time) + '</td>';
            html += '<td><span class="audit-action-badge ' + action.class + '">' + escapeHtml(action.label) + '</span></td>';
            html += '<td>' + actor + '<br><small style="color:var(--text-muted);">' + escapeHtml(entry.actor_role || '') + '</small></td>';
            html += '<td>' + detail + '</td>';
            html += '<td>';
            if (oldData || newData) {
                html += '<div class="diff-view">';
                if (oldData) {
                    html += '<div class="audit-old"><strong>قبل:</strong><br>' + oldData + '</div>';
                }
                if (newData) {
                    html += '<div class="audit-new"><strong>بعد:</strong><br>' + newData + '</div>';
                }
                html += '</div>';
            } else {
                html += '—';
            }
            html += '</td>';
            html += '</tr>';
        });

        html += '</tbody></table></div>';
        container.innerHTML = html;
    };

    // ==========================================
    // Add Audit Entry (prepend)
    // ==========================================
    ShiftAudit.addEntry = function(containerId, entry) {
        var container = document.getElementById(containerId);
        if (!container) return;

        var tbody = container.querySelector('tbody');
        if (!tbody) {
            ShiftAudit.render(containerId, [entry]);
            return;
        }

        var action = actionMap[entry.action_type] || { label: entry.action_type, class: 'muted' };
        var time = formatTime(entry.created_at);
        var actor = escapeHtml(entry.actor_name || entry.actor_id || '—');
        var detail = escapeHtml(entry.action_detail || '—');
        var oldData = entry.old_data ? formatData(entry.old_data) : '';
        var newData = entry.new_data ? formatData(entry.new_data) : '';

        var html = '<tr style="animation: toastIn 0.3s ease;">';
        html += '<td style="white-space:nowrap;">' + escapeHtml(time) + '</td>';
        html += '<td><span class="audit-action-badge ' + action.class + '">' + escapeHtml(action.label) + '</span></td>';
        html += '<td>' + actor + '<br><small style="color:var(--text-muted);">' + escapeHtml(entry.actor_role || '') + '</small></td>';
        html += '<td>' + detail + '</td>';
        html += '<td>';
        if (oldData || newData) {
            html += '<div class="diff-view">';
            if (oldData) {
                html += '<div class="audit-old"><strong>قبل:</strong><br>' + oldData + '</div>';
            }
            if (newData) {
                html += '<div class="audit-new"><strong>بعد:</strong><br>' + newData + '</div>';
            }
            html += '</div>';
        } else {
            html += '—';
        }
        html += '</td>';
        html += '</tr>';

        tbody.insertAdjacentHTML('afterbegin', html);
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
            minute: '2-digit',
            second: '2-digit'
        });
    }

    function escapeHtml(text) {
        if (text == null) return '';
        var div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function formatData(data) {
        if (!data) return '';
        var text = data;
        try {
            var obj = JSON.parse(data);
            text = JSON.stringify(obj, null, 2);
        } catch (e) {
            // Not JSON, keep as string
        }
        return escapeHtml(text).replace(/\n/g, '<br>');
    }

    // Expose to window
    window.ShiftAudit = ShiftAudit;

})(window);
