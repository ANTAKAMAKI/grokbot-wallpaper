import { EventEmitter } from 'node:events';
import http from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_LABEL,
  DEBUG_PORT,
  LOOPBACK,
  PROTOCOL,
  RELAUNCH_COOLDOWN_MS,
  WATCH_MODE,
  acquireSingleWatcher,
  applyWallpaper,
  assessRelaunch,
  buildAgentPlist,
  buildEnsureExpression,
  buildLiveUpdateExpression,
  buildStatus,
  commandHasLoopbackDebug,
  createCdpConnection,
  createPanelHandler,
  createWatchController,
  decidePanelConflict,
  emptyGuard,
  ensureWatcher,
  hasExactFlag,
  installAutostart,
  isAllowedDebugUrl,
  isBootstrapConflict,
  isGrokAppEvent,
  isMainBinary,
  isWallpaperTarget,
  launchMonitorSource,
  listenLoopback,
  openWithDebug,
  overlay,
  parseLaunchctlPrint,
  parseMonitorLine,
  parseProcessList,
  prepareFile,
  probePort,
  quitAppNormally,
  recordRelaunchFailure,
  registerWatchStart,
  reserveRelaunch,
  routeDebugEvent,
  runLaunchMonitor,
  runOneRelaunch,
  saveWallpaper,
  sha256,
  startLaunchMonitor,
} from '../scripts/grokbot-wallpaper.mjs';

const APP = '/Applications/Grok Bot.app';
const BIN = `${APP}/Contents/MacOS/Grok Bot`;
const DEBUG_COMMAND = `${BIN} --remote-debugging-port=19222 --remote-debugging-address=127.0.0.1`;
const PLAIN_COMMAND = BIN;
const VERSION = { webSocketDebuggerUrl: 'ws://127.0.0.1:19222/devtools/browser/test' };
const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function tempDir() {
  return mkdtemp(path.join(tmpdir(), 'grokbot-wallpaper-'));
}

function clock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    set: value => { now = value; },
    advance: ms => { now += ms; },
  };
}

function controllerFixture(options = {}) {
  const time = clock();
  const calls = [];
  const diagnostics = [];
  let guard = emptyGuard();
  const state = {
    last: { image: '/tmp/current.png', opacity: 0.94, appearance: 'dark', restored: false, sha256: 'abc' },
    procs: [],
    probeValue: null,
  };
  const controller = createWatchController({
    now: time.now,
    cooldownMs: RELAUNCH_COOLDOWN_MS,
    readLast: async () => state.last,
    readGuard: async () => guard,
    writeGuard: async value => { guard = value; },
    listProcesses: async () => state.procs,
    isMain: command => isMainBinary(command, APP),
    probe: async () => state.probeValue,
    waitForDebug: async () => state.probeValue,
    relaunch: async () => {
      calls.push('relaunch');
      return options.relaunch ? options.relaunch(state) : { ok: false, code: 'quit-refused', pid: state.procs[0]?.pid ?? null };
    },
    attach: async () => { calls.push('attach'); },
    detach: async () => { calls.push('detach'); },
    ensureOverlay: async info => { calls.push(['ensure', info?.reason]); },
    uninstall: async () => { calls.push('uninstall'); },
    diagnose: async entry => { diagnostics.push(entry); },
    defer: () => Promise.resolve(),
  });
  return { controller, state, calls, diagnostics, time, guard: () => guard };
}

function relaunchCount(calls) {
  return calls.filter(call => call === 'relaunch').length;
}

test('debug address and process flags stay on loopback', () => {
  assert.equal(WATCH_MODE, 'event-driven');
  assert.equal(isAllowedDebugUrl('ws://127.0.0.1:19222/devtools/browser/abc', DEBUG_PORT), true);
  assert.equal(isAllowedDebugUrl('ws://127.0.0.1:19223/devtools/browser/abc'), false);
  assert.equal(isAllowedDebugUrl('ws://0.0.0.0:19222/devtools/browser/abc'), false);
  assert.equal(isAllowedDebugUrl('wss://127.0.0.1:19222/devtools/browser/abc'), false);
  assert.equal(isAllowedDebugUrl('http://127.0.0.1:19222/json'), false);
  assert.equal(commandHasLoopbackDebug(DEBUG_COMMAND), true);
  assert.equal(commandHasLoopbackDebug(PLAIN_COMMAND), false);
  assert.equal(commandHasLoopbackDebug(`${BIN} --remote-debugging-port=19222 --remote-debugging-address=0.0.0.0`), false);
  assert.equal(hasExactFlag(`${BIN} --remote-debugging-address=127.0.0.1.example`, '--remote-debugging-address=127.0.0.1'), false);
  assert.equal(isMainBinary(DEBUG_COMMAND, APP), true);
  assert.equal(isMainBinary(`/usr/bin/node ${BIN}`, APP), false);
  const parsed = parseProcessList(`  10 ${DEBUG_COMMAND}\n  11 /usr/bin/node helper watch\n  12 ${PLAIN_COMMAND}\n`, APP);
  assert.deepEqual(parsed.map(proc => proc.pid), [10, 12]);
});

