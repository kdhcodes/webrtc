## darwin-arm64, 2026-11-20

- Darwin 27.0.0, Apple M3 Pro x 12, 36 GB, Node v24.22.2
- @roamhq/wrtc 0.10.0
- 2026-11-20 08:59 UTC: recv-x6, vga, local
  - ours 0.0.0 at 3f343f7 (dirty), dist/; wrtc.node sha256 5236efddb9d6, native inputs e5a9b5b129da
  - 5 runs per implementation; media: 5 s warm-up, 20 s window
  - load average (1/5/15 min) 15.48 / 10.42 / 7.00 at start, 3.83 / 4.37 / 5.38 at end
- cells: median [min–max] over runs

### recv-x6: receive-heavy: 1 pair, audio + 6 VP8 tracks of 640x480@30 into 6 remote sinks

| metric | ours | wrtc | ours / wrtc (medians) | paired ours / wrtc per run |
|---|---|---|---|---|
| CPU, % of one core | 109.0 [92.4–119.7] | 110.3 [72.4–121.5] | 0.99 | 0.97 [0.92–1.28] |
|   user | 101.1 [87.2–110.9] | 98.8 [65.7–108.7] | 1.02 | 1.00 [0.95–1.33] |
|   sys | 7.9 [5.2–8.8] | 11.5 [6.7–12.8] | 0.69 | 0.67 [0.64–0.81] |
| RSS steady (median), MB | 265 [226–278] | 223 [212–230] | 1.19 | 1.20 [1.07–1.21] |
| RSS peak in window, MB | 268 [229–279] | 229 [213–232] | 1.17 | 1.19 [1.08–1.21] |
| RSS peak, process lifetime, MB | 322 [280–330] | 276 [259–279] | 1.17 | 1.17 [1.08–1.20] |
| JS heap used (median), MB | 7.4 [7.3–7.5] | 6.7 [6.1–6.8] | 1.10 | 1.09 [1.08–1.23] |
| external + ArrayBuffers (median), MB | 36.0 [32.9–39.0] | 21.9 [19.7–22.3] | 1.64 | 1.67 [1.51–1.94] |
| event-loop delay p50, ms | 0.21 [0.20–0.25] | 0.19 [0.13–0.24] | 1.09 | 1.09 [0.93–1.59] |
| event-loop delay p99, ms | 3.54 [1.12–4.65] | 3.90 [1.45–4.25] | 0.91 | 0.85 [0.45–1.19] |
| event-loop delay max, ms | 6.2 [1.6–9.2] | 6.1 [1.7–7.5] | 1.00 | 1.00 [0.90–1.25] |
| GC events / s | 2.4 [2.3–2.4] | 2.1 [2.1–2.2] | 1.09 | 1.09 [1.07–1.14] |
|   major GC / s | 1.15 [1.15–1.20] | 0.00 [0.00–0.05] | n/a | n/a |
| GC time, ms / s | 1.05 [0.94–1.36] | 0.55 [0.31–0.74] | 1.90 | 1.85 [1.41–3.10] |
| JS (main) thread CPU, ms / s | 46.0 [29.8–53.5] | 52.8 [26.1–59.8] | 0.87 | 0.87 [0.81–1.17] |
|   outside pushes and handlers (sink delivery, callbacks, timers, GC) | 28.4 [17.4–31.8] | 35.0 [16.7–39.1] | 0.81 | 0.81 [0.74–1.06] |
| JS thread busy (event-loop utilization, wall clock), ms / s | 77.1 [34.4–85.2] | 87.4 [30.5–100.7] | 0.88 | 0.86 [0.73–1.13] |
|   in onData/onFrame pushes | 10.99 [6.42–13.64] | 10.41 [4.71–12.51] | 1.06 | 1.06 [0.96–1.50] |
|   in sink handlers (this script) | 1.87 [1.01–2.12] | 1.57 [0.72–1.74] | 1.20 | 1.17 [1.08–1.46] |
|   other: sink event delivery, callbacks, timers, GC | 58.6 [22.0–63.4] | 69.5 [21.2–82.9] | 0.84 | 0.76 [0.67–1.04] |
| push timer lateness p99, ms | 1.64 [1.46–2.44] | 2.22 [1.17–2.86] | 0.74 | 0.85 [0.60–1.25] |
| audio sink callbacks / s (per sink) | 100.0 [100.0–100.0] | 100.0 [100.0–100.0] | 1.00 | 1.00 [1.00–1.00] |
| video streams sent (all pairs) | 6 [6–6] | 6 [6–6] | 1.00 | 1.00 [1.00–1.00] |
| video sinks | 6 [6–6] | 6 [6–6] | 1.00 | 1.00 [1.00–1.00] |
| video frames / s delivered (per sink) | 29.7 [29.7–29.7] | 29.7 [29.7–29.7] | 1.00 | 1.00 [1.00–1.00] |
|   slowest sink | 29.6 [29.6–29.6] | 29.6 [29.6–29.7] | 1.00 | 1.00 [1.00–1.00] |
| video frames never delivered, % | 1.11 [1.00–1.17] | 1.14 [1.06–1.28] | 0.98 | 0.95 [0.88–1.05] |
| frames at full (expected) resolution, % | 100.0 [100.0–100.0] | 100.0 [100.0–100.0] | 1.00 | 1.00 [1.00–1.00] |
| source-to-sink latency p50, ms | 25.7 [22.8–26.8] | 84.2 [83.4–90.3] | 0.31 | 0.30 [0.27–0.32] |
| source-to-sink latency p99, ms | 42.0 [34.2–44.6] | 116.7 [104.9–156.4] | 0.36 | 0.35 [0.27–0.43] |
| source-to-sink latency max, ms | 79.1 [72.5–95.6] | 176.7 [135.5–259.2] | 0.45 | 0.45 [0.31–0.55] |
| frames later than 100 ms, % | 0.00 [0.00–0.00] | 7.19 [2.92–26.27] | 0.00 | 0.00 [0.00–0.00] |
| video packet send (pacer) delay, ms / packet | 0.30 [0.14–0.34] | 18.35 [17.58–21.28] | 0.02 | 0.02 [0.01–0.02] |
| audio packet send delay, ms / packet | 0.00 [0.00–0.00] | n/a | n/a | n/a |
| jitter buffer delay, ms / frame | 19.4 [17.9–20.7] | 66.6 [63.2–67.6] | 0.29 | 0.29 [0.28–0.31] |
| receive processing delay (arrival to decoded), ms / frame | 20.7 [19.1–21.9] | 76.7 [75.0–80.7] | 0.27 | 0.27 [0.25–0.29] |
| video bitrate, kbps (per pair) | 8751 [8697–9181] | 8227 [7631–8271] | 1.06 | 1.12 [1.06–1.14] |
| audio bitrate, kbps (per pair) | 32.4 [32.4–32.4] | 29.3 [29.3–29.3] | 1.11 | 1.11 [1.11–1.11] |
| encode time, ms / frame | 4.07 [3.35–4.52] | 3.94 [2.38–4.35] | 1.03 | 1.02 [0.97–1.41] |
| decode time, ms / frame | 1.21 [1.14–1.33] | 1.13 [0.84–1.22] | 1.07 | 1.06 [1.02–1.35] |
| average QP | 11.7 [10.6–11.9] | 14.0 [13.9–15.6] | 0.84 | 0.79 [0.75–0.85] |
| frames encoded / s (per pair, all layers) | 178.0 [177.9–178.2] | 178.0 [177.9–178.1] | 1.00 | 1.00 [1.00–1.00] |
| process CPU per encoded frame, ms | 6.12 [5.19–6.72] | 6.19 [4.07–6.83] | 0.99 | 0.96 [0.92–1.27] |
| teardown (stop sinks, close PCs), ms | 3.9 [3.1–5.0] | 5.8 [4.0–8.5] | 0.67 | 0.62 [0.42–0.97] |
| exit after teardown, ms | 11 [7–12] | process.exit() | n/a | n/a |
| load average (1 min) after the run | 6.36 [6.28–13.50] | 7.14 [6.46–9.82] | n/a | n/a |
| codec | video/VP8 | video/VP8 | | |
| encoder | libvpx | libvpx | | |
| decoder | libvpx | libvpx | | |
| qualityLimitation | none | none | | |

