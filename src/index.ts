import { Command } from 'commander';
import { execSync } from 'child_process';
import * as tui from './tui';
import { runLoop } from './loop';
import { Config } from './types';

const DEFAULT_SYSTEM_A = `You are Agent A in a back-and-forth conversation with Agent B. Reply with exactly one short sentence. Be playful and keep the rally going.`;

const DEFAULT_SYSTEM_B = `You are Agent B in a back-and-forth conversation with Agent A. Reply with exactly one short sentence. Be playful and keep the rally going.`;

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
    .option('-t, --turns <number>', 'Max number of turns', '10')
    .option('--timeout <seconds>', 'Per-turn timeout in seconds', '60')
    .option('--claude-path <path>', 'Path to claude CLI', resolveClaudePath())
    .parse(process.argv);

  const opts = program.opts<{
    seed: string;
    systemA: string;
    systemB: string;
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

  const config: Config = {
    seed: opts.seed,
    systemA: opts.systemA,
    systemB: opts.systemB,
    turns,
    timeoutSecs,
    claudePath: opts.claudePath,
  };

  tui.initTui();

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
