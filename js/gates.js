/* LT v0.1 — Pre-Session Gate Sequence (strict order; KC steps stay hidden until all pass)
   Gate 0 — Equipment Label Confirmation (one checklist screen; all boxes + one hold to confirm)
   Gate 1 — Fitness-for-Use Declaration (one checklist screen; all boxes + one hold to confirm)
   Gate 2 — TECH Authorization attestation
   Gate 3 — Equipment Baseline State Checklist */

import { speak } from './speech.js';

const FITNESS_DECLARATIONS = [
  'This equipment has not been flagged as out of service, damaged, or compromised by any person in this organization.',
  'This equipment has received the required maintenance clearance from an authorized person for this type of operation.',
  'I am not aware of any condition, fault, or anomaly in this equipment that has not been formally reported and cleared.',
  'If this session involves repair or diagnostic work on compromised equipment, I confirm the appropriate repair KC is selected and I am authorized to perform repair operations.'
];

function attestationText(orgName) {
  return `I confirm that ${orgName} has authorized me to perform this procedure on this equipment, ` +
    `that I am in a fit and focused state to begin, and that I understand I will be guided step by step ` +
    `and must not proceed to any step before the system has confirmed the prior step complete.`;
}

const FINE_PRINT = 'Full third-party TECH authorization verification will be available in a future release. ' +
  'During this phase, TECH qualification is the responsibility of the deploying organization.';

