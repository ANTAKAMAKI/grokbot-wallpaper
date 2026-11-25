#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import { watch as watchDirectory } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const execFileUtf8 = promisify(execFile);
export const DEBUG_PORT = 19222;
export const PANEL_PORT = 19223;
export const LOOPBACK = '127.0.0.1';
export const PROTOCOL = 2;
export const AGENT_LABEL = 'com.kingao.grokbot-wallpaper';
export const BINDING = 'grokbotWallpaperSave';
export const WATCH_MODE = 'event-driven';
export const RELAUNCH_COOLDOWN_MS = 60_000;
export const RELAUNCH_FAILURE_CAP = 3;
export const RELAUNCH_FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const STORM_WINDOW_MS = 60_000;
export const STORM_START_CAP = 3;
const LIMIT = 4 * 1024 * 1024;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const help = `Grok Bot 本地壁纸（Node.js 22+ / macOS）
  node scripts/grokbot-wallpaper.mjs apply <image> [--opacity 0.9] [--dark|--light] [--relaunch]
  node scripts/grokbot-wallpaper.mjs restore
  node scripts/grokbot-wallpaper.mjs status
  node scripts/grokbot-wallpaper.mjs panel
  node scripts/grokbot-wallpaper.mjs watch
首次开启本机调试端口需要确认后传 --relaunch。那一次只会正常退出并重新打开，不会强制结束进程。
登录后助手会待命。Grok Bot 真正打开时，才按上次的壁纸恢复聊天背景。
助手不轮询。应用启动、页面导航、重新加载和新窗口都走系统通知和调试事件。
默认透明度 0.9，范围 0.15–1。仅使用 127.0.0.1:${DEBUG_PORT} 与 127.0.0.1:${PANEL_PORT}。`;

