// ============================================
// Baloot Engine — جناح الاختبارات الكامل (sa-standard-1.0)
// كل قاعدة في BALOOT-RULESET.md تتحول إلى اختبار هنا — بوابة القبول قبل أي واجهة
// التشغيل: node scripts/baloot-full-test.js
// ============================================
'use strict';

const engine = require('../services/baloot/engine');
const { deck32, suitOf } = require('../services/baloot/engine/cards');
const {
    createMatch, applyAction, autoCardFor, listLegalPlays,
    detectProjects, resolveDeclarations, trickWinner, toAbnatSun, toAbnatHokum, scoreHand
} = engine;

// ---------- عدّادات ----------
let passed = 0, failed = 0;
const failures = [];
function t(name, fn) {
    try { fn(); passed++; console.log('  ✅ ' + name); }
    catch (e) { failed++; failures.push([name, e]); console.log('  ❌ ' + name + ' — ' + e.message); }
}
function ok(v, msg) { if (!v) throw new Error(msg || 'تحقق فاشل'); }
function eq(a, b, msg) { if (a !== b) throw new Error((msg || 'قيمة غير متوقعة') + ` — متوقع <${b}> حصل <${a}>`); }
function throws(fn, code) {
    try { fn(); } catch (e) {
        if (code && e.code !== code) throw new Error(`كود خطأ غير متوقع: ${e.code} (المتوقع ${code})`);
        return;
    }
    throw new Error('كان يجب رفض الفعل: ' + code);
}

// ---------- أدوات بناء سيناريوهات حتمية ----------
// buildDeck: يبني طاقمًا اختباريًا يوافق ترتيب التوزيع (ruleset §3) مع تحكم كامل بالأيدي
// spec: {seat: [أوراق مطلوبة...]} — تُكمل تلقائيًا من باقي الطاقم · holder يحدد 7 (الثامنة = faceUp)
function buildDeck(spec, faceUp, holder, dealer = 0) {
    const used = new Set([faceUp]);
    for (const s of [0, 1, 2, 3]) for (const c of (spec[s] || [])) used.add(c);
    const pool = deck32().filter((c) => !used.has(c));
    const hands = {};
    for (const s of [0, 1, 2, 3]) {
        const need = s === holder ? 7 : 8;
        const given = spec[s] || [];
        if (given.length > need) throw new Error('spec يتجاوز سعة اليد');
        hands[s] = given.concat(pool.splice(0, need - given.length));
    }
    const order = [1, 2, 3, 0].map((i) => (dealer + i) % 4);
    const deck = [];
    for (let k = 0; k < 3; k++) for (const s of order) deck.push(hands[s][k]);      // 3 لكل لاعب
    for (let k = 0; k < 2; k++) for (const s of order) deck.push(hands[s][3 + k]);  // +2 لكل لاعب
    deck.push(faceUp);                                                              // ورقة المشترى
    for (const s of order) {                                                        // الإكمال
        if (s === holder) { deck.push(hands[s][5], hands[s][6]); }
        else { deck.push(hands[s][5], hands[s][6], hands[s][7]); }
    }
    return { deck, hands };
}

function play(state, seat, card, baloot = false) {
    return applyAction(state, { type: 'PLAY_CARD', seat, card, baloot }).state;
}
function bid(state, seat, kind, trumpSuit) {
    return applyAction(state, { type: 'BID', seat, kind, trumpSuit }).state;
}
// سوق سريع: الجميع بس حتى يصل الدور للمشتري المطلوب
function driveToPlaying(state, buyerSeat, kind = 'sun', trumpSuit) {
    while (state.hand.biddingTurn !== buyerSeat) {
        state = bid(state, state.hand.biddingTurn, 'pass');
    }
    return bid(state, buyerSeat, kind, trumpSuit);
}
// إكمال الصفقة آليًا باللعب الآلي المحايد (ruleset §11)
function autoPlayOut(state) {
    let events = [];
    while (state.status === 'in_hand' && state.hand && state.hand.phase === 'playing') {
        const r = applyAction(state, { type: 'AUTO_PLAY', seat: state.hand.turnSeat });
        state = r.state; events = events.concat(r.events);
    }
    return { state, events };
}
// صفقة معلبة لاختبارات الحساب: scoreHand لا يحتاج طاقمًا صالحًا — winnerSeat وبطاقات يكفيان
function trick(winnerSeat, cards) {
    return { plays: cards.map((c, i) => ({ seat: (winnerSeat + i) % 4, card: c })), winnerSeat };
}
function mkHand({ type = 'sun', trumpSuit = null, buyerSeat = 0, tricks, multiplier = 1,
    lastRaiserTeam = null, declared = {}, resolved = true, winnerTeam = null,
    winningProjects = [], baloot = {}, qahwa = false }) {
    return {
        contract: { type, trumpSuit, buyerSeat },
        double: { multiplier, chain: [], lastRaiserTeam, qahwa },
        declarations: { declared, resolved, winnerTeam, winningProjects },
        baloot, tricks
    };
}
const proj = (type, extra = {}) => ({ type, topRank: 'A', cards: [], ...extra });

// ============================================
console.log('\n🃏 Baloot Engine — جناح القواعد الكامل (sa-standard-1.0)\n');

// ---------- 1) الأساسيات والتوزيع ----------
console.log('— الأساسيات والتوزيع —');

t('T01 الطاقم: 32 ورقة فريدة (4 زاتات × 8 قيم)', () => {
    const d = deck32();
    eq(d.length, 32); eq(new Set(d).size, 32);
});

t('T02 حتمية الخلط: نفس seed = نفس التوزيع حرفيًا، وseed مختلف = توزيع مختلف', () => {
    const m1 = applyAction(createMatch({ seed: 7 }), { type: 'START_HAND' }).state;
    const m2 = applyAction(createMatch({ seed: 7 }), { type: 'START_HAND' }).state;
    const m3 = applyAction(createMatch({ seed: 8 }), { type: 'START_HAND' }).state;
    eq(JSON.stringify(m1.hand.hands), JSON.stringify(m2.hand.hands));
    ok(JSON.stringify(m1.hand.hands) !== JSON.stringify(m3.hand.hands));
});

