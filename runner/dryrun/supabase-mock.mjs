/**
 * Recording stand-in for @supabase/supabase-js used by the dry-run ingest.
 * Reads come from a production snapshot (in memory); writes are applied to the in-memory copy
 * and recorded. Nothing is ever sent to a real database.
 */
import fs from 'node:fs';

const state = { tables: {}, writes: [], nextId: 10_000_000 };
globalThis.__DRYRUN__ = state;

export function resetDryRun(snapshotFile) {
  const snap = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
  state.tables = Object.fromEntries(Object.entries(snap).map(([k, v]) => [k, (v || []).map((r) => ({ ...r }))]));
  state.writes = [];
}

const tableOf = (name) => { if (!state.tables[name]) state.tables[name] = []; return state.tables[name]; };

function matches(row, filters) {
  return filters.every(([op, col, val]) => {
    if (op === 'eq') return row[col] === val;
    if (op === 'in') return val.includes(row[col]);
    if (op === 'is') return val === null ? row[col] == null : row[col] === val;
    if (op === 'notnull') return row[col] != null;
    return true;
  });
}

class Query {
  constructor(name) { this.name = name; this.filters = []; this.op = 'select'; this.payload = null; this.max = Infinity; this.returning = false; }
  select() { if (this.op !== 'select') this.returning = true; return this; }
  insert(rows) { this.op = 'insert'; this.payload = [].concat(rows); return this; }
  upsert(rows, opts) { this.op = 'upsert'; this.payload = [].concat(rows); this.conflict = opts?.onConflict; return this; }
  update(patch) { this.op = 'update'; this.payload = patch; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(c, v) { this.filters.push(['eq', c, v]); return this; }
  in(c, v) { this.filters.push(['in', c, v]); return this; }
  is(c, v) { this.filters.push(['is', c, v]); return this; }
  not(c, op, v) { if (op === 'is' && v === null) this.filters.push(['notnull', c]); return this; }
  neq(c, v) { this.filters.push(['neq', c, v]); return this; }
  limit(n) { this.max = n; return this; }
  range(a, b) { this.from_ = a; this.max = b - a + 1; return this; }
  order() { return this; }
  single() { return this; }
  then(resolve, reject) { try { resolve(this.run()); } catch (e) { reject(e); } }

  run() {
    const rows = tableOf(this.name);
    if (this.op === 'select') {
      const hit = rows.filter((r) => matches(r, this.filters));
      return { data: hit.slice(this.from_ || 0, (this.from_ || 0) + this.max), error: null };
    }
    if (this.op === 'insert' || this.op === 'upsert') {
      const added = this.payload.map((r) => ({ id: state.nextId++, ...r }));
      rows.push(...added);
      state.writes.push({ table: this.name, op: this.op, rows: this.payload });
      return { data: added, error: null };
    }
    const hit = rows.filter((r) => matches(r, this.filters));
    if (this.op === 'update') hit.forEach((r) => Object.assign(r, this.payload));
    if (this.op === 'delete') state.tables[this.name] = rows.filter((r) => !hit.includes(r));
    state.writes.push({ table: this.name, op: this.op, patch: this.payload, filters: this.filters, affected: hit.map((r) => ({ ...r })) });
    return { data: this.returning ? hit : null, error: null };
  }
}

export function createClient() {
  return { from: (name) => new Query(name), rpc: async (name, args) => { state.writes.push({ op: 'rpc', table: name, rows: [args || {}], affected: [] }); return { data: null, error: null }; } };
}
