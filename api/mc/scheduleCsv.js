const fs = require('fs');
const path = require('path');

const FILES = [
  {
    id: 'lessons',
    label: 'Lessons CSV',
    name: '02-beginners-photography-lessons.csv',
    kind: 'lesson',
    githubPath: 'csv/02-beginners-photography-lessons.csv',
  },
  {
    id: 'workshops',
    label: 'Workshops CSV',
    name: '03-photographic-workshops-near-me.csv',
    kind: 'workshop',
    githubPath: 'csv/03-photographic-workshops-near-me.csv',
  },
];

const GITHUB_REPO = process.env.MC_SCHEDULE_CSV_GITHUB || 'alanranger/alan-shared-resources';
const GITHUB_BRANCH = process.env.MC_SCHEDULE_CSV_BRANCH || 'main';

function localCsvDirs() {
  const dirs = [];
  if (process.env.MC_SCHEDULE_CSV_DIR) dirs.push(process.env.MC_SCHEDULE_CSV_DIR);
  dirs.push(path.join(__dirname, '..', '..', '..', 'alan-shared-resources', 'csv'));
  dirs.push('G:\\Dropbox\\alan ranger photography\\Website Code\\alan-shared-resources\\csv');
  return dirs;
}

function resolveLocalFile(fileName) {
  for (const dir of localCsvDirs()) {
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

function readCsvText(text) {
  const clean = text.replace(/^\uFEFF/, '');
  const lines = clean.split(/\r?\n/).filter((l) => l.trim());
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

function sourceFromLocal(f, full) {
  const st = fs.statSync(full);
  const days = ageDays(st.mtimeMs);
  return {
    id: f.id,
    label: f.label,
    name: f.name,
    kind: f.kind,
    ok: true,
    error: null,
    origin: 'local',
    path: full,
    mtime: st.mtime.toISOString(),
    age_days: Math.round(days * 10) / 10,
    tone: freshnessTone(days),
    display: `${f.label}: updated ${humanAgo(st.mtimeMs)}`,
    text: fs.readFileSync(full, 'utf8'),
  };
}

async function fetchGithubCsv(f) {
  const rawUrl = `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${f.githubPath}`;
  const commitUrl = `https://api.github.com/repos/${GITHUB_REPO}/commits?path=${encodeURIComponent(f.githubPath)}&per_page=1`;
  const [rawRes, commitRes] = await Promise.all([
    fetch(rawUrl, { headers: { Accept: 'text/plain' } }),
    fetch(commitUrl, { headers: { Accept: 'application/vnd.github+json' } }),
  ]);
  if (!rawRes.ok) {
    const err = new Error(`github_raw_${rawRes.status}`);
    err.status = rawRes.status;
    throw err;
  }
  const text = await rawRes.text();
  let mtimeIso = null;
  if (commitRes.ok) {
    const commits = await commitRes.json();
    mtimeIso = commits?.[0]?.commit?.committer?.date || null;
  }
  if (!mtimeIso) {
    const hdr = rawRes.headers.get('last-modified');
    mtimeIso = hdr ? new Date(hdr).toISOString() : new Date().toISOString();
  }
  const mtimeMs = new Date(mtimeIso).getTime();
  const days = ageDays(mtimeMs);
  return {
    id: f.id,
    label: f.label,
    name: f.name,
    kind: f.kind,
    ok: true,
    error: null,
    origin: 'github',
    path: `github:${GITHUB_REPO}/${f.githubPath}@${GITHUB_BRANCH}`,
    mtime: mtimeIso,
    age_days: Math.round(days * 10) / 10,
    tone: freshnessTone(days),
    display: `${f.label}: updated ${humanAgo(mtimeMs)} (alan-shared-resources)`,
    text,
  };
}

function missingSource(f, error) {
  return {
    id: f.id,
    label: f.label,
    name: f.name,
    kind: f.kind,
    ok: false,
    error: error || 'missing_or_unreadable',
    origin: null,
    path: null,
    mtime: null,
    age_days: null,
    tone: 'red',
    display: `${f.label}: MISSING — re-export into alan-shared-resources/csv and push`,
    text: null,
  };
}

async function fetchDropboxCsv(f) {
  const token = process.env.DROPBOX_ACCESS_TOKEN || process.env.MC_DROPBOX_ACCESS_TOKEN;
  if (!token) return null;
  const dropPath = `/alan-shared-resources/csv/${f.name}`;
  const metaRes = await fetch('https://api.dropboxapi.com/2/files/get_metadata', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: dropPath, include_media_info: false }),
  });
  if (!metaRes.ok) return null;
  const meta = await metaRes.json();
  const dlRes = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Dropbox-API-Arg': JSON.stringify({ path: dropPath }),
    },
  });
  if (!dlRes.ok) return null;
  const text = await dlRes.text();
  const mtimeIso = meta.client_modified || meta.server_modified;
  const mtimeMs = new Date(mtimeIso).getTime();
  const days = ageDays(mtimeMs);
  return {
    id: f.id,
    label: f.label,
    name: f.name,
    kind: f.kind,
    ok: true,
    error: null,
    origin: 'dropbox',
    path: `dropbox:${dropPath}`,
    mtime: mtimeIso,
    age_days: Math.round(days * 10) / 10,
    tone: freshnessTone(days),
    display: `${f.label}: updated ${humanAgo(mtimeMs)} (Dropbox original)`,
    text,
  };
}

async function loadOneSource(f) {
  try {
    const dbx = await fetchDropboxCsv(f);
    if (dbx) return dbx;
  } catch (e) { /* fall through */ }
  const local = resolveLocalFile(f.name);
  if (local) {
    try {
      return sourceFromLocal(f, local);
    } catch (e) {
      return missingSource(f, e.message || 'local_read_failed');
    }
  }
  if (process.env.VERCEL || process.env.MC_ALLOW_GITHUB_CSV_FALLBACK === 'true') {
    try {
      return await fetchGithubCsv(f);
    } catch (e) {
      return missingSource(f, e.message || 'github_fetch_failed');
    }
  }
  return missingSource(f, 'dropbox_credentials_missing — set DROPBOX_ACCESS_TOKEN on Vercel; no silent repo fallback');
}

/** Source freshness for UI + detector logging. */
async function getScheduleSources() {
  return Promise.all(FILES.map(loadOneSource));
}

async function loadScheduleEvents() {
  const sources = await getScheduleSources();
  const events = [];
  const errors = [];
  for (const src of sources) {
    if (!src.ok) {
      errors.push(src);
      continue;
    }
    try {
      const { rows } = readCsvText(src.text);
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
