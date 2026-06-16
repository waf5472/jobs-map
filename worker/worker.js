/**
 * jobs-worker — Cloudflare Worker
 * Pulls live listings from JSearch (Google-for-Jobs aggregation: LinkedIn, Indeed,
 * ZipRecruiter, Workday, etc.), normalises them into the schema the map consumes,
 * classifies each into a title "family", dedupes, geocodes any gaps, caches in KV,
 * and serves jobs.json with CORS.
 *
 * Endpoints:
 *   GET /jobs.json            -> cached results (fast, what the map fetches)
 *   GET /jobs.json?refresh=1  -> force a live re-pull (costs API quota)
 *   GET /health               -> {ok, count, updated}
 *   GET /debug                -> one raw JSearch result + field-presence check
 *
 * Also runs on a cron trigger (see wrangler.toml) to refresh the cache nightly.
 *
 * Secrets / bindings (set via wrangler — see README):
 *   JSEARCH_KEY   (secret)  RapidAPI key for JSearch
 *   JOBS_KV       (KV)      cache for results + geocode lookups
 */

// ----------------------------- CONFIG -----------------------------
// Add a state by adding a string. Multi-state = edit this array. That's the whole change.
// Cost scales as TITLES.length * LOCATIONS.length * NUM_PAGES API calls per refresh.
const LOCATIONS = ["Massachusetts"]; // e.g. ["Massachusetts","New Hampshire","Rhode Island","Connecticut"]

// Each title: the search phrase (q), the family it maps to (fam), and a relevance
// regex the returned job_title must match (gates out JSearch's loose free-text noise).
const TITLES = [
  { q: "Senior NPI Engineer",                  fam: "npi", rx: /\bnpi\b|new product introduction/i },
  { q: "Senior NPI Manufacturing Engineer",    fam: "npi", rx: /\bnpi\b|new product introduction/i },
  { q: "Senior Hardware Engineer",             fam: "hw",  rx: /hardware (design|engineer)|electrical engineer/i },
  { q: "Senior Product Development Engineer",  fam: "pde", rx: /product development engineer|r&?d engineer/i },
  { q: "Staff Manufacturing Engineer",         fam: "mfg", rx: /manufacturing engineer|mfg engineer/i },
  { q: "Senior Manufacturing Engineer",        fam: "mfg", rx: /manufacturing engineer|mfg engineer/i },
  { q: "Senior Supplier Quality Engineer",     fam: "sup", rx: /supplier (quality|development|engineer)/i },
  { q: "NPI Program Manager",                  fam: "ppm", rx: /(npi|product|program).*manager|manager.*(npi|program)|sourcing manager/i },
  { q: "Manufacturing Engineering Manager",    fam: "mgr", rx: /(manufacturing|engineering) manager/i },
];

const NUM_PAGES   = 3;        // JSearch pages per query (10 results/page). Raise for depth, costs quota.
const DATE_POSTED = "month";  // all | today | 3days | week | month
const COUNTRY     = "us";
const CACHE_TTL_S = 60 * 60 * 24; // serve cache up to 24h
const KEY_RESULTS = "results:current";
// ------------------------------------------------------------------

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

