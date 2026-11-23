// Types for scripts/build-ts.mjs, so scripts/build-ts.test.ts is type-checked.

/**
 * One .d.ts file's text without the `#private;` placeholders and
 * `[Symbol.toStringTag]` declarations. Throws if a private name or a
 * toStringTag is still declared afterwards.
 */
export function structuralDeclarations(text: string, file?: string): string;

/** Rewrites every .d.ts under `dir` with structuralDeclarations(). */
export function rewriteDeclarations(dir: string): void;

/** tsc's arguments for tsconfig.json plus `args`. Throws on -p/--project. */
export function tscArgs(args: string[]): string[];

/**
 * The directory tsc emits into for tsconfig.json in `cwd` (default: the repo
 * root) plus `args`, as tsc itself reads them.
 */
export function outDirFor(args: string[], cwd?: string): string;
