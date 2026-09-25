// ============================================
// Baloot Engine — scoring.js (sa-standard-1.0)
// حساب اللفة والصفقة والمباراة — بتفصيل البنود (ruleset §8 / §9)
// «لا رقم يهبط بلا تفسير» — كل نتيجة ترجع مع detail كامل
// ============================================
'use strict';

const { suitOf, rankOf, powerOf, rawPoints, isTrump } = require('./cards');
const { RULESET, TEAM_OF, OTHER_TEAM } = require('./rules');
const { projectPoints } = require('./declarations');

// قاعدة اللفة (ruleset §5.3): أعلى الزات المفتوح يأخذها إلا إذا قطعها حكم
function trickWinner(plays, contract) {
    const ledSuit = suitOf(plays[0].card);
    let best = plays[0];
    for (const p of plays.slice(1)) {
        const pTrump = isTrump(p.card, contract);
        const bTrump = isTrump(best.card, contract);
        if (pTrump && !bTrump) { best = p; continue; }
        if (pTrump !== bTrump) continue; // غير الحكم لا يأكل الحكم
        if (suitOf(p.card) !== ledSuit && !pTrump) continue; // زات آخر لا يأكل
        if (powerOf(p.card, contract) > powerOf(best.card, contract)) best = p;
    }
    return best.seat;
}

// التحويل إلى أبناط (ruleset §8.2) — حساب صحيح بأعشار العشرة بلا فواصل عائمة:
// الصن: كسر <5 يُكسر، >5 يُجبر، المناصف يُضاعف (35←7) · ثم ×2
// الحكم: كسر <5 يُكسر، >5 يُجبر، المناصف يُكسر دائمًا (45←4)
function toAbnatSun(raw) {
    const base = Math.floor(raw / 10), t = raw % 10;
    const v = t < 5 ? base : t > 5 ? base + 1 : base + 0.5;
    return v * 2;
}
function toAbnatHokum(raw) {
    const base = Math.floor(raw / 10), t = raw % 10;
    return t < 5 ? base : t > 5 ? base + 1 : base;
}
const toAbnat = (raw, type) => (type === 'sun' ? toAbnatSun(raw) : toAbnatHokum(raw));

