/**
 * MC carry-forward queue (DETECT-ONLY — never writes to Google Calendar).
 *
 * A task is queued when ALL of:
 *   - it has a due_date, AND
 *   - it is NOT complete (state is one of OPEN_STATES below), AND
 *   - its due_date is today or in the past (due/overdue and still open).
 *
 * The optional habits_needing_confirmation list is read straight from the
 * existing MC-43 detector output (pending_diary_changes, change_type
 * 'missed_habit', status 'pending') — this endpoint computes/serves only and
 * changes NO habit behaviour and writes NOTHING anywhere.
 *
 * Read-only public GET (mirrors public-count.js) so Claude can fetch it and
 * do the calendar side on Alan's instruction.
 */
const { envReady, json, cors, sb } = require('./_lib');

const OPEN_STATES = 'todo,in_progress,waiting';

/** Alan's local day (Europe/London) as YYYY-MM-DD. */
function londonToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function daysBetween(fromYmd, toYmd) {
  const a = new Date(`${fromYmd}T12:00:00Z`);
  const b = new Date(`${toYmd}T12:00:00Z`);
  return Math.round((b - a) / 86400000);
}

module.exports = async function handler(req, res) {
  if (cors(req, res)) return;
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
  const today = londonToday();
  if (!envReady()) {
    return json(res, 200, {
      configured: false, today, count: 0,
      carry_forward: [], habits_needing_confirmation: [], calendar_writes: 0,
    });
  }
  try {
    const tasks = await sb(
      `tasks?select=display_id,title,priority,state,due_date&state=in.(${OPEN_STATES})&due_date=lte.${today}&order=due_date.asc,priority.asc`,
    );
    const carry_forward = (Array.isArray(tasks) ? tasks : []).map((t) => ({
      mc_id: `MC-${t.display_id}`,
      display_id: t.display_id,
      title: t.title,
      priority: t.priority,
      status: t.state,
      original_due_date: t.due_date,
      effective_date: today,
      days_overdue: daysBetween(t.due_date, today),
    }));

    let habits_needing_confirmation = [];
    try {
      const pend = await sb(
        `pending_diary_changes?select=summary,proposed_action,target_date,related_id&change_type=eq.missed_habit&status=eq.pending&order=target_date.asc`,
      );
      habits_needing_confirmation = (Array.isArray(pend) ? pend : []).map((p) => ({
        title: String(p.summary || '').replace(/^Missed habit:\s*/, ''),
        missed_date: p.target_date,
        proposed_action: p.proposed_action,
        related_id: p.related_id,
      }));
    } catch (e) {
      // habits list is optional — never let it block the carry-forward queue
      habits_needing_confirmation = [];
    }

    return json(res, 200, {
      configured: true,
      generated_at: new Date().toISOString(),
      today,
      timezone: 'Europe/London',
      count: carry_forward.length,
      carry_forward,
      habits_needing_confirmation,
      calendar_writes: 0,
    });
  } catch (e) {
    return json(res, 200, {
      configured: true, today, error: 'fail-silent', count: 0,
      carry_forward: [], habits_needing_confirmation: [], calendar_writes: 0,
    });
  }
};
