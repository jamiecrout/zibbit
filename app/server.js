'use strict';
/*
 * zibbit server
 * - Talks to one or more Xtream Codes providers (credentials stay on the server).
 * - Caches each provider's channel catalog, serves it in slices.
 * - Proxies live streams ONLY while a client is pulling them; closing the client
 *   connection (or POST /api/stop) drops the upstream connection immediately.
 * - Every URL handed to the browser is sealed (AES-GCM), so provider credentials
 *   embedded in stream/segment URLs never reach the client.
 * v2: roles (admin/user), forced password change, any number of providers (Xtream or M3U+XMLTV),
 *     and an admin API/page for providers, people, name cleanup, guide sources and security.
 * No dependencies. Node 18+.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const VERSION = require('./package.json').version; // the one place the version lives; releases are tagged v<version>
const zlib = require('zlib');
const { Readable } = require('stream');
const transcode = require('./transcode');
const recorder = require('./recorder');
const downloader = require('./downloader');
const tablo = require('./tablo');

const PORT = +(process.env.PORT || 8080);
const CONFIG_DIR = path.resolve(process.env.CONFIG_DIR || path.join(__dirname, 'config'));
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const CATALOG_TTL_MS = (+(process.env.CATALOG_TTL_HOURS || 6)) * 3600 * 1000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const UA = 'Mozilla/5.0 (Linux; Android 13; Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/* Started as root (for example `docker exec ... node server.js adduser`) on a config folder that belongs to someone else: do the work as that
 * owner, so nothing is ever saved that the running server then cannot read. PUID=0 opts out. */
if (typeof process.getuid === 'function' && process.getuid() === 0 && process.env.PUID !== '0') {
  try { const o = fs.statSync(CONFIG_DIR); if (o.uid !== 0) { process.setgid(o.gid); process.setuid(o.uid); } } catch { /* no config folder yet: carry on as before */ }
}
/* Everything saved under the config folder (profiles, PIN hashes, per-profile state, provider logins, caches) is for this program
 * alone: new files are made private to its user, and files from earlier versions, which were created world-readable, are
 * tightened once at start. The folder itself is left as it is. */
process.umask(0o077);
fs.mkdirSync(path.join(CONFIG_DIR, 'cache'), { recursive: true });
(function tightenModes(dir) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) { fs.chmodSync(p, 0o700); tightenModes(p); } else if (e.isFile()) fs.chmodSync(p, 0o600);
    } catch { /* not ours to change; leave it */ }
  }
})(CONFIG_DIR);

/* ---------- token key (persisted so icon URLs stay cacheable across restarts) ---------- */
const KEY_FILE = path.join(CONFIG_DIR, 'secret.key');
let KEY;
try { KEY = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex'); } catch { /* generate below */ }
if (!KEY || KEY.length !== 32) {
  KEY = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, KEY.toString('hex'), { mode: 0o600 });
}

function seal(obj, deterministic = false) {
  const json = JSON.stringify(obj);
  const iv = deterministic
    ? crypto.createHmac('sha256', KEY).update(json).digest().subarray(0, 12)
    : crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(json, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64url');
}
function unseal(tok) {
  try {
    const b = Buffer.from(tok, 'base64url');
    if (b.length < 29) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'));
  } catch { return null; }
}

/* ---------- recovery key: provider logins and guide addresses are stored encrypted ----------
 * The key is the ZIBBIT_KEY environment variable when it is set (then it is never written to the config folder). Otherwise
 * it is made on first start and kept in recovery.key. Admins can read it under Security (after typing their password), and
 * it is what opens a backup. Values on disk look like  enc:v1:<base64>  (AES-256-GCM). A plain value, such as one typed
 * into the file by hand, is still read, and is encrypted the next time it is saved or at the next start. */
const CRED_PREFIX = 'enc:v1:';
const RK_FILE = path.join(CONFIG_DIR, 'recovery.key');
const RK_ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const rkNorm = (s) => String(s || '').replace(/[\s-]+/g, '').toUpperCase();
const rkShow = (s) => (rkNorm(s).match(/.{1,4}/g) || []).join('-');
const rkDerive = (s) => crypto.scryptSync(rkNorm(s), 'zibbit-credentials-v1', 32);
const rkMake = () => Array.from({ length: 32 }, () => RK_ALPHA[crypto.randomInt(32)]).join('');
const RK = { text: '', key: null, other: null, source: 'file', problem: '', hadFile: false };
(function loadRecoveryKey() {
  let env = rkNorm(process.env.ZIBBIT_KEY);
  if (env && env.length < 16) { RK.problem = 'ZIBBIT_KEY is shorter than 16 characters, so it is being ignored.'; console.error('[zibbit] ' + RK.problem); env = ''; }
  let file = '';
  try { file = rkNorm(fs.readFileSync(RK_FILE, 'utf8')); } catch { /* none yet */ }
  if (file.length < 16) file = '';
  RK.hadFile = !!file;
  if (env) { RK.text = env; RK.source = 'env'; if (file && file !== env) RK.other = rkDerive(file); } // the old file key still opens what it sealed, until that is re-sealed
  else {
    if (!file) { file = rkMake(); fs.writeFileSync(RK_FILE, file, { mode: 0o600 }); console.log('[zibbit] made a recovery key. An admin can read it under Settings > Admin settings > Security.'); }
    RK.text = file;
  }
  RK.key = rkDerive(RK.text);
})();
function sealCred(v) {
  if (typeof v !== 'string' || !v || v.startsWith(CRED_PREFIX)) return v;
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', RK.key, iv);
  const enc = Buffer.concat([c.update(v, 'utf8'), c.final()]);
  return CRED_PREFIX + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64url');
}
/* { text, plain } for a value that was never encrypted, { text, old } when only the previous key opened it, null when no key does */
function openCred(v) {
  if (typeof v !== 'string' || !v.startsWith(CRED_PREFIX)) return { text: v, plain: true };
  const b = Buffer.from(v.slice(CRED_PREFIX.length), 'base64url');
  if (b.length < 29) return null;
  for (const [i, k] of [RK.key, RK.other].entries()) {
    if (!k) continue;
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', k, b.subarray(0, 12));
      d.setAuthTag(b.subarray(12, 28));
      return { text: Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'), old: i === 1 };
    } catch { /* try the next key */ }
  }
  return null;
}
const writeFileAtomic = (file, text, mode = 0o600) => { const tmp = file + '.tmp'; fs.writeFileSync(tmp, text, { mode }); fs.renameSync(tmp, file); };
/* the guide addresses in settings.json can carry a login, so they are sealed as well: { epg: { <provider id>: [address, ...] } } */
function mapEpg(s, fn) {
  if (!s || !s.epg || typeof s.epg !== 'object') return s;
  const epg = {};
  for (const [k, v] of Object.entries(s.epg)) epg[k] = Array.isArray(v) ? v.map(fn) : fn(v);
  return { ...s, epg };
}
const openEpgValue = (x) => { const r = typeof x === 'string' ? openCred(x) : { text: x }; return r ? r.text : x; }; // one that no key opens stays as it is, so saving never loses it
const sealEpgValue = (x) => (typeof x === 'string' ? sealCred(x.trim()) : x);

/* ---------- profiles (optional) ----------
 * users.json holds scrypt hashes. With no users the site behaves as before (APP_PASSWORD or open).
 * Manage people with:  docker exec -it zibbit node server.js adduser <name>   (also: passwd, deluser, users) */
const USERS_FILE = path.join(CONFIG_DIR, 'users.json');
const slug = (n) => String(n).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'user';
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };
const scryptAsync = (pw, saltHex) => new Promise((resolve, reject) => crypto.scrypt(String(pw), Buffer.from(saltHex, 'hex'), 32, (e, k) => (e ? reject(e) : resolve(k.toString('hex')))));
const DUMMY_SALT = '00'.repeat(16);
let usersCache = { at: 0, list: [] };
function getUsers(fresh) {
  if (!fresh && Date.now() - usersCache.at < 5000) return usersCache.list;
  const j = readJson(USERS_FILE);
  const list = (Array.isArray(j.users) ? j.users : []).filter((u) => u && u.name && u.salt && u.hash);
  usersCache = { at: Date.now(), list };
  return list;
}
function writeUsers(users) {
  const tmp = USERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ users }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, USERS_FILE);
  usersCache = { at: 0, list: [] };
}
async function setUserPassword(name, password, mustExist, opts = {}) {
  const users = getUsers(true).slice();
  const i = users.findIndex((u) => u.name.toLowerCase() === name.toLowerCase());
  if (mustExist && i < 0) throw new Error(`no such user: ${name}`);
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scryptAsync(password, salt);
  if (i >= 0) users[i] = { ...users[i], salt, hash, ...(opts.mustChange !== undefined ? { mustChange: !!opts.mustChange } : {}), ...(opts.role ? { role: opts.role } : {}) };
  else {
    // the first profile keeps the saved groups/favorites that existed before profiles did
    let stateFile = !users.length && fs.existsSync(path.join(CONFIG_DIR, 'state.json')) ? 'state.json' : `state-${slug(name)}.json`;
    while (users.some((u) => u.stateFile === stateFile)) stateFile = stateFile.replace(/(-\d+)?\.json$/, (m, n) => `-${(n ? -n : 1) + 1}.json`);
    users.push({ name, salt, hash, stateFile, role: opts.role || 'user', ...(opts.mustChange ? { mustChange: true } : {}) });
  }
  writeUsers(users);
}
let stdinRest = ''; // input that arrived after the end of a line, for the next prompt (piped input)
function promptHidden(q) {
  return new Promise((resolve) => {
    process.stdout.write(q);
    const stdin = process.stdin;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let s = '';
    let done = false;
    const finish = () => { done = true; stdin.removeListener('data', onData); if (stdin.isTTY) stdin.setRawMode(false); stdin.pause(); process.stdout.write('\n'); resolve(s); };
    function onData(chunk) {
      for (let i = 0; i < chunk.length && !done; i++) {
        const c = chunk[i];
        if (c === '\r' || c === '\n' || c === '\u0004') {
          if (c === '\r' && chunk[i + 1] === '\n') i++;
          stdinRest = chunk.slice(i + 1);
          return finish();
        }
        if (c === '\u0003') process.exit(130);
        if (c === '\u007f' || c === '\b') s = s.slice(0, -1); else s += c;
      }
    }
    stdin.on('data', onData);
    if (stdinRest) { const r = stdinRest; stdinRest = ''; onData(r); }
  });
}
if (['adduser', 'passwd', 'deluser', 'users', 'promote', 'demote', 'clear-ip-rules'].includes(process.argv[2])) {
  (async () => {
    const [, , cmd, name] = process.argv;
    if (cmd === 'users') { const u = getUsers(true); console.log(u.length ? u.map((x) => `${x.name}  [${x.role === 'admin' ? 'admin' : 'user'}${x.mustChange ? ', must change password' : ''}]  (${x.stateFile})`).join('\n') : '(no profiles yet: the first start creates an "admin" account)'); return; }
    if (cmd === 'clear-ip-rules') {
      const f = path.join(CONFIG_DIR, 'settings.json');
      const s0 = readJson(f);
      delete s0.adminAllow;
      fs.writeFileSync(f + '.tmp', JSON.stringify(s0, null, 2), { mode: 0o600 }); fs.renameSync(f + '.tmp', f);
      console.log('Removed the admin address rules. Restart is not needed.');
      return;
    }
    if (cmd === 'promote' || cmd === 'demote') {
      if (!name) throw new Error(`usage: node server.js ${cmd} <name>`);
      const all = getUsers(true).slice();
      const i = all.findIndex((u) => u.name.toLowerCase() === name.toLowerCase());
      if (i < 0) throw new Error(`no such user: ${name}`);
      if (cmd === 'demote' && all[i].role === 'admin' && all.filter((u) => u.role === 'admin').length <= 1) throw new Error('that is the only admin');
      all[i] = { ...all[i], role: cmd === 'promote' ? 'admin' : 'user' };
      writeUsers(all);
      console.log(`${all[i].name} is now ${cmd === 'promote' ? 'an admin' : 'a regular user'}.`);
      return;
    }
    if (!name) throw new Error(`usage: node server.js ${cmd} <name>`);
    if (cmd === 'deluser') {
      const users = getUsers(true).filter((u) => u.name.toLowerCase() !== name.toLowerCase());
      writeUsers(users);
      console.log(`Removed ${name}. Their saved groups and favorites file was left in place.`);
      return;
    }
    const pw = await promptHidden(`Password for ${name} (at least 8 characters): `);
    if (pw.length < 8) throw new Error('password is too short');
    if (pw !== (await promptHidden('Repeat it: '))) throw new Error('the two passwords did not match');
    await setUserPassword(name, pw, cmd === 'passwd', cmd === 'adduser' ? { role: process.argv[4] === 'admin' ? 'admin' : 'user' } : { mustChange: false });
    console.log(`${cmd === 'adduser' ? 'Saved' : 'Updated'} ${name}${cmd === 'adduser' && process.argv[4] === 'admin' ? ' (admin)' : ''}. Sign-ins and sessions are picked up within a few seconds, no restart needed.`);
  })().then(() => process.exit(0), (e) => { console.error('Error: ' + e.message); process.exit(1); });
  return; // command-line mode: do not start the server
}
if (process.argv[2] === 'epgimport') {
  // node server.js epgimport <provider id> <playlist.m3u>: copies the playlist's stream -> guide channel id pairs into epgmap.json. Prints counts only.
  try {
    const [, , , pidArg, file] = process.argv;
    if (!pidArg || !file) throw new Error('usage: node server.js epgimport <provider id> <playlist file>');
    const pid = String(pidArg).toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const raw = readJson(path.join(CONFIG_DIR, 'providers.json'));
    const list = Array.isArray(raw) ? raw : raw.providers || [];
    if (!list.some((p) => String(p.id || '').toLowerCase().replace(/[^a-z0-9_-]/g, '') === pid)) throw new Error(`no provider "${pidArg}" in providers.json`);
    const text = fs.readFileSync(file, 'utf8');
    const pairs = new Map();
    let ext = 0, last = '';
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith('#EXTINF')) { ext++; const m = /tvg-id="([^"]*)"/.exec(line); last = m ? m[1].trim() : ''; continue; }
      if (!line || line[0] === '#') continue;
      const m = /\/(\d+)(?:\.[A-Za-z0-9]+)?(?:\?.*)?$/.exec(line.trim());
      if (m && last && !pairs.has(m[1])) pairs.set(m[1], last);
      last = '';
    }
    const cat = readJson(path.join(CONFIG_DIR, 'cache', pid + '.json'));
    const known = new Set((cat.channels || []).map((c) => String(c.s)));
    const keep = known.size ? [...pairs].filter(([s]) => known.has(s)) : [...pairs];
    const mapFile = path.join(CONFIG_DIR, 'epgmap.json');
    const all = readJson(mapFile);
    all[pid] = Object.assign({}, all[pid], Object.fromEntries(keep));
    fs.writeFileSync(mapFile + '.tmp', JSON.stringify(all, null, 1));
    fs.renameSync(mapFile + '.tmp', mapFile);
    console.log(`Playlist: ${ext} entries, ${pairs.size} with a guide id.`);
    console.log(known.size ? `${keep.length} of them are channels in ${pid}'s list and were saved to epgmap.json (${pairs.size - keep.length} skipped).` : `${keep.length} saved to epgmap.json (no saved channel list for ${pid} yet, so nothing was filtered).`);
    console.log(/^#EXTM3U[^\n]*(?:url-tvg|x-tvg-url)=/.test(text) ? 'The first line names a guide address (url-tvg). Copy it into "epg" in settings.json yourself.' : 'The first line has no guide address.');
  } catch (e) { console.error('Error: ' + e.message); process.exit(1); }
  process.exit(0);
}
const authMode = () => (getUsers().length ? 'users' : APP_PASSWORD ? 'basic' : 'open');

