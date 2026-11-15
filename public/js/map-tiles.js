/* بلاطات Leaflet الموحدة: Mapbox من إعداد التشغيل، وCARTO بديلًا عند غيابه. */
(function (root, factory) {
    'use strict';
    var api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.EmsMapTiles = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    function getConfig(options) {
        var settings = root.SMAP_MAP_CONFIG || {};
        var forceCarto = options && options.provider === 'carto';
        var token = !forceCarto && typeof settings.accessToken === 'string' && /^pk\.[A-Za-z0-9._-]+$/.test(settings.accessToken)
            ? settings.accessToken : '';
        if (token) {
            return {
                url: 'https://api.mapbox.com/styles/v1/mapbox/light-v11/tiles/256/{z}/{x}/{y}{r}?access_token=' + encodeURIComponent(token),
                attribution: '&copy; <a href="https://www.mapbox.com/">Mapbox</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
                maxZoom: 19
            };
        }
        var cartoKey = typeof settings.cartoApiKey === 'string' ? settings.cartoApiKey : '';
        return {
            url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png' + (cartoKey ? '?key=' + encodeURIComponent(cartoKey) : ''),
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
            subdomains: 'abcd',
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
