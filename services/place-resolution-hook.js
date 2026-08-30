/**
 * place-resolution-hook.js — الربط الحي السلبي لـ Place Intelligence (PI-3)
 * اعتماد المالك 2026-08-29 — حاجز ①: الاستجابة لا تنتظر المحرك، لكن الكتابة
 * متسلسلة وذرّية — ممنوع lost update بين بلاغات متزامنة.
 * ═══════════════════════════════════════════════════════════════════════════
 * makeResolutionHook(placeIntel) يعيد دالة enqueue واحدة:
 *  - كل بلاغ يدخل طابورًا تسلسليًا (Promise chain) — كتابة تلو الأخرى.
 *  - فشل أي بلاغ يُسجَّل console.error فقط ولا يكسر الطابور ولا الاستجابة.
 *  - لا قيمة مرجعة تُنتظر من المسار الرئيسي (fire-and-forget منظم).
 */
'use strict';

function makeResolutionHook(placeIntel, logger = console, onResolved = null) {
    let queue = Promise.resolve();
    let enqueued = 0, failed = 0;

    function enqueue(eventId, incident) {
        if (!placeIntel || !eventId) return;
        enqueued++;
        queue = queue.then(() => {
            try {
                const r = placeIntel.recordResolution(eventId, incident);
                // PI-7 (اعتماد المالك 2026-08-30): ردّة اختيارية بعد نجاح الحسم —
                // تغذي Discovery الخارجي. إضافية صِرفة: بلا onResolved لا يتغير
                // أي سلوك. فشل الردّة لا يكسر الطابور (معزولة بـtry).
                if (onResolved && r && r.ok) {
                    try { onResolved(eventId, r.resolution, incident); }
                    catch (cbErr) { logger.error('[PlaceIntel] onResolved: ' + cbErr.message); }
                }
            } catch (err) {
                failed++;
                logger.error('[PlaceIntel] فشل حسم البلاغ ' + eventId + ': ' + err.message);
            }
        }).catch(err => {
            // لا يحدث نظريًا (الداخلية ملتفة بـ try) — حارس أخير يمنع كسر الطابور
            failed++;
            logger.error('[PlaceIntel] خطأ طابور: ' + err.message);
        });
    }

    // للاختبار فقط: انتظار تصريف الطابور + عدادات
    function _drain() { return queue; }
    function _stats() { return { enqueued, failed }; }

    return { enqueue, _drain, _stats };
}

module.exports = { makeResolutionHook };