test('launch and navigation events are not a timer', async () => {
  let intervals = 0;
  const original = globalThis.setInterval;
  globalThis.setInterval = () => { intervals += 1; return 1; };
  try {
    const fix = controllerFixture();
    fix.state.probeValue = VERSION;
    assert.equal((await fix.controller.startup()).action, 'attached');
    fix.state.probeValue = null;
    fix.state.procs = [];
    assert.equal((await fix.controller.startup()).action, 'idle');
    fix.controller.noteAttached(VERSION.webSocketDebuggerUrl);
    const pending = fix.controller.onNavigation({ reason: 'frameNavigated', sessionId: 's' });
    fix.controller.onNavigation({ reason: 'load', sessionId: 's' });
    fix.controller.onNavigation({ reason: 'documentUpdated', sessionId: 's' });
    await pending;
    assert.equal(relaunchCount(fix.calls), 0);
    assert.deepEqual(fix.calls.filter(call => Array.isArray(call)), [['ensure', 'documentUpdated']]);
    assert.equal(intervals, 0);
  } finally {
    globalThis.setInterval = original;
  }
});

test('startup with a live debug session reinjects and does not quit', async () => {
  const fix = controllerFixture();
  fix.state.probeValue = VERSION;
  fix.state.procs = [{ pid: 22280, command: DEBUG_COMMAND }];
  const result = await fix.controller.startup();
  assert.equal(result.action, 'attached');
  assert.equal(relaunchCount(fix.calls), 0);
  assert.equal(fix.calls.filter(call => call === 'attach').length, 1);
});

test('startup does not open Grok Bot when it is not running', async () => {
  const fix = controllerFixture();
  const result = await fix.controller.startup();
  assert.equal(result.action, 'idle');
  assert.equal(relaunchCount(fix.calls), 0);
});

test('restored wallpaper does not relaunch or reinject', async () => {
  const fix = controllerFixture();
  fix.state.last = { image: '/tmp/current.png', restored: true };
  fix.state.procs = [{ pid: 4, command: PLAIN_COMMAND }];
  assert.equal((await fix.controller.startup()).action, 'inactive');
  assert.equal((await fix.controller.onLaunchEvent({ pid: 4 })).action, 'inactive');
  assert.equal(relaunchCount(fix.calls), 0);
});

test('a no-debug launch gets one relaunch and a second event does not', async () => {
  const fix = controllerFixture();
  fix.state.procs = [{ pid: 10, command: PLAIN_COMMAND }, { pid: 11, command: PLAIN_COMMAND }];
  const first = fix.controller.onLaunchEvent({ pid: 10, path: '/Applications/Grok Bot.app' });
  const second = fix.controller.onLaunchEvent({ pid: 11, path: '/Applications/Grok Bot.app' });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.action, 'failed');
  assert.equal(a.code, 'quit-refused');
  assert.equal(b.action, 'skipped');
  assert.equal(b.code, 'cooldown');
  assert.equal(relaunchCount(fix.calls), 1);
  fix.time.advance(RELAUNCH_COOLDOWN_MS + 1);
  fix.state.procs = [{ pid: 10, command: PLAIN_COMMAND }];
  const repeated = await fix.controller.onLaunchEvent({ pid: 10 });
  assert.equal(repeated.code, 'trigger-handled');
  assert.equal(relaunchCount(fix.calls), 1);
});

test('three failed relaunches stop further automatic quits', async () => {
  const fix = controllerFixture();
  for (const pid of [10, 11, 12]) {
    fix.state.procs = [{ pid, command: PLAIN_COMMAND }];
    const result = await fix.controller.onLaunchEvent({ pid });
    assert.equal(result.code, 'quit-refused');
    fix.time.advance(RELAUNCH_COOLDOWN_MS + 1);
  }
  fix.state.procs = [{ pid: 13, command: PLAIN_COMMAND }];
  const stopped = await fix.controller.onLaunchEvent({ pid: 13 });
  assert.equal(stopped.code, 'relaunch-cap');
  assert.equal(relaunchCount(fix.calls), 3);
  assert.equal(fix.diagnostics.at(-1).code, 'relaunch-cap');
});

test('a failed relaunch suppresses the resulting no-debug pid', () => {
  const now = 5_000;
  const reserved = reserveRelaunch(emptyGuard(), { id: 'launch:10', pid: 10 }, now);
  const failed = recordRelaunchFailure(reserved, now, { code: 'relaunch-no-debug', originPid: 10, resultPid: 11 });
  const again = assessRelaunch(failed, { id: 'disconnect:11', pid: 11 }, now + RELAUNCH_COOLDOWN_MS + 5);
  assert.equal(again.allow, false);
  assert.equal(again.code, 'suppressed-pid');
});

test('debug launch attaches instead of quitting', async () => {
  const fix = controllerFixture();
  fix.state.procs = [{ pid: 30, command: DEBUG_COMMAND }];
  fix.state.probeValue = VERSION;
  const result = await fix.controller.onLaunchEvent({ pid: 30 });
  assert.equal(result.action, 'attached');
  assert.equal(relaunchCount(fix.calls), 0);
});

