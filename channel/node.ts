#!/usr/bin/env node
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import WebSocket from 'ws';
import { scanManifest, formatManifest } from './manifest.js';

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
const authPath = join(homedir(), '.talkative', 'auth.json');

interface AuthData { handle: string; token: string; }

function loadAuth(): AuthData | null {
  try {
    const data = JSON.parse(readFileSync(authPath, 'utf8'));
    if (data.handle && data.token) return data as AuthData;
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
const relayUrl = rawUrl.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');

// Handle: saved auth > CLI arg > random
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
let pendingRegisterResolve: ((result: any) => void) | null = null;
let pendingVerifyResolve: ((result: any) => void) | null = null;
let pendingVerifyHandle: string | null = null;

// --- WebSocket to Relay ---
let ws: WebSocket;

function connectRelay() {
  ws = new WebSocket(`${relayUrl}/node`);

  ws.on('open', () => {
    log('Connected to relay...');
    const auth = loadAuth();
    if (auth) {
      handle = auth.handle;
      ws.send(JSON.stringify({ type: 'register', handle: auth.handle, token: auth.token }));
      log(`Auto-authenticating as ${auth.handle}`);
    } else {
      ws.send(JSON.stringify({ type: 'register', handle }));
    }
  });

  ws.on('message', async (data: Buffer) => {
    const msg = JSON.parse(data.toString());

    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }

    if (msg.type === 'registered') {
      log(`Registered as ${handle} (node: ${msg.node_id}). Waiting for messages...`);
      return;
    }

    if (msg.type === 'verify_required') {
      pendingVerifyHandle = msg.handle ?? handle;
      if (pendingRegisterResolve) {
        pendingRegisterResolve({ status: 'verify_required', emailHint: msg.email_hint });
        pendingRegisterResolve = null;
      }
      return;
    }

    if (msg.type === 'verified') {
      handle = pendingVerifyHandle ?? handle;
      saveAuth({ handle, token: msg.token });
      log(`Verified and registered as ${handle}`);
      if (pendingVerifyResolve) {
        pendingVerifyResolve({ status: 'verified', handle });
        pendingVerifyResolve = null;
      }
      return;
    }

    if (msg.type === 'auth_failed') {
      log(`Auth failed: ${msg.reason}`);
      clearAuth();
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: `Authentication failed: ${msg.reason}. Please re-verify with talk_set_handle.`,
          meta: { from: 'system' },
        },
      });
      return;
    }

    if (msg.type === 'auth_required') {
      if (pendingRegisterResolve) {
        pendingRegisterResolve({ status: 'auth_required', text: msg.text });
        pendingRegisterResolve = null;
      }
      return;
    }

    if (msg.type === 'peers') {
      if (pendingPeersResolve) {
        pendingPeersResolve(msg.peers);
        pendingPeersResolve = null;
      }
      return;
    }

    if (msg.type === 'message') {
      log(`Message from ${msg.from_handle}: ${msg.text.slice(0, 200)}`);
      try {
        await mcp.notification({
          method: 'notifications/claude/channel',
          params: {
            content: msg.text,
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
      if (pendingRegisterResolve) {
        pendingRegisterResolve({ status: 'error', text: msg.text });
        pendingRegisterResolve = null;
      }
      if (pendingVerifyResolve) {
        pendingVerifyResolve({ status: 'error', text: msg.text });
        pendingVerifyResolve = null;
      }
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

  ws.on('error', async (err) => {
    log(`WebSocket error: ${err.message}`);
    try {
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: { content: `Connection error: ${err.message}`, meta: { from: 'system' } },
      });
    } catch {}
  });
  ws.on('close', async () => {
    log('Disconnected from relay.');
    try {
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: { content: 'Disconnected from the Talkative relay. Reconnecting in 5 seconds...', meta: { from: 'system' } },
      });
    } catch {}
    setTimeout(connectRelay, 5000);
  });
}

// --- Peers query ---
function requestPeers(): Promise<any[]> {
  return new Promise((resolve, reject) => {
    if (ws.readyState !== WebSocket.OPEN) {
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
      description: 'Set your handle on the Talkative network. Requires email verification for new handles.',
      inputSchema: {
        type: 'object',
        properties: {
          handle: { type: 'string', description: 'The handle to use (e.g. @sarah)' },
          email: { type: 'string', description: 'Email address for identity verification' },
        },
        required: ['handle'],
      },
    },
    {
      name: 'talk_verify',
      description: 'Submit the email verification code to complete handle registration.',
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'The 6-digit verification code from the email' },
        },
        required: ['code'],
      },
    },
    {
      name: 'talk_peers',
      description: 'List all peers currently online on the Talkative network',
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
    const args = req.params.arguments as { handle: string; email?: string };
    const h = args.handle.startsWith('@') ? args.handle : `@${args.handle}`;

    // Check if we already have a valid token for this handle
    const auth = loadAuth();
    if (auth && auth.handle === h && auth.token) {
      handle = h;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'register', handle: h, token: auth.token }));
      }
      return { content: [{ type: 'text', text: `Authenticated as ${h} using saved credentials.` }] };
    }

    if (!args.email) {
      return { content: [{ type: 'text', text: `Email is required to register handle ${h}. Please provide an email address for verification.` }] };
    }

    handle = h;
    if (ws.readyState !== WebSocket.OPEN) {
      return { content: [{ type: 'text', text: 'Not connected to relay. Try again in a moment.' }] };
    }

    try {
      const result = await new Promise<any>((resolve, reject) => {
        pendingRegisterResolve = resolve;
        ws.send(JSON.stringify({ type: 'register', handle: h, email: args.email }));
        setTimeout(() => {
          if (pendingRegisterResolve) {
            pendingRegisterResolve = null;
            reject(new Error('Registration timed out'));
          }
        }, 30_000);
      });

      if (result.status === 'verify_required') {
        return { content: [{ type: 'text', text: `A verification code has been sent to ${result.emailHint}. Please provide the 6-digit code.` }] };
      }
      if (result.status === 'auth_required') {
        return { content: [{ type: 'text', text: result.text }] };
      }
      if (result.status === 'error') {
        return { content: [{ type: 'text', text: result.text }] };
      }

      return { content: [{ type: 'text', text: `Handle set to ${h}.` }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Failed to register: ${err.message}` }] };
    }
  }

  if (name === 'talk_verify') {
    const { code } = req.params.arguments as { code: string };
    if (!pendingVerifyHandle) {
      return { content: [{ type: 'text', text: 'No pending verification. Use talk_set_handle first.' }] };
    }
    if (ws.readyState !== WebSocket.OPEN) {
      return { content: [{ type: 'text', text: 'Not connected to relay.' }] };
    }

    try {
      const result = await new Promise<any>((resolve, reject) => {
        pendingVerifyResolve = resolve;
        ws.send(JSON.stringify({ type: 'verify', handle: pendingVerifyHandle, code }));
        setTimeout(() => {
          if (pendingVerifyResolve) {
            pendingVerifyResolve = null;
            reject(new Error('Verification timed out'));
          }
        }, 30_000);
      });

      if (result.status === 'verified') {
        pendingVerifyHandle = null;
        return { content: [{ type: 'text', text: `Verified! You are now registered as ${result.handle}. Credentials saved for future sessions.` }] };
      }
      if (result.status === 'error') {
        return { content: [{ type: 'text', text: result.text }] };
      }

      return { content: [{ type: 'text', text: 'Verification failed.' }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Verification failed: ${err.message}` }] };
    }
  }

  if (name === 'talk_send') {
    const { to, message } = req.params.arguments as { to: string; message: string };
    if (ws.readyState !== WebSocket.OPEN) {
      return { content: [{ type: 'text', text: 'Not connected to relay. Try again in a moment.' }] };
    }
    ws.send(JSON.stringify({ type: 'message', to, text: message, from_handle: handle }));
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

  throw new Error(`Unknown tool: ${name}`);
});

// --- Start ---
const transport = new StdioServerTransport();
mcp.connect(transport);
connectRelay();
