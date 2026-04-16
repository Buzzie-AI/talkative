# Talkative: real-time peer delivery via `FileChanged` hook

## Context

Today `channel/node.ts` delivers peer messages by calling `mcp.notification('notifications/claude/channel', ...)`, which Claude Code only honors when launched with `--dangerously-load-development-channels server:network`. The flag is experimental, blocked by org policy in many enterprises, and effectively silent-fails for new users — they can `talk_send` but never *receive*, which defeats the plugin. We need reactive inbound delivery on stock Claude Code with no special flags.

Investigation of the Claude Code binary confirmed:
1. `FileChanged` hooks exist and are backed by chokidar (`za.watch` with `awaitWriteFinish: {stabilityThreshold:500, pollInterval:200}, persistent:true, ignoreInitial:true`).
2. Hooks can return `hookSpecificOutput.watchPaths` as an array of **absolute paths** to dynamically register with the running watcher. Binary docstrings: `watchPaths (array of absolute paths) to dynamically update the watch list.` and `…to register with the FileChanged watcher.`
3. Plugins can ship hooks via `plugin/hooks/hooks.json` (verified against `~/.claude/plugins/marketplaces/claude-plugins-official/plugins/ralph-loop/hooks/hooks.json` and `…/learning-output-style/hooks/hooks.json`).
4. FileChanged matchers are literal basenames, split on `|`, example `.envrc|.env`. No globs.
5. FileChanged hooks "run asynchronously and cannot block actions" and return `additionalContext: string` which is added to Claude's context.

That's everything we need to replace the experimental notification with a reactive file-based trigger that works on stock Claude Code.

## Approach

**Maildir inbox + bump file + three hooks.**

The MCP server drops each inbound peer message as a single file in `~/.talkative/inbox/` (`<ts>-<rand>.json`), then touches a fixed sentinel file `~/.talkative/inbox.bump`. The sentinel has a literal basename (`inbox.bump`), which is the only thing the FileChanged matcher needs.

A `SessionStart` hook ensures the inbox directory and bump file exist, drains anything queued while Claude Code was closed, and returns `hookSpecificOutput.watchPaths: ["${HOME}/.talkative/inbox.bump"]`. Claude Code registers that absolute path with its chokidar watcher at session start.

A `FileChanged` hook with `matcher: "inbox.bump"` fires whenever the MCP server touches the sentinel. It drains the maildir (atomic dir-rename → read all files → unlink), formats the messages as `<channel source="talkative" from="@x">...</channel>` XML, and returns it as `additionalContext`. Claude sees the peer messages folded into its context on the next read.

A `UserPromptSubmit` hook does the same drain as a fallback for any race where `FileChanged` missed something (watcher init latency, system notification coalescing, etc.). 99% of the time the inbox is empty and the hook exits in microseconds.

The `Stop` hook from the earlier email-style plan is **dropped entirely** — FileChanged handles the real-time path, and the risky `decision:block` re-wake is no longer needed. No recursion guard, no rate-limit, no chatty back-and-forth wedge.

**UX framing.** This isn't quite Slack — `additionalContext` from FileChanged is queued asynchronously and won't interrupt Claude mid-sentence; delivery lands on Claude's next context read. That's the same mental model as email-with-push: messages arrive reactively, but Claude processes them at natural turn boundaries rather than mid-stream. For AFK awareness, the status line can optionally show an unread count by `ls`-counting the inbox directory, and the MCP server can optionally emit OS notifications via `osascript`. Both are additions on top of the core delivery path, not replacements.

Result: zero flags, zero manual `settings.json` edits, works unchanged in locked-down orgs, real-time-enough for the "peer pings me while I work" use case. `talk_send`, `talk_peers`, and the full skill surface keep working.

## Critical files

### Modify

