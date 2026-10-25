/**
 * Main Application Orchestrator for Bihar Citizen Echo.
 * Connects WebSocket hub, synchronizes modular nodes, handles DB actions,
 * exports/imports, and filters.
 */

document.addEventListener("DOMContentLoaded", () => {
  // Initialize sub-controllers
  window.CanvasEngine.init();
  window.AppTerminal.init();
  window.NewsModal.init();

  // Top Nav Elements
  const valServerStatus = document.getElementById("valServerStatus");
  const badgeServer = document.getElementById("badgeServer");
  const masterPipelineToggleBtn = document.getElementById("masterPipelineToggleBtn");
  const pipelineIcon = document.getElementById("pipelineIcon");
  const pipelineText = document.getElementById("pipelineText");
  const triggerSampleFeedBtn = document.getElementById("triggerSampleFeedBtn");
  const resetDbBtn = document.getElementById("resetDbBtn");

  // Node 1: Scraper Elements
  const rawQueueCount = document.getElementById("rawQueueCount");
  const rawFeedStreamList = document.getElementById("rawFeedStreamList");
  const scraperDelaySlider = document.getElementById("scraperDelaySlider");
  const scraperDelayLabel = document.getElementById("scraperDelayLabel");
  const viewRawDbBtn = document.getElementById("viewRawDbBtn");
  const exportRawJsonBtn = document.getElementById("exportRawJsonBtn");
  const exportRawCsvBtn = document.getElementById("exportRawCsvBtn");
  const importRawDbFile = document.getElementById("importRawDbFile");

  // Node 2: DeepSeek Elements
  const processedCountPill = document.getElementById("processedCountPill");
  const processedFeedStreamList = document.getElementById("processedFeedStreamList");
  const aiDelaySlider = document.getElementById("aiDelaySlider");
  const aiDelayLabel = document.getElementById("aiDelayLabel");
  const viewProcessedDbBtn = document.getElementById("viewProcessedDbBtn");
  const exportProcJsonBtn = document.getElementById("exportProcJsonBtn");
  const exportProcCsvBtn = document.getElementById("exportProcCsvBtn");
  const importProcDbFile = document.getElementById("importProcDbFile");

  // Filter Selects
  const districtFilterSelect = document.getElementById("districtFilterSelect");
  const grievanceFilterSelect = document.getElementById("grievanceFilterSelect");

  let ws = null;
  let rawItems = [];
  let processedItems = [];
  let isPipelineActive = true;

  // 1. WebSocket Hub Connection
  function connectWebSocket() {
    const wsProto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${wsProto}//${window.location.host}/ws/hub?client_type=frontend`;

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      if (badgeServer) badgeServer.classList.add("online");
      if (valServerStatus) valServerStatus.innerText = "Online";
      window.AppTerminal.appendLog({
        timestamp: Date.now(),
        stream: "SYSTEM",
        level: "SUCCESS",
        message: "Connected to Bihar Citizen Echo WebSocket Hub."
      });
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleWsMessage(msg);
      } catch (e) {
        console.error("Malformed WebSocket message:", e);
      }
    };

    ws.onclose = () => {
      if (badgeServer) badgeServer.classList.remove("online");
      if (valServerStatus) valServerStatus.innerText = "Offline (Reconnecting)";
      setTimeout(connectWebSocket, 3000);
    };

    ws.onerror = (e) => {
      console.warn("WebSocket error:", e);
    };
  }

  function handleWsMessage(msg) {
    if (msg.type === "STATUS_UPDATE") {
      updateStatusBadges(msg);
    } else if (msg.type === "EXTENSION_CONNECTED") {
      const ext = msg.extension || {};
      if (window.CanvasEngine && window.CanvasEngine.showDiscoveryToast) {
        window.CanvasEngine.showDiscoveryToast(
          ext.name || msg.client_type || "Chrome Extension",
          ext.icon || "🔌",
          ext.node_id
        );
      }
    } else if (msg.type === "LOG_ENTRY" && msg.log) {
      window.AppTerminal.appendLog(msg.log);
    } else if (msg.type === "NEW_RAW_ITEM" && msg.item) {
      addRawItemToQueue(msg.item);
    } else if (msg.type === "NEW_PROCESSED_ITEM" && msg.item) {
      addProcessedItemToFeed(msg.item);
    } else if (msg.type === "CUSTOM_QUERY_ANSWER") {
      if (msg.error) {
        window.AppTerminal.appendLog({
          timestamp: Date.now(),
          stream: "DEEPSEEK",
          level: "ERROR",
          message: msg.error
        });
      } else {
        window.AppTerminal.appendLog({
          timestamp: Date.now(),
          stream: "DEEPSEEK",
          level: "SUCCESS",
          message: `DEEPSEEK RESPONSE: ${msg.text}`
        });
      }
    }
  }

  let lastReceivedStatus = null;

  function updateDynamicExtensionBar(connectedExts) {
    const bar = document.getElementById("dynamicExtensionBar");
    if (!bar) return;

    // Remove any previous dynamic extension badges and hint
    const toRemove = bar.querySelectorAll(".dynamic-ext-badge, #noExtHint");
    toRemove.forEach(el => el.remove());

    const allBadges = [];
    const addedNodeIds = new Set();

    // 1. Add any connected Chrome extension indicators
    (connectedExts || []).forEach(ext => {
      const nid = ext.node_id || "";
      if (nid) addedNodeIds.add(nid);
      allBadges.push({
        id: ext.client_type || nid,
        node_id: nid,
        name: ext.name || ext.client_type,
        icon: ext.icon || "🧩",
        status: ext.status || "Active",
        online: true
      });
    });

    // 2. Discover all pipeline nodes currently placed on the canvas
    const canvasNodes = document.querySelectorAll(".pipeline-node");
    canvasNodes.forEach(nodeEl => {
      const nodeId = nodeEl.dataset.node || nodeEl.id;
      if (nodeId && !addedNodeIds.has(nodeId)) {
        addedNodeIds.add(nodeId);
        const title = nodeEl.querySelector(".node-title")?.innerText || nodeId;
        const icon = nodeEl.querySelector(".node-icon")?.innerText || "⚙️";
        const statusBadge = nodeEl.querySelector(".node-status-badge");
        const statusText = statusBadge?.innerText || "Active";
        allBadges.push({
          id: nodeId,
          node_id: nodeId,
          name: title,
          icon: icon,
          status: statusText,
          online: statusText.toLowerCase().includes("active") || statusText.toLowerCase().includes("online")
        });
      }
    });

    if (allBadges.length === 0) {
      const hint = document.createElement("span");
      hint.id = "noExtHint";
      hint.style.cssText = "font-size: 11px; color: #64748b; font-family: var(--font-mono); padding: 0 4px;";
      hint.innerText = "(No nodes or extensions active)";
      bar.appendChild(hint);
      return;
    }

    allBadges.forEach(b => {
      const badge = document.createElement("div");
      badge.className = `status-badge ${b.online ? 'online' : ''} dynamic-ext-badge`;
      badge.style.cursor = "pointer";
      badge.title = `Node: ${b.node_id || b.name} (Click to center on canvas)`;
      badge.innerHTML = `
        <span class="dot"></span>
        <span>${b.icon} <strong>${escapeHtml(b.name)}</strong>: <span style="color:#38bdf8">${escapeHtml(b.status)}</span></span>
      `;
      badge.addEventListener("click", () => {
        if (b.node_id && window.CanvasEngine && window.CanvasEngine.focusNodeOnCanvas) {
          window.CanvasEngine.focusNodeOnCanvas(b.node_id);
        }
      });
      bar.appendChild(badge);
    });
  }

  // Globally accessible so canvas_nodes.js can trigger top bar refresh on node add/remove
  window.refreshTopBarNodeBadges = function () {
    if (lastReceivedStatus) {
      updateStatusBadges(lastReceivedStatus);
    } else {
      updateDynamicExtensionBar([]);
    }
  };

  function updateStatusBadges(status) {
    if (!status) return;
    lastReceivedStatus = status;

    // 1. Dynamic Top Bar Extensions & Canvas Nodes
    let exts = status.connected_extensions || [];
    if (exts.length === 0) {
      if (status.scraper && status.scraper.connected) {
        exts.push({ client_type: "scraper", name: "Bihar News Scraper", icon: "📡", status: status.scraper.status === "active" ? "Scraping" : "Idle", node_id: "nodeScraper" });
      }
      if (status.deepseek && status.deepseek.connected) {
        exts.push({ client_type: "deepseek", name: "DeepSeek Automator", icon: "🧠", status: status.deepseek.status === "busy" ? "Analyzing" : "Standby", node_id: "nodeDeepseek" });
      }
      if (status.severity && status.severity.connected) {
        exts.push({ client_type: "severity", name: "Civic Severity Scorer", icon: "⚖️", status: "Active", node_id: "nodeSeverity" });
      }
      if (status.factcheck && status.factcheck.connected) {
        exts.push({ client_type: "factcheck", name: "Regional Fact-Checker", icon: "🔎", status: "Active", node_id: "nodeFactcheck" });
      }
    }
    updateDynamicExtensionBar(exts);

    // 2. Canvas Node Status Badges (if present on canvas)
    const scraperBadge = document.getElementById("scraperNodeStatusBadge");
    if (scraperBadge) {
      const isConn = status.scraper && status.scraper.connected;
      scraperBadge.className = isConn ? "node-status-badge active" : "node-status-badge";
      scraperBadge.innerText = isConn ? (status.scraper.status === "active" ? "Scraping" : "Connected") : "Offline";
    }

    const deepseekBadge = document.getElementById("deepseekNodeStatusBadge");
    if (deepseekBadge) {
      const isConn = status.deepseek && status.deepseek.connected;
      deepseekBadge.className = isConn ? "node-status-badge active" : "node-status-badge";
      deepseekBadge.innerText = isConn ? (status.deepseek.status === "busy" ? "Analyzing" : "Standby (Idle)") : "Waiting for Tab";
    }

    const severityBadge = document.getElementById("severityNodeStatusBadge");
    if (severityBadge) {
      const isConn = status.severity && status.severity.connected;
      severityBadge.className = isConn ? "node-status-badge active" : "node-status-badge";
      severityBadge.innerText = isConn ? "Connected" : "Offline";
    }

    const factcheckBadge = document.getElementById("factcheckNodeStatusBadge");
    if (factcheckBadge) {
      const isConn = status.factcheck && status.factcheck.connected;
      factcheckBadge.className = isConn ? "node-status-badge active" : "node-status-badge";
      factcheckBadge.innerText = isConn ? "Connected" : "Offline";
    }

    // 3. Pipeline active
    if (status.pipeline) {
      isPipelineActive = status.pipeline.active;
      updatePipelineButtonUI(isPipelineActive);
    }
  }

  function updatePipelineButtonUI(active) {
    if (active) {
      pipelineIcon.innerText = "⏸";
      pipelineText.innerText = "Pause Pipeline";
      masterPipelineToggleBtn.className = "btn btn-primary";
    } else {
      pipelineIcon.innerText = "▶";
      pipelineText.innerText = "Resume Pipeline";
      masterPipelineToggleBtn.className = "btn btn-success";
    }
  }

  // 2. Initial Data Loading from Backend REST
  async function loadInitialData() {
    try {
      const [rawResp, procResp, statusResp] = await Promise.all([
        fetch("/api/raw_news?limit=30"),
        fetch("/api/processed_news?limit=30"),
        fetch("/api/status")
      ]);

      const rawData = await rawResp.json();
      const procData = await procResp.json();
      const statusData = await statusResp.json();

      rawItems = rawData.items || [];
      processedItems = procData.items || [];

      renderRawQueue();
      renderProcessedFeed();
      renderMasterOutputPanel();
      updateStatusBadges(statusData);


      // Load initial logs
      const logsResp = await fetch("/api/logs?limit=40");
      const logsData = await logsResp.json();
      if (logsData.logs) {
        logsData.logs.forEach(l => window.AppTerminal.appendLog(l));
      }
    } catch (e) {
      console.warn("Error loading initial data:", e);
    }
  }

  // 3. Raw News Queue Rendering (Node 1 - Card A)
  function addRawItemToQueue(item) {
    if (!item) return;
    const itemTitle = (item.title || "").trim().toLowerCase();
    if (!itemTitle) return;

    // Strict deduplication by ID or normalized title
    const exists = rawItems.some(i => 
      (i.id && item.id && i.id === item.id) || 
      (i.title && (i.title || "").trim().toLowerCase() === itemTitle)
    );

    if (!exists) {
      rawItems.unshift(item);
      renderRawQueue();
    }
  }

  function renderRawQueue() {
    if (!rawFeedStreamList) return;
    if (rawQueueCount) rawQueueCount.innerText = `${rawItems.length} items`;
    rawFeedStreamList.innerHTML = "";

    if (rawItems.length === 0) {
      rawFeedStreamList.innerHTML = `
        <div class="stream-card empty-state">
          <p style="color: #64748b; font-size: 11px; text-align: center; padding: 20px;">
            Queue empty. Click "Ingest Bihar Feed" or launch the Bihar Scraper Chrome extension.
          </p>
        </div>
      `;
      return;
    }

    // Apply District Filter if needed
    const filterDistrict = districtFilterSelect.value;
    const filtered = filterDistrict === "ALL" 
      ? rawItems 
      : rawItems.filter(i => (i.district_hint || "").toLowerCase().includes(filterDistrict.toLowerCase()) || (i.title || "").includes(filterDistrict));

    filtered.forEach(item => {
      const card = createRawCard(item);
      rawFeedStreamList.appendChild(card);
    });
  }

  function createRawCard(item) {
    const div = document.createElement("div");
    const isGrievance = Boolean(item.is_grievance || item.grievance_category);
    div.className = "stream-card" + (isGrievance ? " grievance-card" : "");

    const mediaUrl = (item.media_urls && item.media_urls.length > 0) 
      ? item.media_urls[0] 
      : "https://images.unsplash.com/photo-1547683905-f686c993aae5?auto=format&fit=crop&w=600&q=80";

    const idSuffix = (item.id || "").slice(-8);
    const grievanceBadge = isGrievance ? `
      <span style="background: rgba(239, 68, 68, 0.2); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.4); padding: 1px 5px; border-radius: 4px; font-weight: 600; font-size: 10px;">
        🚨 ${escapeHtml(item.grievance_category || 'Grievance')}
      </span>
    ` : "";

    div.innerHTML = `
      <div class="stream-media-preview">
        <img src="${mediaUrl}" alt="Media" loading="lazy">
        <span class="id-tag">ID: ${idSuffix}</span>
      </div>
      <div class="stream-card-title">${escapeHtml(item.title)}</div>
      <div class="stream-card-meta" style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
        <span class="badge-location">📍 ${item.district_hint || 'Bihar'}</span>
        ${grievanceBadge}
        <span style="color: #94a3b8; font-size: 10px;">${item.source_name || 'Web Feed'}</span>
      </div>
    `;

    div.style.cursor = "pointer";
    div.addEventListener("click", (e) => {
      e.stopPropagation();
      window.NewsModal.openModalWithItem(item);
    });
    return div;
  }

  // 4. Processed Intelligence Feed Rendering (Node 2 - Card B)
  function addProcessedItemToFeed(item) {
    if (!item) return;
    const itemId = item.id || item.raw_id;
    const existingIndex = processedItems.findIndex(i => 
      (i.id && itemId && i.id === itemId) || 
      (i.raw_id && itemId && i.raw_id === itemId)
    );
    if (existingIndex >= 0) {
      processedItems[existingIndex] = Object.assign({}, processedItems[existingIndex], item);
    } else {
      processedItems.unshift(item);
    }
    renderProcessedFeed();
    renderMasterOutputPanel();
  }

  function renderProcessedFeed() {
    if (!processedFeedStreamList) return;
    if (processedCountPill) processedCountPill.innerText = `${processedItems.length} analyzed`;
    processedFeedStreamList.innerHTML = "";

    if (processedItems.length === 0) {
      processedFeedStreamList.innerHTML = `
        <div class="stream-card empty-state">
          <p style="color: #64748b; font-size: 11px; text-align: center; padding: 20px;">
            No processed records yet. Items will stream live here as DeepSeek analyzes incoming news!
          </p>
        </div>
      `;
      return;
    }

    const filterDistrict = districtFilterSelect.value;
    const filterGrievance = grievanceFilterSelect.value;

    const filtered = processedItems.filter(item => {
      const itemDistrict = (item.district || item.district_hint || "").toLowerCase();
      if (filterDistrict !== "ALL" && !itemDistrict.includes(filterDistrict.toLowerCase())) {
        return false;
      }
      if (filterGrievance === "GRIEVANCE_ONLY" && !item.is_grievance) {
        return false;
      }
      if (filterGrievance === "NON_POLITICAL" && item.is_political) {
        return false;
      }
      return true;
    });

    filtered.forEach(item => {
      const card = createProcessedCard(item);
      processedFeedStreamList.appendChild(card);
    });
  }

  function createProcessedCard(item) {
    const div = document.createElement("div");
    div.className = "stream-card";

    const mediaUrl = (item.media_urls && item.media_urls.length > 0)
      ? item.media_urls[0]
      : "https://images.unsplash.com/photo-1547683905-f686c993aae5?auto=format&fit=crop&w=600&q=80";

    const idSuffix = (item.id || item.raw_id || "").slice(-8);
    const urgency = item.urgency_level || 1;

    // Deep locality & rural area outside registered city
    const loc = (item.locality || "").trim();
    const blk = (item.city_block || "").trim();
    const dst = (item.district || "Bihar").trim();
    let locationStr = dst;
    if (loc && blk) {
      locationStr = `${loc}, ${blk} (${dst})`;
    } else if (loc) {
      locationStr = `${loc} (${dst})`;
    } else if (blk) {
      locationStr = `${blk} (${dst})`;
    }

    const truthScore = item.truthfulness_score || (item.attributes ? item.attributes.truthfulness_score : null);
    const truthVerdict = item.truth_verdict || (item.attributes ? item.attributes.truth_verdict : null);

    div.innerHTML = `
      <div class="stream-media-preview">
        <img src="${mediaUrl}" alt="Media" loading="lazy">
        <span class="id-tag">ID: ${idSuffix}</span>
      </div>
      <div class="stream-card-title">${escapeHtml(item.title)}</div>
      <div class="badge-row">
        ${item.is_grievance ? `<span class="badge-grievance">🚨 ${escapeHtml(item.grievance_type || 'Grievance')}</span>` : '<span class="badge-civic-type">News</span>'}
        <span class="badge-urgency urgency-${urgency}">Urgency: ${urgency}/5</span>
        <span class="badge-location" title="Locality / Area outside City">📍 ${escapeHtml(locationStr)}</span>
        ${truthScore ? `<span class="badge-truth ${truthScore < 3 ? 'unverified' : ''}">🛡️ Truth: ${truthScore}/5 ${truthVerdict ? '(' + escapeHtml(truthVerdict) + ')' : ''}</span>` : ''}
        ${item.is_political ? '<span class="badge-political">Political</span>' : ''}
      </div>
      <div class="stream-card-meta" style="margin-top: 4px;">
        <span style="color: #64748b;">Flaw Score: ${item.logical_flaw_rating || 1}/5</span>
        <span style="color: #38bdf8;">${escapeHtml(item.responsible_authority || 'Admin')}</span>
      </div>
    `;

    div.style.cursor = "pointer";
    div.addEventListener("click", (e) => {
      e.stopPropagation();
      window.NewsModal.openModalWithItem(item);
    });
    return div;
  }


  // 5. Actions & Buttons
  masterPipelineToggleBtn.addEventListener("click", async () => {
    try {
      const resp = await fetch("/api/pipeline/toggle", { method: "POST" });
      const data = await resp.json();
      isPipelineActive = data.active;
      updatePipelineButtonUI(isPipelineActive);
    } catch (e) {
      alert("Error toggling pipeline: " + e.message);
    }
  });

  triggerSampleFeedBtn.addEventListener("click", async () => {
    triggerSampleFeedBtn.disabled = true;
    triggerSampleFeedBtn.innerText = "Injecting...";
    try {
      const resp = await fetch("/api/pipeline/trigger_sample", { method: "POST" });
      const data = await resp.json();
      window.AppTerminal.appendLog({
        timestamp: Date.now(),
        stream: "PIPELINE",
        level: "SUCCESS",
        message: "Triggered Bihar news sample feed ingestion."
      });
    } catch (e) {
      alert("Error triggering feed: " + e.message);
    } finally {
      setTimeout(() => {
        triggerSampleFeedBtn.disabled = false;
        triggerSampleFeedBtn.innerHTML = "<span>⚡ Ingest Bihar Feed</span>";
      }, 1000);
    }
  });

  resetDbBtn.addEventListener("click", async () => {
    if (confirm("Reset all SQLite databases, logs, and in-memory queues?")) {
      await fetch("/api/db/reset", { method: "POST" });
      rawItems = [];
      processedItems = [];
      renderRawQueue();
      renderProcessedFeed();
    }
  });

  // Sliders
  if (scraperDelaySlider) {
    scraperDelaySlider.addEventListener("input", (e) => {
      const val = parseInt(e.target.value);
      if (scraperDelayLabel) scraperDelayLabel.innerText = `${val} ms`;
    });

    scraperDelaySlider.addEventListener("change", (e) => {
      const val = parseInt(e.target.value);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "SET_SCRAPE_SPEED", speed_ms: val }));
      }
    });
  }

  if (aiDelaySlider) {
    aiDelaySlider.addEventListener("input", (e) => {
      const val = parseInt(e.target.value);
      if (aiDelayLabel) aiDelayLabel.innerText = `${val} ms`;
    });

    aiDelaySlider.addEventListener("change", (e) => {
      const val = parseInt(e.target.value);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "SET_DEEPSEEK_SPEED", speed_ms: val }));
      }
    });
  }

  // DB Viewers
  if (viewRawDbBtn) {
    viewRawDbBtn.addEventListener("click", () => {
      window.NewsModal.openDrawer();
      const tab = document.getElementById("drawerTabRaw");
      if (tab) tab.click();
    });
  }

  if (viewProcessedDbBtn) {
    viewProcessedDbBtn.addEventListener("click", () => {
      window.NewsModal.openDrawer();
      const tab = document.getElementById("drawerTabProc");
      if (tab) tab.click();
    });
  }

  // Exports
  if (exportRawJsonBtn) exportRawJsonBtn.addEventListener("click", () => window.open("/api/db/export?target=raw&format=json"));
  if (exportRawCsvBtn) exportRawCsvBtn.addEventListener("click", () => window.open("/api/db/export?target=raw&format=csv"));
  if (exportProcJsonBtn) exportProcJsonBtn.addEventListener("click", () => window.open("/api/db/export?target=processed&format=json"));
  if (exportProcCsvBtn) exportProcCsvBtn.addEventListener("click", () => window.open("/api/db/export?target=processed&format=csv"));

  // Imports
  if (importRawDbFile) importRawDbFile.addEventListener("change", (e) => handleFileImport(e, "raw"));
  if (importProcDbFile) importProcDbFile.addEventListener("change", (e) => handleFileImport(e, "processed"));

  async function handleFileImport(event, target) {
    const file = event.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append("file", file);

    try {
      const resp = await fetch("/api/db/import", {
        method: "POST",
        body: formData
      });
      const res = await resp.json();
      if (res.status === "success") {
        alert(`Successfully imported ${res.imported} records into ${target} DB.`);
        loadInitialData();
      } else {
        alert("Import failed: " + (res.detail || "Unknown error"));
      }
    } catch (e) {
      alert("Import error: " + e.message);
    }
  }

  // Filters
  districtFilterSelect.addEventListener("change", () => {
    renderRawQueue();
    renderProcessedFeed();
  });

  grievanceFilterSelect.addEventListener("change", () => {
    renderProcessedFeed();
  });

  // ================= 6. FIXED COLLAPSIBLE RIGHT PANEL: MASTER PROCESSED OUTPUT =================
  const masterOutputPanel = document.getElementById("masterOutputPanel");
  const masterPanelToggleBtn = document.getElementById("masterPanelToggleBtn");
  const closePanelBtn = document.getElementById("closePanelBtn");
  const refreshPanelBtn = document.getElementById("refreshPanelBtn");
  const panelSearchInput = document.getElementById("panelSearchInput");
  const panelStreamList = document.getElementById("panelStreamList");
  const panelOutputCount = document.getElementById("panelOutputCount");
  const chipAllCount = document.getElementById("chipAllCount");
  const chipGrievanceCount = document.getElementById("chipGrievanceCount");
  const chipCriticalCount = document.getElementById("chipCriticalCount");
  const panelExportJsonBtn = document.getElementById("panelExportJsonBtn");
  const panelExportCsvBtn = document.getElementById("panelExportCsvBtn");
  const panelOpenModalDbBtn = document.getElementById("panelOpenModalDbBtn");
  const openDbDrawerBtn = document.getElementById("openDbDrawerBtn");

  let masterPanelFilter = "ALL";
  let masterPanelSearchQuery = "";

  if (masterPanelToggleBtn && masterOutputPanel) {
    masterPanelToggleBtn.addEventListener("click", () => {
      masterOutputPanel.classList.toggle("collapsed");
      const isCollapsed = masterOutputPanel.classList.contains("collapsed");
      const icon = masterPanelToggleBtn.querySelector(".toggle-icon");
      if (icon) icon.innerText = isCollapsed ? "❮" : "❯";
    });
  }

  if (closePanelBtn && masterOutputPanel) {
    closePanelBtn.addEventListener("click", () => {
      masterOutputPanel.classList.add("collapsed");
      const icon = masterPanelToggleBtn?.querySelector(".toggle-icon");
      if (icon) icon.innerText = "❮";
    });
  }

  if (refreshPanelBtn) {
    refreshPanelBtn.addEventListener("click", async () => {
      refreshPanelBtn.style.transform = "rotate(180deg)";
      await loadInitialData();
      setTimeout(() => { refreshPanelBtn.style.transform = "none"; }, 400);
    });
  }

  // Top Nav Master DB button: Toggles Master Processed Output panel smoothly
  if (openDbDrawerBtn) {
    openDbDrawerBtn.addEventListener("click", () => {
      if (masterOutputPanel) {
        masterOutputPanel.classList.toggle("collapsed");
        const isCollapsed = masterOutputPanel.classList.contains("collapsed");
        const icon = masterPanelToggleBtn?.querySelector(".toggle-icon");
        if (icon) icon.innerText = isCollapsed ? "❮" : "❯";
        renderMasterOutputPanel();
      } else if (window.NewsModal && window.NewsModal.openDrawer) {
        window.NewsModal.openDrawer();
      }
    });
  }

  // Filter chips in right panel
  document.querySelectorAll(".panel-filter-chips .chip").forEach(chip => {
    chip.addEventListener("click", () => {
      document.querySelectorAll(".panel-filter-chips .chip").forEach(c => c.classList.remove("active"));
      chip.classList.add("active");
      masterPanelFilter = chip.dataset.filter || "ALL";
      renderMasterOutputPanel();
    });
  });

  if (panelSearchInput) {
    panelSearchInput.addEventListener("input", (e) => {
      masterPanelSearchQuery = e.target.value.toLowerCase().trim();
      renderMasterOutputPanel();
    });
  }

  if (panelExportJsonBtn) {
    panelExportJsonBtn.addEventListener("click", () => window.open("/api/db/export?target=processed&format=json"));
  }
  if (panelExportCsvBtn) {
    panelExportCsvBtn.addEventListener("click", () => window.open("/api/db/export?target=processed&format=csv"));
  }
  if (panelOpenModalDbBtn) {
    panelOpenModalDbBtn.addEventListener("click", () => {
      if (window.NewsModal && window.NewsModal.openDrawer) {
        window.NewsModal.openDrawer();
      }
    });
  }

  function renderMasterOutputPanel() {
    if (!panelStreamList) return;

    // Update Counter Chips
    const totalCount = processedItems.length;
    const grievanceCount = processedItems.filter(i => i.is_grievance).length;
    const criticalCount = processedItems.filter(i => (i.urgency_level || 1) >= 4).length;

    if (panelOutputCount) panelOutputCount.innerText = totalCount;
    if (chipAllCount) chipAllCount.innerText = totalCount;
    if (chipGrievanceCount) chipGrievanceCount.innerText = grievanceCount;
    if (chipCriticalCount) chipCriticalCount.innerText = criticalCount;

    panelStreamList.innerHTML = "";

    if (totalCount === 0) {
      panelStreamList.innerHTML = `
        <div style="text-align: center; color: #64748b; font-size: 11px; padding: 40px 16px;">
          <p>No final processed records in database yet.</p>
          <p style="margin-top: 6px;">Click "⚡ Ingest Bihar Feed" or scrape a tab to stream live intelligence.</p>
        </div>
      `;
      return;
    }

    const filtered = processedItems.filter(item => {
      // 1. Filter Chip
      if (masterPanelFilter === "GRIEVANCE" && !item.is_grievance) return false;
      if (masterPanelFilter === "CRITICAL" && (item.urgency_level || 1) < 4) return false;

      // 2. Search query
      if (masterPanelSearchQuery) {
        const title = (item.title || "").toLowerCase();
        const loc = (item.locality || "").toLowerCase();
        const blk = (item.city_block || "").toLowerCase();
        const dst = (item.district || "").toLowerCase();
        const auth = (item.responsible_authority || "").toLowerCase();
        const type = (item.grievance_type || "").toLowerCase();
        const match = title.includes(masterPanelSearchQuery) ||
                      loc.includes(masterPanelSearchQuery) ||
                      blk.includes(masterPanelSearchQuery) ||
                      dst.includes(masterPanelSearchQuery) ||
                      auth.includes(masterPanelSearchQuery) ||
                      type.includes(masterPanelSearchQuery);
        if (!match) return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      panelStreamList.innerHTML = `
        <div style="text-align: center; color: #64748b; font-size: 11px; padding: 30px;">
          No matching processed items found for this filter/search.
        </div>
      `;
      return;
    }

    filtered.forEach(item => {
      const card = createMasterPanelCard(item);
      panelStreamList.appendChild(card);
    });
  }

  function createMasterPanelCard(item) {
    const div = document.createElement("div");
    div.className = "panel-card";

    const mediaUrl = (item.media_urls && item.media_urls.length > 0)
      ? item.media_urls[0]
      : "https://images.unsplash.com/photo-1547683905-f686c993aae5?auto=format&fit=crop&w=600&q=80";

    const urgency = item.urgency_level || 1;
    const loc = (item.locality || "").trim();
    const blk = (item.city_block || "").trim();
    const dst = (item.district || "Bihar").trim();

    let deepLocation = dst;
    if (loc && blk) deepLocation = `${loc}, ${blk} (${dst})`;
    else if (loc) deepLocation = `${loc} (${dst})`;
    else if (blk) deepLocation = `${blk} (${dst})`;

    const truthScore = item.truthfulness_score || (item.attributes ? item.attributes.truthfulness_score : null);
    const truthVerdict = item.truth_verdict || (item.attributes ? item.attributes.truth_verdict : null);

    div.innerHTML = `
      <div class="panel-card-media">
        <img src="${mediaUrl}" alt="Media" loading="lazy">
        <span class="panel-id-pill">ID: ${(item.id || item.raw_id || '').slice(-8)}</span>
      </div>
      <div class="panel-card-title">${escapeHtml(item.title)}</div>
      <div class="panel-badges">
        <span class="panel-locality-tag" title="Deep Locality / Ward / Village">📍 ${escapeHtml(deepLocation)}</span>
        <span class="badge-urgency urgency-${urgency}">Urgency: ${urgency}/5</span>
        ${item.is_grievance ? `<span class="badge-grievance">🚨 ${escapeHtml(item.grievance_type || 'Civic')}</span>` : '<span class="badge-civic-type">News</span>'}
        ${truthScore ? `<span class="panel-truth-tag">🛡️ Truth: ${truthScore}/5 (${escapeHtml(truthVerdict || 'Verified')})</span>` : ''}
      </div>
      <div class="panel-card-meta">
        <span>Flaw Score: ${item.logical_flaw_rating || 1}/5</span>
        <span style="color: #38bdf8;">${escapeHtml(item.responsible_authority || 'Admin')}</span>
      </div>
    `;

    div.style.cursor = "pointer";
    div.addEventListener("click", (e) => {
      e.stopPropagation();
      window.NewsModal.openModalWithItem(item);
    });
    return div;
  }

  // ================= 7. ACTIVE CHECKBOXES & TAB SCRAPER CONTROLS =================
  // Fast Mode (Bypass DeepThink)
  const bypassDeepThinkCheckbox = document.getElementById("bypassDeepThinkCheckbox");
  if (bypassDeepThinkCheckbox) {
    bypassDeepThinkCheckbox.addEventListener("change", (e) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "SET_BYPASS_DEEPTHINK", enabled: e.target.checked }));
      }
    });
  }

  // DeepSeek WebSearch (Fact & Truth Verification)
  const deepseekWebSearchCheckbox = document.getElementById("deepseekWebSearchCheckbox");
  if (deepseekWebSearchCheckbox) {
    deepseekWebSearchCheckbox.addEventListener("change", (e) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "SET_WEBSEARCH_FACTCHECK", enabled: e.target.checked }));
      }
    });
  }

  // Active Regional Feeds Checkboxes
  const feedBhaskar = document.getElementById("feedBhaskar");
  const feedPrabhat = document.getElementById("feedPrabhat");
  const feedHindustan = document.getElementById("feedHindustan");
  const feedJagran = document.getElementById("feedJagran");

  function syncActiveFeeds() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "SET_ACTIVE_FEEDS",
        sources: {
          bhaskar: feedBhaskar ? feedBhaskar.checked : true,
          prabhat: feedPrabhat ? feedPrabhat.checked : true,
          hindustan: feedHindustan ? feedHindustan.checked : true,
          jagran: feedJagran ? feedJagran.checked : true
        }
      }));
    }
  }

  [feedBhaskar, feedPrabhat, feedHindustan, feedJagran].forEach(cb => {
    if (cb) cb.addEventListener("change", syncActiveFeeds);
  });

  // Launch Live Bihar Crawler Button
  const scrapeActiveTabBtn = document.getElementById("scrapeActiveTabBtn");
  if (scrapeActiveTabBtn) {
    scrapeActiveTabBtn.addEventListener("click", async () => {
      scrapeActiveTabBtn.disabled = true;
      scrapeActiveTabBtn.innerHTML = `<span>🚀 Launching Crawler...</span>`;
      try {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "START_CRAWLER" }));
        }

        // Call backend to trigger extension crawler
        const resp = await fetch("/api/scraper/start_crawler", { method: "POST" });
        const data = await resp.json();

        // If extension is in standby, fallback to opening news portal directly
        if (!data.extension_connected) {
          window.open("https://www.bhaskar.com/local/bihar/", "_blank");
        }

        const tabResp = await fetch("/api/scraper/scrape_tab", { method: "POST" });
        if (tabResp.ok) {
          const tabData = await tabResp.json();
          if (tabData.items && tabData.items.length > 0) {
            tabData.items.forEach(it => addRawItemToQueue(it));
            renderRawQueue();
          }
        }

        scrapeActiveTabBtn.innerHTML = `<span>✓ Crawler Running</span>`;
        window.AppTerminal.appendLog({
          timestamp: Date.now(),
          stream: "SCRAPER",
          level: "SUCCESS",
          message: "Launched autonomous Bihar news crawler. Watch Chrome tab continuously visit articles."
        });
      } catch (e) {
        alert("Crawler notice: " + e.message);
      } finally {
        setTimeout(() => {
          scrapeActiveTabBtn.disabled = false;
          scrapeActiveTabBtn.innerHTML = `<span>🚀 Launch Live Bihar Crawler</span>`;
        }, 3000);
      }
    });
  }

  function escapeHtml(text) {

    const div = document.createElement("div");
    div.innerText = text || "";
    return div.innerHTML;
  }

  // Start
  connectWebSocket();
  loadInitialData();
});