const COOKIE = 'dock_session';
const SESSION_DAYS = 180;
const sign = (p) => crypto.createHmac('sha256', KEY).update('session.' + p).digest('base64url');
function makeSession(user, opts) {
  const p = Buffer.from(JSON.stringify({ u: user.name, e: Date.now() + SESSION_DAYS * 864e5, v: user.hash.slice(0, 12), ...(user.epoch ? { x: user.epoch } : {}), ...(opts && opts.tv ? { t: 1 } : {}) })).toString('base64url');
  return p + '.' + sign(p);
}
function parseSession(value) {
  const [p, sig] = String(value || '').split('.');
  if (!p || !sig) return null;
  const want = sign(p);
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  let d;
  try { d = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); } catch { return null; }
  if (!d || !d.e || d.e < Date.now()) return null;
  const u = getUsers().find((x) => x.name === d.u);
  if (!u || u.hash.slice(0, 12) !== d.v || (d.x || 0) !== (u.epoch || 0)) return null; // changing a password, or Sign out everywhere, signs that profile out everywhere
  return d.t ? { ...u, tv: true } : u; // a TV that was paired with a code is signed in with fewer rights (see isAdmin)
}
function readSession(req) {
  const m = /(?:^|;\s*)dock_session=([^;]+)/.exec(req.headers.cookie || '');
  return m ? parseSession(m[1]) : null;
}
function cookieHeader(req, value, maxAge) {
  // a proxy in the middle may report http for its own hop, so also look at what Cloudflare saw
  const secure = /(^|,)\s*https\s*(,|$)/.test(String(req.headers['x-forwarded-proto'] || '')) || /"scheme"\s*:\s*"https"/.test(String(req.headers['cf-visitor'] || ''));
  return `${COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
/* a state-changing request must be JSON and, if the browser says where it came from, come from this site */
function csrfOk(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return false;
  if (req.headers.origin) {
    // behind a reverse proxy the Host header may be rewritten, so also accept the host the proxy says it was given
    const hosts = [req.headers.host, String(req.headers['x-forwarded-host'] || '').split(',')[0].trim()].filter(Boolean);
    try { if (!hosts.includes(new URL(req.headers.origin).host)) return false; } catch { return false; }
  }
  return true;
}
const fails = new Map();
/* Who is calling, for the sign-in lockout. TRUST_IP_HEADER names a header your front door sets to the real client
 * address (Cloudflare: cf-connecting-ip). Otherwise the LAST X-Forwarded-For entry is used: that is the one the nearest
 * proxy added, whereas earlier entries can be written by the client. */
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');
const readSettingsFile = () => { try { return mapEpg(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) || {}, openEpgValue); } catch { return {}; } };
let FILE_SETTINGS = readSettingsFile(); // re-read by applySettings() whenever an admin saves settings
const calcTrustHeader = () => String(process.env.TRUST_IP_HEADER || FILE_SETTINGS.trustIpHeader || '').trim().toLowerCase();
let TRUST_IP_HEADER = calcTrustHeader();
const num = (v, d, lo, hi) => { v = +v; return Number.isFinite(v) && v !== 0 ? Math.min(hi, Math.max(lo, Math.round(v))) : d; };
const calcLock = () => ({ user: num(FILE_SETTINGS.lockUserFails, 5, 1, 100), ip: num(FILE_SETTINGS.lockIpFails, 20, 1, 1000), ms: num(FILE_SETTINGS.lockMinutes, 10, 1, 1440) * 60000 });
let LOCK = calcLock();
const clientIp = (req) => {
  const h = TRUST_IP_HEADER && String(req.headers[TRUST_IP_HEADER] || '').split(',')[0].trim();
  if (h) return h;
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
  return xff[xff.length - 1] || req.socket.remoteAddress || '?';
};
/* An IPv6 visitor controls a whole /64 (billions of addresses), so lockouts are counted per /64, not per address. */
const lockAddr = (ip) => {
  ip = String(ip);
  if (!ip.includes(':')) return ip;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1];
  const a = ip.split('::');
  if (a.length > 2 || !/^[0-9a-fA-F:]+$/.test(ip)) return ip;
  const head = a[0] ? a[0].split(':') : [], tail = a.length > 1 && a[1] ? a[1].split(':') : [];
  const g = [...head, ...(a.length > 1 ? Array(Math.max(0, 8 - head.length - tail.length)).fill('0') : []), ...tail];
  if (g.length !== 8) return ip;
  return g.slice(0, 4).map((x) => (parseInt(x || '0', 16) || 0).toString(16)).join(':') + '::/64';
};
const blockLogged = new Map();
const ipLog = (ip) => String(ip).replace(/[^0-9a-fA-F:.]/g, '?').slice(0, 45);
const lockedFor = (key) => { const f = fails.get(key); return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0; };
function noteFail(key, limit, windowMs) {
  const now = Date.now();
  let f = fails.get(key);
  if (!f || now - f.first > windowMs) f = { n: 0, first: now, until: 0 };
  if (++f.n >= limit) f.until = now + windowMs;
  if (fails.size > 5000) fails.delete(fails.keys().next().value);
  fails.set(key, f);
}

/* ---------- providers ----------
 * type "xtream" (default): url + username + password.   type "m3u": url is the playlist address (an XMLTV guide can be added). */
const PROV_FILE = path.join(CONFIG_DIR, 'providers.json');
const provId = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
let providers = new Map();
/* Source types: "xtream" (login), "m3u" (playlist address), "hdhr" (an HDHomeRun antenna tuner on the network) and
 * "tablo" (a Tablo 4th Gen: Tablo account email + password, optional device address; experimental). */
const ptype = (x) => (x && (x.type === 'm3u' || x.type === 'hdhr' || x.type === 'tablo') ? x.type : 'xtream');
/* Sources whose video is converted here with ffmpeg and handed to the browser as HLS. */
const isLocalHls = (t) => t === 'hdhr' || t === 'tablo';
function normProvider(p) {
  const id = provId(p && p.id);
  const type = ptype(p);
  if (!id || (!p.url && type !== 'tablo')) return null;
  if ((type === 'xtream' || type === 'tablo') && (!p.username || !p.password)) return null;
  return {
    id, type,
    name: String(p.name || id),
    url: type === 'm3u' ? String(p.url || '').trim() : String(p.url || '').trim().replace(/\/+$/, ''),
    username: String(p.username || ''),
    password: String(p.password === undefined ? '' : p.password),
    format: !isLocalHls(type) && p.format === 'ts' ? 'ts' : 'm3u8' // an antenna tuner is always served to the browser as HLS
  };
}
const credFields = (e) => { const t = ptype(e); return t === 'xtream' || t === 'tablo' ? ['username', 'password'] : t === 'm3u' ? ['url'] : []; };
/* an entry as the server uses it: logins opened. If no key opens one, locked is set and the value stays as it is on disk. */
function openEntry(e) {
  const out = { ...e };
  for (const f of credFields(e)) { const r = openCred(e[f]); if (!r) out.locked = true; else out[f] = r.text; }
  return out;
}
function sealEntry(e) {
  const out = { ...e };
  delete out.locked;
  for (const f of credFields(out)) out[f] = sealCred(out[f]);
  return out;
}
/* At start: encrypt anything stored in the clear, and anything sealed with the previous key. */
(function migrateCreds() {
  let n = 0;
  const fix = (v) => { if (typeof v !== 'string' || !v) return v; const r = openCred(v); if (!r || !(r.plain || r.old)) return v; n++; return sealCred(r.text); };
  const pf = readJson(PROV_FILE);
  const list = Array.isArray(pf) ? pf : pf.providers;
  if (Array.isArray(list)) {
    let c = 0;
    for (const e of list) if (e && typeof e === 'object') for (const f of credFields(e)) { const was = n; e[f] = fix(e[f]); if (n > was) c++; }
    if (c) writeFileAtomic(PROV_FILE, JSON.stringify({ providers: list }, null, 2));
  }
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    const was = n;
    const next = mapEpg(raw, fix);
    if (n > was) writeFileAtomic(SETTINGS_FILE, JSON.stringify(next, null, 2));
  } catch { /* no settings yet */ }
  if (n) console.log(`[zibbit] ${n} saved login${n === 1 ? '' : 's'} and guide address${n === 1 ? '' : 'es'} are now stored encrypted.`);
  if (RK.source === 'env' && RK.hadFile) { try { fs.unlinkSync(RK_FILE); console.log('[zibbit] the recovery key now comes from ZIBBIT_KEY, so recovery.key was removed from the config folder.'); } catch { /* leave it */ } }
})();
function loadProviders() {
  const next = new Map();
  if (!fs.existsSync(PROV_FILE)) {
    console.log('[zibbit] no providers yet: sign in as an admin and add one under Settings > Admin settings.');
    providers = next;
    return;
  }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(PROV_FILE, 'utf8')); } catch (e) {
    console.error('[zibbit] providers.json is not valid JSON:', e.message);
    providers = next;
    return;
  }
  const list = Array.isArray(raw) ? raw : raw.providers;
  for (const e0 of list || []) {
    const e = e0 && typeof e0 === 'object' ? openEntry(e0) : e0;
    if (e && e.locked) { console.error(`[zibbit] provider "${e.id || '?'}" is encrypted with a different recovery key, so it is not loaded. Set ZIBBIT_KEY to the key it was saved with, restore a backup, or enter the login again under Admin settings.`); continue; }
    const p = normProvider(e);
    if (!p) { console.error(`[zibbit] skipping invalid provider entry "${(e && e.id) || '?'}" (needs id, url and, for Xtream, username and password)`); continue; }
    next.set(p.id, p);
  }
  providers = next;
  console.log(`[zibbit] providers: ${[...providers.values()].map((p) => p.name).join(', ') || '(none)'}`);
}
loadProviders();

/* ---------- persisted state (groups, favorites, last channel) ---------- */
/* one state file per profile (state.json when there are no profiles) */
const userStates = new Map();
function stateFor(user) {
  const file = path.join(CONFIG_DIR, path.basename((user && user.stateFile) || 'state.json'));
  let st = userStates.get(file);
  if (!st) {
    st = { file, data: Object.assign({ lastProvider: null, last: null, providers: {} }, readJson(file)) };
    if (!st.data.providers || typeof st.data.providers !== 'object') st.data.providers = {};
    userStates.set(file, st);
  }
  return st;
}
function saveState(st) {
  const tmp = st.file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(st.data));
  fs.renameSync(tmp, st.file);
}
/* what a profile may rewind: 0 when rewind is off or ffmpeg is missing */
function rewindMine(st) { const want = rewMin(st && st.data && st.data.rewindMinutes); return Math.min(REWIND_MAX, want); }
function rewindInfo(st) { return { max: REWIND_MAX, minutes: rewindMine(st), choices: [15, 30, 60].filter((x) => x <= REWIND_MAX) }; }
function pstate(st, pid) {
  if (!st.data.providers[pid]) st.data.providers[pid] = { groups: [], favorites: [] };
  const ps = st.data.providers[pid];
  // v2: a person's own view of a provider: channels they hid, and their order inside each group
  if (!Array.isArray(ps.hidden)) ps.hidden = [];
  if (!ps.order || typeof ps.order !== 'object' || Array.isArray(ps.order)) ps.order = {};
  return ps;
}

/* ---------- Xtream helpers ---------- */
const asArray = (x) => (Array.isArray(x) ? x : x && typeof x === 'object' ? Object.values(x) : []);

async function xtream(p, action, params = {}, timeoutMs = 30000) {
  const u = new URL(p.url + '/player_api.php');
  u.search = new URLSearchParams({ username: p.username, password: p.password, ...(action ? { action } : {}), ...params }).toString();
  const r = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`provider answered HTTP ${r.status}`);
  return r.json();
}

/* ---------- movies and shows ---------- */
const vod = require('./vod')({ xtream, asArray, dir: path.join(CONFIG_DIR, 'cache'), log: (m) => console.log('[zibbit] ' + m) });
transcode.setNote((j, what, secs, more) => { const p = providers.get(j.p); if (what === 'ended') return console.log(`[zibbit] ${p ? p.name : j.p}: channel ${j.s}: the buffer's ffmpeg ended by itself after ${secs} s (it had been running fine) | ${String(more || '').replace(/https?:\/\/\S+/g, '…').slice(-500)}`); if (what === 'fast') return console.log(`[zibbit] ${p ? p.name : j.p}: channel ${j.s} is filling its buffer ${secs}x faster than real time (${more}): the source is sending a backlog or its timestamps jump`); console.log(`[zibbit] ${p ? p.name : j.p}: channel ${j.s} ${what === 'stalled' ? 'stopped sending video' : 'had gone quiet'} for ${secs} s, so its buffer was restarted`); });
downloader.setHooks({ log: (m) => console.log('[zibbit] ' + m), urlFor: (pid, kind, id, ext) => { const p = providers.get(pid); return p && vod.supported(p) ? vod.streamUrl(p, kind, id, ext) : null; }, fetchUp: (u, o) => guardedFetch(u, { ...o, headers: { 'User-Agent': UA, ...(o.headers || {}) } }) });

/* ---------- catalog ---------- */
const catalogs = new Map();
const catalogLoading = new Map();
const cacheFile = (pid) => path.join(CONFIG_DIR, 'cache', pid + '.json');

function finalize(cat) {
  const byId = new Map();
  const byCat = new Map();
  for (const ch of cat.channels) {
    byId.set(ch.s, ch);
    if (!byCat.has(ch.c)) byCat.set(ch.c, []);
    byCat.get(ch.c).push(ch);
  }
  const known = new Set(cat.categories.map((c) => c.id));
  for (const id of byCat.keys()) if (!known.has(id)) cat.categories.push({ id, name: id ? `Other (${id})` : 'Uncategorized' });
  for (const c of cat.categories) c.count = byCat.get(c.id) ? byCat.get(c.id).length : 0;
  cat.byId = byId;
  cat.byCat = byCat;
  return cat;
}

const fnv = (str) => { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; };
/* Reads an M3U playlist. Each channel gets a stable numeric id made from its guide id, name and group, so favorites survive a refresh. */
function parseM3u(text) {
  text = String(text).replace(/^\uFEFF/, '');
  const out = { channels: [], guide: '' };
  const hm = /^#EXTM3U[^\r\n]*?(?:url-tvg|x-tvg-url)="([^"]+)"/.exec(text);
  if (hm) out.guide = hm[1].split(',')[0].trim();
  const used = new Set();
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const a = {};
      line.replace(/([A-Za-z0-9_-]+)="([^"]*)"/g, (_, k, v) => { a[k.toLowerCase()] = v; return ''; });
      const ci = line.indexOf(',', line.lastIndexOf('"') + 1);
      const title = ci >= 0 ? line.slice(ci + 1).trim() : '';
      cur = { name: title || a['tvg-name'] || '', e: (a['tvg-id'] || '').trim(), logo: a['tvg-logo'] || '', group: (a['group-title'] || '').trim() };
    } else if (line.startsWith('#EXTGRP:')) {
      if (cur && !cur.group) cur.group = line.slice(8).trim();
    } else if (line[0] !== '#') {
      if (cur && /^https?:\/\//i.test(line) && cur.name) {
        let sid = fnv(`${cur.e}|${cur.name}|${cur.group}`) + 1;
        while (used.has(sid)) sid++;
        used.add(sid);
        out.channels.push({ s: String(sid), n: cur.name, c: cur.group, e: cur.e, i: /^https?:\/\//i.test(cur.logo) ? cur.logo : '', u: line });
      }
      cur = null;
    }
  }
  return out;
}
async function fetchM3u(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error(`the playlist address answered HTTP ${r.status}`);
  const text = await r.text();
  if (!/^\uFEFF?\s*#EXTM3U/.test(text)) throw new Error('that address did not return an M3U playlist');
  return parseM3u(text);
}
async function buildM3uCatalog(p) {
  const pl = await fetchM3u(p.url);
  const groups = [...new Set(pl.channels.map((c) => c.c).filter(Boolean))];
  return finalize({ fetchedAt: Date.now(), categories: groups.map((g) => ({ id: g, name: g })), channels: pl.channels });
}

/* ---------- HDHomeRun ---------- */
const tabloOpening = new Map(); // channel key -> pending request for a Tablo stream address
async function hdhrGet(base, file, ms = 10000) {
  const r = await fetch(base + file, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`the device answered HTTP ${r.status}`);
  return r.json();
}
async function buildHdhrCatalog(p) {
  const lineup = asArray(await hdhrGet(p.url, '/lineup.json'));
  const host = new URL(p.url).hostname;
  const used = new Set();
  const channels = [];
  for (const c of lineup) {
    if (!c || !c.URL || c.DRM) continue; // copy-protected cable channels can't be played
    const num = String(c.GuideNumber || '').trim();
    const name = String(c.GuideName || '').trim() || num;
    let sid = fnv('hdhr|' + num) + 1;
    while (used.has(sid)) sid++;
    used.add(sid);
    let u = '';
    try { const x = new URL(c.URL); x.hostname = host; u = x.href; } catch { continue; } // always reach the tuner by the address that was entered
    channels.push({ s: String(sid), n: num ? `${num} ${name}` : name, c: 'Antenna', e: num.toLowerCase(), i: '', u, v: String(c.VideoCodec || '') });
  }
  return finalize({ fetchedAt: Date.now(), categories: [{ id: 'Antenna', name: 'Antenna' }], channels });
}
/* SiliconDust's listings for the tuner (needs their guide subscription). The tuner's own DeviceAuth is the only credential. */
const HDHR_GUIDE = process.env.HDHR_GUIDE_URL || 'https://api.hdhomerun.com/api/guide.php';
async function readHdhrGuide(p, want, lo, hi) {
  let auth = '';
  for (let i = 0; i < 3 && !auth; i++) { try { auth = String((await hdhrGet(p.url, '/discover.json', 5000)).DeviceAuth || ''); } catch {} }
  if (!auth) throw new Error('the tuner gave no guide key');
  const lists = new Map();
  let programmes = 0, start = lo;
  for (let page = 0; page < 14 && start < hi; page++) { // each answer covers a few hours; ask again from where it ended
    const r = await fetch(`${HDHR_GUIDE}?DeviceAuth=${encodeURIComponent(auth)}&Start=${start}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`the guide service answered HTTP ${r.status}`);
    const rows = asArray(await r.json());
    let last = 0;
    for (const c of rows) {
      const id = String((c && c.GuideNumber) || '').toLowerCase();
      for (const g of asArray(c && c.Guide)) {
        const st = +g.StartTime, en = +g.EndTime;
        if (!(st && en)) continue;
        if (en > last) last = en;
        if (!id || !want.ids.has(id)) continue;
        let l = lists.get(id); if (!l) lists.set(id, (l = []));
        if (l.some((x) => x.start === st)) continue;
        l.push({ title: String(g.Title || ''), desc: String(g.EpisodeTitle || g.Synopsis || '').slice(0, 240), start: st, end: en });
        programmes++;
      }
    }
    if (last <= start) break;
    start = last;
  }
  if (!programmes) throw new Error('the guide service returned no listings for these channels');
  for (const l of lists.values()) l.sort((a, b) => a.start - b.start);
  return { lists, channels: lists.size, programmes };
}
async function hdhrTuners(p) {
  try { return Math.max(0, parseInt((await hdhrGet(p.url, '/discover.json', 5000)).TunerCount, 10) || 0); } catch { return 0; }
}

/* ---------- Tablo (experimental) ---------- */
async function buildTabloCatalog(p) {
  const got = await tablo.listChannels(p);
  const used = new Set();
  const channels = [];
  for (const c of got.channels) {
    const num = c.major ? `${c.major}.${c.minor}` : '';
    let sid = fnv('tablo|' + c.id) + 1;
    while (used.has(sid)) sid++;
    used.add(sid);
    channels.push({ s: String(sid), n: num ? `${num} ${c.name}` : c.name, c: 'Antenna', e: c.id.toLowerCase(), i: '', u: 'tablo:' + c.id, v: 'h264' });
  }
  return finalize({ fetchedAt: Date.now(), categories: [{ id: 'Antenna', name: 'Antenna' }], channels });
}

async function buildCatalog(p) {
  if (p.type === 'tablo') return buildTabloCatalog(p);
  if (p.type === 'm3u') return buildM3uCatalog(p);
  if (p.type === 'hdhr') return buildHdhrCatalog(p);
  const cats = asArray(await xtream(p, 'get_live_categories', {}, 60000));
  const streams = asArray(await xtream(p, 'get_live_streams', {}, 240000));
  return finalize({
    fetchedAt: Date.now(),
    categories: cats.map((c) => ({ id: String(c.category_id), name: String(c.category_name || '').trim() })),
    channels: streams.map((s) => ({
      s: String(s.stream_id),
      n: String(s.name || '').trim(),
      c: String(s.category_id == null ? '' : s.category_id),
      e: String(s.epg_channel_id == null ? '' : s.epg_channel_id).trim(),
      i: typeof s.stream_icon === 'string' && /^https?:\/\//i.test(s.stream_icon) ? s.stream_icon : ''
    }))
  });
}

function refreshCatalog(p) {
  let pr = catalogLoading.get(p.id);
  if (!pr) {
    pr = buildCatalog(p)
      .then((c) => {
        catalogs.set(p.id, c);
        const slim = { fetchedAt: c.fetchedAt, categories: c.categories.map(({ id, name }) => ({ id, name })), channels: c.channels };
        fs.writeFile(cacheFile(p.id), JSON.stringify(slim), { mode: 0o600 }, () => {});
        return c;
      })
      .finally(() => catalogLoading.delete(p.id));
    catalogLoading.set(p.id, pr);
  }
  return pr;
}

async function getCatalog(p, force = false) {
  let cat = catalogs.get(p.id);
  if (!cat && !force) {
    try {
      cat = finalize(JSON.parse(fs.readFileSync(cacheFile(p.id), 'utf8')));
      catalogs.set(p.id, cat);
    } catch { /* no cache */ }
  }
  const stale = !cat || Date.now() - cat.fetchedAt > CATALOG_TTL_MS;
  if (force || !cat) return refreshCatalog(p);
  if (stale) refreshCatalog(p).catch(() => {}); // serve the old list, refresh quietly
  return cat;
}

/* ---------- EPG ---------- */
function decodeMaybeB64(s) {
  s = String(s || '');
  if (!s || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return s;
  try {
    const buf = Buffer.from(s, 'base64');
    const out = buf.toString('utf8');
    if (out.includes('�') || Buffer.from(out, 'utf8').toString('base64') !== s) return s;
    return out;
  } catch { return s; }
}
const epgCache = new Map();
async function providerEpg(p, sid) {
  const k = p.id + ':' + sid;
  const hit = epgCache.get(k);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.list;
  let list = [];
  let ttl = 180000;
  try {
    const j = await xtream(p, 'get_short_epg', { stream_id: sid, limit: 8 }, 15000);
    const ts = (num, str) => (+num || Math.floor(Date.parse(String(str || '').replace(' ', 'T') + 'Z') / 1000) || 0);
    list = asArray(j && j.epg_listings)
      .map((e) => ({ title: decodeMaybeB64(e.title), desc: decodeMaybeB64(e.description), start: ts(e.start_timestamp, e.start), end: ts(e.stop_timestamp, e.end) }))
      .filter((e) => e.start && e.end)
      .sort((a, b) => a.start - b.start);
  } catch { ttl = 30000; }
  if (epgCache.size > 20000) epgCache.delete(epgCache.keys().next().value);
  epgCache.set(k, { at: Date.now(), ttl, list });
  return list;
}
/* Your own guide first, the provider's guide for anything it does not cover. */
async function getEpg(p, sid, wide) {
  if (p.type !== 'xtream' && !guideUrls(p)) return [];
  if (guideUrls(p)) {
    ensureGuide(p);
    await getCatalog(p).catch(() => null); // channel names and guide ids are needed to match
    const l = externalList(p, sid, wide);
    if (l) return l;
    if (!EPG_PROVIDER_FALLBACK && (EPG_CFG.get(String(p.id).toLowerCase()) || EPG_CFG.get(String(p.name || '').toLowerCase()))) return [];
  }
  return p.type !== 'xtream' ? [] : providerEpg(p, sid);
}

/* ---------- external guide (XMLTV) ----------
 * settings.json:  "epg": { "<provider id>": ["https://guide-1", "https://guide-2"] }   (a single address also works)
 * Sources are read in order; a channel uses the first source that has something on right now. A channel is matched by its
 * guide id (case does not matter), then by its cleaned-up name ("epgNameMatch": false turns that off), and
 * epgmap.json ({ "<provider id>": { "<stream id>": "<guide id>" } }) overrides both. Only channels somebody has ticked
 * (or starred) are kept, for a few hours back and a day ahead, so memory stays small. Addresses are never logged. */
const buildEpgCfg = () => {
  const out = new Map();
  const raw = FILE_SETTINGS.epg;
  if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw)) {
    const urls = (Array.isArray(v) ? v : [v]).map((x) => String(x || '').trim()).filter((u) => /^https?:\/\//i.test(u));
    if (urls.length) out.set(k.toLowerCase(), urls);
  }
  return out;
};
let EPG_CFG = buildEpgCfg();
const calcEpgHours = () => Math.max(1, +(FILE_SETTINGS.epgRefreshHours || process.env.EPG_REFRESH_HOURS || 12));
let EPG_HOURS = calcEpgHours();
let EPG_NAME_MATCH = FILE_SETTINGS.epgNameMatch !== false;
/* with a guide address set for a provider, a channel that guide has nothing for is left without program info, unless this is turned on: asking the provider as well is an extra call that often comes back empty */
let EPG_PROVIDER_FALLBACK = FILE_SETTINGS.epgProviderFallback === true;
/* live channels whose audio is E-AC-3 (Dolby Digital Plus, which most browsers cannot decode) get that audio converted to AAC here, video untouched */
let EAC3_FIX = FILE_SETTINGS.convertEac3Audio !== false;
/* the adult-content lock: groups that look adult (or that an admin marks) are locked behind each profile's PIN; see adult.js */
const adult = require('./adult');
let ADULT_ON = FILE_SETTINGS.adultLock === true;
let ADULT_MATCH = adult.wordMatcher(FILE_SETTINGS.adultWords);
let ADULT_IDLE = num(FILE_SETTINGS.adultIdleMinutes, 240, 15, 720) * 60000;
/* rewind: how far back anyone can wind a live channel (0 = off), and the most disk all running buffers may use */
const rewMin = (v) => (v === 0 || v === '0' || v === false ? 0 : [15, 30, 60].includes(+v) ? +v : 60);
let REWIND_MAX = rewMin(FILE_SETTINGS.rewindMinutes);
let REWIND_GB = num(FILE_SETTINGS.rewindMaxGB, 10, 1, 2000);
transcode.setBudget(REWIND_GB * 1e9);
/* recordings: the longest one allowed, and the free space the recordings folder must keep */
let REC_HOURS = num(FILE_SETTINGS.recordMaxHours, 6, 1, 24);
let REC_FLOOR_GB = num(FILE_SETTINGS.recordFloorGB, 20, 1, 5000);
recorder.setLimits({ maxSec: REC_HOURS * 3600, floorBytes: REC_FLOOR_GB * 1e9 });
const pinLock =adult.makeLockout({ max: () => ({ max: LOCK.user, baseMs: LOCK.ms }) });
const unlocks = adult.makeUnlocks({ idleMs: () => ADULT_IDLE });
const EPG_BACK = 3 * 3600, EPG_AHEAD = 30 * 3600;
const guides = new Map();
const guideUrls = (p) => {
  const x = EPG_CFG.get(String(p.id).toLowerCase()) || EPG_CFG.get(String(p.name || '').toLowerCase()) || null;
  return p.type === 'tablo' ? ['tablo:', ...(x || [])] : p.type === 'hdhr' ? ['hdhr:', ...(x || [])] : x; // a Tablo or HDHomeRun brings its own guide; any addresses added are read after it
};
const guideFile = (pid) => path.join(CONFIG_DIR, 'cache', 'epg-' + String(pid).replace(/[^A-Za-z0-9_-]/g, '_') + '.json');
const xmlText = (t) => t.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
  e = e.toLowerCase();
  if (e[0] === '#') { try { return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)); } catch { return m; } }
  return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e];
}).trim();
const xmltvTime = (t) => {
  const m = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?\s*([+-]\d{4})?/.exec(String(t || '').trim());
  if (!m) return 0;
  let v = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) / 1000;
  if (m[7]) v -= (m[7][0] === '-' ? -1 : 1) * (+m[7].slice(1, 3) * 3600 + +m[7].slice(3, 5) * 60);
  return v;
};
const guideName = (n) => String(n || '').normalize('NFKC').toLowerCase()
  .replace(/^\s*(\[[^\]]{1,12}\]|\([^)]{1,12}\)|\|[^|]{1,10}\||[^\s:|]{1,8}\s?[:|])\s*/, '')
  .replace(/\b(hd|fhd|uhd|sd|4k|raw|hevc|60fps|50fps)\b/g, '').replace(/[^a-z0-9]+/g, '');
// US station call signs (WLS, WGBA, KERA): a last-resort way to line a local channel up with a guide id such as wlsdt.us
const callSigns = (n) => { const out = []; const re = /(?:^|[^A-Z0-9])([WK][A-Z]{2,3})(?:-?(?:TV|DT\d?|HD))?(?![A-Z0-9])/g, u = String(n || '').normalize('NFKC').toUpperCase(); let m; while ((m = re.exec(u))) out.push(m[1].toLowerCase()); return out; };
const guideCall = (id) => { const m = /^([wk][a-z]{2,3})(?:dt\d?|tv|hd|lp|cd)?\.us$/.exec(id); return m ? m[1] : ''; };
const attr = (head, name) => { const m = new RegExp('\\b' + name + '="([^"]*)"').exec(head); return m ? m[1] : ''; };

async function* guideText(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(600000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const it = Readable.fromWeb(r.body)[Symbol.asyncIterator]();
  const first = await it.next();
  if (first.done) return;
  const gz = first.value[0] === 0x1f && first.value[1] === 0x8b;
  const rest = (async function* () { yield first.value; for (;;) { const n = await it.next(); if (n.done) return; yield n.value; } })();
  const stream = gz ? Readable.from(rest).pipe(zlib.createGunzip()) : Readable.from(rest);
  stream.setEncoding('utf8');
  for await (const chunk of stream) yield chunk;
}

async function readGuideSource(url, want, nameIdx, callIdx) {
  const now = Math.floor(Date.now() / 1000), lo = now - EPG_BACK, hi = now + EPG_AHEAD;
  const lists = new Map(), wantedXml = new Set();
  let buf = '', pos = 0, total = 0, sawProg = false, channels = 0, programmes = 0;
  for await (const chunk of guideText(url)) {
    total += chunk.length;
    if (total > 2e9) throw new Error('file too large');
    buf = buf.slice(pos) + chunk; pos = 0;
    for (;;) {
      const pi = buf.indexOf('<programme', pos);
      let i = pi, isCh = false;
      if (!sawProg) { const ci = buf.indexOf('<channel ', pos); if (ci !== -1 && (pi === -1 || ci < pi)) { i = ci; isCh = true; } }
      if (i === -1) { pos = Math.max(pos, buf.length - 12); break; }
      const close = isCh ? '</channel>' : '</programme>';
      const e = buf.indexOf(close, i);
      if (e === -1) { pos = i; break; }
      const el = buf.slice(i, e + close.length);
      pos = e + close.length;
      const head = el.slice(0, el.indexOf('>'));
      if (isCh) {
        channels++;
        const id = xmlText(attr(head, 'id')).toLowerCase();
        const names = [...el.matchAll(/<display-name[^>]*>([\s\S]*?)<\/display-name>/g)].map((x) => xmlText(x[1]));
        for (const n of names) { const k = guideName(n); if (k && !nameIdx.has(k)) nameIdx.set(k, id); }
        const cb = guideCall(id);
        if (cb) { const a = callIdx.get(cb); if (a) { if (!a.includes(id)) a.push(id); } else callIdx.set(cb, [id]); }
        if (want.ids.has(id) || (cb && want.calls.has(cb)) || (EPG_NAME_MATCH && names.some((n) => want.names.has(guideName(n))))) wantedXml.add(id);
      } else {
        sawProg = true;
        const id = xmlText(attr(head, 'channel')).toLowerCase();
        if (!wantedXml.has(id)) continue;
        const start = xmltvTime(attr(head, 'start')), end = xmltvTime(attr(head, 'stop'));
        if (!start || !end || end <= lo || start >= hi) continue;
        const t = /<title[^>]*>([\s\S]*?)<\/title>/.exec(el), d = /<desc[^>]*>([\s\S]*?)<\/desc>/.exec(el);
        let l = lists.get(id); if (!l) lists.set(id, (l = []));
        l.push({ title: t ? xmlText(t[1]) : '', desc: d ? xmlText(d[1]).slice(0, 240) : '', start, end });
        programmes++;
      }
    }
  }
  for (const l of lists.values()) l.sort((a, b) => a.start - b.start);
  return { lists, channels, programmes };
}

function allStates() {
  const users = getUsers();
  return users.length ? users.map(stateFor) : [stateFor(null)];
}
function wantedStreams(p, cat) {
  const sids = new Set();
  for (const st of allStates()) {
    const ps = st.data.providers && st.data.providers[p.id];
    if (!ps) continue;
    for (const g of ps.groups || []) for (const ch of cat.byCat.get(g) || []) sids.add(ch.s);
    for (const s of ps.favorites || []) if (cat.byId.has(String(s))) sids.add(String(s));
  }
  return sids;
}

/* A Tablo's own listings, in the same shape as an XMLTV source. Channels are matched by the Tablo's channel identifier. */
async function readTabloGuide(p, want) {
  const now = Math.floor(Date.now() / 1000);
  const g = await tablo.guide(p, want.ids, now - EPG_BACK, now + EPG_AHEAD);
  console.log(`[zibbit] guide ${p.name}: Tablo listings read from the ${g.via}: ${g.programmes} programmes for ${g.lists.size} channels`);
  return { lists: g.lists, channels: g.lists.size, programmes: g.programmes };
}
async function loadGuide(p, urls) {
  let cat = await getCatalog(p);
  if (cat.channels.length && (!('e' in cat.channels[0]) || ((p.type === 'tablo' || p.type === 'hdhr') && !cat.channels[0].e))) cat = await refreshCatalog(p); // a list saved before guide ids were kept
  const wanted = wantedStreams(p, cat);
  const want = { ids: new Set(), names: new Set(), calls: new Set() };
  for (const s of wanted) { const ch = cat.byId.get(s); if (ch.e) want.ids.add(ch.e.toLowerCase()); const k = guideName(ch.n); if (k) want.names.add(k); for (const c of callSigns(ch.n)) want.calls.add(c); }
  const map = readJson(path.join(CONFIG_DIR, 'epgmap.json'))[p.id] || {};
  for (const v of Object.values(map)) want.ids.add(String(v).toLowerCase());
  const nameIdx = new Map(), callIdx = new Map(), lists = [], sources = [];
  for (const url of urls) {
    const t0 = Date.now();
    try {
      const r = url === 'tablo:' ? await readTabloGuide(p, want) : url === 'hdhr:' ? await readHdhrGuide(p, want, Math.floor(Date.now() / 1000) - EPG_BACK, Math.floor(Date.now() / 1000) + EPG_AHEAD) : await readGuideSource(url, want, nameIdx, callIdx);
      lists.push(r.lists);
      sources.push({ ok: true, channels: r.channels, programmes: r.programmes, seconds: Math.round((Date.now() - t0) / 1000) });
    } catch (e) {
      lists.push(new Map());
      sources.push({ ok: false, error: String((e && e.message) || e).replace(/https?:\/\/\S+/g, '').slice(0, 60) || 'failed' });
    }
  }
  return { at: Date.now(), urlsKey: crypto.createHash('sha1').update(urls.join('|')).digest('hex'), sources, lists, nameIdx, callIdx, wanted, map };
}

function resolveXmlHow(g, ch) {
  const has = (x) => x && g.lists.some((m) => m.has(x));
  const o = g.map && g.map[ch.s];
  if (o && has(String(o).toLowerCase())) return [String(o).toLowerCase(), 'link'];
  if (ch.e && has(ch.e.toLowerCase())) return [ch.e.toLowerCase(), 'provider'];
  if (EPG_NAME_MATCH) { const x = g.nameIdx.get(guideName(ch.n)); if (has(x)) return [x, 'name']; }
  if (g.callIdx) for (const c of callSigns(ch.n)) { // local station: prefer the plain id (wls.us) over digital variants
    const ids = g.callIdx.get(c);
    if (ids) { const pick = ids.slice().sort((a, b) => (a === c + '.us' ? -1 : b === c + '.us' ? 1 : a.length - b.length)).find(has); if (pick) return [pick, 'callsign']; }
  }
  return ['', ''];
}
const resolveXml = (g, ch) => resolveXmlHow(g, ch)[0];
function externalList(p, sid, wide) {
  const g = guides.get(p.id);
  if (!g || !g.lists) return null;
  const cat = catalogs.get(p.id), ch = cat && cat.byId.get(sid);
  if (!ch) return null;
  let x = g.resolved.get(sid);
  if (x === undefined) { x = resolveXml(g, ch); g.resolved.set(sid, x); }
  if (!x) return null;
  const now = Date.now() / 1000;
  for (const m of g.lists) {
    const l = m.get(x);
    if (l && l.some((e) => e.start <= now && now < e.end)) {
      const f = l.filter((e) => e.end > now - (wide ? 3600 : 1800));
      return (wide ? f : f.slice(0, 8)).map((e) => ({ title: e.title, desc: e.desc, start: e.start, end: e.end }));
    }
  }
  return null; // nothing on right now in any source: let the provider's guide answer
}

function startGuide(p, g, urls) {
  g.loading = true; g.lastTry = Date.now();
  console.log(`[zibbit] guide ${p.name}: loading ${urls.length} source${urls.length === 1 ? '' : 's'}…`);
  loadGuide(p, urls).then((n) => {
    if (n.sources.some((x) => x.ok) || !g.lists) {
      Object.assign(g, { at: n.at, urlsKey: n.urlsKey, lists: n.lists, nameIdx: n.nameIdx, callIdx: n.callIdx, wanted: n.wanted, map: n.map, resolved: new Map() });
      fs.writeFile(guideFile(p.id), JSON.stringify({ v: 2, at: n.at, urlsKey: n.urlsKey, wanted: [...n.wanted], map: n.map, nameIdx: [...n.nameIdx], callIdx: [...n.callIdx], lists: n.lists.map((m) => [...m]) }), () => {});
    }
    g.sources = n.sources;
    const cat = catalogs.get(p.id);
    let matched = 0;
    if (cat && g.lists) for (const s of g.wanted) if (resolveXml(g, cat.byId.get(s))) matched++;
    console.log(`[zibbit] guide ${p.name}: ${n.sources.filter((x) => x.ok).length}/${n.sources.length} sources read, ${matched} of ${n.wanted.size} channels matched`);
  }).catch((e) => console.log(`[zibbit] guide ${p.name}: failed (${String((e && e.message) || e).replace(/https?:\/\/\S+/g, '').slice(0, 60)})`))
    .finally(() => { g.loading = false; });
}
function ensureGuide(p) {
  const urls = guideUrls(p);
  if (!urls) return;
  let g = guides.get(p.id);
  if (!g) {
    g = { loading: false, at: 0, lastTry: 0, lists: null, sources: [], resolved: new Map(), wanted: new Set(), map: {}, nameIdx: new Map(), callIdx: new Map() };
    guides.set(p.id, g);
    try { // a guide saved by an earlier run, so a restart does not download everything again
      const d = JSON.parse(fs.readFileSync(guideFile(p.id), 'utf8'));
      if (d && d.v === 2 && d.urlsKey === crypto.createHash('sha1').update(urls.join('|')).digest('hex') && Array.isArray(d.lists)) {
        Object.assign(g, { at: d.at, urlsKey: d.urlsKey, lists: d.lists.map((m) => new Map(m)), nameIdx: new Map(d.nameIdx), callIdx: new Map(d.callIdx || []), wanted: new Set(d.wanted), map: readJson(path.join(CONFIG_DIR, 'epgmap.json'))[p.id] || {}, sources: [{ ok: true, cached: true }] });
        console.log(`[zibbit] guide ${p.name}: using the saved listings from ${new Date(d.at).toISOString()} (${d.wanted.length} channels)`);
      }
    } catch { /* nothing saved yet */ }
  }
  if (g.loading) return;
  if (g.lists && Date.now() - g.lastTry > 900000 && Date.now() - (g.checked || 0) > 300000) { // channels ticked or starred since the listings were read
    g.checked = Date.now();
    const cat = catalogs.get(p.id);
    if (cat) for (const s of wantedStreams(p, cat)) if (!g.wanted.has(s)) { startGuide(p, g, urls); return; }
  }
  const old = Date.now() - g.at > EPG_HOURS * 3600e3;
  if (old && Date.now() - g.lastTry > (g.at ? 60000 : 600000)) startGuide(p, g, urls);
}
/* a profile ticked or starred something new: pick it up soon (not more than every 15 minutes) */
function guideTouch(p, cat) {
  const g = guides.get(p.id), urls = guideUrls(p);
  if (!g || !urls || g.loading || Date.now() - g.lastTry < 900000) return;
  for (const s of wantedStreams(p, cat)) if (!g.wanted.has(s)) { startGuide(p, g, urls); return; }
}

async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

/* ---------- stream sessions + proxy ---------- */
/* A session is one device (cid) of one profile (u) watching one channel (s) on one provider (p). */
const sessions = new Map();
const LIVE_MS = 15000; // HLS is short requests, so "live" = a connection is open OR activity within this long
const isLive = (x, now = Date.now()) => x.conns.size > 0 || now - x.last < LIVE_MS;
function sess(pid, sid, uname, cid) {
  const k = [pid, sid, uname || '', cid || ''].join('|');
  let x = sessions.get(k);
  if (!x) { x = { p: pid, s: sid, u: uname || '', c: cid || '', since: Date.now(), last: Date.now(), bytes: 0, conns: new Set() }; sessions.set(k, x); }
  return x;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, x] of sessions) if (!x.conns.size && now - x.last > 120000) sessions.delete(k);
  for (const [k, at] of evicted) if (now - at > 600000) evicted.delete(k);
}, 30000).unref();

function stopSessions(match) {
  let n = 0;
  for (const [k, x] of sessions) {
    if (!match(x)) continue;
    for (const ac of x.conns) { ac.abort(); n++; }
    x.conns.clear();
    sessions.delete(k);
  }
  reapTranscodes();
  return n;
}
/* A transcode lives only while someone is watching that channel. */
function reapTranscodes() {
  const now = Date.now();
  transcode.reap((j) => { if (recorder.recording(j.key)) return true; for (const x of sessions.values()) if (x.p === j.p && x.s === j.s && isLive(x, now)) return true; return false; });
}

/* Someone who "takes over" ends another device's stream. That device's player keeps retrying, so it is
 * remembered here and refused (410) until that device deliberately starts a channel again. */
const evicted = new Map();
const evictKey = (x) => [x.u, x.c, x.p].join('|');

/* Optional cap on simultaneous streams per provider. Off by default: providers' nominal limits are often not
 * enforced, so nothing is blocked unless STREAM_LIMIT is set to a number, or to "auto" to use the provider's
 * own max_connections. 0 = no limit. */
const limitCache = new Map();
const LIMIT_TTL = parseInt(process.env.LIMIT_CACHE_MS, 10) >= 0 ? parseInt(process.env.LIMIT_CACHE_MS, 10) : 60000;
const STREAM_LIMIT = String(process.env.STREAM_LIMIT || '0').trim().toLowerCase();
async function maxConnections(p) {
  if (p.type === 'hdhr') { // the tuners are the limit; STREAM_LIMIT can only lower it
    const hit = limitCache.get(p.id);
    let n = hit && Date.now() - hit.at < LIMIT_TTL ? hit.max : null;
    if (n === null) { n = await hdhrTuners(p); limitCache.set(p.id, { at: Date.now(), max: n }); }
    const cap = parseInt(STREAM_LIMIT, 10) || 0;
    return cap > 0 && n > 0 ? Math.min(n, cap) : n || cap;
  }
  if (p.type === 'm3u' || p.type === 'tablo') return Math.max(0, parseInt(STREAM_LIMIT, 10) || 0);
  if (STREAM_LIMIT !== 'auto') return Math.max(0, parseInt(STREAM_LIMIT, 10) || 0);
  const hit = limitCache.get(p.id);
  if (hit && Date.now() - hit.at < LIMIT_TTL) return hit.max;
  let max = 0;
  try {
    const j = await xtream(p, '', {}, 8000);
    max = Math.max(0, parseInt(j && j.user_info && j.user_info.max_connections, 10) || 0);
  } catch { /* unknown: do not block anyone on a guess */ }
  limitCache.set(p.id, { at: Date.now(), max });
  return max;
}

const limitNoted = new Map();
const rewindBad = new Map(); // "provider-channel" -> when buffering it failed; direct playback is used for 10 minutes
setInterval(() => { const now = Date.now(); for (const [k, at] of rewindBad) if (now - at > 600000) rewindBad.delete(k); }, 60000).unref();
function rewritePlaylist(text, baseUrl, meta, ss) {
  /* the addresses the rewind buffer's ffmpeg is given end in .ts / .m3u8 / .mp4, because newer ffmpeg refuses HLS segments that have no
   * recognisable file extension (the extension is only a label; the server looks the real address up from the sealed part) */
  const wrap = (u, ext) => {
    // deterministic: a rolling live playlist must show the same URL for the same segment on every
    // reload, or hls.js reports "media sequence mismatch" and the stream stops after a few seconds
    try {
      if (meta.k === 'ingest') return '/__ingest/' + seal({ u: new URL(u, baseUrl).href, p: meta.p, s: meta.s, k: 'ingest' }, true) + (ext || '');
      return '/x/' + seal({ u: new URL(u, baseUrl).href, p: meta.p, s: meta.s, c: meta.c }, true);
    } catch { return u; }
  };
  /* Some providers sit behind a balancer whose servers number the same segment alike but name it
   * differently, so one sequence number can come back with two different URLs. Pin the first URL
   * seen for each number for this viewing session so the player always sees a consistent list. */
  const m = /#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(text);
  const pin = ss && m && /#EXTINF/.test(text) ? (ss.segPin || (ss.segPin = new Map())) : null;
  let seq = m ? parseInt(m[1], 10) : 0;
  if (pin) { if (ss.segLast !== undefined && seq < ss.segLast - 5) pin.clear(); ss.segLast = seq; } // the numbering restarted: old pins no longer apply
  let after = '';
  const out = text.split(/\r?\n/).map((line) => {
    if (!line.trim()) return line;
    if (line.startsWith('#')) {
      after = /^#EXT-X-(STREAM-INF|I-FRAME-STREAM-INF)/.test(line) ? '.m3u8' : /^#EXTINF/.test(line) ? '.ts' : after;
      const e = /^#EXT-X-MEDIA:/.test(line) ? '.m3u8' : /^#EXT-X-MAP:/.test(line) ? '.mp4' : /^#EXT-X-I-FRAME-STREAM-INF/.test(line) ? '.m3u8' : '';
      return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${wrap(u, e)}"`);
    }
    const w = wrap(line.trim(), after);
    if (!pin) return w;
    const n = seq++;
    const had = pin.get(n);
    if (had) {
      if (had !== w) {
        if (!ss.pinned) { const pv = providers.get(meta.p); console.log(`[zibbit] ${new Date().toISOString().replace('T', ' ').slice(0, 19)}Z ${pv ? pv.name : meta.p}: channel ${meta.s} lists one segment under different addresses; keeping the first so playback stays steady`); }
        ss.pinned = (ss.pinned || 0) + 1;
      }
      return had;
    }
    pin.set(n, w);
    return w;
  }).join('\n');
  if (pin) for (const k of pin.keys()) { if (k < seq - 60) pin.delete(k); else break; }
  return out;
}

