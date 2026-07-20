// ============================================================
//  mirror-departures  —  Cloudflare Worker relay for the mirror
// ------------------------------------------------------------
//  Finds the nearest stop to a lat/lon and returns its next
//  departures, using Trafiklab's ResRobot v2.1 API.
//  Also relays Swedish electricity spot prices, live stock
//  prices (via Yahoo Finance), a remote settings store (KV),
//  and a WebRTC signaling relay for the remote camera viewer.
//  Keeps your API key OFF the public web page and adds the
//  CORS headers a browser needs.
//
//  SETUP (one time):
//   1. Get a free key: trafiklab.se -> create account ->
//      "Skapa nytt projekt" -> add API "ResRobot - Reseplaneraren
//      v2.1" -> copy the key.
//   2. Cloudflare: dash.cloudflare.com -> Workers & Pages ->
//      Create -> Create Worker -> name it (e.g. mirror-departures)
//      -> Deploy -> Edit code -> paste THIS file -> Deploy.
//   3. In the Worker: Settings -> Variables -> Add variable
//      name RESROBOT_KEY, value = your key -> Save and deploy.
//   4. Bind a KV namespace called MIRROR_KV to this Worker
//      (Bindings -> Add -> KV Namespace -> name it MIRROR_KV).
//   5. Copy the Worker URL (https://mirror-departures.<you>.workers.dev)
//      into the mirror's "Departures service URL" field.
//
//  The mirror calls:
//    departures:  <worker-url>?lat=57.70&lon=11.96  (opt &id=740025000)
//    electricity: <worker-url>?elpris=SE3
//    stock:       <worker-url>?stock=AAPL&range=1mo&interval=1d
//    config:      <worker-url>?config=get/set&id=main
//    webrtc:      <worker-url>?rtc=sdp|ice|reset&role=offer|answer|mirror|viewer&id=main
// ============================================================

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function cleanId(raw) {
  return (raw || "main").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "main";
}

// ---- abuse guards ----
// The website's live demo talks to this same Worker, so writes are throttled
// to 30/min per client IP via the PUSH_LIMITER ratelimit binding (see
// wrangler.toml). Fails open if the binding is missing.
async function overLimit(request, env) {
  if (!env.PUSH_LIMITER) return false;
  const ip = request.headers.get("CF-Connecting-IP") || "?";
  try {
    const r = await env.PUSH_LIMITER.limit({ key: ip });
    return !r.success;
  } catch (e) {
    return false;
  }
}
function isDemo(id) {
  return id.slice(0, 5) === "demo-";
}
// KV put that reports failure (e.g. daily write quota) as JSON instead of a
// bare Cloudflare 1101 error page.
async function kvPut(env, key, val, opts) {
  try {
    await env.MIRROR_KV.put(key, val, opts);
    return null;
  } catch (e) {
    return json({ error: "relay write failed (daily write limit or storage) — try again later" }, 500);
  }
}

// ---- spend guard ----
// The $5 Workers Paid plan includes, per month: 10M requests, 10M KV reads,
// 1M KV writes. Cloudflare has NO hard billing cap — overages just bill — so
// an hourly cron compares month-to-date usage against these ceilings and cuts
// the workers.dev URL when one is nearly spent. HTTP traffic (and therefore
// billing) stops; the cron keeps running and re-enables the URL when the new
// month's numbers are back under the line.
// Requires two secrets (wrangler secret put): ANALYTICS_TOKEN — an API token
// with Account Analytics:Read + Workers Scripts:Edit; ACCOUNT_ID.
const GUARD = { requests: 9500000, kvReads: 9500000, kvWrites: 950000 };
const SCRIPT_NAME = "still-wave-afbc";
const KV_NAMESPACE_ID = "e1c544641cc943a1b11d7e8f8c6e3ba1";

