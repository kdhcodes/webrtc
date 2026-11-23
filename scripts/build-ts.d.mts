// Types for scripts/build-ts.mjs, so scripts/build-ts.test.ts is type-checked.

/**
 * One .d.ts file's text without the `#private;` placeholders and
 * `[Symbol.toStringTag]` getters. Throws if a private name is still
 * declared afterwards.
 */
export function structuralDeclarations(text: string, file?: string): string;

/** Rewrites every .d.ts under `dir` with structuralDeclarations(). */
export function rewriteDeclarations(dir: string): void;
