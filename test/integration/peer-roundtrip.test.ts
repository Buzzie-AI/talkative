// Two-session encrypted roundtrip integration test.
//
// Prerequisites:
//   1. Run the relay locally with TEST_MODE enabled:
//        cd ../talkative-relay
//        npx wrangler dev --env test --port 8787
//   2. Then from talkative/:
//        npm run test:integration
//
// What this proves: two MCP server subprocesses (mocking two Claude Code
// sessions) can authenticate against the relay, connect via WebSocket,
// exchange an E2E-encrypted message, and deliver the plaintext to the
// receiving MCP client via notifications/claude/channel.

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateKeypair } from '../../channel/crypto';

const RELAY_HTTP = process.env.TALKATIVE_RELAY_HTTP ?? 'http://127.0.0.1:8787';
const RELAY_WS = process.env.TALKATIVE_RELAY_URL ?? 'ws://127.0.0.1:8787';
const TALKATIVE_ROOT = resolve(__dirname, '..', '..');

interface AuthFile {
  handle: string;
  token: string;
  publicKey: string;
  secretKey: string;
}

async function mintToken(handle: string, pubkey: string): Promise<string> {
  const resp = await fetch(`${RELAY_HTTP}/test/issue-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ handle, pubkey }),
  });
  if (!resp.ok) {
    throw new Error(`issue-token failed: ${resp.status} ${await resp.text()}`);
  }
  const data = (await resp.json()) as { handle: string; token: string };
  return data.token;
}

function writeAuthFixture(dir: string, name: string, data: AuthFile): string {
  const path = join(dir, `${name}.json`);
  writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
  return path;
}

interface Peer {
  client: Client;
  received: Array<{ method: string; params: unknown }>;
  ready: Promise<void>;
}

async function spawnPeer(authPath: string): Promise<Peer> {
  const received: Array<{ method: string; params: unknown }> = [];
  let resolveReady!: () => void;
  const ready = new Promise<void>((r) => {
    resolveReady = r;
  });

  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', 'channel/node.ts'],
    cwd: TALKATIVE_ROOT,
    env: {
      ...process.env,
      TALKATIVE_AUTH_PATH: authPath,
      TALKATIVE_RELAY_URL: RELAY_WS,
    } as Record<string, string>,
    stderr: 'inherit',
  });

  const client = new Client(
    { name: 'integration-test', version: '0.0.1' },
    { capabilities: { experimental: { 'claude/channel': {} } } },
  );

  client.fallbackNotificationHandler = async (notif) => {
    received.push({ method: notif.method, params: notif.params as unknown });
    const text = JSON.stringify(notif.params);
    if (notif.method === 'notifications/claude/channel' && /connected as|Welcome/i.test(text)) {
      resolveReady();
    }
  };

  await client.connect(transport);
  return { client, received, ready };
}

async function relayIsUp(): Promise<boolean> {
  try {
    const resp = await fetch(`${RELAY_HTTP}/status`);
    return resp.ok;
  } catch {
    return false;
  }
}

describe('two-session encrypted roundtrip', () => {
  let tmpDir: string;
  let alice: Peer;
  let bob: Peer;
  let aliceHandle: string;
  let bobHandle: string;

  beforeAll(async () => {
    if (!(await relayIsUp())) {
      throw new Error(
        `Relay not reachable at ${RELAY_HTTP}. Start it with:\n  cd talkative-relay && npx wrangler dev --env test --port 8787`,
      );
    }

    tmpDir = mkdtempSync(join(tmpdir(), 'talkative-integration-'));

    const aliceKP = generateKeypair();
    const bobKP = generateKeypair();
    const suffix = Date.now();
    aliceHandle = `@testa${suffix}`;
    bobHandle = `@testb${suffix}`;

    const aliceToken = await mintToken(aliceHandle, aliceKP.publicKey);
    const bobToken = await mintToken(bobHandle, bobKP.publicKey);

    const alicePath = writeAuthFixture(tmpDir, 'alice', {
      handle: aliceHandle,
      token: aliceToken,
      publicKey: aliceKP.publicKey,
      secretKey: aliceKP.secretKey,
    });
    const bobPath = writeAuthFixture(tmpDir, 'bob', {
      handle: bobHandle,
      token: bobToken,
      publicKey: bobKP.publicKey,
      secretKey: bobKP.secretKey,
    });

    alice = await spawnPeer(alicePath);
    bob = await spawnPeer(bobPath);

    await Promise.all([
      Promise.race([
        alice.ready,
        new Promise<void>((_, rej) =>
          setTimeout(() => rej(new Error('alice did not signal ready')), 20_000),
        ),
      ]),
      Promise.race([
        bob.ready,
        new Promise<void>((_, rej) =>
          setTimeout(() => rej(new Error('bob did not signal ready')), 20_000),
        ),
      ]),
    ]);
  }, 30_000);

  afterAll(async () => {
    await Promise.allSettled([alice?.client.close(), bob?.client.close()]);
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('alice sends an E2E-encrypted message and bob receives plaintext', async () => {
    const plaintext = `roundtrip-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const startIdx = bob.received.length;

    await alice.client.callTool({
      name: 'talk_send',
      arguments: { to: bobHandle, message: plaintext },
    });

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const hit = bob.received
        .slice(startIdx)
        .find((n) => JSON.stringify(n.params).includes(plaintext));
      if (hit) {
        expect(hit.method).toBe('notifications/claude/channel');
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(
      `Bob never received the plaintext. Notifications so far: ${JSON.stringify(
        bob.received.slice(startIdx),
        null,
        2,
      )}`,
    );
  });

  test('bob sends back, alice receives plaintext (reverse direction)', async () => {
    const plaintext = `reply-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const startIdx = alice.received.length;

    await bob.client.callTool({
      name: 'talk_send',
      arguments: { to: aliceHandle, message: plaintext },
    });

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const hit = alice.received
        .slice(startIdx)
        .find((n) => JSON.stringify(n.params).includes(plaintext));
      if (hit) {
        expect(hit.method).toBe('notifications/claude/channel');
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(
      `Alice never received the reply. Notifications so far: ${JSON.stringify(
        alice.received.slice(startIdx),
        null,
        2,
      )}`,
    );
  });

  test('talk_send to an unknown/offline peer surfaces a clear error (no silent drop)', async () => {
    const ghostHandle = `@ghost${Date.now()}`;
    const plaintext = `should-never-arrive-${Math.random().toString(36).slice(2)}`;
    const aliceStart = alice.received.length;
    const bobStart = bob.received.length;

    const result = await alice.client.callTool({
      name: 'talk_send',
      arguments: { to: ghostHandle, message: plaintext },
    });

    const body = JSON.stringify(result.content);
    expect(body).toMatch(/not online|cannot deliver|offline/i);
    expect(body).toContain(ghostHandle);

    // Give the relay a beat to route anything it shouldn't have, then verify
    // no stray notification landed on bob (who is connected but was never
    // the intended recipient) and the ciphertext never appeared anywhere.
    await new Promise((r) => setTimeout(r, 300));
    const strayOnBob = bob.received
      .slice(bobStart)
      .find((n) => JSON.stringify(n.params).includes(plaintext));
    expect(strayOnBob).toBeUndefined();
    const echoOnAlice = alice.received
      .slice(aliceStart)
      .find((n) => JSON.stringify(n.params).includes(plaintext));
    expect(echoOnAlice).toBeUndefined();
  });
});