/* ---------- app updates: the Android app asks this server whether a newer app exists ---------- */
/* The APK is never part of the image. It is read from a public folder (default: the zibbit-android repo), so publishing an
   update there is all it takes; this server checks it at most every 5 minutes and passes the file through. */
const APP_BASE = (process.env.APP_UPDATE_URL || 'https://raw.githubusercontent.com/jamiecrout/zibbit-android/main/').replace(/\/*$/, '/');
const APP_CHANNEL = (process.env.APP_UPDATE_CHANNEL != null ? process.env.APP_UPDATE_CHANNEL : (() => { try { return fs.readFileSync(path.join(__dirname, 'update-channel.txt'), 'utf8'); } catch { return ''; } })()).trim().replace(/^\/+|\/+$/g, '');
const appUpd = { at: 0, j: null };
async function appManifest() {
  if (appUpd.j && Date.now() - appUpd.at < 300000) return appUpd.j;
  try {
    const r = await fetch(`${APP_BASE}${APP_CHANNEL ? APP_CHANNEL + '/' : ''}latest.json`, { headers: { 'User-Agent': 'zibbit' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = JSON.parse(await r.text());
    const ok = Number.isInteger(j.versionCode) && j.versionCode > 0 && typeof j.versionName === 'string' && j.versionName.length < 40
      && /^[0-9a-f]{64}$/.test(j.sha256 || '') && Number.isInteger(j.size) && j.size > 0 && j.size < 200e6 && /^[A-Za-z0-9._-]+\.apk$/.test(j.file || '');
    if (!ok) throw new Error('the update list is not in the expected shape');
    appUpd.j = { versionCode: j.versionCode, versionName: j.versionName, sha256: j.sha256, size: j.size, file: j.file };
  } catch (e) {
    if (!appUpd.j) console.log(`[zibbit] app updates: could not read the update list (${cleanErr(e)})`);
  }
  appUpd.at = Date.now();
  return appUpd.j;
}
async function appUpdateRoute(req, res, pn) {
  const m = await appManifest();
  if (!m) return json(res, 404, { error: 'No app update is published.' });
  if (pn === '/app/latest.json') return json(res, 200, { versionCode: m.versionCode, versionName: m.versionName, sha256: m.sha256, size: m.size, url: 'app/Zibbit.apk' });
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  try {
    const r = await fetch(`${APP_BASE}${APP_CHANNEL ? APP_CHANNEL + '/' : ''}${m.file}`, { headers: { 'User-Agent': 'zibbit' }, signal: ac.signal });
    if (!r.ok || !r.body) return json(res, 502, { error: 'The update file is not available right now.' });
    res.writeHead(200, { 'Content-Type': 'application/vnd.android.package-archive', 'Content-Length': String(m.size), 'Cache-Control': 'no-store' });
    Readable.fromWeb(r.body).on('error', () => res.destroy()).pipe(res);
  } catch (e) {
    if (!res.headersSent) json(res, 502, { error: 'The update file is not available right now.' }); else res.destroy();
  }
}

/* the detail behind a bare "fetch failed": what kind of error it was and, for a multi-address connect, what each address said */
function describeCause(c) {
  if (!c) return ' [no detail from the network layer]';
  const bits = [c.constructor && c.constructor.name, c.code, c.errno, c.syscall, c.address && (c.address + (c.port ? ':' + c.port : '')), c.message].filter(Boolean);
  const sub = Array.isArray(c.errors) ? ' {' + c.errors.map((x) => [x.code, x.address && (x.address + (x.port ? ':' + x.port : '')), x.message].filter(Boolean).join(' ')).join('; ') + '}' : '';
  return ' [' + bits.join(' ') + ']' + sub;
}

/* ---------- E-AC-3 audio ---------- */
/* The stream types a transport-stream chunk declares (read from its PAT/PMT): [{ type, eac3 }] */
function tsStreams(buf) {
  let pmtPid = -1;
  for (let i = 0; i + 188 <= buf.length; i += 188) {
    if (buf[i] !== 0x47) continue;
    const pid = ((buf[i + 1] & 0x1f) << 8) | buf[i + 2], pusi = buf[i + 1] & 0x40, af = (buf[i + 3] >> 4) & 3;
    let o = i + 4;
    if (af & 2) o += 1 + buf[o];
    if (!(af & 1) || !pusi) continue;
    o += 1 + buf[o];
    if (pid === 0 && pmtPid < 0) pmtPid = ((buf[o + 10] & 0x1f) << 8) | buf[o + 11];
    else if (pid === pmtPid) {
      const len = ((buf[o + 1] & 0x0f) << 8) | buf[o + 2], pil = ((buf[o + 10] & 0x0f) << 8) | buf[o + 11];
      const out = [];
      let p = o + 12 + pil;
      const end = o + 3 + len - 4;
      while (p + 5 <= end) {
        const type = buf[p], il = ((buf[p + 3] & 0x0f) << 8) | buf[p + 4];
        let eac3 = type === 0x87;
        for (let q = p + 5; q + 2 <= p + 5 + il; q += 2 + buf[q + 1]) if (type === 0x06 && buf[q] === 0x7a) eac3 = true;
        out.push({ type, eac3 });
        p += 5 + il;
      }
      return out;
    }
  }
  return [];
}
const eac3Seen = new Map(); // "provider:channel" -> { need, at }
/* Looks at the first segment the provider is sending for this channel (about one extra request, the first time only, then remembered) */
async function needsAudioFix(p, id, target) {
  if (!EAC3_FIX || !(await transcode.available())) return false;
  const k = p.id + ':' + id, hit = eac3Seen.get(k);
  if (hit && Date.now() - hit.at < (hit.need ? 6 * 3600e3 : 10 * 60e3)) return hit.need;
  let need = false, why = '';
  try {
    const get = async (u) => { const r = await guardedFetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) }); if (!r.ok) throw new Error('HTTP ' + r.status); return r; };
    let r = await get(target), text = await r.text(), base = r.finalUrl || r.url || target;
    if (/#EXT-X-STREAM-INF/.test(text)) { // a list of qualities: look at the first
      const v = text.split(/\r?\n/).find((l) => l.trim() && l[0] !== '#');
      base = new URL(v.trim(), base).href; r = await get(base); text = await r.text(); base = r.finalUrl || r.url || base;
    }
    const seg = text.split(/\r?\n/).find((l) => l.trim() && l[0] !== '#');
    if (!seg) throw new Error('no segments listed');
    const sr = await get(new URL(seg.trim(), base).href);
    const chunks = []; let n = 0;
    for await (const c of sr.body) { chunks.push(c); n += c.length; if (n >= 192000) break; }
    sr.body.cancel().catch(() => {});
    const st = tsStreams(Buffer.concat(chunks));
    need = st.some((x) => x.eac3);
    why = st.length ? '' : 'no stream table found';
  } catch (e) { why = String(e.message || e).slice(0, 80); }
  eac3Seen.set(k, { need, at: Date.now() });
  if (need) console.log(`[zibbit] ${p.name}: channel ${id} has E-AC-3 audio, which browsers can't decode: converting the audio to AAC here (video unchanged)`);
  else if (why) console.log(`[zibbit] ${p.name}: channel ${id}: could not check the audio type (${why}); playing it as it is`);
  return need;
}
/* ---------- keeping the server out of the local network ----------
 * Stream, playlist, picture and movie addresses come from providers (and from whatever a provider's server redirects to), not from
 * the people using the app. A provider, or anything between you and one on plain http, could point one at an address inside your own
 * network, or at a cloud metadata address, and the answer would be handed to whoever asked. So before each request, and again at every
 * redirect, the name is looked up and the request is refused if it lands on a private, loopback or link-local address, unless that
 * host is one of your own providers. A provider that really does serve from inside your network can be allowed with
 * ALLOW_PRIVATE_UPSTREAM=1 (or "allowPrivateUpstream": true in settings.json). */
const dnsp = require('dns').promises;
const net = require('net');
const PRIVATE_NETS = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.168.0.0/16', '198.18.0.0/15', '224.0.0.0/3',
  '::/128', '::1/128', 'fc00::/7', 'fe80::/10', 'ff00::/8'].map(cidrParse);
const allowPrivateUpstream = () => /^(1|true|yes)$/i.test(String(process.env.ALLOW_PRIVATE_UPSTREAM || FILE_SETTINGS.allowPrivateUpstream || ''));
const hostOf = (u) => { try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? u : 'http://' + u).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch { return ''; } };
const isProviderHost = (h) => [...providers.values()].some((p) => p.url && hostOf(p.url) === h);
const dnsMemo = new Map();
async function addrsOf(h) {
  if (net.isIP(h)) return [h];
  const hit = dnsMemo.get(h);
  if (hit && Date.now() - hit.at < 60000) return hit.a;
  let a = [];
  try { a = (await dnsp.lookup(h, { all: true })).map((x) => x.address); } catch { /* the request itself will report it */ }
  if (dnsMemo.size > 2000) dnsMemo.clear();
  dnsMemo.set(h, { at: Date.now(), a });
  return a;
}
/* null when the address may be fetched, otherwise why not */
async function upstreamBlocked(u) {
  let x; try { x = new URL(u); } catch { return 'not an address'; }
  if (x.protocol !== 'http:' && x.protocol !== 'https:') return 'not http or https';
  if (allowPrivateUpstream()) return null;
  const h = x.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isProviderHost(h)) return null;
  for (const a of await addrsOf(h)) { const ip = ipParse(a); if (!ip || PRIVATE_NETS.some((c) => c && inCidr(ip, c))) return 'a private address'; }
  return null;
}
const blockNoted = new Map();
/* fetch with every hop checked; `finalUrl` on the answer is the address that finally answered */
async function guardedFetch(url, opts) {
  let u = url;
  for (let hop = 0; hop < 6; hop++) {
    const why = await upstreamBlocked(u);
    if (why) {
      const h = hostOf(u);
      if (Date.now() - (blockNoted.get(h) || 0) > 60000) { blockNoted.set(h, Date.now()); if (blockNoted.size > 200) blockNoted.clear(); console.log(`[zibbit] refused a request to ${h || '?'}: it is ${why}. If this is your provider, set ALLOW_PRIVATE_UPSTREAM=1.`); }
      throw Object.assign(new Error('refused: ' + why), { refused: true });
    }
    const r = await fetch(u, { ...opts, redirect: 'manual' });
    const loc = r.status >= 300 && r.status < 400 && r.headers.get('location');
    if (!loc) { Object.defineProperty(r, 'finalUrl', { value: u }); return r; }
    try { await r.body?.cancel(); } catch { /* already closed */ }
    u = new URL(loc, u).href;
  }
  throw new Error('too many redirects');
}

