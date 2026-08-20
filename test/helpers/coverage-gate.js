'use strict';

/*
 * test/helpers/coverage-gate.js
 *
 * Enforces the Tier 0 coverage gate: `lib/*.js` must stay above a line
 * threshold. The `node --test --experimental-test-coverage` report is parsed
 * from stdout; anything below the threshold aborts with a non-zero exit.
 *
 * Usage: node test/helpers/coverage-gate.js [threshold]
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const THRESHOLD = parseFloat(process.argv[2] || '90');
const ROOT = path.join(__dirname, '..', '..');
const TEST_DIR = path.join(ROOT, 'test', 'unit');

const args = ['--test', '--experimental-test-coverage', TEST_DIR];
const res = spawnSync(process.execPath, args, { encoding: 'utf8' });

const output = res.stdout + (res.stderr || '');

if (res.status !== 0 && !output.includes('# start of coverage report')) {
  // Tests failed before coverage could even report.
  process.stdout.write(output);
  process.exit(res.status || 1);
}

const files = [];
for (const line of output.split('\n')) {
  if (/^\s*#?\s*[\w./-]+\.js\s+\|/.test(line)) {
    const parts = line.split('|').map((s) => s.trim());
    if (parts.length >= 5) {
      files.push({ file: parts[0].replace(/^#\s*/, ''), linePct: parseFloat(parts[1]) });
    }
  }
}

const libFiles = files.filter((f) => f.file.startsWith('lib/'));
if (libFiles.length === 0) {
  process.stdout.write(output);
  console.error('\ncoverage gate: no lib/ files found in coverage report');
  process.exit(1);
}

let failed = false;
for (const f of libFiles) {
  const ok = f.linePct >= THRESHOLD;
  if (!ok) failed = true;
  console.log(`${ok ? 'ok' : 'FAIL'}  ${f.file}  ${f.linePct.toFixed(1)}%  (>= ${THRESHOLD}%)`);
}

if (failed) {
  console.error(`\ncoverage gate: lib/ must stay >= ${THRESHOLD}% line coverage`);
  process.exit(1);
}
console.log(`\ncoverage gate passed: all lib/ files >= ${THRESHOLD}%`);
process.exit(0);