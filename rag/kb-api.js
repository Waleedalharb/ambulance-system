/* ============================================
   KB API - Knowledge Base REST Routes
   منصة الجنوب - نظام إدارة العمليات الإسعافية
   ============================================ */

const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const multer = require('multer');

const { processDocument } = require('./document-processor');
const { SOPRAGIndex, generateAnswer, generateSuggestedQuestions, RAG_CONFIG } = require('./rag-engine');
const { getAgent } = require('./agent-layer');
const { getAIProvider } = require('./ai-provider');
const { SOPRAGIndex, generateAnswer, generateSuggestedQuestions, RAG_CONFIG } = require('./rag-engine');

const router = express.Router();

const logger = {
  info: (msg) => console.log(`[KB-API] ${new Date().toISOString()} INFO: ${msg}`),
  error: (msg, err) => console.error(`[KB-API] ${new Date().toISOString()} ERROR: ${msg}`, err ? (err.message || err) : ''),
};

// ============================================
// SEED SOP DATA (default for testing)
// ============================================
const SEED_SOP_DOCUMENT = `
# بروتوكول تشغيلي تجريبي

# الإجراء رقم: SOP-001
## اسم الإجراء
رفض المريض النقل

## الوصف
يطبق هذا الإجراء عندما يرفض المريض النقل بعد وصول الفرقة الإسعافية إلى الموقع.

## خطوات التنفيذ
1. تقوم الفرقة الإسعافية بتقييم الحالة وتقديم الرعاية اللازمة.
2. يتم تدوين جميع الملاحظات الطبية والسريرية داخل البلاغ.
3. يتم إشعار الطبيب المناوب بالحالة.
4. يتواصل الطبيب مع المريض هاتفياً أو بالطريقة المعتمدة.
5. يقوم الطبيب بشرح الحالة للمريض وتقديم النصائح الطبية المناسبة.
6. إذا وافق المريض على النقل يتم استكمال إجراءات النقل.
7. إذا أصر المريض على رفض النقل بعد استلام النصيحة الطبية يتم توثيق رفض النقل وفق النموذج المعتمد.
8. يتم إغلاق البلاغ بعد اكتمال جميع إجراءات التوثيق.

## ملاحظات
لا يجوز إغلاق البلاغ قبل توثيق جميع الإجراءات.
يجب تسجيل جميع الملاحظات الطبية داخل النظام.

# الإجراء رقم: SOP-002
## اسم الإجراء
تصنيف البلاغات

## الوصف
تصنيف البلاغات حسب درجة الخطورة.

## تصنيفات البلاغ
• ألفا (Alpha)
• برافو (Bravo)
• تشارلي (Charlie)
• دلتا (Delta)

# الإجراء رقم: SOP-003
## اسم الإجراء
آلية نقل حالات دلتا

## الوصف
إجراء نقل الحالات المصنفة دلتا.

## التعليمات
إذا كانت الحالة مصنفة (دلتا):
• يتم نقل المريض إلى أقرب منشأة صحية مناسبة.
• يمنع تجاوز أقرب منشأة صحية إلى منشأة أبعد.
• لا يتم تغيير جهة النقل إلا إذا وجد توجيه رسمي من القيادة أو التنسيق العملياتي.

# الإجراء رقم: SOP-004
## اسم الإجراء
آلية نقل حالات تشارلي

## الوصف
إجراء نقل الحالات المصنفة تشارلي.

## التعليمات
إذا كانت الحالة مصنفة (تشارلي):

إذا كان المريض مواطناً:
• يتم النقل إلى مستشفى حكومي فقط.
• يجب أن يكون المستشفى داخل القطاع.
• لا يسمح بالنقل إلى قطاع آخر إلا بتوجيه رسمي.

إذا كان المريض غير مواطن:
• يتم النقل إلى مستشفى أهلي فقط.
• يجب أن يكون المستشفى داخل القطاع.

# الإجراء رقم: SOP-005
## اسم الإجراء
طلب النقل إلى مستشفى أهلي

## الوصف
إجراء طلب النقل إلى مستشفى أهلي.

## التعليمات
إذا كان المريض مواطناً وطلب النقل إلى مستشفى أهلي وكانت الحالة مصنفة:
• ألفا
• أو تشارلي

فيجب اتباع الخطوات التالية:
1. تقوم الفرقة بإشعار التنسيق العملياتي.
2. يتواصل التنسيق مع المريض أو أحد ذويه.
3. يتم التأكد من رغبتهم بالنقل إلى مستشفى أهلي.
4. يتم توثيق المكالمة داخل البلاغ.
5. يتم استكمال الإجراءات حسب التعليمات المعتمدة.
`;

