/**
 * Multi-Tab High-Speed Parallel Crawler Engine for Bihar Regional News.
 * Concurrently crawls 3 major Bihar media portals (Dainik Bhaskar, Live Hindustan, Prabhat Khabar),
 * prioritizes public grievances, and streams real-time news intelligence to the backend pipeline.
 */

const BACKEND_WS_URL = "ws://localhost:8000/ws/hub?client_type=scraper_ext";
const BACKEND_HTTP_URL = "http://localhost:8000";

let ws = null;
let reconnectTimer = null;

// ================= MULTI-PORTAL CONFIGURATION =================
const TARGET_PORTALS = [
  {
    id: "bhaskar",
    name: "Dainik Bhaskar Bihar",
    startUrl: "https://www.bhaskar.com/local/bihar/",
    fallbackSeeds: [
      "https://www.bhaskar.com/local/bihar/patna/",
      "https://www.bhaskar.com/local/bihar/muzaffarpur/",
      "https://www.bhaskar.com/local/bihar/gaya/",
      "https://www.bhaskar.com/local/bihar/bhagalpur/"
    ]
  },
  {
    id: "hindustan",
    name: "Live Hindustan Bihar",
    startUrl: "https://www.livehindustan.com/bihar/",
    fallbackSeeds: [
      "https://www.livehindustan.com/bihar/patna/",
      "https://www.livehindustan.com/bihar/muzaffarpur/",
      "https://www.livehindustan.com/bihar/purnia/"
    ]
  },
  {
    id: "prabhat",
    name: "Prabhat Khabar Bihar",
    startUrl: "https://www.prabhatkhabar.com/state/bihar",
    fallbackSeeds: [
      "https://www.prabhatkhabar.com/state/bihar/patna",
      "https://www.prabhatkhabar.com/state/bihar/muzaffarpur"
    ]
  }
];

// ================= CRAWLER SHARED STATE =================
let isCrawlerActive = false;
let visitedUrls = new Set();
let seenTitles = new Set();
let totalScraped = 0;
let totalGrievancesScraped = 0;
let portalPrefs = { bhaskar: true, hindustan: true, prabhat: true };
let scrapedItemsCache = [];

// Map of tabId -> WorkerState { portalId, portalName, queue: string[], seedIdx: number }
const workerTabs = new Map();

async function initStorage() {
  try {
    const data = await chrome.storage.local.get(["visited_urls", "seen_titles", "crawler_stats", "scraper_portal_prefs", "scraped_items_cache"]);
    if (data.visited_urls && Array.isArray(data.visited_urls)) {
      visitedUrls = new Set(data.visited_urls);
    }
    if (data.seen_titles && Array.isArray(data.seen_titles)) {
      seenTitles = new Set(data.seen_titles);
    }
    if (data.crawler_stats) {
      totalScraped = data.crawler_stats.totalScraped || 0;
      totalGrievancesScraped = data.crawler_stats.totalGrievances || 0;
    }
    if (data.scraper_portal_prefs) {
      portalPrefs = data.scraper_portal_prefs;
    }
    if (data.scraped_items_cache && Array.isArray(data.scraped_items_cache)) {
      scrapedItemsCache = data.scraped_items_cache;
    }
  } catch (e) {}
}
initStorage();

function saveStorage() {
  try {
    chrome.storage.local.set({
      visited_urls: Array.from(visitedUrls).slice(-1000),
      seen_titles: Array.from(seenTitles).slice(-1000),
      crawler_stats: {
        totalScraped: totalScraped,
        totalGrievances: totalGrievancesScraped,
        activeWorkers: workerTabs.size,
        isActive: isCrawlerActive
      }
    });
  } catch (e) {}
}

// Track Tab Closures
chrome.tabs.onRemoved.addListener((tabId) => {
  if (workerTabs.has(tabId)) {
    const worker = workerTabs.get(tabId);
    logLocal("INFO", `Worker tab for [${worker.portalName}] closed.`);
    workerTabs.delete(tabId);
    if (workerTabs.size === 0) {
      isCrawlerActive = false;
    }
    notifyPopup();
  }
});

// Alarm Keepalive for Service Worker
chrome.alarms.create("multitab_keepalive", { periodInMinutes: 0.35 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "multitab_keepalive") {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connectWebSocket();
    } else {
      try {
        ws.send(JSON.stringify({ type: "HEARTBEAT", timestamp: Date.now() }));
      } catch (e) {}
    }
  }
});

// Top level WS Connect
connectWebSocket();

