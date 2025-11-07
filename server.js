import express from "express";
import axios from "axios";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import https from "https";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = 3000;

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

const baseURL = process.env.TUFN_URL;
const username = process.env.TUFN_USER;
const password = process.env.TUFN_PASS;
const token = process.env.TUFN_TOKEN;

function getAuthHeaders() {
  if (token) return { Authorization: `Bearer ${token}` };
  if (username && password) {
    const encoded = Buffer.from(`${username}:${password}`).toString("base64");
    return { Authorization: `Basic ${encoded}` };
  }
  throw new Error("Missing authentication. Set TUFN_TOKEN or TUFN_USER/TUFN_PASS in .env");
}

/* --------------------------
   Helpers (robust extraction)
--------------------------- */

// Get a nested value by path array, e.g. ["device_info","name"]
function get(obj, pathArr) {
  let cur = obj;
  for (const k of pathArr) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = cur[k];
  }
  return cur;
}

// First non-empty among many dotted paths
function pickFirstByPaths(obj, pathCandidates) {
  for (const p of pathCandidates) {
    const v = get(obj, p);
    if (v !== undefined && v !== null && v !== "") return String(v);
  }
  return "";
}

// Return the first array that looks like an ordered hop list
function getLikelyHopArray(json) {
  const candidateKeys = [
    "path",
    "hops",
    "nodes",
    "path_hops",
    "route",
    "pathNodes",
    "segments",
    "flow",
  ];
  for (const key of candidateKeys) {
    if (Array.isArray(json?.[key])) return json[key];
  }
  // Try deeper: if the response stores path details inside another object
  for (const [k, v] of Object.entries(json || {})) {
    if (Array.isArray(v) && v.length && typeof v[0] === "object") return v;
    if (v && typeof v === "object") {
      const found = getLikelyHopArray(v);
      if (found) return found;
    }
  }
  return null;
}

// Recursively scan the whole JSON for objects that contain device_info.{name,type}
function recursiveCollectDeviceInfo(json, out = [], seen = new Set()) {
  if (!json || typeof json !== "object") return out;

  if (json.device_info && typeof json.device_info === "object") {
    const name = pickFirstByPaths(json, [["device_info", "name"], ["name"], ["hostname"], ["device"]]);
    const type = pickFirstByPaths(json, [["device_info", "type"], ["device_info", "device_type"], ["type"]]);
    // try to find a likely interface nearby
    const iface = pickFirstByPaths(json, [["interface"], ["ingress_interface"], ["egress_interface"], ["ifname"]]);
    const ip = pickFirstByPaths(json, [["ip"], ["address"]]);
    const action = pickFirstByPaths(json, [["action"], ["status"], ["state"]]);
    const notes = [ip && `IP: ${ip}`, action && `Status: ${action}`].filter(Boolean).join(" • ");

    const key = `${name}|${type}|${iface}|${notes}`;
    if (name && !seen.has(key)) {
      out.push({ device: name, type: type || "", iface: iface || "", notes });
      seen.add(key);
    }
  }

  for (const v of Object.values(json)) {
    if (Array.isArray(v)) {
      for (const item of v) recursiveCollectDeviceInfo(item, out, seen);
    } else if (v && typeof v === "object") {
      recursiveCollectDeviceInfo(v, out, seen);
    }
  }
  return out;
}

function extractDevicesFromPathJson(json) {
  if (!json || typeof json !== "object") return [];

  // 1) Try ordered hop arrays first
  const hops = getLikelyHopArray(json);
  if (Array.isArray(hops) && hops.length) {
    const out = [];
    const seen = new Set();
    hops.forEach((hop, i) => {
      const deviceName = pickFirstByPaths(hop, [
        ["device_info", "name"],
        ["device", "name"],
        ["name"],
        ["hostname"],
        ["node"],
        ["appliance"],
        ["device"],
      ]);
      const deviceType = pickFirstByPaths(hop, [
        ["device_info", "type"],
        ["device_info", "device_type"],
        ["type"],
      ]);
      const iface = pickFirstByPaths(hop, [
        ["interface"],
        ["ingress_interface"],
        ["egress_interface"],
        ["ifname"],
      ]);
      const ip = pickFirstByPaths(hop, [["ip"], ["address"]]);
      const action = pickFirstByPaths(hop, [["action"], ["status"], ["state"]]);
      const notes = [ip && `IP: ${ip}`, action && `Status: ${action}`].filter(Boolean).join(" • ");

      // Only count rows that actually have a device name
      if (deviceName) {
        const key = `${i}|${deviceName}|${deviceType}|${iface}|${notes}`;
        if (!seen.has(key)) {
          out.push({
            hop: i + 1,
            device: deviceName,
            type: deviceType || "",
            iface: iface || "",
            notes,
          });
          seen.add(key);
        }
      }
    });
    if (out.length) return out;
  }

  // 2) Fallback: recursively scan everything for device_info blocks
  const collected = recursiveCollectDeviceInfo(json);
  // annotate hop numbers in the order found
  return collected.map((d, idx) => ({ hop: idx + 1, ...d }));
}

/* --------------------------
   Routes
--------------------------- */

// Legacy JSON path proxy (kept for compatibility)
app.post("/api/topology-path", async (req, res) => {
  const { source, destination, service } = req.body;
  try {
    const response = await axios.get(`${baseURL}/securetrack/api/topology/path`, {
      params: { src: source, dst: destination, service },
      headers: { ...getAuthHeaders(), Accept: "application/json" },
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    });
    res.json(response.data);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({
      error: "Failed to query Tufin path API",
      details: err.response?.data || err.message,
    });
  }
});

// Image proxy
app.get("/api/topology-image", async (req, res) => {
  const { source, destination, service } = req.query;
  try {
    const response = await axios.get(`${baseURL}/securetrack/api/topology/path_image`, {
      params: { src: source, dst: destination, service },
      headers: { ...getAuthHeaders(), Accept: "image/png" },
      responseType: "arraybuffer",
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    });
    res.set("Content-Type", "image/png");
    res.send(response.data);
  } catch (err) {
    console.error("Error fetching topology image:", err.response?.data || err.message);
    res.status(500).send("Failed to retrieve topology image");
  }
});

// New: raw data + normalized devices (from device_info)
app.post("/api/topology-path-with-devices", async (req, res) => {
  const { source, destination, service } = req.body;
  try {
    const response = await axios.get(`${baseURL}/securetrack/api/topology/path`, {
      params: { src: source, dst: destination, service },
      headers: { ...getAuthHeaders(), Accept: "application/json" },
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    });

    const raw = response.data;
    const devices = extractDevicesFromPathJson(raw);

    // If still no devices, expose a tiny hint to help debug shapes
    res.json({
      data: raw,
      devices,
      meta: {
        devices_found: devices.length,
      },
    });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({
      error: "Failed to query Tufin path API (with devices)",
      details: err.response?.data || err.message,
    });
  }
});

// Static frontend
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(port, () => {
  console.log(`Tufin Topology GUI running at http://localhost:${port}`);
});