export async function runGates(ctx) {
  const { kc, ledger, ui, sessionId } = ctx;
  const title = document.getElementById('gate-title');
  const body = document.getElementById('gate-body');
  const dots = document.getElementById('gate-progress');

  function setProgress(n) {
    dots.innerHTML = [0, 1, 2, 3]
      .map((i) => `<div class="dot ${i < n ? 'done' : i === n ? 'now' : ''}"></div>`)
      .join('');
  }

  ui.show('screen-gate');

  /* ---------------- Gate 0: Equipment Label Confirmation ---------------- */
  setProgress(0);
  title.textContent = 'GATE 0 — EQUIPMENT LABELS';

  /* KCs authored with no equipment have nothing to verify here; the session
     then enters the ledger at the first fitness confirmation instead. */
  const gate0 = kc.equipment_labels.length === 0 ? { ok: true } : await new Promise((resolve) => {
    body.innerHTML = `
      <div class="gate-heading">Equipment label check</div>
      <div class="gate-sub">Locate each item and read its physical label. Check off each label once you have confirmed it at the equipment. All labels must be checked to proceed.</div>
      <div class="check-list" id="label-list"></div>
      <div class="decl-actions" id="label-actions"></div>
    `;
    const list = document.getElementById('label-list');
    const actions = document.getElementById('label-actions');

    kc.equipment_labels.forEach((label) => {
      const item = document.createElement('label');
      item.className = 'check-item';
      item.innerHTML = `
        <input type="checkbox">
        <span class="check-name">${label}</span>
      `;
      list.appendChild(item);
    });
    const boxes = () => [...list.querySelectorAll('input')];

    const hold = ui.holdButton('ALL LABELS CONFIRMED', 'press and hold');
    hold.setDisabled(true);
    hold.onComplete(() => resolve({ ok: true }));
    actions.appendChild(hold.el);

    const missing = ui.holdButton('LABEL MISSING OR DOES NOT MATCH', 'press and hold — ends the session', 'danger');
    missing.onComplete(() => resolve({
      ok: false,
      unchecked: kc.equipment_labels.filter((_, i) => !boxes()[i].checked)
    }));
    actions.appendChild(missing.el);

    list.addEventListener('change', () => {
      boxes().forEach((b) => b.closest('.check-item').classList.toggle('checked', b.checked));
      hold.setDisabled(!boxes().every((b) => b.checked));
    });
  });

  if (gate0.ok) {
    /* The first label confirmation is the session's first ledger entry —
       it carries the session context that session_start used to. */
    for (const label of kc.equipment_labels) {
      const detail = ctx.sessionLogged
        ? { label }
        : {
            label,
            session_context: {
              kc_id: kc.kc_id, kc_version: kc.kc_version, app_version: ctx.appVersion,
              kc_db_id: ctx.kcRef ? ctx.kcRef.id : null,
              profile: ctx.profileName || null
            }
          };
      await ledger.append('gate_label_confirm', { session_id: sessionId, method: 'tap', detail });
      ctx.sessionLogged = true;
    }
  } else {
    /* No label was confirmed: the session never entered the ledger,
       so there is nothing to record and nothing to close out. */
    const which = gate0.unchecked.length ? gate0.unchecked.join(', ') : 'one or more labels';
    return { passed: false, reason: `Labels could not be confirmed at the equipment: ${which}. Verify you are at the correct equipment, then start a new session.` };
  }

  /* ---------------- Gate 1: Fitness-for-Use Declaration ---------------- */
  setProgress(1);
  title.textContent = 'GATE 1 — FITNESS FOR USE';

  const gate1 = await new Promise((resolve) => {
    body.innerHTML = `
      <div class="gate-heading">Fitness-for-use declarations</div>
      <div class="gate-sub">Read each declaration and check it to confirm. All declarations must be checked to proceed.</div>
      <div class="check-list" id="decl-list"></div>
      <div class="decl-actions" id="decl-actions"></div>
    `;
    const list = document.getElementById('decl-list');
    const actions = document.getElementById('decl-actions');

    FITNESS_DECLARATIONS.forEach((text) => {
      const item = document.createElement('label');
      item.className = 'check-item';
      item.innerHTML = `
        <input type="checkbox">
        <span class="check-decl">${text}</span>
      `;
      list.appendChild(item);
    });
    const boxes = () => [...list.querySelectorAll('input')];

    /* Declaration 4 only applies to repair/diagnostic sessions; the N/A toggle
       checks its box and records the response as not-applicable. */
    let lastIsNa = false;
    const na = document.createElement('button');
    na.className = 'btn btn-secondary';
    na.textContent = 'DECLARATION 4 NOT APPLICABLE — STANDARD OPERATION';
    list.appendChild(na);

    const hold = ui.holdButton('I CONFIRM ALL DECLARATIONS', 'press and hold');
    hold.setDisabled(true);
    hold.onComplete(() => resolve({ ok: true, lastIsNa }));
    actions.appendChild(hold.el);

    const decline = ui.holdButton('I CANNOT CONFIRM THIS', 'press and hold — ends the session', 'danger');
    decline.onComplete(() => resolve({
      ok: false,
      unchecked: FITNESS_DECLARATIONS.map((_, i) => i + 1).filter((n) => !boxes()[n - 1].checked)
    }));
    actions.appendChild(decline.el);

    function sync() {
      boxes().forEach((b) => b.closest('.check-item').classList.toggle('checked', b.checked));
      hold.setDisabled(!boxes().every((b) => b.checked));
    }
    na.addEventListener('click', () => {
      lastIsNa = !lastIsNa;
      boxes()[3].checked = lastIsNa;
      na.classList.toggle('na-active', lastIsNa);
      sync();
    });
    list.addEventListener('change', (e) => {
      if (e.target === boxes()[3]) { lastIsNa = false; na.classList.remove('na-active'); }
      sync();
    });
  });

  if (!gate1.ok) {
    /* If nothing has entered the ledger yet (no-equipment KC), a decline here
       leaves no trace — same semantics as declining the first label. */
    if (ctx.sessionLogged) {
      await ledger.append('gate_declined', {
        session_id: sessionId,
        detail: { gate: 1, declarations_unconfirmed: gate1.unchecked, reason: 'Fitness declaration declined' }
      });
    }
    return { passed: false, reason: 'A fitness-for-use declaration could not be confirmed. The equipment must be cleared through your organization before a session can begin.' };
  }
  for (let i = 0; i < FITNESS_DECLARATIONS.length; i++) {
    const detail = { declaration: i + 1, response: i === 3 && gate1.lastIsNa ? 'not_applicable_standard_operation' : 'confirmed' };
    if (!ctx.sessionLogged) {
      /* No-equipment KC: the session's first ledger entry is this confirm,
         so it carries the session context instead of a label confirm. */
      detail.session_context = {
        kc_id: kc.kc_id, kc_version: kc.kc_version, app_version: ctx.appVersion,
        kc_db_id: ctx.kcRef ? ctx.kcRef.id : null,
        profile: ctx.profileName || null
      };
    }
    await ledger.append('gate_fitness_confirm', { session_id: sessionId, detail });
    ctx.sessionLogged = true;
  }

  /* ---------------- Gate 2: TECH Authorization ---------------- */
  setProgress(2);
  title.textContent = 'GATE 2 — AUTHORIZATION';
  const orgName = kc.organization_name || 'the deploying organization';

  await new Promise((resolve) => {
    body.innerHTML = `
      <div class="gate-heading">TECH authorization</div>
      <label class="attest-check">
        <input type="checkbox" id="attest-box">
        <span>${attestationText(orgName)}</span>
      </label>
      <div class="attest-fineprint">${FINE_PRINT}</div>
      <button class="btn btn-primary btn-big" id="attest-continue" disabled>CONTINUE</button>
    `;
    const box = document.getElementById('attest-box');
    const cont = document.getElementById('attest-continue');
    box.addEventListener('change', () => { cont.disabled = !box.checked; });
    cont.addEventListener('click', async () => {
      await ledger.append('gate_auth_confirm', { session_id: sessionId, detail: { organization: orgName } });
      resolve();
    });
  });

  /* ---------------- Gate 3: Equipment Baseline State ---------------- */
  setProgress(3);
  title.textContent = 'GATE 3 — BASELINE STATE';

  for (let i = 0; i < kc.baseline_checklist.length; i++) {
    const item = kc.baseline_checklist[i];
    const ok = await new Promise((resolve) => {
      body.innerHTML = `
        <div class="gate-heading">Baseline check ${i + 1} of ${kc.baseline_checklist.length}</div>
        <div class="gate-sub">Physically verify this condition at the equipment, then confirm.</div>
        <div class="decl-card">${item}</div>
        <div class="decl-actions" id="baseline-actions"></div>
      `;
      const actions = document.getElementById('baseline-actions');

      const confirmBtn = ui.holdButton('CONDITION VERIFIED', 'press and hold');
      confirmBtn.onComplete(() => resolve(true));
      actions.appendChild(confirmBtn.el);

      const notMet = ui.holdButton('CONDITION NOT MET', 'press and hold — ends the session', 'danger');
      notMet.onComplete(() => resolve(false));
      actions.appendChild(notMet.el);
    });

    if (!ok) {
      await ledger.append('gate_declined', {
        session_id: sessionId,
        detail: { gate: 3, reason: `Baseline condition not met: ${item}` }
      });
      return { passed: false, reason: `A baseline condition is not met: "${item}". Resolve the condition, then start a new session.` };
    }
    await ledger.append('gate_baseline_confirm', { session_id: sessionId, detail: { item } });
  }

  await speak('All gates passed. Knowledge container loading.');
  return { passed: true };
}
