// Types for scripts/ci-status.mjs, so its test is type-checked.

/** The fields of a GitHub workflow run this reads. */
export interface Run {
  status: string;
  conclusion: string | null;
  html_url?: string;
}

export type Verdict = 'success' | 'failure' | 'pending';

export function verdict(runs: Run[]): Verdict;
export function waitForCi(options: {
  fetchRuns(): Promise<Run[]>;
  sleep(ms: number): Promise<void>;
  now(): number;
  timeoutMs: number;
  intervalMs: number;
  log(line: string): void;
}): Promise<'success' | 'failure' | 'timeout'>;
