// A minimal DOM for running WPT's webrtc/ tests in Node (test/wpt/child.mjs).
// Only the WPT harness loads it; it isn't part of the package.
//
// Video is real, not simulated: a <video> element plays its srcObject by
// attaching the implementation's nonstandard RTCVideoSink, and its state
// (readyState, videoWidth, loadedmetadata, playing, ...) moves only when
// decoded frames arrive. A canvas's captureStream() pushes its pixels into
// an RTCVideoSource, and drawImage(video) paints the element's current
// decoded frame, so a getImageData() pixel check sees what went through the
// codec.
//
// What a pass proves:
// - Video size, pixels and frame callbacks: decoded frames arrived.
// - Audio-only elements do NOT prove audio was received, only that the
//   receive pipeline runs. A remote RTCAudioSink gets libwebrtc's playout
//   silence before any packet arrives (Chrome's element would be ready then
//   too), and getUserMedia's audio is silent anyway. With the sender
//   pushing nothing, these still pass: remote-track-currentTime's audio
//   subtest, receiver-track-live (4) and getContributingSources [audio].
// - currentTime, for video too, proves one decoded frame: from the first
//   one it is wall-clock time while playing (the spec's MediaStream
//   timeline), so it advances whether or not more frames come.
//
// What there is:
// - document: createElement, getElementById, getElementsByTagName, body,
//   head, documentElement, readyState 'complete'. Elements form a tree
//   (appendChild, removeChild, remove, append, prepend, parentElement) with
//   attributes, id, click() and on<event> handlers. innerHTML and
//   textContent are plain strings (no parsing).
// - HTMLMediaElement (HTMLVideoElement, HTMLAudioElement): srcObject only.
//   Every audio track gets an RTCAudioSink; a <video> also shows its first
//   video track. readyState goes HAVE_NOTHING -> HAVE_ENOUGH_DATA at the
//   first frame (or, with no video track, the first audio samples), firing
//   loadedmetadata, loadeddata, canplay and canplaythrough; with autoplay or
//   play() it then fires play and playing and resolves play()'s promise.
//   currentTime runs while playing, with timeupdate every 250 ms.
//   videoWidth/videoHeight follow the frames, with resize on a change.
//   requestVideoFrameCallback (metadata without rtpTimestamp: the sinks
//   don't report it) and getVideoPlaybackQuality count presented frames.
//   A paused element keeps showing its last frame.
// - HTMLCanvasElement with a 2D context: fillStyle (rgb()/rgba(), hex and a
//   few names), fillRect, drawImage (video or canvas, nearest neighbour
//   scaling), getImageData, putImageData; and captureStream(frameRate?),
//   which sends a frame after each task that painted. getContext() for
//   anything but '2d' returns null (no WebGL).
// - ImageData, requestAnimationFrame / cancelAnimationFrame (~60 Hz).
// - YUV <-> RGB is BT.601 limited range, as libyuv (and Chrome) convert.
//
// Only what vendored tests use is here. Not there: HTML parsing (the child creates a page's elements from
// wpt-lib's element list), media src URLs, the media element's
// captureStream(), WebAudio playout, VideoFrame / MediaStreamTrackProcessor,
// paths, text, transforms, globalAlpha, compositing modes, frame rotation.
// Named access on window covers the page's own elements only.

/** The parts of the implementation (ours or @roamhq/wrtc) the shim uses. */
export interface Track extends EventTarget {
  readonly kind: string;
  readonly readyState: string;
}

export interface Stream extends EventTarget {
  getTracks(): Track[];
}

interface Sink extends EventTarget {
  stop(): void;
}

export interface Implementation {
  MediaStream: new (tracks?: Track[]) => Stream;
  nonstandard: {
    RTCVideoSource: new () => {
      createTrack(): Track;
      onFrame(frame: { width: number; height: number; data: Uint8Array }): void;
    };
    RTCVideoSink: new (track: Track) => Sink;
    RTCAudioSink: new (track: Track) => Sink;
  };
}

/** A tightly packed I420 frame, as the sinks deliver and the sources take. */
export interface I420Frame {
  width: number;
  height: number;
  data: Uint8Array;
}

// --- Colour conversion ------------------------------------------------------

const clamp = (value: number) => (value < 0 ? 0 : value > 255 ? 255 : Math.round(value));

