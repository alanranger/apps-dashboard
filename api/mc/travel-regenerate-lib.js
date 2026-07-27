/**
 * Regenerate travel_blocks from live GCal workshop times (derived, not frozen).
 * DB + push-queue only — never writes Google Calendar.
 */
const {
  awaySpansFromTravelBlocks,
  isWorkshopCalendarEvent,
  isRestDaySourceEvent,
  londonYmdHmToUtcMs,
} = require('./habit-placer-lib');
const { addDays } = require('./scheduling-rules-lib');

function normTitle(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleScore(a, b) {
  const na = normTitle(a);
  const nb = normTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 100;
  if (na.includes(nb) || nb.includes(na)) return 80;
  const aw = new Set(na.split(' ').filter((w) => w.length > 3));
  const bw = nb.split(' ').filter((w) => w.length > 3);
  if (!aw.size || !bw.length) return 0;
  let hit = 0;
  for (const w of bw) if (aw.has(w)) hit += 1;
  let score = Math.round((hit / Math.max(aw.size, bw.length)) * 70);
  // Shared distinctive phrases (guest workshops often rename Masterclass ↔ Workshop)
  if (na.includes('david ward') && nb.includes('david ward')) score = Math.max(score, 70);
  if (na.includes('post processing') && nb.includes('post processing')) score = Math.max(score, 60);
  if (hit >= 3) score = Math.max(score, 55);
  return score;
}

function eventBounds(e) {
  const startRaw = e.start?.dateTime || (e.start?.date ? `${e.start.date}T00:00:00Z` : null);
  let endRaw = e.end?.dateTime || null;
  if (!endRaw && e.end?.date) {
    // all-day end exclusive
    endRaw = `${e.end.date}T00:00:00Z`;
  }
  if (!startRaw) return null;
  const startMs = Date.parse(startRaw);
  let endMs = Date.parse(endRaw || startRaw);
  if (e.start?.date && !e.start?.dateTime && e.end?.date) {
    endMs = Date.parse(e.end.date) - 60000; // last minute of last inclusive day
  }
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  return { startMs, endMs, startIso: new Date(startMs).toISOString(), endIso: new Date(endMs).toISOString() };
}

function isTravelWorkshopEvent(e) {
  if (isWorkshopCalendarEvent(e)) return true;
  return isRestDaySourceEvent(e);
}

function pairKey(b) {
  if (b.workshop_row_key) return b.workshop_row_key;
  return `${b.venue_name || ''}|${normTitle(b.workshop_title)}`;
}

/** Pair travel_out + travel_back for regeneration. */
function pairTravelBlocks(blocks) {
  const outs = (blocks || []).filter((b) => b.block_type === 'travel_out')
    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
  const backs = (blocks || []).filter((b) => b.block_type === 'travel_back')
    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
  const used = new Set();
  const pairs = [];
  for (const out of outs) {
    const key = pairKey(out);
    const outMs = Date.parse(out.starts_at);
    let bi = backs.findIndex((bk, i) => !used.has(i) && pairKey(bk) === key
      && Date.parse(bk.starts_at) >= outMs);
    if (bi < 0) {
      bi = backs.findIndex((bk, i) => !used.has(i) && Date.parse(bk.starts_at) >= outMs
        && titleScore(out.workshop_title, bk.workshop_title) >= 50);
    }
    if (bi < 0) continue;
    used.add(bi);
    pairs.push({ out, back: backs[bi], key });
  }
  return pairs;
}

function pickWorkshop(pair, workshops) {
  const title = pair.out.workshop_title || pair.back.workshop_title;
  const anchorDay = londonDay(pair.out.workshop_start || pair.out.starts_at);
  const outDay = londonDay(pair.out.starts_at);
  let best = null;
  let bestScore = -1;
  for (const w of workshops) {
    const b = eventBounds(w);
    if (!b) continue;
    const ts = titleScore(title, w.summary);
    if (ts < 45) continue;
    const evDay = londonDay(b.startIso);
    const dayDist = Math.abs(Date.parse(`${evDay}T12:00:00Z`) - Date.parse(`${anchorDay}T12:00:00Z`)) / 86400000;
    const outDist = Math.abs(Date.parse(`${evDay}T12:00:00Z`) - Date.parse(`${outDay}T12:00:00Z`)) / 86400000;
    // Prefer events near stamped workshop_start / travel_out day (max 4 days).
    if (Math.min(dayDist, outDist) > 4) continue;
    const score = ts - Math.min(dayDist, outDist) * 8;
    if (score > bestScore) {
      bestScore = score;
      best = { event: w, bounds: b, score };
    }
  }
  return best;
}

function driveMinutesFor(pair, venues) {
  const venue = String(pair.out.venue_name || '').toLowerCase();
  const hit = (venues || []).find((v) => venue && String(v.venue_name || '').toLowerCase().includes(venue.split('/')[0].trim()));
  if (hit?.minutes_from_home) return Number(hit.minutes_from_home);
  if (pair.out.drive_minutes_used) return Number(pair.out.drive_minutes_used);
  if (pair.back.drive_minutes_used) return Number(pair.back.drive_minutes_used);
  return 90;
}

function londonDay(iso) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(iso));
  } catch (e) {
    return String(iso).slice(0, 10);
  }
}