export function clampOpacity(value) {
  return Math.max(0.15, Math.min(1, Number(value)));
}
export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}
export function assertLoopbackHost(host) {
  if (host !== LOOPBACK) {
    const error = new Error('面板只能绑定 127.0.0.1。');
    error.code = 'host-rejected';
    throw error;
  }
}
export function isAllowedDebugUrl(address, port = DEBUG_PORT) {
  let url;
  try { url = new URL(address); } catch { return false; }
  return url.protocol === 'ws:' && url.hostname === LOOPBACK && url.port === String(port);
}
export function hasExactFlag(command, flag) {
  let from = 0;
  const text = String(command);
  while (from < text.length) {
    const at = text.indexOf(flag, from);
    if (at < 0) return false;
    const before = at === 0 ? ' ' : text[at - 1];
    const after = text[at + flag.length] ?? ' ';
    if (/\s/.test(before) && /\s/.test(after)) return true;
    from = at + flag.length;
  }
  return false;
}
export function commandHasLoopbackDebug(command, port = DEBUG_PORT) {
  return hasExactFlag(command, `--remote-debugging-port=${port}`)
    && hasExactFlag(command, '--remote-debugging-address=127.0.0.1');
}
export function isMainBinary(command, app) {
  const bin = path.join(app, 'Contents/MacOS/Grok Bot');
  return command === bin || command.startsWith(`${bin} `);
}
export function parseProcessList(stdout, app) {
  const found = [];
  for (const line of String(stdout).split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!match || !app) continue;
    const command = match[2];
    if (isMainBinary(command, app)) found.push({ pid: Number(match[1]), command });
  }
  return found;
}
export function isGrokAppEvent(event) {
  if (!event || (event.type !== 'launch' && event.type !== 'terminate')) return false;
  const appPath = String(event.path || '');
  return event.name === 'Grok Bot' || appPath.includes('/Grok Bot.app');
}
export function parseMonitorLine(line) {
  const trimmed = String(line).trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const msg = JSON.parse(trimmed);
    if (!msg || typeof msg.type !== 'string') return null;
    if (msg.pid != null) msg.pid = Number(msg.pid);
    return msg;
  } catch {
    return null;
  }
}
export function isWallpaperTarget(info) {
  if (!info || !['page', 'webview'].includes(info.type)) return false;
  return !/^(devtools|chrome|chrome-extension):/.test(info.url || '');
}
export function emptyGuard() {
  return { failures: [], handled: {}, suppressedPids: [], cooldownUntil: 0, stopped: false, reason: null };
}
function normalizeGuard(state) {
  const base = state && typeof state === 'object' ? state : {};
  return {
    failures: Array.isArray(base.failures) ? base.failures.filter(item => Number.isFinite(item)) : [],
    handled: base.handled && typeof base.handled === 'object' ? { ...base.handled } : {},
    suppressedPids: Array.isArray(base.suppressedPids) ? base.suppressedPids.filter(item => Number.isFinite(item)) : [],
    cooldownUntil: Number.isFinite(base.cooldownUntil) ? base.cooldownUntil : 0,
    stopped: Boolean(base.stopped),
    reason: base.reason ?? null,
  };
}
export function assessRelaunch(state, trigger, now, opts = {}) {
  const windowMs = opts.windowMs ?? RELAUNCH_FAILURE_WINDOW_MS;
  const cap = opts.cap ?? RELAUNCH_FAILURE_CAP;
  const pruned = normalizeGuard(state);
  pruned.failures = pruned.failures.filter(item => now - item < windowMs);
  if (pruned.failures.length >= cap) {
    pruned.stopped = true;
    pruned.reason = 'relaunch-cap';
    return { allow: false, code: 'relaunch-cap', state: pruned };
  }
  pruned.stopped = false;
  if (pruned.reason === 'relaunch-cap') pruned.reason = null;
  if (pruned.handled[trigger.id]) return { allow: false, code: 'trigger-handled', state: pruned };
  if (pruned.cooldownUntil && now < pruned.cooldownUntil) return { allow: false, code: 'cooldown', state: pruned };
  if (trigger.pid != null && pruned.suppressedPids.includes(trigger.pid)) {
    return { allow: false, code: 'suppressed-pid', state: pruned };
  }
  return { allow: true, code: null, state: pruned };
}
export function reserveRelaunch(state, trigger, now, cooldownMs = RELAUNCH_COOLDOWN_MS) {
  const next = normalizeGuard(state);
  next.handled[trigger.id] = now;
  next.cooldownUntil = now + cooldownMs;
  return next;
}
function addPid(list, pid) {
  if (pid == null || list.includes(pid)) return list;
  return [...list, pid];
}
export function recordRelaunchFailure(state, now, { code, resultPid = null, originPid = null, windowMs = RELAUNCH_FAILURE_WINDOW_MS, cap = RELAUNCH_FAILURE_CAP } = {}) {
  const next = normalizeGuard(state);
  next.failures = [...next.failures.filter(item => now - item < windowMs), now];
  next.suppressedPids = addPid(addPid(next.suppressedPids, originPid), resultPid);
  next.stopped = next.failures.length >= cap;
  next.reason = next.stopped ? 'relaunch-cap' : (code || 'relaunch-failed');
  return next;
}
export function shouldPersistDiagnostic(code) {
  return [
    'quit-refused', 'relaunch-no-debug', 'relaunch-cap', 'relaunch-failed', 'debug-timeout', 'debug-unsafe',
    'debug-not-ready', 'debug-session-lost', 'panel-legacy', 'panel-foreign', 'handover-failed', 'lock-contended',
    'launch-monitor-down', 'restart-storm', 'inject-failed', 'state-unreadable', 'bootout-stuck', 'bootstrap-failed',
    'panel-not-ready', 'app-missing',
  ].includes(code);
}
export function parseLaunchctlPrint(stdout) {
  const text = String(stdout || '');
  if (!text.trim() || /Could not find service/i.test(text)) return null;
  const pid = text.match(/^\s*pid\s*=\s*(\d+)\s*$/m);
  const state = text.match(/^\s*state\s*=\s*(\S+)\s*$/m);
  return { pid: pid ? Number(pid[1]) : null, state: state ? state[1] : null };
}
export function isBootstrapConflict(error) {
  const text = `${error?.message ?? ''}\n${error?.stderr ?? ''}\n${error?.stdout ?? ''}`;
  return /input\/output error/i.test(text)
    || /already bootstrapped/i.test(text)
    || /service already loaded/i.test(text)
    || /Bootstrap failed:\s*5\b/i.test(text);
}
function errorText(error) {
  return [error?.message, error?.stderr, error?.stdout].filter(Boolean).join('\n');
}
function escapeXml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
export function buildAgentPlist({ label = AGENT_LABEL, nodePath, scriptPath, dir, logPath }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${escapeXml(label)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(scriptPath)}</string>
    <string>watch</string>
  </array>
  <key>WorkingDirectory</key><string>${escapeXml(dir)}</string>
  <key>StandardOutPath</key><string>${escapeXml(logPath)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(logPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin:${escapeXml(path.dirname(nodePath))}</string>
    <key>GROKBOT_WALLPAPER_AGENT</key><string>1</string>
  </dict>
</dict>
</plist>
`;
}
export function launchMonitorSource() {
  return `
ObjC.import('Cocoa');
ObjC.import('Foundation');
function emit(obj) {
  var line = JSON.stringify(obj) + '\\n';
  var ns = $.NSString.alloc.initWithUTF8String(line);
  var data = ns.dataUsingEncoding($.NSUTF8StringEncoding);
  var out = $.NSFileHandle.fileHandleWithStandardOutput;
  out.writeData(data);
  out.synchronizeFile;
}
function text(value) {
  if (value === null || value === undefined) return '';
  try { if (value.js !== undefined) return String(value.js); } catch (e) {}
  try { return String(ObjC.unwrap(value)); } catch (e2) {}
  return '';
}
function emitApp(kind, note) {
  var app = note.userInfo.objectForKey($.NSWorkspaceApplicationKey);
  var appPath = text(app.bundleURL.path);
  var name = text(app.localizedName);
  if (name !== 'Grok Bot' && appPath.indexOf('/Grok Bot.app') < 0) return;
  emit({
    type: kind,
    name: name,
    bundleId: text(app.bundleIdentifier),
    path: appPath,
    pid: Number(app.processIdentifier)
  });
}
ObjC.registerSubclass({
  name: 'GrokbotWallpaperLaunchObserver',
  superClassName: 'NSObject',
  methods: {
    'launched:': { types: ['void', ['id']], implementation: function (note) { emitApp('launch', note); } },
    'terminated:': { types: ['void', ['id']], implementation: function (note) { emitApp('terminate', note); } }
  }
});
var observer = $.GrokbotWallpaperLaunchObserver.alloc.init;
globalThis.__grokbotWallpaperObserver = observer;
var center = $.NSWorkspace.sharedWorkspace.notificationCenter;
center.addObserverSelectorNameObject(observer, 'launched:', $.NSWorkspaceDidLaunchApplicationNotification, null);
center.addObserverSelectorNameObject(observer, 'terminated:', $.NSWorkspaceDidTerminateApplicationNotification, null);
emit({ type: 'ready' });
$.NSRunLoop.mainRunLoop.runUntilDate($.NSDate.distantFuture);
`;
}
export function startLaunchMonitor({ spawnImpl = spawn, onEvent, onExit }) {
  const child = spawnImpl('/usr/bin/osascript', ['-l', 'JavaScript', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  child.stdout.setEncoding?.('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const event = parseMonitorLine(line);
      if (event) onEvent(event);
    }
  });
  child.on('exit', code => onExit?.(code ?? null));
  child.stdin.end(launchMonitorSource());
  return { stop() { try { child.kill(); } catch { /* monitor already gone */ } }, child };
}
export function runLaunchMonitor({ start = startLaunchMonitor, onEvent, onGiveUp }) {
  let failures = 0;
  let current = null;
  let stopped = false;
  function arm() {
    if (stopped) return;
    current = start({
      onEvent,
      onExit: code => {
        if (stopped) return;
        failures += 1;
        if (failures > 1) {
          onGiveUp?.(code);
          return;
        }
        queueMicrotask(arm);
      },
    });
  }
  arm();
  return {
    stop() { stopped = true; current?.stop(); },
    get failures() { return failures; },
  };
}

export async function waitUntil(predicate, { timeout = 1000, interval = 50, sleep: sleepImpl = sleep, now = Date.now, maxAttempts } = {}) {
  const cap = maxAttempts ?? Math.max(1, Math.ceil(timeout / interval) + 1);
  const start = now();
  for (let attempt = 0; attempt < cap; attempt += 1) {
    const value = await predicate();
    if (value) return value;
    if (now() - start >= timeout) return null;
    await sleepImpl(interval);
  }
  return null;
}

export async function quitAppNormally({ exec, listProcesses, sleep: sleepImpl = sleep, now = Date.now, timeoutMs = 10000 }) {
  await exec('osascript', ['-e', 'tell application "Grok Bot" to quit'], { timeout: 8000 }).catch(() => {});
  const stopped = await waitUntil(async () => (await listProcesses()).length === 0, {
    timeout: timeoutMs, interval: 250, sleep: sleepImpl, now,
  });
  if (!stopped) {
    const error = new Error('Grok Bot 尚未退出。已停止，没有强制结束进程。');
    error.code = 'quit-refused';
    throw error;
  }
}
export async function openWithDebug({ exec, appPath, debugPort = DEBUG_PORT }) {
  if (!appPath) {
    const error = new Error('未找到 Grok Bot.app，请安装在 /Applications 或 ~/Applications。');
    error.code = 'app-missing';
    throw error;
  }
  const args = ['-a', appPath, '--args', `--remote-debugging-port=${debugPort}`, '--remote-debugging-address=127.0.0.1'];
  await exec('open', args);
  return args;
}
export async function runOneRelaunch(deps) {
  await deps.quitApp();
  const lingering = await deps.listProcesses();
  if (lingering.some(proc => deps.isMain(proc.command))) {
    const error = new Error('Grok Bot 尚未退出。已停止，没有强制结束进程。');
    error.code = 'quit-refused';
    throw error;
  }
  await deps.openWithDebug();
  const version = await waitUntil(() => deps.probe(), {
    timeout: deps.debugTimeoutMs ?? 20000,
    interval: deps.debugIntervalMs ?? 400,
    sleep: deps.sleep ?? sleep,
    now: deps.now ?? Date.now,
    maxAttempts: deps.debugMaxAttempts,
  });
  if (!version) {
    const error = new Error('等待本机调试端口超时。已停止，不会再次退出。');
    error.code = 'debug-timeout';
    throw error;
  }
  if (!isAllowedDebugUrl(version.webSocketDebuggerUrl, deps.debugPort ?? DEBUG_PORT)) {
    const error = new Error('调试端口不是 127.0.0.1。已停止。');
    error.code = 'debug-unsafe';
    throw error;
  }
  const after = await deps.listProcesses();
  const main = after.find(proc => deps.isMain(proc.command));
  if (!main || !commandHasLoopbackDebug(main.command, deps.debugPort ?? DEBUG_PORT)) {
    const error = new Error('应用已打开，但没有仅本机调试参数。已停止，不会再次退出。');
    error.code = 'relaunch-no-debug';
    throw error;
  }
  return version;
}

function eligible(last) {
  return Boolean(last && last.image && last.restored !== true);
}
export function createWatchController(deps) {
  let chain = Promise.resolve();
  let sessionActive = false;
  let currentBrowser = null;
  let reconnects = 0;
  let batch = [];
  let scheduled = false;
  let pendingNav = Promise.resolve();
  const guardOpts = {
    windowMs: deps.failureWindowMs ?? RELAUNCH_FAILURE_WINDOW_MS,
    cap: deps.failureCap ?? RELAUNCH_FAILURE_CAP,
  };
  function exclusive(fn) {
    const run = chain.then(fn, fn);
    chain = run.then(() => {}, () => {});
    return run;
  }
  async function diagnose(entry) {
    if (deps.diagnose) await deps.diagnose(entry);
  }
  async function readLastSafe() {
    try { return await deps.readLast(); }
    catch (error) {
      await diagnose({ code: 'state-unreadable', message: error.message });
      return null;
    }
  }
  async function attachIfNeeded(version) {
    const url = version?.webSocketDebuggerUrl;
    if (!url || !isAllowedDebugUrl(url, deps.debugPort ?? DEBUG_PORT)) {
      await diagnose({ code: 'debug-unsafe' });
      return false;
    }
    if (sessionActive && currentBrowser === url) return true;
    currentBrowser = url;
    sessionActive = true;
    try {
      await deps.attach(version);
      return true;
    } catch (error) {
      sessionActive = false;
      currentBrowser = null;
      await diagnose({ code: 'inject-failed', message: error.message });
      return false;
    }
  }
  async function attemptRelaunch(trigger) {
    const now = deps.now();
    const decision = assessRelaunch(await deps.readGuard(), trigger, now, guardOpts);
    if (!decision.allow) {
      await deps.writeGuard(decision.state);
      await diagnose({ code: decision.code, trigger: trigger.id });
      return { action: 'skipped', code: decision.code };
    }
    const reserved = reserveRelaunch(decision.state, trigger, now, deps.cooldownMs ?? RELAUNCH_COOLDOWN_MS);
    await deps.writeGuard(reserved);
    try {
      const result = await deps.relaunch();
      if (!result?.ok) {
        const failed = recordRelaunchFailure(reserved, deps.now(), {
          code: result?.code || 'relaunch-failed',
          resultPid: result?.pid ?? null,
          originPid: trigger.pid,
          ...guardOpts,
        });
        await deps.writeGuard(failed);
        await diagnose({ code: result?.code || failed.reason, trigger: trigger.id, message: result?.message });
        return { action: 'failed', code: result?.code || 'relaunch-failed' };
      }
      if (result.version) await attachIfNeeded(result.version);
      return { action: 'relaunched' };
    } catch (error) {
      const failed = recordRelaunchFailure(reserved, deps.now(), {
        code: error.code || 'relaunch-failed',
        originPid: trigger.pid,
        ...guardOpts,
      });
      await deps.writeGuard(failed);
      await diagnose({ code: error.code || 'relaunch-failed', message: error.message, trigger: trigger.id });
      return { action: 'failed', code: error.code || 'relaunch-failed' };
    }
  }
  async function handleProcess(kind, hintedPid = null) {
    const last = await readLastSafe();
    if (!eligible(last)) return { action: 'inactive' };
    const procs = await deps.listProcesses();
    const main = procs.find(proc => proc.pid === hintedPid) || procs.find(proc => deps.isMain(proc.command));
    if (!main) return { action: kind === 'startup' ? 'idle' : 'absent' };
    if (commandHasLoopbackDebug(main.command, deps.debugPort ?? DEBUG_PORT)) {
      let version = await deps.probe();
      if (!version) version = await deps.waitForDebug?.();
      if (!version) {
        await diagnose({ code: 'debug-not-ready', pid: main.pid });
        return { action: 'failed', code: 'debug-not-ready' };
      }
      const ok = await attachIfNeeded(version);
      return ok ? { action: 'attached' } : { action: 'failed', code: 'debug-unsafe' };
    }
    let version = await deps.probe();
    if (version) {
      if (!isAllowedDebugUrl(version.webSocketDebuggerUrl, deps.debugPort ?? DEBUG_PORT)) {
        await diagnose({ code: 'debug-unsafe' });
        return { action: 'failed', code: 'debug-unsafe' };
      }
      const ok = await attachIfNeeded(version);
      return ok ? { action: 'attached' } : { action: 'failed', code: 'debug-unsafe' };
    }
    return attemptRelaunch({ id: `${kind}:${main.pid}`, pid: main.pid, kind });
  }
  return {
    startup() {
      return exclusive(async () => {
        const last = await readLastSafe();
        if (!eligible(last)) return { action: 'inactive' };
        const version = await deps.probe();
    if (version) {
      const ok = await attachIfNeeded(version);
      return ok ? { action: 'attached' } : { action: 'failed', code: 'debug-unsafe' };
    }
        const procs = await deps.listProcesses();
        const main = procs.find(proc => deps.isMain(proc.command));
        if (!main) return { action: 'idle' };
        return handleProcess('startup', main.pid);
      });
    },
    onLaunchEvent(event) {
      reconnects = 0;
      return exclusive(() => handleProcess('launch', event?.pid ?? null));
    },
    onTerminate() {
      return exclusive(async () => {
        sessionActive = false;
        currentBrowser = null;
        reconnects = 0;
        if (deps.detach) await deps.detach();
        return { action: 'detached' };
      });
    },
    onSessionClose() {
      return exclusive(async () => {
        sessionActive = false;
        currentBrowser = null;
        if (reconnects >= 1) {
          await diagnose({ code: 'debug-session-lost' });
          return { action: 'stopped', code: 'debug-session-lost' };
        }
        reconnects += 1;
        const version = await deps.probe();
        if (version && isAllowedDebugUrl(version.webSocketDebuggerUrl, deps.debugPort ?? DEBUG_PORT)) {
          await attachIfNeeded(version);
          return { action: 'reconnected' };
        }
        const procs = await deps.listProcesses();
        const main = procs.find(proc => deps.isMain(proc.command));
        if (!main) return { action: 'idle' };
        if (commandHasLoopbackDebug(main.command, deps.debugPort ?? DEBUG_PORT)) {
          await diagnose({ code: 'debug-not-ready', pid: main.pid });
          return { action: 'failed', code: 'debug-not-ready' };
        }
        const last = await readLastSafe();
        if (!eligible(last)) return { action: 'inactive' };
        return attemptRelaunch({ id: `disconnect:${main.pid}`, pid: main.pid, kind: 'disconnect' });
      });
    },
    onNavigation(info) {
      batch.push(info);
      if (!scheduled) {
        scheduled = true;
        pendingNav = (async () => {
          await (deps.defer ? deps.defer() : Promise.resolve());
          scheduled = false;
          const last = batch[batch.length - 1];
          batch = [];
          if (!sessionActive) return { action: 'no-session' };
          try {
            await deps.ensureOverlay(last);
            return { action: 'ensured', info: last };
          } catch (error) {
            await diagnose({ code: 'inject-failed', message: error.message });
            return { action: 'failed', code: 'inject-failed' };
          }
        })();
      }
      return pendingNav;
    },
    async onWallpaperFile() {
      const last = await readLastSafe();
      if (!eligible(last)) {
        sessionActive = false;
        if (deps.uninstall) await deps.uninstall();
        return { action: 'inactive' };
      }
      if (!sessionActive) return { action: 'pending' };
      try {
        await deps.ensureOverlay({ reason: 'last-applied' });
        return { action: 'ensured' };
      } catch (error) {
        await diagnose({ code: 'inject-failed', message: error.message });
        return { action: 'failed', code: 'inject-failed' };
      }
    },
    noteAttached(url) {
      sessionActive = true;
      currentBrowser = url;
    },
  };
}

export function decidePanelConflict({ selfManaged, ownerManaged, selfPid, ownerPid }) {
  if (ownerManaged && !selfManaged) return 'yield';
  if (selfManaged && !ownerManaged) return 'handover';
  if (selfManaged && ownerManaged) return selfPid > ownerPid ? 'yield' : 'handover';
  return selfPid > ownerPid ? 'handover' : 'yield';
}
function lockPaths(dir) {
  const lock = path.join(dir, 'watch.lock');
  return { lock, pid: path.join(lock, 'pid'), ppid: path.join(lock, 'ppid'), token: path.join(lock, 'token'), managed: path.join(lock, 'managed') };
}
async function readLock(dir) {
  const files = lockPaths(dir);
  try {
    const [pid, ppid, token, managed] = await Promise.all([
      fs.readFile(files.pid, 'utf8'),
      fs.readFile(files.ppid, 'utf8'),
      fs.readFile(files.token, 'utf8'),
      fs.readFile(files.managed, 'utf8').catch(() => ''),
    ]);
    return { pid: Number(pid), ppid: Number(ppid), token: token.trim(), managed: managed.trim() === '1' };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
async function releaseLockIfMine(ctx) {
  const owner = await readLock(ctx.dir);
  if (!owner || owner.pid !== ctx.pid) return;
  await fs.rm(lockPaths(ctx.dir).lock, { recursive: true, force: true });
}
async function claimLock(ctx) {
  const files = lockPaths(ctx.dir);
  const create = async () => {
    await fs.mkdir(files.lock);
    const token = randomBytes(16).toString('hex');
    await fs.writeFile(files.pid, String(ctx.pid), { mode: 0o600 });
    await fs.writeFile(files.ppid, String(ctx.ppid ?? 0), { mode: 0o600 });
    await fs.writeFile(files.token, token, { mode: 0o600 });
    await fs.writeFile(files.managed, ctx.managed ? '1' : '0', { mode: 0o600 });
    return token;
  };
  try {
    return { claimed: true, token: await create() };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const owner = await readLock(ctx.dir);
  const alive = owner && await ctx.pidAlive(owner.pid) && await ctx.isWatchCommand(owner.pid);
  if (!alive) {
    await fs.rm(files.lock, { recursive: true, force: true });
    try {
      return { claimed: true, token: await create() };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      return { claimed: false, owner: await readLock(ctx.dir), contended: true };
    }
  }
  return { claimed: false, owner, contended: false };
}
export function probePort(port, host = LOOPBACK) {
  assertLoopbackHost(host);
  return new Promise(resolve => {
    const socket = net.connect({ host, port });
    const finish = open => { socket.destroy(); resolve(open); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}
async function fetchHealthOnce(port) {
  try {
    const response = await fetch(`http://${LOOPBACK}:${port}/health`, { signal: AbortSignal.timeout(400), redirect: 'error' });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}
async function fetchHealthSoon(ctx) {
  const attempts = ctx.healthAttempts ?? 20;
  for (let index = 0; index < attempts; index += 1) {
    const health = await fetchHealthOnce(ctx.port);
    if (health?.ok) return health;
    if (!(await probePort(ctx.port))) return null;
    await (ctx.sleep ?? sleep)(ctx.healthGapMs ?? 40);
  }
  return null;
}
async function postHandover(port, token) {
  try {
    const response = await fetch(`http://${LOOPBACK}:${port}/handover`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(1000),
      redirect: 'error',
    });
    return response.ok;
  } catch {
    return false;
  }
}
function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}
export function listenLoopback(server, port, host = LOOPBACK) {
  assertLoopbackHost(host);
  return new Promise((resolve, reject) => {
    const onError = error => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      const address = server.address();
      if (!address || address.address !== LOOPBACK) {
        server.close();
        const error = new Error('面板只能绑定 127.0.0.1。');
        error.code = 'host-rejected';
        reject(error);
        return;
      }
      resolve(address);
    });
  });
}
function isLoopback(req) {
  const addr = req.socket.remoteAddress;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}
