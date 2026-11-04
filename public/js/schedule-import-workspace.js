/* P6 — واجهة عرض ومراجعة الاستيراد فقط؛ التفسير والحسم والبصمات في الخادم. */
(function () {
    'use strict';
    if (!window.AuthCore || !AuthCore.requireAuth('/')) return;
    const $ = id => document.getElementById(id);
    const state = { me: null, batch: null, options: null, busy: false };
    const STATUS = { analyzed: 'تم التحليل', mapped: 'تم تطبيق الخريطة', validated: 'المراجعة جارية', reviewed: 'مراجع بشريًا', imported: 'أنشئ مرجع imported' };
    const ISSUE = {
        MONTH_MISMATCH: 'اختلاف الشهر', MONTH_UNRESOLVED: 'الشهر غير محسوم', STRUCTURE_UNRESOLVED: 'بنية غير محسومة', MAPPING_INVALID: 'خريطة غير صالحة',
        EMPLOYEE_UNRESOLVED: 'موظف غير محسوم', DATE_UNRESOLVED: 'تاريخ غير محسوم', DATE_OUTSIDE_MONTH: 'تاريخ خارج الشهر', UNKNOWN_SHIFT_CODE: 'رمز مجهول',
        TEAM_UNRESOLVED: 'فريق غير محسوم', EMPLOYEE_INACTIVE: 'موظف غير نشط', HOURS_MISMATCH: 'اختلاف الساعات', DUPLICATE_CONFLICT: 'تكرار متعارض', DUPLICATE_IDENTICAL: 'تكرار متطابق', EMPTY_SHEET: 'ورقة فارغة'
    };
    function esc(value) { return String(value === null || value === undefined ? '' : value).replace(/[&<>'"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[ch]); }
    function fmt(value) { return value === null || value === undefined || value === '' ? '—' : esc(value); }
    function option(value, label, selected = false) { return `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`; }
    function table(headers, rows, empty = 'لا توجد بيانات') {
        if (!rows || !rows.length) return `<div class="empty">${esc(empty)}</div>`;
        return `<table><thead><tr>${headers.map(item => `<th>${esc(item)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${cell === undefined || cell === null || cell === '' ? '—' : cell}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    }
    function allowed() { return !!state.me && (state.me.permissions_star === true || (state.me.permissions || []).includes('*') || (state.me.permissions || []).includes('schedule.import')); }
    function toast(text, type = 'info') { if (window.ToastCore) ToastCore.show(text, type); }
    function showError(error) {
        const el = $('smartImportMessage'); el.className = 'message error'; el.textContent = `${error.message || 'فشل الطلب'}${error.code ? ` (${error.code})` : ''}`; el.classList.remove('hidden');
    }
    function clearMessage() { $('smartImportMessage').classList.add('hidden'); }
    async function api(path, options = {}) {
        const config = { method: options.method || 'GET', headers: {} };
        if (options.form) config.body = options.form;
        else if (options.body !== undefined) { config.headers['Content-Type'] = 'application/json'; config.body = JSON.stringify(options.body); }
        const response = await AuthCore.apiRequest(path, config);
        let data = null; try { data = await response.json(); } catch (_) { data = null; }
        if (!response.ok) { const error = new Error(data && data.error || `فشل الطلب HTTP ${response.status}`); error.code = data && data.code; throw error; }
        return data;
    }
    function setBusy(value, label = '') {
        state.busy = value; $('smartImportState').textContent = label || (state.batch ? STATUS[state.batch.status] : 'لم تُختر دفعة');
        $('smartImportUploadForm').querySelector('button').disabled = value || !allowed();
        $('smartImportMapForm').querySelector('button').disabled = value || !allowed() || !state.batch || state.batch.status === 'imported';
        renderActions();
    }
    async function action(fn) {
        if (state.busy) return; clearMessage(); setBusy(true, 'جارٍ تنفيذ الطلب…');
        try { await fn(); } catch (error) { showError(error); toast(error.message, 'error'); }
        finally { setBusy(false); }
    }
    function renderActions() {
        const ready = state.batch && state.batch.analysis && !state.batch.analysis.counts.blockers && !state.batch.analysis.counts.warnings;
        $('smartImportConfirm').disabled = state.busy || !allowed() || !ready || state.batch.status === 'reviewed' || state.batch.status === 'imported';
        $('smartImportFinalize').disabled = state.busy || !allowed() || !state.batch || state.batch.status !== 'reviewed';
        $('smartImportDownload').disabled = !state.batch || state.busy;
        $('smartImportReviewReason').disabled = !allowed() || !state.batch || state.batch.status === 'imported';
    }
    function renderList(batches) {
        $('smartImportBatches').innerHTML = batches.length ? batches.map(row => `<button class="record import-batch" type="button" data-id="${esc(row.id)}"><strong>${esc(row.original_name)}</strong><span>${fmt(row.month)} · ${esc(STATUS[row.status] || row.status)}</span><small>${fmt(row.created_at)} · ${fmt(row.created_by)}</small></button>`).join('') : '<div class="empty">لا توجد دفعات</div>';
    }
    async function loadList() { const result = await api('/api/schedule/imports'); renderList(result.batches); }
    function reviewControl(issue) {
        const candidates = issue.candidates || [];
        if (issue.type === 'EMPLOYEE_UNRESOLVED') {
            const rows = state.options.employees;
            return `<select class="review-value">${rows.map(row => option(row.id, `${row.name} — ${row.employee_code || row.id}`, candidates.length === 1 && Number(candidates[0].id) === Number(row.id))).join('')}</select><button class="button secondary review-action" data-action="set_employee" type="button">إسناد موظف</button>`;
        }
        if (issue.type === 'UNKNOWN_SHIFT_CODE') return `<select class="review-value">${state.options.shiftCodes.map(row => option(row.code, `${row.code} — ${row.name || ''}`)).join('')}</select><button class="button secondary review-action" data-action="set_shift" type="button">اختيار رمز موجود</button>`;
        if (issue.type === 'TEAM_UNRESOLVED') return `<select class="review-value">${state.options.teams.map(row => option(row.id, `${row.name} — ${row.center || ''}`)).join('')}</select><button class="button secondary review-action" data-action="set_team" type="button">إسناد فريق</button>`;
        if (['DATE_UNRESOLVED', 'DATE_OUTSIDE_MONTH'].includes(issue.type)) return `<input class="review-value" type="date"><button class="button secondary review-action" data-action="set_date" type="button">تصحيح التاريخ</button>`;
        if (issue.severity === 'warning') return '<button class="button secondary review-action" data-action="accept_warning" type="button">قبول التحذير بسبب</button>';
        return 'يتطلب خريطة قالب أعلاه';
    }
    function renderIssues(analysis) {
        const pending = analysis.issues.filter(issue => issue.status === 'pending');
        $('smartImportIssues').innerHTML = table(['القضية', 'السبب', 'الموضع', 'القيمة', 'القرار'], pending.map(issue => {
            const source = issue.source ? `${issue.source.sheet || ''} / ${issue.source.block || ''} / صف ${issue.source.row || '—'} / عمود ${issue.source.column || '—'}` : 'عام';
            const controls = reviewControl(issue);
            const exclude = issue.assignmentId ? ' <button class="button danger review-action" data-action="exclude_assignment" type="button">استبعاد الخلية</button>' : '';
            return [`<span data-issue="${esc(issue.id)}" data-assignment="${esc(issue.assignmentId || '')}">${esc(ISSUE[issue.type] || issue.type)}</span>`, esc(issue.message), esc(source), fmt(issue.currentValue), `<div class="import-review-controls" data-issue="${esc(issue.id)}" data-assignment="${esc(issue.assignmentId || '')}">${controls}${allowed() ? exclude : ''}</div>`];
        }), 'لا توجد قضايا معلقة');
        $('smartImportIssues').querySelectorAll('select,input,button').forEach(control => { control.disabled = !allowed() || state.busy || state.batch.status === 'imported'; });
    }
    function evidence(item) {
        return `<details><summary>الدليل والسبب</summary><div>الموظف: ${esc(item.evidence.employee)}</div><div>التاريخ: ${esc(item.evidence.date)}</div><div>الرمز: ${esc(item.evidence.shift)}</div><div>الفريق: ${esc(item.evidence.team)}</div>${item.evidence.exclusion ? `<div>${esc(item.evidence.exclusion)}</div>` : ''}<code>${esc(JSON.stringify(item.evidence.source))}</code><pre>${esc(JSON.stringify(item.evidence.cell || {}))}</pre></details>`;
    }
    function renderPreview(analysis) {
        const rows = analysis.assignments.slice(0, 1000);
        $('smartImportAssignments').innerHTML = (analysis.assignments.length > rows.length ? '<p class="notice warning">تعرض الواجهة أول 1000 عنصر؛ التحليل والحفظ في الخادم يشملان جميع العناصر.</p>' : '') + table(['الموظف', 'التاريخ الأصلي/المحلل', 'الرمز الأصلي/المحلل', 'الفريق', 'الحالة', 'الساعات', 'الدليل'], rows.map(item => [
            `${esc(item.employee_name || item.raw_employee_name)}<br><small>${fmt(item.employee_code || item.raw_employee_code)}</small>`, `${fmt(item.raw_date)}<br>${fmt(item.date)}`,
            `${fmt(item.raw_shift)}<br>${fmt(item.shift_code)}`, `${fmt(item.raw_team)}${item.team_id ? `<br>#${item.team_id}` : ''}`, fmt(item.status), fmt(item.reported_hours), evidence(item)
        ]));
        $('smartImportDiffs').innerHTML = table(['النوع', 'الموظف', 'التاريخ', 'قبل', 'بعد', 'ملاحظة'], analysis.referenceDiff.slice(0, 1000).map(row => [fmt(row.change), fmt(row.employee_id), fmt(row.date), fmt(row.before), fmt(row.after), fmt(row.note)]));
        $('smartImportOriginal').innerHTML = analysis.original.map(sheet => `<details class="record"><summary>${esc(sheet.name)} · ${esc(sheet.extraction)} · ثقة OCR: ${fmt(sheet.ocrConfidence)}</summary><p>دمج: ${sheet.merges.length} · تعليقات: ${sheet.notes.length} · خلايا منسقة/معلقة: ${sheet.styledCells}</p>${table(Array.from({ length: Math.min(20, sheet.rows.reduce((n, row) => Math.max(n, row.length), 0)) }, (_, i) => `عمود ${i + 1}`), sheet.rows.slice(0, 20).map(row => Array.from({ length: Math.min(20, row.length) }, (_, i) => esc(row[i]))))}</details>`).join('') || '<div class="empty">لا توجد معاينة</div>';
    }
    function renderBatch() {
        const batch = state.batch;
        if (!batch) return;
        const analysis = batch.analysis;
        $('smartImportState').textContent = STATUS[batch.status] || batch.status;
        $('smartImportDetails').innerHTML = [['الملف', esc(batch.original_name)], ['الصيغة', fmt(batch.format)], ['الشهر', fmt(batch.month)], ['الحالة', esc(STATUS[batch.status])], ['SHA-256 للأصل', `<code>${esc(batch.file_sha256)}</code>`], ['SHA-256 للتحليل', `<code>${esc(batch.analysis_hash)}</code>`], ['القالب', `${esc(analysis.template.signature)}<br>${esc(analysis.template.note)}`], ['مرجع P1-A', batch.version_id ? `<code>${esc(batch.version_id)}</code>` : 'لم يُنشأ']].map(([key, value]) => `<div class="detail-row"><span>${key}</span><span>${value}</span></div>`).join('');
        $('smartImportMapMonth').value = batch.month || '';
        $('smartImportMappings').value = JSON.stringify(batch.mapping || [], null, 2);
        $('smartImportStructures').innerHTML = table(['الورقة/الجزء', 'الاتجاه', 'صف العنوان', 'الخريطة', 'المصدر'], analysis.structures.map(row => [`${esc(row.sheet)}<br><code>${esc(row.block)}</code>`, fmt(row.orientation), fmt(row.headerRow), `<code>${esc(JSON.stringify(row.mapping || { employeeColumn: row.employeeColumn, employeeCodeColumn: row.employeeCodeColumn, dateColumns: row.dateColumns }))}</code>`, fmt(row.source || 'تحليل آلي')]));
        $('smartImportAssignmentsCount').textContent = analysis.counts.assignments;
        $('smartImportEmployeesCount').textContent = analysis.counts.employees;
        $('smartImportBlockersCount').textContent = analysis.counts.blockers;
        $('smartImportWarningsCount').textContent = analysis.counts.warnings;
        renderIssues(analysis); renderPreview(analysis);
        $('smartImportReviews').innerHTML = table(['الوقت', 'المستخدم', 'الإجراء', 'القضية', 'القيمة', 'السبب', 'بصمة ما قبل القرار'], batch.reviews.map(row => [fmt(row.created_at), fmt(row.created_by), fmt(row.action), fmt(row.issue_id), `<code>${esc(JSON.stringify(row.value))}</code>`, fmt(row.reason), `<code>${esc(row.analysis_hash)}</code>`]));
        $('smartImportMapForm').querySelectorAll('input,textarea').forEach(input => { input.disabled = !allowed() || batch.status === 'imported' || batch.reviews.length > 0; });
        renderActions();
    }
    async function openBatch(id) { const result = await api(`/api/schedule/imports/${encodeURIComponent(id)}`); state.batch = result.batch; state.options = result.options; renderBatch(); }
    $('smartImportUploadForm').addEventListener('submit', event => { event.preventDefault(); action(async () => {
        const file = $('smartImportFile').files[0]; if (!file) throw new Error('اختر ملفًا');
        const form = new FormData(); form.append('file', file); if ($('smartImportMonth').value) form.append('month', $('smartImportMonth').value);
        const result = await api('/api/schedule/imports', { method: 'POST', form }); state.batch = result.batch; state.options = result.options;
        $('smartImportFile').value = ''; renderBatch(); await loadList(); toast('حُفظ الأصل واكتمل التحليل الأولي', 'success');
    }); });
    $('smartImportMapForm').addEventListener('submit', event => { event.preventDefault(); action(async () => {
        let mappings = []; const text = $('smartImportMappings').value.trim();
        if (text) { try { mappings = JSON.parse(text); } catch (_) { throw new Error('JSON لخريطة القالب غير صالح'); } }
        if (!Array.isArray(mappings)) throw new Error('خرائط القالب يجب أن تكون مصفوفة JSON');
        const result = await api(`/api/schedule/imports/${state.batch.id}/map`, { method: 'PUT', body: { month: $('smartImportMapMonth').value, mappings, expected_analysis_hash: state.batch.analysis_hash } });
        state.batch = result.batch; state.options = result.options; renderBatch(); await loadList(); toast('طُبقت الخريطة وأُعيد التحليل', 'success');
    }); });
    $('smartImportBatches').addEventListener('click', event => { const button = event.target.closest('.import-batch'); if (button) action(() => openBatch(button.dataset.id)); });
    $('smartImportIssues').addEventListener('click', event => { const button = event.target.closest('.review-action'); if (!button) return; action(async () => {
        const container = button.closest('.import-review-controls'), actionName = button.dataset.action, valueControl = container.querySelector('.review-value');
        let value = null;
        if (actionName === 'set_employee') value = { employee_id: Number(valueControl.value) };
        if (actionName === 'set_shift') value = { shift_code: valueControl.value };
        if (actionName === 'set_team') value = { team_id: Number(valueControl.value) };
        if (actionName === 'set_date') value = { date: valueControl.value };
        const result = await api(`/api/schedule/imports/${state.batch.id}/review`, { method: 'POST', body: { action: actionName, issue_id: container.dataset.issue,
            assignment_id: container.dataset.assignment || null, value, reason: $('smartImportReviewReason').value, expected_analysis_hash: state.batch.analysis_hash } });
        state.batch = result.batch; state.options = result.options; renderBatch(); await loadList(); toast('حُفظ قرار المراجعة وسببه', 'success');
    }); });
    $('smartImportConfirm').addEventListener('click', () => action(async () => {
        const result = await api(`/api/schedule/imports/${state.batch.id}/review`, { method: 'POST', body: { action: 'confirm_review', reason: $('smartImportReviewReason').value, expected_analysis_hash: state.batch.analysis_hash } });
        state.batch = result.batch; state.options = result.options; renderBatch(); await loadList(); toast('اكتملت المراجعة البشرية النهائية', 'success');
    }));
    $('smartImportFinalize').addEventListener('click', () => action(async () => {
        if (!window.confirm('سيُنشأ مرجع P1-A بحالة imported فقط؛ لن يُعتمد أو يُنشر أو يُكتب في الجدول الرسمي. متابعة؟')) return;
        const result = await api(`/api/schedule/imports/${state.batch.id}/import`, { method: 'POST', body: { expected_analysis_hash: state.batch.analysis_hash } });
        state.batch = result.batch; state.options = result.options; renderBatch(); await loadList(); toast(`أُنشئ المرجع ${result.version.id} بحالة imported`, 'success');
    }));
    $('smartImportDownload').addEventListener('click', () => action(async () => {
        const response = await AuthCore.apiRequest(`/api/schedule/imports/${state.batch.id}/file`);
        if (!response.ok) throw new Error(`فشل تنزيل الأصل HTTP ${response.status}`);
        const url = URL.createObjectURL(await response.blob()), link = document.createElement('a'); link.href = url; link.download = state.batch.original_name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }));
    document.querySelector('[data-tab="imports"]').addEventListener('click', () => action(loadList));
    async function init() {
        try {
            state.me = await api('/api/auth/me');
            $('smartImportUploadForm').querySelectorAll('input,button').forEach(control => { control.disabled = !allowed(); });
            $('smartImportMapForm').querySelectorAll('input,textarea,button').forEach(control => { control.disabled = !allowed(); });
            renderActions(); await loadList();
        } catch (error) { showError(error); }
    }
    init();
})();
