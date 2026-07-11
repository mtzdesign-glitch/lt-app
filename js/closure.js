/* LT — Session closure (Deploy Agent)
   Every session that entered the ledger must end with exactly one terminal
   event: session_complete, or session_closed with an explicit reason.
   TESTING is logged as the literal single word so test sessions can be
   filtered out of operational data during analysis. */

export const CLOSURE_OPTIONS = [
  { label: 'EQUIPMENT MALFUNCTION', reason: 'equipment malfunction' },
  { label: 'EMERGENCY', reason: 'emergency' },
  { label: 'POWER OUTAGE', reason: 'power outage' },
  { label: 'TESTING', reason: 'TESTING' },
  { label: 'OTHER (STATE REASON)', reason: null } // freetext
];

/* Closure-reason screen. Returns the reason string to record.
   allowCancel: adds a cancel option and may return null (session stays open).
   Without allowCancel a reason is mandatory — the options re-present until
   one is chosen. */
export async function chooseClosureReason(ui, { allowCancel = false, heading } = {}) {
  const labels = CLOSURE_OPTIONS.map((o) => o.label);
  if (allowCancel) labels.push('CANCEL — DO NOT END SESSION');
  for (;;) {
    const pick = await ui.modal(
      heading || 'This session is ending before completion. The reason will be recorded in the ledger:',
      labels
    );
    if (allowCancel && pick === CLOSURE_OPTIONS.length) return null;
    const opt = CLOSURE_OPTIONS[pick];
    if (opt.reason !== null) return opt.reason;
    const text = await ui.modalInput('State the reason for ending the session:', 'reason');
    if (text !== null && text.trim() !== '') return 'other: ' + text.trim();
    if (allowCancel) return null;
  }
}

/* Append the mandatory terminal event for a session that did not complete. */
export function appendSessionClosed(ledger, { session_id, step_id = null, closed_from, reason, extra = null }) {
  return ledger.append('session_closed', {
    session_id,
    step_id,
    method: 'tap',
    detail: { reason, closed_from, ...(extra || {}) }
  });
}

/* ---- Global abort path (KC schema amendment §1) ----
   An abort is a SAFETY halt on an abnormal condition, distinct from the
   administrative closures above. Reason codes are enumerated (no mandatory
   free text); the set grows as real abort events surface gaps. Every KC type
   gets the generic set; dangerous-equipment KCs add hazard codes; a KC doc
   can extend the menu via an abort_reasons: [{code, label}] array. */

export const ABORT_REASONS_GENERIC = [
  { code: 'abnormal_noise', label: 'ABNORMAL NOISE' },
  { code: 'visible_damage', label: 'VISIBLE DAMAGE' },
  { code: 'wont_start', label: 'EQUIPMENT WON\'T START / OPERATE' },
  { code: 'operator_judgment_other', label: 'OPERATOR JUDGMENT — OTHER CONDITION' }
];

export const ABORT_REASONS_DANGEROUS = [
  { code: 'fuel_smell', label: 'FUEL SMELL' },
  { code: 'co_alarm', label: 'CO ALARM' }
];

export function abortReasonsFor(kc, kcType) {
  const list = kcType === 'dangerous_equipment'
    ? [...ABORT_REASONS_DANGEROUS, ...ABORT_REASONS_GENERIC]
    : [...ABORT_REASONS_GENERIC];
  for (const r of kc.abort_reasons || []) {
    if (r && r.code && r.label && !list.some((x) => x.code === r.code)) list.push(r);
  }
  return list;
}

/* Terminal event for an aborted session. An aborted procedure can never
   resume mid-point — the next session restarts from step 1. */
export function appendSessionAborted(ledger, { session_id, step_id = null, reason_code, reason_label, extra = null }) {
  return ledger.append('session_aborted', {
    session_id,
    step_id,
    method: 'tap',
    detail: { reason_code, reason_label, aborted_at_step: step_id, ...(extra || {}) }
  });
}
