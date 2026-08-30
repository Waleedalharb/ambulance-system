/**
 * place-discovery-hook.js — الربط التسلسلي لـDiscovery بعد الحسم (PI-7)
 * يعمل داخل سلسلة الخطاف القائم عبر onResolved (بعد recordResolution مباشرة):
 *  - لا يُستدعى إن كان القرار confirmed (المسجل داخليًا لا يحتاج مزودًا).
 *  - طابور تسلسلي مستقل بنفس فلسفة place-resolution-hook: فشل أي بلاغ
 *    يُسجَّل ولا يكسر الطابور ولا يمس البلاغ ولا الاستجابة.
 *  - الميزانية والقاطع عبر الكاش — استعلام مزود واحد لكل بلاغ كحد أقصى.
 */
'use strict';
const { discover } = require('./place-discovery-orchestrator');

function makeDiscoveryHook({ provider, cache, logger = console }) {
    let queue = Promise.resolve();
    let enqueued = 0, skipped = 0, failed = 0;

    function onResolved(eventId, resolution, incident) {
        if (!eventId || !resolution) return;
        if (resolution.decision === 'confirmed') { skipped++; return; }  // Registry حسمها
        if (!incident || typeof incident.lat !== 'number') { skipped++; return; }
        if (!provider) { skipped++; return; }                            // التوكن غير مضبوط — فشل آمن صامت
        if (cache && !cache.allowProviderCall()) { skipped++; return; }  // ميزانية/قاطع

        enqueued++;
        queue = queue.then(async () => {
            try {
                // تقاسم خلوي: بلاغ سابق بنفس الموقع (~55م) يغني عن استعلام جديد
                const cellHit = cache && cache.getCell(incident.lat, incident.lng);
                if (cellHit) { cache.set(eventId, cellHit); return; }
                // فحص الميزانية لحظة التنفيذ أيضًا (الفحص عند enqueue وحده يسبق
                // الاستهلاك الفعلي — الطابور متسلسل فالفحص هنا هو الحاسم)
                if (cache && !cache.allowProviderCall()) { skipped++; return; }
                if (cache) cache.noteProviderCall();
                const result = await discover(provider, incident);
                if (result.errorKind === 'rate-limited' && cache) cache.noteRateLimited();
                if (cache) { cache.set(eventId, result); cache.setCell(incident.lat, incident.lng, result); }
            } catch (err) {
                failed++;
                if (cache) cache.noteError();
                logger.error('[PlaceDiscovery] فشل البلاغ ' + eventId + ': ' + err.message);
            }
        }).catch(err => {
            failed++;
            logger.error('[PlaceDiscovery] خطأ طابور: ' + err.message);
        });
    }

    function _drain() { return queue; }
    function _stats() { return { enqueued, skipped, failed }; }

    return { onResolved, _drain, _stats };
}

module.exports = { makeDiscoveryHook };
