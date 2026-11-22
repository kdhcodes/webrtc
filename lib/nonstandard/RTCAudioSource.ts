import { native } from '../internal/native.ts';
import type { NativeAudioData, NativeAudioSource } from '../internal/native-types.ts';
import { registerInterface } from '../internal/webidl.ts';
import { type MediaStreamTrack, trackFromNative } from '../MediaStreamTrack.ts';
import {
  bytes,
  type Converter,
  count,
  expecting,
  expectObject,
  hasBytes,
  member,
  memberValue,
  optional,
  throwFirstError,
  uint8,
  uint16,
} from './convert.ts';

/** wrtc's RTCAudioData. 10 ms of 16-bit PCM per call. */
export interface RTCAudioData {
  /** Any TypedArray or ArrayBuffer is accepted at runtime, as in wrtc. */
  samples: Int16Array;
  sampleRate: number;
  /** Must be 16. */
  bitsPerSample?: number;
  channelCount?: number;
  /** Must equal floor(sampleRate / 100) if given. */
  numberOfFrames?: number;
}

const SIXTEEN_BITS = '16 (only 16-bit PCM is supported)';

/** bitsPerSample: wrtc's uint8 conversion; only 16 passes the later check. */
const bitsConverter: Converter<number> = expecting(uint8, SIXTEEN_BITS);

/** samples: any TypedArray or an ArrayBuffer, as in wrtc; Int16Array is the natural one. */
const samplesConverter = expecting(
  bytes,
  'an Int16Array of 16-bit samples (or another TypedArray, or an ArrayBuffer)',
);

/**
 * Validates `onData`'s argument with wrtc's rules (node-webrtc
 * `rtc_on_data_event_dict.cc`), except that a view's byteOffset is honoured.
 */
export function toNativeAudioData(data: unknown): NativeAudioData {
  const name = 'RTCAudioSource.onData: data';
  const object = expectObject(data, name, 'an object {samples, sampleRate, ...}');
  const samples = member(object, name, 'samples', samplesConverter);
  const bits = optional(object, name, 'bitsPerSample', bitsConverter, 16);
  const rate = member(object, name, 'sampleRate', uint16);
  const channels = optional(object, name, 'channelCount', uint8, 1);
  const frames = optional(object, name, 'numberOfFrames', uint16, undefined);
  throwFirstError(samples, bits, rate, channels, frames);

  const bitsPerSample = memberValue(bits);
  if (bitsPerSample !== 16) {
    throw new TypeError(`${name}.bitsPerSample must be ${SIXTEEN_BITS}, not ${bitsPerSample}`);
  }
  const sampleRate = memberValue(rate);
  const numberOfFrames = Math.floor(sampleRate / 100);
  const givenFrames = memberValue(frames) ?? numberOfFrames;
  if (givenFrames !== numberOfFrames) {
    throw new TypeError(
      `${name}.numberOfFrames must be ${numberOfFrames} (10 ms at ${sampleRate} Hz) or left ` +
        `out, not ${givenFrames}: each call takes exactly 10 ms of audio`,
    );
  }
  const channelCount = memberValue(channels);
  const view = memberValue(samples);
  const expected = (channelCount * numberOfFrames * bitsPerSample) / 8;
  if (view.byteLength !== expected) {
    throw new TypeError(
      `${name}.samples ${hasBytes(view)}, but 10 ms of ` +
        `${channelCount}-channel 16-bit audio at ${sampleRate} Hz needs ${expected} ` +
        `(${count(numberOfFrames, 'frame')} × ${count(channelCount, 'channel')} × 2 bytes)`,
    );
  }

  // Int16 needs 2-byte alignment; an odd byteOffset gets a copy.
  const pcm =
    view.byteOffset % 2 === 0
      ? new Int16Array(view.buffer, view.byteOffset, view.byteLength / 2)
      : new Int16Array(view.slice().buffer);
  return { samples: pcm, sampleRate, bitsPerSample, channelCount, numberOfFrames };
}

/**
 * wrtc's programmatic audio source. Each `onData` call is delivered
 * synchronously, unbuffered, to every track created from this source.
 */
export class RTCAudioSource {
  #native: NativeAudioSource;

  static {
    registerInterface('RTCAudioSource', (value) => #native in value);
  }

  constructor() {
    this.#native = new native.AudioSource();
  }

  createTrack(): MediaStreamTrack {
    return trackFromNative(this.#native.createTrack());
  }

  onData(data: RTCAudioData): void {
    this.#native.pushData(toNativeAudioData(data));
  }
}
