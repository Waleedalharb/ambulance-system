/* ============================================
   AGENT LAYER - Operational AI Agent
   منصة الجنوب - طبقة الوكيل الذكي
   ============================================
   - Conversation memory
   - Intent recognition
   - Clarifying questions
   - Multi-SOP reasoning
   - Hallucination prevention
   ============================================ */

const { getAIProvider } = require('./ai-provider');
const { RAG_CONFIG } = require('./rag-engine');

const logger = {
  info: (msg) => console.log(`[AGENT] ${new Date().toISOString()} INFO: ${msg}`),
  error: (msg, err) => console.error(`[AGENT] ${new Date().toISOString()} ERROR: ${msg}`, err ? (err.message || err) : ''),
};

// ============================================
// SYSTEM PROMPT - Define agent behavior
// ============================================
const SYSTEM_PROMPT = `أنت مساعد تشغيلي ذكي لمنصة إدارة العمليات الإسعافية (قطاع جنوب الرياض).

قواعدك الأساسية:
1. أنت تعتمد فقط على الإجراءات التشغيلية (SOP) المقدمة لك. لا تستخدم معرفتك العامة.
2. إذا لم تجد إجابة في الإجراءات، قل بوضوح: "لم يتم العثور على إجراء رسمي يتعلق بهذا السؤال داخل قاعدة المعرفة الحالية."
3. لا تخمن. لا تستنتج من معلومات خارج الإجراءات.
4. اطرح أسئلة توضيحية إذا كانت المعلومات ناقصة.
5. اذكر دائماً المرجع (SOP) الذي استندت إليه.
6. اجعل إجاباتك مختصرة ومباشرة ومناسبة لبيئة العمل الميداني.
7. استخدم اللغة العربية الفصحى.

طريقة الإجابة:
- إذا كان السؤال واضح والإجراء موجود: أجب مباشرة مع ذكر المرجع.
- إذا كانت المعلومات ناقصة: اطرح أسئلة توضيحية.
- إذا لم يوجد إجراء: أخبر المستخدم واقترح التواصل مع المشرف.

أمثلة على الأسئلة التوضيحية:
- "ما تصنيف الحالة؟ (ألفا/برافو/تشارلي/دلتا)"
- "هل المريض مواطن أم غير مواطن؟"
- "هل توجد رغبة في النقل إلى مستشفى معين؟"`;

// ============================================
// CONVERSATION MEMORY
// ============================================
class ConversationMemory {
  constructor(sessionId, maxMessages = 20) {
    this.sessionId = sessionId;
    this.messages = [];
    this.maxMessages = maxMessages;
    this.context = {
      patientType: null,      // 'citizen' | 'non-citizen' | null
      classification: null,   // 'alpha' | 'bravo' | 'charlie' | 'delta' | null
      scenario: null,         // current scenario being discussed
      lastSOP: null,          // last SOP referenced
      extractedInfo: {}       // any info extracted from conversation
    };
  }

  add(role, content, metadata = {}) {
    this.messages.push({
      role,
      content,
      timestamp: Date.now(),
      metadata
    });
    // Trim old messages
    if (this.messages.length > this.maxMessages) {
      this.messages = this.messages.slice(-this.maxMessages);
    }
  }

  getMessages() {
    return this.messages;
  }

  getRecentContext(count = 5) {
    return this.messages.slice(-count);
  }

  updateContext(key, value) {
    this.context[key] = value;
  }

  getContext() {
    return this.context;
  }

  // Extract patient info from conversation
  extractPatientInfo() {
    const allText = this.messages.map(m => m.content).join(' ').toLowerCase();
    
    // Check for citizenship
    if (allText.includes('مواطن') || allText.includes('سعودي')) {
      this.context.patientType = 'citizen';
    } else if (allText.includes('غير مواطن') || allText.includes('وافد') || allText.includes('مقيم')) {
      this.context.patientType = 'non-citizen';
    }
    
    // Check for classification
    const classMap = {
      'ألفا': 'alpha', 'alpha': 'alpha', 'الفا': 'alpha',
      'برافو': 'bravo', 'bravo': 'bravo',
      'تشارلي': 'charlie', 'charlie': 'charlie',
      'دلتا': 'delta', 'delta': 'delta'
    };
    for (const [arabic, english] of Object.entries(classMap)) {
      if (allText.includes(arabic)) {
        this.context.classification = english;
        break;
      }
    }
    
    return this.context;
  }
}

// ============================================
// SESSION STORE
// ============================================
class SessionStore {
  constructor() {
    this.sessions = new Map();
    this.maxSessions = 1000;
  }

  get(sessionId) {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, new ConversationMemory(sessionId));
    }
    return this.sessions.get(sessionId);
  }

  delete(sessionId) {
    this.sessions.delete(sessionId);
  }

  cleanup(maxAgeMs = 30 * 60 * 1000) { // 30 minutes
    const now = Date.now();
    for (const [id, memory] of this.sessions) {
      const lastMessage = memory.messages[memory.messages.length - 1];
      if (lastMessage && (now - lastMessage.timestamp) > maxAgeMs) {
        this.sessions.delete(id);
      }
    }
  }
}

