/* ============================================
   DOCUMENT PROCESSOR - RAG Knowledge Base
   منصة الجنوب - نظام إدارة العمليات الإسعافية
   ============================================
   Handles: PDF, Word, Excel, Text, HTML
   Graceful fallback if libraries not installed
   ============================================ */

const fs = require('fs').promises;
const path = require('path');

const logger = {
  info: (msg) => console.log(`[RAG-DOC] ${new Date().toISOString()} INFO: ${msg}`),
  error: (msg, err) => console.error(`[RAG-DOC] ${new Date().toISOString()} ERROR: ${msg}`, err ? (err.message || err) : ''),
  warn: (msg) => console.warn(`[RAG-DOC] ${new Date().toISOString()} WARN: ${msg}`),
};

// ============================================
// LIBRARY DETECTION (graceful fallback)
// ============================================
let pdfParse = null;
let mammoth = null;
let xlsx = null;

try { pdfParse = require('pdf-parse'); } catch (e) { logger.warn('pdf-parse not installed. PDF processing will be limited.'); }
try { mammoth = require('mammoth'); } catch (e) { logger.warn('mammoth not installed. Word processing will be limited.'); }
try { xlsx = require('xlsx'); } catch (e) { logger.warn('xlsx not installed. Excel processing will be limited.'); }

// ============================================
// CHUNKING CONFIGURATION
// ============================================
const CHUNK_SIZE = 512;      // target characters per chunk
const CHUNK_OVERLAP = 128;   // overlap between chunks
const MAX_CHUNK_SIZE = 1024; // hard limit

// ============================================
// TEXT NORMALIZATION (Arabic-friendly)
// ============================================
function normalizeText(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '') // remove tashkeel
    .replace(/[\u0660-\u0669]/g, d => String.fromCharCode(d.charCodeAt(0) - 0x0660 + 0x0030)) // Arabic numerals to ASCII
    .replace(/\s+/g, ' ')          // normalize whitespace
    .replace(/[\u200B-\u200F\uFEFF]/g, '') // remove zero-width chars
    .trim();
}

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&\w+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ============================================
// CHUNKING STRATEGY
// ============================================
function splitIntoChunks(text, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  if (!text) return [];
  const normalized = normalizeText(text);
  if (normalized.length <= chunkSize) return normalized.trim() ? [normalized] : [];

  const chunks = [];
  const sentences = normalized.split(/(?<=[.!?。،\n])\s+/); // split on sentence boundaries

  let currentChunk = '';
  for (const sentence of sentences) {
    const s = sentence.trim();
    if (!s) continue;

    // If adding this sentence exceeds chunk size, save current and start new
    if (currentChunk.length + s.length + 1 > chunkSize && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      // Keep overlap: last part of current chunk
      const overlapText = currentChunk.slice(-overlap);
      currentChunk = overlapText + ' ' + s;
    } else {
      currentChunk = currentChunk ? currentChunk + ' ' + s : s;
    }

    // If current chunk exceeds max, force split
    if (currentChunk.length > MAX_CHUNK_SIZE) {
      chunks.push(currentChunk.slice(0, MAX_CHUNK_SIZE).trim());
      currentChunk = currentChunk.slice(MAX_CHUNK_SIZE - overlap);
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  // Deduplicate exact chunks
  return [...new Set(chunks)].filter(c => c.length > 20); // min 20 chars
}

// ============================================
// PARSERS BY FILE TYPE
// ============================================

async function parsePDF(filePath) {
  try {
    if (pdfParse) {
      const dataBuffer = await fs.readFile(filePath);
      const result = await pdfParse(dataBuffer);
      return { text: result.text || '', pages: result.numpages || 0 };
    }
  } catch (err) {
    logger.error('PDF parse error', err);
  }
  // Fallback: try to read as text (some PDFs are text-based)
  try {
    const buf = await fs.readFile(filePath);
    const text = buf.toString('utf-8');
    // Extract text between stream/endstream or just plain text
    const extracted = text.replace(/[^\x20-\x7E\u0600-\u06FF\n\r\s]/g, ' ').replace(/\s+/g, ' ');
    return { text: extracted.slice(0, 50000), pages: 0, fallback: true };
  } catch (e) {
    return { text: '', pages: 0, error: 'PDF parsing failed. Install pdf-parse.' };
  }
}

async function parseWord(filePath) {
  try {
    if (mammoth) {
      const result = await mammoth.extractRawText({ path: filePath });
      return { text: result.value || '', fallback: false };
    }
  } catch (err) {
    logger.error('Word parse error', err);
  }
  // Fallback: read as zip and extract text from xml
  try {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(filePath);
    const xmlEntry = zip.getEntry('word/document.xml');
    if (xmlEntry) {
      const xml = zip.readAsText(xmlEntry);
      const text = xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      return { text: text.slice(0, 50000), fallback: true };
    }
  } catch (e) {
    // adm-zip may not be available either
  }
  return { text: '', fallback: true, error: 'Word parsing failed. Install mammoth.' };
}

async function parseExcel(filePath) {
  try {
    if (xlsx) {
      const workbook = xlsx.readFile(filePath);
      let text = '';
      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        const json = xlsx.utils.sheet_to_json(sheet, { header: 1 });
        text += `Sheet: ${sheetName}\n`;
        for (const row of json) {
          text += row.join('\t') + '\n';
        }
        text += '\n';
      }
      return { text, sheets: workbook.SheetNames.length };
    }
  } catch (err) {
    logger.error('Excel parse error', err);
  }
  return { text: '', error: 'Excel parsing failed. Install xlsx.' };
}

async function parseText(filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf-8');
    return { text };
  } catch (err) {
    return { text: '', error: err.message };
  }
}

