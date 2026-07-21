const fs = require('fs');
const path = require('path');

const FILES = [
  {
    id: 'lessons',
    label: 'Lessons CSV',
    name: '02-beginners-photography-lessons.csv',
    kind: 'lesson',
  },
  {
    id: 'workshops',
    label: 'Workshops CSV',
    name: '03-photographic-workshops-near-me.csv',
    kind: 'workshop',
  },
];

function candidateDirs() {
  const dirs = [];
  if (process.env.MC_SCHEDULE_CSV_DIR) dirs.push(process.env.MC_SCHEDULE_CSV_DIR);
  // Deployed copy (Vercel) + Alan's shared Dropbox (local / if mounted)
  dirs.push(path.join(process.cwd(), 'data', 'schedule'));
  dirs.push(path.join(__dirname, '..', '..', 'data', 'schedule'));
  dirs.push('G:\\Dropbox\\alan ranger photography\\Website Code\\alan-shared-resources\\csv');
  return dirs;
}

function resolveFile(fileName) {
  for (const dir of candidateDirs()) {
    const full = path.join(dir, fileName);
    try {
      if (fs.existsSync(full)) return full;
    } catch (e) { /* skip */ }
  }
  return null;
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function readCsvFile(fullPath) {
  const text = fs.readFileSync(fullPath, 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { headers: [], rows: [] };
  const headers = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map((line) => {
    const cols = parseCsvLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = cols[i] != null ? cols[i] : ''; });
    return obj;
  });
  return { headers, rows };
}

function ageDays(mtimeMs) {
  return (Date.now() - mtimeMs) / 86400000;
}

function freshnessTone(days) {
  if (days < 7) return 'green';
  if (days <= 14) return 'amber';
  return 'red';
}

function humanAgo(mtimeMs) {
  const sec = Math.max(0, Math.round((Date.now() - mtimeMs) / 1000));
  if (sec < 3600) return `${Math.max(1, Math.round(sec / 60))} minutes ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)} hours ago`;
  const d = Math.round(sec / 86400);
  return d === 1 ? '1 day ago' : `${d} days ago`;
}

/** Source freshness for UI + detector logging. */
function getScheduleSources() {
  return FILES.map((f) => {
    const full = resolveFile(f.name);
    if (!full) {
      return {
        id: f.id,
        label: f.label,
        name: f.name,
        kind: f.kind,
        ok: false,
        error: 'missing_or_unreadable',
        path: null,
        mtime: null,
        age_days: null,
        tone: 'red',
        display: `${f.label}: MISSING — re-export into apps-dashboard/data/schedule/`,
      };
    }
    const st = fs.statSync(full);
    const days = ageDays(st.mtimeMs);
    return {
      id: f.id,
      label: f.label,
      name: f.name,
      kind: f.kind,
      ok: true,
      error: null,
      path: full,
      mtime: st.mtime.toISOString(),
      age_days: Math.round(days * 10) / 10,
      tone: freshnessTone(days),
      display: `${f.label}: updated ${humanAgo(st.mtimeMs)}`,
    };
  });
}

function loadScheduleEvents() {
  const sources = getScheduleSources();
  const events = [];
  const errors = [];
  for (const src of sources) {
    if (!src.ok) {
      errors.push(src);
      continue;
    }
    try {
      const { rows } = readCsvFile(src.path);
      rows.forEach((r, idx) => {
        const start = String(r.Start_Date || '').slice(0, 10);
        if (!start || !r.Event_Title) return;
        events.push({
          source_id: src.id,
          kind: src.kind,
          title: r.Event_Title,
          start_date: start,
          start_time: String(r.Start_Time || '').slice(0, 8),
          end_date: String(r.End_Date || start).slice(0, 10),
          end_time: String(r.End_Time || '').slice(0, 8),
          location_name: r.Location_Business_Name || '',
          address: r.Location_Address || '',
          postcode: r.Location_City_State_ZIP || '',
          url: r.Event_URL || '',
          workflow: r.Workflow_State || '',
          row_key: `${src.id}:${r.Event_URL || idx}:${start}`,
        });
      });
    } catch (e) {
      errors.push({ ...src, ok: false, error: e.message || 'read_failed' });
    }
  }
  return { sources, events, errors };
}

function isHomeBased(ev, homePostcode) {
  const blob = `${ev.address} ${ev.postcode} ${ev.location_name}`.toLowerCase();
  const home = String(homePostcode || 'CV4 9HW').toLowerCase();
  if (blob.includes(home.toLowerCase())) return true;
  if (blob.includes('hathaway road')) return true;
  if (blob.includes('cv4 9h')) return true;
  return false;
}

module.exports = {
  FILES,
  getScheduleSources,
  loadScheduleEvents,
  isHomeBased,
};
