'use strict';
/* The live-stream player, shared by the TV page (tv.html) and the web page (index.html), so a fix to one is a fix to both:
 *   - setting up hls.js (or the browser's own HLS) and mpegts.js
 *   - what to do when they report trouble (one place, one order)
 *   - one watchdog for a picture that has stopped moving
 *   - the log line for a picture that jumps
 * Each page passes what is its own: the video element, its state object S, and a few functions (below). */
(function () {
  window.ZPlayer = function (A) {
    const { video, S } = A;
    const live = () => { const sk = video.seekable; return sk && sk.length ? { lo: sk.start(0), hi: sk.end(sk.length - 1) } : { lo: 0, hi: 0 }; };
    const ranges = (tr) => { let o = ''; try { for (let i = 0; i < tr.length; i++) o += `${Math.round(tr.start(i))}-${Math.round(tr.end(i))} `; } catch { /* none */ } return o.trim() || 'none'; };

    /* ---- starting a stream ---- */
    function startHls(url, tsUrl) {
      S.liveJumps = 0; S.lvl = null; S.frag = null;
      if (window.Hls && Hls.isSupported()) {
        const hls = new Hls(Object.assign({ maxBufferLength: 15, maxMaxBufferLength: 30, backBufferLength: 10, liveSyncDurationCount: 3, manifestLoadingMaxRetry: 1, levelLoadingMaxRetry: 3, fragLoadingMaxRetry: 4, enableWorker: true }, A.hlsExtra || {}));
        S.hls = hls;
        hls.on(Hls.Events.LEVEL_UPDATED, (_, d) => { try { const x = d.details; S.lvl = { at: Date.now(), sn: x.startSN + '-' + x.endSN, n: x.fragments.length }; } catch { /* diagnostics only */ } });
        hls.on(Hls.Events.FRAG_LOADED, (_, d) => { try { S.frag = { at: Date.now(), sn: d.frag.sn }; } catch { /* diagnostics only */ } });
        hls.on(Hls.Events.MANIFEST_PARSED, () => { const p = video.play(); if (p && p.catch) p.catch(A.startedOk(() => S.hls === hls)); });
        hls.on(Hls.Events.ERROR, (_, d) => {
          if (!d.fatal || S.hls !== hls) return;
          const net = d.type === Hls.ErrorTypes.NETWORK_ERROR;
          /* in this order: no playlist at all -> the TS stream; a segment the server's buffer no longer holds -> live; any other network trouble -> ask again (3 times);
             a decoder problem -> recover (2 times); otherwise give up and say why */
          if (net && (d.details === 'manifestLoadError' || d.details === 'manifestLoadTimeOut') && !S.triedTs && window.mpegts) {
            S.triedTs = true; S.rw = false; A.teardownPlayer(); A.showOverlay('Connecting', 'Trying the TS stream', true); startTs(tsUrl); return;
          }
          if (net && d.details === 'fragLoadError' && d.response && d.response.code === 404 && S.rw && S.liveJumps++ < 2) {
            const r = live();
            A.noteFail(`recovering to live: ${d.frag && d.frag.sn != null ? 'segment ' + d.frag.sn + ' gone, ' : ''}at ${Math.round(video.currentTime)}s, buffer ${Math.round(r.lo)}-${Math.round(r.hi)}s`);
            hls.startLoad(-1); return;
          }
          if (net && S.netRetries++ < 3) { hls.startLoad(); return; }
          if (d.type === Hls.ErrorTypes.MEDIA_ERROR && S.mediaRetries++ < 2) { hls.recoverMediaError(); return; }
          const why = `${d.type}/${d.details}${d.response && d.response.code ? ' HTTP ' + d.response.code : ''}${d.frag && d.frag.sn != null ? ' segment ' + d.frag.sn : ''}${d.reason ? ' ' + d.reason : ''}`;
          const r = live();
          A.noteFail(why + ` | at ${Math.round(video.currentTime)}s, buffer ${Math.round(r.lo)}-${Math.round(r.hi)}s`);
          A.fail('This channel isn’t responding');
        });
        hls.loadSource(url);
        hls.attachMedia(video);
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = url;
        const p = video.play(); if (p && p.catch) p.catch(() => {});
      } else A.fail(...A.cantHls);
    }
    function startTs(url) {
      if (!(window.mpegts && mpegts.isSupported())) return A.fail(...A.cantTs);
      const pl = mpegts.createPlayer({ type: 'mpegts', isLive: true, url }, { enableWorker: true, liveBufferLatencyChasing: true, liveBufferLatencyMaxLatency: 8, liveBufferLatencyMinRemain: 1.5, autoCleanupSourceBuffer: true });
      S.ts = pl;
      pl.attachMediaElement(video);
      pl.on(mpegts.Events.ERROR, (type, detail) => { if (S.ts === pl) { A.noteFail(`ts/${type}/${detail}`); A.fail('This channel isn’t responding'); } });
      pl.load();
      const p = pl.play(); if (p && p.catch) p.catch(A.startedOk(() => S.ts === pl));
    }

    /* what the player knows about the stream, for the log lines below: is it paused, is its playlist still being refreshed, is it still loading segments */
    const ago = (t) => Math.round((Date.now() - t) / 1000) + ' s ago';
    const state = () => `${video.paused ? 'paused' : 'playing'}, ready ${video.readyState}, playlist ${S.lvl ? S.lvl.sn + ' (' + S.lvl.n + ' segments) updated ' + ago(S.lvl.at) : 'not seen'}, last segment ${S.frag ? S.frag.sn + ' loaded ' + ago(S.frag.at) : 'none yet'}`;

    /* ---- a picture that jumps by more than a moment is logged: where from, where to, what was loaded, and whether we asked for it (go live, skip, scrub) or the player did on its own ---- */
    let why = '', jl = { t: 0, at: 0, sent: 0 };
    function noteJump(kind, from, to) {
      const now = Date.now(); if (now - jl.sent < 2000) return; jl.sent = now;
      const r = live();
      A.noteFail(`jump (${kind}${why ? ', ' + why : ', by the player'}, ${S.rw ? 'buffered' : S.ts ? 'ts' : 'direct hls'}): ${Math.round(from)}s -> ${Math.round(to)}s, seekable ${Math.round(r.lo)}-${Math.round(r.hi)}s, loaded ${ranges(video.buffered)}, rate ${video.playbackRate}, ${state()}`);
    }
    video.addEventListener('seeking', () => {
      if (!S.vod && S.playing && Math.abs(video.currentTime - jl.t) > 1.5) noteJump('seek', jl.t, video.currentTime);
      why = '';
    });
    video.addEventListener('timeupdate', () => {
      const t = video.currentTime, now = Date.now();
      // time that passed on the clock since the last update bounds how far the picture can honestly have moved
      if (!S.vod && S.playing && !video.seeking && !video.paused && jl.at && t - jl.t > (now - jl.at) / 1000 * video.playbackRate + 1.5) noteJump('silent', jl.t, t);
      // any step backwards, however small: a segment played again shows up here even when it is too short to count as a jump
      if (!S.vod && S.playing && !video.paused && jl.at && t < jl.t - 0.3 && now - (jl.back || 0) > 1000) { jl.back = now; A.noteFail(`stepped back (${video.seeking ? 'seeking' : 'while playing'}, ${S.rw ? 'buffered' : S.ts ? 'ts' : 'direct hls'}): ${jl.t.toFixed(1)}s -> ${t.toFixed(1)}s, loaded ${ranges(video.buffered)}, rate ${video.playbackRate}, ${state()}`); }
      jl.t = t; jl.at = video.paused ? 0 : now;
    });

    /* ---- the watchdog: staying close to live matters more than missing a few seconds. An HLS picture that is "playing" but has not moved for 10 s is
       started again from scratch, as if the channel had been left and come back to: it lands at the live edge. If that picture is also stuck 10 s on,
       it gives up and says so. Short stalls (under 10 s) are left to the spinner. Rewinding and pausing are the viewer's own doing and never trigger this:
       a paused picture is not checked, and a rewound one is moving. ---- */
    let fz = { t: -1, at: 0, tries: 0, cur: '' };
    setInterval(() => {
      const cur = S.current ? S.current.p + '/' + S.current.s : '';
      if (cur !== fz.cur) fz = { t: -1, at: 0, tries: 0, cur };
      // a seek that never finishes counts as frozen too (the position stops where the seek aimed, with the spinner showing), so seeking does not stand the check down
      if (!cur || !S.hls || S.vod || !S.playing || video.paused || (A.busy && A.busy()) || S.tearing) { fz.at = 0; fz.t = -1; return; }
      const t = video.currentTime, now = Date.now();
      if (Math.abs(t - fz.t) > 0.05) { if (Math.abs(t - fz.t) > 3 || !fz.at) fz.tries = 0; fz.t = t; fz.at = now; return; }
      if (!fz.at) fz.at = now;
      if (now - fz.at < 10000) return;
      fz.at = now;
      const r = live();
      A.noteFail(`picture frozen (try ${fz.tries + 1}): at ${Math.round(t)}s, seekable ${Math.round(r.lo)}-${Math.round(r.hi)}s, loaded ${ranges(video.buffered)}, ready ${video.readyState}, ${video.videoWidth}x${video.videoHeight}, ${state()}`);
      if (fz.tries === 0) { fz.tries = 1; A.restart(); }
      else { fz.tries = 2; A.fail('This channel isn’t responding'); }
    }, 2000);

    return { startHls, startTs, live, why: (w) => { why = w; } };
  };
})();
