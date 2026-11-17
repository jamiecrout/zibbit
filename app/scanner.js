'use strict';
/* Remembers how sharp each live channel really is, and fills the gaps in the background.
 *
 * Only channels in a ticked group or a favorite are looked at, a provider only while nobody is watching it,
 * and the moment someone starts a channel there the probes on that provider are stopped. At most `slots`
 * probes run at once across all providers, one per provider, with a pause between them.
 * What a viewer's own player sees (report) always wins over a probe.
 *
 * Stored per provider as { "<channel id>": [width, height, checked-at seconds] }, about 12 bytes a channel. */
const fs = require('fs');
const path = require('path');

module.exports = function scanner(o) {
  const slots = o.slots || 2;
  const gap = o.gapMs != null ? o.gapMs : 4000;        // between two probes on one provider
  const staleS = (o.staleDays || 30) * 86400;           // a known value is looked at again after this long
  const retryS = (o.retryDays || 7) * 86400;            // a channel that would not probe is tried again after this long
  const now = o.now || (() => Date.now());
  const log = o.log || (() => {});
  const data = new Map();      // provider -> { sid: [w, h, at] }
  const dirty = new Set();
  const active = new Map();    // provider -> { sid, abort }
  const state = new Map();     // provider -> { next: ms before which nothing runs, fails: in a row, cool: ms }
  let timer = null, saveT = null, startedAt = now();

  const file = (pid) => path.join(o.dir, 'res-' + String(pid).replace(/[^a-z0-9_-]/gi, '_') + '.json');
  function load(pid) {
    let m = data.get(pid);
    if (!m) { try { m = JSON.parse(fs.readFileSync(file(pid), 'utf8')); } catch { m = {}; } if (!m || typeof m !== 'object' || Array.isArray(m)) m = {}; data.set(pid, m); }
    return m;
  }
  function flush() {
    saveT = null;
    for (const pid of dirty) { try { fs.mkdirSync(o.dir, { recursive: true }); const tmp = file(pid) + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(load(pid))); fs.renameSync(tmp, file(pid)); } catch (e) { log('resolution cache could not be saved: ' + e.message); } }
    dirty.clear();
  }
  function touch(pid) { dirty.add(pid); if (!saveT) { saveT = setTimeout(flush, 5000); if (saveT.unref) saveT.unref(); } }
  const sec = () => Math.floor(now() / 1000);

  /* the height in pixels of a channel, or 0 when it is not known */
  function height(pid, sid) { const v = load(pid)[sid]; return v && v[1] > 0 ? Math.max(v[1], Math.round(v[0] * 9 / 16)) : 0; } // 16:9 equivalent, so a letterboxed 1920x800 is still "1080"
  function size(pid, sid) { const v = load(pid)[sid]; return v && v[1] > 0 ? { w: v[0], h: v[1] } : null; }

  /* what a player saw while the channel was on screen */
  function report(pid, sid, w, h) {
    w = Math.round(+w); h = Math.round(+h);
    if (!(w >= 160 && w <= 8192 && h >= 120 && h <= 4320)) return false;
    const m = load(pid), v = m[sid];
    if (v && v[0] === w && v[1] === h && sec() - v[2] < 86400) return true;
    m[sid] = [w, h, sec()]; touch(pid); return true;
  }

  /* someone is starting a channel on this provider: stop what the scanner is doing there and leave it alone for a while */
  function yieldTo(pid) {
    const a = active.get(pid);
    if (a) { try { a.abort(); } catch { /* gone */ } }
    const st = state.get(pid) || { next: 0, fails: 0, cool: 0 };
    st.next = Math.max(st.next, now() + 120000); state.set(pid, st);
  }

  /* the next channel of this provider worth probing: never-seen first, then the oldest value past its time */
  function pick(pid, wanted) {
    const m = load(pid), t = sec();
    let best = null, bestAt = Infinity;
    for (const sid of wanted) {
      const v = m[sid];
      if (!v) return sid;
      const age = t - v[2], limit = v[1] > 0 ? staleS : retryS;
      if (age >= limit && v[2] < bestAt) { best = sid; bestAt = v[2]; }
    }
    return best;
  }

  function counts(pid, wanted) { const m = load(pid); let known = 0; for (const sid of wanted) if (m[sid] && m[sid][1] > 0) known++; return { known, wanted: wanted.size }; }

  let running = 0, busyTick = false;
  async function tick() {
    if (busyTick) return; busyTick = true;
    try {
      if (now() - startedAt < (o.startDelayMs != null ? o.startDelayMs : 300000)) return;
      for (const p of o.providers()) {
        if (running >= slots) break;
        const st = state.get(p.id) || { next: 0, fails: 0, cool: 0 };
        state.set(p.id, st);
        if (active.has(p.id) || now() < st.next || now() < st.cool) continue;
        if (!o.supported(p)) continue;
        let wanted;
        try { wanted = await o.wanted(p); } catch { continue; }
        const sid = pick(p.id, wanted);
        if (!sid) { st.next = now() + 600000; continue; }          // nothing to do here: look again in ten minutes
        let ok = false;
        try { ok = await o.idle(p); } catch { ok = false; }
        if (!ok) { st.next = now() + 120000; continue; }           // someone is watching or the account has no spare stream
        const url = await o.urlFor(p, sid);
        if (!url) { load(p.id)[sid] = [0, 0, sec()]; touch(p.id); continue; }
        running++;
        const ac = new AbortController();
        active.set(p.id, { sid, abort: () => ac.abort() });
        (async () => {
          let r = null;
          try { r = await o.probe(url, ac.signal); } catch { r = null; }
          running--; active.delete(p.id);
          if (ac.signal.aborted) return;                            // a viewer needed the provider: no verdict on the channel
          const m = load(p.id);
          if (r && r.w > 0 && r.h > 0) { m[sid] = [r.w, r.h, sec()]; st.fails = 0; }
          else { m[sid] = [0, 0, sec()]; st.fails++; if (st.fails >= 5) { st.cool = now() + 1800000; st.fails = 0; log(`${p.name}: five probes in a row got no picture size, so the resolution scan leaves it alone for 30 minutes`); } }
          touch(p.id);
          st.next = now() + gap + Math.floor(Math.random() * gap);
        })();
      }
    } finally { busyTick = false; }
  }

  function start() { if (timer) return; timer = setInterval(() => tick().catch(() => {}), o.tickMs || 8000); if (timer.unref) timer.unref(); }
  function stop() { if (timer) clearInterval(timer); timer = null; for (const a of active.values()) { try { a.abort(); } catch { /* gone */ } } flush(); }

  return { height, size, report, yieldTo, start, stop, tick, counts, flush, _load: load };
};
