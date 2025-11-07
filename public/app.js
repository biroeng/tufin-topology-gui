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

let scale = 1;
let isPanning = false;
let startX = 0, startY = 0;
let offsetX = 0, offsetY = 0;

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  setTimeout(() => toastEl.classList.remove('show'), 1600);
}

// theme
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

// image zoom/pan
function applyTransform() {
  img.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
}
zoomInBtn.addEventListener('click', () => { scale = Math.min(scale + 0.15, 4); applyTransform(); });
zoomOutBtn.addEventListener('click', () => { scale = Math.max(scale - 0.15, 0.4); applyTransform(); });
resetZoomBtn.addEventListener('click', () => { scale = 1; offsetX = 0; offsetY = 0; applyTransform(); });
imageWrapper.addEventListener('wheel', (e) => {
  e.preventDefault();
  const delta = e.deltaY < 0 ? 0.1 : -0.1;
  scale = Math.min(4, Math.max(0.4, scale + delta));
  applyTransform();
}, { passive: false });

img.addEventListener('mousedown', (e) => { isPanning = true; startX = e.clientX - offsetX; startY = e.clientY - offsetY; img.style.cursor = 'grabbing'; });
window.addEventListener('mouseup', () => { isPanning = false; img.style.cursor = 'grab'; });
window.addEventListener('mousemove', (e) => {
  if (!isPanning) return;
  offsetX = e.clientX - startX; offsetY = e.clientY - startY;
  applyTransform();
});

// form helpers
swapBtn.addEventListener('click', () => { const t = srcEl.value; srcEl.value = dstEl.value; dstEl.value = t; });
clearBtn.addEventListener('click', () => { srcEl.value = ''; dstEl.value = ''; svcEl.value = ''; jsonPre.textContent = 'No results yet.'; tb.innerHTML = `<tr><td colspan="5" class="muted">Run a query to see devices.</td></tr>`; overlay.textContent = 'No image yet'; img.style.display = 'none'; });

// download image
downloadBtn.addEventListener('click', async () => {
  if (!img.src || img.style.display === 'none') return showToast('No image to download');
  const a = document.createElement('a');
  a.href = img.src;
  a.download = `topology_path_${Date.now()}.png`;
  a.click();
});

// copy json
copyBtn.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(jsonPre.textContent || ''); showToast('JSON copied'); }
  catch { showToast('Copy failed'); }
});

// simple IP-ish validation
function validInput() {
  if (!srcEl.value.trim() || !dstEl.value.trim()) {
    hintEl.textContent = 'Source and Destination are required.'; return false;
  }
  hintEl.textContent = ''; return true;
}

// run query
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!validInput()) return;

  // reset UI
  jsonPre.textContent = 'Loading…';
  overlay.textContent = 'Loading image…';
  img.style.display = 'none';
  scale = 1; offsetX = 0; offsetY = 0; applyTransform();

  const source = srcEl.value.trim();
  const destination = dstEl.value.trim();
  const service = svcEl.value.trim();

  try {
    // image first
    const url = `/api/topology-image?source=${encodeURIComponent(source)}&destination=${encodeURIComponent(destination)}&service=${encodeURIComponent(service)}`;
    img.src = url;
    img.onload = () => { overlay.textContent = ''; img.style.display = 'block'; };
    img.onerror = () => { overlay.textContent = 'Image not available for this query'; img.style.display = 'none'; };

    // json + devices
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
});

function renderDevices(devs) {
  if (!Array.isArray(devs) || !devs.length) {
    tb.innerHTML = `<tr><td colspan="5" class="muted">No devices found in response. Check JSON section.</td></tr>`;
    return;
  }
  tb.innerHTML = devs.map(d => `
    <tr>
      <td>${d.hop ?? ''}</td>
      <td>${esc(d.device ?? '')}</td>
      <td>${esc(d.type ?? '')}</td>
      <td>${esc(d.iface ?? '')}</td>
      <td>${esc(d.notes ?? '')}</td>
    </tr>
  `).join('');
}

function esc(s) {
  return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'","&#039;");
}
