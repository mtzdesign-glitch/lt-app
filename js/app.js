/* LT v0.1 — App controller: screens, UI helpers, wiring. */

import { Ledger } from './ledger.js';
import { runGates } from './gates.js';
import { runSession, loadSnapshot, clearSnapshot } from './session.js';
import { chooseClosureReason, appendSessionClosed } from './closure.js';
import { renderReview } from './review.js';
import * as backend from './backend.js';
import * as sync from './sync.js';
import { runBuilder } from './builder.js';
import { runPublicManual, runManualViewer, sectionsOf } from './manual.js';
import { runPublishScreen } from './publish.js';

const APP_VERSION = '0.9.2';
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

/* sessionId is set only while a session flow is live, so nothing (e.g. a
   review_view from the home screen) can attach a session to the ledger before
   the first gate label confirm. pendingSessionId is the identity generated on
   app open, held internally until a session actually starts. */
const ctx = {
  kc: null, kcRef: null,            // kcRef = { id, title, kc_type } of the open library KC
  enterprise: null, profileId: null, profileName: null,
  ledger: new Ledger(), ui,
  sessionId: null, pendingSessionId: null,
  sessionLogged: false,   // set by gates.js at the first gate_label_confirm
  appVersion: APP_VERSION
};

let libraryRows = [];     // last-loaded KC library rows (id, kc_type, title, doc, updated_at)

