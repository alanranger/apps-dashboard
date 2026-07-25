/**
 * §7b directional make-up for a missed habit.
 * missed_habit_direction=backward_if_time_critical: a time-critical habit whose
 * ideal day is blocked rolls to the nearest PRIOR legal slot (earlier, not later);
 * flexible habits keep the forward roll. Neither direction legal → explicit
 * unplaceable (never silent). Pure — no DB / Calendar access.
 */
const { isSchedulableDay, addDays } = require('./scheduling-rules-lib');

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
  const backwardMode = ruleMap.missed_habit_direction === 'backward_if_time_critical'
    && habit.time_critical === true;

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

  if (rolls < maxRolls) {
    const target = firstLegalForward(today, ruleMap, holidays, 14);
    return {
      proposed: `Roll forward to next working day ${target} at ${idealTime} (roll ${rolls + 1}/${maxRolls}). Title: ${recPrefix} ${habit.title}`,
      reason: `Missed occurrence ${lastDue}; policy roll_forward_capped`,
      urgency: 'normal',
      rollsDelta: 1,
    };
  }
  return {
    proposed: `Max rolls (${maxRolls}) used — wait for next natural occurrence of "${habit.title}". Do not auto-clear.`,
    reason: `Missed ${lastDue}; rolls_used=${rolls} at cap`,
    urgency: 'normal',
    rollsDelta: 0,
  };
}

module.exports = { firstLegalForward, nearestPriorLegal, computeMissedProposal };
