// Service Worker - منصة الجنوب
var CACHE_NAME = 'janoub-cache-v5';
var urlsToCache = [
    '/',
    '/index.html'
];

self.addEventListener('install', function(event) {
    event.waitUntil(
        caches.open(CACHE_NAME).then(function(cache) {
            return cache.addAll(urlsToCache);
        }).catch(function(err) {
            console.log('Cache failed:', err);
        })
    );
    self.skipWaiting();
});

self.addEventListener('activate', function(event) {
    event.waitUntil(
        caches.keys().then(function(cacheNames) {
            return Promise.all(
                cacheNames.filter(function(name) {
                    return name !== CACHE_NAME;
                }).map(function(name) {
                    return caches.delete(name);
                })
            );
        })
    );
    self.clients.claim();
});

self.addEventListener('fetch', function(event) {
    event.respondWith(
        fetch(event.request).then(function(response) {
            var responseClone = response.clone();
            caches.open(CACHE_NAME).then(function(cache) {
                cache.put(event.request, responseClone);
            });
            return response;
        }).catch(function() {
            return caches.match(event.request).then(function(cached) {
                if (cached) return cached;
                if (event.request.mode === 'navigate') {
                    return new Response(
                        '<html dir="rtl"><head><meta charset="UTF-8"><title>الجنوب - Offline</title>' +
                        '<style>body{font-family:Arial;background:#1E293B;color:white;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;text-align:center;padding:20px;}' +
                        'h1{color:#EF4444;}p{color:#94A3B8;}.btn{background:#2563EB;color:white;padding:12px 24px;border:none;border-radius:8px;cursor:pointer;margin-top:20px;font-size:1rem;}</style></head>' +
                        '<body><h1>⚠️ لا يوجد اتصال</h1><p>تم تخزين البيانات محلياً.<br>سيتم المزامنة عند العودة.</p>' +
                        '<button class="btn" onclick="location.reload()">🔄 إعادة المحاولة</button></body></html>',
                        { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
                    );
                }
                return new Response('', { status: 408, statusText: 'Network unavailable' });
            });
        })
    );
});