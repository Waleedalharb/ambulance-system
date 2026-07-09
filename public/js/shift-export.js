/* ==========================================
   Export Logic - shift-export.js
   منصة الجنوب - Dashboard Export Helpers
   ========================================== */

(function() {
    'use strict';

    function exportDashboardToPDF(dashboardId, filename) {
        if (!window.html2pdf) {
            DashUtils.showToast('مكتبة PDF غير متوفرة', 'error');
            return;
        }
        var element = document.getElementById(dashboardId);
        if (!element) {
            DashUtils.showToast('العنصر غير موجود', 'error');
            return;
        }
        var opt = {
            margin: 0.5,
            filename: (filename || 'dashboard') + '.pdf',
            image: { type: 'jpeg', quality: 0.98 },
            html2canvas: { scale: 2, useCORS: true },
            jsPDF: { unit: 'in', format: 'a4', orientation: 'landscape' }
        };
        DashUtils.showToast('جاري إنشاء ملف PDF...', 'info');
        html2pdf().set(opt).from(element).save().then(function() {
            DashUtils.showToast('تم التصدير إلى PDF بنجاح', 'success');
        }).catch(function() {
            DashUtils.showToast('فشل في تصدير PDF', 'error');
        });
    }

    function exportTableToExcel(rows, headers, filename, sheetName) {
        if (!window.XLSX) {
            DashUtils.showToast('مكتبة Excel غير متوفرة', 'error');
            return;
        }
        var data = rows.map(function(row) {
            var obj = {};
            headers.forEach(function(h) {
                obj[h.label] = row[h.key] || '';
            });
            return obj;
        });
        var ws = XLSX.utils.json_to_sheet(data);
        var wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, sheetName || 'Sheet1');
        XLSX.writeFile(wb, (filename || 'export') + '.xlsx');
        DashUtils.showToast('تم التصدير إلى Excel بنجاح', 'success');
    }

    function exportShiftsToExcel(shifts) {
        if (!window.XLSX) {
            DashUtils.showToast('مكتبة Excel غير متوفرة', 'error');
            return;
        }
        var headers = [
            { key: 'id', label: 'المعرف' },
            { key: 'date', label: 'التاريخ' },
            { key: 'shift_type', label: 'نوع المناوبة' },
            { key: 'supervisor', label: 'المشرف' },
            { key: 'total_reports', label: 'إجمالي البلاغات' },
            { key: 'completed_reports', label: 'المنجزة' },
            { key: 'pending_reports', label: 'المعلقة' },
            { key: 'completion_rate', label: 'نسبة الإنجاز' },
            { key: 'staff_count', label: 'الموظفين' },
            { key: 'health_score', label: 'درجة الصحة' }
        ];
        exportTableToExcel(shifts, headers, 'shifts_export', 'المناوبات');
    }

    function exportAlertsToExcel(alerts) {
        if (!window.XLSX) {
            DashUtils.showToast('مكتبة Excel غير متوفرة', 'error');
            return;
        }
        var headers = [
            { key: 'id', label: 'المعرف' },
            { key: 'alert_type', label: 'نوع التنبيه' },
            { key: 'severity', label: 'الخطورة' },
            { key: 'message', label: 'الرسالة' },
            { key: 'shift_id', label: 'المناوبة' },
            { key: 'created_at', label: 'التاريخ' }
        ];
        exportTableToExcel(alerts, headers, 'alerts_export', 'التنبيهات');
    }

    function downloadReport(reportId) {
        return DashUtils.apiFetch('/api/shifts/reports/' + reportId).then(function(resp) {
            return resp.json();
        }).then(function(data) {
            if (data && data.file_path) {
                window.open(data.file_path, '_blank');
            } else {
                DashUtils.showToast('مسار التقرير غير متوفر', 'error');
            }
        }).catch(function() {
            DashUtils.showToast('فشل في تحميل التقرير', 'error');
        });
    }

    function requestReport(type, dateFrom, dateTo) {
        return DashUtils.apiFetch('/api/shifts/reports/generate', {
            method: 'POST',
            body: JSON.stringify({ type: type, date_from: dateFrom, date_to: dateTo })
        }).then(function(resp) { return resp.json(); }).then(function(data) {
            if (data && data.success) {
                DashUtils.showToast('تم إنشاء التقرير بنجاح', 'success');
                return data;
            } else {
                throw new Error(data.error || 'فشل في إنشاء التقرير');
            }
        }).catch(function(err) {
            DashUtils.showToast(err.message || 'فشل في إنشاء التقرير', 'error');
            throw err;
        });
    }

    window.ExportUtils = {
        exportDashboardToPDF: exportDashboardToPDF,
        exportTableToExcel: exportTableToExcel,
        exportShiftsToExcel: exportShiftsToExcel,
        exportAlertsToExcel: exportAlertsToExcel,
        downloadReport: downloadReport,
        requestReport: requestReport
    };
})();
