/**
 * ArchiveService — المسار الواحد للأرشفة (Archive Contract §2)
 * ═══════════════════════════════════════════════════════════
 * Every transition to ARCHIVED goes through here — no exceptions except the
 * documented /api/emergency/* escape hatches:
 *   handover-approve · manual /api/shift-archive · direct /api/shift/:id/archive
 *   · auto-archive of the previous shift inside startShift
 *
 * Pipeline (atomic from the caller's perspective — status changes LAST):
 *   1. Seal snapshot via the archive engine (validate → collect → hash →
 *      store → verify). Failure aborts BEFORE any status change.
 *   2. Archive this shift's conversations (explicit shift_id link — general
 *      conversations with NULL are never touched).
 *   3. Status transition + audit + ShiftArchived event via ShiftService.
 *
 * Re-running archive() on an already-archived shift is safe: it re-seals and
 * re-marks (used for the auto-archive path where ShiftManager already flipped
 * the status before the seal existed).
 */

class ArchiveService {
    /**
     * @param {Object} deps
     * @param {Object} deps.archiveEngine - ShiftArchiveEngine (seal machinery)
     * @param {Object} deps.shiftService  - ShiftService (status ownership)
     * @param {Object} deps.storage       - StorageAdapter
     * @param {Object} deps.db            - db module (chat_conversations writes)
     */
    constructor({ archiveEngine, shiftService, storage, db }) {
        this.archiveEngine = archiveEngine;
        this.shiftService = shiftService;
        this.storage = storage;
        this.db = db;
    }

    /**
     * @param {number} shiftId
     * @param {Object} user
     * @param {Object} options - { reason, strict, source }
     */
    async archive(shiftId, user, { reason = '', strict = false, source = 'manual' } = {}) {
        shiftId = parseInt(shiftId);
        const shift = await this.storage.getShiftById(shiftId);
        if (!shift) return { success: false, error: 'المناوبة غير موجودة' };

        // 1. Seal (fails → abort before status change)
        const archiveResult = await this.archiveEngine.executeArchive(shiftId, {
            user,
            strict,
            skipVerify: false,
            snapshotType: source === 'auto' ? 'auto' : 'manual'
        });
        if (!archiveResult || archiveResult.success === false) {
            return {
                success: false,
                error: 'فشل إنشاء لقطة الأرشفة',
                detail: archiveResult && (archiveResult.error || archiveResult.message)
            };
        }

        // 2. Archive this shift's conversations (D-6 + explicit link)
        try {
            await this.db.run('UPDATE chat_conversations SET is_archived = 1 WHERE shift_id = ?', [shiftId]);
        } catch (err) {
            console.error('[ArchiveService] Conversation archiving failed:', err.message);
            // Non-fatal: the seal already captured their messages; flagging is
            // a view concern and can be re-applied on the next archive run.
        }

        // 3. Status transition (audit + ShiftArchived broadcast via event)
        const marked = await this.shiftService.markArchived(
            shiftId,
            user,
            archiveResult.snapshotHash,
            reason || `أرشفة المناوبة (${source})`
        );
        if (!marked.success) return marked;

        return {
            success: true,
            shiftId,
            snapshotHash: archiveResult.snapshotHash,
            duration: archiveResult.duration,
            phases: archiveResult.phases,
            source
        };
    }
}

module.exports = ArchiveService;
