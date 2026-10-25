/**
 * Popup Script for DeepSeek AI Automator.
 * Manages tab detection, throttle delay slider, bypass toggles,
 * and standalone prompt execution tests.
 */

document.addEventListener("DOMContentLoaded", () => {
  const wsStatus = document.getElementById("wsStatus");
  const wsStatusText = document.getElementById("wsStatusText");
  const tabIndicator = document.getElementById("tabIndicator");
  const tabStatusLabel = document.getElementById("tabStatusLabel");
  const openDeepSeekBtn = document.getElementById("openDeepSeekBtn");
  const throttleSlider = document.getElementById("throttleSlider");
  const throttleValue = document.getElementById("throttleValue");
  const disableDeepThinkToggle = document.getElementById("disableDeepThinkToggle");
  const totalProcessedCount = document.getElementById("totalProcessedCount");
  const aiStatusState = document.getElementById("aiStatusState");
  const loadSamplePromptBtn = document.getElementById("loadSamplePromptBtn");
  const testPromptInput = document.getElementById("testPromptInput");
  const runTestPromptBtn = document.getElementById("runTestPromptBtn");
  const testTimerLabel = document.getElementById("testTimerLabel");
  const testOutputContainer = document.getElementById("testOutputContainer");
  const testOutputPre = document.getElementById("testOutputPre");
  const logsConsole = document.getElementById("logsConsole");
  const clearLogsBtn = document.getElementById("clearLogsBtn");

  let testStartTime = 0;
  let timerInterval = null;

  // Keep background worker alive while popup is open
  try {
    chrome.runtime.connect({ name: "deepseek_popup_keepalive" });
  } catch (e) {}

  // Initial state retrieval
  function refreshState() {
    chrome.runtime.sendMessage({ type: "GET_STATE" }, (res) => {
      if (chrome.runtime.lastError || !res) {
        updateWsStatus(false);
        return;
      }
      updateWsStatus(res.wsConnected);
      updateTabStatus(res.hasTab, res.tabId);
      updateConfigUI(res.config, res.isProcessing);
      renderLogs(res.logs);
    });
  }

  refreshState();
  const pollTimer = setInterval(refreshState, 1500);
  window.addEventListener("unload", () => clearInterval(pollTimer));

  // Focus Existing Tab or Open DeepSeek if none exists
  openDeepSeekBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "FOCUS_OR_OPEN_TAB" }, (res) => {
      if (res && res.tabId) {
        updateTabStatus(true, res.tabId);
      }
    });
  });

  // Throttle Slider
  throttleSlider.addEventListener("input", (e) => {
    const val = parseInt(e.target.value);
    throttleValue.innerText = `${val} ms`;
  });

  throttleSlider.addEventListener("change", (e) => {
    const val = parseInt(e.target.value);
    chrome.runtime.sendMessage({
      type: "SET_CONFIG",
      config: { throttleDelayMs: val }
    });
  });

  // Bypass DeepThink Toggle
  disableDeepThinkToggle.addEventListener("change", (e) => {
    chrome.runtime.sendMessage({
      type: "SET_CONFIG",
      config: { disableDeepThink: e.target.checked }
    });
  });

  // Sample Bihar Prompt
  loadSamplePromptBtn.addEventListener("click", () => {
    testPromptInput.value = `STRICT: Return ONLY JSON analyzing this Bihar grievance:
Source: Dainik Bhaskar Bihar
Headline: पटना के कंकड़बाग में 4 दिनों से जलजमाव, सीवर ओवरफ्लो
Content: पिछले 96 घंटों से गंदे पानी का जलजमाव बना हुआ है। संप हाउस की दो मोटरें जल गई हैं। डेंगू का खतरा।

Schema:
{"title":"string","actual_news":"string","is_grievance":true,"grievance_type":"Waterlogging/Drainage","urgency_level":4,"logical_flaw_rating":1,"sentiment":"Negative","district":"Patna","city_block":"Kankarbagh","locality":"Ward 44","key_demands":["Replace sump pump","Drain water"],"responsible_authority":"Patna Municipal Corporation"}`;
  });

  // Run Test Injection
  runTestPromptBtn.addEventListener("click", () => {
    const text = testPromptInput.value.trim();
    if (!text) {
      alert("Please enter or load a test prompt first.");
      return;
    }

    runTestPromptBtn.disabled = true;
    runTestPromptBtn.innerText = "Injecting...";
    testOutputContainer.classList.remove("hidden");
    testOutputPre.innerText = "Waiting for DeepSeek response from chat.deepseek.com tab...";
    testStartTime = Date.now();
    testTimerLabel.innerText = "0.0s";

    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      const elapsed = ((Date.now() - testStartTime) / 1000).toFixed(1);
      testTimerLabel.innerText = `${elapsed}s`;
    }, 100);

    chrome.runtime.sendMessage({
      type: "TEST_PROMPT_MANUAL",
      prompt: text
    }, (res) => {
      if (res && res.error) {
        clearInterval(timerInterval);
        testTimerLabel.innerText = "Error";
        testOutputPre.innerText = `Error: ${res.error}. Open chat.deepseek.com first.`;
        runTestPromptBtn.disabled = false;
        runTestPromptBtn.innerText = "Send to DeepSeek Tab";
      }
    });
  });

  // Clear Logs
  clearLogsBtn.addEventListener("click", () => {
    chrome.storage.local.set({ deepseek_logs: [] }, () => {
      logsConsole.innerHTML = '<div class="log-line info">Logs cleared.</div>';
    });
  });

  // Messages from Background
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "WS_STATUS") {
      updateWsStatus(msg.connected);
    } else if (msg.type === "TAB_STATUS") {
      updateTabStatus(msg.found, msg.tabId);
    } else if (msg.type === "LOG" && msg.log) {
      appendLog(msg.log);
    } else if (msg.type === "PROMPT_COMPLETED") {
      if (timerInterval) clearInterval(timerInterval);
      runTestPromptBtn.disabled = false;
      runTestPromptBtn.innerText = "Send to DeepSeek Tab";
      testOutputContainer.classList.remove("hidden");
      testOutputPre.innerText = msg.result_text || "No response text received.";
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

  function updateTabStatus(found, tabId) {
    if (found) {
      tabIndicator.classList.add("active");
      tabStatusLabel.innerText = `DeepSeek Active (Tab: ${tabId})`;
      openDeepSeekBtn.innerText = "Focus Tab";
    } else {
      tabIndicator.classList.remove("active");
      tabStatusLabel.innerText = "DeepSeek Tab Not Open";
      openDeepSeekBtn.innerText = "Open DeepSeek";
    }
  }

  function updateConfigUI(cfg, isProcessing) {
    if (!cfg) return;
    throttleSlider.value = cfg.throttleDelayMs || 4000;
    throttleValue.innerText = `${cfg.throttleDelayMs || 4000} ms`;
    disableDeepThinkToggle.checked = cfg.disableDeepThink !== false;
    totalProcessedCount.innerText = cfg.totalProcessedCount || 0;
    
    if (isProcessing) {
      aiStatusState.innerText = "BUSY";
      aiStatusState.style.color = "#fbbf24";
    } else {
      aiStatusState.innerText = "IDLE";
      aiStatusState.style.color = "#34d399";
    }
  }

  function renderLogs(logs) {
    logsConsole.innerHTML = "";
    if (!logs || logs.length === 0) {
      logsConsole.innerHTML = '<div class="log-line info">No events recorded.</div>';
      return;
    }
    logs.slice(-25).forEach(appendLog);
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
