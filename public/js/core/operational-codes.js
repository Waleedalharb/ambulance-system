/**
 * ═══ محلل الأكواد التشغيلية الملحقة — operational-codes.js ═══
 * مرحلة الأوفرلاب 1 (محلل مشترك + بذر + توافق عرض فقط — بلا أي تغيير سلوك).
 *
 * الأكواد الملحقة تحمل بدايتها في لاحقتها (بخلاف الأكواد القديمة المفردة):
 *   - أوفرلاب:   O<المدة>-<ساعة البداية>   مثل O12-09 · O12-12 · O12-14
 *     (O12 بلا لاحقة = كود قديم — ليس كودًا تشغيليًا ملحقًا ⇒ null)
 *   - تدخل سريع (الصيغة الجديدة الموقعة): RR<دورية?><رقم>-<D|N>-<ساعة البداية>
 *     مثل RRA1-D-04 · RRA1-N-16 — حرف D/N هو المصدر الوحيد لحقيقة الوردية
 *     (D صباحية · N ليلية)؛ ممنوع اشتقاق D/N من الساعة أو الساعة من D/N.
 *   - تدخل سريع (الصيغة القديمة): RR<دورية?><رقم>-<ساعة البداية>  مثل RRA1-04 · RRA1-16
 *     تبقى مدعومة للبيانات التاريخية (legacy:true · shift:null — ورديتها تُشتق
 *     من الساعة في القاموس كما كانت، ولا يُعدَّل أي تاريخ سابق).
 *     (مدة التدخل السريع ثابتة 12 ساعة بقرار البذر: 04:00→16:00 و16:00→04:00)
 *
 * نقي بلا تبعيات. نمط UMD: يعمل في المتصفح (window.OperationalCodes)
 * وفي Node (module.exports) — نفس أسلوب js/time-riyadh.js.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.OperationalCodes = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    function pad2(n) { return (n < 10 ? '0' : '') + n; }

    // ── أكواد تشغيلية مخصصة من إدارة الرموز (additive — لا تغيّر الأنماط المدمجة) ──
    // كود مخصص يُسجَّل فقط إن لم يطابق أي نمط مدمج؛ يُفك من خصائصه المسجلة حرفيًا.
    var CUSTOM_CODES = {};
    function registerCustom(code, def) {
        var c = String(code || '').trim().toUpperCase();
        if (!c || !def || !def.durationH || !def.start) return false;
        if (parseOperationalCode(c)) return false;                 // يطابق نمطًا مدمجًا — لا حاجة
        if (Object.prototype.hasOwnProperty.call(CUSTOM_CODES, c)) return false;
        CUSTOM_CODES[c] = {
            kind: def.kind === 'rapid' ? 'rapid' : 'overlap',
            series: def.series || '',
            rapidNo: def.rapidNo || null,
            shift: def.shift || null,
            explicitShift: !!def.explicitShift,
            durationH: def.durationH,
            start: def.start,
            end: def.end || pad2((parseInt(def.start.slice(0, 2), 10) + def.durationH) % 24) + ':00',
            custom: true
        };
        return true;
    }

    /**
     * تحليل كود تشغيلي ملحق ← { kind, durationH, start, end, ... } أو null.
     * start/end بصيغة 'HH:00' دائمًا (اللاحقة ساعة فقط بلا دقائق).
     * end = (start + duration) mod 24 — عبور منتصف الليل طبيعي (O12-14 ⇒ 02:00).
     */
    function parseOperationalCode(code) {
        if (code === null || code === undefined) return null;
        var c = String(code).trim();
        var m;
        // أولوية صفر: كود تشغيلي مخصص مسجل من إدارة الرموز (لا يطابق نمطًا مدمجًا)
        if (Object.prototype.hasOwnProperty.call(CUSTOM_CODES, c.toUpperCase())) {
            var cu = CUSTOM_CODES[c.toUpperCase()];
            return {
                kind: cu.kind, series: cu.series, rapidNo: cu.rapidNo,
                shift: cu.shift, explicitShift: cu.explicitShift,
                durationH: cu.durationH, start: cu.start, end: cu.end, custom: true
            };
        }
        // أوفرلاب ملحق: O<مدة 1-99 ساعة>-<بداية 00-23> — بلا لاحقة ⇒ null (كود قديم)
        m = c.match(/^O(\d{1,2})-(\d{2})$/);
        if (m) {
            var durationH = parseInt(m[1], 10);
            var startH = parseInt(m[2], 10);
            if (durationH < 1 || durationH > 99 || startH > 23) return null;
            return {
                kind: 'overlap',
                durationH: durationH,
                start: pad2(startH) + ':00',
                end: pad2((startH + durationH) % 24) + ':00'
            };
        }
        // تدخل سريع — الصيغة الجديدة: RR<دورية اختيارية><رقم>-<D|N>-<بداية 00-23>
        // حرف D/N وردية صريحة (explicitShift) — المصدر الوحيد لحقيقة الوردية.
        m = c.match(/^RR([A-Z]?)(\d+)-([DN])-(\d{2})$/);
        if (m) {
            var nStartH = parseInt(m[4], 10);
            if (nStartH > 23) return null;
            return {
                kind: 'rapid',
                series: m[1] || '',
                rapidNo: parseInt(m[2], 10),
                shift: m[3],
                explicitShift: true,
                durationH: 12,
                start: pad2(nStartH) + ':00',
                end: pad2((nStartH + 12) % 24) + ':00'
            };
        }
        // تدخل سريع — الصيغة القديمة (بلا حرف وردية): تبقى للبيانات التاريخية
        // legacy:true · shift:null — الوردية تُشتق من الساعة في القاموس كما كانت.
        m = c.match(/^RR([A-Z]?)(\d+)-(\d{2})$/);
        if (m) {
            var rStartH = parseInt(m[3], 10);
            if (rStartH > 23) return null;
            return {
                kind: 'rapid',
                series: m[1] || '',
                rapidNo: parseInt(m[2], 10),
                shift: null,
                legacy: true,
                durationH: 12,
                start: pad2(rStartH) + ':00',
                end: pad2((rStartH + 12) % 24) + ':00'
            };
        }
        return null;
    }

    /** هل الكود تشغيلي ملحق (أوفرلاب/تدخل سريع بلاحقة بداية)؟ */
    function isOperationalCode(code) {
        return parseOperationalCode(code) !== null;
    }

    /**
     * حل بداية الدوام لكود ← 'HH:MM' — الأسبقية:
     *   1) لاحقة الكود نفسها (O12-12 ⇒ 12:00) — تعريف الكود ذاته.
     *   2) shiftCodesRow.time_start إن وُجد صف تعريف بوقت.
     *   3) حد النظام القديم: صباحية ⇒ 05:00 · ليلية ⇒ 17:00 (افتراضي صباحية).
     */
    function resolveOperationalStart(code, shiftCodesRow, shiftType) {
        var parsed = parseOperationalCode(code);
        if (parsed) return parsed.start;
        if (shiftCodesRow && shiftCodesRow.time_start) return String(shiftCodesRow.time_start);
        var st = String(shiftType || '');
        return st.indexOf('ليل') !== -1 ? '17:00' : '05:00';
    }

    return {
        parseOperationalCode: parseOperationalCode,
        isOperationalCode: isOperationalCode,
        resolveOperationalStart: resolveOperationalStart,
        registerCustom: registerCustom
    };
}));