async function monthUsage(env) {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const q = `query($acc:String!,$since:Time!,$until:Time!,$sinceD:Date!,$untilD:Date!){
    viewer{accounts(filter:{accountTag:$acc}){
      workersInvocationsAdaptive(filter:{scriptName:"${SCRIPT_NAME}",datetime_geq:$since,datetime_leq:$until},limit:1000){sum{requests}}
      kvOperationsAdaptiveGroups(filter:{namespaceId:"${KV_NAMESPACE_ID}",date_geq:$sinceD,date_leq:$untilD},limit:100){sum{requests} dimensions{actionType}}
    }}}`;
  const resp = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { "Authorization": "Bearer " + env.ANALYTICS_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ query: q, variables: {
      acc: env.ACCOUNT_ID,
      since: monthStart, until: now.toISOString(),
      sinceD: monthStart.slice(0, 10), untilD: now.toISOString().slice(0, 10),
    } }),
  });
  const j = await resp.json();
  const acct = j && j.data && j.data.viewer && j.data.viewer.accounts && j.data.viewer.accounts[0];
  if (!acct) throw new Error("analytics query failed: " + JSON.stringify(j && j.errors));
  const requests = (acct.workersInvocationsAdaptive || []).reduce((s, r) => s + (r.sum ? r.sum.requests : 0), 0);
  let kvReads = 0, kvWrites = 0;
  for (const g of acct.kvOperationsAdaptiveGroups || []) {
    const n = g.sum ? g.sum.requests : 0;
    const t = g.dimensions ? g.dimensions.actionType : "";
    if (t === "read" || t === "list") kvReads += n;
    else kvWrites += n; // write + delete both draw from write-class quotas
  }
  return { requests, kvReads, kvWrites };
}

async function setSubdomain(env, enabled) {
  const r = await fetch(
    "https://api.cloudflare.com/client/v4/accounts/" + env.ACCOUNT_ID + "/workers/scripts/" + SCRIPT_NAME + "/subdomain",
    { method: "POST",
      headers: { "Authorization": "Bearer " + env.ANALYTICS_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: enabled }) });
  return r.ok;
}

async function runSpendGuard(env) {
  const u = await monthUsage(env);
  const over = u.requests > GUARD.requests || u.kvReads > GUARD.kvReads || u.kvWrites > GUARD.kvWrites;
  const stateKey = "spendguard:disabled";
  const disabled = await env.MIRROR_KV.get(stateKey);
  if (over && !disabled) {
    await setSubdomain(env, false);
    await env.MIRROR_KV.put(stateKey, JSON.stringify({ at: new Date().toISOString(), usage: u }));
  } else if (!over && disabled) {
    await setSubdomain(env, true);
    await env.MIRROR_KV.delete(stateKey);
  }
  return { usage: u, over: over, disabled: !!disabled };
}