test('reload, back navigation, and a new target share one ensure', async () => {
  const fix = controllerFixture();
  fix.controller.noteAttached(VERSION.webSocketDebuggerUrl);
  const pending = Promise.all([
    fix.controller.onNavigation({ reason: 'frameNavigated', sessionId: 'main' }),
    fix.controller.onNavigation({ reason: 'load', sessionId: 'main' }),
    fix.controller.onNavigation({ reason: 'attach', sessionId: 'webview' }),
  ]);
  await pending;
  assert.deepEqual(fix.calls.filter(call => Array.isArray(call)), [['ensure', 'attach']]);
  assert.equal(relaunchCount(fix.calls), 0);
});

test('debug session loss reconnects once and then stops', async () => {
  const fix = controllerFixture({ relaunch: () => ({ ok: true, version: VERSION, pid: 70 }) });
  fix.state.procs = [{ pid: 70, command: PLAIN_COMMAND }];
  const first = await fix.controller.onSessionClose();
  const second = await fix.controller.onSessionClose();
  assert.equal(first.action, 'relaunched');
  assert.equal(second.code, 'debug-session-lost');
  assert.equal(relaunchCount(fix.calls), 1);
  const reconnect = controllerFixture();
  reconnect.state.probeValue = VERSION;
  assert.equal((await reconnect.controller.onSessionClose()).action, 'reconnected');
  assert.equal((await reconnect.controller.onSessionClose()).code, 'debug-session-lost');
  assert.equal(relaunchCount(reconnect.calls), 0);
  assert.equal(reconnect.calls.filter(call => call === 'attach').length, 1);
});

test('restoring the saved record uninstalls without another relaunch', async () => {
  const fix = controllerFixture();
  fix.controller.noteAttached(VERSION.webSocketDebuggerUrl);
  fix.state.last = { image: '/tmp/current.png', restored: true };
  const result = await fix.controller.onWallpaperFile();
  assert.equal(result.action, 'inactive');
  assert.equal(fix.calls.at(-1), 'uninstall');
  assert.equal(relaunchCount(fix.calls), 0);
});

test('routeDebugEvent follows navigation, reload, documents, and bindings', async () => {
  const seen = [];
  const hooks = {
    onNavigation: info => seen.push(info.reason),
    onAttach: info => seen.push(`attach:${info.info.type}`),
    onBinding: payload => seen.push(payload),
  };
  routeDebugEvent({ method: 'Page.frameNavigated', sessionId: 's', params: { frame: { parentId: 'child' } } }, hooks);
  routeDebugEvent({ method: 'Page.frameNavigated', sessionId: 's', params: { frame: {} } }, hooks);
  routeDebugEvent({ method: 'Page.loadEventFired', sessionId: 's' }, hooks);
  routeDebugEvent({ method: 'DOM.documentUpdated', sessionId: 's' }, hooks);
  routeDebugEvent({ method: 'Target.attachedToTarget', params: { sessionId: 's', targetInfo: { type: 'page', url: 'devtools://x', targetId: 'd' } } }, hooks);
  routeDebugEvent({ method: 'Target.attachedToTarget', params: { sessionId: 'w', targetInfo: { type: 'webview', url: 'app://chat', targetId: 'w' } } }, hooks);
  routeDebugEvent({ method: 'Runtime.bindingCalled', params: { name: 'grokbotWallpaperSave', payload: '{"opacity":0.94}' } }, hooks);
  assert.deepEqual(seen, ['frameNavigated', 'load', 'documentUpdated', 'attach:webview', '{"opacity":0.94}']);
  assert.equal(isWallpaperTarget({ type: 'page', url: 'chrome://gpu' }), false);
});

test('cdp client dispatches responses and events', async () => {
  const ws = new EventTarget();
  ws.sent = [];
  ws.send = data => { ws.sent.push(JSON.parse(data)); };
  ws.close = () => ws.dispatchEvent(new Event('close'));
  const cdp = createCdpConnection(ws);
  const events = [];
  cdp.onEvent(event => events.push(event.method));
  const pending = cdp.call('Target.setDiscoverTargets', { discover: true });
  ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: ws.sent[0].id, result: { ok: true } }) }));
  assert.deepEqual(await pending, { ok: true });
  ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ method: 'Page.loadEventFired', sessionId: 's' }) }));
  assert.deepEqual(events, ['Page.loadEventFired']);
});

test('normal quit never signals the app and does not open when quit fails', async () => {
  const calls = [];
  const moving = clock(0);
  await assert.rejects(() => quitAppNormally({
    exec: async (file, args) => {
      calls.push([file, args]);
      return { stdout: '' };
    },
    listProcesses: async () => [{ pid: 1, command: PLAIN_COMMAND }],
    sleep: async () => {},
    now: () => { moving.advance(1000); return moving.now(); },
    timeoutMs: 1500,
  }), error => error.code === 'quit-refused');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'osascript');
  assert.match(calls[0][1][1], /quit/);

  let opened = 0;
  await assert.rejects(() => runOneRelaunch({
    quitApp: async () => { const error = new Error('still open'); error.code = 'quit-refused'; throw error; },
    openWithDebug: async () => { opened += 1; },
    listProcesses: async () => [{ pid: 1, command: PLAIN_COMMAND }],
    isMain: command => isMainBinary(command, APP),
    probe: async () => { throw new Error('probe should not run'); },
    debugPort: DEBUG_PORT,
  }), error => error.code === 'quit-refused');
  assert.equal(opened, 0);
});

