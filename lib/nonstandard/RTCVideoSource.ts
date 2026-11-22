import { mustBe } from '../internal/errors.ts';
import { native } from '../internal/native.ts';
import type { NativeVideoFrame, NativeVideoSource } from '../internal/native-types.ts';
import { registerInterface } from '../internal/webidl.ts';
import { type MediaStreamTrack, trackFromNative } from '../MediaStreamTrack.ts';
import {
  bytes,
  expectObject,
  frameError,
  frameSize,
  isObjectLike,
  member,
  memberValue,
  throwFirstError,
} from './convert.ts';

/** An I420 frame. */
export interface RTCVideoFrame {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
  /** 0, 90, 180 or 270. Honoured (wrtc ignores it). */
  rotation?: number;
}

export interface RTCVideoSourceInit {
  isScreencast?: boolean;
  needsDenoising?: boolean;
}

function toRotation(value: unknown): NativeVideoFrame['rotation'] {
  // wrtc never reads rotation; we honour the four valid values and treat
  // anything else as 0. So no rotation *value* makes onFrame throw, but a
  // frame whose `rotation` getter throws now throws that exception, where
  // wrtc accepted the frame (an accepted divergence: we honour rotation).
  return value === 90 || value === 180 || value === 270 ? value : 0;
}

/**
 * Validates `onFrame`'s argument with wrtc's rules (node-webrtc
 * `image_data.cc`, `i420_helpers.cc`), except that a view's byteOffset is
 * honoured and `rotation` is read. Sizes are checked by frameError().
 */
export function toNativeVideoFrame(frame: unknown): NativeVideoFrame {
  const name = 'RTCVideoSource.onFrame: frame';
  const object = expectObject(frame, name, 'an object {width, height, data}');
  const width = member(object, name, 'width', frameSize);
  const height = member(object, name, 'height', frameSize);
  const data = member(object, name, 'data', bytes);
  throwFirstError(width, height, data);

  const w = memberValue(width);
  const h = memberValue(height);
  const view = memberValue(data);
  const error = frameError(name, 'I420', w, h, view);
  if (error) throw new TypeError(error);
  // An empty frame (0 x -3, say) reaches the native side as 0 x 0.
  const empty = w === 0 || h === 0;
  return {
    width: empty ? 0 : w,
    height: empty ? 0 : h,
    data: view,
    rotation: toRotation(object.rotation),
  };
}

/**
 * wrtc's programmatic video source. Frames are I420, tightly packed.
 *
 * Sending (wrtc adapts nothing; Chrome adapts as below, but defaults to
 * 'maintain-framerate'):
 * - Frames for senders follow what libwebrtc's encoders ask for: frames
 *   are dropped down to `maxFramerate` (and for CPU overload), and
 *   `scaleResolutionDownBy`/`scaleResolutionDownTo` apply.
 * - By default a video sender keeps the pushed size, as wrtc did: senders
 *   start with `degradationPreference` 'maintain-resolution' (not shown by
 *   `getParameters()`), so under low bandwidth a single layer drops frame
 *   rate instead (a 1280x720 layer under a 300 kbps cap: 720p at about
 *   11 fps), and simulcast drops its top layers.
 * - `setParameters({..., degradationPreference: 'maintain-framerate'})`
 *   (Chrome's default) opts into Chrome's resolution adaptation; 'balanced'
 *   adapts both. A single, non-screencast layer then starts small even with
 *   plenty of bandwidth and steps up only as quality allows: in Chromium
 *   159 and here alike, easy 1280x720 content took about 21 s to reach
 *   1280x720 from 320x180, hard (textured) 1280x720 stayed at 320x180 for
 *   40 s, and hard 640x480 at 480x360, because libwebrtc caps a single
 *   layer at 2.5 Mbps (720p) or 1.7 Mbps (VGA) and the quality scaler only
 *   steps up while QP is low. Under a 300 kbps cap it keeps the frame rate
 *   at a lower size instead (960x540 at 29 fps). Leaving
 *   `degradationPreference` out of a later `setParameters()` goes back to
 *   the default. `isScreencast` keeps the resolution either way.
 * - Sinks on this source's tracks (`RTCVideoSink`) get frames as pushed
 *   (not adapted for the encoder), within their queue bound: frames
 *   pushed faster than JS takes them drop the oldest (`framesDropped`).
 * - Simulcast layers are limited by the pushed size (libwebrtc's
 *   `LimitSimulcastLayerCount`, as in Chrome): 3 layers need more than
 *   489,600 pixels (960x540 or bigger; 1280x720 is fine, 640x480 is not),
 *   2 layers more than 122,400 (480x270, 640x360, 640x480), and below that
 *   (320x240 and smaller) only one is sent. The first encodings are kept,
 *   so with `scaleResolutionDownBy` 4/2/1 a 640x480 source sends 160x120
 *   and 320x240, and the full-size layer is never sent. Legacy SDP
 *   simulcast (mediasoup-client's Safari12 handler) has no scales and keeps
 *   the top: 320x240 and 640x480.
 * - VP9 and AV1 send one layer for several encodings unless an encoding
 *   has a `scalabilityMode` (libwebrtc's legacy SVC path, as in Chrome).
 */
export class RTCVideoSource {
  #native: NativeVideoSource;
  #isScreencast: boolean;
  #needsDenoising: boolean | null;

  static {
    registerInterface('RTCVideoSource', (value) => #native in value);
  }

  constructor(init?: RTCVideoSourceInit) {
    let isScreencast = false;
    let needsDenoising: boolean | null = null;
    if (init !== undefined) {
      if (!isObjectLike(init)) {
        throw new TypeError(
          mustBe(
            'RTCVideoSource: init',
            'an object such as {isScreencast: true}, or undefined',
            init,
          ),
        );
      }
      // wrtc reads each member once and converts it with ToBoolean; only
      // `undefined` means unset.
      const screencast = init.isScreencast;
      const denoising = init.needsDenoising;
      isScreencast = screencast === undefined ? false : Boolean(screencast);
      needsDenoising = denoising === undefined ? null : Boolean(denoising);
    }
    this.#isScreencast = isScreencast;
    this.#needsDenoising = needsDenoising;
    this.#native = new native.VideoSource({ isScreencast, needsDenoising });
  }

  get isScreencast(): boolean {
    return this.#isScreencast;
  }

  /**
   * Typed as in wrtc's .d.ts for drop-in compatibility. At runtime it is
   * `null` when unset, exactly as in wrtc.
   */
  get needsDenoising(): boolean | undefined {
    return this.#needsDenoising as boolean | undefined;
  }

  createTrack(): MediaStreamTrack {
    return trackFromNative(this.#native.createTrack());
  }

  onFrame(frame: RTCVideoFrame): void {
    this.#native.pushFrame(toNativeVideoFrame(frame));
  }
}
