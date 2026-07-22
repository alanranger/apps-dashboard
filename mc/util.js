export const STATES = ['todo', 'in_progress', 'waiting', 'done_claimed', 'done', 'superseded', 'wont_do', 'verified'];

export const STATE_LABEL = {
  todo: 'To do',
  in_progress: 'In progress',
  waiting: 'Waiting',
  done_claimed: 'Done-claimed',
  done: 'Done',
  superseded: 'Superseded',
  wont_do: "Won't do",
  verified: 'Verified',
};

export const $ = (id) => document.getElementById(id);

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d + (String(d).length === 10 ? 'T12:00:00' : ''));
  return dt.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

export function fmtTime(t) {
  if (!t) return '—';
  const s = String(t).slice(0, 5);
  const [h, m] = s.split(':').map(Number);
  if (Number.isNaN(h)) return s;
  const dt = new Date();
  dt.setHours(h, m || 0, 0, 0);
  return dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export function empty(icon, text, actionHtml = '') {
  return `<div class="empty"><i class="ti ${icon}"></i><p>${esc(text)}</p>${actionHtml}</div>`;
}

export function handoffRef(label, file) {
  if (!file) return `${label}: —`;
  if (/^https?:\/\//i.test(file)) {
    return `${label}: <a href="${esc(file)}" target="_blank" rel="noopener">${esc(file)}</a>`;
  }
  return `${label}: <a href="#" class="handoff-ref" data-copy="${esc(file)}" title="Google Drive handoff file">${esc(file)}</a>`;
}
