'use strict';
/* Downloads. A movie or episode is copied from the provider into the profile's own folder exactly as the provider sends it (no
 * conversion), so it plays wherever streaming it already played.
 *
 *   <recordings>/<profile>/downloads/<name>.<ext>   the finished file
 *   <recordings>/<profile>/downloads/<name>.<ext>.part and <name>.json   while it is coming down / the details
 *
 * Only one download runs per provider at a time (the rest wait their turn), so a download never takes more than one of the
 * provider's streams. A download that breaks off picks up where it stopped; one cut short by a restart starts again by itself. */
const fs = require('fs');
const path = require('path');
const { helpers: H, limits } = require('./recorder');

const PER_PROVIDER = 1;
const RETRIES = 6;
const active = new Map(); // `${profile}|${id}` -> running or waiting job
let hooks = { urlFor: null, fetchUp: null, log: () => {} };
function setHooks(h) { hooks = { ...hooks, ...h }; }

const dirOf = (profile) => H.dirOf(profile, 'downloads');
const available = () => { try { fs.accessSync(H.BASE, fs.constants.W_OK); return true; } catch { return false; } };
const clean = (s) => String(s || '').replace(/[^\w .()&'+,-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 90);
function nameFor(o) {
  const t = clean(o.title) || 'Download';
  if (o.kind === 'show') {
    const z = (n) => String(n).padStart(2, '0');
    return `${t} - S${z(o.season || 0)}E${z(o.ep || 0)}${clean(o.epTitle) ? ' - ' + clean(o.epTitle) : ''}`.slice(0, 140);
  }
  return o.year ? `${t} (${clean(o.year).slice(0, 4)})` : t;
}
function pathsOf(profile, id) {
  if (!H.validId(id) || id.endsWith('.json') || id.endsWith('.part')) return null;
  const dir = dirOf(profile), file = path.join(dir, id);
  if (!file.startsWith(dir + path.sep)) return null;
  return { dir, file, part: file + '.part', meta: file.replace(/\.[a-z0-9]{2,5}$/i, '') + '.json' };
}

function start(o) {
  if (!available()) throw new Error('Downloads need a folder. An admin can map a share to /recordings.');
  const ext = String(o.ext || 'mp4').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'mp4';
  const dir = dirOf(o.profile);
  try { H.ensureDir(dir); fs.accessSync(dir, fs.constants.W_OK); } catch { throw new Error('The downloads folder can’t be written to. Check the share’s permissions.'); }
  if (H.freeBytes(dir) < limits.floorBytes) throw new Error('Not enough free space on the disk.');
  const base = nameFor(o);
  // the same title again is the same file
  for (const j of active.values()) if (j.profile === o.profile && j.pid === o.pid && j.kind === o.kind && j.src === String(o.id)) return { id: j.id, again: true };
  let id = `${base}.${ext}`, n = 1;
  for (;;) {
    const p = pathsOf(o.profile, id);
    const m = H.readMeta(p.meta);
    if (!fs.existsSync(p.file) && !fs.existsSync(p.part) && !m) break;
    if (m && m.pid === o.pid && m.kind === o.kind && m.src === String(o.id)) { if (m.state === 'done') return { id, again: true }; break; } // came apart earlier: pick it up again
    id = `${base} (${++n}).${ext}`;
  }
  const p = pathsOf(o.profile, id);
  const meta = { owner: o.profile, title: o.kind === 'show' ? `${clean(o.title)}  S${o.season}E${o.ep}${o.epTitle ? '  ' + clean(o.epTitle) : ''}` : clean(o.title) + (o.year ? ` (${clean(o.year).slice(0, 4)})` : ''), kind: o.kind, pid: o.pid, src: String(o.id), ext, at: Math.floor(Date.now() / 1000), state: 'queued', size: 0, total: 0, pos: 0, dur: (+o.mins || 0) * 60 };
  H.writeMeta(p.meta, meta);
  const job = { profile: o.profile, id, pid: o.pid, kind: o.kind, src: String(o.id), ext, meta, p, got: 0, state: 'queued', ac: null, tries: 0 };
  active.set(o.profile + '|' + id, job);
  kick();
  return { id };
}

function runningOf(pid) { let n = 0; for (const j of active.values()) if (j.pid === pid && j.state === 'running') n++; return n; }
function kick() {
  for (const j of active.values()) if (j.state === 'queued' && runningOf(j.pid) < PER_PROVIDER) { j.state = 'running'; run(j).catch(() => {}); }
}
const save = (j, patch) => { Object.assign(j.meta, patch); try { H.writeMeta(j.p.meta, j.meta); } catch { /* the folder went away */ } };
function finish(j, patch) { save(j, patch); active.delete(j.profile + '|' + j.id); kick(); }

async function run(j) {
  let wait = 0;
  for (;;) {
    if (j.gone) return;
    let got = 0; try { got = fs.statSync(j.p.part).size; } catch { /* starting fresh */ }
    j.ac = new AbortController();
    try {
      const url = hooks.urlFor(j.pid, j.kind, j.src, j.ext);
      if (!url) return finish(j, { state: 'failed', err: 'That provider is no longer set up.' });
      const headers = got ? { range: `bytes=${got}-` } : {};
      const r = await hooks.fetchUp(url, { headers, signal: j.ac.signal });
      const ct = r.headers.get('content-type') || '';
      if (!r.ok && r.status !== 206) throw Object.assign(new Error(`The provider answered HTTP ${r.status}.`), { fatal: r.status === 404 || r.status === 403 || r.status === 401 || r.status === 407 });
      if (/html|json|text|xml/i.test(ct)) throw Object.assign(new Error('The provider sent a page instead of the video.'), { fatal: true });
      if (got && r.status !== 206) got = 0; // the provider ignored the range: start over
      const len = +r.headers.get('content-length') || 0, total = r.status === 206 ? got + len : len;
      if (total && H.freeBytes(j.p.dir) - Math.max(0, total - got) < limits.floorBytes) return finish(j, { state: 'failed', err: 'Not enough free space on the disk.' });
      j.got = got; save(j, { state: 'running', total });
      const out = fs.createWriteStream(j.p.part, { flags: got ? 'a' : 'w', mode: H.FILE_MODE });
      let lastCheck = Date.now();
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!out.write(value)) await new Promise((res) => out.once('drain', res));
        j.got += value.length; wait = 0;
        if (Date.now() - lastCheck > 5000) { lastCheck = Date.now(); if (H.freeBytes(j.p.dir) < limits.floorBytes) { j.ac.abort(); await new Promise((res) => out.end(res)); return finish(j, { state: 'failed', err: 'Stopped: free space ran low.' }); } }
      }
      await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
      if (total && j.got < total) throw new Error('The connection ended early.');
      fs.renameSync(j.p.part, j.p.file); try { fs.chmodSync(j.p.file, H.FILE_MODE); } catch { /* fine */ }
      hooks.log(`download finished: ${j.id}`);
      return finish(j, { state: 'done', size: j.got, total: j.got, err: undefined });
    } catch (e) {
      if (j.gone) return;
      if (e && e.fatal || ++j.tries > RETRIES) return finish(j, { state: 'failed', err: String((e && e.message) || e).slice(0, 140) });
      wait = Math.min(30000, 1500 * 2 ** j.tries);
      save(j, { state: 'running', err: undefined });
      await new Promise((res) => setTimeout(res, wait));
    }
  }
}

