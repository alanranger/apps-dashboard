/**
 * Heuristic hotel-confirmation parsers (multi-shape). Prefer booking refs.
 */

function normalizeRef(s) {
  return String(s || '').trim().toUpperCase().replace(/\s+/g, '');
}

function extractBookingRefs(text) {
  const t = String(text || '');
  const found = new Set();
  const patterns = [
    /\bBDC[- ]?([A-Z0-9]{6,})\b/gi,
    /\bbooking\.com\s*(?:confirmation|pin|number)?[:\s#]*([A-Z0-9]{8,})\b/gi,
    /\b(?:confirmation|booking)\s*(?:number|ref|reference|code|pin)[:\s#]*([A-Z0-9-]{6,})\b/gi,
    /\b(?:reservation)\s*(?:number|id|ref)[:\s#]*([A-Z0-9-]{6,})\b/gi,
    /\b([0-9]{9,12})\b/g, // booking.com numeric style
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(t))) {
      const raw = m[1] || m[0];
      const n = normalizeRef(raw);
      if (n.length >= 6 && n.length <= 32) found.add(n);
    }
  }
  return [...found];
}

function extractPounds(text) {
  const t = String(text || '');
  const amounts = [];
  const re = /£\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?|[0-9]+(?:\.[0-9]{2})?)/g;
  let m;
  while ((m = re.exec(t))) {
    amounts.push(Number(m[1].replace(/,/g, '')));
  }
  return amounts;
}

function isCancellation(subject, body) {
  const t = `${subject}\n${body}`.toLowerCase();
  if (/cancell?ed|cancellation|booking has been cancelled|reservation cancelled/.test(t)) return true;
  if (/has been canceled/.test(t)) return true;
  return false;
}

function hotelHint(subject, from) {
  const s = String(subject || '');
  // "Confirmation: The White Horse, Overstrand" style
  const after = s.replace(/^(re:|fwd:)\s*/i, '');
  if (/ravenstone/i.test(`${s} ${from}`)) return 'Ravenstone Manor';
  if (/white horse/i.test(s)) return after;
  if (/ellerby/i.test(s)) return 'Ellerby Country Inn';
  if (/hartland/i.test(s)) return 'Hartland Quay Hotel';
  if (/kingston/i.test(s)) return 'Kingston Country Courtyard';
  return after.slice(0, 120) || null;
}

function parseHotelMessage(msg) {
  const blob = `${msg.subject}\n${msg.snippet}\n${msg.bodyText}`;
  const refs = extractBookingRefs(blob);
  const amounts = extractPounds(blob);
  const cancelled = isCancellation(msg.subject, msg.bodyText);
  return {
    message_id: msg.id,
    thread_id: msg.threadId,
    date: msg.internalDate,
    subject: msg.subject,
    from: msg.from,
    refs,
    primary_ref: refs[0] || null,
    amounts,
    amount: amounts.length ? Math.max(...amounts) : null,
    cancelled,
    hotel_hint: hotelHint(msg.subject, msg.from),
    parse_ok: refs.length > 0 || /booking\.com|ravenstone|confirmation|reservation/i.test(blob),
  };
}

function refsMatch(a, b) {
  if (!a || !b) return false;
  const x = normalizeRef(a);
  const y = normalizeRef(b);
  return x === y || x.includes(y) || y.includes(x);
}

function costMismatch(dbCost, emailAmount) {
  if (dbCost == null || emailAmount == null) return false;
  const a = Number(dbCost);
  const b = Number(emailAmount);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) >= 25; // £25+ difference = flag
}

module.exports = {
  normalizeRef,
  extractBookingRefs,
  parseHotelMessage,
  refsMatch,
  costMismatch,
};
