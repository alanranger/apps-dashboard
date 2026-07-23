export const PRIORITY_OPTIONS = [
  { v: 'p0', label: 'p0 — money / urgent' },
  { v: 'p1', label: 'p1 — important' },
  { v: 'p2', label: 'p2 — normal later' },
  { v: 'p3', label: 'p3 — low' },
  { v: 'p4', label: 'p4 — backlog' },
  { v: 'p5', label: 'p5 — someday' },
];

export function prioritySelectOptions(selected) {
  return PRIORITY_OPTIONS.map((o) =>
    `<option value="${o.v}" ${selected === o.v ? 'selected' : ''}>${o.label}</option>`,
  ).join('');
}

export const PRI_RANK = Object.fromEntries(PRIORITY_OPTIONS.map((o, i) => [o.v, i]));
