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
  onChunk: (text: string) => void;
}

export interface RunClaudeResult {
  text: string;
  sessionId: string;
}

export function runClaude(opts: RunClaudeOptions): Promise<RunClaudeResult> {
  return new Promise((resolve, reject) => {
    const { claudePath, systemPrompt, inputText, timeoutMs, sessionId, cwd, skipPermissions, onChunk } = opts;

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

    if (sessionId) {
      // Resume existing session — Claude maintains full history
      args.push('--resume', sessionId);
    } else {
      // First turn — start fresh session with system prompt
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

        // Stream text chunks
        if (
          parsed.type === 'stream_event' &&
          parsed.event?.type === 'content_block_delta' &&
          parsed.event.delta?.type === 'text_delta' &&
          typeof parsed.event.delta.text === 'string'
        ) {
          fullText += parsed.event.delta.text;
          onChunk(parsed.event.delta.text);
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