import project from "../project.json";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    // Portfolio schema doc (read cross-origin by the portfolio site)
    if (url.pathname === "/project.json") {
      return new Response(JSON.stringify(project), {
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/health") {
      const blob = await readCache(env);
      return json({ ok: true, count: blob ? blob.jobs.length : 0, updated: blob ? blob.updated : null });
    }

    if (url.pathname === "/debug") {
      // Hit /debug after deploying to verify JSearch field names match normalize()
      if (!env.JSEARCH_KEY) return json({ error: "JSEARCH_KEY secret not set" });
      try {
        const data = await jsearch(env, `${TITLES[0].q} in ${LOCATIONS[0]}`, 1);
        const sample = data?.data?.[0] ?? null;
        // These are the fields normalize() relies on — all should show true
        const fieldCheck = sample ? {
          job_id:                     sample.job_id !== undefined,
          employer_name:              sample.employer_name !== undefined,
          job_title:                  sample.job_title !== undefined,
          job_city:                   sample.job_city !== undefined,
          job_state:                  sample.job_state !== undefined,
          job_latitude:               sample.job_latitude !== undefined,
          job_longitude:              sample.job_longitude !== undefined,
          job_apply_link:             sample.job_apply_link !== undefined,
          job_google_link:            sample.job_google_link !== undefined,
          job_publisher:              sample.job_publisher !== undefined,
          job_posted_at_timestamp:    sample.job_posted_at_timestamp !== undefined,
          job_posted_at_datetime_utc: sample.job_posted_at_datetime_utc !== undefined,
        } : null;
        return json({
          query: `${TITLES[0].q} in ${LOCATIONS[0]}`,
          api_status: data?.status,
          result_count: data?.data?.length ?? 0,
          fieldCheck,
          sample,
        });
      } catch (e) {
        return json({ error: String(e) });
      }
    }

    // Dynamic search — called by the live map UI
    // GET /search?q=Senior+NPI+Engineer,Staff+Mfg+Engineer&states=Massachusetts,New+Hampshire
    if (url.pathname === "/search") {
      if (!env.JSEARCH_KEY) return json({ error: "JSEARCH_KEY secret not set" });
      const qParam = (url.searchParams.get("q") || "").trim();
      const statesParam = (url.searchParams.get("states") || "").trim();
      if (!qParam || !statesParam) {
        return json({ error: "Required: q (comma-sep titles), states (comma-sep state names)" });
      }
      const titles = qParam.split(",").map(t => t.trim()).filter(Boolean).slice(0, 10);
      const states = statesParam.split(",").map(s => s.trim()).filter(Boolean);
      const pages  = Math.min(parseInt(url.searchParams.get("pages") || "3"), 3);

      // Cache key — sorted so order doesn't affect cache hits
      const ck = "srch:" + titles.slice().sort().join("|") + "@" + states.slice().sort().join("|") + ":" + pages;
      const cacheKey = ck.slice(0, 512);
      const cached = await env.JOBS_KV.get(cacheKey);
      if (cached && url.searchParams.get("refresh") !== "1") return json(JSON.parse(cached));

      const seen = new Map();
      for (const state of states) {
        for (const title of titles) {
          for (let page = 1; page <= pages; page++) {
            try {
              const data = await jsearch(env, `${title} in ${state}`, page);
              const rows = data?.data || [];
              for (const r of rows) {
                const id = r.job_id || `${r.employer_name}|${r.job_title}|${r.job_city}`;
                if (seen.has(id)) continue;
                if (!inTargetState(r, state)) continue;
                const norm = await normalizeOpen(r, title, env);
                if (norm) seen.set(id, norm);
              }
            } catch (e) {
              console.log("search error", title, state, page, String(e));
            }
          }
        }
      }
      const jobs = [...seen.values()].sort((a, b) => (b.posted || 0) - (a.posted || 0));
      const blob = { updated: new Date().toISOString(), count: jobs.length, jobs };
      await env.JOBS_KV.put(cacheKey, JSON.stringify(blob), { expirationTtl: 60 * 60 }); // 1h cache
      return json(blob);
    }

    if (url.pathname === "/jobs.json") {
      if (url.searchParams.get("refresh") === "1") {
        const blob = await refresh(env);
        return json(blob);
      }
      let blob = await readCache(env);
      if (!blob) blob = await refresh(env); // cold cache
      return json(blob);
    }

    // Everything else → the static map UI (public/index.html via the assets binding).
    return env.ASSETS.fetch(request);
  },

  // Cron trigger -> nightly refresh
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refresh(env));
  },
};

// --------------------------- core ---------------------------------
async function refresh(env) {
  const seen = new Map(); // job_id -> normalised job (dedupe)
  for (const loc of LOCATIONS) {
    for (const t of TITLES) {
      for (let page = 1; page <= NUM_PAGES; page++) {
        let data;
        try {
          data = await jsearch(env, `${t.q} in ${loc}`, page);
        } catch (e) {
          // soft-fail one query, keep going
          console.log("jsearch error", t.q, loc, page, String(e));
          continue;
        }
        const rows = (data && data.data) || [];
        for (const r of rows) {
          const id = r.job_id || `${r.employer_name}|${r.job_title}|${r.job_city}`;
          if (seen.has(id)) continue;
          // relevance gate: title must look like the family we asked for
          if (t.rx && !t.rx.test(r.job_title || "")) continue;
          // location gate: keep only target states (JSearch leaks nearby/remote)
          if (!inTargetState(r, loc)) continue;
          const norm = await normalize(r, t.fam, env);
          if (norm) seen.set(id, norm);
        }
      }
    }
  }
  const jobs = [...seen.values()].sort((a, b) => (b.posted || 0) - (a.posted || 0));
  const blob = { updated: new Date().toISOString(), count: jobs.length, jobs };
  await env.JOBS_KV.put(KEY_RESULTS, JSON.stringify(blob), { expirationTtl: CACHE_TTL_S * 2 });
  return blob;
}

