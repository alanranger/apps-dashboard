import fs from 'fs';

const p = JSON.parse(
  fs.readFileSync(
    'G:/Dropbox/alan ranger photography/Website Code/apps-dashboard/tmp/mc49-plan.json',
    'utf8'
  )
);
const outbox =
  'C:/Users/alan/Google Drive/Claude shared resources/Cursor Outputs for Claude';
const lines = [];
const now = new Date().toISOString();

lines.push('---');
lines.push('answers_question: 2026-07-23-MC-49-full-calendar-relay-from-24-jul');
lines.push('question_file: QUESTION-2026-07-23-MC-49-full-calendar-relay-from-24-jul.md');
lines.push('answered_by: cursor');
lines.push(`answered_at: ${now}`);
lines.push('status: complete');
lines.push(
  'supersedes: generate-full-placement-plan-all-calendars, placement-plan-REJECTED-multiday-blocks-full-span, roll-backward-if-time-critical'
);
lines.push('---');
lines.push('');
lines.push('# RESPONSE — MC-49 full calendar re-lay from 24 Jul (clean slate)');
lines.push('');
lines.push('**Answered:** 2026-07-23');
lines.push('**By:** Cursor');
lines.push(
  '**Nothing written to any calendar.** Plan only. Claude verifies against an independent busy map before writing, then logs to `recurring_log` / `tasks.scheduled_start`.'
);
lines.push('');
lines.push(
  `Supersedes all prior placement plans. Horizons: habits **${p.meta.start} → ${p.meta.habitEnd}** (13wk) · travel/buffers/reminders **→ ${p.meta.travelEnd}** (26wk) · tasks compete for the same **240** min/day cap.`
);
lines.push('');
lines.push('## Counts');
lines.push('');
lines.push('| Section | Placed | Unplaceable |');
lines.push('|---|---:|---:|');
lines.push(`| Habits | ${p.habitRows.length} | ${p.unplaceable.length} |`);
lines.push(`| Task blocks | ${p.taskRows.length} | ${p.taskUn.length} |`);
lines.push(`| Travel / buffers / hotel reminders | ${p.travelRows.length} | 0 |`);
lines.push(`| Displacements / rolls logged | ${p.rolls.length} | — |`);
lines.push('');
lines.push('## 2. How the busy map was built');
lines.push('');
lines.push(
  'Source: live Google Calendar MCP (`account=alan`), two windows merged (24 Jul–24 Oct + 24 Oct–23 Jan).'
);
lines.push('');
lines.push('| Calendar | Events in feed |');
lines.push('|---|---:|');
const nice = {
  'info@alanranger.com': 'Primary info@alanranger.com',
  'ic364d06u5bjt60d91q0nrqps6ulk7b2@import.calendar.google.com':
    'Landscape Photographic Workshops',
  'nht93uaqhhd191kc3fg1kjs57k6bunhn@import.calendar.google.com':
    'Photography Lessons Coventry/Online',
  'c_0e7gnac3odl7ki0jfjiaedot9g@group.calendar.google.com': 'Ipswich Town',
  'alanranger.com_75moakqf5i3ap9jirm85uev8h8@group.calendar.google.com': 'UK Holidays',
  'c_e6e8a50d4f6a9e8c7a5e284ead78fb8621c1d63ea92a97dca94b268baf76921a@group.calendar.google.com':
    'Photography Workshop Journey',
  'thv8nth15qbu530phsap5td5cjfl9536@import.calendar.google.com': 'FIFA World Cup',
};
for (const [id, n] of Object.entries(p.meta.eventCounts)) {
  lines.push(`| ${nice[id] || id} | ${n} |`);
}
lines.push('| UK Holidays / Journey / FIFA (queried) | **0** in window |');
lines.push('| England fixtures | **not on account** — none to block |');
lines.push('');
lines.push('Rules applied:');
lines.push('');
lines.push('- `busy_map_scope=all_calendars` — all listed calendars read.');
lines.push(
  '- `multiday_blocks_full_span=true` — timed workshop/primary events with start-date ≠ end-date mark **every day** of the span full-day busy (Hartland, Yorkshire, Lakes, Snowdonia, Dorset, Vyrnwy, Gower, Norfolk, winter Lakes, Post Processing Masterclass, etc.).'
);
lines.push(
  '- Same-day **away** workshops → full-day busy; **home** (Hathaway / Kenilworth / Chesterton / Priory / local walks) → timed busy only.'
);
lines.push(
  '- All-day primary **Block Out / Stay at\\* / Post Processing / Ruby Moving** → full-day; birthdays/social all-days do **not** full-block.'
);
lines.push(
  '- `fixture_buffer_min=60` — Ipswich timed busy **kick-off−60 → full-time+60**, **ignoring** `transparency: transparent`.'
);
lines.push(
  '- `recurring_personal_blocks` cleaner — fortnightly Fri **09:00–13:00** (already on primary; synthetic fill if missing). Working window those days effectively **13:00–17:00**.'
);
lines.push(
  '- `exclude_bank_holidays=true` — UK BH in window: 31 Aug, 25/28 Dec 2026, 1 Jan 2027 (holiday calendar returned 0 events).'
);
lines.push(
  '- Open MC **tasks** placed **before** habits so they occupy the cap (fixes the 1 Sep over-cap class of bug).'
);
lines.push('');
lines.push('Full-day busy days (52):');
lines.push('`' + p.meta.fullDays.join(' · ') + '`');
lines.push('');
lines.push('## 1a. Habits (13 weeks)');
lines.push('');
lines.push(
  'Format: `date | start | end | title | calendar | priority | DB source | rule`'
);
lines.push('');
lines.push('```');
for (const r of p.habitRows) {
  lines.push(
    `${r.date} | ${r.start} | ${r.end} | ${r.title} | ${r.calendar} | ${r.priority} | ${r.source} | ${r.rule}`
  );
}
lines.push('```');
lines.push('');
lines.push('## 1b. Task blocks (open tasks with due_date + est_minutes)');
lines.push('');
lines.push(
  `All ${p.taskRows.length} placed. Description field for Claude: **\`tasks.detail_md\`**.`
);
lines.push('');
lines.push('```');
for (const r of p.taskRows) {
  lines.push(
    `${r.date} | ${r.start} | ${r.end} | ${r.title} | ${r.calendar} | ${r.priority} | ${r.source} | ${r.rule}`
  );
}
lines.push('```');
lines.push('');
lines.push('## 1c. Travel, buffers, hotel deadline reminders (26 weeks)');
lines.push('');
lines.push(
  'Drive minutes from `venue_drive_times` (verified_by=google_directions): Piles **30**, Padley **120**, Batsford **60**, Burnham 135, Hartland 240, Gower 195, Capel/Snowdonia 180, Bassenthwaite/Lakes 225, Saltburn/Yorkshire 210, Wareham/Dorset 195, Vyrnwy 135, Roaches/Hathersage 120, local home 15. Prep/decompress 30 on home courses + evening classes (both Camera Course cohorts). Online Zoom tuition skipped. Hotel reminders = Stay-at start − 3 days (`hotel_deadline_reminder_days=3`).'
);
lines.push('');
lines.push('```');
for (const r of p.travelRows) {
  lines.push(
    `${r.date} | ${r.start} | ${r.end} | ${r.title} | ${r.calendar} | ${r.priority} | ${r.source} | ${r.rule}`
  );
}
lines.push('```');
lines.push('');
lines.push('## 3. Displacements and rolls');
lines.push('');
lines.push('| Title | Dir | From | Reason |');
lines.push('|---|---|---|---|');
for (const r of p.rolls) {
  const title = (r.title || '').replace(/\|/g, '/');
  const reason = (r.reason || '').replace(/\|/g, '/');
  lines.push(`| ${title} | ${r.dir || ''} | ${r.from || ''} | ${reason} |`);
}
lines.push('');
lines.push('## 4. Cannot place');
lines.push('');
if (!p.unplaceable.length && !p.taskUn.length) {
  lines.push(
    '**None.** Every habit occurrence in the 13-week horizon and every open task block found a slot under `backward_if_time_critical` / forward search + caps.'
  );
} else {
  for (const u of p.unplaceable) {
    lines.push(`- HABIT ${u.title} ideal ${u.ideal}: ${u.reason}`);
  }
  for (const u of p.taskUn) {
    lines.push(`- TASK MC-${u.id} ${u.title}: ${u.reason}`);
  }
}
lines.push('');
lines.push('## 5. Confirmation');
lines.push('');
lines.push('- **No calendar writes** from Cursor.');
lines.push(
  '- Descriptions: habits → `recurring_tasks.scheduled_note`; tasks → `tasks.detail_md`; travel/buffers → calendar event + `venue_drive_times` / buffer rules.'
);
lines.push(
  '- Two-cohort Camera Courses (e.g. Wk1 Thu 17 Sep **and** Tue 22 Sep) each get their own prep/decompress rows.'
);
lines.push(
  '- Cleaner fortnightly Fridays already present on primary; treated as blocking 09:00–13:00.'
);
lines.push(
  '- Notable: first BAU cycle shifts to **9–12 Aug** (Jul 27–29 packed with overdue task blocks + Ruby Moving / White Horse residential). Second cycle stays **21–23 Sep** (Day1 / Day2 / Upload).'
);
lines.push('');

const path = `${outbox}/RESPONSE-2026-07-23-MC-49-full-calendar-relay-from-24-jul-LATEST.md`;
fs.writeFileSync(path, lines.join('\n'), 'utf8');
console.log('wrote', path, 'bytes', fs.statSync(path).size);
