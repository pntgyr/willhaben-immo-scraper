#!/usr/bin/env node
/**
 * Willhaben scraper — Node.js / Playwright
 * Reads structured data from __NEXT_DATA__ (no DOM/regex hacks).
 * Paginates until all results fetched.
 * Usage: node run.js [output.html]
 */
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

// ── URL BUILDER ──────────────────────────────────────────────────────────────
const URL_BUILDER = {
  BASE: "https://www.willhaben.at/iad/immobilien/mietwohnungen/mietwohnung-angebote",
  SF_ID: "708523b4-b275-481f-be91-9412fa087f2b",
  AREA_IDS: [
    117224, 117225, 117226, 117227, 117228, 117229, 117230,
    117232, 117236, 117237, 117238, 117239, 117240, 117242,
  ],
  ROOMS_BUCKET: "3X3",  // "2X2" | "3X3" | "4X4" | null
  PRICE_FROM: null,
  PRICE_TO: 1700,
  AREA_FROM: 72,        // m²
  AREA_TO: null,
  ROWS_PER_PAGE: 30,

  // Server-side feature filters (willhaben ESTATE_PREFERENCE param)
  // Set to true to only fetch ads that have this feature tagged.
  // Note: willhaben only tags ads where sellers explicitly selected the feature.
  // Ads without the tag may still mention it in the description.
  REQUIRE_KELLER: false,       // ESTATE_PREFERENCE=250
  REQUIRE_ABSTELLRAUM: false,  // ESTATE_PREFERENCE=24
  // Outdoor: list any of: "balkon" | "loggia" | "terrasse" | "dachterrasse"
  // Server returns ads that have ANY of the listed types.
  REQUIRE_OUTDOOR: [],         // e.g. ["balkon","loggia"] — FREE_AREA/FREE_AREA_TYPE
};

// Your private gist ID — safe to commit (requires token to read/write)
const GIST_ID = "4843112327aea1ad3adeedb0578607f1";

const OUTDOOR_CODES = { balkon: 20, loggia: 30, terrasse: 10, dachterrasse: 40 };

const buildSearchUrl = (b = URL_BUILDER, page = 1) => {
  const p = new URLSearchParams({
    sfId: b.SF_ID,
    isNavigation: "true",
    rows: b.ROWS_PER_PAGE,
    page,
  });
  for (const id of b.AREA_IDS) p.append("areaId", id);
  if (b.ROOMS_BUCKET) p.append("NO_OF_ROOMS_BUCKET", b.ROOMS_BUCKET);
  if (b.PRICE_FROM != null) p.append("PRICE_FROM", b.PRICE_FROM);
  if (b.PRICE_TO != null) p.append("PRICE_TO", b.PRICE_TO);
  if (b.AREA_FROM != null) p.append("ESTATE_SIZE/LIVING_AREA_FROM", b.AREA_FROM);
  if (b.AREA_TO != null) p.append("ESTATE_SIZE/LIVING_AREA_TO", b.AREA_TO);
  if (b.REQUIRE_KELLER) p.append("ESTATE_PREFERENCE", 250);
  if (b.REQUIRE_ABSTELLRAUM) p.append("ESTATE_PREFERENCE", 24);
  for (const name of (b.REQUIRE_OUTDOOR || [])) {
    const code = OUTDOOR_CODES[name.toLowerCase()];
    if (code) p.append("FREE_AREA/FREE_AREA_TYPE", code);
  }
  return `${b.BASE}?${p}`;
};

// ── IMAGE URL ────────────────────────────────────────────────────────────────
const IMG_BASE = "https://cache.willhaben.at/mmo/";
const imgUrl = (relativePath) =>
  IMG_BASE + relativePath.replace(/\.jpg$/i, "_hoved.jpg");

// ── EXTRACT ADS FROM __NEXT_DATA__ ───────────────────────────────────────────
const extractPageData = (nextData) => {
  const result = nextData?.props?.pageProps?.searchResult;
  if (!result) throw new Error("searchResult not found in __NEXT_DATA__");
  const ads = result.advertSummaryList?.advertSummary || [];
  const get = (ad, name) =>
    ad.attributes?.attribute?.find((a) => a.name === name)?.values?.[0] ?? "";
  const getAll = (ad, name) =>
    ad.attributes?.attribute?.find((a) => a.name === name)?.values ?? [];
  return {
    rowsFound: result.rowsFound || 0,
    rowsReturned: result.rowsReturned || ads.length,
    pageRequested: result.pageRequested || 1,
    ads: ads.map((ad) => {
      const images = (get(ad, "ALL_IMAGE_URLS") || "")
        .split(";")
        .filter(Boolean)
        .slice(0, 3)
        .map(imgUrl);
      const location = get(ad, "LOCATION") || "";
      // "Wien, 02. Bezirk, Leopoldstadt" → "02. Bezirk"
      const district = location.split(",")[1]?.trim() || location;
      return {
        id: ad.id,
        title: get(ad, "HEADING") || ad.description || "",
        url: "https://www.willhaben.at/iad/" + get(ad, "SEO_URL"),
        price: get(ad, "PRICE") || get(ad, "RENT/PER_MONTH_LETTINGS") || "",
        sqm: get(ad, "ESTATE_SIZE/LIVING_AREA") || "",
        rooms: get(ad, "NUMBER_OF_ROOMS") || get(ad, "ROOMS") || "",
        location,
        district,
        floor: get(ad, "FLOOR") || "",
        freeAreas: getAll(ad, "FREE_AREA_TYPE_NAME"),
        // ESTATE_PREFERENCE comes as a single comma-separated string e.g. "24, 250, 4"
        estatePrefs: getAll(ad, "ESTATE_PREFERENCE")
          .flatMap((v) => v.split(",").map((s) => s.trim()))
          .filter(Boolean),
        description: get(ad, "BODY_DYN") || "",
        // All string attribute values concatenated — used for full-text feature search
        fullText: ad.attributes.attribute
          .flatMap((a) => a.values)
          .filter((v) => typeof v === "string" && /[a-zäöüß]/i.test(v))
          .join(" ")
          .toLowerCase(),
        published: get(ad, "PUBLISHED_String") || "",
        images,
      };
    }),
  };
};

