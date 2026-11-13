'use strict';
/* EXPERIMENTAL. Tablo 4th Gen source: signs in to the Tablo cloud account, lists the device's channels, and asks
 * the device on your network to start a live stream, which comes back as an HLS address.
 *
 * Tablo publishes no API for this. The calls below follow the community "tablo-api" Python library (MIT licence,
 * https://pypi.org/project/tablo-api/ 0.1.2, by Michael Dillon), which in turn documents the Tablo mobile app's
 * traffic. The two request-signing keys are the ones that library lists, taken from the app; they can be replaced
 * with TABLO_HASH_KEY / TABLO_DEVICE_KEY should Tablo ever change them. Nothing here has been run against a real
 * device by its author; see docs/CONFIGURATION.md. */
const crypto = require('crypto');

const CLOUD = process.env.TABLO_CLOUD_URL || 'https://lighthousetv.ewscloud.com';
const CLOUD_UA = 'Tablo-FAST/2.0.0 (Mobile; iPhone; iOS 16.6)';
const LOCAL_UA = 'Tablo-FAST/1.7.0 (Mobile; iPhone; iOS 18.4)';
const HASH_KEY = process.env.TABLO_HASH_KEY || '6l8jU5N43cEilqItmT3U2M2PFM3qPziilXqau9ys';
const DEVICE_KEY = process.env.TABLO_DEVICE_KEY || 'ljpg6ZkwShVv8aI12E2LP55Ep8vq1uYDPvX0DdTB';
const SESSION_MS = 6 * 3600 * 1000; // sign in again after this long, or at once if the device refuses us

const sessions = new Map(); // provider id -> { key, at, devices, clientId, access }

class TabloError extends Error { constructor(msg, status, detail) { super(msg); this.status = status || 0; this.detail = detail || ''; } }

/* The signature the device expects: HMAC-MD5 over "METHOD\nPATH\nMD5(BODY)\nDATE" (the body hash is empty for no body). */
function deviceAuth(method, path, body, now) {
  const date = (now || new Date()).toUTCString();
  const bodyHash = body ? crypto.createHash('md5').update(body).digest('hex') : '';
  const sig = crypto.createHmac('md5', HASH_KEY).update(`${method}\n${path}\n${bodyHash}\n${date}`).digest('hex');
  return { authorization: `tablo:${DEVICE_KEY}:${sig}`, date };
}

async function call(url, opts, ms) {
  let r;
  try { r = await fetch(url, { ...opts, signal: AbortSignal.timeout(ms || 15000) }); }
  catch (e) { throw new TabloError(e && e.name === 'TimeoutError' ? 'timed out' : String((e && e.cause && e.cause.code) || (e && e.message) || e)); }
  return r;
}