async function readBody(req, limit = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求过大。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export function createPanelHandler(state) {
  return async function panelRequest(req, res) {
    const headers = {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'Content-Type',
    };
    const send = (code, obj) => { res.writeHead(code, headers); res.end(obj ? JSON.stringify(obj) : ''); };
    if (!isLoopback(req)) { send(403, { ok: false, error: '仅本机可用。' }); return; }
    if (req.method === 'OPTIONS') { send(204); return; }
    const url = new URL(req.url, `http://${LOOPBACK}:${state.port || PANEL_PORT}`);
    if (req.method === 'GET' && url.pathname === '/health') {
      send(200, { ok: true, pid: state.pid, ppid: state.ppid, protocol: PROTOCOL, managed: Boolean(state.managed) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/handover') {
      try {
        const body = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}');
        if (!safeEqual(body.token || '', state.token || '')) { send(403, { ok: false, error: '交接被拒绝。' }); return; }
      } catch {
        send(400, { ok: false, error: '交接请求无效。' });
        return;
      }
      res.writeHead(200, headers);
      res.end(JSON.stringify({ ok: true }));
      setImmediate(() => { void Promise.resolve(state.onHandover?.()).catch(() => {}); });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/apply') {
      try {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const saved = await state.save(body);
        if (state.refresh) await state.refresh(saved);
        send(200, { ok: true, opacity: saved.opacity, image: saved.image, appearance: saved.appearance });
      } catch (error) {
        send(400, { ok: false, error: error.message });
      }
      return;
    }
    send(404, { ok: false, error: '未知接口。' });
  };
}
async function startOwnedServer(ctx, token) {
  let server;
  const handler = createPanelHandler({
    pid: ctx.pid,
    ppid: ctx.ppid,
    managed: ctx.managed,
    token,
    port: ctx.port,
    save: body => saveWallpaper(ctx, body),
    refresh: saved => ctx.refresh?.(saved) ?? Promise.resolve(),
    onHandover: async () => {
      await releaseLockIfMine(ctx);
      await new Promise(resolve => server.close(resolve));
      await ctx.onExit?.(0);
    },
  });
  server = http.createServer((req, res) => { void handler(req, res); });
  const address = await listenLoopback(server, ctx.port, LOOPBACK);
  return {
    server,
    address,
    token,
    port: address.port,
    url: `http://${LOOPBACK}:${address.port}`,
    async close() {
      await releaseLockIfMine(ctx);
      if (server.listening) await new Promise(resolve => server.close(resolve));
    },
  };
}
async function settleBusyPort(ctx) {
  const health = await fetchHealthSoon(ctx);
  if (!health?.ok) {
    await ctx.onDiagnostic?.({ code: 'panel-foreign', message: '面板端口已被其他进程占用。已停止，没有结束那个进程。' });
    return { action: 'refuse', code: 'panel-foreign' };
  }
  if (health.protocol !== PROTOCOL) {
    await ctx.onDiagnostic?.({ code: 'panel-legacy', message: '面板端口上是不支持交接的旧助手。已停止，没有结束它。请先停下旧助手再启动这一版。', ownerPid: health.pid });
    return { action: 'refuse', code: 'panel-legacy', ownerPid: health.pid ?? null };
  }
  const decision = decidePanelConflict({
    selfManaged: Boolean(ctx.managed),
    ownerManaged: Boolean(health.managed),
    selfPid: ctx.pid,
    ownerPid: health.pid,
  });
  if (decision === 'yield') return { action: 'yield', code: 'panel-yield', ownerPid: health.pid };
  if (ctx._handoverDone) {
    await ctx.onDiagnostic?.({ code: 'handover-failed', message: '交接没有拿到面板端口。已停止，没有重试。', ownerPid: health.pid });
    return { action: 'refuse', code: 'handover-failed', ownerPid: health.pid };
  }
  const owner = await readLock(ctx.dir);
  if (!owner?.token || !(await postHandover(ctx.port, owner.token))) {
    await ctx.onDiagnostic?.({ code: 'handover-failed', message: '旧助手没有接受交接。已停止。', ownerPid: health.pid });
    return { action: 'refuse', code: 'handover-failed', ownerPid: health.pid };
  }
  const freed = await waitUntil(async () => !(await probePort(ctx.port)), {
    timeout: ctx.handoverWaitMs ?? 2000,
    interval: 40,
    sleep: ctx.sleep ?? sleep,
    now: ctx.now ?? Date.now,
  });
  if (!freed) {
    await ctx.onDiagnostic?.({ code: 'handover-failed', message: '交接后端口仍被占用。已停止。', ownerPid: health.pid });
    return { action: 'refuse', code: 'handover-failed', ownerPid: health.pid };
  }
  ctx._handoverDone = true;
  return acquireSingleWatcher(ctx);
}
export async function acquireSingleWatcher(ctx) {
  assertLoopbackHost(ctx.host ?? LOOPBACK);
  await fs.mkdir(ctx.dir, { recursive: true, mode: 0o700 });
  if (ctx.port !== 0 && await probePort(ctx.port)) return settleBusyPort(ctx);
  const claim = await claimLock(ctx);
  if (!claim.claimed) {
    if (ctx.port !== 0 && await probePort(ctx.port)) return settleBusyPort(ctx);
    // The lock names a live helper, but nothing is listening. Take the port once.
    // Do not signal that process; this only recovers a socket it already lost.
    if (claim.owner && !ctx._staleRebound) {
      await fs.rm(lockPaths(ctx.dir).lock, { recursive: true, force: true });
      ctx._staleRebound = true;
      return acquireSingleWatcher(ctx);
    }
    const code = claim.contended ? 'lock-contended' : 'panel-foreign';
    await ctx.onDiagnostic?.({ code, message: '没能成为唯一助手。已停止。', ownerPid: claim.owner?.pid ?? null });
    return { action: 'refuse', code, ownerPid: claim.owner?.pid ?? null };
  }
  try {
    const started = await startOwnedServer(ctx, claim.token);
    if (ctx.port === 0) ctx.port = started.port;
    return { action: 'bound', ...started };
  } catch (error) {
    await releaseLockIfMine(ctx);
    if (error.code === 'EADDRINUSE') return settleBusyPort(ctx);
    throw error;
  }
}

export async function registerWatchStart(dir, now = Date.now()) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'watch-starts.json');
  let previous = { starts: [] };
  try { previous = JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const starts = [...(previous.starts || []).filter(item => now - item < STORM_WINDOW_MS), now];
  await writeJSON(file, { starts });
  if (starts.length > STORM_START_CAP) return { ok: false, code: 'restart-storm', starts: starts.length };
  return { ok: true, starts: starts.length };
}
export async function installAutostart(deps) {
  const { dir, agentsDir, nodePath, scriptPath, uid, exec, sleep: sleepImpl = sleep, now = Date.now, label = AGENT_LABEL } = deps;
  await fs.mkdir(agentsDir, { recursive: true, mode: 0o755 });
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const plist = buildAgentPlist({ label, nodePath, scriptPath, dir, logPath: path.join(dir, 'watch.log') });
  const dest = path.join(agentsDir, `${label}.plist`);
  let previous = null;
  try { previous = await fs.readFile(dest, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const changed = previous !== plist;
  if (previous == null || changed) {
    await fs.writeFile(`${dest}.tmp`, plist, { mode: 0o644 });
    await fs.rename(`${dest}.tmp`, dest);
  }
  const target = `gui/${uid}/${label}`;
  const loaded = async () => {
    try {
      const { stdout } = await exec('launchctl', ['print', target]);
      return parseLaunchctlPrint(stdout);
    } catch {
      return null;
    }
  };
  const before = await loaded();
  if (before && !changed) {
    if (!before.pid) await exec('launchctl', ['kickstart', target]).catch(() => {});
    return { ok: true, action: 'already-loaded', pid: before.pid ?? null };
  }
  if (before && changed) {
    try { await exec('launchctl', ['bootout', target]); }
    catch (error) {
      return { ok: false, action: 'bootout-stuck', error: errorText(error) };
    }
    const gone = await waitUntil(async () => (await loaded()) == null, { timeout: 3000, interval: 100, sleep: sleepImpl, now });
    if (!gone) return { ok: false, action: 'bootout-stuck', error: 'bootout 后服务仍在。已停止，没有再次装载。' };
  }
  await exec('launchctl', ['enable', target]).catch(() => {});
  try {
    await exec('launchctl', ['bootstrap', `gui/${uid}`, dest]);
  } catch (error) {
    if (isBootstrapConflict(error)) {
      const after = await loaded();
      if (after) return { ok: true, action: 'bootstrap-already-loaded', warning: errorText(error), pid: after.pid ?? null };
    }
    return { ok: false, action: 'bootstrap-failed', error: errorText(error) };
  }
  const after = await loaded();
  if (after && !after.pid) await exec('launchctl', ['kickstart', target]).catch(() => {});
  return { ok: true, action: 'bootstrapped', pid: after?.pid ?? null };
}
export async function ensureWatcher(deps) {
  const current = await deps.health();
  if (current?.ok && current.protocol === PROTOCOL) return { ready: true, spawned: false };
  if (current?.ok) return { ready: false, spawned: false, code: 'panel-legacy' };
  const waitReady = () => waitUntil(async () => {
    const next = await deps.health();
    return next?.ok && next.protocol === PROTOCOL ? next : null;
  }, {
    timeout: deps.timeoutMs ?? 4000,
    interval: deps.intervalMs ?? 200,
    sleep: deps.sleep ?? sleep,
    now: deps.now ?? Date.now,
    maxAttempts: deps.maxAttempts ?? 21,
  });
  if (deps.autostartRunning) {
    const ready = await waitReady();
    return { ready: Boolean(ready), spawned: false, code: ready ? null : 'panel-not-ready' };
  }
  if (deps.spawned) return { ready: false, spawned: false, code: 'already-spawned' };
  deps.spawned = true;
  deps.markSpawned?.();
  await deps.spawn();
  const ready = await waitReady();
  return { ready: Boolean(ready), spawned: true, code: ready ? null : 'panel-not-ready' };
}

export function buildStatus(parts) {
  return {
    running: Boolean(parts.running),
    debug: Boolean(parts.debug),
    panel: Boolean(parts.panel),
    autostart: Boolean(parts.autostart),
    appPath: parts.appPath ?? null,
    port: parts.port,
    panelPort: parts.panelPort,
    lastApplied: parts.lastApplied ?? null,
    diagnostic: parts.diagnostic ?? null,
    panelProtocol: parts.panelProtocol ?? null,
    panelPid: parts.panelPid ?? null,
    visibility: 'not-checked',
  };
}

// Serialized into the Grok Bot renderer. Keep browser globals unqualified.
export function overlay(config) {
  const key = '__grokbotWallpaperOverlay';
  window[key]?.restore();
  if (!config) return { ok: true };
  const state = {
    data: config.data,
    opacity: Math.max(0.15, Math.min(1, Number(config.opacity) || 0.9)),
    appearance: config.appearance === 'light' ? 'light' : 'dark',
    panel: config.panel || 'http://127.0.0.1:19223',
  };
  const changes = new Map();
  const layer = document.createElement('div');
  layer.id = 'grokbot-wallpaper-layer';
  const panel = document.createElement('div');
  panel.id = 'grokbot-wallpaper-panel';
  const style = document.createElement('style');
  style.id = 'grokbot-wallpaper-style';
  style.textContent = '#grokbot-wallpaper-layer{position:fixed!important;inset:0!important;pointer-events:none!important;z-index:-1!important;background-size:cover!important;background-position:center!important}#grokbot-wallpaper-panel{position:fixed!important;right:16px!important;bottom:120px!important;left:auto!important;top:auto!important;z-index:2147483000!important;pointer-events:auto!important;width:240px!important;padding:10px 12px!important;border-radius:14px!important;background:rgba(20,22,28,.84)!important;color:#f3f4f6!important;font:12px/1.35 -apple-system,BlinkMacSystemFont,system-ui,sans-serif!important;box-shadow:0 10px 28px rgba(0,0,0,.32)!important;backdrop-filter:blur(16px)!important;-webkit-backdrop-filter:blur(16px)!important;user-select:none!important}#grokbot-wallpaper-panel.collapsed{width:auto!important;padding:0!important;background:transparent!important;box-shadow:none!important;backdrop-filter:none!important}#grokbot-wallpaper-panel button,#grokbot-wallpaper-panel label.pick{appearance:none!important;border:0!important;border-radius:8px!important;background:rgba(255,255,255,.12)!important;color:inherit!important;font:inherit!important;cursor:pointer!important;padding:8px 10px!important}#grokbot-wallpaper-panel label.pick{display:block!important;width:100%!important;text-align:center!important;box-sizing:border-box!important;margin:8px 0 0!important}#grokbot-wallpaper-panel .opacity{margin-top:20px!important}#grokbot-wallpaper-panel input[type=range]{width:100%!important;margin:8px 0 0!important;accent-color:#8ab4ff!important}#grokbot-wallpaper-panel .row{display:flex!important;align-items:center!important;justify-content:space-between!important;gap:8px!important}#grokbot-wallpaper-panel .row.drag{cursor:move!important;padding-bottom:6px!important}#grokbot-wallpaper-panel .status{min-height:16px!important;margin-top:6px!important;opacity:.8!important}#grokbot-wallpaper-panel .fab{cursor:move!important;width:40px!important;height:40px!important;border-radius:20px!important;display:none!important;align-items:center!important;justify-content:center!important;background:rgba(20,22,28,.84)!important;box-shadow:0 8px 20px rgba(0,0,0,.28)!important}#grokbot-wallpaper-panel.collapsed .fab{display:flex!important}#grokbot-wallpaper-panel.collapsed .body{display:none!important}';
  function ink() { return state.appearance === 'light' ? '255,255,255' : '16,19,25'; }
  function paint() {
    layer.style.backgroundImage = `linear-gradient(rgba(${ink()},${1 - state.opacity}),rgba(${ink()},${1 - state.opacity})),url("${state.data}")`;
  }
  paint();
  const body = document.createElement('div');
  body.className = 'body';
  const row = document.createElement('div');
  row.className = 'row';
  const title = document.createElement('strong');
  title.textContent = '壁纸';
  const hide = document.createElement('button');
  hide.type = 'button';
  hide.textContent = '收起';
  hide.addEventListener('click', () => panel.classList.add('collapsed'));
  row.classList.add('drag');
  row.append(title, hide);
  function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }
  function bindDrag(handle) {
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      if (event.target.closest('button,input,label,a')) return;
      const rect = panel.getBoundingClientRect();
      const ox = event.clientX - rect.left;
      const oy = event.clientY - rect.top;
      handle.setPointerCapture(event.pointerId);
      const move = ev => {
        const w = panel.offsetWidth, h = panel.offsetHeight;
        const x = clamp(ev.clientX - ox, 8, innerWidth - w - 8);
        const y = clamp(ev.clientY - oy, 8, innerHeight - h - 8);
        panel.style.setProperty('left', x + 'px', 'important');
        panel.style.setProperty('top', y + 'px', 'important');
        panel.style.setProperty('right', 'auto', 'important');
        panel.style.setProperty('bottom', 'auto', 'important');
      };
      const up = ev => {
        handle.releasePointerCapture(ev.pointerId);
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
  }
  bindDrag(row);
  const file = document.createElement('input');
  file.type = 'file';
  file.accept = 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp';
  file.hidden = true;
  const pick = document.createElement('label');
  pick.className = 'pick';
  pick.textContent = '上传壁纸';
  pick.append(file);
  const sliderLabel = document.createElement('div');
  sliderLabel.className = 'row';
  const sliderText = document.createElement('span');
  sliderText.textContent = '透明度';
  const sliderVal = document.createElement('span');
  function setSliderLabel() { sliderVal.textContent = state.opacity.toFixed(2); }
  setSliderLabel();
  sliderLabel.append(sliderText, sliderVal);
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0.15';
  slider.max = '1';
  slider.step = '0.01';
  slider.value = String(state.opacity);
  const status = document.createElement('div');
  status.className = 'status';
  const fab = document.createElement('button');
  fab.type = 'button';
  fab.className = 'fab';
  fab.textContent = '壁纸';
  fab.addEventListener('click', () => panel.classList.remove('collapsed'));
  bindDrag(fab);
  const opacityBox = document.createElement('div');
  opacityBox.className = 'opacity';
  opacityBox.append(sliderLabel, slider, status);
  body.append(row, pick, opacityBox);
  panel.append(fab, body);
  let pending = null;
  function note(text) { status.textContent = text || ''; }
  function queueSave(includeData) {
    const payload = { opacity: state.opacity, appearance: state.appearance };
    if (includeData) payload.data = state.data;
    pending = payload;
    note('已更新');
    const bodyText = JSON.stringify(payload);
    try {
      if (typeof window.grokbotWallpaperSave === 'function') {
        Promise.resolve(window.grokbotWallpaperSave(bodyText)).catch(() => {});
        return;
      }
    } catch { /* binding is optional until the watcher attaches */ }
    try {
      if (typeof fetch === 'function') fetch(`${state.panel}/apply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: bodyText }).catch(() => {});
    } catch { /* the page may block the request; the binding path remains */ }
  }
  slider.addEventListener('input', () => {
    state.opacity = Math.max(0.15, Math.min(1, Number(slider.value)));
    setSliderLabel();
    paint();
    queueSave(false);
  });
  file.addEventListener('change', () => {
    const chosen = file.files && file.files[0];
    file.value = '';
    if (!chosen) return;
    if (chosen.size > 4 * 1024 * 1024) { note('图片超过 4MB，请先缩小'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const data = String(reader.result || '');
      if (!/^data:image\/(png|jpeg|webp);base64,/.test(data)) { note('仅支持 png/jpg/webp'); return; }
      state.data = data;
      paint();
      queueSave(true);
      note('已更新');
    };
    reader.onerror = () => note('读取图片失败');
    reader.readAsDataURL(chosen);
  });
  function set(el, prop, value) {
    if (!changes.has(el)) changes.set(el, new Map());
    const record = changes.get(el);
    if (!record.has(prop)) record.set(prop, { value: el.style.getPropertyValue(prop), priority: el.style.getPropertyPriority(prop) });
    el.style.setProperty(prop, value, 'important');
  }
  let observer, timer, stopped = false;
  function skip(el) {
    return el === layer || el === style || el === panel || panel.contains(el)
      || el.closest('button,input,textarea,select,dialog,[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[role="tooltip"],[role="button"],[contenteditable="true"]');
  }
  function mounted() {
    return Boolean(layer.isConnected && panel.isConnected && style.isConnected);
  }
  function scan() {
    if (stopped || !document.body || !document.documentElement) return;
    set(document.documentElement, 'background-color', 'transparent');
    set(document.documentElement, 'background-image', 'none');
    set(document.documentElement, 'color-scheme', state.appearance);
    set(document.body, 'background-color', 'transparent');
    set(document.body, 'background-image', 'none');
    set(document.body, 'isolation', 'isolate');
    const area = innerWidth * innerHeight;
    for (const el of document.body.querySelectorAll('*')) {
      if (skip(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < innerWidth * 0.22 || rect.height < innerHeight * 0.45 || rect.width * rect.height < area * 0.16 || rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) continue;
      const css = getComputedStyle(el);
      if (css.visibility !== 'visible' || Number(css.opacity) < 0.85 || css.backgroundImage !== 'none') continue;
      if (changes.get(el)?.has('background-color')) continue;
      const rgb = css.backgroundColor.match(/^rgba?\(([^)]+)\)$/);
      if (!rgb) continue;
      const parts = rgb[1].split(/[,\s/]+/).filter(Boolean).map(Number);
      if ((parts[3] ?? 1) < 0.85) continue;
      set(el, 'background-color', `color-mix(in srgb, ${css.backgroundColor} 28%, transparent)`);
    }
  }
  function arm() {
    if (!observer || !document.documentElement) return;
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style'] });
  }
  function ensureDom() {
    if (stopped || !document.head || !document.body || !document.documentElement) return;
    observer?.disconnect();
    if (!mounted()) {
      style.remove();
      layer.remove();
      panel.remove();
      document.head.append(style);
      document.body.prepend(layer);
      document.body.append(panel);
    }
    scan();
    arm();
  }
  function schedule() { if (!stopped && !timer) timer = setTimeout(() => { timer = null; ensureDom(); }, 180); }
  function start() {
    if (stopped) return;
    observer = new MutationObserver(schedule);
    ensureDom();
    window.addEventListener('resize', schedule);
    window.addEventListener('pageshow', schedule);
    document.addEventListener('visibilitychange', schedule);
  }
  window[key] = {
    restore() {
      stopped = true;
      observer?.disconnect();
      clearTimeout(timer);
      document.removeEventListener('DOMContentLoaded', start);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('pageshow', schedule);
      document.removeEventListener('visibilitychange', schedule);
      layer.remove(); style.remove(); panel.remove();
      for (const [el, props] of changes) for (const [prop, old] of props) {
        if (old.value) el.style.setProperty(prop, old.value, old.priority); else el.style.removeProperty(prop);
      }
      changes.clear();
      delete window[key];
    },
    ensure() { ensureDom(); return { ok: true }; },
    update(next = {}) {
      if (next.data) state.data = next.data;
      if (Number.isFinite(Number(next.opacity))) {
        state.opacity = Math.max(0.15, Math.min(1, Number(next.opacity)));
        slider.value = String(state.opacity);
        setSliderLabel();
      }
      if (next.appearance === 'dark' || next.appearance === 'light') state.appearance = next.appearance;
      paint();
      ensureDom();
      return { ok: true };
    },
    takePending() {
      if (!pending) return null;
      const value = pending;
      pending = null;
      return value;
    },
  };
  if (document.body && document.head) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
  return { ok: true };
}

export function buildOverlayExpression(config) {
  return `(${overlay.toString()})(${JSON.stringify(config)})`;
}
export function buildEnsureExpression(config) {
  return `(() => { const layer = document.getElementById('grokbot-wallpaper-layer'); const api = window.__grokbotWallpaperOverlay; if (layer && layer.isConnected && api && typeof api.ensure === 'function') { api.ensure(); return { ok: true, ensured: true }; } return (${overlay.toString()})(${JSON.stringify(config)}); })()`;
}
export function buildUninstallExpression() {
  return '(() => { try { window.__grokbotWallpaperOverlay?.restore?.(); } catch (e) {} return { ok: true, restored: true }; })()';
}
export function buildPresenceExpression() {
  return '(() => { const layer = document.getElementById("grokbot-wallpaper-layer"); const api = window.__grokbotWallpaperOverlay; return { ok: true, present: !!(layer && layer.isConnected && api && api.ensure && api.update) }; })()';
}
export function buildLiveUpdateExpression(patch) {
  return `(() => { const api = window.__grokbotWallpaperOverlay; if (!api || !api.update) return { ok: false }; return api.update(${JSON.stringify(patch)}); })()`;
}
export function routeDebugEvent(msg, hooks) {
  if (!msg || typeof msg.method !== 'string') return null;
  if (msg.method === 'Target.attachedToTarget') {
    const info = msg.params?.targetInfo;
    if (!isWallpaperTarget(info)) return null;
    return hooks.onAttach?.({ sessionId: msg.params.sessionId, info }) ?? null;
  }
  if (msg.method === 'Runtime.bindingCalled' && msg.params?.name === BINDING) {
    return hooks.onBinding?.(msg.params.payload, { sessionId: msg.sessionId }) ?? null;
  }
  if (!msg.sessionId) return null;
  if (msg.method === 'Page.frameNavigated') {
    if (msg.params?.frame?.parentId) return null;
    return hooks.onNavigation?.({ sessionId: msg.sessionId, reason: 'frameNavigated' }) ?? null;
  }
  if (msg.method === 'Page.loadEventFired') return hooks.onNavigation?.({ sessionId: msg.sessionId, reason: 'load' }) ?? null;
  if (msg.method === 'DOM.documentUpdated') return hooks.onNavigation?.({ sessionId: msg.sessionId, reason: 'documentUpdated' }) ?? null;
  return null;
}
export function createCdpConnection(ws) {
  let seq = 0;
  const pending = new Map();
  const handlers = new Set();
  ws.addEventListener('message', event => {
    let msg;
    try { msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)); } catch { return; }
    if (msg.method) {
      for (const handler of handlers) handler(msg);
      return;
    }
    const item = pending.get(msg.id);
    if (!item) return;
    pending.delete(msg.id);
    clearTimeout(item.timer);
    if (msg.error) {
      const error = new Error(`CDP ${item.method} 失败。`);
      error.protocolMessage = String(msg.error.message ?? '');
      item.reject(error);
    } else item.resolve(msg.result);
  });
  ws.addEventListener('close', () => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(Object.assign(new Error('调试连接已关闭。'), { code: 'debug-closed' }));
    }
    pending.clear();
  });
  return {
    call(method, params = {}, { sessionId, timeout = 30000 } = {}) {
      return new Promise((resolve, reject) => {
        const id = ++seq;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP ${method} 超时。`));
        }, timeout);
        pending.set(id, { resolve, reject, timer, method });
        const payload = { id, method, params };
        if (sessionId) payload.sessionId = sessionId;
        ws.send(JSON.stringify(payload));
      });
    },
    onEvent(handler) { handlers.add(handler); return () => handlers.delete(handler); },
    close() { ws.close(); },
  };
}
export async function openDebugSession(version, hooks) {
  const port = hooks.debugPort ?? DEBUG_PORT;
  if (!isAllowedDebugUrl(version?.webSocketDebuggerUrl, port)) {
    const error = new Error('拒绝非 127.0.0.1 调试连接。');
    error.code = 'debug-unsafe';
    throw error;
  }
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(Object.assign(new Error('调试连接超时。'), { code: 'debug-timeout' })); }, 5000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(Object.assign(new Error('调试连接失败。'), { code: 'debug-connect' })); }, { once: true });
  });
  const cdp = createCdpConnection(ws);
  const sessions = new Map();
  ws.addEventListener('close', () => { void hooks.onClose?.(); });
  async function uninstall() {
    const expression = buildUninstallExpression();
    for (const [sessionId, meta] of sessions) {
      if (meta.identifier) {
        await cdp.call('Page.removeScriptToEvaluateOnNewDocument', { identifier: meta.identifier }, { sessionId }).catch(() => {});
      }
      await cdp.call('Runtime.evaluate', { expression, returnByValue: true }, { sessionId }).catch(() => {});
    }
  }
  async function ensure(info = {}) {
    const ids = info.sessionId ? [info.sessionId] : [...sessions.keys()];
    const config = await hooks.config();
    if (!config) {
      await uninstall();
      return { ok: true, restored: true };
    }
    if (!ids.length) return { ok: true, skipped: true };
    for (const sessionId of ids) {
      const probe = await cdp.call('Runtime.evaluate', { expression: buildPresenceExpression(), returnByValue: true }, { sessionId });
      const present = probe.result?.value?.present === true && !probe.exceptionDetails;
      const expression = present
        ? buildLiveUpdateExpression({ opacity: config.opacity, appearance: config.appearance })
        : buildEnsureExpression(config);
      const result = await cdp.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, { sessionId });
      if (result.exceptionDetails || result.result?.value?.ok !== true) {
        throw new Error('壁纸脚本执行失败，可能仅部分窗口已更新；可运行 restore。');
      }
    }
    return { ok: true };
  }
  async function onAttach({ sessionId, info }) {
    if (!sessionId || sessions.has(sessionId)) return;
    sessions.set(sessionId, { targetId: info.targetId, identifier: null });
    const opt = { sessionId };
    await cdp.call('Page.enable', {}, opt);
    await cdp.call('Runtime.enable', {}, opt);
    await cdp.call('DOM.enable', {}, opt).catch(() => {});
    await cdp.call('Runtime.addBinding', { name: BINDING }, opt);
    const config = await hooks.config();
    if (config) {
      const added = await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: buildOverlayExpression(config) }, opt);
      sessions.get(sessionId).identifier = added.identifier;
      await hooks.rememberScript?.({ target: info.targetId, identifier: added.identifier, browser: version.webSocketDebuggerUrl });
    }
    await hooks.onNavigation?.({ sessionId, reason: 'attach' });
  }
  cdp.onEvent(msg => {
    Promise.resolve(routeDebugEvent(msg, {
      onAttach,
      onBinding: hooks.onBinding,
      onNavigation: hooks.onNavigation,
    })).catch(error => hooks.log?.(`调试事件失败：${error.message}`));
  });
  const api = { ensure, uninstall, close() { ws.close(); } };
  hooks.onReady?.(api);
  await cdp.call('Target.setDiscoverTargets', { discover: true });
  await cdp.call('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  return api;
}

