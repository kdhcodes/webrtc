import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type AddonLocation, loadAddon, type Manifest, tarballName } from './addon-path.ts';

const SUPPORTED = 'Supported platforms: darwin-arm64, linux-arm64, linux-x64.';
const FLOORS = 'The prebuilt addons need glibc 2.34+ on Linux and macOS 13.5+ (Node 24).';

function codeError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

interface Options {
  localBuild?: boolean;
  musl?: boolean;
  /** Installed platform packages: name -> its package.json. */
  installed?: Record<string, Manifest>;
  /** The main package's own build id. */
  nativeBuild?: string;
}

/**
 * A package on `triple`. `loadAddon` returns `{ loaded: path }`. `calls`
 * records the module ids resolved, the paths loaded and the musl checks.
 */
function location(triple: string, opts: Options = {}) {
  const [platform = '', arch = ''] = triple.split('-');
  const calls = { resolved: [] as string[], loaded: [] as string[], muslChecks: 0 };
  const loc: AddonLocation = {
    // Scoped, like the real name (@kdh.codes/webrtc).
    self: { name: '@scope/pkg', ...(opts.nativeBuild ? { nativeBuild: opts.nativeBuild } : {}) },
    platform,
    arch,
    isMusl: () => {
      calls.muslChecks++;
      return opts.musl === true;
    },
    localBuild: '/repo/build/Release/wrtc.node',
    exists: (path) => opts.localBuild === true && path === '/repo/build/Release/wrtc.node',
    resolve: (id) => {
      calls.resolved.push(id);
      const pkg = id.replace(/\/package\.json$/, '');
      if (!opts.installed?.[pkg]) throw codeError(`Cannot find module '${id}'`, 'MODULE_NOT_FOUND');
      return `/app/node_modules/${id}`;
    },
    readManifest: (path) => {
      const pkg = path.replace(/^\/app\/node_modules\/(.*)\/package\.json$/, '$1');
      return opts.installed?.[pkg] ?? assert.fail(`read ${path}`);
    },
    load: (path) => {
      calls.loaded.push(path);
      return { loaded: path };
    },
  };
  return { loc, calls };
}

/** The platform package `@scope/pkg-<triple>`, stamped with `nativeBuild` if given. */
function platformPackage(triple: string, nativeBuild?: string): Record<string, Manifest> {
  const name = `@scope/pkg-${triple}`;
  return { [name]: { name, ...(nativeBuild ? { nativeBuild } : {}) } };
}

/** `loc.load` throws a dlopen failure with `message`. */
function failDlopen(loc: AddonLocation, message: string): Error {
  const error = codeError(message, 'ERR_DLOPEN_FAILED');
  loc.load = () => {
    throw error;
  };
  return error;
}

test('a local build (a checkout) loads as is, without looking for the platform package', () => {
  const { loc, calls } = location('darwin-arm64', {
    localBuild: true,
    nativeBuild: 'aaa',
    installed: platformPackage('darwin-arm64', 'bbb'),
  });
  assert.deepEqual(loadAddon(loc), { loaded: '/repo/build/Release/wrtc.node' });
  assert.deepEqual(calls.resolved, []);
});

test('without a local build, the addon comes from the platform package of the same build', () => {
  const { loc, calls } = location('linux-x64', {
    nativeBuild: 'aaa',
    installed: platformPackage('linux-x64', 'aaa'),
  });
  assert.deepEqual(loadAddon(loc), {
    loaded: '/app/node_modules/@scope/pkg-linux-x64/wrtc.node',
  });
  assert.deepEqual(calls.resolved, ['@scope/pkg-linux-x64/package.json']);
  assert.equal(calls.muslChecks, 0, 'libc is only checked to explain a failure');
});

test('a platform package from a different build is refused, naming both ids, and not loaded', () => {
  const { loc, calls } = location('darwin-arm64', {
    nativeBuild: 'aaa',
    installed: platformPackage('darwin-arm64', 'bbb'),
  });
  assert.throws(() => loadAddon(loc), {
    message:
      '@scope/pkg: the platform package @scope/pkg-darwin-arm64 is from a different build ' +
      '(native build bbb) than @scope/pkg (native build aaa). Install the ' +
      '@scope/pkg-darwin-arm64 tarball made by the same ' +
      'scripts/package.sh run.',
  });
  assert.deepEqual(calls.loaded, []);
});

