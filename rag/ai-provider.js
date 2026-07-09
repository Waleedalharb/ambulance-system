/* ============================================
   AI PROVIDER V2 - Multi-Provider with Auto-Failover
   منصة الجنوب - دعم OpenAI + Gemini + Anthropic + أي مزود
   ============================================
   - Auto-detect keys from environment
   - Auto-failover between providers
   - Usage monitoring
   ============================================ */

const { OpenAI } = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const logger = {
  info: (msg) => console.log(`[AI-PROVIDER] ${new Date().toISOString()} INFO: ${msg}`),
  error: (msg, err) => console.error(`[AI-PROVIDER] ${new Date().toISOString()} ERROR: ${msg}`, err ? (err.message || err) : ''),
  warn: (msg) => console.warn(`[AI-PROVIDER] ${new Date().toISOString()} WARN: ${msg}`),
};

// ============================================
// USAGE MONITORING
// ============================================
class UsageMonitor {
  constructor() {
    this.dailyUsage = new Map(); // provider -> { requests, tokens, errors }
    this.lastReset = new Date().toDateString();
  }

  resetIfNeeded() {
    const today = new Date().toDateString();
    if (today !== this.lastReset) {
      this.dailyUsage.clear();
      this.lastReset = today;
    }
  }

  recordRequest(provider, tokens = 0, error = false) {
    this.resetIfNeeded();
    const current = this.dailyUsage.get(provider) || { requests: 0, tokens: 0, errors: 0 };
    current.requests++;
    current.tokens += tokens || 0;
    if (error) current.errors++;
    this.dailyUsage.set(provider, current);
  }

  getUsage(provider) {
    this.resetIfNeeded();
    return this.dailyUsage.get(provider) || { requests: 0, tokens: 0, errors: 0 };
  }

  getAllUsage() {
    this.resetIfNeeded();
    const result = {};
    for (const [provider, data] of this.dailyUsage) {
      result[provider] = data;
    }
    return result;
  }

  // Check if provider is approaching limits (placeholder - real limits depend on provider)
  getStatus(provider) {
    const usage = this.getUsage(provider);
    const totalRequests = usage.requests;
    // Assume daily limit of 1000 requests for free tier
    const limit = 1000;
    const percentage = (totalRequests / limit) * 100;
    
    return {
      provider,
      requestsToday: totalRequests,
      tokensToday: usage.tokens,
      errorsToday: usage.errors,
      limit,
      percentage,
      status: percentage >= 100 ? 'exhausted' : percentage >= 90 ? 'critical' : percentage >= 70 ? 'warning' : 'healthy'
    };
  }
}

// ============================================
// MULTI-PROVIDER MANAGER
// ============================================
class MultiProviderManager {
  constructor() {
    this.providers = new Map();
    this.usageMonitor = new UsageMonitor();
    this.priority = []; // Ordered list of provider IDs
    this._initProviders();
  }

  _initProviders() {
    // Auto-detect all API keys from environment
    const env = process.env;

    // OpenAI
    const openaiKeys = this._collectKeys(env, 'OPENAI_API_KEY');
    if (openaiKeys.length > 0) {
      try {
        const client = new OpenAI({ apiKey: openaiKeys[0] });
        this.providers.set('openai', {
          id: 'openai',
          name: 'OpenAI',
          client,
          keys: openaiKeys,
          models: ['gpt-4o-mini', 'gpt-4o', 'gpt-3.5-turbo'],
          defaultModel: 'gpt-4o-mini',
          chat: this._chatOpenAI.bind(this)
        });
        logger.info(`✅ OpenAI initialized (${openaiKeys.length} key(s))`);
      } catch (err) {
        logger.error('❌ OpenAI init failed', err);
      }
    }

    // Gemini
    const geminiKeys = this._collectKeys(env, 'GEMINI_API_KEY');
    if (geminiKeys.length > 0) {
      try {
        const client = new GoogleGenerativeAI(geminiKeys[0]);
        const model = client.getGenerativeModel({ model: 'gemini-1.5-flash' });
        this.providers.set('gemini', {
          id: 'gemini',
          name: 'Google Gemini',
          client,
          model,
          keys: geminiKeys,
          models: ['gemini-1.5-flash', 'gemini-1.5-pro'],
          defaultModel: 'gemini-1.5-flash',
          chat: this._chatGemini.bind(this)
        });
        logger.info(`✅ Gemini initialized (${geminiKeys.length} key(s))`);
      } catch (err) {
        logger.error('❌ Gemini init failed', err);
      }
    }

    // Anthropic
    const anthropicKeys = this._collectKeys(env, 'ANTHROPIC_API_KEY');
    if (anthropicKeys.length > 0) {
      try {
        // Anthropic uses a different SDK, but we can use fetch
        this.providers.set('anthropic', {
          id: 'anthropic',
          name: 'Anthropic Claude',
          keys: anthropicKeys,
          models: ['claude-3-haiku-20240307', 'claude-3-sonnet-20240229', 'claude-3-opus-20240229'],
          defaultModel: 'claude-3-haiku-20240307',
          chat: this._chatAnthropic.bind(this)
        });
        logger.info(`✅ Anthropic initialized (${anthropicKeys.length} key(s))`);
      } catch (err) {
        logger.error('❌ Anthropic init failed', err);
      }
    }

    // Set priority order (first available = highest priority)
    this.priority = Array.from(this.providers.keys());
    logger.info(`Provider priority: ${this.priority.join(' > ')}`);
  }

  _collectKeys(env, prefix) {
    const keys = [];
    // Check for KEY, KEY_1, KEY_2, etc.
    if (env[prefix] && env[prefix].length > 10) keys.push(env[prefix]);
    for (let i = 1; i <= 10; i++) {
      const key = env[`${prefix}_${i}`];
      if (key && key.length > 10) keys.push(key);
    }
    return keys;
  }