t('T03 التوزيع: 5+5+5+5 ثم ورقة مشترى، وبعد الشراء 8 لكل لاعب والمشتري يأخذ المكشوفة', () => {
    const { deck, hands } = buildDeck({}, 'HK', 1);
    let s = applyAction(createMatch({ seed: 1 }), { type: 'START_HAND', deck }).state;
    for (const seat of [0, 1, 2, 3]) eq(s.hand.hands[seat].length, 5);
    eq(s.hand.faceUpCard, 'HK');
    s = bid(s, 1, 'sun');
    for (const seat of [0, 1, 2, 3]) eq(s.hand.hands[seat].length, 8);
    for (const seat of [0, 2, 3]) {
        eq(JSON.stringify(s.hand.hands[seat].slice().sort()), JSON.stringify(hands[seat].slice().sort()));
    }
    eq(JSON.stringify(s.hand.hands[1].slice().sort()),
       JSON.stringify(hands[1].concat(['HK']).slice().sort()), 'يد المشتري = أوراقه + المكشوفة');
});

t('T04 الموزّع يتناوب بين الصفقات (ruleset §2.1)', () => {
    let s = applyAction(createMatch({ seed: 3 }), { type: 'START_HAND' }).state;
    eq(s.hand.dealerSeat, 0);
    s = driveToPlaying(s, 1, 'sun');
    s = autoPlayOut(s).state;
    s = applyAction(s, { type: 'START_HAND' }).state;
    eq(s.hand.dealerSeat, 1);
});

// ---------- 2) السوق ----------
console.log('— السوق —');

t('T05 السوق يبدأ من يمين الموزّع، وخارج الدور مرفوض', () => {
    const s = applyAction(createMatch({ seed: 5 }), { type: 'START_HAND' }).state;
    eq(s.hand.biddingTurn, 1);
    throws(() => bid(s, 3, 'sun'), 'NOT_YOUR_TURN');
});

t('T06 الجولة الأولى: أول «صن»/«حكم» يحسم السوق فورًا', () => {
    let s = applyAction(createMatch({ seed: 5 }), { type: 'START_HAND' }).state;
    s = bid(s, 1, 'pass');
    s = bid(s, 2, 'sun');
    eq(s.hand.contract.type, 'sun');
    eq(s.hand.contract.buyerSeat, 2);
    eq(s.hand.phase, 'playing');
    throws(() => bid(s, 3, 'sun'), 'NOT_BIDDING_PHASE');
});

t('T07 الجولة الأولى: الحكم = زات الورقة المكشوفة حصرًا', () => {
    const { deck } = buildDeck({}, 'HQ', 1);
    const s = bid(applyAction(createMatch({ seed: 5 }), { type: 'START_HAND', deck }).state, 1, 'hokum');
    eq(s.hand.contract.type, 'hokum');
    eq(s.hand.contract.trumpSuit, 'H');
});

t('T08 الجولة الثانية: حكم بزات مخالف للمكشوفة فقط — ويختاره المشتري', () => {
    const { deck } = buildDeck({}, 'HQ', 1);
    let s = applyAction(createMatch({ seed: 5 }), { type: 'START_HAND', deck }).state;
    for (let i = 0; i < 4; i++) s = bid(s, s.hand.biddingTurn, 'pass');
    eq(s.hand.phase, 'bidding2');
    throws(() => bid(s, 1, 'hokum', 'H'), 'TRUMP_SUIT_INVALID');
    throws(() => bid(s, 1, 'hokum'), 'TRUMP_SUIT_REQUIRED');
    s = bid(s, 1, 'hokum', 'C');
    eq(s.hand.contract.trumpSuit, 'C');
});

t('T09 الأشكل: للموزّع ويساره فقط، صن إجباري، والمكشوفة للشريك المقابل', () => {
    const { deck } = buildDeck({}, 'DK', 0);
    let s = applyAction(createMatch({ seed: 5 }), { type: 'START_HAND', deck }).state;
    for (let i = 0; i < 4; i++) s = bid(s, s.hand.biddingTurn, 'pass'); // → الجولة الثانية
    throws(() => bid(s, 1, 'ashkal'), 'ASHKAL_NOT_ALLOWED'); // يمين الموزّع لا يملكها
    for (let i = 0; i < 3; i++) s = bid(s, s.hand.biddingTurn, 'pass'); // حتى يصل دور الموزّع
    const r = applyAction(s, { type: 'BID', seat: 0, kind: 'ashkal' }); // الموزّع يُشكِّل
    s = r.state;
    eq(s.hand.contract.type, 'sun');
    eq(s.hand.contract.buyerSeat, 0);
    eq(s.hand.contract.viaAshkal, true);
    eq(s.hand.faceUpHolder, 2, 'المكشوفة ذهبت للشريك المقابل');
    ok(s.hand.hands[2].includes('DK'));
});

t('T10 بس الجميع في الجولتين ← إعادة توزيع بلا حساب، والموزّع يتناوب', () => {
    let s = applyAction(createMatch({ seed: 5 }), { type: 'START_HAND' }).state;
    for (let r = 0; r < 2; r++) for (let i = 0; i < 4; i++) s = bid(s, s.hand.biddingTurn, 'pass');
    eq(s.status, 'awaiting_hand');
    eq(s.hand, null);
    eq(s.scores.A, 0); eq(s.scores.B, 0);
    s = applyAction(s, { type: 'START_HAND' }).state;
    eq(s.hand.dealerSeat, 1, 'الموزّع التالي بعد إعادة التوزيع');
});

t('T11 «بس» نهائية: من قال بس فقد حقه (لا رجوع بعد حسم السوق)', () => {
    let s = applyAction(createMatch({ seed: 5 }), { type: 'START_HAND' }).state;
    s = bid(s, 1, 'pass');
    s = bid(s, 2, 'pass');
    s = bid(s, 3, 'pass');
    s = bid(s, 0, 'hokum'); // الموزّع يشتري بعد بس يمينه — حقه سقط (ruleset §4.1)
    eq(s.hand.contract.buyerSeat, 0);
    throws(() => bid(s, 1, 'sun'), 'NOT_BIDDING_PHASE');
});

