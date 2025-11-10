// server.js (ESM)
import express from "express";
import axios from "axios";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import https from "https";
import fs from "fs";
import { exec } from "child_process";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

/* =============================================================================
   Tufin SecureTrack config
============================================================================= */
const baseURL = process.env.TUFN_URL || "https://10.100.200.199"; // base host ONLY
const username = process.env.TUFN_USER || "";
const password = process.env.TUFN_PASS || "";
const token    = process.env.TUFN_TOKEN || "";

function getAuthHeaders() {
  if (token) return { Authorization: `Bearer ${token}` };
  if (username && password) {
    const encoded = Buffer.from(`${username}:${password}`).toString("base64");
    return { Authorization: `Basic ${encoded}` };
  }
  throw new Error("Missing authentication. Set TUFN_TOKEN or TUFN_USER/TUFN_PASS in .env");
}

// TLS -k equivalent
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

/* =============================================================================
   Data dir & stores
============================================================================= */
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const APPROVED_PATH      = path.join(DATA_DIR, "approved_networks.json");
const MAPPINGS_PATH      = path.join(DATA_DIR, "network_mappings.json");
const CURL_OUTPUT_PATH   = path.join(DATA_DIR, "last_curl_output.txt");
const AKIPS_DEVICES_PATH = path.join(DATA_DIR, "akips_devices.txt");

function ensureDataFile(p, initial) {
  if (!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify(initial, null, 2));
}
ensureDataFile(APPROVED_PATH, { items: [] });
ensureDataFile(MAPPINGS_PATH, { items: [] });

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return { items: [] }; } }
function writeJson(p, data) { fs.writeFileSync(p, JSON.stringify(data, null, 2)); }

/* =============================================================================
   Helpers (IPs / CIDR / extraction)
============================================================================= */
function genId(prefix = "") { return (prefix || "id_") + Math.random().toString(36).slice(2, 10); }

