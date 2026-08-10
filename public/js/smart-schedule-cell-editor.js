/* ==========================================
   تعديل خلية المناوبة + بطاقة الموظف + تعارض الاستيراد
   smart-schedule-cell-editor.js
   ==========================================
   قرارات ملزمة (من المالك):
   - رموز المناوبات تُجلب حرفيًا من GET /api/shift-codes — بلا hardcode وبلا طبقة ترجمة.
     الرمز المعروض = الرمز المخزن = الرمز في التقارير.
   - أنماط A/B/C/D (shift_patterns) منفصلة تمامًا عن رموز المناوبات اليومية.
   - تعديل يوم واحد عبر PUT /api/shift-roster/cell لا يغيّر غيره.
   - النقل والنمط وتعديل الخلايا: admin/director فقط.
*/
(function () {
    'use strict';

    // ==========================================
    // مصادقة وصلاحيات (نفس نمط smart-schedule-editor.js)
    // ==========================================
    function getToken() {
        if (window.AuthCore && typeof AuthCore.getToken === 'function') return AuthCore.getToken() || '';
        return localStorage.getItem('auth_access_token') || localStorage.getItem('authToken') || '';
    }

    function userRole() {
        try {
            var token = getToken();
            if (!token) return null;
            var payload = JSON.parse(atob(token.split('.')[1]));
            return payload.role || null;
        } catch (e) {
            return null;
        }
    }

    function canEdit() {
        var role = userRole();
        return role === 'admin' || role === 'director';
    }

    function apiFetch(url, options) {
        options = options || {};
        if (window.AuthCore && typeof AuthCore.apiRequest === 'function') {
            return AuthCore.apiRequest(url, options);
        }
        var headers = options.headers || {};
        var token = getToken();
        if (token) headers['Authorization'] = 'Bearer ' + token;
        if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
        return fetch(url, Object.assign({}, options, { headers: headers }));
    }

    function toast(message, type) {
        if (typeof window.showToast === 'function') window.showToast(message, type || 'info');
    }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function todayISO() {
        try {
            if (window.TimeRiyadh && typeof TimeRiyadh.formatDate === 'function') {
                return TimeRiyadh.formatDate(new Date());
            }
        } catch (e) { /* تجاهل */ }
        return new Date().toISOString().slice(0, 10);
    }

    // ==========================================
    // رموز المناوبات — من الخادم فقط، حرفيًا كما هي مخزنة
    // ==========================================
    var _shiftCodesPromise = null;
    function loadShiftCodes(force) {
        if (!_shiftCodesPromise || force) {
            _shiftCodesPromise = apiFetch('/api/shift-codes')
                .then(function (r) { return r.json(); })
                .then(function (d) { return (d && Array.isArray(d.codes)) ? d.codes : []; })
                .catch(function () { return []; });
        }
        return _shiftCodesPromise;
    }

    // ==========================================
    // حقن CSS والمودالات (نمط style.display flex/none)
    // ==========================================
    var _uiReady = false;
    function ensureUI() {
        if (_uiReady) return;
        _uiReady = true;

        var css = document.createElement('style');
        css.textContent =
            '.ssce-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;align-items:center;justify-content:center;z-index:9999;padding:16px;}' +
            '.ssce-box{background:#121C2E;color:var(--text,#e2e8f0);border:1px solid rgba(255,255,255,.16);border-radius:16px;max-width:640px;width:100%;max-height:85vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.55);}' +
            '.ssce-head{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--border,#334155);font-weight:800;}' +
            '.ssce-close{background:none;border:none;color:var(--text-muted,#94a3b8);font-size:1.1rem;cursor:pointer;}' +
            '.ssce-close:hover{color:var(--text,#e2e8f0);}' +
            '.ssce-body{padding:16px 18px;overflow-y:auto;}' +
            '.ssce-codes{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px;}' +
            '.ssce-code-btn{background:var(--gray-light,#0f172a);border:1px solid var(--border,#334155);border-radius:10px;padding:8px 6px;cursor:pointer;text-align:center;font-family:inherit;color:inherit;transition:border-color .15s;}' +
            '.ssce-code-btn:hover{border-color:var(--primary,#2563EB);}' +
            '.ssce-code-btn .c{display:block;font-weight:800;font-size:.95rem;}' +
            '.ssce-code-btn .n{display:block;font-size:.62rem;color:var(--text-muted,#94a3b8);margin-top:2px;line-height:1.3;}' +
            '.ssce-code-btn.current{border-color:var(--primary,#2563EB);box-shadow:0 0 0 1px var(--primary,#2563EB);}' +
            '.ssce-info-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 16px;margin-bottom:14px;}' +
            '.ssce-info-item{font-size:.82rem;}' +
            '.ssce-info-item .k{color:var(--text-muted,#94a3b8);font-size:.68rem;display:block;}' +
            '.ssce-info-item a{color:var(--primary,#60a5fa);text-decoration:none;}' +
            '.ssce-section{border-top:1px solid var(--border,#334155);padding-top:12px;margin-top:12px;}' +
            '.ssce-section h4{margin:0 0 8px;font-size:.85rem;color:var(--primary,#60a5fa);}' +
            '.ssce-table{width:100%;border-collapse:collapse;font-size:.75rem;}' +
            '.ssce-table th,.ssce-table td{padding:5px 8px;border-bottom:1px solid var(--border,#334155);text-align:right;}' +
            '.ssce-table th{color:var(--text-muted,#94a3b8);font-weight:700;}' +
            '.ssce-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0;}' +
            '.ssce-row select,.ssce-row input[type=date]{background:var(--gray-light,#0f172a);border:1px solid var(--border,#334155);color:inherit;border-radius:8px;padding:6px 10px;font-family:inherit;font-size:.8rem;}' +
            '.ssce-row label{font-size:.78rem;display:flex;align-items:center;gap:4px;}' +
            '.ssce-btn{background:var(--primary,#2563EB);color:#fff;border:none;border-radius:8px;padding:7px 16px;font-weight:700;font-family:inherit;font-size:.8rem;cursor:pointer;}' +
            '.ssce-btn:disabled{opacity:.5;cursor:default;}' +
            '.ssce-btn.secondary{background:var(--gray-light,#0f172a);color:var(--text,#e2e8f0);border:1px solid var(--border,#334155);}' +
            '.ssce-btn.danger{background:#dc2626;}' +
            '.ssce-actions{display:flex;gap:10px;justify-content:flex-start;padding:12px 18px;border-top:1px solid var(--border,#334155);}' +
            '.ssce-empty{color:var(--text-muted,#94a3b8);font-size:.78rem;text-align:center;padding:14px;}' +
            '.ssce-loading{text-align:center;padding:24px;color:var(--text-muted,#94a3b8);}' +
            '.ssce-phone-edit{background:none;border:none;color:var(--primary,#60a5fa);cursor:pointer;font-size:.72rem;padding:2px 6px;}' +
            '.ssce-phone-input{background:#0f172a;border:1px solid var(--border,#334155);color:inherit;border-radius:6px;padding:4px 8px;font-family:inherit;font-size:.8rem;width:130px;direction:ltr;}' +
            '.ssce-mini-btn{background:var(--primary,#2563EB);color:#fff;border:none;border-radius:6px;padding:4px 10px;font-size:.72rem;font-family:inherit;cursor:pointer;}' +
            '.ssce-mini-btn.secondary{background:#0f172a;color:var(--text,#e2e8f0);border:1px solid var(--border,#334155);}' +
            '.ssce-import-file{border:1px dashed var(--border,#334155);border-radius:10px;padding:14px;text-align:center;font-size:.8rem;color:var(--text-muted,#94a3b8);margin-bottom:12px;}' +
            '.ssce-import-summary{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px;margin:10px 0;}' +
            '.ssce-sum-box{background:#0f172a;border:1px solid var(--border,#334155);border-radius:8px;padding:8px;text-align:center;}' +
            '.ssce-sum-box .n{font-size:1.1rem;font-weight:800;display:block;}' +
            '.ssce-sum-box .t{font-size:.66rem;color:var(--text-muted,#94a3b8);}' +
            '.ssce-warn-list{max-height:150px;overflow-y:auto;font-size:.74rem;background:#0f172a;border:1px solid var(--border,#334155);border-radius:8px;padding:8px 10px;margin:6px 0;}' +
            '.ssce-warn-list .w-title{font-weight:800;margin-bottom:4px;}';
        document.head.appendChild(css);

        var wrap = document.createElement('div');
        wrap.innerHTML =
            // منتقي رمز المناوبة
            '<div class="ssce-overlay" id="cellShiftPickerModal">' +
                '<div class="ssce-box">' +
                    '<div class="ssce-head"><span id="cellShiftPickerTitle">تعديل المناوبة</span>' +
                    '<button class="ssce-close" onclick="document.getElementById(\'cellShiftPickerModal\').style.display=\'none\'"><i class="fas fa-times"></i></button></div>' +
                    '<div class="ssce-body" id="cellShiftPickerBody"></div>' +
                '</div>' +
            '</div>' +
            // بطاقة الموظف
            '<div class="ssce-overlay" id="employeeCardModal">' +
                '<div class="ssce-box">' +
                    '<div class="ssce-head"><span id="employeeCardTitle">بطاقة الموظف</span>' +
                    '<button class="ssce-close" onclick="document.getElementById(\'employeeCardModal\').style.display=\'none\'"><i class="fas fa-times"></i></button></div>' +
                    '<div class="ssce-body" id="employeeCardBody"></div>' +
                '</div>' +
            '</div>' +
            // تعارض الاستيراد مع تعديلات يدوية
            '<div class="ssce-overlay" id="importConflictModal">' +
                '<div class="ssce-box">' +
                    '<div class="ssce-head"><span><i class="fas fa-exclamation-triangle" style="color:#f59e0b;"></i> تعارض مع تعديلات يدوية</span>' +
                    '<button class="ssce-close" onclick="document.getElementById(\'importConflictModal\').style.display=\'none\'"><i class="fas fa-times"></i></button></div>' +
                    '<div class="ssce-body" id="importConflictBody"></div>' +
                    '<div class="ssce-actions">' +
                        '<button class="ssce-btn secondary" id="importConflictCancel">إلغاء الاستيراد</button>' +
                        '<button class="ssce-btn danger" id="importConflictOverwrite">الكتابة فوق التعديلات اليدوية</button>' +
                    '</div>' +
                '</div>' +
            '</div>' +
            // استيراد أرقام الجوالات (معاينة ثم تنفيذ)
            '<div class="ssce-overlay" id="phonesImportModal">' +
                '<div class="ssce-box">' +
                    '<div class="ssce-head"><span><i class="fas fa-address-book" style="color:var(--primary,#60a5fa);"></i> استيراد أرقام الجوالات</span>' +
                    '<button class="ssce-close" onclick="document.getElementById(\'phonesImportModal\').style.display=\'none\'"><i class="fas fa-times"></i></button></div>' +
                    '<div class="ssce-body" id="phonesImportBody"></div>' +
                    '<div class="ssce-actions" id="phonesImportActions" style="display:none;">' +
                        '<button class="ssce-btn secondary" onclick="document.getElementById(\'phonesImportModal\').style.display=\'none\'">إلغاء</button>' +
                        '<button class="ssce-btn" id="phonesImportConfirm">تأكيد الاستيراد</button>' +
                    '</div>' +
                '</div>' +
            '</div>';
        document.body.appendChild(wrap);

        // إغلاق عند النقر على الخلفية
        ['cellShiftPickerModal', 'employeeCardModal', 'importConflictModal', 'phonesImportModal'].forEach(function (id) {
            document.getElementById(id).addEventListener('click', function (e) {
                if (e.target === this) this.style.display = 'none';
            });
        });
    }

    // ==========================================
    // 1) تعديل خلية المناوبة
    // ==========================================
    var _pickerCtx = null; // {cell, empId, dateStr}

    function findEmployee(empId) {
        if (typeof employees === 'undefined' || !employees) return null;
        for (var i = 0; i < employees.length; i++) {
            if (String(employees[i].id) === String(empId) ||
                String(employees[i].employeeNumber || '') === String(empId)) return employees[i];
        }
        return null;
    }

    function openShiftPicker(cell, empId, dateStr) {
        ensureUI();
        _pickerCtx = { cell: cell, empId: empId, dateStr: dateStr };

        var emp = findEmployee(empId);
        var empName = emp ? (emp.name || '') : '';
        document.getElementById('cellShiftPickerTitle').textContent =
            'تعديل المناوبة — ' + empName + ' — ' + dateStr;

        var body = document.getElementById('cellShiftPickerBody');
        body.innerHTML = '<div class="ssce-loading"><i class="fas fa-spinner fa-spin"></i> جاري جلب رموز المناوبات…</div>';
        document.getElementById('cellShiftPickerModal').style.display = 'flex';

        loadShiftCodes().then(function (codes) {
            if (!codes.length) {
                body.innerHTML = '<div class="ssce-empty">تعذّر جلب رموز المناوبات من الخادم</div>';
                return;
            }
            var currentCode = cell.getAttribute('data-shift-code') || '';
            var html = '<div class="ssce-codes">';
            codes.forEach(function (sc) {
                var code = String(sc.code || '');
                if (!code) return;
                html += '<button type="button" class="ssce-code-btn' + (code === currentCode ? ' current' : '') + '"' +
                    ' onclick="window._sscePickShiftCode(\'' + esc(code) + '\')">' +
                    '<span class="c">' + esc(code) + '</span>' +
                    (sc.name ? '<span class="n">' + esc(sc.name) + '</span>' : '') +
                    '</button>';
            });
            html += '</div>';
            body.innerHTML = html;
        });
    }

    window._sscePickShiftCode = async function (shiftCode) {
        if (!_pickerCtx) return;
        var ctx = _pickerCtx;
        var cell = ctx.cell;
        var oldCode = cell.getAttribute('data-shift-code') || '';
        if (shiftCode === oldCode) {
            document.getElementById('cellShiftPickerModal').style.display = 'none';
            return;
        }

        document.getElementById('cellShiftPickerModal').style.display = 'none';
        cell.classList.add('cell-saving');
        cell.innerHTML = '<i class="fas fa-spinner fa-spin" style="color:var(--primary);"></i>';

        try {
            var response = await apiFetch('/api/shift-roster/cell', {
                method: 'PUT',
                body: JSON.stringify({
                    employeeCode: String(ctx.empId),
                    date: ctx.dateStr,
                    shiftCode: shiftCode
                })
            });
            var result = await response.json().catch(function () { return {}; });
            if (!response.ok || !result.success) {
                // فشل — أعد الخلية لحالتها وأظهر رسالة الخادم
                renderCellCode(cell, oldCode);
                toast('❌ ' + (result.error || 'فشل تعديل المناوبة'), 'error');
                return;
            }

            // نجاح — حدّث الخلية مباشرة بدون reload
            renderCellCode(cell, shiftCode);

            // حدّث نموذج البيانات المحلي (نفس منهجية الصفحة في اشتقاق الحالة)
            var emp = findEmployee(ctx.empId);
            if (emp) {
                var status = 'دوام';
                if (shiftCode === 'V' || shiftCode === 'VC' || shiftCode === 'E' || shiftCode === 'EV') status = 'إجازة';
                else if (shiftCode === 'WO') status = 'راحة';
                else if (shiftCode === 'C') status = 'تدريب';
                else if (shiftCode === 'ME' || shiftCode === 'F' || shiftCode.indexOf('CP') === 0) status = 'تكميل';
                var found = false;
                (emp.schedule || []).forEach(function (s) {
                    if (s.date === ctx.dateStr) {
                        s.shift = shiftCode; s.shiftCode = shiftCode; s.status = status;
                        if (result.entry && result.entry.id) s.rosterId = result.entry.id;
                        found = true;
                    }
                });
                if (!found) {
                    emp.schedule = emp.schedule || [];
                    emp.schedule.push({
                        date: ctx.dateStr, day: '', shift: shiftCode, shiftCode: shiftCode,
                        status: status, time: '', rosterId: (result.entry && result.entry.id) || null
                    });
                }
            }

            toast('✅ تم تعديل المناوبة إلى ' + shiftCode, 'success');
            try { if (typeof updateStats === 'function') updateStats(); } catch (e) { /* تجاهل */ }
        } catch (err) {
            console.error('Cell shift update error:', err);
            renderCellCode(cell, oldCode);
            toast('❌ خطأ في الاتصال بالخادم', 'error');
        }
    };

    function renderCellCode(cell, code) {
        cell.classList.remove('cell-saving', 'editing');
        cell.setAttribute('data-shift-code', code);
        if (code) {
            var safeCode = String(code).replace(/[^a-zA-Z0-9]/g, '');
            cell.className = 'classic-grid-cell editable classic-shift-' + safeCode;
            // الرمز المعروض = الرمز المخزن — حرفيًا
            cell.innerHTML = '<span class="classic-shift-code">' + esc(code) + '</span>';
            cell.title = code;
        } else {
            cell.className = 'classic-grid-cell editable';
            cell.innerHTML = '-';
            cell.title = '';
        }
    }

    // نقطة الدخول: تستبدل آلية التعديل القديمة غير العملية
    window.editCell = function (cell, empId, dateStr) {
        if (!canEdit()) {
            toast('التعديل متاح لمدير النظام ومدير العمليات فقط', 'info');
            return;
        }
        openShiftPicker(cell, empId, dateStr);
    };

    // ==========================================
    // 2) بطاقة الموظف
    // ==========================================
    window.openEmployeeCard = async function (employeeCode) {
        ensureUI();
        var modal = document.getElementById('employeeCardModal');
        var body = document.getElementById('employeeCardBody');
        document.getElementById('employeeCardTitle').textContent = 'بطاقة الموظف';
        body.innerHTML = '<div class="ssce-loading"><i class="fas fa-spinner fa-spin"></i> جاري تحميل بيانات الموظف…</div>';
        modal.style.display = 'flex';

        try {
            var response = await apiFetch('/api/employees/' + encodeURIComponent(employeeCode) + '/profile');
            var data = await response.json().catch(function () { return {}; });
            if (!response.ok || !data.success) {
                body.innerHTML = '<div class="ssce-empty">' + esc(data.error || 'تعذّر تحميل بيانات الموظف') + '</div>';
                return;
            }
            renderEmployeeCard(data, canEdit());
        } catch (err) {
            console.error('Employee profile error:', err);
            body.innerHTML = '<div class="ssce-empty">خطأ في الاتصال بالخادم</div>';
        }
    };

    function renderEmployeeCard(data, editable) {
        var emp = data.employee || {};
        var team = data.team || null;
        var roster = Array.isArray(data.roster) ? data.roster : [];
        var leaves = Array.isArray(data.leaves) ? data.leaves : [];

        document.getElementById('employeeCardTitle').textContent = emp.name || 'بطاقة الموظف';

        var html = '<div class="ssce-info-grid">' +
            infoItem('الكود الوظيفي', emp.code) +
            infoItem('المسمى الوظيفي', emp.jobTitle) +
            '<div class="ssce-info-item"><span class="k">الجوال</span>' +
                '<span id="sscePhoneValue">' +
                (emp.phone
                    ? '<a href="tel:' + esc(emp.phone) + '"><i class="fas fa-phone"></i> ' + esc(emp.phone) + '</a>'
                    : '<span>—</span>') + '</span>' +
                (editable ? ' <button type="button" class="ssce-phone-edit" title="تعديل الجوال" onclick="window._ssceEditPhone(\'' + esc(emp.code) + '\')"><i class="fas fa-pen"></i></button>' : '') +
                '</div>' +
            infoItem('الرمز', emp.symbol) +
            infoItem('المركز', team ? team.center : null) +
            infoItem('الفرقة', team ? team.name : null) +
            infoItem('النمط', emp.patternCode) +
            '</div>';

        // المناوبات — الشهر الحالي (من الخادم)
        html += '<div class="ssce-section"><h4><i class="fas fa-calendar-alt"></i> مناوبات الشهر الحالي</h4>';
        if (!roster.length) {
            html += '<div class="ssce-empty">لا توجد مناوبات مسجلة هذا الشهر</div>';
        } else {
            html += '<table class="ssce-table"><thead><tr><th>التاريخ</th><th>الرمز</th><th>الفرقة</th></tr></thead><tbody>';
            roster.forEach(function (r) {
                html += '<tr><td>' + esc(r.shift_date || r.date || '') + '</td>' +
                    '<td><strong>' + esc(r.shift_code || r.shiftCode || '') + '</strong></td>' +
                    '<td>' + esc(r.team_name || r.teamName || '—') + '</td></tr>';
            });
            html += '</tbody></table>';
        }
        html += '</div>';

        // الإجازات
        html += '<div class="ssce-section"><h4><i class="fas fa-umbrella-beach"></i> الإجازات</h4>';
        if (!leaves.length) {
            html += '<div class="ssce-empty">لا توجد إجازات مسجلة</div>';
        } else {
            html += '<table class="ssce-table"><tbody>';
            leaves.forEach(function (l) {
                var label = l.leave_type || l.type || 'إجازة';
                var range = (l.start_date || l.from_date || '') + (l.end_date || l.to_date ? ' ← ' + (l.end_date || l.to_date) : '');
                var status = l.status ? ' (' + l.status + ')' : '';
                html += '<tr><td>' + esc(label) + status + '</td><td>' + esc(range || '—') + '</td></tr>';
            });
            html += '</tbody></table>';
        }
        html += '</div>';

        if (editable) {
            // نقل الفرقة — قسم مستقل
            html += '<div class="ssce-section"><h4><i class="fas fa-exchange-alt"></i> نقل الفرقة</h4>' +
                '<div class="ssce-row"><select id="ecTransferTeam"><option value="">جاري جلب الفرق…</option></select></div>' +
                '<div class="ssce-row">' +
                    '<label><input type="radio" name="ecTransferScope" value="day" checked> هذا اليوم فقط</label>' +
                    '<label><input type="radio" name="ecTransferScope" value="from-date"> من تاريخ فصاعدًا</label>' +
                '</div>' +
                '<div class="ssce-row">' +
                    '<input type="date" id="ecTransferDate" value="' + todayISO() + '">' +
                    '<button class="ssce-btn" id="ecTransferSave"><i class="fas fa-save"></i> حفظ النقل</button>' +
                '</div></div>';

            // النمط — قسم مستقل تمامًا، لا علاقة له بالنقل
            html += '<div class="ssce-section"><h4><i class="fas fa-sync-alt"></i> نمط المناوبة (A/B/C/D)</h4>' +
                '<div class="ssce-row"><select id="ecPatternSelect"><option value="">جاري جلب الأنماط…</option></select>' +
                '<button class="ssce-btn" id="ecPatternSave"><i class="fas fa-save"></i> حفظ النمط</button>' +
                '</div></div>';
        }

        document.getElementById('employeeCardBody').innerHTML = html;

        if (editable) {
            loadTeamsInto(document.getElementById('ecTransferTeam'));
            loadPatternsInto(document.getElementById('ecPatternSelect'), emp.patternCode);

            document.getElementById('ecTransferSave').addEventListener('click', function () {
                saveTransfer(emp.code, emp.name);
            });
            document.getElementById('ecPatternSave').addEventListener('click', function () {
                savePattern(emp.code, emp.name);
            });
        }
    }

    function infoItem(label, value) {
        return '<div class="ssce-info-item"><span class="k">' + esc(label) + '</span><span>' +
            (value != null && value !== '' ? esc(value) : '—') + '</span></div>';
    }

    function loadTeamsInto(selectEl) {
        apiFetch('/api/teams')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var teams = (d && Array.isArray(d.teams)) ? d.teams : [];
                var html = '<option value="">— اختر الفرقة —</option>';
                teams.forEach(function (t) {
                    html += '<option value="' + esc(t.id) + '">' + esc(t.name) +
                        (t.center ? ' (' + esc(t.center) + ')' : '') + '</option>';
                });
                selectEl.innerHTML = html;
            })
            .catch(function () {
                selectEl.innerHTML = '<option value="">تعذّر جلب الفرق</option>';
            });
    }

    function loadPatternsInto(selectEl, currentPattern) {
        apiFetch('/api/shift-patterns')
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var patterns = (d && Array.isArray(d.patterns)) ? d.patterns : [];
                var html = '<option value="">— بدون نمط —</option>';
                patterns.forEach(function (p) {
                    var sel = (currentPattern && String(p.code) === String(currentPattern)) ? ' selected' : '';
                    html += '<option value="' + esc(p.code) + '"' + sel + '>' + esc(p.code) +
                        (p.name ? ' — ' + esc(p.name) : '') + '</option>';
                });
                selectEl.innerHTML = html;
            })
            .catch(function () {
                selectEl.innerHTML = '<option value="">تعذّر جلب الأنماط</option>';
            });
    }

    async function saveTransfer(employeeCode, empName) {
        var teamId = document.getElementById('ecTransferTeam').value;
        var date = document.getElementById('ecTransferDate').value;
        var scopeEl = document.querySelector('input[name="ecTransferScope"]:checked');
        var scope = scopeEl ? scopeEl.value : 'day';

        if (!teamId) { toast('اختر الفرقة أولًا', 'error'); return; }
        if (!date) { toast('حدد التاريخ', 'error'); return; }

        var btn = document.getElementById('ecTransferSave');
        btn.disabled = true;
        try {
            var response = await apiFetch('/api/employees/' + encodeURIComponent(employeeCode) + '/transfer', {
                method: 'POST',
                body: JSON.stringify({ teamId: Number(teamId), scope: scope, date: date })
            });
            var result = await response.json().catch(function () { return {}; });
            if (!response.ok || !result.success) {
                toast('❌ ' + (result.error || 'فشل نقل الفرقة'), 'error');
                return;
            }
            toast('✅ ' + (result.message || 'تم نقل الفرقة بنجاح'), 'success');
            applyTransferToDOM(employeeCode);
        } catch (err) {
            console.error('Transfer error:', err);
            toast('❌ خطأ في الاتصال بالخادم', 'error');
        } finally {
            btn.disabled = false;
        }
    }

    // تحديث DOM جزئي بعد النقل — بلا reload
    function applyTransferToDOM(employeeCode) {
        var selectEl = document.getElementById('ecTransferTeam');
        var teamName = selectEl && selectEl.selectedOptions.length
            ? selectEl.selectedOptions[0].textContent.replace(/\s*\(.*\)\s*$/, '')
            : null;

        // نموذج البيانات المحلي
        var emp = findEmployee(employeeCode);
        if (emp && teamName) emp.team = teamName;

        // خلية الاسم في الشبكة الكلاسيكية (title يعرض الفرقة)
        var nameCell = document.querySelector('.classic-grid-cell[data-emp-row="' + employeeCode + '"]');
        if (nameCell && emp) {
            nameCell.title = (emp.jobTitle || '') + ' | ' + (teamName || '-');
        }

        // تحديث عرض الفرقة داخل البطاقة نفسها
        var body = document.getElementById('employeeCardBody');
        if (body && teamName) {
            var items = body.querySelectorAll('.ssce-info-item');
            items.forEach(function (item) {
                var k = item.querySelector('.k');
                if (k && k.textContent === 'الفرقة') {
                    var v = item.querySelector('span:last-child');
                    if (v) v.textContent = teamName;
                }
            });
        }
    }

    async function savePattern(employeeCode, empName) {
        var patternCode = document.getElementById('ecPatternSelect').value || null;
        var btn = document.getElementById('ecPatternSave');
        btn.disabled = true;
        try {
            var response = await apiFetch('/api/employees/' + encodeURIComponent(employeeCode) + '/pattern', {
                method: 'PUT',
                body: JSON.stringify({ patternCode: patternCode })
            });
            var result = await response.json().catch(function () { return {}; });
            if (!response.ok || !result.success) {
                toast('❌ ' + (result.error || 'فشل حفظ النمط'), 'error');
                return;
            }
            toast('✅ تم حفظ النمط' + (patternCode ? ' (' + patternCode + ')' : ' (بدون نمط)'), 'success');

            // تحديث عرض النمط داخل البطاقة
            var body = document.getElementById('employeeCardBody');
            if (body) {
                var items = body.querySelectorAll('.ssce-info-item');
                items.forEach(function (item) {
                    var k = item.querySelector('.k');
                    if (k && k.textContent === 'النمط') {
                        var v = item.querySelector('span:last-child');
                        if (v) v.textContent = patternCode || '—';
                    }
                });
            }
        } catch (err) {
            console.error('Pattern save error:', err);
            toast('❌ خطأ في الاتصال بالخادم', 'error');
        } finally {
            btn.disabled = false;
        }
    }

    // ==========================================
    // 3) تعارض الاستيراد (409) مع التعديلات اليدوية
    // ==========================================
    window.showImportConflictModal = function (conflicts, onOverwrite) {
        ensureUI();
        var body = document.getElementById('importConflictBody');
        var html = '<div style="font-size:.82rem;margin-bottom:10px;">' +
            'الاستيراد يتعارض مع <strong>' + conflicts.length + '</strong> تعيينًا يدويًا محميًا. ' +
            'اختر إلغاء الاستيراد أو الكتابة فوق التعديلات اليدوية:</div>' +
            '<table class="ssce-table"><thead><tr>' +
            '<th>الموظف</th><th>الفرقة اليدوية</th><th>فرقة الاستيراد</th><th>التاريخ</th>' +
            '</tr></thead><tbody>';
        conflicts.forEach(function (c) {
            html += '<tr>' +
                '<td>' + esc(c.name || '') + (c.employeeCode ? ' <small style="color:var(--text-muted,#94a3b8);">(' + esc(c.employeeCode) + ')</small>' : '') + '</td>' +
                '<td>' + esc(c.manualTeam || '—') + '</td>' +
                '<td>' + esc(c.importTeam || '—') + '</td>' +
                '<td>' + esc(c.assignedDate || '—') + '</td>' +
                '</tr>';
        });
        html += '</tbody></table>';
        body.innerHTML = html;

        var modal = document.getElementById('importConflictModal');
        modal.style.display = 'flex';

        document.getElementById('importConflictCancel').onclick = function () {
            modal.style.display = 'none';
            toast('تم إلغاء الاستيراد — لم تُكتب أي بيانات إلى الخادم', 'info');
        };
        document.getElementById('importConflictOverwrite').onclick = function () {
            if (!confirm('سيتم استبدال التعيينات اليدوية المعروضة ببيانات الاستيراد.\n\nهل أنت متأكد؟')) return;
            modal.style.display = 'none';
            if (typeof onOverwrite === 'function') onOverwrite();
        };
    };

    // ==========================================
    // 4) تعديل رقم الجوال يدويًا من بطاقة الموظف (admin/director)
    // ==========================================
    window._ssceEditPhone = function (code) {
        var span = document.getElementById('sscePhoneValue');
        if (!span || span.dataset.editing === '1') return;
        span.dataset.editing = '1';
        var current = (span.textContent || '').trim();
        if (current === '—') current = '';
        span.innerHTML = '<input type="text" class="ssce-phone-input" id="sscePhoneInput" value="' + esc(current) + '" placeholder="05xxxxxxxx" maxlength="15">' +
            ' <button type="button" class="ssce-mini-btn" id="sscePhoneSave">حفظ</button>' +
            ' <button type="button" class="ssce-mini-btn secondary" id="sscePhoneCancel">إلغاء</button>';

        function done() { span.dataset.editing = ''; }
        function render(phone) {
            span.innerHTML = phone
                ? '<a href="tel:' + esc(phone) + '"><i class="fas fa-phone"></i> ' + esc(phone) + '</a>'
                : '<span>—</span>';
            done();
        }
        document.getElementById('sscePhoneCancel').onclick = function () { render(current || null); };
        document.getElementById('sscePhoneSave').onclick = async function () {
            var btn = this;
            var val = document.getElementById('sscePhoneInput').value.trim();
            btn.disabled = true;
            try {
                var r = await apiFetch('/api/employees/' + encodeURIComponent(code) + '/phone', {
                    method: 'PUT',
                    body: JSON.stringify({ phone: val })
                });
                var d = await r.json().catch(function () { return {}; });
                if (!r.ok || !d.success) {
                    toast('❌ ' + (d.error || 'تعذّر حفظ الرقم'), 'error');
                    btn.disabled = false;
                    return;
                }
                render(d.phone);
                toast('✅ تم حفظ رقم الجوال', 'success');
            } catch (err) {
                console.error('Phone save error:', err);
                toast('❌ خطأ في الاتصال بالخادم', 'error');
                btn.disabled = false;
            }
        };
        var inp = document.getElementById('sscePhoneInput');
        if (inp) { inp.focus(); inp.select(); }
    };

    // ==========================================
    // 5) استيراد أرقام الجوالات جماعيًا (Excel/CSV — مطابقة بالكود الوظيفي)
    // ==========================================
    var _phonesRows = null; // صفوف الملف المقروء [{code, phone}]

    var CODE_HEADERS = ['code', 'employee_code', 'employeecode', 'employeenumber', 'empcode', 'employee code', 'employee id', 'emp no', 'empno',
        'الكود', 'الكود الوظيفي', 'الرقم الوظيفي', 'رقم الموظف', 'كود الموظف', 'الكود الوظيفي للموظف', 'كود'];
    var PHONE_HEADERS = ['phone', 'mobile', 'phonenumber', 'phoneno', 'phone number', 'mobile number', 'tel', 'telephone',
        'الجوال', 'رقم الجوال', 'جوال', 'الهاتف', 'رقم الهاتف', 'رقم جوال الموظف', 'رقم جوال', 'موبايل', 'الموبايل', 'جوال الموظف', 'الجوال '];

    function normHeader(h) {
        return String(h == null ? '' : h).trim().toLowerCase().replace(/[ _\-]/g, '');
    }

    function parsePhonesRows(matrix, sheetName) {
        if (!matrix || !matrix.length) return [];
        // اكتشاف صف العناوين: أول صف يحتوي عمود كود وعمود جوال
        var headerIdx = -1, codeCol = 0, phoneCol = 1;
        for (var i = 0; i < Math.min(matrix.length, 10); i++) {
            var cells = (matrix[i] || []).map(normHeader);
            var ci = -1, pi = -1;
            for (var j = 0; j < cells.length; j++) {
                if (ci < 0 && CODE_HEADERS.some(function (h) { return normHeader(h) === cells[j]; })) ci = j;
                if (pi < 0 && PHONE_HEADERS.some(function (h) { return normHeader(h) === cells[j]; })) pi = j;
            }
            if (ci >= 0 && pi >= 0) { headerIdx = i; codeCol = ci; phoneCol = pi; break; }
        }
        // تشخيص (بطلب المالك 2026-08-10): طباعة ما قرأه XLSX فعليًا قبل أي معالجة
        if (headerIdx >= 0) {
            console.log('[استيراد الجوالات] الورقة «' + sheetName + '» — صف العناوين رقم ' + (headerIdx + 1) + ' — القيم المقروءة فعليًا:', matrix[headerIdx]);
            console.log('[استيراد الجوالات] الورقة «' + sheetName + '» — عمود الكود: «' + matrix[headerIdx][codeCol] + '» (رقم ' + (codeCol + 1) + ') — عمود الجوال: «' + matrix[headerIdx][phoneCol] + '» (رقم ' + (phoneCol + 1) + ')');
        } else {
            console.warn('[استيراد الجوالات] الورقة «' + sheetName + '» — لم يُعثر على صف عناوين يطابق القوائم المعروفة — أول 3 صفوف مقروءة فعليًا:', matrix.slice(0, 3));
        }
        var start = headerIdx >= 0 ? headerIdx + 1 : 0;
        var rows = [];
        for (var r = start; r < matrix.length; r++) {
            var row = matrix[r] || [];
            var code = row[codeCol];
            var phone = row[phoneCol];
            if (code === null || code === undefined || String(code).trim() === '') continue;
            var codeStr = String(code).trim();
            if (codeStr.endsWith('.0')) codeStr = codeStr.slice(0, -2); // قراءة رقمية من Excel
            // تخطَّ الصفوف الهيكلية في الكشوف الرسمية: أسماء الفرق وترويسات مكررة —
            // الكود الوظيفي رقمي دائمًا
            if (!/^[0-9]{3,10}$/.test(codeStr)) continue;
            rows.push({ code: codeStr, phone: phone == null ? '' : String(phone).trim() });
        }
        console.log('[استيراد الجوالات] الورقة «' + sheetName + '» — صفوف مستخرجة: ' + rows.length);
        return rows;
    }

    function summaryBox(n, t, color) {
        return '<div class="ssce-sum-box"><span class="n"' + (color ? ' style="color:' + color + ';"' : '') + '>' + n + '</span><span class="t">' + t + '</span></div>';
    }

    function warnList(title, items, renderItem, color) {
        if (!items || !items.length) return '';
        var html = '<div class="ssce-warn-list"><div class="w-title"' + (color ? ' style="color:' + color + ';"' : '') + '>' + esc(title) + ' (' + items.length + ')</div>';
        items.slice(0, 100).forEach(function (it) { html += '<div>' + renderItem(it) + '</div>'; });
        if (items.length > 100) html += '<div style="color:var(--text-muted,#94a3b8);">… و' + (items.length - 100) + ' أخرى</div>';
        return html + '</div>';
    }

    window.openPhonesImportModal = function () {
        if (!canEdit()) {
            toast('الاستيراد متاح لمدير النظام ومدير العمليات فقط', 'info');
            return;
        }
        ensureUI();
        _phonesRows = null;
        document.getElementById('phonesImportActions').style.display = 'none';
        document.getElementById('phonesImportBody').innerHTML =
            '<div class="ssce-import-file">' +
                '<i class="fas fa-file-excel" style="font-size:1.4rem;color:#22c55e;"></i>' +
                '<div style="margin:6px 0;">اختر ملف Excel (.xlsx) أو CSV يحتوي عمودين: <strong>الكود الوظيفي</strong> و<strong>الجوال</strong></div>' +
                '<input type="file" id="phonesImportFile" accept=".xlsx,.xls,.csv">' +
                '<div style="font-size:.68rem;margin-top:6px;">المطابقة بالكود الوظيفي فقط — لن يُستبدل أي رقم موجود برقم فارغ</div>' +
            '</div>' +
            '<div id="phonesImportResult"></div>';
        document.getElementById('phonesImportModal').style.display = 'flex';
        document.getElementById('phonesImportFile').addEventListener('change', onPhonesFileChosen);
    };

    function onPhonesFileChosen(e) {
        var file = e.target.files && e.target.files[0];
        if (!file) return;
        var result = document.getElementById('phonesImportResult');
        result.innerHTML = '<div class="ssce-loading"><i class="fas fa-spinner fa-spin"></i> جاري قراءة الملف…</div>';
        var reader = new FileReader();
        reader.onload = function (ev) {
            try {
                var wb = XLSX.read(ev.target.result, { type: 'array' });
                // دمج كل الأوراق بالترتيب — الأحدث يحدّث الأقدم، والفارغ لا يطغى على الموجود
                var merged = new Map();
                console.log('[استيراد الجوالات] الملف: «' + (file.name || '') + '» — الأوراق المقروءة فعليًا:', wb.SheetNames);
                wb.SheetNames.forEach(function (sn) {
                    var ws = wb.Sheets[sn];
                    var matrix = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
                    parsePhonesRows(matrix, sn).forEach(function (row) {
                        var prev = merged.get(row.code);
                        if (!prev || row.phone) merged.set(row.code, { code: row.code, phone: row.phone || (prev && prev.phone) || '' });
                    });
                });
                _phonesRows = Array.from(merged.values());
                if (!_phonesRows.length) {
                    result.innerHTML = '<div class="ssce-empty">لم يتم العثور على صفوف صالحة — تأكد من وجود عمودَي «الكود الوظيفي» و«الجوال»</div>';
                    return;
                }
                previewPhonesImport();
            } catch (err) {
                console.error('Phones file parse error:', err);
                result.innerHTML = '<div class="ssce-empty">تعذّرت قراءة الملف — تأكد أنه Excel أو CSV سليم</div>';
            }
        };
        reader.readAsArrayBuffer(file);
    }

    async function previewPhonesImport() {
        var result = document.getElementById('phonesImportResult');
        result.innerHTML = '<div class="ssce-loading"><i class="fas fa-spinner fa-spin"></i> جاري المطابقة مع قاعدة البيانات…</div>';
        try {
            var r = await apiFetch('/api/employees/phones/import', {
                method: 'POST',
                body: JSON.stringify({ rows: _phonesRows, confirm: false })
            });
            var d = await r.json().catch(function () { return {}; });
            if (!r.ok || !d.success) {
                result.innerHTML = '<div class="ssce-empty">' + esc(d.error || 'تعذّرت المعاينة') + '</div>';
                return;
            }
            var s = d.summary;
            var html = '<div class="ssce-import-summary">' +
                summaryBox(s.total, 'صفوف الملف') +
                summaryBox(s.matched, 'سيتم تحديثها', '#22c55e') +
                summaryBox(s.unchanged, 'بلا تغيير') +
                summaryBox(s.unmatched, 'بلا مطابقة', '#f59e0b') +
                summaryBox(s.duplicates, 'أكواد مكررة', '#f59e0b') +
                summaryBox(s.invalid, 'أرقام غير صالحة', '#ef4444') +
                summaryBox(s.skippedEmpty, 'أرقام فارغة (تُخطى)') +
                '</div>';
            html += warnList('لم تتم مطابقتهم (كود غير موجود)', d.unmatched, function (u) { return '• ' + esc(u.code) + ' — ' + esc(u.phone); }, '#f59e0b');
            html += warnList('أكواد مكررة في الملف (أُخذ الأول فقط)', d.duplicates, function (u) { return '• ' + esc(u.code) + ' — أُهمل: ' + esc(u.droppedPhone || 'فارغ'); }, '#f59e0b');
            html += warnList('أرقام غير صالحة', d.invalid, function (u) { return '• ' + esc(u.code) + ' — ' + esc(u.phone) + ' (' + esc(u.reason) + ')'; }, '#ef4444');
            html += warnList('معاينة التحديثات', (d.toUpdate || []).slice(0, 20), function (u) { return '• ' + esc(u.name) + ' (' + esc(u.code) + '): ' + esc(u.oldPhone || '—') + ' ← <strong>' + esc(u.newPhone) + '</strong>'; }, '#22c55e');
            result.innerHTML = html;

            var actions = document.getElementById('phonesImportActions');
            var confirmBtn = document.getElementById('phonesImportConfirm');
            if (s.matched > 0) {
                actions.style.display = 'flex';
                confirmBtn.textContent = 'تأكيد استيراد ' + s.matched + ' رقمًا';
                confirmBtn.onclick = commitPhonesImport;
            } else {
                actions.style.display = 'none';
            }
        } catch (err) {
            console.error('Phones preview error:', err);
            result.innerHTML = '<div class="ssce-empty">خطأ في الاتصال بالخادم</div>';
        }
    }

    async function commitPhonesImport() {
        var btn = document.getElementById('phonesImportConfirm');
        var result = document.getElementById('phonesImportResult');
        btn.disabled = true;
        try {
            var r = await apiFetch('/api/employees/phones/import', {
                method: 'POST',
                body: JSON.stringify({ rows: _phonesRows, confirm: true })
            });
            var d = await r.json().catch(function () { return {}; });
            if (!r.ok || !d.success) {
                toast('❌ ' + (d.error || 'فشل الاستيراد'), 'error');
                btn.disabled = false;
                return;
            }
            result.innerHTML = '<div class="ssce-empty" style="color:#22c55e;font-weight:800;">' +
                '<i class="fas fa-check-circle"></i> تم استيراد ' + d.applied + ' رقم جوال بنجاح</div>';
            document.getElementById('phonesImportActions').style.display = 'none';
            toast('✅ تم استيراد ' + d.applied + ' رقم جوال', 'success');
        } catch (err) {
            console.error('Phones commit error:', err);
            toast('❌ خطأ في الاتصال بالخادم', 'error');
            btn.disabled = false;
        }
    }

    // إظهار زر استيراد الجوالات للأدمن/مدير العمليات فقط
    function revealPhonesImport() {
        if (!canEdit()) return;
        var row = document.getElementById('phonesImportRow');
        if (row) row.style.display = 'flex';
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', revealPhonesImport);
    } else {
        revealPhonesImport();
    }

})();
