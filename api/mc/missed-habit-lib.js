/**
 * §7b directional make-up for a missed habit.
 * missed_habit_direction=backward_if_time_critical: a deadline-anchored
 * time-critical habit whose ideal day is blocked rolls to the nearest PRIOR
 * legal slot (earlier, not later). Forward-anchored rrules (BYMONTHDAY /
 * ordinal BYDAY) never roll earlier than the anchor — they roll forward
 * within window_days, or UNPLACEABLE. Flexible habits keep the forward roll.
 * Neither direction legal → explicit unplaceable (never silent). Pure — no
 * DB / Calendar access.
 */
const { isSchedulableDay, addDays } = require('./scheduling-rules-lib');
const { isForwardAnchoredRrule } = require('./rrule-core');

/** First legal working day on or after `fromYmd` (honours holidays). */
function firstLegalOnOrAfter(fromYmd, ruleMap, holidays, maxSteps) {
  let d = fromYmd;
  for (let i = 0; i < maxSteps; i += 1) {
    if (isSchedulableDay(d, ruleMap, holidays)) return d;
    d = addDays(d, 1);
  }
  return null;
}

/** First legal working day strictly after `fromYmd` (honours holidays). */
function firstLegalForward(fromYmd, ruleMap, holidays, maxSteps) {
  let d = fromYmd;
  for (let i = 0; i < maxSteps; i += 1) {
    d = addDays(d, 1);
    if (isSchedulableDay(d, ruleMap, holidays)) return d;
  }
  return null;
}

/**
 * Nearest legal working day strictly before `idealYmd`, not earlier than `floorYmd`
 * (skips weekends/holidays). Returns null if the floor is reached first — i.e. the
 * only prior legal slots are in the past, so a backward make-up is impossible.
 */
function nearestPriorLegal(idealYmd, floorYmd, ruleMap, holidays) {
  let d = idealYmd;
  for (let i = 0; i < 60; i += 1) { // safety cap; floor normally stops the walk
    d = addDays(d, -1);
    if (d < floorYmd) return null;
    if (isSchedulableDay(d, ruleMap, holidays)) return d;
  }
  return null;
}

function computeMissedProposal(ctx) {
  const {
    habit, lastDue, today, ruleMap, holidays, maxRolls,
  } = ctx;
  const idealTime = String(habit.ideal_time || '09:00').slice(0, 5);
  const recPrefix = ruleMap.title_prefix_recurring || 'MC 🔁';
  const rolls = Number(habit.rolls_used || 0);
  const windowDays = Math.max(0, Number(habit.window_days) || 0);
  const forwardAnchored = isForwardAnchoredRrule(habit.rrule);
  const backwardMode = ruleMap.missed_habit_direction === 'backward_if_time_critical'
    && habit.time_critical === true
    && !forwardAnchored;

  // Forward-anchored (Booking Sheet BYMONTHDAY=1, Monthly Accounts 1MO, …):
  // never earlier than the rrule anchor; only forward within window_days.
  if (habit.time_critical === true && forwardAnchored) {
    const ceiling = addDays(lastDue, windowDays);
    if (today > ceiling) {
      return {
        proposed: `UNPLACEABLE (forward-anchor): "${habit.title}" ideal ${lastDue} has passed its window (+${windowDays}d). Do NOT roll before the anchor — decide manually.`,
        reason: `Missed ${lastDue}; forward-anchored rrule; today ${today} > ceiling ${ceiling}`,
        urgency: 'high',
        rollsDelta: 0,
      };
    }
    const startSearch = today > lastDue ? today : lastDue;
    const target = firstLegalOnOrAfter(startSearch, ruleMap, holidays, windowDays + 14);
    if (target && target <= ceiling) {
      return {
        proposed: `Roll FORWARD to ${target} at ${idealTime} (forward-anchored — never before ${lastDue}). Title: ${recPrefix} ${habit.title}`,
        reason: `Missed ${lastDue}; forward-anchored; window_days=${windowDays}`,
        urgency: 'high',
        rollsDelta: 0,
      };
    }
    return {
      proposed: `UNPLACEABLE (forward-anchor): "${habit.title}" has no legal slot on/after ${lastDue} within window_days=${windowDays}.`,
      reason: `Missed ${lastDue}; forward-anchored; no forward legal slot`,
      urgency: 'high',
      rollsDelta: 0,
    };
  }

  if (backwardMode) {
    const back = nearestPriorLegal(lastDue, today, ruleMap, holidays);
    if (back) {
      return {
        proposed: `Roll BACK to nearest prior legal slot ${back} at ${idealTime} (time-critical — earlier, not later). Title: ${recPrefix} ${habit.title}`,
        reason: `Missed ${lastDue}; missed_habit_direction=backward_if_time_critical; time_critical=true`,
        urgency: 'high',
        rollsDelta: 0,
      };
    }
    return {
      proposed: `UNPLACEABLE (backward): "${habit.title}" is time-critical and its ideal day ${lastDue} has passed with no legal slot at/before it still open. Do NOT auto-roll forward — decide manually (do ASAP or Skip this occurrence).`,
      reason: `Missed ${lastDue}; time_critical=true; no prior legal slot >= today ${today}; forward roll suppressed for time-critical`,
      urgency: 'high',
      rollsDelta: 0,
    };
  }

  // Cap tracks how many intentional make-ups Alan has already taken, but an
  // incomplete occurrence must still land on a next legal slot — never drop.
  const target = firstLegalForward(today, ruleMap, holidays, 14);
  if (rolls < maxRolls) {
    return {
      proposed: `Roll forward to next working day ${target} at ${idealTime} (roll ${rolls + 1}/${maxRolls}). Title: ${recPrefix} ${habit.title}`,
      reason: `Missed occurrence ${lastDue}; policy roll_forward_capped`,
      urgency: 'normal',
      rollsDelta: 1,
    };
  }
  return {
    proposed: `Roll forward to next working day ${target} at ${idealTime} (rolls_used=${rolls} at cap ${maxRolls} — still re-pin incomplete; do not drop). Title: ${recPrefix} ${habit.title}`,
    reason: `Missed ${lastDue}; rolls_used=${rolls} at cap; incomplete still rolls`,
    urgency: 'normal',
    rollsDelta: 0,
  };
}

module.exports = {
  firstLegalForward, nearestPriorLegal, computeMissedProposal, firstLegalOnOrAfter,
};