const KC_TYPE_LABELS = {
  procedure: 'PROCEDURE',
  dangerous_equipment: 'DANGEROUS EQUIPMENT / SYSTEMS',
  product_instructions: 'PRODUCT MANUAL'
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function newSessionId() {
  const t = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  return `TAC-${t}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

async function boot() {
  document.getElementById('app-version').textContent = 'v' + APP_VERSION;
  document.getElementById('auth-version').textContent = 'v' + APP_VERSION;

  /* Customer channel: a ?m=<public_id> link (from a QR code on a product)
     opens ONE published product manual — no login, no profiles, no library.
     Everything else about the app stays out of the way. */
  const publicManualId = new URLSearchParams(location.search).get('m');
  if (publicManualId) {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => { /* still works online */ });
    }
    await runPublicManual(publicManualId, ui, APP_VERSION);
    return;
  }

  ctx.pendingSessionId = newSessionId(); // generated on app open, not yet in the ledger

  // Service worker for offline app shell + installability
  if ('serviceWorker' in navigator) {
    // When a new version finishes installing it takes control immediately
    // (skipWaiting + clients.claim). Reload once so the fresh files show on
    // THIS launch instead of the next one — but only from a between-work
    // screen, never mid-session.
    const SAFE_RELOAD_SCREENS = ['screen-auth', 'screen-profile', 'screen-library', 'screen-home'];
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloaded) return; // first-ever install: nothing old to replace
      if (!SAFE_RELOAD_SCREENS.some((id) => document.getElementById(id).classList.contains('active'))) return;
      reloaded = true;
      location.reload();
    });
    navigator.serviceWorker.register('sw.js').catch(() => { /* app still works online */ });
  }

  wireStatic();

  const session = await backend.getSession();
  if (!session) { setAuthMode('login'); show('screen-auth'); return; }
  await enterProfileScreen();
}

/* ---------------- enterprise login screen ---------------- */

let authMode = 'login';

function authMsg(text, cls = '') {
  const el = document.getElementById('auth-msg');
  el.textContent = text;
  el.className = 'auth-msg' + (cls ? ' ' + cls : '');
}

function setAuthMode(mode) {
  authMode = mode;
  document.getElementById('auth-entname-field').hidden = mode === 'login';
  document.getElementById('auth-heading').textContent =
    mode === 'login' ? 'ENTERPRISE LOGIN' : 'CREATE ENTERPRISE ACCOUNT';
  document.getElementById('btn-auth-submit').textContent =
    mode === 'login' ? 'LOG IN' : 'CREATE ACCOUNT';
  document.getElementById('btn-auth-toggle').textContent =
    mode === 'login' ? 'NEW HERE? CREATE AN ENTERPRISE ACCOUNT' : 'ALREADY HAVE AN ACCOUNT? LOG IN';
  authMsg('');
}

async function submitAuth() {
  const email = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  const entName = document.getElementById('auth-entname').value.trim();
  if (!email || !password) { authMsg('Enter email and password.', 'bad'); return; }
  if (authMode === 'signup' && !entName) { authMsg('Enter your enterprise name.', 'bad'); return; }
  if (authMode === 'signup' && password.length < 6) {
    authMsg('The password must be at least 6 characters.', 'bad');
    return;
  }

  const btn = document.getElementById('btn-auth-submit');
  btn.disabled = true;
  authMsg('Working…');
  try {
    if (authMode === 'login') {
      await backend.signIn(email, password);
      await enterProfileScreen();
    } else {
      const r = await backend.signUp(email, password, entName);
      if (r.needsConfirmation) {
        setAuthMode('login');
        authMsg('Account created. Check your email, tap the confirmation link, then log in here.', 'ok');
      } else {
        await enterProfileScreen();
      }
    }
  } catch (e) {
    const m = e.message || '';
    authMsg(
      /rate limit/i.test(m)
        ? 'Too many confirmation emails were sent in the last hour. Wait an hour and try again — or use CONTINUE WITH GOOGLE, which needs no email.'
        : m || 'Could not reach the server. Check the connection.',
      'bad');
  } finally {
    btn.disabled = false;
  }
}

/* ---------------- profile picker ---------------- */

async function enterProfileScreen() {
  const [ent, profs] = await Promise.all([backend.getEnterprise(), backend.listProfiles()]);
  ctx.enterprise = ent.data || ctx.enterprise;

  /* Federated sign-ups arrive with the placeholder enterprise name. */
  if (!ent.offline && ctx.enterprise && ctx.enterprise.name === 'My Enterprise') {
    const name = await modalInput('Welcome! What is the name of your enterprise (company or team)?');
    if (name && name.trim()) {
      try { ctx.enterprise = await backend.renameEnterprise(name.trim()); } catch { /* keep placeholder */ }
    }
  }

  const entEl = document.getElementById('profile-enterprise');
  entEl.innerHTML = '';
  if (ctx.enterprise) {
    const span = document.createElement('span');
    span.textContent = ctx.enterprise.name;
    const edit = document.createElement('button');
    edit.className = 'btn btn-secondary row-edit';
    edit.textContent = '✎';
    edit.setAttribute('aria-label', 'Rename enterprise');
    edit.addEventListener('click', async () => {
      const name = await modalInput('New name for the enterprise:', ctx.enterprise.name);
      if (!name || !name.trim() || name.trim() === ctx.enterprise.name) return;
      try {
        ctx.enterprise = await backend.renameEnterprise(name.trim());
        await enterProfileScreen();
      } catch {
        await modal('Could not rename — check the connection and try again.', ['OK']);
      }
    });
    entEl.append(span, edit);
  }
  document.getElementById('profile-offline').hidden = !profs.offline;

  const list = document.getElementById('profile-list');
  list.innerHTML = '';
  const profiles = profs.data || [];
  const last = backend.lastProfile();
  if (profiles.length === 0) {
    list.innerHTML = '<p class="screen-sub">No profiles yet — create the first one below.</p>';
  }
  for (const p of profiles) {
    const row = document.createElement('div');
    row.className = 'profile-row';
    const b = document.createElement('button');
    b.className = 'btn btn-secondary btn-big';
    b.textContent = p.display_name + (last && last.id === p.id ? '  ·  last used' : '');
    b.addEventListener('click', () => pickProfile(p));
    const edit = document.createElement('button');
    edit.className = 'btn btn-secondary row-edit';
    edit.textContent = '✎';
    edit.setAttribute('aria-label', 'Rename ' + p.display_name);
    edit.addEventListener('click', async () => {
      const name = await modalInput('New name for this profile:', p.display_name);
      if (!name || !name.trim() || name.trim() === p.display_name) return;
      try {
        const upd = await backend.renameProfile(p.id, name.trim());
        if (last && last.id === p.id) backend.rememberProfile(upd);
        await enterProfileScreen();
      } catch {
        await modal('Could not rename — check the connection and try again.', ['OK']);
      }
    });
    row.append(b, edit);
    list.appendChild(row);
  }
  show('screen-profile');
}

async function pickProfile(p) {
  ctx.profileId = p.id;
  ctx.profileName = p.display_name;
  backend.rememberProfile(p);
  await enterLibrary();
}

/* ---------------- KC library ---------------- */

async function enterLibrary() {
  sync.kick(); // push any field captures that are still waiting
  const res = await backend.listKCs();
  libraryRows = res.data || [];
  /* Local edits that haven't synced yet are newer than the server's copy —
     overlay them so authored steps never look lost. Ops are oldest-first,
     so the newest queued doc wins. */
  for (const op of await sync.pendingOps()) {
    if (op.kind !== 'kc_doc_update') continue;
    const row = libraryRows.find((r) => r.id === op.payload.kc_db_id);
    if (row) row.doc = op.payload.doc;
  }
  document.getElementById('library-offline').hidden = !res.offline;
  document.getElementById('library-sub').textContent =
    `${ctx.enterprise ? ctx.enterprise.name + ' · ' : ''}working as ${ctx.profileName}`;
  renderLibrary();
  show('screen-library');
  await resolveIncompleteSession();
}

const SAMPLE_KC_ID = 'KC-POOL-001';

function renderLibrary() {
  /* The sample can only be added once — hide the button while it's in the library. */
  document.getElementById('btn-import-sample').hidden =
    libraryRows.some((r) => r.doc && r.doc.kc_id === SAMPLE_KC_ID);
  const wrap = document.getElementById('kc-list');
  wrap.innerHTML = libraryRows.length === 0
    ? '<p class="screen-sub">No knowledge containers yet. Create one, or add the sample to explore.</p>'
    : '';
  for (const row of libraryRows) {
    const d = document.createElement('div');
    d.className = 'kc-card';
    const steps = row.doc && row.doc.steps ? row.doc.steps.length : 0;
    d.innerHTML = `
      <div class="kc-type-tag">${KC_TYPE_LABELS[row.kc_type] || row.kc_type}</div>
      <h3>${escapeHtml(row.title)}</h3>
      <div class="kc-meta">${steps} step${steps === 1 ? '' : 's'} · updated ${new Date(row.updated_at).toLocaleDateString()}</div>
    `;
    d.addEventListener('click', () => openKC(row));
    wrap.appendChild(d);
  }
}

function openKC(row) {
  ctx.kc = row.doc;
  ctx.kcRef = { id: row.id, title: row.title, kc_type: row.kc_type, published: !!row.published };
  renderKcHome();
  show('screen-home');
}

function renderKcHome() {
  const kc = ctx.kc;
  document.getElementById('home-kc-title').textContent = `${kc.title} — ${kc.kc_id} v${kc.kc_version}`;
  const empty = !kc.steps || kc.steps.length === 0;
  /* A product manual is read by customers, not run by techs: VIEW MANUAL and
     PUBLISH & QR CODE replace START SESSION / REVIEW MODE. */
  const isManual = ctx.kcRef.kc_type === 'product_instructions';
  document.getElementById('btn-start-session').hidden = isManual;
  document.getElementById('btn-review-mode').hidden = isManual;
  document.getElementById('btn-view-manual').hidden = !isManual;
  document.getElementById('btn-publish-kc').hidden = !isManual;
  document.getElementById('btn-start-session').disabled = empty;
  document.getElementById('btn-review-mode').disabled = empty;
  document.getElementById('btn-view-manual').disabled = empty;
  document.getElementById('home-status').textContent = empty
    ? `No steps yet — tap BUILD STEPS to author the first one · working as ${ctx.profileName}`
    : isManual
      ? `${kc.steps.length} steps · ${sectionsOf(kc).length} section${sectionsOf(kc).length === 1 ? '' : 's'} · ${ctx.kcRef.published ? 'LIVE to customers' : 'not published'} · working as ${ctx.profileName}`
      : `${kc.steps.length} steps · OC: ${kc.oc_name} · working as ${ctx.profileName}`;
}

async function createNewKC(kcType) {
  const name = await modalInput(`Name for the new ${KC_TYPE_LABELS[kcType].toLowerCase()} KC:`);
  if (!name || !name.trim()) return;
  const doc = {
    kc_id: 'KC-' + Date.now().toString(36).toUpperCase(),
    kc_version: '0.1.0',
    title: name.trim(),
    kc_type: kcType,
    oc_name: ctx.profileName,
    organization_name: ctx.enterprise ? ctx.enterprise.name : '',
    equipment_labels: [],
    baseline_checklist: [],
    interruption_threshold_minutes: 30,
    voice_window_seconds: 5,
    steps: []
  };
  if (kcType === 'product_instructions') {
    doc.requires_safety_agreement = false; // switched on in PUBLISH & QR CODE
    doc.safety_protocol_text = '';
  }
  try {
    const row = await backend.createKC({ title: doc.title, kcType, doc, createdBy: ctx.profileId });
    libraryRows.push(row);
    renderLibrary();
    openKC(row);
  } catch {
    await modal('Could not create the KC — check the connection and try again.', ['OK']);
  }
}

async function importSampleKC() {
  if (libraryRows.some((r) => r.doc && r.doc.kc_id === SAMPLE_KC_ID)) return; // already in the library
  const btn = document.getElementById('btn-import-sample');
  btn.disabled = true; // a second tap mid-import must not create a double
  try {
    const res = await fetch('kc/pool-cleaning.json');
    const doc = await res.json();
    const row = await backend.createKC({ title: doc.title, kcType: 'procedure', doc, createdBy: ctx.profileId });
    libraryRows.push(row);
    renderLibrary();
  } catch {
    await modal('Could not add the sample KC — check the connection and try again.', ['OK']);
  } finally {
    btn.disabled = false;
  }
}

async function deleteOpenKC() {
  const steps = (ctx.kc.steps || []).length;
  const sure = await modal(
    `Delete "${ctx.kc.title}" (${steps} step${steps === 1 ? '' : 's'}) from the library? Its videos are removed too. This affects everyone in the enterprise and cannot be undone.`,
    ['CANCEL', 'DELETE KC']);
  if (sure !== 1) return;
  try {
    await backend.deleteKC(ctx.kcRef.id);
    backend.cacheRemoveKC(ctx.kcRef.id);
    libraryRows = libraryRows.filter((r) => r.id !== ctx.kcRef.id);
    ctx.kc = null;
    ctx.kcRef = null;
    renderLibrary();
    show('screen-library');
  } catch {
    await modal('Could not delete — check the connection and try again.', ['OK']);
  }
}

async function renameOpenKC() {
  const name = await modalInput('New name for this KC:', ctx.kc.title);
  if (!name || !name.trim() || name.trim() === ctx.kc.title) return;
  try {
    const doc = { ...ctx.kc, title: name.trim() };
    const row = await backend.renameKC(ctx.kcRef.id, name.trim(), doc);
    const i = libraryRows.findIndex((r) => r.id === row.id);
    if (i >= 0) libraryRows[i] = row;
    ctx.kc = row.doc;
    ctx.kcRef.title = row.title;
    renderLibrary();
    renderKcHome();
  } catch {
    await modal('Could not rename — check the connection and try again.', ['OK']);
  }
}

/* ---------------- static wiring ---------------- */

function wireStatic() {
  document.getElementById('btn-auth-submit').addEventListener('click', submitAuth);
  document.getElementById('btn-auth-toggle').addEventListener('click', () =>
    setAuthMode(authMode === 'login' ? 'signup' : 'login'));
  document.getElementById('btn-pw-toggle').addEventListener('click', () => {
    const pw = document.getElementById('auth-password');
    const showing = pw.type === 'text';
    pw.type = showing ? 'password' : 'text';
    document.getElementById('btn-pw-toggle').textContent = showing ? 'SHOW' : 'HIDE';
  });
  document.getElementById('btn-auth-google').addEventListener('click', async () => {
    authMsg('Opening Google sign-in…');
    try {
      await backend.signInWithGoogle(); // navigates away to Google on success
    } catch (e) {
      authMsg(/provider is not enabled|unsupported provider/i.test(e.message || '')
        ? 'Google sign-in is not switched on yet for this app — use email below for now.'
        : (e.message || 'Could not reach the server.'), 'bad');
    }
  });

  document.getElementById('btn-new-profile').addEventListener('click', async () => {
    const name = await modalInput('Name for the new profile (the person doing the work):');
    if (!name || !name.trim()) return;
    try {
      const p = await backend.createProfile(name.trim());
      await pickProfile(p);
    } catch {
      await modal('Could not create the profile — check the connection and try again.', ['OK']);
    }
  });
  document.getElementById('btn-logout').addEventListener('click', async () => {
    const sure = await modal('Log out of this enterprise? The session ledger stays on this phone.', ['CANCEL', 'LOG OUT']);
    if (sure !== 1) return;
    await backend.signOut();
    location.reload();
  });

  document.getElementById('btn-switch-profile').addEventListener('click', enterProfileScreen);
  document.getElementById('btn-new-procedure').addEventListener('click', () => createNewKC('procedure'));
  document.getElementById('btn-new-dangerous').addEventListener('click', () => createNewKC('dangerous_equipment'));
  document.getElementById('btn-new-product').addEventListener('click', () => createNewKC('product_instructions'));
  document.getElementById('btn-import-sample').addEventListener('click', importSampleKC);
  document.getElementById('btn-back-library').addEventListener('click', () => show('screen-library'));
  document.getElementById('btn-rename-kc').addEventListener('click', renameOpenKC);
  document.getElementById('btn-delete-kc').addEventListener('click', deleteOpenKC);
  document.getElementById('btn-build-steps').addEventListener('click', async () => {
    await runBuilder(ctx);
    renderLibrary();  // step counts may have changed
    renderKcHome();
    show('screen-home');
  });

  document.getElementById('btn-start-session').addEventListener('click', startSession);
  document.getElementById('btn-review-mode').addEventListener('click', () => openReview('screen-home'));
  document.getElementById('btn-view-manual').addEventListener('click', async () => {
    /* Company preview: exactly what a customer sees, minus the warranty gate
       (the gate's text is visible on the publish screen). */
    await runManualViewer(ctx.kc, { ui, title: ctx.kc.title, backTo: 'screen-home' });
    show('screen-home');
  });
  document.getElementById('btn-publish-kc').addEventListener('click', async () => {
    const res = await runPublishScreen(ctx);
    if (res) {
      ctx.kcRef.published = res.published;
      const row = libraryRows.find((r) => r.id === ctx.kcRef.id);
      if (row) { row.published = res.published; row.doc = ctx.kc; }
    }
    renderKcHome();
    show('screen-home');
  });
  document.getElementById('btn-ledger').addEventListener('click', showLedgerScreen);

  document.querySelectorAll('[data-back]').forEach((b) =>
    b.addEventListener('click', () => show(
      b.closest('#screen-review') ? reviewBackTarget :
      b.closest('#screen-ledger') ? 'screen-library' : 'screen-home')));

  document.getElementById('btn-blocked-home').addEventListener('click', () => show('screen-home'));
  document.getElementById('btn-summary-home').addEventListener('click', () => show('screen-home'));

  document.getElementById('btn-gate-abort').addEventListener('click', async () => {
    const sure = await modal('Exit the gate sequence? No session will start.', ['EXIT', 'CONTINUE GATES']);
    if (sure === 0) {
      /* Before the first label confirm the session never entered the ledger —
         exiting writes nothing. After it, the exit is a terminal path and
         must close with a recorded reason. */
      if (ctx.sessionLogged) {
        await ctx.ledger.append('gate_declined', {
          session_id: ctx.sessionId,
          detail: { gate: 'exit', reason: 'TECH exited the gate sequence' }
        });
        const reason = await chooseClosureReason(ui);
        await appendSessionClosed(ctx.ledger, {
          session_id: ctx.sessionId, closed_from: 'gate_declined', reason
        });
      }
      location.reload();
    }
  });

  document.getElementById('btn-export').addEventListener('click', async () => {
    await ctx.ledger.append('export', { detail: { entries: ctx.ledger.entries.length } });
    ctx.ledger.export();
  });

  document.getElementById('btn-delete-history').addEventListener('click', async () => {
    const entries = ctx.ledger.entries;
    if (entries.length === 0 ||
        (entries.length === 1 && entries[0].event_type === 'ledger_cleared')) {
      await modal('There is no history to delete.', ['OK']);
      return;
    }
    /* An export appends an 'export' event last, so anything after it means
       there are entries no exported file contains. */
    if (entries[entries.length - 1].event_type !== 'export') {
      const pick = await modal(
        'Some entries have not been exported. Deleting is permanent — export first to keep a copy.',
        ['EXPORT NOW', 'DELETE WITHOUT EXPORTING', 'CANCEL']);
      if (pick === 0) {
        await ctx.ledger.append('export', { detail: { entries: entries.length } });
        ctx.ledger.export();
        return; // tap DELETE HISTORY again once the file is saved
      }
      if (pick === 2) return;
    } else {
      const pick = await modal(
        'Delete all ledger history from this phone? Exported files are not affected. This cannot be undone.',
        ['CANCEL', 'DELETE HISTORY']);
      if (pick === 0) return;
    }
    await ctx.ledger.clear();
    showLedgerScreen(); // re-render: list is empty again
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
  /* A new session cannot start while an incomplete one is unresolved. */
  const resolved = await resolveIncompleteSession();
  if (resolved === 'resumed') return; // the prior session ran instead

  ctx.sessionId = ctx.pendingSessionId;
  ctx.sessionLogged = false;
  /* No ledger entry yet — the session enters the ledger at the first
     successful gate_label_confirm, or not at all. */

  await runGatedSession();
}

/* Gates, then the guided session. Used for new sessions and for continuing
   a session that was interrupted during the gate sequence. */
async function runGatedSession() {
  const gateResult = await runGates(ctx);
  if (!gateResult.passed) {
    /* Terminal path: a session that entered the ledger must close with a
       recorded reason, even when it ends at gate_declined. */
    if (ctx.sessionLogged) {
      const reason = await chooseClosureReason(ui, {
        heading: 'The session ended at a gate. The closure reason will be recorded in the ledger:'
      });
      await appendSessionClosed(ctx.ledger, {
        session_id: ctx.sessionId, closed_from: 'gate_declined', reason
      });
    }
    endSessionContext();
    document.getElementById('blocked-title').textContent = 'SESSION BLOCKED';
    document.getElementById('blocked-reason').textContent = gateResult.reason;
    show('screen-blocked');
    return;
  }

  const result = await runSession(ctx);
  finishSession(result);
}

function endSessionContext() {
  ctx.sessionId = null;
  ctx.sessionLogged = false;
  ctx.pendingSessionId = newSessionId(); // fresh identity for the next session
}

function finishSession(result) {
  endSessionContext();
  if (ctx.kc) renderKcHome(); // a resumed session may end on a KC that was never rendered this launch
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
  } else if (result.reason === 'aborted') {
    document.getElementById('blocked-title').textContent = 'SESSION ABORTED';
    document.getElementById('blocked-reason').textContent =
      `Aborted — ${result.abort.reason_label}. An aborted procedure cannot resume: ` +
      'start a new session from step 1 once the condition is resolved.';
    show('screen-blocked');
  } else {
    show('screen-home');
  }
}

/* ---------------- single active session + crash recovery ----------------

   An incomplete session = started (present in the ledger) but neither
   session_complete nor session_closed. It must be continued or closed out
   (with a recorded reason) before anything else can start. */

/* Recover which library KC a ledger session ran on: its first gate_label_confirm
   carries session_context.kc_id (the KC's logical id inside its doc). */
function kcRowForSession(sessionId) {
  const e = ctx.ledger.entries.find((en) =>
    en.session_id === sessionId && en.detail && en.detail.session_context);
  if (!e) return null;
  return libraryRows.find((r) => r.doc && r.doc.kc_id === e.detail.session_context.kc_id) || null;
}

function findIncompleteSession() {
  const snap = loadSnapshot();
  const latest = ctx.ledger.latestSessionStatus();

  if (snap) {
    if (latest && latest.session_id === snap.session_id && !latest.open) {
      clearSnapshot(); // terminal event already recorded — snapshot is stale
    } else {
      return { kind: 'resumable', snap };
    }
  }
  if (latest && latest.open) {
    return {
      /* gate_declined already recorded but the app closed before the closure
         reason was: only the reason is still owed. Otherwise the app closed
         during the gate sequence, where no resumable state is persisted. */
      kind: latest.declined ? 'needs_closure' : 'unresumable',
      session_id: latest.session_id,
      step_id: latest.lastEvent ? latest.lastEvent.step_id : null
    };
  }
  return null;
}

/* Returns false (nothing to resolve), 'resumed', or 'closed'. */
async function resolveIncompleteSession() {
  const inc = findIncompleteSession();
  if (!inc) return false;

  if (inc.kind === 'resumable') {
    /* The snapshot carries its own copy of the KC, so the right procedure
       resumes no matter which library KC is currently open. */
    if (!inc.snap.kc_doc) {
      await modal('A previous session cannot be continued (it was recorded by an older version of the app). It must be closed out with a recorded reason.', ['RECORD REASON']);
      const reason = await chooseClosureReason(ui);
      await appendSessionClosed(ctx.ledger, {
        session_id: inc.snap.session_id, step_id: inc.snap.current,
        closed_from: 'resume_prompt', reason
      });
      clearSnapshot();
      return 'closed';
    }
    const pick = await modal(`Continue previous session? (${inc.snap.kc_ref ? inc.snap.kc_ref.title : inc.snap.kc_doc.title})`, ['CONTINUE', 'CLOSE OUT']);
    if (pick === 0) {
      ctx.kc = inc.snap.kc_doc;
      ctx.kcRef = inc.snap.kc_ref || null;
      ctx.sessionId = inc.snap.session_id;
      ctx.sessionLogged = true;
      await ctx.ledger.append('session_resumed', {
        session_id: inc.snap.session_id, step_id: inc.snap.current, method: 'tap',
        detail: { resumed_at_step: inc.snap.current, steps_already_confirmed: inc.snap.completed.length }
      });
      const result = await runSession(ctx, inc.snap);
      finishSession(result);
      return 'resumed';
    }
    const reason = await chooseClosureReason(ui, { allowCancel: true });
    if (reason === null) return resolveIncompleteSession(); // backed out — the prompt is the only way past
    await appendSessionClosed(ctx.ledger, {
      session_id: inc.snap.session_id, step_id: inc.snap.current,
      closed_from: 'resume_prompt', reason
    });
    clearSnapshot();
    return 'closed';
  }

  if (inc.kind === 'needs_closure') {
    await modal('The previous session ended at a gate, but its closure reason was never recorded. Record it now.', ['RECORD REASON']);
    const reason = await chooseClosureReason(ui);
    await appendSessionClosed(ctx.ledger, {
      session_id: inc.session_id, step_id: inc.step_id, closed_from: 'gate_declined', reason
    });
    return 'closed';
  }

  /* Interrupted during the gate sequence: gate progress is not persisted, so
     Continue re-runs the gates from the start under the same session id
     (founder decision, 2026-07-10). The KC is recovered from the session's
     ledger context; if it is no longer in the library, closure is the only path. */
  const kcRow = kcRowForSession(inc.session_id);
  if (!kcRow) {
    await modal('A previous session was interrupted during the pre-session gates, and its KC is no longer in this library. It must be closed out with a recorded reason.', ['RECORD REASON']);
    const r = await chooseClosureReason(ui);
    await appendSessionClosed(ctx.ledger, {
      session_id: inc.session_id, step_id: inc.step_id, closed_from: 'resume_prompt',
      reason: r, extra: { interrupted_during: 'gates', kc_unavailable: true }
    });
    return 'closed';
  }
  const pick = await modal(`Continue previous session? (${kcRow.title}) It was interrupted during the pre-session gates, so the gates will run again from the start.`, ['CONTINUE', 'CLOSE OUT']);
  if (pick === 0) {
    ctx.kc = kcRow.doc;
    ctx.kcRef = { id: kcRow.id, title: kcRow.title, kc_type: kcRow.kc_type };
    ctx.sessionId = inc.session_id;
    ctx.sessionLogged = true; // already in the ledger — keep its identity
    await ctx.ledger.append('session_resumed', {
      session_id: inc.session_id, method: 'tap',
      detail: { resumed_at_step: null, resume_point: 'gates_rerun_from_start' }
    });
    await runGatedSession();
    return 'resumed';
  }
  const reason = await chooseClosureReason(ui, { allowCancel: true });
  if (reason === null) return resolveIncompleteSession(); // backed out — the prompt is the only way past
  await appendSessionClosed(ctx.ledger, {
    session_id: inc.session_id, step_id: inc.step_id, closed_from: 'resume_prompt',
    reason, extra: { interrupted_during: 'gates' }
  });
  return 'closed';
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
    const status = s.completed ? 'COMPLETED'
      : s.aborted_reason ? `ABORTED — ${s.aborted_reason.toUpperCase()}`
      : s.closed_reason ? `CLOSED — ${s.closed_reason.toUpperCase()}`
      : s.blocked ? 'BLOCKED AT GATE'
      : 'NOT COMPLETED';
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
