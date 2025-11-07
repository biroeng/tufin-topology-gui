"use strict";

const $ = (s) => document.querySelector(s);
const toast = (m) => { const t = $("#toast"); if (!t) return; t.textContent = m; t.classList.add("show"); setTimeout(()=>t.classList.remove("show"),1500); };

const searchInput = $("#search");
const reloadBtn = $("#reload");
const copyBtn = $("#copyJson");
const rawJsonEl = $("#rawJson");
const tbody = $("#devBody");
const countEl = document.getElementById("countInfo");

let all = [];

function esc(s){return String(s??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");}
const debounce = (fn, ms=150)=>{ let t; return (...args)=>{ clearTimeout(t); t=setTimeout(()=>fn(...args), ms); }; };

function normalize(json){
  const root = json?.devices ?? json?.items ?? json;
  const arr = Array.isArray(root) ? root
    : Array.isArray(root?.devices) ? root.devices
    : Array.isArray(root?.items) ? root.items : [];
  return (arr||[]).map(d=>({
    id: d.id ?? d.device_id ?? "",
    name: d.name ?? d.device_name ?? "",
    type: d.type ?? d.device_type ?? "",
    ip: d.ip ?? d.address ?? d.management_ip ?? "",
    domain: d.domain ?? d.context ?? d.mssp_context ?? ""
  }));
}

function render(items){
  if (!items.length) { tbody.innerHTML = `<tr><td colspan="5" class="muted">No devices found.</td></tr>`; if (countEl) countEl.textContent = "0"; return; }
  if (countEl) countEl.textContent = String(items.length);
  tbody.innerHTML = items.map(d=>`
    <tr>
      <td>${esc(d.id)}</td><td>${esc(d.name)}</td><td>${esc(d.type)}</td><td>${esc(d.ip)}</td><td>${esc(d.domain)}</td>
    </tr>`).join("");
}

function filterNow(){
  const q = (searchInput?.value || "").trim().toLowerCase();
  if (!q) return render(all);
  const f = all.filter(d => [d.id,d.name,d.type,d.ip,d.domain].join(" ").toLowerCase().includes(q));
  render(f);
}
const filterDebounced = debounce(filterNow, 150);

async function load(){
  tbody.innerHTML = `<tr><td colspan="5" class="muted">Loading…</td></tr>`;
  rawJsonEl.textContent = "Loading…";
  try{
    const r = await fetch("/api/devices");
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "Failed to load devices");
    all = normalize(j);
    render(all);
    rawJsonEl.textContent = JSON.stringify(j, null, 2);
    toast(`Loaded ${all.length} device${all.length===1?"":"s"}`);
    filterNow();
  }catch(e){
    tbody.innerHTML = `<tr><td colspan="5" class="muted">Error loading devices.</td></tr>`;
    rawJsonEl.textContent = `Error: ${e.message}`;
  }
}

searchInput?.addEventListener("input", filterDebounced);
reloadBtn?.addEventListener("click", load);
copyBtn?.addEventListener("click", async()=>{ try{ await navigator.clipboard.writeText(rawJsonEl.textContent || ""); toast("JSON copied"); }catch{ toast("Copy failed"); } });

load();
