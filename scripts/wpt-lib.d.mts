// Types for scripts/wpt-lib.mjs, so scripts/wpt-lib.test.ts is type-checked.

export const PASS: 'PASS';
export const OK: 'OK';
export const PROTOCOL_ERROR: 'PROTOCOL_ERROR';

export interface Meta {
  scripts: string[];
  long: boolean;
  title: string | null;
  variants: string[];
}

export type PageScript = { src: string } | { code: string; line: number };

/** An element of a test page, for the child's DOM shim. */
export interface PageElement {
  tag: string;
  attributes: Record<string, string>;
}

export interface Page {
  scripts: PageScript[];
  long: boolean;
  title: string | null;
  variants: string[];
  elements: PageElement[];
}

export type PlanScript = { path: string } | { code: string; line: number };

export interface TestPlan {
  scripts: PlanScript[];
  long: boolean;
  title: string | null;
  elements: PageElement[];
}

export interface SubtestResult {
  status: string;
  message?: string | null | undefined;
}

export interface TestResult {
  status: string;
  message?: string | null | undefined;
  subtests: Record<string, SubtestResult>;
}

/** One status, or several when flaky. */
export type Statuses = string | string[];

/**
 * 'PASS', or a status with a reason. The status can be keyed by
 * process.platform where it differs between platforms.
 */
export type Expectation =
  | string
  | {
      status: Statuses | Record<string, Statuses>;
      reason?: string;
      subtests?: Record<string, Expectation>;
    };

export interface CompareOptions {
  /** The run covered every test, so an expected test with no result is a delta. */
  full?: boolean;
  /** Whose platform-keyed expectations apply (default: process.platform). */
  platform?: string;
}

export interface Delta {
  id: string;
  subtest: string | null;
  expected: string;
  actual: string;
  message?: string | null | undefined;
}

export function isTestFile(path: string): boolean;
export function discoverTests(vendorDir: string): string[];
export function splitId(id: string): { file: string; variant: string };
export function parseMeta(source: string): Meta;
export function parseHtml(source: string): Page;
export function resolveScript(src: string, file: string): string | null;
export function testPlan(vendorDir: string, id: string): TestPlan;
export function allowed(expectation: Expectation, platform?: string): string[];
export function compare(
  results: Record<string, TestResult>,
  expectations: Record<string, Expectation>,
  options?: CompareOptions,
): { unexpected: Delta[]; newPasses: Delta[] };
export function shortMessage(message: string | null | undefined): string;
export function updateExpectations(
  results: Record<string, TestResult>,
  old: Record<string, Expectation>,
  options?: CompareOptions,
): Record<string, Expectation>;
export function countStatuses(results: Record<string, TestResult>): Record<string, number>;
