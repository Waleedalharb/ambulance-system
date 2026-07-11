/* ==========================================
   Shared Dashboard Logic - shift-dashboard.js
   منصة الجنوب - Dashboard Common Functions
   ========================================== */

(function() {
    'use strict';

    // ==========================================
    // Auth & API Helpers
    // ==========================================
    function getToken() {
        return localStorage.getItem('authToken') || sessionStorage.getItem('authToken') || localStorage.getItem('token') || sessionStorage.getItem('token') || '';
    }

    function getUser() {
        try {
            return JSON.parse(localStorage.getItem('currentUser') || sessionStorage.getItem('currentUser') || localStorage.getItem('user') || sessionStorage.getItem('user') || '{}');
        } catch (e) {
            return {};
        }
    }

    function apiFetch(url, options) {
        const token = getToken();
        const opts = Object.assign({}, options || {}, {
            headers: Object.assign({
                'Authorization': 'Bearer ' + token,
                'Content-Type': 'application/json'
            }, (options && options.headers) || {})
        });
        return fetch(url, opts).then(function(resp) {
            if (resp.status === 401) {
                showToast('جلسة العمل منتهية، يرجى تسجيل الدخول', 'error');
                throw new Error('Unauthorized');
            }
            return resp;
        });
    }

    // ==========================================
    // Toast Notifications
    // ==========================================
    function showToast(message, type) {
        type = type || 'info';
        var container = document.querySelector('.toast-container');
        if (!container) {
            container = document.createElement('div');
            container.className = 'toast-container';
            document.body.appendChild(container);
        }
        var toast = document.createElement('div');
        toast.className = 'toast ' + type;
        var icon = type === 'success' ? 'fa-check-circle' : type === 'error' ? 'fa-exclamation-circle' : 'fa-info-circle';
        toast.innerHTML = '<i class="fas ' + icon + '"></i> ' + message;
        container.appendChild(toast);
        setTimeout(function() { toast.remove(); }, 3000);
    }

    // ==========================================
    // Cache Helpers
    // ==========================================
    function cacheSet(key, data, ttlSeconds) {
        ttlSeconds = ttlSeconds || 300;
        try {
            var item = { data: data, expires: Date.now() + (ttlSeconds * 1000) };
            localStorage.setItem('dash_cache_' + key, JSON.stringify(item));
        } catch (e) {}
    }

    function cacheGet(key) {
        try {
            var raw = localStorage.getItem('dash_cache_' + key);
            if (!raw) return null;
            var item = JSON.parse(raw);
            if (Date.now() > item.expires) {
                localStorage.removeItem('dash_cache_' + key);
                return null;
            }
            return item.data;
        } catch (e) { return null; }
    }

    function cacheClear() {
        try {
            Object.keys(localStorage).forEach(function(k) {
                if (k.indexOf('dash_cache_') === 0) localStorage.removeItem(k);
            });
        } catch (e) {}
    }

    // ==========================================
    // Date Helpers
    // ==========================================
    function todayStr() {
        var d = new Date();
        return d.toISOString().split('T')[0];
    }

    function formatDate(dateStr) {
        if (!dateStr) return '-';
        // Handle Saudi format like "3/7/2026" → "2026-07-03"
        var parts = dateStr.split('/');
        if (parts.length === 3) {
            var d = new Date(parseInt(parts[2], 10), parseInt(parts[1], 10) - 1, parseInt(parts[0], 10));
            if (!isNaN(d.getTime())) return d.toLocaleDateString('ar-SA', { year: 'numeric', month: 'long', day: 'numeric' });
        }
        var d = new Date(dateStr);
        if (isNaN(d.getTime())) return dateStr;
        return d.toLocaleDateString('ar-SA', { year: 'numeric', month: 'long', day: 'numeric' });
    }

    function formatDateTime(dateStr) {
        if (!dateStr) return '-';
        // Handle ISO or Saudi format
        var d = new Date(dateStr);
        if (isNaN(d.getTime())) return dateStr;
        return d.toLocaleDateString('ar-SA', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    }

    function getWeekStart(date) {
        var d = date ? new Date(date) : new Date();
        var day = d.getDay();
        var diff = d.getDate() - day + (day === 0 ? -6 : 1);
        var start = new Date(d.setDate(diff));
        return start.toISOString().split('T')[0];
    }

    function getWeekEnd(weekStart) {
        var d = new Date(weekStart);
        d.setDate(d.getDate() + 6);
        return d.toISOString().split('T')[0];
    }

    function getMonthStart(date) {
        var d = date ? new Date(date) : new Date();
        return d.toISOString().slice(0, 7) + '-01';
    }

    function getMonthEnd(date) {
        var d = date ? new Date(date) : new Date();
        d.setMonth(d.getMonth() + 1);
        d.setDate(0);
        return d.toISOString().split('T')[0];
    }

    function addDays(dateStr, days) {
        var d = new Date(dateStr);
        d.setDate(d.getDate() + days);
        return d.toISOString().split('T')[0];
    }

    function monthName(monthIndex) {
        var names = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
        return names[monthIndex] || '';
    }

    function dayName(dayIndex) {
        var names = ['الأحد','الإثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
        return names[dayIndex] || '';
    }

    // ==========================================
    // KPI Card Rendering
    // ==========================================
    function renderKpiCard(container, icon, value, label, colorClass, change, changeLabel) {
        colorClass = colorClass || 'blue';
        var changeHtml = '';
        if (change !== undefined && change !== null) {
            var changeClass = change > 0 ? 'up' : change < 0 ? 'down' : 'neutral';
            var changeIcon = change > 0 ? 'fa-arrow-up' : change < 0 ? 'fa-arrow-down' : 'fa-minus';
            changeHtml = '<div class="kpi-change ' + changeClass + '"><i class="fas ' + changeIcon + '"></i> ' + Math.abs(change) + '% ' + (changeLabel || '') + '</div>';
        }
        var html = '<div class="kpi-card ' + colorClass + ' fade-in">' +
            '<div class="kpi-icon ' + colorClass + '"><i class="fas ' + icon + '"></i></div>' +
            '<div class="kpi-value">' + value + '</div>' +
            '<div class="kpi-label">' + label + '</div>' +
            changeHtml +
            '</div>';
        container.insertAdjacentHTML('beforeend', html);
    }

    function clearKpiCards(container) {
        container.innerHTML = '';
    }

    // ==========================================
    // Pagination
    // ==========================================
    function renderPagination(container, currentPage, totalPages, onPageChange) {
        if (totalPages <= 1) { container.innerHTML = ''; return; }
        var html = '<div class="pagination">';
        html += '<button class="pagination-btn" ' + (currentPage <= 1 ? 'disabled' : '') + ' onclick="window._pageChange(' + (currentPage - 1) + ')"><i class="fas fa-chevron-right"></i></button>';
        for (var i = 1; i <= totalPages; i++) {
            if (i === 1 || i === totalPages || (i >= currentPage - 1 && i <= currentPage + 1)) {
                html += '<button class="pagination-btn ' + (i === currentPage ? 'active' : '') + '" onclick="window._pageChange(' + i + ')">' + i + '</button>';
            } else if (i === currentPage - 2 || i === currentPage + 2) {
                html += '<span class="pagination-info">...</span>';
            }
        }
        html += '<button class="pagination-btn" ' + (currentPage >= totalPages ? 'disabled' : '') + ' onclick="window._pageChange(' + (currentPage + 1) + ')"><i class="fas fa-chevron-left"></i></button>';
        html += '</div>';
        container.innerHTML = html;
        window._pageChange = function(p) { onPageChange(p); };
    }

    // ==========================================
    // Spinner
    // ==========================================
    function showSpinner(container) {
        container.innerHTML = '<div class="spinner-container"><div class="spinner"></div><span>جاري التحميل...</span></div>';
    }

    function showEmpty(container, message) {
        container.innerHTML = '<div class="empty-state"><i class="fas fa-inbox"></i><h3>' + (message || 'لا توجد بيانات') + '</h3></div>';
    }

    // ==========================================
    // Modal Helpers
    // ==========================================
    function openModal(modalId) {
        var el = document.getElementById(modalId);
        if (el) el.classList.add('active');
    }

    function closeModal(modalId) {
        var el = document.getElementById(modalId);
        if (el) el.classList.remove('active');
    }

    // ==========================================
    // Export to Excel
    // ==========================================
    function exportToExcel(data, filename, sheetName) {
        if (!window.XLSX) { showToast('مكتبة Excel غير متوفرة', 'error'); return; }
        var ws = XLSX.utils.json_to_sheet(data);
        var wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, sheetName || 'Sheet1');
        XLSX.writeFile(wb, filename + '.xlsx');
        showToast('تم التصدير إلى Excel بنجاح', 'success');
    }

    // ==========================================
    // Export to PDF
    // ==========================================
    function exportToPDF(elementId, filename) {
        if (!window.html2pdf) { showToast('مكتبة PDF غير متوفرة', 'error'); return; }
        var element = document.getElementById(elementId);
        if (!element) { showToast('العنصر غير موجود', 'error'); return; }
        var opt = {
            margin: 0.5,
            filename: filename + '.pdf',
            image: { type: 'jpeg', quality: 0.98 },
            html2canvas: { scale: 2, useCORS: true },
            jsPDF: { unit: 'in', format: 'a4', orientation: 'landscape' }
        };
        html2pdf().set(opt).from(element).save().then(function() {
            showToast('تم التصدير إلى PDF بنجاح', 'success');
        }).catch(function() {
            showToast('فشل في تصدير PDF', 'error');
        });
    }

    // ==========================================
    // Live Clock
    // ==========================================
    function initLiveClock(elementId) {
        var el = document.getElementById(elementId);
        if (!el) return;
        function update() {
            var now = new Date();
            el.textContent = now.toLocaleString('ar-SA', {
                hour: '2-digit', minute: '2-digit', second: '2-digit',
                year: 'numeric', month: '2-digit', day: '2-digit'
            });
        }
        update();
        setInterval(update, 1000);
    }

    // ==========================================
    // Auth Check
    // ==========================================
    function checkAuth() {
        var token = getToken();
        if (!token) {
            showToast('يرجى تسجيل الدخول', 'error');
            setTimeout(function() { window.location.href = '/'; }, 1500);
            return false;
        }
        return true;
    }

    function isAdmin() {
        var user = getUser();
        return user.role === 'admin' || user.role === 'director' || user.role === 'مدير' || user.role === 'مدير عمليات';
    }

    // ==========================================
    // Navigation
    // ==========================================
    function goToShiftDetail(shiftId) {
        window.location.href = '/shift-detail.html?id=' + shiftId;
    }

    // ==========================================
    // Number formatting
    // ==========================================
    function formatNumber(n) {
        if (n === null || n === undefined || isNaN(n)) return '0';
        return Number(n).toLocaleString('ar-SA');
    }

    function formatPercent(n) {
        if (n === null || n === undefined || isNaN(n)) return '0%';
        return Number(n).toFixed(1) + '%';
    }

    // ==========================================
    // Expose globals
    // ==========================================
    window.DashUtils = {
        getToken: getToken,
        getUser: getUser,
        apiFetch: apiFetch,
        showToast: showToast,
        cacheSet: cacheSet,
        cacheGet: cacheGet,
        cacheClear: cacheClear,
        todayStr: todayStr,
        formatDate: formatDate,
        formatDateTime: formatDateTime,
        getWeekStart: getWeekStart,
        getWeekEnd: getWeekEnd,
        getMonthStart: getMonthStart,
        getMonthEnd: getMonthEnd,
        addDays: addDays,
        monthName: monthName,
        dayName: dayName,
        renderKpiCard: renderKpiCard,
        clearKpiCards: clearKpiCards,
        renderPagination: renderPagination,
        showSpinner: showSpinner,
        showEmpty: showEmpty,
        openModal: openModal,
        closeModal: closeModal,
        exportToExcel: exportToExcel,
        exportToPDF: exportToPDF,
        initLiveClock: initLiveClock,
        checkAuth: checkAuth,
        isAdmin: isAdmin,
        goToShiftDetail: goToShiftDetail,
        formatNumber: formatNumber,
        formatPercent: formatPercent
    };
})();
