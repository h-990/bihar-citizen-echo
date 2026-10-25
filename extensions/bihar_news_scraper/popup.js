/**
 * Popup Script for Bihar News & Public Grievance Multi-Tab Crawler.
 * Monitors the 3 parallel worker tabs (Dainik Bhaskar, Live Hindustan, Prabhat Khabar),
 * displays live grievance statistics, and handles real-time start/pause controls.
 */

document.addEventListener("DOMContentLoaded", () => {
  const wsStatus = document.getElementById("wsStatus");
  const wsStatusText = document.getElementById("wsStatusText");
  const toggleScrapeBtn = document.getElementById("toggleScrapeBtn");
  const scrapeStateLabel = document.getElementById("scrapeStateLabel");
  const totalScrapedCount = document.getElementById("totalScrapedCount");
  const totalGrievanceCount = document.getElementById("totalGrievanceCount");
  const activeTabsCount = document.getElementById("activeTabsCount");
  const badgeBhaskar = document.getElementById("badgeBhaskar");
  const badgeHindustan = document.getElementById("badgeHindustan");
  const badgePrabhat = document.getElementById("badgePrabhat");
  const reloadExtBtn = document.getElementById("reloadExtBtn");
  const logsConsole = document.getElementById("logsConsole");
  const clearLogsBtn = document.getElementById("clearLogsBtn");

  function refreshState() {
    chrome.runtime.sendMessage({ type: "GET_STATE" }, (res) => {
      if (chrome.runtime.lastError || !res) {
        updateWsStatus(false);
        return;
      }
      updateWsStatus(res.wsConnected);
      updateCrawlerUI(res);
    });
  }

  refreshState();
  const pollTimer = setInterval(refreshState, 1500);
  window.addEventListener("unload", () => clearInterval(pollTimer));

  // Toggle Parallel Crawler
  toggleScrapeBtn.addEventListener("click", () => {
    toggleScrapeBtn.disabled = true;
    chrome.runtime.sendMessage({ type: "TOGGLE_CRAWLER" }, (res) => {
      toggleScrapeBtn.disabled = false;
      refreshState();
    });
  });

  // Reload Extension
  if (reloadExtBtn) {
    reloadExtBtn.addEventListener("click", () => {
      reloadExtBtn.innerText = "Reloading...";
      chrome.runtime.reload();
    });
  }

  // Clear Logs
  if (clearLogsBtn) {
    clearLogsBtn.addEventListener("click", () => {
      logsConsole.innerHTML = '<div class="log-line info">Logs cleared.</div>';
    });
  }

  // Listen for messages from background script
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "WS_STATUS") {
      updateWsStatus(msg.connected);
    } else if (msg.type === "CRAWLER_STATE") {
      updateCrawlerUI(msg);
    } else if (msg.type === "LOG" && msg.log) {
      appendLog(msg.log);
    }
  });

  function updateWsStatus(connected) {
    if (!wsStatus || !wsStatusText) return;
    if (connected) {
      wsStatus.classList.add("connected");
      wsStatusText.innerText = "Connected";
    } else {
      wsStatus.classList.remove("connected");
      wsStatusText.innerText = "Offline";
    }
  }

  function updateCrawlerUI(state) {
    if (!state) return;

    const isActive = state.isCrawlerActive || state.isActive;
    const workerCount = state.activeWorkersCount || (state.workers ? state.workers.length : 0);

    // Main Toggle Button
    if (isActive) {
      toggleScrapeBtn.innerText = "⏸️ Pause 3-Tab Crawler";
      toggleScrapeBtn.style.background = "#e11d48";
      scrapeStateLabel.innerText = `Active (${workerCount} tabs running)`;
      scrapeStateLabel.style.color = "#34d399";
    } else {
      toggleScrapeBtn.innerText = "⚡ Launch 3-Tab Crawler";
      toggleScrapeBtn.style.background = "";
      scrapeStateLabel.innerText = "Stopped";
      scrapeStateLabel.style.color = "#94a3b8";
    }

    // Numbers
    if (totalScrapedCount && state.totalScraped !== undefined) {
      totalScrapedCount.innerText = state.totalScraped;
    }
    if (totalGrievanceCount && state.totalGrievances !== undefined) {
      totalGrievanceCount.innerText = state.totalGrievances;
    }
    if (activeTabsCount) {
      activeTabsCount.innerText = workerCount;
    }

    // Portal Badges
    const workers = state.workers || [];
    const bhaskarWorker = workers.find(w => w.portalId === "bhaskar" || (w.portalName && w.portalName.includes("Bhaskar")));
    const hindustanWorker = workers.find(w => w.portalId === "hindustan" || (w.portalName && w.portalName.includes("Hindustan")));
    const prabhatWorker = workers.find(w => w.portalId === "prabhat" || (w.portalName && w.portalName.includes("Prabhat")));

    updatePortalBadge(badgeBhaskar, bhaskarWorker, isActive);
    updatePortalBadge(badgeHindustan, hindustanWorker, isActive);
    updatePortalBadge(badgePrabhat, prabhatWorker, isActive);
  }

  function updatePortalBadge(el, worker, isActive) {
    if (!el) return;
    if (worker && isActive) {
      el.style.background = "#059669";
      el.style.color = "#ecfdf5";
      el.innerText = worker.queueLength > 0 ? `Crawling (${worker.queueLength} queued)` : "Scanning seed...";
    } else if (worker && !isActive) {
      el.style.background = "#475569";
      el.style.color = "#f1f5f9";
      el.innerText = "Paused";
    } else {
      el.style.background = "#1e293b";
      el.style.color = "#94a3b8";
      el.innerText = "Ready";
    }
  }

  function appendLog(log) {
    if (!logsConsole) return;
    const div = document.createElement("div");
    const lvl = (log.level || "INFO").toLowerCase();
    div.className = `log-line ${lvl}`;
    const time = new Date(log.timestamp).toLocaleTimeString();
    div.innerText = `[${time}] ${log.message}`;
    logsConsole.appendChild(div);
    logsConsole.scrollTop = logsConsole.scrollHeight;

    // Prune excessive log nodes
    while (logsConsole.childNodes.length > 100) {
      logsConsole.removeChild(logsConsole.firstChild);
    }
  }
});