async function cloudSignIn(email, password) {
  const base = { 'User-Agent': CLOUD_UA, Accept: '*/*' };
  let r = await call(`${CLOUD}/api/v2/login/`, { method: 'POST', headers: { ...base, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  if (r.status === 400 || r.status === 401 || r.status === 403) throw new TabloError('Tablo rejected the email or password.', r.status);
  if (!r.ok) throw new TabloError(`the Tablo cloud answered HTTP ${r.status}`, r.status);
  const login = await r.json();
  if (!login || !login.access_token) throw new TabloError('the Tablo cloud sign-in did not return a token');
  const auth = `${login.token_type || 'Bearer'} ${login.access_token}`;
  r = await call(`${CLOUD}/api/v2/account/`, { headers: { ...base, Authorization: auth } });
  if (!r.ok) throw new TabloError(`the Tablo cloud account lookup answered HTTP ${r.status}`, r.status);
  const acct = await r.json();
  const profile = acct && Array.isArray(acct.profiles) && acct.profiles[0];
  const devs = acct && Array.isArray(acct.devices) ? acct.devices : [];
  if (!profile) throw new TabloError('this Tablo account has no profile');
  if (!devs.length) throw new TabloError('this Tablo account has no devices');
  const clientId = crypto.randomUUID();
  const devices = [];
  for (const d of devs) {
    r = await call(`${CLOUD}/api/v2/account/select/`, { method: 'POST', headers: { ...base, 'Content-Type': 'application/json', Authorization: auth }, body: JSON.stringify({ pid: profile.identifier, sid: d.serverId }) });
    if (!r.ok) throw new TabloError(`the Tablo cloud would not select ${d.name || d.serverId} (HTTP ${r.status})`, r.status);
    const sel = await r.json();
    devices.push({ sid: String(d.serverId), name: String(d.name || d.serverId), url: String(d.url || '').replace(/\/+$/, ''), lighthouse: String(sel.token || '') });
  }
  return { access: String(login.access_token), devices, clientId };
}

/* The sign-in for a provider, reused until it is old or the provider's login changes. */
async function session(p, fresh) {
  const key = `${p.username}\n${p.password}`;
  const s = sessions.get(p.id);
  if (!fresh && s && s.key === key && Date.now() - s.at < SESSION_MS) return s;
  const got = await cloudSignIn(p.username, p.password);
  const next = { key, at: Date.now(), ...got };
  sessions.set(p.id, next);
  return next;
}
function forget(id) { sessions.delete(id); }

/* The device to use: the one whose address matches what was typed in, else the account's first. */
function pickDevice(s, p) {
  const addr = String(p.url || '').trim();
  let local = '';
  if (addr) local = (/^[a-z]+:\/\//i.test(addr) ? addr : 'http://' + addr).replace(/\/+$/, '');
  const dev = s.devices.find((d) => local && d.url.replace(/^https?:\/\//, '').split(':')[0] === local.replace(/^https?:\/\//, '').split(':')[0]) || s.devices[0];
  if (local && !/:\d+$/.test(local.replace(/^https?:\/\//, ''))) local += ':8885'; // the device listens on 8885
  return { ...dev, url: local || dev.url };
}

async function withSession(p, fn) {
  let s = await session(p);
  try { return await fn(s); }
  catch (e) {
    if (!(e instanceof TabloError) || (e.status !== 401 && e.status !== 403)) throw e;
    s = await session(p, true); // the token or registration expired: sign in once more
    return fn(s);
  }
}

/* [{ id, major, minor, name, network }] for the device, from the cloud guide. Over-the-top channels are left out. */
function listChannels(p) {
  return withSession(p, async (s) => {
    const dev = pickDevice(s, p);
    const r = await call(`${CLOUD}/api/v2/account/${encodeURIComponent(dev.lighthouse)}/guide/channels/`, {
      headers: { Authorization: `Bearer ${s.access}`, Lighthouse: dev.lighthouse, Accept: '*/*', 'User-Agent': CLOUD_UA, 'Content-Type': 'application/json' }
    }, 30000);
    if (!r.ok) throw new TabloError(`the Tablo cloud guide answered HTTP ${r.status}`, r.status);
    const list = await r.json();
    const out = [];
    for (const c of Array.isArray(list) ? list : []) {
      if (!c || !c.identifier || c.kind === 'ott') continue;
      const info = c.ota || {};
      out.push({ id: String(c.identifier), major: parseInt(info.major, 10) || 0, minor: parseInt(info.minor, 10) || 0, name: String(info.callSign || c.name || c.identifier), network: String(info.network || '') });
    }
    out.sort((a, b) => a.major - b.major || a.minor - b.minor || a.name.localeCompare(b.name));
    return { device: { sid: dev.sid, name: dev.name, url: dev.url }, channels: out };
  });
}

/* Asks the device to start a live stream. Resolves to { url (the HLS playlist), token (the session, to end later) }. */
function watch(p, channelId) {
  return withSession(p, async (s) => {
    const dev = pickDevice(s, p);
    const path = `/guide/channels/${channelId}/watch`;
    const payload = {
      bandwidth: null,
      extra: { limitedAdTracking: 1, deviceOSVersion: '16.6', lang: 'en_US', height: 1080, deviceId: '00000000-0000-0000-0000-000000000000', width: 1920, deviceModel: 'iPhone10,1', deviceMake: 'Apple', deviceOS: 'iOS' },
      device_id: s.clientId,
      platform: 'ios'
    };
    // The library this follows is written in Python, whose JSON has a space after every comma and colon. The device
    // should hash whatever it receives, but if it is stricter than that, the second form is the one it knew.
    const bodies = [JSON.stringify(payload), JSON.stringify(payload).replace(/("(?:[^"\\]|\\.)*")|([,:])/g, (m, str, p) => (str ? str : p + ' '))];
    let r, text = '';
    const tried = [];
    for (const body of bodies) {
      const sig = deviceAuth('POST', path, body);
      r = await call(`${dev.url}${path}?lh`, {
        method: 'POST',
        headers: { Authorization: sig.authorization, Date: sig.date, 'Content-Type': 'application/x-www-form-urlencoded', Accept: '*/*', 'User-Agent': LOCAL_UA },
        body
      }, 20000);
      text = await r.text().catch(() => '');
      tried.push(r.status);
      if (r.status !== 401) break;
    }
    const where = `${dev.url} answered ${tried.join(', ')}${text ? ' body: ' + text.slice(0, 200) : ''}`;
    if (r.status === 401) throw new TabloError('the Tablo refused the request (not registered with this sign-in)', 401, where);
    if (!r.ok) throw new TabloError(r.status === 503 || /tuner|busy|in use/i.test(text) ? 'all tuners are busy' : `the Tablo answered HTTP ${r.status}`, r.status, where);
    let j; try { j = JSON.parse(text); } catch { j = null; }
    const pl = j && j.playlist_url;
    if (!pl) throw new TabloError('the Tablo did not return a stream address');
    try { return { url: new URL(pl, dev.url + '/').href, token: j.token ? String(j.token) : '' }; } catch { throw new TabloError('the Tablo returned an unusable stream address'); }
  });
}

/* A signed request with no body, to see whether the device accepts our signature at all. */
function probe(p) {
  return withSession(p, async (s) => {
    const dev = pickDevice(s, p);
    const out = {};
    for (const path of ['/server/info']) {
      const sig = deviceAuth('GET', path, '');
      try {
        const r = await call(dev.url + path, { headers: { Authorization: sig.authorization, Date: sig.date, Accept: '*/*', 'User-Agent': LOCAL_UA } }, 8000);
        out[path] = r.status;
      } catch (e) { out[path] = String(e.message || e); }
    }
    return { url: dev.url, ...out };
  });
}

/* Tells the Tablo a stream is over so it frees the tuner at once; otherwise the tuner stays reserved until the session times out. Never throws. */
async function endSession(p, token) {
  if (!token) return;
  try {
    const s = sessions.get(p.id);
    if (!s) return;
    const dev = pickDevice(s, p);
    const path = `/player/sessions/${encodeURIComponent(token)}`;
    const sig = deviceAuth('DELETE', path, '');
    await call(dev.url + path, { method: 'DELETE', headers: { Authorization: sig.authorization, Date: sig.date, Accept: '*/*', 'User-Agent': LOCAL_UA } }, 8000);
  } catch { /* the session expires by itself */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (t) => { const v = Date.parse(t); return Number.isFinite(v) ? Math.floor(v / 1000) : 0; };

/* Program listings for the channels in `want` (a set of lower-case channel identifiers), for the window lo..hi (epoch
 * seconds). Resolves to { lists: Map(id -> [{title, desc, start, end}]), programmes, via }.
 * First choice is the cloud's one-request-per-day guide grid. If that has none of our channels, the Tablo's own guide is
 * read from the device in batches of 50 (it refuses connections for about a minute after a burst, so it goes slowly). */
function guide(p, want, lo, hi) {
  return withSession(p, async (s) => {
    const dev = pickDevice(s, p);
    const lists = new Map();
    let programmes = 0;
    const add = (id, start, end, title, desc) => {
      if (!id || !want.has(id) || !start || !end || end <= lo || start >= hi) return;
      let l = lists.get(id); if (!l) lists.set(id, (l = []));
      if (l.some((e) => e.start === start)) return;
      l.push({ title: String(title || ''), desc: String(desc || '').slice(0, 240), start, end });
      programmes++;
    };
    const fin = (via) => { for (const l of lists.values()) l.sort((a, b) => a.start - b.start); return { lists, programmes, via }; };

    const days = [-1, 0, 1].map((d) => new Date(Date.now() + d * 86400e3).toISOString().slice(0, 10));
    for (const day of days) {
      const r = await call(`${CLOUD}/api/v2/account/${encodeURIComponent(dev.lighthouse)}/guide/grid/?day=${day}&limit=200`, {
        headers: { Authorization: `Bearer ${s.access}`, Lighthouse: dev.lighthouse, Accept: '*/*', 'User-Agent': CLOUD_UA, 'Content-Type': 'application/json' }
      }, 45000);
      if (r.status === 401 || r.status === 403) throw new TabloError('the Tablo cloud sign-in expired', r.status);
      if (!r.ok) continue;
      const j = await r.json().catch(() => null);
      for (const row of j && Array.isArray(j.grid) ? j.grid : []) {
        const id = String((row.channel && (row.channel.identifier || row.channel.id)) || '').toLowerCase();
        if (!want.has(id)) continue;
        for (const a of Array.isArray(row.airings) ? row.airings : []) {
          const start = iso(a.datetime);
          add(id, start, start + (+a.duration || 0), a.title || (a.show && a.show.title), a.description);
        }
      }
    }
    if (programmes > 0) return fin('cloud');

    // Not in the cloud grid: read the guide from the device itself.
    const local = async (method, path, bodyText) => {
      const sig = deviceAuth(method, path, bodyText || '');
      const r = await call(dev.url + path, { method, headers: { Authorization: sig.authorization, Date: sig.date, Accept: '*/*', 'User-Agent': LOCAL_UA, ...(bodyText ? { 'Content-Type': 'application/json' } : {}) }, body: bodyText || undefined }, 30000);
      if (r.status === 401) throw new TabloError('the Tablo refused the request', 401);
      if (!r.ok) throw new TabloError(`the Tablo answered HTTP ${r.status}`, r.status);
      return r.json();
    };
    const paths = (await local('GET', '/guide/airings')).filter((x) => typeof x === 'string').slice(0, 8000);
    for (let i = 0; i < paths.length; i += 50) {
      const got = await local('POST', '/batch', JSON.stringify(paths.slice(i, i + 50))).catch((e) => { if (e.status === 401) throw e; return null; });
      if (got && typeof got === 'object') {
        for (const o of Object.values(got)) {
          const d = o && o.airing_details;
          if (!d) continue;
          const ch = d.channel || {};
          const id = String(ch.channel_identifier || ch.identifier || (ch.channel && ch.channel.channel_identifier) || o.channel_identifier || '').toLowerCase();
          const start = iso(d.datetime);
          add(id, start, start + (+d.duration || 0), d.show_title || (o.episode && o.episode.title), o.episode && o.episode.description);
        }
      }
      await sleep(300);
    }
    return fin('device');
  });
}

module.exports = { listChannels, watch, endSession, guide, probe, forget, deviceAuth, TabloError };
