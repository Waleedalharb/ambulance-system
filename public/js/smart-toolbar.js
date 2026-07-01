// demo-v3c Smart UI Scripts
// تفاعل Smart Topbar + Sidebar + Operations Room Modal

(function() {
    // Sidebar Toggle
    const sidebar = document.getElementById('smartSidebar');
    const sidebarOverlay = document.getElementById('sidebarOverlay');
    const sidebarToggle = document.getElementById('sidebarToggle');
    const sidebarClose = document.getElementById('sidebarClose');

    function toggleSidebar() {
        if (!sidebar) return;
        sidebar.classList.toggle('open');
        if (sidebarOverlay) sidebarOverlay.classList.toggle('active');
        document.body.style.overflow = sidebar.classList.contains('open') ? 'hidden' : '';
    }

    // Group Toggle
    function toggleGroup(header) {
        const group = header.parentElement;
        if (group) group.classList.toggle('collapsed');
    }
    // window.toggleGroup = toggleGroup; // keep app.js version which rotates arrow

    // Operations Room Modal
    const opsModal = document.getElementById('opsModal');
    const opsRoomBtn = document.getElementById('opsRoomBtn');

    if (opsRoomBtn && opsModal) {
        opsRoomBtn.addEventListener('click', function() {
            opsModal.classList.add('active');
            document.body.style.overflow = 'hidden';
            loadOpsRoomData();
        });
    }

    function closeOpsModal() {
        if (opsModal) {
            opsModal.classList.remove('active');
            document.body.style.overflow = '';
        }
    }
    window.closeOpsModal = closeOpsModal;

    if (opsModal) {
        opsModal.addEventListener('click', function(e) {
            if (e.target === opsModal) closeOpsModal();
        });
    }

    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            closeOpsModal();
            if (sidebar) sidebar.classList.remove('open');
            if (sidebarOverlay) sidebarOverlay.classList.remove('active');
            document.body.style.overflow = '';
        }
    });

    // Tab Switching
    function switchTab(btn, tabName) {
        document.querySelectorAll('#opsModal .modal-tab').forEach(function(t) { t.classList.remove('active'); });
        document.querySelectorAll('#opsModal .tab-panel').forEach(function(p) { p.classList.remove('active'); });
        btn.classList.add('active');
        var panel = document.getElementById('panel-' + tabName);
        if (panel) panel.classList.add('active');
    }
    window.switchTab = switchTab;

    // Set current date in topbar
    var dateElTopbar = document.getElementById('currentDateTopbar');
    if (dateElTopbar) {
        var now = new Date();
        var options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
        dateElTopbar.textContent = now.toLocaleDateString('ar-SA', options);
    }

    // ========== Operations Room Data Loader ==========
    function getAuthToken() {
        return localStorage.getItem('authToken') || '';
    }

    function fetchWithAuth(url) {
        const token = getAuthToken();
        return fetch(url, {
            headers: token ? { 'Authorization': 'Bearer ' + token } : {}
        }).then(function(res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
        });
    }

    function formatDate(dateStr) {
        if (!dateStr) return '';
        var d = new Date(dateStr);
        if (isNaN(d)) return dateStr;
        return d.toLocaleDateString('ar-SA', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    }

    function renderOperationalFiles(files) {
        var container = document.getElementById('ops-files-container');
        if (!container) return;
        if (!files || files.length === 0) {
            container.innerHTML = '<p style="text-align:center;color:var(--gray-600);padding:20px;">لا توجد ملفات متاحة</p>';
            return;
        }
        var html = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;">';
        files.forEach(function(file) {
            var icon = 'fa-file';
            if (file.mimeType) {
                if (file.mimeType.includes('pdf')) icon = 'fa-file-pdf';
                else if (file.mimeType.includes('image')) icon = 'fa-file-image';
                else if (file.mimeType.includes('word') || file.mimeType.includes('document')) icon = 'fa-file-word';
                else if (file.mimeType.includes('excel') || file.mimeType.includes('sheet')) icon = 'fa-file-excel';
            }
            html += '<div class="protocol-card" style="cursor:pointer;" onclick="downloadOpsFile(\'' + (file.id || '') + '\')">';
            html += '<div class="protocol-icon"><i class="fas ' + icon + '"></i></div>';
            html += '<h4>' + (file.filename || 'ملف') + '</h4>';
            html += '<p>' + (file.uploadDate ? formatDate(file.uploadDate) : '') + '</p>';
            html += '<button class="protocol-btn">تحميل</button>';
            html += '</div>';
        });
        html += '</div>';
        container.innerHTML = html;
    }

    window.downloadOpsFile = function(id) {
        if (!id) return;
        var token = getAuthToken();
        var link = document.createElement('a');
        link.href = '/api/download-operational/' + id;
        if (token) link.setAttribute('data-token', token);
        link.download = '';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    function renderDocsList(docs, containerId, showPriority) {
        var container = document.getElementById(containerId);
        if (!container) return;
        if (!docs || docs.length === 0) {
            container.innerHTML = '<p style="text-align:center;color:var(--gray-600);padding:20px;">لا توجد تحديثات</p>';
            return;
        }
        var html = '';
        docs.forEach(function(doc) {
            var priorityClass = 'normal';
            var priorityText = 'إشعار';
            if (doc.priority === 'urgent' || doc.priority === 'عالي') { priorityClass = 'urgent'; priorityText = 'عاجل'; }
            else if (doc.priority === 'important' || doc.priority === 'متوسط') { priorityClass = 'important'; priorityText = 'مهم'; }

            html += '<div class="update-item ' + priorityClass + '">';
            html += '<div class="update-dot"></div>';
            html += '<div class="update-content">';
            if (showPriority) {
                html += '<span class="update-badge ' + priorityClass + '">' + priorityText + '</span>';
            }
            html += '<h4>' + (doc.description || doc.filename || 'تحديث') + '</h4>';
            if (doc.category) html += '<p>التصنيف: ' + doc.category + '</p>';
            if (doc.uploader) html += '<span class="update-time">بواسطة: ' + doc.uploader + ' • ' + formatDate(doc.uploadDate) + '</span>';
            else html += '<span class="update-time">' + formatDate(doc.uploadDate) + '</span>';
            html += '</div></div>';
        });
        container.innerHTML = html;
    }

    function renderKpis(data, shifts, peakData) {
        var activeReports = 0;
        if (data && data.data) {
            var allData = data.data;
            for (var key in allData) {
                if (allData[key] && allData[key].count) activeReports += allData[key].count;
            }
        }
        var elActive = document.getElementById('kpi-active-reports');
        if (elActive) elActive.textContent = activeReports;

        var elShifts = document.getElementById('kpi-shifts');
        if (elShifts) elShifts.textContent = (shifts && Array.isArray(shifts)) ? shifts.length : 0;

        var alertCount = 0;
        if (peakData && peakData.data && peakData.data.alerts) alertCount = peakData.data.alerts.length;
        var elAlerts = document.getElementById('kpi-peak-alerts');
        if (elAlerts) elAlerts.textContent = alertCount;

        var missionsContainer = document.getElementById('ops-peak-missions');
        if (missionsContainer) {
            if (peakData && peakData.data && peakData.data.missions && peakData.data.missions.length > 0) {
                var html = '<h3 style="color:var(--primary-700);margin-bottom:12px;font-size:1rem;"><i class="fas fa-tasks" style="color:var(--teal);"></i> المهمات النشطة</h3>';
                html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;">';
                peakData.data.missions.forEach(function(m) {
                    html += '<div class="protocol-card" style="text-align:right;">';
                    html += '<h4>' + (m.unit || '') + ' - ' + (m.location || '') + '</h4>';
                    html += '<p>الأولوية: ' + (m.priority || '') + '</p>';
                    html += '<p>الحالة: ' + (m.status || '') + '</p>';
                    html += '<p>' + (m.startTime || '') + ' → ' + (m.endTime || '') + '</p>';
                    html += '</div>';
                });
                html += '</div>';
                missionsContainer.innerHTML = html;
            } else {
                missionsContainer.innerHTML = '<p style="text-align:center;color:var(--gray-600);padding:20px;">لا توجد مهمات وقت الذروة حالياً</p>';
            }
        }
    }

    function renderShifts(shifts) {
        var container = document.getElementById('ops-reports-container');
        if (!container) return;
        if (!shifts || shifts.length === 0) {
            container.innerHTML = '<p style="text-align:center;color:var(--gray-600);padding:20px;">لا توجد مناوبات مسجلة</p>';
            return;
        }
        var html = '';
        shifts.forEach(function(shift) {
            var icon = 'fa-file-alt';
            var total = shift.totalReports || 0;
            html += '<div class="report-item">';
            html += '<div class="report-icon"><i class="fas ' + icon + '"></i></div>';
            html += '<div class="report-info">';
            html += '<h4>' + (shift.shiftName || 'مناوبة') + '</h4>';
            html += '<p>البلاغات: ' + total + ' • ' + formatDate(shift.startTime) + '</p>';
            html += '</div>';
            html += '<button class="report-btn" onclick="viewShiftReport(' + (shift.id || 0) + ')">عرض</button>';
            html += '</div>';
        });
        container.innerHTML = html;
    }

    window.viewShiftReport = function(shiftId) {
        window.open('/shift-report.html?shiftId=' + shiftId, '_blank');
    };

    window.loadOpsRoomData = function() {
        var token = getAuthToken();
        var headers = token ? { 'Authorization': 'Bearer ' + token } : {};

        // جلب الملفات التشغيلية
        fetchWithAuth('/api/operational-files').then(function(result) {
            renderOperationalFiles(result.files || []);
        }).catch(function(err) {
            console.error('فشل جلب الملفات التشغيلية:', err);
            var c = document.getElementById('ops-files-container');
            if (c) c.innerHTML = '<p style="text-align:center;color:var(--coral);padding:20px;">فشل تحميل الملفات</p>';
        });

        // جلب التحديثات التشغيلية (docs)
        fetchWithAuth('/api/docs').then(function(result) {
            var docs = result.docs || [];
            renderDocsList(docs, 'ops-docs-protocols', false);
            renderDocsList(docs, 'ops-updates-container', true);
        }).catch(function(err) {
            console.error('فشل جلب التحديثات:', err);
            var c1 = document.getElementById('ops-docs-protocols');
            if (c1) c1.innerHTML = '<p style="text-align:center;color:var(--coral);padding:20px;">فشل تحميل البروتوكولات</p>';
            var c2 = document.getElementById('ops-updates-container');
            if (c2) c2.innerHTML = '<p style="text-align:center;color:var(--coral);padding:20px;">فشل تحميل التحديثات</p>';
        });

        // جلب البيانات والمناوبات ووقت الذروة
        Promise.all([
            fetchWithAuth('/api/data').catch(function() { return null; }),
            fetchWithAuth('/api/shifts').catch(function() { return []; }),
            fetchWithAuth('/api/peak-data').catch(function() { return null; })
        ]).then(function(results) {
            renderKpis(results[0], results[1], results[2]);
            renderShifts(results[1]);
        }).catch(function(err) {
            console.error('فشل جلب المؤشرات:', err);
        });
    };

    // Load ops room data when modal opens (integrated into single listener above)
    // uploadOpsFiles function added below

    // Upload operational files
    window.uploadOpsFiles = function(input) {
        var files = input.files;
        if (!files || files.length === 0) return;
        var formData = new FormData();
        for (var i = 0; i < files.length; i++) {
            formData.append('files', files[i]);
        }
        formData.append('category', 'general');
        formData.append('notes', 'مرفوع من غرفة العمليات');
        
        fetch('/api/upload-operational', {
            method: 'POST',
            body: formData
        })
        .then(function(r) { return r.json(); })
        .then(function(data) {
            alert('✅ تم رفع الملفات بنجاح');
            loadOpsRoomData(); // إعادة تحميل البيانات
        })
        .catch(function(err) {
            alert('❌ فشل في رفع الملفات');
            console.error(err);
        });
    };
})();
