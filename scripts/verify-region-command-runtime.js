'use strict';

const EXPECTED = 'v22.23.5';
const result = {
  ok: process.version === EXPECTED,
  expected: EXPECTED,
  actual: process.version,
  execPath: process.execPath
};
console.log(JSON.stringify(result, null, 2));
if (!result.ok) {
  console.error(`Region Command acceptance tests require Node ${EXPECTED}; received ${process.version}.`);
  process.exitCode = 1;
}