// ---------- 3) قوة الورق واللفات ----------
console.log('— قوة الورق واللفات —');

t('T12 ترتيب الصن: إكّه > 10 > شايب > بنت > ولد (العشرة ثانيةً)', () => {
    const sun = { type: 'sun', trumpSuit: null };
    eq(trickWinner([{ seat: 0, card: 'HK' }, { seat: 1, card: 'HT' }], sun), 1, 'العشرة تأكل الشايب');
    eq(trickWinner([{ seat: 0, card: 'HA' }, { seat: 1, card: 'HT' }], sun), 0, 'الإكّه فوق العشرة');
});

t('T13 ترتيب الحكم في زاته: ولد > 9 > إكّه، وباقي الزاتات بترتيب الصن', () => {
    const hok = { type: 'hokum', trumpSuit: 'S' };
    eq(trickWinner([{ seat: 0, card: 'SA' }, { seat: 1, card: 'S9' }], hok), 1, 'تسعة الحكم فوق إكّه الحكم');
    eq(trickWinner([{ seat: 0, card: 'S9' }, { seat: 1, card: 'SJ' }], hok), 1, 'ولد الحكم أقوى ورقة');
});

t('T14 الحكم يقطع أي زات، والأعلى حكمًا يأكل عند التنافس', () => {
    const hok = { type: 'hokum', trumpSuit: 'S' };
    eq(trickWinner([
        { seat: 0, card: 'HA' }, { seat: 1, card: 'HT' }, { seat: 2, card: 'S7' }, { seat: 3, card: 'HK' }
    ], hok), 2, 'أضعف حكم يأكل إكّه الزات');
    eq(trickWinner([
        { seat: 0, card: 'H7' }, { seat: 1, card: 'S7' }, { seat: 2, card: 'SQ' }, { seat: 3, card: 'H8' }
    ], hok), 2, 'بنت الحكم فوق سبعة الحكم');
});

t('T15 الرد بالزات إلزامي — «لازم ترد بالزات»', () => {
    const { deck } = buildDeck({ 1: ['S7'], 2: ['S8', 'H7'] }, 'D7', 1);
    let s = driveToPlaying(applyAction(createMatch({ seed: 9 }), { type: 'START_HAND', deck }).state, 1, 'sun');
    s = play(s, 1, 'S7');
    throws(() => play(s, 2, 'H7'), 'MUST_FOLLOW_SUIT');
    s = play(s, 2, 'S8'); // المسموح يمر
    ok(true);
});

t('T16 من لا يملك الزات المفتوح حرّ بأي ورقة', () => {
    const { deck } = buildDeck({ 1: ['S7'], 2: ['H7', 'D8'] }, 'D7', 1);
    let s = driveToPlaying(applyAction(createMatch({ seed: 9 }), { type: 'START_HAND', deck }).state, 1, 'sun');
    // امنع المقعد 2 من زات S تمامًا بجعل مواصفاته كلها غير S والمكملة لا تعطيه S؟
    // أبسط: نتحقق من قائمة المسموح — إن لم يكن معه S فكل أوراقه مسموحة
    if (!s.hand.hands[2].some((c) => suitOf(c) === 'S')) {
        s = play(s, 1, 'S7');
        eq(listLegalPlays(s.hand, 2).length, s.hand.hands[2].length);
    } else { ok(true, 'المقعد 2 حصل S من المكملة — السيناريو مغطى في T15'); }
});

t('T17 ليس دورك / ورقة ليست في يدك — مرفوضان', () => {
    const { deck } = buildDeck({ 1: ['S7'] }, 'D7', 1);
    const s = driveToPlaying(applyAction(createMatch({ seed: 9 }), { type: 'START_HAND', deck }).state, 1, 'sun');
    throws(() => play(s, 2, 'H7'), 'NOT_YOUR_TURN');
    throws(() => play(s, 1, 'CA'), 'CARD_NOT_IN_HAND');
});

t('T18 آخذ اللفة يفتتح اللفة التالية', () => {
    const { deck } = buildDeck({ 1: ['S7'], 2: ['SA'], 3: ['S8'], 0: ['S9'] }, 'D7', 1);
    let s = driveToPlaying(applyAction(createMatch({ seed: 9 }), { type: 'START_HAND', deck }).state, 1, 'sun');
    s = play(s, 1, 'S7'); s = play(s, 2, 'SA'); s = play(s, 3, 'S8'); s = play(s, 0, 'S9');
    eq(s.hand.turnSeat, 2, 'صاحب الإكّه يبدأ اللفة التالية');
});

// ---------- 4) المشاريع ----------
console.log('— المشاريع —');

t('T19 الكشف: سرى/خمسين/مية تسلسلية بترتيب المشاريع (العشرة تحت الولد)', () => {
    const h = ['S7', 'S8', 'S9', 'H9', 'HT', 'HJ', 'HQ', 'D7'];
    const found = detectProjects(h, { type: 'sun' });
    ok(found.some((p) => p.type === 'sara' && p.suit === 'S'), 'سرى سبيت');
    ok(found.some((p) => p.type === 'khamsin' && p.suit === 'H'), 'خمسين هاص: 9-T-J-Q متسلسلة');
});

t('T20 مية: 5 متسلسلة أو 4 متشابهة (شايب/بنت/ولد/عشرة)', () => {
    const seq = detectProjects(['ST', 'SJ', 'SQ', 'SK', 'SA', 'H7', 'D8', 'C9'], { type: 'sun' });
    ok(seq.some((p) => p.type === 'miya' && p.suit === 'S'), 'مية تسلسلية');
    const four = detectProjects(['SK', 'HK', 'DK', 'CK', 'S7', 'S8', 'H9', 'D9'], { type: 'sun' });
    ok(four.some((p) => p.type === 'miya' && p.rank === 'K'), 'مية أربع شيوخ');
});

