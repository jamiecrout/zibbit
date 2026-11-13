/* Admin settings: providers, channels and guide, playback, locks, security (which also holds people, the recovery key and backups).
 * Everything here talks to /api/admin/*, which the server only answers for admins. */
(() => {
'use strict';
const D = window.Dock;
const { $, el, api, send, toast, openDialog, closeDialog } = D;
const sheet = $('#adminSheet');
const body = $('#adminBody');
let tab = 'providers';

/* ---------- small building blocks ---------- */
function field(label, input, hint) {
  const f = el('div', 'field');
  if (label) { const l = el('label', '', label); if (input.id) l.htmlFor = input.id; f.append(l); }
  f.append(input);
  if (hint) f.append(el('small', '', hint));
  return f;
}
let uid = 0;
function input(type, value, attrs = {}) {
  const i = document.createElement(type === 'textarea' ? 'textarea' : 'input');
  if (type !== 'textarea') i.type = type;
  i.id = 'af' + (++uid);
  i.value = value == null ? '' : value;
  for (const [k, v] of Object.entries(attrs)) i.setAttribute(k, v);
  if (type === 'text' || type === 'password' || type === 'textarea') { i.autocapitalize = 'none'; i.autocomplete = 'off'; i.spellcheck = false; }
  return i;
}
function select(options, value) {
  const s = document.createElement('select');
  s.id = 'af' + (++uid);
  for (const [v, t] of options) { const o = el('option', '', t); o.value = v; s.append(o); }
  s.value = value;
  return s;
}
function check(label, checked, hint) {
  const f = el('div', 'field inline');
  const c = input('checkbox', ''); c.checked = !!checked;
  const l = el('label', '', label); l.htmlFor = c.id;
  f.append(c, l);
  if (hint) { const w = el('div', 'field'); w.style.padding = '0'; w.style.border = '0'; f.style.flexWrap = 'wrap'; const sm = el('small', '', hint); sm.style.flexBasis = '100%'; f.append(sm); }
  return { row: f, box: c };
}
function row(title, sub, buttons, pill) {
  const r = el('div', 'arow');
  const t = el('div', 'at');
  const b = el('b', '', title);
  if (pill) b.append(el('span', 'pill', pill));
  t.append(b, el('small', '', sub || ''));
  const acts = el('div', 'acts');
  for (const [label, fn] of buttons) { const x = el('button', 'btn', label); x.type = 'button'; x.addEventListener('click', fn); acts.append(x); }
  r.append(t, acts);
  return r;
}
function note(text, kind) { const f = el('div', 'field'); f.append(el('p', 'msg' + (kind ? ' ' + kind : ''), text)); return f; }
const fail = (e) => { body.replaceChildren(note(e.message || 'Something went wrong.', 'bad')); };

/* A small form in its own dialog: build(bodyEl) fills it in; buttons are [label, handler, primary?]. */
function form(title, build, buttons) {
  $('#formTitle').textContent = title;
  const fb = $('#formBody'), ff = $('#formFoot');
  fb.replaceChildren(); ff.replaceChildren();
  build(fb);
  const dlg = $('#formSheet');
  for (const [label, fn, primary] of buttons) {
    const b = el('button', 'btn' + (primary ? ' primary' : ''), label);
    b.type = 'button';
    b.addEventListener('click', async () => {
      b.disabled = true;
      try { await fn(b); } catch (e) { toast(e.message || 'That didn’t work'); }
      b.disabled = false;
    });
    ff.append(b);
  }
  openDialog(dlg);
}
const closeForm = () => closeDialog($('#formSheet'));

/* ---------- tabs ---------- */
function openAdmin(t) {
  if (t) tab = t;
  render();
  openDialog(sheet);
}
for (const b of document.querySelectorAll('#adminTabs button')) b.addEventListener('click', () => { tab = b.dataset.atab; render(); });
function render() {
  for (const b of document.querySelectorAll('#adminTabs button')) b.setAttribute('aria-selected', String(b.dataset.atab === tab));
  body.scrollTop = 0;
  ({ providers: renderProviders, channels: renderChannels, playback: renderPlayback, locks: renderLocks, security: renderSecurity })[tab]();
}

/* ---------- providers ---------- */
async function renderProviders() {
  body.replaceChildren(note('Loading'));
  let j;
  try { j = await api('/api/admin/providers'); } catch (e) { return fail(e); }
  body.replaceChildren();
  const top = el('div', 'field');
  const add = el('button', 'btn primary', 'Add provider');
  add.type = 'button';
  add.addEventListener('click', () => providerForm(null));
  top.append(add, el('small', '', 'Add as many as you like: Xtream logins, M3U playlists, HDHomeRun tuners and (experimental) Tablo.'));
  body.append(top);
  if (!j.providers.length) body.append(note('No providers yet. Add one to get started.'));
  for (const p of j.providers) {
    body.append(row(p.name, `${p.type === 'm3u' ? 'M3U playlist' : p.type === 'hdhr' ? 'HDHomeRun' : p.type === 'tablo' ? 'Tablo (experimental)' : 'Xtream'}  ${p.url}${p.locked ? '  (locked: the saved login needs a different recovery key, see Security)' : p.live ? '' : '  (not loaded: check the entry)'}`, [['Edit', () => providerForm(p)], ['Remove', () => removeProvider(p)]], p.type === 'm3u' ? 'M3U' : p.type === 'hdhr' || p.type === 'tablo' ? 'Antenna' : ''));
  }
}
function providerForm(p) {
  const f = {};
  form(p ? `Edit ${p.name}` : 'Add provider', (fb) => {
    f.name = input('text', p ? p.name : '', { maxlength: 60, placeholder: 'For example: Living room antenna' });
    f.type = select([['xtream', 'Xtream login (server, username, password)'], ['m3u', 'M3U playlist address'], ['hdhr', 'HDHomeRun tuner (antenna)'], ['tablo', 'Tablo 4th Gen (antenna, experimental)']], p ? p.type : 'xtream');
    f.url = input('text', p && p.type !== 'm3u' ? p.url : '', { inputmode: 'url' });
    f.user = input('text', p ? p.username : '', { autocomplete: 'off' });
    f.pass = input('password', '', { autocomplete: 'new-password' });
    f.format = select([['m3u8', 'HLS (.m3u8): most providers'], ['ts', 'Raw transport stream (.ts)']], p ? p.format : 'm3u8');
    f.epg = input('textarea', p ? p.epg.join('\n') : '', { placeholder: 'One address per line (optional)', rows: 3 });
    const fUrl = field('', f.url), fUser = field('Username', f.user), fPass = field('Password', f.pass);
    const lUrl = fUrl.insertBefore(el('label', ''), f.url); lUrl.htmlFor = f.url.id;
    const hUrl = el('small', ''); fUrl.append(hUrl);
    const lUser = fUser.querySelector('label'), lPass = fPass.querySelector('label');
    const fFormat = field('Stream type', f.format, 'If channels don’t start, try the other one.');
    const result = el('div', 'field'); result.hidden = true;
    fb.append(field('Name', f.name), field('Type', f.type), fUrl, fUser, fPass, fFormat,
      field('Program guide (XMLTV) addresses', f.epg, 'Optional. Used for what’s on now and next. Xtream providers also have their own guide.'), result);
    const sync = () => {
      const m3u = f.type.value === 'm3u', hd = f.type.value === 'hdhr', tb = f.type.value === 'tablo';
      lUrl.textContent = m3u ? 'Playlist address' : hd ? 'Tuner address' : tb ? 'Tablo address (optional)' : 'Server address';
      if (lUser) lUser.textContent = tb ? 'Tablo account email' : 'Username';
      if (lPass) lPass.textContent = tb ? 'Tablo account password' : 'Password';
      hUrl.textContent = tb ? 'Experimental, and not yet tested on real hardware. Leave blank to use the address your Tablo account reports, or enter the Tablo’s address on your network, like 192.168.1.60. This server must be able to reach it. Sign-in goes through the Tablo cloud; video is converted while you watch, which needs ffmpeg.' : hd ? 'The address of the HDHomeRun on your network, like 192.168.1.50. This server must be able to reach it. Video is converted for the browser while you watch, which needs ffmpeg and some processor time.' : m3u ? (p && p.type === 'm3u' ? 'Leave blank to keep the saved address (it is hidden because it may contain a login).' : 'The full http(s) address of the .m3u playlist.') : 'With the port, like http://host.example:8080';
      f.url.placeholder = m3u ? 'https://…/playlist.m3u' : hd ? '192.168.1.50' : tb ? '192.168.1.60 (optional)' : 'http://host.example:8080';
      fUser.hidden = fPass.hidden = m3u || hd;
      fFormat.hidden = hd || tb;
      f.pass.placeholder = p && (p.type === 'xtream' || p.type === 'tablo') ? 'Leave blank to keep the saved password' : '';
    };
    f.type.addEventListener('change', sync); sync();
    f.result = result;
  }, [
    ['Test connection', async () => {
      const r = await send('/api/admin/providers/test', collect(p), 'POST');
      const box = f.result; box.hidden = false; box.replaceChildren();
      if (!r.ok) return box.append(el('p', 'msg bad', r.error || 'That didn’t work.'));
      if (r.kind === 'xtream') {
        const exp = r.expires ? ` Expires ${new Date(r.expires * 1000).toLocaleDateString()}.` : '';
        box.append(el('p', 'msg good', `Connected. Account is ${r.status || 'active'}.${exp}${r.maxConnections ? ` Up to ${r.maxConnections} streams at once.` : ''}`));
      } else if (r.kind === 'tablo') {
        box.append(el('p', 'msg good', `Signed in. Found ${r.model} with ${r.channels.toLocaleString()} channel${r.channels === 1 ? '' : 's'}, at ${r.address}. Playing a channel is the part that is not tested yet.`));
        if (!r.ffmpeg) box.append(el('p', 'msg bad', 'ffmpeg was not found on this server, so these channels will list but not play.'));
      } else if (r.kind === 'hdhr') {
        box.append(el('p', 'msg good', `Found ${r.model} with ${r.tuners} tuner${r.tuners === 1 ? '' : 's'} and ${r.channels.toLocaleString()} channel${r.channels === 1 ? '' : 's'}.${r.transcoded ? ` ${r.transcoded} of them are converted for the browser while you watch.` : ''}`));
        if (!r.ffmpeg) box.append(el('p', 'msg bad', 'ffmpeg was not found on this server, so these channels will list but not play.'));
      } else {
        if (r.suggestFormat) f.format.value = r.suggestFormat;
        box.append(el('p', 'msg good', `Found ${r.channels.toLocaleString()} channels in ${r.groups} group${r.groups === 1 ? '' : 's'}. ${r.hlsChannels} of them look like HLS (.m3u8), so stream type is set to ${r.suggestFormat === 'ts' ? 'transport stream' : 'HLS'}.${r.guide ? ' The playlist names a guide: ' + r.guide : ''}`));
      }
    }],
    ['Save', async () => {
      const b = collect(p);
      const r = p ? await send('/api/admin/providers/' + encodeURIComponent(p.id), b, 'PUT') : await send('/api/admin/providers', b, 'POST');
      closeForm(); toast(p ? 'Saved' : 'Provider added');
      renderProviders(); await D.refreshProviders();
      return r;
    }, true]
  ]);
  function collect(old) {
    return { id: old ? old.id : undefined, name: f.name.value, type: f.type.value, url: f.url.value, username: f.user.value, password: f.pass.value, format: f.format.value, epg: f.epg.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean) };
  }
}
function removeProvider(p) {
  form(`Remove ${p.name}?`, (fb) => {
    fb.append(note('The provider disappears from the header for everyone. Each person’s saved groups and favorites stay in their profile file, so adding the same provider back later restores them only if the groups still exist.'));
  }, [['Remove it', async () => {
    await send('/api/admin/providers/' + encodeURIComponent(p.id), {}, 'DELETE');
    closeForm(); toast('Removed'); renderProviders(); await D.refreshProviders();
  }, true]]);
}

/* ---------- people ---------- */
const heading = (t) => el('h3', 'ahead', t);
async function appendPeople() { // the People section at the top of Security
  let j;
  try { j = await api('/api/admin/users'); } catch (e) { fail(e); return false; }
  body.append(heading('People'));
  const top = el('div', 'field');
  const add = el('button', 'btn primary', 'Add person');
  add.type = 'button'; add.addEventListener('click', userForm);
  top.append(add, el('small', '', 'Everyone has their own groups and favorites. Admins can also change everything on these screens.'));
  body.append(top);
  for (const u of j.users) {
    const btns = [];
    if (j.adultLock) {
      btns.push(['Reset PIN', () => pinResetForm(u, 'reset')]);
      if (u.pinWait) btns.push(['Clear lockout', () => pinResetForm(u, 'clear')]);
    }
    if (!u.you) {
      btns.push(['Set password', () => passwordForm(u)]);
      btns.push([u.role === 'admin' ? 'Make regular user' : 'Make admin', async () => {
        try { await send('/api/admin/users/' + encodeURIComponent(u.name), { role: u.role === 'admin' ? 'user' : 'admin' }, 'PUT'); renderSecurity(); } catch (e) { toast(e.message); }
      }]);
      btns.push(['Remove', () => removeUser(u)]);
    }
    body.append(row(u.name, `${u.role === 'admin' ? 'Admin' : 'Regular user'}${u.you ? ', this is you' : ''}${u.mustChange ? ', will choose a new password at next sign-in' : ''}${j.adultLock ? (u.hasPin ? ', content-lock PIN set' : ', no content-lock PIN yet') + (u.pinWait ? `, PIN locked out for ${u.pinWait >= 90 ? Math.ceil(u.pinWait / 60) + ' min' : u.pinWait + ' s'}` : '') : ''}`, btns, u.role === 'admin' ? 'Admin' : ''));
  }
  return true;
}
function userForm() {
  const f = {};
  form('Add person', (fb) => {
    f.name = input('text', '', { maxlength: 60, autocomplete: 'off' });
    f.pass = input('password', '', { autocomplete: 'new-password', minlength: 8 });
    f.role = select([['user', 'Regular user: own groups and favorites only'], ['admin', 'Admin: can change everything']], 'user');
    const c = check('Ask them to choose their own password at first sign-in', true);
    f.must = c.box;
    fb.append(field('Name', f.name), field('Temporary password', f.pass, 'At least 8 characters.'), field('Role', f.role), c.row);
  }, [['Add', async () => {
    await send('/api/admin/users', { name: f.name.value.trim(), password: f.pass.value, role: f.role.value, mustChange: f.must.checked }, 'POST');
    closeForm(); toast('Added'); renderSecurity();
  }, true]]);
}
function passwordForm(u) {
  const f = {};
  form(`New password for ${u.name}`, (fb) => {
    f.pass = input('password', '', { autocomplete: 'new-password', minlength: 8 });
    const c = check('Ask them to choose their own password at next sign-in', true);
    f.must = c.box;
    fb.append(field('New password', f.pass, 'At least 8 characters. This signs them out everywhere.'), c.row);
  }, [['Save', async () => {
    await send(`/api/admin/users/${encodeURIComponent(u.name)}/password`, { password: f.pass.value, mustChange: f.must.checked }, 'POST');
    closeForm(); toast('Password set'); renderSecurity();
  }, true]]);
}
function removeUser(u) {
  form(`Remove ${u.name}?`, (fb) => { fb.append(note('They can no longer sign in. Their saved groups and favorites file is kept in the config folder.')); },
    [['Remove', async () => { await send('/api/admin/users/' + encodeURIComponent(u.name), {}, 'DELETE'); closeForm(); toast('Removed'); renderSecurity(); }, true]]);
}

/* ---------- recovery key and backup (in Security) ---------- */
const fmtSize = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB');
async function appendBackup() {
  let j;
  try { j = await api('/api/admin/backup'); } catch (e) { body.append(note(e.message || 'Something went wrong.', 'bad')); return; }
  body.append(heading('Recovery key and backup'));
  body.append(note('Provider logins and guide addresses are stored encrypted on the server. The recovery key opens them, and it also opens a backup. Keep a copy somewhere safe, such as your password manager: a backup can’t be restored without it.'));
  if (j.source === 'file') body.append(note('The key is kept in the config folder, so a copy of that whole folder includes it. To keep it off the disk, set the ZIBBIT_KEY environment variable to this key and restart.'));
  if (j.problem) body.append(note(j.problem, 'bad'));
  const lockedN = j.locked.providers + j.locked.guides;
  if (lockedN) body.append(note(`${j.locked.providers ? j.locked.providers + ' provider' + (j.locked.providers === 1 ? '' : 's') : ''}${j.locked.providers && j.locked.guides ? ' and ' : ''}${j.locked.guides ? j.locked.guides + ' guide address' + (j.locked.guides === 1 ? '' : 'es') : ''} can’t be read with this server’s key, so ${lockedN === 1 ? 'it isn’t' : 'they aren’t'} in use. Set ZIBBIT_KEY to the key they were saved with, restore a backup, or enter the login again.`, 'bad'));
  body.append(row('Recovery key', j.source === 'env' ? 'From ZIBBIT_KEY. Not on the server’s disk.' : 'Kept in the config folder.', [['Show key', keyForm]], j.source === 'env' ? 'Environment' : ''));
  body.append(row('Back up now', j.ready ? 'Save to the storage folder, or download.' : 'Download. Saving needs a storage folder.', [['Save to storage', async (ev) => {
    const b = ev.currentTarget; b.disabled = true;
    try { const r = await send('/api/admin/backup/save', {}, 'POST'); toast(r.skipped ? `Saved. ${r.skipped} provider${r.skipped === 1 ? '' : 's'} left out (can’t be read)` : 'Saved to the storage folder'); renderSecurity(); } catch (e) { toast(e.message); b.disabled = false; }
  }], ['Download', async (ev) => {
    const b = ev.currentTarget; b.disabled = true;
    try {
      const r = await send('/api/admin/backup/download', {}, 'POST');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(r.backup)], { type: 'application/octet-stream' }));
      a.download = r.name; document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      toast(r.skipped ? `Downloaded. ${r.skipped} provider${r.skipped === 1 ? '' : 's'} left out (can’t be read)` : 'Downloaded');
    } catch (e) { toast(e.message); }
    b.disabled = false;
  }]]));
  const auto = check('Save a backup to storage every day', j.auto, j.ready ? '' : 'Needs a storage folder mapped to /recordings.');
  const keep = input('number', j.keep, { min: 1, max: 60 });
  body.append(auto.row, field('Automatic backups to keep', keep, 'Older automatic ones are removed. Ones you save by hand are never removed.'),
    savebar('Save', async () => { await send('/api/admin/settings', { backupAuto: auto.box.checked, backupKeep: +keep.value }, 'PUT'); toast('Saved'); }));
  for (const f of j.files) {
    const when = new Date(f.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    body.append(row(when, `${f.kind === 'auto' ? 'Automatic' : f.kind === 'before-restore' ? 'Saved before a restore' : 'Saved by hand'}, ${fmtSize(f.size)}`, [['Restore', () => restoreForm(f)]]));
  }
  body.append(row('Restore from a file', 'Use a backup you downloaded earlier.', [['Choose file', () => restoreForm(null)]]));
}
function keyForm() {
  const f = {};
  form('Recovery key', (fb) => {
    f.pw = input('password', '', { autocomplete: 'current-password' });
    f.out = el('div', 'field'); f.out.hidden = true;
    fb.append(note('Asked for again so nobody at your signed-in screen can read it.'), field('Your password', f.pw), f.out);
  }, [['Show key', async (b) => {
    const r = await send('/api/admin/backup/key', { password: f.pw.value }, 'POST');
    const k = input('text', r.key, { readonly: '' });
    k.style.fontFamily = 'ui-monospace, Menlo, Consolas, monospace'; k.style.letterSpacing = '.04em';
    k.addEventListener('focus', () => k.select());
    f.out.hidden = false;
    f.out.replaceChildren(el('label', '', 'Recovery key'), k, el('small', '', r.source === 'env' ? 'This is the value of ZIBBIT_KEY.' : 'To keep it off the disk, set the ZIBBIT_KEY environment variable to this and restart. The copy in the config folder is then removed.'));
    k.focus();
    b.hidden = true;
  }, true]]);
}
function restoreForm(saved) {
  const f = {};
  form(saved ? 'Restore this backup?' : 'Restore from a file', (fb) => {
    fb.append(note('This replaces the providers, people, settings, guide links, groups and favorites on this server with what is in the backup. What is here now is saved first when a storage folder is mapped. You may be signed out afterwards.', 'bad'));
    if (!saved) { f.file = input('file', '', { accept: '.zbk,application/json' }); fb.append(field('Backup file', f.file)); }
    f.key = input('text', '', { placeholder: 'The key the backup was made with' });
    f.pw = input('password', '', { autocomplete: 'current-password' });
    fb.append(field('Recovery key of the backup', f.key, 'The key shown under Security on the server that made it.'), field('Your password', f.pw));
  }, [['Restore', async () => {
    const b = { key: f.key.value, password: f.pw.value };
    if (saved) b.file = saved.name;
    else {
      if (!f.file.files[0]) throw new Error('Choose a backup file first.');
      try { b.backup = JSON.parse(await f.file.files[0].text()); } catch { throw new Error('That isn’t a Zibbit backup file.'); }
    }
    const r = await send('/api/admin/backup/restore', b, 'POST');
    closeForm(); toast(r.notes && r.notes.length ? r.notes[0] : 'Restored');
    setTimeout(() => location.reload(), 1600);
  }, true]]);
}

