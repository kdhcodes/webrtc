import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeCompletions, nativeTask } from './native-tasks.ts';

const later = <T>(settle: (resolve: (v: T) => void, reject: (e: unknown) => void) => void) =>
  new Promise<T>((resolve, reject) => setImmediate(() => settle(resolve, reject)));

test('a promise the addon returns already settled is not counted', async () => {
  const before = nativeCompletions();
  const error = new Error('unparsable');
  await assert.rejects(nativeTask(Promise.reject(error)), (e) => e === error);
  assert.equal(await nativeTask(Promise.resolve(7)), 7);
  assert.equal(nativeCompletions(), before);
});

test('a promise settled in a later task is counted before the caller reacts', async () => {
  const before = nativeCompletions();
  const value = await nativeTask(later<number>((resolve) => resolve(1)));
  assert.equal(value, 1);
  assert.equal(nativeCompletions(), before + 1, 'counted by the time the caller resumes');
  const error = new Error('rejected later');
  await assert.rejects(nativeTask(later((_, reject) => reject(error))), (e) => e === error);
  assert.equal(nativeCompletions(), before + 2);
});
