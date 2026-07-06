/* ============================================
   RAG ENGINE V2 - SOP-Based Operational AI
   منصة الجنوب - المساعد التشغيلي الذكي
   ============================================
   Each SOP is treated as a complete atomic unit.
   No mixing between different SOPs.
   Pure JavaScript, no external AI API.
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
  // No more chunking - each SOP is a complete document
  topK: 1,              // Only retrieve the single best SOP
  minSimilarity: 0.05,  // Minimum similarity threshold
  enableOpenAI: false,
  openAIKey: process.env.OPENAI_API_KEY || null,
  openAIModel: 'gpt-4o-mini',
};

// ============================================
// TOKENIZATION (Arabic + English)
// ============================================
function tokenize(text) {
  if (!text) return [];
  const normalized = text
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '') // remove tashkeel
    .replace(/[\u0660-\u0669]/g, d => String.fromCharCode(d.charCodeAt(0) - 0x0660 + 0x0030))
    .replace(/[^\w\u0600-\u06FF\u0750-\u077F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.split(/\s+/).filter(w => w.length > 1);
}

// ============================================
// SOP PARSER - Extract SOPs from document
// ============================================
function parseSOPs(fullText) {
  // SOPs are separated by headers like: # الإجراء رقم: SOP-XXX
  const sopRegex = /#\s*الإجراء\s*رقم[:\s]*SOP[-\s]*(\d+)[\s\S]*?(?=#\s*الإجراء\s*رقم[:\s]*SOP-\d+|#\s*أمثلة|#\s*تعليمات|#\s*الهدف|$)/gi;
  
  const sops = [];
  let match;
  while ((match = sopRegex.exec(fullText)) !== null) {
    const content = match[0].trim();
    const sopNumber = match[1];
    
    // Extract SOP name
    const nameMatch = content.match(/اسم\s*الإجراء[:\s]*(.+?)(?:\n|$)/i);
    const sopName = nameMatch ? nameMatch[1].trim() : '';
    
    // Extract section keywords
    const keywords = extractKeywords(content);
    
    sops.push({
      id: `SOP-${sopNumber}`,
      number: sopNumber,
      name: sopName,
      content: content,
      keywords: keywords,
      fullText: fullText // Keep reference to full document
    });
  }
  
  return sops;
}

function extractKeywords(content) {
  const keywords = new Set();
  const tokens = tokenize(content);
  for (const token of tokens) {
    if (token.length > 2) {
      keywords.add(token);
    }
  }
  return Array.from(keywords);
}

// ============================================
// TF-IDF
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
  const df = {};
  for (const doc of documents) {
    const uniqueTokens = new Set(doc);
    for (const token of uniqueTokens) {
      df[token] = (df[token] || 0) + 1;
    }
  }
  for (const [term, freq] of Object.entries(df)) {
    idf[term] = Math.log(N / (freq + 1)) + 1;
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

function cosineSimilarity(v1, v2) {
  let dot = 0, norm1 = 0, norm2 = 0;
  for (let i = 0; i < v1.length; i++) {
    dot += v1[i] * v2[i];
    norm1 += v1[i] * v1[i];
    norm2 += v2[i] * v2[i];
  }
  if (norm1 === 0 || norm2 === 0) return 0;
  return dot / (Math.sqrt(norm1) * Math.sqrt(norm2));
}

// ============================================
// SOP-BASED RAG INDEX
// ============================================
class SOPRAGIndex {
  constructor() {
    this.sops = [];
    this.vocabulary = [];
    this.idf = {};
    this.documents = [];
    this.isBuilt = false;
  }

  addDocument(fullText, docId) {
    const sops = parseSOPs(fullText);
    for (const sop of sops) {
      sop.docId = docId;
      this.sops.push(sop);
    }
  }

  build() {
    if (this.sops.length === 0) {
      this.isBuilt = false;
      return;
    }

    // Build vocabulary from all SOPs
    this.documents = this.sops.map(sop => tokenize(sop.content));
    const allTokens = new Set();
    for (const doc of this.documents) {
      for (const token of doc) {
        allTokens.add(token);
      }
    }
    this.vocabulary = Array.from(allTokens).sort();
    this.idf = computeIDF(this.documents);

    // Compute TF-IDF for each SOP
    for (let i = 0; i < this.sops.length; i++) {
      const tf = computeTF(this.documents[i]);
      const tfidf = computeTFIDF(tf, this.idf);
      this.sops[i].tfidf = tfidf;
      this.sops[i].vector = vectorize(tfidf, this.vocabulary);
    }

    this.isBuilt = true;
  }

  search(query, topK = 1) {
    if (!this.isBuilt || this.sops.length === 0) {
      return [];
    }

    const queryTokens = tokenize(query);
    const queryTF = computeTF(queryTokens);
    const queryTFIDF = computeTFIDF(queryTF, this.idf);
    const queryVector = vectorize(queryTFIDF, this.vocabulary);

    // Calculate similarity with each SOP
    const scores = [];
    for (let i = 0; i < this.sops.length; i++) {
      const similarity = cosineSimilarity(queryVector, this.sops[i].vector);
      if (similarity > RAG_CONFIG.minSimilarity) {
        scores.push({
          sop: this.sops[i],
          similarity: similarity
        });
      }
    }

    // Sort by similarity descending
    scores.sort((a, b) => b.similarity - a.similarity);
    return scores.slice(0, topK);
  }

  serialize() {
    return {
      sops: this.sops.map(s => ({
        id: s.id,
        number: s.number,
        name: s.name,
        content: s.content,
        docId: s.docId,
        keywords: s.keywords
      })),
      vocabulary: this.vocabulary,
      idf: this.idf,
      isBuilt: this.isBuilt
    };
  }

  deserialize(data) {
    this.sops = (data.sops || []).map(s => ({
      ...s,
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
// ANSWER EXTRACTION - Only from one SOP
// ============================================
function extractSOPInfo(sop) {
  return {
    sopNumber: sop.id,
    sopName: sop.name || '',
    content: sop.content
  };
}

function extractSteps(sop) {
  const steps = [];
  const lines = sop.content.split('\n');
  for (const line of lines) {
    const stepMatch = line.match(/^\s*(\d+)[\.\-]\s*(.+)/);
    if (stepMatch) {
      steps.push(stepMatch[2].trim());
    }
  }
  return steps;
}

function extractRules(sop) {
  const rules = [];
  const lines = sop.content.split('\n');
  for (const line of lines) {
    const ruleMatch = line.match(/^\s*[•\-\*]\s*(.+)/);
    if (ruleMatch) {
      rules.push(ruleMatch[1].trim());
    }
  }
  return rules;
}

function determineAnswerType(query, sop) {
  const q = query.toLowerCase();
  const content = sop.content.toLowerCase();
  
  // Yes/No questions
  if (q.match(/^(هل|هل\s+يمكن|هل\s+يسمح|هل\s+يحق|هل\s+يجوز)/)) {
    return 'yesno';
  }
  
  // Procedure/step questions
  if (q.includes('كيف') || q.includes('ما\s*الخطوات') || q.includes('ماذا\s*أفعل') || q.includes('ما\s*الإجراء') || q.includes('خطوات')) {
    return 'procedure';
  }
  
  // Where/location questions
  if (q.includes('أين') || q.includes('إلى\s*أين') || q.includes('مستشفى') || q.includes('منشأة')) {
    return 'location';
  }
  
  // What/definition questions
  if (q.includes('ما\s*هو') || q.includes('ما\s*هي') || q.includes('تعريف')) {
    return 'definition';
  }
  
  // Check SOP content for clues
  if (content.includes('خطوات') || content.includes('تنفيذ')) return 'procedure';
  if (content.includes('ينقل') || content.includes('مستشفى') || content.includes('منشأة')) return 'location';
  if (content.includes('لا') || content.includes('يمنع') || content.includes('يسمح')) return 'yesno';
  
  return 'general';
}

function extractAnswerFromSOP(query, sop, answerType) {
  const content = sop.content;
  const info = extractSOPInfo(sop);
  
  let answer = '';
  
  switch (answerType) {
    case 'yesno': {
      // Check for prohibition indicators
      const q = query.toLowerCase();
      if (content.includes('لا يجوز') || content.includes('يمنع') || content.includes('لا يسمح') || 
          content.includes('لا يسمح') || content.includes('لا يتم')) {
        answer = 'لا، لا يجوز.';
      } else if (content.includes('نعم') || content.includes('يمكن') || content.includes('يسمح') || content.includes('يجوز')) {
        answer = 'نعم، يجوز.';
      } else {
        answer = 'لا.';
      }
      
      // Add brief explanation from the relevant section
      const lines = content.split('\n').filter(l => l.trim().length > 10);
      // Find the most relevant line (contains keywords from query)
      const queryWords = tokenize(query);
      let bestLine = '';
      let bestScore = 0;
      for (const line of lines) {
        const lineWords = tokenize(line);
        let score = 0;
        for (const qw of queryWords) {
          if (lineWords.includes(qw)) score++;
        }
        if (score > bestScore) {
          bestScore = score;
          bestLine = line;
        }
      }
      if (bestLine && bestLine.length > 20) {
        answer += '\n\n' + bestLine.trim();
      }
      break;
    }
    
    case 'procedure': {
      const steps = extractSteps(sop);
      if (steps.length > 0) {
        answer = steps.map((step, i) => `${i + 1}. ${step}`).join('\n');
      } else {
        // Extract all numbered items
        const lines = content.split('\n').filter(l => l.match(/^\s*\d+[\.\-]/));
        answer = lines.map((l, i) => l.trim()).join('\n');
      }
      break;
    }
    
    case 'location': {
      const rules = extractRules(sop);
      // Find rules that mention location keywords
      const locationRules = rules.filter(r => 
        r.includes('مستشفى') || r.includes('منشأة') || r.includes('قطاع') || r.includes('نقل')
      );
      if (locationRules.length > 0) {
        answer = locationRules.map(r => '• ' + r).join('\n');
      } else {
        answer = rules.map(r => '• ' + r).join('\n');
      }
      break;
    }
    
    case 'definition': {
      // Extract the description paragraph
      const descMatch = content.match(/الوصف[:\s]*(.+?)(?:\n##|\n#\s*خطوات|$)/i);
      if (descMatch) {
        answer = descMatch[1].trim();
      } else {
        // Get first substantial paragraph
        const lines = content.split('\n').filter(l => l.trim().length > 20);
        answer = lines[0] || '';
      }
      break;
    }
    
    default: {
      // General answer - extract relevant rules/bullets
      const rules = extractRules(sop);
      if (rules.length > 0) {
        answer = rules.map(r => '• ' + r).join('\n');
      } else {
        // Extract all substantial lines
        const lines = content.split('\n').filter(l => l.trim().length > 15 && !l.includes('#'));
        answer = lines.slice(0, 5).map(l => l.trim()).join('\n');
      }
    }
  }
  
  return {
    answer: answer.trim(),
    sopInfo: info,
    answerType
  };
}

// ============================================
// ANSWER GENERATION
// ============================================
const EMS_TEMPLATES = {
  noResult: 'لم يتم العثور على إجراء رسمي يتعلق بهذا السؤال داخل قاعدة المعرفة الحالية.',
  
  procedureIntro: '**الإجراء:** {sopName} ({sopNumber})\n\n**الخطوات:**\n\n',
  locationIntro: '**الإجابة:**\n\n',
  yesnoIntro: '**الإجابة:**\n\n',
  definitionIntro: '**التعريف:**\n\n',
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

  // Get the best matching SOP (only one)
  const bestResult = results[0];
  const sop = bestResult.sop;
  const similarity = bestResult.similarity;
  const confidence = Math.round(similarity * 100);
  
  // Determine answer type
  const answerType = determineAnswerType(query, sop);
  
  // Extract answer from the SOP only
  const extracted = extractAnswerFromSOP(query, sop, answerType);
  
  if (!extracted.answer) {
    return {
      answer: EMS_TEMPLATES.noResult,
      sources: [],
      confidence: 0
    };
  }
  
  // Build the final answer
  let finalAnswer = '';
  const sopInfo = extracted.sopInfo;
  
  // Choose template based on answer type
  if (answerType === 'procedure') {
    finalAnswer = EMS_TEMPLATES.procedureIntro
      .replace('{sopName}', sopInfo.sopName)
      .replace('{sopNumber}', sopInfo.sopNumber);
    finalAnswer += extracted.answer;
    finalAnswer += EMS_TEMPLATES.reference
      .replace('{sopNumber}', sopInfo.sopNumber)
      .replace('{sopName}', sopInfo.sopName);
  } else if (answerType === 'yesno') {
    finalAnswer = EMS_TEMPLATES.yesnoIntro;
    finalAnswer += extracted.answer;
    finalAnswer += EMS_TEMPLATES.referenceShort
      .replace('{sopNumber}', sopInfo.sopNumber);
  } else if (answerType === 'location') {
    finalAnswer = EMS_TEMPLATES.locationIntro;
    finalAnswer += extracted.answer;
    if (sopInfo.sopName) {
      finalAnswer += EMS_TEMPLATES.reference
        .replace('{sopNumber}', sopInfo.sopNumber)
        .replace('{sopName}', sopInfo.sopName);
    } else {
      finalAnswer += EMS_TEMPLATES.referenceShort
        .replace('{sopNumber}', sopInfo.sopNumber);
    }
  } else if (answerType === 'definition') {
    finalAnswer = EMS_TEMPLATES.definitionIntro;
    finalAnswer += extracted.answer;
    if (sopInfo.sopName) {
      finalAnswer += EMS_TEMPLATES.reference
        .replace('{sopNumber}', sopInfo.sopNumber)
        .replace('{sopName}', sopInfo.sopName);
    }
  } else {
    finalAnswer = EMS_TEMPLATES.generalIntro;
    finalAnswer += extracted.answer;
    if (sopInfo.sopName) {
      finalAnswer += EMS_TEMPLATES.reference
        .replace('{sopNumber}', sopInfo.sopNumber)
        .replace('{sopName}', sopInfo.sopName);
    }
  }
  
  // Source info (only one SOP)
  const sources = [{
    docId: sop.docId,
    sopNumber: sopInfo.sopNumber,
    sopName: sopInfo.sopName,
    similarity: Math.round(similarity * 1000) / 1000,
    fullContent: sop.content
  }];
  
  return {
    answer: finalAnswer.trim(),
    sources,
    confidence,
    answerType
  };
}

// ============================================
// SUGGESTED QUESTIONS
// ============================================
function generateSuggestedQuestions(sops, count = 5) {
  if (!sops || sops.length === 0) return [];
  
  const questions = [];
  const seen = new Set();
  
  for (const sop of sops) {
    const sopName = sop.name || '';
    if (sopName.includes('نقل')) {
      questions.push('ما هو إجراء نقل ' + sopName.replace('آلية نقل حالات ', '') + '؟');
    }
    if (sopName.includes('رفض')) {
      questions.push('ماذا أفعل إذا ' + sopName + '؟');
    }
    if (sopName.includes('تصنيف')) {
      questions.push('ما هي تصنيفات البلاغ؟');
    }
    if (sopName.includes('مستشفى')) {
      questions.push('كيف يتم التعامل مع ' + sopName + '؟');
    }
  }
  
  // Add some standard questions
  const standard = [
    'هل يمكن تجاوز أقرب مستشفى في حالة دلتا؟',
    'ماذا أفعل إذا رفض المريض النقل؟',
    'أين يتم نقل مريض غير مواطن حالته تشارلي؟',
    'ما هي خطوات رفض المريض النقل؟',
    'ما هو تصنيف البلاغ دلتا؟'
  ];
  
  for (const q of standard) {
    if (!seen.has(q)) {
      seen.add(q);
      questions.push(q);
    }
    if (questions.length >= count) break;
  }
  
  return questions.slice(0, count);
}

// ============================================
// EXPORTS
// ============================================
module.exports = {
  RAG_CONFIG,
  SOPRAGIndex,
  tokenize,
  parseSOPs,
  extractSOPInfo,
  extractSteps,
  extractRules,
  determineAnswerType,
  extractAnswerFromSOP,
  generateAnswer,
  generateSuggestedQuestions,
  EMS_TEMPLATES
};