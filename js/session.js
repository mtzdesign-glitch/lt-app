/* LT v0.1 — Active Session (Deploy Agent)
   Sterile, gated, spoken. The next step is never rendered or spoken until the
   current step's confirmation is in the ledger. CRM language rule: the system
   frames verification as the system doing its job — never doubt of the TECH. */

import { speak, stopSpeaking, voiceSupported, VoiceListener } from './speech.js';

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

export async function runSession(ctx, resumeState = null) {
  const { kc, ledger, ui } = ctx;
  const stepById = new Map(kc.steps.map((s) => [s.step_id, s]));
  const thresholdMs = (kc.interruption_threshold_minutes || 30) * 60 * 1000;

  const state = resumeState || {
    session_id: ctx.sessionId,
    current: kc.steps[0].step_id,
    completed: [],            // [{step_id, title}] in confirmation order
    confirmations: { voice: 0, tap: 0 },
    interruptions: 0,
    started_at: Date.now()
  };
  const sessionId = state.session_id;

  const body = document.getElementById('session-body');
  const progressEl = document.getElementById('session-progress');
  const pauseBtn = document.getElementById('btn-pause');

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
  }

  /* ---------- session begin (user gesture → fullscreen, wake lock, DND reminder) ---------- */
  ui.show('screen-session');
  pauseBtn.style.display = 'none';
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
      await ledger.append(resumeState ? 'interruption_end' : 'dnd_reminder',
        resumeState
          ? { session_id: sessionId, detail: 'resumed_from_app_reload' }
          : { session_id: sessionId, detail: 'acknowledged' });
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
    progressEl.textContent = `STEP ${stepIndex + 1} / ${kc.steps.length}`;
    pauseBtn.style.display = '';

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

    body.innerHTML = `
      <div class="step-card ${step.critical ? 'critical' : ''}">
        ${step.critical ? '<div class="critical-banner">CRITICAL ACTION</div>' : ''}
        <div class="step-title">${step.title}</div>
        <div class="step-label-tag">${step.equipment_label || ''}</div>
        <p class="step-instruction">${step.instruction}</p>
        ${step.failure_note ? `<div class="failure-note">${step.failure_note}</div>` : ''}
      </div>
      ${step.video ? `
        <video class="step-video" src="${step.video}" preload="metadata" controls playsinline></video>
      ` : ''}
      <button class="btn btn-replay" id="btn-replay">&#128266; REPLAY INSTRUCTION</button>
      <div id="confirm-area" style="display:flex;flex-direction:column;gap:14px;"></div>
    `;

    const confirmArea = document.getElementById('confirm-area');

    const speakStep = async () => {
      const text = (step.critical ? 'Critical action. Verify before execution. ' : '') + step.phraseology;
      await speak(text);
      await ledger.append('step_spoken', { session_id: sessionId, step_id: step.step_id });
    };
    let listener = null;
    let pauseRequested = null; // set by pause button while a stage is running
    let rearmVoiceWindow = () => {}; // assigned in stage 2 while a voice window exists

    document.getElementById('btn-replay').addEventListener('click', () => {
      if (listener) listener.suspend();
      rearmVoiceWindow(); // operator asked to hear it again — give a fresh window
      speakStep().then(() => { if (listener) { listener.resume(); rearmVoiceWindow(); } });
    });

    const onPauseClick = () => { pauseRequested = true; if (listener) listener.stop(); stopSpeaking(); };
    pauseBtn.onclick = onPauseClick;

    await speakStep();

    /* ----- stage 1 for critical steps: prerequisite verification (tap required) ----- */
    if (step.critical && step.critical_prerequisites.length > 0) {
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

        // pause can interrupt stage 1
        const iv = setInterval(() => {
          if (pauseRequested) { clearInterval(iv); resolve('paused'); }
        }, 200);
      });

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
    const voiceWindowS = kc.voice_window_seconds || 15;

    const result = await new Promise((resolve) => {
      const status = document.createElement('div');
      status.className = 'voice-status';
      status.innerHTML = `<div class="mic-dot"></div><div class="voice-text">Preparing voice confirmation…</div>`;
      confirmArea.appendChild(status);
      const statusText = status.querySelector('.voice-text');

      const hold = ui.holdButton(step.required_callout.toUpperCase(), 'press and hold to confirm', step.critical);
      confirmArea.appendChild(hold.el);
      hold.onComplete(() => finish({ method: 'tap', detail: null }));

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
        if (pauseRequested && !done) {
          done = true;
          if (listener) { listener.stop(); listener = null; }
          stopCountdown();
          clearInterval(iv);
          resolve({ paused: true });
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
        statusText.innerHTML = `Listening for callout: <span class="callout-want">“${step.required_callout}”</span> · voice closes in ${left}s`;
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

      if (voiceSupported() && navigator.onLine) {
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
            // time, so a permission prompt doesn't eat into the 15 seconds.
            if (on && !armed) { armed = true; rearmVoiceWindow(); }
          }
        });
        listener.start();
      } else {
        statusText.textContent = (voiceSupported() ? 'Voice needs a network connection' : 'Voice not supported on this device')
          + ' — confirm with the hold button below.';
      }
    });

    if (result.paused) return await pauseFlow(step);

    state.confirmations[result.method]++;
    await ledger.append('step_confirmed', {
      session_id: sessionId, step_id: step.step_id, method: result.method, detail: result.detail
    });

    pauseBtn.onclick = null;
    if (result.spoken) {
      await speak(result.spoken);
    } else {
      await speak(`${step.required_callout}. Confirmed.`);
    }

    /* ----- post-step decision (IF/THEN branch, e.g. after S13) ----- */
    if (step.post_decision) {
      const choice = await new Promise((resolve) => {
        body.innerHTML = `
          <div class="decision-block">
            <div class="decision-prompt">${step.post_decision.prompt}</div>
            <div id="decision-actions" style="display:flex;flex-direction:column;gap:12px;"></div>
          </div>
        `;
        const actions = document.getElementById('decision-actions');
        step.post_decision.options.forEach((opt) => {
          const h = ui.holdButton(opt.label, 'press and hold');
          h.onComplete(() => resolve(opt));
          actions.appendChild(h.el);
        });
        speak(step.post_decision.prompt);
      });
      await ledger.append('branch_decision', {
        session_id: sessionId, step_id: step.step_id, method: 'tap',
        detail: { decision: choice.detail, goto: choice.goto }
      });
      await speak(choice.spoken);
      return { action: 'goto', target: choice.goto };
    }

    return { action: 'advance' };
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
    noteEl.textContent = `Resume within ${kc.interruption_threshold_minutes} minutes for rapid reconfirmation. After that, the session restarts from the beginning.`;
    const tick = setInterval(() => { timerEl.textContent = fmtClock(Date.now() - pausedAt); }, 500);

    const choice = await new Promise((resolve) => {
      document.getElementById('btn-resume').onclick = () => resolve({ type: 'resume' });
      document.getElementById('btn-abandon').onclick = async () => {
        const reason = await chooseAbandonReason();
        if (reason !== null) resolve({ type: 'abandon', reason });
      };
      document.getElementById('btn-goto-step').onclick = async () => {
        const target = await chooseJumpTarget();
        if (target !== null) resolve({ type: 'jump', target });
        else ui.show('screen-pause'); // cancelled — stay paused
      };
      document.getElementById('btn-pause-review').onclick = () => { ui.openReview('screen-pause'); };
    });
    clearInterval(tick);

    if (choice.type === 'abandon') {
      await ledger.append('session_abandoned', {
        session_id: sessionId, step_id: step.step_id,
        detail: { reason: choice.reason, elapsed_pause_ms: Date.now() - pausedAt }
      });
      clearSnapshot();
      return { action: 'exit', reason: 'abandoned' };
    }

    const elapsed = Date.now() - pausedAt;
    if (elapsed >= thresholdMs) {
      await ledger.append('session_restart_forced', {
        session_id: sessionId, step_id: step.step_id,
        detail: { pause_minutes: Math.round(elapsed / 60000), threshold_minutes: kc.interruption_threshold_minutes }
      });
      clearSnapshot();
      await ui.modal('The pause exceeded ' + kc.interruption_threshold_minutes + ' minutes. To protect the procedure, the session must restart from the beginning, including all gates.', ['UNDERSTOOD']);
      return { action: 'exit', reason: 'restart_forced' };
    }

    if (choice.type === 'jump') {
      await ledger.append('step_jump', {
        session_id: sessionId, step_id: step.step_id, method: 'tap',
        detail: { from: step.step_id, to: choice.target, reason: 'TECH selected a different step' }
      });
      await ledger.append('interruption_end', { session_id: sessionId, step_id: step.step_id, detail: { pause_ms: elapsed, resumed_at: choice.target } });
      return { action: 'jumpto', target: choice.target };
    }

    ui.show('screen-session');
    if (state.completed.length > 0) await rapidReconfirm();
    await ledger.append('interruption_end', { session_id: sessionId, step_id: step.step_id, detail: { pause_ms: elapsed } });
    return { action: 'repeat' }; // re-present the current step in full
  }

  /* ---- END SESSION: record why. Returns reason string, or null if cancelled. ---- */
  async function chooseAbandonReason() {
    const options = ['EQUIPMENT MALFUNCTION', 'EMERGENCY', 'POWER OUTAGE', 'OTHER (STATE REASON)', 'CANCEL — STAY PAUSED'];
    const pick = await ui.modal('Ending the session before completion. The reason will be recorded in the ledger:', options);
    if (pick === 4) return null;
    if (pick === 3) {
      const text = await ui.modalInput('State the reason for ending the session:', 'reason');
      if (text === null || text.trim() === '') return null;
      return 'other: ' + text.trim();
    }
    return options[pick].toLowerCase();
  }

  /* ---- GO TO A DIFFERENT STEP: pick a step, hold to confirm. Returns step_id or null. ---- */
  function chooseJumpTarget() {
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
          (s.critical ? ' <span class="badge-critical">CRITICAL</span>' : '');
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
