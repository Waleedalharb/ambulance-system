'use strict';
// ═══════════════════════════════════════════════════════════════════
// A-3.6: Pre-Deploy Gate — بوابة أمان إلزامية قبل أي نشر.
// READ-ONLY على المشروع والبيانات (الاختبارات تشتغل على نسخ مؤقتة معزولة).
// الاستخدام:
//   node scripts/pre-deploy-gate.js --target scripts/peak-ssot-test.js
//        [--target scripts/another-test.js] [--regression-output file.txt]
// القاعدة: لا نشر إلا بـ GATE: PASS — أي FAIL يوقف القرار فورًا مع السبب.
// ═══════════════════════════════════════════════════════════════════
const { spawn, spawnSync, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;

// ─── الـ baseline الثابت المعتمد (يُحدَّث فقط بقرار مالك المنصة) ───
// محدَّث 2026-10-05 (قرار المالك): 160/12 بعد دخول 3cdf0b7 إلى origin/main —
// CHAT_DISABLED=true (قرار مالك موثق في server.js: «تعطيل المحادثة الخاصة»)
// يُفشل فحصَي المحادثة عمدًا: بطارية القراءة على /api/chat/* ← 403 CHAT_DISABLED،
// و«إنشاء/فتح محادثة خاصة» تبعًا لها. الفشلون العشرة الأوائل أقدم من ذلك وثابتون.
const BASELINE = {
    pass: 160,
    knownFailures: ['W1-B ①', 'W1-B ②', 'W1-B ④', 'V-B ⑪', 'V-B ⑫', 'V-B ②④', 'V-B ②⑦', 'F6 ④', 'SR-1 ①', 'SR-1 ⑨'],
    knownCrash: 'EMPTY_PERIODS_GUARD',
    // فشلا CHAT_DISABLED بأنماط مثبتة من الطرفين: أي فشل إضافي داخل بطارية
    // القراءة (غير مسارات /api/chat/* الثلاثة بالضبط) أو تغيّر سبب فشل المحادثة
    // يكسر التطابق ويُحسب فشلًا جديدًا — لا تبييض صامت لأعطال مستقبلية.
    knownFailurePatterns: [
        /^بطارية القراءة \(\d+\/\d+\) — \/api\/chat\/users→403 \| \/api\/chat\/conversations→403 \| \/api\/chat\/online→403$/,
        /^إنشاء\/فتح محادثة خاصة — لا يوجد مستخدم آخر$/
    ]
};

// المخازن المُرحَّلة إلى SQLite SSOT (JSON الخاص بها مجمّد: لا قراءة حية ولا كتابة)
const MIGRATED_STORES = [
    { name: 'announcements', reader: 'readAnnouncements', pathConst: 'ANNOUNCEMENTS_PATH', file: 'announcements.json' },
    { name: 'shift-data', reader: 'readShifts', pathConst: 'SHIFT_DATA_PATH', file: 'shift-data.json' },
    { name: 'peak-data', reader: 'readPeakData', pathConst: 'PEAK_DATA_PATH', file: 'peak-data.json' }
];

// سجل الاستثناءات المعتمدة لفحص DROP TABLE — إضافة أي استثناء جديد تحتاج
// قرار مالك موثقًا هنا بالسبب والتاريخ. ما لم يكن مدرجًا هنا أو داخل إعادة
// بناء محروسة (foreign_keys=OFF) ⇒ FAIL.
const APPROVED_DROP_EXCEPTIONS = [
    { table: 'daily_reports', reason: 'F4 (معتمد سابقًا): مخزن ميت استُبدل بالتقرير المشتق — DROP IF EXISTS idempotent بلا FK واردة، داخل try/catch موثق' }
];

const EXPECTED_ROUTES = [
    "app.get('/api/peak-data'", "app.post('/api/peak-mission'", "app.post('/api/peak-resolve'", "app.delete('/api/peak-mission/:id'",
    "app.get('/api/announcements'", "app.post('/api/announcements'", "app.delete('/api/announcements/:id'", "app.post('/api/announcements/add'"
];
const EXPECTED_MAPPERS = ['mapPeakMissionRow', 'mapPeakAlertRow', 'mapPeakLogRow'];
const REQUIRED_TABLES = ['shifts', 'users', 'reports', 'announcements', 'peak_missions', 'peak_alerts', 'peak_logs',
    'peak_plans', 'notifications', 'employees', 'teams', 'leave_requests', 'app_settings'];

// ─── وسائط التشغيل ───
const args = process.argv.slice(2);
const targets = [];
let regressionOutputFile = null;
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--target' && args[i + 1]) targets.push(path.resolve(ROOT, args[++i]));
    else if (args[i] === '--regression-output' && args[i + 1]) regressionOutputFile = path.resolve(ROOT, args[++i]);
}

