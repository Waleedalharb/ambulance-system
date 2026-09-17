/**
 * ═══ push-gateway.js — بوابة APNs (طبقة v6 فوق نظام الإشعارات القائم) ═══
 *
 * ليست نظام إشعارات جديدًا: لا تنشئ إشعارات ولا تخزن رسائل. تُستدعى من
 * نقاط الإنشاء القائمة (NotificationService.notifyPersonal /
 * ScheduleChangeNotifier / مسار الإشعار اليدوي) لإيصال نسخة Push لأجهزة
 * الموظف المسجّلة في push_devices، وتبقى SSE/WS قناة التطبيق المفتوح.
 *
 * ضوابط المالك المثبتة:
 *   ① مفاتيح APNs من متغيرات البيئة فقط (APNS_KEY / APNS_KEY_BASE64 +
 *      APNS_KEY_ID + APNS_TEAM_ID + APNS_BUNDLE_ID) — لا ملف .p8 في المستودع.
 *   ② بلا مفاتيح (أو بلا حزمة apn): الوضع المعطَّل — لا رمي ولا كسر لأي
 *      مسار قائم، مجرد {disabled:true} وسجل واحد عند أول محاولة.
 *   ③ الفشل الجزئي/الكلي يُحصى ولا يرمي أبدًا — مثل فلسفة ScheduleChangeNotifier.
 *   ④ التوكنات الميتة (410/Unregistered/BadDeviceToken) تُفصل فورًا حتى لا
 *      تتراكم الإرسالات الفاشلة.
 *   ⑤ بيئة APNs لكل جهاز (development=sandbox لبناء Xcode، production
 *      لـTestFlight/App Store) — مزوّد لكل بيئة، والتوجيه حسب الجهاز.
 *   ⑥ delivered = قبول APNs للإرسال فقط؛ APNs لا تمنح إيصال وصول للجهاز.
 *      القراءة تأتي من مسارات /api/my/notifications القائمة.
 */
'use strict';

const DEFAULT_BUNDLE_ID = 'online.emsoperations.app';

class PushGateway {
    /**
     * @param {object} deps { db?, getDb?, providerFactory? }
     *   db أو getDb (كسول — db تُفتح بعد إنشاء البوابة في server.js).
     *   providerFactory(environment) ⇒ { send(note, tokens) } — للاختبارات.
     *   الافتراضي: apn.Provider من حزمة apn (تُحمَّل كسولًا عند أول إرسال).
     * بيانات الاعتماد تُقرأ من البيئة عند الإنشاء:
     *   APNS_KEY (محتوى .p8 نصًا) أو APNS_KEY_BASE64 (base64 لمحتواه)
     *   APNS_KEY_ID + APNS_TEAM_ID (إلزاميان مع المفتاح)
     *   APNS_BUNDLE_ID (اختياري — الافتراضي online.emsoperations.app)
     */
    constructor({ db, getDb, providerFactory } = {}) {
        if (!db && typeof getDb !== 'function') throw new Error('PushGateway: db أو getDb مطلوب');
        this._dbStatic = db || null;
        this._getDb = typeof getDb === 'function' ? getDb : null;
        this._providerFactory = typeof providerFactory === 'function' ? providerFactory : null;
        this._providers = new Map(); // environment ⇒ provider (كسول)
        this._apn = null;            // حزمة apn بعد أول تحميل ناجح
        this._disabledLogged = false;

        const keyRaw = process.env.APNS_KEY || null;
        const keyB64 = process.env.APNS_KEY_BASE64 || null;
        this._key = keyRaw || (keyB64 ? Buffer.from(keyB64, 'base64').toString('utf8') : null);
        this._keyId = process.env.APNS_KEY_ID || null;
        this._teamId = process.env.APNS_TEAM_ID || null;
        this._topic = process.env.APNS_BUNDLE_ID || DEFAULT_BUNDLE_ID;
    }

