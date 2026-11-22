## darwin-arm64, 2026-11-20

- Darwin 27.0.0, Apple M3 Pro x 12, 36 GB, Node v24.22.2
- @roamhq/wrtc 0.10.0
- 2026-11-20 09:17 UTC: recv-x6, vga, local
  - ours 0.0.0 at a1e03ad (dirty), dist/; wrtc.node sha256 a71be0ddd644, native inputs 7d5221c70b5c
  - 5 runs per implementation; media: 5 s warm-up, 20 s window
  - load average (1/5/15 min) 1.98 / 3.41 / 4.71 at start, 2.93 / 3.32 / 4.07 at end
- cells: median [min–max] over runs

### recv-x6: receive-heavy: 1 pair, audio + 6 VP8 tracks of 640x480@30 into 6 remote sinks

| metric | ours | wrtc | ours / wrtc (medians) | paired ours / wrtc per run |
|---|---|---|---|---|
| CPU, % of one core | 114.1 [86.0–121.7] | 119.0 [85.8–121.2] | 0.96 | 1.00 [0.72–1.33] |
|   user | 105.0 [79.8–112.2] | 106.7 [76.7–108.3] | 0.98 | 1.03 [0.75–1.37] |
|   sys | 9.1 [6.3–9.5] | 12.3 [9.1–12.9] | 0.74 | 0.74 [0.51–1.00] |
| RSS steady (median), MB | 264 [257–268] | 223 [218–226] | 1.18 | 1.20 [1.15–1.22] |
| RSS peak in window, MB | 268 [259–269] | 224 [220–229] | 1.20 | 1.20 [1.15–1.22] |
| RSS peak, process lifetime, MB | 321 [320–325] | 271 [266–276] | 1.18 | 1.20 [1.16–1.21] |
| JS heap used (median), MB | 7.4 [7.3–7.6] | 6.8 [6.2–6.9] | 1.09 | 1.10 [1.07–1.20] |
| external + ArrayBuffers (median), MB | 35.1 [33.8–39.9] | 21.9 [19.2–22.3] | 1.60 | 1.62 [1.54–1.82] |
| event-loop delay p50, ms | 0.24 [0.19–0.27] | 0.20 [0.13–0.26] | 1.21 | 1.25 [0.91–1.43] |
| event-loop delay p99, ms | 4.28 [1.35–5.07] | 4.11 [2.65–4.46] | 1.04 | 0.96 [0.32–1.63] |
| event-loop delay max, ms | 7.3 [4.8–17.0] | 7.0 [5.7–10.3] | 1.05 | 0.91 [0.81–1.66] |
| GC events / s | 2.3 [2.3–2.4] | 2.1 [2.1–2.2] | 1.09 | 1.09 [1.07–1.14] |
|   major GC / s | 1.15 [1.15–1.20] | 0.00 [0.00–0.05] | n/a | n/a |
| GC time, ms / s | 1.09 [0.81–1.19] | 0.62 [0.56–1.42] | 1.77 | 1.59 [0.84–2.00] |
| JS (main) thread CPU, ms / s | 53.6 [36.3–57.4] | 56.4 [41.7–58.2] | 0.95 | 0.97 [0.66–1.29] |
|   outside pushes and handlers (sink delivery, callbacks, timers, GC) | 33.0 [23.4–35.1] | 36.4 [28.6–39.2] | 0.91 | 0.89 [0.65–1.16] |
| JS thread busy (event-loop utilization, wall clock), ms / s | 89.6 [45.3–100.3] | 98.5 [87.3–115.4] | 0.91 | 0.87 [0.46–1.03] |
|   in onData/onFrame pushes | 12.85 [6.85–14.02] | 11.40 [7.46–11.99] | 1.13 | 1.22 [0.60–1.72] |
|   in sink handlers (this script) | 1.99 [1.39–2.41] | 1.71 [1.33–1.79] | 1.17 | 1.17 [0.90–1.50] |
|   other: sink event delivery, callbacks, timers, GC | 69.0 [32.4–77.9] | 79.4 [74.2–96.8] | 0.87 | 0.80 [0.41–0.95] |
| push timer lateness p99, ms | 2.49 [1.30–3.41] | 2.64 [2.49–3.03] | 0.94 | 1.00 [0.49–1.13] |
| audio sink callbacks / s (per sink) | 100.0 [100.0–100.0] | 100.0 [100.0–100.0] | 1.00 | 1.00 [1.00–1.00] |
| video streams sent (all pairs) | 6 [6–6] | 6 [6–6] | 1.00 | 1.00 [1.00–1.00] |
| video sinks | 6 [6–6] | 6 [6–6] | 1.00 | 1.00 [1.00–1.00] |
| video frames / s delivered (per sink) | 29.7 [29.6–29.7] | 29.7 [29.6–29.8] | 1.00 | 1.00 [1.00–1.00] |
|   slowest sink | 29.6 [29.6–29.6] | 29.6 [29.6–29.7] | 1.00 | 1.00 [1.00–1.00] |
| video frames never delivered, % | 1.17 [0.97–1.22] | 1.17 [1.03–1.36] | 1.00 | 1.00 [0.88–1.08] |
| frames at full (expected) resolution, % | 100.0 [100.0–100.0] | 100.0 [100.0–100.0] | 1.00 | 1.00 [1.00–1.00] |
| source-to-sink latency p50, ms | 25.9 [24.1–26.6] | 86.8 [83.7–92.5] | 0.30 | 0.28 [0.28–0.32] |
| source-to-sink latency p99, ms | 42.4 [34.1–43.9] | 117.5 [113.5–164.5] | 0.36 | 0.34 [0.21–0.38] |
| source-to-sink latency max, ms | 95.4 [74.0–112.4] | 205.9 [122.8–267.3] | 0.46 | 0.46 [0.36–0.73] |
| frames later than 100 ms, % | 0.00 [0.00–0.05] | 13.49 [7.64–29.91] | 0.00 | 0.00 [0.00–0.00] |
| video packet send (pacer) delay, ms / packet | 0.25 [0.12–0.45] | 19.66 [17.34–21.50] | 0.01 | 0.01 [0.01–0.02] |
| audio packet send delay, ms / packet | 0.00 [0.00–0.00] | n/a | n/a | n/a |
| jitter buffer delay, ms / frame | 19.4 [18.6–21.3] | 66.3 [65.8–68.8] | 0.29 | 0.29 [0.27–0.32] |
| receive processing delay (arrival to decoded), ms / frame | 20.8 [20.0–22.3] | 78.7 [76.1–82.8] | 0.26 | 0.26 [0.24–0.29] |
| video bitrate, kbps (per pair) | 8687 [8525–9190] | 8127 [7908–8202] | 1.07 | 1.06 [1.05–1.16] |
| audio bitrate, kbps (per pair) | 32.4 [32.4–32.4] | 29.3 [29.3–29.3] | 1.11 | 1.11 [1.11–1.11] |
| encode time, ms / frame | 4.36 [3.17–4.64] | 4.24 [2.94–4.37] | 1.03 | 1.06 [0.74–1.48] |
| decode time, ms / frame | 1.26 [0.96–1.35] | 1.22 [0.96–1.28] | 1.03 | 1.04 [0.79–1.31] |
| average QP | 11.9 [10.5–12.4] | 14.1 [13.9–14.6] | 0.85 | 0.85 [0.73–0.87] |
| frames encoded / s (per pair, all layers) | 178.0 [177.9–178.2] | 178.1 [177.5–178.2] | 1.00 | 1.00 [1.00–1.00] |
| process CPU per encoded frame, ms | 6.41 [4.84–6.83] | 6.70 [4.81–6.80] | 0.96 | 1.00 [0.72–1.33] |
| teardown (stop sinks, close PCs), ms | 6.1 [3.1–9.1] | 6.5 [4.7–9.0] | 0.95 | 0.91 [0.34–1.95] |
| exit after teardown, ms | 9 [7–12] | process.exit() | n/a | n/a |
| load average (1 min) after the run | 5.16 [2.45–6.34] | 5.05 [3.13–5.85] | n/a | n/a |
| codec | video/VP8 | video/VP8 | | |
| encoder | libvpx | libvpx | | |
| decoder | libvpx | libvpx | | |
| qualityLimitation | none | none | | |