async function readJSON(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
async function writeJSON(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(`${file}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(`${file}.tmp`, file);
}
function mimeOf(suffix) {
  return suffix === '.png' ? 'image/png' : suffix === '.webp' ? 'image/webp' : 'image/jpeg';
}
function validImage(data, suffix) {
  return suffix === '.png' ? data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : suffix === '.webp' ? data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP'
    : data[0] === 255 && data[1] === 216 && data[2] === 255;
}
export async function writeCurrent(dir, data, suffix, source) {
  if (data.length > LIMIT) throw new Error('处理后图片仍超过 4MB，请提供更小的图片。');
  if (!validImage(data, suffix)) throw new Error('图片内容与文件扩展名不符。');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const dest = path.join(dir, `current${suffix}`);
  await fs.writeFile(`${dest}.tmp`, data, { mode: 0o600 });
  await fs.rename(`${dest}.tmp`, dest);
  return { image: dest, source, bytes: data, sha256: sha256(data), data: `data:${mimeOf(suffix)};base64,${data.toString('base64')}` };
}
export async function prepareFile(dir, file) {
  const source = path.resolve(file);
  const ext = path.extname(source).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) throw new Error('仅支持 png/jpg/jpeg/webp 图片。');
  const stat = await fs.stat(source);
  if (!stat.isFile()) throw new Error('图片路径必须是文件。');
  let data;
  let suffix = ext === '.jpeg' ? '.jpg' : ext;
  if (stat.size > LIMIT) {
    try { await fs.access('/usr/bin/sips'); } catch { throw new Error('图片超过 4MB，且 sips 不可用；请先缩小图片。'); }
    const temp = await fs.mkdtemp(path.join(dir, 'convert-'));
    try {
      const out = path.join(temp, 'photo.jpg');
      await execFileUtf8('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '75', '-Z', '2560', source, '--out', out]);
      data = await fs.readFile(out);
      suffix = '.jpg';
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
  } else data = await fs.readFile(source);
  return writeCurrent(dir, data, suffix, source);
}
export async function prepareDataUrl(dir, dataUrl) {
  const match = String(dataUrl).match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) throw new Error('仅支持 png/jpg/webp 图片。');
  const data = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  const suffix = match[1] === 'png' ? '.png' : match[1] === 'webp' ? '.webp' : '.jpg';
  if (data.length > LIMIT) throw new Error('图片超过 4MB，请先缩小。');
  return writeCurrent(dir, data, suffix, path.join(dir, `current${suffix}`));
}
export async function saveWallpaper(ctx, body) {
  const lastPath = path.join(ctx.dir, 'last-applied.json');
  const last = await readJSON(lastPath, {}) ?? {};
  let opacity = last.opacity ?? 0.9;
  let appearance = last.appearance === 'light' ? 'light' : 'dark';
  if (body.opacity != null) {
    if (!Number.isFinite(Number(body.opacity))) throw new Error('--opacity 需要有限数字。');
    opacity = clampOpacity(body.opacity);
  }
  if (body.appearance === 'dark' || body.appearance === 'light') appearance = body.appearance;
  let image = last.image;
  let source = last.source ?? image;
  let digest = last.sha256 ?? null;
  if (body.data) {
    const prepared = await prepareDataUrl(ctx.dir, body.data);
    image = prepared.image;
    source = prepared.image;
    digest = prepared.sha256;
  } else if (!image) throw new Error('还没有壁纸。');
  else {
    await fs.access(image);
    if (!digest) digest = sha256(await fs.readFile(image));
  }
  const record = { image, source, opacity, appearance, sha256: digest, time: new Date().toISOString(), restored: false };
  await writeJSON(lastPath, record);
  return record;
}
let imageCache = null;
async function loadConfig(ctx) {
  const last = await readJSON(path.join(ctx.dir, 'last-applied.json'), null);
  if (!eligible(last)) { imageCache = null; return null; }
  const stat = await fs.stat(last.image);
  const key = `${last.image}\0${stat.size}\0${stat.mtimeMs}\0${last.opacity}\0${last.appearance}`;
  if (imageCache?.key === key) return imageCache.config;
  const bytes = await fs.readFile(last.image);
  const suffix = path.extname(last.image).toLowerCase() === '.jpeg' ? '.jpg' : path.extname(last.image).toLowerCase();
  if (!validImage(bytes, suffix)) throw new Error('已保存的壁纸已损坏。');
  const config = {
    data: `data:${mimeOf(suffix)};base64,${bytes.toString('base64')}`,
    opacity: clampOpacity(last.opacity ?? 0.9),
    appearance: last.appearance === 'light' ? 'light' : 'dark',
    panel: `http://${LOOPBACK}:${ctx.panelPort ?? PANEL_PORT}`,
  };
  imageCache = { key, config };
  return config;
}

async function rememberScript(dir, entry) {
  const file = path.join(dir, 'scripts.json');
  const registry = await readJSON(file, { browser: null, entries: [] });
  const browser = entry.browser;
  const next = registry.browser === browser ? registry : { browser, entries: [] };
  next.entries = next.entries.filter(item => item.target !== entry.target);
  next.entries.push({ target: entry.target, identifier: entry.identifier });
  await writeJSON(file, next);
}
async function getJSON(port, endpoint) {
  const response = await fetch(`http://${LOOPBACK}:${port}${endpoint}`, { signal: AbortSignal.timeout(1800), redirect: 'error' });
  if (!response.ok) throw new Error('本机调试接口未就绪。');
  return response.json();
}
async function listTargets(port) {
  let targets = [];
  const found = await waitUntil(async () => {
    targets = (await getJSON(port, '/json/list')).filter(target => isWallpaperTarget(target) && target.webSocketDebuggerUrl);
    return targets.length ? targets : null;
  }, { timeout: 10000, interval: 300 });
  if (!found) throw new Error('没有可用的 Grok Bot 页面，请打开主窗口后重试。');
  return found;
}
export async function injectOnce(ctx, version, config) {
  if (!isAllowedDebugUrl(version.webSocketDebuggerUrl, ctx.debugPort ?? DEBUG_PORT)) {
    const error = new Error('拒绝非 127.0.0.1 调试连接。');
    error.code = 'debug-unsafe';
    throw error;
  }
  const targets = await listTargets(ctx.debugPort ?? DEBUG_PORT);
  const registryPath = path.join(ctx.dir, 'scripts.json');
  const old = await readJSON(registryPath, { browser: null, entries: [] });
  const registry = old.browser === version.webSocketDebuggerUrl ? old : { browser: version.webSocketDebuggerUrl, entries: [] };
  for (const target of targets) {
    if (!isAllowedDebugUrl(target.webSocketDebuggerUrl, ctx.debugPort ?? DEBUG_PORT)) {
      const error = new Error('拒绝非 127.0.0.1 调试连接。');
      error.code = 'debug-unsafe';
      throw error;
    }
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ws.close(); reject(new Error('调试连接超时。')); }, 5000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('调试连接失败。')); }, { once: true });
    });
    const cdp = createCdpConnection(ws);
    try {
      await cdp.call('Page.enable');
      for (const entry of registry.entries.filter(item => item.target === target.id)) {
        try { await cdp.call('Page.removeScriptToEvaluateOnNewDocument', { identifier: entry.identifier }); }
        catch (error) {
          if (!/script.*(not found|does not exist)|no script.*(id|identifier)/i.test(error.protocolMessage ?? '')) {
            throw new Error('无法移除旧的重载脚本；请重试 restore，或手动退出应用结束该进程。');
          }
        }
      }
      registry.entries = registry.entries.filter(item => item.target !== target.id);
      await writeJSON(registryPath, registry);
      if (config) {
        const added = await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: buildOverlayExpression(config) });
        registry.entries.push({ target: target.id, identifier: added.identifier });
        await writeJSON(registryPath, registry);
      }
      const expression = config ? buildEnsureExpression(config) : buildUninstallExpression();
      const result = await cdp.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails || result.result?.value?.ok !== true) throw new Error('壁纸脚本执行失败，可能仅部分窗口已更新；可运行 restore。');
    } finally { cdp.close(); }
  }
}

