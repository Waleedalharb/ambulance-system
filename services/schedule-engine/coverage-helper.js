/**
 * ═══ services/schedule-engine/coverage-helper.js — غلاف توافق E-2 (FSS E-4) ═══
 *
 * كان مهايئ M2 المحدود (E-2). منذ E-4 أصبح coverage-service.js هو المصدر
 * الموحد الوحيد لمنطق التغطية (شرط المالك 2026-10-06: إزالة الازدواجية دون
 * كسر E-2) وهذا الملف غلاف رقيق يحفظ عقد E-2 (assessRemovalImpact + periodOf)
 * بتفويض كامل — لا يحتوي أي منطق تغطية بعد الآن. لا تحذفه ما دام
 * unable-attend-service.js يستورده.
 */
'use strict';

const { assessRemovalImpact, periodOf } = require('./coverage-service.js');

module.exports = { assessRemovalImpact, periodOf };
