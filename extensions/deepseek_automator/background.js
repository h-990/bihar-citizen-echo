/**
 * Background Service Worker for DeepSeek AI Web Automator Extension.
 * - Bridges backend WebSocket commands to the chat.deepseek.com content script runtime.
 * - Auto-discovers and focuses existing DeepSeek tabs without creating duplicates.
 * - Persistent keepalive via chrome.alarms.
 */

const BACKEND_WS_URL = "ws://localhost:8000/ws/hub?client_type=deepseek_ext";

let ws = null;
let reconnectTimer = null;
let activeDeepSeekTabId = null;
let isProcessing = false;

// Default config
const DEFAULT_CONFIG = {
  throttleDelayMs: 4000,
  disableDeepThink: true,
  autoInjectNewChat: false,
  totalProcessedCount: 0
};

// Initialize
chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get("deepseek_config");
  if (!existing.deepseek_config) {
    await chrome.storage.local.set({ deepseek_config: DEFAULT_CONFIG });
  }
  logLocal("INFO", "DeepSeek Web Automator Extension installed.");
  connectWebSocket();
  locateDeepSeekTab();
});

chrome.runtime.onStartup.addListener(() => {
  connectWebSocket();
  locateDeepSeekTab();
});

// Keepalive alarm to prevent MV3 service worker from dying
chrome.alarms.create("deepseek_keepalive", { periodInMinutes: 0.35 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "deepseek_keepalive") {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connectWebSocket();
    } else {
      try {
        ws.send(JSON.stringify({ type: "HEARTBEAT", timestamp: Date.now() }));
      } catch (e) {}
    }
    locateDeepSeekTab();
  }
});

// Top-level auto connect
connectWebSocket();
locateDeepSeekTab();

function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  logLocal("INFO", "Connecting to backend WebSocket at " + BACKEND_WS_URL);
  try {
    ws = new WebSocket(BACKEND_WS_URL);

    ws.onopen = () => {
      logLocal("SUCCESS", "Connected to Backend Server (DeepSeek Automator).");
      notifyPopup({ type: "WS_STATUS", connected: true });
      checkAndSendReady();
    };

    ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleBackendTask(msg);
      } catch (e) {
        logLocal("ERROR", "Error handling backend message: " + e.message);
      }
    };

    ws.onclose = () => {
      notifyPopup({ type: "WS_STATUS", connected: false });
      ws = null;
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connectWebSocket, 2500);
    };

    ws.onerror = (err) => {
      notifyPopup({ type: "WS_STATUS", connected: false });
    };
  } catch (e) {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectWebSocket, 2500);
  }
}

// Listen for persistent keepalive port from DeepSeek content script
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "deepseek_keepalive_port") {
    if (port.sender && port.sender.tab) {
      activeDeepSeekTabId = port.sender.tab.id;
      chrome.storage.local.set({ activeDeepSeekTabId: activeDeepSeekTabId });
      logLocal("INFO", `DeepSeek keepalive port active for tab ${activeDeepSeekTabId}`);
      notifyPopup({ type: "TAB_STATUS", found: true, tabId: activeDeepSeekTabId });
      checkAndSendReady();
    }
  }
});

// Dynamic Content Script Injection for Pre-Existing or Restored Tabs
async function ensureContentScriptInjected(tabId) {
  if (!tabId) return false;
  try {
    // 1. Ping tab to check if content script is active
    const pong = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { type: "PING" }, (res) => {
        if (chrome.runtime.lastError || !res || res.status !== "pong") {
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });

    if (pong) return true;

    // 2. Tab is open but content script is not running - inject programmatically
    logLocal("INFO", `Dynamically injecting content script into DeepSeek tab ${tabId}...`);
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ["content_script.js"]
    });

    // Wait 200ms for script initialization
    await new Promise(r => setTimeout(r, 200));

    // 3. Re-verify ping
    const recheck = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { type: "PING" }, (res) => {
        if (chrome.runtime.lastError || !res || res.status !== "pong") {
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });

    return recheck;
  } catch (err) {
    logLocal("WARN", `Could not auto-inject content script into tab ${tabId}: ${err.message}`);
    return false;
  }
}

