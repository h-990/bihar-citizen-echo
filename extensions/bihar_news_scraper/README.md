# 🗞️ Bihar Regional News Grievance Scraper Extension

High-speed parallel multi-portal crawler Chrome extension for automated monitoring of regional public grievances across Bihar.

## Features
- **Concurrent Multi-Portal Crawling**: Launches and coordinates dedicated worker tabs across 3 prominent regional news outlets:
  - Dainik Bhaskar Bihar
  - Live Hindustan Bihar
  - Prabhat Khabar Bihar
- **Selective Portal Filtering**: Enable or disable specific news portals on the fly directly from the extension popup.
- **Civic Grievance Prioritization**: Built-in Hindi/English taxonomy scoring for civic infrastructure problems:
  - Roads, Bridges & Waterlogging
  - Electricity & Power Outages
  - Drinking Water & Nal-Jal Scheme
  - Public Hospitals & Primary Healthcare
  - Municipal Sanitation & Garbage Waste
  - Public Protests & Demonstrations
- **Data Export Capabilities**: One-click download of collected regional reports in structured **JSON** and **CSV** formats.
- **Real-Time Telemetry Badge**: Dynamic badge on the extension icon displaying active crawler status and tab worker counts.
- **Zero-Latency WebSocket Streaming**: Streams discovered raw news payloads directly to the Bihar Citizen Echo backend ingest pipeline via WebSocket (`ws://localhost:8000/ws/hub`).

## Installation
1. Open Google Chrome or any Chromium-based browser (Brave, Edge).
2. Navigate to `chrome://extensions`.
3. Enable **Developer mode** via the toggle switch in the upper right corner.
4. Click **Load unpacked** and select this directory: `extensions/bihar_news_scraper`.
5. The extension icon will appear in your Chrome toolbar.

## Architecture
- `manifest.json`: Manifest V3 extension configuration with host permissions for target news domains.
- `background.js`: Service worker handling WebSocket connection, queue management, tab life cycles, and storage persistence.
- `content.js`: Content script injected into news pages for link harvesting, DOM content extraction, and contextual grievance tagging.
- `popup.html` / `popup.js`: Dashboard popup providing crawler controls, active statistics, portal selectors, and data export.
