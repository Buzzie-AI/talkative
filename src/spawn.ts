import { spawn as spawnProc } from 'child_process';
import { StreamEvent } from './types';

export interface RunClaudeOptions {
  claudePath: string;
  systemPrompt: string;
  inputText: string;
  timeoutMs: number;
  sessionId: string | null;   // null = first turn (new session)
  cwd: string;
  skipPermissions: boolean;
  noSessionPersistence?: boolean;
  onChunk: (text: string) => void;
}

export interface RunClaudeResult {
  text: string;
  sessionId: string;
}

export function runClaude(opts: RunClaudeOptions): Promise<RunClaudeResult> {
  return new Promise((resolve, reject) => {
    const { claudePath, systemPrompt, inputText, timeoutMs, sessionId, cwd, skipPermissions, noSessionPersistence, onChunk } = opts;

    const args = [
      '-p',
      '--verbose',
      '--output-format', 'stream-json',
      '--include-partial-messages',
    ];

    if (skipPermissions) {
      args.push('--dangerously-skip-permissions');
    } else {
      // No tools for the Director — it must only produce text, never execute
      args.push('--tools', '');
    }

    if (noSessionPersistence) {
      args.push('--no-session-persistence');
    }

    if (sessionId && !noSessionPersistence) {
      // Resume existing session — Claude maintains full history
      args.push('--resume', sessionId);
    } else {
      // First turn, or session persistence disabled — start fresh with system prompt
      args.push('--system-prompt', systemPrompt);
    }

    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env['CLAUDECODE'];
    delete env['CLAUDE_CODE_ENTRYPOINT'];
    delete env['CLAUDE_CODE_SESSION_ID'];
    delete env['CLAUDE_CODE_VERSION'];

    const proc = spawnProc(claudePath, args, {
      env,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let fullText = '';
    let stderrBuf = '';
    let capturedSessionId = sessionId ?? '';
    let settled = false;
    let lineBuffer = '';

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill('SIGTERM');
        reject(new Error(`Claude timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    proc.stdin.write(inputText);
    proc.stdin.end();

    proc.stdout.on('data', (chunk: Buffer) => {
      lineBuffer += chunk.toString('utf8');
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed: StreamEvent;
        try {
          parsed = JSON.parse(trimmed) as StreamEvent;
        } catch {
          continue;
        }

        // Grab session ID from the init event on first turn
        if (parsed.type === 'system' && parsed.subtype === 'init' && parsed.session_id) {
          capturedSessionId = parsed.session_id;
        }

        if (parsed.type === 'stream_event') {
          const ev = parsed.event;
          if (!ev) continue;

          // Text response streaming
          if (
            ev.type === 'content_block_delta' &&
            ev.delta?.type === 'text_delta' &&
            typeof ev.delta.text === 'string'
          ) {
            fullText += ev.delta.text;
            onChunk(ev.delta.text);
          }

          // Show tool name as it starts (gives live feedback during long tool calls)
          if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
            onChunk(`\n⚙ ${ev.content_block.name ?? 'tool'}…\n`);
          }
        }

        // Tool result — show a one-line summary of what the tool returned
        if (parsed.type === 'user' && Array.isArray(parsed.message?.content)) {
          for (const block of parsed.message.content) {
            if (block.type === 'tool_result') {
              const preview = typeof block.content === 'string'
                ? block.content.slice(0, 120).replace(/\n/g, ' ')
                : '';
              if (preview) onChunk(`  → ${preview}\n`);
            }
          }
        }
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;

      if (code !== 0 && code !== null) {
        reject(new Error(`Claude exited with code ${code}. stderr: ${stderrBuf.slice(0, 800)}`));
      } else if (!capturedSessionId) {
        reject(new Error(`No session ID received. stderr: ${stderrBuf.slice(0, 800)}`));
      } else {
        resolve({ text: fullText.trim(), sessionId: capturedSessionId });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}