  getAvailableProviders() {
    return Array.from(this.providers.values()).map(p => ({
      id: p.id,
      name: p.name,
      models: p.models,
      defaultModel: p.defaultModel,
      ready: true
    }));
  }

  getProvider(id) {
    return this.providers.get(id);
  }

  isReady() {
    return this.providers.size > 0;
  }

  getStatus() {
    const status = {
      available: this.getAvailableProviders(),
      priority: this.priority,
      usage: this.usageMonitor.getAllUsage()
    };
    // Add limit status for each provider
    for (const provider of this.providers.keys()) {
      status[provider] = this.usageMonitor.getStatus(provider);
    }
    return status;
  }

  // Main chat with auto-failover
  async chat(messages, options = {}) {
    const preferredProvider = options.provider;
    const model = options.model;
    const temperature = options.temperature !== undefined ? options.temperature : 0.3;
    const maxTokens = options.maxTokens || 1000;

    // Determine provider order
    let providersToTry;
    if (preferredProvider && this.providers.has(preferredProvider)) {
      providersToTry = [preferredProvider, ...this.priority.filter(p => p !== preferredProvider)];
    } else {
      providersToTry = [...this.priority];
    }

    const errors = [];

    for (const providerId of providersToTry) {
      const provider = this.providers.get(providerId);
      if (!provider) continue;

      try {
        const result = await provider.chat(messages, {
          model: model || provider.defaultModel,
          temperature,
          maxTokens,
          client: provider.client,
          modelInstance: provider.model
        });

        this.usageMonitor.recordRequest(providerId, result.usage?.total_tokens);
        return { ...result, provider: providerId };

      } catch (err) {
        logger.error(`Provider ${providerId} failed: ${err.message}`);
        this.usageMonitor.recordRequest(providerId, 0, true);
        errors.push({ provider: providerId, error: err.message });

        // Check if it's a rate limit or quota error
        const isQuotaError = err.message?.includes('quota') || 
                             err.message?.includes('rate limit') ||
                             err.message?.includes('429') ||
                             err.status === 429;
        
        if (isQuotaError) {
          logger.warn(`Provider ${providerId} quota exceeded, trying next...`);
          continue;
        }

        // For non-quota errors, still try next provider
        continue;
      }
    }

    // All providers failed
    throw new Error(`All AI providers failed. Errors: ${JSON.stringify(errors)}`);
  }

  // Provider-specific chat implementations
  async _chatOpenAI(messages, { model, temperature, maxTokens, client }) {
    const completion = await client.chat.completions.create({
      model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      temperature,
      max_tokens: maxTokens,
    });

    return {
      content: completion.choices[0].message.content,
      role: completion.choices[0].message.role,
      usage: completion.usage
    };
  }

  async _chatGemini(messages, { model, temperature, maxTokens, modelInstance }) {
    const history = [];
    let lastUserMessage = '';
    
    for (const msg of messages) {
      if (msg.role === 'system') {
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

    const chat = modelInstance.startChat({
      history,
      generationConfig: { temperature, maxOutputTokens: maxTokens }
    });

    const result = await chat.sendMessage(lastUserMessage || 'Hello');
    const response = await result.response;

    return {
      content: response.text(),
      role: 'assistant',
      usage: null
    };
  }

  async _chatAnthropic(messages, { model, temperature, maxTokens, keys }) {
    // Convert messages to Anthropic format
    const systemMessage = messages.find(m => m.role === 'system');
    const conversationMessages = messages.filter(m => m.role !== 'system').map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content
    }));

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': keys[0],
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature,
        system: systemMessage?.content || '',
        messages: conversationMessages
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error: ${error}`);
    }

    const data = await response.json();
    return {
      content: data.content[0].text,
      role: 'assistant',
      usage: data.usage
    };
  }
}

// ============================================
// BACKWARD COMPATIBLE AIProvider CLASS
// ============================================
class AIProvider {
  constructor(config = {}) {
    this.manager = new MultiProviderManager();
    this.provider = config.provider || process.env.AI_PROVIDER || this.manager.priority[0] || 'gemini';
    this.model = config.model || process.env.AI_MODEL || null;
    this.temperature = config.temperature || parseFloat(process.env.AI_TEMPERATURE) || 0.3;
    this.maxTokens = config.maxTokens || parseInt(process.env.AI_MAX_TOKENS) || 1000;
  }

  isReady() {
    return this.manager.isReady();
  }

  getStatus() {
    return this.manager.getStatus();
  }

  getAvailableProviders() {
    return this.manager.getAvailableProviders();
  }

  getActiveProvider() {
    return this.provider;
  }

  setProvider(providerId) {
    if (!this.manager.getProvider(providerId)) {
      throw new Error(`Provider ${providerId} not available`);
    }
    this.provider = providerId;
    logger.info(`Switched to provider: ${providerId}`);
  }

  setModel(modelId) {
    this.model = modelId;
    logger.info(`Switched to model: ${modelId}`);
  }

  async testConnection() {
    try {
      const result = await this.chat([
        { role: 'user', content: 'Say "Connected" in Arabic.' }
      ]);
      return { success: true, response: result.content, provider: result.provider };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async chat(messages, options = {}) {
    return this.manager.chat(messages, {
      provider: options.provider || this.provider,
      model: options.model || this.model,
      temperature: options.temperature !== undefined ? options.temperature : this.temperature,
      maxTokens: options.maxTokens || this.maxTokens
    });
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
  MultiProviderManager,
  UsageMonitor,
  getAIProvider
};
