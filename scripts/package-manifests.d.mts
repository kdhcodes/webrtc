// Types for scripts/package-manifests.mjs, so its test is type-checked.

export type Manifest = Record<string, unknown> & { name: string; version: string };

export function platformPackageName(name: string, triple: string): string;
export function platformDeps(
  root: Manifest,
  triples: string[],
  wiring?: string,
): Record<string, Record<string, unknown>>;
export function mainManifest(
  root: Manifest,
  options: { buildId: string; triples: string[]; wiring: string },
): Manifest;
export function platformManifest(
  root: Manifest,
  options: { triple: string; buildId: string; commit: string },
): Manifest;
export function platformReadme(root: Manifest, triple: string): string;
