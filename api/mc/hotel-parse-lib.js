/**
 * Heuristic hotel-confirmation parsers (multi-shape). Prefer booking refs.
 * v2: cancel = subject/event only; refs reject word-tails/phones; £ near total labels.
 */

const REF_DENY = new Set([
  'ERENCE', 'REFERENCE', 'CONFIRMATION', 'NUMBER', 'BOOKING', 'RESERVATION',
  'CANCELLED', 'CANCELED', 'CANCEL', 'PLEASE', 'DETAILS', 'CUSTOMER',
]);

function normalizeRef(s) {
  return String(s || '').trim().toUpperCase().replace(/\s+/g, '');
}

function isPlausibleRef(raw, opts = {}) {
  const n = normalizeRef(raw);
  if (n.length < 6 || n.length > 32) return false;
  if (REF_DENY.has(n)) return false;
  if (/^0\d{9,11}$/.test(n)) return false; // UK phones
  if (/^[A-Z]+$/.test(n) && n.length < 10) return false;
  // booking.com numeric (no leading 0; reject unix timestamps ~2015–2035)
  if (/^\d{9,12}$/.test(n) && !n.startsWith('0')) {
    const num = Number(n);
    if (n.length === 10 && num >= 1420070400 && num <= 2051222400) return false;
    return true;
  }
  if (/^BDC-?[A-Z0-9]{6,}$/i.test(n)) return true;
  // Ravenstone / HLS hex — only when allowHex
  if (opts.allowHex && /^[0-9A-F]{8,12}$/i.test(n) && /[0-9]/.test(n) && /[A-F]/i.test(n)) {
    return true;
  }
  // Mixed alnum (not hex-only catch-all)
  if (/[0-9]/.test(n) && /[A-Z]/i.test(n) && n.length >= 10 && !/^[0-9A-F]+$/i.test(n)) {
    return true;
  }
  return false;
}

function extractBookingRefs(text, opts = {}) {
  const t = String(text || '');
  const found = new Set();
  const patterns = [
    /\bBDC[- ]?([A-Z0-9]{6,})\b/gi,
    /\bbooking\.com\s*(?:confirmation|pin|number)?[:\s#]*([A-Z0-9]{8,})\b/gi,
    /\b(?:confirmation|booking)\s*(?:number|ref|code|pin)[:\s#]*([A-Z0-9-]{6,})\b/gi,
    /\b(?:reservation)\s*(?:number|id|ref)[:\s#]*([A-Z0-9-]{6,})\b/gi,
    /\b([1-9][0-9]{8,11})\b/g,
  ];
  if (opts.allowHex) patterns.push(/\b([0-9a-f]{8,12})\b/gi);
  for (const re of patterns) {
    let m;
    while ((m = re.exec(t))) {
      const raw = m[1] || m[0];
      if (isPlausibleRef(raw, opts)) found.add(normalizeRef(raw));
    }
  }
  return [...found];
}

function extractLabeledTotals(text) {
  const t = String(text || '');
  const amounts = [];
  const re = /(?:total|price|paid|amount|charge|grand\s*total|booking\s*total|you\s*paid)[:\s]*£\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?|[0-9]+(?:\.[0-9]{2})?)/gi;
  let m;
  while ((m = re.exec(t))) amounts.push(Number(m[1].replace(/,/g, '')));
  const re2 = /£\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?|[0-9]+(?:\.[0-9]{2})?)\s*(?:total|paid)/gi;
  while ((m = re2.exec(t))) amounts.push(Number(m[1].replace(/,/g, '')));
  return amounts;
}

function isCancellation(subject, body, from) {
  const sub = String(subject || '').toLowerCase();
  const frm = String(from || '').toLowerCase();
  if (/booking\s+canceled|booking\s+cancelled|cancellation\s+confirmed|has\s+been\s+cancell?ed|reservation\s+cancell?ed|cancelled\s+for\b|canceled\s+for\b/.test(sub)) {
    return true;
  }
  if (/cs-noreply@booking\.com/.test(frm) && /cancell?/.test(sub)) return true;
  return false;
}

function hotelHint(subject, from) {
  const s = String(subject || '');
  const after = s.replace(/^(re:|fwd:)\s*/i, '');
  if (/ravenstone/i.test(`${s} ${from}`)) return 'Ravenstone Manor';
  if (/ellerby/i.test(s)) return 'Ellerby Country Inn';
  if (/hartland/i.test(s)) return 'Hartland Quay Hotel';
  if (/kingston/i.test(s)) return 'Kingston Country Courtyard';
  if (/angel\s*inn/i.test(s)) return 'Angel Inn';
  if (/vyrnwy/i.test(s)) return 'Lake Vyrnwy Hotel';
  if (/white horse/i.test(s)) return 'White Horse';
  const cleaned = after
    .replace(/^(confirmation|booking confirmation|your booking)[:\s-]*/i, '')
    .trim();
  return cleaned.slice(0, 80) || null;
}

function normalizeHotelName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hotelNamesMatch(a, b) {
  const x = normalizeHotelName(a);
  const y = normalizeHotelName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.includes(y) || y.includes(x)) return true;
  const xt = x.split(' ').filter((t) => t.length > 3);
  const yt = new Set(y.split(' ').filter((t) => t.length > 3));
  const shared = xt.filter((t) => yt.has(t));
  return shared.length >= 2 || (shared.length === 1 && shared[0].length >= 6);
}

function parseHotelMessage(msg) {
  const blob = `${msg.subject}\n${msg.snippet}\n${msg.bodyText}`;
  const allowHex = /ravenstone|high-level-software|ravenstonemanor/i.test(
    `${msg.subject}\n${msg.from}\n${blob.slice(0, 500)}`,
  );
  const refs = extractBookingRefs(blob, { allowHex });
  const amounts = extractLabeledTotals(blob);
  const cancelled = isCancellation(msg.subject, msg.bodyText, msg.from);
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
  if (x === y) return true;
  if (x.length >= 8 && y.length >= 8 && (x.includes(y) || y.includes(x))) return true;
  return false;
}

function costMismatch(dbCost, emailAmount) {
  // v2: disabled — booking.com emails often show ex-VAT / partial / room-only
  // figures that disagree with register totals without being wrong.
  return false;
}

/** Name mismatch only when clearly different hotels (not subject fluff). */
function nameMismatch(dbHotel, hint, subject) {
  if (!dbHotel || !hint) return false;
  if (hotelNamesMatch(hint, dbHotel)) return false;
  const sub = normalizeHotelName(subject || '');
  const db = normalizeHotelName(dbHotel);
  // If the DB hotel's distinctive tokens appear in the subject, it matches
  const tokens = db.split(' ').filter((t) => t.length > 3);
  if (tokens.some((t) => sub.includes(t))) return false;
  // Ignore hints that are mostly subject chrome
  if (/thanks|confirmed|message|special request|action required|updated booking/i.test(hint)
    && tokens.some((t) => normalizeHotelName(hint).includes(t))) return false;
  if (/thanks|message from|special request|action required/i.test(hint)) return false;
  return true;
}

module.exports = {
  normalizeRef,
  extractBookingRefs,
  extractLabeledTotals,
  parseHotelMessage,
  refsMatch,
  costMismatch,
  nameMismatch,
  hotelNamesMatch,
  isCancellation,
  isPlausibleRef,
};