### vga: 1 pair, audio + 640x480@30 VP8

| metric | ours | wrtc | ours / wrtc (medians) | paired ours / wrtc per run |
|---|---|---|---|---|
| CPU, % of one core | 32.3 [29.3–37.9] | 38.5 [35.6–39.3] | 0.84 | 0.88 [0.78–0.96] |
|   user | 27.7 [25.2–32.6] | 32.0 [29.7–32.7] | 0.87 | 0.91 [0.81–1.00] |
|   sys | 4.6 [4.0–5.2] | 6.5 [5.8–6.7] | 0.70 | 0.73 [0.64–0.79] |
| RSS steady (median), MB | 74 [71–76] | 65 [63–65] | 1.14 | 1.14 [1.10–1.21] |
| RSS peak in window, MB | 78 [77–81] | 65 [63–65] | 1.19 | 1.20 [1.19–1.28] |
| RSS peak, process lifetime, MB | 128 [128–132] | 111 [109–112] | 1.15 | 1.15 [1.15–1.20] |
| JS heap used (median), MB | 8.2 [8.1–8.5] | 6.6 [6.1–6.9] | 1.24 | 1.27 [1.19–1.32] |
| external + ArrayBuffers (median), MB | 7.9 [7.8–8.7] | 6.9 [5.2–8.3] | 1.14 | 1.14 [0.95–1.60] |
| event-loop delay p50, ms | 0.23 [0.22–0.31] | 0.17 [0.13–0.31] | 1.33 | 1.33 [0.92–2.44] |
| event-loop delay p99, ms | 1.37 [1.30–1.69] | 1.44 [1.28–2.08] | 0.95 | 0.95 [0.81–1.12] |
| event-loop delay max, ms | 2.7 [1.9–9.9] | 2.0 [1.8–2.6] | 1.31 | 1.43 [0.88–4.89] |
| GC events / s | 1.4 [1.4–1.5] | 2.0 [2.0–2.1] | 0.71 | 0.71 [0.71–0.76] |
|   major GC / s | 0.05 [0.00–0.05] | 0.00 [0.00–0.00] | n/a | n/a |
| GC time, ms / s | 0.44 [0.36–0.52] | 0.56 [0.44–0.62] | 0.78 | 0.75 [0.60–1.00] |
| JS (main) thread CPU, ms / s | 38.3 [35.5–43.7] | 43.8 [40.7–44.5] | 0.87 | 0.88 [0.86–0.98] |
|   outside pushes and handlers (sink delivery, callbacks, timers, GC) | 23.5 [21.6–26.9] | 28.3 [26.3–28.5] | 0.83 | 0.84 [0.82–0.95] |
| JS thread busy (event-loop utilization, wall clock), ms / s | 41.4 [38.4–46.0] | 46.3 [43.3–47.0] | 0.89 | 0.90 [0.88–0.99] |
|   in onData/onFrame pushes | 6.47 [5.98–7.36] | 6.95 [6.14–7.03] | 0.93 | 0.97 [0.93–1.09] |
|   in sink handlers (this script) | 1.27 [1.16–1.45] | 1.18 [1.07–1.19] | 1.08 | 1.19 [1.01–1.23] |
|   other: sink event delivery, callbacks, timers, GC | 26.9 [24.4–29.3] | 30.6 [28.9–31.2] | 0.88 | 0.86 [0.85–0.96] |
| push timer lateness p99, ms | 1.19 [1.17–1.30] | 1.36 [1.18–1.53] | 0.88 | 0.88 [0.79–1.00] |
| audio sink callbacks / s (per sink) | 100.0 [100.0–100.0] | 100.0 [100.0–100.0] | 1.00 | 1.00 [1.00–1.00] |
| video streams sent (all pairs) | 1 [1–1] | 1 [1–1] | 1.00 | 1.00 [1.00–1.00] |
| video sinks | 1 [1–1] | 1 [1–1] | 1.00 | 1.00 [1.00–1.00] |
| video frames / s delivered (per sink) | 29.7 [29.7–29.8] | 29.7 [29.5–29.7] | 1.00 | 1.00 [1.00–1.01] |
|   slowest sink | 29.7 [29.7–29.8] | 29.7 [29.5–29.7] | 1.00 | 1.00 [1.00–1.01] |
| video frames never delivered, % | 1.00 [0.67–1.00] | 1.00 [1.00–1.50] | 1.00 | 0.86 [0.67–1.00] |
| frames at full (expected) resolution, % | 100.0 [100.0–100.0] | 100.0 [100.0–100.0] | 1.00 | 1.00 [1.00–1.00] |
| source-to-sink latency p50, ms | 28.3 [26.9–32.2] | 60.4 [59.0–74.0] | 0.47 | 0.47 [0.44–0.50] |
| source-to-sink latency p99, ms | 32.4 [31.0–36.4] | 63.6 [62.1–78.2] | 0.51 | 0.51 [0.47–0.52] |
| source-to-sink latency max, ms | 63.4 [51.9–67.0] | 106.8 [78.7–120.5] | 0.59 | 0.55 [0.50–0.81] |
| frames later than 100 ms, % | 0.00 [0.00–0.00] | 0.48 [0.00–0.48] | 0.00 | 0.00 [0.00–0.00] |
| video packet send (pacer) delay, ms / packet | 0.34 [0.23–0.43] | 15.60 [14.90–16.43] | 0.02 | 0.02 [0.02–0.03] |
| audio packet send delay, ms / packet | 0.00 [0.00–0.00] | n/a | n/a | n/a |
| jitter buffer delay, ms / frame | 20.0 [19.5–23.2] | 45.5 [44.3–57.1] | 0.44 | 0.43 [0.39–0.46] |
| receive processing delay (arrival to decoded), ms / frame | 22.2 [21.1–25.4] | 52.6 [50.8–65.5] | 0.42 | 0.41 [0.38–0.44] |
| video bitrate, kbps (per pair) | 1615 [1614–1646] | 1605 [1526–1606] | 1.01 | 1.02 [1.01–1.06] |
| audio bitrate, kbps (per pair) | 32.4 [32.4–32.4] | 35.2 [35.1–35.2] | 0.92 | 0.92 [0.92–0.92] |
| encode time, ms / frame | 5.09 [4.64–6.12] | 5.35 [4.88–5.45] | 0.95 | 1.01 [0.90–1.12] |
| decode time, ms / frame | 1.78 [1.62–2.13] | 1.92 [1.83–1.97] | 0.93 | 0.96 [0.84–1.08] |
| average QP | 9.9 [8.4–9.9] | 10.5 [10.5–13.0] | 0.94 | 0.86 [0.75–0.94] |
| frames encoded / s (per pair, all layers) | 29.7 [29.7–29.8] | 29.7 [29.5–29.7] | 1.00 | 1.00 [1.00–1.01] |
| process CPU per encoded frame, ms | 10.82 [9.85–12.75] | 12.96 [11.99–13.24] | 0.84 | 0.87 [0.78–0.96] |
| teardown (stop sinks, close PCs), ms | 4.3 [2.0–6.5] | 4.9 [1.6–5.7] | 0.87 | 0.87 [0.39–2.17] |
| exit after teardown, ms | 10 [5–13] | process.exit() | n/a | n/a |
| load average (1 min) after the run | 5.40 [3.35–6.03] | 5.69 [2.78–6.35] | n/a | n/a |
| codec | video/VP8 | video/VP8 | | |
| encoder | libvpx | libvpx | | |
| decoder | libvpx | libvpx | | |
| qualityLimitation | none | none | | |

