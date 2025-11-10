"use strict";

const $ = (s) => document.querySelector(s);
const toast = (m) => { const t = $("#toast"); if (!t) return; t.textContent = m; t.classList.add("show"); setTimeout(()=>t.classList.remove("show"),1500); };
function esc(s){return String(s??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");}

const form = $("#queryForm");
const sourceEl = $("#source");
const destEl = $("#destination");
const serviceEl = $("#service");
const hintEl = $("#formHint");

const img = $("#topologyImage");
const imgOverlay = $("#imageOverlay");

const resultPre = $("#result");
const tableBody = $("#devicesTableBody");

const zoomInBtn = $("#zoomIn");
const zoomOutBtn = $("#zoomOut");
const resetZoomBtn = $("#resetZoom");
const downloadBtn = $("#downloadImg");
const copyJsonBtn = $("#copyJson");

const approvedForm = $("#approvedForm");
const approvedInput = $("#approvedInput");
const approvedList = $("#approvedList");

// Zoom
let zoom = 1;
function applyZoom(){ img.style.transform = `scale(${zoom})`; img.style.transformOrigin = "center center"; }
zoomInBtn?.addEventListener("click", ()=>{ zoom = Math.min(3, zoom + 0.1); applyZoom(); });
zoomOutBtn?.addEventListener("click", ()=>{ zoom = Math.max(0.3, zoom - 0.1); applyZoom(); });
resetZoomBtn?.addEventListener("click", ()=>{ zoom = 1; applyZoom(); });

// Download PNG (uses POST to ensure same params & headers)
downloadBtn?.addEventListener("click", async ()=>{
  try{
    const body = collectOptions();
    const res = await fetch("/api/topology/path_image", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ ...body, _ts: Date.now() }) });
    if (!res.ok) throw new Error("Failed to fetch image");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `topology_${Date.now()}.png`; a.click(); URL.revokeObjectURL(url);
  }catch{ toast("Download failed"); }
});

// Copy JSON
copyJsonBtn?.addEventListener("click", async ()=>{
  try{ await navigator.clipboard.writeText(resultPre.textContent || ""); toast("JSON copied"); }catch{ toast("Copy failed"); }
});

// Approved networks
async function listApproved(){ const r = await fetch("/api/approved-networks"); return r.json(); }
async function addApproved(cidr, tags=[]){ const r = await fetch("/api/approved-networks",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({ cidr, tags })}); if(!r.ok) throw new Error("Add failed"); return r.json(); }
async function tagByIp(ip, tags=[]){ const r = await fetch("/api/approved-networks/tag-by-ip",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({ ip, tags })}); if(!r.ok) throw new Error("Tag by IP failed"); return r.json(); }
async function renderApproved(){
  try{
    const data = await listApproved();
    const items = data.items || [];
    approvedList.innerHTML = items.length ? items.map(i=>`<li><span class="pill">${esc(i.cidr)}</span> ${(i.tags||[]).map(t=>`<span class="pill">${esc(t)}</span>`).join(" ")}</li>`).join("") : `<li class="muted">No approved networks yet.</li>`;
  }catch{ approvedList.innerHTML = `<li class="muted">Failed to load approved networks.</li>`; }
}
approvedForm?.addEventListener("submit", async (e)=>{ e.preventDefault(); const v = approvedInput.value.trim(); if(!v) return; try{ await addApproved(v,[]); approvedInput.value=""; await renderApproved(); toast("Added"); }catch{ toast("Failed to add"); } });
renderApproved();

