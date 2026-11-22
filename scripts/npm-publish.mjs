// Publishes the tarballs scripts/package.sh made: the platform packages
// first, then the main package, so the main package's optionalDependencies
// exist by the time anyone can install it. A version that's already in the
// registry is skipped, so a rerun after a partial failure publishes the rest.
//
//   node scripts/npm-publish.mjs [--dry-run] [--no-provenance] <dir with the .tgz files>
//
// Each goes out with `npm publish <tarball> --access public --provenance`
// (--tag next for a prerelease version such as 0.2.0-rc.1). In CI
// (.github/workflows/release.yml) npm authenticates by trusted publishing
// (OIDC); provenance needs that too, so publishing from a laptop takes
// --no-provenance and an `npm login`. NPM names the npm to run (tests).
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The package.json inside a tarball. */
export function readManifest(tarball) {
  const tar = spawnSync('tar', ['-xOzf', tarball, 'package/package.json'], { encoding: 'utf8' });
  if (tar.status !== 0)
    throw new Error(`can't read package/package.json in ${tarball}: ${tar.stderr}`);
  return JSON.parse(tar.stdout);
}

/**
 * The tarballs in publishing order: the platform packages (those with an
 * `os` field), then the main package. Fails unless there's exactly one main
 * package and every platform package it depends on is there, at its version.
 */
export function plan(packages) {
  const mains = packages.filter((p) => !p.manifest.os);
  if (mains.length !== 1) {
    throw new Error(
      `expected one main package (no "os" field), found ${mains.length}: ` +
        mains.map((p) => p.manifest.name).join(', '),
    );
  }
  const [main] = mains;
  const platforms = packages
    .filter((p) => p.manifest.os)
    .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
  const deps = {
    ...main.manifest.optionalDependencies,
    ...main.manifest.peerDependencies,
  };
  for (const [name, version] of Object.entries(deps)) {
    const found = platforms.find((p) => p.manifest.name === name);
    if (!found) throw new Error(`${main.manifest.name} depends on ${name}, which has no tarball`);
    if (found.manifest.version !== version) {
      throw new Error(
        `${main.manifest.name} depends on ${name}@${version}, but its tarball is ${found.manifest.version}`,
      );
    }
  }
  return [...platforms, main];
}

/** Whether name@version is in the registry; throws on anything but a 404. */
export function isPublished(npm, name, version) {
  const view = spawnSync(npm, ['view', `${name}@${version}`, 'version'], { encoding: 'utf8' });
  if (view.status === 0) return view.stdout.trim() !== '';
  if (/E404|404 Not Found/.test(view.stderr)) return false;
  throw new Error(`npm view ${name}@${version} failed:\n${view.stderr}`);
}

export function publishArgs(tarball, version, { dryRun = false, provenance = true } = {}) {
  return [
    'publish',
    // Absolute: npm reads a relative "dir/x.tgz" as a GitHub repo shorthand.
    resolve(tarball),
    '--access',
    'public',
    ...(provenance ? ['--provenance'] : []),
    ...(version.includes('-') ? ['--tag', 'next'] : []),
    ...(dryRun ? ['--dry-run'] : []),
  ];
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const provenance = !args.includes('--no-provenance');
  const dirs = args.filter((a) => !a.startsWith('--'));
  if (dirs.length !== 1) {
    console.error(
      'usage: node scripts/npm-publish.mjs [--dry-run] [--no-provenance] <dir with the .tgz files>',
    );
    process.exit(2);
  }
  const npm = process.env.NPM || 'npm';
  const packages = readdirSync(dirs[0])
    .filter((f) => f.endsWith('.tgz'))
    .map((f) => {
      const tarball = join(dirs[0], f);
      return { tarball, manifest: readManifest(tarball) };
    });
  for (const { tarball, manifest } of plan(packages)) {
    const spec = `${manifest.name}@${manifest.version}`;
    if (isPublished(npm, manifest.name, manifest.version)) {
      console.log(`npm-publish: ${spec} is already published; skipping it`);
      continue;
    }
    console.log(`npm-publish: publishing ${spec}${dryRun ? ' (dry run)' : ''}`);
    const run = spawnSync(npm, publishArgs(tarball, manifest.version, { dryRun, provenance }), {
      stdio: 'inherit',
    });
    if (run.status !== 0) {
      console.error(`npm-publish: publishing ${spec} failed; rerun to publish the rest`);
      process.exit(1);
    }
  }
}

if (import.meta.main) main();