// ── HTML GENERATOR ───────────────────────────────────────────────────────────
const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");

// ESTATE_PREFERENCE codes → label
const PREF_LABELS = {
  "250": "Keller", "24": "Abstellraum", "4": "Lift",
  "25": "Barrierefrei", "23": "Garage", "15": "Parkplatz", "26": "Carport",
};

// Badge visual category → CSS class
// green = required criteria, blue = good extras, orange = warning, purple = other
const BADGE_COLOR = {
  "Badewanne":    "green", "Keller":      "green", "Abstellraum": "green",
  "Loggia":       "green", "Balkon":      "green", "Terrasse":    "green",
  "Dachterrasse": "green", "Garten":      "green", "Wintergarten":"green",
  "Lift":         "blue",  "Barrierefrei":"blue",  "Garage":      "blue",
  "Parkplatz":    "blue",  "Carport":     "blue",
  "Möbliert":     "orange",
};
const badgeColor = (label) => BADGE_COLOR[label] || "purple";

// Detect features from ALL text fields + structured fields.
// Returns { features: [{label, source, color}], moebliert, criteria }
const detectFeatures = (r) => {
  const full = r.fullText; // all attribute values lowercased
  const found = new Map(); // label → source

  // Structured: FREE_AREA_TYPE_NAME
  for (const f of r.freeAreas) found.set(f, "field");

  // Structured: ESTATE_PREFERENCE codes
  for (const code of r.estatePrefs) {
    const label = PREF_LABELS[String(code)];
    if (label && !found.has(label)) found.set(label, "field");
  }

  // möbliert — criteria bar only, not a badge
  const moebliert =
    r.estatePrefs.includes("28") ||
    /möbliert|moebliert|teilmöbliert|vollmöbliert/i.test(full);

  // Text checks — German synonyms for bathtub + all others
  const textChecks = [
    ["Badewanne",    /wanne/],
    ["Keller",       /\bkeller\b|\bkellerabteil\b|\bkellerfach\b/],
    ["Abstellraum",  /abstellraum|abstell\b|lagerraum|abstellkammer/],
    ["Loggia",       /\bloggia\b/],
    ["Balkon",       /\bbalkon\b/],
    ["Terrasse",     /\bterrasse\b/],
    ["Dachterrasse", /dachterrasse/],
    ["Garten",       /\bgarten\b/],
    ["Wintergarten", /wintergarten/],
    ["Lift",         /\blift\b|\baufzug\b|\bfahrstuhl\b/],
  ];
  for (const [label, re] of textChecks) {
    if (!found.has(label) && re.test(full)) found.set(label, "text");
  }

  const features = [...found.entries()].map(([label, source]) => ({
    label, source, color: badgeColor(label),
  }));

  const fkeys = features.map((f) => f.label.toLowerCase());
  const hasOutdoor = fkeys.some((k) => /loggia|balkon|terrasse|garten|wintergarten/.test(k));
  const criteria = {
    badewanne:   fkeys.some((k) => k === "badewanne"),
    keller:      fkeys.includes("keller"),
    abstellraum: fkeys.includes("abstellraum"),
    outdoor:     hasOutdoor,
  };
  const passes = criteria.badewanne && criteria.keller && criteria.abstellraum;

  // Strip criteria labels from badges — criteria bar already shows them
  const CRITERIA_LABELS = new Set(["badewanne","keller","abstellraum","loggia","balkon","terrasse","dachterrasse","garten","wintergarten"]);
  const badgeFeatures = features.filter((f) => !CRITERIA_LABELS.has(f.label.toLowerCase()));

  return { features: badgeFeatures, moebliert, criteria, passes };
};

const eurPerSqm = (price, sqm) => {
  const p = parseFloat(price), s = parseFloat(sqm);
  return p && s ? (p / s).toFixed(0) : "";
};

