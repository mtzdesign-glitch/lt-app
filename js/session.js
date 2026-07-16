/* LT v0.1 — Active Session (Deploy Agent)
   Sterile, gated, spoken. The next step is never rendered or spoken until the
   current step's confirmation is in the ledger. CRM language rule: the system
   frames verification as the system doing its job — never doubt of the TECH. */

import { speak, stopSpeaking, voiceSupported, VoiceListener } from './speech.js';
import { chooseClosureReason, appendSessionClosed, abortReasonsFor, appendSessionAborted } from './closure.js';
import { sevOf, SEVERITY_BADGE } from './severity.js';
import { mediaUrl } from './backend.js';

const SNAPSHOT_KEY = 'lt_active_session';

export function loadSnapshot() {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function clearSnapshot() {
  localStorage.removeItem(SNAPSHOT_KEY);
}

function saveSnapshot(state) {
  localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ ...state, last_activity: Date.now() }));
}

function fmtClock(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function fmtDuration(ms) {
  const min = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  return min > 0 ? `${min} min ${sec} s` : `${sec} s`;
}

const JUMP_WARNING = 'You are skipping steps including critical safety checks. Proceeding accepts full responsibility for verifying these manually.';

export async function runSession(ctx, resumeState = null) {
  const { kc, ledger, ui } = ctx;
  const stepById = new Map(kc.steps.map((s) => [s.step_id, s]));

  const state = resumeState || {
    session_id: ctx.sessionId,
    kc_ref: ctx.kcRef || null,  // library identity of the KC this session runs on
    kc_doc: kc,                 // full KC copy so a crash can resume the right procedure
    current: kc.steps[0].step_id,
    completed: [],            // [{step_id, title}] in confirmation order
    confirmations: { voice: 0, tap: 0 },
    interruptions: 0,
    started_at: Date.now()
  };
  const sessionId = state.session_id;

  /* Persist state from the first moment: a crash at any point after the gates
     must leave a session that can be continued at its last known step. */
  if (!resumeState) saveSnapshot(state);

  const body = document.getElementById('session-body');
  const progressEl = document.getElementById('session-progress');
  const pauseBtn = document.getElementById('btn-pause');
  const abortBtn = document.getElementById('btn-abort');
  const kcType = kc.kc_type || (ctx.kcRef ? ctx.kcRef.kc_type : null);

  let wakeLock = null;
  let sessionLive = true;

  async function acquireWakeLock() {
    if (!('wakeLock' in navigator)) {
      await ledger.append('wake_lock_status', { session_id: sessionId, detail: 'unsupported' });
      return;
    }
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      await ledger.append('wake_lock_status', { session_id: sessionId, detail: 'acquired' });
      wakeLock.addEventListener('release', () => {
        if (sessionLive) ledger.append('wake_lock_status', { session_id: sessionId, detail: 'released' });
      });
    } catch (e) {
      await ledger.append('wake_lock_status', { session_id: sessionId, detail: 'failed: ' + e.message });
    }
  }

  const onVisibility = () => {
    if (document.visibilityState === 'visible' && sessionLive) acquireWakeLock();
  };
  document.addEventListener('visibilitychange', onVisibility);

  function cleanup() {
    sessionLive = false;
    document.removeEventListener('visibilitychange', onVisibility);
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    stopSpeaking();
    pauseBtn.style.display = 'none';
    abortBtn.style.display = 'none';
    abortBtn.onclick = null;
  }

  /* ---------- session begin (user gesture → fullscreen, wake lock, DND reminder) ---------- */
  ui.show('screen-session');
  pauseBtn.style.display = 'none';
  abortBtn.style.display = 'none';
  progressEl.textContent = '';

  await new Promise((resolve) => {
    body.innerHTML = `
      <div class="step-card">
        <div class="step-title">${resumeState ? 'Resuming session' : 'Session ready'}</div>
        <p class="step-instruction">The screen will stay awake and the app will go full screen.
        Enable <strong>Do Not Disturb</strong> on this phone now, so notifications cannot interrupt the procedure.</p>
      </div>
      <button class="btn btn-primary btn-big" id="btn-begin">DO NOT DISTURB IS ON — BEGIN</button>
    `;
    document.getElementById('btn-begin').addEventListener('click', async () => {
      try { await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); } catch { /* not fatal */ }
      await acquireWakeLock();
      /* On resume, session_resumed has already been written at the
         continue/close-out prompt — one event per lifecycle transition. */
      if (!resumeState) await ledger.append('dnd_reminder', { session_id: sessionId, detail: 'acknowledged' });
      resolve();
    });
  });

  /* Rapid reconfirmation when resuming with prior completed steps. */
  if (resumeState && state.completed.length > 0) {
    await rapidReconfirm();
  }

  /* ---------- main gated loop ---------- */
  while (state.current) {
    const step = stepById.get(state.current);
    const stepIndex = kc.steps.findIndex((s) => s.step_id === step.step_id);
    progressEl.textContent = `STEP ${stepIndex + 1} / ${kc.steps.length}`
      + (step.phase ? ` · ${String(step.phase).toUpperCase()}` : '');
    pauseBtn.style.display = '';
    abortBtn.style.display = '';

    const outcome = await runStep(step);

    if (outcome.action === 'exit') { cleanup(); return outcome; }
    if (outcome.action === 'repeat') continue;
    if (outcome.action === 'jumpto') {
      state.current = outcome.target;
      saveSnapshot(state);
      continue;
    }

    state.completed.push({ step_id: step.step_id, title: step.title });

    let next = null;
    if (outcome.action === 'goto') {
      next = outcome.target;
    } else {
      next = stepIndex + 1 < kc.steps.length ? kc.steps[stepIndex + 1].step_id : null;
    }
    state.current = next;
    saveSnapshot(state);
  }

  /* ---------- completion ---------- */
  const durationMs = Date.now() - state.started_at;
  const summary = {
    duration: fmtDuration(durationMs),
    steps_confirmed: state.completed.length,
    voice: state.confirmations.voice,
    tap: state.confirmations.tap,
    interruptions: state.interruptions
  };
  await ledger.append('session_complete', { session_id: sessionId, detail: summary });
  clearSnapshot();
  cleanup();
  await speak('Procedure complete. All steps confirmed. Session closed.');
  return { action: 'complete', summary };

  /* ================= step runner ================= */

  async function runStep(step) {
    await ledger.append('step_presented', { session_id: sessionId, step_id: step.step_id });

    const sev = sevOf(step);
    /* critical_safety demands an active, named assertion (schema amendment §2):
       the assertion text is displayed, must be checked, and is logged verbatim. */
    const assertion = sev === 'critical_safety' && step.safety_assertion ? step.safety_assertion : null;

    body.innerHTML = `
      <div class="step-card ${sev === 'critical_safety' ? 'critical safety' : sev === 'critical' ? 'critical' : ''}">
        ${sev !== 'standard' ? `<div class="critical-banner ${sev === 'critical_safety' ? 'safety' : ''}">${SEVERITY_BADGE[sev]}</div>` : ''}
        <div class="step-title">${step.title}</div>
        <div class="step-label-tag">${step.equipment_label || ''}</div>
        <p class="step-instruction">${step.instruction}</p>
        ${step.failure_note ? `<div class="failure-note">${step.failure_note}</div>` : ''}
      </div>
      ${step.video ? `
        <video class="step-video" preload="metadata" controls playsinline></video>
      ` : ''}
      <button class="btn btn-replay" id="btn-replay">&#128266; REPLAY INSTRUCTION</button>
      <div id="confirm-area" style="display:flex;flex-direction:column;gap:14px;"></div>
    `;

    if (step.video) {
      const vidEl = body.querySelector('.step-video');
      /* Bundled clips resolve to themselves; vault clips get a signed URL.
         Offline vault clips degrade to a note — the step still runs. */
      mediaUrl(step.video)
        .then((u) => { vidEl.src = u; })
        .catch(() => {
          const note = document.createElement('div');
          note.className = 'no-video';
          note.textContent = 'Video unavailable offline — guided by text and voice.';
          vidEl.replaceWith(note);
        });
    }

    const confirmArea = document.getElementById('confirm-area');

    const speakStep = async () => {
      const prefix = sev === 'critical_safety' ? 'Critical safety step. Verify before execution. '
        : sev === 'critical' ? 'Critical action. Verify before execution. ' : '';
      await speak(prefix + step.phraseology);
      await ledger.append('step_spoken', { session_id: sessionId, step_id: step.step_id });
    };
    let listener = null;
    let pauseRequested = null; // set by pause button while a stage is running
    let abortRequested = false; // set by the persistent abort button
    let rearmVoiceWindow = () => {}; // assigned in stage 2 while a voice window exists

    document.getElementById('btn-replay').addEventListener('click', () => {
      if (listener) listener.suspend();
      rearmVoiceWindow(); // operator asked to hear it again — give a fresh window
      speakStep().then(() => { if (listener) { listener.resume(); rearmVoiceWindow(); } });
    });

    const onPauseClick = () => { pauseRequested = true; if (listener) listener.stop(); stopSpeaking(); };
    pauseBtn.onclick = onPauseClick;
    const onAbortClick = () => { abortRequested = true; if (listener) listener.stop(); stopSpeaking(); };
    abortBtn.onclick = onAbortClick;

    await speakStep();

    /* ----- stage 1 for critical steps: prerequisite verification (tap required) ----- */
    if (sev !== 'standard' && (step.critical_prerequisites || []).length > 0) {
      const stage1 = await new Promise((resolve) => {
        const block = document.createElement('div');
        block.className = 'prereq-block';
        block.innerHTML = `<h4>STAGE 1 — VERIFY PREREQUISITES</h4>` +
          step.critical_prerequisites.map((p, i) => `
            <label class="prereq-item"><input type="checkbox" data-prereq="${i}"><span>${p}</span></label>
          `).join('');
        confirmArea.appendChild(block);

        const holdEl = ui.holdButton('PREREQUISITES VERIFIED', 'press and hold', true);
        holdEl.setDisabled(true);
        confirmArea.appendChild(holdEl.el);

        const boxes = Array.from(block.querySelectorAll('input[type=checkbox]'));
        boxes.forEach((b) => b.addEventListener('change', () => {
          holdEl.setDisabled(!boxes.every((x) => x.checked));
        }));

        holdEl.onComplete(() => resolve('confirmed'));

        // pause or abort can interrupt stage 1
        const iv = setInterval(() => {
          if (abortRequested) { clearInterval(iv); resolve('aborted'); }
          else if (pauseRequested) { clearInterval(iv); resolve('paused'); }
        }, 200);
      });

      if (stage1 === 'aborted') {
        const aborted = await abortFlow(step);
        return aborted || { action: 'repeat' }; // cancelled abort re-presents the step
      }
      if (stage1 === 'paused') return await pauseFlow(step);

      await ledger.append('critical_prereq_confirm', {
        session_id: sessionId, step_id: step.step_id, method: 'tap',
        detail: { prerequisites: step.critical_prerequisites }
      });
      await speak('Prerequisites verified. Execute.');
      confirmArea.innerHTML = '';
    }

    /* ----- stage 2: execution confirmation — one spoken request, then a timed
       voice window; when it closes, press-and-hold is the only confirmation.
       The app never speaks again on its own: long steps (e.g. S07) proceed at
       the operator's discretion without audible interruptions. ----- */
    /* Capped at 5s: Android kills a silent recognition session after ~5s with
       an unavoidable system chime, so a longer window only buys chime-and-
       restart cycles that also pause any playing video. Existing KC docs still
       say 15 — the cap here fixes them all without touching the database. */
    const voiceWindowS = Math.min(kc.voice_window_seconds || 5, 5);

    const result = await new Promise((resolve) => {
      const status = document.createElement('div');
      status.className = 'voice-status';
      status.innerHTML = `<div class="mic-dot"></div><div class="voice-text">Preparing voice confirmation…</div>`;
      confirmArea.appendChild(status);
      const statusText = status.querySelector('.voice-text');

      /* critical_safety: the named assertion must be actively checked before
         the confirm unlocks — a distinct affirmative act, not a generic tap. */
      let assertBox = null;
      if (assertion) {
        const item = document.createElement('label');
        item.className = 'check-item assert-item';
        item.innerHTML = `<input type="checkbox"><span class="check-decl">${assertion}</span>`;
        confirmArea.appendChild(item);
        assertBox = item.querySelector('input');
        assertBox.addEventListener('change', () => {
          item.classList.toggle('checked', assertBox.checked);
          hold.setDisabled(!assertBox.checked);
        });
      }

      const hold = ui.holdButton(step.required_callout.toUpperCase(), 'press and hold to confirm', sev !== 'standard');
      confirmArea.appendChild(hold.el);
      hold.onComplete(() => finish({ method: 'tap', detail: null }));
      if (assertion) hold.setDisabled(true);

      let alt = null;
      if (step.alternate_confirm) {
        alt = ui.holdButton(step.alternate_confirm.label, 'press and hold', true);
        confirmArea.appendChild(alt.el);
        alt.onComplete(() => finish({ method: 'tap', detail: step.alternate_confirm.detail, spoken: step.alternate_confirm.spoken }));
      }

      let done = false;
      let deadline = 0;
      let tickIv = null;

      function stopCountdown() {
        if (tickIv) { clearInterval(tickIv); tickIv = null; }
      }
      function finish(r) {
        if (done) return;
        done = true;
        if (listener) { listener.stop(); listener = null; }
        stopCountdown();
        clearInterval(iv);
        resolve(r);
      }

      const iv = setInterval(() => {
        if ((pauseRequested || abortRequested) && !done) {
          done = true;
          if (listener) { listener.stop(); listener = null; }
          stopCountdown();
          clearInterval(iv);
          resolve(abortRequested ? { aborted: true } : { paused: true });
        }
      }, 200);

      const showHoldOnly = (msg) => {
        status.classList.remove('listening');
        statusText.textContent = msg;
      };

      const closeVoiceWindow = () => {
        if (done || !listener) return;
        listener.stop();
        listener = null;
        stopCountdown();
        showHoldOnly('Voice window closed — press and hold to confirm when ready.');
        ledger.append('voice_window_closed', {
          session_id: sessionId, step_id: step.step_id,
          detail: { window_seconds: voiceWindowS }
        });
      };

      const renderCountdown = () => {
        if (done || !listener) return;
        const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
        statusText.innerHTML = `Listening for callout: <span class="callout-want">“${step.required_callout}”</span> · voice closes in <span class="countdown-num">${left}</span>s`;
        if (left <= 0) closeVoiceWindow();
      };

      /* Start/restart the voice window. Re-armed only by the operator's own
         REPLAY INSTRUCTION tap — the app itself never extends or repeats. */
      rearmVoiceWindow = () => {
        if (done || !listener) return;
        deadline = Date.now() + voiceWindowS * 1000;
        if (!tickIv) tickIv = setInterval(renderCountdown, 250);
        renderCountdown();
      };

      if (assertion) {
        /* Voice cannot stand in for the assertion: confirmation is the checked
           assertion plus press-and-hold, nothing less. */
        statusText.textContent = 'Critical safety step — check the assertion above, then press and hold to confirm.';
      } else if (voiceSupported() && navigator.onLine) {
        let armed = false;
        listener = new VoiceListener(step.callout_keywords, {
          onMatch: (transcript) => finish({ method: 'voice', detail: { transcript } }),
          onReject: (transcript) => {
            // Logged for the record, but silent: one spoken request per step,
            // no talk-back while the operator works.
            ledger.append('callout_rejected', {
              session_id: sessionId, step_id: step.step_id, method: 'voice',
              detail: { heard: transcript, required: step.required_callout }
            });
          },
          onUnavailable: (reason) => {
            const why = reason === 'mic-denied' ? 'Microphone unavailable'
              : reason === 'offline' ? 'Voice needs a network connection'
              : 'Voice not supported on this device';
            listener = null;
            stopCountdown();
            showHoldOnly(`${why} — confirm with the hold button below.`);
          },
          onStateChange: (on) => {
            status.classList.toggle('listening', on);
            // The window starts when the mic is actually live for the first
            // time, so a permission prompt doesn't eat into the window.
            if (on && !armed) { armed = true; rearmVoiceWindow(); }
          },
          // Android ended the session on its own (~5s of silence) — the window
          // closes with it rather than restarting the mic (each restart chimes
          // and pauses video).
          onSessionEnd: () => closeVoiceWindow()
        });
        listener.start();
      } else {
        statusText.textContent = (voiceSupported() ? 'Voice needs a network connection' : 'Voice not supported on this device')
          + ' — confirm with the hold button below.';
      }
    });

    if (result.aborted) {
      const aborted = await abortFlow(step);
      return aborted || { action: 'repeat' }; // cancelled abort re-presents the step
    }
    if (result.paused) return await pauseFlow(step);

    state.confirmations[result.method]++;
    await ledger.append('step_confirmed', {
      session_id: sessionId, step_id: step.step_id, method: result.method,
      detail: assertion
        ? { ...(result.detail || {}), severity: 'critical_safety', assertion }
        : result.detail
    });

    pauseBtn.onclick = null;
    if (result.spoken) {
      await speak(result.spoken);
    } else {
      await speak(`${step.required_callout}. Confirmed.`);
    }

    /* ----- post-step decision (IF/THEN branch, e.g. after S13) ----- */
    if (step.post_decision) {
      for (;;) {
        const choice = await new Promise((resolve) => {
          body.innerHTML = `
            <div class="decision-block">
              <div class="decision-prompt">${step.post_decision.prompt}</div>
              <div id="decision-actions" style="display:flex;flex-direction:column;gap:12px;"></div>
            </div>
          `;
          const actions = document.getElementById('decision-actions');
          let done = false;
          const fin = (v) => { if (done) return; done = true; clearInterval(aiv); resolve(v); };
          step.post_decision.options.forEach((opt) => {
            const h = ui.holdButton(opt.label, 'press and hold');
            h.onComplete(() => fin(opt));
            actions.appendChild(h.el);
          });
          const aiv = setInterval(() => { if (abortRequested) fin({ aborted: true }); }, 200);
          speak(step.post_decision.prompt);
        });
        if (choice.aborted) {
          const aborted = await abortFlow(step, { at: 'post_decision' });
          if (aborted) return aborted;
          abortRequested = false;
          continue; // cancelled abort re-presents the decision
        }
        await ledger.append('branch_decision', {
          session_id: sessionId, step_id: step.step_id, method: 'tap',
          detail: { decision: choice.detail, goto: choice.goto }
        });
        await speak(choice.spoken);
        return { action: 'goto', target: choice.goto };
      }
    }

    return { action: 'advance' };
  }

  /* ================= global abort (schema amendment §1) =================
     A safety halt available from every screen of an active session. The
     operator picks an enumerated condition; the session ends with a distinct
     session_aborted terminal event and can never resume — the procedure
     restarts from step 1 next time. Returns the exit outcome, or null when
     the operator cancels back to work. */

  async function abortFlow(step, extraDetail = null) {
    ui.show('screen-session');
    pauseBtn.style.display = 'none';
    abortBtn.style.display = 'none';
    progressEl.textContent = 'ABORT';
    stopSpeaking();

    const pick = await new Promise((resolve) => {
      body.innerHTML = `
        <div class="step-card safety">
          <div class="critical-banner safety">ABORT — ABNORMAL CONDITION</div>
          <div class="step-title">Stop this session</div>
          <p class="step-instruction">Select the condition you observed. The session ends immediately
          and the abort is recorded in the ledger. An aborted procedure cannot be resumed —
          it must restart from step 1 once the condition is resolved.</p>
        </div>
        <div id="abort-actions" style="display:flex;flex-direction:column;gap:12px;"></div>
      `;
      const actions = document.getElementById('abort-actions');
      for (const r of abortReasonsFor(kc, kcType)) {
        const h = ui.holdButton(r.label, 'press and hold — ends the session', 'danger');
        h.onComplete(() => resolve(r));
        actions.appendChild(h.el);
      }
      const cancel = document.createElement('button');
      cancel.className = 'btn btn-secondary';
      cancel.textContent = 'CANCEL — CONTINUE THE PROCEDURE';
      cancel.addEventListener('click', () => resolve(null));
      actions.appendChild(cancel);
    });

    if (!pick) {
      pauseBtn.style.display = '';
      abortBtn.style.display = '';
      return null;
    }

    await appendSessionAborted(ledger, {
      session_id: sessionId, step_id: step.step_id,
      reason_code: pick.code, reason_label: pick.label,
      extra: { steps_confirmed: state.completed.length, ...(extraDetail || {}) }
    });
    clearSnapshot();
    cleanup();
    await speak('Session aborted. The event is recorded. This procedure must restart from step one.');
    return { action: 'exit', reason: 'aborted', abort: { reason_code: pick.code, reason_label: pick.label } };
  }

  /* ================= pause / interruption ================= */

  async function pauseFlow(step) {
    state.interruptions++;
    const pausedAt = Date.now();
    await ledger.append('interruption_start', { session_id: sessionId, step_id: step.step_id });
    saveSnapshot({ ...state, paused_at: pausedAt });

    ui.show('screen-pause');
    const timerEl = document.getElementById('pause-timer');
    const noteEl = document.getElementById('pause-note');
    noteEl.textContent = 'The session stays open until you resume it or end it with a recorded reason. Completed steps are reconfirmed on resume.';
    const tick = setInterval(() => { timerEl.textContent = fmtClock(Date.now() - pausedAt); }, 500);

    const choice = await new Promise((resolve) => {
      document.getElementById('btn-resume').onclick = () => resolve({ type: 'resume' });
      document.getElementById('btn-pause-abort').onclick = async () => {
        const aborted = await abortFlow(step, { from: 'pause' });
        if (aborted) resolve({ type: 'aborted', outcome: aborted });
        else ui.show('screen-pause'); // cancelled — stay paused
      };
      document.getElementById('btn-abandon').onclick = async () => {
        const reason = await chooseClosureReason(ui, { allowCancel: true });
        if (reason !== null) resolve({ type: 'abandon', reason });
      };
      document.getElementById('btn-goto-step').onclick = async () => {
        const jump = await chooseJumpTarget(step);
        if (jump !== null) resolve({ type: 'jump', ...jump });
        else ui.show('screen-pause'); // cancelled — stay paused
      };
      document.getElementById('btn-pause-review').onclick = () => { ui.openReview('screen-pause'); };
    });
    clearInterval(tick);

    const elapsed = Date.now() - pausedAt;

    /* Abort already wrote its terminal event, cleared the snapshot, and
       cleaned up inside abortFlow — just propagate the exit. */
    if (choice.type === 'aborted') return choice.outcome;

    if (choice.type === 'abandon') {
      await appendSessionClosed(ledger, {
        session_id: sessionId, step_id: step.step_id, closed_from: 'manual_abandon',
        reason: choice.reason, extra: { elapsed_pause_ms: elapsed }
      });
      clearSnapshot();
      return { action: 'exit', reason: 'closed' };
    }

    if (choice.type === 'jump') {
      await ledger.append('step_jump', {
        session_id: sessionId, step_id: step.step_id, method: 'tap',
        detail: {
          from: step.step_id,
          to: choice.target,
          reason: 'TECH selected a different step',
          risk_accepted: true,
          warning_text: JUMP_WARNING,
          skipped_steps: choice.skipped,
          skipped_critical_prereq_confirms: choice.skipped
            .filter((s) => s.critical_prerequisites.length > 0)
            .map((s) => ({ step_id: s.step_id, prerequisites: s.critical_prerequisites }))
        }
      });
      await ledger.append('interruption_end', { session_id: sessionId, step_id: step.step_id, detail: { pause_ms: elapsed, resumed_at: choice.target } });
      return { action: 'jumpto', target: choice.target };
    }

    ui.show('screen-session');
    if (state.completed.length > 0) await rapidReconfirm();
    await ledger.append('interruption_end', { session_id: sessionId, step_id: step.step_id, detail: { pause_ms: elapsed } });
    return { action: 'repeat' }; // re-present the current step in full
  }

  /* ---- GO TO A DIFFERENT STEP: pick a step, accept the risk, execute.
     Returns { target, skipped } or null if cancelled at any point. ---- */
  async function chooseJumpTarget(fromStep) {
    for (;;) {
      const target = await pickJumpStep();
      if (target === null) return null;
      const skipped = computeSkippedSteps(fromStep.step_id, target);
      const accepted = await confirmJumpRisk(target, skipped);
      if (accepted) return { target, skipped };
      // risk warning declined — back to the step list
    }
  }

  /* Steps bypassed by jumping from the current (unconfirmed) step forward to
     the target: everything in sequence order from current up to (excluding)
     the target, minus steps already confirmed this session. Backward jumps
     bypass nothing — those steps will be run again. */
  function computeSkippedSteps(fromId, toId) {
    const fromIdx = kc.steps.findIndex((s) => s.step_id === fromId);
    const toIdx = kc.steps.findIndex((s) => s.step_id === toId);
    if (toIdx <= fromIdx) return [];
    const confirmed = new Set(state.completed.map((c) => c.step_id));
    return kc.steps.slice(fromIdx, toIdx)
      .filter((s) => !confirmed.has(s.step_id))
      .map((s) => ({
        step_id: s.step_id,
        title: s.title,
        critical: sevOf(s) !== 'standard',
        severity: sevOf(s),
        critical_prerequisites: s.critical_prerequisites || []
      }));
  }

  /* Risk-acceptance warning shown before every jump. The ledger entry it
     produces enumerates the skipped steps and their critical prerequisites,
     so a reviewer needs no cross-reference to the KC. */
  function confirmJumpRisk(target, skipped) {
    return new Promise((resolve) => {
      const targetIdx = kc.steps.findIndex((s) => s.step_id === target);
      progressEl.textContent = 'CONFIRM JUMP';

      const skippedHtml = skipped.length === 0
        ? '<p class="step-instruction">No pending steps are bypassed by this jump.</p>'
        : '<p class="step-instruction">Steps that will be skipped without confirmation:</p>' +
          skipped.map((s) => `
            <div class="failure-note">
              ${s.step_id} — ${s.title}${s.critical ? ' <span class="badge-critical">CRITICAL</span>' : ''}
              ${s.critical_prerequisites.length > 0
                ? `<br>Critical prerequisites that will NOT be verified:<br>• ${s.critical_prerequisites.join('<br>• ')}`
                : ''}
            </div>`).join('');

      body.innerHTML = `
        <div class="step-card critical">
          <div class="critical-banner">STEP JUMP — RISK ACCEPTANCE</div>
          <div class="step-title">Jumping to step ${targetIdx + 1}</div>
          <p class="step-instruction">${JUMP_WARNING}</p>
          ${skippedHtml}
        </div>
        <div id="jump-warning-actions" style="display:flex;flex-direction:column;gap:10px;"></div>
      `;
      const actions = document.getElementById('jump-warning-actions');

      const accept = ui.holdButton('I ACCEPT FULL RESPONSIBILITY — EXECUTE JUMP', 'press and hold', 'danger');
      accept.onComplete(() => resolve(true));
      actions.appendChild(accept.el);

      const back = document.createElement('button');
      back.className = 'btn btn-secondary';
      back.textContent = 'GO BACK — DO NOT JUMP';
      back.addEventListener('click', () => resolve(false));
      actions.appendChild(back);
    });
  }

  /* ---- step picker: returns step_id or null if cancelled. ---- */
  function pickJumpStep() {
    return new Promise((resolve) => {
      ui.show('screen-session');
      pauseBtn.style.display = 'none';
      progressEl.textContent = 'SELECT STEP';

      body.innerHTML = `
        <div class="step-card">
          <div class="step-title">Go to a different step</div>
          <p class="step-instruction">Select the step to continue from. The jump is recorded in the ledger. Guidance resumes at the selected step.</p>
        </div>
        <div id="jump-list" style="display:flex;flex-direction:column;gap:8px;"></div>
        <div id="jump-actions" style="display:flex;flex-direction:column;gap:10px;"></div>
      `;

      const list = document.getElementById('jump-list');
      const actions = document.getElementById('jump-actions');
      let selected = null;

      kc.steps.forEach((s, i) => {
        const row = document.createElement('button');
        row.className = 'btn btn-secondary step-pick';
        row.innerHTML = `<span class="step-num">${String(i + 1).padStart(2, '0')}</span> ${s.title}` +
          (sevOf(s) !== 'standard' ? ' <span class="badge-critical">CRITICAL</span>' : '');
        row.addEventListener('click', () => {
          list.querySelectorAll('.step-pick').forEach((r) => r.classList.remove('selected'));
          row.classList.add('selected');
          selected = s.step_id;
          hold.setDisabled(false);
        });
        list.appendChild(row);
      });

      const hold = ui.holdButton('START FROM SELECTED STEP', 'press and hold');
      hold.setDisabled(true);
      hold.onComplete(() => resolve(selected));
      actions.appendChild(hold.el);

      const cancel = document.createElement('button');
      cancel.className = 'btn btn-tertiary';
      cancel.textContent = 'CANCEL — BACK TO PAUSE';
      cancel.addEventListener('click', () => resolve(null));
      actions.appendChild(cancel);
    });
  }

  /* ================= rapid reconfirmation ================= */

  async function rapidReconfirm() {
    pauseBtn.style.display = 'none';
    progressEl.textContent = 'RECONFIRM';
    body.innerHTML = `
      <div class="step-card">
        <div class="step-title">Rapid reconfirmation</div>
        <p class="step-instruction">Confirming the record matches the work already done. Tap COMPLETE as each completed step is read aloud.</p>
      </div>
      <div id="reconfirm-list"></div>
    `;
    const list = document.getElementById('reconfirm-list');

    for (let i = 0; i < state.completed.length; i++) {
      const c = state.completed[i];
      const row = document.createElement('div');
      row.className = 'reconfirm-item';
      row.innerHTML = `<span>${i + 1}. ${c.title}</span>`;
      const btn = document.createElement('button');
      btn.className = 'btn btn-primary';
      btn.textContent = 'COMPLETE';
      row.appendChild(btn);
      list.appendChild(row);
      row.scrollIntoView({ block: 'nearest' });

      await speak(`Step. ${c.title}.`);
      await new Promise((resolve) => { btn.onclick = resolve; });
      btn.disabled = true;
      row.classList.add('done');
      await ledger.append('rapid_reconfirm', { session_id: sessionId, step_id: c.step_id, method: 'tap' });
    }
    await speak('Reconfirmation complete. Resuming procedure.');
  }
}
