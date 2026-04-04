import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

async function run(): Promise<void> {
  console.log('Starting role-check test...\n');

  const outputBase = path.resolve(__dirname, '..', 'output');
  const before = new Set(fs.existsSync(outputBase) ? fs.readdirSync(outputBase) : []);

  await new Promise<void>((resolve, reject) => {
    const proc = spawn('npx', [
      'tsx', 'src/index.ts',
      '--builder',
      '--turns', '12',
      '--seed', 'I want a program that prints the number 1. Then I want it to also print 2. Then also print 3.',
    ], { cwd: path.resolve(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] });

    proc.stdout.on('data', (d: Buffer) => process.stdout.write(d));
    proc.stderr.on('data', (d: Buffer) => process.stderr.write(d));
    proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`talkative exited with code ${code}`)));
  });

  // Find the new session folder created during this run
  const after = fs.readdirSync(outputBase).filter(d => !before.has(d));
  if (after.length === 0) throw new Error('FAIL: No output session folder was created');
  const sessionDir = path.join(outputBase, after[after.length - 1]);
  console.log(`\nSession folder: ${sessionDir}`);

  // Verify files were created
  const files = fs.readdirSync(sessionDir);
  if (files.length === 0) throw new Error('FAIL: No files created in session folder');
  console.log(`Files created: ${files.join(', ')}`);

  // Find and run the produced program
  const runnable = files.find(f => f.endsWith('.js') || f.endsWith('.py') || f.endsWith('.ts'));
  if (!runnable) {
    console.log('SKIP: No runnable file found — manual inspection required');
    return;
  }

  const ext = path.extname(runnable);
  const cmd = ext === '.py' ? `python3 "${runnable}"` : `node "${runnable}"`;
  let programOutput: string;
  try {
    programOutput = execSync(cmd, { cwd: sessionDir, encoding: 'utf8' });
  } catch (e: unknown) {
    throw new Error(`FAIL: Program crashed — ${e instanceof Error ? e.message : String(e)}`);
  }

  console.log(`\nProgram output:\n${programOutput.trim()}\n`);

  if (!programOutput.includes('1')) throw new Error('FAIL: Program did not print 1');
  if (!programOutput.includes('2')) throw new Error('FAIL: Program did not print 2');
  if (!programOutput.includes('3')) throw new Error('FAIL: Program did not print 3');

  console.log('✓ Program prints 1, 2, and 3');
  console.log('✓ Role-check test passed');
}

run().catch(err => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