    /** الجاهزية: مفتاح + معرّفاته. غياب أيٍّ منها = وضع معطَّل آمن. */
    isEnabled() {
        return Boolean(this._key && this._keyId && this._teamId);
    }

    /** وحدة القاعدة لحظة الاستدعاء (حقن كسول أو مباشر). */
    _db() {
        return this._getDb ? this._getDb() : this._dbStatic;
    }

    _logDisabledOnce() {
        if (!this._disabledLogged) {
            this._disabledLogged = true;
            console.log('[push-gateway] APNs disabled — APNS_KEY/APNS_KEY_ID/APNS_TEAM_ID غير مكتملة (وضع آمن بلا إرسال)');
        }
    }

    _loadApn() {
        if (this._apn) return this._apn;
        try {
            this._apn = require('apn'); // eslint-disable-line global-require
        } catch (e) {
            throw new Error('apn package unavailable: ' + e.message);
        }
        return this._apn;
    }

    /** مزوّد البيئة (sandbox للتطوير، production للإصدار) — إنشاء كسول. */
    _provider(environment) {
        const env = environment === 'production' ? 'production' : 'development';
        if (this._providers.has(env)) return this._providers.get(env);
        let provider;
        if (this._providerFactory) {
            provider = this._providerFactory(env);
        } else {
            const apn = this._loadApn();
            provider = new apn.Provider({
                token: { key: this._key, keyId: this._keyId, teamId: this._teamId },
                production: env === 'production'
            });
        }
        this._providers.set(env, provider);
        return provider;
    }

    /** عدد غير المقروء للشارة: جرس notifications + سجل notification_log. */
    async unreadCountForUser(userId) {
        const uid = String(userId);
        let count = 0;
        try {
            const r = await this._db().get('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND is_read = 0', [uid]);
            count += (r && r.c) || 0;
        } catch (_) { /* جدول قد يغيب في قواعد مصغّرة — الشارة تقريبية لا حرجة */ }
        try {
            const r2 = await this._db().get(
                "SELECT COUNT(*) AS c FROM notification_log WHERE recipient_user_id = ? AND status NOT IN ('read', 'acknowledged')", [uid]);
            count += (r2 && r2.c) || 0;
        } catch (_) { /* نفس الاعتبار */ }
        return count;
    }

