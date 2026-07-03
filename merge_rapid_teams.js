const fs = require('fs');

// Read eb63e7e version
const eb63Path = process.argv[2];
const eb63 = fs.readFileSync(eb63Path, 'utf-8');

// Read current version
const currentPath = process.argv[3];
let current = fs.readFileSync(currentPath, 'utf-8');

// Extract function by name from source
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

// Extract var assignment by name
function extractVar(source, varName) {
    const regex = new RegExp(`var ${varName}\\s*=`);
    const match = source.match(regex);
    if (!match) return null;
    const start = match.index;
    let i = start;
    let semicolons = 0;
    while (i < source.length && semicolons < 1) {
        if (source[i] === ';') semicolons++;
        i++;
    }
    return source.substring(start, i);
}

// Extract rapidTeams (it's an array, ends with ];)
function extractRapidTeams(source) {
    const start = source.indexOf('var rapidTeams = [');
    if (start === -1) return null;
    let i = start;
    let found = false;
    while (i < source.length - 1) {
        if (source[i] === ']' && source[i+1] === ';') {
            found = true;
            i += 2;
            break;
        }
        i++;
    }
    if (!found) return null;
    return source.substring(start, i);
}

// 1. Extract from eb63e7e
const rapidTeams = extractRapidTeams(eb63);
const buildCentersTable = extractFunction(eb63, 'buildCentersTable');
const updateRapidStatusIcon = extractFunction(eb63, 'updateRapidStatusIcon');
const setRapidComplete = extractFunction(eb63, 'setRapidComplete');
const setRapidIncomplete = extractFunction(eb63, 'setRapidIncomplete');

console.log('Extracted from eb63e7e:');
console.log('  rapidTeams:', rapidTeams ? rapidTeams.length + ' chars' : 'NOT FOUND');
console.log('  buildCentersTable:', buildCentersTable ? buildCentersTable.length + ' chars' : 'NOT FOUND');
console.log('  updateRapidStatusIcon:', updateRapidStatusIcon ? updateRapidStatusIcon.length + ' chars' : 'NOT FOUND');
console.log('  setRapidComplete:', setRapidComplete ? setRapidComplete.length + ' chars' : 'NOT FOUND');
console.log('  setRapidIncomplete:', setRapidIncomplete ? setRapidIncomplete.length + ' chars' : 'NOT FOUND');

// 2. Add rapidTeams after centerList definition (find "var centerList = [")
if (rapidTeams) {
    const centerListMatch = current.match(/var centerList = \[/);
    if (centerListMatch) {
        // Find end of centerList (];
        const start = centerListMatch.index;
        let i = start;
        const start = centerListMatch.index;
)
        const start = centerListMatch.index;
        let i = start;
        let found = false;
        while (i < current.length - 1) {
            if (current[i] === ']' && current[i+1] === ';') {
                found = true;
                i += 2;
                break;
            }
            i++;
        }
        if (found) {
            current = current.substring(0, i) + '\n\n' + rapidTeams + '\n' + current.substring(i);
            console.log('Inserted: rapidTeams');
        }
    }
}

// 3. Replace buildCentersTable
if (buildCentersTable) {
    const oldFunc = extractFunction(current, 'buildCentersTable');
    if (oldFunc) {
        current = current.replace(oldFunc, buildCentersTable);
        console.log('Replaced: buildCentersTable');
    }
}

// 4. Add updateRapidStatusIcon before buildCentersTable or after updateStatusIcon
if (updateRapidStatusIcon) {
    const exists = current.includes('function updateRapidStatusIcon(');
    if (!exists) {
        const insertBefore = 'function buildCentersTable() {';
        const idx = current.indexOf(insertBefore);
        if (idx !== -1) {
            current = current.substring(0, idx) + updateRapidStatusIcon + '\n\n' + current.substring(idx);
            console.log('Inserted: updateRapidStatusIcon');
        }
    }
}

// 5. Add setRapidComplete/setRapidIncomplete after updateRapidStatusIcon
if (setRapidComplete && setRapidIncomplete) {
    const exists = current.includes('function setRapidComplete(');
    if (!exists) {
        const insertAfter = 'function updateRapidStatusIcon(';
        const idx = current.indexOf(insertAfter);
        if (idx !== -1) {
            // Find end of updateRapidStatusIcon
            const funcCode = extractFunction(current, 'updateRapidStatusIcon');
            if (funcCode) {
                const endIdx = current.indexOf(funcCode) + funcCode.length;
                current = current.substring(0, endIdx) + '\n\n' + setRapidComplete + '\n\n' + setRapidIncomplete + '\n' + current.substring(endIdx);
                console.log('Inserted: setRapidComplete, setRapidIncomplete');
            }
        }
    }
}

fs.writeFileSync(currentPath, current, 'utf-8');
console.log('\nDone!');
