import blessed from 'blessed';

let screen: blessed.Widgets.Screen;
let boxA: blessed.Widgets.ScrollableBoxElement;
let boxB: blessed.Widgets.ScrollableBoxElement;
let statusBar: blessed.Widgets.BoxElement;
let contentA = '';
let contentB = '';

export function initTui(): void {
  screen = blessed.screen({ smartCSR: true, title: 'talkative' });

  boxA = blessed.scrollablebox({
    parent: screen,
    label: ' Agent A ',
    left: 0,
    top: 0,
    width: '50%',
    height: '90%',
    border: { type: 'line' },
    style: { border: { fg: 'cyan' }, label: { fg: 'cyan', bold: true } },
    scrollable: true,
    alwaysScroll: true,
    wrap: true,
    tags: true,
    scrollbar: { ch: ' ', style: { bg: 'cyan' } },
  });

  boxB = blessed.scrollablebox({
    parent: screen,
    label: ' Agent B ',
    left: '50%',
    top: 0,
    width: '50%',
    height: '90%',
    border: { type: 'line' },
    style: { border: { fg: 'magenta' }, label: { fg: 'magenta', bold: true } },
    scrollable: true,
    alwaysScroll: true,
    wrap: true,
    tags: true,
    scrollbar: { ch: ' ', style: { bg: 'magenta' } },
  });

  statusBar = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: '100%',
    height: '10%',
    border: { type: 'line' },
    style: { border: { fg: 'white' }, fg: 'white', bg: 'black' },
    tags: true,
    content: ' Press {bold}q{/bold} or {bold}Ctrl+C{/bold} to exit',
  });

  screen.key(['q', 'escape', 'C-c'], () => {
    screen.destroy();
    process.exit(0);
  });

  screen.render();
}

export function setLabels(labelA: string, labelB: string): void {
  boxA.setLabel(` ${labelA} `);
  boxB.setLabel(` ${labelB} `);
  screen.render();
}

export function appendA(text: string): void {
  contentA += text;
  boxA.setContent(contentA);
  boxA.setScrollPerc(100);
  screen.render();
}

export function appendB(text: string): void {
  contentB += text;
  boxB.setContent(contentB);
  boxB.setScrollPerc(100);
  screen.render();
}

export function setThinking(turn: number, agent: 'A' | 'B'): void {
  const color = agent === 'A' ? '{cyan-fg}' : '{magenta-fg}';
  statusBar.setContent(
    ` Turn {bold}${turn}{/bold} | ${color}Agent ${agent}{/} received prompt — {yellow-fg}thinking...{/yellow-fg} | {bold}q{/bold} to exit`
  );
  screen.render();
}

export function setStatus(turn: number, speaker: string, elapsedMs?: number): void {
  const elapsed = elapsedMs != null ? ` (${(elapsedMs / 1000).toFixed(1)}s)` : '';
  const text = speaker === 'done'
    ? ` {green-fg}DONE{/green-fg} — completed ${turn} turn(s). Press {bold}q{/bold} to exit.`
    : ` Turn {bold}${turn}{/bold} | {green-fg}Agent ${speaker} responded${elapsed}{/green-fg} | Press {bold}q{/bold} to exit`;
  statusBar.setContent(text);
  screen.render();
}

export function setError(msg: string): void {
  statusBar.setContent(` {red-fg}ERROR:{/red-fg} ${msg} — Press {bold}q{/bold} to exit`);
  screen.render();
}

export function destroy(): void {
  try { screen.destroy(); } catch { /* ignore */ }
}