test('one relaunch opens with loopback args and stops if debug args are missing', async () => {
  const calls = [];
  const opened = await openWithDebug({
    exec: async (file, args) => { calls.push([file, args]); },
    appPath: APP,
    debugPort: DEBUG_PORT,
  });
  assert.equal(calls[0][0], 'open');
  assert.deepEqual(opened, ['-a', APP, '--args', '--remote-debugging-port=19222', '--remote-debugging-address=127.0.0.1']);

  const sequence = [];
  let checks = 0;
  await assert.rejects(() => runOneRelaunch({
    quitApp: async () => { sequence.push('quit'); },
    openWithDebug: async () => { sequence.push('open'); },
    listProcesses: async () => {
      checks += 1;
      return checks === 1 ? [] : [{ pid: 8, command: PLAIN_COMMAND }];
    },
    isMain: command => isMainBinary(command, APP),
    probe: async () => VERSION,
    debugPort: DEBUG_PORT,
    debugTimeoutMs: 0,
  }), error => error.code === 'relaunch-no-debug');
  assert.deepEqual(sequence, ['quit', 'open']);

  const success = [];
  let reads = 0;
  const version = await runOneRelaunch({
    quitApp: async () => { success.push('quit'); },
    openWithDebug: async () => { success.push('open'); },
    listProcesses: async () => {
      reads += 1;
      return reads === 1 ? [] : [{ pid: 9, command: DEBUG_COMMAND }];
    },
    isMain: command => isMainBinary(command, APP),
    probe: async () => VERSION,
    debugPort: DEBUG_PORT,
  });
  assert.equal(version.webSocketDebuggerUrl, VERSION.webSocketDebuggerUrl);
  assert.deepEqual(success, ['quit', 'open']);
});

