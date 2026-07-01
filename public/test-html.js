const fs = require('fs');

const html = fs.readFileSync('index.html', 'utf8');
const lines = html.split('\n');

// Find modals and their initial display state
const modals = [];
lines.forEach((line, i) => {
  if (/<div[^>]*id="[^"]*Modal"/.test(line) || /<div[^>]*class="modal"/.test(line)) {
    const displayMatch = line.match(/display\s*:\s*([^"';]+)/);
    modals.push({ 
      line: i+1, 
      text: line.trim().substring(0, 120),
      display: displayMatch ? displayMatch[1].trim() : 'not set'
    });
  }
});

console.log('Modals found:', modals.length);
modals.forEach(m => console.log('Line', m.line, 'display:', m.display, '|', m.text));

// Check for initial display:none on critical elements
console.log('');
console.log('=== Checking for display:none in HTML ===');
const displayNone = [];
lines.forEach((line, i) => {
  if (/display\s*:\s*none/.test(line)) {
    displayNone.push({ line: i+1, text: line.trim().substring(0, 120) });
  }
});
console.log('display:none instances:', displayNone.length);
displayNone.forEach(d => console.log('Line', d.line, ':', d.text));