function ipToNum(ip) {
  const m = String(ip).trim().match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some(n => n < 0 || n > 255)) return null;
  return (((a << 24) >>> 0) + (b << 16) + (c << 8) + d) >>> 0;
}
function inCidr(ip, cidr) {
  const ipNum = ipToNum(ip);
  if (ipNum == null) return false;
  if (!cidr) return false;
  const parts = String(cidr).trim().split("/");
  if (parts.length === 1) return ipNum === ipToNum(parts[0]);
  const base = ipToNum(parts[0]);
  const len  = Number(parts[1]);
  if (base == null || isNaN(len) || len < 0 || len > 32) return false;
  const mask = len === 0 ? 0 : (~0 << (32 - len)) >>> 0;
  return ((ipNum & mask) >>> 0) === ((base & mask) >>> 0);
}
function isValidIpOrCidr(s) {
  return /^(\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?$/.test(String(s).trim());
}

const TAG_TAXONOMY = {
  environment: ["Production", "Development", "QA", "DR"],
  businessUnit: ["Finance", "HR", "Research", "Marketing", "IT", "Operations"],
  dataSensitivity: ["Public", "Internal", "Confidential", "PII"],
  application: ["SAP-ERP", "CustomerPortal", "SharePoint", "ActiveDirectory", "CRM", "Custom-App"],
  compliance: ["PCI-DSS", "SOX", "HIPAA", "GDPR", "ISO27001"],
  trustZone: ["Internal-Trust", "DMZ", "Untrusted-Internet", "Partner-Extranet"]
};

// JSON extraction helpers
function get(obj, pathArr) {
  let cur = obj;
  for (const k of pathArr) { if (!cur || typeof cur !== "object") return undefined; cur = cur[k]; }
  return cur;
}
function pickFirstByPaths(obj, paths) {
  for (const p of paths) { const v = get(obj, p); if (v !== undefined && v !== null && v !== "") return String(v); }
  return "";
}
function getLikelyHopArray(json) {
  const keys = ["path", "hops", "nodes", "path_hops", "route", "pathNodes", "segments", "flow"];
  for (const k of keys) if (Array.isArray(json?.[k])) return json[k];
  for (const v of Object.values(json || {})) {
    if (Array.isArray(v) && v.length && typeof v[0] === "object") return v;
    if (v && typeof v === "object") {
      const deeper = getLikelyHopArray(v);
      if (deeper) return deeper;
    }
  }
  return null;
}
function recursiveCollectDeviceInfo(json, out = [], seen = new Set()) {
  if (!json || typeof json !== "object") return out;
  if (json.device_info && typeof json.device_info === "object") {
    const name = pickFirstByPaths(json, [["device_info", "name"], ["name"], ["hostname"], ["device"]]);
    const type = pickFirstByPaths(json, [["device_info", "type"], ["device_info", "device_type"], ["type"]]);
    const iface = pickFirstByPaths(json, [["interface"], ["ingress_interface"], ["egress_interface"], ["ifname"]]);
    const ip    = pickFirstByPaths(json, [["ip"], ["address"]]);
    const action= pickFirstByPaths(json, [["action"], ["status"], ["state"]]);
    const notes = [ip && `IP: ${ip}`, action && `Status: ${action}`].filter(Boolean).join(" • ");
    const key   = `${name}|${type}|${iface}|${notes}`;
    if (name && !seen.has(key)) { out.push({ device: name, type: type || "", iface: iface || "", notes }); seen.add(key); }
  }
  for (const v of Object.values(json)) {
    if (Array.isArray(v)) v.forEach(it => recursiveCollectDeviceInfo(it, out, seen));
    else if (v && typeof v === "object") recursiveCollectDeviceInfo(v, out, seen);
  }
  return out;
}
function extractDevicesFromPathJson(json) {
  if (!json || typeof json !== "object") return [];
  const hops = getLikelyHopArray(json);
  if (Array.isArray(hops) && hops.length) {
    const out = [], seen = new Set();
    hops.forEach((hop, i) => {
      const deviceName = pickFirstByPaths(hop, [["device_info", "name"], ["device", "name"], ["name"], ["hostname"], ["node"], ["appliance"], ["device"]]);
      const deviceType = pickFirstByPaths(hop, [["device_info", "type"], ["device_info", "device_type"], ["type"]]);
      const iface = pickFirstByPaths(hop, [["interface"], ["ingress_interface"], ["egress_interface"], ["ifname"]]);
      const ip    = pickFirstByPaths(hop, [["ip"], ["address"]]);
      const action= pickFirstByPaths(hop, [["action"], ["status"], ["state"]]);
      const notes = [ip && `IP: ${ip}`, action && `Status: ${action}`].filter(Boolean).join(" • ");
      if (deviceName) {
        const key = `${i}|${deviceName}|${deviceType}|${iface}|${notes}`;
        if (!seen.has(key)) { out.push({ hop: i + 1, device: deviceName, type: deviceType || "", iface: iface || "", notes }); seen.add(key); }
      }
    });
    if (out.length) return out;
  }
  const collected = recursiveCollectDeviceInfo(json);
  return collected.map((d, idx) => ({ hop: idx + 1, ...d }));
}

/* =============================================================================
   UI routes
============================================================================= */
app.get("/",        (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/tags",    (req, res) => res.sendFile(path.join(__dirname, "public", "tags.html")));
app.get("/metrics", (req, res) => res.sendFile(path.join(__dirname, "public", "metrics.html")));
app.get("/curl",    (req, res) => res.sendFile(path.join(__dirname, "public", "curl.html")));

/* =============================================================================
   Tag taxonomy + Approved networks + Mappings
============================================================================= */
app.get("/api/tag-taxonomy", (_req, res) => res.json(TAG_TAXONOMY));

// Approved Networks
app.get("/api/approved-networks", (_req, res) => res.json(readJson(APPROVED_PATH)));
app.post("/api/approved-networks", (req, res) => {
  const { cidr, tags } = req.body || {};
  if (!cidr) return res.status(400).json({ error: "cidr is required" });
  const isIpOnly = !!ipToNum(cidr);
  const isCidr   = /^(\d+\.){3}\d+\/\d{1,2}$/.test(cidr);
  if (!isIpOnly && !isCidr) return res.status(400).json({ error: "cidr must be IPv4 or IPv4/CIDR" });
  const data = readJson(APPROVED_PATH);
  const item = { id: genId("an_"), cidr, tags: Array.isArray(tags) ? tags : [] };
  data.items.push(item); writeJson(APPROVED_PATH, data);
  res.status(201).json(item);
});
app.put("/api/approved-networks/:id", (req, res) => {
  const { id } = req.params;
  const { cidr, tags } = req.body || {};
  const data = readJson(APPROVED_PATH);
  const idx = data.items.findIndex(x => x.id === id);
  if (idx < 0) return res.status(404).json({ error: "not found" });
  if (cidr) {
    const isIpOnly = !!ipToNum(cidr);
    const isCidr   = /^(\d+\.){3}\d+\/\d{1,2}$/.test(cidr);
    if (!isIpOnly && !isCidr) return res.status(400).json({ error: "cidr must be IPv4 or IPv4/CIDR" });
    data.items[idx].cidr = cidr;
  }
  if (Array.isArray(tags)) data.items[idx].tags = tags;
  writeJson(APPROVED_PATH, data);
  res.json(data.items[idx]);
});
app.delete("/api/approved-networks/:id", (req, res) => {
  const { id } = req.params;
  const data = readJson(APPROVED_PATH);
  const idx = data.items.findIndex(x => x.id === id);
  if (idx < 0) return res.status(404).json({ error: "not found" });
  const removed = data.items.splice(idx, 1)[0];
  writeJson(APPROVED_PATH, data);
  res.json(removed);
});
app.post("/api/approved-networks/tag-by-ip", (req, res) => {
  const { ip, tags } = req.body || {};
  if (!ip || ipToNum(ip) == null) return res.status(400).json({ error: "valid ip required" });
  const data = readJson(APPROVED_PATH);
  const cidr = `${ip}/32`;
  const existing = data.items.find(x => x.cidr === cidr);
  if (existing) {
    const set = new Set([...(existing.tags || []), ...(Array.isArray(tags) ? tags : [])]);
    existing.tags = Array.from(set); writeJson(APPROVED_PATH, data); return res.json(existing);
  }
  const item = { id: genId("an_"), cidr, tags: Array.isArray(tags) ? tags : [] };
  data.items.push(item); writeJson(APPROVED_PATH, data); res.status(201).json(item);
});

// Network ↔ Application mappings
app.get("/api/mappings", (_req, res) => res.json(readJson(MAPPINGS_PATH)));
app.post("/api/mappings", (req, res) => {
  const { cidr, applications } = req.body || {};
  if (!cidr || !isValidIpOrCidr(cidr)) return res.status(400).json({ error: "cidr required (IPv4 or IPv4/CIDR)" });
  const data = readJson(MAPPINGS_PATH);
  const item = { id: genId("m_"), cidr: String(cidr).trim(), applications: Array.isArray(applications) ? applications : [] };
  data.items.push(item); writeJson(MAPPINGS_PATH, data); res.status(201).json(item);
});
app.put("/api/mappings/:id", (req, res) => {
  const { id } = req.params;
  const data = readJson(MAPPINGS_PATH);
  const idx = data.items.findIndex(x => x.id === id);
  if (idx < 0) return res.status(404).json({ error: "not found" });
  const { cidr, applications } = req.body || {};
  if (cidr && !isValidIpOrCidr(cidr)) return res.status(400).json({ error: "invalid cidr" });
  if (cidr) data.items[idx].cidr = String(cidr).trim();
  if (Array.isArray(applications)) data.items[idx].applications = applications;
  writeJson(MAPPINGS_PATH, data); res.json(data.items[idx]);
});
app.delete("/api/mappings/:id", (req, res) => {
  const { id } = req.params;
  const data = readJson(MAPPINGS_PATH);
  const idx = data.items.findIndex(x => x.id === id);
  if (idx < 0) return res.status(404).json({ error: "not found" });
  const removed = data.items.splice(idx, 1)[0];
  writeJson(MAPPINGS_PATH, data); res.json(removed);
});

/* =============================================================================
   Tufin Topology (image + JSON)
============================================================================= */
// /api/topology-path (raw JSON)
app.post("/api/topology-path", async (req, res) => {
  const { source, destination, service } = req.body || {};
  try {
    const response = await axios.get(`${baseURL}/securetrack/api/topology/path`, {
      params: { src: source, dst: destination, service },
      headers: { ...getAuthHeaders(), Accept: "application/json" },
      httpsAgent: insecureAgent
    });
    res.json(response.data);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Failed to query Tufin path API", details: err.response?.data || err.message });
  }
});

// /api/topology-image (PNG) + alias
app.get("/api/topology-image", async (req, res) => {
  try {
    const src = (req.query.src || req.query.source || "").trim();
    const dst = (req.query.dst || req.query.destination || "").trim();
    const svc = (req.query.service || "any").trim();
    if (!src || !dst) return res.status(400).json({ error: "src/dst (or source/destination) are required" });

    const response = await axios.get(`${baseURL}/securetrack/api/topology/path_image`, {
      params: { src, dst, service: svc },
      headers: { ...getAuthHeaders(), Accept: "image/png" },
      responseType: "arraybuffer",
      httpsAgent: insecureAgent
    });
    res.set("Content-Type", "image/png");
    res.send(response.data);
  } catch (err) {
    console.error("Error fetching topology image:", err.response?.data || err.message);
    res.status(500).send("Failed to retrieve topology image");
  }
});
// alias to support /api/topology/path_image
app.get("/api/topology/path_image", (req, res) => {
  req.url = "/api/topology-image" + (req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "");
  app._router.handle(req, res, () => {});
});

// Enhanced: /api/topology-path-with-devices
app.post("/api/topology-path-with-devices", async (req, res) => {
  const { source, destination, service } = req.body || {};
  try {
    const response = await axios.get(`${baseURL}/securetrack/api/topology/path`, {
      params: { src: source, dst: destination, service },
      headers: { ...getAuthHeaders(), Accept: "application/json" },
      httpsAgent: insecureAgent
    });
    const raw = response.data;
    const devices = extractDevicesFromPathJson(raw);

    // tag enrichment from approved networks
    const approvedStore = readJson(APPROVED_PATH);
    const netItems = approvedStore.items || [];
    const withTags = devices.map(d => {
      const ipMatch = (d.notes || "").match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/);
      const ip = ipMatch ? ipMatch[1] : null;
      const matched = ip ? netItems.filter(n => inCidr(ip, n.cidr)) : [];
      const tags = matched.flatMap(m => m.tags || []);
      return { ...d, ip: ip || "", approved: matched.length > 0, tags };
    });

    res.json({ data: raw, devices: withTags, meta: { devices_found: withTags.length } });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Failed to query Tufin path API (with devices)", details: err.response?.data || err.message });
  }
});

/* =============================================================================
   AKIPS metrics poller (reuses .env)
============================================================================= */
const API_DB_BASE_URL = process.env.API_DB_BASE_URL || "https://10.100.200.20/api-db";
const API_DB_USER     = process.env.API_DB_USER     || "api-ro";
const API_DB_PASS     = process.env.API_DB_PASS     || "verysafe";
const API_DB_POLL_MS  = Number(process.env.API_DB_POLL_MS || 15000);

const DB_SERIES_CACHE = [];
const DB_SERIES_CACHE_MAX = 2000;
let dbPollTimer = null;
let dbPollingEnabled = API_DB_POLL_MS > 0;

function parseMaybeJSON(text) { try { return JSON.parse(text); } catch { return text; } }
function pushDbSample(item) {
  DB_SERIES_CACHE.push({ ts: new Date().toISOString(), ...item });
  if (DB_SERIES_CACHE.length > DB_SERIES_CACHE_MAX) DB_SERIES_CACHE.shift();
}
async function fetchDbSeriesOnce() {
  const qs  = `username=${encodeURIComponent(API_DB_USER)};password=${encodeURIComponent(API_DB_PASS)};cmds=${encodeURIComponent("series avg time last5m gauge")}`;
  const url = `${API_DB_BASE_URL}?${qs}`;
  const res = await fetch(url, { agent: insecureAgent });
  const text = await res.text();
  if (!res.ok) throw new Error(`api-db HTTP ${res.status}: ${text.slice(0, 200)}`);
  const data = parseMaybeJSON(text);
  pushDbSample({ ok: true, raw: text, data });
  return { ok: true, raw: text, data };
}
function startDbPolling() {
  if (dbPollTimer || !dbPollingEnabled || API_DB_POLL_MS <= 0) return;
  dbPollTimer = setInterval(async () => {
    try { await fetchDbSeriesOnce(); }
    catch (e) { pushDbSample({ ok: false, error: e.message }); }
  }, API_DB_POLL_MS);
}
function stopDbPolling() {
  if (dbPollTimer) { clearInterval(dbPollTimer); dbPollTimer = null; }
}
if (dbPollingEnabled) startDbPolling();

// Metrics API
app.post("/api/db-series/now", async (_req, res) => {
  try { res.json({ ok: true, item: await fetchDbSeriesOnce() }); }
  catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});
app.get("/api/db-series/cache", (_req, res) => {
  res.json({ ok: true, items: DB_SERIES_CACHE.slice(-200) });
});
app.post("/api/db-series/poll", (req, res) => {
  const enable = String(req.query.enable || "").toLowerCase();
  if (enable === "1" || enable === "true") { dbPollingEnabled = true; startDbPolling(); return res.json({ ok: true, polling: true }); }
  if (enable === "0" || enable === "false") { dbPollingEnabled = false; stopDbPolling(); return res.json({ ok: true, polling: false }); }
  res.status(400).json({ ok: false, error: "Pass ?enable=1 or ?enable=0" });
});

/* =============================================================================
   Curl runners (AKIPS) using env + files + helper
============================================================================= */
function buildAkipsCurl(cmds) {
  // AKIPS expects semicolons between params; we encode spaces in command as '+'
  const encCmds = cmds.replace(/\s+/g, '+');
  return `curl -sk "${API_DB_BASE_URL}?username=${API_DB_USER};password=${API_DB_PASS};cmds=${encCmds}"`;
}

// for UI to show the actual commands built from .env
app.get("/api/curl-info", (req, res) => {
  res.json({
    ok: true,
    base: API_DB_BASE_URL,
    metrics: buildAkipsCurl("series avg time last5m gauge"),
    devices: buildAkipsCurl("mget device *")
  });
});

// global flag to prevent overlap
let __curlBusy = false;

// metrics curl
app.post("/api/run-curl", (req, res) => {
  if (__curlBusy) return res.status(429).json({ ok: false, error: "Previous curl still running. Try again shortly." });
  __curlBusy = true;

  const cmd = buildAkipsCurl("series avg time last5m gauge");
  exec(cmd, { maxBuffer: 10 * 1024 * 1024, timeout: 30000 }, (err, stdout, stderr) => {
    __curlBusy = false;

    // Persist stdout for metrics page consumption
    try { fs.writeFileSync(CURL_OUTPUT_PATH, stdout || "", "utf8"); }
    catch (e) { console.error("Failed to write last_curl_output.txt:", e.message); }

    if (err) {
      return res.status(502).json({
        ok: false, error: err.message,
        exitCode: typeof err.code === "number" ? err.code : null,
        signal: err.signal || null,
        stderr: String(stderr || ""), stdout: String(stdout || "")
      });
    }
    res.json({ ok: true, when: new Date().toISOString(), stdout: String(stdout || ""), stderr: String(stderr || "") });
  });
});

// devices curl
app.post("/api/run-curl-devices", (req, res) => {
  const cmd = buildAkipsCurl("mget device *");
  exec(cmd, { maxBuffer: 20 * 1024 * 1024, timeout: 30000 }, (err, stdout, stderr) => {
    if (err) {
      console.error("AKIPS devices curl failed:", err.message);
      return res.status(502).json({ ok: false, error: err.message, stderr, stdout });
    }
    try { fs.writeFileSync(AKIPS_DEVICES_PATH, stdout || "", "utf8"); }
    catch (e) { console.error("Failed to write akips_devices.txt:", e.message); }
    res.json({ ok: true, stdout: String(stdout || ""), stderr: String(stderr || "") });
  });
});

// readers for files (used by metrics.html)
app.get("/api/curl-output-file", (req, res) => {
  try { const data = fs.readFileSync(CURL_OUTPUT_PATH, "utf8"); res.type("text/plain").send(data); }
  catch { res.status(404).send("No curl output file found yet."); }
});
app.get("/api/akips-devices", (req, res) => {
  try { const data = fs.readFileSync(AKIPS_DEVICES_PATH, "utf8"); res.type("text/plain").send(data); }
  catch { res.status(404).send("No AKIPS device list file found."); }
});


// ---- Device interface admin status (AKIPS) ----
// POST /api/device-status { device: "tos-rtr1" }
app.post("/api/device-status", (req, res) => {
  const device = (req.body?.device || "").trim();
  if (!device) return res.status(400).json({ ok: false, error: "device is required" });

  // Build the exact curl: curl -sk "<base>?username=...;password=..." -d "cmds=mget * DEVICE * IF-MIB.ifAdminStatus"
  const cmds = `mget * ${device} * IF-MIB.ifAdminStatus`;
  // Escape double-quotes in cmds (very unlikely here, but safe)
  const cmdsEsc = cmds.replace(/"/g, '\\"');
  const cmd = `curl -sk "${API_DB_BASE_URL}?username=${API_DB_USER};password=${API_DB_PASS}" -d "cmds=${cmdsEsc}"`;

  exec(cmd, { maxBuffer: 20 * 1024 * 1024, timeout: 30000 }, (err, stdout, stderr) => {
    if (err) {
      console.error("device-status curl failed:", err.message);
      return res.status(502).json({ ok: false, error: err.message, stderr, stdout });
    }

    // Parse the IF-MIB.ifAdminStatus output into rows
    // Try to catch lines like:
    //  IF-MIB::ifAdminStatus.3 = 1
    //  ifAdminStatus.5 2
    //  ... (AKIPS formats can vary; we’re lenient)
    const lines = String(stdout || "").split(/\r?\n/).filter(Boolean);
    const rows = [];
    for (const line of lines) {
      // Find ifIndex
      const idxMatch = line.match(/ifAdminStatus\.(\d+)/i);
      // Find last integer (status code)
      const codeMatch = line.match(/(\d+)\s*$/);
      if (!idxMatch || !codeMatch) continue;

      const ifIndex = Number(idxMatch[1]);
      const code = Number(codeMatch[1]);
      const statusText = code === 1 ? "up" : code === 2 ? "down" : code === 3 ? "testing" : `unknown(${code})`;

      rows.push({ ifIndex, statusCode: code, statusText, raw: line });
    }

    // Sort by ifIndex asc for readability
    rows.sort((a, b) => a.ifIndex - b.ifIndex);

    res.json({
      ok: true,
      device,
      count: rows.length,
      rows,
      raw: stdout
    });
  });
});

/* =============================================================================
   Start server
============================================================================= */
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
