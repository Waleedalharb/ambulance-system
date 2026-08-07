/**
 * خدمة توليد PDF الرسمي لسير العمل — W-3
 * ═══════════════════════════════════════════════════════════
 * وثيقة حكومية رسمية A4 تُولَّد عند الاعتماد فقط (قبل قفل الصف).
 * التخزين: data/archives/workflows/<ref_no>.pdf — المسار النسبي في pdf_path.
 *
 * خط أنبوب العربية محسوم ومُثبت بصريًا (بقرار المالك — لا يُغيَّر):
 *  (أ) features:{} في كل doc.text وإلا قسّم pdfkit النص عند المسافات؛
 *  (ب) fontkit يعكس فقرة RTL كاملة، لذلك نعكس السلسلة المرئية مسبقًا + U+200F.
 */

const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const bidi = require('bidi-js')();

const ROOT = path.join(__dirname, '..');
const FONT_PATH = path.join(ROOT, 'assets', 'fonts', 'Amiri-Regular.ttf');
const LOGO_PATH = path.join(ROOT, 'public', 'logo.png');
const STORAGE_DIR = path.join(ROOT, 'data', 'archives', 'workflows');

// ─── خط أنبوب العربية (محسوم — لا تغيّره) ───
function ar(t) {
    if (!/[\u0600-\u06FF]/.test(t)) return t;              // لاتيني/أرقام خالصة: كما هي
    const V = bidi.getReorderedString(t, bidi.getEmbeddingLevels(t, 'rtl'));
    return '\u200F' + [...V].reverse().join('');
}

// ─── توقيت العرض السعودي (تخزين UTC) — أغلفة للطبقة المركزية public/js/time-riyadh.js ───
const TimeRiyadh = require('../public/js/time-riyadh.js');
// doc-v4 ②: القيم الغائبة تُرسم فراغًا لا «—»
// النص الخام يمر للطبقة المركزية لتطبيع naive-UTC قبل التنسيق
function fDate(iso) { if (!iso) return ''; const r = TimeRiyadh.formatDate(iso); return r === '—' ? '' : r; }
function fTime(iso) { if (!iso) return ''; const r = TimeRiyadh.formatTime(iso); return r === '—' ? '' : r; }
function fDateTime(iso) { if (!iso) return ''; const r = TimeRiyadh.formatDateTime(iso); return r === '—' ? '' : r; }

// ─── تسميات ───
function vehStatusLabel(st) {
    if (st === 'active') return 'عاملة';
    if (st === 'reserve') return 'احتياط';
    if (st === 'breakdown') return 'متعطلة';
    if (st === 'out_of_service') return 'خارج الخدمة';
    return '—';
}
function teamStatusLabel(st) {
    if (st === 'ready') return 'جاهزة';
    if (st === 'missing') return 'ناقصة';
    if (st === 'offline') return 'خارج الخدمة';
    return 'بانتظار التكميل';
}
function lateFor(lateRecords, name) {
    if (!Array.isArray(lateRecords)) return null;
    return lateRecords.find(r => r && r.employee === name) || null;
}
function lateNote(lateRecords, name) {
    const r = lateFor(lateRecords, name);
    if (!r) return null;                                    // doc-v4 ②: بلا سطر بدل «—»
    if (r.status === 'arrived' && r.arrivedAt) {
        // doc-v4 ①: قالب موحد بسطر واحد — «وقت الحضور: … • مدة التأخير: …»
        const d = (typeof r.durationMinutes === 'number') ? ' • مدة التأخير: ' + r.durationMinutes + ' دقيقة' : '';
        return 'وقت الحضور: ' + fTime(r.arrivedAt) + d;
    }
    return 'لم يحضر بعد';
}