const toHtml = (rows, sourceUrl, scrapedAt) => {
  // Collect unique districts for checklist
  const districts = [...new Set(rows.map((r) => r.district).filter(Boolean))].sort();
  const districtCheckboxes = districts.map((d) =>
    `<label><input type="checkbox" value="${esc(d)}" checked onchange="saveDistricts()"> ${esc(d)}</label>`
  ).join("\n      ");

  const cards = rows.map((r) => {
    const { features, moebliert, criteria, passes } = detectFeatures(r);
    const imgs = r.images.length
      ? r.images.map((u) => `<img src="${esc(u)}" loading="lazy" referrerpolicy="no-referrer" />`).join("")
      : '<div class="noimg">no image</div>';
    const eps = eurPerSqm(r.price, r.sqm);
    const featureBadges = features.map(({ label, source, color }) =>
      `<span class="badge badge-${color} feat-${source}" title="${source === "text" ? "found in text" : "tagged by seller"}">${esc(label)}</span>`
    ).join("");
    const featureKeys = features.map((f) => f.label.toLowerCase()).join(",");
    const crit = (ok, label) => `<span class="crit ${ok ? "crit-ok" : "crit-miss"}">${ok ? "✓" : "✗"} ${label}</span>`;
    const outdoorLabel = `<strong class="outdoor-label ${criteria.outdoor ? "outdoor-present" : "outdoor-missing"}">Outdoor</strong>`;
    const criteriaBar = `<div class="criteria-bar">
      ${crit(criteria.badewanne, "Badewanne")}
      ${crit(criteria.keller, "Keller")}
      ${crit(criteria.abstellraum, "Abstellraum")}
      ${outdoorLabel}
      ${moebliert ? '<span class="crit crit-warn">⚠ Möbliert</span>' : ""}
    </div>`;
    return `
    <article class="card${passes ? "" : " dim"}"
      data-url="${esc(r.url)}"
      data-price="${esc(r.price)}"
      data-sqm="${esc(r.sqm)}"
      data-eps="${eps}"
      data-district="${esc(r.district)}"
      data-features="${esc(featureKeys)}"
      data-moebliert="${moebliert ? "1" : "0"}"
      data-fulltext="${esc(r.fullText.slice(0, 500))}">
      <div class="imgs">${imgs}</div>
      <div class="body">
        <p class="title"><a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.title)}</a></p>
        <p class="location">${esc(r.location)}${r.floor ? ` · ${esc(r.floor)}. OG` : ""}</p>
        <div class="stats">
          ${r.price ? `<span class="price">€ ${esc(r.price)}</span>` : ""}
          ${r.sqm ? `<span>${esc(r.sqm)} m²</span>` : ""}
          ${r.rooms ? `<span>${esc(r.rooms)} Zi.</span>` : ""}
          ${eps ? `<span>€ ${eps}/m²</span>` : ""}
        </div>
        ${criteriaBar}
        ${featureBadges ? `<div class="features">${featureBadges}</div>` : ""}
        ${r.description ? `<p class="desc">${esc(r.description)}</p>` : ""}
      </div>
      <div class="actions">
        <button class="btn-star" onclick="toggleStar(this)">☆ Star</button>
        <button class="btn-hide" onclick="toggleHide(this)">Hide</button>
      </div>
    </article>`;
  }).join("");

  return `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>willhaben (${rows.length})</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
           margin: 0; background: #f0f2f5; }
    header { background: #1a1d23; color: #e8eaf0; padding: 10px 16px;
             display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
             position: sticky; top: 0; z-index: 100;
             box-shadow: 0 2px 8px rgba(0,0,0,0.4); }
    header h1 { margin: 0; font-size: 15px; font-weight: 600; flex: 1 1 auto; min-width: 120px; }
    .hdr-meta { font-size: 12px; color: #9aa; white-space: nowrap; }
    header button { padding: 5px 10px; border: 1px solid #444; border-radius: 5px;
                    background: #2a2d35; color: #d0d4e0; font-size: 12px; cursor: pointer;
                    white-space: nowrap; }
    header button:hover { background: #383c48; }
    header button.active { background: #0a58ca; color: #fff; border-color: #0a58ca; }
    header a { color: #6af; font-size: 12px; text-decoration: none; white-space: nowrap; }
    select { padding: 5px 8px; border: 1px solid #444; border-radius: 5px;
             background: #2a2d35; color: #d0d4e0; font-size: 12px; cursor: pointer; }
    .sep { width: 1px; height: 20px; background: #444; flex-shrink: 0; }
    .district-filter { position: relative; }
    .district-panel { display: none; position: absolute; top: calc(100% + 6px); left: 0; background: #2a2d35;
                      border: 1px solid #555; border-radius: 6px; padding: 6px; min-width: 160px;
                      z-index: 200; flex-direction: column; gap: 2px;
                      box-shadow: 0 4px 12px rgba(0,0,0,0.5); }
    .district-panel.open { display: flex; }
    .district-panel-hdr { display: flex; gap: 4px; padding-bottom: 5px; margin-bottom: 2px;
                          border-bottom: 1px solid #444; }
    .district-panel-hdr button { flex: 1; padding: 3px 0; font-size: 11px; border: 1px solid #555;
                                  border-radius: 4px; background: #383c48; color: #d0d4e0; cursor: pointer; }
    .district-panel-hdr button:hover { background: #444a58; }
    .district-panel label { display: flex; align-items: center; gap: 7px; font-size: 12px;
                            color: #d0d4e0; cursor: pointer; padding: 2px 4px; border-radius: 3px;
                            white-space: nowrap; }
    .district-panel label:hover { background: #383c48; }
    .district-panel input[type=checkbox] { accent-color: #0a58ca; cursor: pointer; width: 13px; height: 13px; }
    #sync-indicator { font-size: 11px; color: #9aa; white-space: nowrap; }
    .sidebar-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.35); z-index: 400; }
    .sidebar-overlay.open { display: block; }
    .sidebar { position: fixed; right: 0; top: 0; height: 100vh; width: 280px; background: #1a1d23;
               border-left: 1px solid #444; z-index: 401; display: flex; flex-direction: column;
               padding: 0; transform: translateX(100%); transition: transform 0.2s ease; }
    .sidebar.open { transform: translateX(0); }
    .sidebar-hdr { display: flex; align-items: center; justify-content: space-between;
                   padding: 12px 16px; border-bottom: 1px solid #333; }
    .sidebar-hdr span { font-size: 13px; font-weight: 600; color: #e8eaf0; }
    .sidebar-hdr button { background: none; border: none; color: #9aa; font-size: 16px; cursor: pointer; padding: 2px 6px; }
    .sidebar-hdr button:hover { color: #e8eaf0; }
    .sidebar-body { padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; flex: 1; overflow-y: auto; }
    .sidebar-body label { font-size: 11px; color: #9aa; display: block; margin-bottom: 3px; }
    .sidebar-body input[type=password], .sidebar-body input[type=text] {
      width: 100%; padding: 5px 8px; border: 1px solid #444; border-radius: 4px;
      background: #0d0f13; color: #d0d4e0; font-size: 12px; }
    .sidebar-btn-row { display: flex; gap: 6px; }
    .sidebar-btn-row button { flex: 1; padding: 6px 0; font-size: 12px; border: 1px solid #444;
                               border-radius: 4px; background: #2a2d35; color: #d0d4e0; cursor: pointer; }
    .sidebar-btn-row button:hover { background: #383c48; }
    .sidebar-status { font-size: 11px; color: #9aa; min-height: 15px; }
    .sidebar-info { font-size: 11px; color: #667; line-height: 1.5; border-top: 1px solid #333; padding-top: 10px; }
    .modal-backdrop { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.6);
                      z-index: 500; align-items: center; justify-content: center; }
    .modal-backdrop.open { display: flex; }
    .modal-box { background: #2a2d35; border: 1px solid #555; border-radius: 8px; padding: 20px;
                 max-width: 320px; width: 90%; display: flex; flex-direction: column; gap: 10px; }
    .modal-box h3 { margin: 0; font-size: 14px; color: #e8eaf0; }
    .modal-box p { margin: 0; font-size: 12px; color: #9aa; line-height: 1.5; }
    .modal-box input { width: 100%; padding: 6px 8px; border: 1px solid #444; border-radius: 4px;
                       background: #0d0f13; color: #d0d4e0; font-size: 13px; }
    .modal-btn-row { display: flex; gap: 8px; }
    .modal-btn-row button { flex: 1; padding: 7px 0; font-size: 12px; border: 1px solid #444;
                             border-radius: 4px; background: #2a2d35; color: #d0d4e0; cursor: pointer; }
    .modal-btn-row button:first-child { background: #0a58ca; border-color: #0a58ca; color: #fff; }
    .modal-btn-row button:first-child:hover { background: #0847a8; }
    .modal-btn-row button:last-child:hover { background: #383c48; }
    main { padding: 14px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
            gap: 12px; max-width: 1600px; margin: 0 auto; }
    .card { background: #fff; border: 1px solid #dde; border-radius: 9px;
            overflow: hidden; display: flex; flex-direction: column; }
    .card.starred { border-color: #f5c542; box-shadow: 0 0 0 2px #f5c54255; }
    .card.hidden { display: none; }
    .card.hidden.show-hidden { display: flex; opacity: 0.4; }
    .card.dim { opacity: 0.55; filter: grayscale(20%); }
    .outdoor-label { font-size: 11px; font-weight: 700; padding: 1px 6px; border-radius: 3px; }
    .outdoor-present { background: #d1fae5; color: #065f46; border: 1px solid #6ee7b7; }
    .outdoor-missing { color: #aaa; background: #f5f5f5; border: 1px solid #e0e0e0; text-decoration: line-through; }
    .imgs { display: flex; gap: 2px; height: 180px; background: #dde; flex-shrink: 0; overflow: hidden; }
    .imgs img { flex: 1; min-width: 0; height: 100%; object-fit: cover; }
    .noimg { width: 100%; display: flex; align-items: center; justify-content: center;
             color: #aaa; font-size: 13px; }
    .body { padding: 10px 12px; display: flex; flex-direction: column; gap: 4px; flex: 1; }
    .title { font-size: 13px; font-weight: 600; line-height: 1.3; margin: 0; }
    .title a { color: #0a58ca; text-decoration: none; }
    .title a:hover { text-decoration: underline; }
    .location { font-size: 11px; color: #778; margin: 0; }
    .stats { display: flex; flex-wrap: wrap; gap: 5px; font-size: 12px; }
    .stats span { background: #f0f3f8; padding: 2px 7px; border-radius: 4px; color: #334; }
    .stats .price { background: #e8f4ec; color: #166534; font-weight: 600; }
    .criteria-bar { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 2px; }
    .crit { font-size: 11px; font-weight: 600; padding: 1px 6px; border-radius: 3px; }
    .crit-ok   { background: #dcfce7; color: #166534; }
    .crit-miss { background: #fee2e2; color: #991b1b; }
    .crit-warn { background: #ffedd5; color: #9a3412; }
    .features { display: flex; flex-wrap: wrap; gap: 4px; }
    .badge { padding: 2px 7px; border-radius: 4px; font-size: 11px; font-weight: 500; }
    .badge-green  { background: #dcfce7; color: #166534; }
    .badge-blue   { background: #dbeafe; color: #1d4ed8; }
    .badge-orange { background: #ffedd5; color: #c2410c; }
    .badge-purple { background: #f3e8ff; color: #7e22ce; }
    .feat-text { border-style: dashed; border-width: 1px; }
    .desc { font-size: 11px; color: #666; margin: 0; line-height: 1.4; }
    .actions { display: flex; gap: 6px; padding: 8px 12px 10px;
               border-top: 1px solid #f0f0f0; background: #fafbfc; flex-shrink: 0; }
    .actions button { flex: 1; padding: 5px 0; border: 1px solid #dde; border-radius: 5px;
                      font-size: 12px; cursor: pointer; background: #fff; color: #445; }
    .actions button:hover { background: #f0f3f8; }
    .btn-star.on { background: #fffbe6; border-color: #f5c542; color: #92610a; }
    .btn-hide.on { background: #fef2f2; border-color: #fca5a5; color: #991b1b; }
    #empty { text-align: center; padding: 60px 20px; color: #778; font-size: 15px; display: none; }
  </style>
</head>
<body>
<header>
  <h1>willhaben</h1>
  <span class="hdr-meta" id="count-meta"></span>

  <div class="sep"></div>

  <select id="sel-sort" onchange="saveUI(); applyAll()">
    <option value="">— sort —</option>
    <option value="price-asc">Price ↑</option>
    <option value="price-desc">Price ↓</option>
    <option value="sqm-asc">m² ↑</option>
    <option value="sqm-desc">m² ↓</option>
    <option value="eps-asc">€/m² ↑</option>
    <option value="eps-desc">€/m² ↓</option>
  </select>

  <div class="district-filter" id="district-filter">
    <button id="btn-districts" onclick="toggleDistrictPanel()">Districts ▾</button>
    <div class="district-panel" id="district-panel" hidden>
      <div class="district-panel-hdr">
        <button onclick="toggleAllDistricts(true)">All</button>
        <button onclick="toggleAllDistricts(false)">None</button>
      </div>
      ${districtCheckboxes}
    </div>
  </div>

  <div class="sep"></div>

  <button id="btn-matching" onclick="toggleUiFilter('matching')">✓ Matching only</button>

  <div class="sep"></div>

  <button id="btn-only-starred"  onclick="toggleUiFilter('starred')">★ Starred</button>
  <button id="btn-show-hidden"   onclick="toggleUiFilter('hidden')">Show hidden</button>
  <button id="btn-refresh" onclick="doRefresh()" style="background:#1a3a1a;border-color:#2a5a2a;color:#6f6;">↺ Re-scrape</button>
  <span id="refresh-status" style="font-size:11px;color:#9aa;"></span>

  <button onclick="toggleSidebar()">⚡ Sync</button>
  <span id="sync-indicator"></span>

  <a href="${esc(sourceUrl)}" target="_blank" rel="noopener noreferrer">↗ Search</a>
  <span class="hdr-meta">Scraped: ${esc(scrapedAt)}</span>
</header>
<main>
  <div class="grid" id="grid">${cards}</div>
  <p id="empty">No listings match current filters.</p>
</main>
<script>
  const STATE_KEY = "willhaben_v1";
  const GIST_KEY  = "willhaben_gist";
  const UI_KEY    = "willhaben_ui";
  const loadUI  = () => { try { return JSON.parse(localStorage.getItem(UI_KEY) || "{}"); } catch { return {}; } };
  const saveUI  = () => localStorage.setItem(UI_KEY, JSON.stringify({
    matching: uiFilters.matching, starred: uiFilters.starred, hidden: uiFilters.hidden,
    sort: document.getElementById("sel-sort").value,
    excludedDistricts: [...document.querySelectorAll("#district-panel input[type=checkbox]:not(:checked)")].map(b => b.value),
  }));
  const loadState = () => { try { return JSON.parse(localStorage.getItem(STATE_KEY) || "{}"); } catch { return {}; } };
  const saveState = (s) => localStorage.setItem(STATE_KEY, JSON.stringify(s));
  const getSet = (k) => new Set(loadState()[k] || []);
  const toggleInSet = (k, url) => {
    const s = loadState(), set = getSet(k);
    set.has(url) ? set.delete(url) : set.add(url);
    saveState({ ...s, [k]: [...set] });
  };

  // ── Export / Import ──────────────────────────────────────────────────────────
  const adsSnapshot = () => ({ starred: [...getSet("starred")], hidden: [...getSet("hidden")] });
  const mergeAds = (incoming) => {
    const s = loadState();
    const starred = new Set([...(s.starred || []), ...(incoming.starred || [])]);
    const hidden  = new Set([...(s.hidden  || []), ...(incoming.hidden  || [])]);
    saveState({ ...s, starred: [...starred], hidden: [...hidden] });
  };

  function exportState() {
    const blob = new Blob([JSON.stringify(adsSnapshot(), null, 2)], { type: "application/json" });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "willhaben-state.json" });
    a.click(); URL.revokeObjectURL(a.href);
  }
  function importState(input) {
    const file = input.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => { try { mergeAds(JSON.parse(e.target.result)); applyAll(); } catch { alert("Invalid JSON file"); } };
    reader.readAsText(file);
    input.value = "";
  }

  // ── Gist sync ────────────────────────────────────────────────────────────────
  const PRESET_GIST_ID = "${GIST_ID}";
  const loadGistCfg = () => { try { return JSON.parse(localStorage.getItem(GIST_KEY) || "{}"); } catch { return {}; } };
  const saveGistConfig = () => {
    localStorage.setItem(GIST_KEY, JSON.stringify({
      token: document.getElementById("gist-token").value.trim(),
      gistId: document.getElementById("gist-id").value.trim(),
    }));
  };
  function toggleSidebar() {
    document.getElementById("sidebar").classList.toggle("open");
    document.getElementById("sidebar-overlay").classList.toggle("open");
  }
  function gistStatus(msg, err) {
    const el = document.getElementById("gist-status");
    el.textContent = msg; el.style.color = err ? "#f87" : "#6a6";
  }
  function setSyncIndicator(msg, err) {
    const el = document.getElementById("sync-indicator");
    el.textContent = msg; el.style.color = err ? "#f87" : "#6a6";
  }
  function showTokenModal() {
    document.getElementById("token-modal").classList.add("open");
    document.getElementById("modal-token").focus();
  }
  function dismissModal() { document.getElementById("token-modal").classList.remove("open"); }
  function saveModalToken() {
    const t = document.getElementById("modal-token").value.trim();
    if (!t) return;
    document.getElementById("gist-token").value = t;
    saveGistConfig();
    dismissModal();
    pushToGist();
  }
  let _pushTimer = null;
  function autoPush() {
    const { token } = loadGistCfg();
    if (!token) { showTokenModal(); return; }
    clearTimeout(_pushTimer);
    _pushTimer = setTimeout(pushToGist, 800);
  }
  async function pushToGist() {
    const { token, gistId } = loadGistCfg();
    if (!token) { gistStatus("Token required", true); return; }
    setSyncIndicator("⟳ syncing…");
    const body = { description: "willhaben scraper state", public: false,
      files: { "willhaben-state.json": { content: JSON.stringify(adsSnapshot(), null, 2) } } };
    const url = gistId ? "https://api.github.com/gists/" + gistId : "https://api.github.com/gists";
    const res = await fetch(url, { method: gistId ? "PATCH" : "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify(body) });
    if (!res.ok) { gistStatus("Error " + res.status, true); setSyncIndicator("✗ sync failed", true); return; }
    const data = await res.json();
    if (!gistId) { document.getElementById("gist-id").value = data.id; saveGistConfig(); }
    const t = new Date().toLocaleTimeString();
    gistStatus("Pushed ✓ " + t);
    setSyncIndicator("✓ " + t);
  }
  async function pullFromGist() {
    const { token, gistId } = loadGistCfg();
    if (!token || !gistId) { gistStatus("Token + Gist ID required", true); return; }
    gistStatus("Pulling…");
    const res = await fetch("https://api.github.com/gists/" + gistId,
      { headers: { Authorization: "Bearer " + token } });
    if (!res.ok) { gistStatus("Error " + res.status, true); return; }
    const data = await res.json();
    const content = data.files["willhaben-state.json"]?.content;
    if (!content) { gistStatus("File not found in gist", true); return; }
    let parsed;
    try { parsed = JSON.parse(content); } catch { gistStatus("Invalid JSON in gist", true); return; }
    mergeAds(parsed);
    const saved = loadState();
    const sc = (saved.starred || []).length, hc = (saved.hidden || []).length;
    applyAll();
    gistStatus("Pulled ✓ — " + sc + " starred, " + hc + " hidden");
  }

  let uiFilters = { starred: false, hidden: false, matching: false };

  function toggleStar(btn) {
    toggleInSet("starred", btn.closest(".card").dataset.url);
    applyAll();
    autoPush();
  }
  function toggleHide(btn) {
    toggleInSet("hidden", btn.closest(".card").dataset.url);
    applyAll();
    autoPush();
  }
  function toggleUiFilter(type) {
    uiFilters[type] = !uiFilters[type];
    document.getElementById("btn-only-starred").classList.toggle("active", uiFilters.starred);
    document.getElementById("btn-show-hidden").classList.toggle("active", uiFilters.hidden);
    document.getElementById("btn-matching").classList.toggle("active", uiFilters.matching);
    saveUI();
    applyAll();
  }

  function toggleDistrictPanel() {
    document.getElementById("district-panel").classList.toggle("open");
  }
  function toggleAllDistricts(selectAll) {
    for (const box of document.querySelectorAll("#district-panel input[type=checkbox]")) box.checked = selectAll;
    saveDistricts();
  }
  function saveDistricts() {
    updateDistrictBtn();
    saveUI();
    applyAll();
  }
  function updateDistrictBtn() {
    const boxes = [...document.querySelectorAll("#district-panel input[type=checkbox]")];
    const checked = boxes.filter(b => b.checked).length;
    document.getElementById("btn-districts").textContent =
      checked === boxes.length ? "Districts ▾" : "Districts (" + checked + "/" + boxes.length + ") ▾";
  }
  document.addEventListener("click", (e) => {
    if (!document.getElementById("district-filter").contains(e.target))
      document.getElementById("district-panel").hidden = true;
  });

  function applyAll() {
    const starred   = getSet("starred");
    const hidden    = getSet("hidden");
    const sortVal   = document.getElementById("sel-sort").value;
    const excluded  = new Set([...document.querySelectorAll("#district-panel input[type=checkbox]:not(:checked)")].map(b => b.value));

    const allCards = Array.from(document.querySelectorAll(".card"));
    let visible = 0;

    // Filter pass
    for (const card of allCards) {
      const url  = card.dataset.url;
      const isStar = starred.has(url);
      const isHide = hidden.has(url);

      card.classList.toggle("starred", isStar);
      card.classList.toggle("hidden", isHide);
      card.classList.toggle("show-hidden", isHide && uiFilters.hidden);

      // Sync button labels
      const bs = card.querySelector(".btn-star"), bh = card.querySelector(".btn-hide");
      if (bs) { bs.textContent = isStar ? "★ Starred" : "☆ Star"; bs.classList.toggle("on", isStar); }
      if (bh) { bh.textContent = isHide ? "👁 Unhide" : "Hide"; bh.classList.toggle("on", isHide); }

      // Visibility logic
      let show = true;
      if (uiFilters.starred && !isStar) show = false;
      if (isHide && !uiFilters.hidden) show = false;
      const isDim = card.classList.contains("dim");
      if (excluded.has(card.dataset.district)) show = false;
      if (uiFilters.matching && isDim) show = false;

      card.style.display = show ? "" : "none";
      if (show) visible++;
    }

    document.getElementById("empty").style.display = visible === 0 ? "block" : "none";

    // Sort visible cards
    if (sortVal) {
      const grid = document.getElementById("grid");
      const visibleCards = allCards.filter(c => c.style.display !== "none");
      const [field, dir] = sortVal.split("-");
      const key = { price: "price", sqm: "sqm", eps: "eps" }[field];
      visibleCards.sort((a, b) => {
        const av = parseFloat(a.dataset[key]) || (dir === "asc" ? Infinity : -Infinity);
        const bv = parseFloat(b.dataset[key]) || (dir === "asc" ? Infinity : -Infinity);
        return dir === "asc" ? av - bv : bv - av;
      });
      for (const c of visibleCards) grid.appendChild(c);
    }

    // Update meta
    const total = allCards.length;
    const sc = [...starred].filter(u => document.querySelector('[data-url="' + CSS.escape(u) + '"]')).length;
    const hc = [...hidden].filter(u => document.querySelector('[data-url="' + CSS.escape(u) + '"]')).length;
    document.getElementById("count-meta").textContent =
      visible + "/" + total + " shown · ★ " + sc + " · hidden " + hc;
  }

  // Restore gist config inputs
  const _gc = loadGistCfg();
  if (_gc.token) document.getElementById("gist-token").value = _gc.token;
  if (_gc.gistId) document.getElementById("gist-id").value = _gc.gistId;
  else if (PRESET_GIST_ID) { document.getElementById("gist-id").value = PRESET_GIST_ID; saveGistConfig(); }

  // Restore UI filters
  const _ui = loadUI();
  const _excSaved = _ui.excludedDistricts || loadState().excludedDistricts || [];
  for (const box of document.querySelectorAll("#district-panel input[type=checkbox]"))
    if (_excSaved.includes(box.value)) box.checked = false;
  updateDistrictBtn();
  if (_ui.matching) { uiFilters.matching = true; document.getElementById("btn-matching").classList.add("active"); }
  if (_ui.starred)  { uiFilters.starred  = true; document.getElementById("btn-only-starred").classList.add("active"); }
  if (_ui.hidden)   { uiFilters.hidden   = true; document.getElementById("btn-show-hidden").classList.add("active"); }
  if (_ui.sort)     document.getElementById("sel-sort").value = _ui.sort;

  applyAll();

  // Auto-pull from gist on every page load if configured
  if (_gc.token && (_gc.gistId || PRESET_GIST_ID)) pullFromGist();

  async function doRefresh() {
    const btn = document.getElementById("btn-refresh");
    const status = document.getElementById("refresh-status");
    btn.disabled = true;
    btn.textContent = "Scraping…";
    status.textContent = "";
    try {
      const res = await fetch("/refresh", { method: "POST" });
      if (!res.ok) { status.textContent = "Already running"; btn.disabled = false; btn.textContent = "↺ Re-scrape"; return; }
      status.textContent = "Running…";
      // Poll until done then reload
      const poll = setInterval(async () => {
        try {
          const s = await fetch("/status").then(r => r.json());
          if (s.lastLog.length) status.textContent = s.lastLog[s.lastLog.length - 1];
          if (!s.scraping) { clearInterval(poll); location.reload(); }
        } catch { clearInterval(poll); location.reload(); }
      }, 1500);
    } catch {
      status.textContent = "Server not running — start with: node server.js";
      btn.disabled = false;
      btn.textContent = "↺ Re-scrape";
    }
  }
</script>

<div class="sidebar-overlay" id="sidebar-overlay" onclick="toggleSidebar()"></div>
<aside class="sidebar" id="sidebar">
  <div class="sidebar-hdr">
    <span>⚡ Gist Sync</span>
    <button onclick="toggleSidebar()" title="Close">✕</button>
  </div>
  <div class="sidebar-body">
    <div>
      <label>GitHub token (classic · gist scope)</label>
      <input id="gist-token" type="password" placeholder="ghp_…" oninput="saveGistConfig()">
    </div>
    <div>
      <label>Gist ID</label>
      <input id="gist-id" type="text" placeholder="pre-filled from config" oninput="saveGistConfig()">
    </div>
    <div class="sidebar-btn-row">
      <button onclick="pushToGist()">↑ Push now</button>
      <button onclick="pullFromGist()">↓ Pull now</button>
    </div>
    <div class="sidebar-status" id="gist-status"></div>
    <div class="sidebar-info">
      Auto-syncs on every star / hide.<br>
      Use Push / Pull to sync manually across devices.<br><br>
      Token stored in localStorage only — never sent anywhere except api.github.com.
    </div>
    <div style="border-top:1px solid #333;padding-top:10px;display:flex;flex-direction:column;gap:6px">
      <div style="font-size:11px;color:#9aa">Local backup</div>
      <div class="sidebar-btn-row">
        <button onclick="exportState()">↓ Export JSON</button>
        <button onclick="document.getElementById('import-file').click()">↑ Import JSON</button>
      </div>
      <input id="import-file" type="file" accept=".json" onchange="importState(this)" style="display:none">
    </div>
  </div>
</aside>

<div class="modal-backdrop" id="token-modal">
  <div class="modal-box">
    <h3>GitHub token needed</h3>
    <p>Enter a classic personal access token with <strong>gist</strong> scope to auto-sync starred &amp; hidden ads.</p>
    <p>GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic) → gist scope.</p>
    <input id="modal-token" type="password" placeholder="ghp_…">
    <div class="modal-btn-row">
      <button onclick="saveModalToken()">Save &amp; sync</button>
      <button onclick="dismissModal()">Skip (local only)</button>
    </div>
  </div>
</div>
</body>
</html>`;
};

