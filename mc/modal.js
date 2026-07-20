import { api } from './api.js';
import { store } from './store.js';
import { $, esc } from './util.js';

export function openNewTaskModal(onCreated) {
  const opts = store.projects.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  $('modalBox').innerHTML = `
    <h2 style="font-size:16px;font-weight:600;margin-bottom:8px">New task</h2>
    <label>Title</label><input id="ntTitle"/>
    <label>Project</label><select id="ntProject">${opts}</select>
    <label>Owner</label><select id="ntOwner"><option>alan</option><option>claude</option><option>cursor</option><option>external</option></select>
    <label>Priority</label><select id="ntPriority"><option>p0</option><option selected>p1</option><option>p2</option></select>
    <label>Impact</label><select id="ntImpact"><option>HIGH</option><option selected>MEDIUM</option><option>LOW</option></select>
    <label>Difficulty</label><select id="ntDifficulty"><option>LOW</option><option selected>MEDIUM</option><option>HIGH</option></select>
    <label>Due</label><input id="ntDue" type="date"/>
    <label>Recurrence (project task only)</label><input id="ntRec" placeholder="optional weekly:1 / monthly:1 — NOT for BAU habits"/>
    <p class="meta" style="margin:4px 0 8px">For <strong>BAU habits</strong> (Reclaim-style diary booking): cancel and use the <strong>Recurring</strong> tab → <strong>Add habit</strong>. Claude books Calendar <strong>28 days ahead</strong>.</p>
    <label>Next step</label><input id="ntNext"/>
    <label>Detail</label><textarea id="ntDetail" rows="3"></textarea>
    <div style="display:flex;gap:8px;margin-top:12px">
      <button type="button" id="ntSave">Create</button>
      <button type="button" id="ntCancel">Cancel</button>
    </div>`;
  $('modal').classList.add('open');
  $('ntCancel').onclick = () => $('modal').classList.remove('open');
  $('ntSave').onclick = async () => {
    await api('/api/mc/tasks', {
      method: 'POST',
      body: {
        title: $('ntTitle').value.trim(),
        project_id: $('ntProject').value,
        owner: $('ntOwner').value,
        priority: $('ntPriority').value,
        impact: $('ntImpact').value,
        difficulty: $('ntDifficulty').value,
        due_date: $('ntDue').value || null,
        recurrence: $('ntRec').value.trim() || null,
        next_step: $('ntNext').value.trim() || null,
        detail_md: $('ntDetail').value.trim() || null,
      },
    });
    $('modal').classList.remove('open');
    await onCreated();
  };
}
