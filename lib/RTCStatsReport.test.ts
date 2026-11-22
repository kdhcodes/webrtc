import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RTCStatsReport, statsReportFromJson } from './RTCStatsReport.ts';

// The addon's format: libwebrtc's ToJson(), an array of stats objects.
const json = JSON.stringify([
  { id: 'P', type: 'peer-connection', timestamp: 1, dataChannelsOpened: 0 },
  { id: 'T', type: 'transport', timestamp: 1, nested: { a: [1] } },
]);

test('an empty selection ({}) is an empty report', () => {
  assert.equal(statsReportFromJson('{}').size, 0);
});

test('is a read-only map of stats by id, with the Map read surface', () => {
  const report = statsReportFromJson(json);
  assert.equal(report.size, 2);
  assert.equal(report.get('P').type, 'peer-connection');
  assert.equal(report.has('T'), true);
  assert.deepEqual([...report.keys()], ['P', 'T']);
  assert.deepEqual(
    [...report].map(([id, stats]) => [id, stats.type]),
    [
      ['P', 'peer-connection'],
      ['T', 'transport'],
    ],
  );
  const seen: string[] = [];
  report.forEach((stats, id, parent) => {
    assert.equal(parent, report);
    seen.push(`${id}:${stats.type}`);
  });
  assert.deepEqual(seen, ['P:peer-connection', 'T:transport']);
  assert.equal('set' in report, false);
});

test('stats entries are plain mutable objects, as in browsers and wrtc', () => {
  const stats = statsReportFromJson(json).get('T');
  assert.equal(Object.isFrozen(stats), false);
  stats.note = 'user annotation';
  assert.equal(stats.note, 'user annotation');
});

test('inbound-rtp and outbound-rtp entries get the legacy mediaType, equal to kind', () => {
  const report = statsReportFromJson(
    JSON.stringify([
      { id: 'I', type: 'inbound-rtp', timestamp: 1, kind: 'audio' },
      { id: 'O', type: 'outbound-rtp', timestamp: 1, kind: 'video' },
      { id: 'R', type: 'remote-inbound-rtp', timestamp: 1, kind: 'video' },
    ]),
  );
  assert.deepEqual(
    [...report.values()].map((s) => [s.id, s.mediaType]),
    [
      ['I', 'audio'],
      ['O', 'video'],
      ['R', undefined],
    ],
  );
});

test("timestamp is converted from libwebrtc's microseconds to milliseconds", () => {
  const report = statsReportFromJson(
    JSON.stringify([{ id: 'P', type: 'peer-connection', timestamp: 1795177007628501 }]),
  );
  assert.equal(report.get('P').timestamp, 1795177007628.501);
});

test("a transport's srtpCipher gets the IANA name Chrome reports; other names pass through", () => {
  const report = statsReportFromJson(
    JSON.stringify([
      { id: 'T1', type: 'transport', timestamp: 1, srtpCipher: 'AES_CM_128_HMAC_SHA1_80' },
      { id: 'T2', type: 'transport', timestamp: 1, srtpCipher: 'AES_CM_128_HMAC_SHA1_32' },
      { id: 'T3', type: 'transport', timestamp: 1, srtpCipher: 'AEAD_AES_128_GCM' },
      { id: 'T4', type: 'transport', timestamp: 1, srtpCipher: 'AEAD_AES_256_GCM' },
      { id: 'T5', type: 'transport', timestamp: 1, srtpCipher: 'SRTP_AES128_CM_HMAC_SHA1_80' },
      { id: 'T6', type: 'transport', timestamp: 1, srtpCipher: 'toString' },
      { id: 'T7', type: 'transport', timestamp: 1 },
    ]),
  );
  assert.deepEqual(
    [...report.values()].map((s) => s.srtpCipher),
    [
      'SRTP_AES128_CM_HMAC_SHA1_80',
      'SRTP_AES128_CM_HMAC_SHA1_32',
      'SRTP_AEAD_AES_128_GCM',
      'SRTP_AEAD_AES_256_GCM',
      'SRTP_AES128_CM_HMAC_SHA1_80',
      'toString',
      undefined,
    ],
  );
});

test('is not constructible from JS', () => {
  assert.throws(() => new RTCStatsReport(), { name: 'TypeError', message: 'Illegal constructor' });
});
