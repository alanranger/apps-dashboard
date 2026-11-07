import fs from 'fs';

const d = JSON.parse(fs.readFileSync('G:/Dropbox/alan ranger photography/Website Code/apps-dashboard/tmp/bank-holidays.json', 'utf8'));
const ew = d['england-and-wales'].events;
const rows = ew.map((e) => {
  const title = String(e.title).replace(/'/g, "''");
  const notes = String(e.notes || '').replace(/'/g, "''");
  const sub = notes.toLowerCase().includes('substitute');
  return `  ('${e.date}', 'england-and-wales', '${title}', ${sub ? 'true' : 'false'})`;
}).join(',\n');

const sql = `INSERT INTO public.bank_holidays (holiday_date, division, title, is_substitute) VALUES\n${rows}\nON CONFLICT (holiday_date, division) DO UPDATE SET title = EXCLUDED.title, is_substitute = EXCLUDED.is_substitute, updated_at = now();`;

fs.writeFileSync('G:/Dropbox/alan ranger photography/Website Code/apps-dashboard/tmp/bh-insert.sql', sql);
console.log('rows', ew.length, 'range', ew[0].date, '->', ew[ew.length - 1].date);
