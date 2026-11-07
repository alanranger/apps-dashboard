/** Emit per-block KEEP/MOVE/DELETE classification for Aug–Oct MC dump. */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const result = JSON.parse(fs.readFileSync(path.join(__dirname, 'adjudicate-result.json'), 'utf8'));
const DUMP_DIR = String.raw`C:\Users\alan\.cursor\projects\g-Dropbox-alan-ranger-photography-Website-Code-Chat-AI-Bot\agent-tools`;
const FILES = [
  '1d04bd30-a33b-42ff-ad82-d177eab7fbf7.txt',
  'c0eec649-277d-4fa2-b5e5-020fc8cbbed1.txt',
  '312b81fe-21e9-481f-abe1-f74c66f87749.txt',
];
const TIE = new Set(JSON.parse(fs.readFileSync(path.join(__dirname, 'tieback-ids.json'), 'utf8')));

const byId = new Map();
for (const f of FILES) {
  const data = JSON.parse(fs.readFileSync(path.join(DUMP_DIR, f), 'utf8'));
  for (const e of data.events || []) {
    if (e.status === 'cancelled') continue;
    byId.set(e.id, e);
  }
}

const breachIds = new Set();
const reasons = new Map(); // id -> [reasons]
function add(id, reason) {
  if (!id) return;
  breachIds.add(id);
  const arr = reasons.get(id) || [];
  arr.push(reason);
  reasons.set(id, arr);
}

for (const o of result.overlaps) {
  add(o.a.id, `overlap ${o.overlapMin}m with ${o.b.title}`);
  add(o.b.id, `overlap ${o.overlapMin}m with ${o.a.title}`);
}
for (const z of result.zeroGaps) {
  add(z.a.id, `zero gap before ${z.b.title}`);
  add(z.b.id, `zero gap after ${z.a.title}`);
}
for (const c of result.capBreaches) {
  // tag all non-travel MC on that day
  for (const e of byId.values()) {
    if (!e.start?.dateTime) continue;
    const d = e.start.dateTime.slice(0, 10);
    if (d !== c.day) continue;
    if (e.colorId !== '10' && !TIE.has(e.id)) continue;
    if ((e.summary || '').includes('MC 🚗') || (e.summary || '').includes('MC ⏳')) continue;
    add(e.id, `day cap ${c.minutes}m > 240`);
  }
}
for (const w of result.windowBreaches) add(w.id, `starts before window (${w.window})`);
add('bhcc8qenibs36v2lvlio1ua7fo', 'placed during David Ward residential (all-day Stay + Post Processing)');
add('0np73n7k18621lhm2qo093j3nk', 'duplicate Review/Amend on 15 Sep (Lake District roll-back duplicate)');
// 18 Sep reminder inside travel
add('12v0odkh7a3obfo1gpkohmamas', 'lands at end of Lake District travel-out / residential departure day');
add('aqrbdgkvvn3oe6n2snddvnv898', 'lands while Alan at Lake District residential');

const mc = [...byId.values()].filter((e) => e.colorId === '10' || TIE.has(e.id))
  .filter((e) => e.start?.dateTime)
  .sort((a, b) => Date.parse(a.start.dateTime) - Date.parse(b.start.dateTime));

const rows = [];
let move = 0; let del = 0; let keep = 0; let unmatched = 0;
for (const e of mc) {
  const tied = TIE.has(e.id);
  const isUnmatched = e.colorId === '10' && !tied;
  const br = reasons.get(e.id) || [];
  let action = 'KEEP';
  let note = '';
  if (isUnmatched) {
    action = 'UNMATCHED';
    unmatched += 1;
    note = 'colorId=10 with no tasks/recurring_log/travel_blocks tie-back — flag only, do not classify further';
  } else if (e.id === '0np73n7k18621lhm2qo093j3nk') {
    action = 'DELETE';
    del += 1;
    note = 'Duplicate Review/Amend (ideal 18 Sep rolled onto 15 Sep which already has the 11 Sep roll-forward). Keep lp9ar8hesvf99q7un81poa0q88.';
  } else if (e.id === 'bhcc8qenibs36v2lvlio1ua7fo') {
    action = 'DELETE';
    del += 1;
    note = 'MC-52 done; was wrongly placed during David Ward workshop. Calendar residue — remove.';
  } else if (br.length) {
    action = 'MOVE';
    move += 1;
    note = br.join('; ');
  } else if ((e.summary || '').includes('MC 🚗')) {
    keep += 1;
    note = 'KEEP — travel block tied to workshop CSV / travel_blocks; depart-at-end + arrive-30 rules.';
  } else if ((e.summary || '').includes('MC ⏳')) {
    keep += 1;
    note = 'KEEP — home prep/decompress buffer (buffer_scope=home_only).';
  } else if ((e.summary || '').includes('⏰')) {
    // matched reminders that pass window (none currently)
    keep += 1;
    note = 'KEEP — hotel deadline reminder (pending window exemption ruling).';
  } else {
    keep += 1;
    note = 'KEEP — no independent overlap/gap/cap/window breach found in Aug–Oct sweep; still subject to full re-lay if Alan chooses wipe.';
  }
  rows.push({
    action,
    id: e.id,
    title: e.summary,
    start: e.start.dateTime,
    end: e.end.dateTime,
    tied,
    note,
  });
}

const summary = { total: rows.length, KEEP: keep, MOVE: move, DELETE: del, UNMATCHED: unmatched, moveOrDeletePct: Math.round(100 * (move + del) / rows.length) };
fs.writeFileSync(path.join(__dirname, 'diff-rows.json'), JSON.stringify({ summary, rows }, null, 2));
console.log(JSON.stringify(summary, null, 2));
