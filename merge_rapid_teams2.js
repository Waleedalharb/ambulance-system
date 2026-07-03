const fs = require('fs');

const eb63Path = process.argv[2];
const currentPath = process.argv[3];
const eb63 = fs.readFileSync(eb63Path, 'utf-8');
let current = fs.readFileSync(currentPath, 'utf-8');

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

function extractRapidTeams(source) {
    const start = source.indexOf('var rapidTeams = [');
    if (start === -1) return null;
    let i = start;
    while (i < source.length - 1) {
        if (source[i] === ']' && source[i+1] === ';') {
            i += 2;
            break;
        }
        i++;
    }
    return source.substring(start, i);
}

const rapidTeams = extractRapidTeams(eb63);
const buildCentersTable = extractFunction(eb63, 'buildCentersTable');
const updateRapidStatusIcon = extractFunction(eb63, 'updateRapidStatusIcon');
const setRapidComplete = extractFunction(eb63, 'setRapidComplete');
const setRapidIncomplete = extractFunction(eb63, 'setRapidIncomplete');

console.log('Extracted:');
console.log('  rapidTeams:', rapidTeams ? 'yes' : 'NO');
console.log('  buildCentersTable:', buildCentersTable ? 'yes' : 'NO');
console.log('  updateRapidStatusIcon:', updateRapidStatusIcon ? 'yes' : 'NO');
console.log('  setRapidComplete:', setRapidComplete ? 'yes' : 'NO');
console.log('  setRapidIncomplete:', setRapidIncomplete ? 'yes' : 'NO');

// Add rapidTeams after centerList
if (rapidTeams) {
    const idx = current.indexOf('var centerList = [');
    if (idx !== -1) {
        let i = idx;
        while (i < current.length - 1) {
            if (current[i] === ']' && current[i+1] === ';') { i += 2; break; }
            i++;
        }
        current = current.substring(0, i) + '\n\n' + rapidTeams + '\n' + current.substring(i);
        console.log('Inserted: rapidTeams');
    }
}

// Replace buildCentersTable
if (buildCentersTable) {
    const oldFunc = extractFunction(current, 'buildCentersTable');
    if (oldFunc) {
        current = current.replace(oldFunc, buildCentersTable);
        console.log('Replaced: buildCentersTable');
    }
}

// Add updateRapidStatusIcon before buildCentersTable
if (updateRapidStatusIcon) {
    if (!current.includes('function updateRapidStatusIcon(')) {
        const idx = current.indexOf('function buildCentersTable() {');
        if (idx !== -1) {
            current = current.substring(0, idx) + updateRapidStatusIcon + '\n\n' + current.substring(idx);
            console.log('Inserted: updateRapidStatusIcon');
        }
    }
}

// Add setRapidComplete after updateRapidStatusIcon
if (setRapidComplete && setRapidIncomplete) {
    if (!current.includes('function setRapidComplete(')) {
        const funcCode = extractFunction(current, 'updateRapidStatusIcon');
        if (funcCode) {
            const endIdx = current.indexOf(funcCode) + funcCode.length;
            current = current.substring(0, endIdx) + '\n\n' + setRapidComplete + '\n\n' + setRapidIncomplete + '\n' + current.substring(endIdx);
            console.log('Inserted: setRapidComplete, setRapidIncomplete');
        }
    }
}

fs.writeFileSync(currentPath, current, 'utf-8');
console.log('\nDone!');
