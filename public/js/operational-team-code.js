/* مصدر واحد لدليل ترميز فرق CAD — الرمز للعرض ولا يغيّر مفاتيح الربط الداخلية. */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OperationalTeamCode = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  /* دليل الترميز V3.0: R-القطاع-[النوع-]المناوبة-الفرقة. */
  var SECTORS = {
    1: { sectorName: 'قطاع وسط مدينة الرياض', displayName: 'وسط الرياض', shortName: 'وسط', rapidName: 'وسط' },
    2: { sectorName: 'قطاع شرق مدينة الرياض', displayName: 'شرق الرياض', shortName: 'شرق', rapidName: 'شرق' },
    3: { sectorName: 'قطاع جنوب الرياض', displayName: 'جنوب الرياض', shortName: 'جنوب', rapidName: 'جنوب' },
    4: { sectorName: 'قطاع غرب مدينة الرياض', displayName: 'غرب الرياض', shortName: 'غرب', rapidName: 'غرب' },
    5: { sectorName: 'قطاع شمال مدينة الرياض', displayName: 'شمال الرياض', shortName: 'شمال', rapidName: 'شمال' },
    6: { sectorName: 'قطاع محافظة الدرعية', displayName: 'محافظة الدرعية', shortName: 'الدرعية', rapidName: 'درعية' },
    7: { sectorName: 'قطاع محافظة شقراء', displayName: 'محافظة شقراء', shortName: 'شقراء', rapidName: 'شقراء' },
    8: { sectorName: 'قطاع محافظة المجمعة', displayName: 'محافظة المجمعة', shortName: 'المجمعة', rapidName: 'المجمعه' },
    9: { sectorName: 'قطاع محافظة الغاط', displayName: 'محافظة الغاط', shortName: 'الغاط', rapidName: 'الغاط' },
    10: { sectorName: 'قطاع محافظة الزلفي', displayName: 'محافظة الزلفي', shortName: 'الزلفي', rapidName: 'الزلفي' },
    11: { sectorName: 'قطاع محافظة رماح', displayName: 'محافظة رماح', shortName: 'رماح', rapidName: 'رماح' },
    12: { sectorName: 'قطاع محافظة الخرج', displayName: 'محافظة الخرج', shortName: 'الخرج', rapidName: 'خرج' },
    13: { sectorName: 'قطاع محافظة حوطة بني تميم', displayName: 'محافظة حوطة بني تميم', shortName: 'حوطة بني تميم', rapidName: 'حوطة بني تميم' },
    14: { sectorName: 'قطاع محافظة الأفلاج', displayName: 'محافظة الأفلاج', shortName: 'الأفلاج', rapidName: 'الأفلاج' },
    15: { sectorName: 'قطاع محافظة وادي الدواسر', displayName: 'محافظة وادي الدواسر', shortName: 'وادي الدواسر', rapidName: 'وادي الدواسر' },
    16: { sectorName: 'قطاع محافظة المزاحمية', displayName: 'محافظة المزاحمية', shortName: 'المزاحمية', rapidName: 'المزاحمية' },
    17: { sectorName: 'قطاع محافظة القويعية', displayName: 'محافظة القويعية', shortName: 'القويعية', rapidName: 'القويعية' },
    18: { sectorName: 'قطاع محافظة الدوادمي', displayName: 'محافظة الدوادمي', shortName: 'الدوادمي', rapidName: 'الدوادمي' },
    19: { sectorName: 'قطاع محافظة عفيف', displayName: 'محافظة عفيف', shortName: 'عفيف', rapidName: 'عفيف' }
  };
  /* «ليلية» محفوظة للتوافق مع بيانات المنصة الحالية، وتقابل «مسائية» في الدليل. */
  var SHIFTS = { 1: 'صباحية', 2: 'ليلية', 3: 'تداخلية', 4: 'على مدار 24 ساعة' };
  var UNIT_TYPES = { R: 'استجابة سريعة', S: 'دراجة أو سكوتر', G: 'جولف', F: 'فراجلة', M: 'باص' };

  function asciiDigits(value) {
    return String(value == null ? '' : value)
      .replace(/[٠-٩]/g, function (digit) { return String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)); })
      .replace(/[۰-۹]/g, function (digit) { return String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)); });
  }

  function normalizeName(value) {
    return asciiDigits(value).replace(/[‎‏‪-‮⁦-⁩﻿]/g, '').replace(/\s+/g, ' ').trim();
  }

  function legacyTeamName(sectorCode, unitType, shiftCode, teamNumber) {
    var sector = SECTORS[sectorCode];
    if (!unitType) return sector.shortName + ' ' + teamNumber;
    if (unitType === 'R') {
      /* اسم «سريع N» هو المفتاح التاريخي القائم لوحدات الجنوب. */
      if (sectorCode === 3) return 'سريع ' + teamNumber;
      return (shiftCode === 3 ? 'ناري ' : 'سريع ') + sector.rapidName + ' ' + teamNumber;
    }
    if (unitType === 'S') return 'هوائي ' + teamNumber;
    if (unitType === 'M') {
      if (sectorCode === 5) return 'باص طويق ' + teamNumber;
      if (sectorCode === 17) return 'باص أحد ' + teamNumber;
      return 'باص ' + sector.shortName + ' ' + teamNumber;
    }
    return UNIT_TYPES[unitType] + ' ' + sector.shortName + ' ' + teamNumber;
  }

  function parseOperationalTeamCode(value) {
    var normalized = asciiDigits(value).trim().toUpperCase();
    var match = /^R-([1-9]|1\d)-(?:(R|S|G|F|M)-)?([1-4])-([1-9]\d*)$/.exec(normalized);
    if (!match) return null;
    var sectorCode = Number(match[1]);
    var sector = SECTORS[sectorCode];
    var teamNumber = Number(match[4]);
    if (!sector || !Number.isSafeInteger(teamNumber) || teamNumber < 1) return null;
    var unitType = match[2] || null;
    var shiftCode = Number(match[3]);
    var operationalCode = 'R-' + sectorCode + '-' + (unitType ? unitType + '-' : '') + shiftCode + '-' + teamNumber;
    var teamName = legacyTeamName(sectorCode, unitType, shiftCode, teamNumber);
    return {
      regionCode: 'R',
      sectorCode: String(sectorCode),
      sectorName: sector.sectorName,
      unitType: unitType,
      unitTypeName: unitType ? UNIT_TYPES[unitType] : 'وحدة إسعافية',
      shiftCode: shiftCode,
      shiftType: SHIFTS[shiftCode],
      teamNumber: teamNumber,
      teamName: teamName,
      operationalCode: operationalCode,
      displayLabel: operationalCode + ' — ' + sector.displayName + ' · فرقة ' + teamNumber +
        (unitType ? ' · ' + UNIT_TYPES[unitType] : '') + ' · ' + SHIFTS[shiftCode]
    };
  }

  function shiftCodeFromType(shiftType) {
    var normalized = normalizeName(shiftType);
    if (normalized === 'صباحية' || normalized === 'صباح' || normalized === '1') return 1;
    if (normalized === 'ليلية' || normalized === 'ليل' || normalized === 'مسائية' || normalized === 'مساء' || normalized === '2') return 2;
    if (normalized === 'تداخلية' || normalized === 'تداخل' || normalized === '3') return 3;
    if (normalized === 'على مدار 24 ساعة' || normalized === 'مدار 24 ساعة' || normalized === '24 ساعة' || normalized === '24' || normalized === '4') return 4;
    return null;
  }

  function identityFromLegacyName(teamName, shiftCode) {
    var normalized = normalizeName(teamName);
    var match;
    for (var sectorCode = 1; sectorCode <= 19; sectorCode += 1) {
      var sector = SECTORS[sectorCode];
      match = new RegExp('^' + sector.shortName + '\\s+([1-9]\\d*)$').exec(normalized);
      if (match) return parseOperationalTeamCode('R-' + sectorCode + '-' + shiftCode + '-' + Number(match[1]));
      match = new RegExp('^(?:سريع|ناري)\\s+' + sector.rapidName + '\\s+([1-9]\\d*)$').exec(normalized);
      if (match) return parseOperationalTeamCode('R-' + sectorCode + '-R-' + shiftCode + '-' + Number(match[1]));
    }
    /* لا تغيير في مفاتيح وحدات الجنوب السريعة المخزنة تاريخيًا. */
    match = /^سريع\s+([1-9]\d*)$/.exec(normalized);
    if (match) return parseOperationalTeamCode('R-3-R-' + shiftCode + '-' + Number(match[1]));
    match = /^هوائي\s+([1-9]\d*)$/.exec(normalized);
    if (match) return parseOperationalTeamCode('R-4-S-' + shiftCode + '-' + Number(match[1]));
    match = /^باص\s+طويق\s+([1-9]\d*)$/.exec(normalized);
    if (match) return parseOperationalTeamCode('R-5-M-' + shiftCode + '-' + Number(match[1]));
    match = /^باص\s+أحد\s+([1-9]\d*)$/.exec(normalized);
    if (match) return parseOperationalTeamCode('R-17-M-' + shiftCode + '-' + Number(match[1]));
    return null;
  }

  function identityFromTeamName(teamName, shiftType) {
    var coded = parseOperationalTeamCode(teamName);
    if (coded) return coded;
    var shiftCode = shiftCodeFromType(shiftType);
    if (!shiftCode) return null;
    return identityFromLegacyName(teamName, shiftCode);
  }

  function identityFields(teamName, shiftType) {
    var identity = identityFromTeamName(teamName, shiftType);
    return {
      name: identity ? identity.teamName : String(teamName == null ? '' : teamName),
      operationalCode: identity ? identity.operationalCode : null,
      sectorName: identity ? identity.sectorName : null,
      teamNumber: identity ? String(identity.teamNumber) : null,
      unitType: identity ? identity.unitType : null,
      shiftType: identity ? identity.shiftType : (shiftType || null),
      displayLabel: identity ? identity.displayLabel : String(teamName == null ? '' : teamName)
    };
  }

  return {
    parseOperationalTeamCode: parseOperationalTeamCode,
    identityFromTeamName: identityFromTeamName,
    identityFields: identityFields,
    shiftCodeFromType: shiftCodeFromType,
    sectors: SECTORS,
    shifts: SHIFTS,
    unitTypes: UNIT_TYPES
  };
});
