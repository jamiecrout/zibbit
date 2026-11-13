'use strict';
/* The adult-content lock: which groups count as adult, the four-digit PIN, wrong-guess lockouts, and who is unlocked right now.
 * Everything here is plain logic with no network or files, so it can be tested on its own. */
const crypto = require('crypto');

const CEILING_MS = 12 * 3600 * 1000;   // an unlock never lasts longer than this, whatever is playing
const DAY_MS = 24 * 3600 * 1000;
const DEFAULT_WORDS = 'xxx, adult, 18+, porn, nsfw, erotic';

/* The words an admin lists are matched as whole words ("adult" matches "ADULT: Movies" but not "Adulthood"); a word with a
 * symbol in it, like 18+, is matched as written. "Adult Swim" is a cartoon channel and never counts. */
function wordMatcher(list) {
  const words = (Array.isArray(list) ? list : String(list == null ? DEFAULT_WORDS : list).split(/[,\n]/))
    .map((w) => String(w).normalize('NFKC').toLowerCase().trim()).filter(Boolean).slice(0, 60);
  const res = words.map((w) => {
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // a plain word also matches its plural ("adult" catches "FOR ADULTS"); a word with a symbol in it, like 18+, is matched as written
    return /^[a-z0-9 ]+$/.test(w) ? new RegExp('(^|[^a-z0-9])' + esc.replace(/\s+/g, '\\s+') + 's?([^a-z0-9]|$)') : new RegExp(esc);
  });
  return (name) => {
    const n = String(name == null ? '' : name).normalize('NFKC').toLowerCase();
    if (/adult[\s_.-]*swim/.test(n)) return false;
    return res.some((r) => r.test(n));
  };
}

/* Is this group locked? An admin's explicit mark (true or false) beats the name. marks: { "<kind>:<id>": true|false } */
function groupLocked(marks, kind, id, name, byName) {
  const m = marks && marks[kind + ':' + id];
  if (m === true || m === false) return m;
  return byName(name);
}

const validPin = (x) => typeof x === 'string' && /^\d{4}$/.test(x);

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.scryptSync(pin, salt, 32).toString('hex') };
}
function checkPin(rec, pin) {
  if (!rec || !rec.salt || !rec.hash || !validPin(pin)) return false;
  const got = crypto.scryptSync(pin, rec.salt, 32), want = Buffer.from(rec.hash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/* Wrong guesses. After `max` misses the person waits `baseMs`; once that has passed, a single further miss locks again for twice as
 * long (capped at a day). A right PIN, or an admin, clears it. */
function makeLockout({ max, baseMs, now = Date.now }) {
  const rec = new Map();
  const cfg = typeof max === 'function' ? max : () => ({ max, baseMs });
  return {
    wait(key) { const r = rec.get(key); return r && r.until > now() ? Math.ceil((r.until - now()) / 1000) : 0; },
    fail(key) {
      const c = cfg(), r = rec.get(key) || { n: 0, level: 0, until: 0 };
      r.n++;
      if (r.n >= c.max) {
        r.level++;
        r.until = now() + Math.min(DAY_MS, c.baseMs * Math.pow(2, r.level - 1));
        r.n = Math.max(0, c.max - 1); // once this wait is over, one more miss locks again
      }
      if (rec.size > 2000) rec.delete(rec.keys().next().value);
      rec.set(key, r);
      return this.wait(key);
    },
    left(key) { const c = cfg(), r = rec.get(key); return r ? Math.max(0, c.max - r.n) : c.max; },
    ok(key) { rec.delete(key); },
    clear(key) { rec.delete(key); }
  };
}

/* Who is unlocked. Keyed by the device's sign-in (a hash of its cookie), so another profile, another device, or a new sign-in starts locked.
 * Any activity (a key press, a click, or a stream being pulled) pushes the idle timer back; the ceiling counts from the PIN. */
function makeUnlocks({ idleMs, now = Date.now }) {
  const map = new Map();
  const idle = typeof idleMs === 'function' ? idleMs : () => idleMs;
  const alive = (u, user) => !!u && u.user === user && now() - u.at < CEILING_MS && now() - u.last < idle();
  return {
    unlock(dev, user) { if (map.size > 2000) map.delete(map.keys().next().value); map.set(dev, { user, at: now(), last: now() }); },
    touch(dev, user) { const u = map.get(dev); if (alive(u, user)) u.last = now(); },
    is(dev, user) { const u = map.get(dev); if (alive(u, user)) return true; if (u && u.user === user) map.delete(dev); return false; },
    lock(dev) { map.delete(dev); },
    lockUser(user) { for (const [k, u] of map) if (u.user === user) map.delete(k); },
    leftMs(dev, user) { const u = map.get(dev); return alive(u, user) ? Math.min(CEILING_MS - (now() - u.at), idle() - (now() - u.last)) : 0; }
  };
}

module.exports = { CEILING_MS, DEFAULT_WORDS, wordMatcher, groupLocked, validPin, hashPin, checkPin, makeLockout, makeUnlocks };