async function locateDeepSeekTab() {
  try {
    // 1. Search all tabs across all windows for any open DeepSeek tab
    const allTabs = await chrome.tabs.query({});
    const dsTab = allTabs.find(t => 
      (t.url && t.url.toLowerCase().includes("deepseek")) ||
      (t.pendingUrl && t.pendingUrl.toLowerCase().includes("deepseek")) ||
      (t.title && t.title.toLowerCase().includes("deepseek"))
    );

    if (dsTab) {
      activeDeepSeekTabId = dsTab.id;
      await chrome.storage.local.set({ activeDeepSeekTabId: dsTab.id });
      // Ensure content script is mounted in this tab
      await ensureContentScriptInjected(dsTab.id);
      notifyPopup({ type: "TAB_STATUS", found: true, tabId: activeDeepSeekTabId });
      checkAndSendReady();
      return activeDeepSeekTabId;
    }

    // 2. Fallback check stored tab ID if query missed it
    const stored = await chrome.storage.local.get("activeDeepSeekTabId");
    if (stored && stored.activeDeepSeekTabId) {
      try {
        const tab = await chrome.tabs.get(stored.activeDeepSeekTabId);
        if (tab && ((tab.url && tab.url.includes("deepseek")) || (tab.title && tab.title.toLowerCase().includes("deepseek")))) {
          activeDeepSeekTabId = tab.id;
          await ensureContentScriptInjected(tab.id);
          notifyPopup({ type: "TAB_STATUS", found: true, tabId: activeDeepSeekTabId });
          checkAndSendReady();
          return activeDeepSeekTabId;
        }
      } catch (e) {}
    }

    activeDeepSeekTabId = null;
    notifyPopup({ type: "TAB_STATUS", found: false });
    return null;
  } catch (e) {
    return null;
  }
}

function checkAndSendReady() {
  if (ws && ws.readyState === WebSocket.OPEN && !isProcessing) {
    ws.send(JSON.stringify({
      type: "DEEPSEEK_READY",
      status: "idle",
      tab_id: activeDeepSeekTabId
    }));
  }
}

