/* ==========================================
   التحقق من الصحة - Validation Engine
   smart-schedule-validation.js
   ========================================== */
(function() {
    'use strict';

    function getToken() {
        return localStorage.getItem('authToken') || '';
    }

    // ==========================================
    // Validate Current Roster
    // ==========================================
    window.validateCurrentRoster = function() {
        if (typeof employees === 'undefined' || !employees || employees.length === 0) {
            if (typeof showToast === 'function') showToast('لا توجد بيانات للتحقق', 'warning');
            return;
        }

        var changes = [];
        employees.forEach(function(emp) {
            if (emp.schedule && emp.schedule.length) {
                emp.schedule.forEach(function(s) {
                    changes.push({
                        employee_id: emp.id || emp.name,
                        shift_date: s.date,
                        shift_code: s.shiftCode || s.shift,
                        team_id: emp.team || ''
                    });
                });
            }
        });

        if (changes.length === 0) {
            if (typeof showToast === 'function') showToast('لا توجد مناوبات للتحقق', 'warning');
            return;
        }

        showValidationModal('جاري التحقق...');
        var token = getToken();
        if (token) {
            fetch('/api/shift-roster/validate', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token
                },
                body: JSON.stringify({ changes: changes })
            }).then(function(r) { return r.json(); }).then(function(data) {
                showValidationResult(data);
            }).catch(function(err) {
                console.error('Validation error:', err);
                // Fallback to local validation
                var localResult = validateLocal(changes);
                showValidationResult(localResult);
            });
        } else {
            var localResult = validateLocal(changes);
            showValidationResult(localResult);
        }
    };

    // ==========================================
    // Local Validation
    // ==========================================
    function validateLocal(changes) {
        var conflicts = [];
        var empDays = {};

        changes.forEach(function(c) {
            var key = (c.employee_id || '') + '|' + (c.shift_date || '');
            if (empDays[key]) {
                conflicts.push({
                    type: 'duplicate',
                    message: 'موظف لديه مناوبتان في نفس اليوم: ' + c.employee_id + ' - ' + c.shift_date,
                    employee_id: c.employee_id,
                    shift_date: c.shift_date
                });
            }
            empDays[key] = true;
        });

        // Check consecutive night shifts
        var empShifts = {};
        changes.forEach(function(c) {
            var eid = c.employee_id || '';
            if (!empShifts[eid]) empShifts[eid] = [];
            empShifts[eid].push(c);
        });

        Object.keys(empShifts).forEach(function(eid) {
            var list = empShifts[eid].sort(function(a, b) {
                return new Date(a.shift_date) - new Date(b.shift_date);
            });
            var consecutiveNights = 0;
            list.forEach(function(item) {
                var code = item.shift_code || '';
                if (code === 'ليلية') {
                    consecutiveNights++;
                    if (consecutiveNights > 3) {
                        conflicts.push({
                            type: 'warning',
                            message: 'موظف لديه ' + consecutiveNights + ' مناوبات ليلية متتالية: ' + eid,
                            employee_id: eid,
                            shift_date: item.shift_date
                        });
                    }
                } else {
                    consecutiveNights = 0;
                }
            });
        });

        return {
            success: true,
            valid: conflicts.length === 0,
            conflicts: conflicts
        };
    }

    // ==========================================
    // Validate Changes (API wrapper)
    // ==========================================
    window.validateChanges = function(changes) {
        return new Promise(function(resolve) {
            var token = getToken();
            if (!token) {
                resolve(validateLocal(changes || []));
                return;
            }
            fetch('/api/shift-roster/validate', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token
                },
                body: JSON.stringify({ changes: changes || [] })
            }).then(function(r) { return r.json(); }).then(function(data) {
                resolve(data);
            }).catch(function() {
                resolve(validateLocal(changes || []));
            });
        });
    };

    // ==========================================
    // Check Conflict (local)
    // ==========================================
    window.checkConflict = function(employeeId, date, code) {
        if (typeof employees === 'undefined' || !employees) return null;
        var emp = employees.find(function(e) { return e.id === employeeId || e.name === employeeId; });
        if (!emp || !emp.schedule) return null;
        var existing = emp.schedule.find(function(s) { return s.date === date; });
        if (existing && existing.shiftCode !== code) {
            return {
                type: 'conflict',
                message: 'يوجد مناوبة أخرى في نفس اليوم: ' + existing.shiftCode,
                employee_id: employeeId,
                shift_date: date
            };
        }
        return null;
    };

    // ==========================================
    // Check Max Hours (local heuristic)
    // ==========================================
    window.checkMaxHours = function(employeeId) {
        if (typeof employees === 'undefined' || !employees) return null;
        var emp = employees.find(function(e) { return e.id === employeeId || e.name === employeeId; });
        if (!emp || !emp.schedule) return null;
        var workDays = emp.schedule.filter(function(s) {
            var code = s.shiftCode || s.shift || '';
            return code !== 'إجازة' && code !== 'راحة' && code !== 'OFF';
        }).length;
        if (workDays > 26) {
            return {
                type: 'warning',
                message: 'الموظف لديه ' + workDays + ' أيام عمل هذا الشهر',
                employee_id: employeeId,
                work_days: workDays
            };
        }
        return null;
    };

    // ==========================================
    // Show Validation Modal
    // ==========================================
    function showValidationModal(content) {
        var modal = document.getElementById('validationModal');
        var body = document.getElementById('validationModalBody');
        if (!modal || !body) return;
        body.innerHTML = '<div class="text-center mt-3">' + content + '</div>';
        modal.classList.add('active');
    }

    // ==========================================
    // Show Validation Result
    // ==========================================
    window.showValidationResult = function(result) {
        var body = document.getElementById('validationModalBody');
        if (!body) return;
        if (!result) {
            body.innerHTML = '<div class="text-center mt-3">لا توجد نتائج</div>';
            return;
        }

        var html = '';
        if (result.valid && (!result.conflicts || result.conflicts.length === 0)) {
            html += '<div class="validation-result success">';
            html += '<div class="validation-result-title"><i class="fas fa-check-circle icon-success"></i> لا توجد تعارضات</div>';
            html += '<p style="color:#64748B;font-size:0.9rem;">جميع المناوبات صحيحة ولا توجد مشاكل.</p>';
            html += '</div>';
        } else {
            var errorCount = (result.conflicts || []).filter(function(c) { return c.type === 'error' || c.type === 'duplicate'; }).length;
            var warningCount = (result.conflicts || []).filter(function(c) { return c.type === 'warning'; }).length;
            html += '<div class="validation-result ' + (errorCount > 0 ? 'error' : 'warning') + '">';
            html += '<div class="validation-result-title">';
            html += '<i class="fas ' + (errorCount > 0 ? 'fa-exclamation-circle icon-error' : 'fa-exclamation-triangle icon-warning') + '"></i> ';
            html += 'تم العثور على ' + (result.conflicts || []).length + ' ملاحظة';
            html += '</div>';
            html += '<p style="color:#64748B;font-size:0.85rem;">' + errorCount + ' خطأ · ' + warningCount + ' تحذير</p>';
            html += '</div>';

            if (result.conflicts && result.conflicts.length > 0) {
                html += '<div class="validation-conflict-list">';
                result.conflicts.forEach(function(c) {
                    var icon = c.type === 'error' || c.type === 'duplicate' ? 'fa-times-circle' : 'fa-exclamation-triangle';
                    var cls = c.type === 'error' || c.type === 'duplicate' ? 'error' : 'warning';
                    html += '<div class="validation-conflict-item ' + cls + '">';
                    html += '<i class="fas ' + icon + '"></i>';
                    html += '<div class="validation-conflict-text">' + (c.message || '') + '<br><small style="color:#94A3B8;">' + (c.employee_id || '') + ' — ' + (c.shift_date || '') + '</small></div>';
                    html += '</div>';
                });
                html += '</div>';
            }
        }

        body.innerHTML = html;
    };

    // ==========================================
    // Close Validation Modal
    // ==========================================
    window.closeValidationModal = function() {
        var modal = document.getElementById('validationModal');
        if (modal) modal.classList.remove('active');
    };

    // Close on click outside
    document.addEventListener('DOMContentLoaded', function() {
        var modal = document.getElementById('validationModal');
        if (modal) {
            modal.addEventListener('click', function(e) {
                if (e.target === modal) closeValidationModal();
            });
        }
    });

})();