export async function applyWallpaper(deps, { file, opacity = 0.9, appearance = 'dark', confirmed = false } = {}) {
  if (!file) throw new Error('apply 需要图片路径。');
  const version = await deps.probe();
  if (!version && !confirmed) return { code: 2 };
  const prepared = await deps.prepare(file);
  let current = version;
  if (!current) {
    try { current = await deps.relaunch(); }
    catch (error) { return { code: 1, error: error.code || error.message }; }
  }
  if (!isAllowedDebugUrl(current.webSocketDebuggerUrl, deps.debugPort ?? DEBUG_PORT)) return { code: 1, error: 'debug-unsafe' };
  const autostart = await deps.installAutostart();
  const watcher = await deps.ensureWatcher();
  const config = {
    data: prepared.data,
    opacity: clampOpacity(opacity),
    appearance: appearance === 'light' ? 'light' : 'dark',
    panel: `http://${LOOPBACK}:${deps.panelPort ?? PANEL_PORT}`,
  };
  await deps.inject(current, config);
  const record = {
    image: prepared.image,
    source: prepared.source,
    opacity: config.opacity,
    appearance: config.appearance,
    sha256: prepared.sha256,
    time: deps.nowIso(),
    restored: false,
  };
  await deps.writeLast(record);
  return { code: 0, image: prepared.image, record, autostart, watcher };
}

