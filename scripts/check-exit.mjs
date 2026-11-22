#!/usr/bin/env node
// Runs each test file that can touch the addon under plain `node` (not `node --test`, which
// exits even when handles leak) and fails if one doesn't exit on its own.
// A leaked peer connection or sink keeps the process alive, so this is how
// "every test must close what it opens" is enforced.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Every test file that may create native objects (PCs, sinks, workers):
// integration tests, unit tests colocated under lib/, and the WPT DOM
// shim's tests (its media elements attach sinks).
const dirs = ['lib', 'test/native', 'test/integration', 'test/compat', 'test/wpt'];
const timeoutMs = Number(process.env.CHECK_EXIT_TIMEOUT_MS ?? 60_000);
const files = dirs
  .filter((dir) => existsSync(dir))
  .flatMap((dir) => readdirSync(dir, { recursive: true }).map((f) => join(dir, String(f))))
  .filter((f) => f.endsWith('.test.ts'))
  .sort();

// Lines of a failing file's own output to show, so the failing assertion is
// visible without rerunning it.
const tailLines = 60;

let failed = false;
for (const file of files) {
  const started = Date.now();
  let output = '';
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'inherit'] });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve('timeout');
    }, timeoutMs);
    child.on('exit', (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
  const ms = Date.now() - started;
  if (code === 0) {
    console.log(`ok   ${file} (${ms} ms)`);
  } else {
    failed = true;
    console.log(
      code === 'timeout'
        ? `HANG ${file}: still running after ${timeoutMs} ms (leaked handle?)`
        : `FAIL ${file}: exit code ${code}`,
    );
    const tail = output.trimEnd().split('\n').slice(-tailLines);
    if (tail.length > 0 && tail[0] !== '') {
      console.log(tail.map((line) => `     | ${line}`).join('\n'));
    }
  }
}
process.exit(failed ? 1 : 0);
