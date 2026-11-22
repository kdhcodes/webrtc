/**
 * Where the native addon (wrtc.node) comes from:
 *   1. build/Release/wrtc.node in a checkout that has run `pnpm run build`.
 *      The packaged main package doesn't ship build/, so this only matches
 *      when developing in the repo, and it's loaded as is.
 *   2. Otherwise the installed platform package, `<name>-<platform>-<arch>`
 *      (e.g. `@kdh.codes/webrtc-linux-x64`, in the same scope;
 *      scripts/package.sh builds one per supported platform). Both packages
 *      carry the `nativeBuild` id of the native sources the binary was built
 *      from; they must match, so a new main package never silently runs an
 *      old binary.
 */
// Builtins this package needs at import time come through
// process.getBuiltinModule rather than `import`: importing a builtin builds
// an ESM facade over it, and the facades and node:crypto were about 15 of
// the 42 ms the package took to import on Linux (bench/RESULTS.md, "After
// the performance pass").
const { dirname, join } = process.getBuiltinModule('node:path');

/**
 * Platforms scripts/package.sh builds a platform package for. Keep in sync
 * with `platforms` in scripts/native-inputs.sh.
 */
export const SUPPORTED_PLATFORMS: readonly string[] = ['darwin-arm64', 'linux-arm64', 'linux-x64'];

/** The oldest systems the prebuilt addons load on (see PLAN.md, "Linux"). */
const FLOORS = 'The prebuilt addons need glibc 2.34+ on Linux and macOS 13.5+ (Node 24).';

/** dlopen failures that point at a too-old glibc or macOS (missing versions or symbols). */
const TOO_OLD = /GLIBC|version|symbol|newer/i;

/** The fields of a package.json the loader reads. */
export interface Manifest {
  name: string;
  /** Id of the native sources the platform binary was built from (scripts/package.sh). */
  nativeBuild?: string;
}

export interface AddonLocation {
  /** This package's own package.json. */
  self: Manifest;
  platform: string;
  arch: string;
  /**
   * Linux with musl instead of glibc (e.g. Alpine). Only called on Linux, and
   * only to explain a failure, so a slow or approximate check is fine.
   */
  isMusl(): boolean;
  /** Absolute path of build/Release/wrtc.node relative to this package. */
  localBuild: string;
  exists(path: string): boolean;
  /** `require.resolve` from this package. */
  resolve(id: string): string;
  readManifest(path: string): Manifest;
  /** `require` of a .node file. */
  load(path: string): unknown;
}

export function platformPackageName(packageName: string, platform: string, arch: string): string {
  return `${packageName}-${platform}-${arch}`;
}

/**
 * The file `npm pack` / `pnpm pack` writes for `packageName`: a scoped
 * `@scope/name` becomes `scope-name-<version>.tgz`.
 */
export function tarballName(packageName: string, version = '<version>'): string {
  return `${packageName.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
}

/** Loads the addon; throws an Error saying what to install or rebuild if it can't. */
export function loadAddon(loc: AddonLocation): unknown {
  if (loc.exists(loc.localBuild)) return loc.load(loc.localBuild);

  const name = loc.self.name;
  const triple = `${loc.platform}-${loc.arch}`;
  const supported = `Supported platforms: ${SUPPORTED_PLATFORMS.join(', ')}.`;
  if (!SUPPORTED_PLATFORMS.includes(triple)) {
    throw new Error(`${name}: no prebuilt native addon for ${triple}. ${supported}`);
  }
  // The Linux packages are glibc-only, so on musl the package is missing (its
  // libc field keeps it from installing) or fails to load.
  const musl = (cause: unknown) =>
    loc.platform === 'linux' && loc.isMusl()
      ? new Error(`${name}: musl libc (e.g. Alpine) isn't supported. ${FLOORS}`, { cause })
      : undefined;

  const pkg = platformPackageName(name, loc.platform, loc.arch);
  let manifestPath: string;
  try {
    manifestPath = loc.resolve(`${pkg}/package.json`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error;
    throw (
      musl(error) ??
      new Error(
        `${name}: the native addon for ${triple} is missing. Install the platform package ` +
          `${pkg} next to ${name} (its tarball is ${tarballName(pkg)}), or, in a checkout, ` +
          `build it with \`pnpm run build\`. ${supported}`,
        { cause: error },
      )
    );
  }

  const built = loc.readManifest(manifestPath).nativeBuild;
  if (loc.self.nativeBuild !== undefined && built !== loc.self.nativeBuild) {
    throw new Error(
      `${name}: the platform package ${pkg} is from a different build (native build ` +
        `${built ?? 'unknown'}) than ${name} (native build ${loc.self.nativeBuild}). Install ` +
        `the ${pkg} tarball made by the same scripts/package.sh run.`,
    );
  }

  const path = join(dirname(manifestPath), 'wrtc.node');
  try {
    return loc.load(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ERR_DLOPEN_FAILED') throw error;
    const message = (error as Error).message;
    const hint = TOO_OLD.test(message) ? ` ${FLOORS}` : '';
    throw (
      musl(error) ??
      new Error(`${name}: could not load ${pkg}'s native addon: ${message}.${hint}`, {
        cause: error,
      })
    );
  }
}
