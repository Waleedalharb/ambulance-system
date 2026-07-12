// ============================================
// SERVER.JS CHAT UPGRADE PATCH
// Replace the existing WebSocket & Chat Broadcast sections with this code
// ============================================

// ============================================
// SECTION 1: REPLACE initWebSocket function (around line 247)
// ============================================

function initWebSocket(server) {
    wss = new WebSocket.Server({ server, path: '/ws' });
    
    wss.on('connection', function(ws, req) {
        // Basic origin check for WebSocket
        const origin = req.headers.origin;
        const allowedOrigins = process.env.CORS_ORIGIN ? [process.env.CORS_ORIGIN] : [];
        if (process.env.NODE_ENV === 'production' && allowedOrigins.length > 0 && !allowedOrigins.includes(origin)) {
            ws.close(1008, 'Origin not allowed');
            return;
        }

        // Extract token from query string or headers
        const url = new URL(req.url, 'http://localhost');
        const token = url.searchParams.get('token') || req.headers['sec-websocket-protocol'];

        // JWT Authentication for WebSocket
        if (!token) {
            console.log('[WS] Connection rejected: no token');
            ws.close(1008, 'Authentication required');
            return;
        }

        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            ws.user = decoded;
            ws.isAuthenticated = true;
            ws.chatConversations = [];
            ws.lastSeen = Date.now();
            ws.isAlive = true;
            console.log('[WS] Authenticated:', ws.user.name, '(' + ws.user.id + ')');
        } catch (err) {
            console.log('[WS] Connection rejected: invalid token');
            ws.close(1008, 'Invalid token');
            return;
        }

        clients.push(ws);

        // Track online user - check if already has a connection (multi-tab)
        const existingConnection = onlineUsers.get(ws.user.id);
        if (existingConnection) {
            // User has another tab open - mark as multi-connection but still broadcast online
            console.log('[WS] User', ws.user.name, 'has multiple connections');
        }
        
        onlineUsers.set(ws.user.id, {
            ws: ws,
            user: ws.user,
            lastSeen: Date.now(),
            connections: (existingConnection ? existingConnection.connections || 1 : 0) + 1
        });
        
        // Broadcast user_online to ALL connected clients (not just chat subscribers)
        broadcastToAll({
            type: 'user_online',
            userId: ws.user.id,
            name: ws.user.name,
            role: ws.user.role,
            timestamp: new Date().toISOString()
        });

        ws.send(JSON.stringify({ 
            type: 'connected', 
            message: 'متصل بالسيرفر', 
            user: ws.user,
            onlineUsers: Array.from(onlineUsers.values()).map(u => ({ id: u.user.id, name: u.user.name, role: u.user.role }))
        }));

        // Send current online users list immediately
        ws.send(JSON.stringify({
            type: 'online_users_list',
            users: Array.from(onlineUsers.values()).map(u => ({ id: u.user.id, name: u.user.name, role: u.user.role }))
        }));

        // Keep-Alive: server-initiated ping every 30 seconds
        ws.pingInterval = setInterval(function() {
            if (ws.readyState === WebSocket.OPEN) {
                if (!ws.isAlive) {
                    console.log('[WS] Connection dead, terminating:', ws.user ? ws.user.name : 'unknown');
                    ws.terminate();
                    return;
                }
                ws.isAlive = false;
                ws.ping(function(){});
            }
        }, 30000);

        ws.on('pong', function() {
            ws.isAlive = true;
            ws.lastSeen = Date.now();
        });

        ws.on('message', function(raw) {
            try {
                var msg = JSON.parse(raw);
                ws.lastSeen = Date.now();
                ws.isAlive = true;

                if (msg.type === 'chat_typing') {
                    // Broadcast typing to conversation subscribers ONLY
                    broadcastToConversation(msg.conversationId, { 
                        type: 'chat_typing', 
                        conversationId: msg.conversationId, 
                        user: ws.user 
                    });
                }
                if (msg.type === 'chat_subscribe') {
                    ws.chatConversations = ws.chatConversations || [];
                    if (!ws.chatConversations.includes(msg.conversationId)) {
                        ws.chatConversations.push(msg.conversationId);
                    }
                    // Send current online users
                    ws.send(JSON.stringify({
                        type: 'online_users_list',
                        users: Array.from(onlineUsers.values()).map(u => ({ id: u.user.id, name: u.user.name, role: u.user.role }))
                    }));
                }
                if (msg.type === 'chat_unsubscribe') {
                    if (ws.chatConversations) {
                        ws.chatConversations = ws.chatConversations.filter(function(id) { return id !== msg.conversationId; });
                    }
                }
                if (msg.type === 'chat_presence') {
                    // Update presence timestamp
                    if (ws.user && ws.user.id) {
                        const entry = onlineUsers.get(ws.user.id);
                        if (entry) {
                            entry.lastSeen = Date.now();
                        }
                    }
                    // Acknowledge presence
                    ws.send(JSON.stringify({
                        type: 'chat_presence_ack',
                        userId: ws.user.id,
                        timestamp: new Date().toISOString()
                    }));
                }
                if (msg.type === 'ping') {
                    ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
                }
                if (msg.type === 'logout') {
                    // Client is logging out - mark as offline
                    console.log('[WS] User logged out:', ws.user ? ws.user.name : 'unknown');
                    handleUserDisconnect(ws, true);
                    ws.close(1000, 'User logged out');
                }
            } catch(e) {
                console.error('[WS] Message error:', e.message);
            }
        });

        ws.on('close', function() {
            console.log('[WS] Client disconnected:', ws.user ? ws.user.name : 'unknown');
            clearInterval(ws.pingInterval);
            handleUserDisconnect(ws, false);
            clients = clients.filter(function(c) { return c !== ws; });
        });

        ws.on('error', function(err) {
            console.error('[WS] Error:', err);
        });
    });
    
    console.log('[WS] Server attached to HTTP server on /ws');
    
    // Heartbeat: remove stale connections every 60 seconds
    // A connection is stale if it hasn't responded to ping in 120 seconds
    setInterval(function() {
        var now = Date.now();
        clients.forEach(function(client) {
            if (client.readyState === WebSocket.OPEN && !client.isAlive) {
                console.log('[WS] Heartbeat timeout:', client.user ? client.user.name : 'unknown');
                client.terminate();
            }
        });
    }, 60000);
}

