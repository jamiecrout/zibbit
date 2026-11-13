'use strict';
/* Recordings. A recording is a copy of what a channel's rewind buffer holds, kept growing until it is stopped, runs out of time or the
 * disk runs low. It is written as MPEG-TS while it runs (a crash loses nothing but the last second) and turned into an MP4 afterwards
 * without re-encoding the picture, so any device can play it and seek in it.
 *
 * Folder layout (map a share to /recordings, or set RECORDINGS_DIR):
 *   <recordings>/<profile>/recordings/<date time channel>.mp4   and a small .json next to it holding the details
 * Each profile only ever sees its own folder. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const transcode = require('./transcode');

const BASE = process.env.RECORDINGS_DIR || '/recordings';
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const TICK_MS = 1000;
const DIR_MODE = 0o775, FILE_MODE = 0o664; // group-writable, so the share's own users (SMB, Plex, Jellyfin) can manage the files too

const limits = { maxSec: 6 * 3600, floorBytes: 20e9 };
function setLimits(o) {
  if (o && o.maxSec > 0) limits.maxSec = o.maxSec;
  if (o && o.floorBytes >= 0) limits.floorBytes = o.floorBytes;
}

function available() { try { fs.accessSync(BASE, fs.constants.W_OK); return true; } catch { return false; } }
function freeBytes(dir) { try { const s = fs.statfsSync(dir || BASE); return Number(s.bavail) * Number(s.bsize); } catch { return Infinity; } }

/* one folder per profile; a name that had to be changed gets a short suffix so two different names can never share a folder */
function folderName(profile) {
  const raw = String(profile || '');
  const safe = raw.replace(/[^\w .()-]/g, '_').replace(/^[. ]+/, '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'profile';
  return safe === raw ? safe : safe + '-' + crypto.createHash('sha1').update(raw).digest('hex').slice(0, 4);
}
const dirOf = (profile, kind) => path.join(BASE, folderName(profile), kind || 'recordings');
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  try { fs.chmodSync(path.dirname(dir), DIR_MODE); fs.chmodSync(dir, DIR_MODE); } catch { /* the folder belongs to someone else: use it as it is */ }
}
const fileSafe = (s) => String(s || '').replace(/[^\w .()&'+-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Channel';
const stamp = (d) => { const z = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}.${z(d.getMinutes())}`; };
const validId = (id) => typeof id === 'string' && id.length > 0 && id.length <= 150 && !/[\\/\0]/.test(id) && !id.startsWith('.');

const active = new Map(); // `${profile}|${key}` -> running recording

function readMeta(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function writeMeta(file, meta) { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(meta), { mode: FILE_MODE }); fs.renameSync(tmp, file); try { fs.chmodSync(file, FILE_MODE); } catch { /* fine */ } }

/* What the buffer's playlist lists: [{ n, dur }] in order. */
function listSegments(job) {
  let text;
  try { text = fs.readFileSync(path.join(job.dir, 'index.m3u8'), 'utf8'); } catch { return []; }
  const out = [];
  let dur = 0;
  for (const l of text.split(/\r?\n/)) {
    const d = /^#EXTINF:([\d.]+)/.exec(l); if (d) dur = parseFloat(d[1]);
    const n = /^s(\d+)\.ts$/.exec(l.trim()); if (n) { out.push({ n: parseInt(n[1], 10), dur }); dur = 0; }
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Starts recording `key` (a channel with a running rewind buffer) for `profile`.
 *   back  - seconds of what is already buffered to include (0 = from now)
 *   until - epoch seconds to stop at (omit to record until stopped or the longest allowed time)
 * Throws an Error whose message can be shown to the person. */
function start(o) {
  if (!available()) throw new Error('Recordings need a folder. Map a share to /recordings on the container.');
  const id = o.profile + '|' + o.key;
  const have = active.get(id);
  if (have) return have;
  const job = transcode.get(o.key);
  if (!job || job.dead || !(job.keepSec > 0)) throw new Error('This channel isn’t being buffered, so it can’t be recorded. Turn on Rewind live TV first.');
  const dir = dirOf(o.profile, 'recordings');
  ensureDir(dir);
  if (freeBytes(dir) < limits.floorBytes) throw new Error(`Not enough free space to record (less than ${Math.round(limits.floorBytes / 1e9)} GB left).`);
  const now = new Date();
  const stem0 = stamp(now) + ' ' + fileSafe(o.chName);
  let stem = stem0, i = 1;
  while (fs.existsSync(path.join(dir, stem + '.json')) || fs.existsSync(path.join(dir, stem + '.mp4'))) stem = `${stem0} (${++i})`;
  const rec = {
    id: stem, profile: o.profile, key: o.key, dir, part: path.join(dir, stem + '.rec.ts'), meta: path.join(dir, stem + '.json'),
    ch: String(o.chName || ''), title: String(o.title || '').slice(0, 120), at: Math.floor(now.getTime() / 1000), dur: 0, bytes: 0,
    until: o.until > 0 ? o.until : 0, stopReq: false, why: '', last: 0, fh: null
  };
  active.set(id, rec);
  writeMeta(rec.meta, { state: 'recording', ch: rec.ch, title: rec.title, at: rec.at, dur: 0, size: 0, key: rec.key });
  run(rec, Math.max(0, Math.floor(o.back || 0))).catch((e) => { rec.why = 'recording failed: ' + (e && e.message); }).finally(() => finalize(rec, id));
  return rec;
}

async function run(rec, back) {
  rec.fh = await fs.promises.open(rec.part, 'a', FILE_MODE);
  let first = true, lastBeat = 0;
  for (;;) {
    const job = transcode.get(rec.key);
    if (!job || job.dead) { rec.why = rec.why || 'the channel stopped'; break; }
    transcode.touch(rec.key); // a running recording keeps the channel's buffer alive even if nobody is watching
    const segs = listSegments(job);
    let todo;
    if (first) { // the part of the past that was asked for
      let acc = 0, from = segs.length;
      while (from > 0 && acc < back) { from--; acc += segs[from].dur; }
      todo = segs.slice(from).filter((s) => s.n >= (job.floor || 0));
      first = false;
    } else todo = segs.filter((s) => s.n > rec.last);
    for (const s of todo) {
      if (rec.stopReq) break;
      let buf;
      try { buf = await fs.promises.readFile(path.join(job.dir, 's' + s.n + '.ts')); } catch { continue; } // trimmed away before it could be copied
      await rec.fh.write(buf);
      rec.last = s.n; rec.dur += s.dur; rec.bytes += buf.length;
    }
    if (rec.stopReq) { rec.why = rec.why || 'stopped'; break; }
    if (rec.dur >= limits.maxSec) { rec.why = 'reached the longest allowed recording'; break; }
    if (rec.until && Date.now() / 1000 >= rec.until) { rec.why = 'finished'; break; }
    if (freeBytes(rec.dir) < limits.floorBytes) { rec.why = 'the disk is nearly full'; break; }
    if (Date.now() - lastBeat > 10000) { lastBeat = Date.now(); try { writeMeta(rec.meta, { state: 'recording', ch: rec.ch, title: rec.title, at: rec.at, dur: Math.round(rec.dur), size: rec.bytes, key: rec.key }); } catch { /* next time */ } }
    await sleep(TICK_MS);
  }
}

function stop(profile, key) {
  const rec = active.get(profile + '|' + key);
  if (!rec) return false;
  rec.stopReq = true;
  return true;
}

async function finalize(rec, id) {
  try { if (rec.fh) await rec.fh.close(); } catch { /* closed */ }
  rec.fh = null;
  active.delete(id);
  if (rec.dur < 5) { // nothing worth keeping
    for (const f of [rec.part, rec.meta]) { try { fs.unlinkSync(f); } catch { /* gone */ } }
    return;
  }
  const meta = { state: 'finishing', ch: rec.ch, title: rec.title, at: rec.at, dur: Math.round(rec.dur), size: rec.bytes, key: rec.key, why: rec.why };
  try { writeMeta(rec.meta, meta); } catch { /* shown as unfinished */ }
  await remux(rec.part, rec.meta, meta);
}

/* .ts -> .mp4 with the picture copied as it is; sound is kept when a browser can play it, otherwise turned into AAC */
async function remux(part, metaFile, meta) {
  const out = part.replace(/\.rec\.ts$/, '.mp4'), tmp = out + '.tmp.mp4';
  let audio = 'aac';
  try { const st = await transcode.probeAll(part); const a = st.find((x) => x.type === 'audio'); if (a && /^(aac|mp3)$/i.test(a.codec)) audio = 'copy'; } catch { /* encode to be safe */ }
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', part, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'copy', '-c:a', audio, ...(audio === 'aac' ? ['-b:a', '160k', '-ac', '2'] : []), '-movflags', '+faststart', '-f', 'mp4', tmp];
  const ok = await new Promise((resolve) => {
    let p, err = '';
    try { p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] }); } catch { return resolve(false); }
    p.stderr.on('data', (d) => { err = (err + d).slice(-400); });
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
  if (ok) {
    try {
      fs.renameSync(tmp, out); try { fs.chmodSync(out, FILE_MODE); } catch { /* fine */ }
      meta.state = 'done'; meta.size = fs.statSync(out).size; delete meta.why;
      writeMeta(metaFile, meta);
      try { fs.unlinkSync(part); } catch { /* gone */ }
      return;
    } catch { /* fall through: keep the .ts */ }
  }
  try { fs.unlinkSync(tmp); } catch { /* none */ }
  meta.state = 'unfinished'; // the raw .ts is kept: nothing is lost, but it needs another player
  try { writeMeta(metaFile, meta); } catch { /* shown as is */ }
}

/* Recordings left half-way by a restart or crash are finished now. */
function recover() {
  if (!available()) return 0;
  let n = 0;
  let people = [];
  try { people = fs.readdirSync(BASE); } catch { return 0; }
  for (const who of people) {
    const dir = path.join(BASE, who, 'recordings');
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const stem = f.slice(0, -5), mf = path.join(dir, f), meta = readMeta(mf);
      if (!meta || (meta.state !== 'recording' && meta.state !== 'finishing')) continue;
      if ([...active.values()].some((r) => r.meta === mf)) continue;
      const part = path.join(dir, stem + '.rec.ts');
      if (!fs.existsSync(part)) { try { fs.unlinkSync(mf); } catch { /* gone */ } continue; }
      meta.state = 'finishing'; meta.why = 'the server restarted';
      try { meta.size = fs.statSync(part).size; } catch { /* keep */ }
      remux(part, mf, meta).catch(() => {});
      n++;
    }
  }
  return n;
}

/* What a profile's folder holds, newest first. */
function list(profile) {
  const dir = dirOf(profile, 'recordings');
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const m = readMeta(path.join(dir, f)); if (!m) continue;
    const id = f.slice(0, -5);
    const live = [...active.values()].find((r) => r.profile === profile && r.id === id);
    out.push({ id, ch: m.ch || '', title: m.title || '', at: m.at || 0, dur: live ? Math.round(live.dur) : m.dur || 0, size: live ? live.bytes : m.size || 0, state: live ? 'recording' : m.state === 'recording' ? 'finishing' : m.state || 'done', pos: m.pos || 0, key: live ? live.key : undefined });
  }
  return out.sort((a, b) => b.at - a.at);
}
/* is anyone recording this channel right now? (its buffer must stay up even when nobody is watching) */
function recording(key) { for (const r of active.values()) if (r.key === key) return true; return false; }
function runningFor(profile) { return [...active.values()].filter((r) => r.profile === profile).map((r) => ({ key: r.key, id: r.id, dur: Math.round(r.dur), until: r.until })); }

/* paths inside a profile's own folder only */
function pathsOf(profile, id) {
  if (!validId(id)) return null;
  const dir = dirOf(profile, 'recordings');
  const mk = (ext) => { const p = path.join(dir, id + ext); return p.startsWith(dir + path.sep) ? p : null; };
  return { dir, meta: mk('.json'), mp4: mk('.mp4'), ts: mk('.rec.ts') };
}
function fileFor(profile, id) {
  const p = pathsOf(profile, id);
  if (!p || !fs.existsSync(p.mp4)) return null;
  return p.mp4;
}
function remove(profile, id) {
  const p = pathsOf(profile, id);
  if (!p || !fs.existsSync(p.meta)) return false;
  if ([...active.values()].some((r) => r.profile === profile && r.id === id)) return false; // stop it first
  for (const f of [p.mp4, p.ts, p.meta]) { try { fs.unlinkSync(f); } catch { /* not there */ } }
  return true;
}
function setPos(profile, id, t) {
  const p = pathsOf(profile, id); if (!p) return false;
  const m = readMeta(p.meta); if (!m) return false;
  m.pos = Math.max(0, Math.floor(+t || 0));
  try { writeMeta(p.meta, m); return true; } catch { return false; }
}

const helpers = { BASE, folderName, dirOf, ensureDir, fileSafe, validId, readMeta, writeMeta, freeBytes: (d) => freeBytes(d || BASE), DIR_MODE, FILE_MODE };
module.exports = { helpers, available, setLimits, start, stop, list, recording, runningFor, fileFor, remove, setPos, recover, freeBytes: () => freeBytes(BASE), BASE, limits };
