/* ============================================================
   📖 دليل استخدام الخريطة التشغيلية — داخل المنصة (اعتماد المالك 2026-08-25)
   دليل تشغيلي بلغة بسيطة للمستخدم الميداني/الإداري — ليس وثيقة فنية.
   يجاوب على: وش أشوف؟ وش معناه؟ من وين جاء الرقم؟ وكيف أفسره؟
   عرض فقط: لا يقرأ ولا يكتب أي بيانات تشغيلية — محتوى ثابت يشرح
   السلوك المعتمد (الحية/الذاكرة/الـOverlay) كما وثّقه MAP-OPERATIONS-CATALOG.
   ============================================================ */
(function () {
    'use strict';

    var built = false;

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // ---------- محتوى الدليل (بلغة تشغيلية بسيطة) ----------
    var SECTIONS = [
        {
            id: 'live', icon: '🟢', title: 'الخريطة الحية — وش يصير الحين؟',
            html:
                '<p>الخريطة الحية تجاوب على سؤال واحد فقط: <b>«وش يصير الحين؟»</b>. كل ما تشوفه فيها يخص اللحظة الحالية من المناوبة الشغالة.</p>'
                + '<h4>📍 البلاغ النشط</h4>'
                + '<p>بلاغ شغّال حاليًا وما انتهى. يظهر على الخريطة إذا كان له موقع مسجل في CAD، <b>ويختفي تلقائيًا فور ما ينتهي أو يُلغى في CAD</b> — ما تحتاج تحدّث الصفحة.</p>'
                + '<h4>وش معنى ألوان البلاغ؟</h4>'
                + '<ul>'
                + '<li>🟢 <b>أخضر:</b> وصلت له فرقة أو باشرته — تحت السيطرة.</li>'
                + '<li>🟡 <b>أصفر:</b> في الانتظار أو في الطريق، وما زال ضمن الوقت الطبيعي.</li>'
                + '<li>🔴 <b>أحمر:</b> تأخر عن المعتاد ويحتاج انتباهك الآن.</li>'
                + '</ul>'
                + '<h4>🚑 الفرقة</h4>'
                + '<p>موقعها التقريبي حول مركزها (ما عندنا GPS للفرق)، ولونها يوضح جاهزيتها: أخضر جاهزة · أصفر بانتظار قرار التكميل · أحمر ناقصة أو خارج الخدمة.</p>'
                + '<h4>🏥 المركز</h4>'
                + '<p>موقع ثابت، ولونه يعكس حالة فرقه: إذا فيه فرقة ناقصة يحمر.</p>'
                + '<h4>وش معنى ⚠️ فوق بعض البلاغات؟</h4>'
                + '<p>النظام يشتبه أن البلاغ مكرر (نفس الحالة سُجلت مرتين). <b>تنبيه للتحقق فقط</b> — القرار والإلغاء داخل CAD حصرًا، والمنصة ما تلغي ولا تدمج أي بلاغ.</p>'
                + '<h4>الفرق بين «فرقة مشاركة فعلًا» و«فرقة في خطة الاستجابة»</h4>'
                + '<p>اللي تشوفه في خطة الاستجابة في CAD مجرد <b>ترشيح</b> من النظام. الفرقة ما تعتبر مشاركة — ولا تنحسب في أي رقم — إلا إذا ثبت إنها <b>تحركت فعلًا</b> بوقت حقيقي من رحلتها هي.</p>'
        },
        {
            id: 'memory', icon: '🔵', title: 'ذاكرة الخريطة — وش صار تاريخيًا؟',
            html:
                '<p>زر <b>«ذاكرة الخريطة»</b> فوق الخريطة يفتح وضع التحليل التاريخي فوق نفس المساحة. تختار الفترة من خانتي التاريخ وتضغط <b>تحديث</b>.</p>'
                + '<h4>هل أرقامها بلاغات حقيقية؟</h4>'
                + '<p><b>نعم، كلها بلاغات فعلية مسجلة</b> — مو رسم تقريبي ولا تقدير. كل رقم فيها تقدر تضغطه وتشوف البلاغات اللي كوّنته بالضبط.</p>'
                + '<h4>هل البلاغات المنتهية تدخل في الذاكرة؟</h4>'
                + '<p>نعم، وهذا هو الصحيح: <b>البلاغ المنتهي حدث فعلًا</b>، والتحليل التاريخي يحتاجه. الحية للحاضر، والذاكرة للتاريخ — كل وحدة لها سؤال مختلف.</p>'
                + '<h4>وش التبويبات اللي فيها؟</h4>'
                + '<ul>'
                + '<li>🔥 <b>الكثافة:</b> وين تتركز البلاغات — وكل نقطة تضغطها تشوف بلاغها.</li>'
                + '<li>🎯 <b>المناطق الساخنة:</b> مناطق الطلب المرتفع مع بلاغاتها الفعلية.</li>'
                + '<li>📈 <b>الأنماط الزمنية:</b> أي ساعة وأي يوم يكثر الطلب، ومقارنة بالفترة اللي قبلها.</li>'
                + '<li>🚑 <b>التمركزات التاريخية:</b> وين كانت الفرق متمركزة فعلًا.</li>'
                + '<li>⚠️ <b>فجوات التغطية:</b> مناطق طلب مرتفع وتغطيتها ضعيفة — مع سبب التصنيف.</li>'
                + '<li>💡 <b>دعم القرار:</b> اقتراحات تمركز مبنية على البيانات — <b>اقتراح فقط، ما ينفذ شيء تلقائيًا</b>.</li>'
                + '</ul>'
        },
        {
            id: 'density', icon: '🔥', title: 'قراءة الكثافة — الرقم هذا من وين جاء؟',
            html:
                '<p>إذا ظهرت منطقة مكتوب فيها <b>«8 بلاغات»</b>، فهذا <b>ما يعني وجود 8 بلاغات حالية</b>. الرقم يمثل البلاغات الفعلية اللي وقعت في هذي المنطقة خلال <b>الفترة اللي اخترتها أنت</b> من التاريخين.</p>'
                + '<h4>كيف تتأكد أن الرقم حقيقي؟</h4>'
                + '<ul>'
                + '<li>🟡 <b>اضغط أي نقطة صفراء</b> في تبويب الكثافة ← تنفتح لك بطاقة البلاغ نفسه: رقمه ووقته ونوعه وموقعه.</li>'
                + '<li>🎯 <b>اضغط أي منطقة ساخنة</b> ← تشوف قائمة البلاغات اللي كوّنت الرقم كاملة، وأي بلاغ فيها تضغطه تشوف تفاصيله.</li>'
                + '</ul>'
                + '<p><b>«8 بلاغات» يعني هذي الثمانية بالتحديد</b> — تقدر تعدها بنفسك واحدًا واحدًا. لا نقطة بلا بلاغ، ولا رقم بلا مصدر.</p>'
                + '<h4>ليش بلاغ ما يظهر كنقطة؟</h4>'
                + '<p>لأنه بلا موقع مسجل في CAD. المنصة <b>ما تخمّن المواقع أبدًا</b> — يُحسب في العدد الإجمالي بصدق، لكن ما يرسم له نقطة مختلقة.</p>'
        },
        {
            id: 'overlay', icon: '🟣', title: 'الـOverlay — عين المنصة على CAD',
            html:
                '<p>الـOverlay أداة التقاط فقط: <b>عين تقرأ اللي يعرضه CAD</b> وترسله للمنصة. ما يغيّر في CAD شيء، وما يقرر، ولا يحسب — كل الحسابات تتم في المنصة من البيانات الأصلية.</p>'
                + '<h4>متى تنحسب الفرقة مشاركة في البلاغ؟</h4>'
                + '<p>لما يثبت لها <b>حدث تشغيلي فعلي من رحلتها هي</b> (تحرك/وصول/مباشرة بوقت حقيقي). قاعدة ثابتة: <b>لا رحلة = لا مشاركة</b>، وما يُنسخ وقت من فرقة لفرقة ثانية أبدًا.</p>'
                + '<h4>ليش كانت تظهر سابقًا فرق ما استجابت؟</h4>'
                + '<p>سابقًا كانت تُسجَّل الفرقة مجرد ظهور اسمها في قائمة CAD. اتضح إن بعض الظهور مجرد <b>اقتراحات خطة استجابة</b> — والإصلاح المعتمد الآن: الظهور في الخطة لا يكفي، والمشاركة تحتاج دليلًا فعليًا.</p>'
                + '<h4>متى تدخل الفرقة في المنجزات؟</h4>'
                + '<p>إذا كانت مشاركتها محتسبة: تحركت فعلًا وما أُلغيت قبل التحرك. الفرقة اللي أُلغيت قبل ما تتحرك تبقى محفوظة في السجل لكن <b>ما تنحسب في أي عداد</b>.</p>'
        },
        {
            id: 'faq', icon: '❓', title: 'أسئلة شائعة',
            html:
                '<div class="mguide-q">ليش أشوف أحيانًا بلاغًا انتهى؟</div>'
                + '<p>لأن الخريطة الحية والذاكرة وظيفتهما مختلفة: الحية تعرض «الحين» فقط ويختفي منها المنتهي فورًا، والذاكرة تحتفظ به لأنه حدث فعلًا ويُحسب في التحليل التاريخي.</p>'
                + '<div class="mguide-q">ليش فيه رقم كثافة؟ هل هو حقيقي؟</div>'
                + '<p>نعم — الرقم ناتج عن مجموعة بلاغات فعلية في الفترة المختارة. اضغط النقطة أو المنطقة وشاهد البلاغات اللي كوّنته بنفسك.</p>'
                + '<div class="mguide-q">ليش فرقة ما تظهر ضمن مشاركة البلاغ؟</div>'
                + '<p>لأنها كانت ضمن خطة الاستجابة ولم يثبت لها حدث تشغيلي فعلي. الترشيح في CAD ليس مشاركة.</p>'
                + '<div class="mguide-q">هل الخريطة تعرض الوضع الحالي فقط؟</div>'
                + '<p>الخريطة الحية نعم. أما ذاكرة الخريطة فهي للتحليل التاريخي حسب الفترة اللي تختارها.</p>'
                + '<div class="mguide-q">ليش بلاغ معروف عندي ما له علامة على الخريطة؟</div>'
                + '<p>لأن CAD ما سجل له موقعًا. يظهر في لوحة «بلاغات بلا موقع دقيق» بجانب الخريطة الحية بصدق — بدل ما نخترع له موقعًا غلط.</p>'
                + '<div class="mguide-q">وش معنى «احتمال تكرار — يحتاج تحقق»؟</div>'
                + '<p>النظام وجد بلاغًا آخر مشابهًا جدًا (وقت/موقع/وصف). هذا تنبيه للمراجعة في CAD فقط — المنصة لا تلغي ولا تدمج أي بلاغ.</p>'
        }
    ];

    // ---------- البناء (مرة واحدة) ----------
    function build() {
        if (built) return;
        built = true;
        var backdrop = document.createElement('div');
        backdrop.id = 'mapGuideBackdrop';
        backdrop.className = 'mguide-backdrop';
        backdrop.style.display = 'none';
        var nav = SECTIONS.map(function (s) {
            return '<button type="button" class="mguide-navbtn" data-sec="' + s.id + '">' + s.icon + ' ' + esc(s.title.split('—')[0].trim()) + '</button>';
        }).join('');
        var body = SECTIONS.map(function (s) {
            return '<section class="mguide-sec" id="mguide-sec-' + s.id + '"><h3>' + s.icon + ' ' + esc(s.title) + '</h3>' + s.html + '</section>';
        }).join('');
        backdrop.innerHTML =
            '<div class="mguide" role="dialog" aria-label="دليل استخدام الخريطة التشغيلية">'
            + '<div class="mguide-head"><span>📖 دليل استخدام الخريطة التشغيلية</span>'
            + '<button type="button" class="mguide-close" id="mapGuideClose" title="إغلاق الدليل"><i class="fas fa-xmark"></i></button></div>'
            + '<div class="mguide-nav">' + nav + '</div>'
            + '<div class="mguide-body" id="mapGuideBody">' + body + '</div>'
            + '<div class="mguide-foot">كل رقم في المنصة قابل للتتبع لمصدره — ولا قيمة غائبة تُخمَّن: تُعرض «غير متوفر».</div>'
            + '</div>';
        document.body.appendChild(backdrop);

        backdrop.addEventListener('click', function (e) { if (e.target === backdrop) close(); });
        document.getElementById('mapGuideClose').addEventListener('click', close);
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && backdrop.style.display !== 'none') close();
        });
        var btns = backdrop.querySelectorAll('.mguide-navbtn');
        for (var i = 0; i < btns.length; i++) {
            (function (b) {
                b.addEventListener('click', function () { openSection(b.getAttribute('data-sec')); });
            })(btns[i]);
        }
    }

    function openSection(secId) {
        build();
        var backdrop = document.getElementById('mapGuideBackdrop');
        backdrop.style.display = 'flex';
        document.body.style.overflow = 'hidden';
        var btns = backdrop.querySelectorAll('.mguide-navbtn');
        for (var i = 0; i < btns.length; i++) {
            btns[i].classList.toggle('active', btns[i].getAttribute('data-sec') === secId);
        }
        var sec = document.getElementById('mguide-sec-' + (secId || 'live'));
        var bodyEl = document.getElementById('mapGuideBody');
        if (bodyEl) bodyEl.scrollTop = 0;
        if (sec && sec.scrollIntoView) sec.scrollIntoView({ block: 'start' });
    }
    function open() { openSection('live'); }
    function close() {
        var backdrop = document.getElementById('mapGuideBackdrop');
        if (backdrop) backdrop.style.display = 'none';
        document.body.style.overflow = '';
    }

    function wire() {
        var btn = document.getElementById('mapGuideBtn');
        if (btn) btn.addEventListener('click', function () { open(); });
        // أزرار ⓘ السياقية — شرح فوري صغير بجانب العنصر نفسه (اعتماد المالك 2026-08-25):
        // لا تفتح الدليل ولا صفحة — Popover تشرح العنصر: ما هو؟ مصدره؟ كيف يُحسب؟ معناه لك؟
        document.addEventListener('click', function (e) {
            var t = e.target && e.target.closest ? e.target.closest('[data-info]') : null;
            if (t) { e.stopPropagation(); toggleInfo(t); return; }
            if (infoPop && !infoPop.contains(e.target)) closeInfo();
        });
        document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeInfo(); });
        window.addEventListener('resize', closeInfo);
        window.addEventListener('scroll', closeInfo, true);
    }

    // ═══ محتوى الشرح السياقي ⓘ (اعتماد المالك 2026-08-25) ═══
    // لكل مؤشر: ما هو؟ ← من أين تأتي بياناته؟ ← كيف يُحسب/يُقرأ؟ ← ماذا يعني لك؟
    // التعريفات من المنطق الموثق المعتمد (MAP-OPERATIONS-CATALOG) — لا تعريف مخترع.
    var INFO = {
        'kpi-status': {
            t: 'الضغط الحالي',
            h: '<p><b>ما هو؟</b> مستوى الضغط التشغيلي على القطاع في هذه اللحظة.</p>'
                + '<p><b>مصدره:</b> حالات البلاغات <b>النشطة فقط</b> في المناوبة الحالية — المنتهي لا يدخل فيه.</p>'
                + '<p><b>كيف يُقرأ؟</b> يأخذ أسوأ حالة بين البلاغات النشطة — بلاغ واحد متجاوز يكفي لرفعه.</p>'
                + '<p><b>ماذا يعني لك؟</b> 🟢 طبيعي: الوضع مستقر · 🟡 متوسط: يحتاج متابعة ولا يستدعي إجراءً فوريًا · 🔴 مرتفع: فيه بلاغ يحتاج تدخلًا الآن.</p>'
        },
        'kpi-count': {
            t: 'بلاغات المناوبة',
            h: '<p><b>ما هو؟</b> عدد البلاغات <b>النشطة الآن</b> في مناوبتك.</p>'
                + '<p><b>مصدره:</b> محرك البلاغات — يتحدّث تلقائيًا مع كل بلاغ جديد أو بلاغ ينتهي.</p>'
                + '<p><b>كيف يُقرأ؟</b> المنتهي والملغى <b>لا يُعدَّان هنا</b> — يبقيان محفوظين في التقارير والإحصائيات التاريخية.</p>'
        },
        'kpi-ready': {
            t: 'فرق جاهزة',
            h: '<p><b>ما هو؟</b> عدد الفرق الجاهزة من إجمالي الفرق الميدانية (جاهزة / الإجمالي).</p>'
                + '<p><b>مصدره:</b> بيانات تكميل المناوبة الحالية — حالة كل فرقة (اكتمال الكادر وحالة المركبة) كما سُجّلت في التكميل.</p>'
        },
        'kpi-arrival': {
            t: 'متوسط الوصول',
            h: '<p><b>ما هو؟</b> متوسط أسرع زمن وصول مسجّل للبلاغات.</p>'
                + '<p><b>كيف يُحسب؟</b> لكل بلاغ: من وقت إنشائه في CAD حتى وصول أول فرقة محتسبة (مرحلة الوصول)، ثم متوسط البلاغات. الفرق التي لم تتحرك <b>لا تدخل</b> في الحساب.</p>'
                + '<p><b>الرقم الصغير بجانبه</b> = عدد البلاغات الداخلة في المتوسط.</p>'
                + '<p><b>ملاحظة:</b> الرقم يعكس البلاغات التي يعتمد عليها المؤشر، وليس بالضرورة زمن البلاغ الأخير.</p>'
        },
        'kpi-alerts': {
            t: 'حالات حرجة',
            h: '<p><b>ما هو؟</b> عدد الحالات التي تجاوزت الآن الحد الزمني المعتمد لمرحلتها وتحتاج تدخلًا.</p>'
                + '<p><b>الحدود المعتمدة:</b> وصول 10 دقائق (<b>Echo — مهدد للحياة 🚨: 8 دقائق</b>) · مباشرة دقيقتان (من الوصول) · بقاء في الموقع 10 دقائق · بقاء في المنشأة 10 دقائق.</p>'
                + '<p><b>التصنيف:</b> يُستخرج تلقائيًا من كود CAD (الحرف A/B/C/D/E داخل proQACode) — A بارد · B متوسط · C عادي · D خطير · E مهدد للحياة.</p>'
                + '<p><b>مصدره:</b> أحداث CAD الفعلية فقط (البحث/العلاج/النقل/بدء التسليم/انتهاء التسليم) — <b>لا تنبيه لفرقة لم تتحرك</b>، والبلاغ المنتهي تنتهي تنبيهاته معه، وكل مرحلة يتوقف مؤقتها فور اكتمالها.</p>'
        },
        'hist-memory': {
            t: 'ذاكرة الخريطة',
            h: '<p><b>ما هي؟</b> وضع التحليل التاريخي فوق نفس الخريطة — إجابة سؤال «وش صار؟» لا «وش يصير الآن؟».</p>'
                + '<p><b>كيف تستخدمها؟</b> اختر الفترة من التاريخين واضغط «تحديث»، ثم تنقّل بين التبويبات.</p>'
                + '<p><b>أرقامها حقيقية؟</b> نعم — كل رقم مبني على بلاغات فعلية مسجلة، وتقدر تضغط أي نقطة أو منطقة وتشوف البلاغات التي كوّنته بالضبط.</p>'
        },
        'noloc-panel': {
            t: 'بلاغات بلا موقع دقيق',
            h: '<p><b>ما هي؟</b> بلاغات نشطة لم يُسجّل CAD موقعها الجغرافي.</p>'
                + '<p><b>ليش ما لها علامة على الخريطة؟</b> لأن المنصة <b>لا تخمّن المواقع أبدًا</b> — تُعرض هنا بصدق بدل رسم علامة في مكان غلط.</p>'
                + '<p><b>متى تختفي من هنا؟</b> فور اكتمال موقعها في CAD (تظهر على الخريطة) أو انتهاء البلاغ.</p>'
        }
    };

    // ---------- Popover الشرح السياقي ----------
    var infoPop = null, infoFor = null;
    function buildInfoPop() {
        if (infoPop) return;
        infoPop = document.createElement('div');
        infoPop.className = 'minfo-pop';
        infoPop.style.display = 'none';
        document.body.appendChild(infoPop);
    }
    function toggleInfo(btn) {
        buildInfoPop();
        var key = btn.getAttribute('data-info');
        if (infoFor === btn && infoPop.style.display !== 'none') { closeInfo(); return; }
        var def = INFO[key];
        if (!def) return;
        infoFor = btn;
        infoPop.innerHTML = '<div class="minfo-head"><span>' + esc(def.t) + '</span>'
            + '<button type="button" class="minfo-close" title="إغلاق"><i class="fas fa-xmark"></i></button></div>'
            + '<div class="minfo-body">' + def.h + '</div>';
        infoPop.querySelector('.minfo-close').addEventListener('click', closeInfo);
        infoPop.style.display = 'block';
        // تموضع بجانب العنصر: تحته افتراضيًا، فوقه إن لم تكفِ المساحة — ومثبّت داخل الشاشة
        var r = btn.getBoundingClientRect();
        infoPop.style.visibility = 'hidden';
        var pw = infoPop.offsetWidth, ph = infoPop.offsetHeight;
        var top = r.bottom + 8;
        if (top + ph > window.innerHeight - 10) top = Math.max(10, r.top - ph - 8); // اقلب فوق العنصر
        // اعتماد المالك 2026-08-31: على سطح المكتب تخصم مساحة القائمة الجانبية
        // المفتوحة من الحد الأيمن — البطاقة تعيد التموضع داخل المساحة المتاحة
        // بدل أن تدخل تحت القائمة (القائمة يمين الشاشة في RTL)
        var sbw = 0;
        try {
            var sb = document.getElementById('smartSidebar');
            if (sb && sb.classList.contains('open') && window.innerWidth >= 769) sbw = sb.offsetWidth || 280;
        } catch (e) { }
        var left = Math.min(Math.max(10, r.left + r.width / 2 - pw / 2), window.innerWidth - sbw - pw - 10);
        infoPop.style.top = top + 'px';
        infoPop.style.left = left + 'px';
        infoPop.style.visibility = 'visible';
    }
    function closeInfo() {
        if (infoPop) infoPop.style.display = 'none';
        infoFor = null;
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();

    window.MapGuide = { open: open, openSection: openSection, close: close };
})();