/* Reset PIN / Clear lockout. For your own profile the account password is asked for, so someone at your signed-in screen can't do it for you. */
function pinResetForm(u, action) {
  const f = {};
  const reset = action === 'reset';
  form(reset ? `Reset PIN for ${u.name}` : `Clear PIN lockout for ${u.name}`, (fb) => {
    fb.append(note(reset ? `${u.name}'s PIN is removed and any lockout is cleared. They set a new one the next time they open a locked group. Locked groups are locked again on all their screens.` : `${u.name} can try their PIN again straight away. The PIN itself is not changed.`));
    if (u.you) { f.pw = input('password', '', { autocomplete: 'current-password' }); fb.append(field('Your password', f.pw, 'Asked for because this is your own PIN.')); }
  }, [[reset ? 'Reset PIN' : 'Clear lockout', async () => {
    await send(`/api/admin/users/${encodeURIComponent(u.name)}/pin`, { action, ...(u.you ? { password: f.pw.value } : {}) }, 'POST');
    closeForm(); toast(reset ? 'PIN reset' : 'Lockout cleared'); renderSecurity();
  }, true]]);
}

/* ---------- locks ---------- */
const pinInput = () => input('password', '', { inputmode: 'numeric', maxlength: 4, pattern: '[0-9]*', autocomplete: 'off' });
async function renderLocks() {
  body.replaceChildren(note('Loading'));
  let s, provs;
  try { [s, provs] = await Promise.all([api('/api/admin/settings'), api('/api/admin/providers')]); } catch (e) { return fail(e); }
  body.replaceChildren();
  body.append(note('Groups whose name matches the words below, or that you mark, are locked behind a four-digit PIN, one for each person. It is meant for adult content, but you can lock any group you want kept out of sight. A locked group still shows, with a lock, but its channels and titles are hidden everywhere (guide, search, favorites, history) until the PIN is entered. The server also refuses to play them.'));
  body.append(row('Content lock', s.adultLock ? 'Blocked groups are locked behind each person’s PIN.' : 'Blocked groups show like any other group.', [[s.adultLock ? 'Turn off' : 'Turn on', () => (s.adultLock ? adultOffForm() : adultOnFlow(s))]], s.adultLock ? 'On' : ''));
  const words = input('textarea', s.adultWords, { rows: 2, placeholder: 'xxx, adult, 18+' });
  const idle = select([['60', '1 hour'], ['240', '4 hours'], ['720', '12 hours']], String([60, 240, 720].includes(s.adultIdleMinutes) ? s.adultIdleMinutes : 240));
  body.append(
    field('Lock groups whose name contains', words, 'Separate with commas. Whole words only, so “adult” matches “ADULT: Movies” but not “Adulthood”; “Adult Swim” never counts. Use the lists below to lock or unlock any group by hand.'),
    field('Lock again after no activity for', idle, 'Pressing keys, browsing and watching all count as activity. Whatever is happening, it locks again 12 hours after the PIN was entered. It also locks when someone switches profile or signs out.'),
    savebar('Save', async () => { await send('/api/admin/settings', { adultWords: words.value, adultIdleMinutes: +idle.value }, 'PUT'); toast('Saved'); renderLocks(); }));
  if (!provs.providers.length) return;
  body.append(note('Locked groups, by provider:'));
  for (const p of provs.providers) body.append(row(p.name, '', [['Choose groups', () => adultGroupsForm(p)]]));
}
function adultOnFlow(s) {
  if (s.youHavePin) return adultOnSave();
  const f = {};
  form('Set your PIN', (fb) => {
    f.pw = input('password', '', { autocomplete: 'current-password' });
    f.pin = pinInput(); f.pin2 = pinInput();
    fb.append(note('Turning the lock on starts with your own PIN. Everyone else sets theirs the first time they open a locked group, or you can reset theirs under Security > People.'),
      field('Your password', f.pw), field('New PIN (four digits)', f.pin), field('Type the PIN again', f.pin2));
  }, [['Set PIN and turn on', async () => {
    if (!/^\d{4}$/.test(f.pin.value)) throw new Error('The PIN is four digits.');
    if (f.pin.value !== f.pin2.value) throw new Error('The two PINs don’t match.');
    await send('/api/adult/pin', { password: f.pw.value, pin: f.pin.value }, 'POST');
    await adultOnSave(); closeForm();
  }, true]]);
}
async function adultOnSave() { await send('/api/admin/settings', { adultLock: true }, 'PUT'); toast('Content lock is on'); renderLocks(); }
function adultOffForm() {
  const f = {};
  form('Turn off the content lock', (fb) => {
    f.pin = pinInput();
    fb.append(note('Blocked groups will show like any other group, for everyone. Enter your PIN to confirm. If you have forgotten it, reset it under Security > People, then set a new one.'), field('Your PIN', f.pin));
  }, [['Turn off', async () => {
    await send('/api/admin/settings', { adultLock: false, adultPin: f.pin.value }, 'PUT');
    closeForm(); toast('Content lock is off'); renderLocks();
  }, true]]);
}
function adultGroupsForm(p) {
  const fl = el('input'); fl.type = 'search'; fl.placeholder = 'Filter groups'; fl.autocomplete = 'off';
  const list = el('div');
  form(`Locked groups: ${p.name}`, (fb) => { fb.append(field('', fl), list); list.append(note('Loading')); }, [['Done', () => closeForm(), true]]);
  api('/api/admin/adult/groups?p=' + encodeURIComponent(p.id)).then((j) => {
    list.replaceChildren();
    const rows = [];
    for (const [kind, label] of [['live', 'Live TV'], ['movie', 'Movies'], ['show', 'Shows']]) {
      const items = j[kind] || [];
      if (!items.length) continue;
      list.append(el('div', 'field', label));
      for (const c of items) {
        const lab = el('label', 'cat'); lab.dataset.name = c.name.toLowerCase();
        const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = c.locked;
        const note2 = c.mark === null ? (c.locked ? 'by name' : '') : 'set by you';
        lab.append(cb, el('span', 'cname', c.name || '(unnamed)'), el('span', 'ccount', note2));
        cb.addEventListener('change', async () => {
          try { await send('/api/admin/adult/groups', { p: p.id, kind, id: c.id, locked: cb.checked === c.auto ? null : cb.checked }, 'PUT'); lab.lastChild.textContent = cb.checked === c.auto ? (cb.checked ? 'by name' : '') : 'set by you'; }
          catch (e) { cb.checked = !cb.checked; toast(e.message); }
        });
        rows.push(lab); list.append(lab);
      }
    }
    if (!rows.length) list.append(note('Nothing to show yet. The provider’s lists may still be loading.'));
    fl.addEventListener('input', () => { const q = fl.value.trim().toLowerCase(); for (const r of rows) r.hidden = !!q && !r.dataset.name.includes(q); });
  }).catch((e) => { list.replaceChildren(note(e.message, 'bad')); });
}

