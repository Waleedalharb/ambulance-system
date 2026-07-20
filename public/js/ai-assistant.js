/* ============================================
   AI ASSISTANT — RAG-based Operational AI
   منصة الجنوب — المساعد التشغيلي الذكي
   ============================================ */

(function() {
    'use strict';

    const AI_CONFIG = {
        name: 'المساعد التشغيلي',
        role: 'مساعد الذكاء الاصطناعي — RAG',
        greetingDelay: 1500,
        maxMessageLength: 2000,
        apiBase: '/api/rag',
        suggestionsCount: 4
    };

    const CONFIDENCE_LABELS = {
        high: { text: 'ثقة عالية', class: 'high', color: '#065F46', bg: '#D1FAE5' },
        medium: { text: 'ثقة متوسطة', class: 'medium', color: '#92400E', bg: '#FEF3C7' },
        low: { text: 'ثقة منخفضة', class: 'low', color: '#991B1B', bg: '#FEE2E2' }
    };

    const ROLE_CATEGORIES = {
        admin: ['بروتوكول', 'إجراء', 'تعليمات', 'تقرير', 'عام'],
        director: ['بروتوكول', 'إجراء', 'تعليمات', 'تقرير', 'عام'],
        user: ['إجراء', 'تعليمات', 'عام'],
        paramedic: ['بروتوكول', 'إجراء', 'عام']
    };

    class AIAssistant {
        constructor() {
            this.container = null;
            this.panel = null;
            this.messages = [];
            this.sessionId = null;
            this.sessions = [];
            this.isOpen = false;
            this.isTyping = false;
            this.unreadCount = 0;
            this.currentUser = null;
            this.suggestedQuestions = [];
            this.init();
        }

        async init() {
            try {
                this.currentUser = await this.getCurrentUser();
                this.sessionId = this.generateSessionId();
                this.createUI();
                this.bindEvents();
                this.loadSuggestedQuestions();
                this.loadSessions();

                // Show greeting on first visit only — never before authentication
                const hasVisited = localStorage.getItem('aiAssistantVisited');
                const isLoggedIn = !!(localStorage.getItem('auth_access_token') || localStorage.getItem('authToken'));
                if (!hasVisited && isLoggedIn) {
                    setTimeout(() => {
                        this.showGreeting();
                        localStorage.setItem('aiAssistantVisited', 'true');
                    }, AI_CONFIG.greetingDelay);
                }
            } catch (e) {
                console.error('[AI Assistant] Init error:', e);
            }
        }

        async getCurrentUser() {
            try {
                const token = localStorage.getItem('authToken');
                if (!token) return null;
                const res = await fetch('/api/auth/me', {
                    headers: { 'Authorization': 'Bearer ' + token }
                });
                if (!res.ok) return null;
                return await res.json();
            } catch (e) {
                return null;
            }
        }

        isAdmin() {
            return this.currentUser && (this.currentUser.role === 'admin' || this.currentUser.role === 'director');
        }

        getUserRoleCategories() {
            const role = this.currentUser ? this.currentUser.role : 'user';
            return ROLE_CATEGORIES[role] || ROLE_CATEGORIES.user;
        }

        generateSessionId() {
            return 'session-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
        }

        createUI() {
            // Floating toggle button (bottom-right)
            this.container = document.createElement('div');
            this.container.className = 'ai-assistant-container';
            this.container.id = 'aiAssistantContainer';
            this.container.innerHTML = `
                <button class="ai-toggle-btn" id="aiToggleBtn" title="المساعد الذكي">
                    <i class="fas fa-robot"></i>
                    <span class="ai-badge" id="aiBadge" style="display:none">0</span>
                </button>
            `;
            document.body.appendChild(this.container);

            // Slide-out panel from RIGHT
            this.panel = document.createElement('div');
            this.panel.className = 'ai-panel';
            this.panel.id = 'aiPanel';

            const adminLink = this.isAdmin()
                ? `<a href="/admin-knowledge.html" class="ai-header-btn" title="إدارة المعرفة" target="_blank"><i class="fas fa-cog"></i></a>`
                : '';

            this.panel.innerHTML = `
                <div class="ai-panel-header">
                    <div class="ai-header-info">
                        <div class="ai-header-icon"><i class="fas fa-robot"></i></div>
                        <div>
                            <h4>${AI_CONFIG.name}</h4>
                            <span class="ai-status"><span class="ai-status-dot"></span> متصل</span>
                        </div>
                    </div>
                    <div class="ai-header-actions">
                        <button class="ai-header-btn" id="aiSessionsBtn" title="الجلسات"><i class="fas fa-history"></i></button>
                        <button class="ai-header-btn" id="aiNewChatBtn" title="محادثة جديدة"><i class="fas fa-plus"></i></button>
                        ${adminLink}
                        <button class="ai-header-btn" id="aiCloseBtn" title="إغلاق"><i class="fas fa-times"></i></button>
                    </div>
                </div>
                <div class="ai-panel-body">
                    <!-- Sessions Sidebar -->
                    <div class="ai-sessions-sidebar" id="aiSessionsSidebar">
                        <div class="ai-sessions-header">
                            <h5>جلسات المحادثة</h5>
                            <button id="aiCloseSessionsBtn" title="إغلاق"><i class="fas fa-times"></i></button>
                        </div>
                        <div class="ai-sessions-list" id="aiSessionsList"></div>
                    </div>
                    <div class="ai-welcome" id="aiWelcome">
                        <div class="ai-welcome-icon"><i class="fas fa-brain"></i></div>
                        <h3>مرحباً بك في المساعد التشغيلي!</h3>
                        <p>يمكنني مساعدتك في الاستفسارات حول البروتوكولات والإجراءات التشغيلية بناءً على قاعدة المعرفة.</p>
                        <div class="ai-suggestions" id="aiSuggestions"></div>
                        <div class="ai-role-badge" id="aiRoleBadge" style="display:none"></div>
                    </div>
                    <div class="ai-messages" id="aiMessages"></div>
                </div>
                <div class="ai-panel-footer">
                    <div class="ai-input-area">
                        <textarea class="ai-input" id="aiInput" placeholder="اكتب سؤالك هنا..." rows="1"></textarea>
                        <button class="ai-send-btn" id="aiSendBtn" title="إرسال"><i class="fas fa-paper-plane"></i></button>
                    </div>
                    <div class="ai-footer-note">المساعد يستخدم قاعدة المعرفة التشغيلية</div>
                </div>
            `;
            document.body.appendChild(this.panel);

            this.elements = {
                toggleBtn: document.getElementById('aiToggleBtn'),
                panel: document.getElementById('aiPanel'),
                messages: document.getElementById('aiMessages'),
                input: document.getElementById('aiInput'),
                sendBtn: document.getElementById('aiSendBtn'),
                closeBtn: document.getElementById('aiCloseBtn'),
                newChatBtn: document.getElementById('aiNewChatBtn'),
                sessionsBtn: document.getElementById('aiSessionsBtn'),
                sessionsSidebar: document.getElementById('aiSessionsSidebar'),
                closeSessionsBtn: document.getElementById('aiCloseSessionsBtn'),
                sessionsList: document.getElementById('aiSessionsList'),
                badge: document.getElementById('aiBadge'),
                welcome: document.getElementById('aiWelcome'),
                suggestions: document.getElementById('aiSuggestions'),
                roleBadge: document.getElementById('aiRoleBadge')
            };

            // Show role badge
            if (this.currentUser && this.currentUser.role) {
                this.elements.roleBadge.style.display = 'inline-block';
                this.elements.roleBadge.textContent = this.getRoleLabel(this.currentUser.role);
            }
        }

        getRoleLabel(role) {
            const labels = {
                admin: 'مدير النظام',
                director: 'مدير العمليات',
                user: 'مستخدم',
                paramedic: 'مسعف'
            };
            return labels[role] || role;
        }

        bindEvents() {
            this.elements.toggleBtn.addEventListener('click', () => this.togglePanel());
            this.elements.closeBtn.addEventListener('click', () => this.closePanel());
            this.elements.newChatBtn.addEventListener('click', () => this.startNewChat());
            this.elements.sessionsBtn.addEventListener('click', () => this.toggleSessionsSidebar());
            this.elements.closeSessionsBtn.addEventListener('click', () => this.hideSessionsSidebar());
            this.elements.sendBtn.addEventListener('click', () => this.sendMessage());

            this.elements.input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    this.sendMessage();
                }
            });

            this.elements.input.addEventListener('input', () => {
                this.elements.input.style.height = 'auto';
                this.elements.input.style.height = Math.min(this.elements.input.scrollHeight, 120) + 'px';
            });

            document.addEventListener('click', (e) => {
                if (this.isOpen && !this.panel.contains(e.target) && !this.container.contains(e.target)) {
                    this.closePanel();
                }
            });
        }

        togglePanel() {
            this.isOpen ? this.closePanel() : this.openPanel();
        }

        openPanel() {
            this.isOpen = true;
            this.panel.classList.add('open');
            this.elements.toggleBtn.classList.add('active');
            this.unreadCount = 0;
            this.elements.badge.style.display = 'none';
            setTimeout(() => this.elements.input.focus(), 300);
        }

        closePanel() {
            this.isOpen = false;
            this.panel.classList.remove('open');
            this.elements.toggleBtn.classList.remove('active');
            this.hideSessionsSidebar();
        }

        toggleSessionsSidebar() {
            this.elements.sessionsSidebar.classList.toggle('open');
        }

        hideSessionsSidebar() {
            this.elements.sessionsSidebar.classList.remove('open');
        }

        startNewChat() {
            this.sessionId = this.generateSessionId();
            this.messages = [];
            this.elements.messages.innerHTML = '';
            this.elements.welcome.style.display = 'flex';
            this.loadSuggestedQuestions();
            this.hideSessionsSidebar();
        }

        showGreeting() {
            this.openPanel();
            this.addBotMessage('أهلاً بك! أنا المساعد التشغيلي الذكي لقطاع جنوب الرياض. يمكنني الإجابة على استفساراتك حول البروتوكولات والإجراءات التشغيلية بناءً على قاعدة المعرفة المتاحة. كيف يمكنني مساعدتك؟', 0, []);
        }

        async loadSessions() {
            try {
                const token = localStorage.getItem('authToken');
                if (!token) return;
                const res = await fetch(`${AI_CONFIG.apiBase}/sessions`, {
                    headers: { 'Authorization': 'Bearer ' + token }
                });
                if (!res.ok) return;
                const data = await res.json();
                if (data.success) {
                    this.sessions = data.sessions || [];
                    this.renderSessions();
                }
            } catch (e) {
                console.error('[AI] Failed to load sessions:', e);
            }
        }

        renderSessions() {
            const container = this.elements.sessionsList;
            if (!this.sessions.length) {
                container.innerHTML = '<div class="ai-sessions-empty">لا توجد جلسات سابقة</div>';
                return;
            }
            container.innerHTML = this.sessions.map(s => {
                const title = s.title || 'محادثة بدون عنوان';
                const date = s.updated_at ? new Date(s.updated_at).toLocaleDateString('ar-SA') : '';
                const isActive = this.sessionId === s.session_id ? 'active' : '';
                return `
                    <div class="ai-session-item ${isActive}" data-id="${s.session_id}">
                        <div class="ai-session-title">${this.escapeHtml(title)}</div>
                        <div class="ai-session-date">${date}</div>
                        <button class="ai-session-delete" data-id="${s.session_id}" title="حذف"><i class="fas fa-trash"></i></button>
                    </div>
                `;
            }).join('');

            container.querySelectorAll('.ai-session-item').forEach(item => {
                item.addEventListener('click', (e) => {
                    if (e.target.closest('.ai-session-delete')) return;
                    const sessionId = item.dataset.id;
                    this.loadSessionMessages(sessionId);
                });
            });

            container.querySelectorAll('.ai-session-delete').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const sessionId = btn.dataset.id;
                    if (confirm('هل أنت متأكد من حذف هذه الجلسة؟')) {
                        await this.deleteSession(sessionId);
                    }
                });
            });
        }

        async loadSessionMessages(sessionId) {
            try {
                const token = localStorage.getItem('authToken');
                if (!token) return;
                this.showTyping();
                const res = await fetch(`${AI_CONFIG.apiBase}/sessions/${sessionId}/messages`, {
                    headers: { 'Authorization': 'Bearer ' + token }
                });
                if (!res.ok) throw new Error('Failed to load messages');
                const data = await res.json();
                if (data.success) {
                    this.hideTyping();
                    this.sessionId = sessionId;
                    this.messages = data.messages || [];
                    this.elements.messages.innerHTML = '';
                    this.elements.welcome.style.display = 'none';
                    this.messages.forEach(msg => {
                        const type = msg.role === 'user' ? 'user' : 'bot';
                        const metadata = msg.role === 'assistant' ? {
                            sources: msg.sources ? (typeof msg.sources === 'string' ? JSON.parse(msg.sources) : msg.sources) : null,
                            confidence: msg.confidence
                        } : null;
                        if (type === 'user') {
                            this.addUserMessage(msg.content);
                        } else {
                            this.addBotMessage(msg.content, metadata.confidence, metadata.sources);
                        }
                    });
                    this.hideSessionsSidebar();
                } else {
                    this.hideTyping();
                    throw new Error(data.error || 'Failed to load messages');
                }
            } catch (error) {
                console.error('[AI] Load session messages error:', error);
                this.hideTyping();
            }
        }

        async deleteSession(sessionId) {
            try {
                const token = localStorage.getItem('authToken');
                if (!token) return;
                const res = await fetch(`${AI_CONFIG.apiBase}/sessions/${sessionId}`, {
                    method: 'DELETE',
                    headers: { 'Authorization': 'Bearer ' + token }
                });
                if (res.ok) {
                    this.sessions = this.sessions.filter(s => s.session_id !== sessionId);
                    this.renderSessions();
                    if (this.sessionId === sessionId) {
                        this.startNewChat();
                    }
                }
            } catch (error) {
                console.error('[AI] Delete session error:', error);
            }
        }

        async loadSuggestedQuestions() {
            try {
                const token = localStorage.getItem('authToken');
                const res = await fetch(`${AI_CONFIG.apiBase}/suggest?count=${AI_CONFIG.suggestionsCount}`, {
                    headers: token ? { 'Authorization': 'Bearer ' + token } : {}
                });
                if (!res.ok) return;
                const data = await res.json();
                if (data.success && data.questions) {
                    this.suggestedQuestions = data.questions;
                    this.renderSuggestions();
                }
            } catch (e) {
                console.error('[AI] Failed to load suggestions:', e);
                // Fallback suggestions filtered by role
                const roleCategories = this.getUserRoleCategories();
                const fallbackMap = {
                    'بروتوكول': 'ما هي البروتوكولات التشغيلية؟',
                    'إجراء': 'كيفية تسجيل بلاغ؟',
                    'تعليمات': 'خطوات تكميل النوبة',
                    'تقرير': 'الإجراءات الطارئة',
                    'عام': 'ساعات العمل في المراكز'
                };
                this.suggestedQuestions = roleCategories.map(c => fallbackMap[c] || fallbackMap['عام']).slice(0, 4);
                this.renderSuggestions();
            }
        }

        renderSuggestions() {
            this.elements.suggestions.innerHTML = this.suggestedQuestions.map(q => `
                <button class="ai-suggestion-btn" data-q="${this.escapeHtml(q)}">${this.escapeHtml(q)}</button>
            `).join('');

            this.elements.suggestions.querySelectorAll('.ai-suggestion-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    this.elements.input.value = e.target.dataset.q;
                    this.sendMessage();
                });
            });
        }

        addUserMessage(text) {
            this.elements.welcome.style.display = 'none';
            const el = document.createElement('div');
            el.className = 'ai-message user';
            const time = new Date().toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' });
            el.innerHTML = `
                <div class="ai-message-content">${this.escapeHtml(text).replace(/\n/g, '<br>')}</div>
                <span class="ai-message-time">${time}</span>
            `;
            this.elements.messages.appendChild(el);
            this.scrollToBottom();
        }

        addBotMessage(text, confidence, sources, answerType) {
            this.elements.welcome.style.display = 'none';
            const el = document.createElement('div');
            el.className = 'ai-message bot';
            const time = new Date().toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' });

            // Format structured answer
            let formattedText = this.formatText(text);
            formattedText = formattedText.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

            // Add details button if sources exist with full content
            let detailsHtml = '';
            if (sources && sources.length > 0 && sources[0].fullContent) {
                const detailsId = 'details-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
                detailsHtml = `
                    <div class="ai-details-toggle">
                        <button class="ai-details-btn" onclick="document.getElementById('${detailsId}').style.display = document.getElementById('${detailsId}').style.display === 'none' ? 'block' : 'none'; this.textContent = document.getElementById('${detailsId}').style.display === 'none' ? 'عرض الإجراء الكامل' : 'إخفاء التفاصيل';">
                            <i class="fas fa-file-alt"></i> عرض الإجراء الكامل
                        </button>
                        <div id="${detailsId}" class="ai-details-panel" style="display:none;">
                            <div class="ai-details-content">
                                ${this.escapeHtml(sources[0].fullContent).replace(/\n/g, '<br>')}
                            </div>
                        </div>
                    </div>
                `;
            }

            el.innerHTML = `
                <div class="ai-message-content">${formattedText}</div>
                ${detailsHtml}
                <span class="ai-message-time">${time}</span>
            `;
            this.elements.messages.appendChild(el);
            this.scrollToBottom();
        }

        showTyping() {
            this.isTyping = true;
            const el = document.createElement('div');
            el.className = 'ai-message bot typing';
            el.id = 'aiTypingIndicator';
            el.innerHTML = `
                <div class="ai-typing-indicator"><span></span><span></span><span></span></div>
            `;
            this.elements.messages.appendChild(el);
            this.scrollToBottom();
        }

        hideTyping() {
            this.isTyping = false;
            const el = document.getElementById('aiTypingIndicator');
            if (el) el.remove();
        }

        scrollToBottom() {
            this.elements.messages.scrollTop = this.elements.messages.scrollHeight;
        }

        async sendMessage() {
            const text = this.elements.input.value.trim();
            if (!text || this.isTyping) return;
            if (text.length > AI_CONFIG.maxMessageLength) {
                this.addBotMessage('الرسالة طويلة جداً. يرجى تقصير السؤال.', 0, []);
                return;
            }

            this.addUserMessage(text);
            this.elements.input.value = '';
            this.elements.input.style.height = 'auto';
            this.elements.sendBtn.disabled = true;
            this.showTyping();

            try {
                const token = localStorage.getItem('authToken');
                const res = await fetch(`${AI_CONFIG.apiBase}/ask`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': token ? 'Bearer ' + token : ''
                    },
                    body: JSON.stringify({
                        query: text,
                        sessionId: this.sessionId,
                        topK: 5
                    })
                });

                this.hideTyping();
                this.elements.sendBtn.disabled = false;

                if (!res.ok) {
                    throw new Error('HTTP ' + res.status);
                }

                const data = await res.json();
                if (data.success) {
                    this.addBotMessage(data.answer, data.confidence, data.sources, data.answerType);
                    // Refresh sessions if this was a new session
                    if (!this.sessions.find(s => s.session_id === this.sessionId)) {
                        await this.loadSessions();
                    }
                } else {
                    this.addBotMessage('عذراً، حدث خطأ في معالجة سؤالك. يرجى المحاولة مرة أخرى.', 0, []);
                }
            } catch (err) {
                this.hideTyping();
                this.elements.sendBtn.disabled = false;
                console.error('[AI Assistant] Chat error:', err);
                this.addBotMessage('عذراً، لا يمكن الاتصال بالخادم حالياً. يرجى التحقق من الاتصال والمحاولة لاحقاً.', 0, []);
            }
        }

        formatText(text) {
            if (!text) return '';
            let html = this.escapeHtml(text);
            html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
            html = html.replace(/\n/g, '<br>');
            html = html.replace(/⚠️/g, '<span style="color:var(--coral)">⚠️</span>');
            return html;
        }

        escapeHtml(text) {
            if (!text) return '';
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }
    }

    // Initialize — AuthGate: لا نسخة ولا زر قبل المصادقة (index.html)؛
    // الصفحات التي لا تحمّل AuthManager تحافظ على السلوك السابق.
    function initAIAssistant() {
        if (!window.aiAssistant) window.aiAssistant = new AIAssistant();
    }
    if (window.AuthGate) {
        AuthGate.onStart(initAIAssistant);
        // تفكيك عند الخروج/انتهاء الجلسة — الزر لا يبقى فوق شاشة الدخول
        AuthGate.onStop(function() {
            if (window.aiAssistant) {
                try {
                    if (window.aiAssistant.container) window.aiAssistant.container.remove();
                    if (window.aiAssistant.panel) window.aiAssistant.panel.remove();
                } catch (e) {}
                window.aiAssistant = null;
            }
        });
    } else if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initAIAssistant);
    } else {
        initAIAssistant();
    }

    // Global toggle function for external buttons (topbar, sidebar, etc.)
    window.toggleAIChatPanel = function() {
        if (window.aiAssistant) {
            window.aiAssistant.togglePanel();
            return;
        }
        // Retry: AI assistant may still be loading
        let attempts = 0;
        const retry = setInterval(() => {
            attempts++;
            if (window.aiAssistant) {
                clearInterval(retry);
                window.aiAssistant.togglePanel();
            } else if (attempts > 20) { // Give up after ~2 seconds
                clearInterval(retry);
                console.warn('[AI Assistant] Failed to load after retries');
                alert('المساعد الذكي قيد التحميل، يرجى المحاولة بعد لحظات');
            }
        }, 100);
    };
})();
