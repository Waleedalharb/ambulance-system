const fs = require('fs');
const path = process.argv[2];
let content = fs.readFileSync(path, 'utf-8');

// Fix 1: Remove duplicate block in openShiftModal
// The duplicate starts with "                loadShiftToForm(currentShift);" (indented with spaces)
// and ends with the closing of the function before "async function loadShifts()"
const dup1 = `                loadShiftToForm(currentShift);
            } else {
                clearShiftForm();
                var el_shiftDate = document.getElementById('shiftDate'); if (el_shiftDate) el_shiftDate.innerText = getSaudiDate();
            }
        } else {
            clearShiftForm();
            var el_shiftDate = document.getElementById('shiftDate'); if (el_shiftDate) el_shiftDate.innerText = getSaudiDate();
        }
    });
}`;
content = content.replace(dup1, '');

// Fix 2: Remove old startShiftBoundaryCheck after the new one
const oldBoundary = `    lastShiftType = getCurrentShiftType ? getCurrentShiftType() : 'صباح';
    shiftBoundaryCheckInterval = setInterval(function() {
        var currentType = getCurrentShiftType ? getCurrentShiftType() : 'صباح';
        if (currentType !== lastShiftType) {
            console.log('[BOUNDARY] Shift type changed from', lastShiftType, 'to', currentType);
            lastShiftType = currentType;
            if (document.getElementById('shiftModal') && document.getElementById('shiftModal').style.display === 'flex') {
                if (confirm('تنبيه: تغيرت المناوبة (صار وقت ' + currentType + '). هل تبي تحدث النموذج؟')) {
                    location.reload();
                }
            }
        }
    }, 30000);
}`;
content = content.replace(oldBoundary, '');

// Fix 3: Remove old saveShiftData after the new one
const oldSaveShift = `    var shiftData = getShiftFromForm();
    if (!shiftData.shiftType) { alert("❌ الرجاء اختيار نوع المناوبة (صباحية / ليلية)"); return; }
    var targetId = viewingShiftId || currentShiftId;
    if (!targetId) { alert("❌ لا توجد مناوبة محددة للحفظ. الرجاء بدء مناوبة جديدة أولاً."); return; }
    try {
        var response = await fetch('/api/update-shift-data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shiftId: targetId, shiftData: shiftData }) });
        var result = await response.json();
        if (result.success) {
            alert("✅ تم حفظ بيانات التكميل بنجاح");
            await loadShifts();
            await loadAllData();
            calculateLiveReportStats();
            updateWorkforceStats();
            updateDistributionIndicator();
            if (viewingShiftId) {
                var viewResponse = await fetch('/api/shifts/' + viewingShiftId);
                var viewResult = await viewResponse.json();
                if (viewResult && viewResult.shift) { loadShiftToForm(viewResult.shift); }
            }
        } else { alert("❌ فشل في حفظ البيانات: " + (result.error || "خطأ غير معروف")); }
    } catch (error) { alert("❌ خطأ في الاتصال: " + error.message); }
}`;
content = content.replace(oldSaveShift, '');

// Fix 4: Remove old autoSaveShift after the new one
const oldAutoSave = `    if (!currentShiftId) return;
    try {
        var shiftData = getShiftFromForm();
        if (!shiftData.shiftType) return;

        await fetch('/api/update-shift-data', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ shiftId: currentShiftId, shiftData: shiftData })
        });

        _pendingChanges = false;
        showAutoSaveIndicator();
    } catch (e) { /* silently fail */ }
}`;
content = content.replace(oldAutoSave, '');

// Clean up any extra blank lines
content = content.replace(/\n{4,}/g, '\n\n\n');

fs.writeFileSync(path, content, 'utf-8');
console.log('Done. File size:', content.length);
