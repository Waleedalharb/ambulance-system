/* بلاطات Leaflet الموحدة: نفس مصدر OSM المعتمد في مركز قيادة المنطقة. */
(function (root, factory) {
    'use strict';
    var api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.EmsMapTiles = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    function getConfig(options) {
        return {
            url: 'https://tile.openstreetmap.de/{z}/{x}/{y}.png',
            attribution: '&copy; OpenStreetMap contributors',
            maxZoom: 19
        };
    }

    function addLeafletTiles(map, options) {
        if (!root.L || typeof root.L.tileLayer !== 'function') throw new Error('Leaflet غير متاح');
        var config = getConfig(options);
        var url = config.url;
        delete config.url;
        return root.L.tileLayer(url, config).addTo(map);
    }

    return { getConfig: getConfig, addLeafletTiles: addLeafletTiles };
});
