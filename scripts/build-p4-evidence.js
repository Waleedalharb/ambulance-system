'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..');
const WORKSPACE = path.join(ROOT, '..', '..');
const projectFiles = [
  'render.yaml',
  'public/js/schedule-workspace.js',
  'scripts/run-regression-isolated.js',
  'scripts/regression-test.js',
  'scripts/permissions-phase0-test.js',
  'scripts/schedule-permissions-test.js',
  'scripts/p4-browser-acceptance-test.js',
  'scripts/migrate-schedule-p1-p3.js',
  'scripts/predeploy-rehearsal-test.js',
  'scripts/backup.js',
  'scripts/build-p4-evidence.js',
  'deploy/migrations/2026-11-04-schedule-p1-p3.sql',
  'deploy/PRE-DEPLOYMENT-RUNBOOK.md',
  'test-output/p4-browser-1793812653226/summary.json',
  'test-output/p4-browser-1793812653226/desktop-unresolved.png',
  'test-output/p4-browser-1793812653226/mobile-unresolved.png',
  'test-output/predeploy-1793812491568/summary.json'
];
const workspaceFiles = [
  'P4-FINAL-DELIVERY-REPORT.md',
  'final-gate-p1-a-continuity-test.log',
  'final-gate-p1-b-generation-test.log',
  'final-gate-p2-lifecycle-test.log',
  'final-gate-p3-workspace-test.log',
  'final-gate-schedule-generation-access-test.log',
  'final-gate-e0-foundation-test.log',
  'final-gate-e4-coverage-validation-test.log',
  'final-gate-permissions-phase0-test.log',
  'final-gate-schedule-permissions-test.log',
  'final-gate-permissions-write-guard-test.log',
  'p4-browser-acceptance-final.log',
  'predeploy-rehearsal-final.log',
  'final-regression-gate.log',
  'migration-cold-verify.log'
];
const rows = [];
for (const file of projectFiles) {
  const absolute = path.join(ROOT, file);
  if (!fs.existsSync(absolute)) throw new Error('Missing evidence: ' + absolute);
  const hash = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
  rows.push(`${hash}  inspection/project-full/${file.replace(/\\/g, '/')}`);
}
for (const file of workspaceFiles) {
  const absolute = path.join(WORKSPACE, file);
  if (!fs.existsSync(absolute)) throw new Error('Missing evidence: ' + absolute);
  const hash = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
  rows.push(`${hash}  ${file.replace(/\\/g, '/')}`);
}
const output = path.join(WORKSPACE, 'P4-EVIDENCE-SHA256.txt');
fs.writeFileSync(output, '# SHA-256 evidence manifest — P4 final delivery, 2026-11-04\n' + rows.join('\n') + '\n');
console.log(`Wrote ${rows.length} hashes to ${output}`);
