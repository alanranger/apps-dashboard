/**
 * Fix Gower May 2027 trip travel + dedupe Bank Genie Aug 2026.
 * Run: node scripts/fix-gower-travel-and-bank-genie-2026-08-11.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

// Load env without dotenv package
const envPath = path.join(root, '.env.local');
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue;
  const i = line.indexOf('=');
  let v = line.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  if (!process.env[line.slice(0, i).trim()]) {
    process.env[line.slice(0, i).trim()] = v;
  }
}

const {
  insertPrimaryEvent,
  deletePrimaryEvent,
  insertPrimaryAllDayEvent,
  verifyPrimaryEvent,
} = require('../api/mc/gcal-write-lib.js');
const {
  travelGcalTitle,
  travelGcalDescription,
  travelGcalLocation,
  awaySpanGcalTitle,
} = require('../api/mc/gcal-title-lib.js');

const MC_URL = process.env.MC_SUPABASE_URL;
const MC_KEY = process.env.MC_SUPABASE_SERVICE_KEY;

async function sb(p, opts = {}) {
  const r = await fetch(`${MC_URL}/rest/v1/${p}`, {
    method: opts.method || 'GET',
    headers: {
      apikey: MC_KEY,
      Authorization: `Bearer ${MC_KEY}`,
      'Content-Type': 'application/json',
      Prefer: opts.prefer || 'return=representation',
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${opts.method || 'GET'} ${p} → ${t.slice(0, 500)}`);
  return t ? JSON.parse(t) : null;
}

const WORKSHOP = {
  title: 'Gower Peninsula Photo Workshop - Landscape Photography Wales',
  rowKey:
    'gcal:_6or34or571i36chg75j6aohn6pj30e326lgjipi0etrnebj1dhgmssj1dpjmashecdnmq',
  startIso: '2027-05-28T09:00:00.000Z', // 10:00 London
  venue: 'Gower',
  postcode: 'SA3 2EH',
  driveMin: 195,
};

// Fri 06:15–09:30 Europe/London (BST = +01) = 05:15–08:30Z
const OUT = {
  startIso: '2027-05-28T05:15:00.000Z',
  endIso: '2027-05-28T08:30:00.000Z',
};
// Mon checkout 09:00–12:15 BST = 08:00–11:15Z
const BACK = {
  startIso: '2027-05-31T08:00:00.000Z',
  endIso: '2027-05-31T11:15:00.000Z',
};

const report = { deleted: [], created: [], errors: [] };

async function deleteGenieDupes() {
  // Keep diary-pin event b53p9dmd4uorvnt4h15mhddi5c (Wed/Thu 13th 12:45).
  // Remove same-day orphan + stale rolled Saturday.
  const kill = [
    {
      id: 'eumpof3t09l28opu5jja58cc98',
      why: 'duplicate Bank Genie same day 15:30 (unpinned orphan from re-place)',
    },
    {
      id: 'c5r8f916qs8im5cg2a4vacejbg',
      why: 'stale Bank Genie 8 Aug after incomplete roll → 13 Aug',
    },
  ];
  for (const k of kill) {
    try {
      await deletePrimaryEvent(k.id);
      report.deleted.push({ id: k.id, why: k.why });
    } catch (e) {
      report.errors.push({ step: 'delete_genie', id: k.id, error: e.message });
    }
  }
}

async function ensureGowerTravel() {
  // Drop any wrong-dated Gower travel_blocks first
  const existing = await sb(
    'travel_blocks?select=*&or=(workshop_title.ilike.*Gower*,workshop_row_key.eq.'
      + encodeURIComponent(WORKSHOP.rowKey)
      + ')&block_type=in.(travel_out,travel_back,travel_leg)',
  );
  for (const row of existing || []) {
    if (row.calendar_event_id) {
      try {
        await deletePrimaryEvent(row.calendar_event_id);
      } catch (_) {
        /* ok */
      }
    }
    await sb(`travel_blocks?id=eq.${row.id}`, { method: 'DELETE', prefer: 'return=minimal' });
    report.deleted.push({
      id: row.id,
      why: `old travel_block ${row.block_type} ${row.starts_at}`,
    });
  }

  // Also purge any primary GCal residual titles for this workshop travel
  // (handled by manual IDs only when known — skip broad purge)

  const outMeta = {
    block_type: 'travel_out',
    workshop_title: WORKSHOP.title,
    venue_name: WORKSHOP.venue,
    leg_from: 'home',
    leg_to: WORKSHOP.venue,
    drive_minutes_used: WORKSHOP.driveMin,
  };
  const backMeta = {
    block_type: 'travel_back',
    workshop_title: WORKSHOP.title,
    venue_name: WORKSHOP.venue,
    leg_from: WORKSHOP.venue,
    leg_to: 'home',
    drive_minutes_used: WORKSHOP.driveMin,
  };

  const outEv = await insertPrimaryEvent({
    summary: travelGcalTitle(outMeta),
    startIso: OUT.startIso,
    endIso: OUT.endIso,
    description: travelGcalDescription(outMeta),
    location: travelGcalLocation(outMeta),
  });
  const backEv = await insertPrimaryEvent({
    summary: travelGcalTitle(backMeta),
    startIso: BACK.startIso,
    endIso: BACK.endIso,
    description: travelGcalDescription(backMeta),
    location: travelGcalLocation(backMeta),
  });

  const baseRow = {
    venue_name: WORKSHOP.venue,
    workshop_title: WORKSHOP.title,
    workshop_start: WORKSHOP.startIso,
    workshop_row_key: WORKSHOP.rowKey,
    drive_minutes_used: WORKSHOP.driveMin,
    drive_time_verified_at: new Date().toISOString(),
    created_by: 'cursor',
    manual_lock: false,
  };

  const outRow = await sb('travel_blocks', {
    method: 'POST',
    body: {
      ...baseRow,
      block_type: 'travel_out',
      starts_at: OUT.startIso,
      ends_at: OUT.endIso,
      calendar_event_id: outEv.id,
      leg_from: 'home',
      leg_to: WORKSHOP.venue,
    },
  });
  const backRow = await sb('travel_blocks', {
    method: 'POST',
    body: {
      ...baseRow,
      block_type: 'travel_back',
      starts_at: BACK.startIso,
      ends_at: BACK.endIso,
      calendar_event_id: backEv.id,
      leg_from: WORKSHOP.venue,
      leg_to: 'home',
    },
  });

  report.created.push({
    kind: 'travel_out',
    gcal: outEv.id,
    db: Array.isArray(outRow) ? outRow[0]?.id : outRow?.id,
    when: 'Fri 28 May 06:15–09:30 London',
  });
  report.created.push({
    kind: 'travel_back',
    gcal: backEv.id,
    db: Array.isArray(backRow) ? backRow[0]?.id : backRow?.id,
    when: 'Mon 31 May 09:00–12:15 London',
  });

  // AWAY span Fri–Mon (travel-out day through travel-back day)
  try {
    const title = awaySpanGcalTitle({
      venue_name: WORKSHOP.venue,
      workshop_title: WORKSHOP.title,
    });
    // end exclusive = day after travel-back day
    const awayStart = '2027-05-28';
    const awayEndEx = '2027-06-01';
    const existingAway = await sb(
      'away_day_blocks?status=eq.active&start_date=eq.2027-05-28&select=*',
    );
    let awayEvId = existingAway?.[0]?.calendar_event_id || null;
    if (!awayEvId) {
      const aw = await insertPrimaryAllDayEvent({
        summary: title,
        startDate: awayStart,
        endDateExclusive: awayEndEx,
        description: 'AWAY for Gower residential — auto seed 11 Aug 2026',
      });
      awayEvId = aw.id;
    }
    const awayBody = {
      start_date: awayStart,
      end_date: '2027-05-31',
      venue_name: WORKSHOP.venue,
      workshop_title: WORKSHOP.title,
      workshop_row_key: WORKSHOP.rowKey,
      calendar_event_id: awayEvId,
      status: 'active',
      updated_at: new Date().toISOString(),
    };
    if (existingAway?.[0]?.id) {
      await sb(`away_day_blocks?id=eq.${existingAway[0].id}`, {
        method: 'PATCH',
        prefer: 'return=minimal',
        body: awayBody,
      });
    } else {
      // column names may differ — try common
      try {
        await sb('away_day_blocks', {
          method: 'POST',
          prefer: 'return=minimal',
          body: {
            ...awayBody,
            created_at: new Date().toISOString(),
          },
        });
      } catch (e) {
        report.errors.push({ step: 'away_insert', error: e.message });
      }
    }
    report.created.push({ kind: 'away', gcal: awayEvId, when: '2027-05-28..31' });
  } catch (e) {
    report.errors.push({ step: 'away', error: e.message });
  }

  // Keep REST Mon 31 — rule-correct after last workshop day Sun 30.
  // (Already present: 3q7jeemj0f20og8gagjr7dnj6s)
}

async function main() {
  await deleteGenieDupes();
  await ensureGowerTravel();
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
