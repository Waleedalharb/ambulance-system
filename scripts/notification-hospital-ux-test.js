/**
 * جولة 2026-08-28 (B) — حارس نصي مانع للرجوع:
 * ① مركز الإشعارات (التصميم ④ المعتمد): شريط Topbar + مركز بتبويبات + أولوية/مصدر/إجراء
 * ② إعادة تصميم تبويب المستشفيات في أرشيف المناوبة (داكن بالكامل، Timeline حقيقي)
 * ③ صياغة JS المضمّن في الصفحتين المعدلتين سليمة (node --check على المستخلص)
 * فحص نصي + صياغي فقط — لا خادم ولا متصفح.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
const opsDash = fs.readFileSync(path.join(root, 'public', 'operations-dashboard.html'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond) {
    if (cond) { pass++; console.log('  ✅ ' + name); }
    else { fail++; failures.push(name); console.log('  ❌ ' + name); }
}

console.log('\n═══ ① مركز الإشعارات — التصميم ④ ═══');
// الهيكل
check('شريط Topbar (notifStrip) موجود بجانب الجرس', indexHtml.includes('id="notifStrip"'));
check('أزرار الشريط: أيقونة/نص/وقت/إخفاء', ['notifStripIcon', 'notifStripText', 'notifStripTime'].every(id => indexHtml.includes('id="' + id + '"')));
check('تبويبات المركز الثلاثة (غير مقروء/مقروء/الكل)', ['data-nc2tab="unread"', 'data-nc2tab="read"', 'data-nc2tab="all"'].every(t => indexHtml.includes(t)));
check('عداد غير المقروء في الترويسة (nc2UnreadCount)', indexHtml.includes('id="nc2UnreadCount"'));
check('زرّا التذييل (تعليم الكل/مسح الكل)', indexHtml.includes('nc2-footer-btn') && indexHtml.includes('nc2-footer-danger'));
// الأنماط (الطبقة الختامية)
check('لوحة داكنة زجاجية (لا بطاقات بيضاء)', /\.notification-panel \{[^}]*rgba\(10,18,34|rgba\(17,28,48/.test(indexHtml));
check('أنماط التبويبات والبطاقات والشريط', ['.nc2-tab', '.nc-item', '.notif-strip', '.nc2-footer-btn'].every(c => indexHtml.includes(c)));
check('ألوان الأولوية الأربعة على البطاقات', ['.nc-danger', '.nc-warning', '.nc-success', '.nc-info'].every(c => indexHtml.includes(c)));
check('تجاوب الجوال للشريط (يُخفى <640px والـToast يغطي)', /@media \(max-width: 640px\)[^}]*\{[^}]*\.notif-strip \{ display: none !important; \}/.test(indexHtml.replace(/\n/g, ' ')) || indexHtml.includes('.notif-strip { display: none !important; }'));
// المنطق
check('منع التكرار (dedupeNotifications)', appJs.includes('function dedupeNotifications('));
check('الأولوية من النوع (notifPriorityOf)', appJs.includes('function notifPriorityOf('));
check('اشتقاق المصدر (notifSourceOf)', appJs.includes('function notifSourceOf('));
check('الإجراء المرتبط (notifActionFor + notifActionRun)', appJs.includes('function notifActionFor(') && appJs.includes('function notifActionRun('));
check('وقت نسبي واعٍ بـUTC (notifTimeAgo)', appJs.includes('function notifTimeAgo(') && appJs.includes("s.replace(' ', 'T') + 'Z'"));
check('تهريب HTML — صفر undefined/null (nc2Esc)', appJs.includes('function nc2Esc(') && appJs.includes("nc2Esc(n.title) || 'إشعار'"));
check('الشريط: حداثة ≤ 30 دقيقة (لا إشعار قديم كأنه جديد)', appJs.includes('30 * 60 * 1000'));
check('المعلوماتي يختفي تلقائيًا (12ث) والحرج يبقى', appJs.includes('12000') && /prio\.key === 'info' \|\| prio\.key === 'success'/.test(appJs));
check('الحرج/المراقبة لا إخفاء تلقائي لهما', !/prio\.key === 'danger'[\s\S]{0,80}setTimeout/.test(appJs.split("if (prio.key === 'info'")[0].slice(-400)));
check('إغلاق اللوحة يستثني الجرس والشريط', appJs.includes("getElementById('notifStrip')") && appJs.includes("getElementById('notificationBell')"));
check('إصدار app.js مرقّى (v=48)', indexHtml.includes('js/app.js?v=48'));

console.log('\n═══ ② تبويب المستشفيات — إعادة التصميم ═══');
check('أنماط hosp- الداكنة موجودة', ['.hosp-kpi', '.hosp-journey', '.hosp-timeline', '.hosp-calm', '.hosp-alert-banner'].every(c => opsDash.includes(c)));
check('لا بطاقات بيضاء (--gray-100 اختفى من القسم)', !/chip\('رحلة/.test(opsDash) && !opsDash.includes('var(--gray-100,#f3f4f6)'));
check('شريط التنبيهات النشطة أعلى القسم', opsDash.includes('hosp-alert-banner') && opsDash.includes('تنبيه نشط'));
check('حالة «لا تنبيهات» الهادئة', opsDash.includes('لا توجد تنبيهات تشغيلية'));
check('Timeline حقيقي بأيقونات الأحداث', ['tl-seen', 'tl-change', 'tl-alert', 'tl-ack', 'tl-resolved'].every(c => opsDash.includes(c)));
check('بطاقات الرحلات: الحالية أولًا', opsDash.includes('hj-current') && opsDash.includes('hj-open-at-close'));
check('تهريب HTML في القسم (esc)', /var esc = function \(v\)/.test(opsDash));
check('عرض فقط: لا كتابة fetch/POST جديدة في القسم', !/renderHospitalTab[\s\S]*?fetch\(/.test(opsDash.split('function renderHospitalTab')[1].split('function ')[1] || ''));

console.log('\n═══ ③ الـToast السفلي — الشكل الجديد (يبقى بمكانه ووظيفته) ═══');
const appCss = fs.readFileSync(path.join(root, 'public', 'css', 'app.css'), 'utf8');
const mapConfig = fs.readFileSync(path.join(root, 'public', 'js', 'map-config.js'), 'utf8');
check('الحاوية والموضع لم يتغيرا (toast-container أسفل يسار)', appCss.includes('.toast-container') && /bottom:\s*24px/.test(appCss));
check('التوست داكن زجاجي (لا خلفيات *-50 الفاتحة)', appCss.includes('rgba(10,18,34,0.98)') && !/toast-notification\.(success|error|warning|info) \{ background: var\(--(teal|coral|gold|info)-50/.test(appCss));
check('ألوان الأنواع التشغيلية (بنفسجي/برتقالي/أخضر)', ['tk-report', 'tk-hospital', 'tk-completion'].every(c => appCss.includes(c)));
check('بنية التوست الجديدة (kind/time/close/actions)', ['toast-kind', 'toast-time', 'toast-close', 'toast-action-btn'].every(c => appCss.includes(c)));
check('showNotification يبقي التوقيع والأصوات', /function showNotification\(title, message, type, duration\)/.test(appJs) && appJs.includes('playSuccessSound'));
check('وسم النوع التشغيلي + تهريب + إغلاق يدوي', appJs.includes('toastActionRun') && appJs.includes('kindMap') && appJs.includes('toast-close'));
check('الإجراء لا يُعرض إلا بدوال وجهة موجودة (depsOk)', appJs.includes('depsOk'));
check('SSE يمرر النوع الحقيقي (_n.type) بدل info الثابتة', appJs.includes("_n.type || 'info'"));
check('الحرج/التحذيري 8ث والمعلوماتي 4ث', appJs.includes("? 8000 : 4000"));
check('app.css?v=35 في كل الصفحات الخمس', ['index.html', 'admin-dashboard.html', 'admin-knowledge.html', 'admin-shift-codes.html', 'admin-vehicles.html'].every(f => fs.readFileSync(path.join(root, 'public', f), 'utf8').includes('app.css?v=35')));

console.log('\n═══ ④ Mapbox Light — المسار «ب» (متغير بيئة Render، لا توكن في Git) ═══');
const serverJs = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
check('مسار الحقن /js/map-config.runtime.js موجود', serverJs.includes("app.get('/js/map-config.runtime.js'"));
check('المسار يقرأ MAPBOX_PUBLIC_TOKEN من البيئة', serverJs.includes('process.env.MAPBOX_PUBLIC_TOKEN'));
check('يقبل صيغة pk. فقط ويمنع أي قيمة أخرى', serverJs.includes('/^pk\\.[A-Za-z0-9._-]+$/'));
check('no-store (لا تخزين للاستجابة الحاملة للإعداد)', /map-config\.runtime[\s\S]{0,400}no-store/.test(serverJs));
check('غياب المتغير = no-op (الافتراضي/المحلي يبقى حرفيًا)', serverJs.includes('غير مضبوط في بيئة الخادم'));
check('index.html يرفع map-config.runtime.js', indexHtml.includes('js/map-config.runtime.js'));
check('map-config.js في Git بلا توكن (الافتراضي leaflet)', !/pk\.eyJ[A-Za-z0-9._-]*/.test(mapConfig) && mapConfig.includes("provider: 'leaflet'"));
// حارس عدم التسريب: لا توكن Mapbox في أي ملف متتبع تحت public/ أو الجذور الحساسة
const tracked = ['public/index.html', 'public/js/map-config.js', 'public/js/app.js', 'public/css/app.css', 'server.js', 'public/operations-dashboard.html']
    .map(f => fs.readFileSync(path.join(root, f), 'utf8'));
