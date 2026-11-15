'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const TeamCode = require('../public/js/operational-team-code');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log('PASS ' + name);
}

check('الصيغة الصباحية R-3-1-1 تفك إلى جنوب 1', () => {
  const value = TeamCode.parseOperationalTeamCode('R-3-1-1');
  assert.equal(value.teamName, 'جنوب 1');
  assert.equal(value.shiftType, 'صباحية');
  assert.equal(value.sectorName, 'قطاع جنوب الرياض');
  assert.equal(value.operationalCode, 'R-3-1-1');
});
check('الصيغة الليلية R-3-2-1 تفك إلى نفس الهوية الداخلية', () => {
  const value = TeamCode.parseOperationalTeamCode('r-3-2-1');
  assert.equal(value.teamName, 'جنوب 1');
  assert.equal(value.shiftType, 'ليلية');
  assert.equal(value.operationalCode, 'R-3-2-1');
});
check('الأرقام العربية تُطبّع دون تغيير الهوية', () => {
  assert.equal(TeamCode.parseOperationalTeamCode('R-٣-٢-١٢').teamName, 'جنوب 12');
});
check('القطاعات والمناوبات والأرقام غير المعتمدة مرفوضة', () => {
  for (const value of ['R-20-1-1', 'R-3-0-1', 'R-3-5-1', 'R-3-1-0', 'R-3-1--1', 'R-3-1-1x', 'فريق آخر', ''])
    assert.equal(TeamCode.parseOperationalTeamCode(value), null, value);
});
check('جميع الرموز الفريدة في دليل القطاعات مقبولة وقابلة للتطبيع', () => {
  const pages = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'references', 'team-code-guide-pages.json'), 'utf8'));
  const codes = Array.from(new Set(pages.flatMap(page => page.codes)));
  assert.equal(codes.length, 463);
  for (const code of codes) {
    const value = TeamCode.parseOperationalTeamCode(code);
    assert.ok(value, code);
    assert.equal(value.operationalCode, code);
    assert.ok(Number(value.sectorCode) >= 1 && Number(value.sectorCode) <= 19, code);
    assert.ok(value.teamName && value.sectorName && value.shiftType, code);
    assert.equal(TeamCode.identityFromTeamName(value.teamName, value.shiftType).operationalCode, code);
  }
});
check('الوحدات الخاصة والمناوبات الإضافية تفك دون تغيير مفاتيحها', () => {
  assert.equal(TeamCode.parseOperationalTeamCode('R-4-1-1').teamName, 'غرب 1');
  assert.equal(TeamCode.parseOperationalTeamCode('R-4-R-3-1').teamName, 'ناري غرب 1');
  assert.equal(TeamCode.parseOperationalTeamCode('R-4-S-1-2').teamName, 'هوائي 2');
  assert.equal(TeamCode.parseOperationalTeamCode('R-5-M-2-1').teamName, 'باص طويق 1');
  assert.equal(TeamCode.parseOperationalTeamCode('R-19-4-4').shiftType, 'على مدار 24 ساعة');
  assert.equal(TeamCode.parseOperationalTeamCode('R-3-R-2-4').teamName, 'سريع 4');
});
check('الاشتقاق من جنوب N يحترم نوع المناوبة', () => {
  assert.equal(TeamCode.identityFromTeamName('جنوب 2', 'صباحية').operationalCode, 'R-3-1-2');
  assert.equal(TeamCode.identityFromTeamName('جنوب 2', 'ليلية').operationalCode, 'R-3-2-2');
  assert.equal(TeamCode.identityFromTeamName('جنوب 2', 'صباح').operationalCode, 'R-3-1-2');
  assert.equal(TeamCode.identityFromTeamName('جنوب 2', 'ليل').operationalCode, 'R-3-2-2');
  assert.equal(TeamCode.identityFromTeamName('فريق آخر', 'ليلية'), null);
});
check('حقول العرض نصية ولا تضيف رقمًا تشغيليًا خامًا', () => {
  const value = TeamCode.identityFields('جنوب 1', 'ليلية');
  assert.equal(value.teamNumber, '1');
  assert.equal(value.shiftType, 'ليلية');
  assert.match(value.displayLabel, /R-3-2-1/);
});

