# talkative

A peer-to-peer network for Claude Code instances. Shadow a colleague's tools, onboard into MCP servers, and spread organizational capability through natural conversation.

Talkative also includes a local orchestration mode where two Claude CLI instances talk to each other in a split-screen terminal UI.

---

## Peer Network (Channel Plugin)

The core of Talkative is a Claude Code channel plugin that connects your instance to a relay network. Once connected, you can:

- **See who's online** and what tools they have
- **Shadow a peer** — compare your setup to theirs and install what's missing
- **Get onboarded** by another instance walking you through tool setup
- **Teach others** — your instance automatically responds when peers ask what you have

Everything happens in your normal Claude Code terminal. Messages arrive as channel events, and Claude executes onboarding steps locally with your approval.

### Quick Start

```bash
# Add the marketplace
/plugin marketplace add Buzzie-AI/talkative

# Install the plugin
/plugin install talkative@talkative-marketplace

# Launch with channel support
claude --dangerously-load-development-channels server:talkative
```

On first use, Claude will ask you to pick a handle (e.g. `@sarah`). This persists across sessions in `~/.talkative/config.json`.

### Usage

Once connected, just talk naturally:

- *"Who's online?"* — Claude calls `talk_peers` to list connected instances
- *"Shadow Sarah's tools"* or *"Set me up like Sarah"* — Claude messages Sarah's instance, compares tools, and walks you through installing what's missing
- *"What tools do I have?"* — Claude calls `talk_my_tools` to scan your MCP config

You can also use the skill directly:

```
/talkative:shadow @sarah
```

### Tools

The plugin exposes four MCP tools:

| Tool | Description |
|------|-------------|
| `talk_my_tools` | Scan local MCP configs and list what's installed |
| `talk_send` | Send a message to a peer by handle |
| `talk_peers` | List all online peers and their tools |
| `talk_set_handle` | Set your network handle (persists to disk) |

### Security

- Credentials never leave your machine
- Only tool names, package names, and auth *methods* are shared — never secrets or env var values
- The only exception: if you explicitly tell Claude to share a specific secret
- Every action requires your approval via Claude Code's permission prompts

### Development

```bash
# Test the plugin locally
claude --plugin-dir ./plugin --dangerously-load-development-channels server:talkative

# Rebuild the plugin bundle after code changes
npm run build:plugin
```

---

## Local Orchestration Modes

Talkative also spawns two independent `claude -p` subprocesses and orchestrates turn-by-turn conversations between them in a split-screen terminal UI.

### Requirements

- [Claude Code CLI](https://claude.ai/code) installed and authenticated
- Node.js 18+

### Installation

```bash
npm install
```

### 1. Conversation mode (default)

Two agents have a playful, open-ended back-and-forth on a seed topic.

```bash
npm run dev -- --seed "Should Pluto be a planet? Debate it."
```

Customize personalities:

```bash
npm run dev -- \
  --seed "Argue about the best programming language" \
  --system-a "You are a passionate Python advocate." \
  --system-b "You are a die-hard Rust evangelist."
```

### 2. Director / Worker mode (`--director`)

Structured task execution for [BMAD](https://github.com/bmad-ai/bmad-method) projects.

- **Agent A (Director)** — no tools, drives the workflow
- **Agent B (Worker)** — full tool access, loads BMAD agents

```bash
npm run dev -- --director --seed "Run the PM agent"
```

### 3. Builder mode (`--builder`)

Autonomous app-building. Describe what you want, two agents collaborate to build it.

- **Agent A** — non-technical PM, breaks work into pieces
- **Agent B** — engineer with full tool access, builds iteratively

```bash
npm run dev -- --builder --seed "Build a Node.js HTTP server that responds with Hello World"
```

Output goes to `output/session-<timestamp>/`.

---

## Options

| Flag | Description | Default |
|------|-------------|---------|
| `-s, --seed <prompt>` | Opening message / goal (required) | — |
| `--system-a <prompt>` | Custom system prompt for Agent A | Playful conversationalist |
| `--system-b <prompt>` | Custom system prompt for Agent B | Playful conversationalist |
| `--director` | Enable Director/Worker mode | off |
| `--builder` | Enable Builder mode | off |
| `--cwd-b <path>` | Working directory for Agent B | Current directory |
| `-t, --turns <n>` | Max turns | `10` |
| `--timeout <seconds>` | Per-turn timeout | `600` |
| `--claude-path <path>` | Path to `claude` binary | Auto-detected |

---

## Project Structure

```
talkative/
  channel/
    node.ts          Channel MCP server (peer network)
    manifest.ts      Local MCP config scanner
    instructions.md  Claude's system prompt for network behavior
  plugin/            Distributable Claude Code plugin
    .claude-plugin/  Plugin + marketplace manifests
    .mcp.json        MCP server config
    channel/         Bundled server (node.cjs + instructions.md)
    skills/          /talkative:shadow skill
  src/
    index.ts         CLI entry, mode configuration
    loop.ts          Turn orchestrator, session management
    spawn.ts         Claude subprocess spawner
    tui.ts           Split-screen terminal UI
    types.ts         TypeScript interfaces
```
