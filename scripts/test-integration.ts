// Orchestrator for the integration test suite.
//
// Starts `wrangler dev --env test` against ../talkative-relay, polls the
// relay's /status endpoint until it is ready, then runs the integration
// vitest suite. Always kills wrangler when vitest exits (success, failure,
// or SIGINT/SIGTERM).
//
// Opt-out: set TALKATIVE_RELAY_SKIP_START=1 to skip spawning wrangler (useful
// when you already have one running manually — the script will just verify
// the relay is reachable and then run tests).

import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';

const RELAY_DIR = resolve(__dirname, '..', '..', 'talkative-relay');
const PORT = process.env.RELAY_PORT ?? '8787';
const HEALTH_URL = `http://127.0.0.1:${PORT}/status`;
const READY_TIMEOUT_MS = 45_000;
const KILL_ESCALATION_MS = 5_000;
const SKIP_START = process.env.TALKATIVE_RELAY_SKIP_START === '1';

let wrangler: ChildProcess | null = null;
let wranglerExited = false;

function log(msg: string) {
  console.error(`[test-integration] ${msg}`);
}

function pipePrefixed(stream: NodeJS.ReadableStream, tag: string) {
  let buf = '';
  stream.on('data', (chunk: Buffer) => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) process.stderr.write(`[${tag}] ${line}\n`);
    }
  });
  stream.on('end', () => {
    if (buf.trim()) process.stderr.write(`[${tag}] ${buf}\n`);
  });
}

function startWrangler(): ChildProcess {
  log(`starting wrangler dev --env test on port ${PORT}`);
  const proc = spawn(
    'npx',
    ['wrangler', 'dev', '--env', 'test', '--port', PORT, '--local'],
    { cwd: RELAY_DIR, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (proc.stdout) pipePrefixed(proc.stdout, 'wrangler');
  if (proc.stderr) pipePrefixed(proc.stderr, 'wrangler');
  proc.once('exit', (code, sig) => {
    wranglerExited = true;
    log(`wrangler exited (code=${code ?? 'null'} sig=${sig ?? 'null'})`);
  });
  return proc;
}

async function waitForRelay(deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    if (wranglerExited) {
      throw new Error('wrangler exited before becoming ready');
    }
    try {
      const resp = await fetch(HEALTH_URL);
      if (resp.ok) return;
    } catch {
      // Still starting up.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`relay did not become ready within ${READY_TIMEOUT_MS}ms`);
}

function killWrangler(): Promise<void> {
  return new Promise((r) => {
    if (!wrangler || wranglerExited) return r();
    const done = () => r();
    wrangler.once('exit', done);
    try {
      wrangler.kill('SIGTERM');
    } catch {
      return r();
    }
    setTimeout(() => {
      if (wrangler && !wranglerExited) {
        try {
          wrangler.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
    }, KILL_ESCALATION_MS);
  });
}

function runVitest(): Promise<number> {
  log('relay ready — running vitest');
  const forwarded = process.argv.slice(2);
  const vitest = spawn(
    'npx',
    ['vitest', 'run', '--config', 'vitest.integration.config.ts', ...forwarded],
    { stdio: 'inherit' },
  );
  return new Promise((r) => {
    vitest.on('exit', (code) => r(code ?? 1));
  });
}

async function main(): Promise<number> {
  if (!SKIP_START) {
    wrangler = startWrangler();
  } else {
    log('TALKATIVE_RELAY_SKIP_START=1 — assuming wrangler is already running');
  }

  try {
    await waitForRelay(Date.now() + READY_TIMEOUT_MS);
  } catch (err) {
    log(`readiness check failed: ${(err as Error).message}`);
    return 2;
  }

  return runVitest();
}

let cleanupInFlight: Promise<void> | null = null;
function cleanup(): Promise<void> {
  if (!cleanupInFlight) cleanupInFlight = killWrangler();
  return cleanupInFlight;
}

process.on('SIGINT', () => {
  cleanup().finally(() => process.exit(130));
});
process.on('SIGTERM', () => {
  cleanup().finally(() => process.exit(143));
});

main()
  .then(async (code) => {
    await cleanup();
    process.exit(code);
  })
  .catch(async (err) => {
    log(`unexpected error: ${(err as Error).stack ?? err}`);
    await cleanup();
    process.exit(1);
  });
