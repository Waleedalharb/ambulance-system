#!/usr/bin/env node
/* ============================================================
   app-ready-test.js — اختبار جاهزية أساس الجوال (المرحلة 1)
   فحص ثابت (بدون خادم): يتحقق من
   1) viewport-fit=cover في كل صفحات public/*.html
   2) وجود أصول الهوية المعتمدة
   3) سلامة عناصر شاشة الدخول (JS hooks)
   4) ربط app-mobile.css و app-capacitor.js في الصفحات الأساسية
   5) عدم وجود مراجع مكسورة للأصول الجديدة
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public');

let pass = 0, fail = 0;
const failures = [];

function ok(name) { pass++; console.log(`  ✅ ${name}`); }
function bad(name, detail) { fail++; failures.push(name); console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }

/* 1) viewport-fit=cover في كل الصفحات */
console.log('\n[1] viewport-fit=cover');
const pages = fs.readdirSync(PUB).filter(f => f.endsWith('.html'));
let missingVp = [];
for (const f of pages) {
    const s = fs.readFileSync(path.join(PUB, f), 'utf8');
    if (!/viewport-fit=cover/.test(s)) missingVp.push(f);
}
if (missingVp.length === 0) ok(`كل الصفحات (${pages.length}) تحتوي viewport-fit=cover`);
else bad('صفحات بدون viewport-fit=cover', missingVp.join(', '));

/* 2) أصول الهوية */
console.log('\n[2] أصول الهوية المعتمدة');
const assets = ['emblem.png', 'login-bg.png', 'splash-bg.png', 'app-icon.png'];
for (const a of assets) {
    const p = path.join(PUB, 'assets', 'brand', a);
    if (fs.existsSync(p) && fs.statSync(p).size > 10000) ok(`assets/brand/${a} (${Math.round(fs.statSync(p).size / 1024)}KB)`);
    else bad(`assets/brand/${a}`, 'مفقود أو صغير بشكل مريب');
}

/* 3) سلامة شاشة الدخول */
console.log('\n[3] شاشة الدخول — الهوية v3 مع سلامة عناصر JS');
const idx = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
const hooks = ['id="loginUsername"', 'id="loginPassword"', 'id="loginBtn"', 'id="loginError"',
    'id="forgotLink"', 'id="lsClock"', 'id="lsDate"', 'id="resetOverlay"',
    '/assets/brand/emblem.png', '/assets/brand/login-bg.png',
    'منظومة العمليات الإسعافية', 'EMS OPERATIONS', 'نسعى لنحييها'];
const missingHooks = hooks.filter(h => !idx.includes(h));
if (missingHooks.length === 0) ok('كل العناصر والنصوص المعتمدة موجودة');
else bad('عناصر مفقودة في index.html', missingHooks.join(', '));

/* 4) ربط أساس الجوال */
console.log('\n[4] ربط app-mobile.css / app-capacitor.js');
for (const page of ['index.html', 'my-ems.html']) {
    const s = fs.readFileSync(path.join(PUB, page), 'utf8');
    const hasCss = s.includes('/css/app-mobile.css');
    const hasJs = s.includes('/js/app-capacitor.js');
    if (hasCss && hasJs) ok(`${page} مربوطة بالأساس`);
    else bad(`${page}`, `css=${hasCss} js=${hasJs}`);
}
for (const f of ['css/app-mobile.css', 'js/app-capacitor.js']) {
    if (fs.existsSync(path.join(PUB, f))) ok(`${f} موجود`);
    else bad(f, 'الملف غير موجود');
}

/* 5) لا مراجع مكسورة للأصول الجديدة */
console.log('\n[5] سلامة المراجع');
let brokenRef = [];
for (const f of pages) {
    const s = fs.readFileSync(path.join(PUB, f), 'utf8');
    const refs = s.match(/\/assets\/brand\/[a-z0-9.\-_]+/gi) || [];
    for (const r of refs) {
        if (!fs.existsSync(path.join(PUB, r))) brokenRef.push(`${f} -> ${r}`);
    }
}
if (brokenRef.length === 0) ok('لا مراجع مكسورة لأصول الهوية');
else bad('مراجع مكسورة', brokenRef.join(' | '));

/* النتيجة */
console.log(`\n${'='.repeat(50)}`);
console.log(`النتيجة: ${pass} ناجح / ${fail} فاشل`);
if (fail > 0) { console.log('الفاشلة: ' + failures.join(' | ')); process.exit(1); }
console.log('أساس الجوال (المرحلة 1) جاهز ✅');
