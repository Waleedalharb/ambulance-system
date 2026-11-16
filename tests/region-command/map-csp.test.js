'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { HELMET_CONFIG } = require('../../config/security');

test('CSP allows one identical tile origin across region, home and positioning maps', () => {
  const origins = ['region-map.js', 'smart-map.js', 'map-history.js'].map(file => {
    const source = fs.readFileSync(path.join(__dirname, '../../public/js', file), 'utf8');
    const match = source.match(/L\.tileLayer\('([^']+)'/);
    assert.ok(match, file + ' tile source must be explicit');
    return new URL(match[1]).origin;
  });
  origins.push(new URL(require('../../public/js/map-tiles.js').getConfig().url).origin);
  assert.equal(new Set(origins).size, 1, 'all maps must use the same tile origin');
  const directives = HELMET_CONFIG.contentSecurityPolicy.directives;
  for (const origin of new Set(origins)) {
    assert.ok(directives.imgSrc.includes(origin), `img-src must allow ${origin}`);
    assert.ok(directives.connectSrc.includes(origin), `connect-src must allow ${origin}`);
  }
});
