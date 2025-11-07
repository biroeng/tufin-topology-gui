const $ = (s) => document.querySelector(s);
const toast = (m) => { const t = $('.toast'); if (!t) return; t.textContent = m; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'), 1400); };
function esc(s){ return String(s ?? "").replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'","&#039;"); }

(function initTheme() {
  const btn = $('#themeToggle');
  if (!btn) return;
  const saved = localStorage.getItem('theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);
  btn.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme') || 'light';
    const next = cur === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
  });
})();

// Tabs
const tabRules = $('#tabRules');
const tabObjects = $('#tabObjects');
const viewRules = $('#viewRules');
const viewObjects = $('#viewObjects');
function activate(tab) {
  const isRules = tab === 'rules';
  tabRules.classList.toggle('active', isRules);
  tabObjects.classList.toggle('active', !isRules);
  viewRules.classList.toggle('hidden', !isRules);
  viewObjects.classList.toggle('hidden', isRules);
  tabRules.setAttribute('aria-selected', String(isRules));
  tabObjects.setAttribute('aria-selected', String(!isRules));
}
tabRules.addEventListener('click', () => activate('rules'));
tabObjects.addEventListener('click', () => activate('objects'));

// ---------- NAT RULES ----------
const rulesForm = $('#rulesForm');
const rulesDevice = $('#rulesDevice');
const rulesContext = $('#rulesContext');
const inputIf = $('#inputIf');
const outputIf = $('#outputIf');
const natStage = $('#natStage');
const natType = $('#natType');
const rulesHint = $('#rulesHint');
const rulesBody = $('#rulesBody');
const rulesRaw = $('#rulesRaw');
const rulesCopyJson = $('#rulesCopyJson');
const rulesSearch = $('#rulesSearch');

let rulesRows = [];

function normalizeRules(apiJson) {
  // Try common shapes; fallback to array
  const list = apiJson?.rules || apiJson?.items || apiJson?.data || apiJson?.nat_rules || apiJson || [];
  const arr = Array.isArray(list) ? list : (Array.isArray(list?.bindings) ? list.bindings : []);
  return (arr || []).map((r, i) => {
    // Heuristic extraction of important fields
    const id = r.id || r.rule_id || r.uid || r.name || `#${i+1}`;
    const name = r.name || r.rule_name || r.display_name || '';
    const oSrc = r.original_source || r.src || r.original?.source || r.source || '';
    const oDst = r.original_destination || r.dst || r.original?.destination || r.destination || '';
    const oSvc = r.original_service || r.svc || r.original?.service || r.service || '';

    const tSrc = r.translated_source || r.xlate_source || r.translated?.source || '';
    const tDst = r.translated_destination || r.xlate_destination || r.translated?.destination || '';
    const tSvc = r.translated_service || r.xlate_service || r.translated?.service || '';

    const iIn  = r.input_interface || r.ingress_interface || '';
    const iOut = r.output_interface || r.egress_interface || '';
    const stage = r.nat_stage || r.stage || '';
    const type  = r.nat_type || r.type || '';

    return {
      idx: i + 1,
      id,
      name,
      original: [oSrc, oDst, oSvc].filter(Boolean).join(' | '),
      translated: [tSrc, tDst, tSvc].filter(Boolean).join(' | '),
      meta: [iIn && `in:${iIn}`, iOut && `out:${iOut}`, stage && `stage:${stage}`, type && `type:${type}`]
        .filter(Boolean).join(' • '),
      _raw: r
    };
  });
}

function renderRules(rows) {
  if (!rows.length) {
    rulesBody.innerHTML = `<tr><td colspan="5" class="muted">No results.</td></tr>`;
    return;
  }
  rulesBody.innerHTML = rows.map(r => `
    <tr>
      <td>${r.idx}</td>
      <td>${esc(r.name || r.id)}</td>
      <td>${esc(r.original)}</td>
      <td>${esc(r.translated)}</td>
      <td>${esc(r.meta)}</td>
    </tr>
  `).join('');
}

function filterRules() {
  const q = (rulesSearch.value || '').toLowerCase();
  if (!q) return renderRules(rulesRows);
  const filtered = rulesRows.filter(r =>
    [r.name, r.id, r.original, r.translated, r.meta]
      .filter(Boolean).join(' ').toLowerCase().includes(q)
  );
  renderRules(filtered);
}

rulesForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  rulesHint.textContent = '';
  if (!rulesDevice.value.trim()) { rulesHint.textContent = 'Device ID is required.'; return; }

  rulesBody.innerHTML = `<tr><td colspan="5" class="muted">Loading…</td></tr>`;
  rulesRaw.textContent = 'Loading…';

  const qs = new URLSearchParams();
  if (rulesContext.value.trim()) qs.set('context', rulesContext.value.trim());
  if (inputIf.value.trim()) qs.set('input_interface', inputIf.value.trim());
  if (outputIf.value.trim()) qs.set('output_interface', outputIf.value.trim());
  if (natStage.value.trim()) qs.set('nat_stage', natStage.value.trim());
  if (natType.value.trim()) qs.set('nat_type', natType.value.trim());

  try {
    const url = `/api/devices/${encodeURIComponent(rulesDevice.value.trim())}/nat_rules/bindings` + (qs.toString() ? `?${qs.toString()}` : '');
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(typeof data?.details === 'string' ? data.details : JSON.stringify(data.details));
    rulesRows = normalizeRules(data);
    renderRules(rulesRows);
    rulesRaw.textContent = JSON.stringify(data, null, 2);
    toast(`Loaded ${rulesRows.length} NAT rule${rulesRows.length===1?'':'s'}`);
  } catch (err) {
    rulesBody.innerHTML = `<tr><td colspan="5" class="muted">Error loading NAT rules.</td></tr>`;
    rulesRaw.textContent = `Error: ${err.message}`;
  }
});
$('#rulesClear').addEventListener('click', () => {
  rulesDevice.value = rulesContext.value = inputIf.value = outputIf.value = '';
  natStage.value = ''; natType.value = '';
  rulesRows = [];
  rulesBody.innerHTML = `<tr><td colspan="5" class="muted">No results yet.</td></tr>`;
  rulesRaw.textContent = 'No results yet.';
});
rulesCopyJson?.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(rulesRaw.textContent || ''); toast('JSON copied'); } catch { toast('Copy failed'); }
});
rulesSearch?.addEventListener('input', filterRules);

