/* ==========================================
   Comparison Logic - shift-comparison.js
   منصة الجنوب - Shift Comparison Modal
   ========================================== */

(function() {
    'use strict';

    function openComparisonModal(shiftA, shiftB) {
        var overlay = document.getElementById('comparisonModal');
        if (!overlay) {
            document.body.insertAdjacentHTML('beforeend',
                '<div class="dashboard-modal-overlay" id="comparisonModal">' +
                '<div class="dashboard-modal-content" style="max-width:960px;">' +
                '<div class="dashboard-modal-header">' +
                '<div class="dashboard-modal-title"><i class="fas fa-balance-scale"></i> مقارنة المناوبات</div>' +
                '<div class="dashboard-modal-actions">' +
                '<button class="dashboard-btn dashboard-btn-primary" onclick="ComparisonModal.close()"><i class="fas fa-times"></i> إغلاق</button>' +
                '</div></div>' +
                '<div class="dashboard-modal-body" id="comparisonModalBody"></div>' +
                '</div></div>'
            );
            overlay = document.getElementById('comparisonModal');
            overlay.addEventListener('click', function(e) { if (e.target === overlay) closeComparisonModal(); });
        }
        renderComparison(shiftA, shiftB);
        overlay.classList.add('active');
    }

    function closeComparisonModal() {
        var el = document.getElementById('comparisonModal');
        if (el) el.classList.remove('active');
    }

    function renderComparison(a, b) {
        var body = document.getElementById('comparisonModalBody');
        if (!body) return;
        var fields = [
            { key: 'date', label: 'التاريخ' },
            { key: 'shift_type', label: 'نوع المناوبة' },
            { key: 'supervisor', label: 'المشرف' },
            { key: 'total_reports', label: 'إجمالي البلاغات' },
            { key: 'completed_reports', label: 'البلاغات المنجزة' },
            { key: 'pending_reports', label: 'البلاغات المعلقة' },
            { key: 'completion_rate', label: 'نسبة الإنجاز' },
            { key: 'staff_count', label: 'عدد الموظفين' },
            { key: 'team_count', label: 'عدد الفرق' },
            { key: 'vehicle_count', label: 'عدد المركبات' },
            { key: 'avg_response_time', label: 'متوسط وقت الاستجابة' },
            { key: 'critical_cases', label: 'الحالات الحرجة' },
            { key: 'health_score', label: 'درجة الصحة' }
        ];

        var html = '<div class="comparison-grid">';
        html += '<div class="comparison-column">';
        html += '<div class="comparison-column-title a"><i class="fas fa-calendar-day"></i> ' + (a.date || '-') + ' (المناوبة أ)</div>';
        fields.forEach(function(f) {
            var val = a[f.key];
            if (f.key === 'completion_rate' || f.key === 'health_score') val = (val || 0) + '%';
            html += '<div class="comparison-row"><span class="comparison-label">' + f.label + '</span><span class="comparison-value">' + (val || '-') + '</span></div>';
        });
        html += '</div>';

        html += '<div class="comparison-column">';
        html += '<div class="comparison-column-title b"><i class="fas fa-calendar-day"></i> ' + (b.date || '-') + ' (المناوبة ب)</div>';
        fields.forEach(function(f) {
            var av = a[f.key] || 0;
            var bv = b[f.key] || 0;
            var diff = 0;
            var diffHtml = '';
            if (typeof av === 'number' && typeof bv === 'number') {
                diff = bv - av;
                var diffClass = diff > 0 ? 'positive' : diff < 0 ? 'negative' : 'neutral';
                var diffIcon = diff > 0 ? 'fa-arrow-up' : diff < 0 ? 'fa-arrow-down' : 'fa-minus';
                diffHtml = '<span class="comparison-diff ' + diffClass + '"><i class="fas ' + diffIcon + '"></i> ' + Math.abs(diff) + '</span>';
            }
            var val = b[f.key];
            if (f.key === 'completion_rate' || f.key === 'health_score') val = (val || 0) + '%';
            html += '<div class="comparison-row"><span class="comparison-label">' + f.label + '</span><span class="comparison-value">' + (val || '-') + ' ' + diffHtml + '</span></div>';
        });
        html += '</div>';
        html += '</div>';

        body.innerHTML = html;
    }

    function compareTwoShifts(shiftAId, shiftBId) {
        if (!shiftAId || !shiftBId) {
            DashUtils.showToast('يرجى اختيار مناوبتين للمقارنة', 'warning');
            return Promise.reject('Missing IDs');
        }
        return Promise.all([
            DashUtils.apiFetch('/api/shifts/' + shiftAId + '/detail').then(function(r) { return r.json(); }),
            DashUtils.apiFetch('/api/shifts/' + shiftBId + '/detail').then(function(r) { return r.json(); })
        ]).then(function(results) {
            var ad = results[0];
            var bd = results[1];
            if (!ad || !ad.shift) throw new Error('بيانات المناوبة الأولى غير متوفرة');
            if (!bd || !bd.shift) throw new Error('بيانات المناوبة الثانية غير متوفرة');
            var metricsA = ad.metrics || {};
            var metricsB = bd.metrics || {};
            var a = Object.assign({ date: ad.shift.date, shift_type: ad.shift.shift_type, supervisor: ad.shift.supervisor }, metricsA);
            var b = Object.assign({ date: bd.shift.date, shift_type: bd.shift.shift_type, supervisor: bd.shift.supervisor }, metricsB);
            openComparisonModal(a, b);
            return { a: a, b: b };
        }).catch(function(err) {
            DashUtils.showToast('فشل في تحميل بيانات المقارنة: ' + err.message, 'error');
            throw err;
        });
    }

    window.ComparisonModal = {
        open: openComparisonModal,
        close: closeComparisonModal,
        compare: compareTwoShifts
    };
})();
