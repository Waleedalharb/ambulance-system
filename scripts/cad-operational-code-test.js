'use strict';

/* توافق CAD Overlay مع الترميز التشغيلي — بلا متصفح أو بيانات إنتاج. */
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CAD = 'https://cad.example.com';
const messages = [];
const listeners = new Set();
const details = {};
let passed = 0;
let failed = 0;
function check(name, condition, extra) {
  if (condition) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (extra ? ' :: ' + JSON.stringify(extra) : '')); }
}
function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, String(value)) };
}
function element() {
  return {
    style: {}, dataset: {}, classList: { toggle() {} }, append() {}, appendChild() {},
    addEventListener() {}, remove() {}, setPointerCapture() {}, querySelectorAll() { return []; }
  };
}
const body = { innerText: '', appendChild() {} };
const location = { href: CAD + '/list', origin: CAD };
const windowObject = {
  innerWidth: 1280, innerHeight: 800,
  addEventListener(type, fn) { if (type === 'message') listeners.add(fn); },
  removeEventListener(type, fn) { if (type === 'message') listeners.delete(fn); },
  postMessage(data) {
    messages.push(data);
    setTimeout(() => {
      const response = data.kind === 'cad-report'
        ? { success: true, created: true, addedCrews: [], withdrawnCrews: [] }
        : { success: true, total: 0, byType: {}, byCrew: {} };
      for (const fn of [...listeners]) fn({ data: { source: 'south-ext-bridge', reqId: data.reqId, status: 200, data: response } });
    }, 0);
  },
  fetch: async url => {
    const match = String(url).match(/eventId=(\d+)/);
    const payload = match && details[match[1]] ? details[match[1]] : { data: {} };
    return { ok: true, url: String(url), json: async () => payload, clone: () => ({ json: async () => payload }) };
  }
};
const context = {
  console, window: windowObject, location, localStorage: storage(), sessionStorage: storage(),
  document: { getElementById: () => null, createElement: element, head: { appendChild() {} }, body },
  setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {}, XMLHttpRequest: function () {}
};
context.XMLHttpRequest.prototype = {};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'scripts', 'cad-overlay.js'), 'utf8'), context);
const drain = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 5)); };
function unit(unitCode, unitId) {
  return {
    unitCode, unitRequestStatus: 'A', unitId, runUnitId: unitId + 10000,
    journeys: [{ journeyStepCode: 'ACCEPTANCE', journeyStepTime: '2026-11-17T08:00:00Z', stepSeq: 1 }]
  };
}
async function discover(number, units) {
  details[number] = { data: { id: Number(number), units, createdDate: '2026-11-17T07:59:00Z' } };
  context.window.__southHandleCadResponse(CAD + '/dispatch-manager/api/cfs/v2/operation-controller/incident-list?page=1', {
    data: { last: true, items: [{ eventId: Number(number), proQACode: '30A01', lastJourneys: units.map(item => ({ unitCode: item.unitCode, journeyStepCode: 'ACCEPTANCE' })) }] }
  });
  await drain();
  return messages.filter(item => item.kind === 'cad-report' && item.payload.number === number);
}

(async () => {
  check('ختم البناء يثبت نسخة توافق الرموز الجديدة', /2026-11-17\.a/.test(context.window.__southBuild || ''));

  const morning = await discover('9101', [unit('R-3-1-1', 101)]);
  const morningCrew = morning[0]?.payload.crews[0];
  check('R-3-1-1 يقرأ كفرقة الجنوب 1 بالسجل التاريخي نفسه', morningCrew?.team === 'جنوب 1', morning[0]?.payload);
  check('هوية CAD الثابتة وأزمنة الرحلة تصل مع الرمز الجديد', morningCrew?.cadUnitId === 101 && morningCrew?.cadRunUnitId === 10101 && !!morningCrew?.phases['قبول'], morningCrew);

  const night = await discover('9102', [unit('R-3-2-1', 102)]);
  check('R-3-2-1 يبقى مميزًا كمناوبة ليلية دون تغيير مفتاح الفرقة', night[0]?.payload.crews[0]?.team === 'جنوب 1' && night[0]?.payload.crews[0]?.cadUnitId === 102, night[0]?.payload);

  const rapid = await discover('9103', [unit('R-3-R-1-2', 103)]);
  check('R-3-R-1-2 يقرأ كسريع 2 دون إنشاء اسم جديد', rapid[0]?.payload.crews[0]?.team === 'سريع 2', rapid[0]?.payload);

  const foreign = await discover('9104', [unit('R-2-1-1', 201), unit('R-4-1-1', 202), unit('R-3-1-0', 203), unit('R-3-5-1', 204)]);
  check('القطاعات الأخرى والرموز غير الصالحة لا تدخل بيانات الجنوب', foreign.length === 0, foreign.map(item => item.payload));

  const mixed = await discover('9105', [unit('R-3-1-1', 101), unit('جنوب 1', 101)]);
  const repeated = await discover('9105', [unit('R-3-1-1', 101), unit('جنوب 1', 101)]);
  check('الرمز الجديد والاسم التاريخي لا ينشئان فرقتين داخل البلاغ', mixed[0]?.payload.crews.length === 1 && mixed[0]?.payload.crews[0]?.team === 'جنوب 1', mixed[0]?.payload);
  check('إعادة اللقطة نفسها لا ترسل البلاغ مرة ثانية', mixed.length === 1 && repeated.length === 1, { initial: mixed.length, repeated: repeated.length });

  console.log(`RESULT ${passed}/${passed + failed}`);
  process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
