const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

function run(args, env = {}, timeout = 20_000) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout,
    env: { ...process.env, ...env },
  });
}

test('an unknown flag fails loudly instead of falling through to the wizard', () => {
  const result = run(['--definitely-not-a-flag']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown option --definitely-not-a-flag/);
  assert.match(result.stderr, /npm run build/);
  assert.ok(!result.stderr.includes('PRIVATE KEY SOURCE'));
});

test('--help lists --serve (a cheap stale-dist check)', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--serve/);
});

test('--serve refuses to start when private keys are in the environment', () => {
  const envFile = path.join(os.tmpdir(), `serve-env-${Date.now()}`);
  fs.writeFileSync(envFile, 'SERVE_PORT=0\n');
  try {
    const result = run(['--serve'], { SERVE_ENV_FILE: envFile, PRIVATE_KEY: '0xdeadbeef' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /refuses to run with PRIVATE_KEY/);
  } finally {
    fs.rmSync(envFile, { force: true });
  }
});
