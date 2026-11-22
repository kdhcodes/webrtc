// Run by close.interop.ts in a child process, which must exit on its own
// once this test is done: a call with Chromium (media both ways into
// sinks), ended by INTEROP_CLOSES_FIRST (`node` or `chrome`), the other side
// noticing, our close() (an app closes on disconnect too) and the browser
// closed.
import { after, before, test } from 'node:test';
import type { Browser } from 'playwright';
import { CONSENT_WAIT_MS, ENDED, launch, liveCall, nodeReaches } from './chrome.ts';

let browser: Browser;
before(async () => {
  browser = await launch();
});
after(() => browser?.close());

const first = process.env.INTEROP_CLOSES_FIRST ?? 'node';

test(`a call with Chrome, ended by ${first}`, async (t) => {
  const { c } = await liveCall(t, browser);
  if (first === 'chrome') {
    await c.chrome.call('close');
    await nodeReaches(c.pc, (s) => ENDED.includes(s), CONSENT_WAIT_MS);
  } else {
    c.pc.close();
    await c.chrome.reaches((s) => ENDED.includes(s), CONSENT_WAIT_MS);
  }
  await c.checkCandidates();
});
