import express from "express";
import axios from "axios";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import https from "https";
import fs from "fs";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = 3000;

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

const baseURL = process.env.TUFN_URL;
const username = process.env.TUFN_USER;
const password = process.env.TUFN_PASS;
const token = process.env.TUFN_TOKEN;

// ---------- Auth ----------
function getAuthHeaders() {
  if (token) return { Authorization: `Bearer ${token}` };
  if (username && password) {
    const encoded = Buffer.from(`${username}:${password}`).toString("base64");
    return { Authorization: `Basic ${encoded}` };
  }
  throw new Error("Missing authentication. Set TUFN_TOKEN or TUFN_USER/TUFN_PASS in .env");
}

// ---------- Data dir & stores ----------
const DATA_DIR = path.join(__dirname, "data");
const APPROVED_PATH = path.join(DATA_DIR, "approved_networks.json");
const MAPPINGS_PATH = path.join(DATA_DIR, "network_mappings.json");

function ensureDataFile(p, initial) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify(initial, null, 2));
}
ensureDataFile(APPROVED_PATH, { items: [] });
ensureDataFile(MAPPINGS_PATH, { items: [] });

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return { items: [] }; } }
function writeJson(p, data) { fs.writeFileSync(p, JSON.stringify(data, null, 2)); }

// ---------- Helpers ----------
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
  const parts = String(cidr).trim().split("/");
  if (parts.length === 1) return ipNum === ipToNum(parts[0]); // exact IP
  const base = ipToNum(parts[0]); const len = Number(parts[1]);
  if (base == null || isNaN(len) || len < 0 || len > 32) return false;
  const mask = len === 0 ? 0 : (~0 << (32 - len)) >>> 0;
  return ((ipNum & mask) >>> 0) === ((base & mask) >>> 0);
}
function isValidIpOrCidr(s) {
  return /^(\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?$/.test(String(s).trim());
}

// ---------- Tag taxonomy ----------
const TAG_TAXONOMY = {
  environment: ["Production", "Development", "QA", "DR"],
  businessUnit: ["Finance", "HR", "Research", "Marketing", "IT", "Operations"],
  dataSensitivity: ["Public", "Internal", "Confidential", "PII"],
  application: ["SAP-ERP", "CustomerPortal", "SharePoint", "ActiveDirectory", "CRM", "Custom-App"],
  compliance: ["PCI-DSS", "SOX", "HIPAA", "GDPR", "ISO27001"],
  trustZone: ["Internal-Trust", "DMZ", "Untrusted-Internet", "Partner-Extranet"]
};

// ---------- Robust extraction from Tufin JSON ----------
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
    const ip = pickFirstByPaths(json, [["ip"], ["address"]]);
    const action = pickFirstByPaths(json, [["action"], ["status"], ["state"]]);
    const notes = [ip && `IP: ${ip}`, action && `Status: ${action}`].filter(Boolean).join(" • ");
    const key = `${name}|${type}|${iface}|${notes}`;
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
      const ip = pickFirstByPaths(hop, [["ip"], ["address"]]);
      const action = pickFirstByPaths(hop, [["action"], ["status"], ["state"]]);
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

// ---------- Tufin API proxies ----------
app.post("/api/topology-path", async (req, res) => {
  const { source, destination, service } = req.body;
  try {
    const response = await axios.get(`${baseURL}/securetrack/api/topology/path`, {
      params: { src: source, dst: destination, service },
      headers: { ...getAuthHeaders(), Accept: "application/json" },
      httpsAgent: new https.Agent({ rejectUnauthorized: false })
    });
    res.json(response.data);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Failed to query Tufin path API", details: err.response?.data || err.message });
  }
});

app.get("/api/topology-image", async (req, res) => {
  const { source, destination, service } = req.query;
  try {
    const response = await axios.get(`${baseURL}/securetrack/api/topology/path_image`, {
      params: { src: source, dst: destination, service },
      headers: { ...getAuthHeaders(), Accept: "image/png" },
      responseType: "arraybuffer",
      httpsAgent: new https.Agent({ rejectUnauthorized: false })
    });
    res.set("Content-Type", "image/png");
    res.send(response.data);
  } catch (err) {
    console.error("Error fetching topology image:", err.response?.data || err.message);
    res.status(500).send("Failed to retrieve topology image");
  }
});

// Enhanced route: raw data + normalized devices + approved/tags match
app.post("/api/topology-path-with-devices", async (req, res) => {
  const { source, destination, service } = req.body;
  try {
    const response = await axios.get(`${baseURL}/securetrack/api/topology/path`, {
      params: { src: source, dst: destination, service },
      headers: { ...getAuthHeaders(), Accept: "application/json" },
      httpsAgent: new https.Agent({ rejectUnauthorized: false })
    });
    const raw = response.data;
    const devices = extractDevicesFromPathJson(raw);

    // match with approved networks
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

// ---------- Taxonomy ----------
app.get("/api/tag-taxonomy", (_req, res) => {
  res.json(TAG_TAXONOMY);
});

// ---------- Approved Networks CRUD ----------
app.get("/api/approved-networks", (_req, res) => res.json(readJson(APPROVED_PATH)));

app.post("/api/approved-networks", (req, res) => {
  const { cidr, tags } = req.body || {};
  if (!cidr) return res.status(400).json({ error: "cidr is required" });
  const isIpOnly = !!ipToNum(cidr);
  const isCidr = /^(\d+\.){3}\d+\/\d{1,2}$/.test(cidr);
  if (!isIpOnly && !isCidr) return res.status(400).json({ error: "cidr must be IPv4 or IPv4/CIDR" });

  const data = readJson(APPROVED_PATH);
  const item = { id: genId("an_"), cidr, tags: Array.isArray(tags) ? tags : [] };
  data.items.push(item);
  writeJson(APPROVED_PATH, data);
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
    const isCidr = /^(\d+\.){3}\d+\/\d{1,2}$/.test(cidr);
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
    existing.tags = Array.from(set);
    writeJson(APPROVED_PATH, data);
    return res.json(existing);
  }
  const item = { id: genId("an_"), cidr, tags: Array.isArray(tags) ? tags : [] };
  data.items.push(item);
  writeJson(APPROVED_PATH, data);
  res.status(201).json(item);
});

// ---------- Network ↔ Application Mappings CRUD ----------
app.get("/api/mappings", (_req, res) => res.json(readJson(MAPPINGS_PATH)));

app.post("/api/mappings", (req, res) => {
  const { cidr, applications } = req.body || {};
  if (!cidr || !isValidIpOrCidr(cidr)) return res.status(400).json({ error: "cidr required (IPv4 or IPv4/CIDR)" });
  const data = readJson(MAPPINGS_PATH);
  const item = { id: genId("m_"), cidr: String(cidr).trim(), applications: Array.isArray(applications) ? applications : [] };
  data.items.push(item);
  writeJson(MAPPINGS_PATH, data);
  res.status(201).json(item);
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
  writeJson(MAPPINGS_PATH, data);
  res.json(data.items[idx]);
});

app.delete("/api/mappings/:id", (req, res) => {
  const { id } = req.params;
  const data = readJson(MAPPINGS_PATH);
  const idx = data.items.findIndex(x => x.id === id);
  if (idx < 0) return res.status(404).json({ error: "not found" });
  const removed = data.items.splice(idx, 1)[0];
  writeJson(MAPPINGS_PATH, data);
  res.json(removed);
});

// ---------- Pages ----------
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/tags", (_req, res) => res.sendFile(path.join(__dirname, "public", "tags.html")));

app.listen(port, () => console.log(`Tufin Topology GUI running at http://localhost:${port}`));
