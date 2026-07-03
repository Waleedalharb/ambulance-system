const fs = require('fs');

// Read current file (origin/main with remote fixes)
const currentPath = process.argv[2];
let current = fs.readFileSync(currentPath, 'utf-8');

// Read eb63e7e file (with shift management code)
const eb63Path = process.argv[3];
const eb63 = fs.readFileSync(eb63Path, 'utf-8');

// Function to extract a function block by name
function extractFunction(source, funcName) {
    const regex = new RegExp(`(async )?function ${funcName}\\(.*?\\) \\{`, 'g');
    let match;
    while ((match = regex.exec(source)) !== null) {
        const start = match.index;
        let braceCount = 1;
        let i = source.indexOf('{', start) + 1;
        while (braceCount > 0 && i < source.length) {
            if (source[i] === '{') braceCount++;
            else if (source[i] === '}') braceCount--;
            i++;
        }
        return source.substring(start, i);
    }
    return null;
}

// Extract shift management functions from eb63e7e
const funcs = {
    getCurrentShiftType: extractFunction(eb63, 'getCurrentShiftType'),
    getCurrentShiftDate: extractFunction(eb63, 'getCurrentShiftDate'),
    getShiftDraftKey: extractFunction(eb63, 'getShiftDraftKey'),
    getShiftDraftKeyFor: extractFunction(eb63, 'getShiftDraftKeyFor'),
    saveShiftDraft: extractFunction(eb63, 'saveShiftDraft'),
    loadShiftDraft: extractFunction(eb63, 'loadShiftDraft'),
    loadShiftDraftFor: extractFunction(eb63, 'loadShiftDraftFor'),
    clearShiftDraft: extractFunction(eb63, 'clearShiftDraft'),
    clearShiftDraftFor: extractFunction(eb63, 'clearShiftDraftFor'),
    hasShiftDraft: extractFunction(eb63, 'hasShiftDraft'),
    loadDraftToForm: extractFunction(eb63, 'loadDraftToForm'),
    startShiftBoundaryCheck: extractFunction(eb63, 'startShiftBoundaryCheck'),
    stopShiftBoundaryCheck: extractFunction(eb63, 'stopShiftBoundaryCheck'),
    saveShiftData: extractFunction(eb63, 'saveShiftData'),
    loadShiftToForm: extractFunction(eb63, 'loadShiftToForm'),
    getShiftFromForm: extractFunction(eb63, 'getShiftFromForm'),
    clearShiftForm: extractFunction(eb63, 'clearShiftForm'),
};

// Check which functions are missing in current
const missing = [];
for (const [name, code] of Object.entries(funcs)) {
    if (!code) {
        console.log(`Warning: Could not extract ${name}`);
        continue;
    }
    const exists = current.includes(`function ${name}(`) || current.includes(`async function ${name}(`);
    if (!exists) {
        missing.push({ name, code });
        console.log(`Missing: ${name}`);
    } else {
        console.log(`Already exists: ${name}`);
    }
}

console.log(`\nTotal missing: ${missing.length}`);

// Insert missing functions into current file
// Insert getCurrentShiftType and getCurrentShiftDate after getSaudiMonthYear
if (funcs.getCurrentShiftType && funcs.getCurrentShiftDate) {
    const insertAfter = 'function getSaudiMonthYear() {';
    const idx = current.lastIndexOf(insertAfter);
    if (idx !== -1) {
        // Find end of getSaudiMonthYear function
        let braceCount = 1;
        let i = current.indexOf('{', idx) + 1;
        while (braceCount > 0 && i < current.length) {
            if (current[i] === '{') braceCount++;
            else if (current[i] === '}') braceCount--;
            i++;
        }
        const insertPoint = i;
        const toInsert = '\n\n// ============================================\n// نظام النوبة التلقائي (Auto-Shift)\n// ============================================\n' + 
            funcs.getCurrentShiftType + '\n\n' + funcs.getCurrentShiftDate + '\n';
        current = current.substring(0, insertPoint) + toInsert + current.substring(insertPoint);
        console.log('Inserted: getCurrentShiftType, getCurrentShiftDate');
    }
}

// Insert draft system after returnToCurrentShift
if (funcs.saveShiftDraft) {
    const insertAfter = 'async function returnToCurrentShift() {';
    const idx = current.indexOf(insertAfter);
    if (idx !== -1) {
        let braceCount = 1;
        let i = current.indexOf('{', idx) + 1;
        while (braceCount > 0 && i < current.length) {
            if (current[i] === '{') braceCount++;
            else if (current[i] === '}') braceCount--;
            i++;
        }
        const insertPoint = i;
        const draftFuncs = [
            funcs.getShiftDraftKey,
            funcs.getShiftDraftKeyFor,
            funcs.saveShiftDraft,
            funcs.loadShiftDraft,
            funcs.loadShiftDraftFor,
            funcs.clearShiftDraft,
            funcs.clearShiftDraftFor,
            funcs.hasShiftDraft,
            funcs.loadDraftToForm,
        ].filter(Boolean).join('\n\n');
        const toInsert = '\n\n// ============================================\n// نظام الحفظ التلقائي (Draft Auto-Save)\n// ============================================\n' + draftFuncs + '\n';
        current = current.substring(0, insertPoint) + toInsert + current.substring(insertPoint);
        console.log('Inserted: draft system');
    }
}

// Insert boundary check before saveShiftData
if (funcs.startShiftBoundaryCheck) {
    const insertBefore = 'async function saveShiftData() {';
    const idx = current.indexOf(insertBefore);
    if (idx !== -1) {
        const toInsert = '// ============================================\n// فحص تغيير حدود المناوبة (Boundary Check)\n// ============================================\n' +
            funcs.startShiftBoundaryCheck + '\n\n' + funcs.stopShiftBoundaryCheck + '\n\n';
        current = current.substring(0, idx) + toInsert + current.substring(idx);
        console.log('Inserted: boundary check');
    }
}

// Replace saveShiftData
if (funcs.saveShiftData) {
    const oldFunc = extractFunction(current, 'saveShiftData');
    if (oldFunc) {
        current = current.replace(oldFunc, funcs.saveShiftData);
        console.log('Replaced: saveShiftData');
    }
}

// Replace loadShiftToForm
if (funcs.loadShiftToForm) {
    const oldFunc = extractFunction(current, 'loadShiftToForm');
    if (oldFunc) {
        current = current.replace(oldFunc, funcs.loadShiftToForm);
        console.log('Replaced: loadShiftToForm');
    }
}

// Replace getShiftFromForm
if (funcs.getShiftFromForm) {
    const oldFunc = extractFunction(current, 'getShiftFromForm');
    if (oldFunc) {
        current = current.replace(oldFunc, funcs.getShiftFromForm);
        console.log('Replaced: getShiftFromForm');
    }
}

// Replace clearShiftForm
if (funcs.clearShiftForm) {
    const oldFunc = extractFunction(current, 'clearShiftForm');
    if (oldFunc) {
        current = current.replace(oldFunc, funcs.clearShiftForm);
        console.log('Replaced: clearShiftForm');
    }
}

fs.writeFileSync(currentPath, current, 'utf-8');
console.log('\nDone! File written.');
