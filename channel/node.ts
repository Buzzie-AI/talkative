#!/usr/bin/env node
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import WebSocket from 'ws';
import { scanManifest, formatManifest } from './manifest.js';
import { generateKeypair, encryptFor, decryptFrom, KeyPair } from './crypto.js';
import { deriveBaseHandle, handleVariant, HANDLE_RETRY_MAX_ATTEMPTS } from './handle.js';

const PROTOCOL_VERSION = '2';
// Plugin build version. Keep in sync with plugin/.claude-plugin/plugin.json
// (there's a memory rule about this). Sent on every request so the relay
// can log skew and the user can see it in any error message.
const PLUGIN_VERSION = '1.3.4';

// Latest relay versions observed on the current connection (populated from
// the `registered` message and from HTTP response headers). Used to build
// self-diagnosing error strings.
let lastSeenRelayProto: string | null = null;
let lastSeenRelayBuild: string | null = null;

const CLIENT_VERSION_HEADERS: Record<string, string> = {
  'X-Talkative-Plugin-Build': PLUGIN_VERSION,
  'X-Talkative-Plugin-Proto': PROTOCOL_VERSION,
};

function mergeClientHeaders(init?: RequestInit): RequestInit {
  const existing = (init?.headers ?? {}) as Record<string, string>;
  return {
    ...init,
    headers: { ...CLIENT_VERSION_HEADERS, ...existing },
  };
}

function relayFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, mergeClientHeaders(init)).then((resp) => {
    // Cache the relay versions from any response so we can include them in
    // error messages even when the error itself comes from elsewhere.
    const proto = resp.headers.get('x-talkative-relay-proto');
    const build = resp.headers.get('x-talkative-relay-build');
    if (proto) lastSeenRelayProto = proto;
    if (build) lastSeenRelayBuild = build;
    return resp;
  });
}

function versionTail(relayProto?: string | null, relayBuild?: string | null): string {
  const p = relayProto ?? lastSeenRelayProto;
  const b = relayBuild ?? lastSeenRelayBuild;
  if (!p && !b) {
    return ` (plugin build=${PLUGIN_VERSION} proto=${PROTOCOL_VERSION}; relay version unknown)`;
  }
  return ` (plugin build=${PLUGIN_VERSION} proto=${PROTOCOL_VERSION} ↔ relay build=${b ?? '?'} proto=${p ?? '?'})`;
}

// --- Logging ---
import { appendFileSync } from 'fs';
const logDir = join(homedir(), '.talkative');
const logPath = join(logDir, 'node.log');
try { mkdirSync(logDir, { recursive: true }); } catch {}
const _stderr = process.stderr.write.bind(process.stderr);
const log = (msg: string) => {
  const line = `${new Date().toISOString()} ${msg}\n`;
  _stderr(line);
  try { appendFileSync(logPath, line); } catch {}
};

// --- Auth token management ---
// Default: ~/.talkative/auth.json. Override with TALKATIVE_AUTH_PATH to isolate
// identities per project (useful when running two Claude Code sessions as
// different handles — set a different path in each project's .mcp.json env).
const authPath = process.env.TALKATIVE_AUTH_PATH
  ? (process.env.TALKATIVE_AUTH_PATH.startsWith('/')
      ? process.env.TALKATIVE_AUTH_PATH
      : join(process.cwd(), process.env.TALKATIVE_AUTH_PATH))
  : join(homedir(), '.talkative', 'auth.json');

interface AuthData {
  handle: string;
  token: string;
  publicKey: string;
  secretKey: string;
}

function loadAuth(): AuthData | null {
  try {
    const data = JSON.parse(readFileSync(authPath, 'utf8'));
    if (data.handle && data.token && data.publicKey && data.secretKey) {
      return data as AuthData;
    }
  } catch {}
  return null;
}

