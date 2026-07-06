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
// STRUCTURED ANSWER EXTRACTION
// ============================================

function extractSOPInfo(content) {
  // Extract SOP number and name
  const sopMatch = content.match(/الإجراء\s*رقم[\s:]*SOP-?\s*(\d+)/i);
  const nameMatch = content.match(/اسم\s*الإجراء[\s:]*(.+?)(?:\n|$)/i);
  
  return {
    sopNumber: sopMatch ? `SOP-${sopMatch[1]}` : null,
    sopName: nameMatch ? nameMatch[1].trim() : null
  };
}

function extractSteps(content) {
  // Extract numbered steps
  const steps = [];
  const lines = content.split('\n');
  for (const line of lines) {
    const stepMatch = line.match(/^\s*(\d+)[\.\-]\s*(.+)/);
    if (stepMatch) {
      steps.push(stepMatch[2].trim());
    }
  }
  return steps;
}

function extractRules(content) {
  // Extract bullet points
  const rules = [];
  const lines = content.split('\n');
  for (const line of lines) {
    const ruleMatch = line.match(/^\s*[•\-\*]\s*(.+)/);
    if (ruleMatch) {
      rules.push(ruleMatch[1].trim());
    }
  }
  return rules;
}

function extractAnswer(content) {
  // Extract answer from Q&A section
  const answerMatch = content.match(/###\s*الإجابة\s*\n+([\s\S]+?)(?:\n---|\n###\s*سؤال|$)/i);
  if (answerMatch) {
    return answerMatch[1].trim();
  }
  
  // Look for "وفقاً للإجراء" pattern
  const accordMatch = content.match(/وفقاً\s*للإجراء\s+SOP-\d+[^\n]*/i);
  if (accordMatch) {
    return accordMatch[0].trim();
  }
  
  return null;
}

function determineAnswerType(query, results) {
  const q = query.toLowerCase();
  
  // Yes/No questions
  if (q.match(/^(هل|هل\s+يمكن|هل\s+يسمح|هل\s+يحق)/)) {
    return 'yesno';
  }
  
  // Procedure/step questions
  if (q.includes('كيف') || q.includes('ما\s*الخطوات') || q.includes('ماذا\s*أفعل') || q.includes('ما\s*الإجراء')) {
    return 'procedure';
  }
  
  // Where/location questions
  if (q.includes('أين') || q.includes('إلى\s*أين') || q.includes('مستشفى')) {
    return 'location';
  }
  
  // Check first result for classification keywords
  if (results.length > 0) {
    const content = results[0].content.toLowerCase();
    if (content.includes('خطوات') || content.includes('تنفيذ')) return 'procedure';
    if (content.includes('ينقل') || content.includes('مستشفى')) return 'location';
    if (content.includes('لا') || content.includes('نعم') || content.includes('يمكن')) return 'yesno';
  }
  
  return 'general';
}

function buildStructuredAnswer(query, results) {
  if (!results || results.length === 0) {
    return null;
  }
  
  const bestResult = results[0];
  const content = bestResult.content;
  const sopInfo = extractSOPInfo(content);
  const answerType = determineAnswerType(query, results);
  
  // Build structured answer parts
  let answer = '';
  
  // 1. Determine if it's a Yes/No question
  if (answerType === 'yesno') {
    const q = query.toLowerCase();
    // Check if the content contains "لا" or prohibition
    if (content.includes('لا يجوز') || content.includes('يمنع') || content.includes('لا يسمح') || content.includes('لا.')) {
      answer = '**لا.**\n\n';
    } else if (content.includes('نعم') || content.includes('يمكن') || content.includes('يسمح')) {
      answer = '**نعم.**\n\n';
    } else {
      answer = '**لا.**\n\n';
    }
  }
  
  // 2. Try to extract answer from Q&A section first
  const extractedAnswer = extractAnswer(content);
  if (extractedAnswer) {
    answer += extractedAnswer.replace(/^لا\./, '').replace(/^نعم\./, '').trim();
    answer += '\n';
  } else {
    // 3. Extract steps if this is a procedure
    const steps = extractSteps(content);
    if (steps.length > 0 && answerType === 'procedure') {
      answer += '\n';
      for (let i = 0; i < steps.length; i++) {
        answer += `${i + 1}. ${steps[i]}\n`;
      }
    } else {
      // 4. Extract rules/bullets
      const rules = extractRules(content);
      if (rules.length > 0) {
        for (const rule of rules) {
          answer += `• ${rule}\n`;
        }
      } else {
        // 5. Fallback: use first 2 sentences of content
        const sentences = content.split(/[\.\n]/).filter(s => s.trim().length > 10);
        if (sentences.length > 0) {
          answer += sentences[0].trim() + '\n';
          if (sentences.length > 1 && answer.length < 200) {
            answer += sentences[1].trim() + '\n';
          }
        }
      }
    }
  }
  
  return {
    answer: answer.trim(),
    sopInfo,
    answerType
  };
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
  noResult: 'لم يتم العثور على إجراء رسمي يتعلق بهذا السؤال داخل قاعدة المعرفة الحالية.',
  
  // Structured answer templates
  procedureIntro: '**الإجراء:** {sopName} ({sopNumber})\n\n**الخطوات:**\n\n',
  locationIntro: '**الإجابة:**\n\n',
  yesnoIntro: '',
  generalIntro: '**الإجابة:**\n\n',
  
  reference: '\n\n**المرجع:**\n{sopNumber} – {sopName}.',
  referenceShort: '\n\n**المرجع:**\n{sopNumber}.'
};

function generateAnswer(query, results) {
  if (!results || results.length === 0) {
    return {
      answer: EMS_TEMPLATES.noResult,
      sources: [],
      confidence: 0
    };
  }

  // Calculate average similarity for confidence
  let totalSimilarity = 0;
  const sources = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    totalSimilarity += r.similarity;
    sources.push({
      docId: r.docId,
      chunkIndex: r.chunkIndex,
      similarity: Math.round(r.similarity * 1000) / 1000,
      excerpt: r.content.slice(0, 150) + (r.content.length > 150 ? '...' : ''),
      fullContent: r.content  // Store full content for "Show Details" button
    });
    if (i >= 2) break; // Only keep top 3 sources for the response
  }

  const avgSimilarity = totalSimilarity / Math.min(results.length, 3);
  const confidence = Math.round(avgSimilarity * 100);
  
  // Build structured answer
  const structured = buildStructuredAnswer(query, results);
  
  if (!structured || !structured.answer) {
    return {
      answer: EMS_TEMPLATES.noResult,
      sources,
      confidence
    };
  }

  // Build the final answer based on type
  let finalAnswer = '';
  const answerType = structured.answerType;
  const sopInfo = structured.sopInfo;
  
  if (answerType === 'procedure' && sopInfo.sopNumber && sopInfo.sopName) {
    finalAnswer = EMS_TEMPLATES.procedureIntro
      .replace('{sopName}', sopInfo.sopName)
      .replace('{sopNumber}', sopInfo.sopNumber);
    finalAnswer += structured.answer;
    finalAnswer += EMS_TEMPLATES.reference
      .replace('{sopNumber}', sopInfo.sopNumber)
      .replace('{sopName}', sopInfo.sopName);
  } else if (answerType === 'location' || answerType === 'yesno') {
    finalAnswer = EMS_TEMPLATES.locationIntro;
    finalAnswer += structured.answer;
    if (sopInfo.sopNumber) {
      finalAnswer += EMS_TEMPLATES.referenceShort
        .replace('{sopNumber}', sopInfo.sopNumber);
    }
  } else {
    finalAnswer = EMS_TEMPLATES.generalIntro;
    finalAnswer += structured.answer;
    if (sopInfo.sopNumber && sopInfo.sopName) {
      finalAnswer += EMS_TEMPLATES.reference
        .replace('{sopNumber}', sopInfo.sopNumber)
        .replace('{sopName}', sopInfo.sopName);
    }
  }
  
  // Add low confidence warning
  if (confidence < 30) {
    finalAnswer += '\n\n⚠️ تنبيه: مستوى الثقة منخفض. يُفضل مراجعة المشرف التشغيلي.';
  }

  return { 
    answer: finalAnswer.trim(), 
    sources, 
    confidence,
    answerType
  };
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
