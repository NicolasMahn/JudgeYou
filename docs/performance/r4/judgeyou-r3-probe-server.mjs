import { monitorEventLoopDelay } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { createApp, LISTEN_BACKLOG } from './source/server/server.js';

globalThis.fetch = () => { throw new Error('External fetch disabled in static probe'); };
const server = createApp({ key: 'probe-not-a-real-key', adminToken: '', origins: ['http://benchmark.local'] });
const durations = new Uint32Array(300002);
const loop = monitorEventLoopDelay({ resolution: 10 });
const metrics = { requests: 0, completed: 0, active: 0, peakActive: 0, connections: 0, openConnections: 0, peakConnections: 0, apiAttempts: 0, statuses: {} };
let durationMax = 0;
const tcp = () => {
  const lines = readFileSync('/proc/net/netstat', 'utf8').trim().split('\n');
  const index = lines.findIndex(line => line.startsWith('TcpExt:'));
  const names = lines[index].split(/\s+/), values = lines[index + 1].split(/\s+/);
  return Object.fromEntries(['ListenOverflows', 'ListenDrops', 'TCPTimeouts'].map(name => [name, Number(values[names.indexOf(name)])]));
};
const tcpStart = tcp();
const started = performance.now();
let previousCpu = process.cpuUsage();
server.prependListener('request', (req, res) => {
  const began = performance.now();
  metrics.requests++;
  metrics.active++;
  metrics.peakActive = Math.max(metrics.peakActive, metrics.active);
  if (req.url.startsWith('/api/')) metrics.apiAttempts++;
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    metrics.active--;
    metrics.completed++;
    const ms = performance.now() - began;
    durationMax = Math.max(durationMax, ms);
    durations[Math.min(durations.length - 1, Math.ceil(ms * 10))]++;
    metrics.statuses[res.statusCode] = (metrics.statuses[res.statusCode] ?? 0) + 1;
  };
  res.once('finish', done);
  res.once('close', done);
});
server.on('connection', socket => {
  metrics.connections++;
  metrics.openConnections++;
  metrics.peakConnections = Math.max(metrics.peakConnections, metrics.openConnections);
  socket.once('close', () => metrics.openConnections--);
});
loop.enable();
const timer = setInterval(() => {
  const cpu = process.cpuUsage(previousCpu);
  previousCpu = process.cpuUsage();
  console.log(JSON.stringify({ type: 'server-sample', at: new Date().toISOString(), requests: metrics.requests, active: metrics.active, openConnections: metrics.openConnections, rssBytes: process.memoryUsage().rss, cpuMs: (cpu.user + cpu.system) / 1000, loopP95Ms: loop.count ? loop.percentile(95) / 1e6 : null, loopMaxMs: loop.max / 1e6 }));
  loop.reset();
}, 1000).unref();
server.listen({ host: '127.0.0.1', port: 8500, backlog: LISTEN_BACKLOG }, () => console.log(JSON.stringify({ type: 'server-ready', at: new Date().toISOString(), pid: process.pid, node: process.version })));
process.once('SIGTERM', () => {
  clearInterval(timer);
  loop.disable();
  server.closeAllConnections();
  server.close(() => {
    let seen = 0, p50 = null, p95 = null;
    for (let index = 0; index < durations.length; index++) {
      seen += durations[index];
      if (p50 === null && seen >= metrics.completed * .5) p50 = index / 10;
      if (p95 === null && seen >= metrics.completed * .95) { p95 = index / 10; break; }
    }
    const cpu = process.cpuUsage();
    const tcpEnd = tcp();
    console.log(JSON.stringify({ type: 'server-complete', at: new Date().toISOString(), elapsedMs: performance.now() - started, ...metrics, serverResponseMs: { p50, p95, max: durationMax }, process: { cpuUserMs: cpu.user / 1000, cpuSystemMs: cpu.system / 1000, peakRssKiB: process.resourceUsage().maxRSS }, tcpDelta: Object.fromEntries(Object.entries(tcpEnd).map(([key, value]) => [key, value - tcpStart[key]])) }));
  });
});
