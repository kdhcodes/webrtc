// Types for scripts/gen-idl.mjs, so scripts/gen-idl.test.ts is type-checked.

export interface IdlSource {
  /** WebIDL source text. */
  idl: string;
  /** Where it came from, recorded in the generated doc comments. */
  origin: string;
}

export interface GenerateResult {
  /** `header` followed by the unformatted TypeScript module. */
  code: string;
  counts: { enums: number; typedefs: number; dictionaries: number; unions: number };
}

/**
 * Generates the converters module for `sources`, in collection order. Throws
 * on anything it can't emit faithfully.
 */
export function generate(
  sources: IdlSource[],
  options?: {
    header?: string;
    /** Dictionary name to members typed as the consumer's lib.dom has them. */
    libDomMembers?: Record<string, string[]>;
  },
): GenerateResult;

/**
 * Generates the interface shapes module (`interfaceShapes`) for `sources`.
 * Throws on member kinds lib/internal/interface-shape.ts doesn't handle.
 */
export function generateInterfaces(
  sources: IdlSource[],
  options?: { header?: string },
): { code: string; count: number };

/**
 * Both generated modules from @webref/idl, formatted as committed: `files`
 * maps each path (relative to the repo root) to its code.
 */
export function generateFiles(): { files: Record<string, string>; log: string[] };
