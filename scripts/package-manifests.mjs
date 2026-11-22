// The package.json files of the packages scripts/package.sh assembles: the
// main package and one per platform, derived from the repo's package.json.
//
//   node scripts/package-manifests.mjs <stage dir> <native build id> "<all triples>" [<present triple>...]
//
// writes <stage>/main/package.json and <stage>/<triple>/package.json for each
// present triple, reading (and removing) <stage>/<triple>/.build, a line of
// "<build id>\t<commit>" for the binary staged there. PLATFORM_DEPS picks how
// the main package refers to the platform packages (see platformDeps).
import { readFileSync, rmSync, writeFileSync } from 'node:fs';

/** Packages that are only needed to build the addon, never at runtime. */
const BUILD_ONLY = ['node-addon-api'];
const ENGINES = { node: '>=24' };
const LEGAL = ['LICENSE', 'THIRD_PARTY_NOTICES.md'];

/** The fields every published package carries as the repo's package.json has them. */
function shared(root) {
  const fields = {};
  for (const key of ['license', 'repository', 'homepage', 'bugs', 'publishConfig']) {
    if (root[key] !== undefined) fields[key] = root[key];
  }
  return fields;
}

export function platformPackageName(name, triple) {
  return `${name}-${triple}`;
}

/**
 * How the main package depends on the platform packages, each at exactly
 * the main package's version (the loader also checks their `nativeBuild`):
 *   optional (default): optionalDependencies, as @roamhq/wrtc does. The
 *     package manager installs the one whose os, cpu and libc match and
 *     skips the others.
 *   peer: optional peerDependencies, which no package manager installs
 *     implicitly; install the platform's package next to the main one.
 * Optional dependencies resolve every name in the registry, so they are only
 * safe because the names are in a scope we own (@kdh.codes): nobody else can
 * publish a package there for npm to pick up and run install scripts from.
 */
export function platformDeps(root, triples, wiring = 'optional') {
  const deps = Object.fromEntries(
    triples.map((triple) => [platformPackageName(root.name, triple), root.version]),
  );
  if (wiring === 'optional') return { optionalDependencies: deps };
  if (wiring === 'peer') {
    return {
      peerDependencies: deps,
      peerDependenciesMeta: Object.fromEntries(
        Object.keys(deps).map((name) => [name, { optional: true }]),
      ),
    };
  }
  throw new Error(`PLATFORM_DEPS=${wiring}: expected optional or peer`);
}

/** The main package: the JS in dist/, its types, and the platform packages as dependencies. */
export function mainManifest(root, { buildId, triples, wiring }) {
  const runtimeDeps = { ...root.dependencies };
  for (const name of BUILD_ONLY) delete runtimeDeps[name];
  return {
    name: root.name,
    version: root.version,
    description: root.description,
    keywords: root.keywords,
    ...shared(root),
    type: root.type,
    exports: root.exports,
    types: root.types,
    engines: ENGINES,
    nativeBuild: buildId,
    files: ['dist', 'README.md', ...LEGAL],
    ...(Object.keys(runtimeDeps).length ? { dependencies: runtimeDeps } : {}),
    ...platformDeps(root, triples, wiring),
  };
}

/** One platform's package: wrtc.node, limited to that os, cpu (and libc). */
export function platformManifest(root, { triple, buildId, commit }) {
  const [os, cpu] = triple.split('-');
  return {
    name: platformPackageName(root.name, triple),
    version: root.version,
    description: `The ${triple} native addon for ${root.name}, built from ${commit}.`,
    ...shared(root),
    os: [os],
    cpu: [cpu],
    ...(os === 'linux' ? { libc: ['glibc'] } : {}),
    engines: ENGINES,
    nativeBuild: buildId,
    main: 'wrtc.node',
    files: ['wrtc.node', 'README.md', ...LEGAL],
  };
}

/** The platform package's README: what it is, and to install the main package instead. */
export function platformReadme(root, triple) {
  return (
    `# ${platformPackageName(root.name, triple)}\n\n` +
    `The prebuilt ${triple} native addon (\`wrtc.node\`) for [\`${root.name}\`](${root.homepage}).\n\n` +
    `Install \`${root.name}\` instead: it depends on this package and loads it on ${triple}.\n`
  );
}

function main() {
  const [stage, buildId, all, ...present] = process.argv.slice(2);
  if (!stage || !buildId || all === undefined) {
    console.error(
      'usage: node scripts/package-manifests.mjs <stage> <build id> "<triples>" [<present>...]',
    );
    process.exit(2);
  }
  const root = JSON.parse(readFileSync('package.json', 'utf8'));
  const write = (dir, manifest) =>
    writeFileSync(`${dir}/package.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  const wiring = process.env.PLATFORM_DEPS || 'optional';
  write(`${stage}/main`, mainManifest(root, { buildId, triples: all.split(' '), wiring }));
  for (const triple of present) {
    const dir = `${stage}/${triple}`;
    const [built, commit] = readFileSync(`${dir}/.build`, 'utf8').trim().split('\t');
    rmSync(`${dir}/.build`);
    write(dir, platformManifest(root, { triple, buildId: built, commit }));
    writeFileSync(`${dir}/README.md`, platformReadme(root, triple));
  }
}

if (import.meta.main) main();
