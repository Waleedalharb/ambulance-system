// ============================================
// BalootTimerService — D3 (Architecture Freeze §6/A6)
// مؤقتات خادمية مُدامجة: كل مهلة سجل في baloot_deadlines، تُعاد تعبئتها بعد
// Restart، والفائتة أثناء التوقف تُستهلك فورًا بترتيبها — كأن التوقف لم يحدث.
// لا منطق قواعد هنا — فقط جدولة وإطلاق. المعالجة في baloot-match/table-service.
// ============================================
'use strict';

class BalootTimerService {
    /**
     * @param {object} deps
     * @param {object} deps.store   — طبقة وصول baloot_* (makeBalootStore)
     * @param {function} deps.onFire — async (deadlineRow) => void — المعالج الفعلي
     * @param {function} [deps.now] — ساعة قابلة للحقن (للاختبارات)
     * @param {function} [deps.setTimer] / [deps.clearTimer] — قابلة للحقن
     */
    constructor({ store, onFire, now, setTimer, clearTimer }) {
        if (!store) throw new Error('BalootTimerService: store مطلوب');
        this.store = store;
        this.onFire = onFire || null;
        this.handlers = new Map(); // kind → async handler — توجيه المهل لأصحابها
        this.now = now || (() => Date.now());
        this.setTimer = setTimer || setTimeout;
        this.clearTimer = clearTimer || clearTimeout;
        this._live = new Map(); // deadlineId → timer handle
    }

    // تسجيل معالج لنوع مهلة (turn/reconnect → match-service · ready_check/lobby_idle → table-service)
    register(kind, handler) {
        this.handlers.set(kind, handler);
    }

    // جدولة مهلة — تُحفظ أولًا ثم تُسلَّح (البقاء قبل الإطلاق)
    async schedule({ matchId = null, tableId = null, kind, ttlMs, payload = {} }) {
        const fireAt = this.now() + ttlMs;
        const id = await this.store.insertDeadline({ matchId, tableId, kind, fireAt, payload });
        this._arm({ id, match_id: matchId, table_id: tableId, kind, fire_at: fireAt, payload_json: JSON.stringify(payload) });
        return id;
    }

    _arm(row) {
        const delay = Math.max(0, row.fire_at - this.now());
        const handle = this.setTimer(() => { this._fire(row).catch(() => {}); }, delay);
        this._live.set(row.id, handle);
    }

    async _fire(row) {
        this._live.delete(row.id);
        // حارس ذري: من استهلكها أولًا يملك الإطلاق — لا إطلاق مزدوج أبدًا
        const consumed = await this.store.consumeDeadline(row.id);
        if (!consumed) return;
        const deadline = {
            id: row.id,
            matchId: row.match_id,
            tableId: row.table_id,
            kind: row.kind,
            payload: safeParse(row.payload_json)
        };
        const handler = this.handlers.get(row.kind) || this.onFire;
        if (handler) await handler(deadline);
    }

    // إلغاء مهل بلا إطلاق (مثل: مهلة الدور عند إيقاف المباراة مؤقتًا)
    async cancel({ matchId = null, tableId = null, kinds = null }) {
        const rows = await this.store.pendingDeadlinesFor({ matchId, tableId, kinds });
        for (const r of rows) {
            await this.store.consumeDeadline(r.id);
            const handle = this._live.get(r.id);
            if (handle) { this.clearTimer(handle); this._live.delete(r.id); }
        }
        return rows.length;
    }

    // الإقلاع: المهل الفائتة تُستهلك فورًا بترتيبها، والقادمة تُسلَّح بما تبقى
    async onBoot() {
        const rows = await this.store.pendingDeadlines();
        let fired = 0, armed = 0;
        for (const row of rows) {
            if (row.fire_at <= this.now()) {
                await this._fire(row); fired++;
            } else {
                this._arm(row); armed++;
            }
        }
        return { fired, armed };
    }

    shutdown() {
        for (const h of this._live.values()) this.clearTimer(h);
        this._live.clear();
    }
}

function safeParse(json) {
    try { return JSON.parse(json || '{}'); } catch (_) { return {}; }
}

module.exports = BalootTimerService;