/** Converts an I420 frame to RGBA (opaque), BT.601 limited range. */
export function i420ToRgba({ width, height, data }: I420Frame): Uint8ClampedArray {
  const chromaWidth = Math.ceil(width / 2);
  const uPlane = width * height;
  const vPlane = uPlane + chromaWidth * Math.ceil(height / 2);
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const chromaRow = (y >> 1) * chromaWidth;
    for (let x = 0; x < width; x++) {
      const luma = 1.164 * ((data[y * width + x] as number) - 16);
      const u = (data[uPlane + chromaRow + (x >> 1)] as number) - 128;
      const v = (data[vPlane + chromaRow + (x >> 1)] as number) - 128;
      const at = (y * width + x) * 4;
      rgba[at] = clamp(luma + 1.596 * v);
      rgba[at + 1] = clamp(luma - 0.392 * u - 0.813 * v);
      rgba[at + 2] = clamp(luma + 2.017 * u);
      rgba[at + 3] = 255;
    }
  }
  return rgba;
}

/** Converts RGBA to an I420 frame (alpha ignored), BT.601 limited range. */
export function rgbaToI420(rgba: Uint8ClampedArray, width: number, height: number): I420Frame {
  const chromaWidth = Math.ceil(width / 2);
  const chromaHeight = Math.ceil(height / 2);
  const uPlane = width * height;
  const vPlane = uPlane + chromaWidth * chromaHeight;
  const data = new Uint8Array(vPlane + chromaWidth * chromaHeight);
  for (let i = 0; i < width * height; i++) {
    const r = rgba[i * 4] as number;
    const g = rgba[i * 4 + 1] as number;
    const b = rgba[i * 4 + 2] as number;
    data[i] = ((66 * r + 129 * g + 25 * b + 128) >> 8) + 16;
  }
  for (let cy = 0; cy < chromaHeight; cy++) {
    for (let cx = 0; cx < chromaWidth; cx++) {
      // The average of the (up to) 2x2 pixels this chroma sample covers.
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let y = cy * 2; y < Math.min(cy * 2 + 2, height); y++) {
        for (let x = cx * 2; x < Math.min(cx * 2 + 2, width); x++) {
          const at = (y * width + x) * 4;
          r += rgba[at] as number;
          g += rgba[at + 1] as number;
          b += rgba[at + 2] as number;
          n++;
        }
      }
      r /= n;
      g /= n;
      b /= n;
      const at = cy * chromaWidth + cx;
      data[uPlane + at] = clamp(((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128);
      data[vPlane + at] = clamp(((112 * r - 94 * g - 18 * b + 128) >> 8) + 128);
    }
  }
  return { width, height, data };
}

/** Parses a CSS colour (the subset canvas tests use) to RGBA 0-255, or null. */
export function parseColor(text: string): [number, number, number, number] | null {
  const value = String(text).trim().toLowerCase();
  const named: Record<string, [number, number, number, number]> = {
    black: [0, 0, 0, 255],
    white: [255, 255, 255, 255],
    red: [255, 0, 0, 255],
    green: [0, 128, 0, 255],
    lime: [0, 255, 0, 255],
    blue: [0, 0, 255, 255],
    yellow: [255, 255, 0, 255],
    cyan: [0, 255, 255, 255],
    magenta: [255, 0, 255, 255],
    gray: [128, 128, 128, 255],
    grey: [128, 128, 128, 255],
    transparent: [0, 0, 0, 0],
  };
  if (value in named) return named[value] as [number, number, number, number];
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(value)?.[1];
  if (hex !== undefined) {
    const pairs = hex.length <= 4 ? [...hex].map((d) => d + d) : (hex.match(/../g) ?? []);
    const [r = 0, g = 0, b = 0, a = 255] = pairs.map((pair) => Number.parseInt(pair, 16));
    return [r, g, b, a];
  }
  const fn = /^rgba?\(([^)]*)\)$/.exec(value)?.[1];
  if (fn === undefined) return null;
  const parts = fn
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map(Number);
  if (parts.length < 3 || parts.length > 4 || parts.some(Number.isNaN)) return null;
  const [r, g, b, a = 1] = parts as [number, number, number, number?];
  return [clamp(r), clamp(g), clamp(b), clamp(a * 255)];
}

// --- Events and the element tree --------------------------------------------

/** Queues `task` as a browser queues an element task (after the current one). */
const queueTask = (task: () => void) => setImmediate(task);

const handlerListeners = new WeakMap<object, Map<string, (event: Event) => void>>();
const handlerValues = new WeakMap<object, Map<string, unknown>>();

/** Defines `on<name>` event handler attributes on a prototype. */
function defineHandlers(proto: object, names: string[]): void {
  for (const name of names) {
    Object.defineProperty(proto, `on${name}`, {
      configurable: true,
      enumerable: true,
      get(this: EventTarget) {
        return handlerValues.get(this)?.get(name) ?? null;
      },
      set(this: EventTarget, value: unknown) {
        const values = handlerValues.get(this) ?? new Map<string, unknown>();
        handlerValues.set(this, values);
        const listeners = handlerListeners.get(this) ?? new Map();
        handlerListeners.set(this, listeners);
        values.set(name, typeof value === 'function' ? value : null);
        if (!listeners.has(name)) {
          const listener = (event: Event) => {
            const handler = values.get(name);
            if (typeof handler === 'function') handler.call(this, event);
          };
          listeners.set(name, listener);
          this.addEventListener(name, listener);
        }
      },
    });
  }
}

