'use strict';
/* On-demand live transcoding for sources whose video a browser cannot play (an antenna tuner sends MPEG-2 video
 * and AC3 audio). One ffmpeg process per channel turns the stream into short H.264/AAC HLS segments in a temporary
 * folder. It is shared by everyone watching that channel and is stopped as soon as nobody is. */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/* The rewind buffer lives here. Map a real folder to /rewind (or set REWIND_DIR) so a long buffer doesn't fill the container's own disk;
 * without one the system temp folder is used. Only the zibbit-hls folder inside it is ever emptied or deleted. */
const BASE = process.env.TRANSCODE_DIR || process.env.REWIND_DIR || (() => { try { fs.accessSync('/rewind', fs.constants.W_OK); return '/rewind'; } catch { return os.tmpdir(); } })();
const ROOT = path.join(BASE, 'zibbit-hls');
const REWIND_IDLE_MS = 120000; // a channel with a rewind buffer waits longer: someone who paused for a minute still expects to resume where they were
const IDLE_MS = 20000;      // nobody asked for the playlist or a segment for this long: stop
const START_MS = 25000;     // give up waiting for the first segments after this long
const STALL_MS = Math.max(4, parseInt(process.env.STALL_SECONDS, 10) || 30) * 1000; // a running buffer that has made no new segment for this long is stuck (the provider stopped sending but kept the connection)
let note = () => {};
function setNote(fn) { note = fn; }
const NEED_SEGMENTS = 2;    // playlist is handed out once it lists this many segments
const MAX_HEIGHT = Math.max(0, parseInt(process.env.TRANSCODE_MAX_HEIGHT, 10) >= 0 ? parseInt(process.env.TRANSCODE_MAX_HEIGHT, 10) : 720);
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

const jobs = new Map(); // key -> job
const stalledAt = new Map(); // provider -> when one of its buffers was last killed for going quiet
const RESTART_GAP_MS = 4000; // a provider needs a moment to notice a dropped connection; reconnecting at once can look like a second stream
/* a source that ends by itself within seconds of starting, over and over, is not a live channel a buffer can follow: key -> { n, at } */
const quick = new Map();
function flaky(key) { const q = quick.get(key); return !!q && q.n >= 3 && Date.now() - q.at < 60000; }
let jobSeq = 0;       // every run gets its own folder, so a stopped run's cleanup can never delete a newer run's files

let availability = null;
function available() {
  if (!availability) {
    availability = new Promise((resolve) => {
      let out = '';
      let p;
      try { p = spawn(FFMPEG, ['-hide_banner', '-version'], { stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return resolve(false); }
      p.stdout.on('data', (d) => { out += d; });
      p.on('error', () => resolve(false));
      p.on('close', (code) => resolve(code === 0 && /ffmpeg version/i.test(out)));
    });
  }
  return availability;
}

function rmrf(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ } }
try { rmrf(ROOT); fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 }); } catch { /* made on first use */ }

const HLS_TIME = 2;
/* a stream address ffmpeg may open: web addresses only, so a playlist can never point it at a file or a local protocol */
const okInput = (u) => /^https?:\/\/[^\s]+$/i.test(String(u || ''));

function buildArgs(input, dir, opts) {
  const o = opts || {};
  const copyVideo = /^(h264|avc|copy)/i.test(String(o.videoCodec || ''));
  const keepSec = Math.max(0, Math.floor(o.keepSec || 0));
  const a = ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-protocol_whitelist', 'http,https,tcp,tls,crypto', '-fflags', '+genpts+discardcorrupt', '-rw_timeout', '15000000'];
  if (o.reconnect) a.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '4');
  a.push('-i', input, '-map', '0:v:0', '-map', '0:a:0?');
  if (copyVideo) a.push('-c:v', 'copy');
  else {
    const vf = ['yadif=0:-1:1'];
    if (MAX_HEIGHT > 0) vf.push(`scale=-2:min(ih\\,${MAX_HEIGHT})`);
    a.push('-vf', vf.join(','), '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'main', '-pix_fmt', 'yuv420p', '-crf', '23', '-maxrate', '4500k', '-bufsize', '9000k', '-g', '60', '-sc_threshold', '0');
  }
  if (o.audioCopy) a.push('-c:a', 'copy');
  else a.push('-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000');
  // without a rewind buffer: the last 8 segments. With one: enough entries to cover the whole window (a segment is never shorter than HLS_TIME)
  const listSize = keepSec > 0 ? Math.ceil(keepSec / HLS_TIME) + 10 : 8;
  a.push('-f', 'hls', '-hls_time', String(HLS_TIME), '-hls_list_size', String(listSize),
    '-hls_flags', 'delete_segments+omit_endlist+independent_segments+temp_file',
    '-hls_segment_filename', path.join(dir, 's%d.ts'), path.join(dir, 'index.m3u8'));
  return a;
}