function element() {
  return {
    id: '', style: {}, dataset: {}, classList: { toggle() {} },
    append() {}, appendChild() {}, addEventListener() {}, remove() {},
    querySelectorAll() { return []; }, setPointerCapture() {},
    offsetLeft: 0, offsetTop: 0, offsetWidth: 100
  };
}
function storage() {
  const values = new Map();
  return { getItem: key => values.has(key) ? values.get(key) : null, setItem: (key, value) => values.set(key, String(value)) };
}
const body = { innerText: '', appendChild() {} };
const windowObject = {
  innerWidth: 1280, innerHeight: 800,
  addEventListener() {}, removeEventListener() {}, postMessage() {},
  fetch: async () => ({ ok: false, json: async () => null })
};
const context = {
  console, window: windowObject,
  document: { body, head: { appendChild() {} }, getElementById: () => null, createElement: element },
  location: { href: 'https://cad.example.test/list', origin: 'https://cad.example.test' },
  localStorage: storage(), sessionStorage: storage(),
  setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
  XMLHttpRequest: function () {}
};
context.XMLHttpRequest.prototype = {};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/operational-team-code.js'), 'utf8'), context);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'cad-overlay.js'), 'utf8'), context);
const overlay = context.window.__southTeamCodeTest;

check('نسخة الجنوب تقبل فرق الجنوب فقط وتعزل بقية القطاعات', () => {
  assert.equal(overlay.mapToSouthTeam('R-3-1-1'), 'جنوب 1');
  assert.equal(overlay.mapToSouthTeam('R-3-2-1'), 'جنوب 1');
  assert.equal(overlay.mapToSouthTeam('R-4-1-1'), null);
  assert.equal(overlay.mapToSouthTeam('R-3-R-2-4'), 'سريع 4');
  assert.equal(overlay.mapToSouthTeam('R-5-M-2-1'), null);
  assert.equal(overlay.mapToSouthTeam('R-20-1-1'), null);
});
check('متتبع CAD يلتقط الرمز المركب', () => {
  body.innerText = 'R-3-1-1 - 12\nR-3-2-2 - 13\nR-4-1-1 - 14';
  const crews = overlay.crewStatesFromTracker();
  assert.deepEqual(Array.from(crews, item => item.name).slice(0, 2), ['R-3-1-1', 'R-3-2-2']);
});
check('لقطة الوحدات تدمج القديم والجديد في مشاركة واحدة', () => {
  context.window.__southHandleCadResponse('https://cad.example.test/event-manager/api/v2/event-dispatched/detail?eventId=9001', {
    data: { id: 9001, units: [
      { unitCode: 'R-3-1-1', unitRequestStatus: 'A', unitId: 101, runUnitId: 1001, journeys: [{ journeyStepCode: 'ACCEPTANCE', journeyStepTime: '2026-11-15T08:00:00Z', stepSeq: 1 }] },
      { unitCode: 'جنوب 1', unitRequestStatus: 'A', unitId: 101, runUnitId: 1001, journeys: [{ journeyStepCode: 'ACCEPTANCE', journeyStepTime: '2026-11-15T08:00:00Z', stepSeq: 1 }] },
      { unitCode: 'R-3-2-2', unitRequestStatus: 'A', unitId: 102, runUnitId: 1002, journeys: [{ journeyStepCode: 'ACCEPTANCE', journeyStepTime: '2026-11-15T08:00:00Z', stepSeq: 1 }] },
      { unitCode: 'R-4-1-9', unitRequestStatus: 'A', unitId: 109, runUnitId: 1009, journeys: [{ journeyStepCode: 'ACCEPTANCE', journeyStepTime: '2026-11-15T08:00:00Z', stepSeq: 1 }] }
    ] }
  });
  const crews = overlay.crewsFromCadUnits('9001');
  assert.equal(crews.length, 2);
  assert.equal(crews[0].team, 'جنوب 1');
  assert.equal(crews[0].operationalCode, 'R-3-1-1');
  assert.equal(crews[0].cadUnitId, 101);
  assert.equal(crews[0].cadRunUnitId, 1001);
  assert.equal(crews[1].team, 'جنوب 2');
  assert.equal(crews[1].operationalCode, 'R-3-2-2');
  assert.ok(!crews.some(crew => crew.team === 'غرب 9'));
});
check('دمج المصادر يبقى على المفتاح الداخلي ولا يضاعف الفرقة', () => {
  const merged = overlay.mergeCrewSources(
    [{ team: 'جنوب 1', cadUrs: 'A' }],
    [{ team: 'جنوب 1', operationalCode: 'R-3-2-1', cadReached: true }]
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].team, 'جنوب 1');
});
check('مسبار CAD يستخرج الرمز الجديد', () => {
  context.window.__southProbeRecord('https://cad.example.test/event-manager/api/v2/event-dispatched/detail?eventId=9001', 'test', { units: [{ unitCode: 'R-3-2-1' }] });
  const samples = context.window.__southProbe.buf;
  assert.ok(samples[samples.length - 1].units.some(value => value.includes('R-3-2-1')));
});

console.log('\nالنتيجة: ' + passed + ' اختبارًا ناجحًا');
