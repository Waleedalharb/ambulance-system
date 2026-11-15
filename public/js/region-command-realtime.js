(function (global) {
  'use strict';
  function RegionCommandRealtime(options) {
    this.onChange = options.onChange;
    this.onStatus = options.onStatus;
    this.source = null;
    this.timer = null;
    this.seen = new Set();
    this.opened = false;
    this.stopped = false;
    this.pending = [];
  }
  RegionCommandRealtime.prototype.status = function (state) {
    if (this.onStatus) this.onStatus(state);
  };
  RegionCommandRealtime.prototype.start = function () {
    this.stop();
    this.stopped = false;
    var token = AuthCore.getToken();
    if (!token) { this.status('forbidden'); return; }
    this.status('connecting');
    try {
      this.source = new EventSource('/api/sse?token=' + encodeURIComponent(token));
    } catch (_) { this.status('disconnected'); return; }
    var self = this;
    this.source.onopen = function () {
      self.status('connected');
      if (self.opened) self.onChange([{ reason: 'reconnect' }]);
      self.opened = true;
    };
    this.source.onmessage = function (event) {
      var data;
      try { data = JSON.parse(event.data); } catch (_) { return; }
      if (!data || data.type !== 'region_command_changed') return;
      if (data.eventId) {
        if (self.seen.has(data.eventId)) return;
        self.seen.add(data.eventId);
        if (self.seen.size > 5000) self.seen.delete(self.seen.values().next().value);
      }
      self.pending.push(data);
      self.schedule();
    };
    this.source.onerror = function () {
      if (self.stopped) return;
      if (self.source && self.source.readyState === EventSource.CLOSED) {
        self.status('forbidden');
        self.stop();
      } else self.status('reconnecting');
    };
  };
  RegionCommandRealtime.prototype.schedule = function () {
    var self = this;
    if (this.timer) return;
    this.timer = setTimeout(function () {
      self.timer = null;
      var events = self.pending.splice(0, self.pending.length);
      if (events.length && !self.stopped) self.onChange(events);
    }, 600);
  };
  RegionCommandRealtime.prototype.stop = function () {
    this.stopped = true;
    if (this.source) { try { this.source.close(); } catch (_) { /* مغلق */ } }
    this.source = null;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.pending = [];
  };
  global.RegionCommandRealtime = RegionCommandRealtime;
})(window);