function segmentCount(dir) {
  try { return (fs.readFileSync(path.join(dir, 'index.m3u8'), 'utf8').match(/#EXTINF/g) || []).length; } catch { return 0; }
}

/* What the video of a stream really is, for sources that don't say. Resolves to { codec, pix, field } (blank when unknown). */
function probe(input) {
  return new Promise((resolve) => {
    let out = '';
    let p;
    try { p = spawn(FFMPEG.replace(/ffmpeg$/, 'ffprobe'), ['-v', 'error', '-rw_timeout', '10000000', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,pix_fmt,field_order', '-of', 'csv=p=0', input], { stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return resolve({ codec: '', pix: '', field: '' }); }
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } }, 15000);
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => { clearTimeout(t); resolve({ codec: '', pix: '', field: '' }); });
    p.on('close', () => { clearTimeout(t); const [codec = '', pix = '', field = ''] = out.trim().split(/\r?\n/)[0].split(','); resolve({ codec, pix, field }); });
  });
}

/* Every stream in a file, for finding out what a movie really holds. Resolves to a list of {type, codec, profile, pix, w, h} (empty when unknown). */
function probeAll(input) {
  return new Promise((resolve) => {
    let out = '';
    let p;
    try { p = spawn(FFMPEG.replace(/ffmpeg$/, 'ffprobe'), ['-v', 'error', '-rw_timeout', '15000000', '-show_entries', 'stream=codec_type,codec_name,profile,pix_fmt,width,height', '-of', 'json', input], { stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return resolve([]); }
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } }, 25000);
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => { clearTimeout(t); resolve([]); });
    p.on('close', () => { clearTimeout(t); try { resolve((JSON.parse(out).streams || []).map((s) => ({ type: s.codec_type, codec: s.codec_name, profile: s.profile || '', pix: s.pix_fmt || '', w: s.width || 0, h: s.height || 0 }))); } catch { resolve([]); } });
  });
}

/* how long since this job last finished a segment (the playlist is rewritten each time) */
function quietMs(job) { try { return Date.now() - fs.statSync(path.join(job.dir, 'index.m3u8')).mtimeMs; } catch { return 0; } }
/* a channel whose segments are 10 s or longer is quiet for that long between segments while perfectly healthy: wait a few segments' worth, not a fixed 15 s */
function isStuck(job, ms) { return job.started && !job.dead && quietMs(job) > Math.max(ms, (job.longest || 0) * 2.5 * 1000 + 5000); }

