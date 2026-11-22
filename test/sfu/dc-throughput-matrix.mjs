// Runs dc-throughput.mjs over a matrix and prints a Markdown table.
//   node dc-throughput-matrix.mjs <mediasoup dir>[,<dir>...] [--runs N] [--duration S]
//     [--sizes 1k,64k] [--strategies burst,one] [--send-buffers 0,4m] [--extra '<args>']
// Prints one Markdown table row per run (stdout) and all results as JSON (stderr).
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};
const dirs = argv[0].split(',');
const runs = Number(arg('--runs', 2));
const duration = arg('--duration', '5');
const sizes = arg('--sizes', '1k,64k').split(',');
const strategies = arg('--strategies', 'burst,one').split(',');
const buffers = arg('--send-buffers', '0').split(',');
const extra = arg('--extra', '').split(' ').filter(Boolean);
const script = fileURLToPath(new URL('./dc-throughput.mjs', import.meta.url));

const rows = [];
for (const dir of dirs) {
  for (const size of sizes) {
    for (const strategy of strategies) {
      for (const buf of buffers) {
        for (let i = 0; i < runs; i++) {
          const args = [
            script,
            '--json',
            '--size',
            size,
            '--strategy',
            strategy,
            '--duration',
            duration,
            ...extra,
          ];
          if (buf !== '0') args.push('--send-buffer', buf);
          let r;
          try {
            const out = execFileSync(process.execPath, args, {
              env: { ...process.env, MEDIASOUP_DIR: dir },
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'inherit'],
              timeout: (Number(duration) + 120) * 1000,
            });
            r = JSON.parse(out.trim().split('\n').pop());
          } catch (e) {
            r = { label: `${dir} ${size} ${strategy} buf=${buf}`, error: String(e).slice(0, 200) };
          }
          rows.push(r);
          const f = (x, n = 1) => (x == null ? '-' : Number(x).toFixed(n));
          const line = r.error
            ? `| ${r.label} | ERROR ${r.error} |`
            : `| ${r.label} | ${f(r.mibps)} | ${f(r.msgps, 0)} | ${r.received}/${r.sent} | ${f(r.lostPct, 2)}% | ${r.sfuSendBufferFullEvents} | ${r.gaps.length ? r.gaps.join(' ') : '-'} | ${r.udpBufferDrops} | ${f(r.workerCpuPct, 0)}% | ${r.pairs.sender?.vpn || r.pairs.receiver?.vpn ? 'VPN' : 'lan/lo'} | ${r.childExit.sender.code}/${r.childExit.receiver.code} |`;
          console.log(line);
        }
      }
    }
  }
}
console.error(JSON.stringify(rows));
