import { Command } from 'commander';
import { execSync } from 'child_process';
import * as path from 'path';
import * as tui from './tui';
import { runLoop } from './loop';
import { Config } from './types';

const DEFAULT_SYSTEM_A = `You are Agent A in a back-and-forth conversation with Agent B. Reply with exactly one short sentence. Be playful and keep the rally going.`;

const DEFAULT_SYSTEM_B = `You are Agent B in a back-and-forth conversation with Agent A. Reply with exactly one short sentence. Be playful and keep the rally going.`;

const DIRECTOR_SYSTEM =
`You are a Director. You communicate only in plain text — you have no tools and cannot execute anything yourself.

You are directing Agent B, a Claude Code Worker that runs inside a software project. Agent B has full tool access and will execute your instructions.

Rules:
- Output only the next instruction or answer for Agent B. Nothing else.
- One instruction at a time. Keep it short and specific.
- When Agent B reports back, read its output and give the next instruction.
- When Agent B asks a question, answer it directly.
- When the goal is complete, output only: DONE`;

const WORKER_SYSTEM =
`You are a Worker agent operating inside a software project. You are being operated by a Director agent (Agent A) that will send you instructions one at a time.

Rules:
- Execute each instruction using your available tools (Bash, Read, Edit, Write, etc.) and any BMAD agents available in this project.
- After completing each instruction, report back concisely: what you did and what (if anything) you need the Director to decide or clarify.
- If you need input to proceed, ask a single clear question.
- Do not wait for confirmation — act on the instruction and report back.`;

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

  // In director mode, override system prompts and default cwd-b to cwd
  const cwdA = process.cwd();
  const cwdB = opts.cwdB ? path.resolve(opts.cwdB) : process.cwd();

  const systemA = opts.director ? DIRECTOR_SYSTEM : opts.systemA;
  const systemB = opts.director ? WORKER_SYSTEM   : opts.systemB;

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
    skipPermissionsB: opts.director ? true : false,
  };

  tui.initTui();

  // Update panel labels in director mode
  if (opts.director) {
    tui.setLabels('Director', `Worker (${path.basename(cwdB)})`);
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