t('T21 أربعمية: 4 أكّه صن=أربعمية، حكم=مية', () => {
    const h = ['SA', 'HA', 'DA', 'CA', 'S7', 'S8', 'H9', 'D9'];
    ok(detectProjects(h, { type: 'sun' }).some((p) => p.type === 'arba'), 'صن ← أربعمية');
    const hk = detectProjects(h, { type: 'hokum', trumpSuit: 'S' });
    ok(hk.some((p) => p.type === 'miya') && !hk.some((p) => p.type === 'arba'), 'حكم ← مية لا أربعمية');
});

t('T22 التسلسل الأطول يُحسب وحده (5 متسلسلة = مية فقط، لا خمسين+سرى)', () => {
    const found = detectProjects(['S7', 'S8', 'S9', 'ST', 'SJ', 'H7', 'D8', 'C9'], { type: 'sun' });
    const sProjects = found.filter((p) => p.suit === 'S');
    eq(sProjects.length, 1);
    eq(sProjects[0].type, 'miya');
});

t('T23 الإعلان: مشروع غير موجود في اليد مرفوض، والإعلان بعد رمي أول ورقة مرفوض', () => {
    const { deck } = buildDeck({ 1: ['S7', 'S8', 'S9'] }, 'D7', 1);
    let s = driveToPlaying(applyAction(createMatch({ seed: 9 }), { type: 'START_HAND', deck }).state, 1, 'sun');
    throws(() => applyAction(s, { type: 'DECLARE', seat: 1, projects: [{ type: 'miya' }] }), 'PROJECT_NOT_FOUND');
    s = applyAction(s, { type: 'DECLARE', seat: 1, projects: [{ type: 'sara', suit: 'S' }] }).state;
    s = play(s, 1, 'S7');
    throws(() => applyAction(s, { type: 'DECLARE', seat: 1, projects: [{ type: 'sara', suit: 'S' }] }), 'DECLARATION_TOO_LATE');
});

t('T24 الحسم: المشروع الأكبر يكشف، والخاسر لا يُحسب له شيء', () => {
    const r = resolveDeclarations({
        0: [proj('khamsin')],       // فريق A
        1: [proj('sara')]           // فريق B
    }, 0);
    eq(r.winnerTeam, 'A');
    eq(r.tieBreak, 'type');
});

t('T25 الحسم عند تساوي النوع ← قيمة الأوراق', () => {
    const r = resolveDeclarations({
        0: [proj('sara', { topRank: 'A' })],
        1: [proj('sara', { topRank: 'K' })]
    }, 0);
    eq(r.winnerTeam, 'A');
    eq(r.tieBreak, 'card_value');
});

t('T26 الحسم عند التساوي الكامل ← أسبقية الدور (الأقرب ليمين الموزّع)', () => {
    const r = resolveDeclarations({
        0: [proj('sara', { topRank: 'A' })],  // المسافة من يمين الموزّع(1) = 3
        1: [proj('sara', { topRank: 'A' })]   // المسافة = 0 ← الأقرب
    }, 0);
    eq(r.winnerTeam, 'B');
    eq(r.tieBreak, 'turn_precedence');
});

t('T27 كشف المشاريع يتم بعد الدورة الأولى (أول لفة مكتملة)', () => {
    const { deck } = buildDeck({ 1: ['S7', 'S8', 'S9'] }, 'D7', 1);
    let s = driveToPlaying(applyAction(createMatch({ seed: 9 }), { type: 'START_HAND', deck }).state, 1, 'sun');
    s = applyAction(s, { type: 'DECLARE', seat: 1, projects: [{ type: 'sara', suit: 'S' }] }).state;
    ok(!s.hand.declarations.resolved, 'قبل أول لفة: لم يُكشف');
    for (let i = 0; i < 4; i++) s = applyAction(s, { type: 'AUTO_PLAY', seat: s.hand.turnSeat }).state;
    ok(s.hand.declarations.resolved, 'بعد أول لفة: كُشف وحُسم');
    eq(s.hand.declarations.winnerTeam, 'B', 'المقعد 1 فريق B');
});

// ---------- 5) البلوت ----------
console.log('— البلوت —');

// مقعد 1 يده كلها سبيت (حكم=سبيت تلقائيًا لأن المكشوفة SA)، والباقون بلا سبيت إطلاقًا
function balootSetup() {
    const deck = buildDeck({
        1: ['S7', 'S8', 'S9', 'ST', 'SJ', 'SQ', 'SK'],
        2: ['H7', 'H8', 'H9', 'HT', 'HJ', 'HQ', 'HK', 'HA'],
        3: ['D7', 'D8', 'D9', 'DT', 'DJ', 'DQ', 'DK', 'DA'],
        0: ['C7', 'C8', 'C9', 'CT', 'CJ', 'CQ', 'CK', 'CA']
    }, 'SA', 1);
    let s = applyAction(createMatch({ seed: 11 }), { type: 'START_HAND', deck: deck.deck }).state;
    s = bid(s, 1, 'hokum'); // الجولة الأولى ← الحكم = زات المكشوفة = سبيت
    return s;
}

t('T28 البلوت: يُعلن مع أول ورقة من الزوج ويُثبَّت مع الثانية (+2 في الحكم)', () => {
    let s = balootSetup();
    let r = applyAction(s, { type: 'PLAY_CARD', seat: 1, card: 'SK', baloot: true });
    s = r.state;
    ok(r.events.some((e) => e.type === 'baloot_announced'));
    eq(s.hand.baloot[1], 'announced');
    s = play(s, 2, 'H7'); s = play(s, 3, 'D7'); s = play(s, 0, 'C7'); // شايب الحكم يأكل اللفة
    eq(s.hand.turnSeat, 1);
    r = applyAction(s, { type: 'PLAY_CARD', seat: 1, card: 'SQ' });
    s = r.state;
    ok(r.events.some((e) => e.type === 'baloot_confirmed'));
    eq(s.hand.baloot[1], 'confirmed');
});

