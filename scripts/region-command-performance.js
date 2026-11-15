'use strict';

// قياس HTTP محلي على fixture اصطناعي فقط؛ لا يمثل سعة الإنتاج أو زمن شبكته.
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { performance } = require('perf_hooks');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '..', 'diagnostics', 'region-command-execution');
fs.mkdirSync(OUT, { recursive: true });
const ITERATIONS = Number(process.env.REGION_COMMAND_PERF_ITERATIONS || 60);
const budgets = { overview: 3000, sector: 2000, map: 2000 };
const endpoints = {
  overview: '/api/region-command/overview?view=current',
  sector: '/api/region-command/sectors/S1?view=current',
  map: '/api/region-command/sectors/S1/map?view=current'
};
let child;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}
function percentile(sorted, ratio) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}
function stats(samples) {
  const sorted = samples.map(item => item.ms).sort((a, b) => a - b);
  return {
    count: sorted.length,
    minMs: sorted[0],
    p50Ms: percentile(sorted, .5),
    p95Ms: percentile(sorted, .95),
    maxMs: sorted[sorted.length - 1],
    meanMs: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    bytesMin: Math.min(...samples.map(item => item.bytes)),
    bytesMax: Math.max(...samples.map(item => item.bytes)),
    errors: samples.filter(item => item.error).length
  };
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(3000)]);
}
async function main() {
  const port = await freePort();
  child = spawn(process.execPath, [path.join(__dirname, 'region-command-preview-server.js'), '--host', '127.0.0.1', '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { if ((await fetch(base + '/')).ok) break; } catch (_) { /* لم يبدأ بعد */ }
    if (child.exitCode !== null) throw new Error('Preview server exited: ' + output);
    await sleep(100);
  }
  const report = { generatedAt: new Date().toISOString(), node: process.version, iterations: ITERATIONS, fixture: 'synthetic-in-memory', scope: 'local HTTP latency only; not production capacity or network performance', endpoints: {}, pass: true };
  for (const [name, route] of Object.entries(endpoints)) {
    const samples = [];
    for (let index = 0; index < ITERATIONS + 5; index += 1) {
      const started = performance.now();
      let error = null;
      let bytes = 0;
      try {
        const response = await fetch(base + route, { headers: { Authorization: 'Bearer region', Accept: 'application/json' } });
        const text = await response.text();
        bytes = Buffer.byteLength(text);
        if (!response.ok || !text.includes('"success":true')) error = `HTTP ${response.status}`;
      } catch (cause) { error = cause.message; }
      if (index >= 5) samples.push({ ms: performance.now() - started, bytes, error });
    }
    const summary = stats(samples);
    summary.budgetMs = budgets[name];
    summary.withinBudget = summary.errors === 0 && summary.p95Ms <= budgets[name];
    report.endpoints[name] = summary;
    if (!summary.withinBudget) report.pass = false;
    console.log(`${name}: p50=${summary.p50Ms.toFixed(1)}ms p95=${summary.p95Ms.toFixed(1)}ms max=${summary.maxMs.toFixed(1)}ms errors=${summary.errors} budget=${summary.withinBudget ? 'PASS' : 'FAIL'}`);
  }
  const browserResultPath = path.join(OUT, 'browser', 'browser-results.json');
  if (fs.existsSync(browserResultPath)) {
    const browser = JSON.parse(fs.readFileSync(browserResultPath, 'utf8'));
    report.realtimeBrowserMs = browser.realtimeMs;
    report.browserChecks = {
      passed: browser.results.filter(item => item.pass).length,
      total: browser.results.filter(item => !item.skipped).length,
      skipped: browser.results.filter(item => item.skipped).length,
      interactiveMapSkipped: browser.interactiveMapSkipped === true
    };
  }
  fs.writeFileSync(path.join(OUT, 'performance-results.json'), JSON.stringify(report, null, 2));
  console.log(`PERFORMANCE_RESULT ${report.pass ? 'PASS' : 'FAIL'}`);
  if (!report.pass) process.exitCode = 1;
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(stop);
