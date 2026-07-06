/**
 * RAG Engine - TF-IDF based Retrieval Augmented Generation
 * Pure JavaScript implementation - no external ML libraries needed
 * Compatible with adding OpenAI API later
 */

const fs = require('fs').promises;
const path = require('path');

// ============================================
// TEXT PROCESSING & TOKENIZATION
// ============================================

function tokenize(text) {
    // Arabic + English tokenization
    if (!text) return [];
    return text
        .toLowerCase()
        .replace(/[\u064B-\u065F\u0640]/g, '') // Remove Arabic tashkeel/diacritics
        .replace(/[^\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFFa-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length > 1);
}

function removeStopWords(tokens) {
    // Combined Arabic + English stop words
    const stopWords = new Set([
        'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
        'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
        'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare',
        'ought', 'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by',
        'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above',
        'below', 'between', 'under', 'and', 'but', 'or', 'yet', 'so', 'if',
        'because', 'although', 'though', 'while', 'where', 'when', 'that',
        'which', 'who', 'whom', 'whose', 'what', 'this', 'these', 'those',
        'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her',
        'us', 'them', 'my', 'your', 'his', 'its', 'our', 'their',
        'في', 'من', 'إلى', 'على', 'هذا', 'هذه', 'التي', 'الذي', 'التي',
        'أن', 'لم', 'لا', 'ما', 'كيف', 'متى', 'أين', 'من', 'هل',
        'و', 'أو', 'ثم', 'بعد', 'قبل', 'كل', 'بعض', 'جميع', 'أي',
        'كان', 'يكون', 'كانت', 'أيضا', 'جدا', 'عن', 'مع', 'بين', 'خلال',
        'هو', 'هي', 'هم', 'نحن', 'أنا', 'أنت', 'أنتم', 'هؤلاء',
        'قد', 'لقد', 'قد', 'لقد', 'ذلك', 'هناك', 'هنا', ' حيث ', 'إذ',
        'لكن', 'إلا', 'لو', 'إن', 'لا', 'ما', 'ليس', 'غير', 'دون',
        'سوى', 'فقط', 'حتى', 'إذا', 'عندما', 'بينما', 'لأن', 'لذلك'
    ]);
    return tokens.filter(t => !stopWords.has(t));
}

function stemArabic(token) {
    // Simple Arabic stemming - remove common suffixes/prefixes
    const prefixes = ['ال', 'أ', 'إ', 'ي', 'ت', 'ن', 'ا', 'ل', 'ب', 'ك', 'ف', 'و', 'س', 'سن', 'سأ', 'سوف'];
    const suffixes = ['ة', 'ات', 'ين', 'ون', 'ان', 'ت', 'نا', 'كم', 'هم', 'ها', 'ك', 'ني', 'ه'];
    
    let stemmed = token;
    for (const prefix of prefixes) {
        if (stemmed.startsWith(prefix) && stemmed.length > prefix.length + 2) {
            stemmed = stemmed.slice(prefix.length);
            break;
        }
    }
    for (const suffix of suffixes) {
        if (stemmed.endsWith(suffix) && stemmed.length > suffix.length + 2) {
            stemmed = stemmed.slice(0, -suffix.length);
            break;
        }
    }
    return stemmed;
}

function preprocessText(text) {
    const tokens = tokenize(text);
    const filtered = removeStopWords(tokens);
    return filtered.map(stemArabic);
}

// ============================================
// DOCUMENT CHUNKING
// ============================================

function chunkDocument(text, maxChunkSize = 500, overlap = 50) {
    if (!text || text.trim().length === 0) return [];
    
    const chunks = [];
    const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim().length > 0);
    
    let currentChunk = '';
    for (const paragraph of paragraphs) {
        const trimmed = paragraph.trim();
        if (trimmed.length > maxChunkSize) {
            // Split long paragraphs into sentences
            if (currentChunk.length > 0) {
                chunks.push(currentChunk.trim());
                currentChunk = '';
            }
            
            const sentences = trimmed.match(/[^.!?]+[.!?]+/g) || [trimmed];
            let sentenceChunk = '';
            for (const sentence of sentences) {
                if ((sentenceChunk + sentence).length > maxChunkSize) {
                    if (sentenceChunk.length > 0) {
                        chunks.push(sentenceChunk.trim());
                        sentenceChunk = sentenceChunk.slice(-overlap) + sentence;
                    } else {
                        chunks.push(sentence.trim());
                    }
                } else {
                    sentenceChunk += sentence + ' ';
                }
            }
            if (sentenceChunk.trim().length > 0) {
                currentChunk = sentenceChunk.trim();
            }
        } else if ((currentChunk + '\n\n' + trimmed).length > maxChunkSize) {
            chunks.push(currentChunk.trim());
            currentChunk = trimmed;
        } else {
            currentChunk += (currentChunk.length > 0 ? '\n\n' : '') + trimmed;
        }
    }
    
    if (currentChunk.trim().length > 0) {
        chunks.push(currentChunk.trim());
    }
    
    return chunks.filter(c => c.length > 20);
}

