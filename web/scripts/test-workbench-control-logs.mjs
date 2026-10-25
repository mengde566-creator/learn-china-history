import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '../..');

test('control logs hides complete authorization and cookie header values', t => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't27a-control-logs-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

  const control = path.join(temporaryRoot, '.workbench/control');
  const helper = path.join(temporaryRoot, 'web/scripts/workbench-control.mjs');
  const logFile = path.join(temporaryRoot, '.workbench/runtime/server.log');
  fs.mkdirSync(path.dirname(control), { recursive: true });
  fs.mkdirSync(path.dirname(helper), { recursive: true });
  fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
  fs.copyFileSync(path.join(projectRoot, '.workbench/control'), control);
  fs.copyFileSync(path.join(scriptDirectory, 'workbench-control.mjs'), helper);
  fs.chmodSync(control, 0o755);

  const sentinels = [
    'T27A_BEARER_SENTINEL',
    'T27A_COOKIE_SESSION_SENTINEL',
    'T27A_COOKIE_REFRESH_SENTINEL',
    'T27A_API_KEY_SENTINEL',
  ];
  const input = [
    ...Array.from({ length: 250 }, (_, index) => `event-${index}:${'x'.repeat(220)}`),
    `Authorization: Bearer ${sentinels[0]}`,
    `Cookie: session=${sentinels[1]}; refresh=${sentinels[2]}`,
    `api_key=${sentinels[3]}`,
    'event=page-rendered',
  ].join('\n') + '\n';
  fs.writeFileSync(logFile, input, { mode: 0o600 });
  const originalLog = fs.readFileSync(logFile);

  const result = spawnSync(control, ['logs'], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 64 * 1024,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.ok(Buffer.byteLength(result.stdout, 'utf8') <= 64 * 1024);

  const reply = JSON.parse(result.stdout);
  assert.equal(reply.action, 'logs');
  assert.equal(reply.log.truncated, true);
  assert.ok(Buffer.byteLength(reply.log.text, 'utf8') <= 48 * 1024);
  assert.ok(reply.log.text.split('\n').length - 1 <= 200);
  assert.match(reply.log.text, /^Authorization: \[已隐藏\]$/m);
  assert.match(reply.log.text, /^Cookie: \[已隐藏\]$/m);
  assert.match(reply.log.text, /^api_key=\[已隐藏\]$/m);
  assert.match(reply.log.text, /event=page-rendered/);
  for (const sentinel of sentinels) assert.ok(!result.stdout.includes(sentinel), `${sentinel} leaked`);
  assert.deepEqual(fs.readFileSync(logFile), originalLog);
  assert.equal(fs.existsSync(path.join(temporaryRoot, '.workbench/runtime/control.lock')), false);
});
