/**
 * RAG AI Assistant - EMS South Sector Platform
 * Slide-out panel chat UI with knowledge base integration
 * Uses /api/rag endpoints
 */

(function() {
    'use strict';

    const RAG_CONFIG = {
        name: 'المساعد التشغيلي',
        role: 'مساعد الذكاء الاصطناعي',
        avatar: '/logo-icon.png',
        greetingDelay: 1500,
        maxMessageLength: 2000,
        typingDelay: 800,
        wsReconnectInterval: 5000
    };

    class RAGAssistant {
        constructor() {
            this.container = null;
            this.panel = null;
            this.messages = [];
            this.sessionId = null;
            this.sessions = [];
            this.isOpen = false;
            this.isTyping = false;
            this.unreadCount = 0;
            this.ws = null;
            this.userRole = null;
            this.currentUser = null;
            this.suggestedQuestions = [];
            this.init();
        }

        async init() {
            this.loadUser();
            this.createUI();
            this.bindEvents();
            this.connectWebSocket();
            await this.loadSessions();
            await this.loadSuggestedQuestions();
            
            // Show greeting after delay (only on first visit)
            const hasVisited = localStorage.getItem('ragVisited');
            if (!hasVisited) {
                setTimeout(() => {
                    this.showGreeting();
                    localStorage.setItem('ragVisited', 'true');
                }, RAG_CONFIG.greetingDelay);
            }
        }

        loadUser() {
            try {
                const userData = localStorage.getItem('currentUser');
                if (userData) {
                    this.currentUser = JSON.parse(userData);
                    this.userRole = this.currentUser.role || 'user';
                }
            } catch (e) {
                console.warn('[RAG] Could not load user:', e);
            }
        }

        getToken() {
            return localStorage.getItem('authToken') || '';
        }

        createUI() {
            // Main container - floating button
            this.container = document.createElement('div');
            this.container.className = 'rag-assistant-container';
            this.container.id = 'ragAssistantContainer';
            this.container.innerHTML = `
                <button class="rag-toggle-btn" id="ragToggleBtn" title="المساعد الذكي">
                    <i class="fas fa-robot"></i>
                    <span class="rag-badge" id="ragBadge" style="display:none">0</span>
                </button>
            `;
            document.body.appendChild(this.container);

            // Slide-out panel (RIGHT side)
            this.panel = document.createElement('div');
            this.panel.className = 'rag-panel';
            this.panel.id = 'ragPanel';
            this.panel.innerHTML = `
                <div class="rag-panel-header">
                    <div class="rag-header-info">
                        <img src="${RAG_CONFIG.avatar}" alt="AI" class="rag-header-avatar" onerror="this.src='/logo.png'">
                        <div>
                            <h4>${RAG_CONFIG.name}</h4>
                            <span class="rag-status"><span class="rag-status-dot"></span> متصل</span>
                        </div>
                    </div>
                    <div class="rag-header-actions">
                        <button class="rag-header-btn" id="ragSessionsBtn" title="الجلسات">
                            <i class="fas fa-history"></i>
                        </button>
                        <button class="rag-header-btn" id="ragNewChatBtn" title="محادثة جديدة">
                            <i class="fas fa-plus"></i>
                        </button>
                        <button class="rag-header-btn" id="ragCloseBtn" title="إغلاق">
                            <i class="fas fa-times"></i>
                        </button>
                    </div>
                </div>
                <div class="rag-panel-body">
                    <!-- Sessions sidebar -->
                    <div class="rag-sessions-sidebar" id="ragSessionsSidebar">
                        <div class="rag-sessions-header">
                            <h5>جلسات المحادثة</h5>
                            <button id="ragCloseSessionsBtn" title="إغلاق"><i class="fas fa-times"></i></button>
                        </div>
                        <div class="rag-sessions-list" id="ragSessionsList"></div>
                    </div>
                    <!-- Welcome Screen -->
                    <div class="rag-welcome" id="ragWelcome">
                        <div class="rag-welcome-icon">
                            <i class="fas fa-brain"></i>
                        </div>
                        <h3>مرحباً بك في المساعد التشغيلي!</h3>
                        <p>يمكنني مساعدتك في:</p>
                        <div class="rag-suggestions" id="ragSuggestions"></div>
                        <div class="rag-role-badge" id="ragRoleBadge" style="display:none"></div>
                    </div>
                    <!-- Messages Area -->
                    <div class="rag-messages" id="ragMessages"></div>
                </div>
                <div class="rag-panel-footer">
                    <div class="rag-input-area">
                        <textarea class="rag-input" id="ragInput" placeholder="اكتب سؤالك هنا..." rows="1"></textarea>
                        <button class="rag-send-btn" id="ragSendBtn" title="إرسال">
                            <i class="fas fa-paper-plane"></i>
                        </button>
                    </div>
                    <div class="rag-footer-note">المساعد يستخدم قاعدة المعرفة التشغيلية</div>
                </div>
            `;
            document.body.appendChild(this.panel);

            // Cache elements
            this.elements = {
                toggleBtn: document.getElementById('ragToggleBtn'),
                panel: document.getElementById('ragPanel'),
                messages: document.getElementById('ragMessages'),
                input: document.getElementById('ragInput'),
                sendBtn: document.getElementById('ragSendBtn'),
                closeBtn: document.getElementById('ragCloseBtn'),
                newChatBtn: document.getElementById('ragNewChatBtn'),
                sessionsBtn: document.getElementById('ragSessionsBtn'),
                sessionsSidebar: document.getElementById('ragSessionsSidebar'),
                closeSessionsBtn: document.getElementById('ragCloseSessionsBtn'),
                sessionsList: document.getElementById('ragSessionsList'),
                badge: document.getElementById('ragBadge'),
                welcome: document.getElementById('ragWelcome'),
                suggestions: document.getElementById('ragSuggestions'),
                roleBadge: document.getElementById('ragRoleBadge')
            };

            // Show role badge
            if (this.userRole) {
                this.elements.roleBadge.style.display = 'inline-block';
                this.elements.roleBadge.textContent = this.getRoleLabel(this.userRole);
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
            // Toggle panel
            this.elements.toggleBtn.addEventListener('click', () => {
                this.togglePanel();
            });

            // Close button
            this.elements.closeBtn.addEventListener('click', () => {
                this.closePanel();
            });

            // New chat button
            this.elements.newChatBtn.addEventListener('click', () => {
                this.startNewChat();
            });

            // Sessions button
            this.elements.sessionsBtn.addEventListener('click', () => {
                this.toggleSessionsSidebar();
            });

            this.elements.closeSessionsBtn.addEventListener('click', () => {
                this.hideSessionsSidebar();
            });

            // Send button
            this.elements.sendBtn.addEventListener('click', () => {
                this.sendMessage();
            });

            // Enter key in textarea
            this.elements.input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    this.sendMessage();
                }
            });

            // Auto-resize textarea
            this.elements.input.addEventListener('input', () => {
                this.elements.input.style.height = 'auto';
                this.elements.input.style.height = Math.min(this.elements.input.scrollHeight, 120) + 'px';
            });

            // Close on outside click
            document.addEventListener('click', (e) => {
                if (this.isOpen && 
                    !this.panel.contains(e.target) && 
                    !this.container.contains(e.target)) {
                    this.closePanel();
                }
            });
        }

        togglePanel() {
            if (this.isOpen) {
                this.closePanel();
            } else {
                this.openPanel();
            }
        }

        openPanel() {
            this.isOpen = true;
            this.panel.classList.add('open');
            this.elements.toggleBtn.classList.add('active');
            this.unreadCount = 0;
            this.elements.badge.style.display = 'none';
            
            setTimeout(() => {
                this.elements.input.focus();
            }, 300);
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
            this.sessionId = null;
            this.messages = [];
            this.elements.messages.innerHTML = '';
            this.elements.welcome.style.display = 'flex';
            this.hideSessionsSidebar();
        }

        showGreeting() {
            this.openPanel();
            this.addMessage('bot', 'أهلاً بك! أنا المساعد التشغيلي الذكي لقطاع جنوب الرياض. يمكنني الإجابة على استفساراتك حول البروتوكولات والإجراءات التشغيلية بناءً على قاعدة المعرفة المتاحة. كيف يمكنني مساعدتك؟');
        }

        addMessage(type, text, metadata = null) {
            this.elements.welcome.style.display = 'none';
            
            const messageEl = document.createElement('div');
            messageEl.className = `rag-message ${type}`;
            
            const time = new Date().toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' });
            
            let metadataHtml = '';
            if (metadata) {
                // Confidence
                if (metadata.confidence !== undefined) {
                    const confidencePercent = Math.round(metadata.confidence);
                    const confidenceClass = confidencePercent >= 65 ? 'high' : confidencePercent >= 35 ? 'medium' : 'low';
                    metadataHtml += `<div class="rag-confidence ${confidenceClass}"><i class="fas fa-shield-alt"></i> مستوى الثقة: ${confidencePercent}%</div>`;
                }
                
                // Sources
                if (metadata.sources && metadata.sources.length > 0) {
                    const sourcesList = metadata.sources.map((s, i) => {
                        const content = s.content ? s.content.substring(0, 120) + '...' : '';
                        const docTitle = s.docTitle || s.docId || `مصدر ${i + 1}`;
                        return `<li class="rag-source-item">
                            <div class="rag-source-header" onclick="this.nextElementSibling.classList.toggle('open')">
                                <span class="rag-source-tag">${i + 1}</span>
                                <span class="rag-source-title">${this.escapeHtml(docTitle)}</span>
                                <i class="fas fa-chevron-down rag-source-toggle"></i>
                            </div>
                            <div class="rag-source-content">${this.escapeHtml(content)}</div>
                        </li>`;
                    }).join('');
                    
                    metadataHtml += `
                        <div class="rag-message-sources">
                            <span class="rag-sources-label"><i class="fas fa-bookmark"></i> المصادر:</span>
                            <ul class="rag-sources-list">${sourcesList}</ul>
                        </div>
                    `;
                }
                
                // Query time
                if (metadata.queryTimeMs) {
                    metadataHtml += `<div class="rag-query-time">⏱️ ${metadata.queryTimeMs} ملي ثانية</div>`;
                }
            }
            
            messageEl.innerHTML = `
                <div class="rag-message-content">${this.formatMessage(text)}</div>
                ${metadataHtml}
                <span class="rag-message-time">${time}</span>
            `;
            
            this.elements.messages.appendChild(messageEl);
            this.scrollToBottom();
        }

        formatMessage(text) {
            if (!text) return '';
            // Escape HTML
            let formatted = this.escapeHtml(text);
            // Convert newlines to <br>
            formatted = formatted.replace(/\n/g, '<br>');
            // Bold markers
            formatted = formatted.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
            // Numbered lists
            formatted = formatted.replace(/^(\d+)[\.\)]\s+(.+)$/gm, '<div style="margin-right:8px;margin-bottom:4px;"><span style="color:var(--primary);font-weight:600;">$1.</span> $2</div>');
            return formatted;
        }

        showTyping() {
            this.isTyping = true;
            const typingEl = document.createElement('div');
            typingEl.className = 'rag-message bot typing';
            typingEl.id = 'ragTypingIndicator';
            typingEl.innerHTML = `
                <div class="rag-typing-indicator">
                    <span></span><span></span><span></span>
                </div>
            `;
            this.elements.messages.appendChild(typingEl);
            this.scrollToBottom();
        }

        hideTyping() {
            this.isTyping = false;
            const typingEl = document.getElementById('ragTypingIndicator');
            if (typingEl) typingEl.remove();
        }

        scrollToBottom() {
            this.elements.messages.scrollTop = this.elements.messages.scrollHeight;
        }

        escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        async loadSessions() {
            try {
                const token = this.getToken();
                if (!token) return;
                
                const response = await fetch('/api/rag/sessions', {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                
                if (!response.ok) return;
                const data = await response.json();
                if (data.success) {
                    this.sessions = data.sessions || [];
                    this.renderSessions();
                }
            } catch (error) {
                console.error('[RAG] Load sessions error:', error);
            }
        }

        renderSessions() {
            const container = this.elements.sessionsList;
            if (!this.sessions.length) {
                container.innerHTML = '<div class="rag-sessions-empty">لا توجد جلسات سابقة</div>';
                return;
            }
            
            container.innerHTML = this.sessions.map(s => {
                const title = s.title || 'محادثة بدون عنوان';
                const date = s.updated_at ? new Date(s.updated_at).toLocaleDateString('ar-SA') : '';
                const isActive = this.sessionId === s.session_id ? 'active' : '';
                return `
                    <div class="rag-session-item ${isActive}" data-id="${s.session_id}">
                        <div class="rag-session-title">${this.escapeHtml(title)}</div>
                        <div class="rag-session-date">${date}</div>
                        <button class="rag-session-delete" data-id="${s.session_id}" title="حذف"><i class="fas fa-trash"></i></button>
                    </div>
                `;
            }).join('');
            
            // Bind click events
            container.querySelectorAll('.rag-session-item').forEach(item => {
                item.addEventListener('click', (e) => {
                    if (e.target.closest('.rag-session-delete')) return;
                    const sessionId = item.dataset.id;
                    this.loadSessionMessages(sessionId);
                });
            });
            
            container.querySelectorAll('.rag-session-delete').forEach(btn => {
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
                const token = this.getToken();
                if (!token) return;
                
                this.showTyping();
                const response = await fetch(`/api/rag/sessions/${sessionId}/messages`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                
                if (!response.ok) throw new Error('Failed to load messages');
                const data = await response.json();
                
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
                        this.addMessage(type, msg.content, metadata);
                    });
                    
                    this.hideSessionsSidebar();
                } else {
                    this.hideTyping();
                    throw new Error(data.error || 'Failed to load messages');
                }
            } catch (error) {
                console.error('[RAG] Load session messages error:', error);
                this.hideTyping();
            }
        }

        async deleteSession(sessionId) {
            try {
                const token = this.getToken();
                if (!token) return;
                
                const response = await fetch(`/api/rag/sessions/${sessionId}`, {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                
                if (response.ok) {
                    this.sessions = this.sessions.filter(s => s.session_id !== sessionId);
                    this.renderSessions();
                    if (this.sessionId === sessionId) {
                        this.startNewChat();
                    }
                }
            } catch (error) {
                console.error('[RAG] Delete session error:', error);
            }
        }

        async loadSuggestedQuestions() {
            try {
                const response = await fetch('/api/rag/suggest');
                if (!response.ok) return;
                const data = await response.json();
                if (data.success && data.questions) {
                    this.suggestedQuestions = data.questions.slice(0, 4);
                    this.renderSuggestedQuestions();
                }
            } catch (error) {
                console.error('[RAG] Load suggestions error:', error);
                // Fallback suggestions
                this.suggestedQuestions = [
                    'ما هي البروتوكولات التشغيلية؟',
                    'كيفية تسجيل بلاغ؟',
                    'خطوات تكميل النوبة',
                    'الإجراءات الطارئة'
                ];
                this.renderSuggestedQuestions();
            }
        }

        renderSuggestedQuestions() {
            if (!this.elements.suggestions) return;
            this.elements.suggestions.innerHTML = this.suggestedQuestions.map(q => `
                <button class="rag-suggestion-btn" data-q="${this.escapeHtml(q)}">${this.escapeHtml(q)}</button>
            `).join('');
            
            this.elements.suggestions.querySelectorAll('.rag-suggestion-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const question = e.target.dataset.q;
                    this.elements.input.value = question;
                    this.sendMessage();
                });
            });
        }

        async sendMessage() {
            const text = this.elements.input.value.trim();
            if (!text || this.isTyping) return;
            
            if (text.length > RAG_CONFIG.maxMessageLength) {
                this.addMessage('bot', 'الرسالة طويلة جداً. يرجى تقصير السؤال.');
                return;
            }
            
            // Add user message
            this.addMessage('user', text);
            this.elements.input.value = '';
            this.elements.input.style.height = 'auto';
            
            // Show typing indicator
            this.showTyping();
            
            try {
                const token = this.getToken();
                const response = await fetch('/api/rag/ask', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                    body: JSON.stringify({
                        query: text,
                        sessionId: this.sessionId,
                        topK: 5
                    })
                });
                
                const data = await response.json();
                this.hideTyping();
                
                if (data.success) {
                    this.hideTyping();
                    this.sessionId = this.sessionId || data.sessionId || ('session-' + Date.now());
                    const metadata = {
                        sources: data.sources,
                        confidence: data.confidence,
                        queryTimeMs: data.queryTimeMs
                    };
                    this.addMessage('bot', data.answer, metadata);
                    
                    // Refresh sessions if this was a new session
                    if (!this.sessions.find(s => s.session_id === this.sessionId)) {
                        await this.loadSessions();
                    }
                } else {
                    this.hideTyping();
                    this.addMessage('bot', 'عذراً، حدث خطأ في معالجة سؤالك: ' + (data.error || 'يرجى المحاولة مرة أخرى.'));
                }
            } catch (error) {
                this.hideTyping();
                console.error('[RAG] Chat error:', error);
                this.addMessage('bot', 'عذراً، لا يمكن الاتصال بالخادم. يرجى التحقق من اتصالك بالشبكة.');
            }
        }

        connectWebSocket() {
            const wsUrl = (window.location.protocol === 'https:' ? 'wss://' : 'ws://') + window.location.host + '/ws';
            
            try {
                this.ws = new WebSocket(wsUrl);
                
                this.ws.onopen = () => {
                    console.log('[RAG] WebSocket connected');
                };
                
                this.ws.onmessage = (event) => {
                    try {
                        const data = JSON.parse(event.data);
                        if (data.type === 'notification' || data.type === 'alert') {
                            this.showNotification(data.message);
                        }
                    } catch (e) {
                        // Ignore non-JSON messages
                    }
                };
                
                this.ws.onclose = () => {
                    console.log('[RAG] WebSocket disconnected, reconnecting...');
                    setTimeout(() => this.connectWebSocket(), RAG_CONFIG.wsReconnectInterval);
                };
                
                this.ws.onerror = (error) => {
                    console.error('[RAG] WebSocket error:', error);
                };
            } catch (e) {
                console.log('[RAG] WebSocket not available');
            }
        }

        showNotification(message) {
            if (!this.isOpen) {
                this.unreadCount++;
                this.elements.badge.textContent = this.unreadCount;
                this.elements.badge.style.display = 'flex';
            }
        }
    }

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            window.ragAssistant = new RAGAssistant();
        });
    } else {
        window.ragAssistant = new RAGAssistant();
    }
})();
