'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { HELMET_CONFIG } = require('../../config/security');

test('CSP allows the exact tile origin configured by the region map', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../public/js/region-map.js'), 'utf8');
  const match = source.match(/L\.tileLayer\('([^']+)'/);
  assert.ok(match, 'region map tile source must be explicit');
  const origin = new URL(match[1]).origin;
  const directives = HELMET_CONFIG.contentSecurityPolicy.directives;
  assert.ok(directives.imgSrc.includes(origin), `img-src must allow ${origin}`);
  assert.ok(directives.connectSrc.includes(origin), `connect-src must allow ${origin}`);
});