### vga: 1 pair, audio + 640x480@30 VP8

| metric | ours | wrtc | ours / wrtc (medians) | paired ours / wrtc per run |
|---|---|---|---|---|
| CPU, % of one core | 44.1 [33.9–50.2] | 47.1 [39.7–47.5] | 0.94 | 0.93 [0.85–1.08] |
|   user | 37.9 [29.1–43.5] | 39.4 [32.9–39.6] | 0.96 | 0.96 [0.89–1.14] |
|   sys | 5.9 [4.8–6.7] | 7.7 [6.9–7.9] | 0.77 | 0.78 [0.70–0.87] |
| RSS steady (median), MB | 72 [71–77] | 64 [59–69] | 1.11 | 1.12 [1.08–1.21] |
| RSS peak in window, MB | 73 [72–78] | 65 [59–69] | 1.13 | 1.13 [1.11–1.24] |
| RSS peak, process lifetime, MB | 124 [123–129] | 111 [106–115] | 1.12 | 1.12 [1.08–1.17] |
| JS heap used (median), MB | 8.3 [8.2–8.5] | 6.8 [6.5–6.9] | 1.22 | 1.22 [1.22–1.25] |
| external + ArrayBuffers (median), MB | 8.3 [7.8–9.2] | 8.3 [6.9–8.7] | 1.01 | 1.07 [0.96–1.13] |
| event-loop delay p50, ms | 0.26 [0.23–0.33] | 0.17 [0.14–0.20] | 1.47 | 1.47 [1.16–1.98] |
| event-loop delay p99, ms | 1.38 [1.21–1.45] | 1.53 [1.30–1.57] | 0.90 | 0.93 [0.79–0.98] |
| event-loop delay max, ms | 1.9 [1.6–17.1] | 10.1 [1.6–18.1] | 0.18 | 0.41 [0.16–6.09] |
| GC events / s | 1.4 [1.3–1.5] | 2.0 [2.0–2.1] | 0.71 | 0.72 [0.66–0.73] |
|   major GC / s | 0.05 [0.05–0.05] | 0.00 [0.00–0.00] | n/a | n/a |
| GC time, ms / s | 0.54 [0.44–0.58] | 0.64 [0.53–0.66] | 0.85 | 0.85 [0.82–0.96] |
| JS (main) thread CPU, ms / s | 46.6 [38.9–51.2] | 49.0 [44.0–51.1] | 0.95 | 0.91 [0.88–1.05] |
|   outside pushes and handlers (sink delivery, callbacks, timers, GC) | 27.8 [21.2–30.3] | 30.9 [26.4–32.4] | 0.90 | 0.86 [0.80–0.98] |
| JS thread busy (event-loop utilization, wall clock), ms / s | 48.6 [40.2–53.2] | 51.2 [47.0–54.3] | 0.95 | 0.90 [0.86–1.04] |
|   in onData/onFrame pushes | 7.70 [5.61–8.60] | 7.39 [6.70–8.02] | 1.04 | 0.97 [0.84–1.18] |
|   in sink handlers (this script) | 1.46 [0.81–1.51] | 1.21 [0.96–1.27] | 1.21 | 1.17 [0.84–1.21] |
|   other: sink event delivery, callbacks, timers, GC | 29.9 [22.6–32.2] | 33.7 [29.4–35.6] | 0.89 | 0.87 [0.77–0.98] |
| push timer lateness p99, ms | 1.20 [1.19–1.23] | 1.22 [1.18–1.50] | 0.98 | 0.98 [0.82–1.01] |
| audio sink callbacks / s (per sink) | 100.0 [100.0–100.0] | 100.0 [100.0–100.0] | 1.00 | 1.00 [1.00–1.00] |
| video streams sent (all pairs) | 1 [1–1] | 1 [1–1] | 1.00 | 1.00 [1.00–1.00] |
| video sinks | 1 [1–1] | 1 [1–1] | 1.00 | 1.00 [1.00–1.00] |
| video frames / s delivered (per sink) | 29.7 [29.7–29.8] | 29.6 [29.6–29.7] | 1.00 | 1.00 [1.00–1.00] |
|   slowest sink | 29.7 [29.7–29.8] | 29.6 [29.6–29.7] | 1.00 | 1.00 [1.00–1.00] |
| video frames never delivered, % | 1.00 [0.67–1.00] | 1.17 [1.00–1.33] | 0.86 | 0.75 [0.67–0.86] |
| frames at full (expected) resolution, % | 100.0 [100.0–100.0] | 100.0 [100.0–100.0] | 1.00 | 1.00 [1.00–1.00] |
| source-to-sink latency p50, ms | 33.4 [32.3–39.9] | 67.2 [64.5–74.0] | 0.50 | 0.51 [0.48–0.56] |
| source-to-sink latency p99, ms | 39.5 [37.2–43.0] | 71.7 [68.4–81.7] | 0.55 | 0.54 [0.50–0.57] |
| source-to-sink latency max, ms | 78.2 [54.3–79.5] | 126.4 [108.6–135.1] | 0.62 | 0.58 [0.42–0.72] |
| frames later than 100 ms, % | 0.00 [0.00–0.00] | 0.32 [0.16–0.96] | 0.00 | 0.00 [0.00–0.00] |
| video packet send (pacer) delay, ms / packet | 0.37 [0.28–0.47] | 17.08 [16.11–18.97] | 0.02 | 0.02 [0.02–0.02] |
| audio packet send delay, ms / packet | 0.00 [0.00–0.00] | n/a | n/a | n/a |
| jitter buffer delay, ms / frame | 23.3 [21.1–25.7] | 52.0 [49.2–56.9] | 0.45 | 0.44 [0.43–0.49] |
| receive processing delay (arrival to decoded), ms / frame | 25.3 [23.8–28.9] | 59.7 [55.2–62.5] | 0.42 | 0.45 [0.42–0.48] |
| video bitrate, kbps (per pair) | 1619 [1613–1655] | 1584 [1547–1597] | 1.02 | 1.04 [1.02–1.05] |
| audio bitrate, kbps (per pair) | 32.4 [32.4–32.4] | 35.2 [31.3–35.2] | 0.92 | 0.92 [0.92–1.04] |
| encode time, ms / frame | 7.09 [5.42–8.71] | 6.67 [5.35–6.76] | 1.06 | 1.05 [1.01–1.31] |
| decode time, ms / frame | 2.67 [1.95–3.33] | 2.62 [2.10–2.76] | 1.02 | 1.02 [0.92–1.35] |
| average QP | 9.8 [8.4–9.8] | 11.3 [10.5–12.2] | 0.87 | 0.81 [0.80–0.87] |
| frames encoded / s (per pair, all layers) | 29.7 [29.7–29.8] | 29.6 [29.6–29.7] | 1.00 | 1.00 [1.00–1.00] |
| process CPU per encoded frame, ms | 14.86 [11.42–16.84] | 15.85 [13.42–16.02] | 0.94 | 0.93 [0.85–1.08] |
| teardown (stop sinks, close PCs), ms | 2.9 [2.0–4.2] | 5.4 [2.2–5.8] | 0.54 | 0.68 [0.36–1.01] |
| exit after teardown, ms | 5 [5–12] | process.exit() | n/a | n/a |
| load average (1 min) after the run | 4.20 [3.22–5.35] | 3.86 [3.30–4.95] | n/a | n/a |
| codec | video/VP8 | video/VP8 | | |
| encoder | libvpx | libvpx | | |
| decoder | libvpx | libvpx | | |
| qualityLimitation | none | none | | |