- **`/Users/arvindnaidu/myws/talkative/channel/node.ts`** — delete the six `mcp.notification({method:'notifications/claude/channel',...})` call sites (verified / auth_failed / incoming / error / disconnect / connected). Replace each with `writeInbox({from, text, kind})`. Drop `capabilities.experimental['claude/channel']` from the `Server` constructor.
- **`/Users/arvindnaidu/myws/talkative/plugin/.claude-plugin/plugin.json`** — bump version `1.1.0` → `1.2.0`.
- **`/Users/arvindnaidu/myws/talkative/package.json`** — extend the existing `build:plugin` script (presumed esbuild, based on `plugin/channel/node.cjs` shape) with a second entry that bundles `channel/drain.ts` → `plugin/hooks/drain.cjs`. Read the current script first and mirror its options.
- **`/Users/arvindnaidu/myws/talkative/README.md`** — delete the `--dangerously-load-development-channels` paragraph added in commit `2b4de17` (around the Quick Start). Replace with: "Install the plugin, run `/talkative:login you@example.com`, done. No flags required." Keep the development note pointing at the dev command (`claude --plugin-dir ./plugin`) without the experimental flag.
- **`/Users/arvindnaidu/myws/talkative/.mcp.json`** (project dev config) — no behavioral change; `channel/node.ts` is shared source so `writeInbox` runs in dev too. The project-scoped MCP server keeps its name `talkative` and is what the repo's own Claude sessions use for iteration.
- **`/Users/arvindnaidu/myws/talkative/channel/instructions.md`** — review and update any wording that promises real-time channel-tag arrivals. Describe the inbox + hook path in one paragraph so Claude's guidance matches what actually happens.

### Create

- **`/Users/arvindnaidu/myws/talkative/channel/inbox.ts`** — ~30 lines. Exports `writeInbox({from, text, kind})` and the shared path constants (`inboxDir`, `bumpPath`). Implementation:
  ```
  const talkativeDir = join(homedir(), '.talkative');
  const inboxDir = join(talkativeDir, 'inbox');
  const bumpPath = join(talkativeDir, 'inbox.bump');

  export function writeInbox({from, text, kind = 'peer'}) {
    mkdirSync(inboxDir, {recursive: true, mode: 0o700});
    const name = `${Date.now()}-${randomBytes(3).toString('hex')}.json`;
    writeFileSync(join(inboxDir, name), JSON.stringify({from, text, kind, ts: Date.now()}));
    // bump — append-only, same inode, keeps chokidar happy
    appendFileSync(bumpPath, '\n');
  }
  ```
- **`/Users/arvindnaidu/myws/talkative/channel/drain.ts`** — ~150 lines including burst-handling policy. Single script that branches on `process.argv[2]` ∈ {`SessionStart`, `UserPromptSubmit`, `FileChanged`}. Reads hook input JSON from stdin. Logic:
  ```
  1. Ensure talkativeDir, inboxDir, overflowDir, bumpPath all exist. Idempotent.
  2. For SessionStart: truncate inbox.bump to 0 so future touches register as modifications.
  3. Atomic drain: try renameSync(inboxDir, drainDir); catch ENOENT → no new messages.
  4. mkdirSync(inboxDir, {recursive: true}) to reopen for new writes.
  5. Gather candidates = readdirSync(drainDir).map(readJson) concat readdirSync(overflowDir).map(readJson).
     Sort by ts ascending. Delete drainDir.
  6. Apply caps (see Burst handling section):
     - Slice to latest DRAIN_MAX = 20 messages; move the rest back to overflowDir as individual files.
     - Truncate each message.text to PER_MESSAGE_MAX = 500 chars with truncation marker.
     - Group by sender when sender count ≥ 3; render one <channel count=N> tag per grouped sender.
     - Render final XML; if length > CONTEXT_MAX = 12000, drop oldest until it fits (back to overflowDir).
     - Separate system-kind messages from peer messages; system messages bypass all caps and render first.
  7. Enforce OVERFLOW_MAX = 1000: if overflowDir has > 1000 files after step 6, delete the oldest 500 and log a warning.
  8. Build the response object:
     - additionalContext = systemXml + "\n" + peerXml (omit the key entirely when both are empty)
     - hookSpecificOutput.hookEventName = argv[2]
     - hookSpecificOutput.additionalContext as above
     - For SessionStart: always include watchPaths: [bumpPath], even when no messages — this is the registration moment.
     - systemMessage string reflects real counts including overflow (see Burst handling section for wording).
  9. process.stdout.write(JSON.stringify(out)); process.exit(0). Wrap the whole thing in try/catch that
     logs to ~/.talkative/drain.log and still emits a valid-shape JSON on error (empty additionalContext,
     watchPaths preserved on SessionStart).
  ```
  Implementation notes:
  - `esc()` escapes `<`, `>`, `&`, and double quotes so peer-controlled content can't forge closing tags or inject malformed XML.
  - Zero deps — `fs`, `os`, `path`, `crypto` from stdlib only so the bundled drain.cjs is tiny.
  - Drain ordering race: if a new message file lands between `renameSync(inboxDir, drainDir)` and the subsequent `mkdirSync(inboxDir)`, the write hits ENOENT inside writeInbox — writeInbox's own `mkdirSync(inboxDir, {recursive:true})` handles that case (it runs on every call, not once), so no loss. Document the invariant: **writeInbox always `mkdir -p` before writing.**
  - FileChanged fires on the bump file, not the maildir, so timing-wise: MCP server writes message file → appends to bump → chokidar sees bump change → 500ms `awaitWriteFinish` → hook runs → reads maildir. The message file is guaranteed to be on disk before the hook runs because the MCP server writes it synchronously *before* touching the bump.
  - Caps are `const` at the top of the file. No env vars, no config file — the point is to tune them in one place and redeploy.
