/**
 * Popup Script for Bihar Civic Priority & Severity Analyzer.
 */

document.addEventListener("DOMContentLoaded", () => {
  // Keep background worker alive while popup is open
  try {
    chrome.runtime.connect({ name: "severity_popup_keepalive" });
  } catch (e) {}

  const wsStatus = document.getElementById("wsStatus");
  const wsStatusText = document.getElementById("wsStatusText");
  const totalScoredCount = document.getElementById("totalScoredCount");
  const thresholdSlider = document.getElementById("thresholdSlider");
  const thresholdValue = document.getElementById("thresholdValue");
  const autoHealthToggle = document.getElementById("autoHealthToggle");
  const runSampleScoreBtn = document.getElementById("runSampleScoreBtn");
  const testOutputBox = document.getElementById("testOutputBox");
  const scoreCircle = document.getElementById("scoreCircle");
  const priorityBadge = document.getElementById("priorityBadge");
  const categoryText = document.getElementById("categoryText");
  const recommendationsList = document.getElementById("recommendationsList");
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

  thresholdSlider.addEventListener("input", (e) => {
    thresholdValue.innerText = e.target.value;
  });

  thresholdSlider.addEventListener("change", (e) => {
    chrome.runtime.sendMessage({
      type: "SET_CONFIG",
      config: { sensitivityThreshold: parseInt(e.target.value) }
    });
  });

  autoHealthToggle.addEventListener("change", (e) => {
    chrome.runtime.sendMessage({
      type: "SET_CONFIG",
      config: { autoPrioritizeHealthHazards: e.target.checked }
    });
  });

  runSampleScoreBtn.addEventListener("click", () => {
    runSampleScoreBtn.disabled = true;
    runSampleScoreBtn.innerText = "Evaluating...";

    chrome.runtime.sendMessage({
      type: "TEST_SEVERITY_MANUAL",
      title: "पटना कंकड़बाग में संप हाउस की मोटर जलने से 4 फीट जलजमाव, सैकड़ों घरों में गंदा नाले का पानी घुसा",
      snippet: "सैकड़ों घरों में गंदा नाले का पानी घुसा, डेंगू का भारी प्रकोप",
      district: "Patna"
    }, (res) => {
      runSampleScoreBtn.disabled = false;
      runSampleScoreBtn.innerText = "⚡ Score Sample";

      if (res && res.result) {
        renderScoreResult(res.result);
      }
    });
  });

  clearLogsBtn.addEventListener("click", () => {
    chrome.storage.local.set({ severity_logs: [] }, () => {
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
    totalScoredCount.innerText = cfg.totalScored || 0;
    thresholdSlider.value = cfg.sensitivityThreshold || 50;
    thresholdValue.innerText = cfg.sensitivityThreshold || 50;
    autoHealthToggle.checked = cfg.autoPrioritizeHealthHazards !== false;
  }

  function renderScoreResult(scored) {
    testOutputBox.classList.remove("hidden");
    scoreCircle.innerText = scored.hazard_score;
    
    if (scored.hazard_score >= 80) {
      scoreCircle.style.background = "#7f1d1d";
      scoreCircle.style.borderColor = "#ef4444";
      priorityBadge.style.background = "#ef4444";
    } else if (scored.hazard_score >= 60) {
      scoreCircle.style.background = "#78350f";
      scoreCircle.style.borderColor = "#f59e0b";
      priorityBadge.style.background = "#f59e0b";
    } else {
      scoreCircle.style.background = "#064e3b";
      scoreCircle.style.borderColor = "#10b981";
      priorityBadge.style.background = "#10b981";
    }

    priorityBadge.innerText = scored.response_priority;
    categoryText.innerText = scored.hazard_category;

    recommendationsList.innerHTML = "";
    (scored.actionable_recommendations || []).forEach(r => {
      const li = document.createElement("li");
      li.innerText = r;
      recommendationsList.appendChild(li);
    });
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
