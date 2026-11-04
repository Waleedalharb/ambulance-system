/* P3 — مركز دورة الجدول: عرض وطلبات فقط؛ الحسم والحسابات في الخادم. */
(function () {
    'use strict';
    if (!window.AuthCore || !AuthCore.requireAuth('/')) return;

    const $ = id => document.getElementById(id);
    const state = { me: null, data: null, selectedVersion: null, selectedReference: null, lifecycle: null, employee: null, busy: false };
    const STATUS = { imported: 'مستورد', draft: 'مسودة', ready_for_review: 'جاهز للمراجعة', approved: 'معتمد', published: 'منشور منطقيًا' };
    const KIND = { bootstrap_reference: 'مرجع أولي', generated_draft: 'مسودة مولدة', correction: 'تصحيح' };
    const APPLICABILITY = { required: 'تغطية مطلوبة', not_applicable: 'غير منطبق', unresolved: 'غير محسوم' };
    const EXCEPTION = { temporary_assignment: 'تكليف مؤقت', temporary_change: 'تغيير مؤقت', operational_note: 'ملاحظة تشغيلية' };
    const GAPS = { unresolved: 'غير محسوم', rest_confirmed: 'راحة مؤكدة', missing_data: 'بيانات ناقصة', out_of_scope: 'خارج النطاق', other_approved: 'أخرى معتمدة' };
    const PERMISSION_BY_ID = {
        generateDraft: 'schedule.generate', regenerateDraft: 'schedule.generate',
        openReferenceDraft: 'schedule.draft.edit', deriveContinuity: 'schedule.draft.edit', approveReference: 'schedule.approve',
        reviewDraft: 'schedule.draft.edit', approveDraft: 'schedule.approve', publishDraft: 'schedule.publish', createCorrection: 'schedule.published.edit',
        smartImportConfirm: 'schedule.import', smartImportFinalize: 'schedule.import'
    };
    const FORM_PERMISSION = { importReferenceForm: 'schedule.import', smartImportUploadForm: 'schedule.import', smartImportMapForm: 'schedule.import', gapsForm: 'schedule.gaps.review', continuityForm: 'schedule.draft.edit', exceptionForm: 'schedule.exceptions.manage', coverageForm: 'schedule.settings.manage' };

    function esc(value) {
        return String(value === null || value === undefined ? '' : value).replace(/[&<>'"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[ch]);
    }
    function fmt(value) { return value === null || value === undefined || value === '' ? '—' : esc(value); }
    function status(value) { return `<span class="state-${esc(value)}">${fmt(STATUS[value] || value)}</span>`; }
    function detail(rows) {
        if (!rows || !rows.length) return '<div class="empty">لا توجد بيانات</div>';
        return rows.map(([label, value]) => `<div class="detail-row"><span>${esc(label)}</span><span>${value === undefined ? '—' : value}</span></div>`).join('');
    }
    function table(headers, rows, empty = 'لا توجد بيانات') {
        if (!rows || !rows.length) return `<div class="empty">${esc(empty)}</div>`;
        return `<table><thead><tr>${headers.map(x => `<th>${esc(x)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${cell === undefined || cell === null || cell === '' ? '—' : cell}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    }
    function records(rows, empty = 'لا توجد سجلات') {
        if (!rows || !rows.length) return `<div class="empty">${esc(empty)}</div>`;
        return rows.map(row => `<div class="record ${row.type && /blocker|conflict|violation|shortage/.test(row.type) ? 'error' : ''}"><strong>${fmt(row.type || row.reason || row.code || 'سجل')}</strong><div>${esc(JSON.stringify(row))}</div></div>`).join('');
    }
    function option(value, label, selected = false) { return `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`; }
    function permission(key) {
        if (!state.me) return false;
        if (key === 'schedule.generate') return state.me.user.role === 'admin' && (state.me.permissions_star === true || (state.me.permissions || []).includes(key) || (state.me.permissions || []).includes('*'));
        return state.me.permissions_star === true || (state.me.permissions || []).includes(key) || (state.me.permissions || []).includes('*');
    }
    function toast(message, type = 'info') { if (window.ToastCore) ToastCore.show(message, type); }
    function message(text, type = 'error', target = 'globalMessage') {
        const el = $(target); el.className = `message ${type}`; el.textContent = text; el.classList.remove('hidden');
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    function clearMessage(target = 'globalMessage') { $(target).classList.add('hidden'); }
    function errorText(error) {
        return `${error.message || 'فشل الطلب'}${error.code ? ` (${error.code})` : ''}${error.permission ? ` — الصلاحية المطلوبة: ${error.permission}` : ''}`;
    }
    async function api(path, options = {}) {
        const config = { method: options.method || 'GET', headers: { 'Content-Type': 'application/json' } };
        if (options.body !== undefined) config.body = JSON.stringify(options.body);
        const response = await AuthCore.apiRequest(path, config);
        let data = null;
        try { data = await response.json(); } catch (_) { data = null; }
        if (!response.ok) {
            const error = new Error(data && data.error ? data.error : `فشل الطلب HTTP ${response.status}`);
            error.status = response.status; error.code = data && data.code; error.permission = data && data.permission;
            throw error;
        }
        return data;
    }
    function busy(value, label = '') {
        state.busy = value; $('loadingState').textContent = label;
        $('loadWorkspace').disabled = value;
        document.querySelectorAll('button[type="submit"]').forEach(button => { button.disabled = value || !formAllowed(button.closest('form')); });
    }
    function formAllowed(form) { return form && FORM_PERMISSION[form.id] ? permission(FORM_PERMISSION[form.id]) : true; }
    function applyPermissions() {
        Object.entries(PERMISSION_BY_ID).forEach(([id, key]) => { $(id).classList.toggle('hidden', !permission(key)); });
        Object.keys(FORM_PERMISSION).forEach(id => {
            const allowed = permission(FORM_PERMISSION[id]);
            $(id).querySelectorAll('button[type="submit"]').forEach(button => button.classList.toggle('hidden', !allowed));
            $(id).querySelectorAll('input,select,textarea').forEach(input => {
                let disabled = !allowed;
                if (id === 'coverageForm' && (input.classList.contains('coverage-day') || input.classList.contains('coverage-night'))) {
                    const applicability = input.closest('tr') && input.closest('tr').querySelector('.coverage-applicability');
                    disabled = disabled || !applicability || applicability.value !== 'required';
                }
                input.disabled = disabled;
            });
        });
    }
    function generatedVersions() { return state.data ? state.data.versions.filter(row => row.version_kind !== 'bootstrap_reference') : []; }
    function selectedSummary() { return state.data && state.data.versions.find(row => row.id === state.selectedVersion) || null; }
    function reference() { return state.selectedReference || (state.data && state.data.reference.reference); }
    function teamName(id) { const row = state.data.teams.find(team => Number(team.id) === Number(id)); return row ? row.name : fmt(id); }
    function employeeName(id) { const row = state.data.employees.find(employee => Number(employee.id) === Number(id)); return row ? row.name : fmt(id); }

    function switchTab(name) {
        document.querySelectorAll('.tab').forEach(tab => { const active = tab.dataset.tab === name; tab.classList.toggle('active', active); tab.setAttribute('aria-selected', String(active)); });
        document.querySelectorAll('.panel').forEach(panel => { const active = panel.id === `panel-${name}`; panel.classList.toggle('active', active); panel.hidden = !active; });
        if (name === 'audit') loadAudit().catch(error => message(errorText(error)));
        if (name === 'employees') loadEmployee().catch(error => message(errorText(error)));
    }

    function renderSummary() {
        const data = state.data, current = data.current_version, ref = data.reference.reference, run = data.latest_run;
        $('metricStatus').innerHTML = current ? status(current.status) : 'لا توجد مسودة';
        $('metricVersion').textContent = current ? `${KIND[current.version_kind]} · الإصدار ${current.version_number}` : `${data.versions.length} إصدار مسجل`;
        $('metricReference').textContent = data.reference.usable && ref ? `الإصدار ${ref.version_number}` : 'غير متاح';
        $('metricReferenceDetail').textContent = data.reference.usable && ref ? `${ref.month} · ${STATUS[ref.status]}` : (data.reference.reason || 'لا يوجد مرجع معتمد');
        $('metricRun').textContent = run ? run.mode : 'لا يوجد';
        $('metricRunDetail').textContent = run ? `${run.created_at} · ${run.status}` : 'لم يبدأ توليد لهذا الشهر';
        $('metricUnresolved').textContent = data.coverage.summary.unresolved;
    }

    function renderOverview() {
        const current = selectedSummary() || state.data.current_version, run = state.data.latest_run;
        $('overviewVersion').classList.remove('empty');
        $('overviewVersion').innerHTML = current ? detail([
            ['الإصدار', current.version_number], ['النوع', KIND[current.version_kind]], ['الحالة', status(current.status)],
            ['الأب', current.parent_version_id ? `<code>${esc(current.parent_version_id)}</code>` : '—'],
            ['البصمة', `<code>${esc(current.content_hash)}</code>`], ['أنشئ بواسطة', fmt(current.created_by)], ['التوقيت', fmt(current.created_at)]
        ]) : '<div class="empty">لا توجد مسودة مولدة لهذا الشهر</div>';
        $('overviewRun').classList.remove('empty');
        $('overviewRun').innerHTML = run ? detail([
            ['المعرّف', `<code>${esc(run.id)}</code>`], ['النمط', run.mode], ['الحالة', status(run.status)],
            ['المرجع', `<code>${esc(run.reference_version_id)}</code>`], ['بصمة المدخلات', `<code>${esc(run.input_hash)}</code>`], ['بصمة المخرجات', `<code>${esc(run.output_hash)}</code>`]
        ]) : '<div class="empty">لا توجد عملية توليد</div>';
        $('openCurrentReview').disabled = !current;
        $('regenerateDraft').disabled = !current || !['draft', 'ready_for_review'].includes(current.status);
    }

    function renderReference() {
        const result = state.data.reference, ref = result.reference;
        $('referenceStatus').textContent = result.usable ? `المرجع المباشر المطلوب: ${result.required_month}` : `المرجع غير صالح للتوليد: ${result.reason || 'غير متاح'}`;
        $('referenceDetails').classList.remove('empty');
        $('referenceDetails').innerHTML = ref ? detail([
            ['المعرّف', `<code>${esc(ref.id)}</code>`], ['الشهر', ref.month], ['الإصدار', ref.version_number], ['الحالة', status(ref.status)],
            ['عدد اللقطات', ref.snapshots.length], ['جاهزية المرجع', ref.readiness.ready ? 'جاهز' : 'توجد موانع'],
            ['البصمة', `<code>${esc(ref.content_hash)}</code>`]
        ]) : '<div class="empty">لا يوجد مرجع معتمد للشهر السابق مباشرة</div>';
        $('snapshotList').innerHTML = ref ? table(['#', 'الحالة', 'حالية', 'مصدر المحتوى', 'أنشئت بواسطة', 'التوقيت'], ref.snapshots.map(row => [row.snapshot_number, fmt(row.status), row.is_current ? 'نعم' : 'لا', `<code>${esc(row.source_content_hash)}</code>`, fmt(row.created_by), fmt(row.created_at)])) : '<div class="empty">لا توجد لقطات</div>';
        $('openReferenceDraft').disabled = !ref || ref.status !== 'imported';
        $('deriveContinuity').disabled = !ref || !['draft', 'ready_for_review'].includes(ref.status);
        $('approveReference').disabled = !ref || ref.status !== 'ready_for_review';

        const gaps = [];
        if (ref) {
            const reviewMap = new Map(ref.gap_reviews.map(row => [`${row.employee_id}|${row.gap_date}`, row]));
            for (const employee of ref.content.employees || []) {
                for (const day of employee.days || []) {
                    if (day.shift_code) continue;
                    const saved = reviewMap.get(`${employee.employee_id}|${day.date}`);
                    gaps.push({ employee_id: employee.employee_id, gap_date: day.date, resolution: saved ? saved.resolution : 'unresolved', reason: saved ? saved.reason || '' : '' });
                }
            }
        }
        $('gapReviews').innerHTML = gaps.length ? `<table><thead><tr><th>الموظف</th><th>التاريخ</th><th>الدلالة</th><th>السبب</th></tr></thead><tbody>${gaps.map(row => `<tr data-employee="${row.employee_id}" data-date="${row.gap_date}"><td>${esc(employeeName(row.employee_id))}</td><td>${row.gap_date}</td><td><select class="gap-resolution">${Object.entries(GAPS).map(([key, label]) => option(key, label, row.resolution === key)).join('')}</select></td><td><input class="gap-reason" value="${esc(row.reason)}" maxlength="1000"></td></tr>`).join('')}</tbody></table>` : '<div class="empty">لا توجد أيام فارغة في المرجع</div>';
        $('gapsForm').querySelector('button').disabled = !ref || !['draft', 'ready_for_review'].includes(ref.status) || !permission('schedule.gaps.review');

        const entries = ref && ref.current_snapshot ? ref.current_snapshot.entries : [];
        const teamOptions = state.data.teams.filter(row => row.is_active === 1).map(row => option(row.id, `${row.name} — ${row.center || 'بدون مركز'}`)).join('');
        $('continuityPattern').innerHTML = state.data.patterns.filter(row => row.is_active === 1 && Array.isArray(row.cycle) && row.cycle.length).map(row => option(row.code, `${row.code} — ${row.name || ''} (${row.cycle.join(' → ')})`)).join('');
        $('continuityTeam').innerHTML = option('', 'بدون فريق — يبقى الإسناد غير محسوم') + teamOptions;
        $('continuityEmployee').innerHTML = entries.length ? entries.map(row => option(row.employee_id, `${employeeName(row.employee_id)} — ${row.status}`)).join('') : option('', 'لا توجد لقطة');
        $('continuityEntries').innerHTML = table(['الموظف', 'الحالة', 'النمط', 'الطور', 'الرمز التالي', 'الفريق', 'الإسناد', 'السريان', 'المصدر', 'السبب'], entries.map(row => [esc(employeeName(row.employee_id)), fmt(row.status), fmt(row.pattern_code), fmt(row.next_phase_index), fmt(row.next_shift_code), row.team_id ? esc(teamName(row.team_id)) : '—', fmt(row.assignment_status), fmt(row.effective_date), fmt(row.resolution_source), fmt(row.reason)]));
        $('continuityForm').querySelector('button').disabled = !entries.length || !ref || !['draft', 'ready_for_review'].includes(ref.status) || !permission('schedule.draft.edit');
        if (ref) $('continuityEffectiveDate').value = `${state.data.month}-01`;
    }

    function renderVersions() {
        const rows = state.data.versions;
        $('versionsTable').innerHTML = table(['الشهر', '#', 'النوع', 'الحالة', 'الأب', 'البصمة', 'الإنشاء', 'الاعتماد', 'النشر', 'إجراء'], rows.map(row => [
            row.month, row.version_number, KIND[row.version_kind], status(row.status), row.parent_version_id ? `<code>${esc(row.parent_version_id)}</code>` : '—', `<code>${esc(row.content_hash)}</code>`, `${fmt(row.created_by)}<br>${fmt(row.created_at)}`, `${fmt(row.approved_by)}<br>${fmt(row.approved_at)}`, `${fmt(row.published_by)}<br>${fmt(row.published_at)}`, `<button class="button secondary select-version" data-id="${esc(row.id)}" type="button">فتح</button>`
        ]));
        const generated = generatedVersions();
        const options = generated.map(row => option(row.id, `#${row.version_number} — ${KIND[row.version_kind]} — ${STATUS[row.status]}`)).join('');
        $('compareBase').innerHTML = options || option('', 'لا توجد مسودات'); $('compareTarget').innerHTML = options || option('', 'لا توجد مسودات');
        if (generated.length > 1) $('compareTarget').selectedIndex = 1;
        $('compareForm').querySelector('button').disabled = generated.length < 2;
    }

    function renderReview() {
        const lifecycle = state.lifecycle, summary = selectedSummary();
        if (!lifecycle) {
            $('reviewVersionLabel').textContent = 'اختر مسودة مولدة من الإصدارات.';
            ['hashDetails', 'blockersList', 'unresolvedList', 'coverageDetails', 'e4Details', 'reviewHistory'].forEach(id => { $(id).innerHTML = '<div class="empty">لا توجد نسخة محددة</div>'; });
            ['reviewStatus', 'reviewBlockers', 'reviewShortages', 'reviewE4'].forEach(id => { $(id).textContent = '—'; });
            ['reviewDraft', 'approveDraft', 'publishDraft', 'createCorrection'].forEach(id => { $(id).disabled = true; });
            return;
        }
        const version = lifecycle.version, run = lifecycle.run, review = lifecycle.latest_review;
        const persisted = run.summary || {};
        const blockers = review ? review.blockers : persisted.blockers || [];
        const conflicts = review ? review.conflicts : [];
        const unresolved = review ? review.unresolved_teams : persisted.unresolved_teams || [];
        const shortages = review ? review.shortages : persisted.shortages || [];
        const coverage = review ? review.coverage : persisted.coverage || [];
        const e4 = review ? review.e4 : (persisted.blockers || []).filter(row => row.type === 'e4_violation');
        const warnings = review ? review.warnings : [];
        $('reviewVersionLabel').textContent = `الإصدار ${version.version_number} · ${KIND[version.version_kind]} · ${version.month}`;
        $('reviewStatus').innerHTML = status(version.status);
        $('reviewBlockers').textContent = blockers.length + conflicts.length;
        $('reviewShortages').textContent = shortages.length;
        $('reviewE4').textContent = e4.length;
        $('hashDetails').innerHTML = `<div>content_hash: ${esc(version.content_hash)}</div><div>input_hash: ${esc(run.input_hash)}</div><div>current_input_hash: ${esc(review ? review.current_input_hash : 'لم تُراجع بعد')}</div><div>coverage_policy_version: ${esc(version.coverage_policy_version)}</div>`;
        $('blockersList').innerHTML = records([...blockers, ...conflicts], 'لا توجد موانع أو تعارضات مسجلة');
        $('unresolvedList').innerHTML = records(unresolved, 'لا توجد فرق غير محسومة في هذه المراجعة');
        $('coverageDetails').innerHTML = table(['الفريق', 'التاريخ', 'الحالة', 'نهار فعلي/مطلوب', 'ليل فعلي/مطلوب', 'الإجمالي', 'النقص', 'سبب عدم الحسم'], coverage.map(row => [esc(row.team_name || teamName(row.team_id)), row.date, APPLICABILITY[row.applicability] || row.applicability, `${row.day} / ${row.rule ? row.rule.day : '—'}`, `${row.night} / ${row.rule ? row.rule.night : '—'}`, row.total, fmt((row.missing || []).join(', ')), fmt(row.unresolved_reason)]));
        $('e4Details').innerHTML = records([...e4, ...warnings], 'لا توجد مخالفات E-4 أو تحذيرات');
        $('reviewHistory').innerHTML = table(['الحالة', 'المحتوى', 'المدخلات الأصلية/الحالية', 'المراجع', 'التوقيت', 'الموانع'], lifecycle.reviews.map(row => [row.ready ? 'جاهز' : 'مرفوض بموانع', `<code>${esc(row.content_hash)}</code>`, `<code>${esc(row.input_hash)}</code><br><code>${esc(row.current_input_hash)}</code>`, fmt(row.reviewed_by), fmt(row.created_at), row.blockers.length + row.conflicts.length]));
        $('reviewDraft').disabled = !['draft', 'ready_for_review'].includes(version.status);
        $('approveDraft').disabled = version.status !== 'ready_for_review' || !review || !review.ready;
        $('publishDraft').disabled = version.status !== 'approved';
        $('createCorrection').disabled = !['approved', 'published'].includes(version.status);
        if (summary) $('regenerateDraft').disabled = !['draft', 'ready_for_review'].includes(summary.status);
    }

    function renderEmployeeOptions() {
        const version = state.lifecycle ? state.lifecycle.version : reference();
        let ids = [];
        if (version && version.content) ids = (version.content.employees || []).map(row => Number(row.employee_id));
        else if (state.lifecycle) ids = state.lifecycle.run.entries.map(row => Number(row.employee_id));
        ids = [...new Set(ids)];
        const previous = $('employeeSelector').value;
        $('employeeSelector').innerHTML = ids.length ? ids.map(id => option(id, `${employeeName(id)} — ${id}`)).join('') : option('', 'لا يوجد موظفون في النسخة');
        if (ids.includes(Number(previous))) $('employeeSelector').value = previous;
        $('employeeSelector').disabled = !ids.length;
    }

    function renderEmployee() {
        const value = state.employee;
        if (!value) {
            ['employeeProfile', 'employeeContinuity', 'employeeLeaves', 'employeeDays', 'employeeDiffs'].forEach(id => { $(id).innerHTML = '<div class="empty">اختر موظفًا ونسخة</div>'; });
            return;
        }
        $('employeeProfile').innerHTML = detail([['الاسم', esc(value.employee.name)], ['الكود', fmt(value.employee.employee_code)], ['المسمى', fmt(value.employee.job_title)], ['النمط المسجل', fmt(value.employee.pattern_code)], ['النسخة', `${value.version.version_number} — ${STATUS[value.version.status]}`]]);
        $('employeeContinuity').innerHTML = value.continuity ? detail([['الحالة', fmt(value.continuity.status)], ['النمط', fmt(value.continuity.pattern_code)], ['الطور التالي', fmt(value.continuity.next_phase_index)], ['الرمز التالي', fmt(value.continuity.next_shift_code)], ['الفريق', value.continuity.team_id ? esc(teamName(value.continuity.team_id)) : '—'], ['تاريخ السريان', fmt(value.continuity.effective_date)], ['المصدر', fmt(value.continuity.resolution_source)], ['السبب', fmt(value.continuity.reason)]]) : '<div class="empty">لا توجد استمرارية مرتبطة</div>';
        const leaveRecords = value.leaves.map(row => ({ type: `إجازة ${row.type} — ${row.status}`, start: row.start_date, end: row.end_date, reason: row.reason }));
        const exceptionRecords = value.exceptions.map(row => ({ type: EXCEPTION[row.exception_type], start: row.start_date, end: row.end_date, reason: row.reason, source: row.approval_source }));
        $('employeeLeaves').innerHTML = records([...leaveRecords, ...exceptionRecords], 'لا توجد إجازات أو استثناءات مرتبطة بالشهر');
        $('employeeDays').innerHTML = table(['التاريخ', 'الفريق', 'الرمز', 'المصدر', 'السبب', 'متأثرة'], value.days.map(row => [row.date || row.shift_date, row.team_id ? esc(teamName(row.team_id)) : '—', fmt(row.shift_code), fmt(row.source), fmt(row.reason), row.affected ? 'نعم' : 'لا']));
        $('employeeDiffs').innerHTML = table(['التاريخ', 'قبل', 'بعد', 'النوع', 'السبب'], value.diffs.map(row => [row.shift_date, `${fmt(row.before_shift_code)} / ${row.before_team_id ? esc(teamName(row.before_team_id)) : '—'}`, `${fmt(row.after_shift_code)} / ${row.after_team_id ? esc(teamName(row.after_team_id)) : '—'}`, row.change_type, fmt(row.reason)]));
    }

    function renderExceptions() {
        const previous = { employee: $('exceptionEmployee').value, scope: $('exceptionScopeTeam').value, effect: $('exceptionEffectTeam').value, code: $('exceptionEffectCode').value };
        const employeeOptions = state.data.employees.filter(row => row.is_active === 1).map(row => option(row.id, `${row.name} — ${row.employee_code || row.id}`)).join('');
        const teamOptions = state.data.teams.filter(row => row.is_active === 1).map(row => option(row.id, `${row.name} — ${row.center || 'بدون مركز'}`)).join('');
        $('exceptionEmployee').innerHTML = option('', '— بدون موظف —') + employeeOptions;
        $('exceptionScopeTeam').innerHTML = option('', '— بدون فريق —') + teamOptions;
        $('exceptionEffectTeam').innerHTML = option('', '— بدون تغيير فريق —') + teamOptions;
        $('exceptionEffectCode').innerHTML = option('', '— بدون تغيير رمز —') + state.data.shift_codes.map(row => option(row.code, `${row.code} — ${row.name || row.description || ''}`)).join('');
        $('exceptionEmployee').value = previous.employee; $('exceptionScopeTeam').value = previous.scope; $('exceptionEffectTeam').value = previous.effect; $('exceptionEffectCode').value = previous.code;
        const rows = state.data.exceptions;
        $('exceptionsTable').innerHTML = table(['النوع', 'النطاق', 'الفترة', 'الأثر', 'السبب', 'السند', 'الحالة', 'أنشئ بواسطة', 'إجراء'], rows.map(row => [
            EXCEPTION[row.exception_type], row.employee_id ? esc(employeeName(row.employee_id)) : esc(teamName(row.scope_team_id)), `${row.start_date} → ${row.end_date}`,
            `${row.effect_team_id ? esc(teamName(row.effect_team_id)) : '—'} / ${fmt(row.effect_shift_code)}`, fmt(row.reason), `${fmt(row.approval_source)}<br>${fmt(row.approval_authority)} — ${fmt(row.approved_by)}<br>${fmt(row.approved_at)}`, row.status === 'active' ? 'نشط' : `ملغى: ${fmt(row.cancellation_reason)}`, `${fmt(row.created_by)}<br>${fmt(row.created_at)}`,
            row.status === 'active' && permission('schedule.exceptions.manage') ? `<button class="button danger cancel-exception" data-id="${esc(row.id)}" type="button">إلغاء موثق</button>` : '—'
        ]));
    }

    function renderCoverage() {
        const coverage = state.data.coverage;
        $('coverageSummary').textContent = `مطلوب ${coverage.summary.required} · غير منطبق ${coverage.summary.not_applicable} · غير محسوم ${coverage.summary.unresolved}`;
        const active = coverage.teams.filter(row => row.is_active === 1);
        $('coverageMatrix').innerHTML = table(['الفريق', 'المركز', 'الحالة الحالية', 'قرار المصفوفة', 'نهار', 'ليل', 'الإجمالي المشتق', 'السريان', 'السند الحالي', 'سبب المانع'], active.map(row => {
            const rule = row.applicability === 'required' ? row.rule : null;
            return [
                `${esc(row.team_name)}<br><small>#${row.team_id}</small>`, fmt(row.center), `<span class="state-${row.applicability}">${APPLICABILITY[row.applicability]}</span>`,
                `<select class="coverage-applicability" data-team="${row.team_id}">${Object.entries(APPLICABILITY).map(([key, label]) => option(key, label, row.applicability === key)).join('')}</select>`,
                `<input class="coverage-day" data-team="${row.team_id}" type="number" min="0" step="1" value="${rule ? rule.day : ''}"${row.applicability === 'required' ? '' : ' disabled'}>`,
                `<input class="coverage-night" data-team="${row.team_id}" type="number" min="0" step="1" value="${rule ? rule.night : ''}"${row.applicability === 'required' ? '' : ' disabled'}>`,
                `<span class="coverage-total" data-team="${row.team_id}">${rule ? rule.total : '—'}</span>`,
                `${fmt(row.effective_from)} → ${fmt(row.effective_to)}`, row.evidence ? `${fmt(row.evidence.source)}<br>${fmt(row.evidence.approval_authority)} — ${fmt(row.evidence.approved_by)}` : 'لا يوجد إثبات صالح', fmt(row.unresolved_reason)
            ];
        }));
        $('coverageForm').querySelector('button').disabled = !permission('schedule.settings.manage');
    }

    function renderAll() {
        if (!state.data) { applyPermissions(); return; }
        renderSummary(); renderOverview(); renderReference(); renderVersions(); renderReview(); renderEmployeeOptions(); renderEmployee(); renderExceptions(); renderCoverage(); applyPermissions();
    }

    async function loadLifecycle(id) {
        state.lifecycle = null; state.selectedReference = null;
        if (!id) return;
        const row = state.data.versions.find(version => version.id === id);
        if (!row) return;
        if (row.version_kind === 'bootstrap_reference') {
            const result = await api(`/api/schedule/versions/${encodeURIComponent(id)}`);
            state.selectedReference = result.version;
            return;
        }
        state.lifecycle = await api(`/api/schedule/generated-versions/${encodeURIComponent(id)}/lifecycle`);
    }
    async function selectVersion(id, show = true) {
        state.selectedVersion = id || null; state.employee = null;
        await loadLifecycle(state.selectedVersion);
        renderOverview(); renderReference(); renderReview(); renderEmployeeOptions(); renderEmployee();
        if (show) switchTab(state.lifecycle ? 'review' : 'reference');
    }
    async function loadWorkspace(keepSelection = true) {
        if (state.busy) return;
        clearMessage(); busy(true, 'جارٍ تحميل دورة الشهر…');
        const previous = keepSelection ? state.selectedVersion : null;
        try {
            const month = $('targetMonth').value;
            if (!month) throw new Error('اختر الشهر الهدف');
            state.data = await api(`/api/schedule/workspace?month=${encodeURIComponent(month)}`);
            const desired = previous && state.data.versions.some(row => row.id === previous) ? previous : (state.data.current_version && state.data.current_version.id) || null;
            state.selectedVersion = desired; state.employee = null;
            await loadLifecycle(desired);
            $('referenceMonth').value = state.data.reference.required_month;
            renderAll();
        } catch (error) { message(errorText(error)); }
        finally { busy(false); renderAll(); }
    }
    async function reloadAfter(success) { toast(success, 'success'); await loadWorkspace(true); }
    async function action(fn) {
        if (state.busy) return;
        clearMessage(); busy(true, 'جارٍ تنفيذ الإجراء…');
        try { await fn(); } catch (error) { message(errorText(error)); toast(errorText(error), 'error'); }
        finally { busy(false); applyPermissions(); }
    }
    async function loadEmployee() {
        state.employee = null;
        const versionId = state.selectedVersion, employeeId = $('employeeSelector').value;
        if (!versionId || !employeeId) { renderEmployee(); return; }
        state.employee = await api(`/api/schedule/versions/${encodeURIComponent(versionId)}/employee/${encodeURIComponent(employeeId)}`);
        renderEmployee();
    }
    async function loadAudit() {
        if (!state.data) return;
        $('auditTable').innerHTML = '<div class="empty">جارٍ تحميل السجل…</div>';
        const result = await api(`/api/schedule/audit-log?month=${encodeURIComponent(state.data.month)}&limit=500`);
        $('auditTable').innerHTML = table(['التوقيت', 'المستخدم', 'المعرّف', 'الإجراء', 'النوع', 'التفاصيل'], result.audit.map(row => [fmt(row.created_at), fmt(row.user_name), fmt(row.user_id), fmt(row.action), fmt(row.type), fmt(row.detail)]));
    }

    document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));
    $('loadWorkspace').addEventListener('click', () => loadWorkspace(false));
    $('targetMonth').addEventListener('change', () => loadWorkspace(false));
    $('openCurrentReview').addEventListener('click', () => switchTab('review'));
    $('versionsTable').addEventListener('click', event => {
        const button = event.target.closest('.select-version'); if (!button) return;
        action(async () => { await selectVersion(button.dataset.id); });
    });
    $('employeeSelector').addEventListener('change', () => action(loadEmployee));
    $('refreshAudit').addEventListener('click', () => action(loadAudit));

    $('generateDraft').addEventListener('click', () => action(async () => {
        const note = window.prompt('ملاحظة مصدر التوليد (اختيارية):', 'مسودة شهرية من آخر مرجع معتمد');
        if (note === null) return;
        const result = await api('/api/schedule/generation-runs', { method: 'POST', body: { target_month: state.data.month, source_note: note } });
        await loadWorkspace(false); await selectVersion(result.run.schedule_version_id); toast('تم إنشاء تشغيل التوليد وإصدار جديد', 'success');
    }));
    $('regenerateDraft').addEventListener('click', () => action(async () => {
        if (!state.lifecycle || !window.confirm('سيُنشأ تشغيل وإصدار جديدان مع حماية الخلايا غير المتأثرة. متابعة؟')) return;
        const note = window.prompt('سبب/ملاحظة إعادة التوليد:', 'إعادة توليد minimal-diff بعد مراجعة المدخلات');
        if (note === null) return;
        const result = await api(`/api/schedule/generation-runs/${encodeURIComponent(state.lifecycle.run.id)}/regenerate`, { method: 'POST', body: { source_note: note } });
        await loadWorkspace(false); await selectVersion(result.run.schedule_version_id); toast('تمت إعادة التوليد في إصدار جديد', 'success');
    }));
    $('importReferenceForm').addEventListener('submit', event => { event.preventDefault(); action(async () => {
        const result = await api('/api/schedule/versions/import-roster', { method: 'POST', body: { month: $('referenceMonth').value, source_note: $('referenceSourceNote').value } });
        await reloadAfter('تم استيراد المرجع دون تعديل مصدره'); await selectVersion(result.version.id);
    }); });
    $('openReferenceDraft').addEventListener('click', () => action(async () => {
        const ref = reference(); if (!ref) return;
        await api(`/api/schedule/versions/${ref.id}/open-draft`, { method: 'POST', body: {} }); await reloadAfter('تم فتح المرجع كمسودة');
    }));
    $('deriveContinuity').addEventListener('click', () => action(async () => {
        const ref = reference(); if (!ref) return;
        await api(`/api/schedule/versions/${ref.id}/continuity/derive`, { method: 'POST', body: {} }); await reloadAfter('تم اشتقاق لقطة استمرارية جديدة');
    }));
    $('approveReference').addEventListener('click', () => action(async () => {
        const ref = reference(); if (!ref || !window.confirm(`اعتماد المرجع بالبصمة ${ref.content_hash}؟`)) return;
        await api(`/api/schedule/versions/${ref.id}/approve`, { method: 'POST', body: { content_hash: ref.content_hash } }); await reloadAfter('تم اعتماد المرجع ولقطة الاستمرارية');
    }));
    $('gapsForm').addEventListener('submit', event => { event.preventDefault(); action(async () => {
        const ref = reference(); if (!ref) return;
        const reviews = [...$('gapReviews').querySelectorAll('tbody tr')].map(row => ({ employee_id: Number(row.dataset.employee), gap_date: row.dataset.date, resolution: row.querySelector('.gap-resolution').value, reason: row.querySelector('.gap-reason').value }));
        await api(`/api/schedule/versions/${ref.id}/gaps`, { method: 'PUT', body: { reviews } }); await reloadAfter('تم حفظ دلالات الفراغات');
    }); });
    $('continuityForm').addEventListener('submit', event => { event.preventDefault(); action(async () => {
        const ref = reference(); if (!ref) return;
        const body = { status: $('continuityStatus').value, reason: $('continuityReason').value, effective_date: $('continuityEffectiveDate').value };
        if (body.status === 'resolved') Object.assign(body, { pattern_code: $('continuityPattern').value, next_phase_index: Number($('continuityPhase').value), team_id: $('continuityTeam').value ? Number($('continuityTeam').value) : null });
        await api(`/api/schedule/versions/${ref.id}/continuity/${encodeURIComponent($('continuityEmployee').value)}`, { method: 'PUT', body }); await reloadAfter('تم حفظ الإسناد اليدوي الموثق');
    }); });
    $('reviewDraft').addEventListener('click', () => action(async () => {
        if (!state.lifecycle) return;
        await api(`/api/schedule/generated-versions/${state.lifecycle.version.id}/review`, { method: 'POST', body: {} }); await reloadAfter('تمت إعادة تقييم المسودة وتسجيل المراجعة');
    }));
    $('approveDraft').addEventListener('click', () => action(async () => {
        const version = state.lifecycle && state.lifecycle.version;
        if (!version || !window.confirm(`اعتماد الإصدار ${version.version_number} ببصمته الحالية؟`)) return;
        await api(`/api/schedule/generated-versions/${version.id}/approve`, { method: 'POST', body: { content_hash: version.content_hash } }); await reloadAfter('تم اعتماد المسودة');
    }));
    $('publishDraft').addEventListener('click', () => action(async () => {
        const version = state.lifecycle && state.lifecycle.version;
        if (!version || !window.confirm('النشر منطقي فقط ولن يطبق الجدول على التشغيل. متابعة؟')) return;
        await api(`/api/schedule/generated-versions/${version.id}/publish`, { method: 'POST', body: { content_hash: version.content_hash } }); await reloadAfter('تم النشر المنطقي للإصدار');
    }));
    $('createCorrection').addEventListener('click', () => action(async () => {
        if (!state.lifecycle) return;
        const reason = window.prompt('سبب التصحيح الإداري الموثق (إلزامي):');
        if (!reason || !reason.trim()) return;
        const result = await api(`/api/schedule/generated-versions/${state.lifecycle.version.id}/corrections`, { method: 'POST', body: { reason } });
        await loadWorkspace(false); await selectVersion(result.version.id); toast('تم إنشاء إصدار تصحيحي مستقل', 'success');
    }));
    $('compareForm').addEventListener('submit', event => { event.preventDefault(); action(async () => {
        const result = await api(`/api/schedule/version-comparison?base_id=${encodeURIComponent($('compareBase').value)}&target_id=${encodeURIComponent($('compareTarget').value)}`);
        $('comparisonResult').innerHTML = `<p>عدد التغييرات: ${result.change_count}. السبب غير المسجل يظهر صراحة ولا يُستنتج.</p>` + table(['الموظف', 'التاريخ', 'قبل', 'بعد', 'النوع', 'السبب', 'مصدر السبب'], result.changes.map(row => [esc(employeeName(row.employee_id)), row.date, row.before ? `${fmt(row.before.shift_code)} / ${esc(teamName(row.before.team_id))}` : '—', row.after ? `${fmt(row.after.shift_code)} / ${esc(teamName(row.after.team_id))}` : '—', row.change_type, fmt(row.reason), fmt(row.reason_source)]));
    }); });
    $('exceptionForm').addEventListener('submit', event => { event.preventDefault(); action(async () => {
        await api('/api/schedule/exceptions', { method: 'POST', body: {
            exception_type: $('exceptionType').value, employee_id: $('exceptionEmployee').value || null, scope_team_id: $('exceptionScopeTeam').value || null,
            start_date: $('exceptionStart').value, end_date: $('exceptionEnd').value, effect_team_id: $('exceptionEffectTeam').value || null, effect_shift_code: $('exceptionEffectCode').value || null,
            reason: $('exceptionReason').value, approval_source: $('exceptionApprovalSource').value, approval_authority: $('exceptionApprovalAuthority').value,
            approved_by: $('exceptionApprovedBy').value, approved_at: $('exceptionApprovedAt').value, document_ref: $('exceptionDocumentRef').value || null
        } }); event.target.reset(); await reloadAfter('تم تسجيل الاستثناء المؤقت');
    }); });
    $('exceptionsTable').addEventListener('click', event => {
        const button = event.target.closest('.cancel-exception'); if (!button) return;
        const reason = window.prompt('سبب إلغاء الاستثناء (إلزامي):'); if (!reason || !reason.trim()) return;
        action(async () => { await api(`/api/schedule/exceptions/${encodeURIComponent(button.dataset.id)}/cancel`, { method: 'POST', body: { cancellation_reason: reason } }); await reloadAfter('تم إلغاء الاستثناء وتوثيق السبب'); });
    });
    $('coverageMatrix').addEventListener('change', event => {
        if (!event.target.classList.contains('coverage-applicability')) return;
        const id = event.target.dataset.team, required = event.target.value === 'required';
        ['day', 'night'].forEach(part => { const input = document.querySelector(`.coverage-${part}[data-team="${id}"]`); input.disabled = !required || !permission('schedule.settings.manage'); if (!required) input.value = ''; });
        document.querySelector(`.coverage-total[data-team="${id}"]`).textContent = '—';
    });
    $('coverageMatrix').addEventListener('input', event => {
        if (!event.target.classList.contains('coverage-day') && !event.target.classList.contains('coverage-night')) return;
        const id = event.target.dataset.team, day = document.querySelector(`.coverage-day[data-team="${id}"]`).value, night = document.querySelector(`.coverage-night[data-team="${id}"]`).value;
        document.querySelector(`.coverage-total[data-team="${id}"]`).textContent = day !== '' && night !== '' ? Number(day) + Number(night) : '—';
    });
    $('coverageForm').addEventListener('submit', event => { event.preventDefault(); action(async () => {
        if (!window.confirm('سيتم تسجيل المصفوفة والسند كإثباتات رسمية مرتبطة بالبصمات. هل راجعت جميع الفرق؟')) return;
        const rows = [...$('coverageMatrix').querySelectorAll('.coverage-applicability')].map(select => {
            const id = Number(select.dataset.team), row = { team_id: id, applicability: select.value };
            if (select.value === 'required') { row.day = Number(document.querySelector(`.coverage-day[data-team="${id}"]`).value); row.night = Number(document.querySelector(`.coverage-night[data-team="${id}"]`).value); }
            return row;
        });
        await api('/api/schedule/coverage-approvals', { method: 'PUT', body: {
            rows, source: $('coverageSource').value, approval_authority: $('coverageAuthority').value, approved_by: $('coverageApprovedBy').value,
            approved_at: $('coverageApprovedAt').value, effective_from: $('coverageEffectiveFrom').value, effective_to: $('coverageEffectiveTo').value || null,
            official_confirmation: $('coverageOfficialConfirmation').checked,
            expected_default_hash: state.data.coverage.coverage_default_hash, expected_overrides_hash: state.data.coverage.coverage_overrides_hash
        } }); await reloadAfter('تم حفظ المصفوفة وإثباتاتها وربطها بالبصمات');
    }); });

    async function init() {
        const now = new Date(); now.setMonth(now.getMonth() + 1);
        $('targetMonth').value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        $('exceptionApprovedAt').value = new Date().toISOString().slice(0, 16); $('coverageApprovedAt').value = new Date().toISOString().slice(0, 16);
        try {
            state.me = await api('/api/auth/me');
            $('currentUser').textContent = `${state.me.user.name || state.me.user.id} · ${state.me.role_label || state.me.user.role}`;
            applyPermissions();
            await loadWorkspace(false);
        } catch (error) { message(errorText(error)); }
    }
    init();
})();
