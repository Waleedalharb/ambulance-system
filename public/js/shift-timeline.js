/* ==========================================
   shift-timeline.js
   Timeline Rendering for Shift Detail
   منصة الجنوب - Ambulance Dispatch Platform
   ========================================== */

(function(window) {
    'use strict';

    var ShiftTimeline = {};

    // Event type to icon mapping
    var eventIcons = {
        start: 'fa-play',
        team_checkin: 'fa-users',
        report_received: 'fa-ambulance',
        report_completed: 'fa-check-circle',
        shift_change: 'fa-exchange-alt',
        form_filed: 'fa-file-alt',
        note_added: 'fa-sticky-note',
        alert_triggered: 'fa-bell',
        peak_mission: 'fa-bolt',
        end: 'fa-stop'
    };

    // Event type to color class mapping
    var eventColorClasses = {
        start: 'start',
        team_checkin: 'team_checkin',
        report_received: 'report_received',
        report_completed: 'report_completed',
        shift_change: 'shift_change',
        form_filed: 'form_filed',
        note_added: 'note_added',
        alert_triggered: 'alert_triggered',
        peak_mission: 'peak_mission',
        end: 'end'
    };

    // Event type to Arabic label
    var eventLabels = {
        start: 'بداية المناوبة',
        team_checkin: 'تسجيل فريق',
        report_received: 'استلام بلاغ',
        report_completed: 'إنجاز بلاغ',
        shift_change: 'تغيير مناوبة',
        form_filed: 'تسجيل نموذج',
        note_added: 'إضافة ملاحظة',
        alert_triggered: 'تنبيه',
        peak_mission: 'ذروة مهام',
        end: 'نهاية المناوبة'
    };

    // ==========================================
    // Render Timeline
    // ==========================================
    ShiftTimeline.render = function(containerId, events) {
        var container = document.getElementById(containerId);
        if (!container) return;

        if (!events || events.length === 0) {
            container.innerHTML = '<div class="empty-state"><i class="fas fa-history"></i><p>لا توجد أحداث مسجلة</p></div>';
            return;
        }

        // Sort by event_time descending (newest first)
        var sortedEvents = events.slice().sort(function(a, b) {
            return new Date(b.event_time || b.created_at || 0) - new Date(a.event_time || a.created_at || 0);
        });

        var html = '<div class="timeline">';
        sortedEvents.forEach(function(event) {
            var type = event.event_type || 'note_added';
            var icon = eventIcons[type] || 'fa-circle';
            var colorClass = eventColorClasses[type] || 'note_added';
            var label = eventLabels[type] || type;
            var time = formatTime(event.event_time || event.created_at);
            var title = event.event_title || label;
            var description = event.event_description || '';
            var creator = event.created_by_name || event.created_by || '';

            html += '<div class="timeline-item">';
            html += '<div class="timeline-dot ' + colorClass + '"><i class="fas ' + icon + '"></i></div>';
            html += '<div class="timeline-content">';
            html += '<div class="timeline-time">' + escapeHtml(time) + '</div>';
            html += '<div class="timeline-title">' + escapeHtml(title) + '</div>';
            if (description) {
                html += '<div class="timeline-description">' + escapeHtml(description) + '</div>';
            }
            if (creator) {
                html += '<div class="timeline-meta"><i class="fas fa-user"></i> ' + escapeHtml(creator) + '</div>';
            }
            html += '</div>';
            html += '</div>';
        });
        html += '</div>';

        container.innerHTML = html;
    };

    // ==========================================
    // Add Event to Timeline (prepend)
    // ==========================================
    ShiftTimeline.addEvent = function(containerId, event) {
        var container = document.getElementById(containerId);
        if (!container) return;

        var timeline = container.querySelector('.timeline');
        if (!timeline) {
            ShiftTimeline.render(containerId, [event]);
            return;
        }

        var type = event.event_type || 'note_added';
        var icon = eventIcons[type] || 'fa-circle';
        var colorClass = eventColorClasses[type] || 'note_added';
        var label = eventLabels[type] || type;
        var time = formatTime(event.event_time || event.created_at);
        var title = event.event_title || label;
        var description = event.event_description || '';
        var creator = event.created_by_name || event.created_by || '';

        var html = '<div class="timeline-item" style="animation: toastIn 0.3s ease;">';
        html += '<div class="timeline-dot ' + colorClass + '"><i class="fas ' + icon + '"></i></div>';
        html += '<div class="timeline-content">';
        html += '<div class="timeline-time">' + escapeHtml(time) + '</div>';
        html += '<div class="timeline-title">' + escapeHtml(title) + '</div>';
        if (description) {
            html += '<div class="timeline-description">' + escapeHtml(description) + '</div>';
        }
        if (creator) {
            html += '<div class="timeline-meta"><i class="fas fa-user"></i> ' + escapeHtml(creator) + '</div>';
        }
        html += '</div>';
        html += '</div>';

        timeline.insertAdjacentHTML('afterbegin', html);
    };

    // ==========================================
    // Helpers
    // ==========================================
    function formatTime(dateStr) {
        if (!dateStr) return '—';
        var d = new Date(dateStr);
        if (isNaN(d.getTime())) return dateStr;
        return d.toLocaleDateString('ar-SA', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    function escapeHtml(text) {
        if (text == null) return '';
        var div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // Expose to window
    window.ShiftTimeline = ShiftTimeline;

})(window);
