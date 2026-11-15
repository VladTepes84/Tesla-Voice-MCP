// Split a road geometry into bounded geographic windows instead of querying one
// giant country-scale rectangle. Works across borders; independent of country.
const RAD = Math.PI / 180;
const valid = (value, a, b) => Number.isFinite(value) && value >= a && value <= b;
function distanceKm(a, b) {
  const dLat = (b[1] - a[1]) * RAD;
  const dLon = (b[0] - a[0]) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function chargingCorridorQuery(line, { segmentKm = 35, maxWindows = 16, corridorKm = 2.2 } = {}) {
  if (!Array.isArray(line) || line.length < 2 || line.length > 30000 ||
      !line.every(p => Array.isArray(p) && p.length === 2 && valid(p[0], -180, 180) && valid(p[1], -90, 90)) ||
      !valid(segmentKm, 10, 100) || !Number.isInteger(maxWindows) || maxWindows < 1 || maxWindows > 32 ||
      !valid(corridorKm, 2, 5)) throw Error('invalid_map_arguments');
  const windows = [];
  let traveled = 0;
  const add = (p, offset) => {
    const index = Math.floor(Math.max(0, offset - 1e-8) / segmentKm);
    if (!windows[index]) windows[index] = { south: p[1], north: p[1], west: p[0], east: p[0] };
    const w = windows[index];
    w.south = Math.min(w.south, p[1]); w.north = Math.max(w.north, p[1]);
    w.west = Math.min(w.west, p[0]); w.east = Math.max(w.east, p[0]);
  };
  add(line[0], 0);
  for (let i = 1; i < line.length; i++) {
    const from = line[i - 1], to = line[i];
    const length = distanceKm(from, to);
    // 5-km interpolation also covers simplified geometry with very long edges.
    const steps = Math.max(1, Math.ceil(length / 5));
    for (let j = 1; j <= steps; j++) {
      const t = j / steps;
      add([from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t], traveled + length * t);
    }
    traveled += length;
  }
  const filled = windows.filter(Boolean);
  // Never silently claim complete coverage if the request exceeds our budget.
  const selected = filled.length <= maxWindows ? filled :
    (maxWindows === 1 ? [filled[Math.floor((filled.length - 1) / 2)]] :
      Array.from({ length: maxWindows }, (_, i) => filled[Math.floor(i * (filled.length - 1) / (maxWindows - 1))]));
  const bounded = selected.map(w => {
    const marginLat = corridorKm / 111.2;
    const midLat = (w.south + w.north) / 2;
    const marginLon = corridorKm / (111.2 * Math.max(0.1, Math.cos(midLat * RAD)));
    return [Math.max(-90, w.south - marginLat), Math.max(-180, w.west - marginLon),
      Math.min(90, w.north + marginLat), Math.min(180, w.east + marginLon)].map(x => Number(x.toFixed(6)));
  });
  if (!bounded.length) throw Error('invalid_map_arguments');
  const filters = bounded.map(b => `nwr[amenity=charging_station]["socket:type2_combo"](${b.join(',')});`).join('');
  return {
    query: `[out:json][timeout:6];(${filters});out center 500;`,
    coverage: { corridor_metres: 2000, route_length_estimated_km: Math.round(traveled),
      queried_windows: bounded.length, total_windows: filled.length, complete: filled.length <= maxWindows }
  };
}
