/* ==========================================
   shift-export.js
   Export Helpers (PDF / Excel)
   منصة الجنوب - Ambulance Dispatch Platform
   ========================================== */

(function(window) {
    'use strict';

    var ShiftExport = {};

    // ==========================================
    // Export HTML Element to PDF
    // ==========================================
    ShiftExport.exportElementToPDF = function(elementId, filename) {
        var element = document.getElementById(elementId);
        if (!element) {
            showShiftToast('عنصر التصدير غير موجود', 'error');
            return Promise.reject(new Error('Element not found'));
        }

        var options = {
            margin: [10, 10, 10, 10],
            filename: filename || 'export.pdf',
            image: { type: 'jpeg', quality: 0.95 },
            html2canvas: { scale: 2, useCORS: true, logging: false },
            jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
        };

        return html2pdf().set(options).from(element).save()
            .then(function() {
                showShiftToast('تم التصدير بنجاح', 'success');
            })
            .catch(function(err) {
                showShiftToast('فشل في تصدير PDF', 'error');
                console.error('PDF export error:', err);
                throw err;
            });
    };

    // ==========================================
    // Export Data to Excel
    // ==========================================
    ShiftExport.exportToExcel = function(data, filename, sheetName) {
        if (!data || data.length === 0) {
            showShiftToast('لا توجد بيانات للتصدير', 'error');
            return Promise.reject(new Error('No data'));
        }

        try {
            var ws = XLSX.utils.json_to_sheet(data);
            var wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, sheetName || 'Sheet1');
            XLSX.writeFile(wb, filename || 'export.xlsx');
            showShiftToast('تم تصدير Excel بنجاح', 'success');
            return Promise.resolve();
        } catch (err) {
            showShiftToast('فشل في تصدير Excel', 'error');
            console.error('Excel export error:', err);
            throw err;
        }
    };

    // ==========================================
    // Export Shift Detail to PDF
    // ==========================================
    ShiftExport.exportShiftDetailToPDF = function(shiftId) {
        var container = document.getElementById('shiftDetailContainer');
        if (!container) {
            showShiftToast('الصفحة غير جاهزة للتصدير', 'error');
            return Promise.reject(new Error('Container not found'));
        }

        var filename = 'shift_detail_' + shiftId + '_' + new Date().toISOString().split('T')[0] + '.pdf';
        return ShiftExport.exportElementToPDF('shiftDetailContainer', filename);
    };

    // ==========================================
    // Export Shift Detail to Excel
    // ==========================================
    ShiftExport.exportShiftDetailToExcel = function(shiftData) {
        if (!shiftData) {
            showShiftToast('لا توجد بيانات للتصدير', 'error');
            return Promise.reject(new Error('No shift data'));
        }

        var sheets = {};

        // Sheet 1: Shift Info
        sheets['معلومات المناوبة'] = [{
            'معرف المناوبة': shiftData.shift ? shiftData.shift.id : '',
            'التاريخ': shiftData.shift ? shiftData.shift.date : '',
            'نوع المناوبة': shiftData.shift ? shiftData.shift.shift_type : '',
            'المشرف': shiftData.shift ? shiftData.shift.supervisor : '',
            'المركز': shiftData.shift ? shiftData.shift.center : '',
            'معدل الإنجاز': shiftData.metrics ? shiftData.metrics.completion_rate + '%' : '0%',
            'النتيجة الصحية': shiftData.metrics ? shiftData.metrics.health_score : 0
        }];

        // Sheet 2: Reports
        sheets['البلاغات'] = (shiftData.reports || []).map(function(r) {
            return {
                'معرف البلاغ': r.id || '',
                'النوع': r.report_type || '',
                'الحالة': r.status || '',
                'الوقت': r.created_at || '',
                'الموقع': r.location || ''
            };
        });
        if (sheets['البلاغات'].length === 0) sheets['البلاغات'] = [{ 'ملاحظة': 'لا توجد بلاغات' }];

        // Sheet 3: Staff
        sheets['الكادر'] = (shiftData.staff || []).map(function(s) {
            return {
                'الاسم': s.name || '',
                'الدور': s.role || '',
                'الفريق': s.team || '',
                'الحالة': s.status || ''
            };
        });
        if (sheets['الكادر'].length === 0) sheets['الكادر'] = [{ 'ملاحظة': 'لا يوجد كادر مسجل' }];

        // Sheet 4: Metrics
        if (shiftData.metrics) {
            sheets['المؤشرات'] = [{
                'إجمالي البلاغات': shiftData.metrics.total_reports || 0,
                'المكتملة': shiftData.metrics.completed_reports || 0,
                'المعلقة': shiftData.metrics.pending_reports || 0,
                'المعلقة مؤقتاً': shiftData.metrics.suspended_reports || 0,
                'معدل الإنجاز': shiftData.metrics.completion_rate || 0,
                'عدد الكادر': shiftData.metrics.staff_count || 0,
                'عدد الفرق': shiftData.metrics.team_count || 0,
                'عدد المركبات': shiftData.metrics.vehicle_count || 0,
                'الحالات الحرجة': shiftData.metrics.critical_cases || 0
            }];
        }

        try {
            var wb = XLSX.utils.book_new();
            Object.keys(sheets).forEach(function(sheetName) {
                var ws = XLSX.utils.json_to_sheet(sheets[sheetName]);
                XLSX.utils.book_append_sheet(wb, ws, sheetName);
            });
            var filename = 'shift_detail_' + (shiftData.shift ? shiftData.shift.id : 'export') + '_' + new Date().toISOString().split('T')[0] + '.xlsx';
            XLSX.writeFile(wb, filename);
            showShiftToast('تم تصدير Excel بنجاح', 'success');
            return Promise.resolve();
        } catch (err) {
            showShiftToast('فشل في تصدير Excel', 'error');
            console.error('Excel export error:', err);
            throw err;
        }
    };

    // ==========================================
    // Export Table Data to Excel
    // ==========================================
    ShiftExport.exportTableToExcel = function(tableId, filename) {
        var table = document.getElementById(tableId);
        if (!table) {
            showShiftToast('الجدول غير موجود', 'error');
            return Promise.reject(new Error('Table not found'));
        }

        try {
            var wb = XLSX.utils.table_to_book(table, { sheet: 'Sheet1' });
            XLSX.writeFile(wb, filename || 'table_export.xlsx');
            showShiftToast('تم تصدير الجدول بنجاح', 'success');
            return Promise.resolve();
        } catch (err) {
            showShiftToast('فشل في تصدير الجدول', 'error');
            console.error('Table export error:', err);
            throw err;
        }
    };

    // ==========================================
    // Helpers
    // ==========================================
    function showShiftToast(message, type) {
        if (typeof showToast === 'function') {
            showToast(message, type);
        } else {
            var container = document.getElementById('toastContainer');
            if (!container) return;
            var toast = document.createElement('div');
            toast.className = 'toast ' + type;
            var icon = type === 'success' ? 'fa-check-circle' : type === 'error' ? 'fa-exclamation-circle' : 'fa-info-circle';
            toast.innerHTML = '<i class="fas ' + icon + '"></i><span>' + message + '</span>';
            container.appendChild(toast);
            setTimeout(function() { toast.remove(); }, 3000);
        }
    }

    // Expose to window
    window.ShiftExport = ShiftExport;

})(window);
