/**
 * ═══ baloot-app.js — واجهة البلوت D3 (اعتماد المالك الكتابي 2026-09-25) ═══
 * UMD: يعمل في المتصفح (boot تلقائي) وفي Node (اختبارات نقية بلا DOM).
 * مبدأ التصميم: الواجهة لا تعرف قواعد البلوت — الخادم يرسل «خياراتي الآن»
 * (/api/baloot/matches/:id/options) والواجهة تعرضها فقط. لا معلومة مخفية
 * تصل العميل أصلًا (A7)، وكل فعل لعب يُرسل للخادم ليحكم عليه.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.BalootApp = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    /* ═══ 1) ثوابت عرض (عرض فقط — ليست قواعد) ═══ */
    var SUIT_SYM = { S: '♠', H: '♥', D: '♦', C: '♣' };
    var SUIT_NAME = { S: 'سبيت', H: 'هاص', D: 'ديمن', C: 'شيريا' };
    var SUIT_RED = { H: true, D: true };
    var RANK_FACE = { '7': '7', '8': '8', '9': '9', T: '10', J: 'J', Q: 'Q', K: 'K', A: 'A' };
    var RANK_AR = { '7': '7', '8': '8', '9': '9', T: '10', J: 'ولد', Q: 'بنت', K: 'شايب', A: 'إكّه' };
    var PROJECT_AR = { sara: 'سيرا', khamsin: 'خمسين', miya: 'مية', arba: 'أربعمية' };
    var DOUBLE_AR = { dabal: 'دبل ×2', thri: 'ثري ×3', fur: 'فور ×4', qahwa: 'قهوة ☕' };
    var BID_HINT = {
        sun: 'صن — بلا زات حكم؛ الورق بقوته العادية',
        hokum: 'حكم — زات الحكم أقوى من الكل',
        pass: 'بس — مرور بدون شراء',
        ashkal: 'أشكل — الورقة المكشوفة لشريكك، صن إجباري'
    };

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    /* توزيع المقاعد حول الطاولة من منظوري: شريكي مقابلني،
       التالي في الدور (seat+1) على يساري، والآخر على يميني. */
    function seatLayout(mySeat) {
        if (mySeat == null) return { bottom: 0, left: 1, top: 2, right: 3 };
        return {
            bottom: mySeat,
            left: (mySeat + 1) % 4,
            top: (mySeat + 2) % 4,
            right: (mySeat + 3) % 4
        };
    }
    function teamOf(seat) { return seat % 2 === 0 ? 'A' : 'B'; }
    function seatName(state, seat) {
        var s = (state.seats || []).find(function (x) { return x.seat === seat; });
        return s && s.name ? s.name : 'مقعد ' + (seat + 1);
    }

    /* ═══ 2) الورق ═══ */
    function cardHtml(card, opts) {
        opts = opts || {};
        var code = card.code || card;
        var suit = code[0], rank = code[1];
        var red = SUIT_RED[suit];
        var cls = 'bcard' + (opts.small ? ' sm' : '') + (red ? ' red' : ' dark') +
            (opts.playable ? ' playable' : ' dimmed') + (opts.baloot ? ' baloot' : '');
        var attrs = opts.playable && opts.action ? ' data-card="' + esc(code) + '"' : ' disabled aria-disabled="true"';
        return '<button class="' + cls + '"' + attrs + ' title="' + esc(RANK_AR[rank] + ' ' + SUIT_NAME[suit]) + '">' +
            '<span class="rank">' + esc(RANK_FACE[rank]) + '</span>' +
            '<span class="suit">' + SUIT_SYM[suit] + '</span>' +
            '<span class="ar">' + esc(RANK_AR[rank]) + '</span>' +
            (opts.baloot ? '<span class="blt">بلوت</span>' : '') +
            '</button>';
    }
    function cardBackHtml() {
        return '<div class="bcard back" aria-hidden="true"><span class="suit">🃏</span></div>';
    }

    /* يدي: المسموح بارز وقابل للضغط، غيره باهت ومعطّل — القائمة من الخادم */
    function handHtml(state, options) {
        var hand = state.hand;
        if (!hand || !hand.myHand) return '';
        var legal = (options && options.cards) || [];
        var baloot = (options && options.balootCards) || [];
        var enabled = !!(options && options.myTurn && !options.paused);
        var cards = hand.myHand.map(function (c) {
            var ok = enabled && legal.indexOf(c.code) !== -1;
            return cardHtml(c, { playable: ok, action: ok, baloot: baloot.indexOf(c.code) !== -1 });
        }).join('');
        var hint = !options ? '' :
            options.paused ? 'المباراة متوقفة مؤقتًا' :
            options.myTurn ? (legal.length < hand.myHand.length ? 'ورقك البارز فقط هو المسموح الآن (رد الزات إلزامي)' : 'دورك — اختر ورقة') :
            'انتظر دورك';
        return '<div class="my-hand" data-test="my-hand">' + cards + '</div>' +
            '<div class="hand-hint" data-test="hand-hint">' + esc(hint) + '</div>';
    }

    /* ═══ 3) المقاعد والطاولة ═══ */
    function seatStatusLabel(seatInfo, state, tableInfo) {
        if (!seatInfo || !seatInfo.name) return null;
        if (seatInfo.disconnected) return { txt: 'منقطع', cls: 'off' };
        if (tableInfo && tableInfo.status === 'ready_check') {
            return seatInfo.ready ? { txt: 'جاهز ✓', cls: 'ready' } : { txt: 'ينتظر…', cls: 'wait' };
        }
        return { txt: 'متصل', cls: 'on' };
    }
    function seatHtml(pos, seat, state, tableInfo, turnSeat) {
        var info = null;
        if (tableInfo) info = (tableInfo.seats || []).find(function (x) { return x.seat === seat; });
        var name = null, disconnected = false, ready = false;
        if (state && state.seats) {
            var ss = state.seats.find(function (x) { return x.seat === seat; });
            if (ss) name = ss.name;
        }
        if (!name && info && info.name) name = info.name;
        if (info) { disconnected = !!info.disconnected; ready = !!info.ready; }
        var st = seatStatusLabel({ name: name, disconnected: disconnected, ready: ready }, state, tableInfo);
        var isTurn = turnSeat === seat;
        var teamTag = teamOf(seat) === 'A' ? 'فريق ١' : 'فريق ٢';
        var inner;
        if (name) {
            inner = '<div class="seat-name">' + esc(name) + '</div>' +
                '<div class="seat-sub">' + teamTag + (st ? ' · <span class="st ' + st.cls + '">' + st.txt + '</span>' : '') + '</div>';
        } else {
            inner = '<div class="seat-name empty-seat">مقعد فارغ</div><div class="seat-sub">' + teamTag + '</div>';
        }
        return '<div class="seat seat-' + pos + (isTurn ? ' turn' : '') + (name ? '' : ' vacant') + '" data-seat="' + seat + '" data-test="seat-' + pos + '">' +
            (isTurn ? '<span class="turn-ring" title="الدور عليه"></span>' : '') + inner + '</div>';
    }

    /* الورق على الأرض: كل ورقة باتجاه صاحبها */
    function trickHtml(state, mySeat) {
        var hand = state.hand;
        if (!hand) return '<div class="trick" data-test="trick"></div>';
        var layout = seatLayout(mySeat);
        var posOf = {};
        for (var pos in layout) posOf[layout[pos]] = pos;
        var cards = (hand.currentTrick || []).map(function (p) {
            return '<div class="trick-card t-' + posOf[p.seat] + '">' + cardHtml(p.card, { small: true }) + '</div>';
        }).join('');
        var center = '';
        if (hand.contract) {
            center = '<div class="contract-badge" data-test="contract">' + contractLabel(hand.contract) +
                (hand.double && hand.double.multiplier > 1 ? ' <b>×' + hand.double.multiplier + '</b>' : '') +
                (hand.double && hand.double.qahwa ? ' <b>☕ قهوة</b>' : '') + '</div>';
        }
        return '<div class="trick" data-test="trick">' + cards + center + '</div>';
    }
    function contractLabel(contract) {
        if (!contract) return '';
        if (contract.type === 'sun') return 'صن';
        return 'حكم ' + (SUIT_SYM[contract.trumpSuit] || '') + ' ' + (SUIT_NAME[contract.trumpSuit] || '');
    }

    /* النقاط الحية: فريقنا/فريقهم من منظوري */
    function scoresHtml(state, mySeat) {
        var myTeam = mySeat != null ? teamOf(mySeat) : null;
        var a = state.scores ? state.scores.A : 0, b = state.scores ? state.scores.B : 0;
        var left = myTeam === 'B' ? { label: 'فريقهم', val: a } : { label: myTeam ? 'فريقنا' : 'فريق ١', val: a };
        var right = myTeam === 'B' ? { label: 'فريقنا', val: b } : { label: myTeam ? 'فريقهم' : 'فريق ٢', val: b };
        if (!myTeam) { left = { label: 'فريق ١', val: a }; right = { label: 'فريق ٢', val: b }; }
        return '<div class="scores" data-test="scores">' +
            '<span class="score-pill">' + left.label + ' <b>' + left.val + '</b></span>' +
            '<span class="score-target">الهدف ' + (state.targetScore || 152) + '</span>' +
            '<span class="score-pill">' + right.label + ' <b>' + right.val + '</b></span></div>';
    }

    /* ═══ 4) السوق والأفعال ═══ */
    function biddingBar(options, state) {
        var hand = state.hand;
        if (!hand || (hand.phase !== 'bidding1' && hand.phase !== 'bidding2')) return '';
        var turnName = seatName(state, hand.biddingTurn);
        if (!options || !options.myTurn) {
            return '<div class="bid-bar" data-test="bid-bar"><div class="bid-wait">السوق جارٍ — دور «' + esc(turnName) + '»</div>' +
                (hand.faceUpCard ? '<div class="faceup">الورقة المكشوفة: ' + cardHtml(hand.faceUpCard, { small: true }) + '</div>' : '') + '</div>';
        }
        var btns = (options.bids || []).map(function (b) {
            if (b.kind === 'hokum') {
                var suitPart = hand.phase === 'bidding1'
                    ? SUIT_SYM[hand.faceUpCard.code[0]] + ' ' + SUIT_NAME[hand.faceUpCard.code[0]]
                    : SUIT_SYM[b.trumpSuit] + ' ' + SUIT_NAME[b.trumpSuit];
                return '<button class="btn bid" data-bid="hokum" data-suit="' + b.trumpSuit + '">حكم ' + suitPart +
                    '<small>' + esc(BID_HINT.hokum) + '</small></button>';
            }
            var label = b.kind === 'sun' ? 'صن' : b.kind === 'pass' ? 'بس' : 'أشكل';
            return '<button class="btn bid" data-bid="' + b.kind + '">' + label +
                '<small>' + esc(BID_HINT[b.kind] || '') + '</small></button>';
        }).join('');
        return '<div class="bid-bar" data-test="bid-bar">' +
            '<div class="bid-title">دورك في السوق — اختر:</div>' +
            (hand.faceUpCard ? '<div class="faceup">المكشوفة: ' + cardHtml(hand.faceUpCard, { small: true }) + '</div>' : '') +
            '<div class="bid-btns">' + btns + '</div></div>';
    }

    function actionsBar(options, state) {
        if (!options || state.status !== 'in_hand') return '';
        var parts = [];
        if ((options.projects || []).length) {
            parts.push('<div class="proj-row" data-test="projects">عندك مشروع — أعلنه قبل أول ورقة: ' +
                options.projects.map(function (p) {
                    return '<button class="btn proj" data-project=\'' + JSON.stringify(p) + '\'>' +
                        esc(PROJECT_AR[p.type] || p.type) + '</button>';
                }).join('') + '</div>');
        }
        if ((options.doubles || []).length) {
            parts.push('<div class="dbl-row" data-test="doubles">' +
                options.doubles.map(function (k) {
                    return '<button class="btn dbl" data-double="' + k + '">' + esc(DOUBLE_AR[k] || k) + '</button>';
                }).join('') + '</div>');
        }
        return parts.length ? '<div class="actions-bar">' + parts.join('') + '</div>' : '';
    }

    /* سطر توجيهي بلغة بسيطة — المستخدم لا يحتاج يعرف المصطلحات */
    function phaseHint(state, options, spectator) {
        var hand = state.hand;
        if (state.status === 'finished') return 'انتهت المباراة';
        if (!hand) return 'تجهيز صفقة جديدة…';
        if (options && options.paused) return 'مؤقتًا متوقفة — بانتظار عودة لاعب';
        if (hand.phase === 'bidding1' || hand.phase === 'bidding2') {
            if (spectator) return 'السوق جارٍ — «' + seatName(state, hand.biddingTurn) + '» يختار';
            return options && options.myTurn ? 'دورك في السوق — الخيارات تحت' : 'السوق: دور «' + seatName(state, hand.biddingTurn) + '»';
        }
        if (hand.phase === 'playing') {
            if (spectator) return 'اللعب — دور «' + seatName(state, hand.turnSeat) + '»';
            return options && options.myTurn ? 'دورك — العب ورقة من البارزة' : 'دور «' + seatName(state, hand.turnSeat) + '»';
        }
        return '';
    }

    /* ═══ 5) الأحداث ← رسائل عربية واضحة ═══ */
    function eventMessage(ev, state) {
        var n = function (seat) { return seatName(state, seat); };
        switch (ev.type) {
            case 'bid': return ev.kind === 'pass' ? n(ev.seat) + ': بس' : null;
            case 'bidding_round2': return 'بسّ الجميع — جولة ثانية';
            case 'redeal': return 'بسّ الجميع مرتين — إعادة توزيع';
            case 'contract_set':
                return n(ev.contract.buyerSeat) + ' اشترى ' + contractLabel(ev.contract) + (ev.contract.viaAshkal ? ' (أشكل)' : '');
            case 'declaration_announced': return n(ev.seat) + ' أعلن ' + (PROJECT_AR[ev.project] || ev.project);
            case 'declarations_revealed': return 'المشاريع كُشفت' + (ev.winnerTeam ? ' — لصالح فريق ' + (ev.winnerTeam === 'A' ? '١' : '٢') : '');
            case 'baloot_announced': return n(ev.seat) + ': بلوت! 🌟';
            case 'baloot_confirmed': return 'بلوت ' + n(ev.seat) + ' مُثبَت ✓';
            case 'doubled': return (DOUBLE_AR[ev.kind] || ev.kind) + ' — على فريق ' + (ev.team === 'A' ? '١' : '٢');
            case 'auto_play': return 'لعب آلي عن ' + n(ev.seat) + ' (انتهت مهلة اللفة)';
            case 'trick_won': return 'لفة لـ' + n(ev.winnerSeat);
            case 'hand_scored': return 'انتهت الصفقة — تفصيل النقاط جاهز';
            case 'match_ended': return 'انتهت المباراة! 🏆';
            case 'player_disconnected': return n(ev.seat) + ' انقطع — بانتظار عودته';
            case 'player_reconnected': return n(ev.seat) + ' عاد ✓';
            case 'seat_out': return 'مقعد ' + n(ev.seat) + ' أصبح شاغرًا للاستبدال';
            case 'seat_replaced': return 'انضم لاعب بديل للمقعد';
            case 'match_aborted': return 'أُنهيت المباراة وديًا — بلا خاسر';
            default: return null;
        }
    }

    /* ═══ 6) نهاية الصفقة والمباراة ═══ */
    function handScoreHtml(detail, state) {
        if (!detail) return '';
        var rows = [];
        if (detail.outcome === 'kaboot') {
            rows.push('<div class="score-line big">كبّوت! فريق ' + (detail.kabootTeam === 'A' ? '١' : '٢') + ' أخذ كل اللفات</div>');
            rows.push('<div class="score-line">أساس الكبوت ×' + detail.multiplier + ': <b>' + detail.kabootBase + '</b></div>');
            if (detail.projects) rows.push('<div class="score-line">مشاريع: <b>' + detail.projects + '</b></div>');
            if (detail.baloot) rows.push('<div class="score-line">بلوت: <b>' + detail.baloot + '</b></div>');
        } else {
            rows.push('<div class="score-line">أبناط الورق — فريق ١: ' + detail.cardAbnat.A + ' · فريق ٢: ' + detail.cardAbnat.B + '</div>');
            if (detail.multiplier > 1) rows.push('<div class="score-line">معامل الدبل: ×' + detail.multiplier + '</div>');
            (detail.projects || []).forEach(function (p) {
                rows.push('<div class="score-line">مشروع ' + esc(PROJECT_AR[p.project] || p.project) + ' (' + seatName(state, p.seat) + '): <b>' + p.multiplied + '</b></div>');
            });
            if (detail.balootPts && (detail.balootPts.A || detail.balootPts.B)) {
                rows.push('<div class="score-line">بلوت — فريق ١: ' + detail.balootPts.A + ' · فريق ٢: ' + detail.balootPts.B + '</div>');
            }
            rows.push('<div class="score-line note">' + esc(detail.note || '') + '</div>');
        }
        rows.push('<div class="score-line big">هذه الصفقة: فريق ١ <b>+' + detail.delta.A + '</b> · فريق ٢ <b>+' + detail.delta.B + '</b></div>');
        return '<div class="hand-score" data-test="hand-score">' + rows.join('') + '</div>';
    }

    function matchEndHtml(state, rematch, meId, tableStatus) {
        if (state.status !== 'finished' && tableStatus !== 'post_match') return '';
        var winnerTxt = state.winner ? 'الفائز: فريق ' + (state.winner === 'A' ? '١' : '٢') + ' 🏆' : '';
        var a = state.scores ? state.scores.A : 0, b = state.scores ? state.scores.B : 0;
        var accepted = rematch && rematch.accepts ? rematch.accepts : [];
        var iAccepted = meId != null && accepted.map(String).indexOf(String(meId)) !== -1;
        var rematchBox = '';
        if (tableStatus === 'post_match') {
            rematchBox = '<div class="rematch-box" data-test="rematch">' +
                '<div class="rematch-title">مباراة ثانية؟ (' + accepted.length + '/4 وافقوا)</div>' +
                (iAccepted
                    ? '<div class="rematch-wait">وافقت — بانتظار الباقين… (رفض واحد يلغي الريماچ)</div>'
                    : '<div class="row"><button class="btn primary" data-rematch="accept">أوافق 🃏</button>' +
                      '<button class="btn danger" data-rematch="decline">لا، يكفي</button></div>') +
                '</div>';
        }
        return '<div class="match-end" data-test="match-end"><div class="end-title">انتهت المباراة</div>' +
            '<div class="end-score">فريق ١: <b>' + a + '</b> — فريق ٢: <b>' + b + '</b></div>' +
            '<div class="end-winner">' + esc(winnerTxt) + '</div>' + rematchBox + '</div>';
    }

    /* ═══ 7) اللوبي ═══ */
    var TABLE_STATUS_AR = {
        open: 'تنتظر لاعبين', ready_check: 'فحص الجاهزية', in_match: 'تلعب الآن',
        post_match: 'انتهت — ريماچ؟', closed: 'مغلقة'
    };
    function lobbyTableCard(t, meId, perms) {
        perms = perms || {};
        var seated = (t.seats || []).filter(function (s) { return s.occupied; });
        var seatChips = (t.seats || []).map(function (s) {
            return '<span class="seat-chip' + (s.occupied ? ' taken' : '') + '">' +
                (s.occupied ? esc(s.name || 'لاعب') : 'فارغ') + '</span>';
        }).join('');
        var btns = [];
        if (t.status === 'open' || t.status === 'ready_check') {
            if (perms.canJoin) btns.push('<button class="btn sm primary" data-act="sit" data-table="' + t.id + '">اجلس 🪑</button>');
        }
        if (t.status === 'in_match') {
            if (perms.canJoin) btns.push('<button class="btn sm primary" data-act="sit" data-table="' + t.id + '">اجلس/كمّل 🪑</button>');
            if (perms.councilJoined) btns.push('<button class="btn sm" data-act="watch" data-table="' + t.id + '">شاهد 👁</button>');
        }
        btns.push('<button class="btn sm ghost" data-act="open" data-table="' + t.id + '">تفاصيل</button>');
        return '<div class="card table-card" data-test="lobby-table" data-table="' + t.id + '">' +
            '<div class="row"><h3>🃏 طاولة #' + t.id + '</h3><div class="spacer"></div>' +
            '<span class="status-pill">' + esc(TABLE_STATUS_AR[t.status] || t.status) + '</span></div>' +
            '<div class="seats-row">' + seatChips + '</div>' +
            '<div class="meta"><span>' + seated.length + '/4 جالسين</span><span>الهدف ' + (t.targetScore || 152) + '</span></div>' +
            '<div class="row" style="margin-top:10px">' + btns.join('') + '</div></div>';
    }
    function renderLobby(tables, perms) {
        if (!tables.length) {
            return '<div class="empty" data-test="lobby-empty"><i class="fa-solid fa-chess"></i>لا توجد طاولات بعد — افتح أول طاولة وادعُ الشباب.</div>';
        }
        return tables.map(function (t) { return lobbyTableCard(t, null, perms); }).join('');
    }

    /* ═══ 8) شاشة الطاولة الكاملة ═══ */
    function renderTableView(m) {
        // m: { table, state, options, meId, spectator, paused, spectators, rematch }
        var layout = seatLayout(m.state && m.options ? m.options.mySeat : (m.mySeat != null ? m.mySeat : null));
        var turnSeat = m.state && m.state.hand ? (m.state.hand.turnSeat != null ? m.state.hand.turnSeat : m.state.hand.biddingTurn) : null;
        var seats = ['top', 'right', 'bottom', 'left'].map(function (pos) {
            return seatHtml(pos, layout[pos], m.state, m.table, turnSeat);
        }).join('');
        var trick = m.state ? trickHtml(m.state, m.options ? m.options.mySeat : m.mySeat) : '';
        var scores = m.state ? scoresHtml(m.state, m.options ? m.options.mySeat : m.mySeat) : '';
        var hint = m.state ? phaseHint(m.state, m.options, m.spectator) : '';
        var bid = m.state ? biddingBar(m.options, m.state) : '';
        var acts = m.state ? actionsBar(m.options, m.state) : '';
        var hand = (!m.spectator && m.state) ? handHtml(m.state, m.options) :
            '<div class="spectator-note" data-test="spectator-note">وضع المشاهدة — تشاهد المجريات فقط، بلا أيدٍ وبلا حركة.</div>';
        var end = m.state ? matchEndHtml(m.state, m.rematch, m.meId, m.table ? m.table.status : null) : '';
        var pausedBanner = m.paused ? '<div class="paused-banner" data-test="paused">⏸ المباراة متوقفة مؤقتًا — بانتظار لاعب</div>' : '';
        var specCount = '<span class="spec-count" data-test="spectators">👁 ' + (m.spectators || 0) + ' يشاهدون</span>';
        return '<div class="table-screen" data-test="table-screen">' +
            '<div class="table-head">' + scores + specCount + '</div>' +
            pausedBanner +
            '<div class="table-stage"><div class="felt">' + trick + '</div>' + seats + '</div>' +
            '<div class="hint-line" data-test="hint">' + esc(hint) + '</div>' +
            bid + acts + hand + end + '</div>';
    }

    /* ═══ 9) التصدير ═══ */
    var API = {
        esc: esc, seatLayout: seatLayout, teamOf: teamOf, seatName: seatName,
        cardHtml: cardHtml, cardBackHtml: cardBackHtml, handHtml: handHtml,
        seatHtml: seatHtml, trickHtml: trickHtml, contractLabel: contractLabel,
        scoresHtml: scoresHtml, biddingBar: biddingBar, actionsBar: actionsBar,
        phaseHint: phaseHint, eventMessage: eventMessage,
        handScoreHtml: handScoreHtml, matchEndHtml: matchEndHtml,
        lobbyTableCard: lobbyTableCard, renderLobby: renderLobby,
        renderTableView: renderTableView,
        SUIT_SYM: SUIT_SYM, SUIT_NAME: SUIT_NAME, PROJECT_AR: PROJECT_AR, DOUBLE_AR: DOUBLE_AR
    };

    /* ═══ 10) الإقلاع في المتصفح فقط ═══ */
    if (typeof document !== 'undefined' && typeof window !== 'undefined' && window.localStorage) {
        API.boot = bootBrowser;
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootBrowser);
        else bootBrowser();
    }

    function bootBrowser() {
        var TOKEN = localStorage.getItem('auth_access_token') || localStorage.getItem('authToken') || '';
        if (!TOKEN) {
            document.body.innerHTML = '<div class="empty" style="margin-top:20vh"><i class="fa-solid fa-lock"></i>سجّل الدخول من المنصة أولًا ثم افتح هذه الصفحة.</div>';
            return;
        }
        var S = {
            me: null, councilId: null, councilJoined: false, tables: [],
            table: null, matchId: null, state: null, options: null,
            paused: false, spectators: 0, rematch: null,
            mySeat: null, spectator: true, roomId: null,
            ws: null, wsAlive: false, topics: [], chatTimer: null, lastChatId: 0
        };
        window.__BALOOT_S = S; // خطاف اختبارات الواجهة

        function $(s) { return document.querySelector(s); }
        function toast(msg, ok) {
            var t = $('#toast');
            if (!t) return;
            t.textContent = msg; t.className = 'toast show ' + (ok === false ? 'err' : 'ok');
            setTimeout(function () { t.className = 'toast'; }, 3200);
        }
        async function api(method, path, body) {
            var r = await fetch(path, {
                method: method,
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
                body: body ? JSON.stringify(body) : undefined
            });
            var d = null; try { d = await r.json(); } catch (_) { }
            if (!r.ok) { var e = new Error((d && d.error) || ('خطأ ' + r.status)); e.code = d && d.code; e.status = r.status; throw e; }
            return d;
        }
        function uuid() {
            return 'xxxxxxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
                var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
            });
        }

        /* ── WebSocket: اتصال + إعادة اتصال + اشتراكات ── */
        function wsConnect() {
            try {
                var proto = location.protocol === 'https:' ? 'wss' : 'ws';
                S.ws = new WebSocket(proto + '://' + location.host + '/ws?token=' + encodeURIComponent(TOKEN));
            } catch (_) { scheduleReconnect(); return; }
            S.ws.onopen = function () {
                S.wsAlive = true;
                S.topics.forEach(function (t) { S.ws.send(JSON.stringify({ type: 'baloot_subscribe', topic: t })); });
            };
            S.ws.onmessage = function (ev) {
                var msg; try { msg = JSON.parse(ev.data); } catch (_) { return; }
                onWsMessage(msg);
            };
            S.ws.onclose = function () { S.wsAlive = false; scheduleReconnect(); };
            S.ws.onerror = function () { };
        }
        var reconnectTimer = null;
        function scheduleReconnect() {
            if (reconnectTimer) return;
            reconnectTimer = setTimeout(function () { reconnectTimer = null; wsConnect(); }, 2500);
        }
        function subscribe(topic) {
            if (S.topics.indexOf(topic) === -1) S.topics.push(topic);
            if (S.wsAlive) S.ws.send(JSON.stringify({ type: 'baloot_subscribe', topic: topic }));
        }
        function unsubscribe(topic) {
            S.topics = S.topics.filter(function (t) { return t !== topic; });
            if (S.wsAlive) S.ws.send(JSON.stringify({ type: 'baloot_unsubscribe', topic: topic }));
        }
        setInterval(function () { if (S.wsAlive) S.ws.send(JSON.stringify({ type: 'ping' })); }, 20000);

        function onWsMessage(msg) {
            if (msg.type === 'baloot_lobby' || msg.type === 'baloot_table') {
                if ($('#view-lobby').classList.contains('active')) loadLobby();
                if (S.table && msg.tableId === S.table.id) onTableEvent(msg.events || []);
            }
            if (msg.type === 'baloot_match' && S.matchId === msg.matchId) {
                S.state = msg.state; S.paused = !!msg.paused;
                if (typeof msg.spectators === 'number') S.spectators = msg.spectators;
                (msg.events || []).forEach(function (e) { onMatchEvent(e); });
                refreshOptions().then(renderTable).catch(function () { renderTable(); });
            }
            if (msg.type === 'baloot_error') toast(msg.error || 'تعذر الاشتراك', false);
        }
        function onTableEvent(events) {
            events.forEach(function (e) {
                if (e.type === 'match_started' && e.matchId && !S.matchId) {
                    S.matchId = e.matchId;
                    subscribe('baloot:match:' + e.matchId);
                    refreshMatchState();
                }
            });
            refreshTableInfo();
        }
        function onMatchEvent(e) {
            var txt = API.eventMessage(e, S.state);
            if (txt) toast(txt, true);
            if (e.type === 'hand_scored') showHandScore(e.detail);
            if (e.type === 'match_ended') { /* العرض عبر matchEndHtml بعد تحديث الطاولة */ refreshTableInfo(); }
        }

        /* ── تحميل البيانات ── */
        async function loadMe() {
            var d = await api('GET', '/api/auth/me');
            S.me = d.user;
            var chip = $('#meChip');
            if (chip) chip.innerHTML = '<span class="dot"></span> ' + API.esc(d.user.name || d.user.username);
        }
        async function loadLobby() {
            var d = await api('GET', '/api/baloot/tables');
            S.tables = d.tables || [];
            S.councilId = d.councilId;
            // عضوية المجلس: تُفحص من قائمة مجالسي
            try {
                var cs = await api('GET', '/api/community/councils');
                var bc = (cs.councils || []).find(function (c) { return c.slug === 'baloot'; });
                S.councilJoined = !!(bc && bc.joined);
            } catch (_) { }
            renderLobbyView();
            loadRatings();
        }
        async function loadRatings() {
            try {
                var d = await api('GET', '/api/baloot/ratings');
                var rows = d.ratings || [];
                if (!rows.length) return;
                $('#ratingsList').innerHTML = rows.map(function (r, i) {
                    return '<div class="rating-row"><span class="rating-rank">' + (i + 1) + '</span>' +
                        '<b>' + API.esc(r.name || r.userId) + '</b><div class="spacer"></div>' +
                        '<span class="meta" style="margin:0">' + r.wins + ' فوز · ' + r.matches + ' مباراة · ' + r.honorPoints + ' نقطة شرف</span></div>';
                }).join('');
            } catch (_) { }
        }
        async function refreshTableInfo() {
            if (!S.table) return;
            var d = await api('GET', '/api/baloot/tables/' + S.table.id);
            S.table = d.table; S.mySeat = d.mySeat; S.rematch = d.rematch;
            S.roomId = d.table.roomId || S.roomId;
            if (d.activeMatchId && d.activeMatchId !== S.matchId) {
                S.matchId = d.activeMatchId;
                subscribe('baloot:match:' + d.activeMatchId);
                await refreshMatchState();
            }
            if (!d.activeMatchId) { S.matchId = null; S.state = null; }
            renderTable();
        }
        async function refreshMatchState() {
            if (!S.matchId) return;
            try {
                var d = await api('GET', '/api/baloot/matches/' + S.matchId + '/state');
                S.state = d.state; S.paused = !!d.paused;
                await refreshOptions();
                renderTable();
            } catch (e) { toast(e.message, false); }
        }
        async function refreshOptions() {
            if (!S.matchId || S.mySeat == null) { S.options = null; return; }
            try { S.options = await api('GET', '/api/baloot/matches/' + S.matchId + '/options'); }
            catch (_) { S.options = null; }
        }

        /* ── العرض ── */
        function showView(name) {
            $('#view-lobby').classList.toggle('active', name === 'lobby');
            $('#view-table').classList.toggle('active', name === 'table');
        }
        function renderLobbyView() {
            showView('lobby');
            var perms = { canJoin: true, canCreate: true, councilJoined: S.councilJoined };
            $('#tablesGrid').innerHTML = API.renderLobby(S.tables, perms);
            $('#joinCouncilBar').style.display = S.councilJoined ? 'none' : 'flex';
        }
        function renderTable() {
            if (!S.table) return;
            showView('table');
            S.spectator = S.mySeat == null;
            $('#tableTitle').textContent = 'طاولة بلوت #' + S.table.id;
            $('#tableHost').innerHTML = API.renderTableView({
                table: S.table, state: S.state, options: S.options, meId: S.me ? S.me.id : null,
                mySeat: S.mySeat, spectator: S.spectator,
                paused: S.paused, spectators: S.spectators, rematch: S.rematch
            });
            // حالة الطاولة قبل المباراة: جاهزية/جلوس
            renderPreMatch();
        }
        function renderPreMatch() {
            var bar = $('#preMatchBar');
            if (!S.table || S.matchId) { bar.innerHTML = ''; return; }
            var t = S.table;
            var parts = [];
            if (t.status === 'ready_check' && S.mySeat != null) {
                parts.push('<button class="btn primary big" id="btnReady">أنا جاهز ✓</button><span class="hint">أكّد جاهزيتك لتبدأ المباراة</span>');
            }
            if (t.status === 'open') {
                if (S.mySeat == null) parts.push('<button class="btn primary big" id="btnSit">اجلس على الطاولة 🪑</button>');
                else parts.push('<span class="hint">بانتظار اكتمال الأربعة… انسخ رابط الدعوة وأرسله للشباب:</span><button class="btn" id="btnInvite">📋 نسخ رابط الدعوة</button>');
            }
            if (S.mySeat != null) parts.push('<button class="btn ghost" id="btnLeave">مغادرة الطاولة</button>');
            bar.innerHTML = parts.join(' ');
        }

        /* ── نهاية الصفقة (مودال تفصيل النقاط) ── */
        function showHandScore(detail) {
            var m = $('#scoreModal');
            $('#scoreModalBody').innerHTML = API.handScoreHtml(detail, S.state);
            m.classList.add('show');
        }

        /* ── الأفعال ── */
        async function openTable(id) {
            try {
                unsubscribe('baloot:lobby');
                S.table = null; S.matchId = null; S.state = null; S.options = null; S.mySeat = null;
                var d = await api('GET', '/api/baloot/tables/' + id);
                S.table = d.table; S.mySeat = d.mySeat; S.rematch = d.rematch; S.roomId = d.table.roomId;
                subscribe('baloot:table:' + id);
                if (d.activeMatchId) {
                    S.matchId = d.activeMatchId;
                    subscribe('baloot:match:' + d.activeMatchId);
                    await refreshMatchState();
                }
                renderTable();
                startChat();
            } catch (e) { toast(e.message, false); subscribe('baloot:lobby'); }
        }
        function backToLobby() {
            stopChat();
            if (S.table) unsubscribe('baloot:table:' + S.table.id);
            if (S.matchId) unsubscribe('baloot:match:' + S.matchId);
            S.table = null; S.matchId = null; S.state = null;
            subscribe('baloot:lobby');
            loadLobby();
        }
        async function sit(tableId) {
            try {
                var d = await api('POST', '/api/baloot/tables/' + tableId + '/sit', {});
                toast('جلست — المقعد ' + (d.seat + 1), true);
                if (!S.table) await openTable(tableId); else await refreshTableInfo();
            } catch (e) {
                toast(e.code === 'GATE_DENIED' ? 'لا يمكن الجلوس أثناء الواجب التشغيلي' : e.message, false);
            }
        }
        async function sendAction(type, payload) {
            if (!S.matchId) return;
            try {
                await api('POST', '/api/baloot/matches/' + S.matchId + '/action', { actionId: uuid(), type: type, payload: payload || {} });
            } catch (e) { toast(e.message, false); }
        }

        /* ── دردشة الطاولة (مسارات D1 القائمة) ── */
        function startChat() {
            stopChat();
            if (!S.roomId) return;
            loadChat();
            S.chatTimer = setInterval(loadChat, 4000);
        }
        function stopChat() { if (S.chatTimer) { clearInterval(S.chatTimer); S.chatTimer = null; } }
        async function loadChat() {
            if (!S.roomId || S.spectator) { $('#chatPanel').style.display = S.spectator ? 'none' : 'block'; return; }
            try {
                var d = await api('GET', '/api/community/rooms/' + S.roomId + '/messages?limit=30');
                var msgs = d.messages || [];
                $('#chatLog').innerHTML = msgs.map(function (m) {
                    return '<div class="chat-msg"><b>' + API.esc(m.author_name || '') + ':</b> ' + API.esc(m.content) + '</div>';
                }).join('');
                var log = $('#chatLog'); log.scrollTop = log.scrollHeight;
            } catch (_) { }
        }

        /* ── ربط الأحداث (تفويض) ── */
        document.addEventListener('click', function (ev) {
            var el = ev.target.closest('[data-act],[data-card],[data-bid],[data-double],[data-project],[data-rematch],#btnOpenTable,#btnBack,#btnReady,#btnSit,#btnLeave,#btnInvite,#btnJoinCouncil,#btnChatSend,#scoreModalClose');
            if (!el) return;
            var act = el.dataset.act;
            if (act === 'open' || act === 'watch') openTable(Number(el.dataset.table));
            else if (act === 'sit') sit(Number(el.dataset.table));
            else if (el.id === 'btnOpenTable') {
                api('POST', '/api/baloot/tables', {}).then(function (d) {
                    toast('طاولتك جاهزة — اجلس وادعُ الشباب', true);
                    openTable(d.table.id);
                }).catch(function (e) { toast(e.message, false); });
            }
            else if (el.id === 'btnBack') backToLobby();
            else if (el.id === 'btnJoinCouncil') {
                api('POST', '/api/community/councils/' + S.councilId + '/join', {}).then(function () {
                    toast('انضممت لمجلس البلوت', true); loadLobby();
                }).catch(function (e) { toast(e.message, false); });
            }
            else if (el.id === 'btnReady') api('POST', '/api/baloot/tables/' + S.table.id + '/ready', {}).catch(function (e) { toast(e.message, false); });
            else if (el.id === 'btnSit') sit(S.table.id);
            else if (el.id === 'btnLeave') {
                api('POST', '/api/baloot/tables/' + S.table.id + '/leave', {}).then(backToLobby).catch(function (e) { toast(e.message, false); });
            }
            else if (el.id === 'btnInvite') {
                var link = location.origin + '/baloot.html#table=' + S.table.id;
                if (navigator.clipboard) navigator.clipboard.writeText(link).then(function () { toast('نُسخ رابط الدعوة — أرسله لمن تبي', true); });
                else toast(link, true);
            }
            else if (el.dataset.card) sendAction('PLAY_CARD', { card: el.dataset.card, baloot: el.classList.contains('baloot') });
            else if (el.dataset.bid) sendAction('BID', { kind: el.dataset.bid, trumpSuit: el.dataset.suit });
            else if (el.dataset.double) sendAction('DOUBLE', { kind: el.dataset.double });
            else if (el.dataset.project) { try { sendAction('DECLARE', { projects: [JSON.parse(el.dataset.project)] }); } catch (_) { } }
            else if (el.dataset.rematch) {
                api('POST', '/api/baloot/tables/' + S.table.id + '/rematch/' + el.dataset.rematch, {})
                    .then(function (d) { if (d.matchStarted) toast('بدأت المباراة الثانية!', true); refreshTableInfo(); })
                    .catch(function (e) { toast(e.message, false); });
            }
            else if (el.id === 'btnChatSend') {
                var inp = $('#chatInput');
                if (inp.value.trim() && S.roomId) {
                    api('POST', '/api/community/rooms/' + S.roomId + '/messages', { content: inp.value.trim() })
                        .then(function () { inp.value = ''; loadChat(); })
                        .catch(function (e) { toast(e.message, false); });
                }
            }
            else if (el.id === 'scoreModalClose') $('#scoreModal').classList.remove('show');
        });

        /* ── إقلاع ── */
        (async function init() {
            try {
                await loadMe();
                subscribe('baloot:lobby');
                wsConnect();
                await loadLobby();
                // رابط دعوة مباشر: baloot.html#table=ID
                var m = /#table=(\d+)/.exec(location.hash || '');
                if (m) openTable(Number(m[1]));
            } catch (e) {
                toast(e.message || 'فشل التحميل', false);
            }
        })();
    }

    return API;
});