// ─── doc-v3b: سطر بصري واحد مضمون لكل فرد — أعمدة فرعية ثابتة المواضع ───
// القياس الفعلي (بقرار المالك — لا تخمين): 146 موظفًا نشطًا بخط Amiri @7.5pt عبر
// أنبوب ar نفسه — أطول اسم «عبدالرحمن فهد سلامه عبدالعزيز السلامه» = 96.6pt،
// أطول مسمى «مساعد كبير مسعفين» = 49.1pt، أطول كود (6 أرقام) = 23.9pt.
// الأعمدة الفرعية = القياس + هامش: مسمى 52 | فاصل 7 | اسم 101 (+4.6% هامش) | فاصل 7 | كود 26.
// مُثبت بقياس أن 4 أعمدة أشخاص مستقلة (4×201pt) مستحيلة في عرض A4 (515pt)،
// لذلك تُدمج الغياب/التأخير/الدعم في عمود استثناءات واحد بأقسام موسومة —
// وكل شخص في أي قسم يأخذ نفس الأعمدة الفرعية العالمية (الفواصل تصطف رأسيًا في الوثيقة كلها).
const PS = 7.5;                       // حجم خط أسطر الأشخاص (العناوين تبقى 8.5)
const SUB_JOB = 52, SUB_SEP = 7, SUB_NAME = 101, SUB_CODE = 26;
const PERSON_BLOCK = SUB_JOB + SUB_SEP + SUB_NAME + SUB_SEP + SUB_CODE; // 193
const PERSON_COL_W = PERSON_BLOCK + 8;                                 // 201 (حشو 4+4)
// نماذج أسطر الخلايا — كائنات (لا سلاسل) حتى يرسم table() كل نوع بصيغته
function segP(p) { return { k: 'p', job: (p && p.jobTitle) || '', name: (p && p.name) || '', code: (p && p.code) ? String(p.code) : '' }; }
// وسما نوع الدعم في عمود الاستثناءات — عرض فقط فوق حقول الخادم
const PDF_SUPPORT_LABELS = { volunteer_support: 'تطوع', external_support: 'دعم من مركز آخر', assignment: 'تكليف' };
const PDF_COVERAGE_LABELS = { volunteer: 'تطوع', external: 'دعم من مركز آخر', assignment: 'تكليف', reserve: 'احتياط' };
function segInfo(t) { return { k: 'i', t: String(t) }; }   // سطر معلومة ثانٍ (باهت)
function segLabel(t) { return { k: 'l', t: String(t) }; }  // وسم قسم داخل عمود الاستثناءات
function segText(t) { return { k: 't', t: String(t) }; }   // نص عادي قابل للالتفاف
function personsCell(list, extraFn) {
    const out = [];
    (list || []).forEach(p => {
        if (!p) return;
        out.push(segP(p));
        if (typeof extraFn === 'function') {
            const extra = extraFn(p);
            if (extra) out.push(segInfo(extra));
        }
    });
    return out;
}
// المتأخرون: المفتوحون (state=late) + الذين حضروا (يُستكملون من lateRecords حتى
// لا يضيع وقت الحضور الفعلي ومدة التأخير من الوثيقة)
function latePersons(g, lateRecords, teamName) {
    const persons = g.late.slice();
    (Array.isArray(lateRecords) ? lateRecords : []).forEach(r => {
        if (!r || r.status !== 'arrived' || String(r.teamId || '') !== teamName) return;
        if (persons.some(m => m.name === r.employee)) return;
        persons.push({ name: r.employee, jobTitle: r.jobTitle || null, code: r.code || null });
    });
    return persons;
}

// ─── اشتقاقات اللقطة (نفس منطق الشاشة — عرض فقط) ───
function absReason(t, name) {
    const list = t.absentees || [];
    for (let i = 0; i < list.length; i++) {
        if (list[i] && list[i].name === name) return list[i].reason || null;
    }
    return null;
}
// doc-v2 ①: خلية السبب بلا أسماء — وصف إداري فقط؛ الأسماء بأعمدتها (الغياب/التأخير)
function teamReasons(t) {
    const lines = [];
    const absentees = t.absentees || [];
    if (absentees.some(a => a && a.type !== 'late')) lines.push('نقص بسبب غياب');
    if (absentees.some(a => a && a.type === 'late')) lines.push('تأخير أحد أفراد الكادر');
    if (t.vehicleOk === false) lines.push('نقص مركبة');
    if (t.status === 'offline') {
        const r = t.reason || (t.lastDecision && t.lastDecision.reason);
        if (r) lines.push(String(r));
    }
    return lines;
}
function memberGroups(t) {
    const g = { active: [], abs: [], late: [], away: [] };
    (t.members || []).forEach(m => {
        if (!m || m.role === 'support') return;
        if (m.state === 'absence') g.abs.push(m);
        else if (m.state === 'late') g.late.push(m);
        else if (m.state === 'assignment') g.away.push(m);
        else g.active.push(m);
    });
    return g;
}
function findHomeTeam(teams, supporterName, current) {
    for (const name of Object.keys(teams)) {
        if (name === current) continue;
        const ms = (teams[name] && teams[name].members) || [];
        if (ms.some(m => m && m.role === 'base' && m.name === supporterName)) return name;
    }
    return null;
}
function homeTeamOfVehicle(teams, vehId, exclude) {
    for (const name of Object.keys(teams)) {
        if (name === exclude) continue;
        const tv = teams[name] && teams[name].vehicleId;
        if (tv != null && String(tv) === String(vehId)) return name;
    }
    return null;
}
// doc-v4 ①⑧: عمود الاستثناءات — قوالب موحدة ثابتة لكل نوع:
//   غياب: وسم «غياب» + سطر الفرد + «السبب: …»
//   تأخير: وسم «تأخير» + سطر الفرد + «وقت الحضور: … • مدة التأخير: …»
//   دعم: وسم «دعم» + سطر الفرد + «قادم من: <فريقه>»
// فريق بلا استثناءات ⇒ خلية فارغة تمامًا (بلا «—» نهائيًا — بند ②).
function exceptionsCell(teams, vehMap, t, teamName, g, lateRecords) {
    const out = [];
    if (g.abs.length) {
        out.push(segLabel('غياب'));
        g.abs.forEach(m => {
            out.push(segP(m));
            const r = absReason(t, m.name);
            if (r) out.push(segInfo('السبب: ' + r));
        });
    }
    const lates = latePersons(g, lateRecords, teamName);
    if (lates.length) {
        out.push(segLabel('تأخير'));
        lates.forEach(m => {
            out.push(segP(m));
            const note = lateNote(lateRecords, m.name);
            if (note) out.push(segInfo(note));
        });
    }
    const supporters = (t.members || []).filter(m => m && m.role === 'support' && m.name);
    const vehSupport = t.supportVehicleIds || [];
    if (supporters.length || vehSupport.length) {
        out.push(segLabel('دعم'));
        supporters.forEach(m => {
            out.push(segP(m));
            const home = findHomeTeam(teams, m.name, teamName) || m.fromCenter || null;
            const tLabel = PDF_COVERAGE_LABELS[m.coverageType] || PDF_SUPPORT_LABELS[m.supportType] || null;
            const info = [home ? 'قادم من: ' + home : null, tLabel ? 'النوع: ' + tLabel : null].filter(Boolean).join(' • ');
            if (info) out.push(segInfo(info));
        });
        vehSupport.forEach(id => {
            const v = vehMap[String(id)];
            const vName = (v && v.name) ? v.name : String(id);
            const home = homeTeamOfVehicle(teams, id, teamName);
            out.push(segText('دعم مركبة: ' + vName + (home ? ' (من ' + home + ')' : '')));
        });
    }
    return out;
}

