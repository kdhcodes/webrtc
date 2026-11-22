// Waits for the CI workflow (.github/workflows/ci.yml) to have passed on a
// commit, for the release workflow: a version is only built and published
// from a commit CI passed on.
//
//   node scripts/ci-status.mjs [--timeout-minutes N]
//
// Reads GITHUB_REPOSITORY, GITHUB_SHA, GITHUB_TOKEN (with actions: read) and
// GITHUB_API_URL, as a workflow step has them. Succeeds once a CI run of the
// commit has succeeded; fails if every run of it finished otherwise, or if
// none has passed when the timeout (default 90 minutes) is up, e.g. because
// the commit was never pushed to main or a pull request, so CI never ran.

/** What the commit's CI runs (GitHub's workflow run objects) say so far. */
export function verdict(runs) {
  if (runs.some((r) => r.status === 'completed' && r.conclusion === 'success')) return 'success';
  if (runs.length === 0 || runs.some((r) => r.status !== 'completed')) return 'pending';
  return 'failure';
}

/**
 * Polls fetchRuns until the verdict is final or timeoutMs has passed;
 * resolves to 'success', 'failure' or 'timeout'.
 */
export async function waitForCi({ fetchRuns, sleep, now, timeoutMs, intervalMs, log }) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const runs = await fetchRuns();
    const result = verdict(runs);
    if (result !== 'pending') return result;
    if (now() >= deadline) return 'timeout';
    log(
      runs.length
        ? `CI is still running (${runs.map((r) => r.html_url).join(', ')}); waiting`
        : 'no CI run for this commit yet; waiting',
    );
    await sleep(intervalMs);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--timeout-minutes');
  const minutes = i >= 0 ? Number(args[i + 1]) : 90;
  const { GITHUB_REPOSITORY: repo, GITHUB_SHA: sha, GITHUB_TOKEN: token } = process.env;
  const api = process.env.GITHUB_API_URL || 'https://api.github.com';
  if (!repo || !sha || !token || !(minutes >= 0)) {
    console.error(
      'usage: GITHUB_REPOSITORY=o/r GITHUB_SHA=<commit> GITHUB_TOKEN=... ' +
        'node scripts/ci-status.mjs [--timeout-minutes N]',
    );
    process.exit(2);
  }
  const url = `${api}/repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=100`;
  const fetchRuns = async () => {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) throw new Error(`GET ${url}: ${response.status} ${await response.text()}`);
    return (await response.json()).workflow_runs;
  };
  const result = await waitForCi({
    fetchRuns,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    timeoutMs: minutes * 60_000,
    intervalMs: 30_000,
    log: (line) => console.log(`ci-status: ${line}`),
  });
  if (result === 'success') {
    console.log(`ci-status: CI passed on ${sha}`);
    return;
  }
  console.error(
    result === 'failure'
      ? `ci-status: CI failed on ${sha}; fix it on main and tag a commit CI passed on`
      : `ci-status: no CI run passed on ${sha} within ${minutes} minutes; ` +
          'was the commit pushed to main before it was tagged?',
  );
  process.exit(1);
}

if (import.meta.main) await main();