// Helper: handle user disconnection (logout or tab close)
function handleUserDisconnect(ws, isLogout) {
    if (!ws.user || !ws.user.id) return;
    
    var entry = onlineUsers.get(ws.user.id);
    if (!entry) return;
    
    // Decrement connection count
    var remainingConnections = (entry.connections || 1) - 1;
    
    if (remainingConnections <= 0 || isLogout) {
        // No more connections or explicit logout - mark as offline
        onlineUsers.delete(ws.user.id);
        broadcastToAll({
            type: 'user_offline',
            userId: ws.user.id,
            name: ws.user.name,
            timestamp: new Date().toISOString()
        });
    } else {
        // Still has other tabs open - update connection count
        onlineUsers.set(ws.user.id, {
            ...entry,
            connections: remainingConnections,
            lastSeen: Date.now()
        });
    }
}

// ============================================
// SECTION 2: REPLACE broadcast functions (around line 411)
// ============================================

function broadcast(data) {
    var message = JSON.stringify(data);
    clients = clients.filter(function(client) {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(message);
                return true;
            } catch (e) {
                console.error('[WS] Broadcast error:', e.message);
                return false;
            }
        }
        return false;
    });
    // Also broadcast via SSE
    broadcastSSE(data);
}

// CRITICAL FIX: Broadcast to ALL conversation participants, not just subscribers
// This ensures messages are delivered even if user hasn't opened the conversation yet
function broadcastToConversation(conversationId, data) {
    var message = JSON.stringify(data);
    var sentCount = 0;
    
    // First: send to subscribers (they get it immediately)
    clients.forEach(function(client) {
        if (client.readyState === WebSocket.OPEN) {
            var isSubscribed = client.chatConversations && client.chatConversations.includes(conversationId);
            if (isSubscribed) {
                try {
                    client.send(message);
                    sentCount++;
                } catch (e) {
                    console.error('[WS] Broadcast to subscriber error:', e.message);
                }
            }
        }
    });
    
    // Second: send to authenticated clients who are participants but not subscribers
    // This ensures ALL participants get the message via WebSocket for instant delivery
    broadcastToConversationParticipants(conversationId, data);
    
    // Also broadcast via SSE for non-WebSocket clients
    broadcastSSE(data);
}

// NEW: Broadcast to all WebSocket clients who are participants of the conversation
// Uses the database to find participants, then sends to their WebSocket connections
async function broadcastToConversationParticipants(conversationId, data) {
    try {
        if (!db) return;
        
        // Get all participants of this conversation
        var participants = await db.all(
            'SELECT user_id FROM chat_participants WHERE conversation_id = ?',
            [conversationId]
        );
        
        if (!participants || participants.length === 0) return;
        
        var participantIds = participants.map(function(p) { return p.user_id; });
        var message = JSON.stringify(data);
        
        // Send to ALL authenticated WebSocket connections of participants
        // regardless of whether they subscribed to the conversation
        clients.forEach(function(client) {
            if (client.readyState === WebSocket.OPEN && client.user && client.user.id) {
                if (participantIds.includes(client.user.id)) {
                    try {
                        client.send(message);
                    } catch (e) {
                        console.error('[WS] Participant broadcast error:', e.message);
                    }
                }
            }
        });
    } catch (e) {
        console.error('[WS] broadcastToConversationParticipants error:', e.message);
    }
}

// Helper: broadcast to ALL authenticated connected clients
function broadcastToAll(data) {
    var message = JSON.stringify(data);
    clients.forEach(function(client) {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(message);
            } catch (e) {
                console.error('[WS] Broadcast to all error:', e.message);
            }
        }
    });
}

// Helper: get online users list
function getOnlineUsers() {
    return Array.from(onlineUsers.values()).map(function(u) {
        return { id: u.user.id, name: u.user.name, role: u.user.role };
    });
}


// ============================================
// SECTION 3: UPDATE chat message broadcast (around line 9553)
// Replace the broadcast line in POST /api/chat/conversations/:id/messages
// ============================================

// OLD:
// broadcastToConversation(convId, { type: 'chat_message', conversationId: convId, message });

// NEW - Add after line 9553:
// Broadcast to conversation participants using the enhanced delivery
(async function() {
    try {
        await broadcastToConversationParticipants(convId, { 
            type: 'chat_message', 
            conversationId: convId, 
            message 
        });
    } catch(e) {
        console.error('[Chat] Participant broadcast error:', e.message);
    }
})();


// ============================================
// SECTION 4: UPDATE read receipt broadcast (around line 9588)
// The read receipt broadcast already exists but ensure it broadcasts properly
// ============================================

// The existing code at line 9588 already has:
// broadcastToConversation(message.conversation_id, { type: 'chat_read', messageId: messageId, userId: userId });

// Replace with enhanced version that also sends to all participants:
(async function() {
    try {
        var readData = { type: 'chat_read', messageId: messageId, userId: userId, readAt: new Date().toISOString() };
        broadcastToConversation(message.conversation_id, readData);
        await broadcastToConversationParticipants(message.conversation_id, readData);
    } catch(e) {
        console.error('[Chat] Read receipt broadcast error:', e.message);
    }
})();