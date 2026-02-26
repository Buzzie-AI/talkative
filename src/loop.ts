import { Config } from './types';
import { runClaude } from './spawn';
import * as tui from './tui';

interface HistoryEntry {
  agent: 'A' | 'B';
  text: string;
}

function buildPrompt(history: HistoryEntry[], latestMessage: string, currentAgent: 'A' | 'B'): string {
  const window = history.slice(-6);
  if (window.length === 0) return latestMessage;

  const lines = window.map(h => `Agent ${h.agent}: ${h.text}`).join('\n\n');
  return `Conversation so far:\n${lines}\n\nNow respond as Agent ${currentAgent}:\n---\n${latestMessage}`;
}

export async function runLoop(config: Config): Promise<void> {
  const { seed, systemA, systemB, turns, timeoutSecs, claudePath } = config;
  const timeoutMs = timeoutSecs * 1000;
  const history: HistoryEntry[] = [];
  let lastMessage = seed;
  let completedTurns = 0;

  // Show seed in Agent A's panel as the conversation starter
  tui.appendA(`[Seed] ${seed}\n\n---\n\n`);

  for (let turn = 1; turn <= turns; turn++) {
    // Turn 1 = A responds to seed, turn 2 = B responds to A, turn 3 = A responds to B, ...
    const agent: 'A' | 'B' = turn % 2 === 1 ? 'A' : 'B';
    const systemPrompt = agent === 'A' ? systemA : systemB;
    const append = agent === 'A' ? tui.appendA : tui.appendB;

    tui.setThinking(turn, agent);

    const prompt = buildPrompt(history, lastMessage, agent);
    const turnStart = Date.now();

    let response: string;
    try {
      response = await runClaude({
        claudePath,
        systemPrompt,
        inputText: prompt,
        timeoutMs,
        onChunk: append,
      });
    } catch (err: unknown) {
      tui.setError(`Turn ${turn} (Agent ${agent}): ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const elapsedMs = Date.now() - turnStart;
    completedTurns = turn;

    append('\n\n---\n\n');
    history.push({ agent, text: response });
    lastMessage = response;

    tui.setStatus(turn, agent, elapsedMs);
  }

  tui.setStatus(completedTurns, 'done');
}