check('صفر توكن pk.eyJ في الملفات المتتبعة', tracked.every(t => !t.includes('pk.eyJ')));

console.log('\n═══ ⑤ سلامة الصياغة — JS المضمّن ═══');
function checkInlineScripts(html, fileLabel) {
    const blocks = [];
    const re = /<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html)) !== null) { if (m[1].trim()) blocks.push(m[1]); }
    let ok = true;
    blocks.forEach((code, i) => {
        const tmp = path.join(__dirname, `.tmp-inline-${fileLabel}-${i}.js`);
        fs.writeFileSync(tmp, code);
        try {
            execSync(`node --check "${tmp}"`, { stdio: 'pipe' });
        } catch (e) {
            ok = false;
            console.log('    ↳ خطأ صياغة في الكتلة ' + i + ': ' + String(e.stderr || e.message).split('\n')[0]);
        }
        fs.unlinkSync(tmp);
    });
    return { ok, count: blocks.length };
}
const r1 = checkInlineScripts(indexHtml, 'index');
check('index.html: كل الكتل المضمنة سليمة (' + r1.count + ' كتلة)', r1.ok);
const r2 = checkInlineScripts(opsDash, 'opsdash');
check('operations-dashboard.html: كل الكتل المضمنة سليمة (' + r2.count + ' كتلة)', r2.ok);
try {
    execSync('node --check "' + path.join(root, 'public', 'js', 'app.js') + '"', { stdio: 'pipe' });
    check('app.js سليم صياغيًا', true);
} catch (e) { check('app.js سليم صياغيًا', false); }

console.log('\n═══════════════════════════');
console.log('النتيجة: ' + pass + ' ناجح / ' + fail + ' فاشل');
if (failures.length) { console.log('الفاشل:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('✅ كل فحوص الجولة ناجحة');
