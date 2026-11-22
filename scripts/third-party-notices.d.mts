// Types for scripts/third-party-notices.mjs, so its test is type-checked.

export const TRIPLES: Record<string, string>;

export interface Entry {
  name: string;
  text: string;
  path: string;
  platform: string;
}

export interface Section {
  name: string;
  texts: { text: string; paths: Set<string> }[];
  platforms: Set<string>;
}

export function unescapeHtml(text: string): string;
export function parseLicenses(markdown: string): Map<string, string>;
export function componentOf(path: string): string | null;
export function componentName(component: string): string;
export function parseDeps(text: string): Map<string, string[]>;
export function headerLicence(source: string): string;
export function sections(entries: Entry[]): Section[];
export function renderNotices(list: Section[], platforms: string[]): string;
