/* ==========================================
   الإشعارات - Notifications UI
   smart-schedule-notifications.js
   ========================================== */
(function() {
    'use strict';

    var notifications = [];
    var unreadCount = 0;

    function getToken() {
        return localStorage.getItem('authToken') || '';
    }

    // ==========================================
    // Toggle Notification Panel
    // ==========================================
    window.toggleNotificationPanel = function() {
        var panel = document.getElementById('notificationPanel');
        if (!panel) return;
        var isHidden = panel.classList.contains('hidden');
        // Close audit panel if open
        var auditPanel = document.getElementById('auditPanel');
        if (auditPanel && !auditPanel.classList.contains('hidden')) auditPanel.classList.add('hidden');

        if (isHidden) {
            panel.classList.remove('hidden');
            renderNotificationLog();
        } else {
            panel.classList.add('hidden');
        }
    };

    // ==========================================
    // Fetch Notifications
    // ==========================================
    function fetchNotifications() {
        return new Promise(function(resolve) {
            var token = getToken();
            if (!token) { resolve([]); return; }
            fetch('/api/notifications/log?limit=50', {
                headers: { 'Authorization': 'Bearer ' + token }
            }).then(function(r) { return r.json(); }).then(function(data) {
                notifications = data.notifications || data.log || data || [];
                updateBadge();
                resolve(notifications);
            }).catch(function(err) {
                console.error('Notifications fetch error:', err);
                resolve([]);
            });
        });
    }

    // ==========================================
    // Render Notification Log
    // ==========================================
    window.renderNotificationLog = function() {
        var body = document.getElementById('notificationPanelBody');
        if (!body) return;
        body.innerHTML = '<div class="text-center mt-3" style="color:var(--text-muted);">جاري التحميل...</div>';

        fetchNotifications().then(function(items) {
            if (!items || items.length === 0) {
                body.innerHTML = '<div class="text-center mt-3" style="color:var(--text-muted);">لا توجد إشعارات</div>';
                return;
            }

            var html = '';
            items.forEach(function(item) {
                var status = item.status || 'pending';
                var statusLabel = {
                    'pending': 'قيد الانتظار',
                    'sent': 'تم الإرسال',
                    'delivered': 'تم التسليم',
                    'read': 'مقروء',
                    'failed': 'فشل'
                }[status] || status;

                var timeStr = '';
                if (item.created_at) {
                    var d = new Date(item.created_at);
                    timeStr = d.toLocaleString('ar-SA', { hour12: false });
                }

                var isUnread = status !== 'read';
                var typeIcon = item.notification_type === 'alert' ? 'fa-exclamation-triangle' : item.notification_type === 'system' ? 'fa-cog' : 'fa-calendar-alt';

                html += '<div class="notification-item ' + (isUnread ? 'unread' : '') + '" data-id="' + (item.id || '') + '">';
                html += '<div class="notification-title">';
                html += '<i class="fas ' + typeIcon + '"></i> ' + (item.recipient_name || item.recipient_id || '—');
                html += '</div>';
                html += '<div class="notification-body">' + (item.message || '') + '</div>';
                html += '<div class="notification-meta">';
                html += '<span class="notification-status ' + status + '">' + statusLabel + '</span>';
                html += '<span class="notification-time">' + timeStr + '</span>';
                html += '</div>';
                html += '<div class="notification-actions">';
                if (isUnread) {
                    html += '<button class="btn btn-primary" onclick="markNotificationRead(' + (item.id || 0) + ')">';
                    html += '<i class="fas fa-check"></i> تحديد كمقروء';
                    html += '</button>';
                }
                html += '</div>';
                html += '</div>';
            });

            body.innerHTML = html;
        });
    };

    // ==========================================
    // Mark Notification Read
    // ==========================================
    window.markNotificationRead = function(id) {
        if (!id) return;
        var token = getToken();
        if (!token) {
            if (typeof showToast === 'function') showToast('يجب تسجيل الدخول', 'error');
            return;
        }
        fetch('/api/notifications/' + id + '/read', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + token }
        }).then(function(r) { return r.json(); }).then(function(data) {
            if (data.success) {
                if (typeof showToast === 'function') showToast('تم التحديث', 'success');
                renderNotificationLog();
            } else {
                if (typeof showToast === 'function') showToast('فشل في التحديث', 'error');
            }
        }).catch(function(err) {
            console.error('Mark read error:', err);
            if (typeof showToast === 'function') showToast('فشل في الاتصال بالسيرفر', 'error');
        });
    };

    // ==========================================
    // Mark Notification Delivered
    // ==========================================
    window.markNotificationDelivered = function(id) {
        if (!id) return;
        var token = getToken();
        if (!token) return;
        fetch('/api/notifications/' + id + '/delivered', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + token }
        }).then(function() { renderNotificationLog(); }).catch(function() { /* ignore */ });
    };

    // ==========================================
    // Show Notification Toast
    // ==========================================
    window.showNotificationToast = function(notification) {
        if (!notification) return;
        var message = notification.message || 'إشعار جديد';
        var recipient = notification.recipient_name || notification.recipient_id || '';
        if (typeof showToast === 'function') {
            showToast('🔔 ' + message + (recipient ? ' — ' + recipient : ''), 'info');
        }
        updateBadge();
    };

    // ==========================================
    // Send Notification (manual)
    // ==========================================
    window.sendNotification = function(recipientId, message, type, rosterId, shiftDate, oldVal, newVal) {
        var token = getToken();
        if (!token) {
            if (typeof showToast === 'function') showToast('يجب تسجيل الدخول', 'error');
            return;
        }
        fetch('/api/notifications/send', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + token
            },
            body: JSON.stringify({
                recipient_id: recipientId,
                message: message,
                type: type || 'shift_change',
                roster_id: rosterId,
                shift_date: shiftDate,
                old_value: oldVal,
                new_value: newVal
            })
        }).then(function(r) { return r.json(); }).then(function(data) {
            if (data.success) {
                if (typeof showToast === 'function') showToast('تم إرسال الإشعار', 'success');
                renderNotificationLog();
            } else {
                if (typeof showToast === 'function') showToast('فشل في الإرسال: ' + (data.error || ''), 'error');
            }
        }).catch(function(err) {
            console.error('Send notification error:', err);
            if (typeof showToast === 'function') showToast('فشل في الاتصال بالسيرفر', 'error');
        });
    };

    // ==========================================
    // Update Badge
    // ==========================================
    function updateBadge() {
        var badge = document.getElementById('notifBadge');
        if (!badge) return;
        var unread = notifications.filter(function(n) { return n.status !== 'read' && n.status !== 'delivered'; }).length;
        if (unread > 0) {
            badge.textContent = unread > 99 ? '99+' : unread;
            badge.style.display = 'flex';
        } else {
            badge.style.display = 'none';
        }
    }

    window.fetchUnreadCount = function() {
        return new Promise(function(resolve) {
            var token = getToken();
            if (!token) { resolve(0); return; }
            fetch('/api/notifications/log?status=pending&limit=1', {
                headers: { 'Authorization': 'Bearer ' + token }
            }).then(function(r) { return r.json(); }).then(function(data) {
                var count = (data.notifications || data.log || []).length;
                resolve(count);
            }).catch(function() { resolve(0); });
        });
    };

    // Poll for new notifications every 60 seconds
    setInterval(function() {
        var token = getToken();
        if (token) {
            fetch('/api/notifications/log?limit=1&status=pending', {
                headers: { 'Authorization': 'Bearer ' + token }
            }).then(function(r) { return r.json(); }).then(function(data) {
                var items = data.notifications || data.log || [];
                if (items.length > 0) {
                    showNotificationToast(items[0]);
                    updateBadge();
                }
            }).catch(function() { /* ignore */ });
        }
    }, 60000);

    // Close notification panel on click outside
    document.addEventListener('click', function(e) {
        var panel = document.getElementById('notificationPanel');
        var btn = document.getElementById('notifBtn');
        if (panel && !panel.classList.contains('hidden') && !panel.contains(e.target) && (!btn || !btn.contains(e.target))) {
            panel.classList.add('hidden');
        }
    });

})();
