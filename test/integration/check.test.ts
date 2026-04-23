// /check diagnostic roundtrip tests.
//
// Verifies the explicit probe message flow: client sends {type:'check', nonce},
// relay replies {type:'check_response', sentinel:'123', ...} with session and
// relay diagnostics. This is the thing users reach for when something feels
// broken and they need a yes/no answer about the plumbing.

import { describe, test, expect } from 'vitest';
import WebSocket from 'ws';
import { generateKeypair } from '../../channel/crypto';

const RELAY_HTTP = process.env.TALKATIVE_RELAY_HTTP ?? 'http://127.0.0.1:8787';
const RELAY_WS = process.env.TALKATIVE_RELAY_URL ?? 'ws://127.0.0.1:8787';

async function mintToken(handle: string, pubkey: string): Promise<string> {
  const resp = await fetch(`${RELAY_HTTP}/test/issue-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ handle, pubkey }),
  });
  if (!resp.ok) throw new Error(`issue-token failed: ${resp.status}`);
  return ((await resp.json()) as { token: string }).token;
}

interface CheckResponse {
  type: string;
  sentinel?: string;
  nonce?: string | null;
  node_id?: string | null;
  handle?: string | null;
  sockets_for_handle?: number;
  total_sockets_online?: number;
  relay_proto?: string;
  relay_build?: string;
  server_time_ms?: number;
}

async function openAndWaitRegistered(handle: string, token: string): Promise<WebSocket> {
  const url = `${RELAY_WS}/node?handle=${encodeURIComponent(handle)}&token=${encodeURIComponent(token)}&v=2&build=1.3.3`;
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no registered message in 5s')), 5000);
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'registered') {
        clearTimeout(t);
        resolve();
      }
    });
    ws.on('error', reject);
  });
  return ws;
}

async function sendCheck(ws: WebSocket, nonce: string): Promise<CheckResponse> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no check_response in 5s')), 5000);
    const listener = (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'check_response' && msg.nonce === nonce) {
        clearTimeout(t);
        ws.off('message', listener);
        resolve(msg);
      }
    };
    ws.on('message', listener);
    ws.send(JSON.stringify({ type: 'check', nonce }));
  });
}

describe('/check diagnostic roundtrip', () => {
  const SEMVER = /^\d+\.\d+\.\d+$/;

  test('check_response returns sentinel 123, echoes nonce, reports accurate session state', async () => {
    const kp = generateKeypair();
    const handle = `@check${Date.now()}`;
    const token = await mintToken(handle, kp.publicKey);
    const ws = await openAndWaitRegistered(handle, token);

    const nonce = `test-nonce-${Date.now()}`;
    const resp = await sendCheck(ws, nonce);

    expect(resp.type).toBe('check_response');
    expect(resp.sentinel).toBe('123');
    expect(resp.nonce).toBe(nonce);
    expect(resp.handle).toBe(handle);
    expect(resp.node_id).toBeTruthy();
    expect(resp.sockets_for_handle).toBe(1);
    expect(resp.total_sockets_online).toBeGreaterThanOrEqual(1);
    expect(resp.relay_proto).toBe('2');
    expect(resp.relay_build).toMatch(SEMVER);
    expect(typeof resp.server_time_ms).toBe('number');
    // Clock shouldn't be absurd.
    const now = Date.now();
    expect(resp.server_time_ms!).toBeGreaterThan(now - 60_000);
    expect(resp.server_time_ms!).toBeLessThan(now + 60_000);

    ws.close();
  });

  test('nonce matching: response with a different nonce is not mistaken for ours', async () => {
    const kp = generateKeypair();
    const handle = `@chknonce${Date.now()}`;
    const token = await mintToken(handle, kp.publicKey);
    const ws = await openAndWaitRegistered(handle, token);

    // Send two checks with different nonces, back-to-back. Both should
    // resolve to their own nonces — no mixup.
    const nonceA = 'nonce-a';
    const nonceB = 'nonce-b';

    const collected: CheckResponse[] = [];
    const done = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('did not receive both responses in 5s')), 5000);
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'check_response') {
          collected.push(msg);
          if (collected.length >= 2) {
            clearTimeout(t);
            resolve();
          }
        }
      });
    });

    ws.send(JSON.stringify({ type: 'check', nonce: nonceA }));
    ws.send(JSON.stringify({ type: 'check', nonce: nonceB }));
    await done;

    const nonces = collected.map((r) => r.nonce).sort();
    expect(nonces).toEqual([nonceA, nonceB].sort());
    for (const r of collected) {
      expect(r.sentinel).toBe('123');
    }

    ws.close();
  });

  test('after kick-old, sockets_for_handle is still 1 on the surviving session', async () => {
    // This is the key invariant of the kick-old change — after B replaces A,
    // the relay should report exactly 1 socket for the handle, not 2.
    const kp = generateKeypair();
    const handle = `@chkkick${Date.now()}`;
    const token = await mintToken(handle, kp.publicKey);

    const a = await openAndWaitRegistered(handle, token);
    const b = await openAndWaitRegistered(handle, token);

    // Give the kick a moment to settle on the server's state.
    await new Promise((r) => setTimeout(r, 200));

    const resp = await sendCheck(b, 'post-kick');
    expect(resp.sockets_for_handle).toBe(1);
    expect(resp.handle).toBe(handle);

    try { a.close(); } catch {}
    try { b.close(); } catch {}
  });
});
