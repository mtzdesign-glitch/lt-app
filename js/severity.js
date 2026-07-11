/* LT — step severity tiers (KC schema amendment: dangerous equipment).
   standard        — normal step, generic confirmation
   critical        — correctable failure; prerequisites verified before it runs
   critical_safety — non-correctable failure; requires a named safety assertion
                     the TECH actively checks, logged verbatim in the ledger.
   Older KCs carry only the boolean `critical`; severity is derived from it so
   no existing content ever needs a rewrite. */

export function sevOf(step) {
  if (step.severity) return step.severity;
  return step.critical ? 'critical' : 'standard';
}

export const SEVERITY_BADGE = {
  critical: 'CRITICAL ACTION',
  critical_safety: 'CRITICAL SAFETY'
};
