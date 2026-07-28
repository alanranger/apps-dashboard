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

/** True if event occupies this London calendar day (multi-day timed inclusive). */
function eventOnLondonDay(bounds, day) {
  if (!bounds || !day) return false;
  const startDay = londonDay(bounds.startIso);
  const endDay = londonDay(bounds.endIso);
  return day >= startDay && day <= endDay;
}

/** Latest end (ms) of another teaching event on a London calendar day; null if free. */
function otherTeachingEndOnDay(day, teachingEvents, excludeEventId) {
  let maxEnd = null;
  for (const w of teachingEvents || []) {
    if (!w || w.id === excludeEventId) continue;
    if (!isWorkshopCalendarEvent(w)) continue;
    const b = eventBounds(w);
    if (!b || !eventOnLondonDay(b, day)) continue;
    if (maxEnd == null || b.endMs > maxEnd) maxEnd = b.endMs;
  }
  return maxEnd;
}

/**
 * Guest/attending residential (e.g. David Ward on Primary): day-before arrive.
 * Own Workshops-calendar residential: travel out on first day, arrive at start;
 * travel back leaves at end on last day.
 */
function desiredTravelTimes(bounds, driveMin, arriveMin, pair, ruleMap = {}, opts = {}) {
  const arrive = Math.max(0, Number(arriveMin) || 30);
  const drive = Math.max(15, Number(driveMin) || 90);
  const outDay = londonDay(pair.out.starts_at);
  const backDay = londonDay(pair.back.starts_at);
  const dayTrip = outDay === backDay;
  const teaching = opts.teachingEvents || [];
  const excludeId = opts.excludeEventId || null;
  const guest = !!opts.guestOrAttending;

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
  const backStartMs = bounds.endMs;
  const backEndMs = backStartMs + drive * 60000;
  const back = {
    starts_at: new Date(backStartMs).toISOString(),
    ends_at: new Date(backEndMs).toISOString(),
  };

  // Alan's own residential workshop: first-day travel out, arrive at workshop start.
  if (!guest) {
    let outEndMs = bounds.startMs;
    let outStartMs = outEndMs - drive * 60000;
    let deferred = false;
    const localEnd = otherTeachingEndOnDay(firstDay, teaching, excludeId);
    if (localEnd != null && localEnd > outStartMs
      && localEnd + Math.max(30, arrive) * 60000 + drive * 60000 <= bounds.startMs) {
      outStartMs = localEnd + Math.max(30, arrive) * 60000;
      outEndMs = outStartMs + drive * 60000;
      deferred = true;
    }
    return {
      out: {
        starts_at: new Date(outStartMs).toISOString(),
        ends_at: new Date(outEndMs).toISOString(),
      },
      back,
      workshop_start: bounds.startIso,
      mode: 'residential_first_day_arrive',
      travel_arrive_day: firstDay,
      deferred_for_local_teaching: deferred,
    };
  }

  // Guest/attending (David Ward etc.): day-before afternoon arrive.
  const idealDay = addDays(firstDay, -1);
  const localEndIdeal = otherTeachingEndOnDay(idealDay, teaching, excludeId);
  if (localEndIdeal == null) {
    const outEndMs = londonYmdHmToUtcMs(idealDay, arriveHm);
    const outStartMs = outEndMs - drive * 60000;
    return {
      out: {
        starts_at: new Date(outStartMs).toISOString(),
        ends_at: new Date(outEndMs).toISOString(),
      },
      back,
      workshop_start: bounds.startIso,
      mode: 'residential_guest_day_before',
      arrive_hm: arriveHm,
      travel_arrive_day: idealDay,
    };
  }

  const leaveMs = localEndIdeal + Math.max(30, arrive) * 60000;
  const arriveMs = leaveMs + drive * 60000;
  if (arriveMs <= bounds.startMs - arrive * 60000) {
    return {
      out: {
        starts_at: new Date(leaveMs).toISOString(),
        ends_at: new Date(arriveMs).toISOString(),
      },
      back,
      workshop_start: bounds.startIso,
      mode: 'residential_guest_after_local_teaching',
      arrive_hm: arriveHm,
      travel_arrive_day: idealDay,
      deferred_for_local_teaching: true,
    };
  }

  for (let step = 2; step <= 4; step += 1) {
    const day = addDays(firstDay, -step);
    if (otherTeachingEndOnDay(day, teaching, excludeId) != null) continue;
    const outEndMs = londonYmdHmToUtcMs(day, arriveHm);
    const outStartMs = outEndMs - drive * 60000;
    return {
      out: {
        starts_at: new Date(outStartMs).toISOString(),
        ends_at: new Date(outEndMs).toISOString(),
      },
      back,
      workshop_start: bounds.startIso,
      mode: 'residential_guest_walkback',
      arrive_hm: arriveHm,
      travel_arrive_day: day,
      deferred_for_local_teaching: true,
    };
  }

  return {
    out: {
      starts_at: new Date(leaveMs).toISOString(),
      ends_at: new Date(arriveMs).toISOString(),
    },
    back,
    workshop_start: bounds.startIso,
    mode: 'residential_guest_after_local_teaching_tight',
    arrive_hm: arriveHm,
    travel_arrive_day: idealDay,
    deferred_for_local_teaching: true,
  };
}