/**
 * Desired out/back around live workshop bounds.
 * Day-trip: arrive_before_start_min before start, leave at end.
 * Residential: arrive residential_arrive_hm (default 16:00) on the day before
 * first workshop day; leave for home at workshop end + drive.
 */
function desiredTravelTimes(bounds, driveMin, arriveMin, pair, ruleMap = {}) {
  const arrive = Math.max(0, Number(arriveMin) || 30);
  const drive = Math.max(15, Number(driveMin) || 90);
  const outDay = londonDay(pair.out.starts_at);
  const backDay = londonDay(pair.back.starts_at);
  const dayTrip = outDay === backDay;

  if (dayTrip) {
    const outEndMs = bounds.startMs - arrive * 60000;
    const outStartMs = outEndMs - drive * 60000;
    const backStartMs = bounds.endMs;
    const backEndMs = backStartMs + drive * 60000;
    return {
      out: { starts_at: new Date(outStartMs).toISOString(), ends_at: new Date(outEndMs).toISOString() },
      back: { starts_at: new Date(backStartMs).toISOString(), ends_at: new Date(backEndMs).toISOString() },
      workshop_start: bounds.startIso,
      mode: 'day_trip_formula',
    };
  }

  const firstDay = londonDay(bounds.startIso);
  const arriveHm = String(ruleMap.residential_arrive_hm || '16:00').slice(0, 5);
  const travelArriveDay = addDays(firstDay, -1);
  const outEndMs = londonYmdHmToUtcMs(travelArriveDay, arriveHm);
  const outStartMs = outEndMs - drive * 60000;
  const backStartMs = bounds.endMs;
  const backEndMs = backStartMs + drive * 60000;
  return {
    out: {
      starts_at: new Date(outStartMs).toISOString(),
      ends_at: new Date(outEndMs).toISOString(),
    },
    back: {
      starts_at: new Date(backStartMs).toISOString(),
      ends_at: new Date(backEndMs).toISOString(),
    },
    workshop_start: bounds.startIso,
    mode: 'residential_arrive',
    arrive_hm: arriveHm,
    travel_arrive_day: travelArriveDay,
  };
}

function isoClose(a, b, tolMin = 2) {
  return Math.abs(Date.parse(a) - Date.parse(b)) <= tolMin * 60000;
}