### local: no peer connection: 4 local sources (audio + 1280x720@30) straight into sinks

| metric | ours | wrtc | ours / wrtc (medians) | paired ours / wrtc per run |
|---|---|---|---|---|
| CPU, % of one core | 13.4 [13.3–14.3] | 9.2 [6.5–9.5] | 1.46 | 1.46 [1.40–2.14] |
|   user | 11.7 [11.6–12.6] | 7.8 [5.4–8.0] | 1.51 | 1.51 [1.45–2.23] |
|   sys | 1.7 [1.6–1.8] | 1.4 [1.1–1.5] | 1.20 | 1.18 [1.11–1.67] |
| RSS steady (median), MB | 137 [128–159] | 128 [122–138] | 1.08 | 1.13 [0.95–1.20] |
| RSS peak in window, MB | 161 [145–172] | 139 [122–143] | 1.16 | 1.24 [1.01–1.31] |
| JS heap used (median), MB | 7.2 [7.2–7.3] | 6.6 [6.5–6.7] | 1.09 | 1.10 [1.09–1.10] |
| external + ArrayBuffers (median), MB | 37.6 [32.4–42.9] | 31.9 [26.6–37.2] | 1.18 | 1.18 [1.01–1.41] |
| event-loop delay p50, ms | 0.41 [0.40–0.43] | 0.37 [0.31–0.42] | 1.11 | 1.15 [0.98–1.37] |
| event-loop delay p99, ms | 2.98 [2.98–3.13] | 1.92 [1.62–2.02] | 1.55 | 1.57 [1.55–1.85] |
| event-loop delay max, ms | 14.0 [7.2–19.5] | 7.9 [2.4–22.5] | 1.76 | 0.91 [0.63–7.63] |
| GC events / s | 4.1 [4.0–4.1] | 3.2 [3.2–3.3] | 1.26 | 1.26 [1.24–1.28] |
|   major GC / s | 1.40 [1.40–1.45] | 0.00 [0.00–0.00] | n/a | n/a |
| GC time, ms / s | 3.01 [2.85–3.23] | 0.96 [0.83–1.13] | 3.13 | 3.13 [2.53–3.60] |
| JS (main) thread CPU, ms / s | 108.4 [107.9–116.3] | 86.2 [60.5–88.9] | 1.26 | 1.25 [1.22–1.89] |
|   outside pushes and handlers (sink delivery, callbacks, timers, GC) | 47.1 [45.7–50.6] | 50.3 [35.1–51.1] | 0.94 | 0.94 [0.90–1.44] |
| JS thread busy (event-loop utilization, wall clock), ms / s | 111.5 [110.3–121.6] | 88.0 [61.7–90.5] | 1.27 | 1.27 [1.22–1.93] |
|   in onData/onFrame pushes | 44.52 [43.52–49.35] | 18.70 [12.98–19.51] | 2.38 | 2.37 [2.25–3.57] |
|   in sink handlers (this script) | 1.52 [1.44–1.81] | 1.27 [0.98–1.28] | 1.19 | 1.19 [1.12–1.85] |
|   other: sink event delivery, callbacks, timers, GC | 49.3 [47.7–55.1] | 52.1 [36.3–53.5] | 0.95 | 0.95 [0.92–1.52] |
| push timer lateness p99, ms | 1.34 [1.25–1.39] | 1.22 [1.18–1.30] | 1.10 | 1.10 [1.01–1.14] |
| audio sink callbacks / s (per sink) | 100.0 [100.0–100.0] | 100.0 [100.0–100.0] | 1.00 | 1.00 [1.00–1.00] |
| video frames / s delivered (per sink) | 30.0 [30.0–30.0] | 30.0 [30.0–30.0] | 1.00 | 1.00 [1.00–1.00] |
| source-to-sink latency p50, ms | 2.1 [2.0–2.2] | 1.1 [0.6–1.1] | 2.00 | 1.95 [1.89–3.58] |
| source-to-sink latency p99, ms | 3.9 [3.6–4.1] | 2.5 [2.3–2.9] | 1.52 | 1.59 [1.23–1.70] |
| exit after teardown, ms | 13 [9–16] | process.exit() | n/a | n/a |
| load average (1 min) after the run | 2.89 [2.65–3.16] | 2.76 [2.57–3.04] | n/a | n/a |

