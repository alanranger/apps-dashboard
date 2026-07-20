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
};

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
