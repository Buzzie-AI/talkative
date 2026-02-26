import { spawn as spawnProc } from 'child_process';
import { StreamEvent } from './types';

export interface RunClaudeOptions {
  claudePath: string;
  systemPrompt: string;
  inputText: string;
  timeoutMs: number;
  onChunk: (text: string) => void;
}

export function runClaude(opts: RunClaudeOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const { claudePath, systemPrompt, inputText, timeoutMs, onChunk } = opts;

    const args = [
      '-p',
      '--verbose',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--no-session-persistence',
      '--system-prompt', systemPrompt,
    ];

    const env: NodeJS.ProcessEnv = { ...process.env };
    // Remove all env vars that Claude uses to detect/block nested sessions
    delete env['CLAUDECODE'];
    delete env['CLAUDE_CODE_ENTRYPOINT'];
    delete env['CLAUDE_CODE_SESSION_ID'];
    delete env['CLAUDE_CODE_VERSION'];

    const proc = spawnProc(claudePath, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let fullText = '';
    let stderrBuf = '';
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

        // Events are wrapped: {"type":"stream_event","event":{"type":"content_block_delta",...}}
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
        reject(new Error(`Claude exited with code ${code}. stderr: ${stderrBuf.slice(0, 500)}`));
      } else {
        resolve(fullText.trim());
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
