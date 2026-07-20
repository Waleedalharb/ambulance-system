/* ==========================================
   السحب والإفلات - Drag & Drop Engine
   smart-schedule-dragdrop.js
   ========================================== */
(function() {
    'use strict';

    var dragSource = null;
    var dragSourceData = null;

    function getToken() {
        return localStorage.getItem('auth_access_token') || localStorage.getItem('authToken') || '';
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
    // Initialize Drag & Drop
    // ==========================================
    window.initDragDrop = function() {
        var containers = document.querySelectorAll('.data-table tbody, .calendar-grid, .weekly-grid, .weekly-day-content');
        containers.forEach(function(container) {
            container.addEventListener('dragover', handleDragOver);
            container.addEventListener('dragleave', handleDragLeave);
            container.addEventListener('drop', handleDrop);
        });
    };

    // ==========================================
    // Refresh Draggable Cells
    // ==========================================
    function refreshDraggableCells() {
        var cells = document.querySelectorAll('.data-table tbody td, .calendar-day, .weekly-employee-item');
        cells.forEach(function(cell) {
            if (window.editMode && canEdit()) {
                cell.setAttribute('draggable', 'true');
                cell.classList.add('draggable-cell');
                cell.addEventListener('dragstart', handleDragStart);
                cell.addEventListener('dragend', handleDragEnd);
            } else {
                cell.setAttribute('draggable', 'false');
                cell.classList.remove('draggable-cell', 'dragging', 'drop-valid', 'drop-invalid');
                cell.removeEventListener('dragstart', handleDragStart);
                cell.removeEventListener('dragend', handleDragEnd);
            }
        });
    }

    // ==========================================
    // Drag Start
    // ==========================================
    function handleDragStart(e) {
        if (!window.editMode || !canEdit()) {
            e.preventDefault();
            return;
        }
        dragSource = this;
        this.classList.add('dragging');

        var row = this.closest('tr');
        var employeeName = '';
        var shiftDate = '';
        var currentShift = this.textContent.trim();

        if (row) {
            var nameCell = row.querySelector('td:first-child');
            if (nameCell) employeeName = nameCell.textContent.trim();
        }
        var colIndex = this.cellIndex;
        if (colIndex !== undefined && row) {
            var table = row.closest('table');
            if (table) {
                var header = table.querySelector('thead th:nth-child(' + (colIndex + 1) + ')');
                if (header) shiftDate = header.getAttribute('data-date') || header.textContent.trim();
            }
        }
        employeeName = this.getAttribute('data-employee-id') || employeeName;
        shiftDate = this.getAttribute('data-date') || shiftDate;

        dragSourceData = {
            employeeId: employeeName,
            date: shiftDate,
            shiftCode: currentShift,
            element: this
        };

        e.dataTransfer.effectAllowed = 'move';
        try {
            e.dataTransfer.setData('text/plain', JSON.stringify({
                employeeId: employeeName,
                date: shiftDate,
                shiftCode: currentShift
            }));
        } catch(err) { /* noop */ }
    }

    // ==========================================
    // Drag End
    // ==========================================
    function handleDragEnd(e) {
        this.classList.remove('dragging');
        document.querySelectorAll('.drop-valid, .drop-invalid').forEach(function(el) {
            el.classList.remove('drop-valid', 'drop-invalid');
        });
        dragSource = null;
        dragSourceData = null;
    }

    // ==========================================
    // Drag Over
    // ==========================================
    function handleDragOver(e) {
        if (!dragSource || !dragSourceData) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';

        var target = e.target.closest('.data-table tbody td, .calendar-day, .weekly-employee-item');
        if (!target || target === dragSource) return;

        target.classList.remove('drop-valid', 'drop-invalid');
        // Simple validation: allow drop if same date or different employee
        var targetDate = target.getAttribute('data-date') || '';
        var targetEmployee = target.getAttribute('data-employee-id') || '';
        var isValid = targetDate === dragSourceData.date || targetEmployee !== dragSourceData.employeeId;
        target.classList.add(isValid ? 'drop-valid' : 'drop-invalid');
    }

    // ==========================================
    // Drag Leave
    // ==========================================
    function handleDragLeave(e) {
        var target = e.target.closest('.data-table tbody td, .calendar-day, .weekly-employee-item');
        if (target) target.classList.remove('drop-valid', 'drop-invalid');
    }

    // ==========================================
    // Drop
    // ==========================================
    function handleDrop(e) {
        if (!dragSource || !dragSourceData) return;
        e.preventDefault();

        var target = e.target.closest('.data-table tbody td, .calendar-day, .weekly-employee-item');
        if (!target || target === dragSource) {
            cleanupDropClasses();
            return;
        }

        var targetDate = target.getAttribute('data-date') || '';
        var targetEmployee = target.getAttribute('data-employee-id') || '';
        var targetShift = target.textContent.trim();

        // Same date swap (between employees)
        if (targetDate === dragSourceData.date && targetEmployee && targetEmployee !== dragSourceData.employeeId) {
            handleSwap(dragSourceData, {
                employeeId: targetEmployee,
                date: targetDate,
                shiftCode: targetShift,
                element: target
            });
        }
        // Move to empty cell (same employee, different date)
        else if (targetEmployee === dragSourceData.employeeId && targetDate && targetDate !== dragSourceData.date) {
            moveShift(dragSourceData, { employeeId: targetEmployee, date: targetDate, shiftCode: targetShift, element: target });
        }
        // Cross swap
        else {
            handleSwap(dragSourceData, {
                employeeId: targetEmployee,
                date: targetDate,
                shiftCode: targetShift,
                element: target
            });
        }

        cleanupDropClasses();
    }

    function cleanupDropClasses() {
        document.querySelectorAll('.drop-valid, .drop-invalid').forEach(function(el) {
            el.classList.remove('drop-valid', 'drop-invalid');
        });
    }

    // ==========================================
    // Swap Shifts
    // ==========================================
    window.handleSwap = function(source, target) {
        if (!source || !target) return;
        if (!confirm('هل تريد استبدال المناوبة بين ' + source.employeeId + ' و ' + target.employeeId + '؟')) return;

        // Update local data
        swapLocalShifts(source, target);

        // Call server API
        var token = getToken();
        if (token) {
            fetch('/api/shift-roster/swap', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token
                },
                body: JSON.stringify({
                    employee_id_1: source.employeeId,
                    employee_id_2: target.employeeId,
                    shift_date: source.date || target.date
                })
            }).then(function(r) { return r.json(); }).then(function(data) {
                if (data.success) {
                    if (typeof showToast === 'function') showToast('تم الاستبدال بنجاح', 'success');
                    // Log audit for both sides
                    logAuditSwap(source, target);
                } else {
                    if (typeof showToast === 'function') showToast('فشل في الاستبدال: ' + (data.error || ''), 'error');
                }
            }).catch(function(err) {
                console.error('Swap error:', err);
                if (typeof showToast === 'function') showToast('فشل في الاتصال بالسيرفر', 'error');
            });
        } else {
            if (typeof showToast === 'function') showToast('تم الاستبدال محلياً (غير مسجل)', 'info');
        }

        if (typeof renderCurrentView === 'function') renderCurrentView();
        if (typeof updateStats === 'function') updateStats();
    };

    function moveShift(source, target) {
        if (!confirm('هل تريد نقل المناوبة من ' + source.date + ' إلى ' + target.date + '؟')) return;

        // Update local
        if (typeof employees !== 'undefined' && employees) {
            employees.forEach(function(emp) {
                if (emp.id === source.employeeId || emp.name === source.employeeId) {
                    emp.schedule.forEach(function(s) {
                        if (s.date === source.date) {
                            s.date = target.date;
                        }
                    });
                }
            });
        }

        var token = getToken();
        if (token) {
            fetch('/api/shift-roster/bulk-update', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token
                },
                body: JSON.stringify({
                    changes: [{
                        employee_id: source.employeeId,
                        shift_date: target.date,
                        shift_code: source.shiftCode,
                        old_shift_code: ''
                    }]
                })
            }).then(function(r) { return r.json(); }).then(function(data) {
                if (data.success) {
                    if (typeof showToast === 'function') showToast('تم النقل بنجاح', 'success');
                } else {
                    if (typeof showToast === 'function') showToast('فشل في النقل: ' + (data.error || ''), 'error');
                }
            }).catch(function(err) {
                console.error('Move error:', err);
                if (typeof showToast === 'function') showToast('فشل في الاتصال بالسيرفر', 'error');
            });
        } else {
            if (typeof showToast === 'function') showToast('تم النقل محلياً', 'info');
        }

        if (typeof renderCurrentView === 'function') renderCurrentView();
    }

    function swapLocalShifts(source, target) {
        if (typeof employees !== 'undefined' && employees) {
            employees.forEach(function(emp) {
                if (emp.id === source.employeeId || emp.name === source.employeeId) {
                    emp.schedule.forEach(function(s) {
                        if (s.date === source.date) s.shift = target.shiftCode;
                    });
                }
                if (emp.id === target.employeeId || emp.name === target.employeeId) {
                    emp.schedule.forEach(function(s) {
                        if (s.date === target.date) s.shift = source.shiftCode;
                    });
                }
            });
        }
    }

    function logAuditSwap(source, target) {
        var token = getToken();
        if (!token) return;
        fetch('/api/shift-roster/audit-log', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + token
            },
            body: JSON.stringify({
                employee_id: source.employeeId,
                shift_date: source.date || target.date,
                old_shift_code: source.shiftCode,
                new_shift_code: target.shiftCode,
                change_type: 'swap',
                reason: 'استبدال مع ' + target.employeeId
            })
        }).catch(function(e) { console.error('Audit swap log error:', e); });

        fetch('/api/shift-roster/audit-log', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + token
            },
            body: JSON.stringify({
                employee_id: target.employeeId,
                shift_date: target.date || source.date,
                old_shift_code: target.shiftCode,
                new_shift_code: source.shiftCode,
                change_type: 'swap',
                reason: 'استبدال مع ' + source.employeeId
            })
        }).catch(function(e) { console.error('Audit swap log error:', e); });
    }

    // Hook into view renders to refresh draggables
    var origRender = window.renderCurrentView;
    if (origRender) {
        window.renderCurrentView = function() {
            origRender();
            setTimeout(refreshDraggableCells, 120);
        };
    }

    document.addEventListener('DOMContentLoaded', function() {
        initDragDrop();
        var mva = document.getElementById('mainViewArea');
        if (mva) {
            var observer = new MutationObserver(function() {
                if (window.editMode) setTimeout(refreshDraggableCells, 60);
            });
            observer.observe(mva, { childList: true, subtree: true });
        }
    });

})();
