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

/**
 * RFC-4180 CSV parser over the full text (not line-by-line).
 * Honours quoted fields, embedded commas, embedded newlines, and "" escapes.
 * The previous line-first split broke on Text_Block HTML (360 newlines inside
 * quotes in the workshops CSV) and slid location strings into Start_Date —
 * producing the snapshot error `invalid input syntax for type date: " Kenilwort"`.
 */
function parseCsv(text) {
  const records = [];
  let row = [];
  let cur = '';
  let inQ = false;
  const pushField = () => { row.push(cur); cur = ''; };
  const pushRow = () => {
    pushField();
    // Drop blank trailing lines (record is a single empty field).
    if (row.length === 1 && row[0] === '') { row = []; return; }
    records.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i += 1; }
        else inQ = false;
      } else cur += ch;
      continue;
    }
    if (ch === '"') { inQ = true; continue; }
    if (ch === ',') { pushField(); continue; }
    if (ch === '\n') { pushRow(); continue; }
    if (ch === '\r') {
      if (text[i + 1] === '\n') i += 1;
      pushRow();
      continue;
    }
    cur += ch;
  }
  if (cur.length || row.length) pushRow();
  return records;
}

function readCsvText(text) {
  const clean = String(text || '').replace(/^\uFEFF/, '');
  if (!clean.trim()) return { headers: [], rows: [] };
  const records = parseCsv(clean);
  if (!records.length) return { headers: [], rows: [] };
  const headers = records[0];
  const rows = records.slice(1).map((cols) => {
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

function tryLocal(f) {
  const local = resolveLocalFile(f.name);
  if (!local) return null;
  try {
    return sourceFromLocal(f, local);
  } catch (e) {
    return missingSource(f, e.message || 'local_read_failed');
  }
}

/**
 * Source of truth = GitHub `alanranger/alan-shared-resources` `csv/` (tier 1).
 * Freshness = the file's latest commit date (auto-pushed ~every 10 min, only
 * when the export bytes change → content-driven, fail-stale never fail-fresh).
 *
 * Dropbox was removed on 2026-07-23 (Alan's decision): the previous path was
 * static-token-only and would expire in ~4h, and no Dropbox app will be created.
 *
 * MC_SCHEDULE_CSV_DIR is an explicit dev override (read that local copy first);
 * otherwise a resolvable local copy is used only as an offline fallback if the
 * GitHub fetch fails.
 */
async function loadOneSource(f) {
  if (process.env.MC_SCHEDULE_CSV_DIR) {
    const dev = tryLocal(f);
    if (dev?.ok) return dev;
  }
  try {
    return await fetchGithubCsv(f);
  } catch (e) {
    const offline = tryLocal(f);
    if (offline) return offline;
    return missingSource(f, e.message || 'github_fetch_failed');
  }
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

/**
 * Client sessions that need home Prep/Decompress (Decision 3), not travel:
 * Zoom/online 1-2-1 / mentoring, and in-person Private / Anytime Private 1-2-1s.
 */
function isOnlineClientHome(title) {
  const t = String(title || '').toLowerCase();
  const is121 = /1\s*[-–]?\s*2\s*[-–]?\s*1|\b121\b/.test(t);
  if (is121 && /zoom|online|tuition|mentoring/.test(t)) return true;
  if (/\bonline\b/.test(t) && is121) return true;
  if (/\bzoom\b/.test(t) && /(tuition|mentoring|1\s*[-–]?\s*2\s*[-–]?\s*1)/.test(t)) return true;
  // Acuity often titles mentoring without "1-2-1" (e.g. Monthly Mentoring Feedback - Zoom).
  if (/\bzoom\b/.test(t) && /\bmentoring\b/.test(t)) return true;
  // In-person private at home studio (e.g. "2hr 1-2-1 Anytime Private").
  if (is121 && /\bprivate\b/.test(t)) return true;
  return false;
}

function isHomeBased(ev, homePostcode) {
  if (isOnlineClientHome(ev?.title || ev?.summary || ev?.Event_Title)) return true;
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
  isOnlineClientHome,
  parseCsv,
  readCsvText,
};
