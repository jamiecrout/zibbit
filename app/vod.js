'use strict';
/* Movies and shows from Xtream providers. The catalogs are big (tens of thousands of titles), so each one is fetched
 * once, boiled down to the few fields the screens need, kept in memory and on disk, and served a page at a time. */
const fs = require('fs');
const path = require('path');

const TTL_MS = 6 * 3600 * 1000;     // refresh a catalog in the background when it is older than this
const FETCH_MS = 180000;            // providers can take a minute or more to send a full catalog
const KINDS = { movie: { cats: 'get_vod_categories', list: 'get_vod_streams', id: 'stream_id', pic: 'stream_icon' },
  show: { cats: 'get_series_categories', list: 'get_series', id: 'series_id', pic: 'cover' } };

/* Provider names are decorated: maths-alphabet letters, emoji, bars, country codes. Plain text reads better on a TV. */
function tidy(s) {
  let t = String(s == null ? '' : s).normalize('NFKC');
  t = t.replace(/[^\p{L}\p{N}\s&'’.,:!?()\-+\/]/gu, ' ');      // symbols, emoji, box drawing
  t = t.replace(/^\s*[A-Za-z]{2,3}\s*[-:|]\s+(?=\S)/, '');       // "EN - " / "US| " prefix
  return t.replace(/\s+/g, ' ').trim();
}
const num = (x) => { const n = parseFloat(x); return Number.isFinite(n) ? n : 0; };

module.exports = function makeVod({ xtream, asArray, dir, log }) {
  const cache = new Map();   // "pid|kind" -> { at, cats, items, byCat }
  const loading = new Map(); // "pid|kind" -> promise
  const file = (pid, kind) => path.join(dir, 'vod-' + pid.replace(/[^a-z0-9_-]/gi, '_') + '-' + kind + '.json');

  function build(raw) {
    const byCat = new Map();
    for (const it of raw.items) { if (!byCat.has(it.c)) byCat.set(it.c, []); byCat.get(it.c).push(it); }
    const cats = raw.cats.map((c) => ({ id: c.id, name: c.name, count: (byCat.get(c.id) || []).length })).filter((c) => c.count > 0);
    const byId = new Map(); for (const it of raw.items) byId.set(it.i, it);
    return { at: raw.at, cats, items: raw.items, byCat, byId };
  }

  async function fetchFresh(p, kind) {
    const k = KINDS[kind];
    const t0 = Date.now();
    const [cats, list] = await Promise.all([xtream(p, k.cats, {}, FETCH_MS), xtream(p, k.list, {}, FETCH_MS)]);
    const raw = {
      at: Date.now(),
      cats: asArray(cats).map((c) => ({ id: String(c.category_id), name: tidy(c.category_name) || 'Other' })),
      items: asArray(list).map((m) => ({
        i: String(m[k.id]), n: tidy(m.name || m.title), y: String(m.year || (String(m.releaseDate || m.releasedate || '').slice(0, 4)) || '').slice(0, 4),
        r: Math.round(num(m.rating_5based || num(m.rating) / 2) * 10) / 10, p: m[k.pic] || '',
        a: num(m.added), e: String(m.container_extension || '').toLowerCase(), c: String(m.category_id == null ? '' : m.category_id)
      })).filter((m) => m.i && m.n)
    };
    try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file(p.id, kind) + '.tmp', JSON.stringify(raw)); fs.renameSync(file(p.id, kind) + '.tmp', file(p.id, kind)); } catch { /* memory only */ }
    if (log) log(`${p.name}: ${kind} catalog loaded, ${raw.items.length} titles in ${raw.cats.length} categories, ${Math.round((Date.now() - t0) / 1000)}s`);
    return build(raw);
  }

  /* The catalog, from memory, else from disk, else from the provider. Old ones are served while a new one loads. */
  async function catalog(p, kind) {
    const key = p.id + '|' + kind;
    let c = cache.get(key);
    if (!c) {
      try { const raw = JSON.parse(fs.readFileSync(file(p.id, kind), 'utf8')); if (raw && Array.isArray(raw.items)) { c = build(raw); cache.set(key, c); } } catch { /* none yet */ }
    }
    const stale = !c || Date.now() - c.at > TTL_MS;
    if (stale && !loading.has(key)) {
      const w = fetchFresh(p, kind).then((fresh) => { cache.set(key, fresh); return fresh; }).finally(() => loading.delete(key));
      loading.set(key, w);
      w.catch((e) => { if (log) log(`${p.name}: could not load ${kind} catalog: ${String((e && e.message) || e).replace(/https?:\/\/\S+/g, '')}`); });
    }
    if (c) return c;
    return loading.get(key);
  }

  const supported = (p) => !!p && p.type === 'xtream';

  function page(items, off, lim) {
    return items.slice(off, off + lim).map((m) => ({ id: m.i, n: m.n, y: m.y, r: m.r, p: m.p, e: m.e, a: m.a }));
  }

  /* sort: 'new' (recently added first), 'az', 'rating' (unrated last), 'year' (newest release first, no year last) */
  /* allow: the categories the person ticked (null = no choice made yet, so all); deny: categories hidden by the adult lock */
  const visible = (cat, allow, deny) => (!allow || allow.has(cat)) && !(deny && deny.has(cat));
  function list(c, { cat, q, sort, off, lim, allow, deny }) {
    let items;
    if (cat) items = visible(cat, allow, deny) ? (c.byCat.get(cat) || []) : [];
    else items = allow || (deny && deny.size) ? c.items.filter((m) => visible(m.c, allow, deny)) : c.items;
    const needle = String(q || '').toLowerCase().trim();
    if (needle) {
      const words = needle.split(/\s+/);
      items = items.filter((m) => { const n = m.n.toLowerCase(); return words.every((w) => n.includes(w)); });
    }
    if (needle && !sort) { // best matches first: starts with the words, then a word starts with them, then anywhere; shorter names before longer
      const rank = (m) => { const n = m.n.toLowerCase(); return n.startsWith(needle) ? 0 : n.includes(' ' + needle) ? 1 : 2; };
      items = [...items].sort((a, b) => rank(a) - rank(b) || a.n.length - b.n.length);
    }
    if (sort === 'az') items = [...items].sort((a, b) => a.n.localeCompare(b.n));
    else if (sort === 'rating') items = [...items].sort((a, b) => b.r - a.r || a.n.localeCompare(b.n));
    else if (sort === 'year') items = [...items].sort((a, b) => (parseInt(b.y, 10) || 0) - (parseInt(a.y, 10) || 0) || a.n.localeCompare(b.n)); // no year goes last
    else if (sort === 'new') items = [...items].sort((a, b) => b.a - a.a);
    return { total: items.length, items: page(items, off, lim) };
  }

  const clean = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

  async function movieInfo(p, id) {
    const d = await xtream(p, 'get_vod_info', { vod_id: id }, 60000);
    const i = d.info || {}, md = d.movie_data || {};
    return {
      id: String(id), kind: 'movie', n: tidy(md.name || i.name), y: clean(i.releasedate || i.release_date, 4), plot: clean(i.plot || i.description, 900),
      cast: clean(i.cast || i.actors, 200), director: clean(i.director, 80), genre: clean(i.genre, 80), r: Math.round(num(i.rating_5based || num(i.rating) / 2) * 10) / 10,
      mins: Math.round(num(i.duration_secs) / 60) || num(i.episode_run_time), p: i.movie_image || i.cover_big || '', back: Array.isArray(i.backdrop_path) ? i.backdrop_path[0] || '' : '',
      e: String(md.container_extension || '').toLowerCase(),
      video: clean((i.video || {}).codec_name, 12), audio: clean((i.audio || {}).codec_name, 12), height: num((i.video || {}).height)
    };
  }

  async function showInfo(p, id) {
    const d = await xtream(p, 'get_series_info', { series_id: id }, 90000);
    const i = d.info || {};
    const seasons = Object.keys(d.episodes && !Array.isArray(d.episodes) ? d.episodes : {}).sort((a, b) => num(a) - num(b)).map((s) => ({
      s: num(s),
      eps: asArray(d.episodes[s]).map((e) => ({ id: String(e.id), n: num(e.episode_num), t: tidy(e.title), e: String(e.container_extension || '').toLowerCase(),
        mins: Math.round(num((e.info || {}).duration_secs) / 60), plot: clean((e.info || {}).plot, 400), p: (e.info || {}).movie_image || '' })).sort((a, b) => a.n - b.n)
    }));
    if (!seasons.length && Array.isArray(d.episodes)) { // some panels send a flat list
      const by = new Map();
      for (const e of d.episodes) { const s = num(e.season); if (!by.has(s)) by.set(s, []); by.get(s).push({ id: String(e.id), n: num(e.episode_num), t: tidy(e.title), e: String(e.container_extension || '').toLowerCase(), mins: 0, plot: '', p: '' }); }
      for (const [s, eps] of [...by].sort((a, b) => a[0] - b[0])) seasons.push({ s, eps: eps.sort((a, b) => a.n - b.n) });
    }
    return {
      id: String(id), kind: 'show', n: tidy(i.name), y: clean(i.releaseDate || i.releasedate, 4), plot: clean(i.plot, 900), cast: clean(i.cast, 200), director: clean(i.director, 80),
      genre: clean(i.genre, 80), r: Math.round(num(i.rating_5based || num(i.rating) / 2) * 10) / 10, p: i.cover || '', back: Array.isArray(i.backdrop_path) ? i.backdrop_path[0] || '' : '', seasons
    };
  }

  /* The address of the file on the provider's server, for the seekable proxy and for ffmpeg. */
  function streamUrl(p, kind, id, ext) {
    const base = `${p.url}/${kind === 'show' ? 'series' : 'movie'}/${encodeURIComponent(p.username)}/${encodeURIComponent(p.password)}/${encodeURIComponent(id)}`;
    return ext ? `${base}.${ext.replace(/[^a-z0-9]/gi, '')}` : base;
  }

  return { supported, catalog, list, visible, movieInfo, showInfo, streamUrl, tidy, KINDS, loadingNow: () => loading.size };
};