// Handle Tasks from Backend
async function handleBackendTask(msg) {
  if (msg.type === "PROCESS_NEWS_ITEM") {
    const rawId = msg.raw_id;
    const prompt = msg.prompt;
    const title = msg.title || "";

    const tabId = await locateDeepSeekTab();
    if (!tabId) {
      logLocal("WARN", "DeepSeek tab not found. Waiting for user to open chat.deepseek.com...");
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "DEEPSEEK_ERROR",
          raw_id: rawId,
          error: "DeepSeek tab not found. Please open chat.deepseek.com in Chrome."
        }));
      }
      isProcessing = false;
      return;
    }

    const isReady = await ensureContentScriptInjected(tabId);
    if (!isReady) {
      logLocal("ERROR", `Content script not responding in DeepSeek tab ${tabId}.`);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "DEEPSEEK_ERROR",
          raw_id: rawId,
          error: "DeepSeek tab is not responsive. Please refresh chat.deepseek.com."
        }));
      }
      isProcessing = false;
      return;
    }

    isProcessing = true;
    logLocal("INFO", `Injecting prompt for [${title.substring(0, 35)}] into DeepSeek tab...`);

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "DEEPSEEK_BUSY", raw_id: rawId }));
    }

    chrome.tabs.sendMessage(tabId, {
      type: "EXECUTE_PROMPT",
      prompt: prompt,
      raw_id: rawId,
      is_custom: false,
      enable_websearch: Boolean(msg.enable_websearch),
      bypass_deepthink: msg.bypass_deepthink !== false
    }, (response) => {
      if (chrome.runtime.lastError) {
        logLocal("ERROR", `Failed communicating with tab: ${chrome.runtime.lastError.message}`);
        isProcessing = false;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: "DEEPSEEK_ERROR",
            raw_id: rawId,
            error: chrome.runtime.lastError.message
          }));
        }
        checkAndSendReady();
      }
    });

  } else if (msg.type === "INJECT_USER_QUERY") {
    const text = msg.text;
    const tabId = await locateDeepSeekTab();
    if (!tabId) {
      logLocal("ERROR", "Cannot inject priority query: No DeepSeek tab open.");
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "DEEPSEEK_ERROR",
          raw_id: "custom_user_query",
          error: "No DeepSeek tab open. Please open chat.deepseek.com first."
        }));
      }
      isProcessing = false;
      return;
    }

    const isReady = await ensureContentScriptInjected(tabId);
    if (!isReady) {
      logLocal("ERROR", "Cannot inject priority query: Tab content script not responding.");
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "DEEPSEEK_ERROR",
          raw_id: "custom_user_query",
          error: "DeepSeek tab is not responsive. Please refresh chat.deepseek.com."
        }));
      }
      isProcessing = false;
      return;
    }

    isProcessing = true;
    logLocal("WARN", `Injecting PRIORITY user prompt: "${text.substring(0, 45)}"`);

    chrome.tabs.sendMessage(tabId, {
      type: "EXECUTE_PROMPT",
      prompt: text,
      is_custom: true
    }, (response) => {
      if (chrome.runtime.lastError) {
        logLocal("ERROR", `Failed sending custom query: ${chrome.runtime.lastError.message}`);
        isProcessing = false;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: "DEEPSEEK_ERROR",
            raw_id: "custom_user_query",
            error: chrome.runtime.lastError.message
          }));
        }
      }
    });
  }
}

function logLocal(level, message) {
  const timestamp = Date.now();
  console.log(`[${new Date(timestamp).toLocaleTimeString()}] [${level}] ${message}`);

  chrome.storage.local.get("deepseek_logs", ({ deepseek_logs }) => {
    const logs = deepseek_logs || [];
    logs.push({ timestamp, level, message });
    if (logs.length > 80) logs.shift();
    chrome.storage.local.set({ deepseek_logs: logs });
  });

  notifyPopup({ type: "LOG", log: { timestamp, level, message } });

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: "DEEPSEEK_LOG",
      level: level,
      message: message
    }));
  }
}

function notifyPopup(payload) {
  chrome.runtime.sendMessage(payload).catch(() => {});
}

// Track tab updates or removals
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === activeDeepSeekTabId) {
    activeDeepSeekTabId = null;
    notifyPopup({ type: "TAB_STATUS", found: false });
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab.url && tab.url.includes("deepseek.com")) {
    activeDeepSeekTabId = tabId;
    notifyPopup({ type: "TAB_STATUS", found: true, tabId });
    checkAndSendReady();
  }
});

