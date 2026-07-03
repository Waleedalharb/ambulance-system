const fs = require('fs');

// Read current app.js
const appPath = 'public/js/app.js';
let app = fs.readFileSync(appPath, 'utf-8');

// Read eb63e7e app.js
const eb63Path = process.argv[2] || '/tmp/eb63_app.js';
let eb63 = fs.readFileSync(eb63Path, 'utf-8');

// Extract specific functions from eb63e7e
function extractFunction(source, funcName) {
    const regex = new RegExp(`(async )?function ${funcName}\\(`, 'g');
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

// Extract functions we need (NOT updateRapidStatusIcon - already exists)
const funcs = {
    safeTeamId: extractFunction(eb63, 'safeTeamId'),
    isParamedicPresent: extractFunction(eb63, 'isParamedicPresent'),
    renderTeamParamedics: extractFunction(eb63, 'renderTeamParamedics'),
    fetchTeamParamedics: extractFunction(eb63, 'fetchTeamParamedics'),
    loadTeamParamedics: extractFunction(eb63, 'loadTeamParamedics'),
};

// Check which are missing in current
for (const [name, code] of Object.entries(funcs)) {
    if (!code) {
        console.log(`Warning: Could not extract ${name}`);
        continue;
    }
    const exists = app.includes(`function ${name}(`) || app.includes(`async function ${name}(`);
    if (exists) {
        console.log(`Already exists: ${name}`);
    } else {
        console.log(`Missing: ${name}`);
    }
}

// Insert all missing functions before loadShiftToForm
const insertBefore = 'function loadShiftToForm(shift) {';
const idx = app.indexOf(insertBefore);
if (idx === -1) {
    console.error('Could not find loadShiftToForm insertion point');
    process.exit(1);
}

const toInsert = [
    funcs.safeTeamId,
    funcs.isParamedicPresent,
    funcs.renderTeamParamedics,
    funcs.fetchTeamParamedics,
    funcs.loadTeamParamedics,
].filter(Boolean).join('\n\n');

if (toInsert) {
    app = app.substring(0, idx) + toInsert + '\n\n' + app.substring(idx);
    console.log('Inserted missing paramedic functions');
}

fs.writeFileSync(appPath, app, 'utf-8');
console.log('Done!');
