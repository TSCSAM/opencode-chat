import fsp from "node:fs/promises"
import { ToolError, escapeHtml, resolvePath } from "./core.mjs"
import { fetchJson } from "./http.mjs"

const UA = "OpenCodeChatTools/1.9 (local desktop assistant; contact: localhost)"
const NOMINATIM = "https://nominatim.openstreetmap.org"
const OSRM = "https://router.project-osrm.org"
const OVERPASS = "https://overpass-api.de/api/interpreter"
const WEATHER = "https://api.open-meteo.com/v1/forecast"

async function nominatim(path, params) {
  const query = new URLSearchParams({ format: "jsonv2", addressdetails: "1", ...params }).toString()
  const res = await fetchJson(`${NOMINATIM}${path}?${query}`, {
    headers: { "user-agent": UA, accept: "application/json" },
    timeout: 30_000,
  })
  return res.json
}

export async function geocode(query, options = {}) {
  const rows = await nominatim("/search", { q: String(query), limit: String(options.limit || 5) })
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    displayName: row.display_name,
    lat: Number(row.lat),
    lon: Number(row.lon),
    type: row.type,
    category: row.category,
    importance: row.importance,
    address: row.address,
  }))
}

export async function reverseGeocode(lat, lon) {
  const row = await nominatim("/reverse", { lat: String(lat), lon: String(lon) })
  return row && !row.error ? { displayName: row.display_name, lat: Number(row.lat), lon: Number(row.lon), address: row.address, type: row.type } : null
}

export async function route(args) {
  const points = Array.isArray(args.points) ? args.points : []
  if (points.length < 2) throw new ToolError("route needs at least two points", "BAD_INPUT")
  const coords = points.map((point) => `${Number(point.lon ?? point[0])},${Number(point.lat ?? point[1])}`).join(";")
  const profile = args.profile || "driving"
  const url = `${OSRM}/route/v1/${encodeURIComponent(profile)}/${coords}?overview=full&geometries=geojson&steps=true`
  const { json } = await fetchJson(url, { timeout: 30_000 })
  if (!json.routes?.length) throw new ToolError("no route found", "NOT_FOUND")
  const best = json.routes[0]
  return {
    distanceMeters: best.distance,
    durationSeconds: best.duration,
    legs: best.legs?.map((leg) => ({
      distance: leg.distance,
      duration: leg.duration,
      steps: leg.steps?.map((step) => ({
        instruction: step.maneuver?.instruction || step.name,
        name: step.name,
        distance: step.distance,
        duration: step.duration,
        type: step.maneuver?.type,
        modifier: step.maneuver?.modifier,
      })),
    })),
    geometry: best.geometry,
  }
}

export async function nearby(args) {
  const lat = Number(args.lat)
  const lon = Number(args.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new ToolError("lat and lon are required", "BAD_INPUT")
  const radius = Math.max(50, Math.min(20_000, Number(args.radius || 1000)))
  const category = String(args.category || "restaurant").replace(/["\\]/g, "")
  const tag = category.includes("=") ? category : `amenity=${category}`
  const query = `[out:json][timeout:25];node[${tag}](around:${radius},${lat},${lon});out body 40;`
  const res = await fetchJson(OVERPASS, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA },
    body: `data=${encodeURIComponent(query)}`,
    timeout: 40_000,
  })
  return (res.json.elements || []).map((element) => ({
    id: element.id,
    name: element.tags?.name || "",
    lat: element.lat,
    lon: element.lon,
    tags: element.tags,
  }))
}

export async function weather(args) {
  const lat = Number(args.lat)
  const lon = Number(args.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new ToolError("lat and lon are required", "BAD_INPUT")
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,wind_speed_10m,wind_direction_10m",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_sum,precipitation_probability_max",
    timezone: "auto",
    forecast_days: String(Math.max(1, Math.min(16, Number(args.days || 5)))),
  })
  const { json } = await fetchJson(`${WEATHER}?${params}`, { timeout: 30_000 })
  return {
    latitude: json.latitude,
    longitude: json.longitude,
    timezone: json.timezone,
    current: json.current,
    currentUnits: json.current_units,
    daily: json.daily,
    dailyUnits: json.daily_units,
  }
}

export function timezoneInfo(args) {
  const zone = String(args.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone)
  const date = args.date ? new Date(args.date) : new Date()
  if (Number.isNaN(date.getTime())) throw new ToolError("invalid date", "BAD_INPUT")
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "longOffset",
  })
  return { timezone: zone, local: formatter.format(date), utc: date.toISOString(), parts: formatter.formatToParts(date) }
}

export async function mapHtml(args) {
  const points = Array.isArray(args.points) ? args.points.filter((p) => Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lon))) : []
  if (!points.length) throw new ToolError("points are required", "BAD_INPUT")
  const center = points.length === 1 ? points[0] : { lat: points.reduce((a, p) => a + Number(p.lat), 0) / points.length, lon: points.reduce((a, p) => a + Number(p.lon), 0) / points.length }
  const title = args.title || "Map"
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>html,body,#map{height:100%;margin:0}body{font-family:Segoe UI,Tahoma,sans-serif}.pin{background:#2563eb;color:#fff;border-radius:50%;width:28px;height:28px;display:grid;place-items:center;font-weight:700;border:2px solid white;box-shadow:0 2px 8px #0005}</style>
</head><body><div id="map"></div><script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script><script>
const points = ${JSON.stringify(points)};
const map = L.map('map').setView([${center.lat},${center.lon}], ${Number(args.zoom || 11)});
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap contributors'}).addTo(map);
const markers = [];
points.forEach((p,i)=>{ const m=L.marker([Number(p.lat),Number(p.lon)]).addTo(map); m.bindPopup('<b>'+String(p.name||('Point '+(i+1))).replace(/[<>&]/g,'')+'</b>'); markers.push(m) });
if (markers.length>1) map.fitBounds(L.featureGroup(markers).getBounds().pad(0.15));
</script></body></html>`
  const target = resolvePath(args.output || "map.html", { createParent: true })
  await fsp.writeFile(target, html, "utf8")
  return { path: target, bytes: Buffer.byteLength(html), points: points.length }
}