const refused = new Map(); // provider|channel -> { until, status }: when a 403 or 429 was last seen
async function pipeUpstream(req, res, url, meta) {
  const ac = new AbortController();
  const ss = meta.s && meta.k !== 'ingest' ? sess(meta.p, meta.s, meta.u, meta.c) : null; // the server's own buffer reading is not a viewer
  if (ss) { ss.conns.add(ac); ss.last = Date.now(); }
  const done = () => { if (ss) { ss.conns.delete(ac); ss.last = Date.now(); } };
  res.on('close', () => { ac.abort(); done(); });
  try {
    const headers = { 'User-Agent': UA };
    if (req.headers.range) headers.range = req.headers.range;
    const t0 = Date.now();
    /* a provider that has just refused a channel is not asked again straight away: a player or the buffer's reader retrying
       several times a second does not get in, and only looks like hammering to the provider */
    const dk = meta.s && meta.k !== 'vod' ? meta.p + '|' + meta.s : null, dn = dk && refused.get(dk);
    if (dn && dn.until > t0) { done(); res.writeHead(dn.status, { 'Content-Type': 'text/plain', 'Retry-After': String(Math.ceil((dn.until - t0) / 1000)) }); return res.end('the provider refused this channel a moment ago'); }
    const r = await guardedFetch(url, { headers, signal: ac.signal });
    const ct = r.headers.get('content-type') || '';
    const finalUrl = r.finalUrl || r.url || url;
    /* a live request the provider was slow to start answering is worth a line (at most one per provider every 30 s), so slow channels can be told apart from a slow link */
    const wait = Date.now() - t0;
    if (meta.s && meta.k !== 'vod' && r.ok && wait > 3000) {
      const pv = providers.get(meta.p), key = 'slow:' + meta.p;
      if (Date.now() - (limitNoted.get(key) || 0) > 30000) {
        limitNoted.set(key, Date.now());
        const at = new Date().toISOString().replace('T', ' ').slice(0, 19) + 'Z';
        console.log(`[zibbit] ${at} ${pv ? pv.name : meta.p}: channel ${meta.s} took ${(wait / 1000).toFixed(1)}s to start answering (${/mpegurl/i.test(ct) || /\.m3u8(\?|$)/i.test(finalUrl) ? 'playlist' : 'video data'})`);
      }
    }
    if (meta.s && meta.k !== 'vod' && !r.ok) {
      const pv = providers.get(meta.p);
      const at = new Date().toISOString().replace('T', ' ').slice(0, 19) + 'Z';
      if (dk && (r.status === 403 || r.status === 429)) { refused.set(dk, { until: Date.now() + 8000, status: r.status }); if (refused.size > 500) refused.clear(); }
      console.log(`[zibbit] ${at} ${pv ? pv.name : meta.p}: channel ${meta.s} came back HTTP ${r.status}${ct ? ' (' + ct.split(';')[0] + ')' : ''}` + (r.status === 403 || r.status === 429 ? `; this server holds ${(() => { const h = transcode.heldFor(meta.p); return h.length ? h.length + ' buffer' + (h.length > 1 ? 's' : '') + ': ' + h.join(', ') : 'no buffers'; })()}, ${[...sessions.values()].filter((x) => x.p === meta.p && isLive(x, Date.now())).length} live viewer session(s)` : ''));
      /* a refusal is often the provider's simultaneous-stream limit: note what it says right now (at most once a minute per provider) */
      if (pv && pv.type !== 'hdhr' && pv.type !== 'm3u' && pv.type !== 'tablo' && Date.now() - (limitNoted.get(pv.id) || 0) > 60000) {
        limitNoted.set(pv.id, Date.now());
        xtream(pv, '', {}, 8000).then((j) => {
          const ui = j && j.user_info;
          if (ui) console.log(`[zibbit] ${at} ${pv.name}: account is ${String(ui.status || '?')}, ${parseInt(ui.active_cons, 10) || 0} of ${parseInt(ui.max_connections, 10) || 0} streams in use`);
        }).catch((e) => console.log(`[zibbit] ${at} ${pv.name}: account check failed (${cleanErr(e)})`));
      }
    }
    if (meta.k === 'vod' && (!r.ok || /html|json|text|xml/i.test(ct))) { const pv = providers.get(meta.p); console.log(`[zibbit] ${pv ? pv.name : meta.p}: ${meta.what || 'file'} came back HTTP ${r.status}${ct ? ' (' + ct.split(';')[0] + ')' : ''}, not a video file`); }
    if (r.ok && (/mpegurl/i.test(ct) || /\.m3u8(\?|$)/i.test(finalUrl))) {
      const text = await r.text();
      if (text.trimStart().startsWith('#EXTM3U')) {
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
        return res.end(rewritePlaylist(text, finalUrl, meta, ss));
      }
      res.writeHead(r.status, { 'Content-Type': ct || 'text/plain' });
      return res.end(text);
    }
    // X-Accel-Buffering: tells nginx/NPM not to buffer, so live video isn't held back behind the proxy
    const h = { 'Content-Type': ct || 'application/octet-stream', 'Cache-Control': meta.k === 'icon' ? 'public, max-age=604800' : 'no-store', 'X-Accel-Buffering': 'no' };
    if (!r.headers.get('content-encoding')) {
      for (const k of ['content-length', 'content-range', 'accept-ranges']) { const v = r.headers.get(k); if (v) h[k] = v; }
    }
    res.writeHead(r.status, h);
    if (!r.body) return res.end();
    const rs = Readable.fromWeb(r.body);
    rs.on('data', (d) => { if (ss) { ss.bytes += d.length; ss.last = Date.now(); } });
    rs.on('error', () => res.destroy());
    rs.pipe(res);
  } catch (e) {
    done();
    if (e.name === 'AbortError' || res.destroyed) return;
    if (e.refused && !res.headersSent) { res.writeHead(403, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'upstream: refused' })); }
    if (meta.s) { // say why a live request to the provider failed outright (no HTTP answer at all), at most a few lines a minute per provider
      const key = 'fail:' + meta.p, now = Date.now(), c = limitNoted.get(key) || { at: 0, n: 0 };
      if (now - c.at > 60000) { c.at = now; c.n = 0; }
      if (c.n++ < 5) {
        limitNoted.set(key, c);
        const pv = providers.get(meta.p), cz = e.cause || {};
        const at = new Date().toISOString().replace('T', ' ').slice(0, 19) + 'Z';
        let host = ''; try { host = new URL(url).host; } catch { /* odd address */ }
        console.log(`[zibbit] ${at} ${pv ? pv.name : meta.p}: channel ${meta.s} could not be fetched from ${host}: ${e.name}: ${e.message}${cz.message ? ' / ' + cz.message : ''}${cz.code ? ' (' + cz.code + ')' : ''}${describeCause(cz)}`);
        // ask again with Node's plain HTTP client (strict, then lenient parser) to see the raw answer or the exact socket/parser error; login details are left out
        for (const lenient of [false]) {
          try {
            const u = new URL(url);
            const lib = u.protocol === 'https:' ? require('https') : require('http');
            const rq = lib.get(u, { headers: { 'User-Agent': UA }, insecureHTTPParser: lenient, timeout: 8000 }, (r2) => {
              const loc = r2.headers.location ? (() => { try { const u2 = new URL(r2.headers.location, url); return `${u2.protocol}//${u2.host}${u2.pathname.split('/').slice(0, 2).join('/')}/…`; } catch { return '?'; } })() : '';
              console.log(`[zibbit] ${at} ${pv ? pv.name : meta.p}: channel ${meta.s}: plain client (${lenient ? 'lenient' : 'strict'}) got HTTP ${r2.statusCode} ${r2.statusMessage || ''}${loc ? ', pointing to ' + loc : ''} (${r2.headers['content-type'] || 'no type'}, ${Object.keys(r2.headers).join(',')})`);
              r2.destroy();
            });
            rq.on('timeout', () => rq.destroy(new Error('timed out after 8 s')));
            rq.on('error', (e3) => console.log(`[zibbit] ${at} ${pv ? pv.name : meta.p}: channel ${meta.s}: plain client (${lenient ? 'lenient' : 'strict'}) failed: ${e3.code || ''} ${e3.message}`));
          } catch (e4) { console.log(`[zibbit] ${at} ${pv ? pv.name : meta.p}: channel ${meta.s}: plain client could not start: ${e4.message}`); }
        }
      }
    }
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream: ' + ((e.cause && e.cause.code) || 'request failed') }));
    } else res.destroy();
  }
}

/* ---------- http plumbing ---------- */
const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};
function readBody(req, max = 1e6) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (d) => { n += d.length; if (n > max) { reject(new Error('body too large')); req.destroy(); } else chunks.push(d); });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}
function authOk(req) {
  if (!APP_PASSWORD) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const dec = Buffer.from(h.slice(6), 'base64').toString('utf8');
  const pass = dec.slice(dec.indexOf(':') + 1);
  const a = crypto.createHash('sha256').update(pass).digest();
  const b = crypto.createHash('sha256').update(APP_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
/* What a page may load and run. Scripts: this server's own files, plus the page's own inline script, allowed by its hash (computed from the
 * file as it is served, so nothing to keep in step). Anything injected into a page, or loaded from anywhere else, is refused by the
 * browser. Styles may be inline because the pages set them from script. Nothing may frame these pages. */
function pageCsp(html) {
  const hashes = [];
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) hashes.push("'sha256-" + crypto.createHash('sha256').update(m[1], 'utf8').digest('base64') + "'");
  return ["default-src 'none'", "script-src 'self' " + hashes.join(' '), "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "media-src 'self' blob:",
    "connect-src 'self'", "font-src 'self'", "manifest-src 'self'", "worker-src 'self' blob:", "form-action 'self'", "base-uri 'none'", "frame-ancestors 'none'", "object-src 'none'"].join('; ');
}
/* headers for every response */
function secHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=()');
  if (/(^|,)\s*https\s*(,|$)/.test(String(req.headers['x-forwarded-proto'] || '')) || /"scheme"\s*:\s*"https"/.test(String(req.headers['cf-visitor'] || ''))) res.setHeader('Strict-Transport-Security', 'max-age=15552000'); // only ever sent over https
}
function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname === '/tv' ? '/tv.html' : pathname === '/pair' ? '/pair.html' : pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(file);
    const h = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400' };
    if (ext === '.html') h['Content-Security-Policy'] = pageCsp(data.toString('utf8'));
    res.writeHead(200, h);
    res.end(data);
  });
}

const iconPath = (pid, url) => (url ? '/x/' + seal({ u: url, p: pid, k: 'icon' }, true) : '');
/* Text to hide in channel names (not in group names): "trimFromNames" in settings.json, a list or a comma separated
 * string, e.g. "TV:,AT&T:,US:,RAW". Matching ignores case, sees superscript/fullwidth letters as plain ones (other text keeps its characters), and for words only
 * matches whole words (RAW, not DRAWER). */
/* Some providers draw their | with a box-drawing bar (┃ │ ║ ¦); to a trim entry they are all the plain bar */
const plainBars = (x) => x.replace(/[\u00A6\u2502\u2503\u2551\u2506\u2507\u254E\u254F\uFF5C]/g, '|');
const buildTrimRe = () => {
  const raw = FILE_SETTINGS.trimFromNames != null ? FILE_SETTINGS.trimFromNames : process.env.TRIM_FROM_NAMES || '';
  const list = (Array.isArray(raw) ? raw : String(raw).split(',')).map((x) => plainBars(String(x).normalize('NFKC')).trim()).filter(Boolean);
  if (!list.length) return null;
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*'); // a space in an entry also matches no space or several
  const parts = list.sort((a, b) => b.length - a.length).map((x) => (/^\w/.test(x) ? '(?<![A-Za-z0-9])' : '') + esc(x) + (/\w$/.test(x) ? '(?![A-Za-z0-9])' : ''));
  return new RegExp(parts.join('|'), 'gi');
};
let TRIM_RE = buildTrimRe();
/* "stripSuperscripts": true in settings.json (or STRIP_SUPERSCRIPTS=1) removes every superscript / subscript character
 * (like ᴴᴰ ᴿᴬᵂ ⁶⁰ᶠᵖˢ ²) from channel names. Only real superscripts: fullwidth letters, ™, ligatures and ordinals (º ª) are left alone. */
const calcStrip = () => {
  const v = FILE_SETTINGS.stripSuperscripts != null ? FILE_SETTINGS.stripSuperscripts : process.env.STRIP_SUPERSCRIPTS;
  return v === true || /^(1|true|yes|on)$/i.test(String(v == null ? '' : v).trim());
};
let STRIP_SUP = calcStrip();
const SUP_RE = /[\u00B2\u00B3\u00B9\u02B0-\u02B8\u02E0-\u02E4\u1D2C-\u1D6A\u1D78\u1D9B-\u1DBF\u2070\u2071\u2074-\u208E\u2090-\u209C]+/g;
const nameMemo = new Map();
function dispName(raw) {
  if (!TRIM_RE && !STRIP_SUP) return raw;
  let v = nameMemo.get(raw);
  if (v === undefined) {
    const src = STRIP_SUP ? raw.replace(SUP_RE, ' ') : raw;
    let out = src;
    if (TRIM_RE) {
      // Match on a plain-text version (NFKC turns superscript ᴿᴬᵂ ⁶⁰ᶠᵖˢ into RAW 60fps), but cut the matched text out of the
      // ORIGINAL name, so anything that is not removed keeps its original characters.
      const chars = Array.from(src);
      let flat = '';
      const owner = []; // for each character of `flat`, which original character it came from
      chars.forEach((ch, i) => { const f = plainBars(ch.normalize('NFKC')); for (let k = 0; k < f.length; k++) owner.push(i); flat += f; });
      const cut = new Array(chars.length).fill(false);
      TRIM_RE.lastIndex = 0;
      for (let m; (m = TRIM_RE.exec(flat)); ) {
        if (!m[0]) { TRIM_RE.lastIndex++; continue; }
        for (let k = m.index; k < m.index + m[0].length; k++) cut[owner[k]] = true;
      }
      out = chars.map((ch, i) => (cut[i] ? ' ' : ch)).join('');
    }
    v = out.replace(/\s+/g, ' ').replace(/^[\s|:\-–]+|[\s|:\-–]+$/g, '');
    if (!v) v = raw; // never leave a channel without a name
    if (nameMemo.size > 100000) nameMemo.clear();
    nameMemo.set(raw, v);
  }
  return v;
}
/* The person's own order first (in the order they set); anything they have not placed follows in the provider's order. */
const applyOrder = (list, ids) => {
  if (!ids || !ids.length) return list;
  const pos = new Map(ids.map((id, i) => [id, i]));
  const placed = list.filter((c) => pos.has(c.s)).sort((a, b) => pos.get(a.s) - pos.get(b.s));
  return placed.concat(list.filter((c) => !pos.has(c.s)));
};
const ALL_GROUPS = '__all__'; // the "All channels" view: every ticked group together
const slim = (p, ch) => ({ s: ch.s, n: dispName(ch.n), c: ch.c, i: iconPath(p.id, ch.i) });

/* ---------- adult-content lock: who is unlocked, and which groups are held back ---------- */
const devKey = (req) => { const m = /(?:^|;\s*)dock_session=([^;]+)/.exec(req.headers.cookie || ''); return m ? crypto.createHash('sha256').update(m[1]).digest('hex').slice(0, 32) : ''; };
const adultGate = (req, user) => {
  if (!ADULT_ON || !user) return { on: false, open: true, hasPin: false };
  return { on: true, open: unlocks.is(devKey(req), user.name), hasPin: !!stateFor(user).data.pin };
};
const marksFor = (pid) => (FILE_SETTINGS.adultMarks && FILE_SETTINGS.adultMarks[pid]) || {};
const isAdultGroup = (pid, kind, c) => adult.groupLocked(marksFor(pid), kind, c.id, c.name, ADULT_MATCH);
/* all: the groups the lock covers on this provider. hide: the ones held back from this person right now (none once they are unlocked). */
function adultSets(req, user, p, kind, cats) {
  const gate = adultGate(req, user), all = new Set();
  if (gate.on) for (const c of cats) if (isAdultGroup(p.id, kind, c)) all.add(c.id);
  return { gate, all, hide: gate.open ? new Set() : all };
}
const epCat = new Map(); // "provider|episode" -> the show's category, learned when the show is opened, so an episode file can be checked
const LOCKED_MSG = 'This is locked. Enter your PIN to watch it.';

