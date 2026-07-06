/* ============================================
   RAG ENGINE - TF-IDF + Cosine Similarity
   منصة الجنوب - نظام إدارة العمليات الإسعافية
   ============================================
   Pure JavaScript, no GPU, no external AI API
   Supports future OpenAI integration via config
   ============================================ */

const fs = require('fs').promises;
const path = require('path');

const logger = {
  info: (msg) => console.log(`[RAG-ENGINE] ${new Date().toISOString()} INFO: ${msg}`),
  error: (msg, err) => console.error(`[RAG-ENGINE] ${new Date().toISOString()} ERROR: ${msg}`, err ? (err.message || err) : ''),
  warn: (msg) => console.warn(`[RAG-ENGINE] ${new Date().toISOString()} WARN: ${msg}`),
};

// ============================================
// CONFIGURATION
// ============================================
const RAG_CONFIG = {
  topK: 5,              // number of chunks to retrieve
  minSimilarity: 0.01,  // minimum cosine similarity threshold
  maxContextLength: 3000, // max characters from retrieved chunks
  enableOpenAI: false,  // future: set to true and provide OPENAI_API_KEY
  openAIKey: process.env.OPENAI_API_KEY || null,
  openAIModel: 'gpt-4o-mini',
  // Template-based answer generation (no LLM)
  useTemplates: true
};

// ============================================
// TOKENIZATION (Arabic + English support)
// ============================================
function tokenize(text) {
  if (!text) return [];
  const normalized = text
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '') // remove tashkeel
    .replace(/[\u0660-\u0669]/g, d => String.fromCharCode(d.charCodeAt(0) - 0x0660 + 0x0030))
    .replace(/[^\w\u0600-\u06FF\u0750-\u077F]/g, ' ') // keep Arabic + alphanumeric
    .replace(/\s+/g, ' ')
    .trim();

  const words = normalized.split(/\s+/).filter(w => w.length > 1);
  return words;
}

// ============================================
// TF-IDF VECTORIZATION
// ============================================
function computeTF(tokens) {
  const tf = {};
  const total = tokens.length;
  if (total === 0) return tf;
  for (const token of tokens) {
    tf[token] = (tf[token] || 0) + 1;
  }
  for (const key of Object.keys(tf)) {
    tf[key] = tf[key] / total;
  }
  return tf;
}

function computeIDF(documents) {
  const idf = {};
  const N = documents.length;
  if (N === 0) return idf;

  // Count document frequency for each term
  const df = {};
  for (const doc of documents) {
    const uniqueTokens = new Set(doc);
    for (const token of uniqueTokens) {
      df[token] = (df[token] || 0) + 1;
    }
  }

  for (const [term, freq] of Object.entries(df)) {
    idf[term] = Math.log(N / (freq + 1)) + 1; // smoothed IDF
  }
  return idf;
}

function computeTFIDF(tf, idf) {
  const tfidf = {};
  for (const [term, tfVal] of Object.entries(tf)) {
    const idfVal = idf[term] || 0;
    tfidf[term] = tfVal * idfVal;
  }
  return tfidf;
}

function vectorize(tfidf, vocabulary) {
  return vocabulary.map(term => tfidf[term] || 0);
}

