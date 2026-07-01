const crypto = require('crypto');

// ============================================================================
// Security Configuration - منصة إدارة العمليات الإسعافية
// ============================================================================

// JWT Secret: MUST be set via environment variable in production
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET && process.env.NODE_ENV === 'production') {
    console.error('❌ CRITICAL: JWT_SECRET environment variable is required in production');
    process.exit(1);
}

// Fallback for development only (randomly generated, survives process lifetime)
const DEV_FALLBACK_SECRET = crypto.randomBytes(64).toString('hex');

module.exports = {
    JWT_SECRET: JWT_SECRET || DEV_FALLBACK_SECRET,
    JWT_EXPIRES_IN: '24h',
    
    // Rate limiting configuration
    RATE_LIMIT_WINDOW_MS: 15 * 60 * 1000, // 15 minutes
    RATE_LIMIT_MAX_REQUESTS: 100, // per IP per window
    LOGIN_RATE_LIMIT_MAX: 10, // login attempts per 15 min
    
    // CORS configuration
    CORS_ORIGIN: process.env.CORS_ORIGIN || '*',
    CORS_CREDENTIALS: false,
    
    // Body parser limits
    JSON_LIMIT: '10mb',
    URLENCODED_LIMIT: '10mb',
    
    // File upload limits
    MAX_FILE_SIZE: 20 * 1024 * 1024, // 20MB (reduced from 100MB)
    OPS_MAX_FILE_SIZE: 20 * 1024 * 1024, // 20MB
    
    // Storage paths
    STORAGE_PATH: process.env.RENDER_DISK_PATH || require('path').join(__dirname, '..', 'data'),
    
    // Security headers via Helmet
    HELMET_CONFIG: {
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdnjs.cloudflare.com", "https://unpkg.com", "https://cdn.jsdelivr.net"],
                styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
                fontSrc: ["'self'", "https://fonts.gstatic.com"],
                imgSrc: ["'self'", "data:", "blob:"],
                connectSrc: ["'self'", "wss:", "ws:"],
                mediaSrc: ["'self'"],
                frameSrc: ["'self'"],
            },
        },
        crossOriginEmbedderPolicy: false, // Needed for external fonts/CDNs
        hsts: {
            maxAge: 31536000,
            includeSubDomains: true,
            preload: true
        }
    }
};
