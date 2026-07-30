/**
 * Run habit placer for one date window (used by chunked Full horizon).
 * No calendar writes — pending amendments only.
 */
const { gcalConfigured, fetchHorizonEvents } = require('./gcal-lib');
const { runHabitPlacerPropose } = require('./habit-placer-propose-lib');
const { holidaySetFromRows, bankHolidaySet } = require('./scheduling-rules-lib');

function addDaysYmd(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function existingPending(sb, changeType, relatedId) {
  const rows = await sb(
    `pending_diary_changes?status=eq.pending&change_type=eq.${encodeURIComponent(changeType)}`
    + `&related_id=eq.${encodeURIComponent(relatedId)}&limit=1`,
  );
  return rows?.[0];
}

async function runPlacerWindow(sb, fromYmd, toYmd, opts = {}) {
  if (!gcalConfigured()) {
    return { skipped: true, reason: 'gcal not configured', from: fromYmd, to: toYmd };
  }
  const rules = await sb('scheduling_rules?select=key,value');
  const ruleMap = Object.fromEntries((rules || []).map((r) => [r.key, r.value]));
  const y0 = Number(fromYmd.slice(0, 4));
  let holidays = bankHolidaySet(y0 - 1, y0 + 1);
  try {
    const bh = await sb(`bank_holidays?date=gte.${fromYmd}&date=lte.${toYmd}&select=date`);
    const set = holidaySetFromRows(bh || []);
    if (set.size) holidays = set;
  } catch (_) { /* fallback bank set */ }

  const inserted = [];
  const pendingFn = (ct, rid) => existingPending(sb, ct, rid);
  const timeMin = `${fromYmd}T00:00:00Z`;
  const timeMax = `${toYmd}T23:59:59Z`;
  const { events, assessment } = await fetchHorizonEvents(timeMin, timeMax);
  if (!assessment.ok) {
    return {
      skipped: true, reason: assessment.label, from: fromYmd, to: toYmd,
    };
  }
  const result = await runHabitPlacerPropose({
    sb,
    ruleMap,
    holidays,
    fromYmd,
    toYmd,
    gcalEvents: events,
    existingPending: pendingFn,
    inserted,
    writePending: true,
    phaseAnchorYmd: opts.phaseAnchorYmd || fromYmd,
  });
  return {
    from: fromYmd,
    to: toYmd,
    pending_wrote: result.pending_wrote,
    unplaced: result.unplaced?.length || 0,
    create: result.amendment_counts?.CREATE || 0,
    move: result.amendment_counts?.MOVE || 0,
    keep: result.amendment_counts?.KEEP || 0,
    delete: result.amendment_counts?.DELETE || 0,
    proof_ok: !!result.proof?.ok,
  };
}

module.exports = { runPlacerWindow, addDaysYmd };
