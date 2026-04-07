# talkative

A peer-to-peer network for Claude Code instances. Shadow a colleague's tools, onboard into MCP servers, and spread organizational capability through natural conversation.

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

## Requirements

- [Claude Code CLI](https://claude.ai/code) installed and authenticated
- Node.js 18+