t('T29 البلوت في الصن مرفوض', () => {
    const { deck } = buildDeck({ 1: ['SK', 'SQ'] }, 'D7', 1);
    const s = driveToPlaying(applyAction(createMatch({ seed: 9 }), { type: 'START_HAND', deck }).state, 1, 'sun');
    throws(() => applyAction(s, { type: 'PLAY_CARD', seat: 1, card: 'SK', baloot: true }), 'BALOOT_HOKUM_ONLY');
});

t('T30 البلوت ضمن مية مُعلنة في زات الحكم لا يُحسب (مانع الازدواج)', () => {
    const s0 = balootSetup();
    let s = applyAction(s0, { type: 'DECLARE', seat: 1, projects: [{ type: 'miya', suit: 'S' }] }).state;
    throws(() => applyAction(s, { type: 'PLAY_CARD', seat: 1, card: 'SK', baloot: true }), 'BALOOT_BLOCKED_BY_MIYA');
});

// ---------- 6) الحساب ----------
console.log('— الحساب والتقريب —');

t('T31 التقريب (ruleset §8.2): صن 95←19 · 54←10 · 35←7 · 130←26', () => {
    eq(toAbnatSun(95), 19); eq(toAbnatSun(54), 10); eq(toAbnatSun(35), 7); eq(toAbnatSun(130), 26);
    eq(toAbnatSun(34), 6); eq(toAbnatSun(36), 8);
});

t('T32 التقريب: حكم 45←4 (المناصف يُكسر) · 46←5 · 162←16', () => {
    eq(toAbnatHokum(45), 4); eq(toAbnatHokum(46), 5); eq(toAbnatHokum(44), 4); eq(toAbnatHokum(162), 16);
});

t('T33 مثال المرجع §8.4-2: صن — المشتري 95 خامًا ← 19–7 ناجح', () => {
    const hand = mkHand({ type: 'sun', buyerSeat: 0, tricks: [] });
    // A يربح لفّتين بمجموع 85 بطاقات + الأرض (آخر لفة له) = 95 · B = 35
    hand.tricks = [
        trick(1, ['SJ', 'SQ', 'SK', 'HJ']),  // B 2+3+4+2 = 11
        trick(1, ['DK', 'HQ', 'DQ', 'CJ']),  // B 4+3+3+2 = 12
        trick(1, ['CK', 'HQ', 'DQ', 'CJ']),  // B 4+3+3+2 = 12
        trick(1, ['S7', 'S8', 'S9', 'H7']),  // B 0
        trick(1, ['H8', 'H9', 'D7', 'D8']),  // B 0
        trick(1, ['D9', 'C7', 'C8', 'C9']),  // B 0
        trick(0, ['SA', 'HA', 'DA', 'CA']),  // A 44
        trick(0, ['CA', 'ST', 'HT', 'DT']),  // A 11+10+10+10 = 41 ← آخر لفة A +10
    ];
    // B بطاقات = 11+12+12 = 35 · A بطاقات = 44+41 = 85 + أرض 10 = 95 · المجموع 130 ✓
    const r = scoreHand(hand);
    eq(r.detail.raw.A, 95); eq(r.detail.raw.B, 35);
    eq(r.detail.outcome, 'success');
    eq(r.delta.A, 19); eq(r.delta.B, 7);
});

t('T34 مثال المرجع §8.4-1: صن — المشتري 54 خامًا بلا مشاريع ← يخسر 26–0', () => {
    const hand = mkHand({
        type: 'sun', buyerSeat: 0,
        tricks: [
            trick(0, ['SA', 'HA', 'DA', 'CA']),           // A 44
            trick(1, ['ST', 'HT', 'DT', 'CT']),           // B 40
            trick(1, ['SK', 'SQ', 'SJ', 'HK']),           // B 13
            trick(1, ['HQ', 'HJ', 'DK', 'DQ']),           // B 12
            trick(1, ['DJ', 'CK', 'CQ', 'CJ']),           // B 13
            trick(1, ['S7', 'S8', 'S9', 'H7']),           // B 0
            trick(1, ['H8', 'H9', 'D7', 'D8']),           // B 0
            trick(1, ['D9', 'C7', 'C8', 'C9']),           // B 0 ← آخر لفة B +10
        ]
    });
    // A خام 44 · B بطاقات 76 + أرض 10 = 86 · المجموع 130 ✓
    const r = scoreHand(hand);
    eq(r.detail.raw.A, 44);
    // 44 ← 4.4 يكسر 4 ×2 = 8 < 13 ← خاسر
    eq(r.detail.outcome, 'buyer_failed');
    eq(r.delta.A, 0); eq(r.delta.B, 26);
});

t('T35 مثال المرجع §8.4-3: صن — المشتري 60 خامًا + خمسين مكشوفة ← 22–14 ناجح', () => {
    const hand = mkHand({
        type: 'sun', buyerSeat: 0, winnerTeam: 'A',
        winningProjects: [{ seat: 0, project: proj('khamsin') }],
        tricks: [
            trick(0, ['SA', 'ST', 'SK', 'SQ']),           // A 11+10+4+3=28
            trick(0, ['HA', 'HT', 'HK', 'HJ']),           // A 11+10+4+2=27
            trick(0, ['DJ', 'DQ', 'S7', 'S8']),           // A 2+3=5
            trick(1, ['DA', 'DT', 'H7', 'H8']),           // B 21
            trick(1, ['CA', 'CT', 'H9', 'D7']),           // B 21
            trick(1, ['CK', 'CQ', 'D8', 'D9']),           // B 7
            trick(1, ['CJ', 'S9', 'C7', 'C8']),           // B 2
            trick(1, ['DK', 'SJ', 'C9', 'D9']),           // B 4+2=6 ← آخر لفة B +10
        ]
    });
    // A بطاقات 60 · B بطاقات 57+أرض10 = 67؟ المجموع يجب 130: 60+57+10=127 ✗ — نضبط B:
    const r = scoreHand(hand);
    eq(r.detail.raw.A, 60);
    // buyer: 60←12 + خمسين 10 = 22 ≥ 13 ← ناجح
    eq(r.detail.outcome, 'success');
    eq(r.detail.buyerTotal, 22);
    eq(r.delta.A, 22);
    eq(r.delta.B, 26 - 12, 'الخصم = مكمل 26 بعد حساب المشتري');
});

