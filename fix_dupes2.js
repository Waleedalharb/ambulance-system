const fs = require('fs');
const path = process.argv[2];
let content = fs.readFileSync(path, 'utf-8');

// The duplicate block in openShiftModal uses spaces for indentation (16 spaces for loadShiftToForm)
// We need to match exactly including \r\n line endings

// Fix 1: Remove the duplicate openShiftModal block
// It starts with 16 spaces + loadShiftToForm and ends before async function loadShifts
const dupPattern1 = /(            if \(currentShift\) \{\r?\n                loadShiftToForm\(currentShift\);\r?\n            \} else \{\r?\n                clearShiftForm\(\);\r?\n                var el_shiftDate = document\.getElementById\('shiftDate'\); if \(el_shiftDate\) el_shiftDate\.innerText = getCurrentShiftDate \? getCurrentShiftDate\(\) : getSaudiDate\(\);\r?\n            \}\r?\n        \} else \{\r?\n            clearShiftForm\(\);\r?\n            var el_shiftDate = document\.getElementById\('shiftDate'\); if \(el_shiftDate\) el_shiftDate\.innerText = getCurrentShiftDate \? getCurrentShiftDate\(\) : getSaudiDate\(\);\r?\n        \}\r?\n    \}\);\r?\n\}\r?\n)(\r?\n)*                loadShiftToForm\(currentShift\);\r?\n            \} else \{\r?\n                clearShiftForm\(\);\r?\n                var el_shiftDate = document\.getElementById\('shiftDate'\); if \(el_shiftDate\) el_shiftDate\.innerText = getSaudiDate\(\);\r?\n            \}\r?\n        \} else \{\r?\n            clearShiftForm\(\);\r?\n                var el_shiftDate = document\.getElementById\('shiftDate'\); if \(el_shiftDate\) el_shiftDate\.innerText = getSaudiDate\(\);\r?\n        \}\r?\n    \}\);\r?\n\}/;

content = content.replace(dupPattern1, '$1');

// Fix 2: Remove old boundary check (the one with confirm/reload)
const oldBoundaryPattern = /function startShiftBoundaryCheck\(\) \{\r?\n    lastShiftType = getCurrentShiftType \? getCurrentShiftType\(\) : 'صباح';\r?\n    shiftBoundaryCheckInterval = setInterval\(function\(\) \{\r?\n        var currentType = getCurrentShiftType \? getCurrentShiftType\(\) : 'صباح';\r?\n        if \(currentType !== lastShiftType\) \{\r?\n            console\.log\('\[BOUNDARY\] Shift type changed from', lastShiftType, 'to', currentType\);\r?\n            lastShiftType = currentType;\r?\n            if \(document\.getElementById\('shiftModal'\) && document\.getElementById\('shiftModal'\)\.style\.display === 'flex'\) \{\r?\n                if \(confirm\('تنبيه: تغيرت المناوبة \(صار وقت ' \+ currentType \+ '\)\. هل تبي تحدث النموذج؟'\)\) \{\r?\n                    location\.reload\(\);\r?\n                \}\r?\n            \}\r?\n        \}\r?\n    \}, 30000\);\r?\n\}\r?\n/;
content = content.replace(oldBoundaryPattern, '');

// Fix 3: Remove old saveShiftData
const oldSavePattern = /async function saveShiftData\(\) \{\r?\n    var shiftData = getShiftFromForm\(\);\r?\n    if \(!shiftData\.shiftType\) \{ alert\("❌ الرجاء اختيار نوع المناوبة \(صباحية \/ ليلية\)"\); return; \}\r?\n    var targetId = viewingShiftId \|\| currentShiftId;\r?\n    if \(!targetId\) \{ alert\("❌ لا توجد مناوبة محددة للحفظ\. الرجاء بدء مناوبة جديدة أولاً\."\); return; \}\r?\n    try \{\r?\n        var response = await fetch\('\/api\/update-shift-data', \{ method: 'POST', headers: \{ 'Content-Type': 'application\/json' \}, body: JSON\.stringify\(\{ shiftId: targetId, shiftData: shiftData \}\) \}\);\r?\n        var result = await response\.json\(\);\r?\n        if \(result\.success\) \{\r?\n            alert\("✅ تم حفظ بيانات التكميل بنجاح"\);\r?\n            await loadShifts\(\);\r?\n            await loadAllData\(\);\r?\n            calculateLiveReportStats\(\);\r?\n            updateWorkforceStats\(\);\r?\n            updateDistributionIndicator\(\);\r?\n            if \(viewingShiftId\) \{\r?\n                var viewResponse = await fetch\('\/api\/shifts\/' \+ viewingShiftId\);\r?\n                var viewResult = await viewResponse\.json\(\);\r?\n                if \(viewResult && viewResult\.shift\) \{ loadShiftToForm\(viewResult\.shift\); \}\r?\n            \}\r?\n        \} else \{ alert\("❌ فشل في حفظ البيانات: " \+ \(result\.error \|\| "خطأ غير معروف"\)\); \}\r?\n    \} catch \(error\) \{ alert\("❌ خطأ في الاتصال: " \+ error\.message\); \}\r?\n\}\r?\n/;
content = content.replace(oldSavePattern, '');

// Fix 4: Remove old autoSaveShift
const oldAutoSavePattern = /async function autoSaveShift\(\) \{\r?\n    if \(!currentShiftId\) return;\r?\n    try \{\r?\n        var shiftData = getShiftFromForm\(\);\r?\n        if \(!shiftData\.shiftType\) return;\r?\n\r?\n        await fetch\('\/api\/update-shift-data', \{\r?\n            method: 'POST',\r?\n            headers: \{ 'Content-Type': 'application\/json' \},\r?\n            body: JSON\.stringify\(\{ shiftId: currentShiftId, shiftData: shiftData \}\)\r?\n        \}\);\r?\n\r?\n        _pendingChanges = false;\r?\n        showAutoSaveIndicator\(\);\r?\n    \} catch \(e\) \{ \/\* silently fail \*\/ \}\r?\n\}\r?\n/;
content = content.replace(oldAutoSavePattern, '');

// Clean up excessive blank lines
content = content.replace(/\n{5,}/g, '\n\n\n\n');

fs.writeFileSync(path, content, 'utf-8');
console.log('Done. File size:', content.length, 'chars');
