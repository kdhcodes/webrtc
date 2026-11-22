// The browser half of the Chrome interop tests: one RTCPeerConnection in the
// page, driven from Node through `window.peer` (page.evaluate) and reporting
// back through `window.__emit` (page.exposeFunction). Plain browser JS, loaded
// with page.addScriptTag; test/interop/chrome.ts is the Node side.
//
// Media is deterministic: an oscillator tone through WebAudio and a canvas
// filled with one grey level, captured with captureStream. Received media is
// measured with getStats and with WebAudio / canvas readback.
(() => {
  /** @type {RTCPeerConnection} */
  let pc;
  /** @type {AudioContext} */
  let ctx;
  /** Candidates that arrived before the remote description. */
  let pending = [];
  const iceErrors = [];
  /** Per remote track id: its receiver measurements. */
  const remote = new Map();
  /** Timers drawing the local canvases. */
  const timers = [];

  const emit = (type, payload) => window.__emit(type, payload ?? null);
  const audio = () => {
    ctx ??= new AudioContext({ sampleRate: 48_000 });
    return ctx;
  };

  function measureAudio(track) {
    // Chrome only decodes remote audio that something plays out; a media
    // element plus a WebAudio source covers both pull paths.
    const element = new Audio();
    element.srcObject = new MediaStream([track]);
    element.muted = true;
    element.play().catch(() => {});
    const analyser = audio().createAnalyser();
    analyser.fftSize = 8192;
    audio()
      .createMediaStreamSource(new MediaStream([track]))
      .connect(analyser);
    return {
      element,
      read() {
        const time = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(time);
        const rms = Math.sqrt(time.reduce((sum, s) => sum + s * s, 0) / time.length);
        const freq = new Float32Array(analyser.frequencyBinCount);
        analyser.getFloatFrequencyData(freq);
        let peak = 0;
        for (let i = 1; i < freq.length; i++) if (freq[i] > freq[peak]) peak = i;
        return { rms, peakHz: (peak * audio().sampleRate) / analyser.fftSize };
      },
    };
  }

  function measureVideo(track) {
    const element = document.createElement('video');
    element.muted = true;
    element.srcObject = new MediaStream([track]);
    element.play().catch(() => {});
    const canvas = document.createElement('canvas');
    return {
      element,
      read() {
        const { videoWidth: width, videoHeight: height } = element;
        if (width === 0) return { width, height, luma: null };
        canvas.width = width;
        canvas.height = height;
        const g = canvas.getContext('2d', { willReadFrequently: true });
        g.drawImage(element, 0, 0);
        const { data } = g.getImageData(0, 0, width, height);
        let sum = 0;
        for (let i = 0; i < data.length; i += 4) sum += data[i];
        return { width, height, luma: sum / (data.length / 4) };
      },
    };
  }

  async function addRemoteCandidate(candidate) {
    try {
      await pc.addIceCandidate(candidate);
    } catch (error) {
      // Candidates still arriving after close() don't count.
      if (pc.signalingState !== 'closed') iceErrors.push(String(error));
    }
  }

  async function flushCandidates() {
    const queued = pending;
    pending = [];
    for (const candidate of queued) await addRemoteCandidate(candidate);
  }

  function senderOf(kind) {
    return pc.getSenders().find((s) => s.track?.kind === kind);
  }

  /** Data channels by label (the tests use unique labels). */
  const channels = new Map();

  function channelInfo(channel) {
    return {
      label: channel.label,
      ordered: channel.ordered,
      maxPacketLifeTime: channel.maxPacketLifeTime,
      maxRetransmits: channel.maxRetransmits,
      protocol: channel.protocol,
      negotiated: channel.negotiated,
      id: channel.id,
      readyState: channel.readyState,
    };
  }

  /** Text as itself, binary as an array of bytes. */
  async function describeMessage(data) {
    if (typeof data === 'string') return { dataType: 'string', value: data };
    const buffer = data instanceof Blob ? await data.arrayBuffer() : data;
    return {
      dataType: data instanceof Blob ? 'Blob' : 'ArrayBuffer',
      value: [...new Uint8Array(buffer)],
    };
  }

  /**
   * Reports the channel's events as 'dc' events ({label, type, ...}), in
   * order: messages are described asynchronously (Blobs), so each event
   * waits for the ones before it.
   */
  function watchChannel(channel) {
    channels.set(channel.label, channel);
    let previous = Promise.resolve();
    const report = (type, extra = async () => ({})) => {
      previous = previous.then(async () =>
        emit('dc', {
          label: channel.label,
          type,
          readyState: channel.readyState,
          ...(await extra()),
        }),
      );
    };
    channel.onopen = () => report('open', async () => ({ id: channel.id }));
    channel.onclosing = () => report('closing');
    channel.onclose = () => report('close');
    channel.onerror = ({ error }) =>
      report('error', async () => ({ errorDetail: error.errorDetail, name: error.name }));
    channel.onmessage = ({ data }) => report('message', async () => describeMessage(data));
  }

  window.peer = {
    create(config = {}) {
      pc = new RTCPeerConnection(config);
      pc.onicecandidate = ({ candidate }) => emit('icecandidate', candidate?.toJSON() ?? null);
      pc.onconnectionstatechange = () => emit('connectionstatechange', pc.connectionState);
      pc.ontrack = ({ track, transceiver, streams }) => {
        remote.set(track.id, track.kind === 'audio' ? measureAudio(track) : measureVideo(track));
        for (const stream of streams) {
          stream.onremovetrack = (e) => emit('removetrack', { trackId: e.track.id });
        }
        emit('track', { kind: track.kind, trackId: track.id, mid: transceiver.mid });
      };
      pc.ondatachannel = ({ channel }) => {
        watchChannel(channel);
        emit('datachannel', channelInfo(channel));
      };
    },

    /** Creates a data channel; its events are reported as 'dc' events. */
    createDataChannel(label, init = {}) {
      const channel = pc.createDataChannel(label, init);
      channel.binaryType = 'arraybuffer';
      watchChannel(channel);
      return channelInfo(channel);
    },

    channelInfo: (label) => channelInfo(channels.get(label)),

    /**
     * Sends on channel `label`: `{string}`, `{bytes}` (an ArrayBuffer of
     * them), `{view}` (the bytes in the middle of a larger buffer) or
     * `{blob}` (bytes, as a Blob).
     */
    send(label, message) {
      const channel = channels.get(label);
      if (message.string !== undefined) channel.send(message.string);
      else if (message.bytes) channel.send(new Uint8Array(message.bytes).buffer);
      else if (message.view) channel.send(new Uint8Array([0, ...message.view, 0]).subarray(1, -1));
      else if (message.blob) channel.send(new Blob([new Uint8Array(message.blob)]));
    },

    /** Sends `size` bytes, byte i being i % 251. */
    sendLarge(label, size) {
      channels.get(label).send(new Uint8Array(size).map((_, i) => i % 251).buffer);
    },

    setBinaryType(label, type) {
      channels.get(label).binaryType = type;
    },

    closeChannel(label) {
      channels.get(label).close();
    },

    sctp: () =>
      pc.sctp && {
        state: pc.sctp.state,
        maxMessageSize: pc.sctp.maxMessageSize,
        maxChannels: pc.sctp.maxChannels,
      },

    /** Sends a sine tone at `frequency` Hz from an oscillator. */
    addTone(frequency) {
      const oscillator = audio().createOscillator();
      oscillator.frequency.value = frequency;
      const gain = audio().createGain();
      gain.gain.value = 0.5;
      const destination = audio().createMediaStreamDestination();
      oscillator.connect(gain).connect(destination);
      oscillator.start();
      const [track] = destination.stream.getAudioTracks();
      pc.addTrack(track, destination.stream);
      return track.id;
    },

    /**
     * Sends a `width` x `height` canvas filled with grey `level` (0-255),
     * redrawn at 30 fps with a small moving block so the encoder sees motion.
     */
    addCanvas(width, height, level) {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const g = canvas.getContext('2d');
      let x = 0;
      const draw = () => {
        g.fillStyle = `rgb(${level},${level},${level})`;
        g.fillRect(0, 0, width, height);
        g.fillStyle = level > 127 ? 'black' : 'white';
        g.fillRect(x, 0, 8, 8);
        x = (x + 2) % (width - 8);
      };
      draw();
      timers.push(setInterval(draw, 33));
      const stream = canvas.captureStream(30);
      const [track] = stream.getVideoTracks();
      pc.addTrack(track, stream);
      return track.id;
    },

    removeTrack(kind) {
      pc.removeTrack(senderOf(kind));
    },

    async createOffer() {
      await pc.setLocalDescription();
      return pc.localDescription.toJSON();
    },

    async acceptOffer(offer) {
      await pc.setRemoteDescription(offer);
      await flushCandidates();
      await pc.setLocalDescription();
      return pc.localDescription.toJSON();
    },

    async acceptAnswer(answer) {
      await pc.setRemoteDescription(answer);
      await flushCandidates();
    },

    /**
     * Perfect negotiation, as in the spec's example: from now on the page
     * offers on negotiationneeded and answers remote offers, and as the
     * impolite peer ignores an offer that collides with its own. Its
     * descriptions go out as 'description' events and come in through
     * `description()`, which resolves with 'ignored' or 'applied'.
     * Failures are reported as 'negotiationerror' events.
     */
    perfectNegotiation(polite) {
      let makingOffer = false;
      pc.onnegotiationneeded = async () => {
        try {
          makingOffer = true;
          await pc.setLocalDescription();
          emit('description', pc.localDescription.toJSON());
        } catch (error) {
          emit('negotiationerror', String(error));
        } finally {
          makingOffer = false;
        }
      };
      window.peer.description = async (description) => {
        try {
          const collision =
            description.type === 'offer' && (makingOffer || pc.signalingState !== 'stable');
          if (collision && !polite) return 'ignored';
          await pc.setRemoteDescription(description);
          await flushCandidates();
          if (description.type === 'offer') {
            await pc.setLocalDescription();
            emit('description', pc.localDescription.toJSON());
          }
          return 'applied';
        } catch (error) {
          emit('negotiationerror', String(error));
          return 'failed';
        }
      };
    },

    async addIceCandidate(candidate) {
      if (pc.remoteDescription) await addRemoteCandidate(candidate);
      else pending.push(candidate);
    },

    iceErrors: () => iceErrors,
    connectionState: () => pc.connectionState,
    signalingState: () => pc.signalingState,
    videoCodecs: () => RTCRtpReceiver.getCapabilities('video').codecs.map((c) => c.mimeType),

    /** Every stats object of `type`, for failure messages. */
    async stats(type) {
      return [...(await pc.getStats()).values()].filter((s) => s.type === type);
    },

    transceivers() {
      return pc.getTransceivers().map((t) => ({
        mid: t.mid,
        kind: t.receiver.track.kind,
        direction: t.direction,
        currentDirection: t.currentDirection,
        remoteTrack: { id: t.receiver.track.id, muted: t.receiver.track.muted },
      }));
    },

    /** inbound-rtp of each receiving transceiver, with its codec and track measurements. */
    async inbound() {
      const report = await pc.getStats();
      const result = [];
      for (const stats of report.values()) {
        if (stats.type !== 'inbound-rtp') continue;
        const transceiver = pc.getTransceivers().find((t) => t.mid === stats.mid);
        const trackId = transceiver?.receiver.track.id;
        result.push({
          kind: stats.kind,
          mid: stats.mid,
          trackId,
          codec: report.get(stats.codecId)?.mimeType ?? null,
          packetsReceived: stats.packetsReceived ?? 0,
          framesDecoded: stats.framesDecoded ?? 0,
          frameWidth: stats.frameWidth ?? 0,
          frameHeight: stats.frameHeight ?? 0,
          framesPerSecond: stats.framesPerSecond ?? 0,
          totalAudioEnergy: stats.totalAudioEnergy ?? 0,
          audioLevel: stats.audioLevel ?? 0,
          measured: remote.get(trackId)?.read() ?? null,
        });
      }
      return result;
    },

    close() {
      for (const timer of timers) clearInterval(timer);
      pc.close();
    },
  };
})();
