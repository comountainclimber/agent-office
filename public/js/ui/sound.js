// Sound cues: a handful of short synthesized chiptune blips (WebAudio oscillators and noise with
// short envelopes). No audio files; every motif here is original and deliberately tiny.
//
// createSound() -> {
//   level: 'off' | 'critical' | 'all'      critical = needs-you, failures, connection lost
//   volume: 1..4
//   setLevel(level)    plays the needs-you chirp at the new level, so a change is always heard
//   cycle()            off -> critical -> all -> off
//   toggleMute()       off <-> the last audible level
//   setVolume(n) / cycleVolume()            (also plays the chirp: that is how loud it will be)
//   test()             play the needs-you chirp now (false when sound is off or audio is not available)
//   ingest(prev, next, { selectedId })     derive cues from two successive OfficeState snapshots
//   connLost() / connBack()                one low blip per outage
//   onChange(fn)                           fn({ level, volume, armed })
// }
// Rules of the house: nothing plays for the snapshot present at load; simultaneous events become one
// cue; never more than one cue per 1.5 s; the needs-you chirp at most once per 10 s unless the count
// rose from zero; the audio context is only created or resumed inside a user gesture.
import { store, effStatus } from './dom.js';

export const SOUND_LEVELS = ['off', 'critical', 'all'];
export const SOUND_LEVEL_LABEL = { off: 'OFF', critical: 'CRITICAL', all: 'ALL' };
export const VOLUME_STEPS = 4;

const GLOBAL_GAP_MS = 1500;
const COOLDOWN_MS = { need: 10_000, fail: 3000, done: 3000, conn: 30_000, tick: 4000, test: 0 };
const CRITICAL = new Set(['need', 'fail', 'conn']);
const PRIORITY = ['need', 'fail', 'conn', 'done', 'tick']; // when several happen at once, the first of these wins
const MASTER = [0, 0.05, 0.1, 0.18, 0.3]; // master gain per volume step: quiet on purpose (voices peak at about half of this)

const isLive = (t) => t.status === 'starting' || t.status === 'running';

