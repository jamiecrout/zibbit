'use strict';
/* End-to-end checks: starts the server against a temporary config folder and a pretend provider.
 * Run with:  npm test   (Node 18+, no dependencies) */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

let pass = 0, failN = 0;
const ok = (c, msg) => { if (c) { pass++; console.log('  ok   ' + msg); } else { failN++; console.log('  FAIL ' + msg); } };

/* ---- a pretend provider: Xtream API, an M3U playlist, and a stream ---- */
function mock() {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const j = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u.pathname === '/player_api.php') {
      if (u.searchParams.get('username') !== 'u1' || u.searchParams.get('password') !== 'p1') return j({ user_info: { auth: 0 } });
      const a = u.searchParams.get('action');
      if (!a) return j({ user_info: { auth: 1, status: 'Active', exp_date: '1893456000', max_connections: '2', active_cons: '0' } });
      if (a === 'get_live_categories') return j([{ category_id: '1', category_name: 'News' }, { category_id: '2', category_name: 'Sports' }]);
      if (a === 'get_live_streams') return j([{ stream_id: 101, name: 'US: Alpha News', category_id: '1', epg_channel_id: 'alpha.us', stream_icon: '' }, { stream_id: 102, name: 'Beta Sports', category_id: '2', epg_channel_id: '', stream_icon: '' }]);
      if (a === 'get_vod_categories') return j([{ category_id: '10', category_name: '𝗔𝗖𝗧𝗜𝗢𝗡 ★ 4K' }, { category_id: '11', category_name: 'Comedy' }]);
      if (a === 'get_vod_streams') return j([{ stream_id: 501, name: 'EN - Big Heist (2019)', category_id: '10', container_extension: 'mkv', rating_5based: 4.2, added: '200', stream_icon: 'http://x/a.jpg' }, { stream_id: 502, name: 'Funny Day', category_id: '11', container_extension: 'mp4', rating_5based: 3, added: '300', stream_icon: '' }, { stream_id: 503, name: 'Big Laughs', category_id: '11', container_extension: 'mp4', rating_5based: 5, added: '100' }]);
      if (a === 'get_vod_info') return j({ info: { plot: 'A heist.', duration_secs: 7200, rating_5based: 4.2, releasedate: '2019-05-01', video: { codec_name: 'h264' } }, movie_data: { name: 'Big Heist', container_extension: 'mkv' } });
      if (a === 'get_series_categories') return j([{ category_id: '20', category_name: 'Drama' }]);
      if (a === 'get_series') return j([{ series_id: 601, name: 'Long Show', category_id: '20', cover: 'http://x/c.jpg', rating_5based: 4 }]);
      if (a === 'get_series_info') return j({ info: { name: 'Long Show', plot: 'Ongoing.' }, episodes: { 1: [{ id: '9002', episode_num: 2, title: 'Two', container_extension: 'mkv' }, { id: '9001', episode_num: 1, title: 'One', container_extension: 'mp4' }], 2: [{ id: '9003', episode_num: 1, title: 'Back', container_extension: 'mp4' }] } });
      return j([]);
    }
    if (u.pathname.startsWith('/movie/u1/p1/') || u.pathname.startsWith('/series/u1/p1/')) { // a fake file that honours Range
      const body = Buffer.from('0123456789abcdefghij'); const rg = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
      if (!rg) { res.writeHead(200, { 'Content-Type': 'video/x-matroska', 'Content-Length': body.length, 'Accept-Ranges': 'bytes' }); return res.end(body); }
      const a2 = +rg[1], b2 = rg[2] ? +rg[2] : body.length - 1;
      res.writeHead(206, { 'Content-Type': 'video/x-matroska', 'Content-Range': `bytes ${a2}-${b2}/${body.length}`, 'Content-Length': b2 - a2 + 1, 'Accept-Ranges': 'bytes' });
      return res.end(body.subarray(a2, b2 + 1));
    }
    if (u.pathname === '/guide.xml') {
      const t = (x) => new Date(x).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
      const n = Date.now();
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      return res.end(`<?xml version="1.0"?><tv><channel id="alpha.us"><display-name>Alpha News</display-name></channel><channel id="zeta.us"><display-name>Zeta</display-name></channel>` +
        `<programme start="${t(n - 1800e3)}" stop="${t(n + 1800e3)}" channel="alpha.us"><title>Alpha Now</title></programme>` +
        `<programme start="${t(n - 1800e3)}" stop="${t(n + 1800e3)}" channel="zeta.us"><title>Zeta Now</title></programme></tv>`);
    }
    if (u.pathname === '/list.m3u') {
      const base = `http://127.0.0.1:${srv.address().port}`;
      res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' });
      return res.end(`#EXTM3U url-tvg="http://127.0.0.1/guide.xml"\n#EXTINF:-1 tvg-id="gamma.us" tvg-logo="" group-title="Movies",Gamma Movies\n${base}/s/gamma.m3u8\n#EXTINF:-1 group-title="Movies",Delta Cinema\n${base}/s/delta.ts\n#EXTINF:-1,Loose Channel\n${base}/s/loose.ts\n`);
    }
    /* a pretend Tablo 4th Gen: the cloud account calls, and the device's signed watch call */
    if (u.pathname.startsWith('/cloud/')) {
      const chunks = [];
      req.on('data', (d) => chunks.push(d));
      return req.on('end', () => {
        let body = {}; try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { /* none */ }
        const b = `http://127.0.0.1:${srv.address().port}`;
        if (u.pathname === '/cloud/api/v2/login/') {
          if (body.email !== 'me@example.com' || body.password !== 'tablo-pass') { res.writeHead(403); return res.end('{"error":"bad login"}'); }
          return j({ token_type: 'Bearer', access_token: 'AT' });
        }
        if (req.headers.authorization !== 'Bearer AT') { res.writeHead(401); return res.end(); }
        if (u.pathname === '/cloud/api/v2/account/') return j({ profiles: [{ identifier: 'P1', name: 'me' }], devices: [{ name: 'Fake Tablo', serverId: 'SID_X', url: b }] });
        if (u.pathname === '/cloud/api/v2/account/select/') return j({ token: 'LH' });
        if (u.pathname === '/cloud/api/v2/account/LH/guide/channels/' && req.headers.lighthouse === 'LH') {
          return j([{ identifier: 'S1_503_01', kind: 'ota', ota: { major: 5, minor: 1, callSign: 'WFAKE', network: 'ABC' } }, { identifier: 'S1_503_02', kind: 'ota', ota: { major: 5, minor: 2, callSign: 'WTWO' } }, { identifier: 'OTT_1', kind: 'ott', name: 'Streamy' }]);
        }
        if (u.pathname === '/cloud/api/v2/account/LH/guide/grid/' && req.headers.lighthouse === 'LH') {
          const t0 = Date.now(), day = u.searchParams.get('day');
          const mk = (title, from, mins) => ({ identifier: 'a' + from, title, kind: 'episode', datetime: new Date(t0 + from * 60000).toISOString(), duration: mins * 60, description: 'About ' + title });
          srv.gridDays = (srv.gridDays || []).concat(day);
          return j({ grid: [{ channel: { identifier: 'S1_503_01' }, airings: [mk('Fake Show', -30, 60), mk('Next Show', 30, 30)] }, { channel: { identifier: 'OTHER' }, airings: [mk('Not Ours', -30, 60)] }] });
        }
        res.writeHead(404); res.end();
      });
    }
    if (req.method === 'DELETE' && u.pathname.startsWith('/player/sessions/')) { srv.tabloEnded = (srv.tabloEnded || 0) + 1; res.writeHead(200); return res.end('{}'); }
    const wm = u.pathname.match(/^\/guide\/channels\/([A-Za-z0-9_]+)\/watch$/);
    if (wm && req.method === 'POST') {
      const chunks = [];
      req.on('data', (d) => chunks.push(d));
      return req.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        const c = require('crypto');
        const want = c.createHmac('md5', '6l8jU5N43cEilqItmT3U2M2PFM3qPziilXqau9ys').update(`POST\n${u.pathname}\n${c.createHash('md5').update(raw).digest('hex')}\n${req.headers.date}`).digest('hex');
        if (req.headers.authorization !== `tablo:ljpg6ZkwShVv8aI12E2LP55Ep8vq1uYDPvX0DdTB:${want}` || u.search !== '?lh' || JSON.parse(raw).platform !== 'ios') { res.writeHead(401); return res.end(); }
        srv.tabloWatches = (srv.tabloWatches || 0) + 1;
        j({ playlist_url: `http://127.0.0.1:${srv.address().port}/tablo/stream/${wm[1]}.ts`, token: 't', keepalive: 30 });
      });
    }
    if (u.pathname.startsWith('/tablo/stream/')) { // H.264 + AAC, like the Tablo sends
      const ff = require('child_process').spawn('ffmpeg', ['-v', 'quiet', '-re', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-c:a', 'aac', '-f', 'mpegts', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
      res.writeHead(200, { 'Content-Type': 'video/mp2t' });
      ff.stdout.pipe(res);
      res.on('close', () => ff.kill('SIGKILL'));
      return;
    }
    if (u.pathname === '/discover.json') return j({ FriendlyName: 'Fake HDHomeRun', ModelNumber: 'HDHR-TEST', TunerCount: 2, DeviceAuth: 'fakeauth' });
    if (u.pathname === '/hdhr-guide') { // stands in for SiliconDust's guide service: a two-hour show then a one-hour show, per page
      if (u.searchParams.get('DeviceAuth') !== 'fakeauth') { res.writeHead(403); return res.end(); }
      const st = +u.searchParams.get('Start') || 0, a = Math.floor(st / 3600) * 3600;
      srv.hdhrGuidePages = (srv.hdhrGuidePages || 0) + 1;
      return j([{ GuideNumber: '3.1', GuideName: 'WAAA-DT', Guide: [{ StartTime: a, EndTime: a + 7200, Title: 'Fake Antenna Show', EpisodeTitle: 'Pilot' }, { StartTime: a + 7200, EndTime: a + 10800, Title: 'Later Show' }] }, { GuideNumber: '7.1', GuideName: 'Other', Guide: [{ StartTime: a, EndTime: a + 3600, Title: 'Not Ours' }] }]);
    }
    if (u.pathname === '/lineup.json') {
      const b = `http://127.0.0.1:${srv.address().port}`;
      return j([{ GuideNumber: '3.1', GuideName: 'WAAA-DT', VideoCodec: 'MPEG2', AudioCodec: 'AC3', HD: 1, URL: `${b}/auto/v3.1` }, { GuideNumber: '3.2', GuideName: 'Bounce', VideoCodec: 'MPEG2', AudioCodec: 'AC3', URL: `${b}/auto/v3.2` }, { GuideNumber: '9.1', GuideName: 'Scrambled', DRM: 1, URL: `${b}/auto/v9.1` }]);
    }
    if (u.pathname.startsWith('/auto/')) { // an MPEG-2 + AC3 transport stream, like an antenna tuner sends
      const ff = require('child_process').spawn('ffmpeg', ['-v', 'quiet', '-re', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440', '-c:v', 'mpeg2video', '-c:a', 'ac3', '-f', 'mpegts', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
      res.writeHead(200, { 'Content-Type': 'video/mp2t' });
      ff.stdout.pipe(res);
      res.on('close', () => ff.kill('SIGKILL'));
      return;
    }
    if (u.pathname === '/s/gamma.m3u8') { res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }); return res.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:4,\nseg1.ts\n'); }
    if (u.pathname.startsWith('/s/')) { res.writeHead(200, { 'Content-Type': 'video/mp2t' }); return res.end('TSDATA'); }
    if (u.pathname === '/live/u1/p1/7001.m3u8') { res.writeHead(302, { Location: `http://localhost:${srv.address().port}/secret.txt` }); return res.end(); } // a redirect to another name for this machine
    if (u.pathname === '/live/u1/p1/7002.m3u8') { res.writeHead(302, { Location: `http://127.0.0.1:${srv.address().port}/s/gamma.m3u8` }); return res.end(); } // a redirect that stays on the provider
    if (u.pathname === '/secret.txt') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('TOP SECRET'); }
    if (u.pathname === '/live/u1/p1/9001.ts') { // a raw MPEG-TS live stream (H.264 + AAC), the way a "ts" provider sends it
      srv.rewindPulls = (srv.rewindPulls || 0) + 1;
      const ff = require('child_process').spawn('ffmpeg', ['-v', 'quiet', '-re', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-c:a', 'aac', '-f', 'mpegts', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
      res.writeHead(200, { 'Content-Type': 'video/mp2t' });
      ff.stdout.pipe(res);
      res.on('close', () => ff.kill('SIGKILL'));
      return;
    }
    if (u.pathname === '/live/u1/p1/9003.ts') { // sends video for a few seconds, then goes silent but keeps the connection open (a provider that has stopped feeding the stream)
      srv.stallPulls = (srv.stallPulls || 0) + 1;
      const ff = require('child_process').spawn('ffmpeg', ['-v', 'quiet', '-re', '-t', '5', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-c:a', 'aac', '-f', 'mpegts', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
      res.writeHead(200, { 'Content-Type': 'video/mp2t' });
      ff.stdout.on('data', (d) => res.write(d)); // no end(): the socket stays open
      res.on('close', () => ff.kill('SIGKILL'));
      return;
    }
    if (u.pathname.startsWith('/live/u1/p1/')) { res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }); return res.end('#EXTM3U\n#EXTINF:4,\nseg.ts\n'); }
    res.writeHead(404); res.end();
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- an install made by the previous version: no roles, providers.json and settings.json as they were ---- */
async function upgradeCheck() {
  const crypto = require('crypto');
  console.log('upgrading a V1 config');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dock-up-'));
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync('alex-old-password', salt, 32).toString('hex');
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify({ users: [{ name: 'Alex', salt: salt.toString('hex'), hash, stateFile: 'state.json' }] }));
  fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify({ providers: [{ id: 'primary', name: 'Strong', url: 'http://127.0.0.1:9', username: 'a', password: 'b', format: 'm3u8' }] }));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ trustIpHeader: 'cf-connecting-ip', trimFromNames: 'US:,UK:', epg: { primary: ['http://127.0.0.1:9/e.xml.gz'] } }));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ lastProvider: 'primary', last: null, providers: { primary: { groups: ['1'], favorites: ['5'] } } }));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const env = { ...process.env, PORT: String(port), CONFIG_DIR: dir, TRUST_IP_HEADER: '' };
  const srv = path.join(__dirname, '..', 'server.js');
  const child = spawn(process.execPath, [srv], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 50 && !log.includes('listening'); i++) await sleep(100);
  try {
    ok(!/created the first account/.test(log), 'no default admin is created when profiles already exist');
    ok(/no profile is an admin/.test(log), 'the log says how to make someone an admin');
    const login = await fetch(`http://127.0.0.1:${port}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Alex', password: 'alex-old-password' }) });
    ok(login.status === 200, 'the existing password still works');
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const get = async (p) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { headers: { Cookie: cookie } }); return { status: r.status, j: await r.json().catch(() => null) }; };
    let r = await get('/api/me');
    ok(r.j.role === 'user' && !r.j.mustChange, 'existing profiles become regular users, with no forced password change');
    ok(r.j.version === require('../package.json').version && /^\d+\.\d+\.\d+/.test(r.j.version), 'a signed-in person is told the server version');
    r = await get('/api/providers');
    ok(r.status === 200 && r.j.providers.length === 1 && r.j.providers[0].id === 'primary' && r.j.lastProvider === 'primary', 'providers.json from V1 is read unchanged');
    r = await get('/api/admin/providers');
    ok(r.status === 403, 'nobody is an admin until promoted from the command line');
    const pr = spawn(process.execPath, [srv, 'promote', 'alex'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    pr.stdout.on('data', (d) => { out += d; });
    await new Promise((res) => pr.on('close', res));
    ok(/admin/.test(out), 'promote works from the command line');
    await sleep(5200); // the server re-reads profiles every few seconds
    r = await get('/api/admin/providers');
    ok(r.status === 200 && r.j.providers.length === 1 && r.j.providers[0].epg.length === 1, 'after promote: admin sees the provider and its guide address from the V1 settings.json');
    r = await get('/api/admin/settings');
    ok(r.j.trustIpHeader === 'cf-connecting-ip' && r.j.trimFromNames.join() === 'US:,UK:', 'V1 settings are shown as they were');
    ok(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).providers.primary.favorites[0] === '5', 'saved groups and favorites are untouched');
  } finally { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
}

// every file the server loads from its own folder must be copied into the image, or the container will not start
(function dockerfileCheck() {
  const root = path.join(__dirname, '..'), docker = fs.readFileSync(path.join(root, '..', 'Dockerfile'), 'utf8');
  const copied = new Set((docker.match(/^COPY\s+(.+?)\s+\.\/\s*$/m) || ['', ''])[1].split(/\s+/).map((f) => f.replace(/^app\//, '')));
  const want = new Set();
  for (const f of fs.readdirSync(root).filter((f) => f.endsWith('.js'))) {
    for (const m of fs.readFileSync(path.join(root, f), 'utf8').matchAll(/require\('\.\/([\w.-]+?)(?:\.js)?'\)/g)) want.add(/\.\w+$/.test(m[1]) ? m[1] : m[1] + '.js');
    want.add(f);
  }
  const missing = [...want].filter((f) => !copied.has(f));
  if (!/su-exec/.test(docker) || !/COPY app\/docker-entrypoint\.sh /.test(docker) || !/^ENTRYPOINT \["docker-entrypoint\.sh"\]/m.test(docker)) { console.error('Dockerfile no longer starts the server through the non-root entrypoint'); process.exit(1); }
  const sh = require('child_process').spawnSync('sh', ['-n', path.join(root, 'docker-entrypoint.sh')]);
  if (sh.status !== 0) { console.error('docker-entrypoint.sh has a syntax error: ' + sh.stderr); process.exit(1); }
  if (missing.length) { console.error('Dockerfile does not COPY: ' + missing.join(', ')); process.exit(1); }
  console.log('ok   Dockerfile copies every module the server loads');
})();

async function main() {
  const prov = await mock();
  const pport = prov.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dock-test-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const recDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dock-rec-')); // outside the config folder: recordings are meant to be shared with other programs, the config is not
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), CONFIG_DIR: dir, RECORDINGS_DIR: recDir, TRUST_IP_HEADER: '', STALL_SECONDS: '4', TABLO_CLOUD_URL: `http://127.0.0.1:${pport}/cloud`, PAIR_TTL_SECONDS: '3', HDHR_GUIDE_URL: `http://127.0.0.1:${pport}/hdhr-guide` }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50 && !log.includes('listening'); i++) await sleep(100);
  try {
    function client() {
      let cookie = '';
      return async (method, p, body, extra = {}) => {
        const r = await fetch(base + p, { method, redirect: 'manual', headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...extra }, body: body !== undefined ? JSON.stringify(body) : undefined });
        const sc = r.headers.get('set-cookie');
        if (sc) cookie = sc.split(';')[0];
        let j = null, t = null;
        const ct = r.headers.get('content-type') || '';
        if (ct.includes('json')) j = await r.json().catch(() => null); else t = await r.text();
        return { status: r.status, j, t };
      };
    }
    const A = client();
    console.log('first start');
    ok(/created the first account/.test(log), 'creates the default admin account on a blank config');
    let r = await A('GET', '/api/providers');
    ok(r.status === 401, 'nothing is open before sign-in');
    r = await A('POST', '/api/login', { name: 'admin', password: 'wrong' });
    ok(r.status === 401, 'wrong password is refused');
    const initPw = (log.match(/temporary password "([^"]+)"/) || [])[1];
    ok(/^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/.test(initPw || ''), 'the first account gets a random temporary password, shown in the log');
    ok(!(await A('POST', '/api/login', { name: 'admin', password: 'admin' })).j.name, 'the old well-known first password does not work');
    r = await A('POST', '/api/login', { name: 'admin', password: initPw });
    ok(r.status === 200, 'admin/admin signs in');
    r = await A('GET', '/api/me');
    ok(r.j.role === 'admin' && r.j.mustChange === true, '/api/me says admin and must change password');
    { const anon = await fetch(`${base}/api/me`).then((x) => x.json()); ok(anon.version === undefined, 'the version is not shown to someone who has not signed in'); }
    {
      const m = await fetch(`${base}/manifest.webmanifest`, { redirect: 'manual' }), ic = await fetch(`${base}/icons/apple-touch-icon.png`, { redirect: 'manual' });
      const mj = await m.json().catch(() => ({}));
      ok(m.status === 200 && mj.display === 'standalone' && mj.icons && mj.icons.length === 2 && ic.status === 200 && ic.headers.get('content-type') === 'image/png', 'the home-screen manifest and icons load without signing in');
      const app = await fetch(`${base}/`, { redirect: 'manual' });
      ok(app.status === 302, 'the app page itself still needs a sign-in');
    }
    r = await A('GET', '/api/providers');
    ok(r.status === 403 && r.j.mustChange, 'everything else is blocked until the password is changed');
    r = await A('GET', '/api/admin/providers');
    ok(r.status === 403, 'admin pages are blocked too');
    r = await A('POST', '/api/password', { current: 'nope', next: 'a-new-password-1' });
    ok(r.status === 401, 'change needs the right current password');
    r = await A('POST', '/api/password', { current: initPw, next: 'short' });
    ok(r.status === 400, 'short new password refused');
    r = await A('POST', '/api/password', { current: initPw, next: initPw });
    ok(r.status === 400, 'same password refused');
    r = await A('POST', '/api/password', { current: initPw, next: 'a-new-password-1' });
    ok(r.status === 200, 'password changed');
    r = await A('GET', '/api/me');
    ok(r.status === 200 && r.j.mustChange === false, 'still signed in after the change, flag cleared');
    r = await A('GET', '/api/providers');
    ok(r.status === 200 && r.j.providers.length === 0, 'providers list works and is empty');
    /* ---- pairing a TV ---- */
    {
      const TV = client(), X = client();
      const strip = (c) => c.replace('-', '');
      let p1 = await TV('POST', '/api/pair/start', { label: 'Zibbit TV' });
      ok(p1.status === 200 && /^[BCDFGHJKLMNPQRSTVWXZ2-9]{4}-[BCDFGHJKLMNPQRSTVWXZ2-9]{4}$/.test(p1.j.code) && p1.j.device.length >= 40 && p1.j.link.includes('/pair?code=') && p1.j.expiresIn === 3, 'a TV can ask for a pairing code without signing in');
      r = await TV('POST', '/api/pair/poll', { device: p1.j.device });
      ok(r.j.status === 'pending', 'it is pending until someone approves');
      r = await TV('POST', '/api/pair/poll', { device: p1.j.device });
      ok(r.status === 429, 'polling faster than every second or so is refused');
      r = await X('POST', '/api/pair/lookup', { code: strip(p1.j.code) });
      ok(r.status === 401, 'looking a code up needs a sign-in');
      r = await A('POST', '/api/pair/lookup', { code: 'ZZZZ-ZZZZ' });
      ok(r.status === 404, 'a wrong code is refused');
      r = await A('POST', '/api/pair/lookup', { code: strip(p1.j.code).toLowerCase() });
      ok(r.status === 200 && r.j.label === 'Zibbit TV' && r.j.sameNetwork === true, 'a signed-in person sees what they are approving (code is not case sensitive)');
      r = await A('POST', '/api/pair/approve', { code: p1.j.code });
      ok(r.status === 200, 'and approves it');
      await sleep(1600);
      r = await TV('POST', '/api/pair/poll', { device: p1.j.device });
      ok(r.j.status === 'approved' && r.j.name === 'admin', 'the TV receives its sign-in');
      const tvToken = r.j.token;
      r = await TV('GET', '/api/me');
      ok(r.status === 200 && r.j.name === 'admin' && r.j.tv === true && r.j.role === 'user', 'a paired TV is signed in as that profile, but is never an admin');
      r = await TV('GET', '/api/admin/users');
      ok(r.status === 403, 'a paired TV cannot use the admin screens');
      r = await TV('POST', '/api/password', { current: 'a-new-password-1', next: 'tv-should-not-do-this-1' });
      ok(r.status === 403, 'a paired TV cannot change the password');
      r = await TV('POST', '/api/pair/approve', { code: 'BCDFGHJK' });
      ok(r.status === 403, 'a paired TV cannot approve other TVs');
      r = await X('POST', '/api/pair/poll', { device: p1.j.device });
      ok(r.j.status === 'expired', 'a pairing is single use');
      /* a TV keeps tokens for the profiles paired on it and switches between them */
      const T2 = client();
      r = await T2('POST', '/api/tv/switch', { token: tvToken });
      ok(r.status === 200 && r.j.name === 'admin' && r.j.token, 'a TV can switch to a profile it was paired with');
      r = await T2('GET', '/api/me');
      ok(r.status === 200 && r.j.tv === true, 'a switched TV profile is still a TV (limited rights)');
      r = await T2('GET', '/api/tv/token');
      ok(r.status === 200 && r.j.token, 'a paired TV can ask for its own token');
      r = await A('GET', '/api/tv/token');
      ok(r.status === 403, 'a full sign-in cannot get a TV token');
      r = await X('POST', '/api/tv/switch', { token: 'abc.def' });
      ok(r.status === 401, 'a made-up token is refused');
      /* a code expires, and a code cannot be searched for */
      const p2 = await X('POST', '/api/pair/start', {});
      await sleep(3300);
      r = await A('POST', '/api/pair/lookup', { code: p2.j.code });
      ok(r.status === 404, 'an expired code is refused');
      r = await X('POST', '/api/pair/poll', { device: p2.j.device });
      ok(r.j.status === 'expired', 'and the TV is told so');
      let locked = 0;
      for (let i = 0; i < 12; i++) { r = await A('POST', '/api/pair/lookup', { code: 'BCDFGHJK' }); if (r.status === 429) { locked = i; break; } }
      ok(locked > 0 && locked <= 9, 'repeated wrong codes lock the guesser out');
      r = await A('POST', '/api/pair/lookup', { code: p2.j.code });
      ok(r.status === 429, 'and the lockout holds even for a real code');
      r = await fetch(`${base}/tv`, { redirect: 'manual' }); const tvhtml = r.status === 200 ? await r.text() : '';
      ok(r.status === 200 && /Zibbit/.test(tvhtml), 'the TV page loads without a sign-in');
      r = await fetch(`${base}/pair`, { redirect: 'manual' });
      ok(r.status === 302 && /login\.html\?next=%2Fpair/.test(r.headers.get('location') || ''), 'the pairing page sends someone who is not signed in to sign in, then back');
      let n429 = 0;
      for (let i = 0; i < 14; i++) { r = await X('POST', '/api/pair/start', {}); if (r.status === 429) n429++; }
      ok(n429 > 0, 'asking for codes over and over from one address is limited');
    }

    console.log('providers');
    r = await A('POST', '/api/admin/providers/test', { name: 'T', type: 'xtream', url: `http://127.0.0.1:${pport}`, username: 'u1', password: 'bad' });
    ok(r.j.ok === false, 'test connection reports a bad password');
    r = await A('POST', '/api/admin/providers/test', { name: 'T', type: 'xtream', url: `http://127.0.0.1:${pport}`, username: 'u1', password: 'p1' });
    ok(r.j.ok === true && r.j.maxConnections === 2, 'test connection works and reports the connection limit');
    r = await A('POST', '/api/admin/providers', { name: 'Alpha TV', type: 'xtream', url: `http://127.0.0.1:${pport}/`, username: 'u1', password: 'p1', epg: [] });
    ok(r.status === 200 && r.j.id === 'alpha-tv', 'adds an Xtream provider');
    r = await A('POST', '/api/admin/providers', { name: 'Movie List', type: 'm3u', url: `http://127.0.0.1:${pport}/list.m3u`, format: 'm3u8' });
    ok(r.status === 200, 'adds an M3U provider');
    r = await A('POST', '/api/admin/providers', { name: 'Third', type: 'xtream', url: `http://127.0.0.1:${pport}`, username: 'u1', password: 'p1' });
    ok(r.status === 200 && r.j.providers.length === 3, 'a third provider is fine');
    ok(!JSON.stringify(r.j).includes('p1'), 'the admin list never contains passwords');
    r = await A('GET', '/api/providers');
    ok(r.j.providers.length === 3 && r.j.providers.some((p) => p.type === 'm3u'), 'users see all providers');
    r = await A('GET', '/api/p/alpha-tv/bootstrap');
    ok(r.status === 200 && r.j.total === 2 && r.j.categories.length === 2, 'Xtream catalog loads');
    r = await A('GET', '/api/p/movie-list/bootstrap');
    ok(r.status === 200 && r.j.total === 3, 'M3U catalog loads (3 channels)');
    ok(r.j.categories.some((c) => c.name === 'Movies' && c.count === 2) && r.j.categories.some((c) => c.name === 'Uncategorized'), 'M3U groups come from group-title');
    r = await A('PUT', '/api/p/movie-list/groups', { groups: ['Movies'] });
    ok(r.j.channels === 2, 'groups can be saved for an M3U provider');
    r = await A('GET', '/api/p/movie-list/channels?cat=Movies');
    ok(r.j.items.length === 2 && r.j.items.every((i) => /^\d+$/.test(i.s)), 'M3U channels have numeric ids');
    ok(!JSON.stringify(r.j).includes('127.0.0.1'), 'M3U stream addresses never reach the browser');
    const gamma = r.j.items.find((i) => i.n === 'Gamma Movies'), delta = r.j.items.find((i) => i.n === 'Delta Cinema');
    r = await A('GET', `/live/movie-list/${gamma.s}.m3u8`);
    ok(r.status === 200 && r.t.includes('#EXTM3U') && r.t.includes('/x/'), 'M3U HLS channel plays through the proxy with sealed segment URLs');
    r = await A('GET', `/live/movie-list/${delta.s}.ts`);
    ok(r.status === 200 && r.t === 'TSDATA', 'M3U TS channel plays through the proxy');

    console.log('hdhomerun');
    const hasFfmpeg = require('child_process').spawnSync('ffmpeg', ['-version']).status === 0;
    r = await A('POST', '/api/admin/providers/test', { name: 'Antenna', type: 'hdhr', url: `127.0.0.1:${pport}` });
    ok(r.j.ok === true && r.j.kind === 'hdhr' && r.j.tuners === 2 && r.j.channels === 2 && r.j.transcoded === 2, 'test connection finds the tuner, its tuners and its channels (copy-protected ones left out)');
    r = await A('POST', '/api/admin/providers/test', { name: 'Antenna', type: 'hdhr', url: 'http://127.0.0.1:1' });
    ok(r.j.ok === false, 'test connection reports an unreachable tuner');
    r = await A('POST', '/api/admin/providers', { name: 'Antenna', type: 'hdhr', url: `127.0.0.1:${pport}` });
    ok(r.status === 200 && r.j.providers.find((x) => x.id === 'antenna').type === 'hdhr' && r.j.providers.find((x) => x.id === 'antenna').url === `http://127.0.0.1:${pport}`, 'adds a tuner by bare address');
    r = await A('GET', '/api/p/antenna/bootstrap');
    ok(r.status === 200 && r.j.total === 2 && r.j.categories.some((c) => c.name === 'Antenna' && c.count === 2), 'tuner channels load into one Antenna group');
    r = await A('PUT', '/api/p/antenna/groups', { groups: ['Antenna'] });
    r = await A('GET', '/api/p/antenna/channels?cat=Antenna');
    ok(r.j.items.length === 2 && r.j.items[0].n === '3.1 WAAA-DT' && r.j.items.every((i) => /^\d+$/.test(i.s)), 'channels are named with their number and have numeric ids');
    ok(!JSON.stringify(r.j).includes('127.0.0.1'), 'tuner addresses never reach the browser');
    const ant = r.j.items[0];
    for (let i = 0; i < 40; i++) { r = await A('GET', '/api/p/antenna/epg-status'); if (r.j && r.j.loadedAt) break; await sleep(150); }
    r = await A('GET', `/api/p/antenna/epg-grid?ids=${ant.s}`);
    ok(r.j && r.j[ant.s] && r.j[ant.s].length >= 2 && /Fake Antenna Show/.test(JSON.stringify(r.j[ant.s])) && !/Not Ours/.test(JSON.stringify(r.j)), 'the tuner’s guide subscription fills the grid with no XMLTV address, for our channels only, over several pages');
    if (!hasFfmpeg) console.log('  (ffmpeg not installed here: playback checks skipped)');
    else {
      r = await A('POST', '/api/claim', { p: 'antenna', s: ant.s, cid: 'dev1' });
      ok(r.status === 200 && r.j.max === 2, 'claiming a channel reports the tuner count as the limit');
      r = await A('GET', `/live/antenna/${ant.s}.m3u8?cid=dev1`);
      ok(r.status === 200 && r.t.includes('#EXTM3U') && new RegExp(`${ant.s}/s\\d+\\.ts\\?cid=dev1`).test(r.t), 'the channel plays as HLS made on demand, with segments served by this server');
      const seg = (r.t.match(new RegExp(`${ant.s}/s\\d+\\.ts\\?cid=dev1`)) || [''])[0];
      r = await A('GET', '/live/antenna/' + seg);
      ok(r.status === 200, 'a segment can be fetched');
      r = await A('GET', `/live/antenna/${ant.s}.ts`);
      ok(r.status === 404, 'raw TS is not offered for a tuner');
      r = await A('POST', '/api/stop', { p: 'antenna', s: ant.s, cid: 'dev1' });
      await sleep(300);
      r = await A('GET', '/live/antenna/' + seg);
      ok(r.status === 404, 'pressing Stop ends the transcode right away');
    }
    console.log('tablo (experimental)');
    const tbBody = { name: 'Tablo', type: 'tablo', username: 'me@example.com', password: 'tablo-pass' };
    r = await A('POST', '/api/admin/providers/test', { ...tbBody, password: 'wrong' });
    ok(r.j.ok === false && /rejected/i.test(r.j.error), 'test connection explains a wrong Tablo email or password');
    r = await A('POST', '/api/admin/providers/test', tbBody);
    ok(r.j.ok === true && r.j.kind === 'tablo' && r.j.model === 'Fake Tablo' && r.j.channels === 2, 'test connection signs in and finds the device and its antenna channels (streaming-app channels left out)');
    r = await A('POST', '/api/admin/providers', { ...tbBody, username: '' });
    ok(r.status === 400, 'a Tablo needs the account email');
    r = await A('POST', '/api/admin/providers', tbBody);
    const tv = r.j && r.j.providers && r.j.providers.find((x) => x.id === 'tablo');
    ok(r.status === 200 && tv && tv.type === 'tablo' && tv.username === 'me@example.com' && tv.hasPassword && !JSON.stringify(r.j).includes('tablo-pass'), 'adds a Tablo without a device address, and never shows its password');
    r = await A('GET', '/api/p/tablo/bootstrap');
    ok(r.status === 200 && r.j.total === 2 && r.j.categories.some((c) => c.name === 'Antenna' && c.count === 2), 'Tablo channels load into one Antenna group');
    await A('PUT', '/api/p/tablo/groups', { groups: ['Antenna'] });
    r = await A('GET', '/api/p/tablo/channels?cat=Antenna');
    ok(r.j.items.length === 2 && r.j.items[0].n === '5.1 WFAKE' && r.j.items.every((i) => /^\d+$/.test(i.s)) && !/tablo:|S1_503|127\.0\.0\.1/.test(JSON.stringify(r.j)), 'channels are named with their number, and no device details reach the browser');
    const tch = r.j.items[0];
    r = await A('GET', '/api/p/tablo/epg-status'); r = await A('GET', '/api/p/tablo/epg-status');
    for (let i = 0; i < 40; i++) { r = await A('GET', '/api/p/tablo/epg-status'); if (r.j && r.j.loadedAt) break; await sleep(150); }
    r = await A('GET', `/api/p/tablo/epg-grid?ids=${tch.s}`);
    ok(r.j && r.j[tch.s] && r.j[tch.s].length === 2 && r.j[tch.s][0][2] === 'Fake Show', 'the Tablo’s own guide fills the grid, with no XMLTV address, and keeps only our channels');
    r = await A('PUT', '/api/admin/providers/tablo', { ...tbBody, password: '' });
    ok(r.status === 200, 'editing a Tablo with a blank password keeps the saved one');
    if (hasFfmpeg) {
      const before = prov.tabloWatches || 0;
      r = await A('GET', `/live/tablo/${tch.s}.m3u8?cid=dev1`);
      ok(r.status === 200 && r.t.includes('#EXTM3U') && new RegExp(`${tch.s}/s\\d+\\.ts\\?cid=dev1`).test(r.t), 'a Tablo channel plays as HLS made on demand (the device was asked for a stream with a valid signature)');
      r = await A('GET', `/live/tablo/${tch.s}.m3u8?cid=dev1`);
      ok(r.status === 200 && (prov.tabloWatches || 0) === before + 1, 'watching the same channel again reuses the running stream instead of asking the device for another');
      r = await A('POST', '/api/stop', { p: 'tablo', s: tch.s, cid: 'dev1' });
      await sleep(400);
      ok((prov.tabloEnded || 0) >= 1, 'pressing Stop tells the Tablo the session is over, so the tuner is freed');
    }
    r = await A('DELETE', '/api/admin/providers/tablo', {});
    ok(r.status === 200, 'a Tablo can be removed');

    r = await A('GET', '/live/alpha-tv/101.m3u8');
    ok(r.status === 200 && r.t.includes('#EXTM3U'), 'Xtream channel still plays');
    // a provider cannot send the server to other addresses inside the network: a redirect off the provider to a private address is refused
    r = await A('GET', '/live/alpha-tv/7001.m3u8');
    ok(r.status === 403 && !JSON.stringify(r.j || r.t || '').includes('TOP SECRET'), 'a redirect from the provider to a private address is refused (and nothing from it is passed on)');
    r = await A('GET', '/live/alpha-tv/7002.m3u8');
    ok(r.status === 200 && r.t.includes('#EXTM3U'), 'a redirect that stays on the provider is followed');
    /* rewind: a live channel goes through the server's buffer, one pull from the provider however many watch, and each profile picks its own length */
    r = await A('GET', '/api/rewind');
    ok(r.status === 200 && r.j.max === 60 && r.j.minutes === 60 && r.j.choices.join() === '15,30,60', 'rewind is on by default: 60 minutes, with 30 and 15 to choose');
    r = await A('PUT', '/api/rewind', { minutes: 20 });
    ok(r.j.minutes === 60, 'a length that is not one of the choices is ignored');
    if (hasFfmpeg) {
      r = await A('POST', '/api/admin/providers', { name: 'Rewind TV', type: 'xtream', url: `http://127.0.0.1:${pport}/`, username: 'u1', password: 'p1', format: 'ts', epg: [] });
      ok(r.status === 200, 'adds a provider that sends raw TS');
      r = await A('GET', '/live/rewind-tv/9001.m3u8?cid=rw1');
      const seg = (r.t || '').match(/9001\/s\d+\.ts\?cid=rw1/);
      ok(r.status === 200 && r.t.includes('#EXTM3U') && seg && !/9001\.ts/.test(r.t.replace(seg[0], '')), 'a raw TS channel is served as HLS made from the buffer');
      ok(/#EXT-X-MEDIA-SEQUENCE:\d+/.test(r.t || ''), 'the playlist says where it starts');
      if (seg) { const sr = await A('GET', '/live/rewind-tv/' + seg[0]); ok(sr.status === 200, 'its video segments are served'); }
      const r2 = await A('GET', '/live/rewind-tv/9001.m3u8?cid=rw2');
      ok(r2.status === 200 && prov.rewindPulls === 1, 'a second viewer of the channel shares the buffer: the provider is pulled once');
      { /* recording: a copy of the buffer that keeps growing, turned into an MP4 when stopped, visible only to the profile that made it */
        await sleep(5000); // let the buffer fill a little
        r = await A('POST', '/api/recordings', { p: 'rewind-tv', s: '9001', back: 4, title: 'Test show' });
        ok(r.status === 200 && r.j.ok && r.j.id, 'a channel with a running buffer can be recorded from a few seconds back');
        const recId = r.j.id;
        r = await A('POST', '/api/recordings', { p: 'rewind-tv', s: '9999' });
        ok(r.status === 409 || r.status === 200, 'asking to record a channel nobody is buffering is answered, not ignored');
        await sleep(5000);
        r = await A('GET', '/api/recordings');
        ok(r.status === 200 && r.j.ready && r.j.running.length === 1 && r.j.items.some((x) => x.id === recId && x.state === 'recording' && x.dur > 0), 'the list shows it recording, and how long it has run');
        r = await A('POST', '/api/recordings/stop', { p: 'rewind-tv', s: '9001' });
        ok(r.j.ok === true, 'it can be stopped');
        let it = null;
        for (let i = 0; i < 40; i++) { await sleep(500); r = await A('GET', '/api/recordings'); it = r.j.items.find((x) => x.id === recId); if (it && it.state !== 'recording' && it.state !== 'finishing') break; }
        ok(it && it.state === 'done' && it.dur >= 8 && it.size > 10000 && it.title === 'Test show' && it.ch, 'once stopped it is finished as an MP4 with its length, size and details');
        const mp4 = path.join(recDir, fs.readdirSync(recDir)[0], 'recordings', recId + '.mp4');
        ok(fs.existsSync(mp4) && fs.readFileSync(mp4).subarray(4, 8).toString() === 'ftyp' && !fs.readdirSync(path.dirname(mp4)).some((f) => /\.rec\.ts$|\.tmp/.test(f)), 'the file on disk is a real MP4 and the working files are gone');
        r = await A('GET', '/rec/' + encodeURIComponent(recId) + '.mp4', undefined, { Range: 'bytes=0-99' });
        ok(r.status === 206, 'the player can ask for part of it (seeking works)');
        r = await A('GET', '/rec/' + encodeURIComponent('../' + recId) + '.mp4');
        ok(r.status === 404, 'a path that tries to leave the profile’s own folder finds nothing');
        ok(require('child_process').spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', mp4]).stdout.toString().split(/\s+/).filter(Boolean).sort().join() === 'audio,video', 'it holds both picture and sound');
        process.env.RECORDINGS_DIR = recDir; const rec = require('../recorder');
        ok(rec.list('someone else').length === 0 && !rec.fileFor('someone else', recId), 'another profile sees none of it');
        r = await A('PUT', '/api/recordings/' + encodeURIComponent(recId) + '/pos', { t: 12 });
        r = await A('GET', '/api/recordings');
        ok(r.j.items.find((x) => x.id === recId).pos === 12, 'where you stopped watching is remembered');
        r = await A('DELETE', '/api/recordings/' + encodeURIComponent(recId), {});
        ok(r.status === 200 && !fs.existsSync(mp4) && (await A('GET', '/api/recordings')).j.items.length === 0, 'a recording can be deleted');
      }
      r = await A('PUT', '/api/rewind', { minutes: 15 });
      ok(r.j.minutes === 15, 'a profile can shorten its rewind to 15 minutes');
      { /* a buffer whose provider has gone silent is replaced, not handed to the next viewer */
        const stall = prov.stallPulls || 0;
        r = await A('GET', '/live/rewind-tv/9003.m3u8?cid=st1');
        ok(r.status === 200 && /s\d+\.ts/.test(r.t || ''), 'a channel that starts fine is buffered');
        let again = false;
        for (let i = 0; i < 40 && !again; i++) { await new Promise((x) => setTimeout(x, 1000)); const q = await A('GET', '/live/rewind-tv/9003.m3u8?cid=st2'); if (q.status === 200 && (prov.stallPulls || 0) > stall + 1) again = true; }
        ok(again, 'once the provider stops sending, the next viewer gets a fresh buffer instead of the stuck one');
        await A('POST', '/api/stop', { p: 'rewind-tv', s: '9003' });
      }
      r = await A('GET', '/api/me');
      ok(r.j.rewind === 15, 'and the page learns it');
      await A('PUT', '/api/rewind', { minutes: 60 });
      r = await A('PUT', '/api/admin/settings', { rewindMinutes: 30 });
      r = await A('GET', '/api/rewind');
      ok(r.j.max === 30 && r.j.minutes === 30 && r.j.choices.join() === '15,30', 'the admin can lower the most anyone may rewind, and it caps every profile');
      r = await A('PUT', '/api/admin/settings', { rewindMinutes: 0 });
      r = await A('GET', '/live/rewind-tv/9001.m3u8?cid=rw3');
      ok(r.status !== 200 || !/s\d+\.ts/.test(r.t || ''), 'with rewind off the server no longer buffers (the player falls back to its own TS path)');
      await A('PUT', '/api/admin/settings', { rewindMinutes: 60 });
      await A('POST', '/api/stop', { all: true });
      r = await A('DELETE', '/api/admin/providers/rewind-tv', {});
    }
    { // the window a viewer is given, and how the disk budget trims it
      const tc = require('../transcode');
      const pl = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:100\n' + Array.from({ length: 10 }, (_, i) => `#EXTINF:2.000000,\ns${100 + i}.ts`).join('\n') + '\n';
      const w = tc.windowPlaylist(pl, 6, 0);
      ok(/MEDIA-SEQUENCE:107/.test(w) && w.includes('s107.ts') && w.includes('s109.ts') && !w.includes('s106.ts'), 'a 6-second window keeps the newest segments and moves the sequence number up');
      ok(!tc.windowPlaylist(pl, 0, 104).includes('s103.ts') && tc.windowPlaylist(pl, 0, 104).includes('s104.ts') && /MEDIA-SEQUENCE:104/.test(tc.windowPlaylist(pl, 0, 104)), 'segments the budget already removed are no longer listed');
      ok(tc.windowPlaylist(pl, 0, 0).split('\n').filter((x) => x.endsWith('.ts')).length === 10, 'no limit shows everything');
    }
    r = await A('POST', '/api/p/movie-list/favorite', { s: gamma.s, on: true });
    ok(r.j.favorites.includes(gamma.s), 'favorites work on M3U channels');
    r = await A('POST', '/api/admin/providers/test', { name: 'Movie List', type: 'm3u', url: `http://127.0.0.1:${pport}/list.m3u` });
    ok(r.j.ok && r.j.channels === 3 && r.j.guide, 'M3U test reports channel count and the playlist guide address');
    r = await A('PUT', '/api/admin/providers/alpha-tv', { name: 'Alpha Renamed', type: 'xtream', url: `http://127.0.0.1:${pport}`, username: 'u1', password: '', epg: ['http://127.0.0.1:1/g.xml'] });
    ok(r.status === 200, 'editing with a blank password keeps the saved one');
    r = await A('GET', '/api/p/alpha-tv/bootstrap');
    ok(r.status === 200, 'provider still works after the edit');
    r = await A('GET', '/api/admin/providers');
    ok(r.j.providers.find((p) => p.id === 'alpha-tv').epg.length === 1, 'guide address saved with the provider');
    /* link a channel to another channel's guide */
    r = await A('PUT', '/api/admin/providers/alpha-tv', { name: 'Alpha Renamed', type: 'xtream', url: `http://127.0.0.1:${pport}`, username: 'u1', password: '', epg: [`http://127.0.0.1:${pport}/guide.xml`] });
    r = await A('PUT', '/api/p/alpha-tv/groups', { groups: ['1', '2'] });
    let gs;
    for (let i = 0; i < 40; i++) { await A('GET', '/api/p/alpha-tv/epg-status'); r = await A('GET', '/api/p/alpha-tv/epg-status'); if (r.j.loadedAt) break; await sleep(150); }
    r = await A('GET', '/api/p/alpha-tv/epg-link?s=102');
    ok(r.status === 200 && r.j.guide === '' && r.j.how === '', 'a channel with no match reports no guide');
    r = await A('POST', '/api/p/alpha-tv/epg-link', { s: '102', from: '101' });
    ok(r.status === 200 && r.j.guide === 'alpha.us' && r.j.how === 'link' && r.j.now === 'Alpha Now', 'copying another channel’s guide takes effect at once');
    r = await A('GET', '/api/p/alpha-tv/epg-grid?ids=102');
    ok(r.j['102'].length === 1 && r.j['102'][0][2] === 'Alpha Now', 'the guide grid then shows the copied listings');
    ok(JSON.parse(fs.readFileSync(path.join(dir, 'epgmap.json'), 'utf8'))['alpha-tv']['102'] === 'alpha.us', 'the link is saved in epgmap.json');
    r = await A('POST', '/api/p/alpha-tv/epg-link', { s: '101', from: '102' });
    ok(r.status === 200 && r.j.guide === 'alpha.us', 'copying from a channel that has its own guide works both ways');
    r = await A('POST', '/api/p/alpha-tv/epg-link', { s: '102', from: '999999' });
    ok(r.status === 404, 'copying from an unknown channel is refused');
    /* movies and shows */
    r = await A('GET', '/api/p/alpha-tv/vod-cats');
    ok(r.status === 200 && r.j.supported && r.j.movies.length === 2 && r.j.movies[0].name === 'ACTION 4K' && r.j.movies[0].count === 1 && r.j.shows.length === 1 && r.j.movieTotal === 3, 'movie and show categories come back with plain names and counts');
    r = await A('GET', '/api/p/alpha-tv/vod-list?kind=movie&cat=11&sort=rating');
    ok(r.j.total === 2 && r.j.items[0].n === 'Big Laughs' && r.j.items[1].n === 'Funny Day', 'a category lists its titles, best rated first');
    r = await A('GET', '/api/p/alpha-tv/vod-list?kind=movie&q=big&sort=new');
    ok(r.j.total === 2 && r.j.items[0].n === 'Big Heist (2019)' && r.j.items.some((m) => m.n === 'Big Heist (2019)' && m.e === 'mkv'), 'searching by words finds titles across categories, and a country prefix is dropped');
    r = await A('GET', '/api/p/alpha-tv/vod-list?kind=movie&lim=1&off=1&sort=az');
    ok(r.j.total === 3 && r.j.items.length === 1 && r.j.items[0].n === 'Big Laughs', 'titles are paged');
    r = await A('GET', '/api/p/alpha-tv/vod-list?kind=movie&sort=year');
    ok(r.status === 200 && r.j.items.length === 3 && r.j.items.every((m, i, a) => !i || (parseInt(a[i - 1].y, 10) || 0) >= (parseInt(m.y, 10) || 0)), 'titles can be sorted newest release first');
    r = await A('GET', '/api/p/alpha-tv/vod-info?kind=movie&id=501');
    ok(r.j.plot === 'A heist.' && r.j.mins === 120 && r.j.e === 'mkv' && r.j.video === 'h264', 'a movie’s details come back');
    r = await A('GET', '/api/p/alpha-tv/vod-info?kind=show&id=601');
    ok(r.j.seasons.length === 2 && r.j.seasons[0].eps[0].id === '9001' && r.j.seasons[0].eps[1].e === 'mkv', 'a show’s seasons and episodes come back in order');
    r = await A('GET', '/api/p/alpha-tv/vod-info?kind=movie&id=abc');
    ok(r.status === 400, 'a bad title id is refused');
    r = await A('GET', '/vod/alpha-tv/movie/501.mkv', undefined, { Range: 'bytes=5-9' });
    ok(r.status === 206 && r.t === '56789', 'a movie file is passed through with range requests');
    r = await A('GET', '/vod/alpha-tv/show/9001.mp4');
    ok(r.status === 200, 'an episode file plays');
    r = await A('POST', '/api/downloads', { p: 'alpha-tv', kind: 'movie', id: '501', ext: 'mkv', title: 'Big Heist', year: '2019' });
    const dlId = r.j && r.j.id;
    ok(r.status === 200 && dlId === 'Big Heist (2019).mkv', 'a movie download starts with a clean file name');
    for (let i = 0; i < 40; i++) { r = await A('GET', '/api/downloads'); if (r.j.items[0] && r.j.items[0].state === 'done') break; await new Promise((x) => setTimeout(x, 100)); }
    ok(r.j.ready && r.j.items.length === 1 && r.j.items[0].state === 'done' && r.j.items[0].size === 20, 'the download finishes and is listed with its size');
    r = await A('GET', '/dl/' + encodeURIComponent(dlId), undefined, { Range: 'bytes=5-9' });
    ok(r.status === 206 && r.t === '56789', 'a downloaded file plays with range requests');
    r = await A('GET', '/dl/' + encodeURIComponent('../' + dlId));
    ok(r.status === 404, 'a downloaded file can’t be reached by a path trick');
    r = await A('POST', '/api/downloads', { p: 'alpha-tv', kind: 'movie', id: '501', ext: 'mkv', title: 'Big Heist', year: '2019' });
    ok(r.status === 200 && r.j.again && (await A('GET', '/api/downloads')).j.items.length === 1, 'asking for the same title again does not copy it twice');
    r = await A('POST', '/api/downloads', { p: 'alpha-tv', kind: 'show', id: '9001', ext: 'mp4', title: 'Some Show', season: 1, ep: 2, epTitle: 'Pilot' });
    ok(r.status === 200 && r.j.id === 'Some Show - S01E02 - Pilot.mp4', 'an episode download is named show, season and episode');
    r = await A('PUT', '/api/downloads/' + encodeURIComponent(dlId) + '/pos', { t: 77 });
    ok(r.j.ok && (await A('GET', '/api/downloads')).j.items.find((x) => x.id === dlId).pos === 77, 'where you stopped in a download is remembered');
    r = await A('POST', '/api/downloads', { p: 'nope', kind: 'movie', id: '1', ext: 'mkv', title: 'x' });
    ok(r.status === 400, 'a download from an unknown provider is refused');
    r = await A('DELETE', '/api/downloads/' + encodeURIComponent(dlId), {});
    ok(r.status === 200 && !(await A('GET', '/dl/' + encodeURIComponent(dlId))).status !== 404 && (await A('GET', '/dl/' + encodeURIComponent(dlId))).status === 404, 'a download can be deleted');
    await A('DELETE', '/api/downloads/' + encodeURIComponent('Some Show - S01E02 - Pilot.mp4'), {});
    ok(fs.existsSync(path.join(dir, 'cache', 'vod-alpha-tv-movie.json')), 'the movie catalog is kept on disk');
    r = await A('POST', '/api/p/alpha-tv/epg-link', { s: '102', clear: true });
    ok(r.status === 200 && r.j.how === '' && !fs.existsSync(path.join(dir, 'epgmap.json')) || (r.status === 200 && r.j.how === ''), 'removing the link goes back to automatic matching');
    r = await A('DELETE', '/api/admin/providers/third', {});
    ok(r.status === 200 && r.j.providers.length === 3, 'removes a provider');
    r = await A('GET', '/api/p/third/bootstrap');
    ok(r.status === 404, 'a removed provider is gone');
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'providers.json'), 'utf8'));
    ok(saved.providers.length === 3, 'providers.json was updated on disk');

    console.log('recovery key and backups');
    {
      const crypto = require('crypto');
      const raw = fs.readFileSync(path.join(dir, 'providers.json'), 'utf8');
      ok(raw.includes('enc:v1:') && !raw.includes('"p1"') && !raw.includes('"u1"') && !raw.includes('tablo-pass') && !raw.includes('me@example.com') && !raw.includes('list.m3u'), 'provider logins and playlist addresses are stored encrypted');
      ok(JSON.parse(raw).providers.some((e) => e.type === 'hdhr' && /^http:\/\/127/.test(e.url)), 'an address that holds no login stays readable');
      r = await A('GET', '/api/admin/providers');
      const al = r.j.providers.find((x) => x.id === 'alpha-tv');
      ok(al && al.username === 'u1' && al.hasPassword && al.live && !JSON.stringify(r.j).includes('enc:v1:') && !JSON.stringify(r.j).includes('"p1"'), 'the admin screen still shows the username, never the password, and nothing encrypted');
      r = await A('PUT', '/api/admin/providers/alpha-tv', { name: 'Alpha TV', type: 'xtream', url: '', username: '', password: '', epg: ['http://127.0.0.1:1/guide.xml?user=zz&pass=secret99'] });
      ok(r.status === 200 && r.j.providers.find((x) => x.id === 'alpha-tv').epg[0].includes('secret99'), 'a guide address with a login saves and reads back');
      const st = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');
      ok(!st.includes('secret99') && st.includes('enc:v1:'), 'guide addresses are stored encrypted');
      r = await A('GET', '/api/admin/providers');
      ok(r.j.providers.find((x) => x.id === 'alpha-tv').live, 'saving with blank login fields keeps the saved login');
      r = await A('POST', '/api/admin/backup/key', { password: 'wrong-password-1' });
      ok(r.status === 403, 'the recovery key is not shown without the password');
      r = await A('POST', '/api/admin/backup/key', { password: 'a-new-password-1' });
      const rk = r.j && r.j.key;
      ok(r.status === 200 && /^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/.test(rk || '') && r.j.source === 'file', 'an admin can read the recovery key after typing their password');
      ok(fs.readFileSync(path.join(dir, 'recovery.key'), 'utf8').trim() === rk.replace(/-/g, '') && (fs.statSync(path.join(dir, 'recovery.key')).mode & 0o077) === 0, 'the key is kept in the config folder, owner only, when no environment variable is set');
      r = await A('GET', '/api/admin/backup');
      ok(r.j.source === 'file' && r.j.ready && r.j.locked.providers === 0 && r.j.files.length === 0 && r.j.auto === false, 'the backup page reports where the key is and that the storage folder is ready');
      r = await A('POST', '/api/admin/backup/save', {});
      const bkName = r.j && r.j.name;
      ok(r.status === 200 && /^zibbit-backup-\d{8}-\d{6}\.zbk$/.test(bkName || '') && fs.existsSync(path.join(recDir, 'zibbit-backups', bkName)), 'a backup is saved in the storage folder');
      const bkText = fs.readFileSync(path.join(recDir, 'zibbit-backups', bkName), 'utf8');
      ok(JSON.parse(bkText).zibbit === 'backup' && !bkText.includes('p1') && !bkText.includes('Alpha') && !bkText.includes('admin'), 'the backup file reveals nothing without the key');
      r = await A('POST', '/api/admin/backup/download', {});
      ok(r.status === 200 && r.j.backup.zibbit === 'backup' && /\.zbk$/.test(r.j.name), 'a backup can be downloaded');
      const dl = r.j.backup;
      // a backup made outside the server, to try the checks
      const pack = (files, key) => { const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', crypto.scryptSync(key.replace(/-/g, ''), salt, 32), iv); const data = Buffer.concat([c.update(JSON.stringify({ files }), 'utf8'), c.final()]); return { zibbit: 'backup', v: 1, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') }; };
      r = await A('POST', '/api/admin/backup/restore', { password: 'wrong-password-1', key: rk, file: bkName });
      ok(r.status === 403, 'restoring needs the password');
      r = await A('POST', '/api/admin/backup/restore', { password: 'a-new-password-1', key: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH', file: bkName });
      ok(r.status === 400 && /key/.test(r.j.error), 'the wrong key does not open a backup');
      r = await A('POST', '/api/admin/backup/restore', { password: 'a-new-password-1', key: rk, backup: { hello: 1 } });
      ok(r.status === 400, 'something that is not a backup is refused');
      r = await A('POST', '/api/admin/backup/restore', { password: 'a-new-password-1', key: rk, file: '../../etc/passwd' });
      ok(r.status === 400, 'a restore can only name a backup in the storage folder');
      r = await A('POST', '/api/admin/backup/restore', { password: 'a-new-password-1', key: rk, backup: pack({ 'providers.json': '{"providers":[]}' }, rk) });
      ok(r.status === 400 && /admin/.test(r.j.error), 'a backup with no admin account is refused, so nobody is locked out');
      r = await A('POST', '/api/admin/backup/restore', { password: 'a-new-password-1', key: rk, backup: pack({ 'evil.sh': 'x', 'users.json': '{}' }, rk) });
      ok(r.status === 400, 'a backup holding unexpected files is refused');
      r = await A('GET', '/api/admin/providers');
      ok(r.j.providers.length === 3, 'refused restores changed nothing');
      r = await A('POST', '/api/admin/providers', { name: 'Temp', type: 'xtream', url: `http://127.0.0.1:${pport}`, username: 'tmp', password: 'tmp-pass' });
      ok(r.status === 200 && (await A('GET', '/api/admin/providers')).j.providers.length === 4, 'a provider added after the backup');
      r = await A('POST', '/api/admin/backup/restore', { password: 'a-new-password-1', key: rk, file: bkName });
      ok(r.status === 200 && r.j.ok && /^zibbit-before-restore-/.test(r.j.before), 'restoring from the storage folder works and saves what was there first');
      r = await A('GET', '/api/admin/providers');
      ok(r.j.providers.length === 3 && !r.j.providers.some((x) => x.name === 'Temp') && r.j.providers.find((x) => x.id === 'alpha-tv').live && r.j.providers.find((x) => x.id === 'alpha-tv').epg[0].includes('secret99'), 'the server is back to the backup: providers, logins and guide address');
      r = await A('GET', '/api/me');
      ok(r.status === 200 && r.j.role === 'admin', 'the person who restored is still signed in');
      ok(!fs.readFileSync(path.join(dir, 'providers.json'), 'utf8').includes('"p1"'), 'what a restore writes is encrypted too');
      r = await A('POST', '/api/admin/backup/restore', { password: 'a-new-password-1', key: rk.toLowerCase().replace(/-/g, ' '), backup: dl });
      ok(r.status === 200, 'a downloaded backup restores, and the key is accepted in any case and spacing');
      r = await A('PUT', '/api/admin/settings', { backupAuto: true, backupKeep: 3 });
      r = await A('GET', '/api/admin/backup');
      ok(r.j.auto === true && r.j.keep === 3 && r.j.files.some((x) => x.kind === 'before-restore') && r.j.files.some((x) => x.kind === 'backup'), 'the backup page lists what is saved and the automatic setting');
      r = await A('PUT', '/api/admin/settings', { backupAuto: false });
    }

    console.log('people and roles');
    r = await A('POST', '/api/admin/users', { name: 'Casey', password: 'temp-pass-123', role: 'user' });
    ok(r.status === 200, 'adds a regular user');
    r = await A('POST', '/api/admin/users', { name: 'casey', password: 'temp-pass-123' });
    ok(r.status === 409, 'duplicate names (any case) are refused');
    const U = client();
    r = await U('POST', '/api/login', { name: 'Casey', password: 'temp-pass-123' });
    ok(r.status === 200, 'the new user signs in');
    r = await U('GET', '/api/p/alpha-tv/bootstrap');
    ok(r.status === 403 && r.j.mustChange, 'a temporary password forces a change first');
    r = await U('POST', '/api/password', { current: 'temp-pass-123', next: 'casey-own-pass-9' });
    ok(r.status === 200, 'the user picks their own password');
    {
      const U2 = client();
      r = await U2('POST', '/api/login', { name: 'Casey', password: 'casey-own-pass-9' });
      ok(r.status === 200 && (await U2('GET', '/api/providers')).status === 200 && (await U('GET', '/api/providers')).status === 200, 'a second device signs in alongside the first');
      r = await U2('POST', '/api/signout-everywhere', {});
      ok(r.status === 200, 'Sign out everywhere is accepted');
      ok((await U2('GET', '/api/providers')).status === 200, 'the device that asked stays signed in');
      ok((await U('GET', '/api/providers')).status === 401, 'every other device is signed out');
      r = await U('POST', '/api/login', { name: 'Casey', password: 'casey-own-pass-9' });
      ok(r.status === 200 && (await U('GET', '/api/providers')).status === 200, 'signing in again works');
      ok((await A('GET', '/api/providers')).status === 200, 'it does not sign anyone else out');
      r = await fetch(base + '/api/signout-everywhere', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
      ok(r.status === 401, 'it needs a sign-in');
    }
    r = await U('POST', '/api/p/alpha-tv/epg-link', { s: '102', from: '101' });
    ok(r.status === 403, 'a regular user cannot change which guide a channel uses');
    r = await U('GET', '/api/admin/users');
    ok(r.status === 403, 'a regular user cannot open admin endpoints (users)');
    for (const [m, p, b] of [['GET', '/api/admin/providers'], ['POST', '/api/admin/providers', { name: 'x', url: 'http://a' }], ['GET', '/api/admin/settings'], ['PUT', '/api/admin/settings', { stripSuperscripts: true }], ['DELETE', '/api/admin/providers/alpha-tv', {}], ['POST', '/api/admin/users/casey/password', { password: 'zzzzzzzz1' }], ['GET', '/api/admin/backup'], ['POST', '/api/admin/backup/key', { password: 'x' }], ['POST', '/api/admin/backup/save', {}], ['POST', '/api/admin/backup/download', {}], ['POST', '/api/admin/backup/restore', {}]]) {
      r = await U(m, p, b);
      ok(r.status === 403, `a regular user is refused: ${m} ${p}`);
    }
    r = await U('GET', '/api/me');
    ok(r.j.role === 'user', '/api/me says user');
    r = await U('PUT', '/api/p/alpha-tv/groups', { groups: ['1'] });
    ok(r.status === 200, 'a user can still choose their own groups');
    r = await U('POST', '/api/p/alpha-tv/favorite', { s: '101', on: true });
    ok(r.status === 200, 'and favorites');
    r = await A('GET', '/api/p/alpha-tv/bootstrap');
    ok(!r.j.favorites.includes('101'), 'favorites are separate per person');
    // hide and reorder: a person's own view of a provider
    r = await A('GET', '/api/p/movie-list/channels?cat=Movies');
    const mv = r.j.items.map((x) => x.s);
    ok(mv.length === 2, 'the movie group lists its channels in the provider order');
    r = await A('POST', '/api/p/movie-list/customize', { op: 'order', cat: 'Movies', ids: [mv[1], mv[0]] });
    ok(r.status === 200, 'a person can set their own order for a group');
    r = await A('GET', '/api/p/movie-list/channels?cat=Movies');
    ok(r.j.items[0].s === mv[1] && r.j.items[1].s === mv[0], 'the group now lists in that order');
    r = await U('PUT', '/api/p/movie-list/groups', { groups: ['Movies'] });
    r = await U('GET', '/api/p/movie-list/channels?cat=Movies');
    ok(r.j.items[0].s === mv[0], 'another person still sees the provider order');
    r = await A('POST', '/api/p/movie-list/customize', { op: 'hide', ids: [mv[1]] });
    r = await A('GET', '/api/p/movie-list/channels?cat=Movies');
    ok(r.j.items.length === 1 && r.j.hiddenCount === 1 && r.j.items[0].s === mv[0], 'a hidden channel leaves the group and is counted');
    r = await A('PUT', '/api/p/movie-list/groups', { groups: ['Movies'] });
    r = await A('GET', '/api/p/movie-list/channels?q=delta');
    ok(r.j.items.length === 0, 'search skips hidden channels');
    r = await A('GET', '/api/p/movie-list/channels?cat=__all__');
    ok(r.j.items.length === 1 && r.j.hiddenCount === 1 && r.j.items[0].s === mv[0], 'a channel hidden in its group is also left out of All channels, and counted as hidden');
    r = await U('GET', '/api/p/movie-list/channels?cat=Movies');
    ok(r.j.items.length === 2, 'another person still sees the hidden channel');
    r = await A('GET', '/api/p/movie-list/channels?cat=Movies&hidden=1');
    ok(r.j.items.length === 1 && r.j.items[0].s === mv[1], 'the hidden list can be read back');
    r = await A('POST', '/api/p/movie-list/customize', { op: 'show', ids: [mv[1]] });
    r = await A('GET', '/api/p/movie-list/channels?cat=Movies');
    ok(r.j.items.length === 2 && r.j.items[0].s === mv[1], 'showing a channel again puts it back where the order says');
    r = await A('POST', '/api/p/movie-list/customize', { op: 'reset', cat: 'Movies' });
    r = await A('GET', '/api/p/movie-list/channels?cat=Movies');
    ok(r.j.items[0].s === mv[0], 'reset returns the provider order');
    r = await A('POST', '/api/p/movie-list/customize', { op: 'order', cat: 'Movies', ids: ['999999', mv[1], mv[1]] });
    r = await A('GET', '/api/p/movie-list/channels?cat=Movies');
    ok(r.j.items.length === 2 && r.j.items[0].s === mv[1], 'unknown and repeated ids in an order are ignored; unplaced channels follow');
    r = await A('POST', '/api/p/movie-list/customize', { op: 'bogus', ids: [] });
    ok(r.status === 400, 'unknown change types are refused');
    r = await A('POST', '/api/p/movie-list/favorite', { s: mv[0], on: true });
    r = await A('POST', '/api/p/movie-list/favorite', { s: mv[1], on: true });
    r = await A('GET', '/api/p/movie-list/channels?fav=1');
    ok(r.j.items[0].s === mv[1], 'favorites list newest first');
    r = await A('POST', '/api/p/movie-list/customize', { op: 'favorites', ids: [mv[0], mv[1]] });
    r = await A('GET', '/api/p/movie-list/channels?fav=1');
    ok(r.j.items[0].s === mv[0] && r.j.items.length === 2, 'favorites can be reordered');
    r = await A('POST', '/api/p/movie-list/customize', { op: 'favorites', ids: ['999999'] });
    r = await A('GET', '/api/p/movie-list/channels?fav=1');
    ok(r.j.items.length === 2, 'reordering favorites cannot add or drop any');
    r = await A('POST', '/api/admin/users/Casey/password', { password: 'reset-by-admin-1' });
    ok(r.status === 200, 'admin sets a user password');
    r = await U('GET', '/api/me');
    ok(r.status === 401, 'that signs the user out everywhere');
    const U2 = client();
    r = await U2('POST', '/api/login', { name: 'Casey', password: 'reset-by-admin-1' });
    r = await U2('POST', '/api/password', { current: 'reset-by-admin-1', next: 'casey-own-pass-9' });
    ok(r.status === 200, 'user changes it again');
    r = await A('POST', '/api/admin/users/admin/password', { password: 'something-else-1' });
    ok(r.status === 400, 'admins change their own password via Change password, not the admin screen');
    r = await A('PUT', '/api/admin/users/admin', { role: 'user' });
    ok(r.status === 400, 'the last admin cannot be demoted');
    r = await A('DELETE', '/api/admin/users/admin', {});
    ok(r.status === 400, 'you cannot remove yourself');
    r = await A('PUT', '/api/admin/users/Casey', { role: 'admin' });
    ok(r.status === 200, 'promote a user');
    r = await A('PUT', '/api/admin/users/admin', { role: 'user' });
    ok(r.status === 200, 'with two admins, one can be demoted');
    r = await A('GET', '/api/admin/users');
    ok(r.status === 403, 'a demoted admin loses access immediately');
    r = await U2('PUT', '/api/admin/users/admin', { role: 'admin' });
    ok(r.status === 200, 'the other admin restores it');
    r = await U2('DELETE', '/api/admin/users/Casey', {});
    ok(r.status === 400, 'admins cannot remove their own account');
    r = await A('DELETE', '/api/admin/users/Casey', {});
    ok(r.status === 200, 'admin removes another account');

    console.log('settings');
    r = await A('GET', '/api/admin/settings');
    ok(r.status === 200 && r.j.you === '127.0.0.1', 'settings load and show your address');
    r = await A('PUT', '/api/admin/settings', { trimFromNames: ['US:', 'RAW'], stripSuperscripts: true, epgRefreshHours: 6, lockUserFails: 3 });
    ok(r.status === 200, 'name cleanup and lockout settings save');
    r = await A('GET', '/api/p/alpha-tv/channels?cat=1');
    ok(r.j.items[0].n === 'Alpha News', 'name cleanup applies immediately, without a restart');
    {
      const g1 = r.j, g2 = await A('GET', '/api/p/alpha-tv/channels?cat=2'), all = await A('GET', '/api/p/alpha-tv/channels?cat=__all__');
      ok(all.status === 200 && all.j.total === g1.total + g2.j.total && all.j.items[0].s === g1.items[0].s && all.j.items.slice(-1)[0].s === g2.j.items.slice(-1)[0].s, '"All channels" lists every ticked group together, in the person’s group order');
    }
    r = await A('PUT', '/api/admin/settings', { adminAllow: ['203.0.113.0/24'] });
    ok(r.status === 200 && /IPv4/.test(r.j.warning), 'an address rule is saved (loopback and home-network addresses are always allowed) and warns about IPv6');
    r = await A('PUT', '/api/admin/settings', { adminAllow: ['not-an-address'] });
    ok(r.status === 400, 'a bad rule is refused');
    const s = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    ok(s.trimFromNames === 'US:,RAW' && s.epg && s.epg['alpha-tv'], 'settings.json keeps names and guide addresses together');
    console.log('adult lock');
    {
      const ad = require('../adult');
      const mt = ad.wordMatcher(ad.DEFAULT_WORDS);
      ok(mt('XXX - Late') && mt('ADULT: Movies') && mt('Movies 18+') && mt('┃ADULT┃ Shows') && !mt('Adulthood') && !mt('Adult Swim') && !mt('Sports'), 'adult words match whole words in group names; Adult Swim and Adulthood do not');
      ok(mt('FOR ADULTS') && mt('Xxx Movies') && !mt('NETFLIX ADULT-SWIM') && !mt('DISNEY+ ADULT SWIM') && !mt('HBO MAX (ADULT SWIM)') && !mt('Adultery drama'), 'a plural matches ("FOR ADULTS"); Adult Swim with a hyphen or brackets is still exempt');
      ok(ad.groupLocked({ 'live:2': true }, 'live', '2', 'Sports', mt) === true && ad.groupLocked({ 'live:9': false }, 'live', '9', 'XXX - Late', mt) === false && ad.groupLocked({}, 'live', '9', 'XXX - Late', mt) === true, 'an admin’s mark beats the name, either way');
      const rec = ad.hashPin('4821');
      ok(ad.checkPin(rec, '4821') && !ad.checkPin(rec, '4822') && !ad.checkPin(rec, 'abcd') && !JSON.stringify(rec).includes('4821'), 'a PIN is stored hashed and checked');
      let t = 1000; const lk = ad.makeLockout({ max: 2, baseMs: 1000, now: () => t });
      lk.fail('k'); ok(lk.wait('k') === 0, 'one miss does not lock');
      lk.fail('k'); ok(lk.wait('k') === 1, 'the second miss locks for the base time');
      t += 1500; ok(lk.wait('k') === 0, 'the lock ends');
      lk.fail('k'); ok(lk.wait('k') === 2, 'after a lock, a single miss locks again for twice as long');
      lk.ok('k'); lk.fail('k'); ok(lk.wait('k') === 0, 'a right PIN starts over');
      let u0 = 0; const ul = ad.makeUnlocks({ idleMs: 3600000, now: () => u0 });
      ul.unlock('dev', 'Dana');
      ok(ul.is('dev', 'Dana') && !ul.is('dev', 'Alex') && !ul.is('other', 'Dana'), 'an unlock belongs to one profile on one device');
      u0 = 50 * 60000; ul.touch('dev', 'Dana'); u0 = 100 * 60000;
      ok(ul.is('dev', 'Dana'), 'activity pushes the idle timer back');
      u0 = 170 * 60000; ok(!ul.is('dev', 'Dana'), 'it locks after the idle time');
      const ul2 = ad.makeUnlocks({ idleMs: 3600000, now: () => u0 }); u0 = 0; ul2.unlock('d', 'Dana');
      for (let k = 1; k <= 15; k++) { u0 = k * 50 * 60000; ul2.touch('d', 'Dana'); }
      ok(!ul2.is('d', 'Dana'), 'the 12 hour ceiling re-locks even with constant activity');
    }
    r = await A('POST', '/api/admin/users', { name: 'Dana', password: 'dana-password-1', mustChange: false });
    ok(r.status === 200, 'a second profile for the lock tests');
    const D = client(); await D('POST', '/api/login', { name: 'Dana', password: 'dana-password-1' });
    r = await A('POST', '/api/p/alpha-tv/favorite', { s: '102', on: true });
    ok(r.status === 200, 'a favorite in the group that will be locked');
    r = await A('PUT', '/api/admin/adult/groups', { p: 'alpha-tv', kind: 'live', id: '2', locked: true });
    ok(r.status === 200, 'an admin marks a live group as adult');
    r = await A('PUT', '/api/admin/adult/groups', { p: 'alpha-tv', kind: 'movie', id: '11', locked: true });
    ok(r.status === 200, 'and a movie category');
    r = await A('GET', '/api/admin/adult/groups?p=alpha-tv');
    ok(r.status === 200 && r.j.live.find((c) => c.id === '2').locked && r.j.live.find((c) => c.id === '2').mark === true && !r.j.live.find((c) => c.id === '1').locked && r.j.movie.find((c) => c.id === '11').locked, 'the admin list shows what is locked and why');
    r = await A('GET', '/api/p/alpha-tv/bootstrap');
    ok(r.j.adult && r.j.adult.on === false && !r.j.categories.some((c) => c.lock) && r.j.favorites.includes('102'), 'marks do nothing while the lock is switched off');
    r = await A('PUT', '/api/admin/settings', { adultLock: true });
    ok(r.status === 400 && r.j.needPin, 'switching the lock on first asks for your PIN');
    r = await A('POST', '/api/adult/pin', { password: 'wrong-password', pin: '4821' });
    ok(r.status === 403, 'setting a PIN needs the account password');
    r = await A('POST', '/api/adult/pin', { password: 'a-new-password-1', pin: '48a1' });
    ok(r.status === 400, 'a PIN is four digits');
    r = await A('POST', '/api/adult/pin', { password: 'a-new-password-1', pin: '4821' });
    ok(r.status === 200 && r.j.hasPin, 'the PIN is set');
    r = await A('PUT', '/api/admin/settings', { adultLock: true });
    ok(r.status === 200, 'the lock is switched on');
    r = await A('GET', '/api/p/alpha-tv/bootstrap');
    ok(r.j.adult.on && r.j.adult.open && r.j.categories.find((c) => c.id === '2').lock === 1 && r.j.favorites.includes('102'), 'right after setting the PIN you are unlocked: lock icons shown, nothing hidden');
    if (require('child_process').spawnSync('ffmpeg', ['-version']).status === 0) { // a tuner's video segments follow the same lock as everything else
      r = await A('GET', '/api/p/antenna/channels?cat=Antenna');
      const tch = r.j.items[0];
      r = await A('PUT', '/api/admin/adult/groups', { p: 'antenna', kind: 'live', id: 'Antenna', locked: true });
      r = await A('GET', `/live/antenna/${tch.s}.m3u8?cid=lk1`);
      const sg = (r.t || '').match(new RegExp(`${tch.s}/s\\d+\\.ts\\?cid=lk1`));
      ok(r.status === 200 && sg, 'unlocked: the tuner channel plays and gives a segment address');
      if (sg) {
        r = await A('GET', '/live/antenna/' + sg[0]);
        ok(r.status === 200, 'unlocked: the segment is served');
        await A('POST', '/api/adult/lock', {});
        r = await A('GET', '/live/antenna/' + sg[0]);
        ok(r.status === 403, 'locked: the same segment is refused');
      }
      await A('POST', '/api/stop', { p: 'antenna', s: tch.s, cid: 'lk1' });
      await A('PUT', '/api/admin/adult/groups', { p: 'antenna', kind: 'live', id: 'Antenna', locked: null });
      r = await A('POST', '/api/adult/unlock', { pin: '4821' });
      ok(r.status === 200, 'unlocked again for the rest of the tests');
    }
    r = await A('POST', '/api/adult/lock', {});
    ok(r.status === 200 && r.j.open === false, 'Lock adult content');
    r = await A('GET', '/api/p/alpha-tv/bootstrap');
    ok(r.j.categories.find((c) => c.id === '2').lock === 1 && !r.j.favorites.includes('102'), 'locked: the group is still listed, and the favorite in it is gone');
    r = await A('GET', '/api/p/alpha-tv/channels?cat=2');
    ok(r.j.locked === true && r.j.items.length === 0, 'locked: a locked group shows no channels');
    r = await A('GET', '/api/p/alpha-tv/channels?q=beta&scope=all');
    ok(r.j.items.length === 0, 'locked: search does not find them either');
    r = await A('GET', '/api/p/alpha-tv/channels?fav=1');
    ok(!r.j.items.some((c) => c.s === '102'), 'locked: the favorites list leaves them out');
    r = await A('GET', '/api/p/alpha-tv/channel?s=102');
    ok(r.status === 403, 'locked: the channel itself is refused');
    r = await A('GET', '/api/p/alpha-tv/epg?s=102');
    ok(r.status === 403, 'locked: so is its guide');
    r = await A('GET', '/live/alpha-tv/102.m3u8?cid=t1');
    ok(r.status === 403 && r.j && r.j.locked, 'locked: its stream is refused, even by direct address');
    r = await A('GET', '/api/p/alpha-tv/vod-list?kind=movie&cat=11');
    ok(r.j.locked === true && r.j.items.length === 0, 'locked: a movie category is empty');
    r = await A('GET', '/api/p/alpha-tv/vod-list?kind=movie&q=funny');
    ok(r.j.items.length === 0, 'locked: movie search leaves it out');
    r = await A('GET', '/api/p/alpha-tv/vod-list?kind=movie&sort=new');
    ok(!r.j.items.some((m) => m.id === '502') && r.j.items.some((m) => m.id === '501'), 'locked: Recently added leaves it out, other movies stay');
    r = await A('GET', '/api/p/alpha-tv/vod-info?kind=movie&id=502');
    ok(r.status === 403, 'locked: its details are refused');
    r = await A('GET', '/vod/alpha-tv/movie/502.mp4');
    ok(r.status === 403, 'locked: its file is refused, even by direct address');
    r = await A('GET', '/vod/alpha-tv/movie/501.mkv');
    ok(r.status === 200, 'other movies still play');
    r = await A('POST', '/api/p/alpha-tv/vod-held', { movie: ['501', '502'], show: [] });
    ok(r.j.movie.length === 1 && r.j.movie[0] === '502', 'Continue watching can ask which remembered titles are held back');
    r = await A('POST', '/api/adult/unlock', { pin: '0000' });
    ok(r.status === 403 && r.j.left === 2, 'a wrong PIN is refused and says how many tries are left');
    r = await D('GET', '/api/p/alpha-tv/bootstrap');
    ok(r.j.adult.on && !r.j.adult.open && !r.j.adult.hasPin, 'another profile starts locked, with no PIN yet');
    r = await D('POST', '/api/adult/unlock', { pin: '4821' });
    ok(r.status === 409 && r.j.needPin, 'and cannot get in with someone else’s PIN');
    r = await A('POST', '/api/adult/unlock', { pin: '4821' });
    ok(r.status === 200 && r.j.open, 'the right PIN unlocks');
    r = await A('GET', '/api/p/alpha-tv/channels?cat=2');
    ok(!r.j.locked && r.j.items.some((c) => c.s === '102'), 'unlocked: the group’s channels show');
    r = await A('GET', '/api/p/alpha-tv/bootstrap');
    ok(r.j.favorites.includes('102'), 'unlocked: the favorite is back');
    r = await A('GET', '/api/p/alpha-tv/vod-info?kind=movie&id=502');
    ok(r.status === 200, 'unlocked: movie details load');
    r = await A('GET', '/vod/alpha-tv/movie/502.mp4');
    ok(r.status === 200, 'unlocked: the file plays');
    await A('POST', '/api/logout', {}); await A('POST', '/api/login', { name: 'admin', password: 'a-new-password-1' });
    r = await A('GET', '/api/p/alpha-tv/bootstrap');
    ok(!r.j.adult.open, 'a new sign-in on the same profile starts locked');
    // wrong guesses lock out, an admin can clear it
    r = await D('POST', '/api/adult/pin', { password: 'dana-password-1', pin: '1111' });
    ok(r.status === 200, 'Dana sets her own PIN');
    await D('POST', '/api/adult/lock', {});
    for (let i = 0; i < 3; i++) r = await D('POST', '/api/adult/unlock', { pin: '2222' });
    ok(r.status === 429 && r.j.wait > 0, 'three wrong PINs lock her out for a while');
    r = await D('POST', '/api/adult/unlock', { pin: '1111' });
    ok(r.status === 429, 'even the right PIN is refused during the lockout');
    r = await D('POST', '/api/admin/users/Dana/pin', { action: 'clear' });
    ok(r.status === 403, 'a regular user cannot clear lockouts');
    r = await A('POST', '/api/admin/users/Dana/pin', { action: 'clear' });
    ok(r.status === 200, 'an admin clears the lockout');
    r = await D('POST', '/api/adult/unlock', { pin: '1111' });
    ok(r.status === 200, 'and her PIN still works');
    r = await A('GET', '/api/admin/users');
    ok(r.j.adultLock && r.j.users.find((u) => u.name === 'Dana').hasPin, 'user management shows who has a PIN');
    r = await A('POST', '/api/admin/users/Dana/pin', { action: 'reset' });
    ok(r.status === 200, 'an admin resets her PIN');
    r = await D('GET', '/api/p/alpha-tv/bootstrap');
    ok(!r.j.adult.open && !r.j.adult.hasPin, 'she is locked again and has no PIN');
    r = await A('POST', '/api/admin/users/admin/pin', { action: 'clear' });
    ok(r.status === 403 && r.j.needPassword, 'an admin clearing their own lockout needs their password');
    r = await A('POST', '/api/admin/users/admin/pin', { action: 'clear', password: 'a-new-password-1' });
    ok(r.status === 200, 'with it, they can');
    r = await A('PUT', '/api/admin/settings', { adultLock: false });
    ok(r.status === 403, 'switching the lock off needs the PIN');
    r = await A('PUT', '/api/admin/settings', { adultLock: false, adultPin: '4821' });
    ok(r.status === 200, 'with the PIN it switches off');
    r = await A('GET', '/api/p/alpha-tv/bootstrap');
    ok(!r.j.adult.on && !r.j.categories.some((c) => c.lock) && r.j.favorites.includes('102'), 'switched off: nothing is held back any more');
    // VOD group selection
    r = await A('GET', '/api/p/alpha-tv/vod-cats?kind=movie');
    ok(r.j.movies.length === 2 && r.j.movieTotal === 3, 'before any choice, every movie category shows');
    r = await A('PUT', '/api/p/alpha-tv/vod-groups', { kind: 'movie', groups: ['10', '999'] });
    ok(r.status === 200 && r.j.groups.length === 1 && r.j.groups[0] === '10', 'ticking movie categories keeps only real ones');
    r = await A('GET', '/api/p/alpha-tv/vod-cats?kind=movie');
    ok(r.j.movies.length === 1 && r.j.movieTotal === 1, 'browsing shows only the ticked categories');
    r = await A('GET', '/api/p/alpha-tv/vod-cats?kind=movie&all=1');
    ok(r.j.movies.length === 2 && r.j.movieSel.join() === '10', 'the picker gets every category plus the ticks');
    r = await A('GET', '/api/p/alpha-tv/vod-list?kind=movie&sort=new');
    ok(r.j.total === 1 && r.j.items[0].id === '501', 'Recently added leaves out unticked categories');
    r = await A('GET', '/api/p/alpha-tv/vod-list?kind=movie&q=funny');
    ok(r.j.total === 0, 'search leaves them out too');
    r = await A('GET', '/api/p/alpha-tv/vod-cats?kind=show');
    ok(r.j.shows.length === 1, 'shows are chosen separately and are unaffected');
    r = await A('PUT', '/api/p/alpha-tv/vod-groups', { kind: 'movie', groups: null });
    r = await A('GET', '/api/p/alpha-tv/vod-cats?kind=movie');
    ok(r.j.movies.length === 2 && r.j.movieTotal === 3, 'clearing the choice shows every category again');
    // every page carries a content policy that allows only its own scripts, and the hash it names is the hash of the page's inline script
    {
      const pg = await fetch(base + '/login.html'), csp = pg.headers.get('content-security-policy') || '', html = await pg.text();
      const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => "'sha256-" + require('crypto').createHash('sha256').update(m[1], 'utf8').digest('base64') + "'");
      const scriptSrc = (csp.match(/script-src ([^;]*)/) || ['', ''])[1];
      ok(inline.length > 0 && inline.every((h) => csp.includes(h)), 'the page policy names the hash of every inline script');
      ok(/^'self' 'sha256-/.test(scriptSrc) && !/unsafe/.test(scriptSrc) && /frame-ancestors 'none'/.test(csp) && /default-src 'none'/.test(csp), 'scripts are limited to this server and the hashes; nothing may frame the page');
      ok(pg.headers.get('x-content-type-options') === 'nosniff' && pg.headers.get('x-frame-options') === 'DENY' && pg.headers.get('referrer-policy') === 'no-referrer', 'basic hardening headers are on every response');
      const api = await fetch(base + '/api/me');
      ok(api.headers.get('x-content-type-options') === 'nosniff', 'API answers carry them too');
      const https = await fetch(base + '/login.html', { headers: { 'X-Forwarded-Proto': 'https' } });
      ok(/max-age=\d+/.test(https.headers.get('strict-transport-security') || '') && !pg.headers.get('strict-transport-security'), 'HSTS is sent only when the request came in over https');
    }
    // saved data is private to the program: no file or folder under the config folder is readable by group or others
    {
      const loose = [];
      const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name), m = fs.statSync(f).mode & 0o077; if (m) loose.push(e.name); if (e.isDirectory()) walk(f); } };
      walk(dir);
      ok(loose.length === 0, 'saved files and folders are private to the server (loose: ' + loose.join(', ') + ')');
    }
    // guesses spread over many addresses still run into the per-account limit (3 per address, so 12 for the account)
    {
      const S = client();
      let last = 0;
      for (let i = 0; i < 12; i++) { const r = await S('POST', '/api/login', { name: 'admin', password: 'nope-nope-' + i }, { 'X-Forwarded-For': '198.51.100.' + (i + 1) }); last = r.status; }
      ok(last === 401, 'twelve wrong guesses from twelve addresses are each answered as wrong');
      const r = await S('POST', '/api/login', { name: 'admin', password: 'a-new-password-1' }, { 'X-Forwarded-For': '198.51.100.200' });
      ok(r.status === 429, 'after that the account is locked for every address, even for the right password');
      const o = await S('POST', '/api/login', { name: 'someone-else', password: 'whatever-1' }, { 'X-Forwarded-For': '198.51.100.201' });
      ok(o.status === 401, 'a different name is not affected');
    }
    // lockout: 3 wrong tries, then even the right password is refused
    const L = client();
    for (let i = 0; i < 3; i++) await L('POST', '/api/login', { name: 'admin', password: 'nope-nope-1' });
    r = await L('POST', '/api/login', { name: 'admin', password: 'a-new-password-1' });
    ok(r.status === 429, 'sign-in lockout uses the configured limit');
  } finally {
    child.kill();
    prov.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(recDir, { recursive: true, force: true });
  }
  console.log(`\n${pass} passed, ${failN} failed`);
  if (failN) { console.log('\n--- server log ---\n' + log.split('\n').slice(-25).join('\n')); process.exit(1); }
}
/* ---- an error nobody caught ---- */
async function strayCheck() {
  console.log('stray errors');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dock-stray-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['--require', path.join(__dirname, 'inject-error.js'), path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), CONFIG_DIR: dir, TRUST_IP_HEADER: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '', exited = false;
  child.on('close', () => { exited = true; });
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  try {
    await sleep(2600);
    ok(!exited, 'the server keeps running after an error nobody caught');
    ok(/unexpected error \(still running\): .*boom/.test(log) && /unhandled promise error \(still running\): .*rejected/.test(log), 'both kinds are written to the log');
    ok(!/secret\.example|token=abc/.test(log), 'addresses are left out of that line');
    const r = await fetch(`http://127.0.0.1:${port}/login.html`).then((x) => x.status).catch(() => 0);
    ok(r === 200, 'and it still answers');
  } finally { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
}

/* ---- starting with and without ZIBBIT_KEY ---- */
async function keyCheck() {
  console.log('recovery key at start');
  const crypto = require('crypto');
  const srv = path.join(__dirname, '..', 'server.js');
  const mk = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dock-key-'));
    fs.writeFileSync(path.join(d, 'providers.json'), JSON.stringify({ providers: [{ id: 'primary', name: 'Strong', url: 'http://127.0.0.1:9', username: 'secretuser', password: 'secretpass', format: 'm3u8' }, { id: 'pl', name: 'List', type: 'm3u', url: 'http://127.0.0.1:9/get.php?token=abc123' }] }));
    fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ epg: { primary: ['http://127.0.0.1:9/x.xml?password=guidepw'] } }));
    return d;
  };
  const run = async (dir, key) => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const env = { ...process.env, PORT: String(port), CONFIG_DIR: dir, TRUST_IP_HEADER: '' };
    delete env.ZIBBIT_KEY;
    if (key) env.ZIBBIT_KEY = key;
    const child = spawn(process.execPath, [srv], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    for (let i = 0; i < 60 && !log.includes('listening'); i++) await sleep(100);
    child.kill();
    await new Promise((res) => child.on('close', res));
    return log;
  };
  const read = (d, f) => fs.readFileSync(path.join(d, f), 'utf8');
  const plain = (d) => /secretuser|secretpass|abc123|guidepw/.test(read(d, 'providers.json') + read(d, 'settings.json'));
  const KEY = 'my-own-key-0123456789abcdef';
  const d1 = mk();
  try {
    let log = await run(d1, KEY);
    ok(/4 saved logins? and guide address/.test(log) || /saved logins? and guide address/.test(log), 'an install with plain logins has them encrypted at the first start');
    ok(!plain(d1) && read(d1, 'providers.json').includes('enc:v1:'), 'nothing readable is left in providers.json or settings.json');
    ok(!fs.existsSync(path.join(d1, 'recovery.key')), 'with ZIBBIT_KEY set, no key file is written');
    ok(/providers: Strong, List/.test(log), 'the providers load with the key');
    const before = read(d1, 'providers.json');
    log = await run(d1, 'a-different-key-9876543210');
    ok(/encrypted with a different recovery key/.test(log) && !/providers: Strong/.test(log), 'a different key loads nothing, and says why');
    ok(read(d1, 'providers.json') === before, 'and the encrypted logins are left exactly as they were');
    log = await run(d1, KEY);
    ok(/providers: Strong, List/.test(log), 'the right key brings them back');
    log = await run(d1, 'short');
    ok(/shorter than 16/.test(log) && fs.existsSync(path.join(d1, 'recovery.key')), 'a too-short ZIBBIT_KEY is ignored with a message');
  } finally { fs.rmSync(d1, { recursive: true, force: true }); }
  const d2 = mk();
  try {
    let log = await run(d2, '');
    ok(fs.existsSync(path.join(d2, 'recovery.key')) && !plain(d2) && /providers: Strong, List/.test(log), 'without ZIBBIT_KEY a key is made, kept in the config folder, and used');
    const shown = read(d2, 'recovery.key').trim().replace(/(.{4})(?=.)/g, '$1-');
    log = await run(d2, shown);
    ok(!fs.existsSync(path.join(d2, 'recovery.key')) && /providers: Strong, List/.test(log), 'setting ZIBBIT_KEY to that key moves it off the disk');
    log = await run(d2, 'brand-new-key-for-rotation-1');
    ok(/encrypted with a different recovery key/.test(log), 'a new key does not open what the old one sealed, once the file is gone');
  } finally { fs.rmSync(d2, { recursive: true, force: true }); }
  const d3 = mk();
  try {
    await run(d3, '');
    const log = await run(d3, 'rotate-to-this-key-0123456789');
    ok(!fs.existsSync(path.join(d3, 'recovery.key')) && /providers: Strong, List/.test(log) && !plain(d3), 'a new ZIBBIT_KEY replaces the file key and re-seals what it protected');
  } finally { fs.rmSync(d3, { recursive: true, force: true }); }
}
main().then(upgradeCheck).then(keyCheck).then(strayCheck).then(() => { console.log(`\n${pass} passed, ${failN} failed`); if (failN) process.exit(1); }).catch((e) => { console.error(e); process.exit(1); });