// حساب الصفقة كاملًا — يُستدعى بعد اللفة الثامنة
// hand: { tricks, contract, double, declarations, baloot }
// يعيد { delta: {A,B}, detail, handWinnerTeam }
function scoreHand(hand) {
    const contract = hand.contract;
    const type = contract.type;
    const cap = RULESET.caps[type];
    const mult = hand.double.multiplier;
    const buyerTeam = TEAM_OF(contract.buyerSeat);
    const opp = OTHER_TEAM(buyerTeam);

    // 1) قيم الأوراق الخام لكل فريق + الأرض (ruleset §8.1)
    const raw = { A: 0, B: 0 };
    const tricksWon = { A: 0, B: 0 };
    for (const trick of hand.tricks) {
        const wt = TEAM_OF(trick.winnerSeat);
        tricksWon[wt]++;
        for (const p of trick.plays) raw[wt] += rawPoints(p.card, contract);
    }
    const lastTrickTeam = TEAM_OF(hand.tricks[hand.tricks.length - 1].winnerSeat);
    raw[lastTrickTeam] += RULESET.lastTrickBonus;

    // 2) المشاريع: الفريق الفائز بالحسم فقط (ruleset §7.3-4)، مضروبة بمعامل الدبل (§9)
    const projPts = { A: 0, B: 0 };
    const projDetail = [];
    if (hand.declarations.resolved && hand.declarations.winnerTeam) {
        for (const { seat, project } of hand.declarations.winningProjects) {
            const base = projectPoints(project, type);
            const pts = base * mult;
            projPts[hand.declarations.winnerTeam] += pts;
            projDetail.push({ team: hand.declarations.winnerTeam, seat, project: project.type, base, multiplied: pts });
        }
    }
    // البلوت: لصاحبه دائمًا، ولا يُدبل أبدًا (ruleset §9)
    const balootPts = { A: 0, B: 0 };
    for (const [seatStr, st] of Object.entries(hand.baloot)) {
        if (st === 'confirmed') balootPts[TEAM_OF(Number(seatStr))] += RULESET.projectValues.hokum.baloot;
    }

    // 3) الكبّوت (ruleset §8.5): كل اللفات الثماني لفريق واحد
    //    يحسب أساس الكبوت ×معامل الدبل + مشاريع الفريق الكابت المعلنة، ومشاريع المكبوت بلا قيمة
    let kabootTeam = null;
    if (hand.tricks.length === 8) {
        if (tricksWon.A === 8) kabootTeam = 'A';
        else if (tricksWon.B === 8) kabootTeam = 'B';
    }
    if (kabootTeam) {
        const loser = OTHER_TEAM(kabootTeam);
        const kabootProj = { A: 0, B: 0 };
        for (const [seatStr, projects] of Object.entries(hand.declarations.declared)) {
            const t = TEAM_OF(Number(seatStr));
            for (const p of projects) kabootProj[t] += projectPoints(p, type) * mult;
        }
        const base = RULESET.kaboot[type] * mult;
        const delta = { A: 0, B: 0 };
        delta[kabootTeam] = base + kabootProj[kabootTeam] + balootPts[kabootTeam];
        const detail = {
            outcome: 'kaboot', kabootTeam, handWinnerTeam: kabootTeam, contract, buyerTeam, raw, tricksWon,
            multiplier: mult, kabootBase: base,
            projects: kabootProj[kabootTeam], baloot: balootPts[kabootTeam],
            delta, note: 'كبّوت — مشاريع الفريق المكبوت بلا قيمة'
        };
        return { delta, detail, handWinnerTeam: kabootTeam };
        // loser يخرج بصفر تلقائيًا
    }

    // 4) المسار العادي: أبناط الأوراق + مشاريع الحسم + البلوت
    const cardAbnat = { A: toAbnat(raw.A, type), B: toAbnat(raw.B, type) };
    const buyerCard = cardAbnat[buyerTeam] * mult;
    const oppCard = cardAbnat[opp] * mult;
    const buyerTotal = buyerCard + projPts[buyerTeam] + balootPts[buyerTeam];
    const oppTotal = oppCard + projPts[opp] + balootPts[opp];
    const half = (cap * mult) / 2;

    const delta = { A: 0, B: 0 };
    let outcome;
    let handWinnerTeam;

    if (buyerTotal > half || (buyerTotal === half && mult === 1)) {
        // نجاح المشتري — والتعادل بلا دبل نجاحٌ له (ruleset §8.3 / §14-ج)
        outcome = 'success';
        delta[buyerTeam] = buyerTotal;
        delta[opp] = oppTotal;
        handWinnerTeam = buyerTotal >= oppTotal ? buyerTeam : opp;
    } else if (buyerTotal === half && mult > 1) {
        // تعادل الأبناط تحت الدبل = خسارة من قام بالدبل (ruleset §9)
        const loser = hand.double.lastRaiserTeam || opp;
        const winner = OTHER_TEAM(loser);
        outcome = 'double_tie';
        delta[winner] = cap * mult + projPts.A + projPts.B + balootPts.A + balootPts.B;
        handWinnerTeam = winner;
    } else {
        // إخفاق المشتري: كل الأبناط + مشاريعه المكشوفة + بلوته تنتقل للخصم (ruleset §8.3/§8.4-4)
        outcome = 'buyer_failed';
        delta[opp] = cap * mult + projPts[opp] + projPts[buyerTeam] + balootPts[opp] + balootPts[buyerTeam];
        handWinnerTeam = opp;
    }

    const detail = {
        outcome, contract, buyerTeam, raw, tricksWon, cardAbnat,
        multiplier: mult, threshold: half, buyerTotal, oppTotal,
        projects: projDetail, balootPts, delta, handWinnerTeam,
        note: outcome === 'buyer_failed'
            ? 'المشتري لم يحرز النصف — كل الأبناط والمشاريع المكشوفة للخصم'
            : outcome === 'double_tie'
                ? 'تعادل تحت الدبل — خسارة من قام بالدبل'
                : 'نجاح المشتري'
    };
    return { delta, detail, handWinnerTeam };
}

module.exports = { trickWinner, toAbnatSun, toAbnatHokum, toAbnat, scoreHand };
