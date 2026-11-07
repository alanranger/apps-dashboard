import fs from 'fs';

const rawPath =
  'G:/Dropbox/alan ranger photography/Website Code/apps-dashboard/tmp/verify-recurring-log.json';
const arrPath =
  'G:/Dropbox/alan ranger photography/Website Code/apps-dashboard/tmp/verify-recurring-log.arr.json';
const out =
  'G:/Dropbox/alan ranger photography/Website Code/apps-dashboard/tmp/verify-log-clean.json';

function tryParse(t) {
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  const start = t.indexOf('[');
  const end = t.lastIndexOf(']');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  try {
    return JSON.parse(t);
  } catch {
    // escaped quotes from PowerShell
    const unesc = t.replace(/\\"/g, '"').replace(/\\n/g, '\n');
    return JSON.parse(unesc);
  }
}

let parsed = null;
for (const p of [rawPath, arrPath]) {
  try {
    const t = fs.readFileSync(p, 'utf8');
    // MCP wrapper
    const tag = t.indexOf('<untrusted-data-');
    if (tag >= 0) {
      const gt = t.indexOf('>', tag);
      const close = t.indexOf('</untrusted-data', gt);
      parsed = tryParse(t.slice(gt + 1, close));
    } else {
      parsed = tryParse(t);
    }
    console.log('ok from', p, parsed.length);
    break;
  } catch (e) {
    console.log('fail', p, e.message.slice(0, 120));
  }
}
if (!parsed) process.exit(1);
fs.writeFileSync(out, JSON.stringify(parsed));
console.log('wrote', out);