function intervalHitsBusy(startMs, endMs, busy) {
  return (busy || []).some((b) => startMs < b.endMs && b.startMs < endMs);
}

function isoClose(a, b, tolMin = 2) {
  return Math.abs(Date.parse(a) - Date.parse(b)) <= tolMin * 60000;
}

/** Slide a travel interval later until clear of busy (30-min steps), or null. */
function slideOffBusy(startMs, endMs, busy, maxSteps = 48) {
  const dur = endMs - startMs;
  let s = startMs;
  let e = endMs;
  for (let i = 0; i <= maxSteps; i += 1) {
    if (!intervalHitsBusy(s, e, busy)) {
      return { startMs: s, endMs: e, shifted: i > 0 };
    }
    s += 30 * 60000;
    e = s + dur;
  }
  return null;
}

/**
 * Travel back is anchored to workshop end — never slide it.
 * Fixture / Ipswich busy must NOT push travel later (buffers coexist with travel).
 * Travel out may still slide only for non-fixture busy (e.g. another teaching block).
 */
function isFixtureBusySummary(summary) {
  const t = String(summary || '');
  return /MC\s*⚽|⚽️|Ipswich Town|hard_fixture/i.test(t);
}

function applyBusyAvoidance(desired, busy) {
  if (!busy?.length || !desired?.out) return desired;
  const busyForOut = (busy || []).filter((b) => !isFixtureBusySummary(b.summary));
  const outS = Date.parse(desired.out.starts_at);
  const outE = Date.parse(desired.out.ends_at);
  const outSlide = slideOffBusy(outS, outE, busyForOut);
  if (!outSlide || !outSlide.shifted) return desired;
  return {
    ...desired,
    out: {
      starts_at: new Date(outSlide.startMs).toISOString(),
      ends_at: new Date(outSlide.endMs).toISOString(),
    },
    // back unchanged — leave at workshop end
    mode: `${desired.mode}_busy_avoid_out`,
    deferred_for_busy: true,
  };
}

/**
 * Overnight hotel / multi-venue: travel home after the LAST workshop, not into the hotel leg.
 */
function isOvernightHotelLeg(b) {
  return /overnight|hotel|rudyard/i.test(`${b.workshop_title || ''} ${b.venue_name || ''}`);
}

function hasIntermediateTravelLegs(pair, blocks) {
  const outMs = Date.parse(pair.out.starts_at);
  const backMs = Date.parse(pair.back.starts_at);
  if (!Number.isFinite(outMs) || !Number.isFinite(backMs)) return false;
  const lo = Math.min(outMs, backMs) - 6 * 3600000;
  const hi = Math.max(outMs, backMs) + 18 * 3600000;
  return (blocks || []).some((b) => {
    if (b.block_type !== 'travel_leg') return false;
    const ms = Date.parse(b.starts_at);
    if (!Number.isFinite(ms) || ms < lo || ms > hi) return false;
    const score = Math.max(
      titleScore(pair.out.workshop_title, b.workshop_title),
      titleScore(pair.back.workshop_title, b.workshop_title),
      titleScore(pair.out.venue_name, b.venue_name),
      titleScore(pair.back.venue_name, b.venue_name),
    );
    return score >= 40 || isOvernightHotelLeg(b);
  });
}