async function parseHtml(filePath) {
  try {
    const html = await fs.readFile(filePath, 'utf-8');
    return { text: stripHtml(html) };
  } catch (err) {
    return { text: '', error: err.message };
  }
}

// ============================================
// MAIN PROCESSING PIPELINE
// ============================================
async function processDocument(filePath, mimeType, originalName) {
  const ext = path.extname(originalName || filePath).toLowerCase();
  let result = { text: '', meta: { fileType: ext, pages: 0, sheets: 0 } };

  try {
    if (ext === '.pdf' || mimeType === 'application/pdf') {
      result = await parsePDF(filePath);
      result.meta = { fileType: 'pdf', pages: result.pages || 0 };
    } else if (ext === '.docx' || ext === '.doc' || mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      result = await parseWord(filePath);
      result.meta = { fileType: 'word' };
    } else if (ext === '.xlsx' || ext === '.xls' || mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
      result = await parseExcel(filePath);
      result.meta = { fileType: 'excel', sheets: result.sheets || 0 };
    } else if (ext === '.html' || ext === '.htm' || mimeType === 'text/html') {
      result = await parseHtml(filePath);
      result.meta = { fileType: 'html' };
    } else if (ext === '.txt' || ext === '.md' || ext === '.csv' || mimeType === 'text/plain' || mimeType === 'text/markdown' || mimeType === 'text/csv') {
      result = await parseText(filePath);
      result.meta = { fileType: 'text' };
    } else {
      // Try text fallback
      result = await parseText(filePath);
      result.meta = { fileType: 'text', fallback: true };
    }
  } catch (err) {
    logger.error('Document processing failed', err);
    result = { text: '', error: err.message, meta: { fileType: 'unknown' } };
  }

  const chunks = splitIntoChunks(result.text || '');

  return {
    text: result.text || '',
    chunks,
    chunkCount: chunks.length,
    meta: result.meta || {},
    error: result.error || null
  };
}

// ============================================
// EXPORTS
// ============================================
module.exports = {
  processDocument,
  splitIntoChunks,
  normalizeText,
  stripHtml,
  CHUNK_SIZE,
  CHUNK_OVERLAP
};