const sessionStore = new SessionStore();

// ============================================
// AGENT CLASS
// ============================================
class OperationalAgent {
  constructor() {
    this.aiProvider = getAIProvider();
    this.sessionStore = sessionStore;
  }

  // Main entry point
  async processQuery(query, sessionId, retrievedSOPs = []) {
    const memory = this.sessionStore.get(sessionId);
    
    // Add user message
    memory.add('user', query);
    
    // Extract patient info from full conversation
    memory.extractPatientInfo();
    
    // Build messages for LLM
    const messages = this._buildMessages(memory, retrievedSOPs);
    
    try {
      // Call LLM
      const response = await this.aiProvider.chat(messages, {
        temperature: 0.2, // Low temperature for factual responses
        maxTokens: 800
      });
      
      // Add assistant response
      memory.add('assistant', response.content, {
        provider: response.provider,
        model: response.model
      });
      
      return {
        success: true,
        answer: response.content,
        sessionId: sessionId,
        context: memory.getContext(),
        usage: response.usage
      };
      
    } catch (err) {
      logger.error('Agent processing failed', err);
      return {
        success: false,
        answer: 'عذراً، حدث خطأ في معالجة سؤالك. يرجى المحاولة لاحقاً.',
        error: err.message
      };
    }
  }

  _buildMessages(memory, retrievedSOPs) {
    const messages = [];
    
    // 1. System prompt
    messages.push({
      role: 'system',
      content: SYSTEM_PROMPT
    });
    
    // 2. Context from conversation
    const context = memory.getContext();
    let contextInfo = '';
    if (context.patientType) {
      contextInfo += `نوع المريض: ${context.patientType === 'citizen' ? 'مواطن' : 'غير مواطن'}.\n`;
    }
    if (context.classification) {
      contextInfo += `تصنيف الحالة: ${context.classification}.\n`;
    }
    if (contextInfo) {
      messages.push({
        role: 'system',
        content: `معلومات من سياق المحادثة:\n${contextInfo}`
      });
    }
    
    // 3. Retrieved SOPs as context
    if (retrievedSOPs && retrievedSOPs.length > 0) {
      let sopContext = 'الإجراءات المتاحة:\n\n';
      for (const sop of retrievedSOPs) {
        sopContext += `=== ${sop.id} – ${sop.name} ===\n${sop.content}\n\n`;
      }
      messages.push({
        role: 'system',
        content: sopContext
      });
    } else {
      messages.push({
        role: 'system',
        content: 'لا توجد إجراءات متاحة في قاعدة المعرفة لهذا السؤال.'
      });
    }
    
    // 4. Recent conversation history (last 6 messages)
    const recentMessages = memory.getRecentContext(6);
    for (const msg of recentMessages) {
      messages.push({
        role: msg.role,
        content: msg.content
      });
    }
    
    return messages;
  }

  // Analyze if query needs clarification
  async needsClarification(query, context) {
    const prompt = `حلل هذا السؤال: "${query}"

معلومات متوفرة حالياً:
- نوع المريض: ${context.patientType || 'غير معروف'}
- تصنيف الحالة: ${context.classification || 'غير معروف'}

هل السؤال يحتاج معلومات إضافية للإجابة بدقة؟

أجب بـ "YES" إذا كانت المعلومات ناقصة، متبوعاً بالأسئلة التوضيحية.
أجب بـ "NO" إذا كانت المعلومات كافية.`;

    try {
      const response = await this.aiProvider.chat([
        { role: 'system', content: 'أنت محلل أسئلة. حدد فقط إذا كان السؤال يحتاج توضيح.' },
        { role: 'user', content: prompt }
      ], { temperature: 0.1, maxTokens: 200 });
      
      const content = response.content.toLowerCase();
      if (content.includes('yes') || content.includes('نعم')) {
        // Extract questions
        const questions = response.content.split('\n').filter(l => 
          l.includes('؟') || l.match(/^\d+\./)
        );
        return { needsClarification: true, questions };
      }
      return { needsClarification: false };
    } catch (err) {
      return { needsClarification: false };
    }
  }

  // Get or create session
  getSession(sessionId) {
    return this.sessionStore.get(sessionId);
  }

  // Clear session
  clearSession(sessionId) {
    this.sessionStore.delete(sessionId);
  }
}

// Singleton
let agentInstance = null;

function getAgent() {
  if (!agentInstance) {
    agentInstance = new OperationalAgent();
  }
  return agentInstance;
}

module.exports = {
  OperationalAgent,
  ConversationMemory,
  SessionStore,
  getAgent,
  SYSTEM_PROMPT
};
