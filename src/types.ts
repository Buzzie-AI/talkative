export interface Config {
  seed: string;
  systemA: string;
  systemB: string;
  turns: number;
  timeoutSecs: number;
  claudePath: string;
  cwdA: string;
  cwdB: string;
}

export interface TurnResult {
  text: string;
  turnNumber: number;
  agent: 'A' | 'B';
  elapsedMs: number;
  stopped: boolean;
}

export interface StreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  event?: {
    type: string;
    delta?: { type: string; text?: string };
  };
  result?: string;
  is_error?: boolean;
}