test('launch monitor is push-based and gives up after one restart', async () => {
  const source = launchMonitorSource();
  assert.match(source, /NSWorkspaceDidLaunchApplicationNotification/);
  assert.match(source, /NSWorkspaceDidTerminateApplicationNotification/);
  assert.match(source, /runUntilDate/);
  assert.doesNotMatch(source, /delay\s*\(/);
  const ready = parseMonitorLine('{"type":"ready"}');
  const launch = parseMonitorLine('{"type":"launch","name":"Grok Bot","path":"/Applications/Grok Bot.app","pid":"15"}');
  assert.equal(ready.type, 'ready');
  assert.equal(launch.pid, 15);
  assert.equal(isGrokAppEvent(launch), true);
  assert.equal(isGrokAppEvent({ type: 'launch', name: 'Safari', path: '/Applications/Safari.app' }), false);
  assert.equal(parseMonitorLine('not json'), null);

  let starts = 0;
  let gaveUp = false;
  let exitHandler = null;
  const monitor = runLaunchMonitor({
    start({ onExit }) {
      starts += 1;
      exitHandler = onExit;
      return { stop() {} };
    },
    onEvent() {},
    onGiveUp() { gaveUp = true; },
  });
  exitHandler(1);
  await new Promise(resolve => setImmediate(resolve));
  exitHandler(1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts, 2);
  assert.equal(gaveUp, true);
  monitor.stop();

  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdin = { end() {} };
  child.kill = () => {};
  const seen = [];
  startLaunchMonitor({
    spawnImpl: () => child,
    onEvent: event => seen.push(event.type),
  });
  child.stdout.emit('data', '{"type":"launch","name":"Grok Bot","path":"/Applications/Grok Bot.app","pid":4}\n');
  assert.deepEqual(seen, ['launch']);
});

test('launch agent plist has no schedule and bootstrap conflict is one attempt', async () => {
  const dir = await tempDir();
  const agents = await tempDir();
  try {
    const plist = buildAgentPlist({
      nodePath: '/Users/Admin1/.local/node/bin/node',
      scriptPath: '/Users/Admin1/Library/Application Support/grokbot-wallpaper/scripts/grokbot-wallpaper.mjs',
      dir,
      logPath: path.join(dir, 'watch.log'),
    });
    assert.match(plist, /GROKBOT_WALLPAPER_AGENT/);
    assert.match(plist, /SuccessfulExit/);
    assert.match(plist, /<string>watch<\/string>/);
    assert.doesNotMatch(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
    for (const banned of ['StartInterval', 'StartCalendarInterval', 'WatchPaths', '-k']) assert.equal(plist.includes(banned), false, banned);
    const escaped = buildAgentPlist({ nodePath: '/tmp/node&bin', scriptPath: '/tmp/<script>.mjs', dir: '/tmp/d', logPath: '/tmp/l' });
    assert.match(escaped, /node&amp;bin/);
    assert.match(escaped, /&lt;script&gt;/);

    await writeFile(path.join(agents, `${AGENT_LABEL}.plist`), plist);
    const same = await installAutostart({
      dir, agentsDir: agents, nodePath: '/Users/Admin1/.local/node/bin/node',
      scriptPath: '/Users/Admin1/Library/Application Support/grokbot-wallpaper/scripts/grokbot-wallpaper.mjs',
      uid: 501,
      exec: async (file, args) => {
        if (args.includes('-k')) throw new Error('forbidden');
        if (args[0] === 'print') return { stdout: 'state = running\npid = 30957\n' };
        throw new Error(`unexpected ${args.join(' ')}`);
      },
    });
    assert.equal(same.action, 'already-loaded');
    assert.equal(same.pid, 30957);

    const conflict = Object.assign(new Error('Command failed'), { stderr: 'Bootstrap failed: 5: Input/output error', code: 5 });
    assert.equal(isBootstrapConflict(conflict), true);
    let bootstraps = 0;
    const loadedAfterError = await installAutostart({
      dir: await tempDir(),
      agentsDir: await tempDir(),
      nodePath: '/bin/node',
      scriptPath: '/tmp/grokbot-wallpaper.mjs',
      uid: 501,
      exec: async (_file, args) => {
        if (args.includes('-k')) throw new Error('forbidden');
        if (args[0] === 'print') {
          if (bootstraps === 0) { const error = new Error('Could not find service'); throw error; }
          return { stdout: 'state = running\npid = 5\n' };
        }
        if (args[0] === 'bootstrap') {
          bootstraps += 1;
          throw conflict;
        }
        if (args[0] === 'enable') return { stdout: '' };
        throw new Error(args.join(' '));
      },
    });
    assert.equal(loadedAfterError.ok, true);
    assert.equal(loadedAfterError.action, 'bootstrap-already-loaded');
    assert.equal(bootstraps, 1);

    let failedBootstraps = 0;
    let kickstarts = 0;
    const failed = await installAutostart({
      dir: await tempDir(),
      agentsDir: await tempDir(),
      nodePath: '/bin/node',
      scriptPath: '/tmp/grokbot-wallpaper.mjs',
      uid: 501,
      exec: async (_file, args) => {
        if (args[0] === 'print') { const error = new Error('Could not find service'); throw error; }
        if (args[0] === 'bootstrap') { failedBootstraps += 1; throw conflict; }
        if (args[0] === 'kickstart') kickstarts += 1;
        if (args[0] === 'enable') return { stdout: '' };
        return { stdout: '' };
      },
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.action, 'bootstrap-failed');
    assert.equal(failedBootstraps, 1);
    assert.equal(kickstarts, 0);
    assert.match(failed.error, /Input\/output error/);

    let bootouts = 0;
    const stuck = await installAutostart({
      dir, agentsDir: agents, nodePath: '/bin/node', scriptPath: '/tmp/other.mjs', uid: 501,
      exec: async (_file, args) => {
        if (args[0] === 'print') return { stdout: 'state = running\npid = 1\n' };
        if (args[0] === 'bootout') { bootouts += 1; const error = new Error('bootout failed'); throw error; }
        if (args[0] === 'bootstrap') throw new Error('bootstrap should not run');
        return { stdout: '' };
      },
    });
    assert.equal(stuck.action, 'bootout-stuck');
    assert.equal(bootouts, 1);
    assert.equal(parseLaunchctlPrint('state = running\npid = 4\n').pid, 4);
    assert.equal(parseLaunchctlPrint('Could not find service'), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(agents, { recursive: true, force: true });
  }
});

test('panel binds only loopback and rejects other hosts', async () => {
  const server = http.createServer((_req, res) => res.end('ok'));
  const address = await listenLoopback(server, 0, LOOPBACK);
  try {
    assert.equal(address.address, LOOPBACK);
    assert.equal(await probePort(address.port), true);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  const rejected = http.createServer();
  assert.throws(() => listenLoopback(rejected, 0, '0.0.0.0'), error => error.code === 'host-rejected');
  assert.throws(() => listenLoopback(rejected, 0, 'localhost'), error => error.code === 'host-rejected');
  rejected.close();

  const statuses = [];
  const handler = createPanelHandler({
    pid: 3, ppid: 1, managed: true, token: 'secret-token', port: 9,
    save: async () => ({ opacity: 0.94, image: '/tmp/current.png', appearance: 'dark' }),
    onHandover() { statuses.push('handover'); },
  });
  async function call(address, method, url, body) {
    const chunks = [];
    const response = { writeHead(code) { this.status = code; }, end(payload) { this.body = payload; } };
    const request = {
      method, url, socket: { remoteAddress: address },
      async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(body); },
    };
    await handler(request, response);
    chunks.push(response);
    return response;
  }
  const remote = await call('8.8.8.8', 'GET', '/health');
  assert.equal(remote.status, 403);
  const health = await call(LOOPBACK, 'GET', '/health');
  const healthBody = JSON.parse(health.body);
  assert.equal(healthBody.ok, true);
  assert.equal(healthBody.protocol, PROTOCOL);
  assert.equal(healthBody.token, undefined);
  const denied = await call(LOOPBACK, 'POST', '/handover', JSON.stringify({ token: 'nope' }));
  assert.equal(denied.status, 403);
  assert.equal(statuses.length, 0);
});

function watcherCtx(dir, extra) {
  return {
    dir, host: LOOPBACK, port: 0, pid: 1, ppid: 2, managed: false,
    pidAlive: async () => false,
    isWatchCommand: async () => false,
    healthAttempts: 8,
    healthGapMs: 15,
    handoverWaitMs: 2000,
    ...extra,
  };
}

test('one watcher owns the panel, legacy owners are left alone, and a dead owner is recovered', async () => {
  const dirs = [];
  const closers = [];
  const make = async () => {
    const dir = await tempDir();
    dirs.push(dir);
    return dir;
  };
  try {
    const legacyDir = await make();
    const legacy = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, pid: 22299 }));
    });
    const legacyAddress = await listenLoopback(legacy, 0);
    closers.push(() => new Promise(resolve => legacy.close(resolve)));
    const refused = await acquireSingleWatcher(watcherCtx(legacyDir, {
      port: legacyAddress.port, pid: 30957, ppid: 1, managed: true,
    }));
    assert.equal(refused.code, 'panel-legacy');
    assert.notEqual(refused.action, 'bound');
    assert.equal((await (await fetch(`http://${LOOPBACK}:${legacyAddress.port}/health`)).json()).pid, 22299);

    const agentDir = await make();
    const agent = await acquireSingleWatcher(watcherCtx(agentDir, {
      pid: 10, ppid: 1, managed: true,
      pidAlive: async pid => pid === 10,
      isWatchCommand: async () => true,
    }));
    closers.push(() => agent.close());
    assert.equal(agent.action, 'bound');
    const yielded = await acquireSingleWatcher(watcherCtx(agentDir, {
      port: agent.port, pid: 20, ppid: 80, managed: false,
      pidAlive: async () => true, isWatchCommand: async () => true,
    }));
    assert.equal(yielded.action, 'yield');
    assert.equal((await (await fetch(`${agent.url}/health`)).json()).pid, 10);
    assert.equal(decidePanelConflict({ selfManaged: false, ownerManaged: true, selfPid: 20, ownerPid: 10 }), 'yield');

    const manualDir = await make();
    let manualExit = null;
    const manual = await acquireSingleWatcher(watcherCtx(manualDir, {
      pid: 10, ppid: 40, managed: false,
      pidAlive: async pid => pid === 10,
      isWatchCommand: async () => true,
      onExit(code) { manualExit = code; },
    }));
    closers.push(() => manual.close());
    const takeover = await acquireSingleWatcher(watcherCtx(manualDir, {
      port: manual.port, pid: 30, ppid: 1, managed: true,
      pidAlive: async pid => pid === 10 || pid === 30,
      isWatchCommand: async () => true,
    }));
    closers.push(() => takeover.close());
    assert.equal(takeover.action, 'bound');
    assert.equal(manualExit, 0);
    const owned = await (await fetch(`${takeover.url}/health`)).json();
    assert.equal(owned.pid, 30);
    assert.equal(owned.managed, true);
    assert.equal(owned.token, undefined);
    assert.equal(decidePanelConflict({ selfManaged: true, ownerManaged: false, selfPid: 30, ownerPid: 10 }), 'handover');

    await new Promise(resolve => takeover.server.close(resolve));
    const recovered = await acquireSingleWatcher(watcherCtx(manualDir, {
      port: takeover.port, pid: 40, ppid: 1, managed: true,
      pidAlive: async () => false,
    }));
    closers.push(() => recovered.close());
    assert.equal(recovered.action, 'bound');
    assert.equal((await (await fetch(`${recovered.url}/health`)).json()).pid, 40);

    const lostDir = await make();
    await mkdir(path.join(lostDir, 'watch.lock'));
    await writeFile(path.join(lostDir, 'watch.lock', 'pid'), '22299');
    await writeFile(path.join(lostDir, 'watch.lock', 'ppid'), '1');
    await writeFile(path.join(lostDir, 'watch.lock', 'token'), 'old-token');
    await writeFile(path.join(lostDir, 'watch.lock', 'managed'), '0');
    const rebound = await acquireSingleWatcher(watcherCtx(lostDir, {
      pid: 50, ppid: 1, managed: true,
      pidAlive: async () => true,
      isWatchCommand: async () => true,
    }));
    closers.push(() => rebound.close());
    assert.equal(rebound.action, 'bound');
    assert.equal((await (await fetch(`${rebound.url}/health`)).json()).pid, 50);
  } finally {
    await Promise.all(closers.map(close => Promise.resolve().then(close).catch(() => {})));
    await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })));
  }
});

