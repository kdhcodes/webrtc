// Types for scripts/wpt-report.mjs, so its test is type-checked.

import type { Expectation, TestResult } from './wpt-lib.mjs';

export const SECTIONS: [string, RegExp][];
export const OTHER: string;
export function sectionOf(id: string): string;

export interface Badge {
  schemaVersion: 1;
  label: string;
  message: string;
  color: string;
}

export function badge(results: Record<string, TestResult>): Badge;
export function page(
  results: Record<string, TestResult>,
  expectations: Record<string, Expectation>,
  options: { commit: string; date: string; platform: string; repo: string },
): string;
