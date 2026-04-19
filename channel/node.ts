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

const PROTOCOL_VERSION = '2';

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
  const url = `${wsBase}/node?handle=${encodeURIComponent(auth.handle)}&token=${encodeURIComponent(auth.token)}&v=${PROTOCOL_VERSION}`;
  const sock = new WebSocket(url);
  ws = sock;

  let authRejected = false;
  let settled = false;

  sock.on('unexpected-response', async (_req, res) => {
    if (res.statusCode === 401) {
      authRejected = true;
      log('Relay rejected stored credentials (401). Clearing auth.');
      clearAuth();
      if (!settled) { settled = true; resolve(false); }
      try {
        await mcp.notification({
          method: 'notifications/claude/channel',
          params: {
            content: 'Saved Talkative login is invalid. Run talk_set_handle with your email to re-authenticate.',
            meta: { from: 'system' },
          },
        });
      } catch {}
    } else {
      log(`Relay upgrade failed: status=${res.statusCode}`);
      if (!settled) { settled = true; resolve(false); }
    }
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

    if (msg.type === 'registered') {
      log(`Registered as ${handle} (node: ${msg.node_id}). Waiting for messages...`);
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
            content: `Received an unreadable message from ${msg.from_handle}. Their identity key may have rotated — ask them to re-send.`,
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
            content: plaintext,
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
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: `Network error: ${msg.text}`,
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

  sock.on('close', async () => {
    log('Disconnected from relay.');
    ws = null;
    if (!settled) { settled = true; resolve(false); }
    if (authRejected || intentionalClose) {
      intentionalClose = false;
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
    const resp = await fetch(`${httpBase}/logout`, {
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
): Promise<{ ok: true; pendingId: string; emailHint: string } | { ok: false; error: string }> {
  try {
    const resp = await fetch(`${httpBase}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, handle: h, pubkey: publicKey }),
    });
    const data = await resp.json() as { pending_id?: string; email_hint?: string; error?: string };
    if (!resp.ok || !data.pending_id) {
      return { ok: false, error: data.error ?? `HTTP ${resp.status}` };
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
      const resp = await fetch(`${httpBase}/login-status?pending_id=${encodeURIComponent(pendingId)}`);
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

    // Derive handle from email: strip domain, remove special chars, prefix with @
    const h = `@${email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '').toLowerCase()}`;

    // Already have a saved token for this handle? Verify it against the relay.
    const existing = loadAuth();
    if (existing && existing.handle === h && existing.token) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        return { content: [{ type: 'text', text: `Already connected as ${h}.` }] };
      }
      handle = h;
      const connected = await connectRelay();
      if (connected) {
        return { content: [{ type: 'text', text: `Logged in as ${h}.` }] };
      }
      // Token was rejected — fall through to fresh login
    }

    // Fresh login always mints a new identity keypair. The public half is
    // bound to the identity at email-verification time on the relay; the
    // secret half stays in auth.json.
    const keypair = generateKeypair();
    const result = await beginLogin(email, h, keypair.publicKey);
    if (!result.ok) {
      return { content: [{ type: 'text', text: `Failed to start login: ${result.error}` }] };
    }
    pollLoginStatus(result.pendingId, keypair).catch((err) => log(`login poll crashed: ${err.message}`));
    return {
      content: [{
        type: 'text',
        text: `Check your email at ${result.emailHint} and click the verification link to complete login.`,
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
    ws.send(JSON.stringify({ type: 'message', to, nonce, ciphertext }));
    return { content: [{ type: 'text', text: `Message sent to ${to}.` }] };
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

  throw new Error(`Unknown tool: ${name}`);
});

// --- Start ---
const transport = new StdioServerTransport();
mcp.connect(transport);
connectRelay();
