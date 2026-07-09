/* ==========================================
   Chart.js Helpers - shift-charts.js
   منصة الجنوب - Dashboard Chart Wrappers
   ========================================== */

(function() {
    'use strict';

    var chartRegistry = {};

    var colors = {
        primary: '#2563EB',
        success: '#10B981',
        warning: '#F59E0B',
        danger: '#EF4444',
        purple: '#8B5CF6',
        gray: '#94A3B8',
        lightBlue: '#DBEAFE',
        lightGreen: '#D1FAE5',
        lightWarning: '#FEF3C7',
        lightDanger: '#FEE2E2'
    };

    var palette = [colors.primary, colors.success, colors.warning, colors.danger, colors.purple, '#0EA5E9', '#F97316', '#14B8A6'];

    function destroyChart(id) {
        if (chartRegistry[id]) {
            chartRegistry[id].destroy();
            delete chartRegistry[id];
        }
    }

    function commonOptions() {
        return {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: { font: { family: 'Inter', size: 12 }, padding: 16 }
                },
                tooltip: {
                    rtl: true,
                    textDirection: 'rtl',
                    titleFont: { family: 'Inter' },
                    bodyFont: { family: 'Inter' }
                }
            },
            scales: {
                x: { grid: { display: false }, ticks: { font: { family: 'Inter', size: 11 } } },
                y: { grid: { color: '#F1F5F9' }, ticks: { font: { family: 'Inter', size: 11 } } }
            }
        };
    }

    function createBarChart(id, labels, datasets, stacked) {
        destroyChart(id);
        var ctx = document.getElementById(id);
        if (!ctx) return null;
        var opts = commonOptions();
        if (stacked) {
            opts.scales.x.stacked = true;
            opts.scales.y.stacked = true;
        }
        chartRegistry[id] = new Chart(ctx, {
            type: 'bar',
            data: { labels: labels, datasets: datasets },
            options: opts
        });
        return chartRegistry[id];
    }

    function createLineChart(id, labels, datasets, fill) {
        destroyChart(id);
        var ctx = document.getElementById(id);
        if (!ctx) return null;
        var opts = commonOptions();
        datasets.forEach(function(ds) {
            ds.tension = ds.tension || 0.4;
            ds.fill = fill || false;
            ds.pointRadius = ds.pointRadius || 4;
            ds.pointHoverRadius = 6;
        });
        chartRegistry[id] = new Chart(ctx, {
            type: 'line',
            data: { labels: labels, datasets: datasets },
            options: opts
        });
        return chartRegistry[id];
    }

    function createPieChart(id, labels, data) {
        destroyChart(id);
        var ctx = document.getElementById(id);
        if (!ctx) return null;
        chartRegistry[id] = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: labels,
                datasets: [{
                    data: data,
                    backgroundColor: palette.slice(0, labels.length),
                    borderWidth: 2,
                    borderColor: '#fff'
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { position: 'bottom', labels: { font: { family: 'Inter', size: 12 }, padding: 16 } },
                    tooltip: { rtl: true, textDirection: 'rtl', titleFont: { family: 'Inter' }, bodyFont: { family: 'Inter' } }
                }
            }
        });
        return chartRegistry[id];
    }

    function createHorizontalBarChart(id, labels, datasets) {
        destroyChart(id);
        var ctx = document.getElementById(id);
        if (!ctx) return null;
        var opts = commonOptions();
        opts.indexAxis = 'y';
        chartRegistry[id] = new Chart(ctx, {
            type: 'bar',
            data: { labels: labels, datasets: datasets },
            options: opts
        });
        return chartRegistry[id];
    }

    function createGaugeChart(id, value, label) {
        destroyChart(id);
        var ctx = document.getElementById(id);
        if (!ctx) return null;
        var color = value >= 80 ? colors.success : value >= 50 ? colors.warning : colors.danger;
        chartRegistry[id] = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: [label || 'القيمة', 'المتبقي'],
                datasets: [{
                    data: [value, 100 - value],
                    backgroundColor: [color, '#E2E8F0'],
                    borderWidth: 0,
                    cutout: '75%',
                    circumference: 360,
                    rotation: 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: { enabled: false }
                }
            },
            plugins: [{
                id: 'gaugeText',
                beforeDraw: function(chart) {
                    var ctx = chart.ctx;
                    var center = chart.getDatasetMeta(0).data[0];
                    var x = center ? center.x : chart.width / 2;
                    var y = center ? center.y : chart.height / 2;
                    ctx.save();
                    ctx.font = 'bold 28px Inter';
                    ctx.fillStyle = color;
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(Math.round(value) + '%', x, y);
                    ctx.font = '14px Inter';
                    ctx.fillStyle = '#64748B';
                    ctx.fillText(label || '', x, y + 24);
                    ctx.restore();
                }
            }]
        });
        return chartRegistry[id];
    }

    function updateChart(id, labels, datasets) {
        if (!chartRegistry[id]) return;
        chartRegistry[id].data.labels = labels;
        chartRegistry[id].data.datasets = datasets;
        chartRegistry[id].update();
    }

    function makeDataset(label, data, color, type) {
        return {
            label: label,
            data: data,
            backgroundColor: color || colors.primary,
            borderColor: color || colors.primary,
            borderWidth: 2,
            type: type || 'bar'
        };
    }

    window.ChartHelpers = {
        createBarChart: createBarChart,
        createLineChart: createLineChart,
        createPieChart: createPieChart,
        createHorizontalBarChart: createHorizontalBarChart,
        createGaugeChart: createGaugeChart,
        updateChart: updateChart,
        makeDataset: makeDataset,
        destroyChart: destroyChart,
        colors: colors,
        palette: palette
    };
})();