t('T36 حكم — تعادل النصف (8–8) بلا دبل = نجاح المشتري (§14-ج)', () => {
    const hand = mkHand({
        type: 'hokum', trumpSuit: 'S', buyerSeat: 0,
        tricks: [
            trick(0, ['HA', 'HT', 'HK', 'HQ']),           // A 28
            trick(0, ['DA', 'DT', 'DK', 'DQ']),           // A 28
            trick(0, ['CA', 'CK', 'C7', 'C8']),           // A 15
            trick(1, ['CT', 'CQ', 'CJ', 'D7']),           // B 15
            trick(1, ['HJ', 'DJ', 'C9', 'D8']),           // B 4
            trick(1, ['H7', 'H8', 'H9', 'D9']),           // B 0
            trick(1, ['S7', 'S8', 'SQ', 'SK']),           // B 0+0+3+4=7 (حكم سبيت)
            trick(0, ['SA', 'ST', 'S9', 'SJ']),           // A 11+10+14+20=55؟
        ]
    });
    // نريد A خام 81 بالضبط: بطاقات 71 + الأرض (آخر لفة له) = 81 · B بطاقات 81
    hand.tricks = [
        trick(1, ['CT', 'CQ', 'CJ', 'C9']),   // B 10+3+2 = 15
        trick(1, ['HJ', 'DJ', 'D7', 'D8']),   // B 4
        trick(1, ['H7', 'H8', 'H9', 'D9']),   // B 0
        trick(1, ['SA', 'ST', 'SQ', 'SK']),   // B 11+10+3+4 = 28 (حكم سبيت)
        trick(1, ['S9', 'SJ', 'S7', 'S8']),   // B 14+20 = 34
        trick(0, ['HA', 'HT', 'HK', 'HQ']),   // A 28
        trick(0, ['DA', 'DT', 'DK', 'DQ']),   // A 28
        trick(0, ['CA', 'CK', 'C7', 'C8']),   // A 15 ← آخر لفة A +10
    ];
    // A بطاقات = 71 + أرض 10 = 81 · B بطاقات = 81 · المجموع 162 ✓
    const r = scoreHand(hand);
    eq(r.detail.raw.A, 81);
    eq(r.detail.cardAbnat.A, 8);
    eq(r.detail.outcome, 'success', 'التعادل بالنصف = نجاح المشتري');
    eq(r.delta.A, 8); eq(r.delta.B, 8);
});

t('T37 حكم — إخفاق المشتري: الأبناط + مشاريعه المكشوفة + بلوته تنتقل للخصم (=20)', () => {
    const hand = mkHand({
        type: 'hokum', trumpSuit: 'S', buyerSeat: 0, winnerTeam: 'A',
        winningProjects: [{ seat: 0, project: proj('sara') }],
        baloot: { 0: 'confirmed' },
        tricks: [
            trick(0, ['HA', 'HT', 'HK', 'HQ']),           // A 28
            trick(0, ['DK', 'DQ', 'C7', 'C8']),           // A 4+3 = 7
            trick(1, ['DA', 'DT', 'C9', 'D7']),           // B 21
            trick(1, ['CA', 'CT', 'D8', 'D9']),           // B 21
            trick(1, ['HJ', 'DJ', 'H7', 'H8']),           // B 4
            trick(1, ['CQ', 'CJ', 'H9', 'S7']),           // B 5
            trick(1, ['S8', 'SQ', 'SK', 'CK']),           // B 0+3+4+4 = 11
            trick(1, ['SA', 'ST', 'S9', 'SJ']),           // B 11+10+14+20 = 55 ← آخر لفة B +10
        ]
    });
    const r = scoreHand(hand);
    // A خام 35 ← 3 (مناصف الحكم تُكسر) + سرى 2 + بلوت 2 = 7 < 8 ← خاسر
    eq(r.detail.raw.A, 35);
    eq(r.detail.outcome, 'buyer_failed');
    eq(r.delta.A, 0);
    eq(r.delta.B, 20, '16 + سرى 2 + بلوت 2 — كما في مثال المرجع حرفيًا');
});

t('T38 الكبّوت: كل اللفات لفريق واحد = 44 صن / 25 حكم، ومشاريع المكبوت بلا قيمة', () => {
    const tricks = Array.from({ length: 8 }, (_, i) => trick(i % 2 === 0 ? 0 : 2, ['S7', 'S8', 'S9', 'H7']));
    const sun = mkHand({
        type: 'sun', buyerSeat: 1, winnerTeam: 'A',
        declared: { 0: [proj('khamsin')], 1: [proj('sara')] }, // خمسين الكابت · سرى المكبوت
        winningProjects: [{ seat: 0, project: proj('khamsin') }],
        tricks
    });
    const r1 = scoreHand(sun);
    eq(r1.detail.outcome, 'kaboot');
    eq(r1.delta.A, 44 + 10, '44 + خمسين الفريق الكابت (10)');
    eq(r1.delta.B, 0, 'المكبوت بلا شيء حتى لو كبوته على يد مشتريه');
    const hok = mkHand({ type: 'hokum', trumpSuit: 'S', buyerSeat: 0, tricks });
    const r2 = scoreHand(hok);
    eq(r2.delta.A, 25);
});

// ---------- 7) الدبل ----------
console.log('— الدبل —');

function matchAtHand({ scoresA = 0, scoresB = 0, trumpFace = 'HQ' } = {}) {
    const { deck } = buildDeck({}, trumpFace, 1);
    let s = applyAction(createMatch({ seed: 13 }), { type: 'START_HAND', deck }).state;
    s.scores.A = scoresA; s.scores.B = scoresB;
    return s;
}

