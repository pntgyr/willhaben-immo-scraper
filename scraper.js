/**
 * Willhaben listings scraper — paste into browser DevTools console
 * while on a willhaben search results page (or any willhaben.at page).
 *
 * Tweak URL_BUILDER and CONFIG at the top, then run.
 * Results appear in an overlay with star/hide buttons (state persisted in localStorage).
 * Click "Refresh" in the overlay to re-scrape without re-pasting the script.
 */
(async () => {
  // ── URL BUILDER ──────────────────────────────────────────────────────────
  // Change these to adjust your search. The script will navigate to the built
  // URL automatically if you're not already on it (or just open the URL first).

  const URL_BUILDER = {
    BASE: "https://www.willhaben.at/iad/immobilien/mietwohnungen/mietwohnung-angebote",
    SF_ID: "708523b4-b275-481f-be91-9412fa087f2b",

    // District area IDs for Vienna — add/remove as needed
    AREA_IDS: [
      117224, 117225, 117226, 117227, 117228, 117229, 117230,
      117236, 117237, 117238, 117239, 117240, 117242,
    ],

    ROOMS_BUCKET: "3X3",   // "2X2" | "3X3" | "4X4" | null
    PRICE_FROM: null,      // e.g. 800
    PRICE_TO: 1700,
    AREA_FROM: 72,         // m²
    AREA_TO: null,

    ROWS_PER_PAGE: 30,
    PAGE: 1,
  };

  const buildSearchUrl = (b = URL_BUILDER) => {
    const p = new URLSearchParams({
      sfId: b.SF_ID,
      isNavigation: "true",
      rows: b.ROWS_PER_PAGE,
      page: b.PAGE,
    });
    for (const id of b.AREA_IDS) p.append("areaId", id);
    if (b.ROOMS_BUCKET) p.append("NO_OF_ROOMS_BUCKET", b.ROOMS_BUCKET);
    if (b.PRICE_FROM != null) p.append("PRICE_FROM", b.PRICE_FROM);
    if (b.PRICE_TO != null) p.append("PRICE_TO", b.PRICE_TO);
    if (b.AREA_FROM != null) p.append("ESTATE_SIZE/LIVING_AREA_FROM", b.AREA_FROM);
    if (b.AREA_TO != null) p.append("ESTATE_SIZE/LIVING_AREA_TO", b.AREA_TO);
    return `${b.BASE}?${p}`;
  };

  const SEARCH_URL = buildSearchUrl();

  // ── CONFIG ────────────────────────────────────────────────────────────────
  const CONFIG = {
    TARGET: 60,            // stop after this many matching listings
    MAX_SCROLLS: 40,
    SCROLL_PAUSE_MS: 1200,
    SCROLL_STRATEGY: "bottom",  // "bottom" | "step"
    STEP_PX: 1500,

    INCLUDE_IMAGES: true,
    MAX_IMAGES_PER_AD: 3,

    // Mirror URL_BUILDER values for post-scrape filtering
    MIN_PRICE: null,
    MAX_PRICE: URL_BUILDER.PRICE_TO,
    MIN_SQM: URL_BUILDER.AREA_FROM,
    MAX_SQM: null,
    MIN_ROOMS: 3,
    MAX_ROOMS: 3,

    REQUIRE_KEYWORDS: [],   // e.g. ["Balkon"] — ALL must match
    EXCLUDE_KEYWORDS: [],   // e.g. ["möbliert"] — ANY drops the ad

    SORT_BY: "none",        // "none" | "price" | "sqm" | "eurPerSqm"
    SORT_DIR: "asc",

    LOG_VERBOSE: true,
    DRY_RUN: false,
  };

  // ── HELPERS ───────────────────────────────────────────────────────────────
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...a) => CONFIG.LOG_VERBOSE && console.log("[willhaben]", ...a);

  const isListingHref = (href) => {
    if (typeof href !== "string") return false;
    if (!href.includes("/iad/immobilien/")) return false;
    if (href.includes("/preisvergleich/")) return false;
    if (href.includes("/mietpreisspiegel")) return false;
    return /\/\d{6,}\/?($|\?|#)/.test(href) || /-\d{6,}\/?($|\?|#)/.test(href);
  };

  const absUrl = (href) => {
    try { return new URL(href, location.origin).toString(); } catch { return ""; }
  };

  const normalizeNumber = (s) => {
    if (!s) return "";
    return String(s).replace(/\s/g, "").replace(/\./g, "").replace(/,/g, ".");
  };

  const pickClosestCard = (a) =>
    a.closest("article") ||
    a.closest('div[class*="Ad"]') ||
    a.closest('div[class*="ad"]') ||
    a.closest("li") ||
    a.parentElement;

  const extractFromCardText = (text) => {
    const t = (text || "").replace(/\s+/g, " ").trim();
    const priceMatch = t.match(/([0-9][0-9.\s]*)\s*€/);
    const priceEur = priceMatch ? normalizeNumber(priceMatch[1]) : "";
    const sqmMatch = t.match(/(\d+(?:[.,]\d+)?)\s*m²/i);
    const sqm = sqmMatch ? sqmMatch[1].replace(",", ".") : "";
    const roomsMatch = t.match(/(\d+(?:[.,]\d+)?)\s*(Zimmer|Zi\.|Zim\.)/i);
    const rooms = roomsMatch ? roomsMatch[1].replace(",", ".") : "";
    return { priceEur, sqm, rooms };
  };

  const firstSrcsetUrl = (val) => {
    if (!val || typeof val !== "string") return null;
    const first = val.split(",")[0];
    const url = first?.trim().split(/\s+/)[0];
    return url || null;
  };

  const extractImagesFromCard = (card, max) => {
    if (!card || !CONFIG.INCLUDE_IMAGES) return [];
    const urls = [];
    for (const img of Array.from(card.querySelectorAll("img"))) {
      const candidates = [
        img.getAttribute("src"),
        img.getAttribute("data-src"),
        firstSrcsetUrl(img.getAttribute("data-srcset")),
        firstSrcsetUrl(img.getAttribute("srcset")),
        img.currentSrc,
      ];
      for (const c of candidates) {
        if (c && /^https?:/.test(c) && !urls.includes(c)) { urls.push(c); break; }
      }
      if (urls.length >= max) return urls;
    }
    for (const s of Array.from(card.querySelectorAll("source"))) {
      const c = firstSrcsetUrl(s.getAttribute("srcset"));
      if (c && /^https?:/.test(c) && !urls.includes(c)) urls.push(c);
      if (urls.length >= max) return urls;
    }
    for (const el of Array.from(card.querySelectorAll("[style*='background']"))) {
      const m = el.getAttribute("style")?.match(/url\(["']?(https?:[^"')]+)/);
      if (m && !urls.includes(m[1])) urls.push(m[1]);
      if (urls.length >= max) return urls;
    }
    return urls;
  };

  const passesFilters = (row) => {
    const num = (s) => (s === "" || s == null ? null : Number(s));
    const price = num(row.priceEur);
    const sqm = num(row.sqm);
    const rooms = num(row.rooms);
    if (CONFIG.MIN_PRICE != null && (price == null || price < CONFIG.MIN_PRICE)) return false;
    if (CONFIG.MAX_PRICE != null && (price == null || price > CONFIG.MAX_PRICE)) return false;
    if (CONFIG.MIN_SQM != null && (sqm == null || sqm < CONFIG.MIN_SQM)) return false;
    if (CONFIG.MAX_SQM != null && (sqm == null || sqm > CONFIG.MAX_SQM)) return false;
    if (CONFIG.MIN_ROOMS != null && (rooms == null || rooms < CONFIG.MIN_ROOMS)) return false;
    if (CONFIG.MAX_ROOMS != null && (rooms == null || rooms > CONFIG.MAX_ROOMS)) return false;
    const text = (row.raw || "").toLowerCase();
    for (const kw of CONFIG.REQUIRE_KEYWORDS) {
      if (!text.includes(String(kw).toLowerCase())) return false;
    }
    for (const kw of CONFIG.EXCLUDE_KEYWORDS) {
      if (text.includes(String(kw).toLowerCase())) return false;
    }
    return true;
  };

  const sortRows = (rows) => {
    if (CONFIG.SORT_BY === "none") return rows;
    const key = {
      price: (r) => Number(r.priceEur) || Infinity,
      sqm: (r) => Number(r.sqm) || -Infinity,
      eurPerSqm: (r) => Number(r.netEurPerSqm_guess) || Infinity,
    }[CONFIG.SORT_BY];
    if (!key) return rows;
    const dir = CONFIG.SORT_DIR === "desc" ? -1 : 1;
    return [...rows].sort((a, b) => (key(a) - key(b)) * dir);
  };

  const extractListingsFromDOM = () => {
    const allAnchors = Array.from(document.querySelectorAll("a[href]"));
    const listingAnchors = allAnchors
      .filter((a) => isListingHref(a.getAttribute("href")))
      .map((a) => ({ a, href: absUrl(a.getAttribute("href")) }))
      .filter((x) => x.href);

    log(`anchors total=${allAnchors.length}, listing-shaped=${listingAnchors.length}`);

    const byHref = new Map();
    for (const x of listingAnchors) if (!byHref.has(x.href)) byHref.set(x.href, x);

    const results = [];
    let droppedNoArea = 0;
    for (const { a, href } of byHref.values()) {
      const card = pickClosestCard(a);
      const cardText = (card?.innerText || "").trim();
      if (!/m²|m2\b|\bqm\b/i.test(cardText)) { droppedNoArea++; continue; }

      const title =
        (a.innerText || "").trim() ||
        (card?.querySelector("h1,h2,h3")?.innerText || "").trim();

      const { priceEur, sqm, rooms } = extractFromCardText(cardText);
      const images = extractImagesFromCard(card, CONFIG.MAX_IMAGES_PER_AD);

      results.push({
        url: href, title, priceEur, sqm, rooms,
        netEurPerSqm_guess: priceEur && sqm
          ? (Number(priceEur) / Number(sqm)).toFixed(2) : "",
        images,
        raw: cardText.slice(0, 800),
      });
    }
    if (droppedNoArea > 0) log(`dropped ${droppedNoArea} anchors with no area indicator`);
    return results;
  };

  const uniq = (arr, key) => {
    const m = new Map();
    for (const x of arr) if (!m.has(x[key])) m.set(x[key], x);
    return Array.from(m.values());
  };

  // ── SCROLL ────────────────────────────────────────────────────────────────
  const autoScrollUntil = async () => {
    let lastHeight = -1, stagnantCycles = 0, scrolls = 0;
    while (scrolls < CONFIG.MAX_SCROLLS) {
      const all = uniq(extractListingsFromDOM(), "url");
      const matching = all.filter(passesFilters);
      log(`scroll ${scrolls}: total=${all.length}, matching=${matching.length}/${CONFIG.TARGET}`);
      if (matching.length >= CONFIG.TARGET) break;

      if (CONFIG.SCROLL_STRATEGY === "step") window.scrollBy(0, CONFIG.STEP_PX);
      else window.scrollTo(0, document.body.scrollHeight);
      await sleep(CONFIG.SCROLL_PAUSE_MS);

      const newHeight = document.body.scrollHeight;
      if (newHeight === lastHeight) {
        if (++stagnantCycles >= 2) { log("page stopped growing — stopping scroll"); break; }
      } else { stagnantCycles = 0; }
      lastHeight = newHeight;
      scrolls++;
    }
  };

  // ── PERSISTENT STATE (localStorage) ───────────────────────────────────────
  const STATE_KEY = "willhaben_v1";

  const loadState = () => {
    try { return JSON.parse(localStorage.getItem(STATE_KEY) || "{}"); } catch { return {}; }
  };
  const saveState = (s) => localStorage.setItem(STATE_KEY, JSON.stringify(s));

  const getStarred = () => new Set(loadState().starred || []);
  const getHidden = () => new Set(loadState().hidden || []);

  const toggleStarred = (url) => {
    const s = loadState(), set = new Set(s.starred || []);
    set.has(url) ? set.delete(url) : set.add(url);
    saveState({ ...s, starred: [...set] });
  };

  const toggleHidden = (url) => {
    const s = loadState(), set = new Set(s.hidden || []);
    set.has(url) ? set.delete(url) : set.add(url);
    saveState({ ...s, hidden: [...set] });
  };

  // ── OVERLAY ───────────────────────────────────────────────────────────────
  const OVERLAY_ID = "__wh_overlay";
  const esc = (s) =>
    String(s ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#039;");

  const renderOverlay = (rows) => {
    const starred = getStarred();
    const hidden = getHidden();

    // Preserve filter toggles across re-renders
    const prev = document.getElementById(OVERLAY_ID);
    const showHidden = prev?.dataset.showHidden === "1";
    const onlyStarred = prev?.dataset.onlyStarred === "1";
    if (prev) prev.remove();

    const displayed = rows.filter((r) => {
      if (onlyStarred && !starred.has(r.url)) return false;
      if (!showHidden && hidden.has(r.url)) return false;
      return true;
    });

    const wrap = document.createElement("div");
    wrap.id = OVERLAY_ID;
    wrap.dataset.showHidden = showHidden ? "1" : "0";
    wrap.dataset.onlyStarred = onlyStarred ? "1" : "0";

    // ── Styles ────────────────────────────────────────────────────────────
    const style = document.createElement("style");
    style.textContent = `
      #__wh_overlay {
        position: fixed; inset: 0; z-index: 2147483647;
        background: rgba(0,0,0,0.65);
        display: flex; flex-direction: column;
        font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      }
      #__wh_toolbar {
        background: #1a1d23; color: #e8eaf0;
        padding: 10px 16px; display: flex; align-items: center; gap: 10px;
        flex-shrink: 0; flex-wrap: wrap;
        box-shadow: 0 2px 8px rgba(0,0,0,0.4);
      }
      #__wh_toolbar h1 { margin: 0; font-size: 15px; font-weight: 600; flex: 1; }
      #__wh_toolbar .wh-count { font-size: 13px; color: #9aa; white-space: nowrap; }
      #__wh_toolbar button {
        padding: 5px 11px; border: 1px solid #444; border-radius: 5px;
        background: #2a2d35; color: #d0d4e0; font-size: 12px; cursor: pointer;
        transition: background .15s, color .15s;
      }
      #__wh_toolbar button:hover { background: #383c48; }
      #__wh_toolbar button.active { background: #0a58ca; color: #fff; border-color: #0a58ca; }
      #__wh_toolbar button.close { background: #3a1a1a; border-color: #662; color: #f99; }
      #__wh_toolbar button.close:hover { background: #5a2020; }
      #__wh_toolbar button.refresh { background: #1a3a1a; border-color: #262; color: #6f6; }
      #__wh_toolbar button.refresh:hover { background: #1e4a1e; }
      #__wh_body {
        flex: 1; overflow-y: auto; padding: 14px;
        background: #f0f2f5;
      }
      #__wh_grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
        gap: 12px;
        max-width: 1600px; margin: 0 auto;
      }
      .wh-card {
        background: #fff; border: 1px solid #dde; border-radius: 9px;
        overflow: hidden; display: flex; flex-direction: column;
        transition: box-shadow .15s, opacity .2s;
        position: relative;
      }
      .wh-card.wh-starred { border-color: #f5c542; box-shadow: 0 0 0 2px #f5c54255; }
      .wh-card.wh-hidden { opacity: 0.4; }
      .wh-imgs { display: flex; gap: 2px; height: 170px; background: #dde; flex-shrink: 0; }
      .wh-imgs img { flex: 1; min-width: 0; height: 100%; object-fit: cover; }
      .wh-noimg { width: 100%; display: flex; align-items: center; justify-content: center;
                  color: #aaa; font-size: 13px; }
      .wh-body { padding: 10px 12px; display: flex; flex-direction: column; gap: 5px; }
      .wh-title { font-size: 13px; font-weight: 600; line-height: 1.3; margin: 0; }
      .wh-title a { color: #0a58ca; text-decoration: none; }
      .wh-title a:hover { text-decoration: underline; }
      .wh-stats { display: flex; flex-wrap: wrap; gap: 5px; font-size: 12px; }
      .wh-stats span { background: #f0f3f8; padding: 2px 7px; border-radius: 4px; color: #334; }
      .wh-stats .wh-price { background: #e8f4ec; color: #166534; font-weight: 600; }
      .wh-raw { font-size: 11px; color: #666; white-space: pre-wrap; max-height: 80px;
                overflow: auto; background: #fafafa; padding: 5px 7px; border-radius: 4px;
                margin: 0; border: 1px solid #eee; }
      .wh-actions {
        display: flex; gap: 6px; padding: 8px 12px 10px;
        border-top: 1px solid #f0f0f0; background: #fafbfc;
      }
      .wh-btn {
        flex: 1; padding: 5px 0; border: 1px solid #dde; border-radius: 5px;
        font-size: 12px; cursor: pointer; background: #fff; color: #445;
        transition: background .12s;
      }
      .wh-btn:hover { background: #f0f3f8; }
      .wh-btn.wh-star-on { background: #fffbe6; border-color: #f5c542; color: #92610a; }
      .wh-btn.wh-hide-on { background: #fef2f2; border-color: #fca5a5; color: #991b1b; }
      #__wh_empty {
        text-align: center; padding: 60px 20px; color: #778; font-size: 15px;
      }
    `;
    wrap.appendChild(style);

    // ── Toolbar ───────────────────────────────────────────────────────────
    const toolbar = document.createElement("div");
    toolbar.id = "__wh_toolbar";

    const title = document.createElement("h1");
    title.textContent = "willhaben listings";
    toolbar.appendChild(title);

    const countEl = document.createElement("span");
    countEl.className = "wh-count";
    const hiddenCount = [...hidden].filter((u) => rows.some((r) => r.url === u)).length;
    const starCount = [...starred].filter((u) => rows.some((r) => r.url === u)).length;
    countEl.textContent = `${displayed.length} shown · ${rows.length} total · ★ ${starCount} · hidden ${hiddenCount}`;
    toolbar.appendChild(countEl);

    const btnStarFilter = document.createElement("button");
    btnStarFilter.textContent = "★ Only starred";
    if (onlyStarred) btnStarFilter.classList.add("active");
    btnStarFilter.onclick = () => {
      wrap.dataset.onlyStarred = wrap.dataset.onlyStarred === "1" ? "0" : "1";
      renderOverlay(rows);
    };
    toolbar.appendChild(btnStarFilter);

    const btnShowHidden = document.createElement("button");
    btnShowHidden.textContent = "Show hidden";
    if (showHidden) btnShowHidden.classList.add("active");
    btnShowHidden.onclick = () => {
      wrap.dataset.showHidden = wrap.dataset.showHidden === "1" ? "0" : "1";
      renderOverlay(rows);
    };
    toolbar.appendChild(btnShowHidden);

    const btnRefresh = document.createElement("button");
    btnRefresh.className = "refresh";
    btnRefresh.textContent = "↺ Refresh";
    btnRefresh.onclick = async () => {
      btnRefresh.textContent = "Scraping…";
      btnRefresh.disabled = true;
      try { await window.__willhabenRun(); }
      finally { /* overlay replaced by run */ }
    };
    toolbar.appendChild(btnRefresh);

    const btnClose = document.createElement("button");
    btnClose.className = "close";
    btnClose.textContent = "× Close";
    btnClose.onclick = () => wrap.remove();
    toolbar.appendChild(btnClose);

    wrap.appendChild(toolbar);

    // ── Body ──────────────────────────────────────────────────────────────
    const body = document.createElement("div");
    body.id = "__wh_body";

    if (displayed.length === 0) {
      const empty = document.createElement("div");
      empty.id = "__wh_empty";
      empty.textContent = rows.length === 0
        ? "No listings found. Try relaxing filters or scrolling the page first."
        : "No listings match current view filters.";
      body.appendChild(empty);
    } else {
      const grid = document.createElement("div");
      grid.id = "__wh_grid";

      for (const r of displayed) {
        const isStarred = starred.has(r.url);
        const isHidden = hidden.has(r.url);

        const card = document.createElement("article");
        card.className = [
          "wh-card",
          isStarred ? "wh-starred" : "",
          isHidden ? "wh-hidden" : "",
        ].join(" ").trim();

        // Images
        const imgs = document.createElement("div");
        imgs.className = "wh-imgs";
        if (r.images?.length) {
          for (const u of r.images) {
            const img = document.createElement("img");
            img.src = u;
            img.loading = "lazy";
            img.referrerPolicy = "no-referrer";
            imgs.appendChild(img);
          }
        } else {
          const noimg = document.createElement("div");
          noimg.className = "wh-noimg";
          noimg.textContent = "no image";
          imgs.appendChild(noimg);
        }
        card.appendChild(imgs);

        // Body
        const cardBody = document.createElement("div");
        cardBody.className = "wh-body";

        const h2 = document.createElement("p");
        h2.className = "wh-title";
        const a = document.createElement("a");
        a.href = r.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = r.title || r.url;
        h2.appendChild(a);
        cardBody.appendChild(h2);

        const stats = document.createElement("div");
        stats.className = "wh-stats";
        const addStat = (text, cls) => {
          const s = document.createElement("span");
          if (cls) s.className = cls;
          s.textContent = text;
          stats.appendChild(s);
        };
        if (r.priceEur) addStat(`€ ${r.priceEur}`, "wh-price");
        if (r.sqm) addStat(`${r.sqm} m²`);
        if (r.rooms) addStat(`${r.rooms} Zi.`);
        if (r.netEurPerSqm_guess) addStat(`€ ${r.netEurPerSqm_guess}/m²`);
        cardBody.appendChild(stats);

        if (r.raw) {
          const raw = document.createElement("pre");
          raw.className = "wh-raw";
          raw.textContent = r.raw;
          cardBody.appendChild(raw);
        }
        card.appendChild(cardBody);

        // Action buttons
        const actions = document.createElement("div");
        actions.className = "wh-actions";

        const btnStar = document.createElement("button");
        btnStar.className = "wh-btn" + (isStarred ? " wh-star-on" : "");
        btnStar.textContent = isStarred ? "★ Starred" : "☆ Star";
        btnStar.onclick = () => { toggleStarred(r.url); renderOverlay(rows); };
        actions.appendChild(btnStar);

        const btnHide = document.createElement("button");
        btnHide.className = "wh-btn" + (isHidden ? " wh-hide-on" : "");
        btnHide.textContent = isHidden ? "👁 Unhide" : "Hide";
        btnHide.onclick = () => { toggleHidden(r.url); renderOverlay(rows); };
        actions.appendChild(btnHide);

        card.appendChild(actions);
        grid.appendChild(card);
      }

      body.appendChild(grid);
    }

    wrap.appendChild(body);
    document.body.appendChild(wrap);
    log(`Overlay rendered: ${displayed.length} cards shown`);
  };

  // ── MAIN ──────────────────────────────────────────────────────────────────
  if (!location.host.includes("willhaben.at")) {
    console.error(
      `[willhaben] Not on willhaben.at (you're on ${location.host}).\n` +
      `Open this URL first:\n${SEARCH_URL}`
    );
    return;
  }

  window.__willhabenRun = async () => {
    log("Starting auto-scroll…");
    await autoScrollUntil();

    const allRows = uniq(extractListingsFromDOM(), "url");
    log(`Raw rows after scan: ${allRows.length}`);
    let rows = allRows.filter(passesFilters);
    log(`After filters: ${rows.length}`);
    rows = sortRows(rows).slice(0, CONFIG.TARGET);
    log(`Final: ${rows.length} rows`);

    window.__willhabenRows = rows;
    window.__willhabenAllRows = allRows;

    if (!CONFIG.DRY_RUN) renderOverlay(rows);
    return rows;
  };

  log(`Search URL: ${SEARCH_URL}`);
  await window.__willhabenRun();
})();