- **`/Users/arvindnaidu/myws/talkative/plugin/hooks/hooks.json`** — new file. Registers all three hook events. Shape mirrors the verified `ralph-loop/hooks/hooks.json`:
  ```json
  {
    "description": "Talkative inbox watcher — drains ~/.talkative/inbox into the session",
    "hooks": {
      "SessionStart": [{"hooks":[{"type":"command","command":"node \"${CLAUDE_PLUGIN_ROOT}/hooks/drain.cjs\" SessionStart"}]}],
      "UserPromptSubmit": [{"hooks":[{"type":"command","command":"node \"${CLAUDE_PLUGIN_ROOT}/hooks/drain.cjs\" UserPromptSubmit"}]}],
      "FileChanged": [{"matcher":"inbox.bump","hooks":[{"type":"command","command":"node \"${CLAUDE_PLUGIN_ROOT}/hooks/drain.cjs\" FileChanged"}]}]
    }
  }
  ```
- **`/Users/arvindnaidu/myws/talkative/plugin/hooks/drain.cjs`** — generated by the build step. Do not hand-author.
- **`/Users/arvindnaidu/myws/talkative/plugin/channel/node.cjs`** — regenerated by the existing build step after `channel/node.ts` is edited.

### Delete — nothing

We keep everything else as-is, including the `network` server name in `plugin/.mcp.json`.

## Gotchas

1. **Bump file writes must not replace the inode.** chokidar watches the inode of a single file. Use `fs.appendFileSync(bumpPath, '\n')` — appending a byte keeps the same inode and fires `change` reliably. Do NOT use `writeFileSync` or atomic-rename on the bump path: those replace the inode and chokidar stops firing. `drain.ts` truncates the bump file on SessionStart to bound its size, and that's a same-inode operation via `ftruncate`.
2. **`ignoreInitial: true` means the initial state of the bump file is not fired.** SessionStart is the one chance to drain anything queued during downtime. Implement step 2 of `drain.ts` above carefully.
3. **watchPaths registration happens in SessionStart's return.** If SessionStart fails (crash, permission error), FileChanged never fires because the watch path is never added. Make `drain.ts` bulletproof: wrap everything in try/catch, log to `~/.talkative/drain.log`, and still emit a valid JSON response on error (empty `additionalContext`, always include `watchPaths: [bumpPath]` on SessionStart).
4. **FileChanged fires while Claude is mid-turn.** Docs say "cannot block actions" — the hook does not interrupt Claude. The `additionalContext` is queued; whether it reaches Claude the same turn or the next is empirically untested. Treat it as "next turn at latest."
5. **UserPromptSubmit fallback is not redundant.** If the FileChanged watcher fails silently (e.g. FS event coalescing), UserPromptSubmit will still drain on every user action. Both hooks drain the same maildir via the same atomic rename, so whichever drains first wins and the other becomes a no-op — no duplication.
6. **Drain script locking is unnecessary.** Maildir + atomic `rename` on `inboxDir` → `drainDir` is the concurrency primitive. Two drain processes racing each other: first one's rename succeeds, second's rename fails with ENOENT, second logs "nothing to drain" and exits. Zero messages lost, zero duplicated.
7. **System banners** (connected / auth_failed / disconnect) route through `writeInbox({kind:'system', from:'talkative', text:…})`. `drain.ts` renders them with `source="talkative-system"` so `instructions.md` can tell Claude to treat them as diagnostics rather than peer messages. Today these arrive via the experimental notification at six call sites in `channel/node.ts`; every one of them switches to `writeInbox`.
8. **Content escaping.** Peer `text` is attacker-controlled — another instance can send `</channel><script>evil</script>`. `esc()` in `drain.ts` must neutralize `<`, `>`, `&`, and `"`. Plain HTML-entity encoding is enough; Claude reads the text content, the XML wrapping is just for framing.
9. **Dev-loop double-registration.** The repo's own `.mcp.json` runs `tsx channel/node.ts` and registers server name `talkative`; the installed plugin registers `network`. In a repo-local session, both MCP servers run, both hold WebSockets, both call `writeInbox` on the same `~/.talkative/inbox/`. The atomic-rename drain handles concurrent writes correctly, so this is harmless as long as both register with the same handle. Worth noting in the dev docs; no code change.
10. **Plugin `plugin.json` schema.** Adding `hooks/` is not a schema change — `ralph-loop` and `learning-output-style` both ship `hooks/hooks.json` without declaring it in `plugin.json`. No version field update required, but we bump to 1.2.0 because behavior is meaningfully different.

