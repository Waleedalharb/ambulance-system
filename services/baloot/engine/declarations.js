// ============================================
// Baloot Engine — declarations.js (sa-standard-1.0)
// المشاريع: الكشف الآلي، المقارنة والحسم، البلوت (ruleset §7)
// ============================================
'use strict';

const { SUITS, suitOf, rankOf, DECL_ORDER } = require('./cards');
const { RULESET, TEAM_OF } = require('./rules');

const TYPE_RANK = Object.freeze({ sara: 1, khamsin: 2, miya: 3, arba: 4 });

// كشف مشاريع يدٍ من 8 أوراق (ruleset §7.1)
// يعيد قائمة مشاريع: { type, suit?, rank?, topRank, cards: [...] }
// ملاحظة: التسلسل يُقاس بترتيب المشاريع (§7.2) لا بترتيب القوة.
function detectProjects(hand, contract) {
    const projects = [];
    const bySuit = { S: [], H: [], D: [], C: [] };
    for (const c of hand) bySuit[suitOf(c)].push(rankOf(c));

    // التسلسلات: سرى(3) خمسين(4) مية(5+) — التسلسل الأطول في الزات يُحسب وحده (لا تداخل)
    for (const s of SUITS) {
        const ranks = bySuit[s].slice().sort((a, b) => DECL_ORDER[b] - DECL_ORDER[a]);
        let run = [];
        for (let i = 0; i < ranks.length; i++) {
            if (run.length && DECL_ORDER[run[run.length - 1]] - DECL_ORDER[ranks[i]] === 1) {
                run.push(ranks[i]);
            } else {
                flushRun(projects, run, s);
                run = [ranks[i]];
            }
        }
        flushRun(projects, run, s);
    }

    // الأربع المتشابهة (ruleset §7.1): أكّه → أربعمية (صن) / مية (حكم) · شايب/بنت/ولد/عشرة → مية
    for (const rank of ['A', 'K', 'Q', 'J', 'T']) {
        if (SUITS.every((s) => bySuit[s].includes(rank))) {
            const cards = SUITS.map((s) => s + rank);
            if (rank === 'A' && contract && contract.type === 'sun') {
                projects.push({ type: 'arba', rank, topRank: rank, cards });
            } else {
                projects.push({ type: 'miya', rank, topRank: rank, cards });
            }
        }
    }

    return projects;
}

function flushRun(projects, run, suit) {
    if (run.length < 3) return;
    const type = run.length === 3 ? 'sara' : run.length === 4 ? 'khamsin' : 'miya';
    projects.push({ type, suit, topRank: run[0], cards: run.map((r) => suit + r) });
}

// هل يد اللاعب فيها بلوت نظامي؟ (ruleset §7.1/§7.3: شايب+بنت الحكم، حكم فقط)
function hasBalootCards(hand, contract) {
    if (!contract || contract.type !== 'hokum') return false;
    return hand.includes(contract.trumpSuit + 'K') && hand.includes(contract.trumpSuit + 'Q');
}

// مانع الازدواج (ruleset §7.1/§12): البلوت لا يُحسب إذا كان ضمن مشروع مية مُعلن
// لنفس اللاعب — عمليًا: مية تسلسلية في زات الحكم تتضمن الشايب والبنت معًا.
function balootBlockedBy(declaredProjects, contract) {
    if (!contract || contract.type !== 'hokum') return true;
    return declaredProjects.some((p) =>
        p.type === 'miya' && p.suit === contract.trumpSuit &&
        p.cards.includes(contract.trumpSuit + 'K') && p.cards.includes(contract.trumpSuit + 'Q'));
}

// حسم التنافس بين الفريقين (ruleset §7.3):
// الأكبر يكشف · تساوي النوع ← قيمة الأوراق · تساوي النوع والقيمة ← أسبقية الدور
// declaredBySeat: { seat: [projects] } — dealerSeat لحسم أسبقية الدور
// يعيد { winnerTeam, winningProjects: [{seat, project}], tieBreak }
function resolveDeclarations(declaredBySeat, dealerSeat) {
    const byTeam = { A: [], B: [] };
    for (const [seatStr, projects] of Object.entries(declaredBySeat)) {
        const seat = Number(seatStr);
        for (const p of projects) byTeam[TEAM_OF(seat)].push({ seat, project: p });
    }
    const bestOf = (list) => list.slice().sort((a, b) =>
        TYPE_RANK[b.project.type] - TYPE_RANK[a.project.type] ||
        DECL_ORDER[b.project.topRank] - DECL_ORDER[a.project.topRank]
    )[0] || null;

    const bestA = bestOf(byTeam.A), bestB = bestOf(byTeam.B);
    if (!bestA && !bestB) return { winnerTeam: null, winningProjects: [], tieBreak: 'none' };
    if (bestA && !bestB) return { winnerTeam: 'A', winningProjects: byTeam.A, tieBreak: 'only' };
    if (bestB && !bestA) return { winnerTeam: 'B', winningProjects: byTeam.B, tieBreak: 'only' };

    const ta = TYPE_RANK[bestA.project.type], tb = TYPE_RANK[bestB.project.type];
    if (ta !== tb) {
        const w = ta > tb ? 'A' : 'B';
        return { winnerTeam: w, winningProjects: byTeam[w], tieBreak: 'type' };
    }
    const ra = DECL_ORDER[bestA.project.topRank], rb = DECL_ORDER[bestB.project.topRank];
    if (ra !== rb) {
        const w = ra > rb ? 'A' : 'B';
        return { winnerTeam: w, winningProjects: byTeam[w], tieBreak: 'card_value' };
    }
    // تساوٍ كامل بزاتات مختلفة ← أسبقية الدور (الأقرب ليمين الموزّع)
    const dist = (seat) => (seat - (dealerSeat + 1) + 8) % 4;
    const w = dist(bestA.seat) <= dist(bestB.seat) ? 'A' : 'B';
    return { winnerTeam: w, winningProjects: byTeam[w], tieBreak: 'turn_precedence' };
}

// قيمة المشروع بالأبناط قبل الدبل (ruleset §7.1) — البلوت يُحسب عبر balootPoints
function projectPoints(project, contractType) {
    const table = RULESET.projectValues[contractType];
    return table[project.type] || 0;
}

module.exports = {
    TYPE_RANK, detectProjects, hasBalootCards, balootBlockedBy,
    resolveDeclarations, projectPoints
};