function planTravelRegenerate(blocks, gcalEvents, ruleMap = {}, venues = []) {
  const arriveMin = Number(ruleMap.arrive_before_start_min || 30);
  const workshops = (gcalEvents || []).filter(isTravelWorkshopEvent);
  const pairs = pairTravelBlocks(blocks);
  const changes = [];
  const linked = [];
  const unmatched = [];

  for (const pair of pairs) {
    const match = pickWorkshop(pair, workshops);
    if (!match) {
      unmatched.push({
        venue: pair.out.venue_name,
        title: pair.out.workshop_title,
        out_id: pair.out.id,
        back_id: pair.back.id,
      });
      continue;
    }
    const rowKey = `gcal:${match.event.id}`;
    const drive = driveMinutesFor(pair, venues);
    const desired = desiredTravelTimes(match.bounds, drive, arriveMin, pair, ruleMap);
    const timesOut = !isoClose(pair.out.starts_at, desired.out.starts_at)
      || !isoClose(pair.out.ends_at, desired.out.ends_at);
    const timesBack = !isoClose(pair.back.starts_at, desired.back.starts_at)
      || !isoClose(pair.back.ends_at, desired.back.ends_at);
    const metaOut = pair.out.workshop_row_key !== rowKey
      || !isoClose(pair.out.workshop_start || '', desired.workshop_start, 5);
    const metaBack = pair.back.workshop_row_key !== rowKey
      || !isoClose(pair.back.workshop_start || '', desired.workshop_start, 5);
    const outChanged = timesOut || metaOut;
    const backChanged = timesBack || metaBack;

    const row = {
      venue: pair.out.venue_name,
      title: pair.out.workshop_title || match.event.summary,
      workshop_event_id: match.event.id,
      workshop_row_key: rowKey,
      workshop_live_start: desired.workshop_start,
      workshop_live_end: match.bounds.endIso,
      drive_minutes: drive,
      arrive_before_min: arriveMin,
      out: {
        id: pair.out.id,
        calendar_event_id: pair.out.calendar_event_id,
        from: { starts_at: pair.out.starts_at, ends_at: pair.out.ends_at },
        to: desired.out,
        changed: outChanged,
        times_changed: timesOut,
      },
      back: {
        id: pair.back.id,
        calendar_event_id: pair.back.calendar_event_id,
        from: { starts_at: pair.back.starts_at, ends_at: pair.back.ends_at },
        to: desired.back,
        changed: backChanged,
        times_changed: timesBack,
      },
    };
    linked.push(row);
    if (outChanged || backChanged) changes.push(row);
  }

  const beforeSpans = awaySpansFromTravelBlocks(blocks);
  const projected = (blocks || []).map((b) => {
    const ch = changes.find((c) => c.out.id === b.id || c.back.id === b.id);
    if (!ch) return b;
    if (ch.out.id === b.id) {
      return {
        ...b,
        starts_at: ch.out.to.starts_at,
        ends_at: ch.out.to.ends_at,
        workshop_start: ch.workshop_live_start,
        workshop_row_key: ch.workshop_row_key,
      };
    }
    return {
      ...b,
      starts_at: ch.back.to.starts_at,
      ends_at: ch.back.to.ends_at,
      workshop_start: ch.workshop_live_start,
      workshop_row_key: ch.workshop_row_key,
    };
  });
  const afterSpans = awaySpansFromTravelBlocks(projected);

  return {
    workshop_events: workshops.length,
    pairs: pairs.length,
    linked,
    linked_count: linked.length,
    unmatched,
    changes,
    changed_count: changes.length,
    times_changed_count: changes.filter((c) => c.out.times_changed || c.back.times_changed).length,
    away_spans_before: beforeSpans.map((s) => ({ start: s.startDay, end: s.endDay, summary: s.summary })),
    away_spans_after: afterSpans.map((s) => ({ start: s.startDay, end: s.endDay, summary: s.summary })),
  };
}

module.exports = {
  planTravelRegenerate,
  pairTravelBlocks,
  isTravelWorkshopEvent,
  desiredTravelTimes,
  normTitle,
};
