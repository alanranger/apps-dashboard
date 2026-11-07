import fs from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { parseCsv, readCsvText } = require('../api/mc/scheduleCsv.js');

const csvPath = 'G:/Dropbox/alan ranger photography/Website Code/alan-shared-resources/csv/03-photographic-workshops-near-me.csv';
const text = fs.readFileSync(csvPath, 'utf8');
const { headers, rows } = readCsvText(text);

const ken = rows.find((r) => String(r.Event_Title || '').includes('Kenilworth 01-09'));
const wood = rows.find((r) => /Woodland Walk/i.test(r.Event_Title || '') && /</.test(r.Text_Block || ''));
const xmas = rows.find((r) => /Christmas|Warwickshire/i.test(r.Event_Title || '') && /</.test(r.Text_Block || ''));

console.log('total_rows', rows.length);
console.log('bad_dates', rows.filter((r) => r.Event_Title && !/^\d{4}-\d{2}-\d{2}/.test(String(r.Start_Date || ''))).length);
console.log('ken', ken && {
  Start_Date: ken.Start_Date,
  Location_Business_Name: ken.Location_Business_Name,
  Location_Address: ken.Location_Address,
  Location_City_State_ZIP: ken.Location_City_State_ZIP,
});
console.log('wood_title', wood?.Event_Title, 'start', wood?.Start_Date, 'text_len', wood?.Text_Block?.length);
console.log('xmas_title', xmas?.Event_Title, 'start', xmas?.Start_Date, 'text_len', xmas?.Text_Block?.length);

// Find a row whose Text_Block contains a comma + quote + newline
const rich = rows.find((r) => {
  const t = r.Text_Block || '';
  return t.includes('<div') && t.includes(',') && t.includes('\n');
});
console.log('rich_title', rich?.Event_Title, 'start', rich?.Start_Date);
if (rich) {
  // Rebuild a mini CSV of header + this row using RFC-4180 quoting for the test fixture
  function esc(v) {
    const s = String(v ?? '');
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }
  const headerLine = headers.join(',');
  const dataLine = headers.map((h) => esc(rich[h])).join(',');
  const kenLine = headers.map((h) => esc(ken[h])).join(',');
  fs.writeFileSync('tmp/fixture-workshop-sample.csv', `${headerLine}\n${kenLine}\n${dataLine}\n`);
  console.log('wrote tmp/fixture-workshop-sample.csv');
}