// Messages from Content Script or Popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "CONTENT_SCRIPT_MOUNTED") {
    activeDeepSeekTabId = sender.tab ? sender.tab.id : activeDeepSeekTabId;
    logLocal("SUCCESS", "DeepSeek runtime content script mounted in tab " + activeDeepSeekTabId);
    notifyPopup({ type: "TAB_STATUS", found: true, tabId: activeDeepSeekTabId });
    checkAndSendReady();
    sendResponse({ ack: true });
    return true;

  } else if (request.type === "FOCUS_OR_OPEN_TAB") {
    locateDeepSeekTab().then(async (foundTabId) => {
      if (foundTabId) {
        try {
          const tab = await chrome.tabs.get(foundTabId);
          if (tab) {
            await chrome.windows.update(tab.windowId, { focused: true });
            await chrome.tabs.update(tab.id, { active: true });
            sendResponse({ success: true, tabId: tab.id, focused: true });
            return;
          }
        } catch (e) {}
      }
      // Only create new tab if none exists anywhere
      chrome.tabs.create({ url: "https://chat.deepseek.com/" }, (newTab) => {
        activeDeepSeekTabId = newTab.id;
        chrome.storage.local.set({ activeDeepSeekTabId: newTab.id });
        sendResponse({ success: true, tabId: newTab.id, created: true });
      });
    });
    return true;

  } else if (request.type === "PROMPT_COMPLETED") {
    isProcessing = false;
    const rawId = request.raw_id;
    const resultText = request.result_text;
    const isCustom = request.is_custom;

    logLocal("SUCCESS", `DeepSeek generation complete (${resultText.length} chars).`);

    chrome.storage.local.get("deepseek_config", ({ deepseek_config }) => {
      const cfg = deepseek_config || DEFAULT_CONFIG;
      cfg.totalProcessedCount = (cfg.totalProcessedCount || 0) + 1;
      chrome.storage.local.set({ deepseek_config: cfg });
    });

    // Notify Popup so standalone test UI completes immediately
    notifyPopup({
      type: "PROMPT_COMPLETED",
      raw_id: rawId,
      result_text: resultText,
      is_custom: isCustom
    });

    if (isCustom) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "DEEPSEEK_CUSTOM_RESPONSE",
          text: resultText
        }));
      }
    } else {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "DEEPSEEK_PROCESSED_RESULT",
          raw_id: rawId,
          raw_ai_response: resultText
        }));
      }
    }

    sendResponse({ ack: true });
    return true;

  } else if (request.type === "DEEPSEEK_ERROR") {
    isProcessing = false;
    const rawId = request.raw_id;
    const errorMsg = request.error || "Execution error in DeepSeek tab";
    logLocal("ERROR", `DeepSeek execution failed for [${rawId}]: ${errorMsg}`);

    // Notify Popup so test UI updates on error
    notifyPopup({
      type: "DEEPSEEK_ERROR",
      raw_id: rawId,
      error: errorMsg
    });

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "DEEPSEEK_ERROR",
        raw_id: rawId,
        error: errorMsg
      }));
    }
    checkAndSendReady();
    sendResponse({ ack: true });
    return true;

  } else if (request.type === "GET_STATE") {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connectWebSocket();
    }
    locateDeepSeekTab().then((tabId) => {
      chrome.storage.local.get(["deepseek_config", "deepseek_logs"], (data) => {
        sendResponse({
          config: data.deepseek_config || DEFAULT_CONFIG,
          logs: data.deepseek_logs || [],
          wsConnected: ws ? ws.readyState === WebSocket.OPEN : false,
          hasTab: !!tabId,
          tabId: tabId,
          isProcessing: isProcessing
        });
      });
    });
    return true;

  } else if (request.type === "SET_CONFIG") {
    chrome.storage.local.get("deepseek_config", async ({ deepseek_config }) => {
      const updated = { ...(deepseek_config || DEFAULT_CONFIG), ...request.config };
      await chrome.storage.local.set({ deepseek_config: updated });
      sendResponse({ config: updated });
    });
    return true;

  } else if (request.type === "TEST_PROMPT_MANUAL") {
    locateDeepSeekTab().then(async (tabId) => {
      if (!tabId) {
        sendResponse({ error: "No DeepSeek tab open. Click 'Open DeepSeek' button." });
        return;
      }

      const isReady = await ensureContentScriptInjected(tabId);
      if (!isReady) {
        sendResponse({ error: "DeepSeek tab not responsive. Please refresh chat.deepseek.com." });
        return;
      }

      isProcessing = true;
      chrome.tabs.sendMessage(tabId, {
        type: "EXECUTE_PROMPT",
        prompt: request.prompt,
        raw_id: "test_" + Date.now(),
        is_custom: true
      }, () => {
        if (chrome.runtime.lastError) {
          isProcessing = false;
          notifyPopup({ type: "DEEPSEEK_ERROR", error: chrome.runtime.lastError.message });
          sendResponse({ error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ initiated: true });
        }
      });
    });
    return true;
  }
});
