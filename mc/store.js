/** v2: exec tiles + priority matrix open by default (Alan). Old v1 collapsed prefs ignored. */
function readUiPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem('mc-ui-prefs') || '{}');
    if (p.v !== 2) {
      return { v: 2, execExpanded: true, matrixExpanded: true };
    }
    return {
      v: 2,
      execExpanded: p.execExpanded !== false,
      matrixExpanded: p.matrixExpanded !== false,
    };
  } catch {
    return { v: 2, execExpanded: true, matrixExpanded: true };
  }
}

export const store = {
  role: null,
  projects: [],
  tasks: [],
  checklist: [],
  comments: [],
  log: [],
  activeProjectId: null,
  openTaskId: null,
  /** @type {{ impact: string, diff: string } | null} */
  matrixFilter: null,
  matrixSort: { column: 'due_date', direction: 'asc' },
  /** Exec summary filters — AND together; each dim toggles independently */
  execFilter: { status: null, priority: null, projectId: null, owner: null },
  uiPrefs: {
    execExpanded: readUiPrefs().execExpanded,
    matrixExpanded: readUiPrefs().matrixExpanded,
  },
};

export function setUiPref(key, val) {
  store.uiPrefs[key] = val;
  const p = readUiPrefs();
  p.v = 2;
  p[key] = val;
  localStorage.setItem('mc-ui-prefs', JSON.stringify(p));
}

export function applyBootstrap(data) {
  store.role = data.role;
  store.projects = data.projects || [];
  store.tasks = data.tasks || [];
  store.checklist = data.checklist || [];
  store.comments = data.comments || [];
  store.log = data.log || [];
  if (!store.activeProjectId) store.activeProjectId = store.projects[0]?.id || null;
}

export function projectById(id) {
  return store.projects.find((p) => p.id === id);
}

export function taskById(id) {
  return store.tasks.find((t) => t.id === id);
}

export function taskByMc(n) {
  return store.tasks.find((t) => Number(t.display_id) === Number(n));
}

export function commentsFor(taskId) {
  return store.comments
    .filter((c) => c.task_id === taskId)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

export function logFor(taskId) {
  return store.log
    .filter((l) => l.task_id === taskId)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

export function checksFor(taskId) {
  return store.checklist
    .filter((c) => c.task_id === taskId)
    .sort((a, b) => a.sort - b.sort);
}