// ============================================
// TF-IDF EMBEDDINGS
// ============================================

function computeTF(tokens) {
    const tf = {};
    const total = tokens.length;
    if (total === 0) return tf;
    
    for (const token of tokens) {
        tf[token] = (tf[token] || 0) + 1;
    }
    
    for (const token in tf) {
        tf[token] = tf[token] / total;
    }
    
    return tf;
}

function computeIDF(documents) {
    const idf = {};
    const N = documents.length;
    if (N === 0) return idf;
    
    const documentFreq = {};
    for (const doc of documents) {
        const uniqueTokens = new Set(doc);
        for (const token of uniqueTokens) {
            documentFreq[token] = (documentFreq[token] || 0) + 1;
        }
    }
    
    for (const [token, df] of Object.entries(documentFreq)) {
        idf[token] = Math.log(N / df) + 1; // smoothed IDF
    }
    
    return idf;
}

function computeTFIDF(tf, idf) {
    const tfidf = {};
    for (const token in tf) {
        tfidf[token] = tf[token] * (idf[token] || 0);
    }
    return tfidf;
}

function normalizeVector(vector) {
    let magnitude = 0;
    for (const val of Object.values(vector)) {
        magnitude += val * val;
    }
    magnitude = Math.sqrt(magnitude);
    
    if (magnitude === 0) return vector;
    
    const normalized = {};
    for (const [token, val] of Object.entries(vector)) {
        normalized[token] = val / magnitude;
    }
    return normalized;
}

function cosineSimilarity(vecA, vecB) {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (const val of Object.values(vecA)) {
        normA += val * val;
    }
    for (const val of Object.values(vecB)) {
        normB += val * val;
    }
    
    const allTokens = new Set([...Object.keys(vecA), ...Object.keys(vecB)]);
    for (const token of allTokens) {
        const a = vecA[token] || 0;
        const b = vecB[token] || 0;
        dotProduct += a * b;
    }
    
    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
}

// ============================================
// RAG RETRIEVER
// ============================================

class RAGEngine {
    constructor() {
        this.idf = null;
        this.documents = []; // Array of {id, chunk_index, content, embedding}
        this.isInitialized = false;
    }
    
    async loadDocuments(chunks) {
        // chunks: array of {id, document_id, chunk_index, content, embedding}
        this.documents = chunks.map(c => ({
            id: c.id,
            document_id: c.document_id,
            chunk_index: c.chunk_index,
            content: c.content,
            embedding: typeof c.embedding === 'string' ? JSON.parse(c.embedding) : c.embedding
        }));
        
        // Recompute IDF from all documents
        const allTokens = this.documents.map(d => Object.keys(d.embedding || {}));
        this.idf = computeIDF(allTokens);
        
        this.isInitialized = true;
        return this.documents.length;
    }
    
    async query(queryText, topK = 5) {
        if (!this.isInitialized || this.documents.length === 0) {
            return [];
        }
        
        const queryTokens = preprocessText(queryText);
        const queryTF = computeTF(queryTokens);
        const queryTFIDF = normalizeVector(computeTFIDF(queryTF, this.idf));
        
        const scores = this.documents.map(doc => {
            const docVec = normalizeVector(computeTFIDF(doc.embedding || {}, this.idf));
            const similarity = cosineSimilarity(queryTFIDF, docVec);
            return {
                ...doc,
                score: similarity
            };
        });
        
        scores.sort((a, b) => b.score - a.score);
        return scores.slice(0, topK).filter(s => s.score > 0.01);
    }
    
