const q = (sel) => document.querySelector(sel);
const toastEl = q('#toast');

const form = q('#queryForm');
const srcEl = q('#source');
const dstEl = q('#destination');
const svcEl = q('#service');
const hintEl = q('#formHint');

const img = q('#topologyImage');
const overlay = q('#imageOverlay');
const imageWrapper = q('#imageWrapper');

const tb = q('#devicesTableBody');
const jsonPre = q('#result');

const zoomInBtn = q('#zoomIn');
const zoomOutBtn = q('#zoomOut');
const resetZoomBtn = q('#resetZoom');
const downloadBtn = q('#downloadImg');
const copyBtn = q('#copyJson');
const swapBtn = q('#swapBtn');
const clearBtn = q('#clearBtn');
const darkToggle = q('#darkToggle');

function showToast(msg) { toastEl.textContent = msg; toastEl.classList.add('show'); setTimeout(() => toastEl.classList.remove('show'), 1600); }

// Active menu state
(function setActive() {
  const here = location.pathname || "/";
  document.querySelectorAll('.main-nav .nav-link[data-route]').forEach(a => {
    a.classList.toggle('active', a.getAttribute('data-route') === here);
  });
})();

// Theme
(function initTheme() {
  const saved = localStorage.getItem('theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);
  darkToggle.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme') || 'light';
    const next = cur === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
  });
})();

