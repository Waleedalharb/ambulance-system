const fs = require('fs');

let content = fs.readFileSync('public/index.html', 'utf8');

const oldStart = '/* ===== Light & Warm Theme for shiftModal ONLY ===== */';
const oldEnd = '/* إخفاء الواجهة القديمة فوراً قبل تحميل CSS الخارجي */';

const startIdx = content.indexOf(oldStart);
const endIdx = content.indexOf(oldEnd);

console.log('startIdx:', startIdx);
console.log('endIdx:', endIdx);

if (startIdx !== -1 && endIdx !== -1) {
    const styleOpen = content.lastIndexOf('<style>', startIdx);
    console.log('styleOpen:', styleOpen);
    
    const before = content.substring(0, styleOpen);
    const after = content.substring(endIdx);
    
    const newCSS = `<style>
        /* ===== Modern Smart Interactive Theme for shiftModal ===== */
        #shiftModal.modal {
            background: rgba(11, 30, 51, 0.6) !important;
            backdrop-filter: blur(16px) !important;
            -webkit-backdrop-filter: blur(16px) !important;
        }
        #shiftModal .modal-content {
            background: rgba(255, 255, 255, 0.88) !important;
            backdrop-filter: blur(24px) !important;
            -webkit-backdrop-filter: blur(24px) !important;
            border: 1px solid rgba(255, 255, 255, 0.6) !important;
            border-radius: 24px !important;
            box-shadow: 0 25px 80px rgba(11, 30, 51, 0.15), 0 0 0 1px rgba(255,255,255,0.4) inset !important;
            color: #2C3E50 !important;
            overflow: hidden !important;
        }
    </style>`;
    
    const newContent = before + newCSS + '\n    <style>\n        ' + after;
    fs.writeFileSync('public/index.html', newContent, 'utf8');
    console.log('Success!');
} else {
    console.log('Not found');
}
