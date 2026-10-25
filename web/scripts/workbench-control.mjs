#!/usr/local/bin/node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '../..');
const WEB = path.join(ROOT, 'web');
const NODE = '/usr/local/bin/node';
const NEXT = path.join(WEB, 'node_modules/next/dist/bin/next');
const BUILD_ID = path.join(WEB, '.next/BUILD_ID');
const WORKBENCH = path.join(ROOT, '.workbench');
const RUNTIME = path.join(WORKBENCH, 'runtime');
const PID_FILE = path.join(RUNTIME, 'server.json');
const LOCK_FILE = path.join(RUNTIME, 'control.lock');
const LOG_FILE = path.join(RUNTIME, 'server.log');
const ENTRY_URL = 'http://localhost:3100/';
const PORT = 3100;
const MAX_REPLY_BYTES = 64 * 1024;
const MAX_LOG_BYTES = 48 * 1024;
const MAX_LOG_LINES = 200;

const ACTIONS = new Set(['status', 'start', 'stop', 'restart', 'logs']);
const actionArgs = process.argv.slice(2);
const actionInput = actionArgs[0] || 'status';
const action = ACTIONS.has(actionInput) ? actionInput : 'status';
let actionDeadline = Number.POSITIVE_INFINITY;

function now() {
  return new Date().toISOString();
}

function oneLine(value) {
  return Array.from(String(value).replace(/[\r\n\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 300).join('');
}

function caps({ start = false, stop = false, restart = false, logs = false } = {}) {
  return { start: Boolean(start), stop: Boolean(stop), restart: Boolean(restart), logs: Boolean(logs) };
}

function component(id, name, state, summary) {
  return { id, name, state, summary: oneLine(summary) };
}

function reply(actionName, state, managed, capabilities, summary, code = null, components = [], extra = {}) {
  return {
    schemaVersion: 1,
    action: actionName,
    state,
    managed: Boolean(managed),
    capabilities: caps(capabilities),
    entryUrl: ENTRY_URL,
    checkedAt: now(),
    summary: oneLine(summary),
    code,
    components: components.slice(0, 20),
    effects: [],
    ...extra,
  };
}

function run(file, args, options = {}) {
  const remaining = actionDeadline - Date.now();
  if (remaining <= 0) return { error: new Error('control action deadline exceeded'), status: null, stdout: '', stderr: '' };
  return spawnSync(file, args, {
    encoding: 'utf8',
    timeout: Math.max(1, Math.min(options.timeout ?? 2500, remaining)),
    maxBuffer: 16 * 1024,
    cwd: options.cwd ?? ROOT,
    env: { PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' },
  });
}

function executable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function readPreconditions() {
  const problems = [];
  if (process.execPath !== NODE || !executable(NODE)) problems.push('固定 Node 24.15.0 运行时不可用');
  const versionResult = executable(NODE) ? run(NODE, ['--version']) : null;
  const version = versionResult?.stdout?.trim() || '';
  if (version !== 'v24.15.0') problems.push('Node 版本与项目锁定版本不匹配');
  if (!fs.existsSync(NEXT) || !fs.statSync(NEXT).isFile()) problems.push('项目安装的 Next.js 启动入口不可用');
  if (!fs.existsSync(BUILD_ID) || !fs.readFileSync(BUILD_ID, 'utf8').trim()) problems.push('未找到现有生产构建，请先按项目流程构建');
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(WEB, 'node_modules/next/package.json'), 'utf8'));
    if (pkg.version !== '15.5.27') problems.push('Next.js 版本与当前生产构建不匹配');
  } catch {
    problems.push('无法确认项目已安装的 Next.js 版本');
  }
  return { ok: problems.length === 0, summary: problems[0] || '固定运行时和已有生产构建可用', version };
}

function readJsonFile(file, maxBytes = 4096) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) return { kind: 'invalid' };
    return { kind: 'ok', value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (error) {
    if (error.code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'invalid' };
  }
}