// ============================================
// CONFIGURATION
// ============================================
const KB_UPLOAD_DIR = path.join(process.env.RENDER_DISK_PATH || process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'uploads', 'kb');
const KB_INDEX_PATH = path.join(__dirname, '..', 'data', 'kb-index.json');

// Ensure upload dir exists
(async function ensureKbDir() {
  try {
    await fs.mkdir(KB_UPLOAD_DIR, { recursive: true });
  } catch (e) { /* ignore */ }
})();

// ============================================
// IN-MEMORY SOP RAG INDEX (rebuilt on startup)
// ============================================
const ragIndex = new SOPRAGIndex();
let indexLoaded = false;

async function loadIndexFromDB(db) {
  try {
    if (!db) {
      logger.info('No DB provided, loading seed SOP data');
      ragIndex.addDocument(SEED_SOP_DOCUMENT, 'seed-doc');
      ragIndex.build();
      indexLoaded = true;
      logger.info(`Loaded seed SOP data: ${ragIndex.sops.length} SOPs`);
      return;
    }
    // Load full documents (not chunks) to parse into SOPs
    const docs = await db.all('SELECT id, doc_id, content FROM kb_documents WHERE content IS NOT NULL AND is_active = 1');
    if (!docs || docs.length === 0) {
      logger.info('No KB documents found in DB, loading seed SOP data');
      ragIndex.addDocument(SEED_SOP_DOCUMENT, 'seed-doc');
      ragIndex.build();
      indexLoaded = true;
      logger.info(`Loaded seed SOP data: ${ragIndex.sops.length} SOPs`);
      return;
    }
    for (const doc of docs) {
      ragIndex.addDocument(doc.content, doc.doc_id || ('doc-' + doc.id));
    }
    ragIndex.build();
    indexLoaded = true;
    logger.info(`Loaded ${docs.length} documents into SOP RAG index, found ${ragIndex.sops.length} SOPs`);
  } catch (err) {
    logger.error('Failed to load RAG index from DB, falling back to seed', err);
    ragIndex.addDocument(SEED_SOP_DOCUMENT, 'seed-doc');
    ragIndex.build();
    indexLoaded = true;
  }
}

async function persistIndex() {
  try {
    const data = ragIndex.serialize();
    await fs.writeFile(KB_INDEX_PATH, JSON.stringify(data, null, 2));
  } catch (err) {
    logger.error('Failed to persist index', err);
  }
}

async function loadIndexFromFile() {
  try {
    const data = JSON.parse(await fs.readFile(KB_INDEX_PATH, 'utf8'));
    ragIndex.deserialize(data);
    indexLoaded = true;
    logger.info('SOP RAG index loaded from file');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      logger.error('Failed to load index from file', err);
    }
    // Fallback to seed data if no file exists
    if (!indexLoaded) {
      logger.info('No index file, loading seed SOP data');
      ragIndex.addDocument(SEED_SOP_DOCUMENT, 'seed-doc');
      ragIndex.build();
      indexLoaded = true;
    }
  }
}

// ============================================
// MULTER CONFIG
// ============================================
const KB_ALLOWED_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/plain',
  'text/html',
  'text/markdown',
  'text/csv',
  'application/octet-stream'
];

const kbStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, KB_UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + crypto.randomBytes(8).toString('hex');
    const ext = path.extname(file.originalname);
    cb(null, unique + ext);
  }
});

const kbUpload = multer({
  storage: kbStorage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const allowedExts = ['.pdf', '.docx', '.doc', '.xlsx', '.xls', '.txt', '.md', '.html', '.htm', '.csv'];
    if (allowedExts.includes(ext) || KB_ALLOWED_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('نوع الملف غير مسموح: ' + file.mimetype));
    }
  }
});

function handleMulterError(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'حجم الملف كبير جداً. الحد الأقصى 20 ميجابايت.' });
    }
    return res.status(400).json({ error: 'خطأ في رفع الملف: ' + err.message });
  } else if (err) {
    return res.status(400).json({ error: err.message });
  }
  next();
}

// ============================================
// ROUTES: DOCUMENTS
// ============================================

// POST /api/rag/upload - Upload a document
router.post('/upload', kbUpload.single('file'), handleMulterError, async (req, res) => {
  try {
    const db = req.app.locals.db;
    if (!db) {
      return res.status(503).json({ error: 'قاعدة البيانات غير متوفرة' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'لم يتم رفع أي ملف' });
    }

    const filePath = req.file.path;
    const originalName = req.file.originalname;
    const mimeType = req.file.mimetype;
    const fileSize = req.file.size;
    const category = req.body.category || 'عام';
    const description = req.body.description || '';
    const uploader = req.user ? (req.user.name || req.user.username) : 'system';

    // 1. Process document (extract text + chunks)
    const proc = await processDocument(filePath, mimeType, originalName);
    if (proc.error && !proc.chunks.length) {
      return res.status(422).json({ error: 'فشل استخراج النص من الملف: ' + proc.error });
    }

    // 2. Save document metadata
    const docId = 'doc-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
    const uploadDate = new Date().toISOString();
    const metaJson = JSON.stringify(proc.meta || {});

    const result = await db.run(
      `INSERT INTO kb_documents (doc_id, title, filename, original_name, file_type, mime_type, file_path, file_size, content, category, description, status, chunk_count, meta, created_by, uploader, upload_date, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [docId, originalName, req.file.filename, originalName, mimeType, mimeType, filePath, fileSize, proc.text, category, description, 'active', proc.chunks.length, metaJson, uploader, uploader, uploadDate, 1]
    );

    const dbDocId = result.id;

    // 3. Save full document text to SOP RAG index (not chunks)
    // The SOPRAGIndex will parse the full text into SOPs automatically
    ragIndex.addDocument(proc.text, docId);
    ragIndex.build();
    await persistIndex();

    res.json({
      success: true,
      docId,
      originalName,
      sopCount: ragIndex.sops.length,
      warning: proc.error || null
    });
  } catch (err) {
    logger.error('Upload failed', err);
    res.status(500).json({ error: 'فشل في معالجة الملف: ' + err.message });
  }
});

// GET /api/rag/documents - List all documents
router.get('/documents', async (req, res) => {
  try {
    const db = req.app.locals.db;
    if (!db) return res.status(503).json({ error: 'قاعدة البيانات غير متوفرة' });
    const docs = await db.all('SELECT id, doc_id, title, original_name, category, description, created_by, uploader, upload_date, file_size, chunk_count, status, created_at FROM kb_documents ORDER BY created_at DESC');
    res.json({ success: true, documents: docs || [] });
  } catch (err) {
    logger.error('List documents failed', err);
    res.status(500).json({ error: 'فشل في جلب الوثائق' });
  }
});

// GET /api/rag/documents/:id - Get document details
router.get('/documents/:id', async (req, res) => {
  try {
    const db = req.app.locals.db;
    if (!db) return res.status(503).json({ error: 'قاعدة البيانات غير متوفرة' });
    const doc = await db.get('SELECT * FROM kb_documents WHERE doc_id = ?', [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'الوثيقة غير موجودة' });
    const chunks = await db.all('SELECT id, chunk_index, content, token_count FROM kb_chunks WHERE document_id = ? ORDER BY chunk_index', [doc.id]);
    res.json({ success: true, document: doc, chunks });
  } catch (err) {
    logger.error('Get document failed', err);
    res.status(500).json({ error: 'فشل في جلب الوثيقة' });
  }
});

// DELETE /api/rag/documents/:id - Delete document and its chunks
router.delete('/documents/:id', async (req, res) => {
  try {
    const db = req.app.locals.db;
    if (!db) return res.status(503).json({ error: 'قاعدة البيانات غير متوفرة' });
    const doc = await db.get('SELECT id, file_path FROM kb_documents WHERE doc_id = ?', [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'الوثيقة غير موجودة' });

    // Delete file from disk
    try {
      if (doc.file_path) await fs.unlink(doc.file_path);
    } catch (e) { /* file may not exist */ }

    // Delete from DB (chunks cascade)
    await db.run('DELETE FROM kb_documents WHERE id = ?', [doc.id]);

    // Remove from index
    ragIndex.removeChunksByDocId(doc.id);
    ragIndex.build();
    await persistIndex();

    res.json({ success: true, message: 'تم حذف الوثيقة بنجاح' });
  } catch (err) {
    logger.error('Delete document failed', err);
    res.status(500).json({ error: 'فشل في حذف الوثيقة' });
  }
});

// GET /api/rag/download/:id - Download original file
router.get('/download/:id', async (req, res) => {
  try {
    const db = req.app.locals.db;
    if (!db) return res.status(503).json({ error: 'قاعدة البيانات غير متوفرة' });
    const doc = await db.get('SELECT original_name, file_path, mime_type FROM kb_documents WHERE doc_id = ?', [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'الوثيقة غير موجودة' });
    res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(doc.original_name) + '"');
    res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
    res.sendFile(doc.file_path);
  } catch (err) {
    logger.error('Download failed', err);
    res.status(500).json({ error: 'فشل في تحميل الملف' });
  }
});

// ============================================
// ROUTES: AI PROVIDER SETTINGS
// ============================================

// GET /api/rag/providers - List available AI providers
router.get('/providers', async (req, res) => {
  try {
    const aiProvider = getAIProvider();
    const providers = aiProvider.getAvailableProviders();
    const activeProvider = aiProvider.getActiveProvider();
    res.json({
      success: true,
      providers,
      activeProvider,
      models: providers.find(p => p.id === activeProvider)?.models || []
    });
  } catch (err) {
    logger.error('Get providers failed', err);
    res.status(500).json({ error: 'فشل في جلب مزودي الذكاء الاصطناعي' });
  }
});

// POST /api/rag/providers/switch - Switch AI provider
router.post('/providers/switch', async (req, res) => {
  try {
    const { provider, model } = req.body;
    const aiProvider = getAIProvider();
    aiProvider.setProvider(provider);
    if (model) aiProvider.setModel(model);
    res.json({ success: true, provider, model: aiProvider.model });
  } catch (err) {
    logger.error('Switch provider failed', err);
    res.status(400).json({ error: err.message });
  }
});

// POST /api/rag/providers/test - Test AI provider connection
router.post('/providers/test', async (req, res) => {
  try {
    const aiProvider = getAIProvider();
    const result = await aiProvider.testConnection();
    res.json({ success: true, result });
  } catch (err) {
    logger.error('Test provider failed', err);
    res.status(500).json({ error: 'فشل في اختبار الاتصال: ' + err.message });
  }
});

// ============================================
// ROUTES: QUERY / CHAT (with Agent Layer)
// ============================================

// POST /api/rag/ask - Query the RAG
router.post('/ask', async (req, res) => {
  try {
    const { query, sessionId, topK } = req.body;
    if (!query || typeof query !== 'string') {
      return res.status(400).json({ error: 'الاستفسار مطلوب' });
    }
    if (query.length > 2000) {
      return res.status(400).json({ error: 'الاستفسار طويل جداً (الحد الأقصى 2000 حرف)' });
    }

    const db = req.app.locals.db;
    const startTime = Date.now();

    // Step 1: Retrieve SOPs from RAG index (top 3 for context)
    const searchResults = ragIndex.search(query, 3);
    const retrievedSOPs = searchResults.map(r => r.sop);

    // Step 2: Process through AI Agent
    const agent = getAgent();
    const result = await agent.processQuery(query, sessionId || ('anon-' + Date.now()), retrievedSOPs);
    const queryTime = Date.now() - startTime;

    // Step 3: Save to query log
    if (db) {
      try {
        await db.run(
          `INSERT INTO kb_queries (query, answer, sources, query_time) VALUES (?, ?, ?, ?)`,
          [query, result.answer, JSON.stringify(result.context || {}), queryTime]
        );
      } catch (e) { /* ignore */ }
    }

    // Step 4: Save to chat history
    if (sessionId && db) {
      try {
        let session = await db.get('SELECT id FROM kb_chat_sessions WHERE session_id = ?', [sessionId]);
        if (!session) {
          await db.run('INSERT INTO kb_chat_sessions (session_id, user_id, title) VALUES (?, ?, ?)', 
            [sessionId, req.user ? req.user.id : null, query.slice(0, 100)]);
          session = await db.get('SELECT id FROM kb_chat_sessions WHERE session_id = ?', [sessionId]);
        }
        await db.run('INSERT INTO kb_chat_messages (session_id, role, content, sources) VALUES (?, ?, ?, ?)', 
          [session.id, 'user', query, null]);
        await db.run('INSERT INTO kb_chat_messages (session_id, role, content, sources) VALUES (?, ?, ?, ?)', 
          [session.id, 'assistant', result.answer, JSON.stringify(result.context || {})]);
        await db.run('UPDATE kb_chat_sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [session.id]);
      } catch (e) { /* ignore */ }
    }

    res.json({
      success: true,
      query,
      answer: result.answer,
      sessionId: result.sessionId,
      context: result.context,
      queryTimeMs: queryTime,
      sopFound: retrievedSOPs.length > 0 ? (retrievedSOPs[0].id + ' – ' + retrievedSOPs[0].name) : null
    });
  } catch (err) {
    logger.error('Agent query failed', err);
    res.status(500).json({ error: 'فشل في معالجة الاستفسار: ' + err.message });
  }
});

// POST /api/rag/clear-session - Clear conversation memory
router.post('/clear-session', async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (sessionId) {
      const agent = getAgent();
      agent.clearSession(sessionId);
    }
    res.json({ success: true, message: 'تم مسح سياق المحادثة' });
  } catch (err) {
    logger.error('Clear session failed', err);
    res.status(500).json({ error: 'فشل في مسح الجلسة' });
  }
});

// GET /api/rag/suggest - Get suggested questions
router.get('/suggest', async (req, res) => {
  try {
    const count = Math.min(parseInt(req.query.count) || 5, 10);
    // Generate suggestions from SOPs (not chunks)
    const questions = generateSuggestedQuestions(ragIndex.sops, count);
    res.json({ success: true, questions });
  } catch (err) {
    logger.error('Suggest failed', err);
    res.status(500).json({ error: 'فشل في توليد الأسئلة المقترحة' });
  }
});

// GET /api/rag/stats - KB statistics
router.get('/stats', async (req, res) => {
  try {
    const db = req.app.locals.db;
    let stats = {
      documents: 0,
      sops: ragIndex.sops ? ragIndex.sops.length : 0,
      queries: 0,
      indexBuilt: ragIndex.isBuilt,
      vocabularySize: ragIndex.vocabulary ? ragIndex.vocabulary.length : 0
    };
    if (db) {
      const docCount = await db.get('SELECT COUNT(*) as c FROM kb_documents');
      const chunkCount = await db.get('SELECT COUNT(*) as c FROM kb_chunks');
      const queryCount = await db.get('SELECT COUNT(*) as c FROM kb_queries');
      stats.documents = docCount ? docCount.c : 0;
      stats.chunks = chunkCount ? chunkCount.c : 0;
      stats.queries = queryCount ? queryCount.c : 0;
    }
    res.json({ success: true, stats });
  } catch (err) {
    logger.error('Stats failed', err);
    res.status(500).json({ error: 'فشل في جلب الإحصائيات' });
  }
});

// ============================================
// ROUTES: CHAT HISTORY
// ============================================

// GET /api/rag/sessions - List chat sessions
router.get('/sessions', async (req, res) => {
  try {
    const db = req.app.locals.db;
    if (!db) return res.status(503).json({ error: 'قاعدة البيانات غير متوفرة' });
    const userId = req.user ? req.user.id : null;
    const sessions = await db.all('SELECT * FROM kb_chat_sessions WHERE user_id = ? OR user_id IS NULL ORDER BY updated_at DESC LIMIT 50', [userId]);
    res.json({ success: true, sessions: sessions || [] });
  } catch (err) {
    logger.error('List sessions failed', err);
    res.status(500).json({ error: 'فشل في جلب الجلسات' });
  }
});

// GET /api/rag/sessions/:id/messages - Get messages in a session
router.get('/sessions/:id/messages', async (req, res) => {
  try {
    const db = req.app.locals.db;
    if (!db) return res.status(503).json({ error: 'قاعدة البيانات غير متوفرة' });
    const session = await db.get('SELECT id FROM kb_chat_sessions WHERE session_id = ?', [req.params.id]);
    if (!session) return res.status(404).json({ error: 'الجلسة غير موجودة' });
    const messages = await db.all('SELECT * FROM kb_chat_messages WHERE session_id = ? ORDER BY created_at', [session.id]);
    res.json({ success: true, messages: messages || [] });
  } catch (err) {
    logger.error('Get messages failed', err);
    res.status(500).json({ error: 'فشل في جلب الرسائل' });
  }
});

// DELETE /api/rag/sessions/:id - Delete a chat session
router.delete('/sessions/:id', async (req, res) => {
  try {
    const db = req.app.locals.db;
    if (!db) return res.status(503).json({ error: 'قاعدة البيانات غير متوفرة' });
    await db.run('DELETE FROM kb_chat_sessions WHERE session_id = ?', [req.params.id]);
    res.json({ success: true, message: 'تم حذف الجلسة' });
  } catch (err) {
    logger.error('Delete session failed', err);
    res.status(500).json({ error: 'فشل في حذف الجلسة' });
  }
});

// POST /api/rag/reindex - Rebuild the RAG index from DB
router.post('/reindex', async (req, res) => {
  try {
    const db = req.app.locals.db;
    if (!db) return res.status(503).json({ error: 'قاعدة البيانات غير متوفرة' });

    // Clear existing index
    ragIndex.chunks = [];
    ragIndex.vocabulary = [];
    ragIndex.idf = {};
    ragIndex.isBuilt = false;

    const tokenize = require('./rag-engine').tokenize;
    const allChunks = await db.all('SELECT id, document_id, doc_id, chunk_index, content FROM kb_chunks WHERE content IS NOT NULL');
    for (const c of allChunks) {
      ragIndex.addChunk({
        id: c.id,
        docId: c.document_id,
        chunkIndex: c.chunk_index,
        content: c.content,
        tokens: tokenize(c.content)
      });
    }
    ragIndex.build();
    await persistIndex();

    res.json({ success: true, message: 'تم إعادة بناء الفهرس بنجاح', chunks: allChunks.length });
  } catch (err) {
    logger.error('Reindex failed', err);
    res.status(500).json({ error: 'فشل في إعادة بناء الفهرس' });
  }
});

// ============================================
// EXPORTS
// ============================================
module.exports = {
  router,
  loadIndexFromDB,
  loadIndexFromFile,
  ragIndex
};
