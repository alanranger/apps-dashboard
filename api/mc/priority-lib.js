/** Shared mc_priority rank + daily-cap placement simulation (no Calendar access). */

const PRIORITY_ORDER = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'];
const PRIORITY_RANK = Object.fromEntries(PRIORITY_ORDER.map((p, i) => [p, i]));

function priorityRank(p) {
  return PRIORITY_RANK[p] ?? 9;
}

function compareByPriority(a, b) {
  const d = priorityRank(a.priority) - priorityRank(b.priority);
  if (d !== 0) return d;
  const ak = a.kind === 'task' ? 0 : 1;
  const bk = b.kind === 'task' ? 0 : 1;
  if (ak !== bk) return ak - bk;
  return String(a.title || '').localeCompare(String(b.title || ''));
}

/** Higher priority placed first; lower priority displaced when cap exceeded — never skipped. */
function simulateDayPlacement(items, capMin) {
  const sorted = [...items].sort(compareByPriority);
  const placed = [];
  const displaced = [];
  let used = 0;
  for (const item of sorted) {
    const mins = Number(item.duration_min) || 0;
    if (mins <= 0) {
      placed.push({ ...item, placement: 'fits', roll_forward: false });
      continue;
    }
    if (used + mins <= capMin) {
      used += mins;
      placed.push({ ...item, placement: 'fits', minutes: mins, roll_forward: false });
    } else {
      displaced.push({
        ...item,
        placement: 'displaced',
        roll_forward: true,
        reason: 'lower_priority_than_cap',
        cap_min: capMin,
        minutes_used_before: used,
        minutes_needed: mins,
      });
    }
  }
  return { placed, displaced, minutes_used: used, cap_min: capMin, item_count: items.length };
}

module.exports = {
  PRIORITY_ORDER, PRIORITY_RANK, priorityRank, compareByPriority, simulateDayPlacement,
};