function dataDir() {
  return path.join(homedir(), 'Library/Application Support/grokbot-wallpaper');
}
function agentDir() {
  return path.join(homedir(), 'Library/LaunchAgents');
}
async function appPath() {
  for (const candidate of ['/Applications/Grok Bot.app', path.join(homedir(), 'Applications/Grok Bot.app')]) {
    try { await fs.access(candidate); return candidate; } catch { /* try the next location */ }
  }
  return null;
}
async function exec(file, args, opts = {}) {
  try {
    return await execFileUtf8(file, args, { timeout: opts.timeout ?? 15000, encoding: 'utf8' });
  } catch (error) {
    if (error.stdout) error.stdout = String(error.stdout);
    if (error.stderr) error.stderr = String(error.stderr);
    throw error;
  }
}
async function listMainProcesses(app) {
  if (!app) return [];
  const { stdout } = await exec('ps', ['-axww', '-o', 'pid=,command=']);
  return parseProcessList(stdout, app);
}
async function probeDebug(port = DEBUG_PORT) {
  try {
    const version = await getJSON(port, '/json/version');
    return version?.webSocketDebuggerUrl ? version : null;
  } catch {
    return null;
  }
}
async function panelHealth(port = PANEL_PORT) {
  return fetchHealthOnce(port);
}
async function autostartRunning() {
  try {
    const { stdout } = await exec('launchctl', ['print', `gui/${process.getuid()}/${AGENT_LABEL}`]);
    const parsed = parseLaunchctlPrint(stdout);
    return Boolean(parsed && (parsed.pid || parsed.state));
  } catch {
    return false;
  }
}
function runtime() {
  return {
    dir: dataDir(),
    debugPort: DEBUG_PORT,
    panelPort: PANEL_PORT,
    host: LOOPBACK,
    pid: process.pid,
    ppid: process.ppid,
    managed: process.env.GROKBOT_WALLPAPER_AGENT === '1',
    sleep,
    now: () => Date.now(),
  };
}
async function pidAlive(pid) {
  try {
    await exec('ps', ['-p', String(pid), '-o', 'pid=']);
    return true;
  } catch {
    return false;
  }
}
async function isWatchCommand(pid) {
  try {
    const { stdout } = await exec('ps', ['-p', String(pid), '-o', 'command=']);
    return stdout.includes('grokbot-wallpaper') && hasExactFlag(stdout, 'watch');
  } catch {
    return false;
  }
}
async function writeDiagnostic(dir, entry) {
  if (!shouldPersistDiagnostic(entry.code)) return;
  await writeJSON(path.join(dir, 'diagnostic.json'), { ...entry, time: new Date().toISOString() });
}