function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  try {
    ws = new WebSocket(BACKEND_WS_URL);

    ws.onopen = () => {
      logLocal("SUCCESS", "Connected to Backend Server (Multi-Tab Scraper Extension).");
      notifyPopup({ type: "WS_STATUS", connected: true });
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "SCRAPER_STATUS",
          status: isCrawlerActive ? "active" : "idle"
        }));
      }
    };

    ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "START_CRAWLER" || msg.type === "TRIGGER_SCRAPE_TAB" || msg.type === "TRIGGER_SCRAPE_NOW") {
          startMultiTabCrawler();
        } else if (msg.type === "STOP_CRAWLER") {
          pauseMultiTabCrawler();
        }
      } catch (e) {}
    };

    ws.onclose = () => {
      notifyPopup({ type: "WS_STATUS", connected: false });
      ws = null;
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connectWebSocket, 2500);
    };

    ws.onerror = () => {
      notifyPopup({ type: "WS_STATUS", connected: false });
    };
  } catch (e) {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectWebSocket, 2500);
  }
}

// ================= MULTI-TAB SPAWNER & COORDINATOR =================

async function startMultiTabCrawler() {
  isCrawlerActive = true;
  const activePortals = TARGET_PORTALS.filter(p => portalPrefs[p.id] !== false);
  logLocal("SUCCESS", `Launching Multi-Tab Grievance Crawler across ${activePortals.length} enabled Bihar news portals...`);

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "SCRAPER_STATUS", status: "active" }));
  }

  const allOpenTabs = await chrome.tabs.query({});

  // Launch a dedicated worker tab for each enabled Bihar news portal
  for (let i = 0; i < activePortals.length; i++) {
    const portal = activePortals[i];

    // Check if a tab for this portal is already running
    let existingTab = allOpenTabs.find(t => t.url && t.url.includes(portal.id));
    if (existingTab && workerTabs.has(existingTab.id)) {
      continue;
    }

    if (existingTab) {
      workerTabs.set(existingTab.id, {
        portalId: portal.id,
        portalName: portal.name,
        queue: [],
        seedIdx: 0
      });
      logLocal("INFO", `Attached worker tab to existing ${portal.name} tab.`);
    } else {
      // Create new worker tab (first tab is active, subsequent tabs background)
      const isFirst = (i === 0);
      try {
        const newTab = await chrome.tabs.create({ url: portal.startUrl, active: isFirst });
        workerTabs.set(newTab.id, {
          portalId: portal.id,
          portalName: portal.name,
          queue: [],
          seedIdx: 0
        });
        logLocal("INFO", `Spawned [${portal.name}] worker tab (ID: ${newTab.id})`);
      } catch (e) {
        logLocal("ERROR", `Failed to spawn tab for ${portal.name}: ${e.message}`);
      }
    }
  }

  saveStorage();
  notifyPopup();
}

function pauseMultiTabCrawler() {
  isCrawlerActive = false;
  logLocal("INFO", "Multi-tab crawler paused.");
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "SCRAPER_STATUS", status: "idle" }));
  }
  notifyPopup();
}

async function navigateWorkerNext(tabId) {
  if (!isCrawlerActive) return;

  const worker = workerTabs.get(tabId);
  if (!worker) return;

  // 1. If worker has articles queued, navigate to the next article
  if (worker.queue.length > 0) {
    const nextUrl = worker.queue.shift();
    visitedUrls.add(nextUrl);
    saveStorage();

    logLocal("INFO", `[${worker.portalName}] Navigating to article (${worker.queue.length} left): ${nextUrl.substring(0, 55)}...`);
    try {
      await chrome.tabs.update(tabId, { url: nextUrl });
    } catch (e) {
      workerTabs.delete(tabId);
    }
  } else {
    // 2. Queue empty: Rotate to portal sub-sections (Patna, Muzaffarpur, Gaya, Purnia)
    const portalConfig = TARGET_PORTALS.find(p => p.id === worker.portalId) || TARGET_PORTALS[0];
    const seeds = portalConfig.fallbackSeeds || [portalConfig.startUrl];
    worker.seedIdx = (worker.seedIdx + 1) % seeds.length;
    const nextSeed = seeds[worker.seedIdx];

    logLocal("INFO", `[${worker.portalName}] Queue exhausted. Scanning regional section: ${nextSeed}`);
    try {
      await chrome.tabs.update(tabId, { url: nextSeed });
    } catch (e) {
      workerTabs.delete(tabId);
    }
  }

  notifyPopup();
}

