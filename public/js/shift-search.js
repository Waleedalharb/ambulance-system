/* ==========================================
   Search & Filters - shift-search.js
   منصة الجنوب - Archive Search Logic
   ========================================== */

(function() {
    'use strict';

    var activeFilters = {};

    function setFilter(key, value) {
        if (value === '' || value === null || value === undefined) {
            delete activeFilters[key];
        } else {
            activeFilters[key] = value;
        }
    }

    function getFilter(key) {
        return activeFilters[key];
    }

    function getAllFilters() {
        return Object.assign({}, activeFilters);
    }

    function clearFilter(key) {
        delete activeFilters[key];
    }

    function clearAllFilters() {
        activeFilters = {};
    }

    function buildQueryString(baseUrl) {
        var params = [];
        Object.keys(activeFilters).forEach(function(key) {
            if (activeFilters[key] !== '') {
                params.push(encodeURIComponent(key) + '=' + encodeURIComponent(activeFilters[key]));
            }
        });
        return baseUrl + (baseUrl.indexOf('?') >= 0 ? '&' : '?') + params.join('&');
    }

    function buildArchiveQuery(page, limit) {
        var params = [];
        Object.keys(activeFilters).forEach(function(key) {
            if (activeFilters[key] !== '') {
                params.push(encodeURIComponent(key) + '=' + encodeURIComponent(activeFilters[key]));
            }
        });
        params.push('page=' + (page || 1));
        params.push('limit=' + (limit || 20));
        return '/api/shifts/archive?' + params.join('&');
    }

    function buildSearchQuery(limit) {
        var params = [];
        Object.keys(activeFilters).forEach(function(key) {
            if (activeFilters[key] !== '') {
                params.push(encodeURIComponent(key) + '=' + encodeURIComponent(activeFilters[key]));
            }
        });
        params.push('limit=' + (limit || 50));
        return '/api/shifts/search?' + params.join('&');
    }

    function renderFilterTags(containerId, onRemove) {
        var container = document.getElementById(containerId);
        if (!container) return;
        var labels = {
            date_from: 'من تاريخ',
            date_to: 'إلى تاريخ',
            shift_type: 'نوع المناوبة',
            center: 'المركز',
            supervisor: 'المشرف',
            employee: 'الموظف',
            report_id: 'رقم البلاغ',
            status: 'الحالة',
            q: 'بحث'
        };
        var html = '';
        Object.keys(activeFilters).forEach(function(key) {
            var val = activeFilters[key];
            if (val === '' || val === null || val === undefined) return;
            var label = labels[key] || key;
            html += '<span class="filter-tag" data-key="' + key + '">' + label + ': ' + val + ' <i class="fas fa-times"></i></span>';
        });
        if (Object.keys(activeFilters).length > 0) {
            html += '<button class="filter-tag-clear">مسح الكل</button>';
        }
        container.innerHTML = html;

        container.querySelectorAll('.filter-tag').forEach(function(tag) {
            tag.addEventListener('click', function() {
                var key = this.getAttribute('data-key');
                clearFilter(key);
                renderFilterTags(containerId, onRemove);
                if (onRemove) onRemove(key);
            });
        });
        var clearBtn = container.querySelector('.filter-tag-clear');
        if (clearBtn) {
            clearBtn.addEventListener('click', function() {
                clearAllFilters();
                renderFilterTags(containerId, onRemove);
                if (onRemove) onRemove('all');
            });
        }
    }

    function syncFiltersFromForm(formId) {
        var form = document.getElementById(formId);
        if (!form) return;
        var inputs = form.querySelectorAll('input, select');
        inputs.forEach(function(input) {
            if (input.name) {
                setFilter(input.name, input.value);
            }
        });
    }

    function syncFormFromFilters(formId) {
        var form = document.getElementById(formId);
        if (!form) return;
        Object.keys(activeFilters).forEach(function(key) {
            var el = form.querySelector('[name="' + key + '"]');
            if (el) el.value = activeFilters[key];
        });
    }

    window.SearchFilters = {
        setFilter: setFilter,
        getFilter: getFilter,
        getAllFilters: getAllFilters,
        clearFilter: clearFilter,
        clearAllFilters: clearAllFilters,
        buildQueryString: buildQueryString,
        buildArchiveQuery: buildArchiveQuery,
        buildSearchQuery: buildSearchQuery,
        renderFilterTags: renderFilterTags,
        syncFiltersFromForm: syncFiltersFromForm,
        syncFormFromFilters: syncFormFromFilters
    };
})();