/* ---------- channels and guide ---------- */
async function renderChannels() {
  body.replaceChildren(note('Loading'));
  let s;
  try { s = await api('/api/admin/settings'); } catch (e) { return fail(e); }
  body.replaceChildren();
  const trim = input('textarea', s.trimFromNames.join(', '), { rows: 9, placeholder: 'Separate with commas, for example:\nUS:, UK|, RAW' });
  const sup = check('Remove superscript letters and numbers', s.stripSuperscripts, 'Hides marks like ᴴᴰ or ᴿᴬᵂ from channel names.');
  const nm = check('Match guide data by channel name', s.epgNameMatch, 'When a channel has no guide id, try its cleaned-up name.');
  const fb = check('Also ask the provider for guide data', s.epgProviderFallback, 'Only matters for providers with a guide address set. Off: a channel your guide has nothing for shows no program info. On: Zibbit asks the provider about that channel too.');
  const hrs = input('number', s.epgRefreshHours, { min: 1, max: 168 });
  body.append(
    field('Hide this text in channel names', trim, 'Separate entries with commas. Capitals don’t matter. Words match whole words only (RAW, not DRAWER). Group names aren’t changed.'),
    sup.row, nm.row, fb.row,
    field('Refresh the program guide every (hours)', hrs),
    savebar('Save', async () => {
      await send('/api/admin/settings', { trimFromNames: trim.value.split(/[,\n]/).map((x) => x.trim()).filter(Boolean), stripSuperscripts: sup.box.checked, epgNameMatch: nm.box.checked, epgProviderFallback: fb.box.checked, epgRefreshHours: +hrs.value || 12 }, 'PUT');
      toast('Saved. Channel names update now.');
    }),
    note('Guide addresses are set per provider, under Providers > Edit.'));
}

