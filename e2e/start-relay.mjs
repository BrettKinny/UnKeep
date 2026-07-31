import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = mkdtempSync(join(tmpdir(), 'unkeep-playwright-'));
let terminating = false;
let paused = false;
let relay = null;

function cleanUp() {
  rmSync(dataDir, { recursive: true, force: true });
}

function startRelay() {
  if (relay) return;
  const child = spawn(process.execPath, [join(root, 'apps/server/src/index.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: '4173',
      UNKEEP_DATA_DIR: dataDir,
      UNKEEP_WEB_DIR: join(root, 'apps/web/build'),
      UNKEEP_SETUP_TOKEN: 'playwright-setup-token-0000000001',
      UNKEEP_RECOVERY_TOKEN: 'playwright-recovery-token-00000001',
    },
    stdio: 'inherit',
  });

  relay = child;
  child.once('error', (error) => {
    console.error(error);
    if (relay === child) relay = null;
    if (!terminating && !paused) shutDown(1);
  });
  child.once('exit', (code, signal) => {
    if (relay === child) relay = null;
    if (!terminating && !paused) {
      console.error(`UnKeep E2E relay exited unexpectedly (${signal ?? code ?? 'unknown'})`);
      shutDown(code ?? 1);
    }
  });
}

function stopRelay() {
  const child = relay;
  if (!child) return Promise.resolve();
  return new Promise((resolveStop) => {
    child.once('exit', resolveStop);
    child.kill('SIGTERM');
  });
}

const control = createServer(async (request, response) => {
  if (request.method === 'POST' && request.url === '/pause') {
    paused = true;
    await stopRelay();
    response.writeHead(204).end();
    return;
  }
  if (request.method === 'POST' && request.url === '/resume') {
    paused = false;
    startRelay();
    response.writeHead(204).end();
    return;
  }
  if (request.method === 'POST' && request.url === '/shutdown') {
    response.writeHead(204).end();
    setImmediate(() => shutDown());
    return;
  }
  response.writeHead(404).end();
});

function shutDown(exitCode = 0) {
  if (terminating) return;
  terminating = true;
  paused = true;
  relay?.kill('SIGTERM');
  control.close();
  // Playwright may terminate the web-server process tree shortly after
  // SIGTERM, so remove our private temp directory synchronously first.
  cleanUp();
  process.exitCode = exitCode;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => shutDown());
}

control.listen(4174, '127.0.0.1');
startRelay();