function processStart(pid) {
  const result = run('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { timeout: 1500 });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function processCommand(pid) {
  const result = run('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command='], { timeout: 1500 });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function processCwd(pid) {
  const result = run('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout: 2000 });
  if (result.error || result.status !== 0) return null;
  const entry = result.stdout.split('\n').find(line => line.startsWith('n'));
  return entry ? entry.slice(1) : null;
}

function listenerPids() {
  const result = run('/usr/sbin/lsof', ['-nP', '-t', `-iTCP:${PORT}`, '-sTCP:LISTEN'], { timeout: 2000 });
  if (result.error) return { ok: false, pids: [] };
  if (result.status !== 0 && result.status !== 1) return { ok: false, pids: [] };
  const pids = result.stdout.split(/\s+/).filter(Boolean).map(Number).filter(Number.isInteger);
  return { ok: true, pids: [...new Set(pids)] };
}

function instanceRecord() {
  return readJsonFile(PID_FILE);
}

function processMatches(record) {
  if (!record || !Number.isInteger(record.pid) || record.pid <= 1 || typeof record.startedAt !== 'string') return false;
  const startedAt = processStart(record.pid);
  if (!startedAt || startedAt !== record.startedAt) return false;
  const cwd = processCwd(record.pid);
  if (cwd !== WEB) return false;
  const command = processCommand(record.pid) || '';
  return command.includes(NEXT) || command.includes('next-server');
}

function portOwnerIsManaged(record, pids) {
  return Boolean(record && pids.length === 1 && pids[0] === record.pid && processMatches(record));
}

function logAvailable() {
  try {
    return fs.lstatSync(LOG_FILE).isFile() && !fs.lstatSync(LOG_FILE).isSymbolicLink();
  } catch {
    return false;
  }
}

async function fetchText(url, deadline) {
  const remaining = Math.max(100, deadline - Date.now());
  const response = await fetch(url, { signal: AbortSignal.timeout(Math.min(1500, remaining)), redirect: 'error' });
  const text = await response.text();
  return { status: response.status, text };
}

async function healthCheck() {
  const deadline = Math.min(Date.now() + 4600, actionDeadline);
  const routes = [
    ['home', '/'],
    ['people', '/p/jingke'],
    ['chapter', '/p/jingke/06-yishui'],
  ];
  const checked = [];
  let homeHtml = '';
  for (const [id, pathname] of routes) {
    try {
      const result = await fetchText(new URL(pathname, ENTRY_URL), deadline);
      const okay = result.status === 200 && result.text.length > 0 && result.text.length <= 4 * 1024 * 1024;
      checked.push({ id, okay, status: result.status });
      if (id === 'home') homeHtml = result.text;
    } catch {
      checked.push({ id, okay: false, status: null });
    }
    if (Date.now() >= deadline) break;
  }
  const routesReady = checked.length === routes.length && checked.every(item => item.okay);
  const cssPath = homeHtml.match(/href=["']([^"']+\.css(?:\?[^"']*)?)["']/)?.[1] || null;
  let assetReady = false;
  if (routesReady && cssPath && Date.now() < deadline) {
    try {
      const result = await fetchText(new URL(cssPath, ENTRY_URL), deadline);
      assetReady = result.status === 200 && result.text.length > 0 && result.text.length <= 4 * 1024 * 1024;
    } catch {
      assetReady = false;
    }
  }
  const routeText = checked.map(item => `${item.id}:${item.status ?? '无响应'}`).join('，');
  const components = [
    component('server', '生产服务', 'ready', '由本项目脚本启动并由 PID 与监听端口核实'),
    component('routes', '页面路由', routesReady ? 'ready' : 'degraded', routeText || '页面检查未完成'),
    component('assets', '静态资源', assetReady ? 'ready' : 'degraded', assetReady ? '首页样式资源可访问' : '首页样式资源未确认可访问'),
  ];
  return { ready: routesReady && assetReady, components };
}

function readLock() {
  return readJsonFile(LOCK_FILE, 2048);
}

function lockOwnerState() {
  const lock = readLock();
  if (lock.kind !== 'ok') return lock;
  const { pid, startedAt } = lock.value || {};
  if (!Number.isInteger(pid) || typeof startedAt !== 'string') return { kind: 'invalid' };
  const currentStart = processStart(pid);
  const command = currentStart && currentStart === startedAt ? processCommand(pid) : null;
  if (!currentStart || currentStart !== startedAt || !command?.includes(fileURLToPath(import.meta.url))) return { kind: 'stale', value: lock.value };
  return { kind: 'active', value: lock.value };
}

function ensureRuntime() {
  for (const dir of [WORKBENCH, RUNTIME]) {
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('控制运行目录不是本项目的普通目录');
  }
  fs.chmodSync(WORKBENCH, 0o700);
  fs.chmodSync(RUNTIME, 0o700);
}

function acquireLock() {
  ensureRuntime();
  const existing = lockOwnerState();
  if (existing.kind === 'active' || existing.kind === 'invalid') return null;
  if (existing.kind === 'stale') fs.unlinkSync(LOCK_FILE);
  const token = randomUUID();
  const record = { pid: process.pid, startedAt: processStart(process.pid), token };
  if (!record.startedAt) return null;
  try {
    const fd = fs.openSync(LOCK_FILE, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(record));
    fs.closeSync(fd);
    return token;
  } catch (error) {
    if (error.code === 'EEXIST') return null;
    throw error;
  }
}

function releaseLock(token) {
  const lock = readLock();
  if (lock.kind === 'ok' && lock.value?.pid === process.pid && lock.value?.token === token) {
    fs.unlinkSync(LOCK_FILE);
  }
}

function writePid(record) {
  const temporary = `${PID_FILE}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, PID_FILE);
}

function removePid(record) {
  const current = instanceRecord();
  if (current.kind === 'ok' && current.value?.pid === record.pid && current.value?.startedAt === record.startedAt) {
    fs.unlinkSync(PID_FILE);
  }
}

function createEnv() {
  const user = os.userInfo();
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: os.homedir(),
    USER: user.username,
    LOGNAME: user.username,
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    TMPDIR: os.tmpdir(),
    NODE_ENV: 'production',
  };
}

async function stateView(actionName, includeLock = false) {
  const pre = readPreconditions();
  const log = logAvailable();
  if (includeLock) {
    const lock = lockOwnerState();
    if (lock.kind === 'active' || lock.kind === 'invalid') {
      return reply(actionName, 'unknown', false, { logs: log }, '项目控制动作正在执行或归属无法确认', lock.kind === 'active' ? 'PROJECT_BUSY' : 'CONTROL_LOCK_UNCONFIRMED', [component('control', '控制动作', 'unknown', '请等待当前动作结束')]);
    }
    if (lock.kind === 'stale') {
      return reply(actionName, 'unknown', false, { start: pre.ok, logs: log }, '上次控制动作异常结束，需由后续生命周期动作回收锁记录', 'CONTROL_LOCK_STALE', [component('control', '控制动作', 'unknown', '检测到已结束动作留下的锁记录')]);
    }
  }

  const pidFile = instanceRecord();
  const listeners = listenerPids();
  if (!listeners.ok) {
    return reply(actionName, 'unknown', false, { logs: log }, '无法确认本机 3100 端口的监听进程', 'PROCESS_INSPECTION_FAILED', [component('server', '生产服务', 'unknown', '系统进程检查不可用')]);
  }
  if (pidFile.kind === 'invalid') {
    return reply(actionName, 'unknown', false, { logs: log }, '项目实例记录无效，未操作任何进程', 'OWNERSHIP_UNCONFIRMED', [component('server', '生产服务', 'unknown', '本项目 PID 记录无法验证')]);
  }

  const record = pidFile.kind === 'ok' ? pidFile.value : null;
  if (listeners.pids.length === 0) {
    if (record && processMatches(record)) {
      const components = [component('server', '生产服务', 'degraded', '本项目进程仍在，但没有监听固定端口')];
      return reply(actionName, 'degraded', true, { stop: true, restart: true, logs: log }, '本项目进程未就绪，未启动重复实例', 'HEALTH_FAILED', components);
    }
    const currentStart = record ? processStart(record.pid) : null;
    if (record && currentStart === record.startedAt) {
      return reply(actionName, 'unknown', false, { logs: log }, '实例进程仍存在但命令或工作目录无法确认，未操作该进程', 'OWNERSHIP_UNCONFIRMED', [component('server', '生产服务', 'unknown', 'PID 与启动时间匹配，但项目身份检查未通过')]);
    }
    const stale = Boolean(record && currentStart && currentStart !== record.startedAt);
    const summary = !pre.ok ? pre.summary : '服务已停止';
    return reply(actionName, 'stopped', false, { start: pre.ok, logs: log }, summary, pre.ok ? null : 'PRECONDITION_MISSING', [
      component('production-build', '生产构建', pre.ok ? 'ready' : 'error', pre.summary),
      component('server', '生产服务', 'stopped', stale ? '已保存的进程号不再属于本项目，未触碰该进程' : '3100 端口没有监听进程'),
    ]);
  }

  if (!portOwnerIsManaged(record, listeners.pids)) {
    const code = record ? 'OWNERSHIP_UNCONFIRMED' : 'UNMANAGED_INSTANCE';
    return reply(actionName, 'error', false, { logs: log }, '3100 端口由无法确认归属的实例占用，未接管或停止', code, [component('server', '生产服务', 'unknown', '端口监听 PID 与本项目记录不匹配')]);
  }

  const health = await healthCheck();
  if (health.ready) {
    return reply(actionName, 'ready', true, { stop: true, restart: true, logs: log }, '首页、观史页面和静态样式资源可访问', null, health.components);
  }
  return reply(actionName, 'degraded', true, { stop: true, restart: true, logs: log }, '项目进程归属已确认，但页面或静态资源检查未通过', 'HEALTH_FAILED', health.components);
}

function logsStateView() {
  const pre = readPreconditions();
  const log = logAvailable();
  const listeners = listenerPids();
  if (!listeners.ok) return reply('logs', 'unknown', false, { logs: log }, '无法确认本机 3100 端口的监听进程', 'PROCESS_INSPECTION_FAILED', []);
  const file = instanceRecord();
  if (file.kind === 'invalid') return reply('logs', 'unknown', false, { logs: log }, '项目实例记录无效，未操作任何进程', 'OWNERSHIP_UNCONFIRMED', []);
  const record = file.kind === 'ok' ? file.value : null;
  if (listeners.pids.length === 0) {
    const stillAlive = record && processMatches(record);
    const currentStart = record ? processStart(record.pid) : null;
    if (record && !stillAlive && currentStart === record.startedAt) {
      return reply('logs', 'unknown', false, { logs: log }, '实例进程仍存在但命令或工作目录无法确认', 'OWNERSHIP_UNCONFIRMED', [component('server', '生产服务', 'unknown', 'PID 与启动时间匹配，但项目身份检查未通过')]);
    }
    return reply('logs', stillAlive ? 'degraded' : 'stopped', Boolean(stillAlive), { stop: Boolean(stillAlive), restart: Boolean(stillAlive), start: !stillAlive && pre.ok, logs: log }, stillAlive ? '本项目进程存在但未监听固定端口' : '服务已停止', stillAlive ? 'HEALTH_FAILED' : null, [component('server', '生产服务', stillAlive ? 'degraded' : 'stopped', stillAlive ? '页面状态未重新探测' : '3100 端口没有监听进程')]);
  }
  if (!portOwnerIsManaged(record, listeners.pids)) {
    return reply('logs', 'error', false, { logs: log }, '3100 端口由无法确认归属的实例占用，未接管或停止', record ? 'OWNERSHIP_UNCONFIRMED' : 'UNMANAGED_INSTANCE', [component('server', '生产服务', 'unknown', '端口监听 PID 与本项目记录不匹配')]);
  }
  const knownState = ['ready', 'degraded', 'error'].includes(record.lastState) ? record.lastState : 'unknown';
  const checkedAt = typeof record.lastCheckedAt === 'string' ? record.lastCheckedAt : now();
  const summary = typeof record.lastSummary === 'string' ? record.lastSummary : '实例归属已确认，尚无页面状态记录';
  const components = Array.isArray(record.lastComponents) ? record.lastComponents.slice(0, 20) : [component('server', '生产服务', 'ready', '实例归属和监听端口已确认')];
  return { ...reply('logs', knownState, true, { stop: true, restart: true, logs: log }, summary, knownState === 'unknown' ? 'HEALTH_NOT_CHECKED' : null, components), checkedAt };
}

function persistHealth(record, health, summary) {
  const checkedAt = now();
  const nextRecord = {
    ...record,
    lastState: health.ready ? 'ready' : 'degraded',
    lastCheckedAt: checkedAt,
    lastSummary: oneLine(summary),
    lastComponents: health.components.slice(0, 20),
  };
  writePid(nextRecord);
  return { record: nextRecord, checkedAt };
}

function stateAfterAction(actionName, view, extra = {}) {
  return { ...view, action: actionName, checkedAt: now(), ...extra };
}

function unownedPort(actionName, pids) {
  return reply(actionName, 'error', false, { logs: logAvailable() }, '3100 端口由无法确认归属的实例占用，未接管或停止', 'UNMANAGED_INSTANCE', [component('server', '生产服务', 'unknown', `监听 PID：${pids.join(', ')}`)]);
}

async function startInternal(actionName) {
  const pre = readPreconditions();
  if (!pre.ok) return reply(actionName, 'error', false, { logs: logAvailable() }, pre.summary, 'PRECONDITION_MISSING', [component('production-build', '生产构建', 'error', pre.summary)]);
  const listeners = listenerPids();
  if (!listeners.ok) return reply(actionName, 'unknown', false, { logs: logAvailable() }, '无法确认固定端口监听进程', 'PROCESS_INSPECTION_FAILED', []);
  let file = instanceRecord();
  if (file.kind === 'invalid') return reply(actionName, 'unknown', false, { logs: logAvailable() }, '项目实例记录无效，未启动新进程', 'OWNERSHIP_UNCONFIRMED', []);
  let record = file.kind === 'ok' ? file.value : null;
  if (listeners.pids.length) {
    if (!portOwnerIsManaged(record, listeners.pids)) return unownedPort(actionName, listeners.pids);
    const current = await stateView(actionName, false);
    if (current.managed && (current.state === 'ready' || current.state === 'degraded')) {
      const persisted = persistHealth(record, { ready: current.state === 'ready', components: current.components }, current.summary);
      current.checkedAt = persisted.checkedAt;
    }
    return stateAfterAction(actionName, current);
  }
  if (record) {
    if (processMatches(record)) {
      return reply(actionName, 'degraded', true, { stop: true, restart: true, logs: logAvailable() }, '本项目进程仍在但未监听 3100，拒绝重复启动', 'HEALTH_FAILED', [component('server', '生产服务', 'degraded', '现有进程仍存活')]);
    }
    const startedAt = processStart(record.pid);
    if (startedAt && startedAt === record.startedAt) {
      return reply(actionName, 'unknown', false, { logs: logAvailable() }, '本项目进程归属无法确认，未启动新实例', 'OWNERSHIP_UNCONFIRMED', []);
    }
    removePid(record);
    record = null;
  }

  let logFd;
  try {
    logFd = fs.openSync(LOG_FILE, 'a', 0o600);
    fs.fchmodSync(logFd, 0o600);
  } catch {
    return reply(actionName, 'error', false, { start: false, logs: logAvailable() }, '无法创建项目自有运行日志', 'RUNTIME_UNAVAILABLE', []);
  }
  let child;
  try {
    child = spawn(NODE, [NEXT, 'start', '--hostname', 'localhost', '--port', String(PORT)], {
      cwd: WEB,
      env: createEnv(),
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
  } catch {
    fs.closeSync(logFd);
    return reply(actionName, 'error', false, { start: true, logs: true }, '无法启动项目生产服务进程', 'START_FAILED', []);
  }
  fs.closeSync(logFd);
  let spawnFailed = false;
  child.once('error', () => { spawnFailed = true; });
  child.unref();
  let startedAt = null;
  const tokenDeadline = Date.now() + 3000;
  while (Date.now() < tokenDeadline && !startedAt && !spawnFailed && child.exitCode === null) {
    startedAt = processStart(child.pid);
    if (!startedAt) await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!startedAt) {
    return reply(actionName, spawnFailed || child.exitCode !== null ? 'error' : 'unknown', false, { logs: true }, spawnFailed || child.exitCode !== null ? '生产服务启动进程未能创建或提前退出' : '启动进程身份无法确认，未尝试接管', spawnFailed || child.exitCode !== null ? 'START_FAILED' : 'OWNERSHIP_UNCONFIRMED', []);
  }
  record = { pid: child.pid, startedAt, node: NODE, next: NEXT, host: 'localhost', port: PORT };
  writePid(record);

  const deadline = Date.now() + 105_000;
  while (Date.now() < deadline) {
    const currentStart = processStart(record.pid);
    if (!currentStart || currentStart !== record.startedAt) {
      removePid(record);
      return reply(actionName, 'error', false, { logs: true }, '生产服务启动后提前退出', 'START_FAILED', [component('server', '生产服务', 'error', '进程已退出')]);
    }
    const ports = listenerPids();
    if (!ports.ok) {
      return reply(actionName, 'unknown', true, { stop: true, restart: true, logs: true }, '进程已启动，但无法核实端口监听状态', 'PROCESS_INSPECTION_FAILED', []);
    }
    if (ports.pids.length && !portOwnerIsManaged(record, ports.pids)) {
      return unownedPort(actionName, ports.pids);
    }
    if (ports.pids.length === 1) {
      const health = await healthCheck();
      if (health.ready && portOwnerIsManaged(record, listenerPids().pids)) {
        const summary = '首页、观史页面和静态样式资源可访问';
        const persisted = persistHealth(record, health, summary);
        record = persisted.record;
        return { ...reply(actionName, 'ready', true, { stop: true, restart: true, logs: true }, summary, null, health.components), checkedAt: persisted.checkedAt };
      }
      if (portOwnerIsManaged(record, listenerPids().pids)) {
        const summary = '项目进程归属已确认，但页面或静态资源检查未通过';
        const persisted = persistHealth(record, health, summary);
        record = persisted.record;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  const stopped = await stopOwned(record, 8000);
  if (stopped.state === 'stopped') removePid(record);
  return reply(actionName, stopped.state === 'stopped' ? 'error' : 'unknown', stopped.managed, { logs: true, stop: stopped.managed, restart: stopped.managed }, '生产服务未在时限内通过完整页面和资源检查', 'HEALTH_FAILED', stopped.components);
}

async function stopOwned(record, timeoutMs = 25_000) {
  if (!record || !processMatches(record)) {
    const listeners = listenerPids();
    if (listeners.ok && listeners.pids.length === 0) {
      if (record) removePid(record);
      return { state: 'stopped', managed: false, components: [component('server', '生产服务', 'stopped', '没有本项目运行进程')] };
    }
    return { state: 'unknown', managed: false, components: [component('server', '生产服务', 'unknown', 'PID 与启动时身份不匹配，未向该进程发信号')] };
  }
  try {
    process.kill(record.pid, 'SIGTERM');
  } catch (error) {
    if (error.code !== 'ESRCH') return { state: 'degraded', managed: true, components: [component('server', '生产服务', 'degraded', '向已核验的本项目进程发送正常停止信号失败')] };
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const startedAt = processStart(record.pid);
    if (!startedAt || startedAt !== record.startedAt) {
      const listeners = listenerPids();
      if (listeners.ok && listeners.pids.length === 0) {
        removePid(record);
        return { state: 'stopped', managed: false, components: [component('server', '生产服务', 'stopped', '本项目进程已正常退出，固定端口已释放')] };
      }
      return { state: 'unknown', managed: false, components: [component('server', '生产服务', 'unknown', '本项目进程已退出，但固定端口仍有未归属监听者')] };
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return { state: 'degraded', managed: true, components: [component('server', '生产服务', 'degraded', '本项目进程在 25 秒内未正常退出，未使用强制终止')] };
}

async function stopInternal(actionName) {
  const listeners = listenerPids();
  if (!listeners.ok) return reply(actionName, 'unknown', false, { logs: logAvailable() }, '无法确认固定端口监听进程', 'PROCESS_INSPECTION_FAILED', []);
  const file = instanceRecord();
  if (file.kind === 'invalid') return reply(actionName, 'unknown', false, { logs: logAvailable() }, '项目实例记录无效，未操作任何进程', 'OWNERSHIP_UNCONFIRMED', []);
  const record = file.kind === 'ok' ? file.value : null;
  if (listeners.pids.length === 0) {
    if (record && processMatches(record)) {
      const stopped = await stopOwned(record);
      return reply(actionName, stopped.state, stopped.managed, { start: readPreconditions().ok, stop: stopped.managed, restart: stopped.managed, logs: logAvailable() }, stopped.state === 'stopped' ? '服务已停止' : '本项目进程未能确认停止', stopped.state === 'stopped' ? null : 'STOP_TIMEOUT', stopped.components);
    }
    if (record && processStart(record.pid) === record.startedAt) {
      return reply(actionName, 'unknown', false, { logs: logAvailable() }, '实例进程仍存在但命令或工作目录无法确认，未操作该进程', 'OWNERSHIP_UNCONFIRMED', [component('server', '生产服务', 'unknown', 'PID 与启动时间匹配，但项目身份检查未通过')]);
    }
    if (record) removePid(record);
    return reply(actionName, 'stopped', false, { start: readPreconditions().ok, logs: logAvailable() }, '服务已停止', null, [component('server', '生产服务', 'stopped', '3100 端口没有监听进程')]);
  }
  if (!portOwnerIsManaged(record, listeners.pids)) return unownedPort(actionName, listeners.pids);
  const stopped = await stopOwned(record);
  return reply(actionName, stopped.state, stopped.managed, { start: readPreconditions().ok, stop: stopped.managed, restart: stopped.managed, logs: logAvailable() }, stopped.state === 'stopped' ? '服务已停止' : '本项目进程未能确认停止', stopped.state === 'stopped' ? null : stopped.state === 'unknown' ? 'OWNERSHIP_UNCONFIRMED' : 'STOP_TIMEOUT', stopped.components);
}

async function logsReply() {
  const view = logsStateView();
  let text = '';
  let truncated = false;
  if (logAvailable()) {
    const fd = fs.openSync(LOG_FILE, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const length = Math.min(size, MAX_LOG_BYTES);
      const selected = Buffer.alloc(length);
      fs.readSync(fd, selected, 0, length, Math.max(0, size - length));
      truncated = size > MAX_LOG_BYTES;
      text = selected.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    text = text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    text = text.replace(/(^[ \t]*|\b)(authorization|proxy-authorization|cookie|set-cookie)([ \t]*[:=][ \t]*)[^\r\n]*/gim, '$1$2$3[已隐藏]');
    text = text.replace(/((?:password|passwd|token|secret|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, '$1[已隐藏]');
    const lines = text.split('\n');
    if (lines.length > MAX_LOG_LINES) {
      text = lines.slice(-MAX_LOG_LINES).join('\n');
      truncated = true;
    }
    while (Buffer.byteLength(text, 'utf8') > MAX_LOG_BYTES) {
      text = text.slice(Math.max(1, Math.floor(text.length / 16)));
      truncated = true;
    }
  }
  let result = { ...view, action: 'logs', log: { text, truncated } };
  while (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_REPLY_BYTES && text.length) {
    text = text.slice(Math.max(1, Math.floor(text.length / 4)));
    truncated = true;
    result = { ...result, log: { text, truncated } };
  }
  return result;
}

async function runLifecycle() {
  const token = acquireLock();
  if (!token) return reply(action, 'unknown', false, { logs: logAvailable() }, '另一个控制动作正在执行或锁归属无法确认', 'PROJECT_BUSY', [component('control', '控制动作', 'unknown', '未并行执行启停动作')]);
  try {
    if (action === 'start') return await startInternal(action);
    if (action === 'stop') return await stopInternal(action);
    if (action === 'restart') {
      const stopped = await stopInternal('restart');
      if (stopped.state !== 'stopped') return stopped;
      return await startInternal('restart');
    }
    return reply(action, 'error', false, {}, '不支持的控制动作', 'INVALID_ACTION', []);
  } finally {
    releaseLock(token);
  }
}

function emit(value, exitCode = 0) {
  const line = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(line, 'utf8') <= MAX_REPLY_BYTES) {
    process.stdout.write(line);
    process.exitCode = exitCode;
    return;
  }
  const fallback = reply(value.action, 'unknown', false, {}, '控制结果超过协议大小上限', 'REPLY_TOO_LARGE', []);
  process.stdout.write(`${JSON.stringify(fallback)}\n`);
  process.exitCode = 1;
}

async function main() {
  if (actionArgs.length > 1 || !ACTIONS.has(actionInput)) {
    emit(reply('status', 'error', false, {}, '用法：control status|start|stop|restart|logs', 'INVALID_ACTION', []), 2);
    return;
  }
  const actionBudget = { status: 4500, logs: 4500, start: 110_000, stop: 28_000, restart: 140_000 }[action];
  actionDeadline = Date.now() + actionBudget;
  let result;
  if (action === 'status') result = await stateView(action, true);
  else if (action === 'logs') result = await logsReply();
  else result = await runLifecycle();
  const exitCode = action === 'status' || action === 'logs' ? 0 : result.code === null && (action === 'stop' ? result.state === 'stopped' : result.state === 'ready') ? 0 : 1;
  emit(result, exitCode);
}

main().catch(() => {
  emit(reply(action, 'unknown', false, {}, '控制脚本内部错误，未确认服务状态', 'CONTROL_ERROR', []), 1);
});
