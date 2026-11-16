'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const tiles = require('../../public/js/map-tiles.js');

const referenceConfig = {
  url: 'https://tile.openstreetmap.de/{z}/{x}/{y}.png',
  attribution: '&copy; OpenStreetMap contributors',
  maxZoom: 19
};

test('shared raster config always matches the region-command reference', () => {
  const previous = global.SMAP_MAP_CONFIG;
  try {
    global.SMAP_MAP_CONFIG = { accessToken: 'pk.test_token-123', cartoApiKey: 'cb1.test_key-123' };
    assert.deepEqual(tiles.getConfig(), referenceConfig);
    assert.deepEqual(tiles.getConfig({ provider: 'carto', style: 'dark' }), referenceConfig);
  } finally {
    if (previous === undefined) delete global.SMAP_MAP_CONFIG;
    else global.SMAP_MAP_CONFIG = previous;
  }
});

test('shared helper adds the reference layer without changing the map engine', () => {
  const oldL = global.L;
  try {
    const map = {};
    let receivedUrl;
    const layer = { addTo(target) { assert.equal(target, map); return this; } };
    global.L = { tileLayer(url, options) {
      receivedUrl = url;
      assert.deepEqual(options, { attribution: referenceConfig.attribution, maxZoom: 19 });
      return layer;
    } };
    assert.equal(tiles.addLeafletTiles(map), layer);
    assert.equal(receivedUrl, referenceConfig.url);
  } finally {
    if (oldL === undefined) delete global.L;
    else global.L = oldL;
  }
});

test('home and positioning maps use the exact reference dark filter', () => {
  const css = fs.readFileSync(path.join(__dirname, '../../public/css/executive-theme.css'), 'utf8');
  for (const selector of ['#opsMap', '#histMap', '#peakMap', '#peakAlertMap', '#mapLeaflet']) {
    assert.ok(css.includes(selector + ' .leaflet-tile'), selector + ' must use the reference filter');
  }
  assert.ok(css.includes('filter: invert(1) hue-rotate(180deg) sepia(.28) hue-rotate(190deg) saturate(.85) contrast(1.12) brightness(.58);'));
});

test('production keeps Leaflet and displays the approved positioning system name', () => {
  const server = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');
  assert.ok(server.includes("provider: 'leaflet', accessToken: token"));
  assert.ok(!html.includes('نظام إدارة وقت الذروة'));
  assert.ok(!html.includes('<i class="fas fa-clock"></i> وقت الذروة'));
  assert.ok(html.includes('<h2>🚨 نظام تمركز الفرق</h2>'));
  assert.ok(html.split('<i class="fas fa-clock"></i> نظام تمركز الفرق').length >= 3);
});