    async generateAnswer(queryText, retrievedChunks, contextData = {}) {
        if (!retrievedChunks || retrievedChunks.length === 0) {
            return this.fallbackResponse(queryText, contextData);
        }
        
        // Build context from retrieved chunks
        const context = retrievedChunks
            .map((c, i) => `[${i + 1}] ${c.content.substring(0, 800)}`)
            .join('\n\n');
        
        // Template-based answer generation
        const queryLower = queryText.toLowerCase();
        const queryTokens = new Set(preprocessText(queryText));
        
        // Detect query type
        let queryType = 'general';
        const typeKeywords = {
            'procedure': new Set(['إجراء', 'خطوات', 'كيف', 'طريقة', 'protocol', 'procedure', 'steps', 'how']),
            'definition': new Set(['ما هو', 'ما هي', 'تعريف', 'define', 'what is', 'meaning']),
            'location': new Set(['أين', 'موقع', 'مكان', 'location', 'where', 'address']),
            'contact': new Set(['اتصال', 'هاتف', 'رقم', 'contact', 'phone', 'call']),
            'status': new Set(['حالة', 'عدد', 'كم', 'status', 'count', 'how many', 'current']),
            'protocol': new Set(['بروتوكول', 'تعليمات', 'guideline', 'protocol', 'instruction'])
        };
        
        for (const [type, keywords] of Object.entries(typeKeywords)) {
            for (const keyword of keywords) {
                if (queryLower.includes(keyword)) {
                    queryType = type;
                    break;
                }
            }
            if (queryType !== 'general') break;
        }
        
        // Generate answer based on query type and context
        const answers = this.buildTemplateAnswer(queryType, queryText, context, retrievedChunks, contextData);
        return answers;
    }
    
    buildTemplateAnswer(queryType, queryText, context, chunks, contextData) {
        const sources = chunks.map(c => ({
            document_id: c.document_id,
            chunk_index: c.chunk_index,
            content: c.content.substring(0, 200) + (c.content.length > 200 ? '...' : ''),
            score: Math.round(c.score * 100) / 100
        }));
        
        let mainAnswer = '';
        let followUp = '';
        
        switch (queryType) {
            case 'procedure':
                mainAnswer = `بناءً على المعلومات المتاحة في قاعدة المعرفة، إليك الخطوات المقترحة:\n\n${context}\n\nيرجى التأكد من متابعة البروتوكول المعتمد في القطاع.`;
                followUp = 'هل تحتاج إلى توضيح أي خطوة من هذه الخطوات؟';
                break;
            case 'definition':
                mainAnswer = `وفقاً للمعلومات المتاحة:\n\n${context}\n\nهذا التعريف مبني على الوثائق التشغيلية المعتمدة.`;
                followUp = 'هل تريد معرفة المزيد من التفاصيل حول هذا الموضوع؟';
                break;
            case 'location':
                mainAnswer = `بناءً على البيانات المتاحة:\n\n${context}\n\nيرجى التحقق من الخريطة التفاعلية للتأكد من الموقع الدقيق.`;
                followUp = 'هل تحتاج إلى معلومات توجيهية إضافية؟';
                break;
            case 'contact':
                mainAnswer = `المعلومات التواصلية المتاحة:\n\n${context}\n\nيرجى التأكد من تحديث الأرقام بشكل دوري.`;
                followUp = 'هل تحتاج إلى رقم تواصل آخر؟';
                break;
            case 'status':
                mainAnswer = `الحالة الحالية بناءً على البيانات:\n\n${context}\n\nالبيانات تُحدّث فوراً عبر النظام.`;
                followUp = 'هل تريد تقريراً مفصلاً عن أي جانب معين؟';
                break;
            case 'protocol':
                mainAnswer = `البروتوكول التشغيلي المعتمد:\n\n${context}\n\nتأكد من مراجعة المسؤول قبل التطبيق في حالات استثنائية.`;
                followUp = 'هل تريد الاطلاع على البروتوكول الكامل؟';
                break;
            default:
                mainAnswer = `بناءً على ما وجدته في قاعدة المعرفة:\n\n${context}\n\nملاحظة: المعلومات مأخوذة من الوثائق التشغيلية المعتمدة في القطاع.`;
                followUp = 'هل يمكنني مساعدتك في شيء آخر؟';
        }
        
        return {
            answer: mainAnswer,
            followUp: followUp,
            sources: sources,
            confidence: chunks.length > 0 ? Math.round(chunks[0].score * 100) : 0,
            queryType: queryType
        };
    }
    
