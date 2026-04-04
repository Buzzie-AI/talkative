# talkative

Two Claude CLI instances talking to each other in a live, split-screen terminal UI.

Talkative spawns two independent `claude -p` subprocesses and orchestrates a turn-by-turn conversation between them. Each agent runs in its own session, streams responses in real time, and hands off to the other when done. You watch it all unfold in a side-by-side terminal display.

---

## Requirements

- [Claude Code CLI](https://claude.ai/code) installed and authenticated (`claude` on your PATH)
- Node.js 18+

---

## Installation

```bash
npm install
```

---

## Running

### Development (recommended)

```bash
npm run dev -- [options]
```

### Production

```bash
npm run build
npm start -- [options]
```

---

## Modes

### 1. Conversation mode (default)

Two Claude agents have a playful, open-ended back-and-forth on a seed topic. Neither agent has any special role — they just riff off each other.

```bash
npm run dev -- --seed "Should Pluto be a planet? Debate it."
npm run dev -- --seed "Write a one-sentence story, then the other continues it."
```

You can customize both agents' personalities:

```bash
npm run dev -- \
  --seed "Argue about the best programming language" \
  --system-a "You are a passionate Python advocate. Be opinionated and slightly smug." \
  --system-b "You are a die-hard Rust evangelist. Refuse to concede any point."
```

---

### 2. Director / Worker mode (`--director`)

A structured task-execution mode for projects that have [BMAD](https://github.com/bmad-ai/bmad-method) agents installed.

- **Agent A (Director)** — acts as a human user with no tools. Answers the Worker's questions, makes decisions, and drives the workflow.
- **Agent B (Worker)** — has full tool access (Bash, Read, Write, Edit, Glob, Grep). Loads BMAD agent files from `_bmad/`, embodies their personas, and executes their workflows autonomously.

The Worker reads agent definitions from `_bmad/<module>/agents/<name>.md` and config from `_bmad/<module>/config.yaml`. The Director responds to whatever menus or questions the Worker presents, and says `DONE` when the work is complete.

```bash
# Run from inside a BMAD project
cd my-bmad-project
npx tsx /path/to/talkative/src/index.ts \
  --director \
  --seed "Run the PM agent to create a PRD for a task management app"
```

You can point the Worker at a different directory with `--cwd-b`:

```bash
npx tsx /path/to/talkative/src/index.ts \
  --director \
  --cwd-b /path/to/my-bmad-project \
  --seed "Run the architect agent"
```

---

### 3. Builder mode (`--builder`)

An autonomous app-building mode. You describe what you want built, and two agents collaborate to build it — no BMAD setup required.

- **Agent A (Builder Director)** — a non-technical product manager. Breaks the goal into pieces, hands them to the Worker one at a time, answers clarifying questions, and drives the session to completion. Never writes code, never reads files, never asks the Worker what to do next.
- **Agent B (Builder Worker)** — a software engineer with full tool access. Asks clarifying questions before writing code, builds iteratively, and reports back in plain language.

Each run creates an isolated timestamped folder under `output/` where all generated files live.

```bash
npm run dev -- \
  --builder \
  --seed "Build a Node.js HTTP server that responds with Hello World on port 3000"

npm run dev -- \
  --builder \
  --seed "Build a simple to-do list web app with a clean UI"

npm run dev -- \
  --builder \
  --seed "Build a Python CLI tool that fetches and displays weather for a given city"
```

After a run, find the generated project at:

```
output/
  session-2026-04-02T10-30-00-000Z/
    server.js
    package.json
    ...
```

---

## Options

| Flag | Description | Default |
|------|-------------|---------|
| `-s, --seed <prompt>` | The opening message / goal (required) | — |
| `--system-a <prompt>` | Custom system prompt for Agent A | Playful conversationalist |
| `--system-b <prompt>` | Custom system prompt for Agent B | Playful conversationalist |
| `--director` | Enable Director/Worker mode | off |
| `--builder` | Enable Builder mode | off |
| `--cwd-b <path>` | Working directory for Agent B | Current directory |
| `-t, --turns <n>` | Max number of turns before auto-exit | `10` |
| `--timeout <seconds>` | Per-turn timeout | `600` |
| `--claude-path <path>` | Path to the `claude` binary | Auto-detected |

---

## Terminal UI

The TUI shows two side-by-side panels — Agent A on the left (cyan), Agent B on the right (magenta) — with a status bar at the bottom showing the current turn, agent, and elapsed time. Responses stream in real time as they arrive.

**Keyboard shortcuts:**
- `q` / `Escape` / `Ctrl+C` — exit

---

## How it works

- Each agent runs as an independent `claude -p` subprocess with `--output-format stream-json`
- Both agents maintain their own session across turns via `--resume <session-id>`, so each remembers its own conversation history
- Every message passed between agents is prefixed with a role reminder to prevent identity drift over long sessions
- The Director's session always has `--tools ''` (no tools). The Worker's session uses `--dangerously-skip-permissions` for full tool access
- In builder mode, the Worker's cwd is set to the timestamped output folder so all files are created there
- The loop ends when the Director outputs `DONE` or the turn limit is reached

---

## Project structure

```
talkative/
  src/
    index.ts     CLI entry, mode configuration, system prompts
    loop.ts      Turn orchestrator, session management, role reminders
    spawn.ts     Claude subprocess spawner, stream-json parser
    tui.ts       blessed split-screen terminal UI
    types.ts     Config, TurnResult, StreamEvent interfaces
  output/        Generated projects from builder mode runs
  dist/          Compiled JS output
```
