'use strict';
/* A provider behind a balancer answers a live channel's playlist from more than one of its servers, and they do not agree: one is often a
 * segment or two behind the other, and the same segment name can hold different bytes on each. Following whichever answered last makes the
 * playlist step backward and mixes two versions of the picture. So each channel sticks to one server: a playlist that lists its segments from
 * another server is set aside (the last one from the pinned server is shown again; the other server's segments are kept only as a fallback).
 * The pin moves when the pinned server stops answering playlists, or its segments keep failing. */
module.exports = function pins(o) {
  const switchMs = (o && o.switchMs) || 12000;     // the pinned server has given no playlist for this long while another has: move
  const failN = (o && o.failN) || 3, failMs = (o && o.failMs) || 30000;
  const avoidMs = (o && o.avoidMs) || 60000;       // after its segments failed, a server is not pinned again for this long unless it is the only one answering
  const m = new Map();

  /* hosts: the distinct servers this playlist lists its segments from. Returns { text, event, from, kept } where `text` is the playlist to hand out. */
  function choose(key, hosts, text, now, ctx) {
    if (!hosts || hosts.length !== 1) return { text, ctx, event: null, kept: false };
    const h = hosts[0];
    let st = m.get(key);
    if (!st) { if (m.size > 1000) m.clear(); st = { host: h, text, ctx, at: now, skipped: 0, fails: [], avoid: '', avoidUntil: 0 }; m.set(key, st); return { text, ctx, event: 'pin', host: h, kept: false }; }
    if (st.host === h) { st.text = text; st.ctx = ctx; st.at = now; return { text, ctx, event: null, kept: false }; }
    if (st.host === null) { // unpinned after failures: take a server, but not the one that just failed while another may still answer
      if (h === st.avoid && now < st.avoidUntil && now - st.at < switchMs) { st.skipped++; return { text: st.text, ctx: st.ctx, event: null, kept: true }; }
      const from = st.avoid; st.host = h; st.text = text; st.ctx = ctx; st.at = now; st.skipped = 0; return { text, ctx, event: 'pin', host: h, from, kept: false };
    }
    if (now - st.at > switchMs) { const from = st.host, n = st.skipped; st.host = h; st.text = text; st.ctx = ctx; st.at = now; st.skipped = 0; return { text, ctx, event: 'switch', host: h, from, skipped: n, kept: false }; }
    st.skipped++;
    return { text: st.text, ctx: st.ctx, event: null, kept: true };
  }

  /* a segment could not be had from `host` (the pinned one) */
  function fail(key, host, now) {
    const st = m.get(key); if (!st || st.host !== host) return null;
    st.fails = st.fails.filter((t) => now - t < failMs); st.fails.push(now);
    if (st.fails.length >= failN) { st.fails = []; st.avoid = host; st.avoidUntil = now + avoidMs; st.host = null; st.at = now; return { event: 'unpin', host }; }
    return null;
  }
  function pinned(key) { const st = m.get(key); return st ? st.host : null; }
  return { choose, fail, pinned, _m: m };
};