// doc-v2: تركيب الكادر الحاضر — عدّادات التخصص (أساسي نشط + داعمون) لملخص القوى
function crewComposition(teams) {
    const counts = {};
    Object.keys(teams || {}).forEach(n => {
        ((teams[n] && teams[n].members) || []).forEach(m => {
            if (!m) return;
            if (m.state !== 'active' && m.role !== 'support') return;
            const jt = m.jobTitle || 'غير محدد';
            counts[jt] = (counts[jt] || 0) + 1;
        });
    });
    const parts = Object.keys(counts)
        .sort((a, b) => counts[b] - counts[a] || a.localeCompare(b, 'ar'))
        .map(jt => jt + ' ' + counts[jt]);
    return parts.length ? parts.join(' • ') : '—';   // doc-v4 ⑪: فاصل موحد «•» في كل الوثيقة
}

const FIELD_LABELS = [
    ['summary', 'ملخص المناوبة'],
    ['operationalNotes', 'الملاحظات التشغيلية'],
    ['keyEvents', 'أبرز الأحداث'],
    ['issues', 'المشاكل التشغيلية'],
    ['recommendations', 'التوصيات']
];

// ═══════════════════════════════════════════════════════════
// تفويض «المرحلة الأخيرة قبل الاعتماد الرسمي» (2026-08) — بند ④:
// بيانات «تسجيلات خروج الفرق» للـPDF تُبنى من حقول اللقطة نفسها
// (snapshot.signouts — المالك الوحيد SignoutService، المصدر المشترك مع عرض
// سير العمل الرسمي وصفحة التكميل والتفاصيل والأرشيف). لا استعلام مستقل ولا
// إعادة اشتقاق من roster المجدول: الأعضاء هم من سجّل خروجهم فعلًا، بأكوادهم
// ومسمياتهم (memberDetails)، مع وقت الخروج والمستخدم المسجِّل.
// ═══════════════════════════════════════════════════════════
function buildPdfSignouts(snapshot) {
    const list = (snapshot && Array.isArray(snapshot.signouts)) ? snapshot.signouts : [];
    return list.map(so => {
        const details = (Array.isArray(so.memberDetails) && so.memberDetails.length)
            ? so.memberDetails
            : (Array.isArray(so.members) ? so.members : []).map(n => ({ name: n, code: null, jobTitle: null }));
        return {
            team: so.team || '',
            members: details.filter(m => m && m.name).map(m => ({
                name: m.name || '', code: m.code || null, jobTitle: m.jobTitle || null
            })),
            signoutTime: so.createdAt || null,
            recordedBy: so.recordedByName || '',
            notes: so.notes || ''
        };
    }).filter(r => r.team);
}

