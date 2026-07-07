/* LT v0.1 — Pre-Session Gate Sequence (strict order; KC steps stay hidden until all pass)
   Gate 0 — Equipment Label Confirmation (type each label exactly; 3 mismatches = blocked)
   Gate 1 — Fitness-for-Use Declaration (4 confirmations; any decline blocks)
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

  for (let i = 0; i < kc.equipment_labels.length; i++) {
    const label = kc.equipment_labels[i];
    const ok = await new Promise((resolve) => {
      body.innerHTML = `
        <div class="gate-heading">Equipment label check ${i + 1} of ${kc.equipment_labels.length}</div>
        <div class="gate-sub">Locate this item and read its physical label. Confirming the label matches puts you at the right equipment.</div>
        <div class="label-card">
          <div class="label-prompt">Find the physical label:</div>
          <div class="label-name">${label}</div>
        </div>
        <div id="label-actions" style="display:flex;flex-direction:column;gap:10px;"></div>
      `;
      const actions = document.getElementById('label-actions');

      const hold = ui.holdButton(`LABEL CONFIRMED: ${label}`, 'press and hold');
      hold.onComplete(() => resolve(true));
      actions.appendChild(hold.el);

      const missing = ui.holdButton('LABEL MISSING OR DOES NOT MATCH', 'press and hold — ends the session', 'danger');
      missing.onComplete(() => resolve(false));
      actions.appendChild(missing.el);
    });

    if (ok) {
      await ledger.append('gate_label_confirm', { session_id: sessionId, method: 'tap', detail: { label } });
    } else {
      await ledger.append('gate_label_mismatch', { session_id: sessionId, detail: { label, reason: 'label missing or does not match' } });
      await ledger.append('gate_declined', {
        session_id: sessionId,
        detail: { gate: 0, reason: `Equipment label not confirmed: ${label}` }
      });
      return { passed: false, reason: `The label "${label}" could not be confirmed at the equipment. Verify you are at the correct equipment, then start a new session.` };
    }
  }

  /* ---------------- Gate 1: Fitness-for-Use Declaration ---------------- */
  setProgress(1);
  title.textContent = 'GATE 1 — FITNESS FOR USE';

  for (let i = 0; i < FITNESS_DECLARATIONS.length; i++) {
    const text = FITNESS_DECLARATIONS[i];
    const isLast = i === 3;

    const choice = await new Promise((resolve) => {
      body.innerHTML = `
        <div class="gate-heading">Declaration ${i + 1} of 4</div>
        <div class="decl-card">${text}</div>
        <div class="decl-actions" id="decl-actions"></div>
      `;
      const actions = document.getElementById('decl-actions');

      const confirmBtn = ui.holdButton('I CONFIRM', 'press and hold');
      confirmBtn.onComplete(() => resolve('confirm'));
      actions.appendChild(confirmBtn.el);

      if (isLast) {
        const na = document.createElement('button');
        na.className = 'btn btn-secondary';
        na.textContent = 'NOT APPLICABLE — STANDARD OPERATION';
        na.addEventListener('click', () => resolve('na'));
        actions.appendChild(na);
      }

      const decline = ui.holdButton('I CANNOT CONFIRM THIS', 'press and hold — ends the session', 'danger');
      decline.onComplete(() => resolve('decline'));
      actions.appendChild(decline.el);
    });

    if (choice === 'decline') {
      await ledger.append('gate_declined', {
        session_id: sessionId,
        detail: { gate: 1, declaration: i + 1, reason: 'Fitness declaration declined' }
      });
      return { passed: false, reason: 'A fitness-for-use declaration could not be confirmed. The equipment must be cleared through your organization before a session can begin.' };
    }
    await ledger.append('gate_fitness_confirm', {
      session_id: sessionId,
      detail: { declaration: i + 1, response: choice === 'na' ? 'not_applicable_standard_operation' : 'confirmed' }
    });
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
