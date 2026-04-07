#!/usr/bin/env node
import { readFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import WebSocket from 'ws';
import { scanManifest, formatManifest } from './manifest.js';

// --- Logging ---
import { createWriteStream } from 'fs';
const logPath = join(homedir(), '.talkative', 'node.log');
mkdirSync(join(homedir(), '.talkative'), { recursive: true });
const logStream = createWriteStream(logPath, { flags: 'a' });
const log = (msg: string) => {
  const line = `${new Date().toISOString()} ${msg}\n`;
  log(line);
  logStream.write(line);
};

// --- Config ---
const rawUrl = process.env.TALKATIVE_RELAY_URL ?? 'wss://talkative-relay.workers.dev';
const relayUrl = rawUrl.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');

// Handle: CLI arg or random
let handle = process.argv[2] ?? `@${Math.random().toString(36).slice(2, 8)}`;
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

// --- WebSocket to Relay ---
let ws: WebSocket;

function connectRelay() {
  ws = new WebSocket(`${relayUrl}/node`);

  ws.on('open', () => {
    log('Connected to relay...');
    // Register with handle and tool list
    const manifest = scanManifest();
    ws.send(JSON.stringify({
      type: 'register',
      handle,
      tools: manifest.tools.map(t => t.name),
    }));
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

    if (msg.type === 'peers') {
      // Response to peers query — store for pending tool call
      if (pendingPeersResolve) {
        pendingPeersResolve(msg.peers);
        pendingPeersResolve = null;
      }
      return;
    }

    if (msg.type === 'message') {
      log(`Message from ${msg.from_handle}: ${msg.text.slice(0, 200)}`);
      // Push to Claude as a channel notification
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

// --- Peers query mechanism ---
let pendingPeersResolve: ((peers: any[]) => void) | null = null;

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
      description: 'Set your handle on the Talkative network and re-register with the relay.',
      inputSchema: {
        type: 'object',
        properties: {
          handle: { type: 'string', description: 'The handle to use (e.g. @sarah)' },
        },
        required: ['handle'],
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
    const newHandle = (req.params.arguments as { handle: string }).handle;
    const h = newHandle.startsWith('@') ? newHandle : `@${newHandle}`;
    handle = h;
    // Re-register with relay
    if (ws.readyState === WebSocket.OPEN) {
      const manifest = scanManifest();
      ws.send(JSON.stringify({ type: 'register', handle: h, tools: manifest.tools.map(t => t.name) }));
    }
    return { content: [{ type: 'text', text: `Handle set to ${h} for this session.` }] };
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
      const lines = peers.map((p: any) =>
        `- ${p.handle} — tools: ${p.tools.length > 0 ? p.tools.join(', ') : 'none'}`
      );
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
