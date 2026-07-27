/**
 * Single source for Google Calendar titles for MC-managed events.
 * NEVER derive a Calendar summary from gcal_push_queue.summary / changelog text.
 */

function priorityToken(priority) {
  const s = String(priority || '').toLowerCase();
  if (/^p[0-3]$/.test(s)) return s.toUpperCase();
  return null;
}

function taskGcalTitle({ display_id, title, priority }) {
  const bare = String(title || '').trim() || `MC-${display_id}`;
  const core = `MC-${display_id} · ${bare}`;
  const p = priorityToken(priority);
  return p ? `${p} · ${core}` : core;
}

function habitGcalTitle(title, prefixes = {}) {
  const prefix = prefixes.habit || 'MC 🔁';
  const bare = String(title || '').trim();
  if (!bare) return prefix.trim();
  if (bare.startsWith(prefix) || bare.startsWith('MC 🔁')) return bare;
  return `${prefix} ${bare}`.replace(/\s+/g, ' ').trim();
}

function travelGcalTitle(block, prefixes = {}) {
  const travel = prefixes.travel || 'MC 🚗';
  const buffer = prefixes.buffer || 'MC ⏳';
  const workshop = String(block.workshop_title || block.venue_name || 'workshop').trim();
  const type = String(block.block_type || '');
  if (type === 'prep') return `${buffer} Prep — ${workshop}`;
  if (type === 'decompress') return `${buffer} Decompress — ${workshop}`;
  if (type === 'travel_back') return `${travel} Travel back — ${workshop} → home`;
  if (type === 'travel_leg') return `${travel} Travel — ${workshop}`;
  return `${travel} Travel out — ${workshop}`;
}

/** Destination-ish location for the GCal Location field. */
function travelGcalLocation(block) {
  const type = String(block.block_type || '');
  const to = String(block.leg_to || '').trim();
  const from = String(block.leg_from || '').trim();
  const venue = String(block.venue_name || '').trim();
  if (type === 'travel_back') return to || 'Home';
  if (type === 'travel_out' || type === 'travel_leg') return to || venue || '';
  return venue || to || '';
}

/** Body text: from → to, minutes, venue. */
function travelGcalDescription(block) {
  const type = String(block.block_type || '');
  const from = String(block.leg_from || '').trim() || '—';
  const to = String(block.leg_to || '').trim() || '—';
  const mins = block.drive_minutes_used != null ? Number(block.drive_minutes_used) : null;
  const venue = String(block.venue_name || '').trim();
  const workshop = String(block.workshop_title || '').trim();
  const lines = [];
  if (type === 'prep' || type === 'decompress') {
    lines.push(`${type === 'prep' ? 'Prep' : 'Decompress'} buffer for ${workshop || venue || 'workshop'}.`);
  } else {
    lines.push(`Driving from → to: ${from} → ${to}`);
    if (mins != null && Number.isFinite(mins)) lines.push(`Drive time: ${mins} minutes`);
    if (venue) lines.push(`Venue: ${venue}`);
    if (workshop) lines.push(`Workshop: ${workshop}`);
  }
  return lines.join('\n');
}

function restDayGcalTitle(workshopTitle) {
  const bare = String(workshopTitle || 'workshop').trim();
  return `MC 🛌 REST — after ${bare}`;
}

function awaySpanGcalTitle({ venue_name, workshop_title }) {
  const bare = String(venue_name || workshop_title || 'trip').trim();
  return `MC 🚫 AWAY — ${bare}`;
}

/** Queue/changelog strings that must never become Calendar titles. */
function isChangelogTitle(s) {
  const t = String(s || '');
  if (!t) return true;
  return /^(MC 🚗\s*)?Move travel_/i.test(t)
    || /^Scheduler bump\b/i.test(t)
    || /^Deconflict\b/i.test(t)
    || /^Rest-day flag\b/i.test(t)
    || /^Rest-Monday\b/i.test(t)
    || /^Complete habit\b/i.test(t)
    || /^MOVE Primary event\b/i.test(t)
    || /to follow workshop/i.test(t)
    || /^Rule breach:/i.test(t);
}

module.exports = {
  taskGcalTitle,
  habitGcalTitle,
  travelGcalTitle,
  travelGcalLocation,
  travelGcalDescription,
  restDayGcalTitle,
  awaySpanGcalTitle,
  isChangelogTitle,
  priorityToken,
};
