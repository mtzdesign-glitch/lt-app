/* LT v0.1 — Speech module
   - speak(): Web Speech API speechSynthesis, deliberate rate (~0.9)
   - VoiceListener: SpeechRecognition wrapper that matches required callout
     keywords and auto-falls back to tap when voice is unavailable
     (mic denied, no network — Android Chrome recognition needs network). */

const SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;

let currentUtteranceResolve = null;

/* Speak text aloud. Resolves when speech ends (or immediately if TTS missing). */
export function speak(text, rate = 0.9) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window) || !text) { resolve(); return; }
    // Cancel anything in progress; only one instruction speaks at a time.
    window.speechSynthesis.cancel();
    if (currentUtteranceResolve) { currentUtteranceResolve(); currentUtteranceResolve = null; }

    const u = new SpeechSynthesisUtterance(text);
    u.rate = rate;
    u.lang = 'en-US';
    currentUtteranceResolve = resolve;
    u.onend = () => { currentUtteranceResolve = null; resolve(); };
    u.onerror = () => { currentUtteranceResolve = null; resolve(); };
    window.speechSynthesis.speak(u);
  });
}

export function stopSpeaking() {
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  if (currentUtteranceResolve) { currentUtteranceResolve(); currentUtteranceResolve = null; }
}

/* Is voice confirmation even worth attempting? */
export function voiceSupported() {
  return SR !== null;
}

/* Does the transcript contain ALL required keywords (case-insensitive, word-boundary)? */
export function matchesCallout(transcript, keywords) {
  const t = ' ' + transcript.toLowerCase().replace(/[^a-z0-9 ]/g, ' ') + ' ';
  return keywords.every((k) => t.includes(' ' + k.toLowerCase() + ' '));
}

/* Listens for a callout — one recognition session per voice window.
   callbacks: onMatch(transcript), onReject(transcript), onUnavailable(reason),
   onStateChange(listening), onSessionEnd() when the session ends on its own */
export class VoiceListener {
  constructor(keywords, callbacks) {
    this.keywords = keywords;
    this.cb = callbacks;
    this.active = false;
    this.suspended = false; // true while TTS is speaking so we don't hear ourselves
    this.rec = null;
  }

  start() {
    if (!SR) { this.cb.onUnavailable('unsupported'); return; }
    if (!navigator.onLine) { this.cb.onUnavailable('offline'); return; }
    this.active = true;
    this._spin();
  }

  _spin() {
    if (!this.active || this.suspended) return;
    const rec = new SR();
    this.rec = rec;
    rec.lang = 'en-US';
    // One continuous session per voice window, not a fresh session every few
    // seconds: Android plays its system listening chime on every recognition
    // start/stop, and each restart steals audio focus from a playing video.
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 4;

    rec.onstart = () => this.cb.onStateChange && this.cb.onStateChange(true);

    rec.onresult = (ev) => {
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        const alts = Array.from(res);
        // Interim transcripts count for matching (faster confirm), but only
        // final ones are logged as rejections — interims are half-sentences.
        const hit = alts.find((a) => matchesCallout(a.transcript, this.keywords));
        if (hit) {
          this.stop();
          this.cb.onMatch(hit.transcript.trim());
          return;
        }
        if (res.isFinal) {
          this.cb.onReject(alts[0] ? alts[0].transcript.trim() : '');
        }
      }
    };

    rec.onerror = (ev) => {
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        this.stop();
        this.cb.onUnavailable('mic-denied');
      } else if (ev.error === 'network') {
        this.stop();
        this.cb.onUnavailable('offline');
      }
      // 'no-speech' / 'aborted' → onend will restart the loop
    };

    rec.onend = () => {
      this.cb.onStateChange && this.cb.onStateChange(false);
      // No auto-restart: Android ends a silent session after ~5s and plays its
      // system chime on every start/stop — restarting would chime again and
      // pause any playing video. The voice window lives and dies with this one
      // session; only an operator action (REPLAY → resume) opens another.
      if (this.active && !this.suspended) {
        this.rec = null;
        this.cb.onSessionEnd && this.cb.onSessionEnd();
      }
    };

    try { rec.start(); } catch { /* already started — ignore */ }
  }

  /* Pause listening while the app itself is speaking. */
  suspend() {
    this.suspended = true;
    if (this.rec) { try { this.rec.abort(); } catch { /* noop */ } }
  }

  resume() {
    if (!this.active) return;
    this.suspended = false;
    this._spin();
  }

  stop() {
    this.active = false;
    this.suspended = false;
    if (this.rec) { try { this.rec.abort(); } catch { /* noop */ } this.rec = null; }
    this.cb.onStateChange && this.cb.onStateChange(false);
  }
}