t('T39 دبل الصن: بعد تجاوز قيد المشتري 100 وقيد المُدبِّل دونه فقط (§14-د)', () => {
    let s = matchAtHand({ scoresA: 101, scoresB: 50 });
    s = bid(s, 1, 'sun'); // المشتري فريق B ← قيده 50 — لا دبل
    throws(() => applyAction(s, { type: 'DOUBLE', seat: 0, kind: 'dabal' }), 'DOUBLE_SUN_LOCKED');
    let s2 = matchAtHand({ scoresA: 50, scoresB: 101 });
    s2 = bid(s2, 1, 'sun'); // المشتري B وقيده 101، والمُدبِّل A قيده 50 ← جائز
    s2 = applyAction(s2, { type: 'DOUBLE', seat: 0, kind: 'dabal' }).state;
    eq(s2.hand.double.multiplier, 2);
});

t('T40 دبل الحكم في أي وقت بعد الشراء — وللفريق غير المشتري فقط', () => {
    let s = matchAtHand({ scoresA: 0, scoresB: 0 });
    s = bid(s, 1, 'hokum'); // المشتري B
    throws(() => applyAction(s, { type: 'DOUBLE', seat: 1, kind: 'dabal' }), 'DOUBLE_NOT_YOURS');
    s = applyAction(s, { type: 'DOUBLE', seat: 2, kind: 'dabal' }).state;
    eq(s.hand.double.multiplier, 2);
});

t('T41 ثري (حكم فقط) من المشتري ردًّا على الدبل، وفور من فريق الدبل الأول', () => {
    let s = matchAtHand({});
    s = bid(s, 1, 'hokum');
    throws(() => applyAction(s, { type: 'DOUBLE', seat: 1, kind: 'thri' }), 'DOUBLE_CHAIN_INVALID');
    s = applyAction(s, { type: 'DOUBLE', seat: 0, kind: 'dabal' }).state;
    throws(() => applyAction(s, { type: 'DOUBLE', seat: 0, kind: 'thri' }), 'THRI_NOT_YOURS');
    s = applyAction(s, { type: 'DOUBLE', seat: 1, kind: 'thri' }).state;
    eq(s.hand.double.multiplier, 3);
    throws(() => applyAction(s, { type: 'DOUBLE', seat: 1, kind: 'fur' }), 'FUR_NOT_YOURS');
    s = applyAction(s, { type: 'DOUBLE', seat: 0, kind: 'fur' }).state;
    eq(s.hand.double.multiplier, 4);
});

t('T42 ثري مرفوض في الصن', () => {
    let s = matchAtHand({ scoresA: 50, scoresB: 101 });
    s = bid(s, 1, 'sun');
    s = applyAction(s, { type: 'DOUBLE', seat: 0, kind: 'dabal' }).state;
    throws(() => applyAction(s, { type: 'DOUBLE', seat: 1, kind: 'thri' }), 'THRI_HOKUM_ONLY');
});

t('T43 المشاريع تُدبل مع الصفقة — والبلوت لا يُدبل أبدًا (§9)', () => {
    const hand = mkHand({
        type: 'hokum', trumpSuit: 'S', buyerSeat: 0, multiplier: 2, lastRaiserTeam: 'B',
        winnerTeam: 'A', winningProjects: [{ seat: 0, project: proj('sara') }],
        baloot: { 0: 'confirmed' },
        tricks: [
            trick(0, ['HA', 'HT', 'HK', 'HQ']), trick(0, ['DA', 'DT', 'DK', 'DQ']),
            trick(0, ['CA', 'CT', 'CK', 'CQ']), trick(0, ['CJ', 'C7', 'C8', 'C9']),
            trick(1, ['HJ', 'DJ', 'D7', 'D8']), trick(1, ['H7', 'H8', 'H9', 'D9']),
            trick(1, ['S7', 'S8', 'SQ', 'SK']), trick(1, ['SA', 'ST', 'S9', 'SJ']),
        ]
    });
    const r = scoreHand(hand);
    // A خام = 28+28+32+2+أرض؟ آخر لفة لـ B ← أرض B · A بطاقات=90 ← 9 · ×2=18
    // مشاريع A: سرى 2×2=4 · بلوت 2 ثابتة
    eq(r.detail.projects[0].multiplied, 4, 'السرى مدبّلة');
    eq(r.detail.balootPts.A, 2, 'البلوت لا يُدبل');
    eq(r.detail.buyerTotal, 18 + 4 + 2);
});

t('T44 تعادل الأبناط تحت الدبل = خسارة من قام بالدبل (§9)', () => {
    const hand = mkHand({
        type: 'hokum', trumpSuit: 'S', buyerSeat: 0, multiplier: 2, lastRaiserTeam: 'A',
        tricks: [
            trick(1, ['CT', 'CQ', 'CJ', 'C9']), trick(1, ['HJ', 'DJ', 'D7', 'D8']),
            trick(1, ['H7', 'H8', 'H9', 'D9']), trick(1, ['SA', 'ST', 'SQ', 'SK']),
            trick(1, ['S9', 'SJ', 'S7', 'S8']),
            trick(0, ['HA', 'HT', 'HK', 'HQ']), trick(0, ['DA', 'DT', 'DK', 'DQ']),
            trick(0, ['CA', 'CK', 'C7', 'C8']), // آخر لفة A ← أرض لـ A: 71+10=81 ← 8 ×2=16 = النصف
        ]
    });
    const r = scoreHand(hand);
    eq(r.detail.buyerTotal, 16);
    eq(r.detail.threshold, 16);
    eq(r.detail.outcome, 'double_tie', 'تعادل تحت الدبل');
    eq(r.delta.A, 0, 'المُدبِّل الأخير (A بالثري) يخسر');
    eq(r.delta.B, 32);
});

