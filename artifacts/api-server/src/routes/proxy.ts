import { Router } from "express";

const router = Router();

const ADSB_BASE = "https://api.adsb.lol/v2";

async function fetchAdsb(path: string): Promise<unknown> {
  const res = await fetch(`${ADSB_BASE}${path}`, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "WORLDVIEW/1.0",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw new Error(`adsb.lol returned ${res.status}`);
  }
  return res.json();
}

router.get("/proxy/adsb/mil", async (req, res) => {
  try {
    const data = await fetchAdsb("/mil");
    res.json(data);
  } catch (err: unknown) {
    req.log.error({ err }, "adsb mil proxy error");
    res.status(502).json({ error: "upstream error" });
  }
});

router.get("/proxy/adsb/global", async (req, res) => {
  try {
    const data = await fetchAdsb("/point/0/0/20000");
    res.json(data);
  } catch (err: unknown) {
    req.log.error({ err }, "adsb global proxy error");
    res.status(502).json({ error: "upstream error" });
  }
});

router.get("/proxy/adsb/area", async (req, res) => {
  const lat = parseFloat(req.query["lat"] as string);
  const lon = parseFloat(req.query["lon"] as string);
  const radius = parseInt(req.query["radius"] as string, 10);

  if (isNaN(lat) || isNaN(lon) || isNaN(radius) || radius < 10 || radius > 20000) {
    res.status(400).json({ error: "invalid params: lat, lon, radius (10-20000) required" });
    return;
  }

  const clampedLat = Math.max(-90, Math.min(90, lat));
  const clampedLon = Math.max(-180, Math.min(180, lon));

  try {
    const data = await fetchAdsb(`/point/${clampedLat}/${clampedLon}/${radius}`);
    res.json(data);
  } catch (err: unknown) {
    req.log.error({ err }, "adsb area proxy error");
    res.status(502).json({ error: "upstream error" });
  }
});

// ---------- Satellite TLE proxy (CelesTrak) ----------
//
// We expose a small whitelist of CelesTrak GROUP names so the frontend can
// fetch raw TLE text without running into CORS. Responses are cached in
// memory for an hour because TLE updates are slow-moving.

const CELESTRAK_TLE = "https://celestrak.org/NORAD/elements/gp.php";
const TLE_GROUPS = new Set([
  "active",        // catch-all civilian
  "military",      // military / spy
  "stations",      // ISS + crewed
  "starlink",      // comms
  "geo",           // geostationary comms
  "weather",       // earth-observation weather
  "resource",      // earth-observation imaging (often disguises mil/dual-use)
  "spire",         // earth-observation
  "planet",        // earth-observation
  "radar",         // SAR / radar imaging (RISAT, SAR-LUPE, COSMO-SKYMED…)
  "gnss",          // navigation: GPS, GLONASS, BEIDOU, GALILEO (CelesTrak's combined name)
]);

interface TleCacheEntry { text: string; fetchedAt: number; }
const tleCache: Map<string, TleCacheEntry> = new Map();
const TLE_TTL_MS = 60 * 60 * 1000;

router.get("/proxy/satellites/:group", async (req, res) => {
  const group = String(req.params["group"] || "").toLowerCase();
  if (!TLE_GROUPS.has(group)) {
    res.status(400).json({ error: "unknown group" });
    return;
  }
  const cached = tleCache.get(group);
  if (cached && Date.now() - cached.fetchedAt < TLE_TTL_MS) {
    res.type("text/plain").send(cached.text);
    return;
  }
  try {
    const url = `${CELESTRAK_TLE}?GROUP=${encodeURIComponent(group)}&FORMAT=tle`;
    const upstream = await fetch(url, {
      headers: { "User-Agent": "WORLDVIEW/1.0" },
      signal: AbortSignal.timeout(20000),
    });
    if (!upstream.ok) throw new Error(`celestrak ${upstream.status}`);
    const text = await upstream.text();
    tleCache.set(group, { text, fetchedAt: Date.now() });
    res.type("text/plain").send(text);
  } catch (err: unknown) {
    req.log.error({ err, group }, "satellite tle proxy error");
    if (cached) {
      // serve stale on error
      res.type("text/plain").send(cached.text);
      return;
    }
    res.status(502).json({ error: "upstream error" });
  }
});

// ---------- Nominatim region boundary proxy ----------
//
// Fetches a polygon GeoJSON for a named region (country, strait, city) so the
// frontend can render a tactical boundary without CORS or rate-limit headaches.
// Cached aggressively because boundaries don't change.

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
interface RegionCacheEntry { body: unknown; fetchedAt: number; }
const regionCache: Map<string, RegionCacheEntry> = new Map();
const REGION_TTL_MS = 24 * 60 * 60 * 1000;

router.get("/proxy/region", async (req, res) => {
  const q = String(req.query["q"] || "").trim();
  if (!q || q.length > 120) {
    res.status(400).json({ error: "missing or invalid q" });
    return;
  }
  const key = q.toLowerCase();
  const cached = regionCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < REGION_TTL_MS) {
    res.json(cached.body);
    return;
  }
  try {
    const url = `${NOMINATIM_URL}?q=${encodeURIComponent(q)}&polygon_geojson=1&format=json&limit=1`;
    const upstream = await fetch(url, {
      headers: {
        "Accept": "application/json",
        // Nominatim requires an identifying UA per its usage policy.
        "User-Agent": "WORLDVIEW/1.0 (tactical geospatial demo)",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!upstream.ok) throw new Error(`nominatim ${upstream.status}`);
    const body = await upstream.json();
    regionCache.set(key, { body, fetchedAt: Date.now() });
    res.json(body);
  } catch (err: unknown) {
    req.log.error({ err, q }, "region proxy error");
    if (cached) { res.json(cached.body); return; }
    res.status(502).json({ error: "upstream error" });
  }
});

// ---------- Maritime / ships proxy ----------
//
// Mirrors the FUSED_INTEL/AISSTREAM/MARINETRAFFIC ships radar feed so the
// browser can poll without CORS or upstream rate-limit headaches. We add a
// short in-memory cache because the upstream service is on a free-tier host
// that occasionally cold-starts and takes >5s to respond, and the polling
// interval (5s) would multiply that load.

const SHIPS_URL = "https://ships-faf8.onrender.com/api/radar";
interface ShipsCacheEntry { body: unknown; fetchedAt: number; }
let shipsCache: ShipsCacheEntry | null = null;
const SHIPS_TTL_MS = 4_000; // <5s polling interval, slightly under

router.get("/proxy/ships", async (req, res) => {
  if (shipsCache && Date.now() - shipsCache.fetchedAt < SHIPS_TTL_MS) {
    res.json(shipsCache.body);
    return;
  }
  try {
    const upstream = await fetch(SHIPS_URL, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "WORLDVIEW/1.0",
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!upstream.ok) throw new Error(`ships ${upstream.status}`);
    const body = await upstream.json();
    shipsCache = { body, fetchedAt: Date.now() };
    res.json(body);
  } catch (err: unknown) {
    req.log.error({ err }, "ships proxy error");
    if (shipsCache) {
      // Serve stale rather than failing the radar tick.
      res.json(shipsCache.body);
      return;
    }
    res.status(502).json({ error: "upstream error" });
  }
});

export default router;
