'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Icons = require('../../public/js/proqa-incident-icons');
const Paths = require('../../public/js/proqa-fontawesome-paths');

const EXPECTED = [
  ['آلام أو مشاكل البطن', 'person'], ['الحساسية واللسعات', 'allergies'],
  ['عضات وهجمات الحيوانات', 'paw'], ['الاعتداء والصعق', 'hand-fist'],
  ['آلام الظهر', 'person-cane'], ['مشاكل التنفس', 'lungs'],
  ['الحروق والانفجار', 'fire-flame-curved'], ['استنشاق ومواد خطرة', 'mask-face'],
  ['توقف القلب أو التنفس', 'heart-crack'], ['ألم الصدر', 'heart-pulse'],
  ['الاختناق', 'head-side-cough'], ['التشنجات والنوبات', 'wave-square'],
  ['مشاكل السكري', 'syringe'], ['الغرق وحوادث الغوص', 'person-drowning'],
  ['الكهرباء والصاعقة', 'plug-circle-bolt'], ['مشاكل وإصابات العين', 'eye'],
  ['السقوط', 'person-falling'], ['الصداع', 'head-side-virus'],
  ['مشاكل القلب', 'heart-pulse'], ['التعرض للحرارة أو البرودة', 'temperature-half'],
  ['النزيف والجروح', 'droplet'], ['الاحتجاز والوصول الصعب', 'door-closed'],
  ['الجرعة الزائدة والتسمم', 'prescription-bottle-medical'], ['الحمل والولادة والإجهاض', 'baby'],
  ['نفسية وسلوك غير طبيعي', 'person-circle-exclamation'], ['حالة مرضية محددة', 'bed-pulse'],
  ['طعن أو رضح نافذ', 'burst'], ['السكتة الدماغية', 'brain'],
  ['حوادث المرور والنقل', 'car-burst'], ['الإصابات الرضحية', 'user-injured'],
  ['فقدان الوعي والإغماء', 'person-falling-burst'], ['مشكلة غير معروفة', 'circle-question'],
  ['النقل بين المنشآت', 'truck-medical'], ['التنبيه التلقائي لحادث مركبة', 'car-on'],
  ['بحسب تهيئة الجهة', 'sliders'], ['مراقبة وفرز الأوبئة', 'virus']
];

test('approved ProQA catalog covers all categories 01–36 with local SVG assets', () => {
  assert.equal(Object.keys(Icons.CATEGORIES).length, 36);
  EXPECTED.forEach(([label, icon], index) => {
    const category = index + 1;
    const result = Icons.resolve(`${category}D01`);
    assert.equal(result.category, category);
    assert.equal(result.categoryCode, String(category).padStart(2, '0'));
    assert.equal(result.label, label);
    assert.equal(result.icon, icon);
    assert.ok(Paths[icon]?.viewBox && Paths[icon]?.paths?.length, `missing local icon ${icon}`);
    const html = Icons.markerHtml(`${category}D01`);
    assert.ok(html.includes(`data-proqa-category="${category}"`));
    assert.ok(html.includes('<svg'));
    assert.ok(!html.includes('http'));
  });
});

test('CAD code selects the approved category and ProQA letter selects display tone', () => {
  const breathing = Icons.resolve('6D01');
  assert.equal(breathing.label, 'مشاكل التنفس');
  assert.equal(breathing.icon, 'lungs');
  assert.equal(breathing.tone, 'red');
  assert.equal(breathing.priorityName, 'Delta');

  const arrest = Icons.resolve('9E01');
  assert.equal(arrest.category, 9);
  assert.equal(arrest.icon, 'heart-crack');
  assert.equal(arrest.tone, 'red');
  assert.equal(arrest.priorityName, 'Echo');

  const stroke = Icons.resolve('28C02');
  assert.equal(stroke.category, 28);
  assert.equal(stroke.icon, 'brain');
  assert.equal(stroke.tone, 'yellow');
  assert.equal(stroke.priorityName, 'Charlie');

  const traffic = Icons.resolve('29B05U');
  assert.equal(traffic.category, 29);
  assert.equal(traffic.icon, 'car-burst');
  assert.equal(traffic.tone, 'yellow');
  assert.equal(traffic.priorityName, 'Bravo');

  const chest = Icons.resolve('10A01');
  assert.equal(chest.category, 10);
  assert.equal(chest.tone, 'green');
  assert.equal(chest.color, '#47D7A0');
});

test('unknown, malformed, category 32 and agency-specific 35 never invent a priority color', () => {
  for (const code of [null, undefined, '', 'traffic', '6D1', '6F01', '99D01']) {
    const result = Icons.resolve(code);
    assert.equal(result.category, null);
    assert.equal(result.icon, 'circle-question');
    assert.equal(result.tone, 'unknown');
    assert.equal(result.color, '#8EA5AF');
  }
  const unknown = Icons.resolve('32D01');
  assert.equal(unknown.category, 32);
  assert.equal(unknown.tone, 'unknown');
  assert.equal(unknown.icon, 'circle-question');
  const agency = Icons.resolve('35C01');
  assert.equal(agency.category, 35);
  assert.equal(agency.tone, 'unknown');
  assert.equal(agency.icon, 'sliders');
});

test('marker SVG matches approved pin geometry, colors and unique gradients', () => {
  const first = Icons.markerHtml('29B05U');
  const second = Icons.markerHtml('29B05U');
  assert.ok(first.includes('M50,2 C24,2 6,20 6,44'));
  assert.ok(first.includes('stop-color="#1B4553"'));
  assert.ok(first.includes('stop-color="#091E2A"'));
  assert.ok(first.includes('fill="#0A222E"'));
  assert.ok(first.includes('stroke="#3B5661"'));
  assert.ok(first.includes('--rc-proqa-priority:#F4BB55'));
  const firstId = first.match(/linearGradient id="([^"]+)"/)[1];
  const secondId = second.match(/linearGradient id="([^"]+)"/)[1];
  assert.notEqual(firstId, secondId);
  assert.ok(first.includes(`fill="url(#${firstId})"`));
});

test('untrusted CAD text cannot inject HTML into marker output', () => {
  const attack = '29B05U"><img src=x onerror=alert(1)>';
  const html = Icons.markerHtml(attack);
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('onerror'));
  assert.ok(!html.includes(attack));
  assert.ok(html.includes('data-proqa-category="unknown"'));
  assert.ok(html.includes('data-proqa-tone="unknown"'));
});
