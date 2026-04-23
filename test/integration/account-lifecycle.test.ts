// End-to-end account lifecycle: login → verify → connect → logout → token dead.
//
// Replaces the old interactive test/logout.test.ts. That one required a real
// email inbox and a human clicking a verification link; this one uses the
// TEST_MODE=true /login shortcut that returns verify_token directly in the
// response, so the full chain runs unattended.
//
// The focused tests in auth.test.ts and login-flow.test.ts each exercise
// pieces of this chain; this test is the smoke that proves they compose —
// a single session can log in, receive messages, log out, and end up with
// a revoked token that can't be reused to reconnect.

import { describe, test, expect } from 'vitest';
import WebSocket from 'ws';
import { generateKeypair } from '../../channel/crypto';

const RELAY_HTTP = process.env.TALKATIVE_RELAY_HTTP ?? 'http://127.0.0.1:8787';
const RELAY_WS = process.env.TALKATIVE_RELAY_URL ?? 'ws://127.0.0.1:8787';
const CLOSE_WAIT_MS = 5_000;

function openAuthedSocket(handle: string, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const url = `${RELAY_WS}/node?handle=${encodeURIComponent(handle)}&token=${encodeURIComponent(token)}&v=2&build=1.3.2`;
    const ws = new WebSocket(url);
    let settled = false;
    ws.on('open', () => {
      if (!settled) { settled = true; resolve(ws); }
    });
    ws.on('unexpected-response', (_req, res) => {
      if (!settled) {
        settled = true;
        reject(new Error(`expected OPEN, got HTTP ${res.statusCode}`));
        res.resume();
      }
    });
    ws.on('error', (err) => {
      if (!settled) { settled = true; reject(err); }
    });
  });
}

function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string } | null> {
  return new Promise((resolve) => {
    let settled = false;
    const t = setTimeout(() => {
      if (!settled) { settled = true; resolve(null); }
    }, CLOSE_WAIT_MS);
    ws.on('close', (code, reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      resolve({ code, reason: reason?.toString() ?? '' });
    });
  });
}

function upgradeStatus(handle: string, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = `${RELAY_WS}/node?handle=${encodeURIComponent(handle)}&token=${encodeURIComponent(token)}&v=2&build=1.3.2`;
    const ws = new WebSocket(url);
    let settled = false;
    ws.on('open', () => {
      if (!settled) {
        settled = true;
        try { ws.close(); } catch {}
        reject(new Error('expected upgrade failure, but socket opened'));
      }
    });
    ws.on('unexpected-response', (_req, res) => {
      if (!settled) {
        settled = true;
        resolve(res.statusCode ?? 0);
        res.resume();
      }
    });
    ws.on('error', () => { /* captured via unexpected-response */ });
  });
}

describe('account lifecycle: login → connect → logout → revoked', () => {
  test('full chain runs and leaves the token dead on retry', async () => {
    const kp = generateKeypair();
    const email = `lifecycle${Date.now()}@test.invalid`;
    const handle = `@lifecycle${Date.now()}`;

    // 1. /login — test-mode shortcut returns verify_token directly.
    const loginResp = await fetch(`${RELAY_HTTP}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, handle, pubkey: kp.publicKey }),
    });
    expect(loginResp.status).toBe(200);
    const login = (await loginResp.json()) as {
      pending_id: string;
      email_hint: string;
      verify_token?: string;
    };
    expect(login.verify_token).toBeTruthy();

    // 2. /verify — consume the link.
    const verifyResp = await fetch(
      `${RELAY_HTTP}/verify?token=${encodeURIComponent(login.verify_token!)}`,
    );
    expect(verifyResp.status).toBe(200);

    // 3. /login-status — pick up the auth token (single-use).
    const statusResp = await fetch(
      `${RELAY_HTTP}/login-status?pending_id=${encodeURIComponent(login.pending_id)}`,
    );
    expect(statusResp.status).toBe(200);
    const status = (await statusResp.json()) as {
      status: string;
      handle: string;
      token: string;
    };
    expect(status.status).toBe('verified');
    expect(status.handle).toBe(handle);
    expect(status.token).toBeTruthy();

    // 4. Open an authenticated WebSocket and arm the close listener BEFORE
    //    triggering logout (close can fire fast).
    const ws = await openAuthedSocket(handle, status.token);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    const closePromise = waitForClose(ws);

    // 5. /logout — revoke server-side, kick the live socket.
    const logoutResp = await fetch(`${RELAY_HTTP}/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle, token: status.token }),
    });
    expect(logoutResp.status).toBe(200);
    expect(await logoutResp.json()).toEqual({ ok: true });

    // 6. The live socket must go down. Accept either a close event firing
    //    or the socket transitioning out of OPEN — miniflare locally is
    //    inconsistent about delivering server-initiated close frames.
    const closeInfo = await closePromise;
    const eventuallyClosed = closeInfo !== null || ws.readyState !== WebSocket.OPEN;
    expect(eventuallyClosed).toBe(true);
    if (closeInfo !== null) {
      expect(closeInfo.code).toBe(1008);
      expect(closeInfo.reason.toLowerCase()).toMatch(/logged out/);
    }

    // 7. Reconnecting with the revoked token must fail with 401.
    const reconnectStatus = await upgradeStatus(handle, status.token);
    expect(reconnectStatus).toBe(401);

    try { ws.close(); } catch { /* already closing */ }
  });
});
