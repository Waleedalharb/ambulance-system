/* ==========================================
   التحرير الجماعي - Bulk Editing
   smart-schedule-bulk.js
   ========================================== */
(function() {
    'use strict';

    var bulkSelectedCells = [];
    window.bulkModeActive = false;

    function getToken() {
        return localStorage.getItem('auth_access_token') || localStorage.getItem('authToken') || '';
    }

    function userRole() {
        try {
            var token = getToken();
            if (!token) return null;
            var payload = JSON.parse(atob(token.split('.')[1]));
            return payload.role || null;
        } catch(e) { return null; }
    }

    function canEdit() {
        var role = userRole();
        return role === 'admin' || role === 'director' || role === 'supervisor';
    }

    // ==========================================
    // Start Bulk Edit
    // ==========================================
    window.startBulkEdit = function() {
        if (!window.editMode || !canEdit()) {
            if (typeof showToast === 'function') showToast('يجب تفعيل وضع التحرير أولاً', 'warning');
            return;
        }
        bulkModeActive = true;
        bulkSelectedCells = [];
        var toolbar = document.getElementById('bulkToolbar');
        var btn = document.getElementById('bulkEditBtn');
        if (toolbar) toolbar.classList.remove('hidden');
        if (btn) {
            btn.innerHTML = '<i class="fas fa-check"></i> إنهاء التحرير الجماعي';
            btn.classList.add('btn-coral');
        }
        if (typeof showToast === 'function') showToast('اضغط على الخلايا لتحديدها، ثم اختر المناوبة', 'info');
    };

    // ==========================================
    // Select / Toggle Cell
    // ==========================================
    window.selectCell = function(cell) {
        if (!bulkModeActive) return;
        var index = bulkSelectedCells.indexOf(cell);
        if (index >= 0) {
            bulkSelectedCells.splice(index, 1);
            cell.classList.remove('bulk-selected');
        } else {
            bulkSelectedCells.push(cell);
            cell.classList.add('bulk-selected');
        }
        updateBulkCount();
    };

    function updateBulkCount() {
        var countEl = document.getElementById('bulkCount');
        if (countEl) countEl.textContent = bulkSelectedCells.length + ' خلايا محددة';
    }

    // ==========================================
    // Apply Bulk Edit
    // ==========================================
    window.applyBulkEdit = function(code) {
        if (!bulkModeActive || bulkSelectedCells.length === 0) {
            if (typeof showToast === 'function') showToast('لم يتم تحديد أي خلايا', 'warning');
            return;
        }
        var select = document.getElementById('bulkShiftSelect');
        var selectedCode = code || (select ? select.value : '');
        if (!selectedCode) {
            if (typeof showToast === 'function') showToast('يرجى اختيار مناوبة', 'warning');
            return;
        }

        var changes = [];
        bulkSelectedCells.forEach(function(cell) {
            var row = cell.closest('tr');
            var employeeName = '';
            var shiftDate = '';
            var oldShift = cell.textContent.trim();

            if (row) {
                var nameCell = row.querySelector('td:first-child');
                if (nameCell) employeeName = nameCell.textContent.trim();
            }
            var colIndex = cell.cellIndex;
            if (colIndex !== undefined && row) {
                var table = row.closest('table');
                if (table) {
                    var header = table.querySelector('thead th:nth-child(' + (colIndex + 1) + ')');
                    if (header) shiftDate = header.getAttribute('data-date') || header.textContent.trim();
                }
            }
            employeeName = cell.getAttribute('data-employee-id') || employeeName;
            shiftDate = cell.getAttribute('data-date') || shiftDate;

            changes.push({
                employee_id: employeeName,
                shift_date: shiftDate,
                shift_code: selectedCode,
                old_shift_code: oldShift
            });

            // Update cell visually immediately
            cell.textContent = selectedCode;
            cell.classList.remove('bulk-selected');
        });

        // Update local data
        changes.forEach(function(c) {
            if (typeof employees !== 'undefined' && employees) {
                employees.forEach(function(emp) {
                    if (emp.id === c.employee_id || emp.name === c.employee_id) {
                        var found = false;
                        emp.schedule.forEach(function(s) {
                            if (s.date === c.shift_date) {
                                s.shift = c.shift_code;
                                s.shiftCode = c.shift_code;
                                s.status = (c.shift_code === 'إجازة' || c.shift_code === 'راحة' || c.shift_code === 'OFF') ? 'إجازة' : 'دوام';
                                found = true;
                            }
                        });
                        if (!found) {
                            emp.schedule.push({
                                day: '', date: c.shift_date, shift: c.shift_code, shiftCode: c.shift_code,
                                time: '', location: emp.team || '', status: (c.shift_code === 'إجازة' || c.shift_code === 'راحة' || c.shift_code === 'OFF') ? 'إجازة' : 'دوام'
                            });
                        }
                    }
                });
            }
        });

        // Sync to server
        var token = getToken();
        if (token && changes.length > 0) {
            fetch('/api/shift-roster/bulk-update', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token
                },
                body: JSON.stringify({ changes: changes })
            }).then(function(r) { return r.json(); }).then(function(data) {
                if (data.success) {
                    if (typeof showToast === 'function') showToast('تم تطبيق ' + changes.length + ' تغيير بنجاح', 'success');
                } else {
                    if (typeof showToast === 'function') showToast('فشل في التطبيق: ' + (data.error || ''), 'error');
                }
            }).catch(function(err) {
                console.error('Bulk update error:', err);
                if (typeof showToast === 'function') showToast('فشل في الاتصال بالسيرفر', 'error');
            });
        } else {
            if (typeof showToast === 'function') showToast('تم التطبيق محلياً (غير مسجل)', 'info');
        }

        cancelBulkEdit();
        if (typeof renderCurrentView === 'function') renderCurrentView();
        if (typeof updateStats === 'function') updateStats();
    };

    // ==========================================
    // Cancel Bulk Edit
    // ==========================================
    window.cancelBulkEdit = function() {
        bulkModeActive = false;
        bulkSelectedCells.forEach(function(cell) {
            cell.classList.remove('bulk-selected');
        });
        bulkSelectedCells = [];
        var toolbar = document.getElementById('bulkToolbar');
        var btn = document.getElementById('bulkEditBtn');
        if (toolbar) toolbar.classList.add('hidden');
        if (btn) {
            btn.innerHTML = '<i class="fas fa-th-large"></i> تحرير جماعي';
            btn.classList.remove('btn-coral');
        }
        updateBulkCount();
    };

    // ==========================================
    // Export Roster
    // ==========================================
    window.exportRoster = function(format) {
        var token = getToken();
        if (!token) {
            if (typeof showToast === 'function') showToast('يجب تسجيل الدخول للتصدير', 'error');
            return;
        }
        var month = new Date().getMonth() + 1;
        var year = new Date().getFullYear();
        var monthInput = document.getElementById('filterMonth');
        if (monthInput && monthInput.value) {
            var parts = monthInput.value.split('-');
            year = parseInt(parts[0]);
            month = parseInt(parts[1]);
        }

        fetch('/api/shift-roster/export', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + token
            },
            body: JSON.stringify({
                format: format || 'excel',
                month: month,
                year: year
            })
        }).then(function(r) { return r.json(); }).then(function(data) {
            if (data.success && data.download_url) {
                window.open(data.download_url, '_blank');
                if (typeof showToast === 'function') showToast('جاري التحميل...', 'info');
            } else {
                if (typeof showToast === 'function') showToast('فشل في التصدير: ' + (data.error || ''), 'error');
            }
        }).catch(function(err) {
            console.error('Export error:', err);
            if (typeof showToast === 'function') showToast('فشل في الاتصال بالسيرفر', 'error');
        });
    };

    // ==========================================
    // Get Stats
    // ==========================================
    window.getRosterStats = function() {
        return new Promise(function(resolve) {
            var token = getToken();
            var month = new Date().getMonth() + 1;
            var year = new Date().getFullYear();
            var monthInput = document.getElementById('filterMonth');
            if (monthInput && monthInput.value) {
                var parts = monthInput.value.split('-');
                year = parseInt(parts[0]);
                month = parseInt(parts[1]);
            }
            if (!token) { resolve({}); return; }
            fetch('/api/shift-roster/stats?month=' + month + '&year=' + year, {
                headers: { 'Authorization': 'Bearer ' + token }
            }).then(function(r) { return r.json(); }).then(function(data) {
                resolve(data);
            }).catch(function(err) {
                console.error('Stats error:', err);
                resolve({});
            });
        });
    };

})();
