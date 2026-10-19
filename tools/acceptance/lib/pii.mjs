// Detectors for revealing data (threat model A2/A3: exact location, device identifiers, protected source names).
// Findings carry the path and the kind only, never the matched value, so a leak is not copied into logs or results.

// Keys that must never appear in any API response, event, notification or export.
export const REVEALING_KEYS = new Set([
  "gps", "gps_lat", "gps_lng", "lat", "lng", "lon", "latitude", "longitude", "coordinates", "shot_at",
  "device_id", "device_model", "serial_number", "imei", "idfv", "advertising_id",
  "push_token", "fcm_token", "apns_token",
  "source_name", "protected_source",
]);
// External channels and Outbox payloads additionally carry no contact data (outbox-event.json propertyNames).
export const CHANNEL_KEYS = new Set([...REVEALING_KEYS, "email", "phone"]);

const VALUE_PATTERNS = [
  ["coordinate-pair", /-?\d{1,3}\.\d{4,}\s*[,;/ ]\s*-?\d{1,3}\.\d{4,}/],
  ["iso6709", /[+-]\d{2}(?:\.\d+)?[+-]\d{3}(?:\.\d+)?(?:[+-]\d+(?:\.\d+)?)?\//],
  ["dms", /\d{1,3}°\s*\d{1,2}['′]\s*\d{1,2}(?:\.\d+)?["″]?\s*[NSEW]/i],
  ["geo-uri", /\bgeo:-?\d/i],
  ["exif-gps-tag", /\bGPS(?:Latitude|Longitude|Altitude|Position)\b/i],
  ["apple-model-id", /\biPhone\d{1,2},\d\b/],
  ["samsung-model-id", /\bSM-[A-Z]\d{3,4}[A-Z0-9]*\b/],
  ["quicktime-location", /\bcom\.apple\.quicktime\.(?:location|model)/i],
];

/** Walks any JSON value. opts.keys: a Set of forbidden property names (or false). opts.canaries: literal strings seeded by the test. */
export function scan(value, { keys = REVEALING_KEYS, canaries = [], path = "$" } = {}) {
  const findings = [];
  const walk = (v, p) => {
    if (typeof v === "string") {
      for (const [kind, re] of VALUE_PATTERNS) if (re.test(v)) findings.push({ path: p, kind });
      for (const c of canaries) if (c && v.includes(c)) findings.push({ path: p, kind: "canary" });
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (keys && keys.has(k.toLowerCase())) findings.push({ path: `${p}.${k}`, kind: "forbidden-key" });
        walk(x, `${p}.${k}`);
      }
    } else if (typeof v === "number" || typeof v === "boolean") {
      for (const c of canaries) if (c && String(v) === c) findings.push({ path: p, kind: "canary" });
    }
  };
  walk(value, path);
  return findings;
}