test('opacity and original bytes survive a slider save', async () => {
  const dir = await tempDir();
  try {
    const source = path.join(dir, 'selected-wallpaper.png');
    await writeFile(source, TINY_PNG);
    const prepared = await prepareFile(dir, source);
    assert.equal(prepared.sha256, sha256(TINY_PNG));
    assert.deepEqual(await readFile(prepared.image), TINY_PNG);
    await writeFile(path.join(dir, 'last-applied.json'), JSON.stringify({
      image: prepared.image, source, opacity: 0.9, appearance: 'dark', restored: false,
    }));
    const before = await stat(prepared.image);
    const saved = await saveWallpaper({ dir }, { opacity: 0.94, appearance: 'dark' });
    const after = await stat(prepared.image);
    assert.equal(saved.opacity, 0.94);
    assert.equal(saved.appearance, 'dark');
    assert.equal(saved.restored, false);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.deepEqual(await readFile(prepared.image), TINY_PNG);
    assert.equal(saved.sha256, sha256(TINY_PNG));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('apply injects the requested opacity without relaunching a live debug session', async () => {
  const refused = await applyWallpaper({
    probe: async () => null,
    prepare: async () => { throw new Error('should not prepare'); },
    relaunch: async () => { throw new Error('should not relaunch'); },
  }, { file: '/tmp/selected-wallpaper.png', confirmed: false });
  assert.equal(refused.code, 2);

  let injected = 0;
  const failed = await applyWallpaper({
    probe: async () => null,
    prepare: async () => ({ image: '/tmp/current.png', source: '/tmp/selected-wallpaper.png', data: 'data:image/png;base64,AA', sha256: 'abc' }),
    relaunch: async () => { const error = new Error('no'); error.code = 'quit-refused'; throw error; },
    installAutostart: async () => { throw new Error('should not install'); },
    ensureWatcher: async () => { throw new Error('should not spawn'); },
    inject: async () => { injected += 1; },
    writeLast: async () => {},
    nowIso: () => 't',
  }, { file: '/tmp/selected-wallpaper.png', confirmed: true, opacity: 0.94, appearance: 'dark' });
  assert.equal(failed.code, 1);
  assert.equal(failed.error, 'quit-refused');
  assert.equal(injected, 0);

  const written = [];
  let relaunched = 0;
  const ok = await applyWallpaper({
    probe: async () => VERSION,
    prepare: async () => ({ image: '/tmp/current.png', source: '/tmp/selected-wallpaper.png', data: 'data:image/png;base64,AA', sha256: sha256(TINY_PNG) }),
    relaunch: async () => { relaunched += 1; },
    installAutostart: async () => ({ ok: true, action: 'already-loaded' }),
    ensureWatcher: async () => ({ ready: true, spawned: false }),
    inject: async (_version, config) => {
      assert.equal(config.opacity, 0.94);
      assert.equal(config.appearance, 'dark');
    },
    writeLast: async record => written.push(record),
    nowIso: () => '2026-11-25T02:45:57.000Z',
    debugPort: DEBUG_PORT,
  }, { file: '/tmp/selected-wallpaper.png', opacity: 0.94, appearance: 'dark' });
  assert.equal(ok.code, 0);
  assert.equal(relaunched, 0);
  assert.equal(written[0].opacity, 0.94);
  assert.equal(written[0].appearance, 'dark');
  assert.equal(written[0].restored, false);
});

test('a healthy panel is not joined by a second watcher', async () => {
  let spawned = 0;
  const ready = await ensureWatcher({
    health: async () => ({ ok: true, protocol: PROTOCOL, pid: 30 }),
    autostartRunning: true,
    spawn: async () => { spawned += 1; },
  });
  assert.equal(ready.ready, true);
  assert.equal(spawned, 0);
  const legacy = await ensureWatcher({
    health: async () => ({ ok: true, pid: 22299 }),
    autostartRunning: false,
    spawn: async () => { spawned += 1; },
  });
  assert.equal(legacy.code, 'panel-legacy');
  assert.equal(spawned, 0);
  const moving = clock(0);
  const deps = {
    health: async () => null,
    autostartRunning: false,
    spawned: false,
    spawn: async () => { spawned += 1; },
    sleep: async () => {},
    now: () => { moving.advance(5000); return moving.now(); },
    timeoutMs: 0,
    maxAttempts: 1,
  };
  const first = await ensureWatcher(deps);
  const second = await ensureWatcher(deps);
  assert.equal(first.spawned, true);
  assert.equal(second.code, 'already-spawned');
  assert.equal(spawned, 1);
  const waited = await ensureWatcher({
    health: async () => null,
    autostartRunning: true,
    spawn: async () => { spawned += 1; },
    sleep: async () => {},
    now: () => { moving.advance(5000); return moving.now(); },
    timeoutMs: 0,
    maxAttempts: 1,
  });
  assert.equal(waited.code, 'panel-not-ready');
  assert.equal(spawned, 1);
});

test('repeated watcher starts stop instead of looping', async () => {
  const dir = await tempDir();
  try {
    const now = 10_000;
    assert.equal((await registerWatchStart(dir, now)).ok, true);
    assert.equal((await registerWatchStart(dir, now + 1000)).ok, true);
    assert.equal((await registerWatchStart(dir, now + 2000)).ok, true);
    const stopped = await registerWatchStart(dir, now + 3000);
    assert.equal(stopped.ok, false);
    assert.equal(stopped.code, 'restart-storm');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('status does not claim the wallpaper is visible', () => {
  const status = buildStatus({
    running: true, debug: true, panel: false, autostart: true, appPath: APP,
    port: DEBUG_PORT, panelPort: 19223, lastApplied: { opacity: 0.94, appearance: 'dark' },
    diagnostic: { code: 'panel-legacy' }, panelProtocol: null, panelPid: null,
  });
  assert.equal(status.visibility, 'not-checked');
  assert.equal(status.panel, false);
  assert.equal(status.debug, true);
  assert.equal(status.lastApplied.opacity, 0.94);
});

test('in-page overlay remounts after removal and saves opacity without the image bytes', () => {
  const timers = [];
  const observers = new Set();
  class MutationObserver {
    constructor(callback) { this.callback = callback; this.target = null; observers.add(this); }
    observe(target) { this.target = target; }
    disconnect() { this.target = null; }
  }
  function notify() {
    for (const observer of observers) if (observer.target) observer.callback([]);
  }
  class Element {
    constructor(tag) {
      this.tag = tag;
      this.children = [];
      this.parent = null;
      this.listeners = {};
      this.id = '';
      this.className = '';
      this.textContent = '';
      this.hidden = false;
      this.type = '';
      this.value = '';
      this.accept = '';
      this.offsetWidth = 20;
      this.offsetHeight = 20;
      const map = new Map();
      this.style = {
        setProperty: (prop, value) => map.set(prop, value),
        getPropertyValue: prop => map.get(prop) || '',
        getPropertyPriority: () => '',
        removeProperty: prop => map.delete(prop),
        get backgroundImage() { return map.get('background-image') || ''; },
        set backgroundImage(value) { map.set('background-image', value); },
      };
      this.classList = { add() {}, remove() {} };
    }
    get isConnected() {
      let node = this;
      while (node) {
        if (node === document) return true;
        node = node.parent;
      }
      return false;
    }
    append(...nodes) { for (const node of nodes) this.adopt(node, false); notify(); }
    prepend(...nodes) { for (const node of nodes) this.adopt(node, true); notify(); }
    adopt(node, front) {
      if (node.parent) node.parent.children = node.parent.children.filter(child => child !== node);
      node.parent = this;
      if (front) this.children.unshift(node); else this.children.push(node);
    }
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
      this.parent = null;
      notify();
    }
    contains(node) {
      if (node === this) return true;
      return this.children.some(child => child.contains(node));
    }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter(item => item !== fn); }
    dispatch(type) { for (const fn of this.listeners[type] || []) fn({ target: this, button: 0, closest: () => null }); }
    getBoundingClientRect() { return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }; }
    closest() { return null; }
    querySelectorAll() { return []; }
    setPointerCapture() {}
    releasePointerCapture() {}
  }
  const document = {
    parent: null,
    children: [],
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    removeEventListener() {},
    createElement: tag => new Element(tag),
    getElementById(id) {
      const walk = node => {
        if (node.id === id) return node;
        for (const child of node.children || []) {
          const found = walk(child);
          if (found) return found;
        }
        return null;
      };
      return walk(document);
    },
  };
  const root = new Element('html');
  document.documentElement = root;
  document.head = new Element('head');
  document.body = new Element('body');
  root.append(document.head, document.body);
  root.parent = document;
  document.children = [root];
  const saved = [];
  const sandbox = {
    document,
    innerWidth: 1000,
    innerHeight: 700,
    MutationObserver,
    getComputedStyle: () => ({ visibility: 'visible', opacity: '1', backgroundImage: 'none', backgroundColor: 'rgba(0,0,0,0)' }),
    setTimeout(fn) { timers.push(fn); return timers.length; },
    clearTimeout(id) { timers[id - 1] = null; },
    Promise,
    JSON,
    console,
    grokbotWallpaperSave(payload) { saved.push(payload); },
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    removeEventListener() {},
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const config = { data: 'data:image/png;base64,AAAA', opacity: 0.94, appearance: 'dark', panel: 'http://127.0.0.1:19223' };
  vm.runInContext(`(${overlay.toString()})(${JSON.stringify(config)})`, sandbox);
  const layer = document.getElementById('grokbot-wallpaper-layer');
  assert.equal(layer.isConnected, true);
  assert.match(layer.style.backgroundImage, /16,19,25/);
  assert.match(layer.style.backgroundImage, /0\.06/);
  assert.match(layer.style.backgroundImage, /data:image\/png;base64,AAAA/);
  layer.remove();
  assert.equal(layer.isConnected, false);
  assert.equal(timers.length > 0, true);
  for (let pass = 0; pass < 4 && timers.length; pass += 1) {
    const batch = timers.splice(0);
    for (const fn of batch) if (fn) fn();
  }
  const restored = document.getElementById('grokbot-wallpaper-layer');
  assert.equal(restored.isConnected, true);
  const slider = document.body.children.flatMap(function walk(node) {
    return [node, ...(node.children || []).flatMap(walk)];
  }).find(node => node.type === 'range');
  slider.value = '0.5';
  slider.dispatch('input');
  const payload = JSON.parse(saved.at(-1));
  assert.equal(payload.opacity, 0.5);
  assert.equal(payload.appearance, 'dark');
  assert.equal(Object.hasOwn(payload, 'data'), false);
  assert.match(buildEnsureExpression(config), /ensured/);
  const live = buildLiveUpdateExpression({ opacity: 0.94, appearance: 'dark' });
  assert.equal(live.includes('base64'), false);
  assert.match(live, /0\.94/);
});

test('helper source has no polling loop and no forced process signals', async () => {
  const source = await readFile(new URL('../scripts/grokbot-wallpaper.mjs', import.meta.url), 'utf8');
  for (const banned of ['setInterval', 'for (;;)', 'StartInterval', 'StartCalendarInterval', 'WatchPaths', 'SIGKILL', 'SIGTERM', 'process.kill']) {
    assert.equal(source.includes(banned), false, banned);
  }
});
