/**
 * POST /api/mc/travel-regenerate — recompute travel_blocks from live GCal workshops.
 * dry_run (default) or apply=true. DB + gcal_push_queue only; never writes Calendar.
 */
const {
  envReady, json, cors, readBody, requireAuth, actorFromSession, sb,
} = require('./_lib');
const { gcalConfigured, fetchHorizonEvents } = require('./gcal-lib');
const { planTravelRegenerate } = require('./travel-regenerate-lib');
const { upsertPushRow } = require('./gcal-push-lib');
const { ruleMapFromRows } = require('./scheduling-rules-lib');

async function patchBlock(id, patch) {
  await sb(`travel_blocks?id=eq.${id}`, {
    method: 'PATCH',
    prefer: 'return=minimal',
    body: patch,
  });
}

async function queueTravelMove(actor, blockMeta, to, venue, title, prefixes) {
  if (!blockMeta.calendar_event_id) return null;
  const { travelGcalTitle } = require('./gcal-title-lib');
  const related = `gcal:travel:${blockMeta.id}`;
  const gcalTitle = travelGcalTitle({
    block_type: blockMeta.block_type,
    venue_name: venue,
    workshop_title: title,
  }, prefixes || {});
  await upsertPushRow(sb, {
    related_id: related,
    entity_type: 'travel',
    change_kind: 'move',
    summary: `Move ${blockMeta.block_type || 'travel'} ${venue || ''} → follow workshop`.trim(),
    proposed_action: [
      `MOVE Primary event ${blockMeta.calendar_event_id}`,
      `to ${to.starts_at} – ${to.ends_at} (convert to Europe/London wall-clock; no Z).`,
      `Workshop: ${title || ''}.`,
    ].join(' '),
    payload: {
      calendar_event_id: blockMeta.calendar_event_id,
      block_type: blockMeta.block_type,
      new_start: to.starts_at,
      new_end: to.ends_at,
      venue,
      workshop_title: title,
      title: gcalTitle,
      actor,
    },
  });
  return related;
}

module.exports = async function handler(req, res) {
  if (cors(req, res)) return;
  if (!envReady()) return json(res, 503, { error: 'MC_SUPABASE_NOT_CONFIGURED' });
  const session = requireAuth(req, res);
  if (!session) return;

  if (req.method === 'GET') {
    return json(res, 200, {
      ok: true,
      usage: {
        POST: {
          dry_run: 'default true — report only',
          apply: 'true to PATCH travel_blocks + queue GCal moves',
          weeks: 'optional horizon weeks (default 52)',
        },
      },
    });
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });

  try {
    if (!gcalConfigured()) {
      return json(res, 503, { error: 'GCAL_NOT_CONFIGURED' });
    }
    const body = await readBody(req);
    const actor = actorFromSession(session, body);
    const apply = body.apply === true || body.dry_run === false;
    const weeks = Math.min(104, Math.max(4, Number(body.weeks) || 52));
    const now = Date.now();
    const timeMin = new Date(now - 7 * 86400000).toISOString();
    const timeMax = new Date(now + weeks * 7 * 86400000).toISOString();

    const [blocks, rules, venues, gcal] = await Promise.all([
      sb('travel_blocks?select=*&order=starts_at.asc'),
      sb('scheduling_rules?select=key,value'),
      sb('venue_drive_times?select=venue_name,postcode,minutes_from_home,verified_at'),
      fetchHorizonEvents(timeMin, timeMax),
    ]);
    const ruleMap = ruleMapFromRows(rules);
    const plan = planTravelRegenerate(blocks || [], gcal.events || [], ruleMap, venues || []);

    const applied = [];
    if (apply) {
      for (const row of plan.linked || []) {
        const outPatch = {
          workshop_start: row.workshop_live_start,
          workshop_row_key: row.workshop_row_key,
          workshop_title: row.title,
          drive_minutes_used: row.drive_minutes,
        };
        const backPatch = { ...outPatch };
        if (row.out.changed) {
          outPatch.starts_at = row.out.to.starts_at;
          outPatch.ends_at = row.out.to.ends_at;
        }
        if (row.back.changed) {
          backPatch.starts_at = row.back.to.starts_at;
          backPatch.ends_at = row.back.to.ends_at;
        }
        await patchBlock(row.out.id, outPatch);
        await patchBlock(row.back.id, backPatch);
        if (row.out.times_changed) {
          await queueTravelMove(actor, {
            id: row.out.id,
            calendar_event_id: row.out.calendar_event_id,
            block_type: 'travel_out',
          }, row.out.to, row.venue, row.title);
        }
        if (row.back.times_changed) {
          await queueTravelMove(actor, {
            id: row.back.id,
            calendar_event_id: row.back.calendar_event_id,
            block_type: 'travel_back',
          }, row.back.to, row.venue, row.title);
        }
        if (row.out.times_changed || row.back.times_changed || row.out.changed || row.back.changed) {
          applied.push({
            title: row.title,
            venue: row.venue,
            workshop_row_key: row.workshop_row_key,
            out_changed: row.out.times_changed,
            back_changed: row.back.times_changed,
            linked_only: !row.out.times_changed && !row.back.times_changed,
            out_to: row.out.to,
            back_to: row.back.to,
          });
        }
      }
      // Re-derive away + rest masters when trips move (fixtures unchanged here).
      try {
        const { runRuleEventMasterSync } = require('./rule-event-masters-lib');
        await runRuleEventMasterSync(sb, { writeGcal: true, weeks });
      } catch (e) {
        applied.push({ rule_master_sync_error: e.message });
      }
    }

    return json(res, 200, {
      ok: true,
      dry_run: !apply,
      applied_count: applied.length,
      applied,
      linked_count: (plan.linked || []).length,
      calendar_writes: 0,
      gcal_health: gcal.assessment || null,
      ...plan,
    });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message || 'travel-regenerate failed', detail: e.data });
  }
};