// ============================================
// COSINE SIMILARITY
// ============================================
function cosineSimilarity(vecA, vecB) {
  if (vecA.length !== vecB.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ============================================
// INDEX MANAGEMENT
// ============================================
class RAGIndex {
  constructor() {
    this.chunks = [];       // { id, docId, chunkIndex, content, tokens, tfidf }
    this.vocabulary = [];   // sorted unique terms
    this.idf = {};          // global IDF
    this.isBuilt = false;
  }

  addChunk(chunk) {
    this.chunks.push(chunk);
    this.isBuilt = false;
  }

  removeChunksByDocId(docId) {
    this.chunks = this.chunks.filter(c => c.docId !== docId);
    this.isBuilt = false;
  }

  build() {
    if (this.chunks.length === 0) {
      this.vocabulary = [];
      this.idf = {};
      this.isBuilt = true;
      return;
    }

    const documents = this.chunks.map(c => c.tokens);
    this.idf = computeIDF(documents);
    this.vocabulary = Object.keys(this.idf).sort();

    for (const chunk of this.chunks) {
      const tf = computeTF(chunk.tokens);
      chunk.tfidf = computeTFIDF(tf, this.idf);
      chunk.vector = vectorize(chunk.tfidf, this.vocabulary);
    }

    this.isBuilt = true;
    logger.info(`RAG index built: ${this.chunks.length} chunks, ${this.vocabulary.length} terms`);
  }

  query(queryText, topK = RAG_CONFIG.topK) {
    if (!this.isBuilt) this.build();
    if (this.chunks.length === 0) return [];

    const queryTokens = tokenize(queryText);
    const queryTF = computeTF(queryTokens);
    const queryTFIDF = computeTFIDF(queryTF, this.idf);
    const queryVector = vectorize(queryTFIDF, this.vocabulary);

    const results = [];
    for (const chunk of this.chunks) {
      const sim = cosineSimilarity(queryVector, chunk.vector);
      if (sim >= RAG_CONFIG.minSimilarity) {
        results.push({ ...chunk, similarity: sim });
      }
    }

    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, topK);
  }

  serialize() {
    return {
      chunks: this.chunks.map(c => ({
        id: c.id,
        docId: c.docId,
        chunkIndex: c.chunkIndex,
        content: c.content,
        tokenCount: c.tokens.length
      })),
      vocabulary: this.vocabulary,
      idf: this.idf
    };
  }

  deserialize(data) {
    this.chunks = (data.chunks || []).map(c => ({
      id: c.id,
      docId: c.docId,
      chunkIndex: c.chunkIndex,
      content: c.content,
      tokens: tokenize(c.content),
      tfidf: {},
      vector: []
    }));
    this.vocabulary = data.vocabulary || [];
    this.idf = data.idf || {};
    this.isBuilt = false;
    this.build();
  }
}

// ============================================
// TEMPLATE-BASED ANSWER GENERATION
// ============================================
const EMS_TEMPLATES = {
  greeting: [
    'أهلاً بك! أنا المساعد التشغيلي الذكي لمنصة قطاع الجنوب. كيف يمكنني مساعدتك؟',
    'مرحباً! أنا هنا للإجابة على استفساراتك التشغيلية بناءً على البروتوكولات والوثائق المتاحة.',
    'أهلاً وسهلاً! اسألني عن أي بروتوكول أو إجراء تشغيلي.'
  ],
  noResult: [
    'لم أجد معلومات محددة في قاعدة المعرفة. يمكنك التواصل مع المشرف لإضافة وثائق جديدة.',
    'عذراً، لا توجد معلومات كافية في النظام للإجابة على هذا الاستفسار.',
    'لم أجد وثائق متعلقة بهذا الموضوع. هل تريد مساعدة في شيء آخر؟'
  ],
  protocol: 'بناءً على البروتوكولات المتاحة، إليك المعلومات:',
  procedure: 'وفقاً للإجراءات التشغيلية:',
  general: 'بناءً على الوثائق المتاحة:'
};

function generateAnswer(query, results) {
  if (!results || results.length === 0) {
    const idx = Math.floor(Math.random() * EMS_TEMPLATES.noResult.length);
    return {
      answer: EMS_TEMPLATES.noResult[idx],
      sources: [],
      confidence: 0
    };
  }

  // Build context from top results
  let context = '';
  let totalSimilarity = 0;
  const sources = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    totalSimilarity += r.similarity;
    context += `\n[${i + 1}] ${r.content}\n`;
    sources.push({
      docId: r.docId,
      chunkIndex: r.chunkIndex,
      similarity: Math.round(r.similarity * 1000) / 1000,
      excerpt: r.content.slice(0, 200) + (r.content.length > 200 ? '...' : '')
    });
    if (context.length > RAG_CONFIG.maxContextLength) break;
  }

  const avgSimilarity = totalSimilarity / results.length;
  const confidence = Math.round(avgSimilarity * 100);

  // Determine template based on query keywords
  const q = query.toLowerCase();
  let prefix = EMS_TEMPLATES.general;
  if (q.includes('بروتوكول') || q.includes('protocol') || q.includes('إجراء')) {
    prefix = EMS_TEMPLATES.protocol;
  } else if (q.includes('خطوة') || q.includes('إجراء') || q.includes('procedure') || q.includes('كيف')) {
    prefix = EMS_TEMPLATES.procedure;
  }

  // Build structured answer
  let answer = `${prefix}\n\n`;
  answer += context.trim();
  answer += `\n\n—\nتم الاسترجاع من ${results.length} مقطع من قاعدة المعرفة.\n`;
  if (confidence < 30) {
    answer += '⚠️ تنبيه: مستوى الثقة منخفض. يُفضل مراجعة المشرف التشغيلي.';
  }

  return { answer, sources, confidence };
}

// ============================================
// ANSWER WITH OPENAI (future enhancement)
// ============================================
async function generateAnswerWithOpenAI(query, results) {
  // Placeholder for future OpenAI integration
  // When enabled, this function calls the OpenAI API with the retrieved context
  // For now, falls back to template-based generation
  return generateAnswer(query, results);
}

// ============================================
// SUGGESTED QUESTIONS (based on available chunks)
// ============================================
function generateSuggestedQuestions(chunks, count = 5) {
  if (!chunks || chunks.length === 0) return [];

  const questions = [];
  const seen = new Set();

  // Extract common keywords and form questions
  const keywords = {};
  for (const chunk of chunks) {
    for (const token of chunk.tokens) {
      if (token.length > 3) {
        keywords[token] = (keywords[token] || 0) + 1;
      }
    }
  }

  const topKeywords = Object.entries(keywords)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(e => e[0]);

  const templates = [
    'ما هو بروتوكول {kw}؟',
    'كيف يتم التعامل مع {kw}؟',
    'ما هي خطوات {kw}؟',
    'شرح {kw}',
    'ما المتطلبات الخاصة بـ {kw}؟'
  ];

  for (const kw of topKeywords) {
    for (const tpl of templates) {
      const q = tpl.replace('{kw}', kw);
      if (!seen.has(q)) {
        seen.add(q);
        questions.push(q);
        if (questions.length >= count) break;
      }
    }
    if (questions.length >= count) break;
  }

  return questions;
}

// ============================================
// EXPORTS
// ============================================
module.exports = {
  RAG_CONFIG,
  RAGIndex,
  tokenize,
  computeTF,
  computeIDF,
  computeTFIDF,
  vectorize,
  cosineSimilarity,
  generateAnswer,
  generateAnswerWithOpenAI,
  generateSuggestedQuestions,
  EMS_TEMPLATES
};