## Burst handling & context budget

Channels were a Slack metaphor: one event, one interrupt. Talkative is an email metaphor: durability, ordering, batching, replay. That means `drain.ts` must handle the realistic bad case — 50+ messages queued while the user was at lunch — without exploding Claude's context window or interrupting Claude mid-thought with noise.

**Caps and policy** (all enforced in `drain.ts`):

1. **Per-drain message cap: `DRAIN_MAX = 20`.** Drain reads all files from `.draining/` and sorts chronologically, then slices to the 20 most recent. The remaining older messages are moved to `~/.talkative/inbox/.overflow/` (one file each, same format) instead of being deleted. They survive across drains and sessions and are accessible via the `talk_read` tool (see stretch goal below).
2. **Per-drain character cap: `CONTEXT_MAX = 12000`.** Even 20 messages can blow context if each is a 10KB code dump. After slicing to 20, truncate each message's `text` to `PER_MESSAGE_MAX = 500` characters with a `… (truncated, <N> chars more)` suffix. If the combined `additionalContext` still exceeds 12000 characters, drop oldest messages from the batch until it fits, move them to `.overflow/`.
3. **Per-sender grouping** when a sender has ≥ 3 messages in the drained batch. Instead of emitting three separate `<channel>` tags for `@alice`, emit one:
   ```xml
   <channel source="talkative" from="@alice" count="3">
   [ts1] first message
   [ts2] second message
   [ts3] third message
   </channel>
   ```
   Senders with 1–2 messages render one tag per message (the base case). This keeps per-sender bursts coherent to Claude while leaving single-ping messages unchanged.
4. **Always-accurate `systemMessage`.** The toast/banner reflects the *real* count including truncated and overflowed messages, not the drained count:
   - All fit: `📬 4 peer message(s)`
   - Some overflowed: `📬 50 peer messages — showing 20, 30 queued (talk_read to view)`
   - Character-budget trimmed: `📬 20 peer messages — showing 14, 6 queued (talk_read to view)`
5. **Overflow dir is drained first.** On each drain, older messages in `.overflow/` get a chance to promote into the next batch (oldest-first) before new messages are added. This prevents an "ever-growing backlog" where `.overflow/` keeps all the old and only fresh messages ever get surfaced. Concretely: drain reads `.overflow/*.json` + `.draining/*.json`, sorts all together by timestamp, applies caps, and writes back to `.overflow/` anything that didn't fit.
6. **Hard floor on overflow size: `OVERFLOW_MAX = 1000 messages`.** If `.overflow/` ever reaches 1000 files, the drain script deletes the oldest 500 and logs a warning. This bounds disk usage under adversarial / runaway conditions. In practice no one hits this — it's a safety net.
7. **System banners bypass all caps.** Messages with `kind:'system'` (connected / auth_failed / disconnect) are always delivered in full, never truncated, never overflowed. They're diagnostic and small. Render them separately from peer messages, grouped at the top of the batch.

