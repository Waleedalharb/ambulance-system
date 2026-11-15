'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const tiles = require('../../public/js/map-tiles.js');

function restoreGlobal(name, value) {
  if (value === undefined) delete global[name];
  else global[name] = value;
}

test('Mapbox public runtime token drives the shared Leaflet raster source', () => {
  const previous = global.SMAP_MAP_CONFIG;
  try {
    global.SMAP_MAP_CONFIG = { accessToken: 'pk.test_token-123' };
    const config = tiles.getConfig();
    assert.match(config.url, /^https:\/\/api\.mapbox\.com\/styles\/v1\/mapbox\/light-v11\/tiles\/256\/\{z\}\/\{x\}\/\{y\}\{r\}\?access_token=/);
    assert.ok(config.url.endsWith('pk.test_token-123'));
    assert.match(config.attribution, /Mapbox/);
    assert.equal(config.subdomains, undefined);
  } finally {
    restoreGlobal('SMAP_MAP_CONFIG', previous);
  }
});

test('CARTO remains the safe fallback when Mapbox is absent or invalid', () => {
  const previous = global.SMAP_MAP_CONFIG;
  try {
    delete global.SMAP_MAP_CONFIG;
    assert.match(tiles.getConfig().url, /basemaps\.cartocdn\.com\/light_all/);
    global.SMAP_MAP_CONFIG = { accessToken: 'sk.not-public' };
    assert.match(tiles.getConfig().url, /basemaps\.cartocdn\.com\/light_all/);
  } finally {
    restoreGlobal('SMAP_MAP_CONFIG', previous);
  }
});

test('shared helper adds the configured layer without changing the map engine', () => {
  const oldConfig = global.SMAP_MAP_CONFIG;
  const oldL = global.L;
  try {
    global.SMAP_MAP_CONFIG = { accessToken: 'pk.test_token-123' };
    const map = {};
    let receivedUrl;
    const layer = { addTo(target) { assert.equal(target, map); return this; } };
    global.L = { tileLayer(url, options) {
      receivedUrl = url;
      assert.match(options.attribution, /Mapbox/);
      return layer;
    } };
    assert.equal(tiles.addLeafletTiles(map), layer);
    assert.match(receivedUrl, /api\.mapbox\.com/);
  } finally {
    restoreGlobal('SMAP_MAP_CONFIG', oldConfig);
    restoreGlobal('L', oldL);
  }
});