    /**
     * إرسال إشعار لمستخدمين: جلب الأجهزة النشطة ← تجميع حسب البيئة ← إرسال.
     * @param {string[]} userIds
     * @param {object} payload { title, body, data?, badge? }
     *   badge: رقم صريح أو 'auto' (يُحسب لكل مستخدم) أو undefined (بلا شارة).
     * @returns {Promise<object>} { sent, failed, deactivated, disabled? }
     *   لا يرمي أبدًا — الفشل الكلي يُسجَّل ويُعاد ضمن الإحصاء.
     */
    async sendToUsers(userIds, { title, body, data, badge } = {}) {
        const stats = { sent: 0, failed: 0, deactivated: 0 };
        try {
            if (!this.isEnabled()) { this._logDisabledOnce(); return { ...stats, disabled: true }; }
            const ids = (userIds || []).map(String).filter(Boolean);
            if (!ids.length || !title) return stats;

            const db = this._db();
            if (!db || !db.PushDevices) return { ...stats, noDb: true }; // قاعدة غير جاهزة بعد — سقوط آمن
            const devices = await this._db().PushDevices.activeForUsers(ids);
            if (!devices.length) return stats;

            // الشارة: 'auto' = عدد غير المقروء لكل مستخدم لحظة الإرسال
            let badgeByUser = null;
            if (badge === 'auto') {
                badgeByUser = new Map();
                for (const uid of ids) badgeByUser.set(uid, await this.unreadCountForUser(uid));
            }

            const byEnv = new Map();
            for (const d of devices) {
                const env = d.environment === 'production' ? 'production' : 'development';
                if (!byEnv.has(env)) byEnv.set(env, []);
                byEnv.get(env).push(d);
            }

            for (const [env, devs] of byEnv) {
                let provider;
                try { provider = this._provider(env); }
                catch (e) { console.error('[push-gateway] provider init failed:', e.message); stats.failed += devs.length; continue; }

                let note;
                if (this._providerFactory) {
                    // وضع الاختبار: كائن عادي يمر حرفيًا للمزوّد المزيّف
                    note = { title, body, data: data || {}, topic: this._topic };
                } else {
                    const apn = this._loadApn();
                    note = new apn.Notification();
                    note.alert = { title, body };
                    note.topic = this._topic;
                    note.sound = 'default';
                    note.mutableContent = true;
                    note.payload = data || {};
                }

                for (const d of devs) {
                    const badgeNum = badge === 'auto' ? (badgeByUser.get(String(d.user_id)) || 0)
                        : (typeof badge === 'number' ? badge : null);
                    let noteForDevice = note;
                    if (!this._providerFactory) {
                        if (badgeNum != null) note.badge = badgeNum;
                    } else {
                        noteForDevice = { ...note, badge: badgeNum };
                    }
                    try {
                        const result = await provider.send(noteForDevice, d.device_token);
                        const failed = (result && result.failed) || [];
                        const sent = (result && result.sent) || [];
                        if (failed.length) {
                            stats.failed += failed.length;
                            for (const f of failed) {
                                const reason = (f && f.response && f.response.reason) || (f && f.error && f.error.message) || '';
                                console.warn('[push-gateway] send failed:', reason || 'unknown');
                                if (/Unregistered|BadDeviceToken|DeviceTokenNotForTopic/i.test(String(reason))) {
                                    await this._db().PushDevices.deactivateToken(d.device_token);
                                    stats.deactivated++;
                                }
                            }
                        }
                        if (sent.length) stats.sent += sent.length;
                    } catch (sendErr) {
                        stats.failed++;
                        console.error('[push-gateway] send error:', sendErr.message);
                    }
                }
            }
        } catch (err) {
            console.error('[push-gateway] sendToUsers failed:', err.message);
        }
        return stats;
    }

    /**
     * تحديث صامت للشارة بعد القراءة/التأكيد — content-available بلا تنبيه.
     * بذل قصوى: iOS قد يؤجّل الصامت، والشارة تُصحَّح مع أول إشعار لاحق.
     */
    async sendBadgeRefresh(userId) {
        try {
            if (!this.isEnabled()) return { disabled: true };
            const db = this._db();
            if (!db || !db.PushDevices) return { sent: 0, noDb: true };
            const devices = await this._db().PushDevices.activeForUsers([String(userId)]);
            if (!devices.length) return { sent: 0 };
            const badge = await this.unreadCountForUser(userId);
            let sent = 0;
            for (const d of devices) {
                try {
                    const provider = this._provider(d.environment);
                    let note;
                    if (this._providerFactory) {
                        note = { silent: true, badge, topic: this._topic };
                    } else {
                        const apn = this._loadApn();
                        note = new apn.Notification();
                        note.topic = this._topic;
                        note.badge = badge;
                        note.payload = {};
                        note.setContentAvailable(true);
                        note.priority = 5;
                    }
                    const result = await provider.send(note, d.device_token);
                    if (result && result.sent && result.sent.length) sent++;
                } catch (e) { console.warn('[push-gateway] badge refresh failed:', e.message); }
            }
            return { sent, badge };
        } catch (err) {
            console.error('[push-gateway] sendBadgeRefresh failed:', err.message);
            return { sent: 0 };
        }
    }

    /** إغلاق المزوّدات (نهاية العملية/الاختبارات). */
    async shutdown() {
        for (const p of this._providers.values()) {
            try { if (p && typeof p.shutdown === 'function') await p.shutdown(); } catch (_) { }
        }
        this._providers.clear();
    }
}

module.exports = PushGateway;
