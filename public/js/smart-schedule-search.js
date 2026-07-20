/* ==========================================
   البحث والفلاتر - Search & Filters
   smart-schedule-search.js
   ========================================== */
(function() {
    'use strict';

    var activeFilters = [];
    var searchResults = [];

    // ==========================================
    // Initialize Search
    // ==========================================
    window.initSearch = function() {
        var searchInput = document.getElementById('searchInput');
        if (!searchInput) return;

        // Add enhanced search container
        var searchSection = document.getElementById('searchSection');
        if (searchSection) {
            var enhanced = document.createElement('div');
            enhanced.className = 'search-enhanced';
            enhanced.id = 'searchEnhanced';
            enhanced.innerHTML = '<div class="search-tags" id="activeSearchTags"></div>';
            searchSection.appendChild(enhanced);
        }

        // Add enhanced filter controls after the existing filters row
        var filterSection = document.querySelector('.filters-row');
        if (filterSection) {
            var clearBtn = document.createElement('div');
            clearBtn.className = 'filter-group';
            clearBtn.style.minWidth = 'auto';
            clearBtn.innerHTML = '<label>&nbsp;</label><button class="btn" onclick="clearFilters()"><i class="fas fa-eraser"></i> مسح الفلاتر</button>';
            filterSection.appendChild(clearBtn);
        }
    };

    // ==========================================
    // Enhanced Handle Search
    // ==========================================
    var originalHandleSearch = window.handleSearch;
    window.handleSearch = function(query) {
        // Call original
        if (originalHandleSearch) originalHandleSearch(query);

        // Also update active search tags
        if (!query || query.trim().length === 0) {
            removeFilterTag('search');
            return;
        }
        addFilterTag('search', 'بحث: ' + query.trim());
    };

    // ==========================================
    // Filter by Employee
    // ==========================================
    window.filterByEmployee = function(name) {
        if (!name) {
            removeFilterTag('employee');
            return;
        }
        addFilterTag('employee', 'موظف: ' + name);
        applyActiveFilters();
    };

    // ==========================================
    // Filter by Team
    // ==========================================
    window.filterByTeam = function(team) {
        if (!team) {
            removeFilterTag('team');
            return;
        }
        addFilterTag('team', 'فريق: ' + team);
        applyActiveFilters();
    };

    // ==========================================
    // Filter by Shift Code
    // ==========================================
    window.filterByShiftCode = function(code) {
        if (!code) {
            removeFilterTag('shift');
            return;
        }
        addFilterTag('shift', 'مناوبة: ' + code);
        applyActiveFilters();
    };

    // ==========================================
    // Filter by Date
    // ==========================================
    window.filterByDate = function(date) {
        if (!date) {
            removeFilterTag('date');
            return;
        }
        addFilterTag('date', 'تاريخ: ' + date);
        applyActiveFilters();
    };

    // ==========================================
    // Clear All Filters
    // ==========================================
    window.clearFilters = function() {
        activeFilters = [];
        var tagsContainer = document.getElementById('activeSearchTags');
        if (tagsContainer) tagsContainer.innerHTML = '';

        // Reset existing filter inputs
        var filterDate = document.getElementById('filterDate');
        if (filterDate) filterDate.value = '';
        var filterMonth = document.getElementById('filterMonth');
        if (filterMonth) filterMonth.value = '';
        var filterLocation = document.getElementById('filterLocation');
        if (filterLocation) filterLocation.value = '';
        var filterShift = document.getElementById('filterShift');
        if (filterShift) filterShift.value = '';
        var filterStatus = document.getElementById('filterStatus');
        if (filterStatus) filterStatus.value = '';
        var searchInput = document.getElementById('searchInput');
        if (searchInput) searchInput.value = '';

        if (typeof applyFilters === 'function') applyFilters();
        if (typeof renderCurrentView === 'function') renderCurrentView();
    };

    // ==========================================
    // Add Filter Tag
    // ==========================================
    function addFilterTag(type, label) {
        removeFilterTag(type);
        activeFilters.push({ type: type, label: label });
        renderFilterTags();
    }

    function removeFilterTag(type) {
        activeFilters = activeFilters.filter(function(f) { return f.type !== type; });
        renderFilterTags();
    }

    function renderFilterTags() {
        var container = document.getElementById('activeSearchTags');
        if (!container) return;
        if (activeFilters.length === 0) {
            container.innerHTML = '';
            return;
        }
        var html = '';
        activeFilters.forEach(function(f) {
            html += '<span class="search-tag" onclick="removeFilterTagByType(\'' + f.type + '\')">' + f.label + ' <span class="remove"><i class="fas fa-times"></i></span></span>';
        });
        container.innerHTML = html;
    }

    window.removeFilterTagByType = function(type) {
        removeFilterTag(type);
        applyActiveFilters();
    };

    // ==========================================
    // Apply Active Filters
    // ==========================================
    function applyActiveFilters() {
        if (typeof employees === 'undefined' || !employees) return;
        var filtered = employees.slice();

        activeFilters.forEach(function(f) {
            if (f.type === 'employee') {
                var name = f.label.replace('موظف: ', '').toLowerCase();
                filtered = filtered.filter(function(e) {
                    return (e.name || '').toLowerCase().includes(name);
                });
            } else if (f.type === 'team') {
                var team = f.label.replace('فريق: ', '').toLowerCase();
                filtered = filtered.filter(function(e) {
                    return (e.team || '').toLowerCase().includes(team);
                });
            } else if (f.type === 'shift') {
                var code = f.label.replace('مناوبة: ', '').toLowerCase();
                filtered = filtered.filter(function(e) {
                    return e.schedule && e.schedule.some(function(s) {
                        return (s.shiftCode || s.shift || '').toLowerCase().includes(code);
                    });
                });
            } else if (f.type === 'date') {
                var date = f.label.replace('تاريخ: ', '');
                filtered = filtered.filter(function(e) {
                    return e.schedule && e.schedule.some(function(s) {
                        return (s.date || '') === date;
                    });
                });
            }
        });

        // Temporarily override employees for rendering
        var originalEmployees = employees;
        window.employees = filtered;
        if (typeof renderCurrentView === 'function') renderCurrentView();
        window.employees = originalEmployees;
    }

    // ==========================================
    // Enhanced Search Results
    // ==========================================
    window.searchEmployees = function(query) {
        if (typeof employees === 'undefined' || !employees) return [];
        query = query.toLowerCase().trim();
        var results = [];
        employees.forEach(function(emp) {
            if ((emp.name || '').toLowerCase().includes(query)) {
                results.push({ type: 'employee', name: emp.name, team: emp.team, id: emp.id });
            }
            if (emp.schedule && emp.schedule.length) {
                emp.schedule.forEach(function(s) {
                    var shiftName = (s.shiftCode || s.shift || '').toLowerCase();
                    var dayName = (s.day || '').toLowerCase();
                    var dateStr = (s.date || '').toLowerCase();
                    if (shiftName.includes(query) || dayName.includes(query) || dateStr.includes(query)) {
                        results.push({
                            type: 'shift',
                            name: emp.name + ' — ' + (s.shiftCode || s.shift),
                            day: s.day,
                            date: s.date,
                            shift: s.shiftCode || s.shift,
                            status: s.status,
                            id: emp.id
                        });
                    }
                });
            }
        });
        // Remove duplicates
        var seen = {};
        return results.filter(function(r) {
            var key = (r.name || '') + '|' + (r.date || '') + '|' + (r.shift || '');
            if (seen[key]) return false;
            seen[key] = true;
            return true;
        });
    };

    // ==========================================
    // Show Employee Schedule Modal
    // ==========================================
    window.showEmployeeScheduleModal = function() {
        var modal = document.getElementById('empScheduleModal');
        if (!modal) return;
        modal.classList.add('active');

        // Populate employee select
        var select = document.getElementById('empScheduleSelect');
        if (select && typeof employees !== 'undefined' && employees) {
            select.innerHTML = '<option value="">اختر موظف...</option>';
            employees.forEach(function(emp) {
                var opt = document.createElement('option');
                opt.value = emp.id || emp.name;
                opt.textContent = emp.name + (emp.team ? ' (' + emp.team + ')' : '');
                select.appendChild(opt);
            });
        }

        // Set default month
        var monthInput = document.getElementById('empScheduleMonth');
        if (monthInput) {
            var now = new Date();
            monthInput.value = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
        }
    };

    window.closeEmpScheduleModal = function() {
        var modal = document.getElementById('empScheduleModal');
        if (modal) modal.classList.remove('active');
    };

    // ==========================================
    // Load Employee Schedule
    // ==========================================
    window.loadEmployeeSchedule = function() {
        var select = document.getElementById('empScheduleSelect');
        var monthInput = document.getElementById('empScheduleMonth');
        var result = document.getElementById('empScheduleResult');
        if (!select || !result) return;

        var employeeId = select.value;
        var monthYear = monthInput ? monthInput.value : '';
        if (!employeeId) {
            if (typeof showToast === 'function') showToast('يرجى اختيار موظف', 'warning');
            return;
        }

        result.innerHTML = '<div class="text-center mt-3"><div class="spinner"></div><span>جاري التحميل...</span></div>';

        var token = localStorage.getItem('auth_access_token') || localStorage.getItem('authToken') || '';
        if (token) {
            var parts = monthYear.split('-');
            var month = parts[1] ? parseInt(parts[1]) : new Date().getMonth() + 1;
            var year = parts[0] ? parseInt(parts[0]) : new Date().getFullYear();

            fetch('/api/shift-roster/employee-schedule/' + encodeURIComponent(employeeId) + '?month=' + month + '&year=' + year, {
                headers: { 'Authorization': 'Bearer ' + token }
            }).then(function(r) { return r.json(); }).then(function(data) {
                if (data.success && data.schedule) {
                    renderEmployeeScheduleGrid(data.schedule, employeeId);
                } else {
                    // Fallback to local data
                    renderLocalEmployeeSchedule(employeeId, monthYear);
                }
            }).catch(function() {
                renderLocalEmployeeSchedule(employeeId, monthYear);
            });
        } else {
            renderLocalEmployeeSchedule(employeeId, monthYear);
        }
    };

    function renderLocalEmployeeSchedule(employeeId, monthYear) {
        if (typeof employees === 'undefined' || !employees) return;
        var emp = employees.find(function(e) { return e.id === employeeId || e.name === employeeId; });
        if (!emp) {
            var result = document.getElementById('empScheduleResult');
            if (result) result.innerHTML = '<div class="text-center mt-3">الموظف غير موجود</div>';
            return;
        }

        var schedule = [];
        if (emp.schedule) {
            emp.schedule.forEach(function(s) {
                schedule.push({
                    date: s.date,
                    shift_code: s.shiftCode || s.shift,
                    shift_name: s.shiftCode || s.shift,
                    team_name: s.location || emp.team || ''
                });
            });
        }
        renderEmployeeScheduleGrid(schedule, employeeId);
    }

    function renderEmployeeScheduleGrid(schedule, employeeId) {
        var result = document.getElementById('empScheduleResult');
        if (!result) return;
        if (!schedule || schedule.length === 0) {
            result.innerHTML = '<div class="text-center mt-3">لا توجد مناوبات</div>';
            return;
        }

        // Summary
        var counts = {};
        schedule.forEach(function(s) {
            var code = s.shift_code || s.shift_name || '—';
            counts[code] = (counts[code] || 0) + 1;
        });

        var summaryHtml = '<div class="schedule-summary">';
        Object.keys(counts).forEach(function(code) {
            var color = getShiftColor(code);
            summaryHtml += '<div class="schedule-summary-item"><span class="dot" style="background:' + color + '"></span> ' + code + ': ' + counts[code] + '</div>';
        });
        summaryHtml += '</div>';

        // Grid
        var days = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
        var gridHtml = '<div class="employee-schedule-grid">';
        days.forEach(function(day) {
            gridHtml += '<div class="schedule-day-card" style="background:#F8FAFC;font-weight:700;font-size:0.85rem;">' + day + '</div>';
        });

        // Fill days - find first day of month
        var firstDay = schedule.length > 0 ? new Date(schedule[0].date) : new Date();
        var startDay = firstDay.getDay(); // 0=Sun in JS, but our array starts with Sunday
        for (var i = 0; i < startDay; i++) {
            gridHtml += '<div class="schedule-day-card" style="opacity:0.3;"><div class="day-number">—</div><div class="shift-badge empty">—</div></div>';
        }

        var dayCount = 0;
        schedule.forEach(function(s) {
            dayCount++;
            var d = s.date ? new Date(s.date) : new Date();
            var code = s.shift_code || s.shift_name || '—';
            var badgeClass = getShiftBadgeClass(code);
            gridHtml += '<div class="schedule-day-card">';
            gridHtml += '<div class="day-number">' + dayCount + '</div>';
            gridHtml += '<div class="shift-badge ' + badgeClass + '">' + code + '</div>';
            if (s.team_name) gridHtml += '<div style="font-size:0.7rem;color:#64748B;margin-top:4px;">' + s.team_name + '</div>';
            gridHtml += '</div>';
        });

        gridHtml += '</div>';
        result.innerHTML = summaryHtml + gridHtml;
    }

    function getShiftColor(code) {
        var colors = {
            'صباحية': '#2563EB',
            'مسائية': '#7C3AED',
            'ليلية': '#64748B',
            'إجازة': '#EF4444',
            'راحة': '#10B981',
            'OFF': '#94A3B8',
            'دوام رسمي': '#059669',
            'تدريب': '#2563EB'
        };
        return colors[code] || '#94A3B8';
    }

    function getShiftBadgeClass(code) {
        var map = {
            'صباحية': 'morning',
            'مسائية': 'evening',
            'ليلية': 'night',
            'إجازة': 'off',
            'راحة': 'rest',
            'OFF': 'off',
            'دوام رسمي': 'rest',
            'تدريب': 'morning'
        };
        return map[code] || 'empty';
    }

    // Close modal on click outside
    document.addEventListener('DOMContentLoaded', function() {
        var modal = document.getElementById('empScheduleModal');
        if (modal) {
            modal.addEventListener('click', function(e) {
                if (e.target === modal) closeEmpScheduleModal();
            });
        }
        initSearch();
    });

})();
