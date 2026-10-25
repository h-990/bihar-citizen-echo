/**
 * Terminal Controller for Bottom Docked Console.
 * Manages live multi-stream logs, terminal resizing,
 * and the priority custom AI prompt injection feature.
 */

window.AppTerminal = (function () {
  const dockedTerminal = document.getElementById("dockedTerminal");
  const viewport = document.getElementById("terminalLogsViewport");
  const tabs = document.querySelectorAll(".term-tab");
  const toggleSizeBtn = document.getElementById("toggleTerminalSizeBtn");
  const hideTerminalBtn = document.getElementById("hideTerminalBtn");
  const showTerminalFloatingBtn = document.getElementById("showTerminalFloatingBtn");
  const clearLogsBtn = document.getElementById("clearTerminalLogsBtn");
  const copyLogsBtn = document.getElementById("copyTerminalLogsBtn");
  const customPromptInput = document.getElementById("customPromptInput");
  const sendCustomPromptBtn = document.getElementById("sendCustomPromptBtn");

  let currentStreamFilter = "ALL";
  let allLogs = [];
  let terminalState = "standard"; // "minimized", "standard", "expanded"

  function init() {
    initTabs();
    initControls();
    initResizeHandle();
    initBiharMapInteractions();
    initCustomPromptSender();
  }

  function initTabs() {
    tabs.forEach(tab => {
      tab.addEventListener("click", () => {
        tabs.forEach(t => t.classList.remove("active"));
        tab.classList.add("active");
        currentStreamFilter = tab.dataset.stream;
        renderLogs();
      });
    });
  }

  function setTerminalHeightVar(h) {
    document.documentElement.style.setProperty("--terminal-height", h);
  }

  function initControls() {
    // Toggle size: standard -> expanded -> minimized -> standard
    if (toggleSizeBtn) {
      toggleSizeBtn.addEventListener("click", () => {
        dockedTerminal.style.height = ""; // Clear inline drag height
        if (terminalState === "standard") {
          dockedTerminal.className = "docked-terminal expanded";
          terminalState = "expanded";
          toggleSizeBtn.innerText = "🔽 Standard";
          setTerminalHeightVar("450px");
        } else if (terminalState === "expanded") {
          dockedTerminal.className = "docked-terminal minimized";
          terminalState = "minimized";
          toggleSizeBtn.innerText = "🔼 Expand";
          setTerminalHeightVar("42px");
        } else {
          dockedTerminal.className = "docked-terminal";
          terminalState = "standard";
          toggleSizeBtn.innerText = "🔼 Expand";
          setTerminalHeightVar("240px");
        }
        setTimeout(syncSquareDock, 220);
      });
    }

    if (hideTerminalBtn) {
      hideTerminalBtn.addEventListener("click", () => {
        dockedTerminal.classList.add("hidden");
        setTerminalHeightVar("0px");
        if (showTerminalFloatingBtn) showTerminalFloatingBtn.style.display = "block";
      });
    }

    if (showTerminalFloatingBtn) {
      showTerminalFloatingBtn.addEventListener("click", () => {
        dockedTerminal.classList.remove("hidden");
        dockedTerminal.style.height = "";
        setTerminalHeightVar("240px");
        dockedTerminal.className = "docked-terminal";
        terminalState = "standard";
        showTerminalFloatingBtn.style.display = "none";
        setTimeout(syncSquareDock, 220);
      });
    }

    clearLogsBtn.addEventListener("click", () => {
      allLogs = [];
      viewport.innerHTML = '<div style="color: #64748b; font-size: 11px;">Terminal logs cleared.</div>';
    });

    copyLogsBtn.addEventListener("click", () => {
      const text = allLogs.map(l => `[${formatTime(l.timestamp)}] [${l.stream}] [${l.level}] ${l.message}`).join("\n");
      navigator.clipboard.writeText(text).then(() => {
        alert("Terminal logs copied to clipboard!");
      });
    });
  }

  function appendLog(log) {
    allLogs.push(log);
    if (allLogs.length > 500) allLogs.shift();

    if (currentStreamFilter === "ALL" || currentStreamFilter === log.stream) {
      const entry = createLogElement(log);
      viewport.appendChild(entry);
      viewport.scrollTop = viewport.scrollHeight;
    }
  }

  function renderLogs() {
    viewport.innerHTML = "";
    const filtered = currentStreamFilter === "ALL" 
      ? allLogs 
      : allLogs.filter(l => l.stream === currentStreamFilter);

    if (filtered.length === 0) {
      viewport.innerHTML = '<div style="color: #64748b; font-size: 11px;">No logs recorded for this stream.</div>';
      return;
    }

    filtered.forEach(log => {
      viewport.appendChild(createLogElement(log));
    });
    viewport.scrollTop = viewport.scrollHeight;
  }

  function createLogElement(log) {
    const div = document.createElement("div");
    div.className = "log-entry";

    const streamClass = (log.stream || "SYSTEM").toLowerCase();
    const lvlClass = (log.level || "INFO").toLowerCase();

    div.innerHTML = `
      <span class="log-time">[${formatTime(log.timestamp)}]</span>
      <span class="log-stream ${streamClass}">[${log.stream}]</span>
      <span class="log-lvl ${lvlClass}">[${log.level}]</span>
      <span class="log-msg">${escapeHtml(log.message)}</span>
    `;
    return div;
  }

  function formatTime(ts) {
    if (!ts) return new Date().toLocaleTimeString();
    if (ts < 10000000000) ts = ts * 1000;
    return new Date(ts).toLocaleTimeString();
  }

  function escapeHtml(text) {
    const div = document.createElement("div");
    div.innerText = text || "";
    return div.innerHTML;
  }

  // Priority Custom Send Message Feature
  function initCustomPromptSender() {
    sendCustomPromptBtn.addEventListener("click", handleCustomSend);
    customPromptInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") handleCustomSend();
    });
  }

  async function handleCustomSend() {
    const prompt = customPromptInput.value.trim();
    if (!prompt) return;

    customPromptInput.disabled = true;
    sendCustomPromptBtn.disabled = true;
    sendCustomPromptBtn.innerText = "Waiting...";

    appendLog({
      timestamp: Date.now(),
      stream: "SYSTEM",
      level: "WARN",
      message: `PRIORITY INTERCEPT: Paused queue. Injected user prompt: "${prompt}"`
    });

    try {
      const resp = await fetch("/api/ai/inject_query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: prompt })
      });
      const data = await resp.json();

      if (data.status === "success") {
        appendLog({
          timestamp: Date.now(),
          stream: "DEEPSEEK",
          level: "SUCCESS",
          message: `DEEPSEEK ANSWER: ${data.response}`
        });
        appendLog({
          timestamp: Date.now(),
          stream: "PIPELINE",
          level: "INFO",
          message: "Resumed automated queue processing."
        });
      } else {
        appendLog({
          timestamp: Date.now(),
          stream: "DEEPSEEK",
          level: "ERROR",
          message: `DeepSeek Error: ${data.message || "Failed to get response"}`
        });
      }
    } catch (e) {
      appendLog({
        timestamp: Date.now(),
        stream: "SYSTEM",
        level: "ERROR",
        message: `Custom prompt network error: ${e.message}`
      });
    } finally {
      customPromptInput.value = "";
      customPromptInput.disabled = false;
      sendCustomPromptBtn.disabled = false;
      sendCustomPromptBtn.innerText = "Send to DeepSeek";
    }
  }

  function initResizeHandle() {
    const handle = document.getElementById("terminalResizeBar");
    if (!handle || !dockedTerminal) return;

    let isDragging = false;
    let startY = 0;
    let startHeight = 0;

    handle.addEventListener("mousedown", (e) => {
      isDragging = true;
      startY = e.clientY;
      startHeight = dockedTerminal.offsetHeight;
      document.body.style.userSelect = "none";
      document.body.style.cursor = "ns-resize";
      dockedTerminal.style.transition = "none";
      e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
      if (!isDragging) return;
      const deltaY = startY - e.clientY;
      let newHeight = startHeight + deltaY;
      const maxHeight = window.innerHeight * 0.85;
      newHeight = Math.max(90, Math.min(newHeight, maxHeight));
      
      dockedTerminal.style.height = `${newHeight}px`;
      setTerminalHeightVar(`${newHeight}px`);
      syncSquareDock();
    });

    window.addEventListener("mouseup", () => {
      if (isDragging) {
        isDragging = false;
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        dockedTerminal.style.transition = "height 0.2s ease";
        syncSquareDock();
      }
    });

    window.addEventListener("resize", syncSquareDock);
    setTimeout(syncSquareDock, 100);
  }

  function syncSquareDock() {
    const dock = document.getElementById("terminalSquareDock");
    if (dock && dockedTerminal && !dockedTerminal.classList.contains("minimized") && !dockedTerminal.classList.contains("hidden")) {
      const h = dockedTerminal.offsetHeight;
      dock.style.width = `${h}px`;
      dock.style.height = `${h}px`;
    }
  }

  function initBiharMapInteractions() {
    const tooltip = document.getElementById("biharNodeTooltip");
    const nodes = document.querySelectorAll(".district-node");
    if (!tooltip || !nodes.length) return;

    // Memoize district metadata to prevent DOM layout thrashing during radar sweeps
    const nodeCache = new WeakMap();

    nodes.forEach(node => {
      const distAttr = node.getAttribute("data-dist") || node.querySelector(".node-label")?.textContent || "DISTRICT";
      const cleanDist = distAttr.split(" (")[0].trim();
      nodeCache.set(node, { distName: cleanDist, rawAttr: distAttr });

      node.style.cursor = "pointer";

      node.addEventListener("mouseenter", () => {
        const cached = nodeCache.get(node);
        tooltip.innerHTML = `<span class="tt-dist">📍 ${cached.distName}</span> <span class="tt-stat">ACTIVE // RADAR LOCK [Click for Brief]</span>`;
        tooltip.style.opacity = "1";
      });

      node.addEventListener("mouseleave", () => {
        tooltip.style.opacity = "0";
      });

      node.addEventListener("click", () => {
        const cached = nodeCache.get(node);
        if (window.ModalManager && typeof window.ModalManager.generateDistrictBrief === "function") {
          const items = window._cachedProcessedNews || [];
          window.ModalManager.generateDistrictBrief(cached.distName, items);
        }
      });
    });
  }

  return {
    init,
    appendLog,
    syncSquareDock
  };
})();