async function handleProviderApi(req, res, p, action, url, st, user) {
  const ps = pstate(st, p.id);
  /* of these channel ids, the ones the adult lock is holding back from this person right now */
  const held = async (ids) => {
    if (!ADULT_ON) return new Set();
    const cat = await getCatalog(p), A = adultSets(req, user, p, 'live', cat.categories);
    if (!A.hide.size) return new Set();
    return new Set(ids.filter((s) => { const ch = cat.byId.get(s); return ch && A.hide.has(ch.c); }));
  };
  const vodSel = (kind) => (ps.vodGroups && Array.isArray(ps.vodGroups[kind]) ? new Set(ps.vodGroups[kind]) : null); // null: no choice made, so every category
  if (action === 'bootstrap' && req.method === 'GET') {
    const cat = await getCatalog(p);
    const ids = new Set(cat.categories.map((c) => c.id));
    ps.groups = ps.groups.filter((g) => ids.has(g));
    for (const k of Object.keys(ps.order)) if (!ids.has(k)) delete ps.order[k];
    const A = adultSets(req, user, p, 'live', cat.categories);
    return json(res, 200, {
      categories: cat.categories.map(({ id, name, count }) => (A.all.has(id) ? { id, name, count, lock: 1 } : { id, name, count })),
      groups: ps.groups,
      favorites: A.hide.size ? ps.favorites.filter((id) => { const ch = cat.byId.get(id); return !(ch && A.hide.has(ch.c)); }) : ps.favorites,
      adult: { on: A.gate.on, open: A.gate.open, hasPin: A.gate.hasPin },
      fetchedAt: cat.fetchedAt,
      total: cat.channels.length
    });
  }
  if (action === 'refresh' && req.method === 'POST') {
    const cat = await getCatalog(p, true);
    return json(res, 200, { fetchedAt: cat.fetchedAt, total: cat.channels.length });
  }
  if (action === 'channels' && req.method === 'GET') {
    const cat = await getCatalog(p);
    const q = (url.searchParams.get('q') || '').toLowerCase().trim();
    let list, hiddenCount = 0;
    const hid = new Set(ps.hidden);
    const wantHidden = url.searchParams.get('hidden') === '1';
    if (url.searchParams.get('fav')) {
      list = ps.favorites.map((id) => cat.byId.get(id)).filter(Boolean);
    } else if (q) {
      const toks = q.split(/\s+/);
      const scope = url.searchParams.get('scope') === 'all' ? null : new Set(ps.groups);
      list = [];
      for (const ch of cat.channels) {
        if (scope && !scope.has(ch.c)) continue;
        if (hid.has(ch.s)) continue;
        const n = ch.n.toLowerCase(), d = dispName(ch.n).toLowerCase();
        if (toks.every((t) => n.includes(t) || d.includes(t))) { list.push(ch); if (list.length >= 500) break; }
      }
    } else {
      const cid = url.searchParams.get('cat') || '';
      if (cid === ALL_GROUPS) { // every ticked group, in the person's group order, each with their own channel order
        list = [];
        for (const g of ps.groups) {
          const all = cat.byCat.get(g) || [];
          hiddenCount += all.filter((c) => hid.has(c.s)).length;
          list.push(...applyOrder(all.filter((c) => !hid.has(c.s)), ps.order[g]));
        }
      } else {
        const all = cat.byCat.get(cid) || [];
        hiddenCount = all.filter((c) => hid.has(c.s)).length;
        list = wantHidden ? all.filter((c) => hid.has(c.s)) : applyOrder(all.filter((c) => !hid.has(c.s)), ps.order[cid]);
      }
    }
    const A = adultSets(req, user, p, 'live', cat.categories);
    if (A.hide.size) list = list.filter((ch) => !A.hide.has(ch.c));
    const LIMIT = 25000; // a big provider has well over 10,000 channels; the list is drawn a screenful at a time, so only the download grows (about 1.5 MB for 14,000)
    return json(res, 200, { total: list.length, truncated: list.length > LIMIT, hiddenCount, locked: !!(A.hide.size && A.hide.has(url.searchParams.get('cat') || '')), items: list.slice(0, LIMIT).map((ch) => slim(p, ch)) });
  }
  if (action === 'channel' && req.method === 'GET') {
    const cat = await getCatalog(p);
    const ch = cat.byId.get(String(url.searchParams.get('s') || ''));
    if (ch && adultSets(req, user, p, 'live', cat.categories).hide.has(ch.c)) return json(res, 403, { error: LOCKED_MSG, locked: true });
    return ch ? json(res, 200, slim(p, ch)) : json(res, 404, { error: 'channel not found' });
  }
  if (action === 'epg' && req.method === 'GET') {
    const sid = String(url.searchParams.get('s') || '');
    if (!/^\d+$/.test(sid)) return json(res, 400, { error: 'bad stream id' });
    if ((await held([sid])).size) return json(res, 403, { error: LOCKED_MSG, locked: true });
    return json(res, 200, { list: await getEpg(p, sid) });
  }
  if (action === 'epg-status' && req.method === 'GET') {
    const urls = guideUrls(p), g = guides.get(p.id);
    if (!urls) return json(res, 200, { configured: false });
    ensureGuide(p);
    const cat = await getCatalog(p);
    let matched = 0;
    if (g && g.lists) for (const s of g.wanted) { const ch = cat.byId.get(s); if (ch && resolveXml(g, ch)) matched++; }
    return json(res, 200, { configured: true, sources: urls.length, loading: !!(g && g.loading), loadedAt: g && g.lists ? g.at : 0, results: g ? g.sources : [], channels: g ? g.wanted.size : 0, matched, nameMatching: EPG_NAME_MATCH });
  }
  if (action === 'epg-grid' && req.method === 'GET') {
    // programmes for a batch of channels, as [start, end, title] rows, for the guide grid
    const ids0 = String(url.searchParams.get('ids') || '').split(',').filter((x) => /^\d+$/.test(x)).slice(0, 30);
    const hold = await held(ids0), ids = ids0.filter((x) => !hold.has(x));
    const lists = await mapLimit(ids, 4, (id) => getEpg(p, id, true));
    const out = {};
    ids.forEach((id, i) => { out[id] = lists[i].map((e) => [e.start, e.end, String(e.title || '').slice(0, 120)]); });
    return json(res, 200, out);
  }
  if (action === 'vod-cats' && req.method === 'GET') {
    if (!vod.supported(p)) return json(res, 200, { supported: false, movies: [], shows: [] });
    const kinds = url.searchParams.get('kind') ? [url.searchParams.get('kind')] : ['movie', 'show'];
    const out = { supported: true };
    if (kinds.some((kind) => !vod.KINDS[kind])) return json(res, 400, { error: 'unknown kind' });
    const every = url.searchParams.get('all') === '1'; // the group picker wants every category with the person's ticks; browsing wants only the ticked ones
    await Promise.all(kinds.map(async (kind) => {
      try {
        const c = await vod.catalog(p, kind);
        const A = adultSets(req, user, p, kind, c.cats), sel = vodSel(kind);
        const mark = (x) => (A.all.has(x.id) ? { ...x, lock: 1 } : x);
        out[kind + 's'] = (every ? c.cats : c.cats.filter((x) => !sel || sel.has(x.id))).map(mark);
        if (every) out[kind + 'Sel'] = sel ? [...sel] : null;
        let n = 0; for (const it of c.items) if (vod.visible(it.c, sel, A.hide)) n++;
        out[kind + 'Total'] = n;
      } catch (e) { out[kind + 's'] = []; out[kind + 'Error'] = 'could not load'; }
    }));
    return json(res, 200, out);
  }
  if (action === 'vod-list' && req.method === 'GET') {
    const kind = url.searchParams.get('kind');
    if (!vod.supported(p) || !vod.KINDS[kind]) return json(res, 400, { error: 'unknown kind' });
    const lim = Math.min(200, Math.max(1, parseInt(url.searchParams.get('lim'), 10) || 60)), off = Math.max(0, parseInt(url.searchParams.get('off'), 10) || 0);
    const c = await vod.catalog(p, kind);
    const A = adultSets(req, user, p, kind, c.cats);
    if (A.hide.has(url.searchParams.get('cat') || '\u0000')) return json(res, 200, { total: 0, items: [], locked: true });
    const out = vod.list(c, { cat: url.searchParams.get('cat') || '', q: url.searchParams.get('q') || '', sort: url.searchParams.get('sort') || '', off, lim, allow: vodSel(kind), deny: A.hide });
    for (const m of out.items) m.p = iconPath(p.id, m.p); // posters go through the server like channel logos do
    return json(res, 200, out);
  }
  if (action === 'vod-info' && req.method === 'GET') {
    const kind = url.searchParams.get('kind'), id = String(url.searchParams.get('id') || '');
    if (!vod.supported(p) || !vod.KINDS[kind] || !/^\d+$/.test(id)) return json(res, 400, { error: 'unknown title' });
    const c0 = await vod.catalog(p, kind), it0 = c0.byId.get(id);
    if (it0 && adultSets(req, user, p, kind, c0.cats).hide.has(it0.c)) return json(res, 403, { error: LOCKED_MSG, locked: true });
    const info = kind === 'movie' ? await vod.movieInfo(p, id) : await vod.showInfo(p, id);
    if (kind === 'show' && it0 && ADULT_ON) { if (epCat.size > 60000) epCat.clear(); for (const sn of info.seasons || []) for (const e of sn.eps) epCat.set(p.id + '|' + e.id, it0.c); }
    info.p = iconPath(p.id, info.p); info.back = iconPath(p.id, info.back);
    for (const sn of info.seasons || []) for (const e of sn.eps) e.p = iconPath(p.id, e.p);
    return json(res, 200, info);
  }
  if (action === 'vod-codecs' && req.method === 'GET') {
    // admin only: what a few real files hold (container, video, audio), so we know which ones a TV can play as they are
    if (!isAdmin(user)) return json(res, 403, { error: 'Only an admin can run this.' });
    if (!vod.supported(p)) return json(res, 200, { supported: false });
    const c = await vod.catalog(p, 'movie');
    const per = Math.min(6, Math.max(1, parseInt(url.searchParams.get('n'), 10) || 4)), byExt = new Map();
    for (const m of c.items) { if (!m.e) continue; const l = byExt.get(m.e) || []; if (l.length < 400) l.push(m); byExt.set(m.e, l); }
    const picks = [];
    for (const [e, l] of byExt) { if (l.length < 5) continue; for (let k = 0; k < per; k++) picks.push(l[Math.floor(((k + 0.5) * l.length) / per)]); }
    const rows = await mapLimit(picks, 2, async (m) => {
      const t0 = Date.now();
      const st = await transcode.probeAll(vod.streamUrl(p, 'movie', m.i, m.e));
      const v = st.find((x) => x.type === 'video') || {}, a = st.find((x) => x.type === 'audio') || {};
      return { title: m.n.slice(0, 40), ext: m.e, video: v.codec || '', profile: v.profile || '', pix: v.pix || '', size: v.w ? v.w + 'x' + v.h : '', audio: a.codec || '', ms: Date.now() - t0 };
    });
    return json(res, 200, { supported: true, files: rows });
  }
  if (action === 'vod-probe' && req.method === 'GET') {
    // admin only: what this provider offers as movies and shows (counts and a few samples; nothing secret), used to plan the VOD screens
    if (!isAdmin(user)) return json(res, 403, { error: 'Only an admin can run this.' });
    if (p.type !== 'xtream') return json(res, 200, { supported: false, why: 'Only Xtream providers have movies and shows.' });
    const out = { supported: true };
    const get = async (name, act, params) => { const t0 = Date.now(); try { const d = await xtream(p, act, params || {}, 120000); out[name] = { ok: true, ms: Date.now() - t0, data: d }; return d; } catch (e) { out[name] = { ok: false, error: String((e && e.message) || e).replace(/https?:\/\/\S+/g, '').slice(0, 80) }; return null; } };
    const vc = asArray(await get('movieCategories', 'get_vod_categories')), vs = asArray(await get('movies', 'get_vod_streams'));
    const sc = asArray(await get('showCategories', 'get_series_categories')), ss = asArray(await get('shows', 'get_series'));
    const ext = {}; for (const m of vs) { const e = String(m.container_extension || '?').toLowerCase(); ext[e] = (ext[e] || 0) + 1; }
    const sum = { movieCategories: vc.length, movies: vs.length, showCategories: sc.length, shows: ss.length, movieFileTypes: ext,
      movieCategoryNames: vc.slice(0, 12).map((c) => c.category_name), showCategoryNames: sc.slice(0, 12).map((c) => c.category_name),
      movieSamples: vs.slice(0, 3).map((m) => ({ name: m.name, year: m.year, rating: m.rating, ext: m.container_extension, hasIcon: !!m.stream_icon, added: m.added })),
      showSamples: ss.slice(0, 3).map((m) => ({ name: m.name, year: m.year, rating: m.rating, hasCover: !!m.cover })),
      ms: { movieCategories: out.movieCategories.ms, movies: out.movies.ms, showCategories: out.showCategories.ms, shows: out.shows.ms },
      errors: ['movieCategories', 'movies', 'showCategories', 'shows'].filter((k) => !out[k].ok).map((k) => k + ': ' + out[k].error) };
    if (ss[0]) { try { const t0 = Date.now(); const d = await xtream(p, 'get_series_info', { series_id: ss[0].series_id }, 60000); sum.firstShow = { seasons: Object.keys(d.episodes || {}).length, episodes: Object.values(d.episodes || {}).reduce((a, l) => a + l.length, 0), episodeExt: ((Object.values(d.episodes || {})[0] || [])[0] || {}).container_extension, ms: Date.now() - t0 }; } catch (e) { sum.firstShow = { error: String((e && e.message) || e).slice(0, 60) }; } }
    if (vs[0]) { try { const t0 = Date.now(); const d = await xtream(p, 'get_vod_info', { vod_id: vs[0].stream_id }, 60000); const i = d.info || {}; sum.firstMovie = { hasPlot: !!(i.plot || i.description), duration: i.duration || '', video: (i.video || {}).codec_name || '', audio: (i.audio || {}).codec_name || '', ms: Date.now() - t0 }; } catch (e) { sum.firstMovie = { error: String((e && e.message) || e).slice(0, 60) }; } }
    return json(res, 200, sum);
  }
  if (action === 'epg-link' && (req.method === 'GET' || req.method === 'POST')) {
    // admin only: tell the guide to use another channel's listings for one stream (saved in epgmap.json)
    if (!isAdmin(user)) return json(res, 403, { error: 'Only an admin can change which guide a channel uses.' });
    if (!adminIpAllowed(clientIp(req))) return json(res, 403, { error: 'Admin settings are limited to certain addresses, and this one is not on the list.' });
    const cat = await getCatalog(p);
    const body = req.method === 'POST' ? await readBody(req) : {};
    const sid = String(req.method === 'POST' ? body.s : url.searchParams.get('s') || '');
    const ch = cat.byId.get(sid);
    if (!ch) return json(res, 404, { error: 'channel not found' });
    if (!guideUrls(p)) return json(res, 400, { error: 'No guide sources are set for this provider yet.' });
    ensureGuide(p);
    const g = guides.get(p.id);
    if (!g || !g.lists) return json(res, 503, { error: 'The guide is still loading. Try again in a minute.' });
    const mapFile = path.join(CONFIG_DIR, 'epgmap.json');
    const save = (fn) => { const all = readJson(mapFile); const m = all[p.id] && typeof all[p.id] === 'object' ? all[p.id] : {}; fn(m); if (Object.keys(m).length) all[p.id] = m; else delete all[p.id]; writeJsonAtomic(mapFile, all); g.map = m; g.resolved = new Map(); };
    if (req.method === 'POST') {
      if (body.clear) save((m) => { delete m[sid]; });
      else {
        const src = cat.byId.get(String(body.from || ''));
        if (!src) return json(res, 404, { error: 'The channel to copy from was not found.' });
        const [gid] = resolveXmlHow(g, src);
        if (!gid) return json(res, 400, { error: `${dispName(src.n)} has no guide data either, so there is nothing to copy.` });
        save((m) => { m[sid] = gid; });
      }
    }
    const [gid, how] = resolveXmlHow(g, ch);
    const now = Date.now() / 1000;
    let cur = null;
    if (gid) for (const m of g.lists) { const l = m.get(gid); const e = l && l.find((x) => x.start <= now && now < x.end); if (e) { cur = String(e.title || '').slice(0, 120); break; } }
    return json(res, 200, { name: dispName(ch.n), guide: gid, how, now: cur });
  }
  if (action === 'epg-now' && req.method === 'GET') {
    const ids0 = String(url.searchParams.get('ids') || '').split(',').filter((x) => /^\d+$/.test(x)).slice(0, 30);
    const hold = await held(ids0), ids = ids0.filter((x) => !hold.has(x));
    const now = Date.now() / 1000;
    const lists = await mapLimit(ids, 4, (id) => getEpg(p, id));
    const out = {};
    ids.forEach((id, i) => {
      const cur = lists[i].find((e) => e.start <= now && now < e.end);
      out[id] = cur ? { t: cur.title, s: cur.start, e: cur.end } : null;
    });
    return json(res, 200, out);
  }
  if (action === 'vod-groups' && req.method === 'PUT') {
    const body = await readBody(req);
    if (!vod.supported(p) || !vod.KINDS[body.kind]) return json(res, 400, { error: 'unknown kind' });
    if (!ps.vodGroups || typeof ps.vodGroups !== 'object') ps.vodGroups = {};
    if (body.groups === null) delete ps.vodGroups[body.kind]; // back to showing every category
    else {
      const c = await vod.catalog(p, body.kind), valid = new Set(c.cats.map((x) => x.id));
      ps.vodGroups[body.kind] = [...new Set((Array.isArray(body.groups) ? body.groups : []).map(String))].filter((g) => valid.has(g));
    }
    saveState(st);
    return json(res, 200, { groups: ps.vodGroups[body.kind] || null });
  }
  /* of the movies and shows a client remembers (Continue watching), the ones the adult lock is holding back right now */
  if (action === 'vod-held' && req.method === 'POST') {
    const body = await readBody(req);
    const out = { movie: [], show: [] };
    if (!ADULT_ON || !vod.supported(p)) return json(res, 200, out);
    for (const kind of ['movie', 'show']) {
      const c = await vod.catalog(p, kind), A = adultSets(req, user, p, kind, c.cats);
      if (!A.hide.size) continue;
      for (const id of (Array.isArray(body[kind]) ? body[kind] : []).map(String).slice(0, 500)) { const it = c.byId.get(id); if (it && A.hide.has(it.c)) out[kind].push(id); }
    }
    return json(res, 200, out);
  }
  if (action === 'groups' && req.method === 'PUT') {
    const body = await readBody(req);
    const cat = await getCatalog(p);
    const valid = new Set(cat.categories.map((c) => c.id));
    ps.groups = [...new Set((Array.isArray(body.groups) ? body.groups : []).map(String))].filter((g) => valid.has(g));
    saveState(st);
    const n = ps.groups.reduce((a, g) => a + (cat.byCat.get(g) ? cat.byCat.get(g).length : 0), 0);
    guideTouch(p, cat);
    return json(res, 200, { groups: ps.groups, channels: n });
  }
  if (action === 'customize' && req.method === 'POST') {
    const body = await readBody(req);
    const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).filter((x) => /^\d+$/.test(x)).slice(0, 8000);
    const cat = await getCatalog(p);
    if (body.op === 'hide') {
      ps.hidden = [...new Set(ps.hidden.concat(ids.filter((x) => cat.byId.has(x))))];
    } else if (body.op === 'show') {
      const gone = new Set(ids);
      ps.hidden = ps.hidden.filter((x) => !gone.has(x));
    } else if (body.op === 'order') {
      const cid = String(body.cat == null ? '' : body.cat);
      const inGroup = new Set((cat.byCat.get(cid) || []).map((c) => c.s));
      const keep = [...new Set(ids)].filter((x) => inGroup.has(x));
      if (keep.length) ps.order[cid] = keep; else delete ps.order[cid];
    } else if (body.op === 'reset') {
      delete ps.order[String(body.cat == null ? '' : body.cat)];
    } else if (body.op === 'favorites') {
      const have = new Set(ps.favorites);
      const wanted = [...new Set(ids)].filter((x) => have.has(x));
      const rest = ps.favorites.filter((x) => !wanted.includes(x));
      ps.favorites = wanted.concat(rest);
    } else return json(res, 400, { error: 'unknown change' });
    saveState(st);
    return json(res, 200, { ok: true, hidden: ps.hidden.length });
  }
  if (action === 'favorite' && req.method === 'POST') {
    const body = await readBody(req);
    const sid = String(body.s || '');
    if (!/^\d+$/.test(sid)) return json(res, 400, { error: 'bad stream id' });
    ps.favorites = ps.favorites.filter((x) => x !== sid);
    if (body.on) ps.favorites.unshift(sid);
    saveState(st);
    if (body.on) guideTouch(p, await getCatalog(p));
    return json(res, 200, { favorites: ps.favorites });
  }
  return json(res, 404, { error: 'unknown action' });
}

