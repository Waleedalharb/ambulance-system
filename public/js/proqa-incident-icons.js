/*
 * فهرس عرض بلاغات ProQA المعتمد — الفئات 01–36.
 * عرض نقي بلا DOM: كود CAD → فئة وأيقونة ولون أولوية وSVG محلي.
 * لا يقرأ incident.severity ولا يستنتج تصنيفًا من type أو الوصف.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./alert-rules'), require('./proqa-fontawesome-paths'));
  } else {
    root.ProQAIncidentIcons = factory(root.AlertRules, root.ProQAIconPaths);
  }
})(typeof self !== 'undefined' ? self : this, function (AlertRules, ICONS) {
  'use strict';
  if (!AlertRules || typeof AlertRules.classify !== 'function') throw new Error('AlertRules is required');

  var COLORS = {
    red: '#FF626B',
    yellow: '#F4BB55',
    green: '#47D7A0',
    unknown: '#8EA5AF'
  };
  var CATEGORIES = {
    1: { label: 'آلام أو مشاكل البطن', icon: 'person' },
    2: { label: 'الحساسية واللسعات', icon: 'allergies' },
    3: { label: 'عضات وهجمات الحيوانات', icon: 'paw' },
    4: { label: 'الاعتداء والصعق', icon: 'hand-fist' },
    5: { label: 'آلام الظهر', icon: 'person-cane' },
    6: { label: 'مشاكل التنفس', icon: 'lungs' },
    7: { label: 'الحروق والانفجار', icon: 'fire-flame-curved' },
    8: { label: 'استنشاق ومواد خطرة', icon: 'mask-face' },
    9: { label: 'توقف القلب أو التنفس', icon: 'heart-crack' },
    10: { label: 'ألم الصدر', icon: 'heart-pulse' },
    11: { label: 'الاختناق', icon: 'head-side-cough' },
    12: { label: 'التشنجات والنوبات', icon: 'wave-square' },
    13: { label: 'مشاكل السكري', icon: 'syringe' },
    14: { label: 'الغرق وحوادث الغوص', icon: 'person-drowning' },
    15: { label: 'الكهرباء والصاعقة', icon: 'plug-circle-bolt' },
    16: { label: 'مشاكل وإصابات العين', icon: 'eye' },
    17: { label: 'السقوط', icon: 'person-falling' },
    18: { label: 'الصداع', icon: 'head-side-virus' },
    19: { label: 'مشاكل القلب', icon: 'heart-pulse' },
    20: { label: 'التعرض للحرارة أو البرودة', icon: 'temperature-half' },
    21: { label: 'النزيف والجروح', icon: 'droplet' },
    22: { label: 'الاحتجاز والوصول الصعب', icon: 'door-closed' },
    23: { label: 'الجرعة الزائدة والتسمم', icon: 'prescription-bottle-medical' },
    24: { label: 'الحمل والولادة والإجهاض', icon: 'baby' },
    25: { label: 'نفسية وسلوك غير طبيعي', icon: 'person-circle-exclamation' },
    26: { label: 'حالة مرضية محددة', icon: 'bed-pulse' },
    27: { label: 'طعن أو رضح نافذ', icon: 'burst' },
    28: { label: 'السكتة الدماغية', icon: 'brain' },
    29: { label: 'حوادث المرور والنقل', icon: 'car-burst' },
    30: { label: 'الإصابات الرضحية', icon: 'user-injured' },
    31: { label: 'فقدان الوعي والإغماء', icon: 'person-falling-burst' },
    32: { label: 'مشكلة غير معروفة', icon: 'circle-question' },
    33: { label: 'النقل بين المنشآت', icon: 'truck-medical' },
    34: { label: 'التنبيه التلقائي لحادث مركبة', icon: 'car-on' },
    35: { label: 'بحسب تهيئة الجهة', icon: 'sliders' },
    36: { label: 'مراقبة وفرز الأوبئة', icon: 'virus' }
  };
  var PIN_PATH = 'M50,2 C24,2 6,20 6,44 C6,73 50,116 50,116 C50,116 94,73 94,44 C94,20 76,2 50,2 Z';
  var markerSequence = 0;

  function toneFor(classification, category) {
    // 32 غير معروف و35 غير موحّد: لا لون سريري مفترض لهما.
    if (!classification || !CATEGORIES[category] || category === 32 || category === 35) return 'unknown';
    if (classification.letter === 'A') return 'green';
    if (classification.letter === 'B' || classification.letter === 'C') return 'yellow';
    if (classification.letter === 'D' || classification.letter === 'E') return 'red';
    return 'unknown';
  }

  function resolve(code) {
    var normalized = code === null || code === undefined ? '' : String(code).trim();
    var classification = AlertRules.classify(normalized);
    var match = classification ? normalized.match(/^(\d{1,2})/) : null;
    var category = match ? parseInt(match[1], 10) : null;
    var known = !!CATEGORIES[category];
    var definition = CATEGORIES[known ? category : 32];
    var tone = toneFor(classification, category);
    return {
      code: normalized || null,
      category: known ? category : null,
      categoryCode: known ? String(category).padStart(2, '0') : null,
      label: definition.label,
      icon: definition.icon,
      classification: classification,
      priorityName: classification ? classification.name : null,
      priorityLabel: classification ? classification.label : null,
      tone: tone,
      color: COLORS[tone],
      classificationAvailable: !!classification
    };
  }

  function glyphSvg(name, x, y, size, color, extraClass) {
    var glyph = ICONS && (ICONS[name] || ICONS['circle-question']);
    if (!glyph) throw new Error('ProQA icon paths unavailable: ' + name);
    var paths = glyph.paths.map(function (path) { return '<path d="' + path + '"></path>'; }).join('');
    return '<svg class="' + (extraClass || 'rc-proqa-marker__glyph') + '" x="' + x + '" y="' + y + '" width="' + size + '" height="' + size + '" viewBox="' + glyph.viewBox + '" fill="' + color + '" aria-hidden="true" focusable="false">' + paths + '</svg>';
  }

  function markerHtml(code) {
    var presentation = resolve(code);
    var gradientId = 'rc-proqa-pin-gradient-' + (++markerSequence);
    var categoryAttribute = presentation.category === null ? 'unknown' : String(presentation.category);
    var html = '<span class="rc-proqa-marker" data-proqa-category="' + categoryAttribute + '" data-proqa-tone="' + presentation.tone + '" style="--rc-proqa-priority:' + presentation.color + '" aria-hidden="true">';
    html += '<svg class="rc-proqa-marker__svg" viewBox="0 0 100 120" focusable="false">';
    html += '<defs><linearGradient id="' + gradientId + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1B4553"></stop><stop offset="1" stop-color="#091E2A"></stop></linearGradient></defs>';
    html += '<path class="rc-proqa-marker__pin" d="' + PIN_PATH + '" fill="url(#' + gradientId + ')" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"></path>';
    html += '<circle class="rc-proqa-marker__well" cx="50" cy="38" r="31" fill="#0A222E" stroke="#3B5661" stroke-width="1.4"></circle>';
    html += '<rect class="rc-proqa-marker__highlight" x="32" y="5.5" width="36" height="3.5" rx="1.75" fill="#FFFFFF" opacity=".22"></rect>';
    html += glyphSvg(presentation.icon, 31, 19, 38, '#F8FBFC');
    if (presentation.category === 1) html += glyphSvg('plus', 61, 44, 14, '#42D7C5', 'rc-proqa-marker__focus');
    html += '</svg></span>';
    return html;
  }

  return {
    COLORS: COLORS,
    CATEGORIES: CATEGORIES,
    resolve: resolve,
    glyphSvg: glyphSvg,
    markerHtml: markerHtml
  };
});