/* Starts (or joins) the transcode for `key`. Resolves with the job once the first segments exist. */
function open(key, input, opts) {
  let job = jobs.get(key);
  if (job && isStuck(job, STALL_MS)) { // someone coming back to a buffer that has gone quiet gets a fresh one, not the dead picture. A provider that goes quiet for 15-20 s and carries on is common; ffmpeg reconnects by itself, and killing the buffer then loses everyone's place
    note(job, 'stuck', Math.round(quietMs(job) / 1000));
    if (job.p) stalledAt.set(job.p, Date.now());
    stop(job); job = undefined;
  }
  if (!job || job.dead) {
    if (!okInput(input)) return Promise.reject(Object.assign(new Error('this source is not a web address'), { detail: '' }));
    const dir = path.join(ROOT, key.replace(/[^a-z0-9_-]/gi, '_') + '-' + (++jobSeq));
    rmrf(dir);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    job = { key, dir, keepSec: Math.max(0, Math.floor((opts && opts.keepSec) || 0)), floor: 0, onEnd: opts && opts.onEnd, p: opts && opts.p, s: opts && opts.s, last: Date.now(), t0: Date.now(), dead: false, err: '', proc: null, ready: null };
    jobs.set(key, job);
    const launch = () => {
      if (job.dead) return;
      const proc = spawn(FFMPEG, buildArgs(input, dir, opts), { stdio: ['ignore', 'ignore', 'pipe'] });
      job.proc = proc;
      proc.stderr.on('data', (d) => { if (!job.first) job.first = String(d).slice(0, 400); job.err = (job.err + d).slice(-2000); });
      proc.on('error', (e) => { job.err = e.code === 'ENOENT' ? 'ffmpeg is not installed on this server' : String(e.message); stop(job); });
      proc.on('close', (code, sig) => { const byItself = !job.dead && job.started; if (byItself) { const q = quick.get(key) || { n: 0, at: 0 }; if (Date.now() - job.t0 < 15000) { q.n = Date.now() - q.at < 60000 ? q.n + 1 : 1; q.at = Date.now(); } else q.n = 0; quick.set(key, q); } job.code = code == null ? sig : code; if (byItself) { try { note(job, 'ended', Math.round((Date.now() - job.t0) / 1000), whole(job)); } catch { /* diagnostics only */ } } job.dead = true; job.exited = true; finish(job); if (jobs.get(key) === job) jobs.delete(key); setTimeout(() => rmrf(dir), 2000).unref(); });
    };
    const gap = job.p && stalledAt.has(job.p) ? stalledAt.get(job.p) + RESTART_GAP_MS - Date.now() : 0;
    if (gap > 0) setTimeout(launch, gap); else launch();
    job.ready = new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => {
        if (job.dead) return reject(Object.assign(new Error(explain(job.err)), { detail: whole(job) }));
        if (segmentCount(dir) >= NEED_SEGMENTS) { job.started = true; return resolve(job); }
        if (Date.now() - t0 > START_MS) { stop(job); return reject(Object.assign(new Error(explain(job.err) || 'the stream did not start sending video in time'), { detail: whole(job) })); }
        setTimeout(tick, 250);
      };
      tick();
    });
    job.ready.catch(() => {});
  }
  job.last = Date.now();
  return job.ready;
}

/* What ffmpeg said first and last: the first complaint is usually the cause, the last is what it died of. */
function whole(job) { const t = job.first && !job.err.startsWith(job.first) ? job.first + ' … ' + job.err.slice(-400) : job.err; return t + ` [ffmpeg ${job.exited ? 'ended' : 'stopped'}${job.code != null ? ' (' + job.code + ')' : ''} after ${Math.round((Date.now() - (job.t0 || Date.now())) / 1000)} s]`; }

/* Turns ffmpeg's last words into something a person can act on. */
function explain(err) {
  const e = String(err || '');
  if (/503|Service Unavailable|Server returned 5/i.test(e)) return 'all tuners are busy';
  if (/not installed/i.test(e)) return 'ffmpeg is not installed on this server';
  if (/Connection refused|timed out|No route|Network is unreachable|Name or service not known/i.test(e)) return 'could not reach the tuner';
  return e.trim().split(/\r?\n/).pop() || '';
}


/* The playlist a viewer is given: only the last `sec` seconds (the buffer may hold more than this person asked to keep), and nothing older
 * than segment number `floor` (segments the disk budget has already removed). MEDIA-SEQUENCE moves up by what was cut, so a player that
 * is already playing sees a consistent list. */
