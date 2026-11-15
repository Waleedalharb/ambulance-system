'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

require('./verify-region-command-runtime');
if (process.version !== 'v22.23.5') process.exit(1);
const testDir = path.join(__dirname, '../tests/region-command');
const files = fs.readdirSync(testDir).filter(name => name.endsWith('.test.js')).map(name => path.join(testDir, name));
const result = spawnSync(process.execPath, ['--test', ...files], { cwd: path.join(__dirname, '..'), stdio: 'inherit', env: { ...process.env, REGION_COMMAND_ENABLED: 'true' } });
process.exit(result.status === null ? 1 : result.status);