test('an unstamped platform package is refused by a stamped main package', () => {
  const { loc, calls } = location('darwin-arm64', {
    nativeBuild: 'aaa',
    installed: platformPackage('darwin-arm64'),
  });
  assert.throws(
    () => loadAddon(loc),
    /\(native build unknown\) than @scope\/pkg \(native build aaa\)/,
  );
  assert.deepEqual(calls.loaded, []);
});

test('an unstamped main package skips the build check', () => {
  const { loc } = location('darwin-arm64', { installed: platformPackage('darwin-arm64', 'bbb') });
  assert.deepEqual(loadAddon(loc), {
    loaded: '/app/node_modules/@scope/pkg-darwin-arm64/wrtc.node',
  });
});

test('a missing platform package names it and the supported platforms', () => {
  const { loc } = location('linux-arm64', { installed: platformPackage('linux-x64') });
  assert.throws(
    () => loadAddon(loc),
    (error: Error) => {
      assert.equal(
        error.message,
        '@scope/pkg: the native addon for linux-arm64 is missing. Install the platform package ' +
          '@scope/pkg-linux-arm64 next to @scope/pkg (its tarball is ' +
          'scope-pkg-linux-arm64-<version>.tgz), or, in a checkout, build it with ' +
          `\`pnpm run build\`. ${SUPPORTED}`,
      );
      assert.equal((error.cause as NodeJS.ErrnoException).code, 'MODULE_NOT_FOUND');
      return true;
    },
  );
});

test('on musl, a missing platform package says musl is not supported', () => {
  const { loc } = location('linux-x64', { musl: true });
  assert.throws(() => loadAddon(loc), {
    message: `@scope/pkg: musl libc (e.g. Alpine) isn't supported. ${FLOORS}`,
  });
});

test('an unsupported platform says so without looking for a package', () => {
  const { loc, calls } = location('win32-x64');
  assert.throws(() => loadAddon(loc), {
    message: `@scope/pkg: no prebuilt native addon for win32-x64. ${SUPPORTED}`,
  });
  assert.deepEqual(calls.resolved, []);
});

test('a dlopen failure from a too-old glibc names the package and the floors, keeping the cause', () => {
  const { loc } = location('linux-x64', { installed: platformPackage('linux-x64') });
  const dlopen = failDlopen(loc, "version `GLIBC_2.36' not found");
  assert.throws(
    () => loadAddon(loc),
    (error: Error) => {
      assert.equal(
        error.message,
        "@scope/pkg: could not load @scope/pkg-linux-x64's native addon: version " +
          `\`GLIBC_2.36' not found. ${FLOORS}`,
      );
      assert.equal(error.cause, dlopen);
      return true;
    },
  );
});

test('any other dlopen failure (e.g. the wrong architecture) names the package only', () => {
  const { loc } = location('darwin-arm64', { installed: platformPackage('darwin-arm64') });
  failDlopen(loc, "incompatible architecture (have 'x86_64', need 'arm64')");
  assert.throws(() => loadAddon(loc), {
    message:
      "@scope/pkg: could not load @scope/pkg-darwin-arm64's native addon: incompatible architecture " +
      "(have 'x86_64', need 'arm64').",
  });
});

test('other load errors propagate unchanged', () => {
  const { loc } = location('darwin-arm64', { installed: platformPackage('darwin-arm64') });
  const thrown = new TypeError('not a module');
  loc.load = () => {
    throw thrown;
  };
  assert.throws(
    () => loadAddon(loc),
    (error) => error === thrown,
  );
});

test('tarball names follow npm pack: a scoped name loses its @ and its / becomes -', () => {
  assert.equal(
    tarballName('@kdh.codes/webrtc-linux-x64', '0.0.0'),
    'kdh.codes-webrtc-linux-x64-0.0.0.tgz',
  );
  assert.equal(tarballName('unscoped-darwin-arm64'), 'unscoped-darwin-arm64-<version>.tgz');
});

test('other resolution errors (e.g. a broken package.json) propagate unchanged', () => {
  const { loc } = location('darwin-arm64');
  const thrown = codeError('Invalid package config', 'ERR_INVALID_PACKAGE_CONFIG');
  loc.resolve = () => {
    throw thrown;
  };
  assert.throws(
    () => loadAddon(loc),
    (error) => error === thrown,
  );
});
