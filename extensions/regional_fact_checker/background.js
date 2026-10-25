/**
 * Background Service Worker for Bihar Regional Fact-Checker & Authenticity Ext.
 * Connects to the pipeline WebSocket hub as 'factcheck_ext'.
 * Analyzes credibility score (1-100), rumor patterns, and political mudslinging flags.
 */

const BACKEND_WS_URL = "ws://localhost:8000/ws/hub?client_type=factcheck_ext";

let ws = null;
let reconnectTimer = null;

const DEFAULT_CONFIG = {
  flagClickbait: true,
  strictOfficialSources: false,
  totalFactChecked: 0
};

// Initialize
chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get("factcheck_config");
  if (!existing.factcheck_config) {
    await chrome.storage.local.set({ factcheck_config: DEFAULT_CONFIG });
  }
  logLocal("INFO", "Regional Fact-Checker extension installed.");
  connectWebSocket();
});

chrome.runtime.onStartup.addListener(() => {
  connectWebSocket();
});

// Alarm keepalive
chrome.alarms.create("factcheck_keepalive", { periodInMinutes: 0.35 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "factcheck_keepalive") {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connectWebSocket();
    } else {
      try {
        ws.send(JSON.stringify({ type: "HEARTBEAT", timestamp: Date.now() }));
      } catch (e) {}
    }
  }
});

// Top level connect
connectWebSocket();

function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  logLocal("INFO", "Connecting to backend WebSocket at " + BACKEND_WS_URL);
  try {
    ws = new WebSocket(BACKEND_WS_URL);

    ws.onopen = () => {
      logLocal("SUCCESS", "Connected to Backend Server (Fact-Checker Extension).");
      notifyPopup({ type: "WS_STATUS", connected: true });
      ws.send(JSON.stringify({
        type: "FACTCHECK_READY",
        status: "idle",
        node: "nodeFactcheck"
      }));
    };

    ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleBackendMessage(msg);
      } catch (e) {
        logLocal("ERROR", "Error parsing factcheck task: " + e.message);
      }
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

// Keepalive port listener
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "factcheck_popup_keepalive") {
    logLocal("INFO", "Popup keepalive port active.");
  }
});

// Process task from Backend
async function handleBackendMessage(msg) {
  if (msg.type === "EVALUATE_FACTCHECK") {
    const item = msg.item || {};
    const rawId = msg.raw_id || item.id || `item_${Date.now()}`;

    logLocal("INFO", `Fact-checking report: [${(item.title || "Untitled").substring(0, 35)}]`);
    
    const factResult = evaluateAuthenticity(item);

    chrome.storage.local.get("factcheck_config", ({ factcheck_config }) => {
      const cfg = factcheck_config || DEFAULT_CONFIG;
      cfg.totalFactChecked = (cfg.totalFactChecked || 0) + 1;
      chrome.storage.local.set({ factcheck_config: cfg });
    });

    logLocal("SUCCESS", `Verdict: [${factResult.authenticity_verdict}] Credibility: ${factResult.credibility_score}/100`);

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "FACTCHECK_RESULT",
        raw_id: rawId,
        factcheck_data: factResult
      }));
    }
  }
}

/**
 * Regional Authenticity & Verification Logic
 */