function saveAuth(data: AuthData) {
  mkdirSync(dirname(authPath), { recursive: true });
  writeFileSync(authPath, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function clearAuth() {
  try { unlinkSync(authPath); } catch {}
}

// --- Sanitization ---
/** Escape XML/HTML special chars to prevent tag injection in channel content. */
function sanitize(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// --- Config ---
const rawUrl = process.env.TALKATIVE_RELAY_URL ?? 'wss://talkative-relay.workers.dev';
const wsBase = rawUrl.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');
const httpBase = rawUrl.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://');

// Handle: saved auth > CLI arg > random (random is only a placeholder until login)
const savedAuth = loadAuth();
let handle = savedAuth?.handle ?? process.argv[2] ?? `@${Math.random().toString(36).slice(2, 8)}`;
const __script_dir = typeof __dirname !== 'undefined' ? __dirname : dirname(new URL(import.meta.url).pathname);

// Load instructions from markdown file
let instructions: string;
try {
  instructions = readFileSync(join(__script_dir, 'instructions.md'), 'utf8');
} catch {
  instructions = 'You are connected to the Talkative peer network.';
}

// --- MCP Server ---
const mcp = new Server(
  { name: 'talkative', version: '1.0.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions,
  },
);

// --- Pending state for async tool calls ---
let pendingPeersResolve: ((peers: any[]) => void) | null = null;

// --- Pending delivery acks ---
const pendingAcks = new Map<string, (result: { ok: boolean; error?: string }) => void>();

// --- Pending diagnostic check_response, keyed by nonce ---
interface CheckResponse {
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
const pendingChecks = new Map<string, (resp: CheckResponse) => void>();

// --- Peer public-key cache ---
// Populated from `peers` responses and from `from_pubkey` on inbound messages.
// Used by talk_send to encrypt before transmitting.
const peerPubkeys: Map<string, string> = new Map();

// --- WebSocket to Relay ---
let ws: WebSocket | null = null;
let intentionalClose = false;

function connectRelay(): Promise<boolean> {
  return new Promise((resolve) => {
  const auth = loadAuth();
  if (!auth) {
    log('No saved credentials. Waiting for user to log in with talk_set_handle.');
    resolve(false);
    return;
  }
  handle = auth.handle;
  const url = `${wsBase}/node?handle=${encodeURIComponent(auth.handle)}&token=${encodeURIComponent(auth.token)}&v=${PROTOCOL_VERSION}&build=${encodeURIComponent(PLUGIN_VERSION)}`;
  const sock = new WebSocket(url);
  ws = sock;

  let authRejected = false;
  let evicted = false; // set when relay kicks this session because another login took over
  let settled = false;

  sock.on('unexpected-response', (_req, res) => {
    const statusCode = res.statusCode ?? 0;

    // Capture relay versions from response headers for diagnostics.
    const relayProto = (res.headers['x-talkative-relay-proto'] as string | undefined) ?? null;
    const relayBuild = (res.headers['x-talkative-relay-build'] as string | undefined) ?? null;
    if (relayProto) lastSeenRelayProto = relayProto;
    if (relayBuild) lastSeenRelayBuild = relayBuild;

    // Settle the connect promise immediately so we don't block on body read.
    if (statusCode === 401) {
      authRejected = true;
      clearAuth();
    }
    if (!settled) { settled = true; resolve(false); }

    // Collect the relay's explanation and surface it via channel so the
    // user sees exactly what went wrong (e.g. version mismatch naming
    // both versions, or a specific 401 reason). Always append a version
    // tail so the user can see skew even when the error isn't obviously
    // version-shaped.
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => { body += chunk; });
    res.on('end', async () => {
      const trimmed = body.trim();
      log(`Relay upgrade failed: status=${statusCode} relay_build=${relayBuild ?? 'unknown'} body=${trimmed.slice(0, 300)}`);
      const fallback = statusCode === 401
        ? 'Saved Talkative login is invalid. Run talk_set_handle to re-authenticate.'
        : `Couldn't connect to the Talkative relay (HTTP ${statusCode}).`;
      const content = (trimmed || fallback) + versionTail(relayProto, relayBuild);
      try {
        await mcp.notification({
          method: 'notifications/claude/channel',
          params: { content, meta: { from: 'system' } },
        });
      } catch {}
    });
    res.on('error', () => { /* logged via body read */ });
  });

  sock.on('open', () => {
    log(`Connected to relay as ${handle}`);
    if (!settled) { settled = true; resolve(true); }
  });

  sock.on('message', async (data: Buffer) => {
    const msg = JSON.parse(data.toString());

    if (msg.type === 'ping') {
      sock.send(JSON.stringify({ type: 'pong' }));
      return;
    }

    // Relay is telling us another session took over this handle. Set the
    // flag so the close handler won't auto-reconnect, then surface the
    // message to the user so they know what happened.
    if (msg.type === 'evicted') {
      evicted = true;
      const reason = typeof msg.text === 'string' && msg.text.trim().length > 0
        ? msg.text
        : `Signed out here: another Talkative session took over ${handle}. Run talk_set_handle to reconnect.`;
      log(`Evicted by relay (reason=${msg.reason ?? 'unknown'}): ${reason}`);
      try {
        await mcp.notification({
          method: 'notifications/claude/channel',
          params: { content: reason, meta: { from: 'system' } },
        });
      } catch {}
      return;
    }

    if (msg.type === 'registered') {
      if (typeof msg.relay_proto === 'string') lastSeenRelayProto = msg.relay_proto;
      if (typeof msg.relay_build === 'string') lastSeenRelayBuild = msg.relay_build;
      log(`Registered as ${handle} (node: ${msg.node_id}) relay_build=${lastSeenRelayBuild ?? 'unknown'} relay_proto=${lastSeenRelayProto ?? 'unknown'}`);
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: `Welcome to the Talkative network! You're connected as ${handle}.`,
          meta: { from: 'system' },
        },
      });
      return;
    }

    if (msg.type === 'peers') {
      for (const p of msg.peers ?? []) {
        if (p?.handle && p?.pubkey) peerPubkeys.set(p.handle, p.pubkey);
      }
      if (pendingPeersResolve) {
        pendingPeersResolve(msg.peers);
        pendingPeersResolve = null;
      }
      return;
    }

    if (msg.type === 'check_response' && typeof msg.nonce === 'string') {
      const resolver = pendingChecks.get(msg.nonce);
      if (resolver) {
        pendingChecks.delete(msg.nonce);
        resolver(msg as CheckResponse);
      }
      return;
    }

    if (msg.type === 'ack' && msg.msg_id) {
      const pending = pendingAcks.get(msg.msg_id);
      if (pending) {
        pendingAcks.delete(msg.msg_id);
        pending({ ok: true });
      }
      return;
    }

    if (msg.type === 'message') {
      const auth = loadAuth();
      if (!auth) {
        log('Inbound message but no auth loaded — dropping.');
        return;
      }
      if (!msg.from_pubkey || !msg.nonce || !msg.ciphertext) {
        log(`Malformed E2E message from ${msg.from_handle} — missing fields.`);
        return;
      }
      // Remember the sender's pubkey for future outbound encryption.
      peerPubkeys.set(msg.from_handle, msg.from_pubkey);
      const plaintext = decryptFrom(msg.from_pubkey, auth.secretKey, msg.nonce, msg.ciphertext);
      if (plaintext == null) {
        log(`Decrypt failed from ${msg.from_handle} — key mismatch or tampered ciphertext.`);
        await mcp.notification({
          method: 'notifications/claude/channel',
          params: {
            content: `Received an unreadable message from ${sanitize(msg.from_handle)}. Their identity key may have rotated — ask them to re-send.`,
            meta: { from: 'system' },
          },
        });
        return;
      }
      log(`Message from ${msg.from_handle}: ${plaintext.slice(0, 200)}`);
      try {
        await mcp.notification({
          method: 'notifications/claude/channel',
          params: {
            content: sanitize(plaintext),
            meta: { from: msg.from_handle },
          },
        });
        log('Channel notification sent to Claude Code');
      } catch (err: any) {
        log(`Channel notification FAILED: ${err.message}`);
      }
      return;
    }

    if (msg.type === 'error') {
      log(`Relay error: ${msg.text}`);
      if (msg.msg_id) {
        const pending = pendingAcks.get(msg.msg_id);
        if (pending) {
          pendingAcks.delete(msg.msg_id);
          pending({ ok: false, error: msg.text });
          return;
        }
      }
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: `Network error: ${sanitize(msg.text)}`,
          meta: { from: 'system' },
        },
      });
      return;
    }
  });

  sock.on('error', async (err) => {
    log(`WebSocket error: ${err.message}`);
    if (!settled) { settled = true; resolve(false); }
  });

  sock.on('close', async (code) => {
    log(`Disconnected from relay (code=${code}).`);
    ws = null;
    if (!settled) { settled = true; resolve(false); }
    // Close code 4001 = relay kicked us because another session took over.
    // Treat it the same as an in-band `evicted` message in case the message
    // didn't arrive before the close frame.
    const kickedByCode = code === 4001;
    if (authRejected || intentionalClose || evicted || kickedByCode) {
      intentionalClose = false;
      if (kickedByCode && !evicted) {
        // Fallback: close code arrived without the explanatory message.
        try {
          await mcp.notification({
            method: 'notifications/claude/channel',
            params: {
              content: `Signed out here: another Talkative session took over ${handle}. Run talk_set_handle to reconnect.`,
              meta: { from: 'system' },
            },
          });
        } catch {}
      }
      return;
    }
    try {
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: { content: 'Disconnected from the Talkative relay. Reconnecting in 5 seconds...', meta: { from: 'system' } },
      });
    } catch {}
    setTimeout(connectRelay, 5000);
  });
  });
}

