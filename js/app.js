/* LT v0.1 — App controller: screens, UI helpers, wiring. */

import { Ledger } from './ledger.js';
import { runGates } from './gates.js';
import { runSession, loadSnapshot, clearSnapshot } from './session.js';
import { renderReview } from './review.js';

const APP_VERSION = '0.1.0';
const HOLD_SECONDS = 1.5;

/* ---------------- UI helpers ---------------- */

function show(screenId) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  document.getElementById(screenId).classList.add('active');
  window.scrollTo(0, 0);
}

/* Hold-to-confirm button: press and hold 1.5 s. Prevents accidental taps.
   variant: false = green confirm, true = amber critical, 'danger' = red decline/abort */
function holdButton(label, hint, variant = false) {
  const el = document.createElement('button');
  el.className = 'hold-btn' + (variant === 'danger' ? ' danger' : variant ? ' warn' : '');
  el.innerHTML = `
    <span class="hold-fill"></span>
    <span class="hold-label">${label}</span>
    <span class="hold-hint">${hint || 'press and hold'}</span>
  `;
  const fill = el.querySelector('.hold-fill');

  let raf = null;
  let startAt = 0;
  let completeCb = null;
  let fired = false;

  function frame() {
    const pct = Math.min(1, (performance.now() - startAt) / (HOLD_SECONDS * 1000));
    fill.style.width = (pct * 100) + '%';
    if (pct >= 1) {
      cancel(false);
      fill.style.width = '100%';
      if (!fired && completeCb) { fired = true; completeCb(); }
      return;
    }
    raf = requestAnimationFrame(frame);
  }

  function begin(e) {
    if (el.disabled || fired) return;
    e.preventDefault();
    startAt = performance.now();
    raf = requestAnimationFrame(frame);
  }

  function cancel(resetFill = true) {
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    if (resetFill) fill.style.width = '0%';
  }

  el.addEventListener('pointerdown', begin);
  el.addEventListener('pointerup', () => cancel());
  el.addEventListener('pointercancel', () => cancel());
  el.addEventListener('pointerleave', () => cancel());
  el.addEventListener('contextmenu', (e) => e.preventDefault());

  return {
    el,
    onComplete(cb) { completeCb = cb; },
    setDisabled(v) { el.disabled = v; }
  };
}

/* Simple modal. Returns index of the tapped button. */
function modal(text, buttonLabels) {
  return new Promise((resolve) => {
    const wrap = document.getElementById('modal');
    document.getElementById('modal-text').textContent = text;
    const actions = document.getElementById('modal-actions');
    actions.innerHTML = '';
    buttonLabels.forEach((label, i) => {
      const b = document.createElement('button');
      b.className = 'btn ' + (i === 0 ? 'btn-primary' : 'btn-secondary');
      b.textContent = label;
      b.addEventListener('click', () => { wrap.classList.add('hidden'); resolve(i); });
      actions.appendChild(b);
    });
    wrap.classList.remove('hidden');
  });
}

/* Modal with a text input. Returns the typed string, or null if cancelled. */
function modalInput(text, placeholder) {
  return new Promise((resolve) => {
    const wrap = document.getElementById('modal');
    document.getElementById('modal-text').textContent = text;
    const actions = document.getElementById('modal-actions');
    actions.innerHTML = '';

    const input = document.createElement('input');
    input.className = 'label-input';
    input.placeholder = placeholder || '';
    input.autocomplete = 'off';
    actions.appendChild(input);

    const save = document.createElement('button');
    save.className = 'btn btn-primary';
    save.textContent = 'RECORD';
    save.addEventListener('click', () => { wrap.classList.add('hidden'); resolve(input.value); });
    actions.appendChild(save);

    const cancel = document.createElement('button');
    cancel.className = 'btn btn-secondary';
    cancel.textContent = 'CANCEL';
    cancel.addEventListener('click', () => { wrap.classList.add('hidden'); resolve(null); });
    actions.appendChild(cancel);

    wrap.classList.remove('hidden');
    input.focus();
  });
}

let reviewBackTarget = 'screen-home';
function openReview(backTarget = 'screen-home') {
  reviewBackTarget = backTarget;
  renderReview(ctx);
  show('screen-review');
}

const ui = { show, holdButton, modal, modalInput, openReview };

/* ---------------- boot ---------------- */

const ctx = { kc: null, ledger: new Ledger(), ui, sessionId: null };