// ── SCRAPER ───────────────────────────────────────────────────────────────────
(async () => {
  const outFile = path.resolve(process.argv[2] || "listings.html");
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const firstUrl = buildSearchUrl(URL_BUILDER, 1);

  console.log("[willhaben] Launching browser…");
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    locale: "de-AT",
    viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();
  await page.route("**/*.{woff,woff2,ttf,otf,png,svg,gif,webp}", (r) => r.abort());

  const fetchPage = async (pageNum) => {
    const url = buildSearchUrl(URL_BUILDER, pageNum);
    console.log(`[willhaben] Fetching page ${pageNum}: ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    // Dismiss cookie banner once
    if (pageNum === 1) {
      try {
        await page.click('[data-testid="sp-accept-all-button"]', { timeout: 4000 });
        console.log("[willhaben] Cookie banner dismissed");
      } catch { /* no banner */ }
    }

    return page.evaluate(() => {
      const el = document.getElementById("__NEXT_DATA__");
      if (!el) throw new Error("__NEXT_DATA__ not found");
      return JSON.parse(el.textContent);
    });
  };

  // Page 1
  const firstData = await fetchPage(1);
  const first = extractPageData(firstData);
  console.log(`[willhaben] Page 1: ${first.ads.length} ads, ${first.rowsFound} total`);

  const allAds = [...first.ads];

  // Paginate if needed
  const totalPages = Math.ceil(first.rowsFound / URL_BUILDER.ROWS_PER_PAGE);
  for (let p = 2; p <= totalPages; p++) {
    const data = await fetchPage(p);
    const { ads } = extractPageData(data);
    console.log(`[willhaben] Page ${p}: ${ads.length} ads`);
    allAds.push(...ads);
  }

  // Deduplicate by id
  const seen = new Set();
  const unique = allAds.filter((a) => { if (seen.has(a.id)) return false; seen.add(a.id); return true; });
  console.log(`[willhaben] Total unique: ${unique.length}`);

  // ── Fetch full descriptions from individual listing pages ─────────────────
  const CONCURRENCY = 5;
  console.log(`[willhaben] Fetching ${unique.length} detail pages (concurrency=${CONCURRENCY})…`);

  const detailPages = await Promise.all(
    Array.from({ length: CONCURRENCY }, () => ctx.newPage().then(async (p) => {
      await p.route("**/*.{woff,woff2,ttf,otf,png,svg,gif,webp,css}", (r) => r.abort());
      return p;
    }))
  );

  const fetchDetail = async (workerPage, ad) => {
    try {
      await workerPage.goto(ad.url, { waitUntil: "domcontentloaded", timeout: 20000 });
      return await workerPage.evaluate(() => {
        const el = document.getElementById("__NEXT_DATA__");
        if (!el) return document.body.innerText.toLowerCase();
        const j = JSON.parse(el.textContent);
        const adData =
          j?.props?.pageProps?.ad ||
          j?.props?.pageProps?.advertDetails ||
          j?.props?.pageProps?.adDetail;
        if (!adData) return document.body.innerText.toLowerCase();
        return adData.attributes.attribute.flatMap((a) => a.values).join(" ").toLowerCase();
      });
    } catch {
      return "";
    }
  };

  let idx = 0;
  const detailTexts = new Array(unique.length).fill("");
  await Promise.all(detailPages.map(async (workerPage) => {
    while (true) {
      const i = idx++;
      if (i >= unique.length) break;
      if (i % 10 === 0) console.log(`[willhaben] Details ${i}/${unique.length}…`);
      detailTexts[i] = await fetchDetail(workerPage, unique[i]);
    }
  }));

  for (let i = 0; i < unique.length; i++) {
    if (detailTexts[i]) unique[i].fullText += " " + detailTexts[i];
  }

  await browser.close();

  const scrapedAt = new Date().toLocaleString("de-AT", { timeZone: "Europe/Vienna" });
  fs.writeFileSync(outFile, toHtml(unique, firstUrl, scrapedAt), "utf8");
  console.log(`[willhaben] Written: ${outFile}`);

  const { exec } = require("child_process");
  exec(`xdg-open "${outFile}"`);
})();
