/* ==========================================
   محرر التحرير المباشر - Inline Editing Engine
   smart-schedule-editor.js
   ========================================== */
(function() {
    'use strict';

    var editMode = false;
    var activeCellEditor = null;
    var shiftCodes = [
        { code: 'صباحية', label: 'مناوبة صباحية', color: 'blue' },
        { code: 'مسائية', label: 'مناوبة مسائية', color: 'purple' },
        { code: 'ليلية', label: 'مناوبة ليلية', color: 'gray' },
        { code: 'إجازة', label: 'إجازة', color: 'red' },
        { code: 'راحة', label: 'راحة', color: 'gray' },
        { code: 'OFF', label: 'OFF', color: 'gray' },
        { code: 'دوام رسمي', label: 'دوام رسمي', color: 'green' },
        { code: 'مكلف / مهمة رسمية', label: 'مكلف / مهمة رسمية', color: 'gold' },
        { code: 'أوفر لاب / نوبات تداخلية', label: 'أوفر لاب', color: 'gold' },
        { code: 'إجازة اضطرارية', label: 'إجازة اضطرارية', color: 'red' },
        { code: 'تدريب', label: 'تدريب', color: 'blue' }
    ];

    function getToken() {
        return localStorage.getItem('auth_access_token') || localStorage.getItem('authToken') || '';
    }

    function isLoggedIn() {
        return !!getToken();
    }

    function userRole() {
        try {
            var token = getToken();
            if (!token) return null;
            var payload = JSON.parse(atob(token.split('.')[1]));
            return payload.role || null;
        } catch(e) {
            return null;
        }
    }

    function canEdit() {
        var role = userRole();
        return role === 'admin' || role === 'director' || role === 'supervisor';
    }

    // ==========================================
    // Toggle Edit Mode
    // ==========================================
    window.toggleEditMode = function() {
        editMode = !editMode;
        var btn = document.getElementById('editModeBtn');
        var toolbar = document.getElementById('editorToolbarSection');
        if (btn) {
            btn.innerHTML = editMode
                ? '<i class="fas fa-check"></i> إيقاف التحرير'
                : '<i class="fas fa-edit"></i> تفعيل التحرير';
            btn.classList.toggle('btn-primary', !editMode);
            btn.classList.toggle('btn-coral', editMode);
        }
        if (toolbar) {
            toolbar.classList.toggle('hidden', !editMode && !isLoggedIn());
        }
        if (!editMode) {
            cancelCellEdit();
            if (typeof window.cancelBulkEdit === 'function') window.cancelBulkEdit();
        }
        refreshEditableCells();
        if (typeof showToast === 'function') {
            showToast(editMode ? 'تم تفعيل وضع التحرير' : 'تم إيقاف وضع التحرير', 'info');
        }
    };

    // ==========================================
    // Refresh Editable Cells
    // ==========================================
    function refreshEditableCells() {
        var cells = document.querySelectorAll('.data-table tbody td, .calendar-day, .weekly-employee-item');
        cells.forEach(function(cell) {
            if (editMode && canEdit()) {
                cell.classList.add('editable-cell');
                cell.addEventListener('click', cellClickHandler);
                cell.addEventListener('contextmenu', cellContextMenuHandler);
            } else {
                cell.classList.remove('editable-cell', 'bulk-selected', 'dragging');
                cell.removeEventListener('click', cellClickHandler);
                cell.removeEventListener('contextmenu', cellContextMenuHandler);
            }
        });
    }

    // ==========================================
    // Cell Click Handler
    // ==========================================
    function cellClickHandler(e) {
        if (!editMode) return;
        // If bulk mode is active, delegate to bulk handler
        if (window.bulkModeActive && typeof window.selectCell === 'function') {
            window.selectCell(this);
            return;
        }
        // Extract employee info from the cell or its row
        var cell = this;
        var row = cell.closest('tr');
        var employeeName = '';
        var employeeId = '';
        var shiftDate = '';
        var currentShift = '';

        if (row) {
            var nameCell = row.querySelector('td:first-child');
            if (nameCell) employeeName = nameCell.textContent.trim();
        }
        // Try to get date from column header or cell data
        var colIndex = cell.cellIndex;
        if (colIndex !== undefined && row) {
            var table = row.closest('table');
            if (table) {
                var header = table.querySelector('thead th:nth-child(' + (colIndex + 1) + ')');
                if (header) {
                    shiftDate = header.getAttribute('data-date') || header.textContent.trim();
                }
            }
        }
        currentShift = cell.textContent.trim();

        // If it's a calendar or weekly view cell, use data attributes
        employeeId = cell.getAttribute('data-employee-id') || employeeName;
        shiftDate = cell.getAttribute('data-date') || shiftDate;

        if (cell.querySelector('.cell-editor')) return; // Already editing
        openInlineEditor(cell, employeeId, shiftDate, currentShift);
    }

    // ==========================================
    // Open Inline Editor
    // ==========================================
    window.editCell = function(cell, employeeId, date) {
        if (!editMode || !canEdit()) return;
        var currentShift = cell.textContent.trim();
        openInlineEditor(cell, employeeId, date, currentShift);
    };

    function openInlineEditor(cell, employeeId, date, currentShift) {
        cancelCellEdit();
        cell.classList.add('editing');
        activeCellEditor = cell;

        var editor = document.createElement('div');
        editor.className = 'cell-editor';
        editor.style.position = 'absolute';

        var select = document.createElement('select');
        select.innerHTML = '<option value="">اختر المناوبة...</option>';
        shiftCodes.forEach(function(sc) {
            var opt = document.createElement('option');
            opt.value = sc.code;
            opt.textContent = sc.label;
            if (sc.code === currentShift) opt.selected = true;
            select.appendChild(opt);
        });

        var reasonInput = document.createElement('input');
        reasonInput.type = 'text';
        reasonInput.placeholder = 'سبب التغيير (اختياري)...';
        reasonInput.style.marginTop = '4px';

        var actions = document.createElement('div');
        actions.className = 'cell-editor-actions';

        var saveBtn = document.createElement('button');
        saveBtn.className = 'btn btn-green';
        saveBtn.innerHTML = '<i class="fas fa-check"></i>';
        saveBtn.title = 'حفظ';
        saveBtn.onclick = function() {
            saveCellEdit(cell, employeeId, date, select.value, reasonInput.value, currentShift);
        };

        var cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn';
        cancelBtn.innerHTML = '<i class="fas fa-times"></i>';
        cancelBtn.title = 'إلغاء';
        cancelBtn.onclick = cancelCellEdit;

        var deleteBtn = document.createElement('button');
        deleteBtn.className = 'btn btn-coral';
        deleteBtn.innerHTML = '<i class="fas fa-trash"></i>';
        deleteBtn.title = 'حذف';
        deleteBtn.onclick = function() {
            if (confirm('هل أنت متأكد من حذف هذه المناوبة؟')) {
                deleteShiftForCell(cell, employeeId, date, reasonInput.value);
            }
        };

        actions.appendChild(saveBtn);
        actions.appendChild(cancelBtn);
        actions.appendChild(deleteBtn);
        editor.appendChild(select);
        editor.appendChild(reasonInput);
        editor.appendChild(actions);

        cell.style.position = 'relative';
        cell.appendChild(editor);

        select.focus();

        // Close on Escape
        select.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') cancelCellEdit();
        });
        reasonInput.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') cancelCellEdit();
            if (e.key === 'Enter') {
                saveCellEdit(cell, employeeId, date, select.value, reasonInput.value, currentShift);
            }
        });
    }

    // ==========================================
    // Save Cell Edit
    // ==========================================
    window.saveCellEdit = function(cell, employeeId, date, newShiftCode, reason, oldShiftCode) {
        if (!newShiftCode) {
            if (typeof showToast === 'function') showToast('يرجى اختيار مناوبة', 'error');
            return;
        }
        if (newShiftCode === oldShiftCode) {
            cancelCellEdit();
            return;
        }
        cancelCellEdit();

        // Update local data
        updateLocalShift(employeeId, date, newShiftCode, oldShiftCode);

        // Sync to server if logged in
        var token = getToken();
        if (token) {
            var changes = [{
                employee_id: employeeId,
                shift_date: date,
                shift_code: newShiftCode,
                old_shift_code: oldShiftCode
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
                    if (typeof showToast === 'function') showToast('تم حفظ التغيير بنجاح', 'success');
                    // Log audit
                    logAudit(employeeId, date, oldShiftCode, newShiftCode, 'edit', reason);
                } else {
                    if (typeof showToast === 'function') showToast('فشل في الحفظ: ' + (data.error || ''), 'error');
                }
            }).catch(function(err) {
                console.error('Save cell edit error:', err);
                if (typeof showToast === 'function') showToast('فشل في الاتصال بالسيرفر', 'error');
            });
        } else {
            if (typeof showToast === 'function') showToast('تم التحديث محلياً (غير مسجل)', 'info');
        }

        // Refresh view
        if (typeof renderCurrentView === 'function') renderCurrentView();
        if (typeof updateStats === 'function') updateStats();
    };

    // ==========================================
    // Cancel Cell Edit
    // ==========================================
    window.cancelCellEdit = function() {
        if (activeCellEditor) {
            var editor = activeCellEditor.querySelector('.cell-editor');
            if (editor) editor.remove();
            activeCellEditor.classList.remove('editing');
            activeCellEditor = null;
        }
    };

    // ==========================================
    // Delete Shift
    // ==========================================
    window.deleteShift = function(rosterId) {
        if (!canEdit()) {
            if (typeof showToast === 'function') showToast('لا يوجد صلاحية للحذف', 'error');
            return;
        }
        var token = getToken();
        if (token && rosterId) {
            fetch('/api/shift-roster/' + rosterId, {
                method: 'DELETE',
                headers: { 'Authorization': 'Bearer ' + token }
            }).then(function(r) { return r.json(); }).then(function(data) {
                if (data.success) {
                    if (typeof showToast === 'function') showToast('تم الحذف بنجاح', 'success');
                    if (typeof renderCurrentView === 'function') renderCurrentView();
                } else {
                    if (typeof showToast === 'function') showToast('فشل في الحذف: ' + (data.error || ''), 'error');
                }
            }).catch(function(err) {
                console.error('Delete shift error:', err);
                if (typeof showToast === 'function') showToast('فشل في الاتصال بالسيرفر', 'error');
            });
        } else {
            // Local delete without server ID
            if (typeof showToast === 'function') showToast('تم الحذف محلياً', 'info');
        }
    };

    function deleteShiftForCell(cell, employeeId, date, reason) {
        cancelCellEdit();
        // Remove from local employees
        if (typeof employees !== 'undefined' && employees) {
            employees.forEach(function(emp) {
                if (emp.id === employeeId || emp.name === employeeId) {
                    emp.schedule = emp.schedule.filter(function(s) {
                        return s.date !== date;
                    });
                }
            });
        }
        var token = getToken();
        if (token) {
            logAudit(employeeId, date, '', '', 'delete', reason);
        }
        if (typeof showToast === 'function') showToast('تم حذف المناوبة', 'success');
        if (typeof renderCurrentView === 'function') renderCurrentView();
        if (typeof updateStats === 'function') updateStats();
    }

    // ==========================================
    // Add Shift
    // ==========================================
    window.addShift = function(employeeId, date, code) {
        if (!canEdit()) {
            if (typeof showToast === 'function') showToast('لا يوجد صلاحية للإضافة', 'error');
            return;
        }
        // Update local
        if (typeof employees !== 'undefined' && employees) {
            var emp = employees.find(function(e) { return e.id === employeeId || e.name === employeeId; });
            if (!emp) {
                if (typeof showToast === 'function') showToast('الموظف غير موجود', 'error');
                return;
            }
            emp.schedule.push({
                day: '', date: date, shift: code, shiftCode: code,
                time: '', location: emp.team || '', status: (code === 'إجازة' || code === 'راحة') ? 'إجازة' : 'دوام'
            });
        }
        var token = getToken();
        if (token) {
            logAudit(employeeId, date, '', code, 'add', 'إضافة مناوبة جديدة');
        }
        if (typeof showToast === 'function') showToast('تمت إضافة المناوبة', 'success');
        if (typeof renderCurrentView === 'function') renderCurrentView();
        if (typeof updateStats === 'function') updateStats();
    };

    // ==========================================
    // Update Local Shift
    // ==========================================
    function updateLocalShift(employeeId, date, newCode, oldCode) {
        if (typeof employees !== 'undefined' && employees) {
            employees.forEach(function(emp) {
                if (emp.id === employeeId || emp.name === employeeId) {
                    var found = false;
                    emp.schedule.forEach(function(s) {
                        if (s.date === date) {
                            s.shift = newCode;
                            s.shiftCode = newCode;
                            s.status = (newCode === 'إجازة' || newCode === 'راحة' || newCode === 'OFF') ? 'إجازة' : 'دوام';
                            found = true;
                        }
                    });
                    if (!found) {
                        emp.schedule.push({
                            day: '', date: date, shift: newCode, shiftCode: newCode,
                            time: '', location: emp.team || '', status: (newCode === 'إجازة' || newCode === 'راحة' || newCode === 'OFF') ? 'إجازة' : 'دوام'
                        });
                    }
                }
            });
        }
    }

    // ==========================================
    // Log Audit
    // ==========================================
    function logAudit(employeeId, date, oldVal, newVal, type, reason) {
        var token = getToken();
        if (!token) return;
        fetch('/api/shift-roster/audit-log', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + token
            },
            body: JSON.stringify({
                employee_id: employeeId,
                shift_date: date,
                old_shift_code: oldVal,
                new_shift_code: newVal,
                change_type: type,
                reason: reason || ''
            })
        }).catch(function(err) { console.error('Audit log error:', err); });
    }

    // ==========================================
    // Context Menu
    // ==========================================
    var contextMenuEl = null;

    function cellContextMenuHandler(e) {
        if (!editMode || !canEdit()) return;
        e.preventDefault();
        var cell = this;
        var row = cell.closest('tr');
        var employeeName = '';
        var shiftDate = '';

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

        showContextMenu(e.clientX, e.clientY, cell, employeeName, shiftDate);
    }

    function showContextMenu(x, y, cell, employeeId, date) {
        removeContextMenu();
        var menu = document.createElement('div');
        menu.className = 'cell-context-menu';
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';

        var items = [
            { icon: 'fa-edit', label: 'تعديل', action: function() { openInlineEditor(cell, employeeId, date, cell.textContent.trim()); } },
            { icon: 'fa-trash', label: 'حذف', action: function() { if (confirm('هل أنت متأكد؟')) deleteShiftForCell(cell, employeeId, date, ''); }, danger: true },
            { icon: 'fa-plus', label: 'إضافة مناوبة', action: function() { addShift(employeeId, date, 'صباحية'); } },
            { divider: true },
            { icon: 'fa-user-clock', label: 'جدول الموظف', action: function() { if (typeof window.showEmployeeScheduleModal === 'function') window.showEmployeeScheduleModal(); } }
        ];

        items.forEach(function(item) {
            if (item.divider) {
                var div = document.createElement('div');
                div.className = 'cell-context-menu-divider';
                menu.appendChild(div);
            } else {
                var btn = document.createElement('button');
                btn.className = 'cell-context-menu-item' + (item.danger ? ' danger' : '');
                btn.innerHTML = '<i class="fas ' + item.icon + '"></i> ' + item.label;
                btn.onclick = function() { removeContextMenu(); item.action(); };
                menu.appendChild(btn);
            }
        });

        document.body.appendChild(menu);
        contextMenuEl = menu;

        // Adjust position if off-screen
        var rect = menu.getBoundingClientRect();
        if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 10) + 'px';
        if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 10) + 'px';
    }

    function removeContextMenu() {
        if (contextMenuEl) {
            contextMenuEl.remove();
            contextMenuEl = null;
        }
    }

    document.addEventListener('click', function(e) {
        if (contextMenuEl && !contextMenuEl.contains(e.target)) removeContextMenu();
    });

    // ==========================================
    // Hook into view renders
    // ==========================================
    var originalRenderCurrentView = window.renderCurrentView;
    if (originalRenderCurrentView) {
        window.renderCurrentView = function() {
            originalRenderCurrentView();
            setTimeout(refreshEditableCells, 100);
        };
    }

    // Show editor toolbar if logged in as admin/director
    document.addEventListener('DOMContentLoaded', function() {
        var toolbarSection = document.getElementById('editorToolbarSection');
        if (toolbarSection && isLoggedIn() && canEdit()) {
            toolbarSection.classList.remove('hidden');
        }
    });

    // Listen for view changes via mutation observer on mainViewArea
    var observer = new MutationObserver(function() {
        if (editMode) setTimeout(refreshEditableCells, 50);
    });
    document.addEventListener('DOMContentLoaded', function() {
        var mva = document.getElementById('mainViewArea');
        if (mva) observer.observe(mva, { childList: true, subtree: true });
    });

})();