/* ---------- playback and recording ---------- */
async function renderPlayback() {
  body.replaceChildren(note('Loading'));
  let s;
  try { s = await api('/api/admin/settings'); } catch (e) { return fail(e); }
  body.replaceChildren();
  const eac = check('Convert E-AC-3 audio for the browser', s.convertEac3Audio, 'Some live channels carry Dolby Digital Plus audio, which most browsers can’t play, so the channel stops. When on, Zibbit converts just that audio to AAC on the server and leaves the video alone. Takes effect on the next channel you play.');
  const rwm = select([['0', 'Off'], ['15', '15 minutes'], ['30', '30 minutes'], ['60', '1 hour']], String(s.rewindMinutes));
  const rwg = input('number', s.rewindMaxGB, { min: 1, max: 2000 });
  const rcm = input('number', s.recordMaxHours, { min: 1, max: 24 });
  const rcf = input('number', s.recordFloorGB, { min: 1, max: 5000 });
  body.append(
    eac.row,
    field('Rewind live TV, at most', rwm, 'How far back anyone can wind a live channel. Each person can choose less for themselves. The buffer only exists while a channel is being watched, and it is deleted when everyone leaves. Off: channels play directly from the provider, as before.'),
    field('Disk the rewind buffer may use (GB)', rwg, `All running channels together stay under this; the oldest video is removed first. Folder: ${s.rewindFolder}, ${s.rewindFreeGB} GB free. Map a folder to /rewind so it doesn’t fill the container’s own disk. A 1080p channel is roughly 2 to 4 GB an hour, 4K about 10 GB or more.`),
    field('Longest recording (hours)', rcm, `A recording stops by itself after this long. ${s.recordReady ? `Saved to ${s.recordFolder}, ${s.recordFreeGB} GB free.` : `Recording is off until a folder is mapped to ${s.recordFolder}.`} Recordings are never deleted automatically.`),
    field('Stop recording when free space drops below (GB)', rcf, 'Recordings stop, and new ones won’t start, when the disk has less than this left.'),
    savebar('Save', async () => {
      await send('/api/admin/settings', { convertEac3Audio: eac.box.checked, rewindMinutes: +rwm.value, rewindMaxGB: +rwg.value || 10, recordMaxHours: +rcm.value || 6, recordFloorGB: +rcf.value || 20 }, 'PUT');
      toast('Saved');
    }));
}
function savebar(label, fn) {
  const f = el('div', 'field');
  const b = el('button', 'btn primary', label);
  b.type = 'button';
  b.addEventListener('click', async () => { b.disabled = true; try { await fn(); } catch (e) { toast(e.message || 'That didn’t work'); } b.disabled = false; });
  f.append(b);
  return f;
}