// Zoom/Pan
let scale = 1, isPanning = false, startX = 0, startY = 0, offsetX = 0, offsetY = 0;
function applyTransform() { img.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`; }
zoomInBtn.addEventListener('click', () => { scale = Math.min(scale + 0.15, 4); applyTransform(); });
zoomOutBtn.addEventListener('click', () => { scale = Math.max(scale - 0.15, 0.4); applyTransform(); });
resetZoomBtn.addEventListener('click', () => { scale = 1; offsetX = 0; offsetY = 0; applyTransform(); });
imageWrapper.addEventListener('wheel', (e) => { e.preventDefault(); const d = e.deltaY < 0 ? 0.1 : -0.1; scale = Math.min(4, Math.max(0.4, scale + d)); applyTransform(); }, { passive: false });
img.addEventListener('mousedown', (e) => { isPanning = true; startX = e.clientX - offsetX; startY = e.clientY - offsetY; img.style.cursor = 'grabbing'; });
window.addEventListener('mouseup', () => { isPanning = false; img.style.cursor = 'grab'; });
window.addEventListener('mousemove', (e) => { if (!isPanning) return; offsetX = e.clientX - startX; offsetY = e.clientY - startY; applyTransform(); });

// Helpers
swapBtn.addEventListener('click', () => { const t = srcEl.value; srcEl.value = dstEl.value; dstEl.value = t; });
clearBtn.addEventListener('click', () => {
  srcEl.value = ''; dstEl.value = ''; svcEl.value = '';
  jsonPre.textContent = 'No results yet.';
  tb.innerHTML = `<tr><td colspan="7" class="muted">Run a query to see devices.</td></tr>`;
  overlay.textContent = 'No image yet'; img.style.display = 'none';
});

// Download/Copy
downloadBtn.addEventListener('click', () => {
  if (!img.src || img.style.display === 'none') return showToast('No image to download');
  const a = document.createElement('a');
  a.href = img.src; a.download = `topology_path_${Date.now()}.png`; a.click();
});
copyBtn.addEventListener('click', async () => { try { await navigator.clipboard.writeText(jsonPre.textContent || ''); showToast('JSON copied'); } catch { showToast('Copy failed'); } });

// Validation
function validInput() { if (!srcEl.value.trim() || !dstEl.value.trim()) { hintEl.textContent = 'Source and Destination are required.'; return false; } hintEl.textContent = ''; return true; }

// ---------- Approved Networks (server-backed) ----------
const approvedInput = document.getElementById('approvedInput');
const approvedForm = document.getElementById('approvedForm');
const approvedListEl = document.getElementById('approvedList');
const clearApprovedBtn = document.getElementById('clearApproved');

async function fetchApproved() { const r = await fetch('/api/approved-networks'); return r.json(); }
async function fetchTaxonomy() { const r = await fetch('/api/tag-taxonomy'); return r.json(); }
async function addApproved(cidr, tags) { const r = await fetch('/api/approved-networks', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ cidr, tags }) }); if(!r.ok) throw new Error('Failed to add'); return r.json(); }
async function updateApproved(id, payload) { const r = await fetch(`/api/approved-networks/${id}`, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) }); if(!r.ok) throw new Error('Failed to update'); return r.json(); }
async function deleteApproved(id) { const r = await fetch(`/api/approved-networks/${id}` ,{ method:'DELETE' }); if(!r.ok) throw new Error('Failed to delete'); return r.json(); }
async function tagByIp(ip, tags) { const r = await fetch('/api/approved-networks/tag-by-ip', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ ip, tags }) }); if(!r.ok) throw new Error('Failed to tag by IP'); return r.json(); }

async function renderApprovedChips() {
  const data = await fetchApproved();
  const items = data.items || [];
  if (!items.length) { approvedListEl.innerHTML = `<li class="muted">No approved networks yet.</li>`; return; }
  approvedListEl.innerHTML = items.map(n => `
    <li class="approved-chip">
      <span><strong>${esc(n.cidr)}</strong></span>
      ${Array.isArray(n.tags) && n.tags.length ? `<small>${n.tags.map(esc).join(' • ')}</small>` : `<small class="muted">no tags</small>`}
      <span class="chip-actions">
        <button class="link-btn" data-edit="${n.id}">Edit</button>
        <button class="link-btn" data-del="${n.id}">Delete</button>
      </span>
    </li>
  `).join('');
  approvedListEl.querySelectorAll('[data-del]').forEach(btn => btn.addEventListener('click', async () => { await deleteApproved(btn.getAttribute('data-del')); showToast('Deleted'); renderApprovedChips(); }));
  approvedListEl.querySelectorAll('[data-edit]').forEach(btn => btn.addEventListener('click', async () => {
    const id = btn.getAttribute('data-edit');
    const store = await fetchApproved();
    const entry = (store.items || []).find(x => x.id === id);
    if (!entry) return;
    openTagModal(entry.cidr, entry.tags || [], async (cidr, tags) => { await updateApproved(id, { cidr, tags }); showToast('Updated'); renderApprovedChips(); if (jsonPre.textContent && jsonPre.textContent !== 'No results yet.') runPathQuery(); });
  }));
}
approvedForm?.addEventListener('submit', async (e) => { e.preventDefault(); const cidr = approvedInput.value.trim(); if (!cidr) return; try { await addApproved(cidr, []); showToast('Added'); approvedInput.value = ''; renderApprovedChips(); } catch (e2) { showToast(e2.message || 'Failed to add'); } });
clearApprovedBtn?.addEventListener('click', async () => {
  const data = await fetchApproved();
  for (const it of (data.items || [])) { await deleteApproved(it.id); }
  showToast('Cleared'); renderApprovedChips();
});

// ---------- Tagging modal ----------
const tagModal = document.getElementById('tagModal');
const tagForm = document.getElementById('tagForm');
const tagCidr = document.getElementById('tagCidr');
const tagEnv = document.getElementById('tagEnv');
const tagBU = document.getElementById('tagBU');
const tagData = document.getElementById('tagData');
const tagZone = document.getElementById('tagZone');
const tagApp = document.getElementById('tagApp');
const tagCompliance = document.getElementById('tagCompliance');
document.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', closeTagModal));

let modalResolver = null;
function openTagModal(prefillCidr = '', prefillTags = [], onSave) {
  tagCidr.value = prefillCidr || '';
  [tagEnv, tagBU, tagData, tagZone, tagApp, tagCompliance].forEach(sel => { sel.value = ''; });
  prefillTags.forEach(t => {
    const [k, v] = String(t).split(':');
    const map = { Env: tagEnv, BU: tagBU, DataClassification: tagData, Zone: tagZone, App: tagApp, Service: tagApp, Compliance: tagCompliance };
    const target = map[k] || null;
    if (target) {
      const opt = Array.from(target.options).find(o => o.value === v);
      if (opt) target.value = v;
    }
  });
  tagModal.classList.add('show'); tagModal.setAttribute('aria-hidden', 'false'); modalResolver = onSave || null;
}
function closeTagModal() { tagModal.classList.remove('show'); tagModal.setAttribute('aria-hidden', 'true'); modalResolver = null; }
async function seedTaxonomy() {
  const tax = await fetchTaxonomy();
  const fill = (sel, arr) => { sel.innerHTML = `<option value="">—</option>` + (arr||[]).map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join(''); };
  fill(tagEnv, tax.environment); fill(tagBU, tax.businessUnit); fill(tagData, tax.dataSensitivity);
  fill(tagZone, tax.trustZone); fill(tagApp, tax.application); fill(tagCompliance, tax.compliance);
}
seedTaxonomy();

tagForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const cidr = tagCidr.value.trim();
  const tags = [];
  if (tagEnv.value) tags.push(`Env:${tagEnv.value}`);
  if (tagBU.value) tags.push(`BU:${tagBU.value}`);
  if (tagData.value) tags.push(`DataClassification:${tagData.value}`);
  if (tagZone.value) tags.push(`Zone:${tagZone.value}`);
  if (tagApp.value) tags.push(`App:${tagApp.value}`);
  if (tagCompliance.value) tags.push(`Compliance:${tagCompliance.value}`);

  try {
    if (/^(\d+\.){3}\d+$/.test(cidr)) { await tagByIp(cidr, tags); }
    else { await addApproved(cidr, tags); }
    showToast('Saved'); closeTagModal(); renderApprovedChips(); if (jsonPre.textContent && jsonPre.textContent !== 'No results yet.') runPathQuery();
  } catch (err) { showToast(err.message || 'Failed to save tags'); }
});

// ---------- Query Topology ----------
async function runPathQuery() {
  if (!validInput()) return;
  jsonPre.textContent = 'Loading…';
  overlay.textContent = 'Loading image…';
  img.style.display = 'none';
  scale = 1; offsetX = 0; offsetY = 0; applyTransform();

  const source = srcEl.value.trim();
  const destination = dstEl.value.trim();
  const service = svcEl.value.trim();

  try {
    const url = `/api/topology-image?source=${encodeURIComponent(source)}&destination=${encodeURIComponent(destination)}&service=${encodeURIComponent(service)}`;
    img.src = url;
    img.onload = () => { overlay.textContent = ''; img.style.display = 'block'; };
    img.onerror = () => { overlay.textContent = 'Image not available for this query'; img.style.display = 'none'; };

    const res = await fetch('/api/topology-path-with-devices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, destination, service })
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload?.details || 'API error');
    const { data, devices } = payload;

    jsonPre.textContent = JSON.stringify(data, null, 2);
    renderDevices(devices);
    showToast(`Found ${devices?.length || 0} device(s)`);
  } catch (err) {
    jsonPre.textContent = `Error: ${err.message}`;
    overlay.textContent = 'Image not available';
    renderDevices([]);
  }
}
form.addEventListener('submit', async (e) => { e.preventDefault(); runPathQuery(); });

function renderDevices(devs) {
  if (!Array.isArray(devs) || !devs.length) {
    tb.innerHTML = `<tr><td colspan="7" class="muted">No devices found in response. Check JSON section.</td></tr>`;
    return;
  }
  tb.innerHTML = devs.map((d, idx) => {
    const approvedBadge = d.approved ? `<span class="badge-approved">Approved</span>` : '';
    const tagBadges = (d.tags || []).map(t => `<span class="approved-chip" style="padding:2px 8px;border-radius:999px;border-width:1px;">${esc(t)}</span>`).join(' ');
    const actionBtn = `<button class="link-btn" data-tag-row="${idx}" data-ip="${esc(d.ip || '')}">Tag Network</button>`;
    return `
      <tr>
        <td>${d.hop ?? ''}</td>
        <td>${esc(d.device ?? '')} ${approvedBadge}</td>
        <td>${esc(d.type ?? '')}</td>
        <td>${esc(d.iface ?? '')}</td>
        <td>${esc(d.notes ?? '')}</td>
        <td>${tagBadges || '<span class="muted">—</span>'}</td>
        <td>${actionBtn}</td>
      </tr>
    `;
  }).join('');
  tb.querySelectorAll('[data-tag-row]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const ip = btn.getAttribute('data-ip');
      const prefill = ip ? `${ip}/32` : '';
      openTagModal(prefill, [], () => {});
    });
  });
}

function esc(s) { return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'","&#039;"); }

// Boot
renderApprovedChips();