async function revokeTokenOnServer(auth: AuthData): Promise<{ ok: boolean; error?: string }> {
  try {
    const resp = await relayFetch(`${httpBase}/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: auth.handle, token: auth.token }),
    });
    if (resp.ok) return { ok: true };
    const data = await resp.json().catch(() => ({})) as { error?: string };
    return { ok: false, error: data.error ?? `HTTP ${resp.status}` };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

function closeLocalSession() {
  intentionalClose = true;
  if (ws) {
    try { ws.close(1000, 'logout'); } catch {}
    ws = null;
  }
  clearAuth();
}

// --- HTTP signup flow ---

async function beginLogin(
  email: string,
  h: string,
  publicKey: string,
): Promise<
  | { ok: true; pendingId: string; emailHint: string }
  | { ok: false; error: string; status?: number }
> {
  try {
    const resp = await relayFetch(`${httpBase}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, handle: h, pubkey: publicKey }),
    });
    const data = await resp.json() as { pending_id?: string; email_hint?: string; error?: string };
    if (!resp.ok || !data.pending_id) {
      return { ok: false, status: resp.status, error: data.error ?? `HTTP ${resp.status}` };
    }
    return { ok: true, pendingId: data.pending_id, emailHint: data.email_hint ?? email };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

async function pollLoginStatus(pendingId: string, keypair: KeyPair) {
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const resp = await relayFetch(`${httpBase}/login-status?pending_id=${encodeURIComponent(pendingId)}`);
      if (resp.status === 404 || resp.status === 410) {
        await mcp.notification({
          method: 'notifications/claude/channel',
          params: {
            content: 'Login verification expired before you clicked the email link. Run talk_set_handle again to retry.',
            meta: { from: 'system' },
          },
        });
        return;
      }
      if (!resp.ok) continue;
      const data = await resp.json() as { status: string; handle?: string; token?: string };
      if (data.status === 'pending') continue;
      if (data.status === 'verified' && data.token && data.handle) {
        saveAuth({
          handle: data.handle,
          token: data.token,
          publicKey: keypair.publicKey,
          secretKey: keypair.secretKey,
        });
        handle = data.handle;
        log(`Verified and logged in as ${data.handle}`);
        await mcp.notification({
          method: 'notifications/claude/channel',
          params: {
            content: `Verified! You are now logged in as ${data.handle}.`,
            meta: { from: 'system' },
          },
        });
        connectRelay();
        return;
      }
    } catch (err: any) {
      log(`login-status poll error: ${err.message}`);
    }
  }
  await mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: 'Login verification timed out. Run talk_set_handle again to retry.',
      meta: { from: 'system' },
    },
  });
}

