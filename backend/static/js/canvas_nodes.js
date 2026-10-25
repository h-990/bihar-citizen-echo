/**
 * Interactive Graph Canvas Engine.
 * Provides:
 * 1. Full Canvas Navigation: Panning (drag background), Scrolling (wheel), and Zooming (pinch/ctrl-wheel/buttons).
 * 2. Arbitrary Node Graph Connections: Click/drag from ANY output port to connect to ANY input port.
 * 3. Dynamic Curved SVG Arrows: Real-time cubic Bezier curves with animated pulse dots for all connections.
 * 4. Interactive Edge Deletion: Click on any wire to disconnect/delete it.
 * 5. Node Persistence: Saves node coordinates and edge topology to backend SQLite.
 * 6. Swappable Node Palette: Add Rule-based filters, Web AI automators, API routers, and Exotic classifiers.
 */

window.CanvasEngine = (function () {
  const canvasWrapper = document.getElementById("canvasWrapper");
  const canvasContent = document.getElementById("canvasContent");
  const flowSvgLayer = document.getElementById("flowSvgLayer");
  const svgEdgesGroup = document.getElementById("svgEdgesGroup");
  const tempWirePath = document.getElementById("tempWirePath");

  // Zoom controls
  const zoomInBtn = document.getElementById("zoomInBtn");
  const zoomOutBtn = document.getElementById("zoomOutBtn");
  const resetZoomBtn = document.getElementById("resetZoomBtn");
  const zoomPercent = document.getElementById("zoomPercent");
  const resetCanvasViewBtn = document.getElementById("resetCanvasViewBtn");
  const addNodeBtn = document.getElementById("addNodeBtn");

  // Canvas Transform State
  let panX = 0;
  let panY = 0;
  let zoomLevel = 1.0;
  const MIN_ZOOM = 0.35;
  const MAX_ZOOM = 2.4;

  // Panning interaction state
  let isPanning = false;
  let panStartX = 0, panStartY = 0;

  // Node dragging interaction state
  let activeDraggingNode = null;
  let dragOffsetX = 0, dragOffsetY = 0;

  // Wire Connection state
  let isConnecting = false;
  let connectingSourceNode = null;
  let connectingSourcePort = null;
  let connectingStartCoord = { x: 0, y: 0 };

  // Graph state: edges array
  let edges = [
    {
      edge_id: "edge_scraper_to_deepseek",
      source_node: "nodeScraper",
      source_port: "out",
      target_node: "nodeDeepseek",
      target_port: "in"
    }
  ];

  function init() {
    initCanvasNavigation();
    initZoomControls();
    initDraggableNodes();
    initPortWiringEvents();
    initAddNodePalette();
    loadSavedGraph();
    renderAllEdges();
    startFlowPulseAnimation();
  }

  // ================= 1. CANVAS NAVIGATION & ZOOM =================
  function initCanvasNavigation() {
    // Mouse Pan
    canvasWrapper.addEventListener("mousedown", (e) => {
      // Ignore clicks on nodes, buttons, or controls
      if (e.target.closest(".pipeline-node") || e.target.closest(".canvas-floating-controls") || e.target.closest(".node-port")) {
        return;
      }
      isPanning = true;
      panStartX = e.clientX - panX;
      panStartY = e.clientY - panY;
      canvasWrapper.style.cursor = "grabbing";
    });

    window.addEventListener("mousemove", (e) => {
      if (isPanning) {
        panX = e.clientX - panStartX;
        panY = e.clientY - panStartY;
        applyTransform();
      } else if (activeDraggingNode) {
        // Node dragging
        const newLeft = (e.clientX - panX) / zoomLevel - dragOffsetX;
        const newTop = (e.clientY - panY) / zoomLevel - dragOffsetY;
        activeDraggingNode.style.left = `${Math.max(10, newLeft)}px`;
        activeDraggingNode.style.top = `${Math.max(10, newTop)}px`;
        renderAllEdges();
      } else if (isConnecting) {
        // Dynamic live wire drawing to cursor
        updateTempWire(e.clientX, e.clientY);
      }
    });

    window.addEventListener("mouseup", (e) => {
      if (isPanning) {
        isPanning = false;
        canvasWrapper.style.cursor = "grab";
      }

      if (activeDraggingNode) {
        // Persist node position
        const nodeId = activeDraggingNode.dataset.node || activeDraggingNode.id;
        const x = parseFloat(activeDraggingNode.style.left) || 60;
        const y = parseFloat(activeDraggingNode.style.top) || 40;
        persistNodePosition(nodeId, x, y);
        activeDraggingNode = null;
      }

      if (isConnecting) {
        // Check if dropped on a valid input port
        const targetPortEl = document.elementFromPoint(e.clientX, e.clientY)?.closest(".port-input");
        if (targetPortEl) {
          const targetNode = targetPortEl.dataset.node;
          completeConnection(connectingSourceNode, connectingSourcePort, targetNode, "in");
        }
        cancelConnectingWire();
      }
    });

    // Wheel Scroll & Zoom
    canvasWrapper.addEventListener("wheel", (e) => {
      e.preventDefault();

      if (e.ctrlKey || e.metaKey) {
        // Pinch / Ctrl + Wheel Zoom centered at mouse pointer
        const zoomFactor = e.deltaY < 0 ? 1.08 : 0.92;
        zoomAtPoint(e.clientX, e.clientY, zoomFactor);
      } else {
        // Two-finger scroll / mouse wheel pan
        panX -= e.deltaX * 0.9;
        panY -= e.deltaY * 0.9;
        applyTransform();
      }
    }, { passive: false });
  }

  function zoomAtPoint(clientX, clientY, factor) {
    const rect = canvasWrapper.getBoundingClientRect();
    const mouseX = clientX - rect.left;
    const mouseY = clientY - rect.top;

    const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoomLevel * factor));
    if (newZoom === zoomLevel) return;

    // Adjust pan so that point under cursor remains invariant
    panX = mouseX - (mouseX - panX) * (newZoom / zoomLevel);
    panY = mouseY - (mouseY - panY) * (newZoom / zoomLevel);
    zoomLevel = newZoom;

    applyTransform();
    updateZoomDisplay();
    renderAllEdges();
  }

  function initZoomControls() {
    zoomInBtn.addEventListener("click", () => {
      const rect = canvasWrapper.getBoundingClientRect();
      zoomAtPoint(rect.width / 2, rect.height / 2, 1.2);
    });

    zoomOutBtn.addEventListener("click", () => {
      const rect = canvasWrapper.getBoundingClientRect();
      zoomAtPoint(rect.width / 2, rect.height / 2, 0.83);
    });

    resetZoomBtn.addEventListener("click", () => {
      zoomLevel = 1.0;
      applyTransform();
      updateZoomDisplay();
      renderAllEdges();
    });

    resetCanvasViewBtn.addEventListener("click", () => {
      panX = 0;
      panY = 0;
      zoomLevel = 1.0;
      applyTransform();
      updateZoomDisplay();
      renderAllEdges();
    });
  }

  function applyTransform() {
    canvasContent.style.transform = `translate(${panX}px, ${panY}px) scale(${zoomLevel})`;
    if (canvasWrapper && (canvasWrapper.scrollLeft !== 0 || canvasWrapper.scrollTop !== 0)) {
      canvasWrapper.scrollLeft = 0;
      canvasWrapper.scrollTop = 0;
    }
    if (window.scrollX !== 0 || window.scrollY !== 0) {
      window.scrollTo(0, 0);
    }
  }

  function updateZoomDisplay() {
    zoomPercent.innerText = `${Math.round(zoomLevel * 100)}%`;
  }

  // ================= 2. ARBITRARY NODE GRAPH CONNECTIONS =================
  function initPortWiringEvents() {
    canvasContent.addEventListener("mousedown", (e) => {
      const outPort = e.target.closest(".port-output");
      if (outPort) {
        e.stopPropagation();
        const sourceNode = outPort.dataset.node;
        const sourcePort = outPort.dataset.port || "out";
        startConnectingWire(outPort, sourceNode, sourcePort);
      }
    });

    canvasContent.addEventListener("mouseup", (e) => {
      if (isConnecting) {
        const inPort = e.target.closest(".port-input");
        if (inPort) {
          e.stopPropagation();
          const targetNode = inPort.dataset.node;
          completeConnection(connectingSourceNode, connectingSourcePort, targetNode, "in");
          cancelConnectingWire();
        }
      }
    });
  }

  function startConnectingWire(portEl, sourceNode, sourcePort) {
    isConnecting = true;
    connectingSourceNode = sourceNode;
    connectingSourcePort = sourcePort;

    portEl.classList.add("connecting-source");
    const portCoord = getPortCenterCoordinate(portEl);
    connectingStartCoord = portCoord;

    tempWirePath.style.display = "block";
    tempWirePath.setAttribute("d", `M ${portCoord.x} ${portCoord.y} L ${portCoord.x} ${portCoord.y}`);
  }

  function updateTempWire(clientX, clientY) {
    const contentRect = canvasContent.getBoundingClientRect();
    const curX = (clientX - contentRect.left) / zoomLevel;
    const curY = (clientY - contentRect.top) / zoomLevel;

    const startX = connectingStartCoord.x;
    const startY = connectingStartCoord.y;
    const dx = Math.max(60, Math.abs(curX - startX) * 0.5);

    const d = `M ${startX} ${startY} C ${startX + dx} ${startY}, ${curX - dx} ${curY}, ${curX} ${curY}`;
    tempWirePath.setAttribute("d", d);
  }

  function cancelConnectingWire() {
    isConnecting = false;
    connectingSourceNode = null;
    connectingSourcePort = null;
    tempWirePath.style.display = "none";
    document.querySelectorAll(".node-port").forEach(p => p.classList.remove("connecting-source"));
  }

  function completeConnection(srcNode, srcPort, tgtNode, tgtPort) {
    if (!srcNode || !tgtNode) return;
    if (srcNode === tgtNode) {
      alert("Cannot connect a node to itself.");
      return;
    }

    // Check if edge already exists
    const exists = edges.some(e => e.source_node === srcNode && e.target_node === tgtNode);
    if (exists) {
      alert("A connection between these two nodes already exists.");
      return;
    }

    const edgeId = `edge_${srcNode}_${tgtNode}_${Date.now()}`;
    const newEdge = {
      edge_id: edgeId,
      source_node: srcNode,
      source_port: srcPort,
      target_node: tgtNode,
      target_port: tgtPort
    };

    edges.push(newEdge);
    renderAllEdges();

    // Persist to backend
    fetch("/api/edges", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newEdge)
    }).catch(e => console.warn("Failed to persist edge:", e));

    if (window.AppTerminal) {
      window.AppTerminal.appendLog({
        timestamp: Date.now(),
        stream: "PIPELINE",
        level: "SUCCESS",
        message: `Connected pipeline data flow: [${srcNode}] ➔ [${tgtNode}]`
      });
    }
  }

  // ================= 3. DYNAMIC CURVED SVG ARROWS & FLOW PULSE =================
  function renderAllEdges() {
    svgEdgesGroup.innerHTML = "";

    edges.forEach((edge, index) => {
      const srcNodeEl = document.querySelector(`.pipeline-node[data-node="${edge.source_node}"], #${edge.source_node}`);
      const tgtNodeEl = document.querySelector(`.pipeline-node[data-node="${edge.target_node}"], #${edge.target_node}`);

      if (!srcNodeEl || !tgtNodeEl) return;

      const srcPort = srcNodeEl.querySelector(`.port-output[data-port="${edge.source_port}"], .port-output`);
      const tgtPort = tgtNodeEl.querySelector(`.port-input[data-port="${edge.target_port}"], .port-input`);

      if (!srcPort || !tgtPort) return;

      const p1 = getPortCenterCoordinate(srcPort);
      const p2 = getPortCenterCoordinate(tgtPort);

      const dx = Math.max(70, Math.abs(p2.x - p1.x) * 0.5);
      const pathD = `M ${p1.x} ${p1.y} C ${p1.x + dx} ${p1.y}, ${p2.x - dx} ${p2.y}, ${p2.x} ${p2.y}`;

      const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      g.className = "edge-wrapper";

      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("id", edge.edge_id);
      path.setAttribute("class", "flow-path");
      path.setAttribute("d", pathD);
      path.setAttribute("title", `Click to delete connection: ${edge.source_node} -> ${edge.target_node}`);

      // Delete connection on click
      path.addEventListener("click", () => {
        if (confirm(`Disconnect pipeline edge between ${edge.source_node} and ${edge.target_node}?`)) {
          deleteEdge(edge.edge_id);
        }
      });

      // Animated glowing pulse dot along wire
      const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      dot.setAttribute("class", "flow-glow-dot");
      dot.setAttribute("r", "5");
      dot.setAttribute("data-edge-id", edge.edge_id);
      dot.setAttribute("cx", p1.x);
      dot.setAttribute("cy", p1.y);

      g.appendChild(path);
      g.appendChild(dot);
      svgEdgesGroup.appendChild(g);
    });
  }

  function deleteEdge(edgeId) {
    edges = edges.filter(e => e.edge_id !== edgeId);
    renderAllEdges();
    fetch(`/api/edges/${edgeId}`, { method: "DELETE" }).catch(() => {});
  }

  function getPortCenterCoordinate(portEl) {
    const contentRect = canvasContent.getBoundingClientRect();
    const portRect = portEl.getBoundingClientRect();
    return {
      x: (portRect.left + portRect.width / 2 - contentRect.left) / zoomLevel,
      y: (portRect.top + portRect.height / 2 - contentRect.top) / zoomLevel
    };
  }

  let pulseProgress = 0;
  function startFlowPulseAnimation() {
    function animate() {
      pulseProgress = (pulseProgress + 0.008) % 1.0;
      const paths = svgEdgesGroup.querySelectorAll(".flow-path");
      paths.forEach(p => {
        const edgeId = p.getAttribute("id");
        const dot = svgEdgesGroup.querySelector(`.flow-glow-dot[data-edge-id="${edgeId}"]`);
        if (dot) {
          try {
            const len = p.getTotalLength();
            if (len > 0) {
              const pt = p.getPointAtLength(pulseProgress * len);
              dot.setAttribute("cx", pt.x);
              dot.setAttribute("cy", pt.y);
            }
          } catch (e) {}
        }
      });
      requestAnimationFrame(animate);
    }
    requestAnimationFrame(animate);
  }

  // ================= 4. DRAGGABLE NODES & REMOVAL =================
  function initDraggableNodes() {
    document.querySelectorAll(".pipeline-node").forEach(bindNodeDragEvents);
    document.querySelectorAll(".delete-node-btn").forEach(bindDeleteNodeEvent);
  }

  function bindNodeDragEvents(nodeEl) {
    const header = nodeEl.querySelector(".node-header");
    if (!header) return;

    header.addEventListener("mousedown", (e) => {
      if (e.target.closest("button") || e.target.closest("input") || e.target.closest("select")) return;
      activeDraggingNode = nodeEl;
      const rect = nodeEl.getBoundingClientRect();
      dragOffsetX = (e.clientX - rect.left) / zoomLevel;
      dragOffsetY = (e.clientY - rect.top) / zoomLevel;
      e.stopPropagation();
    });
  }

  function bindDeleteNodeEvent(btn) {
    btn.removeEventListener("click", handleDeleteClick);
    btn.addEventListener("click", handleDeleteClick);
  }

  function handleDeleteClick(e) {
    e.stopPropagation();
    const btn = e.currentTarget;
    const nodeEl = btn.closest(".pipeline-node");
    if (!nodeEl) return;
    const nodeId = btn.dataset.node || nodeEl.dataset.node || nodeEl.id;
    deleteNode(nodeId, nodeEl);
  }

  function deleteNode(nodeId, nodeEl) {
    if (!nodeEl) {
      nodeEl = document.getElementById(nodeId) || document.querySelector(`[data-node="${nodeId}"]`);
    }

    const title = nodeEl ? (nodeEl.querySelector(".node-title")?.innerText || nodeId) : nodeId;
    if (!confirm(`Are you sure you want to remove node [${title}] from the pipeline canvas?\nAll attached wires will be severed and data will bypass this node.`)) {
      return;
    }

    // 1. Sever and remove all connected edges
    edges = edges.filter(e => e.source_node !== nodeId && e.target_node !== nodeId);
    renderAllEdges();

    // 2. Animate out and remove from DOM
    if (nodeEl) {
      nodeEl.style.transition = "all 0.25s ease-out";
      nodeEl.style.transform = "scale(0.8)";
      nodeEl.style.opacity = "0";
      setTimeout(() => {
        nodeEl.remove();
        if (window.refreshTopBarNodeBadges) {
          window.refreshTopBarNodeBadges();
        }
      }, 250);
    }

    // 3. Delete from backend SQLite database
    fetch(`/api/nodes/${nodeId}`, { method: "DELETE" }).catch(() => {});

    if (window.AppTerminal) {
      window.AppTerminal.appendLog({
        timestamp: Date.now(),
        stream: "PIPELINE",
        level: "WARN",
        message: `Removed node [${title}] from canvas. Severed all incoming/outgoing wires.`
      });
    }
  }

  function persistNodePosition(nodeId, x, y) {
    fetch(`/api/nodes/${nodeId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pos_x: x, pos_y: y })
    }).catch(() => {});
  }

  // ================= 5. SWAPPABLE NODE PALETTE MODAL =================
  const NODE_TEMPLATES = [
    {
      id: "nodeScraper",
      type: "scraper",
      title: "Bihar Regional Web Scraper",
      icon: "🕷️",
      tag: "SOURCE_INGESTION",
      desc: "Background RSS, Web feed & portal scraper for Bihar civic grievances (Bhaskar, Prabhat, Hindustan, Jagran).",
      defaultPos: { x: 60, y: 40 }
    },
    {
      id: "nodeDeepseek",
      type: "ai_automator",
      title: "DeepSeek AI Web Automator",
      icon: "🧠",
      tag: "AI_AUTOMATOR",
      desc: "Injected JS runtime for chat.deepseek.com to automate low-latency Bihar news classification & grievance parsing.",
      defaultPos: { x: 480, y: 40 }
    },
    {
      id: "nodeSeverity",
      type: "severity_scorer",
      title: "Civic Priority & Severity Scorer",
      icon: "🚨",
      tag: "SEVERITY_EXT",
      desc: "Calculates citizen hazard score (1-100), response priority, and emergency field mitigation steps.",
      defaultPos: { x: 900, y: 40 }
    },
    {
      id: "nodeFactcheck",
      type: "fact_checker",
      title: "Regional Fact-Checker & Authenticity",
      icon: "🔍",
      tag: "FACTCHECK_EXT",
      desc: "Cross-checks Bihar reporting patterns, detects viral rumors, and flags political mudslinging.",
      defaultPos: { x: 1320, y: 40 }
    },
    {
      id: "nodeRuleFilter",
      type: "rule_filter",
      title: "Rule-Based Political Purge & Gatekeeper",
      icon: "🛡️",
      tag: "RULE_ENGINE",
      desc: "Filters election mudslinging and pure politics deterministically via keyword & regex rules.",
      defaultPos: { x: 480, y: 440 }
    },
    {
      id: "nodeApiAi",
      type: "ai_api",
      title: "API LLM Router (Groq / Ollama / Cloud AI)",
      icon: "⚡",
      tag: "API_ROUTER",
      desc: "Direct API LLM bridge for high-concurrency backup classification without browser tabs.",
      defaultPos: { x: 900, y: 440 }
    },
    {
      id: "nodeTerminal",
      type: "terminal_dispatch",
      title: "Master Output & Processed DB",
      icon: "📢",
      tag: "TERMINAL_DB",
      desc: "Consolidates all upstream facets (Urgency, Severity, Authenticity) into SQLite processed_news.",
      defaultPos: { x: 1740, y: 40 }
    }
  ];

  function initAddNodePalette() {
    const backdrop = document.getElementById("nodePaletteBackdrop");
    const closeBtn = document.getElementById("closePaletteBtn");
    const grid = document.getElementById("paletteGrid");
    const addBtn = document.getElementById("addNodeBtn");

    if (!backdrop || !grid) return;

    if (addBtn) {
      addBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        renderPaletteGrid(grid);
        backdrop.classList.add("open");
      });
    }

    closeBtn?.addEventListener("click", (e) => {
      e.preventDefault();
      backdrop.classList.remove("open");
    });

    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) {
        backdrop.classList.remove("open");
      }
    });

    // Also support Escape key
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && backdrop.classList.contains("open")) {
        backdrop.classList.remove("open");
      }
    });
  }

  function renderPaletteGrid(gridEl) {
    gridEl.innerHTML = "";
    NODE_TEMPLATES.forEach(tmpl => {
      const isAlreadyOnCanvas = !!document.getElementById(tmpl.id);
      const card = document.createElement("div");
      card.className = "palette-card";
      card.innerHTML = `
        <div class="palette-card-top">
          <span class="palette-card-icon">${tmpl.icon}</span>
          <div>
            <div class="palette-card-title">${tmpl.title}</div>
            <span class="palette-card-tag" style="background: rgba(56, 189, 248, 0.15); color: #38bdf8;">${tmpl.tag}</span>
          </div>
        </div>
        <p class="palette-card-desc">${tmpl.desc}</p>
        <div class="palette-card-footer">
          <span class="palette-status-pill ${isAlreadyOnCanvas ? 'online' : ''}">
            ${isAlreadyOnCanvas ? '● On Canvas' : '○ Not on Canvas'}
          </span>
          <div style="display: flex; gap: 6px;">
            ${isAlreadyOnCanvas ? `
              <button class="btn btn-outline btn-sm focus-palette-item-btn">🎯 Focus</button>
            ` : `
              <button class="btn btn-primary btn-sm add-palette-item-btn">➕ Add to Canvas</button>
            `}
          </div>
        </div>
      `;

      const focusBtn = card.querySelector(".focus-palette-item-btn");
      if (focusBtn) {
        focusBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          const backdrop = document.getElementById("nodePaletteBackdrop");
          backdrop?.classList.remove("open");
          focusNodeOnCanvas(tmpl.id);
        });
      }

      const addBtn = card.querySelector(".add-palette-item-btn");
      if (addBtn) {
        addBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          const backdrop = document.getElementById("nodePaletteBackdrop");
          backdrop?.classList.remove("open");
          spawnNode(tmpl);
        });
      }

      gridEl.appendChild(card);
    });
  }

  function focusNodeOnCanvas(nodeId) {
    const el = document.getElementById(nodeId);
    if (!el) return;

    // Use transform panning instead of browser scrollIntoView so headers/controls are never scrolled away
    const nodeLeft = parseFloat(el.style.left) || el.offsetLeft || 0;
    const nodeTop = parseFloat(el.style.top) || el.offsetTop || 0;
    const nodeWidth = el.offsetWidth || 340;
    const nodeHeight = el.offsetHeight || 300;

    const wrapperRect = canvasWrapper ? canvasWrapper.getBoundingClientRect() : { width: window.innerWidth, height: window.innerHeight };
    const centerX = wrapperRect.width / 2;
    const centerY = wrapperRect.height / 2;

    panX = centerX - (nodeLeft + nodeWidth / 2) * zoomLevel;
    panY = centerY - (nodeTop + nodeHeight / 2) * zoomLevel;

    applyTransform();
    renderAllEdges();

    if (canvasWrapper) {
      canvasWrapper.scrollTop = 0;
      canvasWrapper.scrollLeft = 0;
    }
    window.scrollTo(0, 0);

    el.style.boxShadow = "0 0 25px #38bdf8";
    setTimeout(() => { el.style.boxShadow = ""; }, 1500);

    if (window.refreshTopBarNodeBadges) {
      window.refreshTopBarNodeBadges();
    }
  }

  function spawnNode(tmpl) {
    const left = tmpl.defaultPos?.x || (150 + Math.random() * 400);
    const top = tmpl.defaultPos?.y || (150 + Math.random() * 200);

    const div = document.createElement("div");
    div.className = "pipeline-node";
    div.id = tmpl.id;
    div.dataset.node = tmpl.id;
    div.style.left = `${left}px`;
    div.style.top = `${top}px`;

    div.innerHTML = `
      <div class="node-port port-input" data-node="${tmpl.id}" data-port="in" title="Inflow Port"></div>
      <div class="node-header">
        <div class="node-title-group">
          <span class="node-icon">${tmpl.icon}</span>
          <div>
            <span class="node-title">${tmpl.title}</span>
            <span class="node-type-tag">${tmpl.tag}</span>
          </div>
        </div>
        <div class="node-header-actions">
          <span class="node-status-badge active">Active</span>
          <button class="node-close-btn delete-node-btn" data-node="${tmpl.id}" title="Delete Node from Pipeline">✕</button>
        </div>
      </div>
      <div class="node-cards-container">
        <div class="node-card" style="width: 320px;">
          <div class="card-top">
            <h3>Module Configuration</h3>
            <span class="count-pill">Ready</span>
          </div>
          <div class="card-body">
            <p style="font-size: 11px; color: #94a3b8; line-height: 1.4; margin-bottom: 8px;">${tmpl.desc}</p>
            <div style="background: rgba(0,0,0,0.5); padding: 8px; border-radius: 4px; font-family: var(--font-mono); font-size: 10px; color: #38bdf8;">
              Status: Connected to pipeline graph
            </div>
          </div>
        </div>
      </div>
      <div class="node-port port-output" data-node="${tmpl.id}" data-port="out" title="Outflow Port"></div>
    `;

    canvasContent.appendChild(div);
    bindNodeDragEvents(div);
    div.querySelectorAll(".delete-node-btn").forEach(bindDeleteNodeEvent);

    // Save to SQLite
    fetch(`/api/nodes/${tmpl.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        node_type: tmpl.type,
        title: tmpl.title,
        pos_x: left,
        pos_y: top,
        config: {}
      })
    }).catch(() => {});

    focusNodeOnCanvas(tmpl.id);

    if (window.refreshTopBarNodeBadges) {
      window.refreshTopBarNodeBadges();
    }

    if (window.AppTerminal) {
      window.AppTerminal.appendLog({
        timestamp: Date.now(),
        stream: "PIPELINE",
        level: "SUCCESS",
        message: `Added node [${tmpl.title}] to canvas. Wire ports to route data.`
      });
    }
  }

  async function loadSavedGraph() {
    try {
      const resp = await fetch("/api/edges");
      const data = await resp.json();
      if (data.edges && data.edges.length > 0) {
        edges = data.edges;
        renderAllEdges();
      } else {
        // Fallback default starter edges
        edges = [
          { edge_id: "edge_scraper_to_deepseek", source_node: "nodeScraper", source_port: "out", target_node: "nodeDeepseek", target_port: "in" },
          { edge_id: "edge_deepseek_to_terminal", source_node: "nodeDeepseek", source_port: "out", target_node: "nodeTerminal", target_port: "in" }
        ];
        edges.forEach(e => persistEdge(e));
        renderAllEdges();
      }
    } catch (e) {
      console.warn("Could not load saved edges:", e);
    }
  }

  function showDiscoveryToast(name, icon, nodeId) {
    const existingToast = document.querySelector(`.discovery-toast[data-node="${nodeId}"]`);
    if (existingToast) return;

    const toast = document.createElement("div");
    toast.className = "discovery-toast";
    toast.dataset.node = nodeId;
    toast.innerHTML = `
      <span style="font-size: 18px;">${icon || '🔌'}</span>
      <div style="font-size: 11px;">
        <strong>Extension Connected:</strong> ${name}
      </div>
      <button class="btn btn-primary btn-sm add-from-toast-btn" style="margin-left: 6px;">
        ➕ Add Node
      </button>
      <button class="node-close-btn close-toast-btn" style="margin-left: 4px;">✕</button>
    `;

    toast.querySelector(".close-toast-btn").addEventListener("click", () => toast.remove());
    toast.querySelector(".add-from-toast-btn").addEventListener("click", () => {
      const tmpl = NODE_TEMPLATES.find(t => t.id === nodeId) || {
        id: nodeId,
        title: name,
        icon: icon || '🔌',
        tag: 'EXTENSION',
        desc: `Dynamic Chrome Extension module: ${name}`
      };
      spawnNode(tmpl);
      toast.remove();
    });

    document.body.appendChild(toast);
    setTimeout(() => { toast.remove(); }, 8000);
  }

  return {
    init,
    renderAllEdges,
    applyTransform,
    deleteNode,
    spawnNode,
    focusNodeOnCanvas,
    showDiscoveryToast
  };
})();