export class Node extends EventTarget {
  #parent: Node | null = null;
  #children: Node[] = [];

  get parentNode(): Node | null {
    return this.#parent;
  }

  get parentElement(): Node | null {
    return this.#parent;
  }

  get childNodes(): Node[] {
    return [...this.#children];
  }

  get children(): Node[] {
    return [...this.#children];
  }

  get firstChild(): Node | null {
    return this.#children[0] ?? null;
  }

  appendChild<T extends Node>(child: T): T {
    return this.insertBefore(child, null);
  }

  insertBefore<T extends Node>(child: T, reference: Node | null): T {
    child.remove();
    const at = reference === null ? -1 : this.#children.indexOf(reference);
    if (at === -1) this.#children.push(child);
    else this.#children.splice(at, 0, child);
    child.#parent = this;
    return child;
  }

  append(...nodes: Node[]): void {
    for (const node of nodes) this.appendChild(node);
  }

  prepend(...nodes: Node[]): void {
    const first = this.firstChild;
    for (const node of nodes) this.insertBefore(node, first);
  }

  removeChild<T extends Node>(child: T): T {
    const at = this.#children.indexOf(child);
    if (at === -1) throw new DOMException('The node is not a child of this node.', 'NotFoundError');
    this.#children.splice(at, 1);
    child.#parent = null;
    return child;
  }

  remove(): void {
    this.#parent?.removeChild(this);
  }

  /** Descendants in tree order. */
  *descendants(): Generator<Node> {
    for (const child of this.#children) {
      yield child;
      yield* child.descendants();
    }
  }

  getElementsByTagName(name: string): HTMLElement[] {
    const tag = String(name).toUpperCase();
    return [...this.descendants()].filter(
      (node): node is HTMLElement =>
        node instanceof HTMLElement && (tag === '*' || node.tagName === tag),
    );
  }
}

export class HTMLElement extends Node {
  readonly tagName: string;
  readonly localName: string;
  readonly style: Record<string, string> = {};
  innerHTML = '';
  textContent = '';
  #attributes = new Map<string, string>();

  constructor(localName: string) {
    super();
    this.localName = localName.toLowerCase();
    this.tagName = localName.toUpperCase();
  }

  get id(): string {
    return this.getAttribute('id') ?? '';
  }

  set id(value: string) {
    this.setAttribute('id', value);
  }

  getAttribute(name: string): string | null {
    return this.#attributes.get(String(name).toLowerCase()) ?? null;
  }

  setAttribute(name: string, value: unknown): void {
    this.#attributes.set(String(name).toLowerCase(), String(value));
  }

  hasAttribute(name: string): boolean {
    return this.#attributes.has(String(name).toLowerCase());
  }

  removeAttribute(name: string): void {
    this.#attributes.delete(String(name).toLowerCase());
  }

  click(): void {
    this.dispatchEvent(new Event('click'));
  }
}
defineHandlers(HTMLElement.prototype, ['click', 'error', 'load']);

/** Reflects boolean content attributes as IDL attributes. */
function reflectBooleans(proto: object, names: Record<string, string>): void {
  for (const [property, attribute] of Object.entries(names)) {
    Object.defineProperty(proto, property, {
      configurable: true,
      enumerable: true,
      get(this: HTMLElement) {
        return this.hasAttribute(attribute);
      },
      set(this: HTMLElement, value: unknown) {
        if (value) this.setAttribute(attribute, '');
        else this.removeAttribute(attribute);
      },
    });
  }
}

// --- Canvas ----------------------------------------------------------------

export class ImageData {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
  readonly colorSpace = 'srgb';

  constructor(dataOrWidth: Uint8ClampedArray | number, width: number, height?: number) {
    if (typeof dataOrWidth === 'number') {
      this.width = dataOrWidth;
      this.height = width;
      this.data = new Uint8ClampedArray(this.width * this.height * 4);
    } else {
      this.data = dataOrWidth;
      this.width = width;
      this.height = height ?? dataOrWidth.length / 4 / width;
      if (this.data.length !== this.width * this.height * 4) {
        throw new DOMException('The input data length is not correct.', 'IndexSizeError');
      }
    }
  }
}

/** A canvas's bitmap, which its context paints. */
interface Bitmap {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
  /** Called after painting, so captureStream() can send a frame. */
  painted(): void;
}
const bitmaps = new WeakMap<object, Bitmap>();

/** Something drawImage() can draw: its current RGBA pixels, or null. */
interface Drawable {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
}
const drawables = new WeakMap<object, () => Drawable | null>();

export class CanvasRenderingContext2D {
  readonly canvas: HTMLCanvasElement;
  #fill: [number, number, number, number] = [0, 0, 0, 255];
  #fillStyle = '#000000';

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  get #bitmap(): Bitmap {
    return bitmaps.get(this.canvas) as Bitmap;
  }

  get fillStyle(): string {
    return this.#fillStyle;
  }

  set fillStyle(value: string) {
    const color = parseColor(value);
    if (color === null) return;
    this.#fill = color;
    const [r, g, b, a] = color;
    this.#fillStyle =
      a === 255
        ? `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`
        : `rgba(${r}, ${g}, ${b}, ${a / 255})`;
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    const [r, g, b, a] = this.#fill;
    const bitmap = this.#bitmap;
    const left = Math.max(0, Math.round(Math.min(x, x + w)));
    const right = Math.min(bitmap.width, Math.round(Math.max(x, x + w)));
    const top = Math.max(0, Math.round(Math.min(y, y + h)));
    const bottom = Math.min(bitmap.height, Math.round(Math.max(y, y + h)));
    for (let row = top; row < bottom; row++) {
      for (let col = left; col < right; col++) {
        blend(bitmap.pixels, (row * bitmap.width + col) * 4, r, g, b, a);
      }
    }
    bitmap.painted();
  }

  drawImage(image: object, ...args: number[]): void {
    const source = drawables.get(image)?.();
    if (source === undefined) throw new TypeError('drawImage: unsupported image source');
    if (source === null || source.width === 0 || source.height === 0) return;
    const whole = [0, 0, source.width, source.height];
    // (dx, dy), (dx, dy, dw, dh) or (sx, sy, sw, sh, dx, dy, dw, dh).
    const rects: Record<number, number[]> = {
      2: [...whole, ...args, source.width, source.height],
      4: [...whole, ...args],
      8: args,
    };
    const rect = rects[args.length];
    if (rect === undefined) throw new TypeError(`drawImage: ${args.length + 1} arguments`);
    const [sx, sy, sw, sh, dx, dy, dw, dh] = rect.map(Number) as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    const bitmap = this.#bitmap;
    const left = Math.max(0, Math.round(dx));
    const right = Math.min(bitmap.width, Math.round(dx + dw));
    const top = Math.max(0, Math.round(dy));
    const bottom = Math.min(bitmap.height, Math.round(dy + dh));
    for (let row = top; row < bottom; row++) {
      const srcRow = Math.floor(sy + ((row + 0.5 - dy) * sh) / dh);
      if (srcRow < 0 || srcRow >= source.height) continue;
      for (let col = left; col < right; col++) {
        const srcCol = Math.floor(sx + ((col + 0.5 - dx) * sw) / dw);
        if (srcCol < 0 || srcCol >= source.width) continue;
        const from = (srcRow * source.width + srcCol) * 4;
        const p = source.pixels;
        blend(
          bitmap.pixels,
          (row * bitmap.width + col) * 4,
          p[from] as number,
          p[from + 1] as number,
          p[from + 2] as number,
          p[from + 3] as number,
        );
      }
    }
    bitmap.painted();
  }

  getImageData(sx: number, sy: number, sw: number, sh: number): ImageData {
    const bitmap = this.#bitmap;
    const out = new ImageData(sw, sh);
    for (let row = 0; row < sh; row++) {
      for (let col = 0; col < sw; col++) {
        const x = sx + col;
        const y = sy + row;
        if (x < 0 || y < 0 || x >= bitmap.width || y >= bitmap.height) continue;
        const from = (y * bitmap.width + x) * 4;
        out.data.set(bitmap.pixels.subarray(from, from + 4), (row * sw + col) * 4);
      }
    }
    return out;
  }

  putImageData(image: ImageData, dx: number, dy: number): void {
    const bitmap = this.#bitmap;
    for (let row = 0; row < image.height; row++) {
      const y = dy + row;
      if (y < 0 || y >= bitmap.height) continue;
      for (let col = 0; col < image.width; col++) {
        const x = dx + col;
        if (x < 0 || x >= bitmap.width) continue;
        const from = (row * image.width + col) * 4;
        bitmap.pixels.set(image.data.subarray(from, from + 4), (y * bitmap.width + x) * 4);
      }
    }
    bitmap.painted();
  }
}

/** Source-over of one non-premultiplied pixel. */
function blend(
  pixels: Uint8ClampedArray,
  at: number,
  r: number,
  g: number,
  b: number,
  a: number,
): void {
  if (a === 255) {
    pixels[at] = r;
    pixels[at + 1] = g;
    pixels[at + 2] = b;
    pixels[at + 3] = 255;
    return;
  }
  if (a === 0) return;
  const srcA = a / 255;
  const dstA = (pixels[at + 3] as number) / 255;
  const outA = srcA + dstA * (1 - srcA);
  const mix = (src: number, dst: number) => (src * srcA + dst * dstA * (1 - srcA)) / outA;
  pixels[at] = mix(r, pixels[at] as number);
  pixels[at + 1] = mix(g, pixels[at + 1] as number);
  pixels[at + 2] = mix(b, pixels[at + 2] as number);
  pixels[at + 3] = outA * 255;
}

// --- Media elements ----------------------------------------------------------

const readyStates = {
  HAVE_NOTHING: 0,
  HAVE_METADATA: 1,
  HAVE_CURRENT_DATA: 2,
  HAVE_FUTURE_DATA: 3,
  HAVE_ENOUGH_DATA: 4,
} as const;

const mediaEvents = [
  'loadstart',
  'loadedmetadata',
  'loadeddata',
  'canplay',
  'canplaythrough',
  'play',
  'playing',
  'pause',
  'timeupdate',
  'resize',
  'emptied',
  'ended',
];

/** How often timeupdate fires while playing (the spec allows 15 to 250 ms). */
const TIMEUPDATE_MS = 250;
/** How often a media element re-reads its stream's tracks. */
const TRACK_POLL_MS = 100;

let implementation: Implementation | null = null;

/** Sets the implementation (ours or wrtc) whose sinks and sources the elements use. */
export function useImplementation(impl: Implementation): void {
  implementation = impl;
}

function nonstandard(): Implementation['nonstandard'] {
  if (implementation === null) throw new Error('dom-shim: call useImplementation() first');
  return implementation.nonstandard;
}

export class HTMLMediaElement extends HTMLElement {
  // The readyState constants, defined below on the class and its prototype.
  declare readonly HAVE_NOTHING: 0;
  declare readonly HAVE_METADATA: 1;
  declare readonly HAVE_CURRENT_DATA: 2;
  declare readonly HAVE_FUTURE_DATA: 3;
  declare readonly HAVE_ENOUGH_DATA: 4;
  #stream: Stream | null = null;
  /** Bumped when the source changes, so stale sink callbacks are ignored. */
  #generation = 0;
  #sinks = new Map<Track, Sink>();
  #readyState: number = readyStates.HAVE_NOTHING;
  #paused = true;
  #pendingPlays: { resolve: () => void; reject: (error: unknown) => void }[] = [];
  /** Seconds played before the current stretch, and when that stretch began. */
  #played = 0;
  #playingSince: number | null = null;
  #timeupdate: ReturnType<typeof setInterval> | null = null;
  /** Re-reads the stream's tracks: addTrack() by the page fires no event. */
  #trackPoll: ReturnType<typeof setInterval> | null = null;
  #onTrackChange = () => this.#syncTracks();

