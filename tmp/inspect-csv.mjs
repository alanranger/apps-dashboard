import fs from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const csvPath = 'G:/Dropbox/alan ranger photography/Website Code/alan-shared-resources/csv/03-photographic-workshops-near-me.csv';
const text = fs.readFileSync(csvPath, 'utf8');

// Count newlines inside quotes (RFC-4180)
let inQ = false;
let newlinesInQuotes = 0;
for (let i = 0; i < text.length; i += 1) {
  const ch = text[i];
  if (inQ) {
    if (ch === '"' && text[i + 1] === '"') { i += 1; continue; }
    if (ch === '"') { inQ = false; continue; }
    if (ch === '\n') newlinesInQuotes += 1;
  } else if (ch === '"') inQ = true;
}
console.log({
  bytes: text.length,
  naive_lines: text.split(/\r?\n/).length,
  newlines_inside_quotes: newlinesInQuotes,
});

// Current parser result for Kenilworth
// Inline the current readCsvText logic via require — but it isn't exported.
// Reproduce current readCsvText:
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
const clean = text.replace(/^\uFEFF/, '');
const lines = clean.split(/\r?\n/).filter((l) => l.trim());
const headers = parseCsvLine(lines[0]);
console.log('headers_count', headers.length);
console.log('Start_Date_idx', headers.indexOf('Start_Date'));
console.log('Location_Business_Name_idx', headers.indexOf('Location_Business_Name'));
console.log('Text_Block_idx', headers.indexOf('Text_Block'));

const bad = [];
for (let i = 1; i < lines.length; i += 1) {
  const cols = parseCsvLine(lines[i]);
  const obj = {};
  headers.forEach((h, j) => { obj[h] = cols[j] != null ? cols[j] : ''; });
  const start = String(obj.Start_Date || '');
  if (obj.Event_Title && obj.Event_Title.includes('Kenilworth 01-09')) {
    console.log('KENILWORTH_ROW', {
      cols: cols.length,
      headers: headers.length,
      Start_Date: obj.Start_Date,
      Event_Title: obj.Event_Title,
      Location_Business_Name: obj.Location_Business_Name,
      Location_Address: String(obj.Location_Address || '').slice(0, 80),
      Location_City_State_ZIP: obj.Location_City_State_ZIP,
    });
  }
  if (obj.Event_Title && (!/^\d{4}-\d{2}-\d{2}/.test(start) || start.includes('Kenilwort'))) {
    bad.push({
      line: i + 1,
      title: String(obj.Event_Title).slice(0, 60),
      Start_Date: start.slice(0, 40),
      cols: cols.length,
    });
  }
}
console.log('bad_start_dates_count', bad.length);
console.log('bad_sample', bad.slice(0, 8));