/* ---------- security ---------- */
async function renderSecurity() {
  body.replaceChildren(note('Loading'));
  let s;
  try { s = await api('/api/admin/settings'); } catch (e) { return fail(e); }
  body.replaceChildren();
  if (!(await appendPeople())) return;
  await appendBackup();
  body.append(heading('Sign-in protection'));
  const hdr = input('text', s.trustIpHeader, { placeholder: 'Leave blank unless a proxy sets one', disabled: s.trustIpHeaderLockedByEnv ? '' : null });
  if (!s.trustIpHeaderLockedByEnv) hdr.removeAttribute('disabled');
  const uf = input('number', s.lockUserFails, { min: 1, max: 100 });
  const ipf = input('number', s.lockIpFails, { min: 1, max: 1000 });
  const mins = input('number', s.lockMinutes, { min: 1, max: 1440 });
  const allow = input('textarea', s.adminAllow.join('\n'), { rows: 4, placeholder: 'One per line, for example:\n203.0.113.0/24\n2001:db8:1234::/48' });
  body.append(
    field('Sign-in lockout: wrong passwords per person and address', uf, 'After this many wrong tries the person is locked out from that address.'),
    field('Sign-in lockout: wrong passwords from one address in total', ipf),
    field('Lockout lasts (minutes)', mins),
    field('Header that carries the real visitor address', hdr, s.trustIpHeaderLockedByEnv ? 'Set by the TRUST_IP_HEADER environment variable, so it can’t be changed here.' : 'Only name a header your reverse proxy sets itself, such as cf-connecting-ip or x-real-ip. Otherwise the last X-Forwarded-For entry is used.'),
    field('Only allow these addresses to open Admin settings', allow, `Empty means no limit. Playback and sign-in aren’t affected. Addresses on your home network are always allowed. You are connecting from ${s.you}. A rule that would lock you out is refused.`),
    savebar('Save', async () => {
      const r = await send('/api/admin/settings', { lockUserFails: +uf.value, lockIpFails: +ipf.value, lockMinutes: +mins.value, trustIpHeader: hdr.value, adminAllow: allow.value.split(/\r?\n/) }, 'PUT');
      toast('Saved');
      if (r.warning) body.prepend(note(r.warning, 'bad'));
    }),
    note('If you ever lock yourself out of Admin settings, run this on the server:  docker exec -it zibbit node server.js clear-ip-rules'));
}

D.openAdmin = openAdmin;
})();
