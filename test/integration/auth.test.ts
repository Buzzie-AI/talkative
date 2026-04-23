// Auth-layer integration tests — WebSocket upgrade gate and /logout flow.
//
// These tests don't spawn the MCP server; they speak the relay's HTTP + WS
// protocol directly, which makes them fast (~1s/test) and focused on the
// relay's auth surface.
//
// Requires the relay to be running in test mode (npm run test:integration
// starts it automatically).

import { describe, test, expect, beforeAll } from 'vitest';
import WebSocket from 'ws';
import { generateKeypair } from '../../channel/crypto';

const RELAY_HTTP = process.env.TALKATIVE_RELAY_HTTP ?? 'http://127.0.0.1:8787';
const RELAY_WS = process.env.TALKATIVE_RELAY_URL ?? 'ws://127.0.0.1:8787';
const CLOSE_WAIT_MS = 5_000;

async function mintToken(handle: string, pubkey: string): Promise<string> {
  const resp = await fetch(`${RELAY_HTTP}/test/issue-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ handle, pubkey }),
  });
  if (!resp.ok) throw new Error(`issue-token failed: ${resp.status} ${await resp.text()}`);
  const data = (await resp.json()) as { token: string };
  return data.token;
}

/**
 * Attempt a WS upgrade. Resolves either with an open socket (on 101) or
 * an HTTP status code + body (on any non-101 response).
 */
function attemptUpgrade(
  handle: string | null,
  token: string | null,
  version: string | null = '2',
): Promise<{ ws: WebSocket } | { status: number; body: string }> {
  const params = new URLSearchParams();
  if (handle) params.set('handle', handle);
  if (token) params.set('token', token);
  if (version !== null) params.set('v', version);
  const url = `${RELAY_WS}/node?${params.toString()}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;
    ws.on('open', () => {
      if (!settled) {
        settled = true;
        resolve({ ws });
      }
    });
    ws.on('unexpected-response', (_req, res) => {
      if (settled) return;
      const status = res.statusCode ?? 0;
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({ status, body: body.trim() });
      });
    });
    ws.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string } | null> {
  return new Promise((resolve) => {
    let settled = false;
    const t = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, CLOSE_WAIT_MS);
    ws.on('close', (code, reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      resolve({ code, reason: reason?.toString() ?? '' });
    });
  });
}

describe('WS upgrade auth gate', () => {
  let handle: string;
  let token: string;
  let pubkey: string;

  beforeAll(async () => {
    const kp = generateKeypair();
    pubkey = kp.publicKey;
    handle = `@authtest${Date.now()}`;
    token = await mintToken(handle, pubkey);
  });

  test('valid handle + valid token upgrades to 101', async () => {
    const result = await attemptUpgrade(handle, token);
    if ('status' in result) throw new Error(`expected open socket, got ${result.status}`);
    expect(result.ws.readyState).toBe(WebSocket.OPEN);
    result.ws.close();
  });

  test('wrong token for a known handle returns 401 pointing at talk_set_handle', async () => {
    const wrongToken = '0'.repeat(64);
    const result = await attemptUpgrade(handle, wrongToken);
    if ('ws' in result) throw new Error('expected rejection');
    expect(result.status).toBe(401);
    expect(result.body.toLowerCase()).toMatch(/talk_set_handle/);
    expect(result.body.toLowerCase()).toMatch(/revoked|rotated|no longer valid/);
  });

  test('unknown handle returns 401 naming the handle and the fix', async () => {
    const ghost = `@nobody${Date.now()}`;
    const result = await attemptUpgrade(ghost, token);
    if ('ws' in result) throw new Error('expected rejection');
    expect(result.status).toBe(401);
    expect(result.body).toContain(ghost);
    expect(result.body.toLowerCase()).toMatch(/talk_set_handle/);
  });

  test('missing handle returns 401 with actionable text', async () => {
    const result = await attemptUpgrade(null, token);
    if ('ws' in result) throw new Error('expected rejection');
    expect(result.status).toBe(401);
    expect(result.body.toLowerCase()).toMatch(/talk_set_handle|handle/);
  });

  test('missing token returns 401 with actionable text', async () => {
    const result = await attemptUpgrade(handle, null);
    if ('ws' in result) throw new Error('expected rejection');
    expect(result.status).toBe(401);
    expect(result.body.toLowerCase()).toMatch(/talk_set_handle|token/);
  });

  test('wrong protocol version returns 426 that names BOTH versions and both upgrade directions', async () => {
    const result = await attemptUpgrade(handle, token, '1');
    if ('ws' in result) throw new Error('expected rejection');
    expect(result.status).toBe(426);
    // Must mention both the sent version and the expected version.
    expect(result.body).toContain('v=1');
    expect(result.body).toContain('v=2');
    // Must cover both directions: relay-behind AND plugin-behind.
    expect(result.body.toLowerCase()).toMatch(/relay is behind|upgrade the relay|ask.*upgrade/);
    expect(result.body.toLowerCase()).toMatch(/update your.*plugin|update your talkative/);
  });

  test('missing protocol version returns 426 reporting v=none', async () => {
    const result = await attemptUpgrade(handle, token, null);
    if ('ws' in result) throw new Error('expected rejection');
    expect(result.status).toBe(426);
    expect(result.body).toContain('v=none');
    expect(result.body).toContain('v=2');
  });
});

