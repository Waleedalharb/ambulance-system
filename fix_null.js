const fs = require('fs');
const path = 'public/js/app.js';
let lines = fs.readFileSync(path, 'utf-8').split(/\r?\n/);

// Remove lines 2687-2690 (0-indexed: 2686-2689)
// These are: empty saveShiftData, blank, null, blank
// We want to keep the REAL saveShiftData at 2692 (0-indexed: 2691)
// Actually let's find and remove the bad block
const badBlock = [
    'async function saveShiftData(silent) {',
    '}',
    '',
    'null',
    ''
];

for (let i = 0; i < lines.length - badBlock.length + 1; i++) {
    let match = true;
    for (let j = 0; j < badBlock.length; j++) {
        if (lines[i + j].trim() !== badBlock[j].trim()) {
            match = false;
            break;
        }
    }
    if (match) {
        console.log('Removing bad block at line', i + 1);
        lines.splice(i, badBlock.length);
        break;
    }
}

fs.writeFileSync(path, lines.join('\n'), 'utf-8');
console.log('Done');
