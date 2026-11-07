import fs from 'fs';

const raw = fs.readFileSync(
  'C:/Users/alan/.cursor/projects/g-Dropbox-alan-ranger-photography-Website-Code-Chat-AI-Bot/agent-tools/49c19541-6625-434f-a979-e4b414073438.txt',
  'utf8'
);
const outer = JSON.parse(raw);
const t = outer.result;
const i = t.indexOf('[');
const j = t.lastIndexOf(']');
if (i < 0 || j < 0) throw new Error('no array in result');
const rows = JSON.parse(t.slice(i, j + 1));
const out =
  'G:/Dropbox/alan ranger photography/Website Code/apps-dashboard/tmp/verify-log-clean.json';
fs.writeFileSync(out, JSON.stringify(rows));
console.log('habits', rows.length, rows[0].calendar_event_id, rows.at(-1).scheduled_date);
