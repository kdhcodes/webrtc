// Runs a compat scenario script for one implementation in its own process
// and returns what it printed. Shared by the differential compat tests.
import { execFile } from 'node:child_process';

export interface ScenarioRun {
  /** The scenario's stdout: its results as JSON (or '' if it printed none). */
  stdout: string;
  /** False if the process had to be killed after its results. */
  exitedOnItsOwn: boolean;
  /**
   * The signal @roamhq/wrtc's process died of after printing complete
   * results (it is known to crash on exit), or null.
   */
  crashed: NodeJS.Signals | null;
}

// A failure guard only. Generous because `pnpm test` runs files
// concurrently.
const TIMEOUT_MS = 90_000;
const CRASHES: string[] = ['SIGSEGV', 'SIGBUS', 'SIGABRT'];

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

export function runScenario(scenario: string, impl: 'wrtc' | 'ours'): Promise<ScenarioRun> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [scenario, impl],
      { timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) return resolve({ stdout, exitedOnItsOwn: true, crashed: null });
        const e = error as { killed?: boolean; code?: unknown; signal?: NodeJS.Signals | null };
        // Killed by our timeout: the caller decides whether the results it
        // printed first count.
        if (e.killed) return resolve({ stdout, exitedOnItsOwn: false, crashed: null });
        // wrtc only: a crash after printing complete results doesn't void them.
        if (impl === 'wrtc' && e.signal && CRASHES.includes(e.signal) && isJson(stdout)) {
          return resolve({ stdout, exitedOnItsOwn: true, crashed: e.signal });
        }
        reject(
          new Error(
            `the ${impl} scenario failed (exit code ${e.code}, signal ${e.signal}, ` +
              `killed ${e.killed}); stdout: ${stdout.length} bytes, ending ` +
              `${JSON.stringify(stdout.slice(-200))}\nstderr:\n${stderr}`,
          ),
        );
      },
    );
  });
}