// ═══════════════════════════════════════════════════════════
// التوليد — يرفض Promise عند أي فشل (لا اعتماد بلا PDF)
// ═══════════════════════════════════════════════════════════
function generateWorkflowPdf(workflow) {
    return (async () => {
    // doc-v5 (W-4 المبكرة): QR تحقق = المرجع + بصمة SHA-256 — اختياري تمامًا:
    // غياب المكتبة أو فشل التوليد لا يسقط الوثيقة (يُرسم الصندوق بلا QR).
    let qrBuf = null;
    try {
        const QRCode = require('qrcode');
        const payload = String(workflow.refNo || '') + '|' + String(workflow.contentHash || '');
        qrBuf = await QRCode.toBuffer(payload, { errorCorrectionLevel: 'M', margin: 1, width: 200 });
    } catch (_) { qrBuf = null; }
    return new Promise((resolve, reject) => {
        let absPath = null;
        try {
            fs.mkdirSync(STORAGE_DIR, { recursive: true });
            const refNo = workflow.refNo;
            if (!refNo) throw new Error('refNo مطلوب لتوليد PDF');
            const fileName = refNo + '.pdf';
            absPath = path.join(STORAGE_DIR, fileName);
            const relPath = 'data/archives/workflows/' + fileName; // نسبي من جذر المشروع

            const snap = workflow.snapshot || {};
            const shift = snap.shift || {};
            const teams = (snap.staffing && snap.staffing.teams) || {};
            const wfd = (snap.staffing && snap.staffing.workforce) || {};
            const board = snap.vehicles || {};
            const lateRecords = snap.lateRecords;
            const fields = workflow.fields || {};

            const vehMap = {};
            (board.vehicles || []).forEach(v => { if (v && v.id != null) vehMap[String(v.id)] = v; });
            (board.unassigned || []).forEach(v => { if (v && v.id != null) vehMap[String(v.id)] = v; });

            const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: 'سير العمل الرسمي — ' + refNo } });
            const stream = fs.createWriteStream(absPath);
            stream.on('error', reject);
            doc.pipe(stream);
            doc.registerFont('amiri', FONT_PATH);
            doc.font('amiri');

            const PAGE_W = doc.page.width;   // 595.28
            const PAGE_H = doc.page.height;  // 841.89
            const M = 40;
            const CW = PAGE_W - 2 * M;
            let y = M;

            const BLUE = '#1e3a8a', GRAY = '#475569', MUTED = '#64748b', BORDER = '#cbd5e1';

            // نص عربي بمحاذاة يمين — features:{} دائمًا (القاعدة الحرجة)
            function tr(txt, x, yy, w, opts) {
                doc.text(ar(String(txt)), x, yy, Object.assign({ width: w, align: 'right', features: {} }, opts || {}));
            }
            function need(h) {
                if (y + h > PAGE_H - 70) { doc.addPage(); y = M; }
            }
            function heading(txt) {
                need(26);
                y += 8;
                doc.font('amiri').fontSize(11).fillColor(BLUE);
                tr(txt, M, y, CW);
                y += 16;
                doc.moveTo(M, y).lineTo(M + CW, y).lineWidth(0.7).strokeColor(BLUE).stroke();
                y += 4;
            }
            function para(txt, size, color) {
                doc.font('amiri').fontSize(size || 9).fillColor(color || '#0f172a');
                const lines = String(txt).split('\n');
                lines.forEach(line => {
                    const h = doc.heightOfString(ar(line), { width: CW, features: {} }) + 3;
                    need(h);
                    tr(line, M, y, CW, { lineGap: 2 });
                    y += h;
                });
            }
            // ─── doc-v3b: قياس فعلي لكل شخص سيُرسم — ضمان السطر الواحد ───
            // إن تجاوز أي مقطع عموده الفرعي (حالة مرضية خارج قياس القاعدة) يُخفَّض
            // خط الأشخاص تناسبيًا (حد أدنى 7pt)، وlineBreak:false يمنع الالتفاف أبدًا.
            function measurePersonsFont() {
                const all = [];
                Object.keys(teams).forEach(n => ((teams[n] && teams[n].members) || []).forEach(m => { if (m) all.push(m); }));
                (Array.isArray(lateRecords) ? lateRecords : []).forEach(r => { if (r) all.push({ jobTitle: r.jobTitle, name: r.employee, code: r.code }); });
                let maxJ = 0, maxN = 0, maxC = 0;
                doc.font('amiri').fontSize(PS);
                all.forEach(p => {
                    maxJ = Math.max(maxJ, doc.widthOfString(ar((p && p.jobTitle) || '—'), { features: {} }));
                    maxN = Math.max(maxN, doc.widthOfString(ar((p && p.name) || '—'), { features: {} }));
                    if (p && p.code) maxC = Math.max(maxC, doc.widthOfString(String(p.code), { features: {} }));
                });
                const sc = Math.min(1, SUB_JOB / Math.max(maxJ, 1), SUB_NAME / Math.max(maxN, 1), SUB_CODE / Math.max(maxC, 1));
                return Math.max(7, PS * sc);
            }
            const psEff = measurePersonsFont();
            doc.font('amiri').fontSize(psEff);
            const PH = doc.heightOfString(ar('أغ'), { features: {} }) + 1.5; // ارتفاع سطر الشخص الثابت (doc-v4 ⑥)

            // جدول: headers/rows (كل خلية مصفوفة أسطر) — RTL: العمود الأول يمين
            // doc-v3b: سطر الشخص يُرسم كـ3 مقاطع بمواضع x ثابتة + فاصلان «|» مصطفّان
            // رأسيًا في كل أسطر الأشخاص بالوثيقة. أسطر الخلايا كائنات segP/segInfo/
            // segLabel/segText أو سلاسل نصية عادية (خلايا الفرقة/الحالة والجداول الأخرى).
            // Keep Together: ارتفاع الصف يُحسب بنفس صيغة الرسم حرفيًا (lineH هو
            // المعيار الوحيد)، والصف كاملًا ينتقل لصفحة جديدة — لا صف مقسوم أبدًا.
            // doc-v5 ①: + عتبة انتقال كامل للجدول + إعادة الترويسة عند الامتداد.
            function table(headers, rows, colWs, opts) {
                opts = opts || {};
                const x0 = M;
                function isSeg(l) { return l && typeof l === 'object'; }
                // رسم سطر شخص: يمين→يسار [مسمى 52][| 7][اسم 101][| 7][كود 26]
                // doc-v4 ⑤: التسلسل البصري — الاسم الأبرز (حبري)، المسمى رمادي بنفس
                // الحجم، الكود رمادي وأصغر نصف درجة؛ الفاصلة رمادية فاتحة.
                function drawPerson(line, x, ly, w) {
                    const right = x + w - 4;
                    const jobX = right - SUB_JOB;
                    const sep1X = jobX - SUB_SEP;
                    const nameX = sep1X - SUB_NAME;
                    const sep2X = nameX - SUB_SEP;
                    const codeX = sep2X - SUB_CODE;
                    doc.font('amiri').fontSize(psEff).fillColor(GRAY);
                    if (line.job) tr(line.job, jobX, ly, SUB_JOB, { lineBreak: false });
                    doc.font('amiri').fontSize(psEff).fillColor('#0f172a');
                    tr(line.name, nameX, ly, SUB_NAME, { lineBreak: false });
                    if (line.code) {
                        doc.font('amiri').fontSize(Math.max(6.5, psEff - 0.5)).fillColor(MUTED);
                        tr(line.code, codeX, ly + 0.5, SUB_CODE, { lineBreak: false });
                    }
                    doc.font('amiri').fontSize(psEff).fillColor(MUTED);
                    doc.text('|', sep1X, ly, { width: SUB_SEP, align: 'center', lineBreak: false, features: {} });
                    doc.text('|', sep2X, ly, { width: SUB_SEP, align: 'center', lineBreak: false, features: {} });
                }
                // قياس ارتفاع سطر — الصيغة نفسها المستخدمة في الرسم حرفيًا
                // doc-v4 ⑥: هوامش ارتفاع مضغوطة بأمان (+1.5 للسطر، +6 للخلية)
                function lineH(line, w, size) {
                    if (isSeg(line)) {
                        if (line.k === 'p') return PH;
                        doc.font('amiri').fontSize(psEff);
                        return doc.heightOfString(ar(line.t), { width: w - 8, features: {} }) + 1.5;
                    }
                    doc.font('amiri').fontSize(size);
                    return doc.heightOfString(ar(line), { width: w - 8, features: {} }) + 1.5;
                }
                function drawCellLine(line, x, ly, w, size) {
                    if (isSeg(line)) {
                        if (line.k === 'p') { drawPerson(line, x, ly, w); return; }
                        if (line.k === 'l') doc.font('amiri').fontSize(psEff).fillColor(BLUE);
                        else if (line.k === 'i') doc.font('amiri').fontSize(psEff).fillColor(GRAY);
                        else doc.font('amiri').fontSize(psEff).fillColor('#0f172a');
                        tr(line.t, x + 4, ly, w - 8);
                        return;
                    }
                    doc.font('amiri').fontSize(size).fillColor('#0f172a');
                    tr(line, x + 4, ly, w - 8);
                }
                function cellH(lines, w, size) {
                    let h = 0;
                    (lines.length ? lines : []).forEach(l => { h += lineH(l, w, size); });
                    return Math.max(h + 6, 18);
                }
                // ترويسة — دالة قابلة للتكرار (doc-v5 ①: تُعاد في كل صفحة يمتد إليها الجدول)
                let hh = 0;
                headers.forEach((h, i) => { hh = Math.max(hh, cellH([h], colWs[i], 8.5)); });
                function drawHeader() {
                    doc.rect(x0, y, CW, hh).fill('#eff6ff');
                    let x = x0 + CW;
                    headers.forEach((h, i) => {
                        x -= colWs[i];
                        doc.font('amiri').fontSize(8.5).fillColor(BLUE);
                        tr(h, x + 4, y + 3, colWs[i] - 8);
                    });
                    y += hh;
                    doc.moveTo(x0, y).lineTo(x0 + CW, y).lineWidth(1).strokeColor(BORDER).stroke();
                }
                // doc-v5 ① Keep-table-together بعتبة: إن لم يتسع المتبقي من الصفحة
                // لترويسة الجدول + 3 صفوف على الأقل انتقل الجدول كاملًا للصفحة
                // التالية — ممنوع «صف يتيم» بلا ترويسة أعلى صفحة جديدة.
                let probe = hh;
                rows.slice(0, 3).forEach(row => {
                    let prh = 0;
                    row.forEach((cell, i) => { prh = Math.max(prh, cellH(cell, colWs[i], 8)); });
                    probe += prh;
                });
                if (y + probe + 26 > PAGE_H - 70) { doc.addPage(); y = M; }
                drawHeader();
                // صفوف — Keep Together: الصف كاملًا ينتقل لصفحة جديدة (لا تقسيم)،
                // وعند الانتقال يُعاد عنوان القسم (إن طُلب) ثم ترويسة الأعمدة.
                rows.forEach(row => {
                    let rh = 0;
                    row.forEach((cell, i) => { rh = Math.max(rh, cellH(cell, colWs[i], 8)); });
                    if (y + rh + 8 > PAGE_H - 70) {
                        doc.addPage(); y = M;
                        if (opts.onNewPage) opts.onNewPage();
                        drawHeader();
                    }
                    let cx = x0 + CW;
                    row.forEach((cell, i) => {
                        cx -= colWs[i];
                        let ly = y + 3;
                        (cell.length ? cell : []).forEach(line => {
                            drawCellLine(line, cx, ly, colWs[i], 8);
                            ly += lineH(line, colWs[i], 8);
                        });
                    });
                    y += rh;
                    doc.moveTo(x0, y).lineTo(x0 + CW, y).lineWidth(0.5).strokeColor(BORDER).stroke();
                });
            }

            // ═══ الترويسة الحكومية ═══
            try {
                if (fs.existsSync(LOGO_PATH)) doc.image(LOGO_PATH, PAGE_W - M - 58, y, { width: 58, height: 58 });
            } catch (_) { /* الشعار اختياري */ }
            doc.font('amiri').fontSize(9).fillColor(MUTED);
            tr('المملكة العربية السعودية', M, y + 2, CW - 70);
            doc.font('amiri').fontSize(13).fillColor(BLUE);
            tr('هيئة الهلال الأحمر السعودي', M, y + 16, CW - 70);
            doc.font('amiri').fontSize(9.5).fillColor(GRAY);
            tr('الإدارة العامة للخدمات الإسعافية — قطاع جنوب الرياض', M, y + 34, CW - 70);
            doc.font('amiri').fontSize(11.5).fillColor(BLUE);
            tr('سير العمل الرسمي لبداية المناوبة', M, y + 48, CW - 70);
            y += 68;

            // شارة «وثيقة رسمية معتمدة» + المرجع والإصدار
            doc.roundedRect(M, y, CW, 26, 5).fill('#dcfce7');
            doc.font('amiri').fontSize(10).fillColor('#16a34a');
            tr('وثيقة رسمية معتمدة', M + 8, y + 7, 130);
            doc.font('amiri').fontSize(10).fillColor('#0f172a');
            tr('المرجع: ' + refNo + '   •   الإصدار: V' + (workflow.versionNo != null ? workflow.versionNo : '') + '   •   التاريخ: ' + (shift.date || ''), M + 8, y + 7, CW - 16);
            y += 32;
            // خط فاصل مزدوج
            doc.moveTo(M, y).lineTo(M + CW, y).lineWidth(1.5).strokeColor(BLUE).stroke();
            doc.moveTo(M, y + 3).lineTo(M + CW, y + 3).lineWidth(0.5).strokeColor(BLUE).stroke();
            y += 10;

            // ═══ أولًا: بيانات المناوبة ═══
            heading('أولًا: بيانات المناوبة');
            table(
                ['النوع', 'التاريخ', 'البداية', 'النهاية', 'رقم المناوبة', 'وقت إنشاء اللقطة'],
                [[
                    [shift.type || ''], [shift.date || ''], [fTime(shift.startedAt || shift.plannedStartAt)],
                    [fTime(shift.endedAt || shift.plannedEndAt)], [shift.id != null ? String(shift.id) : ''], [fDateTime(snap.takenAt)]
                ]],
                [70, 90, 70, 70, 100, 115]
            );

            // ═══ ثانيًا: جاهزية الفرق والكادر ═══
            heading('ثانيًا: جاهزية الفرق والكادر');
            // doc-v4 ⑫: الترتيب موروث من الفرز المركزي (staffing-events-service) —
            // لا فرز محلي هنا (رقمي طبيعي: جنوب 1..19 ثم سريع 1..4)
            const teamNames = Object.keys(teams);
            if (!teamNames.length) {
                para('— لا توجد بيانات فرق في اللقطة —', 9, MUTED);
            } else {
                const rows = teamNames.map(name => {
                    const t = teams[name] || {};
                    const g = memberGroups(t);
                    const reasons = teamReasons(t);
                    const statusCell = [teamStatusLabel(t.status)];
                    reasons.forEach(r => statusCell.push(r));
                    return [
                        // doc-v4 ④: اسم المركز سطرًا ثانيًا أصغر وبلون رمادي — التركيز على «جنوب 1»
                        t.center ? [name, segInfo('(' + t.center + ')')] : [name],
                        statusCell,
                        personsCell(g.active),
                        exceptionsCell(teams, vehMap, t, name, g, lateRecords)
                    ];
                });
                // doc-v4 ⑦: الترتيب الرسمي — الفرقة | الحالة | الكادر الأساسي | الاستثناءات
                // (4 أعمدة؛ الكادر والاستثناءات بعرض عمود الأشخاص الكامل 201 = كتلة 193 + حشو 8)
                table(
                    ['الفرقة', 'الحالة', 'الكادر الأساسي', 'الاستثناءات'],
                    rows,
                    [45, 68, PERSON_COL_W, PERSON_COL_W]
                );
            }

            // ═══ ثالثًا: المركبات ═══
            heading('ثالثًا: المركبات');
            const vehRows = (board.vehicles || []).map(v => {
                let teamName = '';   // doc-v4 ②: فراغ بدل «—»
                for (const n of Object.keys(teams)) {
                    if (teams[n] && teams[n].vehicleId != null && String(teams[n].vehicleId) === String(v.id)) { teamName = n; break; }
                }
                // doc-v5 ③: السبب موسومًا «سبب: …» في عمود الملاحظات لأي حالة لها
                // سبب (كان سطرًا مجردًا مبتورًا ومكررًا بين خليتين) — موضع واحد واضح.
                return [[v.name || String(v.id)], [vehStatusLabel(v.status)], [teamName],
                        [v.reason ? 'سبب: ' + String(v.reason) : '']];
            });
            if (vehRows.length) {
                // doc-v5 ①: عتبة الانتقال الكامل مدمجة في table() + إعادة عنوان
                // القسم وترويسة الأعمدة تلقائيًا إن امتد الجدول عبر صفحات.
                table(['المركبة', 'الحالة', 'الفريق', 'الملاحظات'], vehRows, [90, 90, 150, 185],
                    { onNewPage: () => heading('ثالثًا: المركبات') });
            } else {
                para('— لا توجد مركبات معيّنة في اللقطة —', 9, MUTED);
            }
            const unassigned = (board.unassigned || []).length;
            if (unassigned) para('مركبات غير معيّنة: ' + unassigned, 8.5, MUTED);

            // ═══ رابعًا: ملخص القوى البشرية ═══
            heading('رابعًا: ملخص القوى البشرية');
            const incomplete = (typeof wfd.missingTeams === 'number' || typeof wfd.offlineTeams === 'number')
                ? String((wfd.missingTeams || 0) + (wfd.offlineTeams || 0)) : '';
            // UAT-1: تسميات التقسيم الجديد (القوى البشرية ثم الجاهزية التشغيلية).
            // اللقطات المجمدة قبل هذا التحديث تفتقد الحقول الجديدة ⇒ تُعرض فراغًا.
            const opRate = wfd.operationalReadinessRate != null ? wfd.operationalReadinessRate : wfd.readinessRate;
            table(
                ['الكادر المجدول', 'الكادر الحاضر', 'الغياب', 'الدعم المؤقت', 'الفرق المطلوبة', 'الفرق الجاهزة', 'الفرق غير المكتملة', 'نسبة الجاهزية'],
                [[
                    [String(wfd.scheduledStaff != null ? wfd.scheduledStaff : '')],
                    [String(wfd.totalStaff != null ? wfd.totalStaff : '')],
                    [String(wfd.absentees != null ? wfd.absentees : '')],
                    [String(wfd.supporters != null ? wfd.supporters : '')],
                    [String(wfd.requiredTeams != null ? wfd.requiredTeams : '')],
                    [String(wfd.readyTeams != null ? wfd.readyTeams : '')],
                    [incomplete],
                    [opRate != null ? opRate + '%' : '']
                ]],
                [62, 62, 50, 62, 66, 62, 76, 75]
            );
            // doc-v5 ⑤: المسمى الرسمي — «الكادر الحاضر حسب التصنيف الوظيفي»
            para('الكادر الحاضر حسب التصنيف الوظيفي: ' + crewComposition(teams), 9, GRAY);

            // ═══ خامسًا: ملخص المناوبة وحقول المشرف ═══
            heading('خامسًا: ملخص المناوبة والملاحظات');
            FIELD_LABELS.forEach(([key, label]) => {
                // doc-v5 ⑥: «☑»/«☐» ليستا في تغطية Amiri (تظهران مربعًا) — تُعرضان «√»/«—» عرضيًا فقط
                const v = fields[key] && String(fields[key]).trim()
                    ? String(fields[key]).replace(/☑/g, '√').replace(/☐/g, '—')
                    : '—';
                doc.font('amiri').fontSize(9).fillColor(BLUE);
                need(16);
                tr(label + ':', M, y, CW);
                y += 13;
                para(v, 9);
                y += 3;
            });
            if (snap.completionNotes && String(snap.completionNotes).trim()) {
                doc.font('amiri').fontSize(9).fillColor(BLUE);
                need(16);
                tr('ملاحظات التكميل:', M, y, CW);
                y += 13;
                para(String(snap.completionNotes), 9);
                y += 3;
            }
            // doc-v4 ⑨: المسميات الإدارية المصححة + الجهات الثلاث بالترتيب الرسمي (خانات توقيع)
            const reviewed = Array.isArray(fields.reviewedBy) ? fields.reviewedBy : [];
            const reviewers = ['قائد المنطقة', 'كبير المسعفين', 'الإداري المناوب'];
            para('تمت مراجعة واعتماد الوثيقة من قبل: ' + reviewers.map(r => (reviewed.indexOf(r) !== -1 ? '(√) ' : '( ) ') + r).join('   '), 8.5, GRAY);

            // ═══ سادسًا: تسجيلات خروج الفرق — من حقول اللقطة نفسها (بند ④) ═══
            // نفس سجل عرض سير العمل الرسمي: الفرقة | الأفراد (مسمى|اسم|كود) |
            // وقت الخروج | المسجِّل. بلا تسجيلات يُخفى القسم بهدوء (اللقطات
            // القديمة بلا signouts تبقى وثائقها كما اعتُمدت حرفيًا).
            const signoutRows = buildPdfSignouts(snap);
            if (signoutRows.length) {
                heading('سادسًا: تسجيلات خروج الفرق');
                table(
                    ['الفرقة', 'أفراد الفرقة', 'وقت الخروج', 'سُجِّل بواسطة'],
                    signoutRows.map(r => [
                        [r.team],
                        personsCell(r.members),
                        [fDateTime(r.signoutTime)],
                        [r.recordedBy]
                    ]),
                    [90, PERSON_COL_W, 110, CW - 90 - PERSON_COL_W - 110]
                );
            }

            // ═══ قسم الختم ═══
            // doc-v5 ④: بنية أسطر صريحة في عمودين (إعداد يمينًا / اعتماد يسارًا) —
            // تبقى واضحة عندما يختلف المُعِد عن المُعتمد. QR التحقق يسار الصندوق.
            need(122);
            y += 8;
            const sealH = 106;
            doc.roundedRect(M, y, CW, sealH, 6).lineWidth(1).strokeColor(BLUE).stroke();
            doc.font('amiri').fontSize(10).fillColor(BLUE);
            tr('الختم والاعتماد', M + 10, y + 8, CW - 20);
            if (qrBuf) { try { doc.image(qrBuf, M + 12, y + 24, { width: 70, height: 70 }); } catch (_) {} }
            const txtX = qrBuf ? M + 94 : M + 10;   // منطقة النص (يمين QR إن وُجد)
            const txtW = CW - (txtX - M) - 10;
            const colW = (txtW - 12) / 2;
            const colR = txtX + colW + 12;          // العمود الأيمن: إعداد الوثيقة
            const colL = txtX;                      // العمود الأيسر: اعتماد الوثيقة
            doc.font('amiri').fontSize(9.5).fillColor(BLUE);
            tr('إعداد الوثيقة', colR, y + 27, colW);
            tr('اعتماد الوثيقة', colL, y + 27, colW);
            doc.font('amiri').fontSize(9).fillColor('#0f172a');
            tr('الاسم: ' + (workflow.createdBy || ''), colR, y + 41, colW);
            tr('الوقت: ' + fDateTime(workflow.createdAt), colR, y + 54, colW);
            tr('الاسم: ' + (workflow.approvedBy || ''), colL, y + 41, colW);
            tr('الوقت: ' + fDateTime(workflow.approvedAt), colL, y + 54, colW);
            tr('الرقم المرجعي: ' + refNo, txtX, y + 71, txtW);
            const shortHash = workflow.contentHash ? workflow.contentHash.slice(0, 16) + '…' : '';
            doc.font('amiri').fontSize(8).fillColor(MUTED);
            tr('بصمة المحتوى (SHA-256): ' + shortHash, txtX, y + 85, txtW);
            y += sealH + 12;

            // ═══ Footer ═══
            need(36);
            doc.moveTo(M, y).lineTo(M + CW, y).lineWidth(1).strokeColor(BLUE).stroke();
            y += 6;
            doc.font('amiri').fontSize(7.5).fillColor(MUTED);
            tr('هذه الوثيقة أُنشئت إلكترونيًا من منصة إدارة العمليات الإسعافية – قطاع جنوب الرياض', M, y, CW);
            y += 11;
            tr('وثيقة معتمدة ومقفلة – أي تعديل يتطلب إعادة إصدار موثقة • ' + refNo, M, y, CW);

            doc.end();
            stream.on('finish', () => resolve({ absPath, relPath }));
        } catch (e) {
            // فشل التوليد — نظّف أي ملف جزئي
            try { if (absPath && fs.existsSync(absPath)) fs.unlinkSync(absPath); } catch (_) {}
            reject(e);
        }
    });
    })();
}

module.exports = { generateWorkflowPdf, buildPdfSignouts, STORAGE_DIR };
