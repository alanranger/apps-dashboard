const {
  bankHolidaySet, ruleMapFromRows, workingWindow, isSchedulableDay,
  isoToLondonDate, isoToLondonMinutes,
} = require('./scheduling-rules-lib');

function breachesForBlock(block, ruleMap, holidays) {
  const date = isoToLondonDate(block.start);
  const endDate = isoToLondonDate(block.end);
  const win = workingWindow(ruleMap, date);
  const startMin = isoToLondonMinutes(block.start);
  const endMin = endDate === date ? isoToLondonMinutes(block.end) : win.end_min;
  const reasons = [];
  if (!isSchedulableDay(date, ruleMap, holidays)) reasons.push('non_schedulable_day');
  if (ruleMap.exclude_bank_holidays === 'true' && holidays.has(date)) reasons.push('bank_holiday');
  if (startMin != null && win.start_min != null && startMin < win.start_min) {
    reasons.push(`starts_before_${win.start}`);
  }
  if (endMin != null && win.end_min != null && endMin > win.end_min) {
    reasons.push(`ends_after_${win.end}`);
  }
  return { date, reasons, win, duration: Math.max(0, (endMin || 0) - (startMin || 0)) };
}

function proposeSlot(date, win, durationMin) {
  const startH = Math.floor(win.start_min / 60);
  const startM = win.start_min % 60;
  const endTotal = win.start_min + durationMin;
  const eh = Math.floor(endTotal / 60);
  const em = endTotal % 60;
  return `Move to ${date} ${String(startH).padStart(2, '0')}:${String(startM).padStart(2, '0')}–${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')} (next legal slot honouring ${durationMin}m block)`;
}

function buildRuleBreachProposals(blocks, ruleMap, pinnedIds) {
  const capMin = Number(ruleMap.daily_task_cap_min || 240);
  const gapMin = Number(ruleMap.decompress_after_task_min || 30);
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const holidays = bankHolidaySet(Number(today.slice(0, 4)) - 1, Number(today.slice(0, 4)) + 1);
  const proposals = [];
  const byDay = {};

  for (const b of blocks) {
    const did = Number(b.display_id);
    if (b.slot_pinned || pinnedIds.has(did)) continue;
    const br = breachesForBlock(b, ruleMap, holidays);
    if (!br.reasons.length) {
      byDay[br.date] = (byDay[br.date] || 0) + br.duration;
      continue;
    }
    const startHm = isoToLondonMinutes(b.start);
    const startLabel = startHm != null
      ? `${String(Math.floor(startHm / 60)).padStart(2, '0')}:${String(startHm % 60).padStart(2, '0')}`
      : '?';
    proposals.push({
      change_type: 'rule_breach',
      summary: `Rule breach: MC-${did} starts ${startLabel}, before ${br.win.start} window`,
      proposed_action: proposeSlot(br.date, br.win, br.duration || 45),
      reason: br.reasons.join('; '),
      related_id: `breach:${did}:${br.date}`,
      target_date: br.date,
      urgency: 'normal',
    });
  }

  for (const [day, total] of Object.entries(byDay)) {
    if (total <= capMin) continue;
    proposals.push({
      change_type: 'rule_breach',
      summary: `Rule breach: ${total}m MC work on ${day} exceeds ${capMin}m cap`,
      proposed_action: `Spread blocks across following legal days within ${capMin}m/day cap`,
      reason: `daily_task_cap_min=${capMin}`,
      related_id: `breach:cap:${day}`,
      target_date: day,
      urgency: 'normal',
    });
  }

  for (let i = 0; i < blocks.length - 1; i += 1) {
    const a = blocks[i];
    const b = blocks[i + 1];
    if (a.slot_pinned || b.slot_pinned) continue;
    if (isoToLondonDate(a.end) !== isoToLondonDate(b.start)) continue;
    const gap = isoToLondonMinutes(b.start) - isoToLondonMinutes(a.end);
    if (gap >= gapMin) continue;
    const did = Number(a.display_id);
    if (pinnedIds.has(did)) continue;
    proposals.push({
      change_type: 'rule_breach',
      summary: `Rule breach: MC-${did} → MC-${b.display_id} gap ${gap}m < ${gapMin}m decompress`,
      proposed_action: `Add ${gapMin - gap}m gap or move MC-${b.display_id} later`,
      reason: `decompress_after_task_min=${gapMin}`,
      related_id: `breach:gap:${did}:${isoToLondonDate(a.start)}`,
      target_date: isoToLondonDate(a.start),
      urgency: 'normal',
    });
  }
  return proposals;
}

module.exports = { buildRuleBreachProposals };