  get srcObject(): Stream | null {
    return this.#stream;
  }

  set srcObject(stream: Stream | null) {
    // The load algorithm, cut down to a MediaStream source.
    this.#detach();
    if (!this.#paused) {
      this.#paused = true;
      this.#rejectPlays();
      this.fire('pause');
    }
    if (this.#readyState !== readyStates.HAVE_NOTHING) {
      this.#readyState = readyStates.HAVE_NOTHING;
      this.fire('emptied');
    }
    this.#played = 0;
    this.#playingSince = null;
    this.resetVideo();
    this.#stream = stream ?? null;
    if (this.#stream === null) return;
    this.fire('loadstart');
    this.#stream.addEventListener?.('addtrack', this.#onTrackChange);
    this.#stream.addEventListener?.('removetrack', this.#onTrackChange);
    this.#trackPoll = setInterval(this.#onTrackChange, TRACK_POLL_MS);
    this.#trackPoll.unref();
    this.#syncTracks();
  }

  get src(): string {
    return '';
  }

  set src(_value: string) {
    throw new Error('dom-shim: media element src URLs are not supported, only srcObject');
  }

  get readyState(): number {
    return this.#readyState;
  }

  get paused(): boolean {
    return this.#paused;
  }

  get ended(): boolean {
    return false;
  }

  get seeking(): boolean {
    return false;
  }

  get error(): null {
    return null;
  }

  get duration(): number {
    return this.#stream === null ? Number.NaN : Number.POSITIVE_INFINITY;
  }

  /** The MediaStream timeline: real time while playing. */
  get currentTime(): number {
    const running =
      this.#playingSince === null ? 0 : (performance.now() - this.#playingSince) / 1000;
    return this.#played + running;
  }

  set currentTime(_value: number) {
    // A MediaStream isn't seekable.
  }

  /** Potentially playing: not paused, and has data to play. */
  get potentiallyPlaying(): boolean {
    return !this.#paused && this.#readyState >= readyStates.HAVE_FUTURE_DATA;
  }

  play(): Promise<void> {
    const promise = new Promise<void>((resolve, reject) => {
      this.#pendingPlays.push({ resolve, reject });
    });
    if (this.#paused) {
      this.#paused = false;
      this.fire('play');
      if (this.#readyState >= readyStates.HAVE_FUTURE_DATA) this.#startPlaying();
    } else if (this.#readyState >= readyStates.HAVE_FUTURE_DATA) {
      this.#resolvePlays();
    }
    return promise;
  }

  pause(): void {
    if (this.#paused) return;
    this.#stopClock();
    this.#paused = true;
    this.fire('timeupdate');
    this.fire('pause');
    this.#rejectPlays();
  }

  /** Queues an event at this element. */
  fire(type: string): void {
    const generation = this.#generation;
    queueTask(() => {
      if (generation === this.#generation || type === 'emptied' || type === 'pause') {
        this.dispatchEvent(new Event(type));
      }
    });
  }

  /** For subclasses: whether this element renders the stream's video. */
  rendersVideo(): boolean {
    return false;
  }

  /** For subclasses: a decoded frame of the rendered video track arrived. */
  videoFrame(_frame: I420Frame): void {}

  /** For subclasses: the source changed. */
  resetVideo(): void {}

  declare autoplay: boolean;

  /**
   * Media data arrived. The first time, the element has metadata and
   * enough data at once (a live stream has nothing to buffer), and starts
   * playing if it should.
   */
  #haveData(): void {
    if (this.#readyState !== readyStates.HAVE_NOTHING) return;
    this.#readyState = readyStates.HAVE_ENOUGH_DATA;
    for (const type of ['loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough']) {
      this.fire(type);
    }
    if (this.#paused && this.autoplay) {
      this.#paused = false;
      this.fire('play');
    }
    if (!this.#paused) this.#startPlaying();
  }

  #startPlaying(): void {
    this.#playingSince = performance.now();
    this.#timeupdate = setInterval(
      () => this.dispatchEvent(new Event('timeupdate')),
      TIMEUPDATE_MS,
    );
    this.#timeupdate.unref();
    const generation = this.#generation;
    queueTask(() => {
      if (generation !== this.#generation || this.#paused) return;
      this.dispatchEvent(new Event('playing'));
      this.#resolvePlays();
    });
  }

  #stopClock(): void {
    if (this.#playingSince !== null) {
      this.#played += (performance.now() - this.#playingSince) / 1000;
      this.#playingSince = null;
    }
    if (this.#timeupdate !== null) clearInterval(this.#timeupdate);
    this.#timeupdate = null;
  }

  #resolvePlays(): void {
    for (const { resolve } of this.#pendingPlays.splice(0)) resolve();
  }

  #rejectPlays(): void {
    for (const { reject } of this.#pendingPlays.splice(0)) {
      reject(new DOMException('The play() request was interrupted.', 'AbortError'));
    }
  }

  /**
   * Attaches sinks to the tracks this element plays: its first live video
   * track (a <video> only) and every live audio track.
   */
  #syncTracks(): void {
    const tracks = this.#stream?.getTracks() ?? [];
    const live = tracks.filter((track) => track.readyState !== 'ended');
    const video = this.rendersVideo() ? live.find((track) => track.kind === 'video') : undefined;
    const wanted = new Set(live.filter((track) => track === video || track.kind === 'audio'));
    for (const [track, sink] of this.#sinks) {
      if (!wanted.has(track)) {
        sink.stop();
        this.#sinks.delete(track);
      }
    }
    const generation = this.#generation;
    for (const track of wanted) {
      if (this.#sinks.has(track)) continue;
      if (track.kind === 'video') {
        const sink = new (nonstandard().RTCVideoSink)(track);
        sink.addEventListener('frame', (event) => {
          if (generation !== this.#generation) return;
          this.videoFrame((event as Event & { frame: I420Frame }).frame);
          this.#haveData();
        });
        this.#sinks.set(track, sink);
      } else {
        const sink = new (nonstandard().RTCAudioSink)(track);
        sink.addEventListener('data', () => {
          if (generation !== this.#generation) return;
          // An element showing video gets its metadata (the size) from the
          // first frame, as Chrome does; audio alone doesn't make it ready.
          if (![...this.#sinks.keys()].some((t) => t.kind === 'video')) this.#haveData();
        });
        this.#sinks.set(track, sink);
      }
    }
  }

  #detach(): void {
    this.#generation++;
    this.#stopClock();
    for (const sink of this.#sinks.values()) sink.stop();
    this.#sinks.clear();
    if (this.#trackPoll !== null) clearInterval(this.#trackPoll);
    this.#trackPoll = null;
    this.#stream?.removeEventListener?.('addtrack', this.#onTrackChange);
    this.#stream?.removeEventListener?.('removetrack', this.#onTrackChange);
  }
}
Object.defineProperties(HTMLMediaElement, Object.getOwnPropertyDescriptors(readyStates));
Object.defineProperties(HTMLMediaElement.prototype, Object.getOwnPropertyDescriptors(readyStates));
defineHandlers(HTMLMediaElement.prototype, mediaEvents);
reflectBooleans(HTMLMediaElement.prototype, {
  autoplay: 'autoplay',
  loop: 'loop',
  muted: 'muted',
});

type FrameCallback = (now: number, metadata: Record<string, number>) => void;

export class HTMLVideoElement extends HTMLMediaElement {
  /** The displayed frame and its RGBA conversion (made on first draw). */
  #frame: I420Frame | null = null;
  #rgba: Uint8ClampedArray | null = null;
  #presentedFrames = 0;
  #frameCallbacks = new Map<number, FrameCallback>();
  #nextCallback = 1;

  constructor() {
    super('video');
    drawables.set(this, () => {
      if (this.readyState < readyStates.HAVE_CURRENT_DATA || this.#frame === null) return null;
      this.#rgba ??= i420ToRgba(this.#frame);
      return { width: this.#frame.width, height: this.#frame.height, pixels: this.#rgba };
    });
  }

  get videoWidth(): number {
    return this.readyState === readyStates.HAVE_NOTHING ? 0 : (this.#frame?.width ?? 0);
  }

  get videoHeight(): number {
    return this.readyState === readyStates.HAVE_NOTHING ? 0 : (this.#frame?.height ?? 0);
  }

  get width(): number {
    return Number(this.getAttribute('width') ?? 0);
  }

  set width(value: number) {
    this.setAttribute('width', value);
  }

  get height(): number {
    return Number(this.getAttribute('height') ?? 0);
  }

  set height(value: number) {
    this.setAttribute('height', value);
  }

  override rendersVideo(): boolean {
    return true;
  }

  override resetVideo(): void {
    this.#frame = null;
    this.#rgba = null;
    this.#presentedFrames = 0;
    // Callbacks waiting for a frame of the old source never get one.
    this.#frameCallbacks.clear();
  }

  override videoFrame(frame: I420Frame): void {
    // The first frame is shown even when paused (it's the poster); later
    // ones only while playing.
    const first = this.#frame === null;
    if (!first && !this.potentiallyPlaying) return;
    const resized =
      !first && (frame.width !== this.#frame?.width || frame.height !== this.#frame?.height);
    this.#frame = frame;
    this.#rgba = null;
    this.#presentedFrames++;
    if (resized) this.fire('resize');
    if (this.#frameCallbacks.size === 0) return;
    const callbacks = [...this.#frameCallbacks.values()];
    this.#frameCallbacks.clear();
    const now = performance.now();
    const metadata = {
      presentationTime: now,
      expectedDisplayTime: now,
      width: frame.width,
      height: frame.height,
      mediaTime: this.currentTime,
      presentedFrames: this.#presentedFrames,
    };
    queueTask(() => {
      for (const callback of callbacks) callback(now, metadata);
    });
  }

  requestVideoFrameCallback(callback: FrameCallback): number {
    const handle = this.#nextCallback++;
    this.#frameCallbacks.set(handle, callback);
    return handle;
  }

  getVideoPlaybackQuality() {
    return {
      creationTime: performance.now(),
      totalVideoFrames: this.#presentedFrames,
      droppedVideoFrames: 0,
      corruptedVideoFrames: 0,
    };
  }
}

export class HTMLAudioElement extends HTMLMediaElement {
  constructor() {
    super('audio');
  }
}

/**
 * RTCPeerConnection-helper.js replaces a canvas track's `stop` by
 * assignment. @roamhq/wrtc's is a read-only inherited property, which makes
 * that assignment throw in strict code; give such a track a writable own
 * copy (ours, whose method is writable, is left alone).
 */
function allowStopOverride(track: Track): void {
  for (let o: object | null = track; o !== null; o = Object.getPrototypeOf(o)) {
    const descriptor = Object.getOwnPropertyDescriptor(o, 'stop');
    if (descriptor === undefined) continue;
    if ('value' in descriptor && !descriptor.writable) {
      Object.defineProperty(track, 'stop', { ...descriptor, writable: true });
    }
    return;
  }
}

export class HTMLCanvasElement extends HTMLElement {
  #context: CanvasRenderingContext2D | null = null;
  #captures = new Set<{
    source: InstanceType<Implementation['nonstandard']['RTCVideoSource']>;
    track: Track;
    intervalMs: number;
    last: number;
  }>();
  #frameQueued = false;

  constructor() {
    super('canvas');
    const bitmap: Bitmap = {
      width: 300,
      height: 150,
      pixels: new Uint8ClampedArray(300 * 150 * 4),
      painted: () => this.#painted(),
    };
    bitmaps.set(this, bitmap);
    drawables.set(this, () => bitmap);
  }

  get width(): number {
    return (bitmaps.get(this) as Bitmap).width;
  }

  set width(value: number) {
    this.#resize(value, this.height);
  }

  get height(): number {
    return (bitmaps.get(this) as Bitmap).height;
  }

  set height(value: number) {
    this.#resize(this.width, value);
  }

  /** Setting either dimension clears the bitmap, as in a browser. */
  #resize(width: number, height: number): void {
    const bitmap = bitmaps.get(this) as Bitmap;
    bitmap.width = Math.max(0, Math.floor(Number(width))) || 0;
    bitmap.height = Math.max(0, Math.floor(Number(height))) || 0;
    bitmap.pixels = new Uint8ClampedArray(bitmap.width * bitmap.height * 4);
    this.#painted();
  }

  getContext(type: string): CanvasRenderingContext2D | null {
    if (type !== '2d') return null;
    this.#context ??= new CanvasRenderingContext2D(this);
    return this.#context;
  }

  /**
   * A stream whose track carries this canvas: a frame after each task
   * that painted it, at most `frameRate` a second if given.
   */
  captureStream(frameRate?: number): Stream {
    const source = new (nonstandard().RTCVideoSource)();
    const track = source.createTrack();
    allowStopOverride(track);
    const intervalMs = frameRate === undefined || frameRate <= 0 ? 0 : 1000 / frameRate;
    this.#captures.add({ source, track, intervalMs, last: -Infinity });
    return new (implementation as Implementation).MediaStream([track]);
  }

  #painted(): void {
    if (this.#captures.size === 0 || this.#frameQueued) return;
    this.#frameQueued = true;
    queueTask(() => {
      this.#frameQueued = false;
      this.#sendFrame();
    });
  }

  #sendFrame(): void {
    const bitmap = bitmaps.get(this) as Bitmap;
    if (bitmap.width === 0 || bitmap.height === 0) return;
    let frame: I420Frame | null = null;
    const now = performance.now();
    for (const capture of this.#captures) {
      if (capture.track.readyState === 'ended') {
        this.#captures.delete(capture);
        continue;
      }
      if (now - capture.last < capture.intervalMs) continue;
      capture.last = now;
      frame ??= rgbaToI420(bitmap.pixels, bitmap.width, bitmap.height);
      capture.source.onFrame(frame);
    }
  }
}

export class HTMLBodyElement extends HTMLElement {}

export class Document extends Node {
  readonly documentElement = new HTMLElement('html');
  readonly head = new HTMLElement('head');
  readonly body = new HTMLBodyElement('body');
  readonly readyState = 'complete';
  title = '';

  constructor() {
    super();
    this.appendChild(this.documentElement);
    this.documentElement.append(this.head, this.body);
  }

  createElement(name: string): HTMLElement {
    const tag = String(name).toLowerCase();
    if (tag === 'video') return new HTMLVideoElement();
    if (tag === 'audio') return new HTMLAudioElement();
    if (tag === 'canvas') return new HTMLCanvasElement();
    return new HTMLElement(tag);
  }

  getElementById(id: string): HTMLElement | null {
    for (const node of this.descendants()) {
      if (node instanceof HTMLElement && node.id === String(id)) return node;
    }
    return null;
  }
}

// --- Animation frames --------------------------------------------------------

let animationCallbacks = new Map<number, (now: number) => void>();
let nextAnimationHandle = 1;
let animationFrameQueued = false;

/** requestAnimationFrame at about 60 Hz. */
export function requestAnimationFrame(callback: (now: number) => void): number {
  const handle = nextAnimationHandle++;
  animationCallbacks.set(handle, callback);
  if (!animationFrameQueued) {
    animationFrameQueued = true;
    setTimeout(() => {
      animationFrameQueued = false;
      const callbacks = animationCallbacks;
      animationCallbacks = new Map();
      const now = performance.now();
      for (const run of callbacks.values()) run(now);
    }, 16);
  }
  return handle;
}

export function cancelAnimationFrame(handle: number): void {
  animationCallbacks.delete(handle);
}
