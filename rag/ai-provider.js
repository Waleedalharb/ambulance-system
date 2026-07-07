/* ============================================
   AI PROVIDER - Unified LLM Interface
   منصة الجنوب - دعم OpenAI + Gemini
   ============================================
   Modular: Add new providers without changing code
   ============================================ */

const { OpenAI } = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const logger = {
  info: (msg) => console.log(`[AI-PROVIDER] ${new Date().toISOString()} INFO: ${msg}`),
  error: (msg, err) => console.error(`[AI-PROVIDER] ${new Date().toISOString()} ERROR: ${msg}`, err ? (err.message || err) : ''),
};

// ============================================
// CONFIGURATION
// ============================================
class AIProvider {
  constructor(config = {}) {
    this.provider = config.provider || process.env.AI_PROVIDER || 'gemini';
    this.model = config.model || process.env.AI_MODEL || 'gemini-1.5-flash-latest';
    this.temperature = config.temperature || parseFloat(process.env.AI_TEMPERATURE) || 0.3;
    this.maxTokens = config.maxTokens || parseInt(process.env.AI_MAX_TOKENS) || 1000;
    
    // Initialize clients
    this.openaiClient = null;
    this.geminiClient = null;
    this.geminiModel = null;
    
    this._initClients();
  }

  _initClients() {
    // OpenAI
    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey && openaiKey.startsWith('sk-')) {
      try {
        this.openaiClient = new OpenAI({ apiKey: openaiKey });
        logger.info('✅ OpenAI client initialized');
      } catch (err) {
        logger.error('❌ Failed to initialize OpenAI client', err);
      }
    } else {
      logger.warn('⚠️ OPENAI_API_KEY not set or invalid');
    }

    // Gemini
    const geminiKey = process.env.GEMINI_API_KEY;
    if (geminiKey && geminiKey.length > 10) {
      try {
        this.geminiClient = new GoogleGenerativeAI(geminiKey);
        this.geminiModel = this.geminiClient.getGenerativeModel({ model: 'gemini-1.5-flash' });
        logger.info('✅ Gemini client initialized');
      } catch (err) {
        logger.error('❌ Failed to initialize Gemini client', err);
      }
    } else {
      logger.warn('⚠️ GEMINI_API_KEY not set or invalid');
    }
  }

  // Check if provider is ready
  isReady() {
    if (this.provider === 'openai') return !!this.openaiClient;
    if (this.provider === 'gemini') return !!this.geminiModel;
    return false;
  }

  // Get provider status for debugging
  getStatus() {
    return {
      provider: this.provider,
      model: this.model,
      openaiReady: !!this.openaiClient,
      geminiReady: !!this.geminiClient,
      envKeys: {
        openai: !!process.env.OPENAI_API_KEY,
        gemini: !!process.env.GEMINI_API_KEY
      }
    };
  }

  getAvailableProviders() {
    const providers = [];
    if (this.openaiClient) providers.push({ id: 'openai', name: 'OpenAI', models: ['gpt-4o-mini', 'gpt-4o', 'gpt-3.5-turbo'] });
    if (this.geminiClient) providers.push({ id: 'gemini', name: 'Google Gemini', models: ['gemini-1.5-flash', 'gemini-1.5-pro'] });
    return providers;
  }

  getActiveProvider() {
    return this.provider;
  }

  setProvider(providerId) {
    if (providerId === 'openai' && !this.openaiClient) {
      throw new Error('OpenAI not configured. Set OPENAI_API_KEY environment variable.');
    }
    if (providerId === 'gemini' && !this.geminiClient) {
      throw new Error('Gemini not configured. Set GEMINI_API_KEY environment variable.');
    }
    this.provider = providerId;
    logger.info(`Switched to provider: ${providerId}`);
  }

  setModel(modelId) {
    this.model = modelId;
    if (this.provider === 'gemini') {
      this.geminiModel = this.geminiClient.getGenerativeModel({ model: modelId });
    }
    logger.info(`Switched to model: ${modelId}`);
  }

  // Test connection
  async testConnection() {
    try {
      const result = await this.chat([
        { role: 'user', content: 'Say "Connected" in Arabic.' }
      ]);
      return { success: true, response: result.content };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // Main chat interface
  async chat(messages, options = {}) {
    const provider = options.provider || this.provider;
    const model = options.model || this.model;
    const temperature = options.temperature !== undefined ? options.temperature : this.temperature;
    const maxTokens = options.maxTokens || this.maxTokens;

    if (provider === 'openai') {
      return this._chatOpenAI(messages, model, temperature, maxTokens);
    } else if (provider === 'gemini') {
      return this._chatGemini(messages, model, temperature, maxTokens);
    } else {
      throw new Error(`Unknown provider: ${provider}`);
    }
  }

  async _chatOpenAI(messages, model, temperature, maxTokens) {
    if (!this.openaiClient) {
      throw new Error('OpenAI client not initialized');
    }

    const completion = await this.openaiClient.chat.completions.create({
      model: model,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content
      })),
      temperature: temperature,
      max_tokens: maxTokens,
    });

    return {
      content: completion.choices[0].message.content,
      role: completion.choices[0].message.role,
      usage: completion.usage,
      provider: 'openai',
      model: model
    };
  }

  async _chatGemini(messages, model, temperature, maxTokens) {
    if (!this.geminiModel) {
      throw new Error('Gemini client not initialized');
    }

    // Convert messages to Gemini format
    const history = [];
    let lastUserMessage = '';
    
    for (const msg of messages) {
      if (msg.role === 'system') {
        // Gemini doesn't support system messages directly, prepend to first user message
        lastUserMessage = msg.content + '\n\n' + lastUserMessage;
      } else if (msg.role === 'user') {
        lastUserMessage += msg.content;
      } else if (msg.role === 'assistant') {
        if (lastUserMessage) {
          history.push({ role: 'user', parts: [{ text: lastUserMessage }] });
          lastUserMessage = '';
        }
        history.push({ role: 'model', parts: [{ text: msg.content }] });
      }
    }

    // Start chat with history
    const chat = this.geminiModel.startChat({
      history: history,
      generationConfig: {
        temperature: temperature,
        maxOutputTokens: maxTokens,
      }
    });

    const result = await chat.sendMessage(lastUserMessage || 'Hello');
    const response = await result.response;

    return {
      content: response.text(),
      role: 'assistant',
      usage: null, // Gemini doesn't provide usage stats in the same way
      provider: 'gemini',
      model: model
    };
  }
}

// Singleton instance
let providerInstance = null;

function getAIProvider() {
  if (!providerInstance) {
    providerInstance = new AIProvider();
  }
  return providerInstance;
}

module.exports = {
  AIProvider,
  getAIProvider
};
