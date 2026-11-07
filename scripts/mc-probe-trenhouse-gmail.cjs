/**
 * Probe Gmail Label_209 for High Trenhouse / ref 4900469028.
 * node scripts/mc-probe-trenhouse-gmail.cjs
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { gmailConfigured, getAccessToken, listLabelMessageIds, getMessage } = require('../api/mc/gmail-lib');
const { parseHotelMessage } = require('../api/mc/hotel-parse-lib');

function extractDates(blob) {
  const out = [];
  const patterns = [
    /\b(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+20\d{2})\b/gi,
    /\b((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s+\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+20\d{2})\b/gi,
    /\b(20\d{2}-\d{2}-\d{2})\b/g,
    /\b(check[- ]?in[^.\n]{0,80})/gi,
    /\b(check[- ]?out[^.\n]{0,80})/gi,
    /\b(\d+\s*(?:night|nights|room|rooms)[^.\n]{0,60})/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(blob))) out.push(m[1].replace(/\s+/g, ' ').trim());
  }
  return [...new Set(out)].slice(0, 40);
}

(async () => {
  if (!gmailConfigured()) throw new Error('Gmail not configured in .env.local');
  const token = await getAccessToken();
  const labelId = process.env.GMAIL_HOTEL_LABEL_ID || 'Label_209';
  const ids = await listLabelMessageIds(token, labelId, 120);
  const hits = [];
  for (const id of ids) {
    const msg = await getMessage(token, id);
    const blob = `${msg.subject}\n${msg.snippet}\n${msg.bodyText || ''}`;
    if (!/trenhouse|4900469028/i.test(blob)) continue;
    const parsed = parseHotelMessage(msg);
    hits.push({
      message_id: msg.id,
      thread_id: msg.threadId,
      internalDate: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : null,
      from: msg.from,
      subject: msg.subject,
      snippet: msg.snippet,
      parsed,
      date_hints: extractDates(blob),
      address_hints: [...new Set((blob.match(/\b[A-Z]{1,2}\d{1,2}[A-Z]?\s*\d[A-Z]{2}\b/gi) || []))],
      body_excerpt: String(msg.bodyText || msg.snippet || '').replace(/\s+/g, ' ').slice(0, 1200),
    });
  }
  console.log(JSON.stringify({ labelId, scanned: ids.length, hits: hits.length, rows: hits }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