// ---------- NAT OBJECTS ----------
const objectsForm = $('#objectsForm');
const objDevice = $('#objDevice');
const objContext = $('#objContext');
const objStart = $('#objStart');
const objCount = $('#objCount');
const objTotal = $('#objTotal');
const objectsHint = $('#objectsHint');
const objectsBody = $('#objectsBody');
const objectsRaw = $('#objectsRaw');
const objectsCopyJson = $('#objectsCopyJson');
const objectsSearch = $('#objectsSearch');

let objectsRows = [];

function normalizeObjects(apiJson) {
  // Expected: { network_objects: { network_object: [...], count, total } } OR arrays
  const root = apiJson?.network_objects || apiJson;
  const list = root?.network_object || root?.items || root?.data || root || [];
  const arr = Array.isArray(list) ? list : [];

  return arr.map((o, i) => {
    const name = o.name || o.display_name || o.uid || `#${i+1}`;
    const type = o.type || o.object_type || '';
    // Try common fields for address / members
    const address = o.address || o.ip || o.cidr || o.subnet || '';
    let members = '';
    if (Array.isArray(o.members)) {
      members = o.members.map(m => m.name || m.address || m.ip || m.cidr || m.uid).filter(Boolean).join(', ');
    } else if (o.member) {
      members = Array.isArray(o.member) ? o.member.join(', ') : String(o.member);
    }
    const addrOrMembers = [address, members].filter(Boolean).join(' | ');
    return { idx: i + 1, name, type, addrOrMembers, _raw: o };
  });
}

function renderObjects(rows) {
  if (!rows.length) {
    objectsBody.innerHTML = `<tr><td colspan="4" class="muted">No results.</td></tr>`;
    return;
  }
  objectsBody.innerHTML = rows.map(r => `
    <tr>
      <td>${r.idx}</td>
      <td>${esc(r.name)}</td>
      <td>${esc(r.type)}</td>
      <td>${esc(r.addrOrMembers)}</td>
    </tr>
  `).join('');
}

function filterObjects() {
  const q = (objectsSearch.value || '').toLowerCase();
  if (!q) return renderObjects(objectsRows);
  const filtered = objectsRows.filter(r =>
    [r.name, r.type, r.addrOrMembers].filter(Boolean).join(' ').toLowerCase().includes(q)
  );
  renderObjects(filtered);
}

objectsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  objectsHint.textContent = '';
  if (!objDevice.value.trim()) { objectsHint.textContent = 'Device ID is required.'; return; }

  objectsBody.innerHTML = `<tr><td colspan="4" class="muted">Loading…</td></tr>`;
  objectsRaw.textContent = 'Loading…';

  const qs = new URLSearchParams();
  if (objContext.value.trim()) qs.set('context', objContext.value.trim());
  if (objStart.value.trim()) qs.set('start', objStart.value.trim());
  if (objCount.value.trim()) qs.set('count', objCount.value.trim());
  if (objTotal.value) qs.set('get_total', objTotal.value);

  try {
    const url = `/api/devices/${encodeURIComponent(objDevice.value.trim())}/nat_objects` + (qs.toString() ? `?${qs.toString()}` : '');
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(typeof data?.details === 'string' ? data.details : JSON.stringify(data.details));
    objectsRows = normalizeObjects(data);
    renderObjects(objectsRows);
    objectsRaw.textContent = JSON.stringify(data, null, 2);
    toast(`Loaded ${objectsRows.length} NAT object${objectsRows.length===1?'':'s'}`);
  } catch (err) {
    objectsBody.innerHTML = `<tr><td colspan="4" class="muted">Error loading NAT objects.</td></tr>`;
    objectsRaw.textContent = `Error: ${err.message}`;
  }
});
$('#objectsClear').addEventListener('click', () => {
  objDevice.value = objContext.value = objStart.value = objCount.value = '';
  objTotal.value = '';
  objectsRows = [];
  objectsBody.innerHTML = `<tr><td colspan="4" class="muted">No results yet.</td></tr>`;
  objectsRaw.textContent = 'No results yet.';
});
objectsCopyJson?.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(objectsRaw.textContent || ''); toast('JSON copied'); } catch { toast('Copy failed'); }
});
objectsSearch?.addEventListener('input', filterObjects);

// Health banner (SSE)
(function(){
  const banner = document.getElementById('tufinHealthBanner');
  const msg = document.getElementById('tufinHealthMsg');
  function setBanner(h) { banner.style.display = (h.status === 'DOWN') ? 'block' : 'none'; msg.textContent = h.lastError ? `(${h.lastError.message})` : ''; }
  try { const es = new EventSource('/api/health/stream'); es.onmessage = (e) => setBanner(JSON.parse(e.data)); } catch {}
})();