const results = [];
function report(check, pass, detail) {
    results.push({ check, pass, detail });
    console.log((pass ? '✅ PASS' : '❌ FAIL') + ' [' + check + ']' + (detail ? ' — ' + detail : ''));
}
function runNode(script, timeoutMs) {
    const r = spawnSync(NODE, [script], { cwd: ROOT, encoding: 'utf8', timeout: timeoutMs || 280000, maxBuffer: 64 * 1024 * 1024 });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), error: r.error };
}

async function main() {
    console.log('═══ PRE-DEPLOY GATE — ' + new Date().toISOString() + ' ═══\n');

    // ─── 1) Git status ───
    try {
        const st = execSync('git status --short', { cwd: ROOT, encoding: 'utf8' });
        const lines = st.split('\n').filter(Boolean);
        const forbidden = lines.filter(l => /database\.js|db\/migrate\.js/.test(l));
        report('1 GIT_STATUS', forbidden.length === 0,
            lines.length + ' ملفًا متغيرًا/غير متتبع (موثق أدناه)' + (forbidden.length ? ' — ممنوع: ' + forbidden.join(',') : ''));
        lines.forEach(l => console.log('    ' + l));
    } catch (e) {
        report('1 GIT_STATUS', false, 'فشل git: ' + e.message);
    }

    // ─── 2) Targeted tests ───
    if (!targets.length) {
        report('2 TARGETED_TESTS', false, 'لم يُحدَّد --target — البوابة تتطلب اختبار البند صراحة');
    } else {
        for (const t of targets) {
            if (!fs.existsSync(t)) { report('2 TARGETED_TESTS', false, 'سكربت مفقود: ' + t); continue; }
            console.log('  … تشغيل ' + path.basename(t));
            const r = runNode(t);
            const m = r.out.match(/نجح: (\d+) \| ❌ فشل: (\d+)/);
            report('2 TARGETED_TESTS', r.code === 0 && !!m && m[2] === '0',
                path.basename(t) + (m ? ` — ${m[1]} نجح / ${m[2]} فشل` : ' — exit=' + r.code));
        }
    }

    // ─── 3+4) Full regression + Baseline comparison ───
    let regOut = null;
    if (regressionOutputFile && fs.existsSync(regressionOutputFile)) {
        regOut = fs.readFileSync(regressionOutputFile, 'utf8');
        console.log('  … قراءة ناتج انحدار محفوظ: ' + path.basename(regressionOutputFile));
    } else {
        console.log('  … تشغيل الانحدار الكامل (قد يستغرق دقائق)');
        const r = runNode(path.join(ROOT, 'scripts', 'run-regression-isolated.js'), 280000);
        regOut = r.out;
    }
    if (!regOut || regOut.length < 100) {
        report('3 FULL_REGRESSION', false, 'لا ناتج للانحدار');
        report('4 BASELINE_COMPARE', false, 'لا ناتج للمقارنة');
    } else {
        const passCount = (regOut.match(/✅/g) || []).length;
        const failLines = regOut.split('\n').filter(l => l.includes('❌'));
        report('3 FULL_REGRESSION', passCount > 0, passCount + ' ✅ / ' + failLines.length + ' ❌');
        const newFailures = failLines
            .map(l => l.replace(/^.*?❌\s*/, '').split(':')[0].trim())
            .filter(name => !BASELINE.knownFailures.some(k => name.startsWith(k)))
            .filter(name => !(BASELINE.knownFailurePatterns || []).some(rx => rx.test(name)));
        const crashKnown = regOut.includes(BASELINE.knownCrash);
        const ok = passCount >= BASELINE.pass && newFailures.length === 0 && crashKnown;
        report('4 BASELINE_COMPARE', ok,
            `pass=${passCount}/${BASELINE.pass} · إخفاقات جديدة=${newFailures.length ? newFailures.join(' | ') : 'لا شيء'} · تعطل ${BASELINE.knownCrash}=${crashKnown ? 'كما هو معروف' : 'غائب!'}`);
    }

    // ─── 5) SQLite schema ───
    try {
        const Database = require('better-sqlite3');
        const db = new Database(path.join(ROOT, 'data', 'ambulance.db'), { readonly: true, fileMustExist: true });
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
        const missing = REQUIRED_TABLES.filter(t => !tables.includes(t));
        const pmCols = db.prepare('PRAGMA table_info(peak_missions)').all().map(c => c.name);
        const legacyPeak = pmCols.includes('mission_id');
        const qc = db.prepare('PRAGMA quick_check').get();
        db.close();
        const problems = [];
        if (missing.length) problems.push('جداول مفقودة: ' + missing.join(','));
        if (legacyPeak) problems.push('peak_missions بالمخطط التاريخي (mission_id) — يحتاج إقلاعًا لتفعيل إعادة البناء');
        if (qc.quick_check !== 'ok') problems.push('quick_check=' + qc.quick_check);
        // مخطط peak التاريخي المحلي معروف ومغطى بإعادة البناء — تحذير لا فشل
        const hardFail = missing.length > 0 || qc.quick_check !== 'ok';
        report('5 SQLITE_SCHEMA', !hardFail, problems.length ? problems.join(' · ') : REQUIRED_TABLES.length + ' جدولًا مطلوبًا موجود + quick_check=ok');
    } catch (e) {
        report('5 SQLITE_SCHEMA', false, e.message);
    }

    // ─── 6) Migration inspection (db.js استاتيكيًا) ───
    try {
        const src = fs.readFileSync(path.join(ROOT, 'db.js'), 'utf8');
        const violations = [];
        const createRe = /CREATE TABLE(?! IF NOT EXISTS)(?:\s+)(?!IF NOT EXISTS)(\w+)/g;
        let m;
        while ((m = createRe.exec(src))) {
            if (!m[1].endsWith('_new')) violations.push('CREATE TABLE بلا IF NOT EXISTS: ' + m[1]);
        }
        const dropRe = /DROP TABLE(?: IF EXISTS)? (\w+)/g;
        const exceptions = [];
        while ((m = dropRe.exec(src))) {
            const before = src.slice(Math.max(0, m.index - 3000), m.index);
            const fkOff = before.lastIndexOf("foreign_keys = OFF");
            const fkOn = before.lastIndexOf("foreign_keys = ON");
            if (fkOff > -1 && fkOff > fkOn) continue; // إعادة بناء محروسة
            const ex = APPROVED_DROP_EXCEPTIONS.find(e => e.table === m[1]);
            if (ex) { exceptions.push(m[1] + ' — ' + ex.reason); continue; }
            violations.push('DROP TABLE بلا حارس foreign_keys=OFF ولا استثناء معتمد: ' + m[1]);
        }
        report('6 MIGRATION_INSPECTION', violations.length === 0,
            violations.length ? violations.join(' | ')
                : 'كل CREATE محمي بـ IF NOT EXISTS وكل DROP محروس' + (exceptions.length ? ' · استثناءات معتمدة: ' + exceptions.join(' | ') : ''));
    } catch (e) {
        report('6 MIGRATION_INSPECTION', false, e.message);
    }

    // ─── 7) JSON fallback detection ───
    try {
        const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
        const bad = [];
        for (const s of MIGRATED_STORES) {
            const fnIdx = src.indexOf('async function ' + s.reader);
            if (fnIdx === -1) { bad.push('القارئ مفقود: ' + s.reader); continue; }
            const rest = src.slice(fnIdx);
            const nextFn = rest.slice(10).search(/\n(async )?function |\napp\.(get|post|delete|put)/);
            const body = nextFn === -1 ? rest : rest.slice(0, nextFn + 10);
            if (body.includes('readFile') || body.includes(s.pathConst)) bad.push(s.reader + ' ما زال يقرأ JSON');
        }
        report('7 JSON_FALLBACK_DETECTION', bad.length === 0, bad.length ? bad.join(' | ') : 'قرّاء المخازن المُرحَّلة لا يلمسون JSON إطلاقًا');
    } catch (e) {
        report('7 JSON_FALLBACK_DETECTION', false, e.message);
    }

    // ─── 8) API contract check ───
    try {
        const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
        const missingR = EXPECTED_ROUTES.filter(r => !src.includes(r));
        const missingM = EXPECTED_MAPPERS.filter(r => !src.includes(r));
        const bad = missingR.concat(missingM);
        report('8 API_CONTRACT', bad.length === 0, bad.length ? 'مفقود: ' + bad.join(' | ') : EXPECTED_ROUTES.length + ' مسارًا + محوّلات العقد موجودة حرفيًا');
    } catch (e) {
        report('8 API_CONTRACT', false, e.message);
    }

    // ─── 9) Frozen JSON protection ───
    try {
        const filesToScan = [path.join(ROOT, 'server.js')].concat(
            fs.readdirSync(path.join(ROOT, 'services')).filter(f => f.endsWith('.js')).map(f => path.join(ROOT, 'services', f)));
        const bad = [];
        for (const s of MIGRATED_STORES) {
            for (const f of filesToScan) {
                const c = fs.readFileSync(f, 'utf8');
                const writeRe = new RegExp('writeFile\\([^)]*' + s.pathConst, 'g');
                if (writeRe.test(c)) bad.push(path.basename(f) + ' يكتب ' + s.pathConst);
            }
        }
        const existing = MIGRATED_STORES.filter(s => fs.existsSync(path.join(ROOT, 'data', s.file))).map(s => s.file);
        report('9 FROZEN_JSON_PROTECTION', bad.length === 0,
            bad.length ? bad.join(' | ') : 'صفر كتابات على الثوابت المجمّدة · ملفات مجمّدة موجودة محليًا: ' + (existing.join(', ') || 'لا شيء'));
    } catch (e) {
        report('9 FROZEN_JSON_PROTECTION', false, e.message);
    }

    // ─── 10+11) Boot + /health ───
    {
        const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-boot-'));
        const TMP_DB = path.join(TMP, 'ambulance.db');
        const TMP_DATA = path.join(TMP, 'data');
        fs.mkdirSync(TMP_DATA, { recursive: true });
        const PORT = 3095;
        let server = null, bootOk = false, healthDetail = '';
        try {
            const Database = require('better-sqlite3');
            const src = new Database(path.join(ROOT, 'data', 'ambulance.db'), { readonly: true });
            src.exec("VACUUM INTO '" + TMP_DB.replace(/'/g, "''") + "'");
            src.close();
            fs.copyFileSync(path.join(ROOT, 'data', 'users.json'), path.join(TMP_DATA, 'users.json'));
            server = spawn(NODE, [path.join(ROOT, 'server.js')], {
                env: Object.assign({}, process.env, { PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DATA, NODE_ENV: 'test' }),
                stdio: ['ignore', 'pipe', 'pipe']
            });
            let log = '';
            server.stdout.on('data', d => log += d);
            server.stderr.on('data', d => log += d);
            for (let i = 0; i < 80 && !bootOk; i++) {
                bootOk = await new Promise(resolve => {
                    const rq = http.get('http://localhost:' + PORT + '/health', res => {
                        let buf = '';
                        res.on('data', c => buf += c);
                        res.on('end', () => {
                            if (res.statusCode === 200) {
                                try {
                                    const j = JSON.parse(buf);
                                    healthDetail = 'status=' + j.status + ' version=' + j.version;
                                    resolve(j.status === 'ok');
                                } catch (e) { resolve(false); }
                            } else resolve(false);
                        });
                    });
                    rq.on('error', () => resolve(false));
                    setTimeout(() => { rq.destroy(); resolve(false); }, 400);
                });
                if (!bootOk) await new Promise(r => setTimeout(r, 500));
            }
            report('10 BOOT_CHECK', bootOk, bootOk ? 'إقلاع نظيف على نسخة معزولة' : 'فشل الإقلاع — ' + log.slice(-300));
            report('11 HEALTH', bootOk && healthDetail.includes('status=ok'), healthDetail || 'لا استجابة');
        } catch (e) {
            report('10 BOOT_CHECK', false, e.message);
            report('11 HEALTH', false, e.message);
        } finally {
            if (server) { try { server.kill(); } catch (_) {} }
        }
    }

    // ─── النتيجة ───
    const failed = results.filter(r => !r.pass);
    console.log('\n═══════════════════════════════════');
    if (failed.length) {
        console.log('❌ GATE: FAIL — ' + failed.length + ' بندًا:');
        failed.forEach(f => console.log('   - [' + f.check + '] ' + (f.detail || '')));
        console.log('القرار: ممنوع النشر حتى تُعالج الأسباب.');
        process.exit(1);
    }
    console.log('✅ GATE: PASS — ' + results.length + ' بندًا. يجوز رفع قرار النشر لاعتماد المالك.');
    process.exit(0);
}

main().catch(e => { console.error('⚠️ انهيار البوابة:', e.message); process.exit(1); });