export function createSound() {
  let level = store.get('ao.sound', 'critical');
  if (!SOUND_LEVELS.includes(level)) level = 'critical';
  let lastAudible = store.get('ao.soundLast', 'critical');
  if (lastAudible !== 'critical' && lastAudible !== 'all') lastAudible = 'critical';
  let volume = Number(store.get('ao.volume', '2'));
  if (!(volume >= 1 && volume <= VOLUME_STEPS)) volume = 2;

  /** @type {AudioContext|null} */
  let ctx = null;
  let master = null;
  let noiseBuf = null;
  let gestureSeen = false;
  let lastCueAt = 0;
  const lastAt = {};
  let deferTimer = 0;
  let deferred = null;
  let connDown = false;
  const listeners = new Set();

  const emit = () => { for (const fn of listeners) fn({ level, volume, armed: gestureSeen }); };

  // ---- audio context: only ever touched from inside a user gesture -------------------------------
  function arm() {
    // Escape and bare modifier keys do not count as a user activation: creating a context on those would
    // only earn a console warning. Wait for a gesture the browser accepts.
    const ua = navigator.userActivation;
    if (ua && !ua.hasBeenActive) return;
    gestureSeen = true;
    if (level === 'off') return; // nothing to play: do not even create a context
    try {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = MASTER[volume];
        master.connect(ctx.destination);
      }
      if (ctx.state !== 'running') ctx.resume().catch(() => {});
    } catch { ctx = null; }
  }
  const onGesture = () => { const was = gestureSeen; arm(); if (!was) emit(); };
  window.addEventListener('pointerdown', onGesture, true);
  window.addEventListener('keydown', onGesture, true);

  function ready() {
    return !!ctx && !!master && ctx.state === 'running';
  }

  // ---- voices ----------------------------------------------------------------------------------
  function tone(type, freq, at, dur, peak = 0.5, slideTo = 0) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, at);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, at + dur);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(peak, at + 0.006);
    g.gain.setValueAtTime(peak, at + Math.max(0.006, dur * 0.55));
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(g).connect(master);
    osc.start(at);
    osc.stop(at + dur + 0.02);
  }

  function noise(at, dur, peak = 0.3, highpass = 0) {
    if (!noiseBuf) {
      noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.25), ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      let v = 0;
      for (let i = 0; i < d.length; i++) { if (i % 6 === 0) v = Math.random() * 2 - 1; d[i] = v; } // stepped: crunchy, not hissy
    }
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const g = ctx.createGain();
    g.gain.setValueAtTime(peak, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    let node = src;
    if (highpass) {
      const f = ctx.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = highpass;
      node = src.connect(f);
    }
    node.connect(g).connect(master);
    src.start(at);
    src.stop(at + dur + 0.02);
  }

  const CUES = {
    // the one that matters: a short two-note rising chirp (soft: triangles, with a little square for the edge)
    need(t) { tone('triangle', 660, t, 0.08, 0.6); tone('triangle', 990, t + 0.09, 0.14, 0.6); tone('square', 990, t + 0.09, 0.1, 0.1); },
    // small success arpeggio
    done(t) { [523, 659, 784, 1047].forEach((f, i) => tone('triangle', f, t + i * 0.062, i === 3 ? 0.14 : 0.07, 0.5)); },
    // short descending buzz
    fail(t) { tone('triangle', 233, t, 0.22, 0.6, 98); tone('square', 117, t + 0.02, 0.2, 0.14, 62); noise(t, 0.07, 0.08); },
    // connection lost: one low blip
    conn(t) { tone('triangle', 147, t, 0.2, 0.7); tone('square', 147, t, 0.06, 0.12); },
    // arrivals and meetings (ALL only): a soft tick
    tick(t) { noise(t, 0.022, 0.2, 2400); tone('square', 1320, t, 0.018, 0.08); },
    // the "this is how loud it is" blip
    test(t) { tone('square', 880, t, 0.06, 0.4); },
  };

  function wanted(kind) {
    if (kind === 'test') return true;
    if (level === 'off') return false;
    return level === 'all' || CRITICAL.has(kind);
  }

  function playNow(kind) {
    if (!ready() || !CUES[kind]) return false;
    try {
      CUES[kind](ctx.currentTime + 0.01);
    } catch { return false; }
    const now = Date.now();
    lastAt[kind] = now;
    if (kind !== 'test') lastCueAt = now;
    return true;
  }

  /** Ask for a cue. `force` skips the cue's own cooldown (never the global rate limit). */
  function play(kind, { force = false } = {}) {
    if (!wanted(kind)) return;
    if (ctx && ctx.state !== 'running' && gestureSeen) ctx.resume().catch(() => {}); // e.g. the tab was suspended
    const now = Date.now();
    if (kind === 'test') { playNow('test'); return; }
    if (!force && now - (lastAt[kind] || 0) < COOLDOWN_MS[kind]) return;
    const wait = lastCueAt + GLOBAL_GAP_MS - now;
    if (wait <= 0) { playNow(kind); return; }
    // inside the global gap: critical cues wait their turn (one slot, highest priority wins), the rest are dropped
    if (!CRITICAL.has(kind)) return;
    if (!deferred || PRIORITY.indexOf(kind) < PRIORITY.indexOf(deferred)) deferred = kind;
    if (!deferTimer) {
      deferTimer = setTimeout(() => {
        deferTimer = 0;
        const k = deferred;
        deferred = null;
        if (k && wanted(k)) playNow(k);
      }, wait + 20);
    }
  }

  /** Play one cue right now, outside the rate limits: the TEST button and "this is what you chose". */
  function preview(kind = 'need') {
    if (level === 'off' || !CUES[kind]) return false;
    if (gestureSeen) arm();
    const go = () => {
      if (!ready()) return false;
      try { CUES[kind](ctx.currentTime + 0.01); } catch { return false; }
      lastAt.test = Date.now();
      return true;
    };
    if (ready()) return go();
    if (!ctx) return false;
    ctx.resume().then(go).catch(() => {}); // the context may still be resuming right after the click
    return true;
  }

  // ---- state -> cues ---------------------------------------------------------------------------
  function ingest(prev, next, { selectedId = null } = {}) {
    if (!prev || !next) return; // the picture at load is not news
    const kinds = new Set();
    let forceNeed = false;

    const before = new Map(prev.sessions.map((s) => [s.id, s]));
    // effStatus: someone you just replied to does not count as waiting (and chirps again if it comes back)
    const wasWaiting = prev.sessions.filter((s) => effStatus(s) === 'waiting').length;
    const fresh = next.sessions.filter((s) => effStatus(s) === 'waiting' && effStatus(before.get(s.id)) !== 'waiting');
    // someone you are looking at right now is not news either
    const news = fresh.filter((s) => !(s.id === selectedId && !document.hidden));
    if (news.length) {
      kinds.add('need');
      if (wasWaiting === 0) forceNeed = true; // from "nobody" to "somebody" always gets its chirp
    }

    const prevTasks = new Map((prev.tasks || []).map((t) => [t.id, t]));
    for (const t of next.tasks || []) {
      const pt = prevTasks.get(t.id);
      if (!pt || !isLive(pt) || pt.status === t.status) continue;
      if (t.status === 'failed') kinds.add('fail');
      else if (t.status === 'done') kinds.add('done');
    }

    for (const s of next.sessions) {
      const p = before.get(s.id);
      if (!p) { kinds.add('tick'); continue; }
      const working = (list) => (list || []).filter((x) => x.status === 'working').length;
      if (working(s.subagents) > 0 && working(p.subagents) === 0) kinds.add('tick');
    }

    const kind = PRIORITY.find((k) => kinds.has(k) && wanted(k));
    if (kind) play(kind, { force: kind === 'need' && forceNeed });
  }

  function setLevel(next, { blip = true } = {}) {
    if (!SOUND_LEVELS.includes(next)) return;
    level = next;
    store.set('ao.sound', level);
    if (level !== 'off') { lastAudible = level; store.set('ao.soundLast', level); }
    if (gestureSeen) arm();
    if (level === 'off' && ctx && ctx.state === 'running') ctx.suspend().catch(() => {});
    emit();
    if (blip) preview('need');
  }

  function setVolume(n, { blip = true } = {}) {
    volume = Math.max(1, Math.min(VOLUME_STEPS, Math.round(n)));
    store.set('ao.volume', volume);
    if (master && ctx) master.gain.setValueAtTime(MASTER[volume], ctx.currentTime);
    emit();
    if (blip) preview('need');
  }

  return {
    get level() { return level; },
    get volume() { return volume; },
    get armed() { return gestureSeen; },
    cycle() { setLevel(SOUND_LEVELS[(SOUND_LEVELS.indexOf(level) + 1) % SOUND_LEVELS.length]); },
    toggleMute() { setLevel(level === 'off' ? lastAudible : 'off'); },
    setLevel,
    setVolume,
    cycleVolume() { setVolume(volume >= VOLUME_STEPS ? 1 : volume + 1); },
    ingest,
    play,
    test: () => preview('need'),
    connLost() { if (connDown) return; connDown = true; play('conn', { force: true }); },
    connBack() { connDown = false; },
    onChange(fn) { listeners.add(fn); fn({ level, volume, armed: gestureSeen }); return () => listeners.delete(fn); },
    /** For tests and the console: what would be allowed right now. */
    debug: () => ({ level, volume, armed: gestureSeen, ctx: ctx ? ctx.state : 'none', lastCueAt, lastAt: { ...lastAt }, deferred }),
  };
}
