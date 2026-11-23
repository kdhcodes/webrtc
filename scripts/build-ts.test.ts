// Tests of the declaration post-processing in scripts/build-ts.mjs. That the
// real declarations come out structural is checked by test/dom-compat/
// (pnpm run typecheck), whose DOM-to-ours assignments fail on a `#private`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { structuralDeclarations } from './build-ts.mjs';

const emitted = `export declare class MediaStream extends EventTarget {
    #private;
    constructor(streamOrTracks?: MediaStream);
    get [Symbol.toStringTag](): string;
    get id(): string;
    get onaddtrack(): AnyEventHandler;
}
export declare class RTCError extends DOMException {
    #private;
    get [Symbol.toStringTag](): string;
    get errorDetail(): RTCErrorDetailType;
}
`;

test("drops every class's #private placeholder and toStringTag getter, nothing else", () => {
  assert.equal(
    structuralDeclarations(emitted),
    `export declare class MediaStream extends EventTarget {
    constructor(streamOrTracks?: MediaStream);
    get id(): string;
    get onaddtrack(): AnyEventHandler;
}
export declare class RTCError extends DOMException {
    get errorDetail(): RTCErrorDetailType;
}
`,
  );
});

test('leaves a file without classes as it is', () => {
  const text = 'export interface RTCIceServer {\n    urls: string | string[];\n}\n';
  assert.equal(structuralDeclarations(text), text);
});

test('throws if a private name is still declared, naming the file and the member', () => {
  for (const member of ['#native: object;', 'readonly #id: string;', 'get #state(): string;']) {
    assert.throws(
      () => structuralDeclarations(`declare class A {\n    ${member}\n}\n`, 'A.d.ts'),
      { message: `A.d.ts: a private name is still declared: ${member.replace(/[:(].*/, '')}` },
      member,
    );
  }
});
