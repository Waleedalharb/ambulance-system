/**
 * محول صيغ الجداول إلى مصفوفات قابلة للتحليل مع الاحتفاظ بالدليل الأصلي.
 * لا يستنتج أي معنى تشغيلي هنا؛ التفسير والمراجعة في ImportAnalysisService.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const SUPPORTED = new Set(['xlsx', 'xls', 'xlsm', 'csv', 'pdf', 'png', 'jpg', 'jpeg']);
let ocrWorker = null;

function extensionOf(filename) {
    return path.extname(String(filename || '')).slice(1).toLowerCase();
}
function assertSupported(filename) {
    const ext = extensionOf(filename);
    if (!SUPPORTED.has(ext)) {
        const error = new Error('صيغة غير مدعومة. الصيغ المقبولة: XLSX/XLS/XLSM/CSV/PDF/PNG/JPG/JPEG');
        error.status = 415; error.code = 'UNSUPPORTED_IMPORT_FORMAT'; throw error;
    }
    return ext;
}
function clean(value) {
    return String(value === null || value === undefined ? '' : value).replace(/\u0000/g, '').trim();
}
function trimRows(rows) {
    const width = rows.reduce((n, row) => Math.max(n, row.length), 0);
    return rows.map(row => Array.from({ length: width }, (_, i) => clean(row[i])));
}
function decodeCsv(buffer) {
    let text = buffer.toString('utf8').replace(/^\uFEFF/, '');
    const replacementCount = (text.match(/\uFFFD/g) || []).length;
    if (replacementCount > 0) {
        try { text = new TextDecoder('windows-1256').decode(buffer); } catch (_) { /* UTF-8 يبقى كما هو */ }
    }
    return text;
}
function colorOf(cell) {
    const style = cell && cell.s;
    if (!style) return null;
    const fg = style.fgColor || (style.fill && style.fill.fgColor) || null;
    const font = style.color || (style.font && style.font.color) || null;
    return { fill: fg || null, font: font || null, bold: !!(style.font && style.font.bold) || !!style.bold };
}
function workbookToSheets(workbook) {
    return workbook.SheetNames.map(name => {
        const sheet = workbook.Sheets[name];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false, blankrows: true });
        const cells = {};
        const notes = [];
        for (const [address, cell] of Object.entries(sheet)) {
            if (address.startsWith('!') || !cell || typeof cell !== 'object') continue;
            const decoded = XLSX.utils.decode_cell(address);
            const comments = cell.c ? cell.c.map(comment => ({ author: clean(comment.a), text: clean(comment.t || comment.text) })) : [];
            const style = colorOf(cell);
            cells[`${decoded.r}:${decoded.c}`] = {
                address, raw: cell.v === undefined ? null : cell.v,
                display: clean(cell.w === undefined ? cell.v : cell.w),
                type: cell.t || null, numberFormat: cell.z || null,
                style, comments
            };
            for (const comment of comments) notes.push({ address, ...comment });
        }
        const merges = (sheet['!merges'] || []).map(range => ({
            ref: XLSX.utils.encode_range(range),
            start: { r: range.s.r, c: range.s.c }, end: { r: range.e.r, c: range.e.c }
        }));
        return { name, rows: trimRows(rows), cells, merges, notes, visibility: sheet['!sheet'] || 'visible' };
    });
}
function parseWorkbook(buffer, ext) {
    const input = ext === 'csv' ? decodeCsv(buffer) : buffer;
    const workbook = XLSX.read(input, {
        type: ext === 'csv' ? 'string' : 'buffer',
        cellDates: true, cellStyles: true, cellNF: true, cellText: true,
        raw: ext === 'csv', bookVBA: false, WTF: false
    });
    return workbookToSheets(workbook);
}
function pdfGlobals() {
    const canvas = require('@napi-rs/canvas');
    for (const key of ['DOMMatrix', 'ImageData', 'Path2D']) {
        if (typeof global[key] === 'undefined' && canvas[key]) global[key] = canvas[key];
    }
    return canvas;
}
async function pdfDocument(buffer) {
    pdfGlobals();
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    return pdfjs.getDocument({ data: new Uint8Array(buffer), disableWorker: true, useSystemFonts: true }).promise;
}
function textItemsToRows(items) {
    const lines = [];
    for (const item of items) {
        const text = clean(item.str);
        if (!text) continue;
        const x = Number(item.transform && item.transform[4]) || 0;
        const y = Number(item.transform && item.transform[5]) || 0;
        let line = lines.find(candidate => Math.abs(candidate.y - y) <= 2.5);
        if (!line) { line = { y, items: [] }; lines.push(line); }
        line.items.push({ text, x, width: Number(item.width) || Math.max(4, text.length * 5), hasEOL: !!item.hasEOL });
    }
    lines.sort((a, b) => b.y - a.y);
    return lines.map(line => {
        line.items.sort((a, b) => a.x - b.x);
        const cells = [];
        let current = null, previousEnd = null;
        for (const item of line.items) {
            const gap = previousEnd === null ? 0 : item.x - previousEnd;
            if (!current || gap > 24) { current = { text: item.text, x: item.x }; cells.push(current); }
            else current.text += (gap > 2 ? ' ' : '') + item.text;
            previousEnd = item.x + item.width;
        }
        return cells.map(cell => clean(cell.text));
    });
}
async function getOcrWorker() {
    if (ocrWorker) return ocrWorker;
    const { createWorker } = require('tesseract.js');
    ocrWorker = await createWorker(['ara', 'eng'], 1, {
        langPath: path.join(__dirname, '..', '..', 'assets', 'ocr'),
        gzip: false, cacheMethod: 'none'
    });
    await ocrWorker.setParameters({ preserve_interword_spaces: '1', user_defined_dpi: '200' });
    return ocrWorker;
}
async function ocrImage(buffer) {
    const worker = await getOcrWorker();
    const result = await worker.recognize(buffer, {}, { text: true, tsv: true });
    const data = result.data || {};
    const lines = new Map();
    const tsv = clean(data.tsv);
    if (tsv) {
        const rows = tsv.split(/\r?\n/);
        for (let i = 1; i < rows.length; i++) {
            const parts = rows[i].split('\t');
            if (parts.length < 12 || parts[0] !== '5') continue;
            const text = clean(parts[11]);
            if (!text) continue;
            const key = parts.slice(1, 5).join(':');
            if (!lines.has(key)) lines.set(key, []);
            lines.get(key).push({ text, x: Number(parts[6]) || 0, width: Number(parts[8]) || 0 });
        }
    }
    let rows = [...lines.values()].map(words => {
        words.sort((a, b) => a.x - b.x);
        const cells = []; let current = null, previousEnd = null;
        for (const word of words) {
            const gap = previousEnd === null ? 0 : word.x - previousEnd;
            if (!current || gap > 45) { current = { text: word.text }; cells.push(current); }
            else current.text += ' ' + word.text;
            previousEnd = word.x + word.width;
        }
        return cells.map(cell => clean(cell.text));
    }).filter(row => row.some(Boolean));
    if (!rows.length && clean(data.text)) rows = data.text.split(/\r?\n/).map(line => line.split(/\s{2,}|\t|\|/).map(clean));
    return { rows: trimRows(rows), text: clean(data.text), confidence: Number(data.confidence) || 0 };
}
async function parsePdf(buffer) {
    const document = await pdfDocument(buffer);
    const sheets = []; const warnings = [];
    try {
        for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
            const page = await document.getPage(pageNumber);
            const content = await page.getTextContent();
            let rows = textItemsToRows(content.items || []);
            let text = (content.items || []).map(item => item.str).join(' ');
            let confidence = null, mode = 'native';
            if (clean(text).length < 20 || rows.length < 2) {
                mode = 'ocr';
                const viewport = page.getViewport({ scale: 2.2 });
                const canvas = pdfGlobals().createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
                const context = canvas.getContext('2d');
                await page.render({ canvasContext: context, viewport }).promise;
                const ocr = await ocrImage(canvas.toBuffer('image/png'));
                rows = ocr.rows; text = ocr.text; confidence = ocr.confidence;
                if (confidence < 55) warnings.push(`ثقة OCR منخفضة في الصفحة ${pageNumber}: ${confidence}%؛ المراجعة البشرية مطلوبة.`);
            }
            sheets.push({ name: `صفحة ${pageNumber}`, rows: trimRows(rows), cells: {}, merges: [], notes: [], text, extraction: mode, ocrConfidence: confidence });
        }
    } finally { await document.destroy(); }
    return { sheets, warnings };
}
async function parseByFormat(buffer, filename) {
    const ext = assertSupported(filename);
    if (!Buffer.isBuffer(buffer) || !buffer.length) {
        const error = new Error('الملف فارغ'); error.status = 422; error.code = 'EMPTY_IMPORT_FILE'; throw error;
    }
    if (['xlsx', 'xls', 'xlsm', 'csv'].includes(ext)) {
        return { format: ext, sheets: parseWorkbook(buffer, ext), warnings: [] };
    }
    if (ext === 'pdf') {
        const parsed = await parsePdf(buffer); return { format: ext, ...parsed };
    }
    const ocr = await ocrImage(buffer);
    return {
        format: ext, warnings: ocr.confidence < 55 ? [`ثقة OCR منخفضة: ${ocr.confidence}%؛ راجع جميع العناصر قبل الاستيراد.`] : [],
        sheets: [{ name: 'صورة الجدول', rows: ocr.rows, cells: {}, merges: [], notes: [], text: ocr.text, extraction: 'ocr', ocrConfidence: ocr.confidence }]
    };
}
async function closeOcrWorker() {
    if (ocrWorker) { await ocrWorker.terminate(); ocrWorker = null; }
}

module.exports = { SUPPORTED, extensionOf, assertSupported, parseByFormat, parseWorkbook, ocrImage, closeOcrWorker, clean, trimRows };
