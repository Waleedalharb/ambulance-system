/* ============================================
 * P1-S7 — فرز أعمدة موحّد للجداول التشغيلية
 * --------------------------------------------
 * - إعادة ترتيب «عرضية فقط» للصفوف المحمّلة أصلاً — بلا جلب جديد وبلا تغيير بيانات.
 * - الترتيب الافتراضي لا يتغيّر إطلاقاً حتى نقرة صريحة على ترويسة قابلة للفرز (عقد الواجهة).
 * - دورة النقرة: تصاعدي ⇒ تنازلي ⇒ استعادة الترتيب الافتراضي.
 * - الكشف الرقمي تلقائي لكل عمود (الأعمدة الرقمية تُفرز عددياً لا أبجدياً).
 * - مقارنة عربية واعية بالمحلية (Intl.Collator) + دعم الأرقام العربية-الهندية والفارسية.
 * - يعمل باللمس (نقرة فقط — بلا hover-only). المؤشر ⇅/▲/▼ خفيف بما ينسجم مع لغة التصميم.
 * الاستخدام: TableSort.makeSortable('tableId' أو عنصر, { exclude: [فهارس أعمدة تُستبعد] })
 * ============================================ */
var TableSort = (function () {
    'use strict';

    var collator = new Intl.Collator('ar', { numeric: true, sensitivity: 'base' });

    var CSS =
        '.ts-sortable{cursor:pointer;user-select:none;-webkit-user-select:none}' +
        '.ts-sortable .ts-arrow{display:inline-block;margin-inline-start:5px;font-size:0.68em;opacity:0.35;transition:opacity .15s ease}' +
        '.ts-sortable:hover .ts-arrow{opacity:0.6}' +
        '.ts-sortable.ts-asc .ts-arrow,.ts-sortable.ts-desc .ts-arrow{opacity:1}' +
        '.ts-sortable .ts-arrow::before{content:"\\21C5"}' +          /* ⇅ افتراضي */
        '.ts-sortable.ts-asc .ts-arrow::before{content:"\\25B2"}' +    /* ▲ */
        '.ts-sortable.ts-desc .ts-arrow::before{content:"\\25BC"}';    /* ▼ */

    function injectStyle() {
        if (document.getElementById('ts-sort-style')) return;
        var st = document.createElement('style');
        st.id = 'ts-sort-style';
        st.textContent = CSS;
        document.head.appendChild(st);
    }

    /* أرقام عربية-هندية/فارسية ⇒ لاتينية، وإزالة فواصل الآلاف والمسافات */
    function normalizeNumeric(s) {
        return s
            .replace(/[٠-٩]/g, function (d) { return '٠١٢٣٤٥٦٧٨٩'.indexOf(d); })
            .replace(/[۰-۹]/g, function (d) { return '۰۱۲۳۴۵۶۷۸۹'.indexOf(d); })
            .replace(/[٬,\s]/g, '');
    }

    function asNumber(s) {
        var n = normalizeNumeric(s);
        if (n === '' || n === '-' || isNaN(Number(n))) return null;
        return Number(n);
    }

    function cellVal(row, idx) {
        var c = row.cells[idx];
        return c ? c.textContent.trim() : '';
    }

    /* صفوف البيانات فقط — تجاهل صفوف colspan (تحميل/فارغ) */
    function dataRows(tbody) {
        var out = [];
        for (var i = 0; i < tbody.rows.length; i++) {
            if (tbody.rows[i].cells.length > 1) out.push(tbody.rows[i]);
        }
        return out;
    }

    /* العمود رقمي إذا كانت كل قيمه غير الفارغة أرقاماً */
    function detectNumeric(rows, idx) {
        var seen = false;
        for (var i = 0; i < rows.length; i++) {
            if (idx >= rows[i].cells.length) continue;
            var v = cellVal(rows[i], idx);
            if (v === '' || v === '-') continue;
            if (asNumber(v) === null) return false;
            seen = true;
        }
        return seen;
    }

    /* إعادة ترقيم عمود «#» عندما يكون ترقيماً تسلسلياً بحتاً (عرضي بحت — ليس بيانات) */
    function renumber(rows) {
        if (rows.length < 2) return;
        for (var i = 0; i < rows.length; i++) {
            var v = cellVal(rows[i], 0);
            if (asNumber(v) === null) return; /* العمود الأول ليس ترقيماً — لا شيء */
        }
        for (var j = 0; j < rows.length; j++) {
            rows[j].cells[0].textContent = (j + 1);
        }
    }

    function cycle(table, tbody, th, colIdx) {
        var rows = dataRows(tbody);
        if (rows.length < 2) return;

        var state = table._tsState;
        if (!state || state.col !== colIdx) state = { col: colIdx, dir: 0 };
        state.dir = (state.dir + 1) % 3; /* 1=تصاعدي 2=تنازلي 0=افتراضي */
        table._tsState = state;

        /* تحديث المؤشرات على كل الترويسات */
        var ths = table.tHead.rows[0].cells;
        for (var i = 0; i < ths.length; i++) {
            ths[i].classList.remove('ts-asc', 'ts-desc');
            ths[i].removeAttribute('aria-sort');
        }

        if (state.dir === 0) {
            /* استعادة الافتراضي — فقط إذا كانت الصفوف الملتقطة ما زالت في DOM */
            var def = table._tsDefault || [];
            var valid = def.length === rows.length && def.every(function (r) { return r.isConnected; });
            if (valid) {
                for (var d = 0; d < def.length; d++) tbody.appendChild(def[d]);
            }
            /* إن أُعيد بناء الجدول (render جديد) فالترتيب الافتراضي عائد أصلاً */
            table._tsDefault = null;
            renumber(dataRows(tbody));
            return;
        }

        /* التقاط الافتراضي عند أول فرز فقط — صفوف متصلة فقط */
        if (!table._tsDefault || !table._tsDefault.every(function (r) { return r.isConnected; })) {
            table._tsDefault = rows.slice();
        }

        var numeric = detectNumeric(rows, colIdx);
        var mul = state.dir === 1 ? 1 : -1;
        /* sort مستقر في كل المتصفحات الحديثة — ترتيب المتساويات محفوظ */
        var sorted = rows.slice().sort(function (a, b) {
            var va = cellVal(a, colIdx), vb = cellVal(b, colIdx);
            if (numeric) {
                var na = asNumber(va), nb = asNumber(vb);
                if (na === null && nb === null) return 0;
                if (na === null) return 1;  /* الفارغ/الشرطة آخراً دائماً */
                if (nb === null) return -1;
                return (na - nb) * mul;
            }
            return collator.compare(va, vb) * mul;
        });
        for (var s = 0; s < sorted.length; s++) tbody.appendChild(sorted[s]);

        th.classList.add(state.dir === 1 ? 'ts-asc' : 'ts-desc');
        th.setAttribute('aria-sort', state.dir === 1 ? 'ascending' : 'descending');
        renumber(dataRows(tbody));
    }

    function makeSortable(table, opts) {
        if (typeof table === 'string') table = document.getElementById(table);
        if (!table || table.dataset.tsInit === '1') return;
        var thead = table.tHead;
        var tbody = table.tBodies[0];
        if (!thead || !thead.rows.length || !tbody) return;
        injectStyle();
        table.dataset.tsInit = '1';
        var exclude = (opts && opts.exclude) || [];

        var headers = thead.rows[0].cells;
        for (var i = 0; i < headers.length; i++) {
            if (exclude.indexOf(i) !== -1) continue;
            (function (th, colIdx) {
                th.classList.add('ts-sortable');
                var arrow = document.createElement('span');
                arrow.className = 'ts-arrow';
                arrow.setAttribute('aria-hidden', 'true');
                th.appendChild(arrow);
                th.addEventListener('click', function () { cycle(table, tbody, th, colIdx); });
            })(headers[i], i);
        }
    }

    return { makeSortable: makeSortable };
})();