describe('/logout revokes tokens and kicks live sockets', () => {
  test('live socket is closed with 1008 and the token is dead on retry', async () => {
    const kp = generateKeypair();
    const handle = `@logout${Date.now()}`;
    const token = await mintToken(handle, kp.publicKey);

    // Open a real socket with the token.
    const first = await attemptUpgrade(handle, token);
    if ('status' in first) throw new Error(`expected open, got ${first.status}`);

    // Attach the close listener BEFORE triggering logout — otherwise the
    // close event can fire between the POST resolving and us calling
    // waitForClose, and we'd miss it.
    const closePromise = waitForClose(first.ws);

    // Revoke.
    const logoutResp = await fetch(`${RELAY_HTTP}/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle, token }),
    });
    expect(logoutResp.status).toBe(200);
    expect(await logoutResp.json()).toEqual({ ok: true });

    // The live socket must go down. In prod the relay sends a 1008 close
    // with reason "logged out"; miniflare locally sometimes doesn't deliver
    // the close frame in time, so accept either: close event fired, OR the
    // socket transitioned out of OPEN within the timeout. Both mean the
    // connection is dead from the client's perspective.
    const closeInfo = await closePromise;
    const eventuallyClosed =
      closeInfo !== null || first.ws.readyState !== WebSocket.OPEN;
    expect(eventuallyClosed).toBe(true);
    if (closeInfo !== null) {
      expect(closeInfo.code).toBe(1008);
      expect(closeInfo.reason).toMatch(/logged out/i);
    }

    // A fresh WS upgrade with the same token must now be rejected — this is
    // the real security invariant and works regardless of miniflare quirks.
    const second = await attemptUpgrade(handle, token);
    expect(second).toHaveProperty('status', 401);

    try {
      first.ws.close();
    } catch {
      /* already closing */
    }
  });

  test('logout for unknown handle is idempotent', async () => {
    const resp = await fetch(`${RELAY_HTTP}/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: `@neverexisted${Date.now()}`, token: 'whatever' }),
    });
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true, already: true });
  });

  test('logout with missing fields returns 400', async () => {
    const resp = await fetch(`${RELAY_HTTP}/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(resp.status).toBe(400);
  });

  test('logout with a known handle but wrong token returns 401', async () => {
    const kp = generateKeypair();
    const handle = `@wrongtoken${Date.now()}`;
    await mintToken(handle, kp.publicKey);

    const resp = await fetch(`${RELAY_HTTP}/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle, token: '0'.repeat(64) }),
    });
    expect(resp.status).toBe(401);
  });
});

describe('version advertisement on every response', () => {
  const SEMVER = /^\d+\.\d+\.\d+$/;

  test('GET /status includes relay version headers', async () => {
    const resp = await fetch(`${RELAY_HTTP}/status`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get('x-talkative-relay-proto')).toBe('2');
    const build = resp.headers.get('x-talkative-relay-build');
    expect(build).not.toBeNull();
    expect(build).toMatch(SEMVER);
  });

  test('error responses also carry the version headers', async () => {
    const resp = await fetch(`${RELAY_HTTP}/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(resp.status).toBe(400);
    expect(resp.headers.get('x-talkative-relay-proto')).toBe('2');
    expect(resp.headers.get('x-talkative-relay-build')).toMatch(SEMVER);
  });

  test('test-mode endpoint also carries version headers', async () => {
    const kp = generateKeypair();
    const resp = await fetch(`${RELAY_HTTP}/test/issue-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: `@vertest${Date.now()}`, pubkey: kp.publicKey }),
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get('x-talkative-relay-proto')).toBe('2');
    expect(resp.headers.get('x-talkative-relay-build')).toMatch(SEMVER);
  });

  test('successful WS connect: registered message includes relay_proto and relay_build', async () => {
    const kp = generateKeypair();
    const handle = `@regmsg${Date.now()}`;
    const token = await mintToken(handle, kp.publicKey);
    const url = `${RELAY_WS}/node?handle=${encodeURIComponent(handle)}&token=${encodeURIComponent(token)}&v=2&build=1.3.0`;
    const ws = new WebSocket(url);

    const registered = await new Promise<{ type: string; relay_proto?: string; relay_build?: string }>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no registered message within 5s')), 5000);
      ws.on('message', (data) => {
        clearTimeout(t);
        resolve(JSON.parse(data.toString()));
      });
      ws.on('error', reject);
    });

    expect(registered.type).toBe('registered');
    expect(registered.relay_proto).toBe('2');
    expect(registered.relay_build).toMatch(SEMVER);
    ws.close();
  });
});