export async function runWatch(ctx, hooks = {}) {
  const app = hooks.app ?? await appPath();
  const gate = await registerWatchStart(ctx.dir, ctx.now());
  if (!gate.ok) {
    const entry = { code: gate.code, message: '助手在短时间内反复启动，已停止，避免重启循环。' };
    await writeDiagnostic(ctx.dir, entry);
    console.error(entry.message);
    return { code: 0, action: gate.code };
  }
  const acquired = await acquireSingleWatcher({
    ...ctx,
    host: LOOPBACK,
    port: ctx.panelPort,
    pidAlive: hooks.pidAlive ?? pidAlive,
    isWatchCommand: hooks.isWatchCommand ?? isWatchCommand,
    onDiagnostic: entry => writeDiagnostic(ctx.dir, entry),
    onExit: code => { hooks.onExit?.(code); },
    refresh: () => session?.ensure?.({ reason: 'panel-apply' }),
  });
  if (acquired.action !== 'bound') {
    const message = acquired.code === 'panel-legacy'
      ? '旧助手仍占着面板端口。这一进程已退出，没有结束旧进程。'
      : acquired.code === 'panel-yield'
        ? '已有唯一助手在运行，本进程退出。'
        : '没能独占面板端口，本进程退出。';
    console.error(message);
    return { code: 0, action: acquired.code, ownerPid: acquired.ownerPid ?? null };
  }
  let session = null;
  const controller = createWatchController({
    debugPort: ctx.debugPort,
    now: ctx.now,
    readLast: () => readJSON(path.join(ctx.dir, 'last-applied.json'), null),
    readGuard: () => readJSON(path.join(ctx.dir, 'relaunch-guard.json'), emptyGuard()),
    writeGuard: value => writeJSON(path.join(ctx.dir, 'relaunch-guard.json'), value),
    listProcesses: () => listMainProcesses(app),
    isMain: command => Boolean(app) && isMainBinary(command, app),
    probe: () => probeDebug(ctx.debugPort),
    waitForDebug: () => waitUntil(() => probeDebug(ctx.debugPort), { timeout: 15000, interval: 400, sleep: ctx.sleep, now: ctx.now }),
    relaunch: async () => {
      try {
        const version = await runOneRelaunch({
          quitApp: () => quitAppNormally({ exec, listProcesses: () => listMainProcesses(app), sleep: ctx.sleep, now: ctx.now }),
          openWithDebug: () => openWithDebug({ exec, appPath: app, debugPort: ctx.debugPort }),
          listProcesses: () => listMainProcesses(app),
          isMain: command => isMainBinary(command, app),
          probe: () => probeDebug(ctx.debugPort),
          sleep: ctx.sleep,
          now: ctx.now,
          debugPort: ctx.debugPort,
        });
        const procs = await listMainProcesses(app);
        return { ok: true, version, pid: procs[0]?.pid ?? null };
      } catch (error) {
        const procs = await listMainProcesses(app).catch(() => []);
        return { ok: false, code: error.code || 'relaunch-failed', pid: procs[0]?.pid ?? null, message: error.message };
      }
    },
    attach: version => openDebugSession(version, {
      debugPort: ctx.debugPort,
      config: () => loadConfig(ctx),
      onReady: api => { session = api; },
      onNavigation: info => controller.onNavigation(info),
      onBinding: async payload => {
        const body = JSON.parse(payload || '{}');
        await saveWallpaper(ctx, body);
        await session?.ensure?.({ reason: 'binding' });
      },
      onClose: () => { void controller.onSessionClose().catch(error => console.error(error.message)); },
      rememberScript: entry => rememberScript(ctx.dir, entry),
      log: message => console.error(message),
    }),
    detach: async () => { session?.close(); session = null; },
    ensureOverlay: async info => (session ? session.ensure(info) : { ok: true, skipped: true }),
    uninstall: () => session?.uninstall?.() ?? Promise.resolve(),
    diagnose: async entry => {
      if (entry.message) console.error(`${entry.code}：${entry.message}`);
      else console.error(entry.code);
      await writeDiagnostic(ctx.dir, entry);
    },
    defer: () => new Promise(resolve => setTimeout(resolve, 80)),
  });
  const wired = controller;
  let directoryWatch;
  try {
    directoryWatch = watchDirectory(ctx.dir, (_event, filename) => {
      if (filename === 'last-applied.json') void wired.onWallpaperFile();
    });
  } catch (error) {
    console.error(`无法监听壁纸记录：${error.message}`);
  }
  const monitor = runLaunchMonitor({
    start: options => startLaunchMonitor({ onEvent: options.onEvent, onExit: options.onExit }),
    onEvent: event => {
      if (event.type === 'ready' || !isGrokAppEvent(event)) return;
      const action = event.type === 'terminate' ? wired.onTerminate() : wired.onLaunchEvent(event);
      Promise.resolve(action).catch(error => console.error(error.message));
    },
    onGiveUp: code => {
      const entry = { code: 'launch-monitor-down', message: `启动监听已退出（${code}）。已停止重试，没有改用轮询。` };
      console.error(entry.message);
      void writeDiagnostic(ctx.dir, entry);
    },
  });
  const startup = await wired.startup();
  return {
    code: 0,
    action: 'watching',
    startup,
    stop: async () => {
      monitor.stop();
      directoryWatch?.close();
      await acquired.close();
    },
  };
}

