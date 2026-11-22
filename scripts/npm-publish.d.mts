// Types for scripts/npm-publish.mjs, so its test is type-checked.

export interface Package {
  tarball: string;
  manifest: Record<string, unknown> & { name: string; version: string; os?: string[] };
}

export function readManifest(tarball: string): Package['manifest'];
export function plan(packages: Package[]): Package[];
export function isPublished(npm: string, name: string, version: string): boolean;
export function publishArgs(
  tarball: string,
  version: string,
  options?: { dryRun?: boolean; provenance?: boolean },
): string[];