function evaluateAuthenticity(item) {
  const text = `${item.title || ""} ${item.snippet || ""} ${item.content || ""} ${item.source_name || ""}`.toLowerCase();
  
  let credibility = 80; // Baseline for recognized local sources
  let verdict = "VERIFIED_REGIONAL_REPORT";
  let sensationalism = "LOW";
  let notes = "Verified against known Bihar regional reporting patterns.";

  // Check 1: Known Established Publications
  const establishedSources = ["bhaskar", "prabhat", "hindustan", "jagran", "bihar.gov", "patna municipal", "dd news"];
  const isEstablished = establishedSources.some(s => text.includes(s));

  if (!isEstablished) {
    credibility -= 20;
    notes = "Source is an independent or social feed aggregator. Verification recommended.";
  }

  // Check 2: Political mudslinging / unsubstantiated claims
  if (text.includes("जुमला") || text.includes("पर्दाफाश") || text.includes("हंगामा") || text.includes("बड़ा खुलासा") || text.includes("मचा हड़कंप")) {
    sensationalism = "HIGH_CLICKBAIT";
    credibility -= 25;
    verdict = "POLITICAL_PROPAGANDA_SUSPECTED";
    notes = "High density of sensationalist buzzwords and political hyperbole detected.";
  }

  // Check 3: Social Rumor / WhatsApp forward signals
  if (text.includes("वायरल") || text.includes("दावा किया जा रहा") || text.includes("सूत्रों के अनुसार") || text.includes("अफवाह")) {
    credibility -= 30;
    verdict = "UNVERIFIED_SOCIAL_RUMOR";
    sensationalism = "MODERATE";
    notes = "Unverified anonymous claims flagged. Lacks official administrative confirmation.";
  }

  // Check 4: Official Administration or Hospital Attribution
  if (text.includes("जिलाधिकारी") || text.includes("dm patna") || text.includes("नगर आयुक्त") || text.includes("सिविल सर्जन") || text.includes("थानाध्यक्ष") || text.includes("सदर अस्पताल")) {
    credibility = Math.min(98, credibility + 15);
    if (verdict !== "UNVERIFIED_SOCIAL_RUMOR") {
      verdict = "VERIFIED_REGIONAL_REPORT";
      notes = "Direct attribution to Bihar administrative or medical officials identified.";
    }
  }

  credibility = Math.max(15, Math.min(99, credibility));

  return {
    credibility_score: credibility,
    authenticity_verdict: verdict,
    sensationalism_index: sensationalism,
    verification_notes: notes,
    factchecked_at: Date.now() / 1000
  };
}

function logLocal(level, message) {
  const timestamp = Date.now();
  console.log(`[${new Date(timestamp).toLocaleTimeString()}] [${level}] ${message}`);

  chrome.storage.local.get("factcheck_logs", ({ factcheck_logs }) => {
    const logs = factcheck_logs || [];
    logs.push({ timestamp, level, message });
    if (logs.length > 80) logs.shift();
    chrome.storage.local.set({ factcheck_logs: logs });
  });

  notifyPopup({ type: "LOG", log: { timestamp, level, message } });

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: "FACTCHECK_LOG",
      level: level,
      message: message
    }));
  }
}

function notifyPopup(payload) {
  chrome.runtime.sendMessage(payload).catch(() => {});
}

// Messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "GET_STATE") {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connectWebSocket();
    }
    chrome.storage.local.get(["factcheck_config", "factcheck_logs"], (data) => {
      sendResponse({
        config: data.factcheck_config || DEFAULT_CONFIG,
        logs: data.factcheck_logs || [],
        wsConnected: ws ? ws.readyState === WebSocket.OPEN : false
      });
    });
    return true;

  } else if (request.type === "SET_CONFIG") {
    chrome.storage.local.get("factcheck_config", async ({ factcheck_config }) => {
      const updated = { ...(factcheck_config || DEFAULT_CONFIG), ...request.config };
      await chrome.storage.local.set({ factcheck_config: updated });
      sendResponse({ config: updated });
    });
    return true;

  } else if (request.type === "TEST_FACTCHECK_MANUAL") {
    const sample = {
      title: request.title || "सोशल मीडिया पर दावा: पटना में कल से 3 दिन तक बिजली बंद, मचा हड़कंप",
      snippet: "व्हाट्सएप ग्रुप्स में वायरल हो रहा मैसेज, प्रशासन ने नहीं की पुष्टि",
      source_name: "Social Viral Wire"
    };
    const scored = evaluateAuthenticity(sample);
    logLocal("SUCCESS", `Manual Test: [${scored.authenticity_verdict}] Score: ${scored.credibility_score}`);

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "FACTCHECK_RESULT",
        raw_id: "test_" + Date.now(),
        factcheck_data: scored
      }));
    }
    sendResponse({ result: scored });
    return true;
  }
});