// --- Peers query ---
function requestPeers(): Promise<any[]> {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error('Not connected to relay'));
      return;
    }
    pendingPeersResolve = resolve;
    ws.send(JSON.stringify({ type: 'peers' }));
    setTimeout(() => {
      if (pendingPeersResolve) {
        pendingPeersResolve = null;
        reject(new Error('Peers request timed out'));
      }
    }, 10_000);
  });
}

// --- MCP Tools ---
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'talk_my_tools',
      description: 'Check what MCP tools and servers are configured on this machine',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'talk_send',
      description: 'Send a message to another peer on the Talkative network',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'The handle of the peer to message (e.g. @sarah)' },
          message: { type: 'string', description: 'The message to send' },
        },
        required: ['to', 'message'],
      },
    },
    {
      name: 'talk_set_handle',
      description: 'Log into the Talkative network with an email address. The handle is derived from the email (e.g. arvind.naidu@gmail.com becomes @arvindnaidu).',
      inputSchema: {
        type: 'object',
        properties: {
          email: { type: 'string', description: 'Email address for login and identity verification' },
        },
        required: ['email'],
      },
    },
    {
      name: 'talk_peers',
      description: 'List all peers currently online on the Talkative network',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'talk_logout',
      description: 'Log out of the Talkative network and revoke the auth token on the server. After this, the token is dead on every machine — you must re-verify via email with talk_set_handle to log back in.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'talk_logout_local',
      description: 'Log out on this machine only. Closes the local connection and forgets saved credentials, but the token remains valid on the server. Use this to switch machines without revoking access elsewhere.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'talk_check',
      description: 'Diagnostic roundtrip: sends a probe to the relay and reports back whether the live WebSocket is healthy, how many sockets are connected as this handle (should be 1), round-trip latency, and client/relay versions. Use this when something feels broken to confirm the plumbing itself is working.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name } = req.params;

  if (name === 'talk_my_tools') {
    const manifest = scanManifest();
    return {
      content: [{ type: 'text', text: formatManifest(manifest) }],
    };
  }

  if (name === 'talk_set_handle') {
    const args = req.params.arguments as { email: string };
    const email = args.email;

    const baseHandle = deriveBaseHandle(email);

    // Already have a saved token for this base handle? Verify it against
    // the relay. (Users whose base collided and were assigned @baseN will
    // not hit this fast-path — they'll fall through and the retry loop
    // below will land on their @baseN again since their email matches.)
    const existing = loadAuth();
    if (existing && existing.handle === baseHandle && existing.token) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        return { content: [{ type: 'text', text: `Already connected as ${baseHandle}.` }] };
      }
      handle = baseHandle;
      const connected = await connectRelay();
      if (connected) {
        return { content: [{ type: 'text', text: `Logged in as ${baseHandle}.` }] };
      }
      // Token was rejected — fall through to fresh login
    }

    // Fresh login always mints a new identity keypair. The public half is
    // bound to the identity at email-verification time on the relay; the
    // secret half stays in auth.json.
    const keypair = generateKeypair();

    // Try base handle, then base2, base3, … up to N attempts. On 409 (the
    // handle is registered to a different email) we bump the suffix and
    // retry. Any other non-OK response stops the loop immediately.
    let lastResult: Awaited<ReturnType<typeof beginLogin>> | null = null;
    let assignedHandle = baseHandle;
    for (let attempt = 1; attempt <= HANDLE_RETRY_MAX_ATTEMPTS; attempt++) {
      assignedHandle = handleVariant(baseHandle, attempt);
      lastResult = await beginLogin(email, assignedHandle, keypair.publicKey);
      if (lastResult.ok) break;
      if (lastResult.status !== 409) break;
    }

    if (!lastResult || !lastResult.ok) {
      if (lastResult && lastResult.status === 409) {
        return {
          content: [{
            type: 'text',
            text: `Handle ${baseHandle} and ${HANDLE_RETRY_MAX_ATTEMPTS - 1} numbered variants are all registered to other emails. Try a different email local-part.`,
          }],
        };
      }
      return {
        content: [{
          type: 'text',
          text: `Failed to start login: ${lastResult?.error ?? 'unknown error'}`,
        }],
      };
    }

    pollLoginStatus(lastResult.pendingId, keypair).catch((err) => log(`login poll crashed: ${err.message}`));

    const collisionNote = assignedHandle !== baseHandle
      ? ` (${baseHandle} was taken; you'll be registered as ${assignedHandle})`
      : '';
    return {
      content: [{
        type: 'text',
        text: `Check your email at ${lastResult.emailHint} and click the verification link to complete login${collisionNote}.`,
      }],
    };
  }

  if (name === 'talk_send') {
    const { to, message } = req.params.arguments as { to: string; message: string };
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return { content: [{ type: 'text', text: 'Not connected to relay. Run talk_set_handle to log in.' }] };
    }
    const auth = loadAuth();
    if (!auth) {
      return { content: [{ type: 'text', text: 'No local identity. Run talk_set_handle to log in.' }] };
    }
    let peerPubkey = peerPubkeys.get(to);
    if (!peerPubkey) {
      try {
        const peers = await requestPeers();
        for (const p of peers) {
          if (p?.handle && p?.pubkey) peerPubkeys.set(p.handle, p.pubkey);
        }
        peerPubkey = peerPubkeys.get(to);
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Could not resolve ${to}'s public key: ${err.message}` }] };
      }
    }
    if (!peerPubkey) {
      return { content: [{ type: 'text', text: `${to} is not online — cannot deliver encrypted message.` }] };
    }
    const { nonce, ciphertext } = encryptFor(peerPubkey, auth.secretKey, message);
    const msgId = Math.random().toString(36).slice(2, 10);
    const ackPromise = new Promise<{ ok: boolean; error?: string }>((resolve) => {
      pendingAcks.set(msgId, resolve);
      setTimeout(() => {
        if (pendingAcks.delete(msgId)) {
          resolve({ ok: false, error: 'Relay did not confirm delivery.' });
        }
      }, 5_000);
    });
    ws.send(JSON.stringify({ type: 'message', to, msg_id: msgId, nonce, ciphertext }));
    const result = await ackPromise;
    if (result.ok) {
      return { content: [{ type: 'text', text: `Message delivered to ${to}.` }] };
    }
    return { content: [{ type: 'text', text: `Message to ${to} failed: ${result.error}` }] };
  }

  if (name === 'talk_peers') {
    try {
      const peers = await requestPeers();
      if (peers.length === 0) {
        return { content: [{ type: 'text', text: 'No peers online.' }] };
      }
      const lines = peers.map((p: any) => `- ${p.handle}`);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Failed to get peers: ${err.message}` }] };
    }
  }

  if (name === 'talk_logout') {
    const auth = loadAuth();
    if (!auth) {
      return { content: [{ type: 'text', text: 'Not logged in.' }] };
    }
    const result = await revokeTokenOnServer(auth);
    closeLocalSession();
    if (!result.ok) {
      return {
        content: [{
          type: 'text',
          text: `Local credentials cleared, but the server-side revoke call failed: ${result.error}. The token may still be valid elsewhere — retry talk_logout once you're online.`,
        }],
      };
    }
    return {
      content: [{
        type: 'text',
        text: `Logged out as ${auth.handle}. The token has been revoked and is no longer valid on any machine. Run talk_set_handle to log in again.`,
      }],
    };
  }

  if (name === 'talk_logout_local') {
    const auth = loadAuth();
    if (!auth) {
      return { content: [{ type: 'text', text: 'Not logged in on this machine.' }] };
    }
    closeLocalSession();
    return {
      content: [{
        type: 'text',
        text: `Logged out of ${auth.handle} on this machine. The token is still valid on the server — use talk_logout instead if you want to revoke it everywhere.`,
      }],
    };
  }

  if (name === 'talk_check') {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return {
        content: [{
          type: 'text',
          text: `[FAIL] Not connected to the Talkative relay. ws=${ws ? 'present' : 'null'} readyState=${ws?.readyState ?? 'n/a'}. Run talk_set_handle to log in.${versionTail()}`,
        }],
      };
    }
    const nonce = `chk-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const started = Date.now();
    const response = await new Promise<CheckResponse | null>((resolve) => {
      const timeout = setTimeout(() => {
        pendingChecks.delete(nonce);
        resolve(null);
      }, 5_000);
      pendingChecks.set(nonce, (resp) => {
        clearTimeout(timeout);
        resolve(resp);
      });
      try {
        ws!.send(JSON.stringify({ type: 'check', nonce }));
      } catch (err) {
        clearTimeout(timeout);
        pendingChecks.delete(nonce);
        resolve(null);
      }
    });
    const rttMs = Date.now() - started;

    if (!response) {
      return {
        content: [{
          type: 'text',
          text: `[FAIL] No check_response from relay within 5s. The socket is open but the relay isn't answering.${versionTail()}`,
        }],
      };
    }

    const sentinelOk = response.sentinel === '123';
    const socketsOk = response.sockets_for_handle === 1;
    const handleEcho = response.handle ?? '(unknown)';
    const lines = [
      `[${sentinelOk && socketsOk ? 'OK' : 'WARN'}] Talkative diagnostic check`,
      ``,
      `Round-trip:         ${rttMs}ms`,
      `Sentinel:           ${response.sentinel ?? '(missing)'} ${sentinelOk ? '(== 123, ok)' : '(EXPECTED 123)'}`,
      ``,
      `This session:`,
      `  handle:           ${handleEcho}`,
      `  node_id:          ${response.node_id ?? '(unknown)'}`,
      `  sockets_for_handle: ${response.sockets_for_handle ?? '?'} ${socketsOk ? '(== 1, ok)' : '(EXPECTED 1 — kick-old invariant may be broken)'}`,
      ``,
      `Relay:`,
      `  build:            ${response.relay_build ?? '?'}`,
      `  proto:            ${response.relay_proto ?? '?'}`,
      `  total_sockets:    ${response.total_sockets_online ?? '?'}`,
      `  server_time:      ${response.server_time_ms ? new Date(response.server_time_ms).toISOString() : '?'}`,
      ``,
      `Client:`,
      `  plugin build:     ${PLUGIN_VERSION}`,
      `  plugin proto:     ${PROTOCOL_VERSION}`,
    ];
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

// --- Start ---
const transport = new StdioServerTransport();
mcp.connect(transport);
connectRelay();