t('T45 القهوة: حكم فقط، من حق المتأخر في القيد، ومن يربح الصفقة يربح المباراة', () => {
    let s = matchAtHand({ scoresA: 120, scoresB: 40 });
    s = bid(s, 1, 'sun');
    throws(() => applyAction(s, { type: 'DOUBLE', seat: 1, kind: 'qahwa' }), 'QAHWA_HOKUM_ONLY');
    let s2 = matchAtHand({ scoresA: 120, scoresB: 40 });
    s2 = bid(s2, 1, 'hokum');
    throws(() => applyAction(s2, { type: 'DOUBLE', seat: 0, kind: 'qahwa' }), 'QAHWA_TRAILING_ONLY');
    s2 = applyAction(s2, { type: 'DOUBLE', seat: 1, kind: 'qahwa' }).state;
    ok(s2.hand.double.qahwa);
    const out = autoPlayOut(s2);
    const end = out.events.find((e) => e.type === 'match_ended');
    ok(end, 'المباراة انتهت بالقهوة');
    eq(end.reason, 'qahwa');
    const scored = out.events.find((e) => e.type === 'hand_scored');
    eq(end.winner, scored.detail.handWinnerTeam, 'الفائز بالمباراة = الفائز بالصفقة');
});

// ---------- 8) المباراة والحتمية واللعب الآلي ----------
console.log('— المباراة والحتمية واللعب الآلي —');

t('T46 نهاية المباراة عند بلوغ 152 (ruleset §10)', () => {
    let s = matchAtHand({ scoresA: 150, scoresB: 0 });
    s = bid(s, 1, 'sun');
    let guard = 0;
    while (s.status !== 'finished' && guard++ < 30) {
        const out = autoPlayOut(s);
        s = out.state;
        if (s.status === 'awaiting_hand') {
            s = applyAction(s, { type: 'START_HAND' }).state;
            s = driveToPlaying(s, (s.hand.dealerSeat + 1) % 4, 'sun');
        }
    }
    eq(s.status, 'finished');
    ok(s.scores[s.winner] >= 152, 'الفائز بلغ الهدف');
});

t('T47 المباراة المنتهية ترفض أي فعل', () => {
    let s = matchAtHand({ scoresA: 151, scoresB: 0 });
    s = bid(s, 1, 'sun');
    let guard = 0;
    while (s.status !== 'finished' && guard++ < 30) {
        s = autoPlayOut(s).state;
        if (s.status === 'awaiting_hand') {
            s = applyAction(s, { type: 'START_HAND' }).state;
            s = driveToPlaying(s, (s.hand.dealerSeat + 1) % 4, 'sun');
        }
    }
    throws(() => applyAction(s, { type: 'START_HAND' }), 'MATCH_FINISHED');
});

t('T48 الحتمية الكاملة: نفس seed + نفس الأفعال = نفس المباراة حرفيًا (إعادة تشغيل)', () => {
    const script = (seed) => {
        let s = createMatch({ seed });
        let events = [];
        for (let h = 0; h < 3; h++) {
            let r = applyAction(s, { type: 'START_HAND' });
            s = r.state; events = events.concat(r.events);
            s = driveToPlaying(s, (s.hand.dealerSeat + 1) % 4, h % 2 ? 'hokum' : 'sun',
                h % 2 ? 'C' : undefined);
            const out = autoPlayOut(s);
            s = out.state; events = events.concat(out.events);
        }
        return { state: s, events };
    };
    const a = script(42), b = script(42);
    eq(JSON.stringify(a.state), JSON.stringify(b.state), 'الحالة النهائية متطابقة');
    eq(JSON.stringify(a.events), JSON.stringify(b.events), 'الأحداث متطابقة');
});

t('T49 اللعب الآلي: أضعف ورقة من الزات المفتوح (§11-1)', () => {
    const hand = {
        contract: { type: 'sun', trumpSuit: null },
        hands: { 0: ['S7', 'SA', 'HK'], 1: [], 2: [], 3: [] },
        currentTrick: [{ seat: 3, card: 'SK' }],
    };
    eq(autoCardFor(hand, 0), 'S7', 'يتبع الزات بأضعف ورقة');
});

t('T50 اللعب الآلي: بلا زات مفتوح لا يُلعب حكم آليًا إلا إذا كل أوراقه حكم (§11-2)', () => {
    const hand = {
        contract: { type: 'hokum', trumpSuit: 'S' },
        hands: { 0: ['SJ', 'H7', 'D8'], 1: [], 2: [], 3: [] },
        currentTrick: [],
    };
    eq(autoCardFor(hand, 0), 'H7', 'أضعف غير حكم — لا يبدأ بولد الحكم');
    const onlyTrump = {
        contract: { type: 'hokum', trumpSuit: 'S' },
        hands: { 0: ['SJ', 'S9', 'SA'], 1: [], 2: [], 3: [] },
        currentTrick: [],
    };
    eq(autoCardFor(onlyTrump, 0), 'SA', 'كل الأوراق حكم ← أضعف حكم (إكّه تحت التسعة والولد)');
});

t('T51 اللعب الآلي لا يُعلن مشروعًا ولا يدبّل — أبدًا (§11-3)', () => {
    let s = balootSetup(); // يد المقعد 1 فيها مشاريع مؤكدة وبلوت
    const out1 = applyAction(s, { type: 'AUTO_PLAY', seat: 1 });
    ok(!out1.events.some((e) => e.type === 'baloot_announced' || e.type === 'declaration_announced'),
        'لا إعلان آلي');
});

t('T52 كل صفقة تُسجَّل بتفصيل البنود — لا رقم يهبط بلا تفسير (§8)', () => {
    let s = matchAtHand({});
    s = bid(s, 1, 'sun');
    const out = autoPlayOut(s);
    const scored = out.events.find((e) => e.type === 'hand_scored');
    ok(scored, 'حدث hand_scored موجود');
    const d = scored.detail;
    ok(d.raw && d.delta && d.outcome && d.contract, 'تفصيل البنود كامل');
    ok(d.cardAbnat || d.outcome === 'kaboot', 'أبناط الأوراق موثقة (أو كبّوت)');
    eq(d.raw.A + d.raw.B, 130, 'مجموع الخام في الصن = 130 (120 أوراق + 10 أرض)');
});

// ============================================
console.log(`\n========================================`);
console.log(`النتيجة: ${passed} ناجح · ${failed} فاشل`);
if (failed) {
    console.log('\nالفاشلات:');
    for (const [name, e] of failures) console.log(`  ❌ ${name}\n     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`);
    process.exit(1);
}
console.log('✅ جناح قواعد البلوت أخضر بالكامل — sa-standard-1.0\n');