describe('single-session-per-handle: new login kicks the old one', () => {
  async function openRegistered(handle: string, token: string): Promise<{
    ws: WebSocket;
    messages: Array<{ type: string; [k: string]: unknown }>;
    closed: Promise<{ code: number; reason: string } | null>;
  }> {
    const url = `${RELAY_WS}/node?handle=${encodeURIComponent(handle)}&token=${encodeURIComponent(token)}&v=2&build=1.3.2`;
    const ws = new WebSocket(url);
    const messages: Array<{ type: string; [k: string]: unknown }> = [];

    // Attach close listener immediately so we don't miss it.
    const closed = new Promise<{ code: number; reason: string } | null>((resolve) => {
      const t = setTimeout(() => resolve(null), 5_000);
      ws.on('close', (code, reason) => {
        clearTimeout(t);
        resolve({ code, reason: reason?.toString() ?? '' });
      });
    });

    ws.on('message', (data) => {
      try {
        messages.push(JSON.parse(data.toString()));
      } catch {
        /* skip malformed */
      }
    });

    // Wait for the registered message so we know the session is live.
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no registered message in 5s')), 5000);
      const check = () => {
        if (messages.some((m) => m.type === 'registered')) {
          clearTimeout(t);
          resolve();
          return;
        }
        setTimeout(check, 50);
      };
      check();
    });

    return { ws, messages, closed };
  }

  test('second connect kicks the first: evicted message AND close with code 4001', async () => {
    const kp = generateKeypair();
    const handle = `@kick${Date.now()}`;
    const token = await mintToken(handle, kp.publicKey);

    const first = await openRegistered(handle, token);
    const second = await openRegistered(handle, token);

    // Wait for first to be closed (up to 5s per openRegistered's listener).
    const closeInfo = await first.closed;

    // At least one of the two signals must have arrived: in-band evicted
    // message, or a close event with code 4001. In miniflare local dev the
    // close frame sometimes doesn't propagate in time; the evicted message
    // is the reliable signal.
    const evictedMsg = first.messages.find((m) => m.type === 'evicted');
    const kickedByClose = closeInfo !== null && closeInfo.code === 4001;
    expect(Boolean(evictedMsg) || kickedByClose).toBe(true);

    if (evictedMsg) {
      expect(typeof evictedMsg.text).toBe('string');
      expect((evictedMsg.text as string).toLowerCase()).toMatch(/another|signed out|took over/);
      expect(evictedMsg.reason).toBe('replaced');
    }
    if (kickedByClose) {
      expect(closeInfo!.code).toBe(4001);
      expect(closeInfo!.reason.toLowerCase()).toMatch(/replaced|another/);
    }

    // The second session should still be alive and well.
    expect(second.ws.readyState).toBe(WebSocket.OPEN);

    try { second.ws.close(); } catch {}
  });

  test('after kick, routing points at the new session (not the old one)', async () => {
    // Connect two peers, A1 and Bob. Then replace A1 with A2. Send from
    // Bob to @A — the new session A2 should receive it; A1 should not.
    const kpA = generateKeypair();
    const kpB = generateKeypair();
    const handleA = `@kickroute${Date.now()}`;
    const handleB = `@kickpeer${Date.now()}`;
    const tokenA = await mintToken(handleA, kpA.publicKey);
    const tokenB = await mintToken(handleB, kpB.publicKey);

    const a1 = await openRegistered(handleA, tokenA);
    const bob = await openRegistered(handleB, tokenB);
    const a2 = await openRegistered(handleA, tokenA);

    // Bob asks for the peer list to learn A's pubkey.
    bob.ws.send(JSON.stringify({ type: 'peers' }));
    const peerList = await new Promise<Array<{ handle: string; pubkey: string }>>((resolve) => {
      const t = setTimeout(() => resolve([]), 3000);
      const iv = setInterval(() => {
        const msg = bob.messages.find((m) => m.type === 'peers') as
          | { peers?: Array<{ handle: string; pubkey: string }> }
          | undefined;
        if (msg) {
          clearInterval(iv);
          clearTimeout(t);
          resolve(msg.peers ?? []);
        }
      }, 50);
    });

    const aPeer = peerList.find((p) => p.handle === handleA);
    expect(aPeer).toBeDefined();

    // Send an (opaque) message from bob to A. We're testing routing, not
    // crypto correctness, so we can put garbage in the ciphertext field.
    bob.ws.send(JSON.stringify({
      type: 'message',
      to: handleA,
      msg_id: 'rt-1',
      nonce: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      ciphertext: 'dGVzdA==',
    }));

    // Wait up to 3s for a2 to receive the 'message' and a1 to NOT.
    await new Promise((r) => setTimeout(r, 1500));

    const deliveredToA2 = a2.messages.find((m) => m.type === 'message');
    const deliveredToA1 = a1.messages.find((m) => m.type === 'message');
    expect(deliveredToA2).toBeDefined();
    expect(deliveredToA1).toBeUndefined();

    try { bob.ws.close(); } catch {}
    try { a2.ws.close(); } catch {}
    try { a1.ws.close(); } catch {}
  });
});