/* ---------- adult-content lock: status, unlock, lock, set PIN ---------- */
const waitText = (sec) => (sec >= 3600 ? `${Math.ceil(sec / 3600)} h` : sec >= 90 ? `${Math.ceil(sec / 60)} min` : `${sec} s`);
async function handleAdult(req, res, user, pn) {
  if (!user) return json(res, 400, { error: 'The content lock needs sign-in profiles.' });
  const dev = devKey(req), st = stateFor(user), key = 'pin|' + user.name;
  const view = () => ({ on: ADULT_ON, hasPin: !!st.data.pin, open: !ADULT_ON || unlocks.is(dev, user.name), wait: pinLock.wait(key), tv: !!user.tv, idleMinutes: Math.round(ADULT_IDLE / 60000) });
  if (pn === '/api/adult/status' && req.method === 'GET') return json(res, 200, view());
  if (req.method !== 'POST') return json(res, 405, { error: 'not allowed' });
  if (pn === '/api/adult/lock') { unlocks.lock(dev); return json(res, 200, view()); }
  if (pn === '/api/adult/ping') { unlocks.touch(dev, user.name); return json(res, 200, { open: !ADULT_ON || unlocks.is(dev, user.name) }); }
  const b = await readBody(req, 4096).catch(() => ({}));
  if (pn === '/api/adult/unlock') {
    if (!ADULT_ON) return json(res, 200, view());
    if (!st.data.pin) return json(res, 409, { error: user.tv ? 'No PIN is set yet. Set it from a phone or computer, in Settings.' : 'Set a PIN first.', needPin: true });
    const wait = pinLock.wait(key);
    if (wait) { res.setHeader('Retry-After', String(wait)); return json(res, 429, { error: `Too many wrong PINs. Try again in ${waitText(wait)}.`, wait }); }
    if (!adult.checkPin(st.data.pin, String(b.pin || ''))) {
      const w = pinLock.fail(key);
      console.log(`[zibbit] wrong content-lock PIN for ${user.name}${w ? `, locked out for ${waitText(w)}` : ''}`);
      if (w) { res.setHeader('Retry-After', String(w)); return json(res, 429, { error: `Too many wrong PINs. Try again in ${waitText(w)}.`, wait: w }); }
      return json(res, 403, { error: 'That PIN isn’t right.', left: pinLock.left(key) }); // 403, not 401: a wrong PIN is not a signed-out session
    }
    pinLock.ok(key); unlocks.unlock(dev, user.name);
    return json(res, 200, view());
  }
  if (pn === '/api/adult/pin') { // set or change the PIN: needs the account password
    if (user.tv) return json(res, 403, { error: 'Set the PIN from a phone or computer, not from a paired TV.' });
    const pin = String(b.pin || '');
    if (!adult.validPin(pin)) return json(res, 400, { error: 'The PIN is four digits.' });
    const ipk = `pw|${lockAddr(clientIp(req))}|${user.name.toLowerCase()}`, wait = lockedFor(ipk);
    if (wait) { res.setHeader('Retry-After', String(wait)); return json(res, 429, { error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} min.` }); }
    const got = await scryptAsync(String(b.password || '').slice(0, 200), user.salt);
    if (!crypto.timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(user.hash, 'hex'))) { noteFail(ipk, LOCK.user, LOCK.ms); return json(res, 403, { error: 'The password isn’t right.' }); }
    fails.delete(ipk);
    st.data.pin = adult.hashPin(pin); saveState(st);
    pinLock.clear(key); unlocks.unlock(dev, user.name);
    console.log(`[zibbit] ${user.name} set their content-lock PIN`);
    return json(res, 200, view());
  }
  return json(res, 404, { error: 'unknown action' });
}

/* ---------- v2: roles, password changes, admin API ---------- */
const isAdmin = (u) => !!u && u.role === 'admin' && !u.tv; // a paired TV is never an admin, even for an admin's profile
const writeJsonAtomic = (file, obj, mode = 0o600) => {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode });
  fs.renameSync(tmp, file);
};
const pwProblem = (pw, name, cur) => {
  pw = String(pw || '');
  if (pw.length < 8) return 'Use at least 8 characters.';
  if (pw.length > 200) return 'That password is too long.';
  if (name && pw.toLowerCase() === String(name).toLowerCase()) return 'The password can’t be the same as the name.';
  if (cur !== undefined && pw === cur) return 'Choose a new password, different from the current one.';
  if (/^(password|12345678|admin123|administrator)$/i.test(pw)) return 'That password is too easy to guess.';
  return '';
};
const goodName = (n) => typeof n === 'string' && n.trim() === n && n.length >= 1 && n.length <= 60 && !/[\x00-\x1f\x7f/\\]/.test(n);

/* IP addresses and ranges (IPv4 and IPv6) for the optional "admin settings only from these addresses" rule */
function ipParse(s) {
  s = String(s || '').trim().replace(/%.*$/, '');
  const m4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  if (m4) s = m4[1];
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) {
    const p = s.split('.').map(Number);
    if (p.some((x) => x > 255)) return null;
    return { v: 4, n: BigInt(((p[0] * 256 + p[1]) * 256 + p[2]) * 256 + p[3]) };
  }
  if (!s.includes(':') || !/^[0-9a-fA-F:]+$/.test(s)) return null;
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (halves.length === 2 && fill < 1) return null;
  const g = [...head, ...Array(fill).fill('0'), ...tail];
  if (g.length !== 8 || g.some((x) => !x || x.length > 4)) return null;
  let n = 0n;
  for (const x of g) n = (n << 16n) | BigInt(parseInt(x, 16));
  return { v: 6, n };
}
function cidrParse(s) {
  const [a, b] = String(s || '').trim().split('/');
  const ip = ipParse(a);
  if (!ip) return null;
  const max = ip.v === 4 ? 32 : 128;
  const bits = b === undefined ? max : /^\d{1,3}$/.test(b) ? +b : -1;
  return bits < 0 || bits > max ? null : { ...ip, bits };
}
const inCidr = (ip, c) => { if (ip.v !== c.v) return false; const sh = BigInt((ip.v === 4 ? 32 : 128) - c.bits); return (ip.n >> sh) === (c.n >> sh); };
const ALWAYS_OK = ['127.0.0.0/8', '::1/128', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7', 'fe80::/10'].map(cidrParse);
const adminRules = () => (Array.isArray(FILE_SETTINGS.adminAllow) ? FILE_SETTINGS.adminAllow : []).map(cidrParse).filter(Boolean);
function adminIpAllowed(ipStr, rules = adminRules()) {
  if (!rules.length) return true;
  const ip = ipParse(ipStr);
  if (!ip) return false;
  return ALWAYS_OK.some((c) => inCidr(ip, c)) || rules.some((c) => inCidr(ip, c));
}

function applySettings() {
  FILE_SETTINGS = readSettingsFile();
  TRUST_IP_HEADER = calcTrustHeader();
  LOCK = calcLock();
  EPG_CFG = buildEpgCfg();
  EPG_HOURS = calcEpgHours();
  EPG_NAME_MATCH = FILE_SETTINGS.epgNameMatch !== false;
  EPG_PROVIDER_FALLBACK = FILE_SETTINGS.epgProviderFallback === true;
  EAC3_FIX = FILE_SETTINGS.convertEac3Audio !== false;
  ADULT_ON = FILE_SETTINGS.adultLock === true;
  ADULT_MATCH = adult.wordMatcher(FILE_SETTINGS.adultWords);
  ADULT_IDLE = num(FILE_SETTINGS.adultIdleMinutes, 240, 15, 720) * 60000;
  REWIND_MAX = rewMin(FILE_SETTINGS.rewindMinutes);
  REWIND_GB = num(FILE_SETTINGS.rewindMaxGB, 10, 1, 2000);
  transcode.setBudget(REWIND_GB * 1e9);
  REC_HOURS = num(FILE_SETTINGS.recordMaxHours, 6, 1, 24);
  REC_FLOOR_GB = num(FILE_SETTINGS.recordFloorGB, 20, 1, 5000);
  recorder.setLimits({ maxSec: REC_HOURS * 3600, floorBytes: REC_FLOOR_GB * 1e9 });
  TRIM_RE = buildTrimRe();
  STRIP_SUP = calcStrip();
  nameMemo.clear();
}
function saveSettings(obj) { writeJsonAtomic(SETTINGS_FILE, mapEpg(obj, sealEpgValue)); applySettings(); }

const maskUrl = (u) => { try { const x = new URL(u); return x.origin + (x.pathname !== '/' ? x.pathname : '') + (x.search ? '?…' : ''); } catch { return ''; } };
const cleanErr = (e) => String((e && e.cause && e.cause.code) || (e && e.message) || e || 'failed').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').slice(0, 120);
const urlOk = (u) => { try { const x = new URL(u); return x.protocol === 'http:' || x.protocol === 'https:'; } catch { return false; } };

function readProviderEntries() {
  const raw = readJson(PROV_FILE);
  const list = Array.isArray(raw) ? raw : raw.providers;
  return (Array.isArray(list) ? list : []).filter((e) => e && provId(e.id)).map((e) => openEntry({ ...e, id: provId(e.id) }));
}
function saveProviderEntries(list) { writeJsonAtomic(PROV_FILE, { providers: list.map(sealEntry) }); loadProviders(); }
function dropProviderCaches(id) {
  catalogs.delete(id); catalogLoading.delete(id); guides.delete(id); limitCache.delete(id); tablo.forget(id);
  for (const f of [cacheFile(id), guideFile(id)]) { try { fs.unlinkSync(f); } catch { /* none saved */ } }
}
function setEpgFor(id, name, urls) {
  const s0 = readSettingsFile();
  const epg = s0.epg && typeof s0.epg === 'object' ? { ...s0.epg } : {};
  for (const k of Object.keys(epg)) {
    const kl = k.toLowerCase();
    if (kl === id || (kl === String(name).toLowerCase() && !providers.has(kl))) delete epg[k];
  }
  if (urls.length) epg[id] = urls;
  s0.epg = epg;
  saveSettings(s0);
  guides.delete(id);
}
/* ---------- server backup ----------
 * One encrypted file with everything that is a setting or a person's saved state: providers (logins included), people,
 * settings, guide links and each person's groups and favorites. It is opened with the recovery key, which is not in it.
 * Files are saved in the storage folder (the one mapped to /recordings), under zibbit-backups. */
const BK_DIR = () => path.join(recorder.BASE, 'zibbit-backups');
const BK_NAME = /^zibbit-(backup|auto|before-restore)-\d{8}-\d{6}\.zbk$/;
const BK_FILE_OK = /^(providers|users|settings|epgmap)\.json$|^state(-[a-z0-9_-]+)?\.json$/;
const stamp = (d = new Date()) => { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };
function collectBackup() {
  const files = {};
  let skipped = 0;
  const list = readProviderEntries().filter((e) => { if (e.locked) { skipped++; return false; } return true; }).map((e) => { const c = { ...e }; delete c.locked; return c; });
  if (fs.existsSync(PROV_FILE)) files['providers.json'] = JSON.stringify({ providers: list }, null, 2);
  if (fs.existsSync(SETTINGS_FILE)) files['settings.json'] = JSON.stringify(readSettingsFile(), null, 2);
  for (const name of fs.readdirSync(CONFIG_DIR)) {
    if (!BK_FILE_OK.test(name) || name in files) continue;
    try { files[name] = fs.readFileSync(path.join(CONFIG_DIR, name), 'utf8'); } catch { /* unreadable: left out */ }
  }
  return { files, skipped };
}
function packBackup(files) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', crypto.scryptSync(RK.text, salt, 32), iv);
  const data = Buffer.concat([c.update(JSON.stringify({ files }), 'utf8'), c.final()]);
  return { zibbit: 'backup', v: 1, created: new Date().toISOString(), app: VERSION, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}
function unpackBackup(b, keyText) {
  if (!b || typeof b !== 'object' || b.zibbit !== 'backup' || typeof b.data !== 'string') throw new Error('That isn’t a Zibbit backup file.');
  if (b.v !== 1) throw new Error('That backup was made by a newer version of Zibbit.');
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', crypto.scryptSync(rkNorm(keyText), Buffer.from(String(b.salt), 'base64'), 32), Buffer.from(String(b.iv), 'base64'));
    d.setAuthTag(Buffer.from(String(b.tag), 'base64'));
    const j = JSON.parse(Buffer.concat([d.update(Buffer.from(b.data, 'base64')), d.final()]).toString('utf8'));
    if (!j.files || typeof j.files !== 'object') throw new Error('shape');
    return j.files;
  } catch { throw new Error('That key doesn’t open this backup.'); }
}
function saveBackupFile(kind) {
  if (!recorder.available()) throw new Error('Backups are saved in the storage folder, and there isn’t one yet. Map a folder to /recordings first.');
  const { files, skipped } = collectBackup();
  const dir = BK_DIR();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `zibbit-${kind}-${stamp()}.zbk`;
  writeFileAtomic(path.join(dir, name), JSON.stringify(packBackup(files)));
  return { name, skipped };
}
function listBackups() {
  let names = [];
  try { names = fs.readdirSync(BK_DIR()); } catch { return []; }
  const out = [];
  for (const n of names) {
    const m = BK_NAME.exec(n);
    if (!m) continue;
    try { const st = fs.statSync(path.join(BK_DIR(), n)); out.push({ name: n, kind: m[1], size: st.size, at: Math.round(st.mtimeMs) }); } catch { /* gone */ }
  }
  return out.sort((a, b) => b.at - a.at);
}
function pruneBackups() { // the newest N automatic ones and the last 3 safety copies; ones saved by hand are never removed
  const keep = { auto: num(FILE_SETTINGS.backupKeep, 14, 1, 60), 'before-restore': 3 };
  const seen = {};
  for (const b of listBackups()) {
    if (!(b.kind in keep)) continue;
    seen[b.kind] = (seen[b.kind] || 0) + 1;
    if (seen[b.kind] > keep[b.kind]) { try { fs.unlinkSync(path.join(BK_DIR(), b.name)); } catch { /* leave it */ } }
  }
}
function autoBackup() {
  if (FILE_SETTINGS.backupAuto !== true || !recorder.available()) return;
  const last = listBackups().find((b) => b.kind === 'auto');
  if (last && Date.now() - last.at < 23 * 3600 * 1000) return;
  try { const r = saveBackupFile('auto'); pruneBackups(); console.log(`[zibbit] saved ${r.name} in the storage folder`); } catch (e) { console.error('[zibbit] automatic backup failed: ' + e.message); }
}
setTimeout(autoBackup, 90000).unref();
setInterval(autoBackup, 3600 * 1000).unref();
/* Puts a backup's files in place. Checked first, so a bad file changes nothing. A safety copy of what is there now is saved first. */
function applyBackup(files, ip) {
  const names = Object.keys(files);
  if (!names.length || names.length > 500 || names.some((n) => !BK_FILE_OK.test(n) || typeof files[n] !== 'string')) throw new Error('That backup holds files this version doesn’t recognise.');
  const parsed = {};
  for (const n of names) { try { parsed[n] = JSON.parse(files[n]); } catch { throw new Error(`${n} in the backup isn’t valid.`); } }
  const us = parsed['users.json'];
  if (!us || !Array.isArray(us.users) || !us.users.some((u) => u && u.role === 'admin' && u.salt && u.hash)) throw new Error('That backup has no admin account, so restoring it would lock everyone out.');
  if (parsed['providers.json'] && !Array.isArray(parsed['providers.json'].providers)) throw new Error('providers.json in the backup isn’t valid.');
  let before = '';
  if (recorder.available()) { try { before = saveBackupFile('before-restore').name; pruneBackups(); } catch { /* the restore goes ahead without it */ } }
  const oldIds = [...providers.keys()];
  const notes = [];
  for (const n of names) {
    if (n === 'providers.json') {
      writeJsonAtomic(PROV_FILE, { providers: parsed[n].providers.filter((e) => e && typeof e === 'object' && provId(e.id)).map((e) => sealEntry({ ...e, id: provId(e.id) })) });
    } else if (n === 'settings.json') {
      const st = parsed[n] && typeof parsed[n] === 'object' ? parsed[n] : {};
      if (Array.isArray(st.adminAllow) && st.adminAllow.length) {
        const rules = st.adminAllow.map(cidrParse).filter(Boolean);
        if (rules.length && !adminIpAllowed(ip, rules)) { delete st.adminAllow; notes.push('The backup limited Admin settings to addresses that don’t include yours, so that limit was left out.'); }
      }
      writeJsonAtomic(SETTINGS_FILE, mapEpg(st, sealEpgValue));
    } else writeFileAtomic(path.join(CONFIG_DIR, n), files[n]);
  }
  usersCache = { at: 0, list: [] };
  userStates.clear();
  applySettings();
  loadProviders();
  for (const id of new Set([...oldIds, ...providers.keys()])) dropProviderCaches(id);
  return { files: names.length, before, notes };
}
/* Asks for the signed-in person's password again. Sends the refusal itself and returns false when it isn't right. */
async function confirmPassword(req, res, user, b) {
  const ipk = `pw|${lockAddr(clientIp(req))}|${user.name.toLowerCase()}`, wait = lockedFor(ipk);
  if (wait) { json(res, 429, { error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} min.` }); return false; }
  const got = await scryptAsync(String(b.password || '').slice(0, 200), user.salt);
  if (!crypto.timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(user.hash, 'hex'))) { noteFail(ipk, LOCK.user, LOCK.ms); json(res, 403, { error: 'Your password isn’t right.', needPassword: true }); return false; }
  fails.delete(ipk);
  return true;
}
function providerView(e) {
  const p = e.locked ? {} : normProvider(e) || {};
  const type = ptype(e);
  return { id: e.id, name: String(e.name || e.id), type, locked: !!e.locked, url: e.locked && type === 'm3u' ? '' : type === 'm3u' ? maskUrl(e.url) : String(e.url || ''), username: !e.locked && (type === 'xtream' || type === 'tablo') ? String(e.username || '') : '', hasPassword: !e.locked && !!e.password, format: !isLocalHls(type) && e.format === 'ts' ? 'ts' : 'm3u8', epg: guideUrls({ id: e.id, name: e.name }) || [], live: providers.has(e.id), ok: !!p.id };
}
/* Turns what the form sent into a provider entry. Blank secrets keep what is already saved. */
function providerFromBody(b, old) {
  const type = b.type === 'm3u' || b.type === 'xtream' || b.type === 'hdhr' || b.type === 'tablo' ? b.type : ptype(old);
  const same = !!old && ptype(old) === type && !old.locked; // a login nothing can open is not carried over: it has to be typed again
  const name = String(b.name != null ? b.name : old ? old.name : '').trim();
  if (!name || name.length > 60) return { error: 'Give the provider a name (up to 60 characters).' };
  let url = String(b.url || '').trim();
  if (!url && same) url = String(old.url || '');
  if (type === 'hdhr' && url && !/^[a-z]+:\/\//i.test(url)) url = 'http://' + url; // "10.0.0.5" is enough for a tuner
  if (type === 'tablo' && url && !/^[a-z]+:\/\//i.test(url)) url = 'http://' + url; // the device address is optional: the account knows it
  if (!(type === 'tablo' && !url) && !urlOk(url)) return { error: 'Enter the full address, starting with http:// or https://' };
  const e = { id: old ? old.id : '', name, type, url: type === 'hdhr' || type === 'tablo' ? url.replace(/\/+$/, '') : url, format: !isLocalHls(type) && b.format === 'ts' ? 'ts' : 'm3u8' };
  if (type === 'tablo') {
    e.username = String(b.username || '').trim() || (same ? String(old.username || '') : '');
    e.password = b.password ? String(b.password) : same && old.password != null ? String(old.password) : '';
    if (!e.username) return { error: 'Enter the Tablo account email.' };
    if (!e.password) return { error: 'Enter the Tablo account password.' };
  }
  if (type === 'xtream') {
    e.url = url.replace(/\/+$/, '');
    e.username = String(b.username || '').trim() || (same ? String(old.username || '') : '');
    e.password = b.password ? String(b.password) : same && old.password != null ? String(old.password) : '';
    if (!e.username) return { error: 'Enter the username.' };
    if (!e.password) return { error: 'Enter the password.' };
  }
  let epg = null;
  if (Array.isArray(b.epg)) {
    epg = b.epg.map((x) => String(x || '').trim()).filter(Boolean);
    if (epg.length > 6) return { error: 'Use at most 6 guide addresses.' };
    if (epg.some((x) => x.length > 600 || !urlOk(x))) return { error: 'Each guide address must start with http:// or https://' };
  }
  return { entry: e, epg };
}
async function testProvider(e) {
  const p = normProvider(e);
  if (!p) return { ok: false, error: 'Fill in the address and login first.' };
  try {
    if (p.type === 'tablo') {
      tablo.forget(p.id);
      const got = await tablo.listChannels(p);
      try { const pr = await tablo.probe(p); console.log(`[zibbit] ${p.name}: Tablo signed check: ${JSON.stringify(pr)}`); } catch (e) { console.log(`[zibbit] ${p.name}: Tablo signed check failed: ${e.message}`); }
      return { ok: true, kind: 'tablo', model: got.device.name, channels: got.channels.length, address: got.device.url, ffmpeg: await transcode.available() };
    }
    if (p.type === 'hdhr') {
      const d = await hdhrGet(p.url, '/discover.json');
      const cat = await buildHdhrCatalog(p);
      const mpeg2 = cat.channels.filter((c) => /mpeg2/i.test(c.v)).length;
      return { ok: true, kind: 'hdhr', model: String(d.FriendlyName || d.ModelNumber || 'HDHomeRun'), tuners: parseInt(d.TunerCount, 10) || 0, channels: cat.channels.length, transcoded: cat.channels.length - cat.channels.filter((c) => /^(h264|avc)/i.test(c.v)).length, mpeg2, ffmpeg: await transcode.available() };
    }
    if (p.type === 'm3u') {
      const pl = await fetchM3u(p.url);
      const hls = pl.channels.filter((c) => /\.m3u8(\?|$)/i.test(c.u)).length;
      return { ok: true, kind: 'm3u', channels: pl.channels.length, groups: new Set(pl.channels.map((c) => c.c)).size, hlsChannels: hls, suggestFormat: pl.channels.length && hls * 2 >= pl.channels.length ? 'm3u8' : 'ts', guide: pl.guide && urlOk(pl.guide) ? pl.guide : '' };
    }
    const j = await xtream(p, '', {}, 15000);
    const ui = j && j.user_info;
    if (!ui) return { ok: false, error: 'The server answered, but not like an Xtream provider. Check the address.' };
    if (!(ui.auth === 1 || ui.auth === '1')) return { ok: false, error: 'The provider rejected the username or password.' };
    return { ok: true, kind: 'xtream', status: String(ui.status || ''), expires: +ui.exp_date || 0, maxConnections: parseInt(ui.max_connections, 10) || 0, activeConnections: parseInt(ui.active_cons, 10) || 0 };
  } catch (err) { return { ok: false, error: 'Could not connect: ' + cleanErr(err) }; }
}

async function handleAdmin(req, res, user, url) {
  const pn = url.pathname, method = req.method;
  if (!isAdmin(user)) return json(res, 403, { error: 'Admins only.' });
  const ip = clientIp(req);
  if (!adminIpAllowed(ip)) return json(res, 403, { error: 'Admin settings are limited to certain addresses, and this one is not on the list.', ip: ipLog(ip) });
  let m;

  /* people */
  if (pn === '/api/admin/users' && method === 'GET') {
    return json(res, 200, { users: getUsers(true).map((u) => ({ name: u.name, role: isAdmin(u) ? 'admin' : 'user', mustChange: !!u.mustChange, you: u.name === user.name, hasPin: !!stateFor(u).data.pin, pinWait: pinLock.wait('pin|' + u.name) })), adultLock: ADULT_ON });
  }
  if (pn === '/api/admin/users' && method === 'POST') {
    const b = await readBody(req, 8192);
    const name = String(b.name || '');
    if (!goodName(name)) return json(res, 400, { error: 'Use 1 to 60 characters for the name, with no slashes.' });
    if (getUsers(true).some((u) => u.name.toLowerCase() === name.toLowerCase())) return json(res, 409, { error: 'There is already someone with that name.' });
    const prob = pwProblem(b.password, name);
    if (prob) return json(res, 400, { error: prob });
    await setUserPassword(name, String(b.password), false, { role: b.role === 'admin' ? 'admin' : 'user', mustChange: b.mustChange !== false });
    console.log(`[zibbit] ${user.name} added ${b.role === 'admin' ? 'admin' : 'user'} ${name}`);
    return json(res, 200, { ok: true });
  }
  if ((m = pn.match(/^\/api\/admin\/users\/([^/]+)\/pin$/))) {
    if (method !== 'POST') return json(res, 405, { error: 'POST only' });
    let name;
    try { name = decodeURIComponent(m[1]); } catch { return json(res, 400, { error: 'bad name' }); }
    const target = getUsers(true).find((u) => u.name.toLowerCase() === name.toLowerCase());
    if (!target) return json(res, 404, { error: 'No such person.' });
    const b = await readBody(req, 4096);
    if (target.name === user.name && !(await confirmPassword(req, res, user, b))) return; // your own: the password, so someone using your signed-in screen can't clear it for you
    const tst = stateFor(target);
    pinLock.clear('pin|' + target.name);
    if (b.action === 'clear') { console.log(`[zibbit] ${user.name} cleared the PIN lockout for ${target.name}`); return json(res, 200, { ok: true }); }
    delete tst.data.pin; saveState(tst); unlocks.lockUser(target.name);
    console.log(`[zibbit] ${user.name} reset the content-lock PIN for ${target.name}`);
    return json(res, 200, { ok: true });
  }
  if (pn === '/api/admin/adult/groups') {
    if (method === 'GET') {
      const p = providers.get(String(url.searchParams.get('p') || ''));
      if (!p) return json(res, 404, { error: 'No such provider.' });
      const marks = marksFor(p.id), out = { live: [], movie: [], show: [] };
      const row = (kind, c) => ({ id: c.id, name: c.name, count: c.count || 0, locked: isAdultGroup(p.id, kind, c), auto: !!ADULT_MATCH(c.name), mark: kind + ':' + c.id in marks ? marks[kind + ':' + c.id] : null });
      try { out.live = (await getCatalog(p)).categories.map((c) => row('live', c)); } catch { out.liveError = 'could not load'; }
      if (vod.supported(p)) for (const kind of ['movie', 'show']) { try { out[kind] = (await vod.catalog(p, kind)).cats.map((c) => row(kind, c)); } catch { out[kind + 'Error'] = 'could not load'; } }
      return json(res, 200, out);
    }
    if (method === 'PUT') {
      const b = await readBody(req, 8192);
      const p = providers.get(String(b.p || ''));
      if (!p || !['live', 'movie', 'show'].includes(b.kind) || typeof b.id !== 'string' || b.id.length > 200) return json(res, 400, { error: 'unknown group' });
      const s0 = readSettingsFile();
      s0.adultMarks = s0.adultMarks && typeof s0.adultMarks === 'object' ? s0.adultMarks : {};
      const mk = (s0.adultMarks[p.id] = s0.adultMarks[p.id] || {}), k = b.kind + ':' + b.id;
      if (b.locked === true || b.locked === false) mk[k] = b.locked; else delete mk[k]; // null: go back to deciding by name
      if (!Object.keys(mk).length) delete s0.adultMarks[p.id];
      saveSettings(s0);
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: 'not allowed' });
  }
  if ((m = pn.match(/^\/api\/admin\/users\/([^/]+)(\/password)?$/))) {
    let name;
    try { name = decodeURIComponent(m[1]); } catch { return json(res, 400, { error: 'bad name' }); }
    const users = getUsers(true).slice();
    const i = users.findIndex((u) => u.name.toLowerCase() === name.toLowerCase());
    if (i < 0) return json(res, 404, { error: 'No such person.' });
    const target = users[i];
    const admins = users.filter(isAdmin).length;
    if (m[2]) {
      if (method !== 'POST') return json(res, 405, { error: 'POST only' });
      if (target.name === user.name) return json(res, 400, { error: 'Use "Change password" in Settings for your own account.' });
      const b = await readBody(req, 8192);
      const prob = pwProblem(b.password, target.name);
      if (prob) return json(res, 400, { error: prob });
      await setUserPassword(target.name, String(b.password), true, { mustChange: b.mustChange !== false });
      console.log(`[zibbit] ${user.name} set a new password for ${target.name}`);
      return json(res, 200, { ok: true });
    }
    if (method === 'PUT') {
      const b = await readBody(req, 4096);
      const role = b.role === 'admin' ? 'admin' : 'user';
      if (role !== 'admin' && isAdmin(target) && admins <= 1) return json(res, 400, { error: 'There must be at least one admin.' });
      users[i] = { ...target, role };
      writeUsers(users);
      console.log(`[zibbit] ${user.name} made ${target.name} ${role === 'admin' ? 'an admin' : 'a regular user'}`);
      return json(res, 200, { ok: true });
    }
    if (method === 'DELETE') {
      if (target.name === user.name) return json(res, 400, { error: 'You can’t remove the account you’re signed in with.' });
      if (isAdmin(target) && admins <= 1) return json(res, 400, { error: 'There must be at least one admin.' });
      writeUsers(users.filter((u) => u !== target));
      stopSessions((x) => x.u === target.name);
      console.log(`[zibbit] ${user.name} removed ${target.name}`);
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: 'not allowed' });
  }

  /* providers */
  if (pn === '/api/admin/providers' && method === 'GET') return json(res, 200, { providers: readProviderEntries().map(providerView) });
  if (pn === '/api/admin/providers/test' && method === 'POST') {
    const b = await readBody(req, 16384);
    const old = b.id ? readProviderEntries().find((e) => e.id === provId(b.id)) : null;
    const r = providerFromBody(b, old);
    if (r.error) return json(res, 200, { ok: false, error: r.error });
    r.entry.id = r.entry.id || 'test';
    return json(res, 200, await testProvider(r.entry));
  }
  if (pn === '/api/admin/providers' && method === 'POST') {
    const b = await readBody(req, 16384);
    const r = providerFromBody(b, null);
    if (r.error) return json(res, 400, { error: r.error });
    const list = readProviderEntries();
    const base = provId(r.entry.name.toLowerCase().replace(/\s+/g, '-')) || 'provider';
    let id = base, n = 2;
    while (list.some((e) => e.id === id)) id = `${base}-${n++}`;
    r.entry.id = id;
    list.push(r.entry);
    saveProviderEntries(list);
    if (r.epg) setEpgFor(id, r.entry.name, r.epg);
    console.log(`[zibbit] ${user.name} added provider ${r.entry.name}`);
    return json(res, 200, { ok: true, id, providers: readProviderEntries().map(providerView) });
  }
  if ((m = pn.match(/^\/api\/admin\/providers\/([a-z0-9_-]+)$/))) {
    const list = readProviderEntries();
    const i = list.findIndex((e) => e.id === m[1]);
    if (i < 0) return json(res, 404, { error: 'No such provider.' });
    const old = list[i];
    if (method === 'PUT') {
      const r = providerFromBody(await readBody(req, 16384), old);
      if (r.error) return json(res, 400, { error: r.error });
      const keep = { ...old, ...r.entry, id: old.id };
      delete keep.locked;
      if (r.entry.type !== 'xtream' && r.entry.type !== 'tablo') { delete keep.username; delete keep.password; }
      const sameSource = ptype(old) === r.entry.type && old.url === keep.url && (old.username || '') === (keep.username || '') && (old.password || '') === (keep.password || '');
      list[i] = keep;
      saveProviderEntries(list);
      if (!sameSource) dropProviderCaches(old.id);
      if (r.epg) setEpgFor(old.id, keep.name, r.epg);
      console.log(`[zibbit] ${user.name} changed provider ${keep.name}`);
      return json(res, 200, { ok: true, providers: readProviderEntries().map(providerView) });
    }
    if (method === 'DELETE') {
      list.splice(i, 1);
      saveProviderEntries(list);
      dropProviderCaches(old.id);
      setEpgFor(old.id, old.name, []);
      console.log(`[zibbit] ${user.name} removed provider ${old.name || old.id}`);
      return json(res, 200, { ok: true, providers: readProviderEntries().map(providerView) });
    }
    return json(res, 405, { error: 'not allowed' });
  }

  /* recovery key and server backups */
  if (pn === '/api/admin/backup' && method === 'GET') {
    let lockedProviders = 0, lockedGuides = 0;
    for (const e of readProviderEntries()) if (e.locked) lockedProviders++;
    for (const v of Object.values(readSettingsFile().epg || {})) for (const x of Array.isArray(v) ? v : [v]) if (typeof x === 'string' && x.startsWith(CRED_PREFIX)) lockedGuides++;
    return json(res, 200, { source: RK.source, problem: RK.problem, locked: { providers: lockedProviders, guides: lockedGuides }, ready: recorder.available(), folder: 'zibbit-backups', files: listBackups(), auto: FILE_SETTINGS.backupAuto === true, keep: num(FILE_SETTINGS.backupKeep, 14, 1, 60) });
  }
  if (pn === '/api/admin/backup/key' && method === 'POST') {
    const b = await readBody(req, 4096);
    if (!(await confirmPassword(req, res, user, b))) return;
    console.log(`[zibbit] ${user.name} viewed the recovery key`);
    return json(res, 200, { ok: true, key: rkShow(RK.text), source: RK.source });
  }
  if (pn === '/api/admin/backup/save' && method === 'POST') {
    try { const r = saveBackupFile('backup'); console.log(`[zibbit] ${user.name} saved ${r.name} in the storage folder`); return json(res, 200, { ok: true, name: r.name, skipped: r.skipped, files: listBackups() }); } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (pn === '/api/admin/backup/download' && method === 'POST') {
    const { files, skipped } = collectBackup();
    console.log(`[zibbit] ${user.name} downloaded a backup`);
    return json(res, 200, { ok: true, name: `zibbit-backup-${stamp()}.zbk`, backup: packBackup(files), skipped });
  }
  if (pn === '/api/admin/backup/restore' && method === 'POST') {
    const b = await readBody(req, 40 * 1024 * 1024);
    if (!(await confirmPassword(req, res, user, b))) return;
    const kk = `rk|${lockAddr(clientIp(req))}|${user.name.toLowerCase()}`, wait = lockedFor(kk);
    if (wait) return json(res, 429, { error: `Too many wrong keys. Try again in ${Math.ceil(wait / 60)} min.` });
    let obj = b.backup;
    if (typeof b.file === 'string') {
      if (!BK_NAME.test(b.file)) return json(res, 400, { error: 'Pick one of the saved backups.' });
      try { obj = JSON.parse(fs.readFileSync(path.join(BK_DIR(), b.file), 'utf8')); } catch { return json(res, 404, { error: 'That backup isn’t in the storage folder any more.' }); }
    }
    let files;
    try { files = unpackBackup(obj, b.key); } catch (e) { if (/key/.test(e.message)) noteFail(kk, LOCK.user, LOCK.ms); return json(res, 400, { error: e.message }); }
    fails.delete(kk);
    try {
      const r = applyBackup(files, ip);
      console.log(`[zibbit] ${user.name} restored a backup (${r.files} files)${r.before ? `; what was here before is saved as ${r.before}` : ''}`);
      return json(res, 200, { ok: true, files: r.files, before: r.before, notes: r.notes });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  /* names, guide and security settings */
  if (pn === '/api/admin/settings' && method === 'GET') {
    const f = FILE_SETTINGS;
    const rawTrim = f.trimFromNames != null ? f.trimFromNames : '';
    return json(res, 200, {
      trimFromNames: (Array.isArray(rawTrim) ? rawTrim : String(rawTrim).split(',')).map((x) => String(x).trim()).filter(Boolean),
      stripSuperscripts: calcStrip(),
      epgNameMatch: f.epgNameMatch !== false,
      epgProviderFallback: f.epgProviderFallback === true,
      convertEac3Audio: f.convertEac3Audio !== false,
      adultLock: ADULT_ON,
      adultWords: f.adultWords != null ? String(f.adultWords) : adult.DEFAULT_WORDS,
      adultIdleMinutes: Math.round(ADULT_IDLE / 60000),
      rewindMinutes: REWIND_MAX, rewindMaxGB: REWIND_GB, rewindFolder: transcode.ROOT, rewindFreeGB: Math.round(Math.min(transcode.freeBytes(), 1e15) / 1e8) / 10,
      recordMaxHours: REC_HOURS, recordFloorGB: REC_FLOOR_GB, recordFolder: recorder.BASE, recordReady: recorder.available(), recordFreeGB: Math.round(Math.min(recorder.freeBytes(), 1e15) / 1e8) / 10,
      youHavePin: !!stateFor(user).data.pin,
      epgRefreshHours: calcEpgHours(),
      trustIpHeader: String(f.trustIpHeader || ''),
      trustIpHeaderLockedByEnv: !!process.env.TRUST_IP_HEADER,
      lockUserFails: LOCK.user, lockIpFails: LOCK.ip, lockMinutes: Math.round(LOCK.ms / 60000),
      adminAllow: (Array.isArray(f.adminAllow) ? f.adminAllow : []).map(String),
      you: ipLog(ip)
    });
  }
  if (pn === '/api/admin/settings' && method === 'PUT') {
    const b = await readBody(req, 65536);
    const s0 = readSettingsFile();
    let warning = '';
    if ('trimFromNames' in b) {
      const list = (Array.isArray(b.trimFromNames) ? b.trimFromNames : String(b.trimFromNames || '').split(/[,\n]/)).map((x) => String(x).trim()).filter(Boolean);
      if (list.join(',').length > 8000) return json(res, 400, { error: 'That list is too long.' });
      s0.trimFromNames = list.join(',');
    }
    if ('stripSuperscripts' in b) s0.stripSuperscripts = !!b.stripSuperscripts;
    if ('epgNameMatch' in b) s0.epgNameMatch = !!b.epgNameMatch;
    if ('epgProviderFallback' in b) s0.epgProviderFallback = !!b.epgProviderFallback;
    if ('convertEac3Audio' in b) s0.convertEac3Audio = !!b.convertEac3Audio;
    if ('adultLock' in b && !!b.adultLock !== (s0.adultLock === true)) {
      const mine = stateFor(user);
      if (b.adultLock) { if (!mine.data.pin) return json(res, 400, { error: 'Set your own PIN first.', needPin: true }); s0.adultLock = true; }
      else { // turning it off takes your PIN
        const key = 'pin|' + user.name, wait = pinLock.wait(key);
        if (wait) return json(res, 429, { error: `Too many wrong PINs. Try again in ${waitText(wait)}.`, wait });
        if (!adult.checkPin(mine.data.pin, String(b.adultPin || ''))) { const w = pinLock.fail(key); return json(res, w ? 429 : 403, { error: w ? `Too many wrong PINs. Try again in ${waitText(w)}.` : 'That PIN isn’t right.', needPin: true }); }
        pinLock.ok(key); s0.adultLock = false;
      }
    }
    if ('adultWords' in b) { const w = String(b.adultWords || '').slice(0, 2000); s0.adultWords = w; }
    if ('adultIdleMinutes' in b) s0.adultIdleMinutes = num(b.adultIdleMinutes, 240, 15, 720);
    if ('rewindMinutes' in b) s0.rewindMinutes = rewMin(b.rewindMinutes);
    if ('rewindMaxGB' in b) s0.rewindMaxGB = num(b.rewindMaxGB, 10, 1, 2000);
    if ('recordMaxHours' in b) s0.recordMaxHours = num(b.recordMaxHours, 6, 1, 24);
    if ('recordFloorGB' in b) s0.recordFloorGB = num(b.recordFloorGB, 20, 1, 5000);
    if ('epgRefreshHours' in b) s0.epgRefreshHours = num(b.epgRefreshHours, 12, 1, 168);
    if ('backupAuto' in b) s0.backupAuto = !!b.backupAuto;
    if ('backupKeep' in b) s0.backupKeep = num(b.backupKeep, 14, 1, 60);
    if ('lockUserFails' in b) s0.lockUserFails = num(b.lockUserFails, 5, 1, 100);
    if ('lockIpFails' in b) s0.lockIpFails = num(b.lockIpFails, 20, 1, 1000);
    if ('lockMinutes' in b) s0.lockMinutes = num(b.lockMinutes, 10, 1, 1440);
    if ('trustIpHeader' in b && !process.env.TRUST_IP_HEADER) {
      const h = String(b.trustIpHeader || '').trim().toLowerCase();
      if (!/^[a-z0-9-]{0,60}$/.test(h)) return json(res, 400, { error: 'A header name uses letters, numbers and dashes only.' });
      if (h) s0.trustIpHeader = h; else delete s0.trustIpHeader;
    }
    if ('adminAllow' in b) {
      const raw = (Array.isArray(b.adminAllow) ? b.adminAllow : String(b.adminAllow || '').split(/[,\n]/)).map((x) => String(x).trim()).filter(Boolean);
      if (raw.length > 50) return json(res, 400, { error: 'Use at most 50 address rules.' });
      const rules = [];
      for (let k = 0; k < raw.length; k++) {
        const c = cidrParse(raw[k]);
        if (!c) return json(res, 400, { error: `Line ${k + 1} isn’t a valid address or range. Use an address like 203.0.113.7 or a range like 203.0.113.0/24.` });
        rules.push(c);
      }
      if (rules.length && !adminIpAllowed(ip, rules)) return json(res, 400, { error: `That rule would block the address you’re using right now (${ipLog(ip)}), so it wasn’t saved. Add a range that includes it.` });
      if (rules.length) {
        const v4 = rules.some((c) => c.v === 4), v6 = rules.some((c) => c.v === 6);
        if (!(v4 && v6)) warning = `Your rules only cover IPv${v4 ? 4 : 6}. From outside your home network, a connection over IPv${v4 ? 6 : 4} will be refused. Home network addresses are always allowed.`;
      }
      if (raw.length) s0.adminAllow = raw; else delete s0.adminAllow;
    }
    saveSettings(s0);
    console.log(`[zibbit] ${user.name} saved settings`);
    return json(res, 200, { ok: true, warning });
  }
  return json(res, 404, { error: 'not found' });
}

async function handleLogin(req, res) {
  if (!csrfOk(req)) return json(res, 403, { error: 'Request not allowed' });
  const b = await readBody(req, 4096).catch(() => ({}));
  const name = String(b.name || '').trim().slice(0, 60);
  const pw = String(b.password || '').slice(0, 200);
  const ip = clientIp(req);
  const lk = lockAddr(ip);
  const k1 = `${lk}|${name.toLowerCase()}`;
  const k2 = `ip|${lk}`;
  /* The two counts above are per address. Someone guessing from many addresses at once (or from an address the front door lets them
   * choose) would never trip them, so each account also has a count across all addresses, set well above what a person typing could
   * reach: four times the per-address limit. It trades a little availability, since a flood of wrong guesses locks that name out for
   * everyone for the lockout time, for a hard limit on how fast any one password can be searched for. */
  const k3 = `acct|${name.toLowerCase()}`;
  const wait = Math.max(lockedFor(k1), lockedFor(k2), lockedFor(k3));
  if (wait) {
    if (!blockLogged.has(lk) || Date.now() - blockLogged.get(lk) > 60000) { blockLogged.set(lk, Date.now()); if (blockLogged.size > 500) blockLogged.delete(blockLogged.keys().next().value); console.log(`[zibbit] sign-in blocked from ${ipLog(ip)}, ${Math.ceil(wait / 60)} min left`); }
    res.setHeader('Retry-After', String(wait));
    return json(res, 429, { error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} min.` });
  }
  const u = getUsers(true).find((x) => x.name.toLowerCase() === name.toLowerCase());
  const got = await scryptAsync(pw, u ? u.salt : DUMMY_SALT); // same work whether or not the name exists
  const ok = !!u && crypto.timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(u.hash, 'hex'));
  if (!ok) {
    noteFail(k1, LOCK.user, LOCK.ms);
    noteFail(k2, LOCK.ip, LOCK.ms);
    if (u) noteFail(k3, LOCK.user * 4, LOCK.ms); // only names that exist: made-up names cannot fill the table or lock anyone out
    console.log(`[zibbit] sign-in failed ${u ? 'for ' + u.name : '(name not on file)'} from ${ipLog(ip)}`); // never the typed name or password
    return json(res, 401, { error: 'Wrong name or password.' });
  }
  fails.delete(k1); fails.delete(k3);
  console.log(`[zibbit] signed in: ${u.name} from ${ipLog(ip)}`);
  res.setHeader('Set-Cookie', cookieHeader(req, makeSession(u), SESSION_DAYS * 86400));
  return json(res, 200, { name: u.name });
}

/* ---------- pairing a TV ----------
 * The TV asks for a short code, shows it (and a QR code), and polls. Someone already signed in on a phone opens /pair, types
 * or scans the code and approves; the TV's next poll receives a session cookie, once. A paired TV has fewer rights than the
 * profile that approved it: it cannot administer, change a password or approve other TVs. Codes expire, are single use, and
 * wrong guesses are counted per profile and per address, so they cannot be searched for. */
const PAIR_TTL = Math.max(2, +process.env.PAIR_TTL_SECONDS || 300) * 1000;
const PAIR_ALPHA = 'BCDFGHJKLMNPQRSTVWXZ23456789'; // no vowels (no words) and nothing that looks like 0, 1, I or O
const pairings = new Map(); // device secret -> { code, user, label, from, at, polled }
const pairCodes = new Map(); // code -> device secret
const pairClean = (c) => String(c || '').toUpperCase().split('').filter((ch) => PAIR_ALPHA.includes(ch)).join('').slice(0, 8);
const pairShow = (c) => c.slice(0, 4) + '-' + c.slice(4);
function pairPurge() {
  const now = Date.now();
  for (const [dev, r] of pairings) if (now - r.at > PAIR_TTL) { pairings.delete(dev); pairCodes.delete(r.code); }
}
function pairOrigin(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const https = /(^|,)\s*https\s*(,|$)/.test(String(req.headers['x-forwarded-proto'] || '')) || /"scheme"\s*:\s*"https"/.test(String(req.headers['cf-visitor'] || ''));
  return host && /^[A-Za-z0-9.\-\[\]:]+$/.test(host) ? `${https ? 'https' : 'http'}://${host}` : '';
}
async function handlePairStart(req, res) {
  if (!csrfOk(req)) return json(res, 403, { error: 'Request not allowed' });
  const ip = lockAddr(clientIp(req)), key = `pairstart|${ip}`;
  const wait = lockedFor(key);
  if (wait) { res.setHeader('Retry-After', String(wait)); return json(res, 429, { error: 'Too many codes asked for. Try again later.' }); }
  noteFail(key, 12, 10 * 60000); // every request counts: a TV needs one now and then
  pairPurge();
  if (pairings.size >= 300) return json(res, 429, { error: 'Too many TVs are waiting to be paired. Try again in a few minutes.' });
  let code;
  do { code = Array.from({ length: 8 }, () => PAIR_ALPHA[crypto.randomInt(PAIR_ALPHA.length)]).join(''); } while (pairCodes.has(code));
  const device = crypto.randomBytes(32).toString('base64url');
  const b = await readBody(req, 1024).catch(() => ({}));
  pairings.set(device, { code, user: '', label: String(b.label || 'a TV').replace(/[^\w .\-]/g, '').slice(0, 40) || 'a TV', from: ip, at: Date.now(), polled: 0 });
  pairCodes.set(code, device);
  const origin = pairOrigin(req);
  return json(res, 200, { device, code: pairShow(code), url: origin ? origin + '/pair' : '', link: origin ? `${origin}/pair?code=${code}` : '', expiresIn: Math.round(PAIR_TTL / 1000), interval: 3 });
}
async function handlePairPoll(req, res) {
  if (!csrfOk(req)) return json(res, 403, { error: 'Request not allowed' });
  const b = await readBody(req, 1024).catch(() => ({}));
  const dev = String(b.device || ''), r = pairings.get(dev);
  if (!r || Date.now() - r.at > PAIR_TTL) { if (r) { pairings.delete(dev); pairCodes.delete(r.code); } return json(res, 200, { status: 'expired' }); }
  if (Date.now() - r.polled < 1500) return json(res, 429, { status: 'slow_down' });
  r.polled = Date.now();
  if (!r.user) return json(res, 200, { status: 'pending' });
  pairings.delete(dev); pairCodes.delete(r.code); // single use
  const u = getUsers(true).find((x) => x.name === r.user);
  if (!u) return json(res, 200, { status: 'expired' });
  console.log(`[zibbit] TV paired: ${u.name} (${r.label}) from ${ipLog(clientIp(req))}`);
  const tok = makeSession(u, { tv: true });
  res.setHeader('Set-Cookie', cookieHeader(req, tok, SESSION_DAYS * 86400));
  return json(res, 200, { status: 'approved', name: u.name, token: tok }); // the TV keeps the token so it can offer this profile on its start screen
}
/* a TV that holds several paired profiles switches between them by presenting a token it was given when paired.
 * Only TV tokens are accepted here, so this can never hand out the rights of a full sign-in. */
async function handleTvSwitch(req, res) {
  if (!csrfOk(req)) return json(res, 403, { error: 'Request not allowed' });
  const key = `tvswitch|${lockAddr(clientIp(req))}`;
  const wait = lockedFor(key);
  if (wait) { res.setHeader('Retry-After', String(wait)); return json(res, 429, { error: 'Too many attempts. Try again later.' }); }
  const b = await readBody(req, 2048).catch(() => ({}));
  const u = parseSession(String(b.token || ''));
  if (!u || !u.tv) { noteFail(key, 20, 10 * 60000); return json(res, 401, { error: 'Signed out' }); }
  const tok = makeSession(u, { tv: true });
  res.setHeader('Set-Cookie', cookieHeader(req, tok, SESSION_DAYS * 86400));
  return json(res, 200, { name: u.name, token: tok });
}
/* looks the code up (a signed-in person, from /pair); with approve:true it also approves it */
async function handlePairApprove(req, res, user, approve) {
  if (!csrfOk(req)) return json(res, 403, { error: 'Request not allowed' });
  if (user.tv) return json(res, 403, { error: 'A TV cannot approve other TVs.' });
  const ip = lockAddr(clientIp(req)), kU = `pairtry|u|${user.name.toLowerCase()}`, kI = `pairtry|ip|${ip}`;
  const wait = Math.max(lockedFor(kU), lockedFor(kI));
  if (wait) { res.setHeader('Retry-After', String(wait)); return json(res, 429, { error: `Too many wrong codes. Try again in ${Math.ceil(wait / 60)} min.` }); }
  const b = await readBody(req, 1024).catch(() => ({}));
  const code = pairClean(b.code);
  pairPurge();
  const dev = code.length === 8 ? pairCodes.get(code) : null, r = dev && pairings.get(dev);
  if (!r || r.user) {
    noteFail(kU, 8, 10 * 60000); noteFail(kI, 20, 10 * 60000);
    return json(res, 404, { error: 'That code is not valid, or it has expired. Check the code on the TV.' });
  }
  if (!approve) return json(res, 200, { label: r.label, seconds: Math.round((Date.now() - r.at) / 1000), sameNetwork: r.from === ip });
  r.user = user.name;
  console.log(`[zibbit] ${user.name} approved a TV (${r.label}), ${r.from === ip ? 'same network' : 'different network'}`);
  return json(res, 200, { ok: true });
}

const cleanCid = (c) => (/^[A-Za-z0-9_-]{1,40}$/.test(String(c || '')) ? String(c) : '');

/* a local file with range support (a recording the player seeks in) */
function serveFileRange(req, res, file, type, saveAs) {
  let size;
  try { size = fs.statSync(file).size; } catch { res.writeHead(404); return res.end('gone'); }
  let start = 0, end = size - 1, code = 200;
  const r = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
  if (r && (r[1] || r[2])) {
    if (r[1]) { start = +r[1]; if (r[2]) end = Math.min(end, +r[2]); } else start = Math.max(0, size - +r[2]);
    if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    code = 206;
  }
  const h = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'private, no-store' };
  if (saveAs) h['Content-Disposition'] = `attachment; filename="${saveAs.replace(/[^\w .()&'+,-]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(saveAs)}`;
  if (code === 206) h['Content-Range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(code, h);
  if (req.method === 'HEAD') return res.end();
  const s = fs.createReadStream(file, { start, end });
  s.on('error', () => res.destroy());
  res.on('close', () => s.destroy());
  s.pipe(res);
}

async function route(req, res) {
  secHeaders(req, res);
  const url = new URL(req.url, 'http://x');
  const pn = url.pathname;
  const mode = authMode();
  let user = null; // the signed-in profile, when there are profiles
  // what a phone needs to offer "Add to Home Screen": the manifest and icons are not private, and browsers fetch them without sign-in
  if ((req.method === 'GET' || req.method === 'HEAD') && /^\/(manifest\.webmanifest|icons\/[A-Za-z0-9_-]+\.png)$/.test(pn)) return serveStatic(req, res, pn);
  // the app checks for updates before anyone has signed in, and the file is the same one published for everybody
  if (req.method === 'GET' && (pn === '/app/latest.json' || pn === '/app/Zibbit.apk')) return appUpdateRoute(req, res, pn);
  /* the rewind buffer's ffmpeg reads the provider's stream through here, so the server's own checks (no private addresses, playlists rewritten) still apply
   * to it. Only this machine may ask, and only with an address the server itself sealed. */
  if (pn.startsWith('/__ingest/')) {
    const ra = req.socket.remoteAddress || '';
    const t = req.method === 'GET' && /^(::ffff:)?127\.0\.0\.1$|^::1$/.test(ra) && !req.headers['x-forwarded-for'] && !req.headers.forwarded ? unseal(pn.slice(10).replace(/\.[a-z0-9]{1,5}$/, '')) : null;
    if (!t || t.k !== 'ingest' || !/^https?:\/\//i.test(t.u || '')) { res.writeHead(404); return res.end('not found'); }
    return pipeUpstream(req, res, t.u, { p: t.p, s: t.s, k: 'ingest' });
  }
  if (mode === 'basic') {
    if (!authOk(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="zibbit"' });
      return res.end('authentication required');
    }
  } else if (mode === 'users') {
    if (pn === '/api/login' && req.method === 'POST') return handleLogin(req, res);
    if (pn === '/api/pair/start' && req.method === 'POST') return handlePairStart(req, res);
    if (pn === '/api/pair/poll' && req.method === 'POST') return handlePairPoll(req, res);
    if (pn === '/api/tv/switch' && req.method === 'POST') return handleTvSwitch(req, res);
    if ((req.method === 'GET' || req.method === 'HEAD') && /^\/(tv|tv\.html|qrcode\.js)$/.test(pn)) return serveStatic(req, res, pn); // the TV page holds nothing private; it asks to be paired
    user = readSession(req);
    if (!user) {
      const read = req.method === 'GET' || req.method === 'HEAD';
      if (read && pn === '/login.html') return serveStatic(req, res, pn);
      if (read && !/^\/(api|live|x)\//.test(pn)) { res.writeHead(302, { Location: pn === '/pair' ? '/login.html?next=' + encodeURIComponent('/pair' + url.search) : '/login.html' }); return res.end(); }
      return json(res, 401, { error: 'Sign in required' });
    }
    if (!csrfOk(req)) return json(res, 403, { error: 'Request not allowed' });
    // a temporary or default password must be replaced before anything else works
    if (user.mustChange && !(pn === '/api/me' || pn === '/api/logout' || pn === '/api/password' || (!pn.startsWith('/api/') && !/^\/(live|x)\//.test(pn)))) {
      return json(res, 403, { error: 'Choose a new password first.', mustChange: true });
    }
  }
  const uname = user ? user.name : '';
  const st = stateFor(user);
  if (ADULT_ON && user && /^\/(live|vod)\//.test(pn)) unlocks.touch(devKey(req), user.name); // watching counts as being there

  /* sealed upstream URLs: stream segments, nested playlists, icons */
  let m = pn.match(/^\/x\/([A-Za-z0-9_-]+)$/);
  if (m) {
    const t = unseal(m[1]);
    if (!t || !t.u || !/^https?:\/\//i.test(t.u)) { res.writeHead(400); return res.end('bad token'); }
    if (t.s && evicted.has([uname, t.c || '', t.p].join('|'))) return json(res, 410, { error: 'taken over' });
    if (ADULT_ON && user && t.k !== 'icon') unlocks.touch(devKey(req), user.name);
    return pipeUpstream(req, res, t.u, { p: t.p, s: t.s, k: t.k, c: t.c, u: uname });
  }

  /* movie and episode files, passed through with range requests so the player can seek */
  m = pn.match(/^\/vod\/([a-z0-9_-]+)\/(movie|show)\/(\d+)\.([a-z0-9]{2,5})$/);
  if (m) {
    const p = providers.get(m[1]);
    if (!p || !vod.supported(p)) { res.writeHead(404); return res.end('unknown provider'); }
    if (ADULT_ON && user) {
      const c0 = await vod.catalog(p, m[2]), A = adultSets(req, user, p, m[2], c0.cats);
      if (A.hide.size) {
        const cat = m[2] === 'movie' ? (c0.byId.get(m[3]) || {}).c : epCat.get(p.id + '|' + m[3]);
        if ((cat != null && A.hide.has(cat)) || (m[2] === 'show' && cat == null)) return json(res, 403, { error: cat == null ? 'Open the show again to play this episode.' : LOCKED_MSG, locked: cat != null });
      }
    }
    return pipeUpstream(req, res, vod.streamUrl(p, m[2], m[3], m[4]), { p: p.id, k: 'vod', u: uname, what: `${m[2]} ${m[3]}.${m[4]}` });
  }

  /* a downloaded file, with range requests so the player can seek; only from the signed-in profile's own folder */
  m = pn.match(/^\/dl\/([^/]+)$/);
  if (m && (req.method === 'GET' || req.method === 'HEAD')) {
    let did = ''; try { did = decodeURIComponent(m[1]); } catch { res.writeHead(404); return res.end('not found'); }
    const f = uname && downloader.fileFor(uname, did);
    if (!f) { res.writeHead(404); return res.end('not found'); }
    const types = { mp4: 'video/mp4', m4v: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm', avi: 'video/x-msvideo', ts: 'video/mp2t', mov: 'video/quicktime' };
    return serveFileRange(req, res, f, types[path.extname(f).slice(1).toLowerCase()] || 'application/octet-stream', url.searchParams.has('save') ? path.basename(f) : '');
  }

  /* a finished recording, with range requests so the player can seek; only from the signed-in profile's own folder */
  m = pn.match(/^\/rec\/([^/]+)\.mp4$/);
  if (m && (req.method === 'GET' || req.method === 'HEAD')) {
    let rid = ''; try { rid = decodeURIComponent(m[1]); } catch { res.writeHead(400); return res.end('bad request'); }
    const f = recorder.fileFor(uname, rid);
    if (!f) { res.writeHead(404); return res.end('not found'); }
    return serveFileRange(req, res, f, 'video/mp4', url.searchParams.has('save') ? path.basename(f) : '');
  }

  /* live entry points */
  /* HDHomeRun segments: /live/<provider>/<channel>/s<n>.ts, written by the channel's transcode */
  m = pn.match(/^\/live\/([a-z0-9_-]+)\/(\d+)\/(s\d+\.ts)$/);
  if (m) {
    const p = providers.get(m[1]);
    if (p && ADULT_ON && user) { // the same lock as the playlist: a segment of a locked channel is not handed out either
      const cat0 = await getCatalog(p), ch0 = cat0.byId.get(m[2]);
      if (ch0 && adultSets(req, user, p, 'live', cat0.categories).hide.has(ch0.c)) return json(res, 403, { error: LOCKED_MSG, locked: true });
    }
    const job = p ? transcode.touch(`${p.id}-${m[2]}`) : null;
    if (!job) { res.writeHead(404); return res.end('not running'); }
    const cid = cleanCid(url.searchParams.get('cid'));
    if (evicted.has([uname, cid, p.id].join('|'))) return json(res, 410, { error: 'taken over' });
    const ss = sess(p.id, m[2], uname, cid);
    return fs.readFile(path.join(job.dir, m[3]), (err, data) => {
      if (err) {
        if (Date.now() - (job.goneNoted || 0) > 15000) { // say why, at most every 15 s per buffer: deleted to make room, or never written
          job.goneNoted = Date.now();
          let on = [], listed = [];
          try { on = fs.readdirSync(job.dir).map((f) => /^s(\d+)\.ts$/.exec(f)).filter(Boolean).map((x) => +x[1]).sort((a, b) => a - b); } catch { /* folder gone */ }
          try { listed = [...fs.readFileSync(path.join(job.dir, 'index.m3u8'), 'utf8').matchAll(/^s(\d+)\.ts$/gm)].map((x) => +x[1]); } catch { /* no playlist */ }
          const pv = providers.get(job.p), rng = (a) => (a.length ? a[0] + '-' + a[a.length - 1] + ' (' + a.length + ')' : 'none');
          console.log(`[zibbit] ${pv ? pv.name : job.p}: channel ${m[2]} was asked for ${m[3]}, which is not on disk; the buffer's floor is ${job.floor || 0}, files on disk ${rng(on)}, playlist lists ${rng(listed)}`);
        }
        res.writeHead(404); return res.end('gone');
      }
      ss.last = Date.now(); ss.bytes += data.length;
      res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': data.length, 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      res.end(data);
    });
  }
  m = pn.match(/^\/live\/([a-z0-9_-]+)\/(\d+)\.(m3u8|ts)$/);
  if (m) {
    const p = providers.get(m[1]);
    if (!p) { res.writeHead(404); return res.end('unknown provider'); }
    const cid = cleanCid(url.searchParams.get('cid'));
    if (evicted.has([uname, cid, p.id].join('|'))) return json(res, 410, { error: 'taken over' });
    if (ADULT_ON && user) { // a locked channel is refused here, whatever address was used to ask for it
      const cat0 = await getCatalog(p), ch0 = cat0.byId.get(m[2]);
      if (ch0 && adultSets(req, user, p, 'live', cat0.categories).hide.has(ch0.c)) return json(res, 403, { error: LOCKED_MSG, locked: true });
    }
    let liveTarget = null; // the provider's own address for this channel
    if (!isLocalHls(p.type)) {
      if (p.type === 'm3u') {
        const ch = (await getCatalog(p)).byId.get(m[2]);
        if (!ch || !ch.u) { res.writeHead(404); return res.end('unknown channel'); }
        liveTarget = ch.u;
      } else liveTarget = `${p.url}/live/${encodeURIComponent(p.username)}/${encodeURIComponent(p.password)}/${m[2]}.${m[3]}`;
    }
    /* rewind: the channel goes through the server's buffer (one ffmpeg per channel, shared by everyone watching it), unless that has just failed here */
    const rwSec = rewindMine(stateFor(user)) * 60;
    const rwKey = `${p.id}-${m[2]}`;
    if (rwSec > 0 && !rewindBad.has(rwKey) && transcode.flaky(rwKey)) { // its buffer keeps ending within seconds: stop restarting it (each restart is another connection to the provider)
      rewindBad.set(rwKey, Date.now());
      console.log(`[zibbit] ${p.name}: channel ${m[2]}'s source keeps ending by itself within seconds, so it is not buffered for rewind; playing it directly`);
    }
    const useRewind = rwSec > 0 && m[3] === 'm3u8' && !isLocalHls(p.type) && !rewindBad.has(rwKey) && await transcode.available();
    let rwTarget = liveTarget;
    if (useRewind && p.type !== 'm3u' && p.format === 'ts') rwTarget = `${p.url}/live/${encodeURIComponent(p.username)}/${encodeURIComponent(p.password)}/${m[2]}.ts`; // a source set to TS is asked for TS
    const fixAudio = !isLocalHls(p.type) && m[3] === 'm3u8' && !(useRewind && p.format === 'ts') && await needsAudioFix(p, m[2], liveTarget);
    if (isLocalHls(p.type) || fixAudio || useRewind) {
      if (m[3] !== 'm3u8') { res.writeHead(404); return res.end('this source is served as HLS'); }
      const ch = (await getCatalog(p)).byId.get(m[2]);
      if ((!ch && !useRewind) || (isLocalHls(p.type) && (!ch || !ch.u))) { res.writeHead(404); return res.end('unknown channel'); }
      if (!(await transcode.available())) return json(res, 501, { error: 'ffmpeg is not installed on this server, so antenna channels can’t be played.' });
      const ss = sess(p.id, m[2], uname, cid);
      ss.last = Date.now();
      let job;
      try {
        const key = `${p.id}-${m[2]}`;
        const viaMe = (u) => `http://127.0.0.1:${PORT}/__ingest/${seal({ u, p: p.id, s: m[2], k: 'ingest' })}`; // read through this server, whose address checks apply
        let input = useRewind ? viaMe(rwTarget) : fixAudio ? viaMe(liveTarget) : ch.u, tabloToken = '';
        if (p.type === 'tablo' && !transcode.touch(key)) { // ask the device for a stream only when none is running for this channel
          let w = tabloOpening.get(key);
          if (!w) { w = tablo.watch(p, ch.u.slice(6)).finally(() => tabloOpening.delete(key)); tabloOpening.set(key, w); }
          const got = await w;
          input = got.url;
          tabloToken = got.token;
        }
        let vcodec = fixAudio || useRewind ? 'copy' : ch.v;
        if (p.type === 'tablo' && !transcode.touch(key)) { // the Tablo doesn't say what its video is: look, and copy it only when a browser can play it as it is
          const pr = await transcode.probe(input);
          const plain = /^h264$/i.test(pr.codec) && /^yuv420p$/i.test(pr.pix || 'yuv420p') && !/^(tt|bb|tb|bt)$/i.test(pr.field);
          vcodec = plain ? 'h264' : 'convert';
          console.log(`[zibbit] ${p.name}: ${ch.n} video is ${pr.codec || 'unknown'} ${pr.pix || ''} ${pr.field || ''}: ${plain ? 'passed through' : 'converted'}`.replace(/\s+:/, ':'));
        }
        job = await transcode.open(key, input, { p: p.id, s: m[2], videoCodec: vcodec, keepSec: rwSec > 0 ? REWIND_MAX * 60 : 0, audioCopy: useRewind && !fixAudio, reconnect: useRewind, onEnd: tabloToken ? () => tablo.endSession(p, tabloToken) : undefined });
      }
      catch (e) {
        if (useRewind && !fixAudio) { // the buffer could not start: this channel plays directly, as it always did, and is not tried again for a while
          rewindBad.set(rwKey, Date.now());
          console.log(`[zibbit] ${p.name}: channel ${m[2]} could not be buffered for rewind (${String(e.message || '').slice(0, 80).replace(/https?:\/\/\S+/g, '…')}); playing it directly${e.detail ? ' | ffmpeg said: ' + String(e.detail).replace(/https?:\/\/\S+/g, '…').replace(/\s+/g, ' ').slice(-300) : ''}`);
          return pipeUpstream(req, res, liveTarget, { p: p.id, s: m[2], c: cid, u: uname });
        }
        /* the provider login must never reach a log or a reply */
        const hide = (x) => { let v = String(x || ''); for (const sec of [p.password, p.username, encodeURIComponent(p.password || ''), encodeURIComponent(p.username || '')]) if (sec && sec.length > 2) v = v.split(sec).join('…'); return v; };
        const why = hide(e.message) || 'the tuner did not respond';
        console.log(`[zibbit] ${p.name}: could not start channel ${ch ? ch.n : m[2]}: ${why}${e.detail ? ' | ' + hide(String(e.detail).slice(-600)).replace(/\s+/g, ' ') : ''}`);
        return json(res, /busy/.test(why) ? 503 : 502, { error: why.charAt(0).toUpperCase() + why.slice(1) });
      }
      let text;
      try { text = fs.readFileSync(path.join(job.dir, 'index.m3u8'), 'utf8'); } catch { return json(res, 502, { error: 'The stream stopped before it started.' }); }
      ss.last = Date.now();
      if (job.keepSec > 0) { transcode.noteWant(job, uname + '|' + cid, rwSec); text = transcode.windowPlaylist(text, rwSec, job.floor); }
      const q = `?cid=${encodeURIComponent(cid)}`;
      text = text.split(/\r?\n/).map((l) => (/^s\d+\.ts$/.test(l.trim()) ? `${m[2]}/${l.trim()}${q}` : l)).join('\n');
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      return res.end(text);
    }
    return pipeUpstream(req, res, liveTarget, { p: p.id, s: m[2], c: cid, u: uname });
  }

  if (pn === '/api/me' && req.method === 'GET') return json(res, 200, { name: user ? user.name : null, tv: !!(user && user.tv), mode, role: user ? (isAdmin(user) ? 'admin' : 'user') : (mode === 'users' ? null : 'admin'), mustChange: !!(user && user.mustChange), rewind: user || mode !== 'users' ? rewindMine(stateFor(user)) : undefined, rec: user || mode !== 'users' ? recorder.available() : undefined, version: user || mode !== 'users' ? VERSION : undefined }); // the version is only for people who are signed in
  if (pn.startsWith('/api/adult/')) return handleAdult(req, res, user, pn);
  if (pn === '/api/pair/lookup' && req.method === 'POST' && user) return handlePairApprove(req, res, user, false);
  if (pn === '/api/pair/approve' && req.method === 'POST' && user) return handlePairApprove(req, res, user, true);
  if (pn === '/api/password' && req.method === 'POST') {
    if (!user) return json(res, 400, { error: 'There is no account to change.' });
    if (user.tv) return json(res, 403, { error: 'Change the password from a phone or computer, not from a paired TV.' });
    const b = await readBody(req, 4096).catch(() => ({}));
    const cur = String(b.current || '').slice(0, 200), next = String(b.next || '');
    const ipk = `pw|${lockAddr(clientIp(req))}|${user.name.toLowerCase()}`;
    const wait = lockedFor(ipk);
    if (wait) { res.setHeader('Retry-After', String(wait)); return json(res, 429, { error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} min.` }); }
    const got = await scryptAsync(cur, user.salt);
    if (!crypto.timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(user.hash, 'hex'))) {
      noteFail(ipk, LOCK.user, LOCK.ms);
      console.log(`[zibbit] wrong current password while changing it, ${user.name}, from ${ipLog(clientIp(req))}`);
      return json(res, 401, { error: 'The current password isn’t right.' });
    }
    const prob = pwProblem(next, user.name, cur);
    if (prob) return json(res, 400, { error: prob });
    fails.delete(ipk);
    await setUserPassword(user.name, next, true, { mustChange: false });
    const fresh = getUsers(true).find((x) => x.name === user.name);
    res.setHeader('Set-Cookie', cookieHeader(req, makeSession(fresh), SESSION_DAYS * 86400)); // stay signed in here, signed out everywhere else
    console.log(`[zibbit] ${user.name} changed their password`);
    return json(res, 200, { ok: true });
  }
  if (pn === '/api/signout-everywhere' && req.method === 'POST') { // every other device, and every paired screen, must sign in again; this one stays signed in
    if (!user || user.tv) return json(res, 403, { error: 'Do this from the main page, signed in with your own account.' });
    const all = getUsers(true).slice();
    const i = all.findIndex((x) => x.name === user.name);
    if (i < 0) return json(res, 404, { error: 'No such person.' });
    all[i] = { ...all[i], epoch: (all[i].epoch || 0) + 1 };
    writeUsers(all);
    res.setHeader('Set-Cookie', cookieHeader(req, makeSession(getUsers(true)[i]), SESSION_DAYS * 86400));
    console.log(`[zibbit] ${user.name} signed out everywhere`);
    return json(res, 200, { ok: true });
  }
  if (pn.startsWith('/api/admin/')) {
    if (mode !== 'users') return json(res, 403, { error: 'Admin settings need sign-in profiles.' });
    return handleAdmin(req, res, user, url);
  }
  if (pn === '/api/tv/token' && req.method === 'GET') { // a TV that was paired before it kept tokens asks for its own
    if (!user.tv) return json(res, 403, { error: 'Only a paired TV can do this.' });
    return json(res, 200, { name: user.name, token: makeSession(user, { tv: true }) });
  }
  if (pn === '/api/logout' && req.method === 'POST') {
    if (user) { stopSessions((x) => x.u === uname); unlocks.lock(devKey(req)); }
    res.setHeader('Set-Cookie', cookieHeader(req, '', 0));
    return json(res, 200, { ok: true });
  }
  if (pn === '/api/providers' && req.method === 'GET') {
    return json(res, 200, {
      providers: [...providers.values()].map((p) => ({ id: p.id, name: p.name, format: p.format, type: p.type })),
      lastProvider: st.data.lastProvider,
      last: st.data.last
    });
  }
  if (pn === '/api/clientlog' && req.method === 'POST') { // the player says why it gave up on a channel; one short line, a few a minute
    const b = await readBody(req, 2048);
    const key = 'client:' + uname, now = Date.now(), c = limitNoted.get(key) || { at: 0, n: 0 };
    if (now - c.at > 60000) { c.at = now; c.n = 0; }
    if (c.n++ < 10 && providers.has(b.p) && /^\d+$/.test(String(b.s))) {
      limitNoted.set(key, c);
      const ch = catalogs.get(b.p) && catalogs.get(b.p).byId.get(String(b.s));
      const at = new Date().toISOString().replace('T', ' ').slice(0, 19) + 'Z';
      console.log(`[zibbit] ${at} ${providers.get(b.p).name}: the player gave up on channel ${b.s}${ch ? ' (' + dispName(ch.n) + ')' : ''}: ${String(b.why || '').replace(/[^\w .,:/()=+-]/g, '').slice(0, 160)}`);
    }
    return json(res, 200, { ok: true });
  }
  /* recordings: each profile sees and manages only its own */
  if (pn === '/api/recordings' && req.method === 'GET') {
    return json(res, 200, { ready: recorder.available(), maxHours: REC_HOURS, items: recorder.list(uname), running: recorder.runningFor(uname) });
  }
  if (pn === '/api/recordings' && req.method === 'POST') {
    const b = await readBody(req, 2048).catch(() => ({}));
    const p = providers.get(b.p), sid = String(b.s || '');
    if (!p || !/^\d+$/.test(sid)) return json(res, 400, { error: 'bad request' });
    const cat = await getCatalog(p), ch = cat.byId.get(sid);
    if (ADULT_ON && user && ch && adultSets(req, user, p, 'live', cat.categories).hide.has(ch.c)) return json(res, 403, { error: LOCKED_MSG, locked: true });
    const now = Date.now() / 1000, until = +b.until > now ? Math.min(+b.until, now + REC_HOURS * 3600) : 0;
    try {
      const r = recorder.start({ profile: uname, key: `${p.id}-${sid}`, chName: ch ? dispName(ch.n) : 'Channel ' + sid, title: String(b.title || '').replace(/[\u0000-\u001f]/g, ' ').trim(), back: Math.max(0, Math.min(+b.back || 0, REWIND_MAX * 60)), until });
      return json(res, 200, { ok: true, id: r.id });
    } catch (e) { return json(res, 409, { error: e.message }); }
  }
  if (pn === '/api/recordings/stop' && req.method === 'POST') {
    const b = await readBody(req, 1024).catch(() => ({}));
    const p = providers.get(b.p), sid = String(b.s || '');
    if (!p || !/^\d+$/.test(sid)) return json(res, 400, { error: 'bad request' });
    return json(res, 200, { ok: recorder.stop(uname, `${p.id}-${sid}`) });
  }
  m = pn.match(/^\/api\/recordings\/([^/]+)(\/pos)?$/);
  if (m) {
    let rid = ''; try { rid = decodeURIComponent(m[1]); } catch { return json(res, 400, { error: 'bad request' }); }
    if (!m[2] && req.method === 'DELETE') return recorder.remove(uname, rid) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'That recording is still running or no longer there.' });
    if (m[2] && req.method === 'PUT') { const b = await readBody(req, 512).catch(() => ({})); return json(res, 200, { ok: recorder.setPos(uname, rid, b.t) }); }
  }
  /* downloads: movies and episodes copied to this profile's own folder */
  if (pn === '/api/downloads' && req.method === 'GET') return json(res, 200, { ready: downloader.available(), items: downloader.list(uname) });
  if (pn === '/api/downloads' && req.method === 'POST') {
    const b = await readBody(req, 4096).catch(() => ({}));
    const p = providers.get(b.p), kind = b.kind === 'show' ? 'show' : 'movie';
    if (!p || !vod.supported(p) || !/^\d+$/.test(String(b.id || '')) || !/^[a-z0-9]{2,5}$/i.test(String(b.ext || ''))) return json(res, 400, { error: 'bad request' });
    if (ADULT_ON && user) {
      const c0 = await vod.catalog(p, kind), A = adultSets(req, user, p, kind, c0.cats);
      if (A.hide.size) {
        const cat = kind === 'movie' ? (c0.byId.get(String(b.id)) || {}).c : epCat.get(p.id + '|' + b.id);
        if ((cat != null && A.hide.has(cat)) || (kind === 'show' && cat == null)) return json(res, 403, { error: cat == null ? 'Open the show again to download this episode.' : LOCKED_MSG, locked: cat != null });
      }
    }
    try { return json(res, 200, { ok: true, ...downloader.start({ profile: uname, pid: p.id, kind, id: String(b.id), ext: b.ext, title: b.title, year: b.year, season: +b.season || 0, ep: +b.ep || 0, epTitle: b.epTitle, mins: b.mins }) }); }
    catch (e) { return json(res, 409, { error: e.message }); }
  }
  m = pn.match(/^\/api\/downloads\/([^/]+)(\/pos|\/retry)?$/);
  if (m) {
    let did = ''; try { did = decodeURIComponent(m[1]); } catch { return json(res, 400, { error: 'bad request' }); }
    if (!m[2] && req.method === 'DELETE') return downloader.remove(uname, did) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'That download is no longer there.' });
    if (m[2] === '/pos' && req.method === 'PUT') { const b = await readBody(req, 512).catch(() => ({})); return json(res, 200, { ok: downloader.setPos(uname, did, b.t) }); }
    if (m[2] === '/retry' && req.method === 'POST') return json(res, 200, { ok: downloader.retry(uname, did) });
  }
  /* how far back this profile can rewind: its own choice, never more than the admin allows */
  if (pn === '/api/rewind' && req.method === 'GET') return json(res, 200, rewindInfo(st));
  if (pn === '/api/rewind' && req.method === 'PUT') {
    const b = await readBody(req, 1024).catch(() => ({}));
    const m = rewMin(b.minutes);
    if (m > 0) { st.data.rewindMinutes = m; saveState(st); }
    return json(res, 200, rewindInfo(st));
  }
  if (pn === '/api/last' && req.method === 'PUT') {
    const b = await readBody(req);
    if (providers.has(b.p) && /^\d+$/.test(String(b.s))) {
      st.data.lastProvider = b.p;
      st.data.last = { p: b.p, s: String(b.s) };
      saveState(st);
    }
    return json(res, 200, { ok: true });
  }
  if (pn === '/api/stop' && req.method === 'POST') {
    const b = await readBody(req).catch(() => ({}));
    const cid = cleanCid(b.cid);
    const mine = (x) => x.u === uname;
    const n = b.all ? stopSessions(mine) : stopSessions((x) => mine(x) && x.p === b.p && (!b.s || x.s === String(b.s)) && (!cid || x.c === cid));
    return json(res, 200, { stopped: n });
  }
  /* Before a channel starts: would it go over the provider's simultaneous-stream limit? */
  if (pn === '/api/claim' && req.method === 'POST') {
    const b = await readBody(req).catch(() => ({}));
    const p = providers.get(b.p);
    const sid = String(b.s || '');
    const cid = cleanCid(b.cid);
    if (!p || !/^\d+$/.test(sid)) return json(res, 400, { error: 'bad request' });
    const max = await maxConnections(p);
    const now = Date.now();
    // this device's own earlier channel does not count: starting a new one replaces it
    // a device that just zapped may still show its previous channel for a moment: count devices, not channels
    const byDevice = new Map();
    for (const x of sessions.values()) {
      if (x.p !== p.id || !isLive(x, now) || (x.u === uname && x.c === cid)) continue;
      const k = x.u + '|' + x.c, cur = byDevice.get(k);
      if (!cur || x.last > cur.last) byDevice.set(k, x);
    }
    let others = [...byDevice.values()];
    // a tuner is used per channel, not per device: people on the same channel share one, and joining one needs no new tuner
    if (isLocalHls(p.type)) { const seen = new Set([sid]); others = others.filter((x) => !seen.has(x.s) && seen.add(x.s)); }
    if (max > 0 && others.length >= max) {
      if (!b.take) {
        const cat = catalogs.get(p.id);
        return json(res, 409, {
          busy: true, max,
          by: [...new Set(others.map((x) => x.u || 'another device'))],
          watching: others.map((x) => ({ user: x.u || 'another device', name: (cat && cat.byId.get(x.s) ? dispName(cat.byId.get(x.s).n) : null) }))
        });
      }
      others.sort((a, c) => a.last - c.last);
      for (const x of others.slice(0, others.length - max + 1)) { evicted.set(evictKey(x), now); stopSessions((y) => y.p === x.p && y.u === x.u && y.c === x.c); }
    }
    evicted.delete([uname, cid, p.id].join('|'));
    sess(p.id, sid, uname, cid).last = now;
    return json(res, 200, { ok: true, max });
  }
  if (pn === '/api/status' && req.method === 'GET') {
    const now = Date.now();
    const list = [];
    const others = [];
    for (const x of sessions.values()) {
      if (!isLive(x, now)) continue;
      const cat = catalogs.get(x.p);
      const ch = cat && cat.byId.get(x.s);
      if (x.u !== uname) { if (!others.some((o) => o.user === (x.u || 'another device') && o.p === x.p && o.c === x.c)) others.push({ user: x.u || 'another device', p: x.p, c: x.c, name: ch ? dispName(ch.n) : null }); continue; }
      list.push({ p: x.p, s: x.s, name: ch ? dispName(ch.n) : null, live: true, open: x.conns.size, bytes: x.bytes, idleMs: now - x.last, sinceMs: now - x.since });
    }
    return json(res, 200, { sessions: list, others, live: list.length > 0, openUpstream: list.reduce((a, x) => a + x.open, 0) });
  }
  m = pn.match(/^\/api\/p\/([a-z0-9_-]+)\/([a-z-]+)$/);
  if (m) {
    const p = providers.get(m[1]);
    if (!p) return json(res, 404, { error: 'unknown provider' });
    try { return await handleProviderApi(req, res, p, m[2], url, st, user); } catch (e) {
      return json(res, 502, { error: String(e.message || e).replace(/\s+/g, ' ').slice(0, 200) });
    }
  }
  if (pn.startsWith('/api/')) return json(res, 404, { error: 'not found' });
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  return serveStatic(req, res, pn);
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    if (!res.headersSent) json(res, 500, { error: String(e.message || e).slice(0, 200) });
    else res.destroy();
  });
});
/* An error nobody caught (a stream that fails with no one listening, say) would end the process, and a container without a
 * restart policy would then stay down. Say what happened and keep serving; if it keeps happening, stop so a restart can start clean. */
const stray = [];
function unexpected(kind, e) {
  const now = Date.now();
  while (stray.length && now - stray[0] > 60000) stray.shift();
  stray.push(now);
  const msg = String((e && (e.stack || e.message)) || e).replace(/https?:\/\/\S+/g, '<address>').split('\n').slice(0, 3).join(' | ').slice(0, 400);
  console.error(`[zibbit] ${kind} (still running): ${msg}`);
  if (stray.length >= 20) { console.error('[zibbit] too many unexpected errors in a minute, stopping'); process.exit(1); }
}
process.on('uncaughtException', (e) => unexpected('unexpected error', e));
process.on('unhandledRejection', (e) => unexpected('unhandled promise error', e));
/* First start: create the admin account. Its password must be changed at first sign-in. An existing install that has
 * profiles but no admin is left as it is (nobody gets a default account); promote one from the command line. */
async function ensureAdmin() {
  const users = getUsers(true);
  if (!users.length) {
    /* No well-known first password: unless one was chosen with ADMIN_INITIAL_PASSWORD, a random one is made and shown once, in this log.
     * It still has to be replaced at first sign-in, but nobody who finds a fresh server can sign in as "admin" with a guess. */
    const custom = process.env.ADMIN_INITIAL_PASSWORD || APP_PASSWORD;
    const made = !custom && Array.from(crypto.randomBytes(16), (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('').replace(/(.{4})(?=.)/g, '$1-');
    await setUserPassword('admin', custom || made, false, { role: 'admin', mustChange: true });
    console.log(custom ? '[zibbit] created the first account "admin" with the password you set in ADMIN_INITIAL_PASSWORD; it must be changed at first sign-in.'
      : `[zibbit] created the first account: name "admin", temporary password "${made}". It is shown only here; you will be asked to choose a new one at first sign-in.`);
  } else if (!users.some(isAdmin)) {
    console.log('[zibbit] NOTICE: no profile is an admin yet, so nobody can open Admin settings. Run:  node server.js promote <name>');
  }
}
ensureAdmin().then(() => server.listen(PORT, () => {
  const u = getUsers(true);
  console.log(`[zibbit] sign-in: profiles (${u.map((x) => x.name + (isAdmin(x) ? ' [admin]' : '')).join(', ')})`);
  console.log(`[zibbit] v${VERSION} listening on :${PORT}  config: ${CONFIG_DIR}`);
  /* guides are read in the background, so they are in memory before anyone asks, and stay fresh */
  const warmGuides = () => { for (const p of providers.values()) { try { ensureGuide(p); } catch { /* next time */ } } };
  setTimeout(warmGuides, 4000);
  setInterval(warmGuides, 10 * 60000).unref();
  const dls = downloader.recover(); if (dls) console.log(`[zibbit] picking up ${dls} download(s) that a restart cut short`);
  const left = recorder.recover(); // recordings a restart cut short are finished now
  if (left) console.log(`[zibbit] finishing ${left} recording${left === 1 ? '' : 's'} that a restart cut short`);
}), (e) => { console.error('[zibbit] could not create the first account:', e.message); process.exit(1); });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopSessions(() => true); server.close(); process.exit(0); });