/** Next-morning workshop after overnight hotel leg (e.g. Sat sunset → Sun sunrise). */
function overnightChainEndBounds(pair, blocks, workshops) {
  const outMs = Date.parse(pair.out.starts_at);
  if (!Number.isFinite(outMs)) return null;
  const hotelLeg = (blocks || []).find((b) => {
    if (b.block_type !== 'travel_leg' || !isOvernightHotelLeg(b)) return false;
    const ms = Date.parse(b.starts_at);
    return Number.isFinite(ms) && ms >= outMs - 3600000 && ms <= outMs + 36 * 3600000;
  });
  if (!hotelLeg) return null;
  const hotelEnd = Date.parse(hotelLeg.ends_at || hotelLeg.starts_at);
  const nextLeg = (blocks || []).find((b) => {
    if (b.block_type !== 'travel_leg' || isOvernightHotelLeg(b)) return false;
    const ms = Date.parse(b.starts_at);
    return Number.isFinite(ms) && ms > hotelEnd && ms < hotelEnd + 18 * 3600000;
  });
  const titleHint = nextLeg?.workshop_title || pair.out.workshop_title;
  let best = null;
  let bestScore = -1;
  for (const w of workshops || []) {
    const b = eventBounds(w);
    if (!b || b.startMs < hotelEnd || b.startMs > hotelEnd + 20 * 3600000) continue;
    const ts = titleScore(titleHint, w.summary);
    const related = /peak|heathers|roaches|padley|district/i.test(
      `${w.summary || ''} ${titleHint || ''}`,
    );
    const score = ts + (related ? 15 : 0);
    if (score > bestScore && (ts >= 35 || related)) {
      bestScore = score;
      best = { event: w, bounds: b };
    }
  }
  return best;
}

function planTravelRegenerate(blocks, gcalEvents, ruleMap = {}, venues = []) {
  const arriveMin = Number(ruleMap.arrive_before_start_min || 30);
  const workshops = (gcalEvents || []).filter(isTravelWorkshopEvent);
  const { buildBusyIntervals } = require('./habit-placer-lib');
  const busy = buildBusyIntervals(gcalEvents || [], ruleMap);
  const pairs = pairTravelBlocks(blocks);
  const changes = [];
  const linked = [];
  const unmatched = [];
  const overnight_chains = [];
  const skipped_multileg = [];

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
    const titleBlob = `${match.event.summary || ''} ${pair.out.workshop_title || ''}`;
    const guestOrAttending = !isWorkshopCalendarEvent(match.event)
      || /attending/i.test(titleBlob);

    let desiredRaw;
    let workshopLiveEnd = match.bounds.endIso;
    const chainEnd = hasIntermediateTravelLegs(pair, blocks)
      ? overnightChainEndBounds(pair, blocks, workshops)
      : null;

    if (chainEnd) {
      // Arrive first workshop start; home only after last workshop end.
      const outEndMs = match.bounds.startMs;
      const outStartMs = outEndMs - drive * 60000;
      const backStartMs = chainEnd.bounds.endMs;
      const backEndMs = backStartMs + drive * 60000;
      desiredRaw = {
        out: {
          starts_at: new Date(outStartMs).toISOString(),
          ends_at: new Date(outEndMs).toISOString(),
        },
        back: {
          starts_at: new Date(backStartMs).toISOString(),
          ends_at: new Date(backEndMs).toISOString(),
        },
        workshop_start: match.bounds.startIso,
        mode: 'overnight_chain_home_after_last',
        travel_arrive_day: londonDay(match.bounds.startIso),
      };
      workshopLiveEnd = chainEnd.bounds.endIso;
      overnight_chains.push({
        title: pair.out.workshop_title,
        first: match.event.summary,
        last: chainEnd.event.summary,
        back: desiredRaw.back,
      });
    } else if (hasIntermediateTravelLegs(pair, blocks)) {
      skipped_multileg.push({
        venue: pair.out.venue_name,
        title: pair.out.workshop_title,
        out_id: pair.out.id,
        back_id: pair.back.id,
        reason: 'intermediate_travel_legs_no_chain_end',
      });
      continue;
    } else {
      desiredRaw = desiredTravelTimes(match.bounds, drive, arriveMin, pair, ruleMap, {
        teachingEvents: workshops,
        excludeEventId: match.event.id,
        guestOrAttending,
      });
    }

    const busySansTravel = busy.filter((b) => !/Travel /i.test(b.summary || ''));
    const desired = applyBusyAvoidance(desiredRaw, busySansTravel);
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
      workshop_live_end: workshopLiveEnd,
      drive_minutes: drive,
      arrive_before_min: arriveMin,
      mode: desired.mode,
      deferred_for_local_teaching: !!desired.deferred_for_local_teaching,
      travel_arrive_day: desired.travel_arrive_day || null,
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
    skipped_multileg,
    overnight_chains,
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
  hasIntermediateTravelLegs,
  overnightChainEndBounds,
  pickWorkshop,
  otherTeachingEndOnDay,
  normTitle,
};
