import { Command } from 'commander';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as tui from './tui';
import { runLoop } from './loop';
import { Config } from './types';

const DEFAULT_SYSTEM_A = `You are Agent A in a back-and-forth conversation with Agent B. Reply with exactly one short sentence. Be playful and keep the rally going.`;

const DEFAULT_SYSTEM_B = `You are Agent B in a back-and-forth conversation with Agent A. Reply with exactly one short sentence. Be playful and keep the rally going.`;

const DIRECTOR_SYSTEM =
`You are a human user working with a BMAD agent. You have no tools — you only respond in plain text.

The BMAD agent (Agent B) will ask you questions, present menus, or request decisions as it runs its workflow. Your job is to simply answer what it asks — pick options, provide names, confirm choices, give short answers.

Rules:
- Read what Agent B says and respond directly to it. Nothing else.
- Keep answers short — one line if possible.
- Never ask Agent B to verify or summarize what it did. Just answer its questions.
- When Agent B says the work is fully complete and asks nothing further, output only: DONE`;

const WORKER_SYSTEM =
`You are a Worker agent operating inside a software project that has BMAD agents installed under _bmad/.

You are operated by a Director (Agent A) who sends instructions one at a time.

When the Director tells you to use a BMAD agent (e.g. "run the PM agent"):
1. Read the agent file from _bmad/ (e.g. _bmad/bmm/agents/pm.md)
2. Fully embody that agent's persona and follow its activation steps exactly as written in the file
3. Also read _bmad/bmm/config.yaml and load all config variables
4. Execute the agent's workflow autonomously — do not stop to ask the user for menu selections, instead make reasonable choices to progress the task
5. When the workflow completes, report back a concise summary of what was produced and where

For all other instructions:
- Execute using your tools (Bash, Read, Edit, Write, Glob, Grep)
- Report back concisely: what you did, what was produced, and any decision needed from the Director
- Ask at most one question if blocked`;

const BUILDER_DIRECTOR_SYSTEM =
`You are a non-technical product manager directing a software engineer (the Worker) to build something.

You do not write code, commands, file names, or technical instructions of any kind. You speak only in plain business language about what you want — not how to build it.

You have NO tools. You cannot read files, browse directories, or inspect anything on disk. You are completely blind to the codebase. You only know what the Worker tells you in plain English.

Rules:
- Break the goal into small, logical pieces. Give the Worker one piece at a time — do not share the full plan upfront.
- Describe each piece as a desired outcome in plain English, as a PM would to an engineer.
- Never mention code, files, directories, terminals, commands, servers, ports, curl, or any technical term.
- NEVER read files, source code, or anything from disk. Do not say "I'll read X" or "let me check X". You are blind to the filesystem — act accordingly.
- Never ask the Worker what to do next. You drive the conversation — you decide what comes next.
- Never ask clarifying questions about requirements. You know what you want — just say it.
- When the Worker asks you clarifying questions, answer them directly and fully.
- Trust the Worker completely. If the Worker says something is done, it is done — never ask for proof, demos, or verification.
- When the Worker completes a piece, move on to the next one without comment.
- Only when every piece of the goal is accomplished, output exactly: DONE
- Never output DONE mid-task. DONE means everything is finished and the session will close.`;

const BUILDER_WORKER_SYSTEM =
`You are a Worker agent. Your job is to build software exactly as directed.

You have full tool access: Bash, Read, Write, Edit, Glob, Grep etc.

Instructions:
- Before writing any code, ask the Director clarifying questions to fully understand the requirements. Only start building once you have enough clarity.
- Build what the Director asks, creating all files in your current working directory.
- If a server or process needs to run, start it as a background process and verify it works.
- If anything fails, fix it autonomously before reporting back.
- When reporting back to the Director, give only a brief plain-English summary of what was accomplished — like a status update, not a technical report. Never mention file names, paths, tool outputs, code, commands, ports, or implementation details. The Director does not need to know how it was built, only that it is done.`;

function resolveClaudePath(): string {
  try {
    return execSync('which claude', { encoding: 'utf8' }).trim();
  } catch {
    return '/Users/anaidu1/.local/bin/claude';
  }
}

