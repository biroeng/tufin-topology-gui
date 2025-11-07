const $ = (s) => document.querySelector(s);
const toast = (m) => { const t = $('#toast'); t.textContent = m; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'), 1400); };

const themeToggle = $('#themeToggle');
(function initTheme() {
  const saved = localStorage.getItem('theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);
  themeToggle.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme') || 'light';
    const next = cur === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
  });
})();

const mapForm = $('#mapForm');
const cidr = $('#cidr');
const appName = $('#appName');
const owner = $('#owner');
const env = $('#env');
const notes = $('#notes');
const formHint = $('#formHint');

const search = $('#search');
const mapBody = $('#mapBody');
const countInfo = $('#countInfo');

const exportBtn = $('#exportBtn');
const importFile = $('#importFile');

function validNet(s){ return /^(\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?$/.test(String(s).trim()); }

async function listMappings() { const r = await fetch('/api/mappings'); return r.json(); }
async function createMapping(payload) { const r = await fetch('/api/mappings', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) }); if(!r.ok) throw new Error('Create failed'); return r.json(); }
async function updateMapping(id, payload) { const r = await fetch(`/api/mappings/${id}`, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) }); if(!r.ok) throw new Error('Update failed'); return r.json(); }
async function deleteMapping(id) { const r = await fetch(`/api/mappings/${id}`, { method:'DELETE' }); if(!r.ok) throw new Error('Delete failed'); return r.json(); }

let all = [];
let filtered = [];

function esc(s){ return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'","&#039;"); }

function renderTable(items) {
  if (!Array.isArray(items) || !items.length) {
    mapBody.innerHTML = `<tr><td colspan="3" class="muted">No mappings yet.</td></tr>`;
    countInfo.textContent = '0 items';
    return;
  }
  countInfo.textContent = `${items.length} item${items.length>1?'s':''}`;
  mapBody.innerHTML = items.map(it => `
    <tr data-id="${it.id}">
      <td><span class="pill">${esc(it.cidr)}</span></td>
      <td>
        ${Array.isArray(it.applications) && it.applications.length ? it.applications.map(a => `
          <div style="margin-bottom:6px;">
            <span class="pill">App: ${esc(a.name)}</span>
            ${a.owner ? `<span class="pill">Owner: ${esc(a.owner)}</span>`:''}
            ${a.env ? `<span class="pill">Env: ${esc(a.env)}</span>`:''}
            ${a.notes ? `<span class="pill" title="${esc(a.notes)}">Notes</span>`:''}
          </div>
        `).join('') : `<span class="muted">—</span>`}
        <div class="link" data-edit="${it.id}">Edit</div>
      </td>
      <td>
        <button class="btn" data-addapp="${it.id}">+ App</button>
        <button class="btn ghost" data-del="${it.id}">Delete</button>
      </td>
    </tr>
  `).join('');

  // wire actions
  mapBody.querySelectorAll('[data-del]').forEach(btn => btn.addEventListener('click', async () => {
    await deleteMapping(btn.getAttribute('data-del'));
    toast('Deleted'); await refresh();
  }));
  mapBody.querySelectorAll('[data-addapp]').forEach(btn => btn.addEventListener('click', async () => {
    const id = btn.getAttribute('data-addapp');
    const m = all.find(x => x.id === id); if (!m) return;
    const name = prompt('Application name:'); if (!name) return;
    const owner = prompt('Owner (optional):') || '';
    const env = prompt('Environment (optional):') || '';
    const notes = prompt('Notes (optional):') || '';
    const applications = [...(m.applications||[]), { name, owner, env, notes }];
    await updateMapping(id, { applications });
    toast('Added'); await refresh();
  }));
  mapBody.querySelectorAll('[data-edit]').forEach(a => a.addEventListener('click', async () => {
    const id = a.getAttribute('data-edit');
    const m = all.find(x => x.id === id); if (!m) return;
    const newCidr = prompt('Edit Network (CIDR or IP):', m.cidr) || m.cidr;
    if (!validNet(newCidr)) return toast('Invalid network');
    const str = prompt('Edit applications as JSON array (name, owner, env, notes):', JSON.stringify(m.applications || [], null, 2));
    let apps = m.applications || [];
    try { if (str) apps = JSON.parse(str); } catch { return toast('Invalid JSON'); }
    await updateMapping(id, { cidr: newCidr, applications: apps });
    toast('Updated'); await refresh();
  }));
}

async function refresh() {
  const data = await listMappings();
  all = data.items || [];
  applyFilter();
}
function applyFilter() {
  const q = (search.value || '').toLowerCase();
  filtered = all.filter(it => {
    const inCidr = it.cidr.toLowerCase().includes(q);
    const inApps = (it.applications||[]).some(a =>
      [a.name, a.owner, a.env, a.notes].filter(Boolean).join(' ').toLowerCase().includes(q)
    );
    return !q || inCidr || inApps;
  });
  renderTable(filtered);
}

search.addEventListener('input', applyFilter);

mapForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  formHint.textContent = '';
  if (!validNet(cidr.value)) { formHint.textContent = 'Enter a valid IPv4 or IPv4/CIDR.'; return; }
  if (!appName.value.trim()) { formHint.textContent = 'Application name is required.'; return; }
  const payload = { cidr: cidr.value.trim(), applications: [{ name: appName.value.trim(), owner: owner.value.trim(), env: env.value.trim(), notes: notes.value.trim() }] };
  try {
    await createMapping(payload);
    toast('Mapping added');
    cidr.value = ''; appName.value=''; owner.value=''; env.value=''; notes.value='';
    await refresh();
  } catch { toast('Failed to add mapping'); }
});

// Export/Import
exportBtn.addEventListener('click', async () => {
  const data = await listMappings();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `network_mappings_${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});
importFile.addEventListener('change', async (e) => {
  const f = e.target.files?.[0]; if (!f) return;
  try {
    const txt = await f.text();
    const json = JSON.parse(txt);
    const items = Array.isArray(json.items) ? json.items : [];
    const existing = await listMappings();
    for (const x of (existing.items||[])) await deleteMapping(x.id);
    for (const it of items) await createMapping({ cidr: it.cidr, applications: it.applications || [] });
    toast('Imported'); await refresh();
  } catch { toast('Import failed'); } finally { e.target.value = ''; }
});

// Boot
refresh();
