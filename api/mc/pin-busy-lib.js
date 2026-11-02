/**
 * Alan 2026-11-02: anything he moves by hand (diary_manual_pin habits, slot_pinned
 * tasks) shows as Busy in Google/Outlook — never "Free" like ordinary MC blocks.
 */

function pinLookbackYmd(now = Date.now()) {
  return new Date(now - 86400000).toISOString().slice(0, 10);
}

async function loadPinnedEventIds(sb, fromYmd = pinLookbackYmd()) {
  const habitPins = await sb(
    `recurring_log?roll_reason=eq.diary_manual_pin&calendar_event_id=not.is.null`
    + `&scheduled_date=gte.${fromYmd}&select=calendar_event_id&limit=5000`,
  );
  const taskPins = await sb(
    `tasks?slot_pinned=eq.true&calendar_event_id=not.is.null`
    + `&scheduled_start=gte.${fromYmd}&select=calendar_event_id&limit=5000`,
  );
  const ids = (habitPins || []).concat(taskPins || []).map((r) => r.calendar_event_id);
  return new Set(ids.filter(Boolean));
}

module.exports = { loadPinnedEventIds, pinLookbackYmd };
