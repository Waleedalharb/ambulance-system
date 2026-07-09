/* ==========================================
   shift-charts.js
   Chart.js Wrapper Helpers for Shift Analytics
   منصة الجنوب - Ambulance Dispatch Platform
   ========================================== */

(function(window) {
    'use strict';

    var ShiftCharts = {};

    // Store chart instances for cleanup
    var chartInstances = {};

    // Default Chart.js options for RTL Arabic
    var defaultOptions = {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
            legend: {
                position: 'bottom',
                labels: {
                    font: { family: "'Inter', 'IBM Plex Sans Arabic', sans-serif", size: 12 },
                    padding: 16,
                    usePointStyle: true
                }
            },
            tooltip: {
                rtl: true,
                textDirection: 'rtl',
                titleFont: { family: "'Inter', 'IBM Plex Sans Arabic', sans-serif", size: 13 },
                bodyFont: { family: "'Inter', 'IBM Plex Sans Arabic', sans-serif", size: 12 },
                padding: 12,
                cornerRadius: 8,
                backgroundColor: 'rgba(30, 41, 59, 0.9)'
            }
        },
        scales: {
            x: {
                ticks: {
                    font: { family: "'Inter', 'IBM Plex Sans Arabic', sans-serif", size: 11 },
                    maxRotation: 0
                },
                grid: { color: 'rgba(226, 232, 240, 0.5)' }
            },
            y: {
                ticks: {
                    font: { family: "'Inter', 'IBM Plex Sans Arabic', sans-serif", size: 11 }
                },
                grid: { color: 'rgba(226, 232, 240, 0.5)' },
                beginAtZero: true
            }
        }
    };

    // ==========================================
    // Gauge Chart (Doughnut-based) for Health Score
    // ==========================================
    ShiftCharts.initGaugeChart = function(containerId, value, label, color) {
        var canvas = document.getElementById(containerId);
        if (!canvas) return null;

        var ctx = canvas.getContext('2d');
        var chartId = containerId + '_gauge';

        if (chartInstances[chartId]) {
            chartInstances[chartId].destroy();
        }

        var remaining = 100 - value;
        var bgColor = color || (value >= 80 ? '#10B981' : value >= 60 ? '#2563EB' : value >= 40 ? '#F59E0B' : '#EF4444');

        var chart = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: [label || 'القيمة', 'المتبقي'],
                datasets: [{
                    data: [value, remaining],
                    backgroundColor: [bgColor, '#E2E8F0'],
                    borderWidth: 0,
                    cutout: '75%',
                    circumference: 180,
                    rotation: 270
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: { enabled: false }
                },
                animation: {
                    animateRotate: true,
                    duration: 1200,
                    easing: 'easeOutQuart'
                }
            }
        });

        chartInstances[chartId] = chart;
        return chart;
    };

    // ==========================================
    // Bar Chart
    // ==========================================
    ShiftCharts.initBarChart = function(containerId, labels, data, label, color) {
        var canvas = document.getElementById(containerId);
        if (!canvas) return null;

        var ctx = canvas.getContext('2d');
        var chartId = containerId + '_bar';

        if (chartInstances[chartId]) {
            chartInstances[chartId].destroy();
        }

        var bgColor = color || '#2563EB';
        var chart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [{
                    label: label || 'القيمة',
                    data: data,
                    backgroundColor: bgColor,
                    borderRadius: 6,
                    borderSkipped: false,
                    barPercentage: 0.6
                }]
            },
            options: JSON.parse(JSON.stringify(defaultOptions))
        });

        chartInstances[chartId] = chart;
        return chart;
    };

    // ==========================================
    // Pie Chart
    // ==========================================
    ShiftCharts.initPieChart = function(containerId, labels, data, colors) {
        var canvas = document.getElementById(containerId);
        if (!canvas) return null;

        var ctx = canvas.getContext('2d');
        var chartId = containerId + '_pie';

        if (chartInstances[chartId]) {
            chartInstances[chartId].destroy();
        }

        var defaultColors = ['#2563EB', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#3B82F6', '#EC4899', '#14B8A6'];
        var chartColors = colors || defaultColors.slice(0, labels.length);

        var chart = new Chart(ctx, {
            type: 'pie',
            data: {
                labels: labels,
                datasets: [{
                    data: data,
                    backgroundColor: chartColors,
                    borderWidth: 2,
                    borderColor: '#FFFFFF'
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'bottom',
                        rtl: true,
                        labels: {
                            font: { family: "'Inter', 'IBM Plex Sans Arabic', sans-serif", size: 12 },
                            padding: 16,
                            usePointStyle: true
                        }
                    },
                    tooltip: {
                        rtl: true,
                        textDirection: 'rtl',
                        titleFont: { family: "'Inter', 'IBM Plex Sans Arabic', sans-serif", size: 13 },
                        bodyFont: { family: "'Inter', 'IBM Plex Sans Arabic', sans-serif", size: 12 },
                        padding: 12,
                        cornerRadius: 8,
                        backgroundColor: 'rgba(30, 41, 59, 0.9)',
                        callbacks: {
                            label: function(context) {
                                var total = context.dataset.data.reduce(function(a, b) { return a + b; }, 0);
                                var percentage = total > 0 ? Math.round((context.raw / total) * 100) + '%' : '0%';
                                return context.label + ': ' + context.raw + ' (' + percentage + ')';
                            }
                        }
                    }
                }
            }
        });

        chartInstances[chartId] = chart;
        return chart;
    };

    // ==========================================
    // Line Chart
    // ==========================================
    ShiftCharts.initLineChart = function(containerId, labels, data, label, color, fill) {
        var canvas = document.getElementById(containerId);
        if (!canvas) return null;

        var ctx = canvas.getContext('2d');
        var chartId = containerId + '_line';

        if (chartInstances[chartId]) {
            chartInstances[chartId].destroy();
        }

        var lineColor = color || '#2563EB';
        var chart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: label || 'القيمة',
                    data: data,
                    borderColor: lineColor,
                    backgroundColor: fill ? hexToRgba(lineColor, 0.1) : 'transparent',
                    fill: fill || false,
                    tension: 0.4,
                    pointRadius: 4,
                    pointHoverRadius: 6,
                    pointBackgroundColor: '#FFFFFF',
                    pointBorderColor: lineColor,
                    pointBorderWidth: 2
                }]
            },
            options: JSON.parse(JSON.stringify(defaultOptions))
        });

        chartInstances[chartId] = chart;
        return chart;
    };

    // ==========================================
    // Horizontal Bar Chart (for comparisons)
    // ==========================================
    ShiftCharts.initHorizontalBarChart = function(containerId, labels, dataA, labelA, dataB, labelB) {
        var canvas = document.getElementById(containerId);
        if (!canvas) return null;

        var ctx = canvas.getContext('2d');
        var chartId = containerId + '_hbar';

        if (chartInstances[chartId]) {
            chartInstances[chartId].destroy();
        }

        var options = JSON.parse(JSON.stringify(defaultOptions));
        options.indexAxis = 'y';

        var chart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: labelA || 'أ',
                        data: dataA,
                        backgroundColor: '#2563EB',
                        borderRadius: 6,
                        barPercentage: 0.6
                    },
                    {
                        label: labelB || 'ب',
                        data: dataB,
                        backgroundColor: '#10B981',
                        borderRadius: 6,
                        barPercentage: 0.6
                    }
                ]
            },
            options: options
        });

        chartInstances[chartId] = chart;
        return chart;
    };

    // ==========================================
    // Destroy Chart
    // ==========================================
    ShiftCharts.destroyChart = function(containerId) {
        var ids = [containerId + '_gauge', containerId + '_bar', containerId + '_pie', containerId + '_line', containerId + '_hbar'];
        ids.forEach(function(id) {
            if (chartInstances[id]) {
                chartInstances[id].destroy();
                delete chartInstances[id];
            }
        });
    };

    // ==========================================
    // Destroy All Charts
    // ==========================================
    ShiftCharts.destroyAll = function() {
        Object.keys(chartInstances).forEach(function(id) {
            if (chartInstances[id]) {
                chartInstances[id].destroy();
            }
        });
        chartInstances = {};
    };

    // Helper: hex to rgba
    function hexToRgba(hex, alpha) {
        var r = parseInt(hex.slice(1, 3), 16);
        var g = parseInt(hex.slice(3, 5), 16);
        var b = parseInt(hex.slice(5, 7), 16);
        return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + alpha + ')';
    }

    // Expose to window
    window.ShiftCharts = ShiftCharts;

})(window);
