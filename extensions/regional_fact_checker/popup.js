/**
 * Popup Script for Bihar Regional Fact-Checker & Authenticity Ext.
 */

document.addEventListener("DOMContentLoaded", () => {
  // Keep background worker alive while popup is open
  try {
    chrome.runtime.connect({ name: "factcheck_popup_keepalive" });
  } catch (e) {}

  const wsStatus = document.getElementById("wsStatus");
  const wsStatusText = document.getElementById("wsStatusText");
  const totalCheckedCount = document.getElementById("totalCheckedCount");
  const flagClickbaitToggle = document.getElementById("flagClickbaitToggle");
  const strictOfficialToggle = document.getElementById("strictOfficialToggle");
  const runFactcheckTestBtn = document.getElementById("runFactcheckTestBtn");
  const testOutputBox = document.getElementById("testOutputBox");
  const credibilityPill = document.getElementById("credibilityPill");
  const verdictBadge = document.getElementById("verdictBadge");
  const verificationNotes = document.getElementById("verificationNotes");
  const logsConsole = document.getElementById("logsConsole");
  const clearLogsBtn = document.getElementById("clearLogsBtn");

  function refreshState() {
    chrome.runtime.sendMessage({ type: "GET_STATE" }, (res) => {
      if (chrome.runtime.lastError || !res) {
        updateWsStatus(false);
        return;
      }
      updateWsStatus(res.wsConnected);
      updateConfigUI(res.config);
      renderLogs(res.logs);
    });
  }

  refreshState();
  const pollTimer = setInterval(refreshState, 1500);
  window.addEventListener("unload", () => clearInterval(pollTimer));

  flagClickbaitToggle.addEventListener("change", (e) => {
    chrome.runtime.sendMessage({
      type: "SET_CONFIG",
      config: { flagClickbait: e.target.checked }
    });
  });

  strictOfficialToggle.addEventListener("change", (e) => {
    chrome.runtime.sendMessage({
      type: "SET_CONFIG",
      config: { strictOfficialSources: e.target.checked }
    });
  });

  runFactcheckTestBtn.addEventListener("click", () => {
    runFactcheckTestBtn.disabled = true;
    runFactcheckTestBtn.innerText = "Checking...";

    chrome.runtime.sendMessage({
      type: "TEST_FACTCHECK_MANUAL",
      title: "सोशल मीडिया पर दावा: पटना में कल से 3 दिन तक बिजली बंद, मचा हड़कंप",
      snippet: "व्हाट्सएप ग्रुप्स में वायरल हो रहा मैसेज, प्रशासन ने नहीं की पुष्टि",
      source_name: "Social Viral Wire"
    }, (res) => {
      runFactcheckTestBtn.disabled = false;
      runFactcheckTestBtn.innerText = "⚡ Check Sample";

      if (res && res.result) {
        renderFactcheckResult(res.result);
      }
    });
  });

  clearLogsBtn.addEventListener("click", () => {
    chrome.storage.local.set({ factcheck_logs: [] }, () => {
      logsConsole.innerHTML = '<div class="log-line info">Logs cleared.</div>';
    });
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "WS_STATUS") {
      updateWsStatus(msg.connected);
    } else if (msg.type === "LOG" && msg.log) {
      appendLog(msg.log);
    }
  });

  function updateWsStatus(connected) {
    if (connected) {
      wsStatus.classList.add("connected");
      wsStatusText.innerText = "Connected";
    } else {
      wsStatus.classList.remove("connected");
      wsStatusText.innerText = "Offline";
    }
  }

  function updateConfigUI(cfg) {
    if (!cfg) return;
    totalCheckedCount.innerText = cfg.totalFactChecked || 0;
    flagClickbaitToggle.checked = cfg.flagClickbait !== false;
    strictOfficialToggle.checked = cfg.strictOfficialSources === true;
  }

  function renderFactcheckResult(res) {
    testOutputBox.classList.remove("hidden");
    credibilityPill.innerText = `Credibility: ${res.credibility_score}/100`;

    if (res.authenticity_verdict === "VERIFIED_REGIONAL_REPORT") {
      verdictBadge.style.background = "#10b981";
      verdictBadge.style.color = "white";
    } else if (res.authenticity_verdict === "UNVERIFIED_SOCIAL_RUMOR") {
      verdictBadge.style.background = "#f59e0b";
      verdictBadge.style.color = "black";
    } else {
      verdictBadge.style.background = "#ef4444";
      verdictBadge.style.color = "white";
    }

    verdictBadge.innerText = res.authenticity_verdict;
    verificationNotes.innerText = `${res.verification_notes} (Sensationalism: ${res.sensationalism_index})`;
  }

  function renderLogs(logs) {
    logsConsole.innerHTML = "";
    if (!logs || logs.length === 0) {
      logsConsole.innerHTML = '<div class="log-line info">No events recorded.</div>';
      return;
    }
    logs.slice(-20).forEach(appendLog);
  }

  function appendLog(log) {
    const div = document.createElement("div");
    const lvl = (log.level || "INFO").toLowerCase();
    div.className = `log-line ${lvl}`;
    const time = new Date(log.timestamp).toLocaleTimeString();
    div.innerText = `[${time}] ${log.message}`;
    logsConsole.appendChild(div);
    logsConsole.scrollTop = logsConsole.scrollHeight;
  }
});