// ================= MESSAGE PASSING WITH CONTENT SCRIPTS & POPUP =================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const senderTabId = sender?.tab?.id;

  if (request.type === "PAGE_HARVESTED_LINKS") {
    let worker = workerTabs.get(senderTabId);
    if (!worker) {
      // Auto-register unrecognized tab on supported portal
      const host = sender?.tab?.url || request.pageUrl || "";
      const matched = TARGET_PORTALS.find(p => host.includes(p.id)) || TARGET_PORTALS[0];
      worker = { portalId: matched.id, portalName: matched.name, queue: [], seedIdx: 0 };
      if (senderTabId) workerTabs.set(senderTabId, worker);
    }

    const unvisited = (request.links || []).filter(u => !visitedUrls.has(u) && !worker.queue.includes(u));
    worker.queue.push(...unvisited);

    logLocal("SUCCESS", `[${worker.portalName}] Discovered ${unvisited.length} fresh articles on page. Queue: ${worker.queue.length}`);
    saveStorage();

    // Fast trigger first article navigation
    if (isCrawlerActive && senderTabId) {
      setTimeout(() => navigateWorkerNext(senderTabId), 800);
    }
    sendResponse({ queued: unvisited.length });
    return true;

  } else if (request.type === "ARTICLE_SCRAPED") {
    const article = request.article;
    if (article && article.title && article.title.length > 10) {
      const norm = article.title.trim().toLowerCase();
      if (!seenTitles.has(norm)) {
        seenTitles.add(norm);
        visitedUrls.add(article.source_url);
        totalScraped++;
        if (article.is_grievance) totalGrievancesScraped++;
        saveStorage();

        // Maintain local items cache for export
        scrapedItemsCache.unshift(article);
        if (scrapedItemsCache.length > 300) scrapedItemsCache.pop();
        try {
          chrome.storage.local.set({ scraped_items_cache: scrapedItemsCache });
        } catch (e) {}

        const badge = article.is_grievance ? `🚨 [${article.grievance_category}]` : "📰";
        logLocal("SUCCESS", `${badge} [${article.district_hint}] "${article.title.substring(0, 42)}" (${article.source_name})`);

        sendScrapedItemsToBackend([article]);
      }
    }
    sendResponse({ received: true });
    return true;

  } else if (request.type === "REQUEST_NEXT_ARTICLE") {
    if (senderTabId) {
      navigateWorkerNext(senderTabId);
    }
    sendResponse({ navigating: true });
    return true;

  } else if (request.type === "GET_STATE") {
    const workersSummary = Array.from(workerTabs.entries()).map(([tabId, w]) => ({
      tabId,
      portalId: w.portalId,
      portalName: w.portalName,
      queueLength: w.queue.length
    }));

    sendResponse({
      wsConnected: ws ? ws.readyState === WebSocket.OPEN : false,
      isCrawlerActive: isCrawlerActive,
      activeWorkersCount: workerTabs.size,
      workers: workersSummary,
      totalScraped: totalScraped,
      totalGrievances: totalGrievancesScraped,
      portals: TARGET_PORTALS.map(p => ({ id: p.id, name: p.name, url: p.startUrl }))
    });
    return true;

  } else if (request.type === "TOGGLE_CRAWLER") {
    if (isCrawlerActive) {
      pauseMultiTabCrawler();
    } else {
      startMultiTabCrawler();
    }
    sendResponse({ isActive: isCrawlerActive });
    return true;

  } else if (request.type === "LAUNCH_MULTI_TAB") {
    startMultiTabCrawler();
    sendResponse({ started: true });
    return true;

  } else if (request.type === "UPDATE_PORTAL_PREFS") {
    if (request.prefs) {
      portalPrefs = { ...portalPrefs, ...request.prefs };
      logLocal("INFO", `Portal preferences updated: ${JSON.stringify(portalPrefs)}`);
    }
    sendResponse({ updated: true });
    return true;
  }
});

function sendScrapedItemsToBackend(items) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: "SCRAPER_RAW_ITEMS",
      items: items
    }));
  } else {
    fetch(`${BACKEND_HTTP_URL}/api/raw_news`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(items)
    }).catch(() => {});
  }
}

function logLocal(level, message) {
  const timestamp = Date.now();
  console.log(`[${new Date(timestamp).toLocaleTimeString()}] [${level}] ${message}`);

  notifyPopup({ type: "LOG", log: { timestamp, level, message } });

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: "SCRAPER_LOG",
      level: level,
      message: message
    }));
  }
}

function updateActionBadge() {
  try {
    if (chrome.action && chrome.action.setBadgeText) {
      if (isCrawlerActive) {
        chrome.action.setBadgeText({ text: workerTabs.size > 0 ? `${workerTabs.size}T` : "ON" });
        chrome.action.setBadgeBackgroundColor({ color: "#0284c7" });
      } else {
        chrome.action.setBadgeText({ text: "" });
      }
    }
  } catch (e) {}
}

function notifyPopup(payload = null) {
  updateActionBadge();
  const workersSummary = Array.from(workerTabs.entries()).map(([tabId, w]) => ({
    tabId,
    portalId: w.portalId,
    portalName: w.portalName,
    queueLength: w.queue.length
  }));
  chrome.runtime.sendMessage(payload || {
    type: "CRAWLER_STATE",
    isActive: isCrawlerActive,
    activeWorkersCount: workerTabs.size,
    workers: workersSummary,
    totalScraped: totalScraped,
    totalGrievances: totalGrievancesScraped
  }).catch(() => {});
}