function windowPlaylist(text, sec, floor) {
  const lines = String(text).split(/\r?\n/);
  const head = [], ents = [];
  let cur = [], seq = 0, started = false;
  for (const l of lines) {
    const m = /^#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(l);
    if (m) seq = parseInt(m[1], 10);
    if (!started && /^#EXTINF/.test(l)) started = true;
    if (!started) { head.push(l); continue; }
    if (!l.trim()) continue;
    cur.push(l);
    if (!l.startsWith('#')) { ents.push({ lines: cur, dur: parseFloat((cur.find((x) => x.startsWith('#EXTINF')) || '').split(':')[1]) || 0, n: (/^s(\d+)\.ts$/.exec(l.trim()) || [])[1] }); cur = []; }
  }
  let from = 0;
  if (sec > 0) { let acc = 0; from = ents.length; while (from > 0 && acc < sec) { from--; acc += ents[from].dur; } }
  while (from < ents.length - 1 && floor > 0 && ents[from].n !== undefined && parseInt(ents[from].n, 10) < floor) from++;
  const kept = ents.slice(from);
  const h = head.map((l) => (/^#EXT-X-MEDIA-SEQUENCE:/.test(l) ? `#EXT-X-MEDIA-SEQUENCE:${seq + from}` : l));
  return h.concat(...kept.map((e) => e.lines)).join('\n') + '\n';
}

/* How far back this channel's buffer goes right now, in seconds (what a viewer could rewind to). */
function bufferedSeconds(job) {
  try {
    const t = fs.readFileSync(path.join(job.dir, 'index.m3u8'), 'utf8');
    return Math.round(windowPlaylist(t, 0, job.floor).match(/#EXTINF:([\d.]+)/g).reduce((a, x) => a + parseFloat(x.slice(8)), 0));
  } catch { return 0; }
}


/* A viewer who asked for a shorter rewind than the others (15 or 30 minutes against 60) really does free the disk: what nobody is entitled to
 * see any more is deleted. `wants` holds each viewer's window and when they last asked. */
function noteWant(job, who, sec) { (job.wants || (job.wants = new Map())).set(who, { sec, at: Date.now() }); }
function wantedSec(job) {
  let best = 0;
  if (job.wants) for (const [k, w] of job.wants) { if (Date.now() - w.at > 90000) job.wants.delete(k); else best = Math.max(best, w.sec); }
  return best;
}
function trimToWanted(job) {
  const want = wantedSec(job);
  if (!want) return 0;
  let text;
  try { text = fs.readFileSync(path.join(job.dir, 'index.m3u8'), 'utf8'); } catch { return 0; }
  const ents = [];
  let dur = 0;
  for (const l of text.split(/\r?\n/)) { const d = /^#EXTINF:([\d.]+)/.exec(l); if (d) dur = parseFloat(d[1]); const n = /^s(\d+)\.ts$/.exec(l.trim()); if (n) { ents.push({ n: parseInt(n[1], 10), dur }); dur = 0; } }
  let acc = 0, i = ents.length, cut = 0;
  const keep = want + 20; // a little over, so the edge of someone's window is never missing
  while (i > 0 && acc < keep) { i--; acc += ents[i].dur; }
  for (let k = 0; k < i; k++) { if (ents[k].n < job.floor) continue; try { fs.unlinkSync(path.join(job.dir, 's' + ents[k].n + '.ts')); cut++; } catch { /* gone already */ } }
  if (i > 0) job.floor = Math.max(job.floor, ents[i].n);
  return cut;
}

/* ---- disk budget ---- the buffers of all running channels together stay under `budgetBytes`; the oldest video goes first. */
let budgetBytes = 0;
function setBudget(bytes) { budgetBytes = Math.max(0, bytes || 0); }
function dirBytes(dir) { let n = 0; try { for (const f of fs.readdirSync(dir)) { try { n += fs.statSync(path.join(dir, f)).size; } catch { /* just rotated */ } } } catch { /* gone */ } return n; }
function freeBytes() { try { const s = fs.statfsSync(ROOT); return Number(s.bavail) * Number(s.bsize); } catch { return Infinity; } }
function enforceBudget() {
  const list = [...jobs.values()].filter((j) => j.keepSec > 0 && !j.dead);
  if (!list.length) return 0;
  for (const j of list) trimToWanted(j);
  const sizes = new Map(list.map((j) => [j, dirBytes(j.dir)]));
  let total = [...sizes.values()].reduce((a, b) => a + b, 0), cut = 0;
  // never leave the disk itself nearly full, whatever the budget says
  const reserve = 1.5e9;
  const over = () => (budgetBytes > 0 && total > budgetBytes) || freeBytes() < reserve;
  let guard = 0;
  while (over() && guard++ < 4000) {
    let big = null;
    for (const j of list) if (!big || sizes.get(j) > sizes.get(big)) big = j;
    if (!big || sizes.get(big) <= 0) break;
    let names;
    try { names = fs.readdirSync(big.dir).filter((f) => /^s\d+\.ts$/.test(f)).sort((x, y) => parseInt(x.slice(1), 10) - parseInt(y.slice(1), 10)); } catch { break; }
    if (names.length <= 3) { sizes.set(big, 0); continue; } // keep the newest few: they are what is playing
    const oldest = names[0];
    let sz = 0;
    try { sz = fs.statSync(path.join(big.dir, oldest)).size; fs.unlinkSync(path.join(big.dir, oldest)); } catch { /* already gone */ }
    big.floor = Math.max(big.floor, parseInt(oldest.slice(1), 10) + 1);
    sizes.set(big, sizes.get(big) - sz); total -= sz; cut++;
  }
  return cut;
}
setInterval(() => { try { enforceBudget(); } catch { /* try again next time */ } }, 8000).unref();

function touch(key) { const j = jobs.get(key); if (j) j.last = Date.now(); return j; }
/* the running job for a channel, without counting as someone using it */
function get(key) { return jobs.get(key); }
/* Runs the job's end hook once (a Tablo stream's tuner is released here). */
function finish(job) { if (job.finished) return; job.finished = true; if (job.onEnd) { try { job.onEnd(); } catch { /* best effort */ } } }
function stop(job) { job.dead = true; finish(job); try { job.proc && job.proc.kill('SIGKILL'); } catch { /* gone */ } if (jobs.get(job.key) === job) jobs.delete(job.key); }
/* Stops every job for which `keep(job)` is false. */
function reap(keep) { let n = 0; for (const j of [...jobs.values()]) if (!keep(j)) { stop(j); n++; } return n; }
function stopAll() { return reap(() => false); }
function running() { return jobs.size; }
/* what this server itself is holding open for a provider, for the log when the provider says no */
function heldFor(p) { return [...jobs.values()].filter((j) => j.p === p && !j.dead).map((j) => `${j.s} (${Math.round((Date.now() - j.t0) / 1000)} s${j.started ? '' : ', starting'})`); }

/* How fast is a buffer filling, in seconds of video per second of clock? A live channel fills at about 1. Much more means the source is sending a backlog
   or its timestamps jump, which a player can't keep up with. Say so once per buffer. */
function checkRate(j, now) {
  if (!j.started || j.dead) return;
  let text; try { text = fs.readFileSync(path.join(j.dir, 'index.m3u8'), 'utf8'); } catch { return; }
  let dur = 0, newest = -1, gained = 0, longest = 0;
  for (const l of text.split(/\r?\n/)) {
    const d = /^#EXTINF:([\d.]+)/.exec(l); if (d) dur = parseFloat(d[1]);
    const n = /^s(\d+)\.ts$/.exec(l.trim());
    if (n) { const k = parseInt(n[1], 10); if (j.rate && k > j.rate.n) gained += dur; if (k > newest) newest = k; if (dur > longest) longest = dur; dur = 0; }
  }
  if (longest > (j.longest || 0)) j.longest = longest;
  if (!j.rate) { // the first look counts everything already written since the buffer started: a backlog dumped at the start is the usual case
    let all = 0; for (const l of text.split(/\r?\n/)) { const d = /^#EXTINF:([\d.]+)/.exec(l); if (d) all += parseFloat(d[1]); }
    j.rate = { n: newest, at: j.t0, got: all };
  }
  j.rate.got += gained; j.rate.n = Math.max(j.rate.n, newest);
  const wall = (now - j.rate.at) / 1000;
  if (wall < 20) return;
  const x = j.rate.got / wall;
  if (x > 1.8 && j.rate.got > 120 && !j.rateNoted) { j.rateNoted = true; note(j, 'fast', Math.round(x * 10) / 10, `${Math.round(j.rate.got)} s of video in ${Math.round(wall)} s; longest segment ${Math.round(longest)} s`); }
  j.rate = { n: j.rate.n, at: now, got: 0 };
}
setInterval(() => {
  const now = Date.now();
  for (const j of [...jobs.values()]) { try { checkRate(j, now); } catch { /* diagnostics only */ } }
  for (const j of [...jobs.values()]) {
    if (now - j.last > (j.keepSec > 0 ? REWIND_IDLE_MS : IDLE_MS)) stop(j);
    else if (isStuck(j, STALL_MS)) { note(j, 'stalled', Math.round(quietMs(j) / 1000)); if (j.p) stalledAt.set(j.p, Date.now()); stop(j); }
  }
}, 5000).unref();
process.on('exit', stopAll); // the server's own SIGINT/SIGTERM handlers call process.exit, which lands here

module.exports = { flaky, heldFor, setNote, noteWant, windowPlaylist, bufferedSeconds, setBudget, enforceBudget, freeBytes, ROOT, available, probe, probeAll, open, touch, get, stop, reap, stopAll, running, explain, MAX_HEIGHT };
