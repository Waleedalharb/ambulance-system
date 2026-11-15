'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const TeamCode = require('../public/js/operational-team-code');
const { buildExtensionFiles } = require('./extension-builder');

const ROOT = path.join(__dirname, '..');
const parserSource = fs.readFileSync(path.join(ROOT, 'public', 'js', 'operational-team-code.js'), 'utf8');
const overlaySource = fs.readFileSync(path.join(ROOT, 'scripts', 'cad-overlay.js'), 'utf8');
const marker = "const OVERLAY_SECTOR_CODE = '3';";
let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log('PASS ' + name);
}

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
function loadSector(sectorCode) {
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
  vm.runInContext(parserSource, context);
  const source = overlaySource.replace(marker, "const OVERLAY_SECTOR_CODE = '" + sectorCode + "';");
  vm.runInContext(source, context);
  return { context, overlay: context.window.__southTeamCodeTest };
}

for (let sector = 1; sector <= 19; sector += 1) {
  check('بناء الحزمة R-' + sector + ' يثبت القطاع ولا يترك القطاع الافتراضي', () => {
    const files = buildExtensionFiles('http://localhost:3002', { sectorCode: String(sector) });
    assert.ok(files.content.includes("const OVERLAY_SECTOR_CODE = '" + sector + "';"));
    if (sector !== 3) assert.ok(!files.content.includes(marker));
    const manifest = JSON.parse(files.manifest);
    assert.ok(manifest.description.includes('للقطاع ' + sector + ' فقط'));
    assert.ok(files.readme.includes('R-' + sector));
  });
}

for (let sector = 1; sector <= 19; sector += 1) {
  const other = sector === 19 ? 1 : sector + 1;
  const ownCode = 'R-' + sector + '-1-1';
  const otherCode = 'R-' + other + '-1-1';
  const own = TeamCode.parseOperationalTeamCode(ownCode);
  const otherIdentity = TeamCode.parseOperationalTeamCode(otherCode);
  const { context, overlay } = loadSector(String(sector));
  check('R-' + sector + ' يقبل رمزه واسمه القديم ويحجب القطاع الآخر بالصيغتين', () => {
    assert.equal(context.window.__cadOverlaySector.code, String(sector));
    assert.equal(overlay.mapToSouthTeam(ownCode), own.teamName);
    assert.equal(overlay.mapToSouthTeam(own.teamName + ' - 1'), own.teamName);
    assert.equal(overlay.mapToSouthTeam(otherCode), null);
    assert.equal(overlay.mapToSouthTeam(otherIdentity.teamName + ' - 1'), null);
  });
  check('R-' + sector + ' يدمج قديمه وجديده ويستبعد وحدة القطاع الآخر من لقطة CAD', () => {
    context.window.__southHandleCadResponse('https://cad.example.test/event-manager/api/v2/event-dispatched/detail?eventId=9001', {
      data: { id: 9001, units: [
        { unitCode: ownCode, unitRequestStatus: 'A', unitId: 101, runUnitId: 1001, journeys: [{ journeyStepCode: 'ACCEPTANCE', journeyStepTime: '2026-11-15T08:00:00Z', stepSeq: 1 }] },
        { unitCode: own.teamName, unitRequestStatus: 'A', unitId: 101, runUnitId: 1001, journeys: [{ journeyStepCode: 'ACCEPTANCE', journeyStepTime: '2026-11-15T08:00:00Z', stepSeq: 1 }] },
        { unitCode: otherCode, unitRequestStatus: 'A', unitId: 102, runUnitId: 1002, journeys: [{ journeyStepCode: 'ACCEPTANCE', journeyStepTime: '2026-11-15T08:00:00Z', stepSeq: 1 }] }
      ] }
    });
    const crews = overlay.crewsFromCadUnits('9001');
    assert.equal(crews.length, 1);
    assert.equal(crews[0].team, own.teamName);
    assert.equal(crews[0].operationalCode, ownCode);
    assert.equal(crews[0].cadUnitId, 101);
    assert.equal(crews[0].cadRunUnitId, 1001);
  });
}

check('الوحدات الخاصة تتبع قطاع الحزمة أيضًا', () => {
  const south = loadSector('3').overlay;
  const west = loadSector('4').overlay;
  const north = loadSector('5').overlay;
  assert.equal(south.mapToSouthTeam('R-3-R-2-4'), 'سريع 4');
  assert.equal(south.mapToSouthTeam('R-4-S-1-2'), null);
  assert.equal(west.mapToSouthTeam('R-4-S-1-2'), 'هوائي 2');
  assert.equal(west.mapToSouthTeam('R-3-R-2-4'), null);
  assert.equal(north.mapToSouthTeam('R-5-M-2-1'), 'باص طويق 1');
  assert.equal(north.mapToSouthTeam('R-4-S-1-2'), null);
});

check('القيم غير المعتمدة مرفوضة في كل القطاعات', () => {
  const south = loadSector('3').overlay;
  assert.equal(south.mapToSouthTeam('R-20-1-1'), null);
  assert.equal(south.mapToSouthTeam('فريق غير معروف'), null);
  assert.throws(() => buildExtensionFiles('http://localhost:3002', { sectorCode: '20' }), /غير صالح/);
});

console.log('\nالنتيجة: ' + passed + ' اختبارًا ناجحًا');