async function jsearch(env, query, page) {
  const u = new URL("https://jsearch.p.rapidapi.com/search");
  u.searchParams.set("query", query);
  u.searchParams.set("page", String(page));
  u.searchParams.set("num_pages", "1");
  u.searchParams.set("country", COUNTRY);
  u.searchParams.set("date_posted", DATE_POSTED);
  const res = await fetch(u, {
    headers: {
      "X-RapidAPI-Key": env.JSEARCH_KEY,
      "X-RapidAPI-Host": "jsearch.p.rapidapi.com",
    },
  });
  if (!res.ok) throw new Error(`JSearch ${res.status}`);
  return res.json();
}

async function normalize(r, fam, env) {
  const town = r.job_city || r.job_state || "";
  const state = r.job_state || "";
  let lat = numOrNull(r.job_latitude);
  let lng = numOrNull(r.job_longitude);
  if (lat == null || lng == null) {
    const g = await geocode(env, [r.job_city, r.job_state].filter(Boolean).join(", "));
    if (g) { lat = g.lat; lng = g.lng; }
  }
  if (lat == null || lng == null) return null; // can't place it -> drop
  return {
    co: r.employer_name || "Unknown",
    ti: r.job_title || "",
    town, state,
    fam,
    url: r.job_apply_link || r.job_google_link || "",
    publisher: r.job_publisher || "",
    posted: r.job_posted_at_timestamp || (r.job_posted_at_datetime_utc ? Date.parse(r.job_posted_at_datetime_utc) / 1000 : null),
    lat, lng,
  };
}

// normalize() variant for /search — no fam/rx, stores the title query that found it
async function normalizeOpen(r, titleQuery, env) {
  const town = r.job_city || "";
  const state = r.job_state || "";
  let lat = numOrNull(r.job_latitude);
  let lng = numOrNull(r.job_longitude);
  if (lat == null || lng == null) {
    const g = await geocode(env, [r.job_city, r.job_state].filter(Boolean).join(", "));
    if (g) { lat = g.lat; lng = g.lng; }
  }
  if (lat == null || lng == null) return null;
  return {
    co: r.employer_name || "Unknown",
    ti: r.job_title || "",
    town, state,
    query: titleQuery,         // which search title found this job
    url: r.job_apply_link || r.job_google_link || "",
    publisher: r.job_publisher || "",
    posted: r.job_posted_at_timestamp ||
      (r.job_posted_at_datetime_utc ? Date.parse(r.job_posted_at_datetime_utc) / 1000 : null),
    lat, lng,
  };
}

// keep only jobs whose state matches the location we searched (name or 2-letter)
function inTargetState(r, loc) {
  const st = (r.job_state || "").toLowerCase();
  const L = loc.toLowerCase();
  if (!st) return true; // some rows omit state; let geocode/relevance handle it
  return L.includes(st) || st.includes(L) || st === stateAbbr(L);
}

// ------------------------ geocode (cached) ------------------------
// Fallback only — most JSearch rows already carry coordinates.
// Uses OpenStreetMap Nominatim (no key). Cached in KV so each "City, ST" hits once.
async function geocode(env, place) {
  if (!place) return null;
  const ck = "geo:" + place.toLowerCase();
  const hit = await env.JOBS_KV.get(ck);
  if (hit) return JSON.parse(hit);
  try {
    const u = new URL("https://nominatim.openstreetmap.org/search");
    u.searchParams.set("q", place + ", USA");
    u.searchParams.set("format", "json");
    u.searchParams.set("limit", "1");
    const res = await fetch(u, { headers: { "User-Agent": "jobs-worker/1.0 (personal job map)" } });
    const arr = await res.json();
    if (arr && arr[0]) {
      const g = { lat: parseFloat(arr[0].lat), lng: parseFloat(arr[0].lon) };
      await env.JOBS_KV.put(ck, JSON.stringify(g), { expirationTtl: 60 * 60 * 24 * 90 });
      return g;
    }
  } catch (e) { console.log("geocode error", place, String(e)); }
  return null;
}

// ------------------------- helpers --------------------------------
async function readCache(env) {
  const s = await env.JOBS_KV.get(KEY_RESULTS);
  return s ? JSON.parse(s) : null;
}
function json(obj) {
  return new Response(JSON.stringify(obj), {
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=900", ...CORS },
  });
}
function numOrNull(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : null; }
function stateAbbr(name) {
  const m = {
    "massachusetts":"ma","new hampshire":"nh","rhode island":"ri","connecticut":"ct",
    "maine":"me","vermont":"vt","new york":"ny","new jersey":"nj","pennsylvania":"pa",
    "california":"ca","texas":"tx","florida":"fl","ohio":"oh","michigan":"mi",
    "illinois":"il","georgia":"ga","north carolina":"nc","virginia":"va",
    "washington":"wa","oregon":"or","colorado":"co","arizona":"az","minnesota":"mn",
  }; // extend as you add states
  return m[name] || name;
}