### local: no peer connection: 4 local sources (audio + 1280x720@30) straight into sinks

| metric | ours | wrtc | ours / wrtc (medians) | paired ours / wrtc per run |
|---|---|---|---|---|
| CPU, % of one core | 10.6 [10.2–13.6] | 10.8 [9.2–12.5] | 0.98 | 1.09 [0.95–1.13] |
|   user | 9.7 [9.3–12.4] | 9.1 [7.7–10.4] | 1.07 | 1.19 [1.03–1.24] |
|   sys | 0.9 [0.9–1.2] | 1.7 [1.5–2.0] | 0.54 | 0.58 [0.50–0.61] |
| RSS steady (median), MB | 151 [127–156] | 130 [122–138] | 1.16 | 1.12 [1.04–1.20] |
| RSS peak in window, MB | 167 [151–187] | 138 [122–143] | 1.21 | 1.24 [1.20–1.31] |
| JS heap used (median), MB | 7.3 [7.2–7.4] | 6.1 [6.0–6.4] | 1.19 | 1.20 [1.15–1.22] |
| external + ArrayBuffers (median), MB | 32.4 [32.3–37.7] | 31.9 [26.6–37.2] | 1.02 | 1.02 [0.87–1.42] |
| event-loop delay p50, ms | 0.66 [0.59–0.74] | 0.58 [0.48–0.75] | 1.13 | 1.17 [0.88–1.26] |
| event-loop delay p99, ms | 2.72 [2.58–2.75] | 2.70 [2.50–2.80] | 1.01 | 0.97 [0.96–1.09] |
| event-loop delay max, ms | 5.0 [4.0–14.8] | 4.2 [3.7–11.9] | 1.19 | 1.25 [0.61–1.52] |
| GC events / s | 4.1 [4.1–4.2] | 3.2 [3.2–3.3] | 1.26 | 1.26 [1.22–1.29] |
|   major GC / s | 1.35 [1.35–1.40] | 0.00 [0.00–0.10] | n/a | n/a |
| GC time, ms / s | 2.57 [2.21–3.26] | 1.29 [0.96–1.58] | 1.99 | 2.40 [1.39–2.50] |
| JS (main) thread CPU, ms / s | 86.1 [83.7–109.4] | 101.2 [86.6–118.1] | 0.85 | 0.93 [0.83–0.97] |
|   outside pushes and handlers (sink delivery, callbacks, timers, GC) | 43.8 [42.7–54.5] | 61.0 [51.3–71.7] | 0.72 | 0.76 [0.70–0.84] |
| JS thread busy (event-loop utilization, wall clock), ms / s | 88.0 [85.5–111.8] | 102.9 [89.6–119.9] | 0.86 | 0.93 [0.83–0.98] |
|   in onData/onFrame pushes | 25.84 [25.07–33.72] | 22.28 [19.42–25.42] | 1.16 | 1.29 [1.13–1.33] |
|   in sink handlers (this script) | 1.92 [1.72–2.25] | 1.94 [1.81–2.53] | 0.99 | 0.94 [0.89–1.09] |
|   other: sink event delivery, callbacks, timers, GC | 46.4 [44.4–57.2] | 62.9 [54.3–73.5] | 0.74 | 0.77 [0.71–0.85] |
| push timer lateness p99, ms | 2.29 [2.16–2.33] | 2.17 [1.95–2.28] | 1.05 | 1.02 [1.01–1.11] |
| audio sink callbacks / s (per sink) | 100.0 [100.0–100.0] | 100.0 [100.0–100.0] | 1.00 | 1.00 [1.00–1.00] |
| video frames / s delivered (per sink) | 30.0 [30.0–30.0] | 30.0 [30.0–30.0] | 1.00 | 1.00 [1.00–1.00] |
| source-to-sink latency p50, ms | 1.2 [1.1–1.5] | 1.3 [0.9–1.5] | 0.93 | 1.03 [0.92–1.23] |
| source-to-sink latency p99, ms | 3.0 [2.7–3.2] | 3.3 [3.2–3.6] | 0.92 | 0.90 [0.87–0.94] |
| exit after teardown, ms | 9 [9–16] | process.exit() | n/a | n/a |
| load average (1 min) after the run | 2.87 [2.77–3.69] | 2.90 [2.59–3.83] | n/a | n/a |