function newSessionId() {
  const t = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  return `LT-${t}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

async function boot() {
  document.getElementById('app-version').textContent = 'v' + APP_VERSION;

  // Load the Knowledge Container
  try {
    const res = await fetch('kc/pool-cleaning.json');
    ctx.kc = await res.json();
  } catch (e) {
    document.getElementById('home-status').textContent =
      'Could not load the knowledge container. Check the connection and reload.';
    show('screen-home');
    return;
  }

  document.getElementById('home-kc-title').textContent =
    `${ctx.kc.title} — ${ctx.kc.kc_id} v${ctx.kc.kc_version}`;
  document.getElementById('home-status').textContent =
    `${ctx.kc.steps.length} steps · OC: ${ctx.kc.oc_name} · all data stays on this phone`;

  // Service worker for offline app shell + installability
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* app still works online */ });
  }

  wireHome();
  show('screen-home');
  await maybeOfferResume();
}

function wireHome() {
  document.getElementById('btn-start-session').addEventListener('click', startSession);
  document.getElementById('btn-review-mode').addEventListener('click', () => openReview('screen-home'));
  document.getElementById('btn-ledger').addEventListener('click', showLedgerScreen);

  document.querySelectorAll('[data-back]').forEach((b) =>
    b.addEventListener('click', () => show(reviewBackTarget && b.closest('#screen-review') ? reviewBackTarget : 'screen-home')));

  document.getElementById('btn-blocked-home').addEventListener('click', () => show('screen-home'));
  document.getElementById('btn-summary-home').addEventListener('click', () => show('screen-home'));

  document.getElementById('btn-gate-abort').addEventListener('click', async () => {
    const sure = await modal('Exit the gate sequence? No session will start.', ['EXIT', 'CONTINUE GATES']);
    if (sure === 0) {
      await ctx.ledger.append('gate_declined', {
        session_id: ctx.sessionId,
        detail: { gate: 'exit', reason: 'TECH exited the gate sequence' }
      });
      location.reload();
    }
  });

  document.getElementById('btn-export').addEventListener('click', async () => {
    await ctx.ledger.append('export', { detail: { entries: ctx.ledger.entries.length } });
    ctx.ledger.export();
  });

  document.getElementById('btn-verify').addEventListener('click', async () => {
    const out = document.getElementById('verify-result');
    out.textContent = 'Verifying…';
    out.className = 'verify-result';
    const r = await ctx.ledger.verify();
    if (r.ok) {
      out.textContent = `Integrity verified — ${r.count} entries, hash chain intact.`;
      out.className = 'verify-result ok';
    } else {
      out.textContent = `INTEGRITY FAILURE at entry #${r.brokenAt}: ${r.reason}.`;
      out.className = 'verify-result bad';
    }
  });
}

/* ---------------- session flow ---------------- */

async function startSession() {
  ctx.sessionId = newSessionId();
  await ctx.ledger.append('session_start', {
    session_id: ctx.sessionId,
    detail: { kc_id: ctx.kc.kc_id, kc_version: ctx.kc.kc_version, app_version: APP_VERSION }
  });

  const gateResult = await runGates(ctx);
  if (!gateResult.passed) {
    document.getElementById('blocked-reason').textContent = gateResult.reason;
    show('screen-blocked');
    return;
  }

  const result = await runSession(ctx);
  finishSession(result);
}

function finishSession(result) {
  if (result.action === 'complete') {
    const s = result.summary;
    document.getElementById('summary-body').innerHTML = `
      <div class="summary-stat"><span class="k">Duration</span><span class="v">${s.duration}</span></div>
      <div class="summary-stat"><span class="k">Steps confirmed</span><span class="v">${s.steps_confirmed}</span></div>
      <div class="summary-stat"><span class="k">Voice confirmations</span><span class="v">${s.voice}</span></div>
      <div class="summary-stat"><span class="k">Tap confirmations</span><span class="v">${s.tap}</span></div>
      <div class="summary-stat"><span class="k">Interruptions</span><span class="v">${s.interruptions}</span></div>
      <div class="summary-stat"><span class="k">Ledger</span><span class="v">recorded &amp; chained</span></div>
    `;
    show('screen-summary');
  } else if (result.reason === 'restart_forced') {
    document.getElementById('blocked-reason').textContent =
      'The pause exceeded the time limit, so this session was closed. Start a new session — all gates will run again.';
    show('screen-blocked');
  } else {
    show('screen-home');
  }
}

/* Offer to resume a session that was interrupted by an app close / reload. */
async function maybeOfferResume() {
  const snap = loadSnapshot();
  if (!snap) return;

  const thresholdMs = (ctx.kc.interruption_threshold_minutes || 30) * 60 * 1000;
  const elapsed = Date.now() - (snap.last_activity || 0);

  if (elapsed >= thresholdMs) {
    await ctx.ledger.append('session_restart_forced', {
      session_id: snap.session_id,
      detail: { reason: 'app_closed_beyond_threshold', minutes: Math.round(elapsed / 60000) }
    });
    clearSnapshot();
    await modal('A previous session was interrupted for longer than ' +
      (ctx.kc.interruption_threshold_minutes) + ' minutes and has been closed. Start a new session when ready.', ['UNDERSTOOD']);
    return;
  }

  const pick = await modal('A session is in progress (interrupted ' + Math.max(1, Math.round(elapsed / 60000)) +
    ' min ago). Resume with rapid reconfirmation?', ['RESUME SESSION', 'DISCARD SESSION']);
  if (pick === 0) {
    ctx.sessionId = snap.session_id;
    const result = await runSession(ctx, snap);
    finishSession(result);
  } else {
    await ctx.ledger.append('session_abandoned', {
      session_id: snap.session_id,
      detail: 'discarded_after_app_reload'
    });
    clearSnapshot();
  }
}

/* ---------------- ledger screen ---------------- */

function showLedgerScreen() {
  const wrap = document.getElementById('ledger-sessions');
  document.getElementById('verify-result').textContent = '';
  const sums = ctx.ledger.sessionSummaries();
  wrap.innerHTML = sums.length === 0 ? '<p class="review-hint">No sessions recorded yet.</p>' : '';
  for (const s of sums) {
    const d = document.createElement('div');
    d.className = 'ledger-session-card';
    const status = s.completed ? 'COMPLETED' : s.blocked ? 'BLOCKED AT GATE' : 'NOT COMPLETED';
    d.innerHTML = `
      <h3>${s.session_id}</h3>
      <div class="meta">${new Date(s.started).toLocaleString()} — ${status}</div>
      <div class="meta">${s.events} events · ${s.steps_confirmed} steps confirmed
        (${s.voice} voice / ${s.tap} tap) · ${s.interruptions} interruption(s)</div>
    `;
    wrap.appendChild(d);
  }
  show('screen-ledger');
}

boot();