async function osascriptRunning() {
  try {
    const { stdout } = await exec('osascript', ['-e', 'application "Grok Bot" is running']);
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || ['help', '--help', '-h'].includes(command)) { console.log(help); return; }
  if (!['apply', 'restore', 'status', 'panel', 'watch'].includes(command)) throw new Error('未知命令。运行 help 查看用法。');
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('需要 Node.js 22 或更新版本。');
  if (process.platform !== 'darwin') throw new Error('请在用户的 Mac 上运行此命令。');
  const ctx = runtime();
  if (command === 'status') {
    const installed = await appPath();
    const version = await probeDebug();
    const health = await panelHealth();
    const running = await osascriptRunning() || (await listMainProcesses(installed)).length > 0;
    console.log(JSON.stringify(buildStatus({
      running,
      debug: Boolean(version && isAllowedDebugUrl(version.webSocketDebuggerUrl)),
      panel: Boolean(health?.ok),
      autostart: await autostartRunning(),
      appPath: installed,
      port: DEBUG_PORT,
      panelPort: PANEL_PORT,
      lastApplied: await readJSON(path.join(ctx.dir, 'last-applied.json'), null),
      diagnostic: await readJSON(path.join(ctx.dir, 'diagnostic.json'), null),
      panelProtocol: health?.protocol ?? null,
      panelPid: health?.pid ?? null,
    }), null, 2));
    return;
  }
  if (command === 'panel' || command === 'watch') {
    if (args.length) throw new Error('此命令不接受参数。');
    if (command === 'panel') {
      const acquired = await acquireSingleWatcher({
        ...ctx,
        port: PANEL_PORT,
        host: LOOPBACK,
        pidAlive,
        isWatchCommand,
        onDiagnostic: entry => writeDiagnostic(ctx.dir, entry),
        onExit: code => process.exit(code),
      });
      if (acquired.action !== 'bound') {
        console.error(acquired.code === 'panel-yield' ? '壁纸面板助手已在运行。' : '面板端口没能独占，已停止。');
        return;
      }
      console.log(`壁纸面板助手已在 http://${LOOPBACK}:${PANEL_PORT} 启动。`);
      return;
    }
    const app = await appPath();
    const watching = await runWatch(ctx, { app, appPath: app, onExit: code => process.exit(code) });
    if (watching.action !== 'watching') return;
    console.log(`壁纸助手已在 http://${LOOPBACK}:${PANEL_PORT} 待命。应用打开、导航和重新加载时会恢复壁纸。`);
    return;
  }
  if (command === 'restore') {
    if (args.length) throw new Error('此命令不接受参数。');
    const version = await probeDebug();
    if (!version) {
      console.log('本机调试端口未开启，无法确认或恢复窗口；本命令不会重启应用。手动退出应用可清除本进程的覆盖层。');
      return;
    }
    await injectOnce(ctx, version, null);
    const last = await readJSON(path.join(ctx.dir, 'last-applied.json'), {}) ?? {};
    await writeJSON(path.join(ctx.dir, 'last-applied.json'), { ...last, restored: true, restoredAt: new Date().toISOString() });
    console.log('已恢复当前窗口并移除已记录的重载脚本。');
    return;
  }
  let file = args.shift();
  if (!file || file.startsWith('--')) throw new Error('apply 需要图片路径。');
  let opacity = 0.9;
  let appearance = 'dark';
  let confirmed = false;
  let mode;
  while (args.length) {
    const arg = args.shift();
    if (arg === '--relaunch') confirmed = true;
    else if (arg === '--opacity') {
      const value = args.shift();
      if (!value || !Number.isFinite(Number(value))) throw new Error('--opacity 需要有限数字。');
      opacity = clampOpacity(value);
    } else if (arg === '--dark' || arg === '--light') {
      if (mode && mode !== arg) throw new Error('--dark 和 --light 不能同时使用。');
      mode = arg;
      appearance = arg.slice(2);
    } else throw new Error('未知选项。运行 help 查看用法。');
  }
  const version = await probeDebug();
  if (!version && !confirmed) {
    console.error('首次换背景需要确认后重启 Grok Bot，并开启仅本机可用的调试端口；当前窗口会关闭。确认后请加 --relaunch 重试。未退出应用。');
    process.exitCode = 2;
    return;
  }
  const result = await applyWallpaper({
    debugPort: DEBUG_PORT,
    panelPort: PANEL_PORT,
    prepare: image => prepareFile(ctx.dir, image),
    probe: () => probeDebug(),
    relaunch: async () => {
      const app = await appPath();
      const guardPath = path.join(ctx.dir, 'relaunch-guard.json');
      const now = Date.now();
      const current = normalizeGuard(await readJSON(guardPath, emptyGuard()));
      const reserved = reserveRelaunch(current, { id: `apply:${now}` }, now);
      await writeJSON(guardPath, reserved);
      try {
        return await runOneRelaunch({
          quitApp: () => quitAppNormally({ exec, listProcesses: () => listMainProcesses(app) }),
          openWithDebug: () => openWithDebug({ exec, appPath: app, debugPort: DEBUG_PORT }),
          listProcesses: () => listMainProcesses(app),
          isMain: command => isMainBinary(command, app),
          probe: () => probeDebug(),
          debugPort: DEBUG_PORT,
        });
      } catch (error) {
        const procs = await listMainProcesses(app).catch(() => []);
        await writeJSON(guardPath, recordRelaunchFailure(reserved, Date.now(), {
          code: error.code || 'relaunch-failed',
          resultPid: procs[0]?.pid ?? null,
          originPid: procs[0]?.pid ?? null,
        }));
        throw error;
      }
    },
    installAutostart: () => installAutostart({
      dir: ctx.dir,
      agentsDir: agentDir(),
      nodePath: process.execPath,
      scriptPath: fileURLToPath(import.meta.url),
      uid: process.getuid(),
      exec,
    }),
    ensureWatcher: async () => ensureWatcher({
      health: () => panelHealth(),
      autostartRunning: await autostartRunning(),
      spawn: async () => {
        await fs.mkdir(ctx.dir, { recursive: true, mode: 0o700 });
        const log = await fs.open(path.join(ctx.dir, 'panel.log'), 'a');
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'watch'], {
          detached: true,
          stdio: ['ignore', log.fd, log.fd],
        });
        child.unref();
        await log.close();
      },
    }),
    inject: (current, config) => injectOnce(ctx, current, config),
    writeLast: record => writeJSON(path.join(ctx.dir, 'last-applied.json'), record),
    nowIso: () => new Date().toISOString(),
  }, { file, opacity, appearance, confirmed });
  if (result.code === 2) {
    process.exitCode = 2;
    return;
  }
  if (result.code !== 0) {
    console.error(`错误：${result.error || 'apply 失败'}`);
    process.exitCode = result.code;
    return;
  }
  if (!result.autostart?.ok) console.error(`登录自启未装上：${result.autostart?.error || result.autostart?.action}`);
  const panelReady = Boolean(result.watcher?.ready);
  console.log(`已应用：${result.image}\n这是本机覆盖层，不是官方主题。完全退出后，下次打开应用时会按上次的图片、透明度和外观恢复。${panelReady ? '\n窗口右下角可上传壁纸和调整透明度。' : '\n悬浮面板助手未独占端口。看 diagnostic.json，不要同时再开一个助手。'}`);
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  main().catch(error => { console.error(`错误：${error.message}`); process.exitCode = 1; });
}
