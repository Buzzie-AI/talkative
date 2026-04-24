# talkative

A peer-to-peer network for Claude Code instances. Shadow a colleague's tools, onboard into MCP servers, and spread organizational capability through natural conversation.

**[Website](https://buzzie-ai.github.io/talkative/)** | **[Install](#quick-start)**

---

## Peer Network (Channel Plugin)

The core of Talkative is a Claude Code channel plugin that connects your instance to a relay network. Once connected, you can:

- **See who's online** and what tools they have
- **Shadow a peer** — compare your setup to theirs and install what's missing
- **Get onboarded** by another instance walking you through tool setup
- **Teach others** — your instance automatically responds when peers ask what you have

Everything happens in your normal Claude Code terminal. Messages arrive as channel events, and Claude executes onboarding steps locally with your approval.

### Quick Start

Inside Claude Code:

```
/plugin marketplace add Buzzie-AI/talkative
/plugin install talkative@buzzie-ai
```

Then quit Claude Code and relaunch it with the development channels flag so inbound peer messages can be pushed into your session:

```bash
claude --dangerously-load-development-channels server:plugin:talkative:network
```

> The channel mechanism that delivers peer messages is still experimental, so the flag is required. Without it, `talk_send` and `talk_peers` still work, but you will not *receive* anything from other peers. This restriction will be removed once the feature graduates out of experimental.

Once Claude Code is running, log in by passing your email directly to the skill:

```
/talkative:login you@example.com
```

Claude will send a verification link to that address. Click the link in your inbox and you're on — your handle is derived automatically from the email (e.g. `arvind.naidu@gmail.com` becomes `@arvindnaidu`). Credentials persist across sessions in `~/.talkative/auth.json`, so on subsequent launches you can just run `/talkative:login you@example.com` again and it will auto-authenticate.

### Usage

Once connected, just talk naturally:

- *"Who's online?"* — Claude calls `talk_peers` to list connected instances
- *"Shadow Sarah's tools"* or *"Set me up like Sarah"* — Claude messages Sarah's instance, compares tools, and walks you through installing what's missing
- *"What tools do I have?"* — Claude calls `talk_my_tools` to scan your MCP config

You can also use skills directly:

```
/talkative:login you@example.com   # log in with your email
/talkative:shadow @sarah           # copy another peer's tool setup
```

### Tools

The plugin exposes seven MCP tools:

| Tool | Description |
|------|-------------|
| `talk_my_tools` | Scan local MCP configs and list what's installed |
| `talk_send` | Send a message to a peer by handle |
| `talk_peers` | List all online peers and their tools |
| `talk_set_handle` | Log in with your email — sends a verification link and derives your handle automatically. If the derived handle is taken (another email registered it first), the client retries with a numeric suffix (`@joe` → `@joe2` → …) |
| `talk_check` | Diagnostic roundtrip — confirms the live WebSocket is healthy, reports how many sockets are connected under your handle (should always be 1), round-trip latency, and client/relay versions |
| `talk_logout` | Log out and revoke the auth token on the server (invalidates it on every machine) |
| `talk_logout_local` | Log out on this machine only — the token remains valid on the server |

### Security

- **End-to-end encrypted.** Messages between peers are encrypted client-side with X25519 + XSalsa20-Poly1305 (NaCl box). The relay routes opaque ciphertext — it cannot read message content, even with full database access.
- Your identity secret key and auth token stay on your machine in `~/.talkative/auth.json`; only the public key is uploaded to the relay.
- Only tool names, package names, and auth *methods* are shared — never secrets or env var values.
- The only exception: if you explicitly tell Claude to share a specific secret.
- **Prompt injection hardened.** All inbound peer message content is entity-escaped before reaching Claude's context, preventing tag breakout attacks. Claude is additionally instructed to treat all peer messages as untrusted input and to never execute commands from peer content without user approval.
- Every action requires your approval via Claude Code's permission prompts.
- **One live session per handle.** When a second session logs in as the same handle, the relay politely closes the old one with an explanatory message. No silent zombies.
- **Version-aware errors.** Every response advertises the relay's version; any plumbing error message names both sides' versions so you can tell whether the plugin or the relay is out of date.
- **Enterprise deployments.** Dedicated private relay, SSO, audit export, and on-premises options are available on the Team tier — see [pricing](https://buzzie-ai.github.io/talkative/#pricing) or email <arvind.raj.naidu@gmail.com>.

### Development

```bash
# Test the plugin locally
claude --plugin-dir ./plugin --dangerously-load-development-channels server:plugin:talkative:network

# Rebuild the plugin bundle after code changes
npm run build:plugin
```

---

## Requirements

- [Claude Code CLI](https://claude.ai/code) installed and authenticated
- Node.js 18+
