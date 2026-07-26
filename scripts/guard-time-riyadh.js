#!/usr/bin/env node
/**
 * guard-time-riyadh.js — حارس سياسة التوقيت الموحدة (TIME-POLICY.md)
 * ═══════════════════════════════════════════════════════════════════
 * يفحص public/ + server.js + services/ + managers.js عن أنماط تحويل/تنسيق الوقت
 * المحظورة خارج الطبقة المركزية public/js/time-riyadh.js — بلا أي استثناء:
 * منطق كشف المناوبة نفسه يمر عبر TimeRiyadh.riyadhParts.
 * (scripts/generate-test-data.js أداة توليد بيانات تطوير — خارج النطاق.)
 *
 * التشغيل: node scripts/guard-time-riyadh.js
 * عند أي مخالفة: يطبع ملف:سطر ويخرج exit 1.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// الأنماط المحظورة (بحث نصي حرفي)
const FORBIDDEN = [
    'toLocaleString(',
    'toLocaleTimeString(',
    'toLocaleDateString(',
    'Intl.DateTimeFormat',       // كل التنسيق داخل time-riyadh.js فقط
    'u-ca-islamic',              // المنصة ميلادية حصرًا — الهجري خارج النطاق
    'getTimezoneOffset(',        // بقايا حساب الإزاحة اليدوي
    'slice(11, 16)',
    'slice(11,16)',
    'setHours(',
    '10800000',
    '(3 * 60',
    '+ 3 * 60',
    '+3*60'
];

// الملفات/المسارات المستثناة من الفحص
const EXCLUDED_FILES = new Set([
    path.normalize('public/js/time-riyadh.js') // الطبقة المركزية نفسها
]);
const EXCLUDED_DIRS = ['node_modules', 'scripts', '.git'];

const SCAN_EXTS = new Set(['.js', '.html', '.mjs', '.cjs']);

function* walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (EXCLUDED_DIRS.includes(entry.name)) continue;
            yield* walk(full);
        } else if (SCAN_EXTS.has(path.extname(entry.name))) {
            yield full;
        }
    }
}

let violations = 0;

function scanFile(absPath) {
    const rel = path.relative(ROOT, absPath);
    if (EXCLUDED_FILES.has(path.normalize(rel))) return;
    const lines = fs.readFileSync(absPath, 'utf8').split('\n');
    lines.forEach((line, i) => {
        for (const pat of FORBIDDEN) {
            if (line.includes(pat)) {
                violations++;
                console.log(`VIOLATION ${rel}:${i + 1}: [${pat}] ${line.trim().slice(0, 120)}`);
            }
        }
    });
}

// النطاق: public/ + server.js + services/ + managers.js
for (const f of walk(path.join(ROOT, 'public'))) scanFile(f);
for (const f of walk(path.join(ROOT, 'services'))) scanFile(f);
scanFile(path.join(ROOT, 'server.js'));
scanFile(path.join(ROOT, 'managers.js'));

if (violations) {
    console.log(`\n❌ guard-time-riyadh: ${violations} مخالفة — كل تنسيق وقت يجب أن يمر عبر TimeRiyadh (TIME-POLICY.md)`);
    process.exit(1);
}
console.log('✅ guard-time-riyadh: لا مخالفات — كل العرض يمر عبر الطبقة المركزية');
