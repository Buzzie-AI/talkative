import { Config } from './types';
import { runClaude } from './spawn';
import * as tui from './tui';

export async function runLoop(config: Config): Promise<void> {
  const { seed, systemA, systemB, turns, timeoutSecs, claudePath, cwdA, cwdB, skipPermissionsA, skipPermissionsB, noSessionPersistenceA } = config;
  const timeoutMs = timeoutSecs * 1000;

  let sessionIdA: string | null = null;
  let sessionIdB: string | null = null;

  let lastMessage = seed;
  let completedTurns = 0;

  tui.appendA(`[Seed] ${seed}\n\n---\n\n`);

  for (let turn = 1; turn <= turns; turn++) {
    const agent: 'A' | 'B' = turn % 2 === 1 ? 'A' : 'B';
    const systemPrompt = agent === 'A' ? systemA : systemB;
    const sessionId = agent === 'A' ? sessionIdA : sessionIdB;
    const cwd = agent === 'A' ? cwdA : cwdB;
    const skipPermissions = agent === 'A' ? skipPermissionsA : skipPermissionsB;
    const append = agent === 'A' ? tui.appendA : tui.appendB;

    tui.setThinking(turn, agent);

    const turnStart = Date.now();
    let result: { text: string; sessionId: string };

    try {
      result = await runClaude({
        claudePath,
        systemPrompt,
        inputText: lastMessage,
        timeoutMs,
        sessionId,
        cwd,
        skipPermissions,
        noSessionPersistence: agent === 'A' ? noSessionPersistenceA : undefined,
        onChunk: append,
      });
    } catch (err: unknown) {
      tui.setError(`Turn ${turn} (Agent ${agent}): ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // Store session ID after first turn so subsequent turns resume the same session
    if (agent === 'A') sessionIdA = result.sessionId;
    else sessionIdB = result.sessionId;

    const elapsedMs = Date.now() - turnStart;
    completedTurns = turn;

    if (!result.text) {
      tui.setError(`Turn ${turn} (Agent ${agent}): empty response received (session: ${result.sessionId})`);
      return;
    }

    append('\n\n---\n\n');
    lastMessage = result.text;

    tui.setStatus(turn, agent, elapsedMs);

    // Director signals completion with DONE — exit cleanly after a short pause
    if (agent === 'A' && result.text.toUpperCase().includes('DONE')) {
      tui.setStatus(completedTurns, 'done');
      setTimeout(() => { tui.destroy(); process.exit(0); }, 3000);
      return;
    }
  }

  tui.setStatus(completedTurns, 'done');
  setTimeout(() => { tui.destroy(); process.exit(0); }, 3000);
}
