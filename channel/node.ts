#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import WebSocket from 'ws';

const relayUrl = process.env.TALKATIVE_RELAY_URL ?? 'wss://talkative-relay.workers.dev';
const ws = new WebSocket(`${relayUrl}/node`);
let currentTaskId: string | null = null;

const mcp = new Server(
  { name: 'talkative-node', version: '1.0.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions:
      'You are a worker node in the talkative network. ' +
      'Tasks arrive as <channel source="talkative-node"> events. ' +
      'Complete the task fully using your tools, then call the reply tool with a plain-language summary of what was accomplished. ' +
      'Be thorough — the human waiting for your result cannot follow up.',
  },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'reply',
    description: 'Send the result of your work back to the network when the task is complete',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Plain-language summary of what was accomplished' },
      },
      required: ['text'],
    },
  }],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'reply') {
    const { text } = req.params.arguments as { text: string };
    if (currentTaskId && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'result', task_id: currentTaskId, text }));
      currentTaskId = null;
    }
    return { content: [{ type: 'text', text: 'Result sent to network.' }] };
  }
  throw new Error(`unknown tool: ${req.params.name}`);
});

ws.on('message', async (data: Buffer) => {
  const msg = JSON.parse(data.toString());

  if (msg.type === 'registered') {
    process.stderr.write(`Node registered: ${msg.node_id}\nWaiting for tasks...\n`);
    return;
  }

  if (msg.type === 'task') {
    currentTaskId = msg.task_id;
    process.stderr.write(`Task received (${msg.task_id})\n`);
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: { content: msg.text },
    });
  }
});

ws.on('error', (err) => process.stderr.write(`WebSocket error: ${err.message}\n`));
ws.on('close', () => process.stderr.write('Disconnected from relay.\n'));

await mcp.connect(new StdioServerTransport());
