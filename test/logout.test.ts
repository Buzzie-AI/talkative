// End-to-end test for the HTTP login + /logout flow.
//
// Usage:
//   TEST_EMAIL=you+talklogout@example.com npx tsx test/logout.test.ts
//
// This is an interactive test — the relay sends a real verification email to
// TEST_EMAIL and the test polls /login-status until you click the link. Use a
// deliverable address that is NOT your normal Talkative login: the derived
// handle is computed from the local-part (e.g. "you+talklogout" →
// "@youtalklogout"), so a "+suffix" address keeps this completely separate
// from your real identity and leaves ~/.talkative/auth.json untouched.
//
// What it proves:
//   1. POST /login returns a pending_id and sends an email
//   2. GET /login-status flips to verified once the link is clicked and hands
//      over the auth token exactly once
//   3. That token opens a real WebSocket at /node
//   4. POST /logout with the token:
//      - returns {ok:true}
//      - server-initiates close(1008, "logged out") on the live socket
//      - causes subsequent /node upgrades with the same token to 401
//   5. /logout with missing fields returns 400
//   6. /logout for an unknown handle is idempotent ({ok:true, already:true})

import WebSocket from 'ws';

const RELAY = process.env.TALKATIVE_RELAY_URL ?? 'https://talkative-relay.silent-block-4b45.workers.dev';
const WS_BASE = RELAY.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');
const HTTP_BASE = RELAY.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://');

const EMAIL_POLL_TIMEOUT_MS = 5 * 60 * 1000;
const CLOSE_WAIT_MS = 5000;

function deriveHandle(email: string): string {
  return `@${email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '').toLowerCase()}`;
}

function openAuthedSocket(handle: string, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const url = `${WS_BASE}/node?handle=${encodeURIComponent(handle)}&token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);
    let settled = false;
    ws.on('open', () => { if (!settled) { settled = true; resolve(ws); } });
    ws.on('unexpected-response', (_req, res) => {
      if (settled) return;
      settled = true;
      reject(new Error(`expected OPEN, got HTTP ${res.statusCode}`));
      res.resume();
    });
    ws.on('error', (err) => { if (!settled) { settled = true; reject(err); } });
  });
}

function expectUpgradeStatus(handle: string, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = `${WS_BASE}/node?handle=${encodeURIComponent(handle)}&token=${encodeURIComponent(token)}`;
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
      if (settled) return;
      settled = true;
      resolve(res.statusCode ?? 0);
      res.resume();
    });
    ws.on('error', () => { /* captured via unexpected-response */ });
  });
}

async function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string } | null> {
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

async function pollForToken(pendingId: string, email: string): Promise<string> {
  const deadline = Date.now() + EMAIL_POLL_TIMEOUT_MS;
  console.log(`   Waiting for you to click the link in ${email} (up to 5 min)`);
  process.stdout.write('   ');
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const resp = await fetch(`${HTTP_BASE}/login-status?pending_id=${encodeURIComponent(pendingId)}`);
      if (resp.status === 404 || resp.status === 410) {
        process.stdout.write('\n');
        throw new Error(`/login-status returned ${resp.status} — session expired before click`);
      }
      if (!resp.ok) { process.stdout.write('?'); continue; }
      const data = await resp.json() as { status: string; handle?: string; token?: string };
      if (data.status === 'pending') { process.stdout.write('.'); continue; }
      if (data.status === 'verified' && data.token) {
        process.stdout.write(' verified\n');
        return data.token;
      }
      process.stdout.write('?');
    } catch (err) {
      process.stdout.write('!');
    }
  }
  process.stdout.write('\n');
  throw new Error('login verification timed out after 5 minutes');
}

async function run(): Promise<void> {
  const email = process.env.TEST_EMAIL;
  if (!email) {
    console.error('Set TEST_EMAIL to a deliverable address (e.g. you+talklogout@example.com).');
    console.error('The test sends a real verification email and waits for you to click the link.');
    process.exit(2);
  }
  const handle = deriveHandle(email);
  console.log(`Logout test — email=${email} handle=${handle}`);
  console.log(`Relay: ${HTTP_BASE}\n`);

  // --- 1. POST /login ---
  console.log('1. POST /login');
  const loginResp = await fetch(`${HTTP_BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, handle }),
  });
  const loginData = await loginResp.json() as { pending_id?: string; email_hint?: string; error?: string };
  if (!loginResp.ok || !loginData.pending_id) {
    throw new Error(`FAIL: /login returned ${loginResp.status}: ${JSON.stringify(loginData)}`);
  }
  console.log(`   pending_id=${loginData.pending_id.slice(0, 12)}… email_hint=${loginData.email_hint}`);

  // --- 2. Poll /login-status ---
  console.log('\n2. Poll /login-status until verified');
  const token = await pollForToken(loginData.pending_id, email);

  // --- 3. Open an authenticated WebSocket ---
  console.log('\n3. Open /node with fresh token → expect OPEN');
  const sock = await openAuthedSocket(handle, token);
  console.log('   socket OPEN');
  const closedPromise = waitForClose(sock);

  // --- 4. POST /logout, observe server-initiated close ---
  console.log('\n4. POST /logout → expect {ok:true} and live socket to close(1008)');
  const logoutResp = await fetch(`${HTTP_BASE}/logout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ handle, token }),
  });
  const logoutData = await logoutResp.json() as { ok?: boolean; error?: string };
  if (!logoutResp.ok || !logoutData.ok) {
    throw new Error(`FAIL: /logout returned ${logoutResp.status}: ${JSON.stringify(logoutData)}`);
  }
  console.log('   server returned {ok:true}');
  const closeInfo = await closedPromise;
  if (!closeInfo) {
    throw new Error(`FAIL: live socket was not closed within ${CLOSE_WAIT_MS}ms of /logout`);
  }
  if (closeInfo.code !== 1008) {
    console.log(`   WARN: expected close code 1008, got ${closeInfo.code} (reason="${closeInfo.reason}")`);
  } else {
    console.log(`   socket closed with code=1008 reason="${closeInfo.reason}"`);
  }

  // --- 5. Reconnect with revoked token → expect 401 ---
  console.log('\n5. Reconnect /node with revoked token → expect HTTP 401');
  const reconnectStatus = await expectUpgradeStatus(handle, token);
  if (reconnectStatus !== 401) {
    throw new Error(`FAIL: expected 401 on reconnect with revoked token, got ${reconnectStatus}`);
  }
  console.log('   rejected with 401');

  // --- 6. Shape validation: missing fields → 400 ---
  console.log('\n6. POST /logout {} → expect 400');
  const badReq = await fetch(`${HTTP_BASE}/logout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (badReq.status !== 400) {
    throw new Error(`FAIL: expected 400 for missing fields, got ${badReq.status}`);
  }
  console.log('   got 400');

  // --- 7. Idempotent: unknown handle → {ok:true, already:true} ---
  console.log('\n7. POST /logout for unknown handle → expect {ok:true, already:true}');
  const idem = await fetch(`${HTTP_BASE}/logout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ handle: '@nonexistent_logout_test_zzz', token: 'whatever' }),
  });
  const idemData = await idem.json() as { ok?: boolean; already?: boolean };
  if (!idemData.ok || !idemData.already) {
    throw new Error(`FAIL: expected idempotent ok, got ${JSON.stringify(idemData)}`);
  }
  console.log('   idempotent ok');

  console.log('\n✓ All logout assertions passed');
}

run().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
