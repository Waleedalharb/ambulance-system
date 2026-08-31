/**
 * pi8-hydrate-order-test.js — PI-8 (اعتماد المالك 2026-08-31)
 * اختبار قبول لإصلاح ترتيب DOM في renderAdvancedDistribution:
 *   appendChild(y.firstElementChild) «ينقل» العقدة ولا ينسخها — لذلك كان
 *   hydrate(logDiv) بعد النقل يعمل على غلاف فارغ ولا تظهر «هوية الموقع» أبدًا.
 * هذا الاختبار يبني DOM مصغّرًا بنفس الدلالات (نقل فعلي + querySelectorAll
 * يمشي الشجرة) ويثبت أن التعبئة تصل للعقدة المنقولة ومساحاتها.
 * تشغيل: node scripts/pi8-hydrate-order-test.js
 */
'use strict';

let passed = 0, failed = 0;
function ok(name, cond, detail) {
    if (cond) { passed++; console.log('✅ ' + name + (detail ? ' (' + detail + ')' : '')); }
    else { failed++; console.log('❌ ' + name + (detail ? ' (' + detail + ')' : '')); }
}

// ─── DOM مصغّر بنفس دلالات المتصفح الحاسمة لهذا العطل ───
function makeEl(tag) {
    return {
        tagName: tag, children: [], parent: null, attrs: {}, _html: '',
        set innerHTML(h) {
            // محاكاة محلل: الغلاف يحوي بطاقة فيها مساحة pi-sugg-slot
            this._html = h;
            this.children = [];
            if (h.indexOf('pi-sugg-slot') !== -1) {
                const slot = makeEl('div'); slot.attrs['class'] = 'pi-sugg-slot';
                const card = makeEl('div'); card.children = [slot]; slot.parent = card;
                const wrap = makeEl('div'); wrap.children = [card]; card.parent = wrap;
                wrap.parent = this; this.children = [wrap];
            }
        },
        get firstElementChild() { return this.children[0] || null; },
        appendChild(node) { // ← الدلالة الحاسمة: نقل وليس نسخ
            if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
            node.parent = this; this.children.push(node); return node;
        },
        querySelectorAll(sel) { // يمشي الشجرة — العنصر المنقول لا يبقى في الأب القديم
            const out = [];
            (function walk(n) {
                n.children.forEach(c => {
                    if (sel === '.pi-sugg-slot' && c.attrs['class'] === 'pi-sugg-slot') out.push(c);
                    walk(c);
                });
            })(this);
            return out;
        }
    };
}
const document = { createElement: makeEl };

// ─── إعادة إنتاج مساري ما قبل/بعد الإصلاح بحرفية الترتيب ───
function legacyOrder() { // ما قبل الإصلاح (لإثبات أن الاختبار كان سيكشفه)
    const container = makeEl('div');
    const logDiv = document.createElement('div');
    logDiv.innerHTML = '<div><div class="pi-sugg-slot" data-num="1326978"></div></div>';
    container.appendChild(logDiv.firstElementChild);
    return logDiv.querySelectorAll('.pi-sugg-slot').length; // hydrate(logDiv) القديم
}
function fixedOrder() { // ما بعد الإصلاح — مطابق لسطور app.js الحالية
    const container = makeEl('div');
    const logDiv = document.createElement('div');
    logDiv.innerHTML = '<div><div class="pi-sugg-slot" data-num="1326978"></div></div>';
    const logNode = logDiv.firstElementChild;
    container.appendChild(logNode);
    return { slotsInLogNode: logNode.querySelectorAll('.pi-sugg-slot').length, // hydrate(logNode) الجديد
             slotsLeftInLogDiv: logDiv.querySelectorAll('.pi-sugg-slot').length,
             slotsInContainer: container.querySelectorAll('.pi-sugg-slot').length };
}

console.log('════════════════════════════════');
console.log('PI-8 — اختبار ترتيب تعبئة «هوية الموقع»');
console.log('════════════════════════════════');

ok('T1 — النمط القديم: hydrate بعد النقل يجد صفر مساحات (إثبات أن العطل حقيقي)', legacyOrder() === 0);

const f = fixedOrder();
ok('T2 — العقدة المنقولة تحتفظ بمساحة الاقتراح', f.slotsInLogNode === 1, 'slots=' + f.slotsInLogNode);
ok('T3 — الغلاف الفارغ لا يحتفظ بشيء (النقل فعلي)', f.slotsLeftInLogDiv === 0);
ok('T4 — container يحتوي المساحة بعد النقل', f.slotsInContainer === 1);

// T5 — فحص ساكن لكود الإنتاج: hydrate يُستدعى على logNode لا على logDiv
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/../public/js/app.js', 'utf8');
const block = src.match(/var logDiv = document\.createElement\('div'\);[\s\S]{0,600}?hydrate\((\w+)\)/);
ok('T5 — app.js: hydrate تُستدعى على العقدة المنقولة logNode', !!block && block[1] === 'logNode',
   block ? ('hydrate(' + block[1] + ')') : 'الكتلة غير موجودة');
ok('T6 — app.js: النقل يمر عبر متغير logNode قبل appendChild', /var logNode = logDiv\.firstElementChild;\s*container\.appendChild\(logNode\);/.test(src));
ok('T7 — لا يوجد أي استدعاء hydrate(logDiv) متبقٍ', !/hydrate\(logDiv\)/.test(src));

// T8 — سلوك hydrate نفسه: مساحة داخل العقدة تُملأ فعلًا (بمحاكاة PlaceSuggestion)
let filled = 0;
const PlaceSuggestion = { hydrate(c) { c.querySelectorAll('.pi-sugg-slot').forEach(function () { filled++; }); } };
const container2 = makeEl('div');
const logDiv2 = document.createElement('div');
logDiv2.innerHTML = '<div><div class="pi-sugg-slot" data-num="1326978"></div></div>';
const node2 = logDiv2.firstElementChild;
container2.appendChild(node2);
PlaceSuggestion.hydrate(node2);
ok('T8 — hydrate على العقدة المنقولة يملأ المساحة فعلًا', filled === 1, 'filled=' + filled);

console.log('════════════════════════════════');
console.log('النتيجة: ' + passed + ' ✅ · ' + failed + ' ❌');
process.exit(failed ? 1 : 0);