async function main(): Promise<void> {
  const program = new Command();

  program
    .name('talkative')
    .description('Two Claude instances talking to each other')
    .requiredOption('-s, --seed <prompt>', 'Seed topic to start the conversation')
    .option('--system-a <prompt>', 'System prompt for Agent A', DEFAULT_SYSTEM_A)
    .option('--system-b <prompt>', 'System prompt for Agent B', DEFAULT_SYSTEM_B)
    .option('--director', 'Use Director/Worker mode (Agent A directs Agent B)')
    .option('--builder', 'Use Builder mode: Director instructs Worker to build the app described by --seed')
    .option('--cwd-b <path>', 'Working directory for Agent B (used with --director)')
    .option('-t, --turns <number>', 'Max number of turns', '10')
    .option('--timeout <seconds>', 'Per-turn timeout in seconds', '600')
    .option('--claude-path <path>', 'Path to claude CLI', resolveClaudePath())
    .parse(process.argv);

  const opts = program.opts<{
    seed: string;
    systemA: string;
    systemB: string;
    director: boolean;
    builder: boolean;
    cwdB: string | undefined;
    turns: string;
    timeout: string;
    claudePath: string;
  }>();

  const turns = parseInt(opts.turns, 10);
  if (!Number.isInteger(turns) || turns <= 0) {
    console.error('Error: --turns must be a positive integer');
    process.exit(1);
  }

  const timeoutSecs = parseInt(opts.timeout, 10);
  if (!Number.isInteger(timeoutSecs) || timeoutSecs <= 0) {
    console.error('Error: --timeout must be a positive integer');
    process.exit(1);
  }

  // In director/builder mode, override system prompts and default cwd-b to cwd
  // Give Agent A an isolated blank workspace so it cannot discover project source
  // files and its sessions don't accumulate alongside the talkative source project.
  let cwdA = process.cwd();
  if (opts.builder || opts.director) {
    cwdA = path.resolve(__dirname, '..', 'director-workspace');
    fs.mkdirSync(cwdA, { recursive: true });
  }

  // Builder mode: create a timestamped output folder and point cwdB at it
  let builderOutputDir: string | undefined;
  if (opts.builder) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputBase = path.resolve(__dirname, '..', 'output');
    builderOutputDir = path.join(outputBase, `session-${timestamp}`);
    fs.mkdirSync(builderOutputDir, { recursive: true });
  }

  const cwdB = opts.cwdB        ? path.resolve(opts.cwdB)
             : builderOutputDir ? builderOutputDir
             : process.cwd();

  const systemA = opts.director ? DIRECTOR_SYSTEM
                : opts.builder  ? BUILDER_DIRECTOR_SYSTEM
                : opts.systemA;

  const systemB = opts.director ? WORKER_SYSTEM
                : opts.builder  ? `${BUILDER_WORKER_SYSTEM}\n\nYour working directory for this session is: ${cwdB}\nCreate ALL files inside this directory. Do not create files anywhere else.`
                : opts.systemB;

  const config: Config = {
    seed: opts.seed,
    systemA,
    systemB,
    turns,
    timeoutSecs,
    claudePath: opts.claudePath,
    cwdA,
    cwdB,
    skipPermissionsA: false,
    skipPermissionsB: opts.director || opts.builder ? true : false,
    noSessionPersistenceA: opts.director || opts.builder ? true : undefined,
  };

  tui.initTui();

  // Update panel labels in director/builder mode
  if (opts.director) {
    tui.setLabels('Director', `Worker (${path.basename(cwdB)})`);
  }
  if (opts.builder) {
    const folderName = builderOutputDir ? path.basename(builderOutputDir) : 'output';
    tui.setLabels('Builder Director', `Builder Worker (${folderName})`);
  }

  process.on('SIGINT', () => {
    tui.destroy();
    process.exit(0);
  });

  try {
    await runLoop(config);
  } catch (err: unknown) {
    tui.setError(err instanceof Error ? err.message : String(err));
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