### Stretch: `talk_read` MCP tool

The drain script only shows headlines when the inbox is bursting. Claude should be able to read the bodies on demand. Add a `talk_read` tool to the MCP server in `channel/node.ts`:

```
talk_read({limit?: number, since?: timestamp, from?: handle}) → {messages: [...], total: N}
```

Reads from `~/.talkative/inbox/.overflow/` (and optionally archives them to `~/.talkative/archive/<YYYY-MM>/` after read, so they don't keep appearing). This makes the UX feel like an email client: drain gives you the summary, `talk_read` gives you the full bodies. Claude can invoke it naturally — "show me what @alice sent while I was out" maps to `talk_read({from: '@alice'})`.

This tool is not required for the FileChanged delivery path to work. Treat it as a follow-up PR unless the initial implementation reveals that Claude struggles with truncated messages. Mark as P1, not P0.

### Why these specific numbers

- `DRAIN_MAX = 20`: empirical — 20 short messages render in ~2KB of XML, well under any reasonable context budget. Higher starts to bog down Claude's attention on the injected content relative to the user's actual prompt.
- `PER_MESSAGE_MAX = 500`: fits a paragraph or two of chat. Longer content is almost always a code paste and should be read via `talk_read` rather than dumped into context. 500 chars ≈ 125 tokens, so 20 × 500 = 10KB, ~2.5K tokens — safe.
- `CONTEXT_MAX = 12000`: ~3000 tokens — large enough for 20 full-bodied messages with headers, small enough to never be a meaningful fraction of a 200K or 1M context window.
- `OVERFLOW_MAX = 1000`: runaway safety net. 1000 × 500 = 500KB on disk, still trivial.

All four are `const` at the top of `drain.ts` — tunable in one place without touching logic.

## Verification

1. **Build.** `npm run build:plugin` (or whatever the script is called). Confirm `plugin/channel/node.cjs` and `plugin/hooks/drain.cjs` both exist and the drain bundle is < 50KB (no stdlib noise).
2. **Smoke the drain script in isolation.** `mkdir -p ~/.talkative/inbox && echo '{"from":"@test","text":"hello","kind":"peer","ts":1}' > ~/.talkative/inbox/0001-a.json && echo '{}' | node plugin/hooks/drain.cjs UserPromptSubmit`. Expect JSON on stdout with `additionalContext` containing `<channel source="talkative" from="@test">hello</channel>`. Inbox dir should be empty afterwards.
3. **Local plugin install.** Use the existing `claude --plugin-dir ./plugin` dev path from `README.md:73` but **without** `--dangerously-load-development-channels`. Temporarily rename `/Users/arvindnaidu/myws/talkative/.mcp.json` → `.mcp.json.bak` so only the plugin path is exercised (avoids double-WS confusion for this test).
4. **Smoke test — tools still work.** `/talkative:login arvind.raj.naidu@gmail.com`, complete email verification. Confirm the `connected` system banner arrives as a `<channel source="talkative-system">` tag in the session — that proves FileChanged is firing.
5. **Golden path — FileChanged reactive delivery.** Second terminal, second `claude --plugin-dir ./plugin` session, log in as a different handle. From terminal 2: trigger `talk_send @handle1 "ping 1"` via a natural prompt. In terminal 1, without typing anything, watch for the message to appear. If it arrives while Claude is idle between turns → real-time delivery confirmed. If it only appears on your next prompt → FileChanged `additionalContext` is being queued until next turn. Either is acceptable; document which is actual behavior.
6. **UserPromptSubmit fallback.** Rename `plugin/hooks/hooks.json` to strip the `FileChanged` entry, keeping only `SessionStart` and `UserPromptSubmit`. Repeat step 5. Messages should still drain on every user prompt, proving the fallback works independently.
7. **SessionStart drain.** Close terminal 1. From terminal 2: `talk_send @handle1 "offline message"`. Start terminal 1. The opening context (Claude's first response) should reference the queued message via `additionalContext` from SessionStart.
8. **Burst ordering.** From terminal 2: send three messages in rapid succession (`for i in 1 2 3; do talk_send @handle1 "burst $i"; sleep 0.1; done`). Confirm all three arrive in terminal 1 in order. chokidar's `awaitWriteFinish` may coalesce multiple bump appends into one FileChanged event, but the drain reads the entire maildir each time, so no messages are lost.
8a. **Burst cap + overflow.** Script-write 50 message files directly into `~/.talkative/inbox/` with staggered timestamps, then touch the bump file once. Confirm: (a) FileChanged fires once, (b) drain emits 20 messages in `additionalContext`, (c) `~/.talkative/inbox/.overflow/` contains the remaining 30 files, (d) `systemMessage` reads `📬 50 peer messages — showing 20, 30 queued`. Then trigger a second drain (touch the bump again): confirm the *oldest 20 from overflow* are promoted into the next batch, not the newest 20.
8b. **Per-sender grouping.** Script-write 5 messages from `@alice` and 1 from `@bob` to the inbox. Drain. Expect `additionalContext` to contain exactly two `<channel>` tags: one `<channel ... from="@alice" count="5">` with all 5 messages inside, and one single-line `<channel ... from="@bob">` for bob.
8c. **Oversized message truncation.** Script-write one message with a 5000-char `text` field. Drain. Expect the rendered `<channel>` tag to contain ~500 chars followed by `… (truncated, 4500 chars more)`. Confirm the original file was deleted, not preserved — the truncation is one-way by design (if Claude wants the full body, it calls `talk_read` in the stretch version).
8d. **System banners bypass caps.** Script-write 20 peer messages and 2 system banners (`kind: 'system'`). Drain. Confirm both system banners render in full as `<channel source="talkative-system">` tags at the top of the batch, and the 20 peer messages fill the remaining budget. If peer messages had to overflow to make room for system banners, confirm the overflow behavior is documented in `systemMessage`.
9. **Log inspection.** `tail -f ~/.talkative/node.log ~/.talkative/drain.log` during tests. Between drains, `ls ~/.talkative/inbox/` should be empty. If files accumulate after step 5 or 6, the hook isn't firing — run `claude --debug` and check hook invocation output.
10. **Flag-free sanity check.** Confirm `claude --plugin-dir ./plugin` launches without any experimental-feature warnings in stdout/stderr. Confirm `strings` of the running session never mentions `dangerously-load-development-channels`.
11. **Org-policy equivalent.** Set `CLAUDE_DISABLE_DEV_CHANNELS=1` (if such an env var exists — check the binary) or manually verify that the plugin works when the dev-channels flag is unavailable. This is the production scenario.
12. **Dev-loop sanity.** Restore the project `.mcp.json`, launch `claude` from the repo (no `--plugin-dir`), confirm the project-scoped `talkative` server starts and writes to the same inbox. For the hook path to fire in the repo session, symlink `plugin/hooks` → `.claude/hooks` in the repo and add a matching block to repo `.claude/settings.json` pointing at `tsx channel/drain.ts`; or just test against the installed plugin path in step 3.

## Riskiest unknown

**Exact timing of FileChanged `additionalContext` delivery.** The docs say the hook "cannot block actions" and the binary shows `ignoreInitial:!0, awaitWriteFinish:{stabilityThreshold:500}` — so we know the hook runs 500ms+ after the bump event on its own thread. What's untested is whether the `additionalContext` it returns is:
- (a) injected into Claude's active context immediately (live streaming), causing Claude to see peer messages mid-turn;
- (b) queued in a pending-context buffer and folded in on Claude's next context read (effectively: next turn);
- (c) discarded if no user prompt or tool result arrives within some window.

(a) is the best case and makes this identical to today's experimental channels. (b) is still a massive win — real-time from the user's perspective (status line / systemMessage toast) even if Claude only sees content on its next turn. (c) would be a blocker.

Step 5 of verification is the moment of truth. If (c), we pivot to stashing messages in a session-local file and using `additionalContext` only as a "you have N unread — call the `talk_read` MCP tool" pointer. That's a fallback design, not needed unless (c) is real.

**Mitigation if timing is worse than expected.** The `UserPromptSubmit` fallback already covers the case where Claude only reads messages on explicit prompts. The `systemMessage` field from FileChanged (`📬 2 peer message(s)`) is a visible toast regardless of `additionalContext` timing — the user always sees "you have mail" in real time. So even worst-case, the UX is: toast fires live, content injects on next turn. That's a usable chat experience.