// Collect options from form (includes Advanced)
function collectOptions(){
  const source = sourceEl.value.trim();
  const dest = destEl.value.trim();
  let service = (serviceEl.value || "").trim();
  if (!service) service = "any";

  const ctxEl = document.getElementById("context");
  const sdomEl = document.getElementById("sourceDomainIdTag");
  const dipEl = document.getElementById("displayIncompletePaths");
  const dbsEl = document.getElementById("displayBlockedStatus");
  const natEl = document.getElementById("simulateNat");
  const lastEl = document.getElementById("lastInstall");

  return {
    source,
    destination: dest,
    service,
    context: ctxEl?.value || "",
    sourceDomainIdTag: sdomEl?.value || "",
    displayIncompletePaths: !!dipEl?.checked,
    displayBlockedStatus: !!dbsEl?.checked,
    simulateNat: natEl?.checked !== false, // default true
    lastInstall: lastEl?.checked !== false  // default true
  };
}

// Image loader (POST)
async function loadTopologyImagePOST(opts) {
  try {
    imgOverlay.textContent = "Loading image…";
    img.src = "";

    const res = await fetch("/securetrack/api/topology-image", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ ...opts, _ts: Date.now() })
    });
    if (!res.ok) {
      const text = await res.text().catch(()=> "");
      console.warn("Image error:", res.status, text);
      imgOverlay.textContent = "Failed to load image";
      return;
    }
    const blob = await res.blob();
    if (!blob.type.startsWith("image/")) { imgOverlay.textContent = "No path image available"; return; }
    const objUrl = URL.createObjectURL(blob);
    img.onload = ()=>{ URL.revokeObjectURL(objUrl); imgOverlay.textContent=""; };
    img.onerror = ()=>{ URL.revokeObjectURL(objUrl); imgOverlay.textContent="Failed to render image"; };
    img.src = objUrl;
  } catch (e) {
    console.error("Image fetch exception:", e);
    imgOverlay.textContent = "Failed to load image";
  }
}

// Device extraction helpers (robust to different shapes)
function getLikelyArray(root){
  if (!root||typeof root!=="object") return [];
  if (Array.isArray(root.hops)) return root.hops;
  if (Array.isArray(root.path)) return root.path;
  if (Array.isArray(root.nodes)) return root.nodes;
  if (root.result && Array.isArray(root.result.hops)) return root.result.hops;
  if (root.data && Array.isArray(root.data.hops)) return root.data.hops;
  if (root.topology && Array.isArray(root.topology.hops)) return root.topology.hops;
  return [];
}
function recursiveCollect(json, out=[], seen=new Set()){
  if (!json || typeof json !== "object") return out;
  if (json.device_info && typeof json.device_info === "object") {
    const info = json.device_info;
    const name = info.name || json.name || info.hostname || info.device || "";
    const type = info.type || info.device_type || json.type || "";
    const ip = info.ip || info.address || json.ip || "";
    const iface = json.interface || json.ingress_interface || json.egress_interface || "";
    const key = `${name}|${type}|${ip}|${iface}`;
    if (name && !seen.has(key)) { out.push({ device:name, type:type||"", ip:ip||"", iface:iface||"", notes:"" }); seen.add(key); }
  }
  for (const v of Object.values(json)) {
    if (Array.isArray(v)) v.forEach(it=>recursiveCollect(it, out, seen));
    else if (v && typeof v === "object") recursiveCollect(v, out, seen);
  }
  return out;
}
function extractDevicesFromTopology(json){
  const hops = getLikelyArray(json);
  const devices = []; const seen = new Set();
  const push = (obj, ifaceHint) => {
    const name = obj?.name ?? obj?.device ?? obj?.hostname ?? obj?.node ?? "";
    if (!name) return;
    const type = obj?.type ?? obj?.device_type ?? "";
    const ip = obj?.ip ?? obj?.address ?? obj?.management_ip ?? "";
    const iface = obj?.interface ?? obj?.iface ?? obj?.ingress_interface ?? obj?.egress_interface ?? ifaceHint ?? "";
    const action = obj?.action ?? obj?.state ?? obj?.status ?? "";
    const notes = [action && `Status: ${action}`].filter(Boolean).join(" • ");
    const k = `${name}|${type}|${ip}|${iface}|${notes}`;
    if (!seen.has(k)) { devices.push({ device:name, type, ip, iface, notes }); seen.add(k); }
  };

  if (Array.isArray(hops) && hops.length) {
    hops.forEach((hop) => {
      push(hop);
      if (hop.device_info && typeof hop.device_info === "object") push({ ...hop.device_info }, hop.interface || hop.iface);
      if (hop.node && typeof hop.node === "object") push(hop.node, hop.interface);
      if (hop.device && typeof hop.device === "object") push(hop.device, hop.interface);
    });
  }
  if (!devices.length) recursiveCollect(json, devices);
  return devices.map((d,i)=>({ hop: i+1, ...d }));
}

