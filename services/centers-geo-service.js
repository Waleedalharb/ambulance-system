/**
 * ═══ centers-geo-service.js — المصدر الوحيد (SSOT) لإحداثيات المراكز التشغيلية ═══
 * P1 (اعتماد المالك 2026-09-21): قراءة فقط من config/operational-centers.json.
 * المفاتيح = قيم teams.center في قاعدة البيانات حرفيًا (منفوحة/الشفاء).
 * لا كتابة ولا اشتقاق ولا إحداثيات مختلقة. لا علاقة بـ centerGeoData القديم
 * (قطاعات فرق تقريبية لـ /api/locate-report — يبقى دون مساس).
 *
 * سلامة المرجع (قرار المالك — صارم بلا فشل صامت): أي مركز مستخدم فعليًا في
 * فرقة ميدانية نشطة (جنوب/دعم/سريع) وغير مصرح به هنا = خطأ بيانات نظام ظاهر
 * في كل سطح قراءة (integrity)، ولا يُسقِط السيرفر. التصريح إما بإحداثيات في
 * centers أو بإعلان صريح في nonGeographicCenters («العمليات»/«الفرق الإضافية»
 * — فرق تتبع إداريًا ولا تُرسم على الخريطة).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const MyPortalService = require('./my-portal-service'); // FIELD_TEAM_TYPES المشتركة — لا نسخة ثانية هنا

const DEFAULT_FILE = path.join(__dirname, '..', 'config', 'operational-centers.json');

class CentersGeoService {
    /**
     * @param {object} deps
     * @param {object} deps.db — طبقة القاعدة (db.all) لجرد teams.center
     * @param {string} [deps.filePath] — مسار بديل (للاختبارات)
     */
    constructor({ db, filePath } = {}) {
        if (!db) throw new Error('CentersGeoService: db مطلوب');
        this.db = db;
        this.filePath = filePath || process.env.CENTERS_GEO_PATH || DEFAULT_FILE;
        this._loaded = null; // { version, centers } | null عند فشل القراءة
        this._loadError = null;
        this._load();
    }

    _load() {
        try {
            const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
            const centers = raw && raw.centers;
            if (!centers || typeof centers !== 'object' || Array.isArray(centers)) {
                throw new Error('شكل الملف غير صالح: centers مفقود');
            }
            for (const [name, c] of Object.entries(centers)) {
                const pair = c && c.center;
                if (!Array.isArray(pair) || pair.length !== 2 ||
                    typeof pair[0] !== 'number' || typeof pair[1] !== 'number' ||
                    Math.abs(pair[0]) > 90 || Math.abs(pair[1]) > 180) {
                    throw new Error('إحداثيات غير صالحة للمركز: ' + name);
                }
            }
            const nonGeographic = raw.nonGeographicCenters || {};
            this._loaded = { version: raw.version || 1, centers, nonGeographic };
        } catch (e) {
            this._loaded = null;
            this._loadError = e.message;
        }
    }

    /** البيانات كما هي — بلا معالجة. */
    getData() {
        return this._loaded;
    }

    /**
     * teamCenters (P3 — اعتماد المالك 2026-09-21): ربط الفريق بالمركز من DB
     * مباشرة (teams.center — نفس استعلام السلامة، بلا اشتقاق). الاسم ← اسم
     * المركز نصًا فقط؛ ممنوع وضع إحداثيات هنا (الإحداثيات من centers فقط).
     * الفرق بلا مركز أو بمركز غير مصرح تظهر في integrity.missing ولا تُخفى.
     * @returns {Promise<Object<string, string>>} — { "جنوب 1": "المنصورة", ... }
     */
    async getTeamCenters() {
        const types = MyPortalService.FIELD_TEAM_TYPES;
        const placeholders = types.map(() => '?').join(', ');
        const rows = await this.db.all(
            `SELECT name, center FROM teams
             WHERE is_active = 1 AND team_type IN (${placeholders})
               AND center IS NOT NULL AND center != ''`, types);
        const out = {};
        for (const r of rows) out[r.name] = r.center;
        return out;
    }

    /**
     * مطابقة 100%: كل مركز مستخدم فعليًا في فرقة ميدانية نشطة (جنوب/دعم/سريع —
     * قائمة MyPortalService.FIELD_TEAM_TYPES المعتمدة، لا نسخة ثانية) يجب أن يكون
     * مصرحًا به: إما مركزًا جغرافيًا في centers أو قيمة معلنة في nonGeographicCenters
     * («العمليات»/«الفرق الإضافية» — فرق تتبع إداريًا ولا تُرسم على الخريطة).
     * أي قيمة أخرى = خطأ بيانات نظام ظاهر في missing، بلا فشل صامت.
     * @returns {Promise<{complete: boolean, missing: Array<{center: string, teams: string[]}>, loadError: string|null}>}
     */
    async checkIntegrity() {
        const missing = [];
        if (!this._loaded) {
            return { complete: false, missing, loadError: this._loadError };
        }
        const types = MyPortalService.FIELD_TEAM_TYPES;
        const placeholders = types.map(() => '?').join(', ');
        const rows = await this.db.all(
            `SELECT name, center FROM teams
             WHERE is_active = 1 AND team_type IN (${placeholders})
               AND center IS NOT NULL AND center != ''`, types);
        const allowed = new Set(
            Object.keys(this._loaded.centers).concat(Object.keys(this._loaded.nonGeographic)));
        const byCenter = {}; // center → [team names]
        for (const r of rows) {
            if (!byCenter[r.center]) byCenter[r.center] = [];
            byCenter[r.center].push(r.name);
        }
        for (const center of Object.keys(byCenter)) {
            if (!allowed.has(center)) {
                missing.push({ center, teams: byCenter[center].sort() });
            }
        }
        return { complete: missing.length === 0, missing, loadError: null };
    }
}

module.exports = CentersGeoService;
