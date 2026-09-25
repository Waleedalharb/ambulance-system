// ============================================
// Baloot Engine — rules.js (sa-standard-1.0)
// ثوابت النسخة المعتمدة — إعداد بيانات لا قيم محروقة (Architecture §3.1/A10)
// المرجع: BALOOT-RULESET.md بالكامل — أي تغيير هنا = ruleset_version جديدة
// ============================================
'use strict';

const RULESET = Object.freeze({
    version: 'sa-standard-1.0',

    // نهاية المباراة (ruleset §10 / §14-أ)
    targetScore: 152,

    // سقف أبناط الصفقة (ruleset §8.2)
    caps: Object.freeze({ sun: 26, hokum: 16 }),

    // قيم المشاريع بالأبناط (ruleset §7.1)
    projectValues: Object.freeze({
        sun: Object.freeze({ sara: 4, khamsin: 10, miya: 20, arba: 40 }),
        hokum: Object.freeze({ sara: 2, khamsin: 5, miya: 10, baloot: 2 })
    }),

    // الكبّوت (ruleset §8.5)
    kaboot: Object.freeze({ sun: 44, hokum: 25 }),

    // نقاط الأرض — آخر لفة (ruleset §8.1)
    lastTrickBonus: 10,

    // شروط الدبل (ruleset §9)
    double: Object.freeze({
        sunMinBuyerScore: 100,   // الصن: يتجاوز قيد المشتري 100 (أي ≥ 101)
        sunMaxDoublerScore: 100, // وقيد المُدبِّل دون 100 (أي ≤ 99)
        maxChain: 4              // دبل → ثري → فور (×2,×3,×4)
    }),

    // اللعب الآلي عند التأخر (ruleset §11) — لا إعلان ولا دبل آلي أبدًا
    autoPlay: Object.freeze({ declaresProjects: false, doubles: false })
});

const TEAM_OF = (seat) => (seat % 2 === 0 ? 'A' : 'B'); // المقاعد 0,2 = A · 1,3 = B (ruleset §2.1)
const OTHER_TEAM = (t) => (t === 'A' ? 'B' : 'A');

module.exports = { RULESET, TEAM_OF, OTHER_TEAM };