    fallbackResponse(queryText, contextData) {
        const queryLower = queryText.toLowerCase();
        
        // Simple rule-based fallback for common questions
        if (queryLower.includes('مرحب') || queryLower.includes('هلا') || queryLower.includes('السلام')) {
            return {
                answer: 'أهلاً وسهلاً! أنا المساعد الذكي التشغيلي لقطاع جنوب الرياض. كيف يمكنني مساعدتك اليوم؟',
                followUp: 'يمكنني الإجابة على استفساراتك حول البروتوكولات والإجراءات التشغيلية.',
                sources: [],
                confidence: 0,
                queryType: 'greeting'
            };
        }
        
        if (queryLower.includes('شكر') || queryLower.includes('تسلم')) {
            return {
                answer: 'عفواً! سعيد بمساعدتك. لا تتردد في طلب المساعدة في أي وقت. 🚑',
                followUp: '',
                sources: [],
                confidence: 0,
                queryType: 'gratitude'
            };
        }
        
        if (queryLower.includes('مساعد') || queryLower.includes('help')) {
            return {
                answer: 'يمكنني مساعدتك في:\n• الإجابة على استفسارات البروتوكولات التشغيلية\n• شرح الإجراءات والخطوات العملية\n• البحث في الوثائق والمستندات\n• تقديم معلومات عن المراكز والفرق\n\nجرب سؤالي عن أي موضوع تشغيلي.',
                followUp: 'ما هو الموضوع الذي تريد البحث فيه؟',
                sources: [],
                confidence: 0,
                queryType: 'help'
            };
        }
        
        return {
            answer: 'لم أجد معلومات محددة في قاعدة المعرفة حول هذا السؤال. يمكنك:\n• صياغة السؤال بشكل مختلف\n• التحقق من الوثائق المتاحة في لوحة إدارة المعرفة\n• التواصل مع المسؤول لإضافة المعلومات المطلوبة',
            followUp: 'هل تريد أن أساعدك في موضوع آخر؟',
            sources: [],
            confidence: 0,
            queryType: 'unknown'
        };
    }
}

// ============================================
// DOCUMENT PROCESSING (basic text extraction)
// ============================================

async function extractTextFromFile(filePath, fileType) {
    try {
        const ext = path.extname(filePath).toLowerCase();
        
        // Plain text files
        if (ext === '.txt' || ext === '.md' || ext === '.json') {
            const content = await fs.readFile(filePath, 'utf8');
            return content;
        }
        
        // For other file types, we return basic info and note that advanced extraction
        // would need additional libraries (pdf-parse, mammoth, xlsx)
        const stats = await fs.stat(filePath);
        return `[ملف ${ext.toUpperCase().replace('.', '')}]\nاسم الملف: ${path.basename(filePath)}\nالحجم: ${Math.round(stats.size / 1024)} كيلوبايت\n\nملاحظة: استخراج النص الكامل من هذا النوع من الملفات يتطلب مكتبات إضافية. يمكنك إضافة المحتوى النصي يدوياً أو تحويل الملف إلى نص أولاً.`;
    } catch (err) {
        throw new Error(`Failed to extract text: ${err.message}`);
    }
}

// ============================================
// EXPORT
// ============================================
module.exports = {
    RAGEngine,
    preprocessText,
    tokenize,
    chunkDocument,
    computeTF,
    computeIDF,
    computeTFIDF,
    normalizeVector,
    cosineSimilarity,
    extractTextFromFile
};