/**
 * News Detail Modal & Master DB Drawer Controller.
 * Displays comprehensive civic grievance intelligence, tagged media,
 * logical flaw ratings, and raw AI JSON schemas.
 */

window.NewsModal = (function () {
  const modal = document.getElementById("newsDetailModal");
  const closeModalBtn = document.getElementById("closeModalBtn");
  const modalNewsTitle = document.getElementById("modalNewsTitle");
  const modalMainImg = document.getElementById("modalMainImg");
  const modalIdWatermark = document.getElementById("modalIdWatermark");
  const modalDistrict = document.getElementById("modalDistrict");
  const modalBlock = document.getElementById("modalBlock");
  const modalLocality = document.getElementById("modalLocality");
  const modalGrievanceType = document.getElementById("modalGrievanceType");
  const modalIsPolitical = document.getElementById("modalIsPolitical");
  const modalAuthority = document.getElementById("modalAuthority");
  const modalUrgency = document.getElementById("modalUrgency");
  const modalFlawScore = document.getElementById("modalFlawScore");
  const modalSentiment = document.getElementById("modalSentiment");
  const modalAffectedPop = document.getElementById("modalAffectedPop");
  const modalSourceLink = document.getElementById("modalSourceLink");
  const modalStorySummary = document.getElementById("modalStorySummary");
  const modalDemandsList = document.getElementById("modalDemandsList");
  const modalRawJson = document.getElementById("modalRawJson");
  const copyJsonBtn = document.getElementById("copyJsonBtn");

  // Master DB Drawer elements
  const dbDrawer = document.getElementById("dbDrawer");
  const openDbDrawerBtn = document.getElementById("openDbDrawerBtn");
  const closeDrawerBtn = document.getElementById("closeDrawerBtn");
  const drawerTabProc = document.getElementById("drawerTabProc");
  const drawerTabRaw = document.getElementById("drawerTabRaw");
  const drawerTableHead = document.getElementById("drawerTableHead");
  const drawerTableBody = document.getElementById("drawerTableBody");

  let currentRawJsonString = "";
  let activeDrawerTab = "processed";

  function escapeHtml(text) {
    if (text === null || text === undefined) return "";
    const div = document.createElement("div");
    div.textContent = String(text);
    return div.innerHTML;
  }

  function init() {
    if (closeModalBtn) closeModalBtn.addEventListener("click", closeModal);
    if (modal) {
      modal.addEventListener("click", (e) => {
        if (e.target === modal) closeModal();
      });
    }

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (modal && modal.classList.contains("open")) closeModal();
        if (dbDrawer && dbDrawer.classList.contains("open")) closeDrawer();
      }
    });

    if (copyJsonBtn) {
      copyJsonBtn.addEventListener("click", () => {
        navigator.clipboard.writeText(currentRawJsonString).then(() => {
          alert("Raw AI JSON copied to clipboard!");
        });
      });
    }

    // Drawer events
    if (openDbDrawerBtn) openDbDrawerBtn.addEventListener("click", openDrawer);
    if (closeDrawerBtn) closeDrawerBtn.addEventListener("click", closeDrawer);
    if (drawerTabProc) drawerTabProc.addEventListener("click", () => switchDrawerTab("processed"));
    if (drawerTabRaw) drawerTabRaw.addEventListener("click", () => switchDrawerTab("raw"));

    const panelModalBtn = document.getElementById("panelOpenModalDbBtn");
    if (panelModalBtn) panelModalBtn.addEventListener("click", openDrawer);
  }

  async function openModalWithItem(item) {
    if (!item) return;

    // If an ID string was passed instead of an object, fetch full news item from backend
    if (typeof item === "string") {
      try {
        const resp = await fetch(`/api/news/${encodeURIComponent(item)}`);
        if (resp.ok) {
          item = await resp.json();
        } else {
          item = { id: item, title: "Bihar Intelligence Item (" + item.slice(-8) + ")" };
        }
      } catch (e) {
        item = { id: item, title: "Bihar Intelligence Item (" + item.slice(-8) + ")" };
      }
    }

    const modalEl = document.getElementById("newsDetailModal") || modal;
    if (!modalEl) {
      console.error("[NewsModal] Modal container #newsDetailModal not found in DOM!");
      return;
    }

    try {
      if (modalNewsTitle) {
        modalNewsTitle.innerText = item.title || "Bihar News Intelligence Item";
      }

      const itemId = item.id || item.raw_id || "bihar_item";
      if (modalIdWatermark) {
        modalIdWatermark.innerText = `ID: ${String(itemId).slice(-8)}`;
      }

      // Tagged Media preview
      if (modalMainImg) {
        let mediaUrls = item.media_urls || [];
        if (typeof mediaUrls === "string") {
          try { mediaUrls = JSON.parse(mediaUrls); } catch (e) { mediaUrls = [mediaUrls]; }
        }
        if (Array.isArray(mediaUrls) && mediaUrls.length > 0 && typeof mediaUrls[0] === "string" && mediaUrls[0].startsWith("http")) {
          modalMainImg.src = mediaUrls[0];
          modalMainImg.style.display = "block";
        } else {
          modalMainImg.src = "https://images.unsplash.com/photo-1547683905-f686c993aae5?auto=format&fit=crop&w=800&q=80";
        }
      }

      // Geographic Intelligence
      if (modalDistrict) modalDistrict.innerText = item.district || item.district_hint || "Bihar (General)";
      if (modalBlock) modalBlock.innerText = item.city_block || "Unspecified Block";
      if (modalLocality) modalLocality.innerText = item.locality || "Unspecified Locality";

      // Civic Classification
      const isGrievance = item.is_grievance !== undefined ? Boolean(item.is_grievance) : true;
      if (modalGrievanceType) {
        modalGrievanceType.innerHTML = isGrievance
          ? `<span class="badge-grievance">Grievance: ${escapeHtml(item.grievance_type || item.grievance_category || "Civic Issue")}</span>`
          : `<span style="color: #60a5fa;">General News</span>`;
      }

      if (modalIsPolitical) {
        modalIsPolitical.innerHTML = item.is_political
          ? `<span class="badge-political">Political Flagged (Filterable)</span>`
          : `<span style="color: #34d399;">Non-Political (Direct Civic)</span>`;
      }

      if (modalAuthority) {
        modalAuthority.innerText = item.responsible_authority || "Local Administration / Municipal Corporation";
      }

      // Ratings & Urgency
      const urgency = parseInt(item.urgency_level, 10) || 1;
      if (modalUrgency) {
        modalUrgency.innerHTML = `<span class="badge-urgency urgency-${urgency}">Level ${urgency}/5 (${getUrgencyLabel(urgency)})</span>`;
      }

      const flaw = parseInt(item.logical_flaw_rating, 10) || 1;
      if (modalFlawScore) {
        modalFlawScore.innerHTML = `<span style="color: ${flaw > 2 ? '#fbbf24' : '#34d399'}; font-weight: 700;">${flaw}/5 (${getFlawLabel(flaw)})</span>`;
      }

      if (modalSentiment) modalSentiment.innerText = item.sentiment || "Neutral";
      if (modalAffectedPop) modalAffectedPop.innerText = item.affected_population || "Locality";

      // Source link
      if (modalSourceLink) {
        modalSourceLink.innerText = item.source_name || "Bihar Source";
        modalSourceLink.href = item.source_url && item.source_url.startsWith("http") ? item.source_url : "#";
      }

      // Dynamic Exotic Facets & Node Attributes
      const exoticContainer = document.getElementById("modalExoticContainer");
      const exoticPanel = document.getElementById("modalExoticPanel");
      let attrs = item.attributes || {};
      if (typeof attrs === "string") {
        try { attrs = JSON.parse(attrs); } catch (e) { attrs = {}; }
      }
      const attrKeys = (typeof attrs === "object" && attrs !== null) ? Object.keys(attrs) : [];

      if (exoticPanel && exoticContainer) {
        if (attrKeys.length > 0) {
          exoticPanel.style.display = "block";
          exoticContainer.innerHTML = "";
          attrKeys.forEach(k => {
            const val = attrs[k];
            const valStr = typeof val === "object" ? JSON.stringify(val) : String(val);
            const div = document.createElement("div");
            div.className = "badge-exotic";
            div.innerHTML = `<span class="badge-exotic-key">${escapeHtml(k)}:</span> <span class="badge-exotic-val">${escapeHtml(valStr)}</span>`;
            exoticContainer.appendChild(div);
          });
        } else {
          exoticPanel.style.display = "none";
        }
      }

      // Story Summary
      if (modalStorySummary) {
        modalStorySummary.innerText = item.actual_news || item.content || item.snippet || item.raw_snippet || "No summary available.";
      }

      // Key Citizen Demands
      if (modalDemandsList) {
        modalDemandsList.innerHTML = "";
        let demands = item.key_demands || [];
        if (typeof demands === "string") {
          try { demands = JSON.parse(demands); } catch (e) { demands = [demands]; }
        }
        if (!Array.isArray(demands)) {
          demands = demands ? [String(demands)] : [];
        }

        if (demands.length > 0) {
          demands.forEach(d => {
            const li = document.createElement("li");
            li.innerText = String(d);
            modalDemandsList.appendChild(li);
          });
        } else {
          modalDemandsList.innerHTML = "<li>No specific citizen demands recorded.</li>";
        }
      }

      // Raw JSON representation
      currentRawJsonString = JSON.stringify(item, null, 2);
      if (modalRawJson) {
        modalRawJson.innerText = currentRawJsonString;
      }

      // Asynchronously fetch complete details if story content is brief
      const lookupId = item.id || item.raw_id;
      if (lookupId && (!item.content && !item.actual_news)) {
        fetch(`/api/news/${encodeURIComponent(lookupId)}`)
          .then(r => r.ok ? r.json() : null)
          .then(fullItem => {
            if (fullItem && modalStorySummary && (modalStorySummary.innerText === "No summary available." || !modalStorySummary.innerText)) {
              modalStorySummary.innerText = fullItem.actual_news || fullItem.content || fullItem.snippet || "";
            }
          })
          .catch(() => {});
      }

      // Open Modal with explicit CSS & class guarantees
      modalEl.classList.add("open");
      modalEl.style.display = "flex";
      modalEl.style.opacity = "1";
      modalEl.style.pointerEvents = "auto";
      modalEl.style.zIndex = "10005";
    } catch (err) {
      console.error("[NewsModal] Error opening modal:", err);
      modalEl.classList.add("open");
      modalEl.style.display = "flex";
      modalEl.style.opacity = "1";
      modalEl.style.pointerEvents = "auto";
      modalEl.style.zIndex = "10005";
    }
  }

  function closeModal() {
    const modalEl = document.getElementById("newsDetailModal") || modal;
    if (modalEl) {
      modalEl.classList.remove("open");
      modalEl.style.display = "none";
      modalEl.style.opacity = "0";
      modalEl.style.pointerEvents = "none";
    }
  }

  function getUrgencyLabel(u) {
    if (u >= 5) return "CRITICAL / DISASTER";
    if (u === 4) return "HIGH SEVERITY";
    if (u === 3) return "ELEVATED CONCERN";
    if (u === 2) return "MODERATE";
    return "ROUTINE";
  }

  function getFlawLabel(f) {
    if (f >= 4) return "Sensational / Unverified";
    if (f === 3) return "Minor Bias Detected";
    return "Factual & Consistent";
  }

  // Master DB Drawer
  function openDrawer() {
    if (dbDrawer) {
      dbDrawer.classList.add("open");
      loadDrawerData();
    }
  }

  function closeDrawer() {
    if (dbDrawer) dbDrawer.classList.remove("open");
  }

  function switchDrawerTab(tab) {
    activeDrawerTab = tab;
    if (tab === "processed") {
      if (drawerTabProc) drawerTabProc.className = "btn btn-primary btn-sm";
      if (drawerTabRaw) drawerTabRaw.className = "btn btn-outline btn-sm";
    } else {
      if (drawerTabProc) drawerTabProc.className = "btn btn-outline btn-sm";
      if (drawerTabRaw) drawerTabRaw.className = "btn btn-primary btn-sm";
    }
    loadDrawerData();
  }

  async function loadDrawerData() {
    if (!drawerTableBody) return;
    drawerTableBody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: #64748b;">Loading table records...</td></tr>';
    const endpoint = activeDrawerTab === "processed" ? "/api/processed_news" : "/api/raw_news";

    try {
      const resp = await fetch(endpoint);
      const data = await resp.json();
      renderDrawerTable(data.items || []);
    } catch (e) {
      drawerTableBody.innerHTML = `<tr><td colspan="5" style="color: #ef4444;">Failed to load DB: ${escapeHtml(e.message)}</td></tr>`;
    }
  }

  function renderDrawerTable(items) {
    if (!drawerTableHead || !drawerTableBody) return;

    if (activeDrawerTab === "processed") {
      drawerTableHead.innerHTML = `
        <tr>
          <th>ID</th>
          <th>Title</th>
          <th>District</th>
          <th>Urgency</th>
          <th>Grievance</th>
        </tr>
      `;
      drawerTableBody.innerHTML = "";
      if (items.length === 0) {
        drawerTableBody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: #64748b;">No processed items in DB yet.</td></tr>';
        return;
      }
      items.forEach(item => {
        const tr = document.createElement("tr");
        tr.style.cursor = "pointer";
        const titleStr = (item.title || "Untitled").substring(0, 35);
        const distStr = item.district || "Bihar";
        const urgency = item.urgency_level || 1;
        const idSuffix = String(item.id || "").slice(-8);

        tr.innerHTML = `
          <td><span style="color: #38bdf8; font-family: monospace;">${escapeHtml(idSuffix)}</span></td>
          <td style="font-weight: 600;">${escapeHtml(titleStr)}...</td>
          <td><span class="badge-location">${escapeHtml(distStr)}</span></td>
          <td><span class="badge-urgency urgency-${urgency}">${urgency}/5</span></td>
          <td>${item.is_grievance ? '<span class="badge-grievance">Yes</span>' : 'News'}</td>
        `;
        tr.addEventListener("click", () => openModalWithItem(item));
        drawerTableBody.appendChild(tr);
      });
    } else {
      drawerTableHead.innerHTML = `
        <tr>
          <th>ID</th>
          <th>Title</th>
          <th>Source</th>
          <th>District Hint</th>
          <th>Status</th>
        </tr>
      `;
      drawerTableBody.innerHTML = "";
      if (items.length === 0) {
        drawerTableBody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: #64748b;">No raw items in DB yet.</td></tr>';
        return;
      }
      items.forEach(item => {
        const tr = document.createElement("tr");
        tr.style.cursor = "pointer";
        const titleStr = (item.title || "Untitled").substring(0, 35);
        const idSuffix = String(item.id || "").slice(-8);

        tr.innerHTML = `
          <td><span style="color: #38bdf8; font-family: monospace;">${escapeHtml(idSuffix)}</span></td>
          <td style="font-weight: 600;">${escapeHtml(titleStr)}...</td>
          <td><span style="color: #94a3b8;">${escapeHtml(item.source_name || 'Web Feed')}</span></td>
          <td><span class="badge-location">${escapeHtml(item.district_hint || 'Bihar')}</span></td>
          <td><span style="color: ${item.status === 'completed' ? '#34d399' : '#fbbf24'};">${escapeHtml(item.status || 'pending')}</span></td>
        `;
        tr.addEventListener("click", () => openModalWithItem(item));
        drawerTableBody.appendChild(tr);
      });
    }
  }

  function generateDistrictBrief(districtName, items = []) {
    const distGrievances = items.filter(it => {
      const d = (it.district || it.district_hint || "").toLowerCase();
      return d.includes(districtName.toLowerCase());
    });
    
    const critical = distGrievances.filter(it => (it.urgency_level || it.urgency_hint || 0) >= 4);
    const dateStr = new Date().toLocaleDateString("en-IN", { day: 'numeric', month: 'short', year: 'numeric' });
    
    const briefHtml = `
      <div style="font-family: inherit; color: #f8fafc;">
        <div style="border-bottom: 2px solid #0284c7; padding-bottom: 12px; margin-bottom: 16px;">
          <h2 style="margin: 0; color: #38bdf8; font-size: 18px;">🏛️ District Magistrate Civic Intelligence Brief: ${escapeHtml(districtName)}</h2>
          <div style="font-size: 12px; color: #94a3b8; margin-top: 4px;">Compiled on ${dateStr} | Bihar Citizen Echo Automated Sentinel</div>
        </div>
        <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 18px;">
          <div style="background: rgba(15,23,42,0.8); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; padding: 12px; text-align: center;">
            <div style="font-size: 22px; font-weight: 700; color: #38bdf8;">${distGrievances.length}</div>
            <div style="font-size: 11px; color: #94a3b8; text-transform: uppercase;">Total Incidents</div>
          </div>
          <div style="background: rgba(15,23,42,0.8); border: 1px solid rgba(239,68,68,0.3); border-radius: 8px; padding: 12px; text-align: center;">
            <div style="font-size: 22px; font-weight: 700; color: #ef4444;">${critical.length}</div>
            <div style="font-size: 11px; color: #fca5a5; text-transform: uppercase;">Critical Hazards</div>
          </div>
          <div style="background: rgba(15,23,42,0.8); border: 1px solid rgba(52,211,153,0.3); border-radius: 8px; padding: 12px; text-align: center;">
            <div style="font-size: 22px; font-weight: 700; color: #34d399;">${Math.round((distGrievances.length - critical.length) / Math.max(1, distGrievances.length) * 100)}%</div>
            <div style="font-size: 11px; color: #6ee7b7; text-transform: uppercase;">Standard Routine</div>
          </div>
        </div>
        <h4 style="margin: 12px 0 8px 0; color: #e2e8f0; font-size: 13px;">🚨 Priority Action Items Requiring Administrative Intervention:</h4>
        <ul style="list-style-type: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px;">
          ${distGrievances.slice(0, 5).map((g, idx) => `
            <li style="background: rgba(30,41,59,0.7); border-left: 3px solid ${(g.urgency_level || g.urgency_hint || 0) >= 4 ? '#ef4444' : '#38bdf8'}; border-radius: 4px; padding: 8px 12px;">
              <div style="font-weight: 600; font-size: 12px; color: #f1f5f9;">${idx + 1}. ${escapeHtml(g.title || 'Civic Grievance')}</div>
              <div style="font-size: 11px; color: #94a3b8; margin-top: 4px;">Responsible Authority: <span style="color: #cbd5e1; font-weight: 500;">${escapeHtml(g.responsible_authority || 'Local Administration / Ward')}</span></div>
            </li>
          `).join('')}
        </ul>
        <div style="margin-top: 20px; display: flex; justify-content: flex-end; gap: 8px;">
          <button onclick="window.print()" class="btn btn-secondary btn-sm">🖨️ Print Brief</button>
        </div>
      </div>
    `;

    const detailModal = document.getElementById("detailModal");
    const modalBody = document.getElementById("modalBody");
    if (detailModal && modalBody) {
      modalBody.innerHTML = briefHtml;
      detailModal.classList.add("open");
    }
  }

  return {
    init,
    openModalWithItem,
    openDrawer,
    generateDistrictBrief
  };
})();