/* What a profile's folder holds, newest first. */
function list(profile) {
  const dir = dirOf(profile);
  let files = []; try { files = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const m = H.readMeta(path.join(dir, f)); if (!m) continue;
    const stem = f.slice(0, -5), id = `${stem}.${m.ext || 'mp4'}`;
    const j = active.get(profile + '|' + id);
    const state = j ? (j.state === 'running' ? 'downloading' : 'waiting') : m.state === 'done' ? 'done' : m.state === 'failed' ? 'failed' : 'stopped';
    out.push({ id, title: m.title || stem, kind: m.kind, at: m.at || 0, state, size: j ? j.got : m.size || 0, total: m.total || 0, pos: m.pos || 0, dur: m.dur || 0, err: state === 'failed' ? m.err || 'Failed' : undefined });
  }
  return out.sort((a, b) => b.at - a.at);
}
function fileFor(profile, id) { const p = pathsOf(profile, id); return p && fs.existsSync(p.file) ? p.file : null; }
function remove(profile, id) {
  const p = pathsOf(profile, id); if (!p) return false;
  const j = active.get(profile + '|' + id);
  if (j) { j.gone = true; try { j.ac && j.ac.abort(); } catch { /* done */ } active.delete(profile + '|' + id); }
  let any = !!j;
  for (const f of [p.file, p.part, p.meta]) { try { fs.unlinkSync(f); any = true; } catch { /* not there */ } }
  kick();
  return any;
}
function retry(profile, id) {
  const p = pathsOf(profile, id); if (!p) return false;
  const m = H.readMeta(p.meta); if (!m || active.has(profile + '|' + id) || m.state === 'done') return false;
  save({ meta: m, p }, { state: 'queued', err: undefined });
  active.set(profile + '|' + id, { profile, id, pid: m.pid, kind: m.kind, src: m.src, ext: m.ext, meta: m, p, got: 0, state: 'queued', tries: 0 });
  kick(); return true;
}
function setPos(profile, id, t) {
  const p = pathsOf(profile, id); if (!p) return false;
  const m = H.readMeta(p.meta); if (!m) return false;
  m.pos = Math.max(0, Math.floor(+t || 0));
  try { H.writeMeta(p.meta, m); return true; } catch { return false; }
}
/* a restart cut these short: start them again from what is already on disk */
function recover() {
  if (!available()) return 0;
  let n = 0;
  let profiles = []; try { profiles = fs.readdirSync(H.BASE); } catch { return 0; }
  for (const pf of profiles) {
    const dir = path.join(H.BASE, pf, 'downloads');
    let files = []; try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const m = H.readMeta(path.join(dir, f)); if (!m || (m.state !== 'running' && m.state !== 'queued')) continue;
      const id = `${f.slice(0, -5)}.${m.ext || 'mp4'}`, profile = m.owner || pf;
      const key = profile + '|' + id; if (active.has(key)) continue;
      const p = { dir, file: path.join(dir, id), part: path.join(dir, id) + '.part', meta: path.join(dir, f) };
      active.set(key, { profile, id, pid: m.pid, kind: m.kind, src: m.src, ext: m.ext || 'mp4', meta: m, p, got: 0, state: 'queued', tries: 0 }); n++;
    }
  }
  kick(); return n;
}
module.exports = { setHooks, available, start, list, fileFor, remove, retry, setPos, recover, active };
