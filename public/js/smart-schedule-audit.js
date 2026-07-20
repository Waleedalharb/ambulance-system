/* ==========================================
   سجل التغييرات - Audit Log UI
   smart-schedule-audit.js
   ========================================== */
(function() {
    'use strict';

    var auditEntries = [];

    function getToken() {
        return localStorage.getItem('auth_access_token') || localStorage.getItem('authToken') || '';
    }

    // ==========================================
    // Toggle Audit Panel
    // ==========================================
    window.toggleAuditPanel = function() {
        var panel = document.getElementById('auditPanel');
        if (!panel) return;
        var isHidden = panel.classList.contains('hidden');
        // Close notification panel if open
        var notifPanel = document.getElementById('notificationPanel');
        if (notifPanel && !notifPanel.classList.contains('hidden')) notifPanel.classList.add('hidden');

        if (isHidden) {
            panel.classList.remove('hidden');
            loadAuditLog();
        } else {
            panel.classList.add('hidden');
        }
    };

    // ==========================================
    // Load Audit Log
    // ==========================================
    function loadAuditLog() {
        var body = document.getElementById('auditPanelBody');
        if (body) body.innerHTML = '<div class="text-center mt-3" style="color:var(--text-muted);">جاري التحميل...</div>';

        var token = getToken();
        if (!token) {
            if (body) body.innerHTML = '<div class="text-center mt-3" style="color:var(--text-muted);">يجب تسجيل الدخول لعرض السجل</div>';
            return;
        }

        var params = new URLSearchParams();
        params.append('limit', '50');

        fetch('/api/shift-roster/audit-log?' + params.toString(), {
            headers: { 'Authorization': 'Bearer ' + token }
        }).then(function(r) { return r.json(); }).then(function(data) {
            auditEntries = data.entries || data.audit_log || data || [];
            renderAuditLog(auditEntries);
        }).catch(function(err) {
            console.error('Audit log load error:', err);
            if (body) body.innerHTML = '<div class="text-center mt-3" style="color:var(--text-muted);">فشل في تحميل السجل</div>';
        });
    }

    // ==========================================
    // Show Audit Log (alias)
    // ==========================================
    window.showAuditLog = function() {
        toggleAuditPanel();
    };

    // ==========================================
    // Render Audit Log
    // ==========================================
    window.renderAuditLog = function(entries) {
        var body = document.getElementById('auditPanelBody');
        if (!body) return;
        if (!entries || entries.length === 0) {
            body.innerHTML = '<div class="text-center mt-3" style="color:var(--text-muted);">لا توجد سجلات</div>';
            return;
        }

        var html = '';
        entries.forEach(function(entry) {
            var type = entry.change_type || 'edit';
            var typeLabel = {
                'edit': 'تعديل',
                'swap': 'استبدال',
                'bulk': 'جماعي',
                'delete': 'حذف',
                'add': 'إضافة'
            }[type] || type;

            var timeStr = '';
            if (entry.created_at) {
                var d = new Date(entry.created_at);
                timeStr = d.toLocaleString('ar-SA', { hour12: false });
            }

            var detail = '';
            if (type === 'swap') {
                detail = 'استبدال مناوبة';
            } else if (type === 'delete') {
                detail = 'حذف مناوبة ' + (entry.old_shift_code || '') + ' في ' + (entry.shift_date || '');
            } else if (type === 'add') {
                detail = 'إضافة مناوبة ' + (entry.new_shift_code || '') + ' في ' + (entry.shift_date || '');
            } else {
                detail = (entry.old_shift_code || '—') + ' ← ' + (entry.new_shift_code || '—') + ' في ' + (entry.shift_date || '');
            }

            html += '<div class="audit-entry">';
            html += '<div class="audit-entry-header">';
            html += '<span class="audit-entry-type ' + type + '">' + typeLabel + '</span>';
            html += '<span class="audit-entry-date">' + timeStr + '</span>';
            html += '</div>';
            html += '<div class="audit-entry-detail">' + detail + '</div>';
            html += '<div class="audit-entry-meta">';
            html += '<i class="fas fa-user" style="margin-left:4px;font-size:0.75rem;"></i> ' + (entry.changed_by_name || entry.changed_by || '—');
            if (entry.reason) html += ' · <i class="fas fa-comment" style="margin-left:4px;font-size:0.75rem;"></i> ' + entry.reason;
            html += '</div>';
            html += '<div class="audit-entry-actions">';
            html += '<button class="btn" onclick="revertChange(' + (entry.id || 0) + ')" ' + (entry.id ? '' : 'disabled') + '>';
            html += '<i class="fas fa-undo"></i> تراجع';
            html += '</button>';
            html += '</div>';
            html += '</div>';
        });

        body.innerHTML = html;
    };

    // ==========================================
    // Revert Change
    // ==========================================
    window.revertChange = function(auditId) {
        if (!auditId) return;
        var entry = auditEntries.find(function(e) { return e.id === auditId; });
        if (!entry) {
            if (typeof showToast === 'function') showToast('السجل غير موجود', 'error');
            return;
        }

        if (!confirm('هل تريد التراجع عن هذا التغيير؟')) return;

        var token = getToken();
        if (!token) {
            if (typeof showToast === 'function') showToast('يجب تسجيل الدخول', 'error');
            return;
        }

        // Revert by swapping old/new values
        var revertCode = entry.old_shift_code || '';
        var changes = [{
            employee_id: entry.employee_id,
            shift_date: entry.shift_date,
            shift_code: revertCode,
            old_shift_code: entry.new_shift_code || ''
        }];

        fetch('/api/shift-roster/bulk-update', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + token
            },
            body: JSON.stringify({ changes: changes })
        }).then(function(r) { return r.json(); }).then(function(data) {
            if (data.success) {
                if (typeof showToast === 'function') showToast('تم التراجع بنجاح', 'success');
                loadAuditLog();
                if (typeof renderCurrentView === 'function') renderCurrentView();
            } else {
                if (typeof showToast === 'function') showToast('فشل في التراجع: ' + (data.error || ''), 'error');
            }
        }).catch(function(err) {
            console.error('Revert error:', err);
            if (typeof showToast === 'function') showToast('فشل في الاتصال بالسيرفر', 'error');
        });
    };

    // ==========================================
    // Undo Last Change (via draft)
    // ==========================================
    window.undoLastChange = function() {
        var token = getToken();
        if (!token) {
            if (typeof showToast === 'function') showToast('يجب تسجيل الدخول', 'error');
            return;
        }
        fetch('/api/shift-roster/undo', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + token
            }
        }).then(function(r) { return r.json(); }).then(function(data) {
            if (data.success) {
                if (typeof showToast === 'function') showToast('تم التراجع عن آخر تغيير', 'success');
                if (typeof renderCurrentView === 'function') renderCurrentView();
                updateUndoRedoButtons(data);
            } else {
                if (typeof showToast === 'function') showToast('لا يوجد تغيير للتراجع عنه', 'warning');
            }
        }).catch(function(err) {
            console.error('Undo error:', err);
            if (typeof showToast === 'function') showToast('فشل في الاتصال بالسيرفر', 'error');
        });
    };

    // ==========================================
    // Redo Last Change
    // ==========================================
    window.redoLastChange = function() {
        var token = getToken();
        if (!token) {
            if (typeof showToast === 'function') showToast('يجب تسجيل الدخول', 'error');
            return;
        }
        fetch('/api/shift-roster/redo', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + token
            }
        }).then(function(r) { return r.json(); }).then(function(data) {
            if (data.success) {
                if (typeof showToast === 'function') showToast('تم إعادة التغيير', 'success');
                if (typeof renderCurrentView === 'function') renderCurrentView();
                updateUndoRedoButtons(data);
            } else {
                if (typeof showToast === 'function') showToast('لا يوجد تغيير لإعادته', 'warning');
            }
        }).catch(function(err) {
            console.error('Redo error:', err);
            if (typeof showToast === 'function') showToast('فشل في الاتصال بالسيرفر', 'error');
        });
    };

    function updateUndoRedoButtons(data) {
        var undoBtn = document.getElementById('undoBtn');
        var redoBtn = document.getElementById('redoBtn');
        if (undoBtn) undoBtn.disabled = !(data.canUndo || data.can_undo);
        if (redoBtn) redoBtn.disabled = !(data.canRedo || data.can_redo);
    }

    // Check undo/redo status on load
    document.addEventListener('DOMContentLoaded', function() {
        var token = getToken();
        if (token) {
            fetch('/api/shift-roster/drafts', {
                headers: { 'Authorization': 'Bearer ' + token }
            }).then(function(r) { return r.json(); }).then(function(data) {
                var drafts = data.drafts || [];
                var undoBtn = document.getElementById('undoBtn');
                var redoBtn = document.getElementById('redoBtn');
                if (undoBtn) undoBtn.disabled = drafts.length === 0;
                if (redoBtn) redoBtn.disabled = true;
            }).catch(function() { /* ignore */ });
        }
    });

})();
