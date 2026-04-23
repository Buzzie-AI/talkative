// Integration tests for the /login → /verify → /login-status chain.
//
// These are only possible in test mode because /login normally sends an
// email and waits for a human to click a link. When TEST_MODE=true, the
// relay returns the verify_token directly in the /login response so the
// test can call /verify itself — exercising the full handler chain
// without an inbox.
//
// See test-integration orchestrator for how wrangler dev --env test is
// started.

import { describe, test, expect } from 'vitest';
import WebSocket from 'ws';
import { generateKeypair } from '../../channel/crypto';

const RELAY_HTTP = process.env.TALKATIVE_RELAY_HTTP ?? 'http://127.0.0.1:8787';
const RELAY_WS = process.env.TALKATIVE_RELAY_URL ?? 'ws://127.0.0.1:8787';

interface LoginResponse {
  pending_id: string;
  email_hint: string;
  verify_token?: string;
  error?: string;
}

interface LoginStatusResponse {
  status?: 'pending' | 'verified';
  handle?: string;
  token?: string;
  error?: string;
}

async function postLogin(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${RELAY_HTTP}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function startLogin(
  email: string,
  handle: string,
  pubkey: string,
): Promise<LoginResponse> {
  const resp = await postLogin({ email, handle, pubkey });
  const data = (await resp.json()) as LoginResponse;
  if (!resp.ok) {
    throw new Error(`/login failed: ${resp.status} ${JSON.stringify(data)}`);
  }
  return data;
}

async function clickVerify(verifyToken: string): Promise<Response> {
  return fetch(`${RELAY_HTTP}/verify?token=${encodeURIComponent(verifyToken)}`);
}

async function pollStatus(pendingId: string): Promise<{ status: number; body: LoginStatusResponse }> {
  const resp = await fetch(
    `${RELAY_HTTP}/login-status?pending_id=${encodeURIComponent(pendingId)}`,
  );
  const body = (await resp.json().catch(() => ({}))) as LoginStatusResponse;
  return { status: resp.status, body };
}

describe('login → verify → login-status flow', () => {
  test('happy path: full chain yields a token that works at WS upgrade', async () => {
    const kp = generateKeypair();
    const email = `flow${Date.now()}@test.invalid`;
    const handle = `@flow${Date.now()}`;

    // 1. /login — in test mode, returns verify_token directly.
    const login = await startLogin(email, handle, kp.publicKey);
    expect(login.pending_id).toBeTruthy();
    expect(login.email_hint).toBeTruthy();
    expect(login.email_hint).not.toContain(email); // should be masked
    expect(login.verify_token).toBeTruthy();

    // 2. Before verification, /login-status should say pending.
    const pre = await pollStatus(login.pending_id);
    expect(pre.status).toBe(200);
    expect(pre.body.status).toBe('pending');

    // 3. "Click" the verify link.
    const verify = await clickVerify(login.verify_token!);
    expect(verify.status).toBe(200);

    // 4. /login-status now returns the auth token.
    const post = await pollStatus(login.pending_id);
    expect(post.status).toBe(200);
    expect(post.body.status).toBe('verified');
    expect(post.body.handle).toBe(handle);
    expect(post.body.token).toBeTruthy();
    expect(typeof post.body.token).toBe('string');

    // 5. That token must actually open a live WS connection.
    const url = `${RELAY_WS}/node?handle=${encodeURIComponent(handle)}&token=${encodeURIComponent(post.body.token!)}&v=2&build=1.3.2`;
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('ws did not open within 5s')), 5000);
      ws.on('open', () => { clearTimeout(t); resolve(); });
      ws.on('error', (err) => { clearTimeout(t); reject(err); });
      ws.on('unexpected-response', (_req, res) => {
        clearTimeout(t);
        reject(new Error(`ws upgrade rejected with ${res.statusCode}`));
      });
    });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  test('auth token is single-use: second /login-status call returns 404', async () => {
    const kp = generateKeypair();
    const email = `once${Date.now()}@test.invalid`;
    const handle = `@once${Date.now()}`;

    const login = await startLogin(email, handle, kp.publicKey);
    const verifyResp = await clickVerify(login.verify_token!);
    expect(verifyResp.status).toBe(200);

    const first = await pollStatus(login.pending_id);
    expect(first.status).toBe(200);
    expect(first.body.token).toBeTruthy();

    const second = await pollStatus(login.pending_id);
    expect(second.status).toBe(404);
    expect(second.body.token).toBeUndefined();
  });

  test('the same verify_token cannot be used twice', async () => {
    const kp = generateKeypair();
    const email = `replay${Date.now()}@test.invalid`;
    const handle = `@replay${Date.now()}`;

    const login = await startLogin(email, handle, kp.publicKey);

    const first = await clickVerify(login.verify_token!);
    expect(first.status).toBe(200);

    const second = await clickVerify(login.verify_token!);
    expect(second.status).toBe(400);
    const text = await second.text();
    expect(text.toLowerCase()).toMatch(/expired|already|invalid/);
  });

  test('/verify without a token returns 400', async () => {
    const resp = await fetch(`${RELAY_HTTP}/verify`);
    expect(resp.status).toBe(400);
  });

  test('/verify with a bogus token returns 400', async () => {
    const resp = await fetch(`${RELAY_HTTP}/verify?token=not-a-real-token`);
    expect(resp.status).toBe(400);
  });

  test('/login with missing fields returns 400', async () => {
    const resp = await postLogin({ email: 'only@example.com' });
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error.toLowerCase()).toMatch(/required/);
  });

  test('/login with malformed JSON returns 400', async () => {
    const resp = await fetch(`${RELAY_HTTP}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    expect(resp.status).toBe(400);
  });

  test('/login rejects re-registering a handle under a different email (409)', async () => {
    const kp = generateKeypair();
    const handle = `@taken${Date.now()}`;
    const email1 = `owner${Date.now()}@test.invalid`;
    const email2 = `squat${Date.now()}@test.invalid`;

    // First user claims the handle.
    const login1 = await startLogin(email1, handle, kp.publicKey);
    const verifyResp = await clickVerify(login1.verify_token!);
    expect(verifyResp.status).toBe(200);
    const status1 = await pollStatus(login1.pending_id);
    expect(status1.body.status).toBe('verified');

    // Second user attempts the same handle.
    const resp = await postLogin({ email: email2, handle, pubkey: kp.publicKey });
    expect(resp.status).toBe(409);
    const body = (await resp.json()) as { error: string };
    expect(body.error.toLowerCase()).toMatch(/already registered|different email/);
  });

  test('/login-status with unknown pending_id returns 404', async () => {
    const resp = await fetch(`${RELAY_HTTP}/login-status?pending_id=nonexistent-${Date.now()}`);
    expect(resp.status).toBe(404);
  });

  test('/login-status without pending_id returns 400', async () => {
    const resp = await fetch(`${RELAY_HTTP}/login-status`);
    expect(resp.status).toBe(400);
  });
});