export default {
  async scheduled(event, env, ctx) {
    if (!env.ANALYTICS_TOKEN || !env.ACCOUNT_ID) return; // guard not configured yet
    ctx.waitUntil(runSpendGuard(env).catch(() => {}));
  },

  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    // Spend-guard status page: <worker-url>?guard=1 shows month-to-date usage
    // vs the cut-off ceilings (read-only aggregates, nothing sensitive).
    if (new URL(request.url).searchParams.get("guard")) {
      if (!env.ANALYTICS_TOKEN || !env.ACCOUNT_ID) return json({ error: "spend guard not configured (missing ANALYTICS_TOKEN / ACCOUNT_ID secrets)" }, 500);
      try {
        const s = await runSpendGuard(env);
        return json({ usage: s.usage, ceilings: GUARD, urlDisabled: s.over });
      } catch (e) {
        return json({ error: String(e && e.message || e) }, 502);
      }
    }

    const url = new URL(request.url);

    // ---- Remote settings store (Cloudflare KV) ----
    //  get:  <worker-url>?config=get&id=main
    //  set:  POST <worker-url>?config=set&id=main   (body = settings JSON)
    //  Requires a KV namespace bound to this Worker as MIRROR_KV.
    const cfg = url.searchParams.get("config");
    if (cfg) {
      const id = cleanId(url.searchParams.get("id"));
      const kvKey = "cfg:" + id;
      if (!env.MIRROR_KV) return json({ error: "Worker missing MIRROR_KV namespace binding" }, 500);
      if (cfg === "set") {
        if (request.method !== "POST") return json({ error: "use POST for config=set" }, 405);
        if (await overLimit(request, env)) return json({ error: "too many pushes from this connection — wait a minute" }, 429);
        const bodyText = await request.text();
        const demo = isDemo(id);
        // Demo mirrors get the same 200 KB budget as real ones (the hourly
        // spend guard is the cost backstop) but still self-delete after an hour.
        if (bodyText.length > 200000) {
          return json({ error: "config too large (200 KB max)" }, 413);
        }
        try { JSON.parse(bodyText); } catch (e) { return json({ error: "body must be JSON" }, 400); }
        const err = await kvPut(env, kvKey, bodyText, demo ? { expirationTtl: 3600 } : undefined);
        if (err) return err;
        return json({ ok: true, id: id });
      }
      const stored = await env.MIRROR_KV.get(kvKey);
      return new Response(stored || "{}", { headers: { "Content-Type": "application/json", ...CORS } });
    }

    // ---- WebRTC signaling relay (for the remote camera viewer) ----
    //  This never sees or stores video — only the small text blobs (SDP offer/
    //  answer + ICE candidates) needed for two browsers to find each other and
    //  open a direct peer-to-peer connection. Video streams device-to-device.
    //
    //  offer/answer:  GET/POST <worker-url>?rtc=sdp&role=offer|answer&id=main
    //                 POST body = {type, sdp, _ts}
    //  ice candidates: POST <worker-url>?rtc=ice&role=mirror|viewer&id=main   (body = one RTCIceCandidate)
    //                  GET  <worker-url>?rtc=ice&role=mirror|viewer&id=main&since=0
    //  reset:         POST <worker-url>?rtc=reset&id=main   (clears old signaling state before a fresh call)
    const rtc = url.searchParams.get("rtc");
    if (rtc) {
      const id = cleanId(url.searchParams.get("id"));
      if (!env.MIRROR_KV) return json({ error: "Worker missing MIRROR_KV namespace binding" }, 500);
      const role = url.searchParams.get("role");
      const TTL = 600; // signaling data auto-expires after 10 minutes either way

      if (rtc === "reset") {
        if (request.method !== "POST") return json({ error: "use POST for rtc=reset" }, 405);
        await Promise.all([
          env.MIRROR_KV.delete("rtc:" + id + ":offer"),
          env.MIRROR_KV.delete("rtc:" + id + ":answer"),
          env.MIRROR_KV.delete("rtc:" + id + ":ice:mirror"),
          env.MIRROR_KV.delete("rtc:" + id + ":ice:viewer"),
        ]);
        return json({ ok: true });
      }

      if (rtc === "sdp") {
        if (role !== "offer" && role !== "answer") return json({ error: "role must be offer or answer" }, 400);
        const key = "rtc:" + id + ":" + role;
        if (request.method === "POST") {
          if (await overLimit(request, env)) return json({ error: "too many requests — wait a minute" }, 429);
          const bodyText = await request.text();
          if (bodyText.length > 20000) return json({ error: "sdp too large" }, 413);
          try { JSON.parse(bodyText); } catch (e) { return json({ error: "body must be JSON" }, 400); }
          const err = await kvPut(env, key, bodyText, { expirationTtl: TTL });
          if (err) return err;
          return json({ ok: true });
        }
        const stored = await env.MIRROR_KV.get(key);
        return new Response(stored || "null", { headers: { "Content-Type": "application/json", ...CORS } });
      }

      if (rtc === "ice") {
        if (role !== "mirror" && role !== "viewer") return json({ error: "role must be mirror or viewer" }, 400);
        const key = "rtc:" + id + ":ice:" + role;
        if (request.method === "POST") {
          if (await overLimit(request, env)) return json({ error: "too many requests — wait a minute" }, 429);
          const bodyText = await request.text();
          if (bodyText.length > 5000) return json({ error: "candidate too large" }, 413);
          let cand;
          try { cand = JSON.parse(bodyText); } catch (e) { return json({ error: "body must be JSON" }, 400); }
          const existingText = await env.MIRROR_KV.get(key);
          const list = existingText ? JSON.parse(existingText) : [];
          list.push(cand);
          if (list.length > 60) list.splice(0, list.length - 60);
          const err = await kvPut(env, key, JSON.stringify(list), { expirationTtl: TTL });
          if (err) return err;
          return json({ ok: true, count: list.length });
        }
        const since = parseInt(url.searchParams.get("since") || "0", 10) || 0;
        const existingText = await env.MIRROR_KV.get(key);
        const list = existingText ? JSON.parse(existingText) : [];
        return json({ candidates: list.slice(since), total: list.length });
      }

      return json({ error: "unknown rtc action" }, 400);
    }

    // ---- Electricity price branch (Swedish spot prices, no key needed) ----
    const elpris = url.searchParams.get("elpris");
    if (elpris) {
      const zone = /^SE[1-4]$/.test(elpris) ? elpris : "SE3";
      try {
        function priceUrl(d) {
          const y = d.getFullYear();
          const m = String(d.getMonth() + 1).padStart(2, "0");
          const day = String(d.getDate()).padStart(2, "0");
          return "https://www.elprisetjustnu.se/api/v1/prices/" +
            y + "/" + m + "-" + day + "_" + zone + ".json";
        }
        const today = new Date();
        const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
        const arr = await fetch(priceUrl(today)).then((r) => r.json());
        let tomorrowArr = [];
        try {
          const t = await fetch(priceUrl(tomorrow)).then((r) => r.json());
          if (Array.isArray(t)) tomorrowArr = t;
        } catch (e) { /* tomorrow's prices aren't published yet (~before 13:00) */ }
        const all = arr.concat(tomorrowArr);
        const now = Date.now();
        let cur = null;
        const vals = [];
        for (const e of arr) {
          vals.push(e.SEK_per_kWh);
          const s = Date.parse(e.time_start), en = Date.parse(e.time_end);
          if (now >= s && now < en) cur = e;
        }
        if (!cur) cur = arr[today.getHours()] || arr[arr.length - 1];
        const min = Math.min.apply(null, vals);
        const max = Math.max.apply(null, vals);

        // average the (possibly 15-min) slots into hourly buckets, then
        // keep the current hour onward, capped to the next 24 hours
        const buckets = {};
        for (const e of all) {
          const startMs = Date.parse(e.time_start);
          const hourMs = Math.floor(startMs / 3600000) * 3600000;
          (buckets[hourMs] = buckets[hourMs] || []).push(e.SEK_per_kWh);
        }
        const nowHourMs = Math.floor(now / 3600000) * 3600000;
        const series = Object.keys(buckets)
          .map((k) => parseInt(k, 10))
          .filter((k) => k >= nowHourMs)
          .sort((a, b) => a - b)
          .slice(0, 24)
          .map((k) => {
            const list = buckets[k];
            const avg = list.reduce((a, b) => a + b, 0) / list.length;
            return { t: k, v: avg };
          });

        return json({ price: cur ? cur.SEK_per_kWh : null, min: min, max: max, zone: zone, series: series });
      } catch (e) {
        return json({ error: "price fetch failed: " + (e && e.message ? e.message : String(e)) }, 502);
      }
    }

    // ---- Stock price branch (Yahoo Finance, no key needed) ----
    const stock = url.searchParams.get("stock");
    if (stock) {
      const range = url.searchParams.get("range") || "1mo";
      const interval = url.searchParams.get("interval") || "1d";
      const yurl =
        "https://query1.finance.yahoo.com/v8/finance/chart/" +
        encodeURIComponent(stock) +
        "?range=" + encodeURIComponent(range) +
        "&interval=" + encodeURIComponent(interval);
      try {
        const resp = await fetch(yurl, {
          headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
        });
        const j = await resp.json();
        const r = j && j.chart && j.chart.result && j.chart.result[0];
        if (!r) {
          const msg = (j && j.chart && j.chart.error && j.chart.error.description) || ("no data for " + stock);
          return json({ message: msg });
        }
        const meta = r.meta || {};
        const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
        const rawC = q.close || [];
        const rawT = r.timestamp || [];
        const closes = [], t = [];
        for (let i = 0; i < rawC.length; i++) {
          if (rawC[i] != null) { closes.push(rawC[i]); t.push(rawT[i] != null ? rawT[i] : null); }
        }
        return json({
          symbol: (meta.symbol || stock).toUpperCase(),
          price: meta.regularMarketPrice != null
            ? meta.regularMarketPrice
            : (closes.length ? closes[closes.length - 1] : null),
          prevClose: meta.chartPreviousClose != null
            ? meta.chartPreviousClose
            : (closes.length ? closes[0] : null),
          closes: closes,
          t: t,
        });
      } catch (e) {
        return json({ message: "stock fetch failed: " + (e && e.message ? e.message : String(e)) });
      }
    }

    const key = env.RESROBOT_KEY;
    if (!key) return json({ error: "Worker missing RESROBOT_KEY variable" }, 500);

    const lat = url.searchParams.get("lat");
    const lon = url.searchParams.get("lon");
    let id = url.searchParams.get("id");
    let stopName = "";
    let resolvedId = null; // only set when we had to resolve nearby-by-coords this call

    try {
      // 1) If no explicit stop, find the nearest one to the coordinates.
      //    The caller SHOULD cache the returned extId and pass &id= on
      //    future requests - ResRobot's whole key shares ONE monthly quota
      //    across nearbystops/departureBoard/location.name (confirmed via
      //    diagnostics 2026-07-20: identical hardQuota/requestCounter on
      //    both endpoints), and re-resolving by coordinates on every poll
      //    burns through it in days instead of the full month.
      if (!id) {
        if (!lat || !lon) return json({ error: "lat/lon required" }, 400);
        const nsUrl =
          "https://api.resrobot.se/v2.1/location.nearbystops" +
          "?originCoordLat=" + encodeURIComponent(lat) +
          "&originCoordLong=" + encodeURIComponent(lon) +
          "&maxNo=1&r=2000&format=json&accessId=" + key;
        const ns = await fetch(nsUrl).then((r) => r.json());
        const list = ns.stopLocationOrCoordLocation || [];
        const sl = list.length ? list[0].StopLocation : null;
        if (sl) {
          id = sl.extId || sl.id;
          stopName = sl.name || "";
        }
        if (!id) {
          const code = ns.errorCode ? " (" + ns.errorCode + ")" : "";
          return json({ error: "no stop found nearby" + code }, 404);
        }
        resolvedId = id;
      }

      // 2) Departures for that stop.
      const dbUrl =
        "https://api.resrobot.se/v2.1/departureBoard" +
        "?id=" + encodeURIComponent(id) +
        "&duration=120&maxJourneys=10&format=json&accessId=" + key;
      const db = await fetch(dbUrl).then((r) => r.json());

      const departures = (db.Departure || []).slice(0, 8).map((d) => {
        const p = (d.Product && d.Product[0]) || {};
        const hay = (
          (p.catOutL || "") + " " + (p.catOut || "") + " " +
          (p.name || "") + " " + (d.name || "")
        ).toLowerCase();
        let mode = "other";
        if (/spårväg|tram/.test(hay)) mode = "tram";
        else if (/tunnelbana|metro|subway/.test(hay)) mode = "metro";
        else if (/båt|färja|ferry|boat/.test(hay)) mode = "boat";
        else if (/tåg|train|pendel|rail/.test(hay)) mode = "train";
        else if (/buss|bus/.test(hay)) mode = "bus";
        return {
          line:
            (p.line) || d.transportNumber || d.name || "",
          dir: (d.direction || "").replace(/\s*\([^)]*\)\s*$/, "").trim(),
          time: (d.rtTime || d.time || "").slice(0, 5), // HH:MM, realtime if available
          date: d.rtDate || d.date || "",
          mode: mode,
        };
      });

      if (!stopName && db.Departure && db.Departure[0]) {
        stopName = db.Departure[0].stop || "";
      }
      // trim a trailing area suffix like "(Göteborg)" for a cleaner label
      stopName = stopName.replace(/\s*\([^)]*\)\s*$/, "").trim();

      return json({ stop: stopName, departures, extId: resolvedId });
    } catch (e) {
      return json({ error: "fetch failed: " + (e && e.message ? e.message : String(e)) }, 502);
    }
  },
};