function renderDevicesTable(devices){
  if (!Array.isArray(devices) || !devices.length) {
    tableBody.innerHTML = `<tr><td colspan="8" class="muted">No devices found in response.</td></tr>`; return;
  }
  tableBody.innerHTML = devices.map(d => {
    const tagBtn = d.ip ? `<button class="link-btn" data-ip="${esc(d.ip)}">Tag Network</button>` : `<span class="muted">—</span>`;
    return `<tr>
      <td>${d.hop ?? ""}</td>
      <td>${esc(d.device ?? "")}</td>
      <td>${esc(d.ip ?? "")}</td>
      <td>${esc(d.type ?? "")}</td>
      <td>${esc(d.iface ?? "")}</td>
      <td>${esc(d.notes ?? "")}</td>
      <td><span class="muted">—</span></td>
      <td>${tagBtn}</td>
    </tr>`;
  }).join("");

  tableBody.querySelectorAll("[data-ip]").forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      const ip = btn.getAttribute("data-ip");
      const t = prompt(`Add tags for ${ip}/32 (comma-separated):`, "") || "";
      const tags = t.split(",").map(s=>s.trim()).filter(Boolean);
      if (!tags.length) return;
      try { await tagByIp(ip, tags); toast("Tagged"); renderApproved(); } catch { toast("Tagging failed"); }
    });
  });
}

// Submit handler
form?.addEventListener("submit", async (e)=>{
  e.preventDefault();
  hintEl.textContent = "";

  const opts = collectOptions();
  if (!opts.source || !opts.destination) { hintEl.textContent = "Source and Destination are required."; return; }

  // Load image in parallel with identical flags/params
  loadTopologyImagePOST(opts);

  // JSON request for devices (optional flags forwarded for parity)
  try {
    const res = await fetch("/api/topology-path-with-devices", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({
        source: opts.source,
        destination: opts.destination,
        service: opts.service,
        context: opts.context,
        sourceDomainIdTag: opts.sourceDomainIdTag,
        displayIncompletePaths: opts.displayIncompletePaths,
        displayBlockedStatus: opts.displayBlockedStatus,
        simulateNat: opts.simulateNat,
        lastInstall: opts.lastInstall
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || data?.details || "Request failed");
    resultPre.textContent = JSON.stringify(data, null, 2);
    const devices = extractDevicesFromTopology(data);
    renderDevicesTable(devices);
    toast(`Found ${devices.length} device${devices.length===1?"":"s"}`);
  } catch (err) {
    resultPre.textContent = `Error: ${err.message}`;
    tableBody.innerHTML = `<tr><td colspan="8" class="muted">Error parsing response.</td></tr>`;
  }
});

// Swap & Clear
$("#swapBtn")?.addEventListener("click", ()=>{ const a = sourceEl.value; sourceEl.value = destEl.value; destEl.value = a; });
$("#clearBtn")?.addEventListener("click", ()=>{
  sourceEl.value = ""; destEl.value = ""; serviceEl.value = "";
  img.src = ""; imgOverlay.textContent = "No image yet";
  resultPre.textContent = "No results yet.";
  tableBody.innerHTML = `<tr><td colspan="8" class="muted">Run a query to see devices.</td></tr>`;
});
