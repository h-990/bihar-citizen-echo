"""
Main FastAPI Application & HTTP/WebSocket Server.
Orchestrates the entire Bihar News & Public Grievance Extraction Pipeline.
"""
import os
import io
import re
import csv
import json
import time
from contextlib import asynccontextmanager
from typing import Optional, Dict, Any, List
import httpx

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from backend.database import (
    init_db, get_all_raw_news, get_all_processed_news, get_news_detail,
    get_recent_logs, reset_all_databases, insert_raw_news, insert_processed_news,
    get_all_nodes, save_node_config, get_district_hotspot_summary
)
from backend.hub import hub
from backend.pipeline import PipelineOrchestrator

START_TIME = time.time()
pipeline = PipelineOrchestrator(hub)

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Initialize DB and Pipeline on startup
    await init_db()
    await pipeline.initialize()
    await hub.broadcast_log("SYSTEM", "SUCCESS", "Bihar News & Grievance Backend Server started successfully.")
    yield
    # Shutdown
    if pipeline._worker_task:
        pipeline._worker_task.cancel()

app = FastAPI(
    title="Bihar Citizen Echo - Grievance & Local News Orchestrator",
    description="Modular pipeline orchestrator for Bihar news scraping and DeepSeek AI analysis",
    version="1.0.0",
    lifespan=lifespan
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def add_no_cache_headers(request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response

# ----------------- WEBSOCKET HUB & ALIASES -----------------
async def _handle_ws_connection(websocket: WebSocket, client_type: str):
    await hub.register(websocket, client_type)
    try:
        while True:
            data = await websocket.receive_text()
            await hub.handle_message(websocket, client_type, data)
    except WebSocketDisconnect:
        await hub.unregister(websocket, client_type)
    except Exception as e:
        await hub.broadcast_log("SYSTEM", "ERROR", f"WebSocket error for {client_type}: {str(e)}")
        await hub.unregister(websocket, client_type)

@app.websocket("/ws/hub")
async def websocket_hub_endpoint(websocket: WebSocket, client_type: str = Query("frontend")):
    await _handle_ws_connection(websocket, client_type)

@app.websocket("/ws/scraper")
async def websocket_scraper_alias(websocket: WebSocket):
    await _handle_ws_connection(websocket, "scraper_ext")

@app.websocket("/ws/deepseek_automator")
async def websocket_deepseek_alias(websocket: WebSocket):
    await _handle_ws_connection(websocket, "deepseek_ext")

@app.websocket("/ws/groq_automator")
async def websocket_groq_alias(websocket: WebSocket):
    await _handle_ws_connection(websocket, "deepseek_ext")

@app.websocket("/ws/severity_scorer")
async def websocket_severity_alias(websocket: WebSocket):
    await _handle_ws_connection(websocket, "severity_ext")

@app.websocket("/ws/fact_checker")
async def websocket_factcheck_alias(websocket: WebSocket):
    await _handle_ws_connection(websocket, "factcheck_ext")

@app.websocket("/ws/frontend")
async def websocket_frontend_alias(websocket: WebSocket):
    await _handle_ws_connection(websocket, "frontend")

# ----------------- REST APIS -----------------

@app.get("/api/status")
async def get_system_status():
    """Return live status of backend, extensions, and queue sizes."""
    return {
        "connected_extensions": list(hub.registered_extensions.values()),
        "scraper": {
            "connected": len(hub.scraper_clients) > 0,
            "count": len(hub.scraper_clients),
            "status": hub.scraper_status
        },
        "deepseek": {
            "connected": len(hub.deepseek_clients) > 0,
            "count": len(hub.deepseek_clients),
            "status": hub.deepseek_status
        },
        "severity": {
            "connected": len(hub.severity_clients) > 0,
            "count": len(hub.severity_clients),
            "status": hub.severity_status
        },
        "factcheck": {
            "connected": len(hub.factcheck_clients) > 0,
            "count": len(hub.factcheck_clients),
            "status": hub.factcheck_status
        },
        "pipeline": {
            "active": hub.is_pipeline_active,
            "paused": pipeline.is_paused,
            "queue_length": len(pipeline.pending_queue),
            "ai_delay_ms": pipeline.ai_delay_ms,
            "intercept_active": hub.is_custom_intercept_active
        },
        "uptime": time.time()
    }

@app.get("/api/raw_news")
async def fetch_raw_news(limit: int = 50, offset: int = 0):
    """Retrieve raw scraped news items."""
    items = await get_all_raw_news(limit=limit, offset=offset)
    return {"count": len(items), "items": items}

@app.get("/api/processed_news")
async def fetch_processed_news(limit: int = 50, offset: int = 0, grievance_only: bool = False):
    """Retrieve AI processed news and civic grievance intelligence."""
    items = await get_all_processed_news(limit=limit, offset=offset, filter_grievance_only=grievance_only)
    return {"count": len(items), "items": items}

@app.get("/api/news/{item_id}")
async def fetch_news_detail(item_id: str):
    """Retrieve full details of a specific news item for modal inspection."""
    item = await get_news_detail(item_id)
    if not item:
        raise HTTPException(status_code=404, detail="News item not found")
    return item

@app.post("/api/pipeline/toggle")
async def toggle_pipeline(active: Optional[bool] = None):
    """Toggle pipeline play / pause."""
    if active is None:
        hub.is_pipeline_active = not hub.is_pipeline_active
    else:
        hub.is_pipeline_active = active
        
    if hub.is_pipeline_active:
        pipeline.resume_pipeline()
    else:
        pipeline.pause_pipeline()
        
    await hub.broadcast_status()
    await hub.broadcast_log("PIPELINE", "INFO", f"Pipeline state toggled to: {'RUNNING' if hub.is_pipeline_active else 'PAUSED'}")
    return {"status": "success", "active": hub.is_pipeline_active}

@app.post("/api/pipeline/reset_busy")
async def reset_pipeline_busy():
    """Reset the DeepSeek busy flag if pipeline gets stuck."""
    pipeline._deepseek_busy = False
    pipeline.resume_pipeline()
    await hub.broadcast_log("PIPELINE", "WARN", "Pipeline busy-flag forcefully reset by user.")
    return {"status": "success"}

DISTRICT_KEYWORDS = [
    ("Patna", ["पटना", "patna", "बाढ़", "दानापुर", "मोकामा", "मसौढ़ी", "फुलवारी"]),
    ("Muzaffarpur", ["मुजफ्फरपुर", "muzaffarpur", "कांटी", "सकरा", "सरैया"]),
    ("Gaya", ["गया", "gaya", "बोधगया", "शेरघाटी", "टिकारी"]),
    ("Bhagalpur", ["भागलपुर", "bhagalpur", "कहलगांव", "नवगछिया", "सुल्तानगंज"]),
    ("Darbhanga", ["दरभंगा", "darbhanga", "बेनीपुर", "बिरौल"]),
    ("Purnia", ["पूर्णिया", "purnia", "बनमनखी", "धमदाहा"]),
    ("Begusarai", ["बेगूसराय", "begusarai", "बरौनी", "बखरी", "तेघड़ा"]),
    ("Samastipur", ["समस्तीपुर", "samastipur", "रोसड़ा", "दलसिंहसराय"]),
    ("Rohtas", ["रोहतास", "rohtas", "सासाराम", "डेहरी"]),
    ("Nalanda", ["नालंदा", "nalanda", "बिहार शरीफ", "राजगीर", "हिलसा"]),
    ("Vaishali", ["वैशाली", "vaishali", "हाजीपुर", "महुआ", "लालगंज"]),
    ("Saran", ["सारण", "saran", "छपरा", "मढ़ौरा", "सोनपुर"]),
    ("Siwan", ["सीवान", "siwan", "महाराजगंज"]),
    ("Gopalganj", ["गोपालगंज", "gopalganj", "हथुआ"]),
    ("Bhojpur", ["भोजपुर", "bhojpur", "आरा", "जगदीशपुर", "पीरो"]),
    ("Buxar", ["बक्सर", "buxar", "डुमरांव"]),
    ("Munger", ["मुंगेर", "munger", "जमालपुर", "तारापुर"]),
    ("Madhubani", ["मधुबनी", "madhubani", "झंझारपुर", "बेनीपट्टी"]),
    ("Saharsa", ["सहरसा", "saharsa", "सिमरी बख्तियारपुर"]),
    ("Motihari", ["मोतिहारी", "motihari", "पूर्वी चंपारण", "रक्सौल"]),
    ("Bettiah", ["बेतिया", "bettiah", "पश्चिम चंपारण", "बगहा"]),
    ("Sitamarhi", ["सीतामढ़ी", "sitamarhi", "पुपरी"]),
    ("Katihar", ["कटिहार", "katihar", "बारसोई"]),
    ("Jamui", ["जमुई", "jamui", "झाझा"]),
    ("Nawada", ["नवादा", "nawada", "रजौली"]),
    ("Aurangabad", ["औरंगाबाद", "aurangabad", "दाउदनगर"])
]

def detect_bihar_district(text: str) -> str:
    text_lower = text.lower()
    for dist, keywords in DISTRICT_KEYWORDS:
        for kw in keywords:
            if kw.lower() in text_lower:
                return dist
    return "Bihar"

async def fetch_live_bihar_portal_news() -> List[Dict[str, Any]]:
    """
    Directly scrapes fresh news items from live Bihar media portals:
    Live Hindustan, Dainik Bhaskar, and Prabhat Khabar.
    Extracts authentic Hindi headlines, real article URLs, and real thumbnail images.
    """
    try:
        from bs4 import BeautifulSoup
    except ImportError:
        BeautifulSoup = None

    items: List[Dict[str, Any]] = []
    seen_titles = set()
    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    }

    async with httpx.AsyncClient(timeout=8.0, headers=headers, follow_redirects=True) as client:
        # 1. Live Hindustan Bihar
        try:
            r = await client.get("https://www.livehindustan.com/bihar/")
            if r.status_code == 200 and BeautifulSoup:
                soup = BeautifulSoup(r.text, "html.parser")
                count = 0
                for h in soup.find_all(["h2", "h3"]):
                    title = h.get_text(strip=True)
                    if len(title) < 15 or "बिहार न्यूज" in title or "आप अभी" in title or title in seen_titles:
                        continue
                    seen_titles.add(title)
                    parent_a = h.find_parent("a") or h.find("a")
                    link = parent_a["href"] if parent_a and parent_a.has_attr("href") else ""
                    if link and not link.startswith("http"):
                        link = "https://www.livehindustan.com" + link

                    container = h.find_parent(["article", "div", "li"])
                    img_url = ""
                    if container:
                        img = container.find("img")
                        if img:
                            img_url = img.get("data-src") or img.get("src") or ""
                    if not img_url or "grey" in img_url or "default" in img_url or "logo" in img_url:
                        img_url = "https://images.unsplash.com/photo-1584824486509-112e4181ff6b?auto=format&fit=crop&w=800&q=80"

                    ts = int(time.time() * 1000) + len(items)
                    items.append({
                        "id": f"bihar_portal_{ts}_{os.urandom(3).hex()}",
                        "title": title,
                        "snippet": title,
                        "content": title,
                        "source_name": "Live Hindustan Bihar",
                        "source_url": link or "https://www.livehindustan.com/bihar/",
                        "media_urls": [img_url],
                        "district_hint": detect_bihar_district(title),
                        "scraped_at": ts / 1000,
                        "status": "pending"
                    })
                    count += 1
                    if count >= 4:
                        break
        except Exception as e:
            pass

        # 2. Dainik Bhaskar Bihar
        try:
            r = await client.get("https://www.bhaskar.com/local/bihar/")
            if r.status_code == 200 and BeautifulSoup:
                soup = BeautifulSoup(r.text, "html.parser")
                count = 0
                for h in soup.find_all(["h2", "h3"]):
                    title = h.get_text(strip=True)
                    if len(title) < 15 or "बिहार न्यूज़" in title or title in seen_titles:
                        continue
                    seen_titles.add(title)
                    parent_a = h.find_parent("a") or h.find("a")
                    link = parent_a["href"] if parent_a and parent_a.has_attr("href") else ""
                    if link and not link.startswith("http"):
                        link = "https://www.bhaskar.com" + link

                    container = h.find_parent(["div"])
                    img_url = ""
                    if container:
                        img = container.find("img")
                        if img:
                            img_url = img.get("src") or img.get("data-src") or ""
                    if not img_url or "default" in img_url:
                        img_url = "https://images.unsplash.com/photo-1590283603385-17ffb3a7f29f?auto=format&fit=crop&w=800&q=80"

                    ts = int(time.time() * 1000) + len(items)
                    items.append({
                        "id": f"bihar_portal_{ts}_{os.urandom(3).hex()}",
                        "title": title,
                        "snippet": title,
                        "content": title,
                        "source_name": "Dainik Bhaskar Bihar",
                        "source_url": link or "https://www.bhaskar.com/local/bihar/",
                        "media_urls": [img_url],
                        "district_hint": detect_bihar_district(title),
                        "scraped_at": ts / 1000,
                        "status": "pending"
                    })
                    count += 1
                    if count >= 4:
                        break
        except Exception as e:
            pass

        # 3. Prabhat Khabar Bihar
        try:
            r = await client.get("https://www.prabhatkhabar.com/state/bihar")
            if r.status_code == 200 and BeautifulSoup:
                soup = BeautifulSoup(r.text, "html.parser")
                count = 0
                for h in soup.find_all(["h2", "h3"]):
                    title = h.get_text(strip=True)
                    if len(title) < 15 or "आपके शहर" in title or title in seen_titles:
                        continue
                    seen_titles.add(title)
                    parent_a = h.find_parent("a") or h.find("a")
                    link = parent_a["href"] if parent_a and parent_a.has_attr("href") else ""
                    if link and not link.startswith("http"):
                        link = "https://www.prabhatkhabar.com" + link

                    container = h.find_parent(["article", "div"])
                    img_url = ""
                    if container:
                        img = container.find("img")
                        if img:
                            img_url = img.get("src") or img.get("data-src") or ""
                    if not img_url or "default" in img_url:
                        img_url = "https://images.unsplash.com/photo-1544620347-c4fd4a3d5957?auto=format&fit=crop&w=800&q=80"

                    ts = int(time.time() * 1000) + len(items)
                    items.append({
                        "id": f"bihar_portal_{ts}_{os.urandom(3).hex()}",
                        "title": title,
                        "snippet": title,
                        "content": title,
                        "source_name": "Prabhat Khabar Bihar",
                        "source_url": link or "https://www.prabhatkhabar.com/state/bihar",
                        "media_urls": [img_url],
                        "district_hint": detect_bihar_district(title),
                        "scraped_at": ts / 1000,
                        "status": "pending"
                    })
                    count += 1
                    if count >= 3:
                        break
        except Exception as e:
            pass

    return items

@app.post("/api/pipeline/trigger_sample")
async def trigger_sample_data():
    """Trigger realistic Bihar news and grievance ingestion into the pipeline from live regional portals."""
    items = await fetch_live_bihar_portal_news()
    inserted_items = []
    for it in items:
        raw_id, is_new = await insert_raw_news(it)
        if is_new:
            it["id"] = raw_id
            inserted_items.append(it)
            await pipeline.enqueue_raw_item(it)
            await hub.send_to_frontends({
                "type": "NEW_RAW_ITEM",
                "item": it
            })

    if inserted_items:
        await hub.broadcast_log("SCRAPER", "SUCCESS", f"Ingested {len(inserted_items)} fresh news items from Bihar portals.")
        return {"status": "success", "count": len(inserted_items), "message": f"Injected {len(inserted_items)} live Bihar news stories."}
    else:
        # If all live stories were already captured, ingest sample feed
        await pipeline.ingest_sample_bihar_feed()
        return {"status": "success", "count": 3, "message": "Injected sample Bihar civic feed."}

@app.get("/api/proxy/rss")
async def proxy_rss_feed(url: str = "", district_hint: str = "Bihar", source_name: str = "Bihar RSS"):
    """Server-side RSS feed proxy to avoid CORS issues for Chrome extension."""
    if not url:
        raise HTTPException(status_code=400, detail="url parameter required")
    try:
        async with httpx.AsyncClient(timeout=12.0, follow_redirects=True) as client:
            resp = await client.get(url, headers={
                "User-Agent": "Mozilla/5.0 (compatible; BiharCitizenEcho/1.0)",
                "Accept": "application/rss+xml, application/xml, text/xml, */*"
            })
            resp.raise_for_status()
            xml_text = resp.text
            
            # Parse RSS items server-side
            items = []
            item_matches = re.findall(r'<item[\s\S]*?</item>', xml_text, re.IGNORECASE)
            for raw_item in item_matches:
                title_m = re.search(r'<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?</title>', raw_item, re.I)
                link_m = re.search(r'<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?</link>', raw_item, re.I)
                desc_m = re.search(r'<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?</description>', raw_item, re.I)
                enc_m = re.search(r'<enclosure[^>]+url=["\']([^"\']+)["\']', raw_item, re.I)
                media_m = re.search(r'<media:content[^>]+url=["\']([^"\']+)["\']', raw_item, re.I)
                
                title = re.sub(r'<[^>]+>', '', title_m.group(1)).strip() if title_m else "Bihar Regional News"
                desc = desc_m.group(1) if desc_m else ""
                link = link_m.group(1).strip() if link_m else ""
                
                media_urls = []
                if enc_m: media_urls.append(enc_m.group(1))
                if media_m: media_urls.append(media_m.group(1))
                img_m = re.search(r'<img[^>]+src=["\']([^"\']+)["\']', desc, re.I)
                if img_m: media_urls.append(img_m.group(1))
                
                clean_snippet = re.sub(r'<[^>]+>', ' ', desc).replace('&nbsp;', ' ')
                clean_snippet = re.sub(r'\s+', ' ', clean_snippet).strip()
                
                if not media_urls:
                    media_urls = ["https://images.unsplash.com/photo-1584824486509-112e4181ff6b?auto=format&fit=crop&w=800&q=80"]
                
                ts = int(time.time() * 1000)
                items.append({
                    "id": f"bihar_rss_{ts}_{os.urandom(3).hex()}",
                    "title": title,
                    "snippet": clean_snippet[:350],
                    "content": clean_snippet,
                    "source_name": source_name,
                    "source_url": link,
                    "media_urls": media_urls[:3],
                    "district_hint": detect_bihar_district(title),
                    "scraped_at": ts / 1000
                })
                
            return {"status": "success", "count": len(items), "items": items}
    except httpx.HTTPStatusError as e:
        return {"status": "error", "message": f"HTTP {e.response.status_code}", "items": []}
    except Exception as e:
        return {"status": "error", "message": str(e), "items": []}

@app.post("/api/scraper/scrape_tab")
async def trigger_active_tab_scrape():
    """
    Trigger live Bihar news scraping from active portals AND the connected Chrome scraper extension.
    Inserts newly fetched stories, enqueues them into the pipeline, and broadcasts NEW_RAW_ITEM.
    """
    await hub.broadcast_log("SCRAPER", "INFO", "Triggering Bihar news scraping from portals & active Chrome tabs...")
    
    # 1. Forward trigger to Chrome extension if connected
    sent = await hub.send_to_scraper_ext({"type": "TRIGGER_SCRAPE_TAB"})

    # 2. Ingest live portal articles server-side so button ALWAYS delivers immediate fresh cards
    items = await fetch_live_bihar_portal_news()
    inserted_items = []
    for it in items:
        raw_id, is_new = await insert_raw_news(it)
        if is_new:
            it["id"] = raw_id
            inserted_items.append(it)
            await pipeline.enqueue_raw_item(it)
            await hub.send_to_frontends({
                "type": "NEW_RAW_ITEM",
                "item": it
            })

    if inserted_items:
        await hub.broadcast_log("SCRAPER", "SUCCESS", f"Ingested {len(inserted_items)} new live stories from Bihar news portals.")
    else:
        await hub.broadcast_log("SCRAPER", "INFO", "All current portal stories are already in queue / database.")

    return {
        "status": "success",
        "inserted": len(inserted_items),
        "total_fetched": len(items),
        "items": inserted_items,
        "extension_notified": sent
    }

@app.post("/api/scraper/start_crawler")
async def api_start_crawler():
    """Instruct the scraper extension to launch or focus the automated news crawler tab in Chrome."""
    sent = await hub.send_to_scraper_ext({"type": "START_CRAWLER"})
    await hub.broadcast_log("SCRAPER", "SUCCESS", "Launched automated Bihar news crawler in Chrome.")
    return {"status": "started" if sent else "standby", "extension_connected": sent}

@app.post("/api/scraper/pause_crawler")
async def api_pause_crawler():
    """Pause automated tab crawling."""
    sent = await hub.send_to_scraper_ext({"type": "STOP_CRAWLER"})
    await hub.broadcast_log("SCRAPER", "INFO", "Paused automated Bihar news crawler.")
    return {"status": "paused" if sent else "standby"}




@app.post("/api/ai/inject_query")
async def api_inject_custom_query(payload: Dict[str, Any]):
    """Pause automated queue, send custom prompt to DeepSeek, wait and return answer."""
    prompt = payload.get("text", "")
    if not prompt:
        raise HTTPException(status_code=400, detail="Text field cannot be empty")
    
    response = await hub.inject_custom_user_message(prompt)
    if response is None:
        return {"status": "error", "message": "DeepSeek automator did not respond or is disconnected."}
    return {"status": "success", "response": response}

@app.get("/api/logs")
async def fetch_system_logs(limit: int = 100, stream: Optional[str] = None):
    """Retrieve recent logs for terminal dock."""
    logs = await get_recent_logs(limit=limit, stream=stream)
    return {"count": len(logs), "logs": logs}

@app.get("/api/analytics/district_hotspots")
async def fetch_district_hotspots():
    """Retrieve aggregated grievance hotspot density across Bihar districts."""
    hotspots = await get_district_hotspot_summary()
    return {"status": "success", "total_districts": len(hotspots), "hotspots": hotspots}

@app.get("/api/health")
async def health_check():
    """Liveness probe for orchestrator."""
    return {"status": "ok", "timestamp": time.time(), "version": "1.1.0"}

@app.get("/api/metrics")
async def system_metrics():
    """System observability telemetry metrics."""
    raw_news = await get_all_raw_news(limit=1000)
    proc_news = await get_all_processed_news(limit=1000)
    grievances = [p for p in proc_news if p.get("is_grievance")]
    
    return {
        "status": "online",
        "version": "1.1.0",
        "uptime_seconds": round(time.time() - START_TIME, 2),
        "telemetry": {
            "raw_ingested_count": len(raw_news),
            "processed_count": len(proc_news),
            "grievance_count": len(grievances),
            "grievance_ratio": round(len(grievances) / max(1, len(proc_news)), 3)
        },
        "connected_extensions": {
            "scraper_workers": len(hub.scraper_clients),
            "deepseek_automators": len(hub.deepseek_clients),
            "severity_analyzers": len(hub.severity_clients),
            "ui_clients": len(hub.ui_clients)
        },
        "pipeline_state": {
            "is_active": hub.is_pipeline_active,
            "deepseek_status": hub.deepseek_status,
            "scraper_status": hub.scraper_status
        }
    }

@app.get("/api/nodes")
async def fetch_pipeline_nodes():
    """Retrieve pipeline node configurations."""
    nodes = await get_all_nodes()
    return {"nodes": nodes}

@app.post("/api/nodes/{node_id}")
async def update_node_configuration(node_id: str, payload: Dict[str, Any]):
    """Update node settings and position."""
    node_type = payload.get("node_type", "custom")
    title = payload.get("title", f"Node {node_id}")
    config = payload.get("config", {})
    pos_x = float(payload.get("pos_x", 60))
    pos_y = float(payload.get("pos_y", 40))
    await save_node_config(node_id, node_type, title, config, pos_x, pos_y)
    return {"status": "success", "node_id": node_id}

@app.delete("/api/nodes/{node_id}")
async def remove_pipeline_node(node_id: str):
    """Delete a node from canvas and disconnect all its edges."""
    from backend.database import delete_pipeline_node
    await delete_pipeline_node(node_id)
    await hub.broadcast_log("PIPELINE", "INFO", f"Removed node '{node_id}' and deleted all attached edges.")
    return {"status": "success", "node_id": node_id}

@app.get("/api/edges")
async def fetch_pipeline_edges():
    """Retrieve all visual and logical connection edges."""
    from backend.database import get_all_edges
    edges = await get_all_edges()
    return {"edges": edges}

@app.post("/api/edges")
async def create_or_update_edge(payload: Dict[str, Any]):
    """Create or connect an edge from any node to any node."""
    from backend.database import save_pipeline_edge
    edge_id = payload.get("edge_id")
    source_node = payload.get("source_node")
    source_port = payload.get("source_port", "out")
    target_node = payload.get("target_node")
    target_port = payload.get("target_port", "in")
    config = payload.get("config", {})

    if not source_node or not target_node:
        raise HTTPException(status_code=400, detail="source_node and target_node are required")

    saved_id = await save_pipeline_edge(edge_id, source_node, source_port, target_node, target_port, config)
    await hub.broadcast_log("PIPELINE", "INFO", f"Connected node '{source_node}' -> '{target_node}'")
    return {"status": "success", "edge_id": saved_id}

@app.delete("/api/edges/{edge_id}")
async def remove_edge(edge_id: str):
    """Disconnect and delete an edge between nodes."""
    from backend.database import delete_pipeline_edge
    await delete_pipeline_edge(edge_id)
    await hub.broadcast_log("PIPELINE", "INFO", f"Removed connection edge: {edge_id}")
    return {"status": "success", "edge_id": edge_id}

@app.post("/api/pipeline/rule_filter")
async def evaluate_rule_filter(payload: Dict[str, Any]):
    """
    Deterministic rule-based decision & filter node execution.
    Can filter political news, match keywords, score hazards, and route without LLM overhead.
    """
    item = payload.get("item", {})
    rules = payload.get("rules", {})
    
    text = (item.get("title", "") + " " + item.get("snippet", "") + " " + item.get("content", "")).lower()
    
    # 1. Political Keyword Filter
    political_keywords = rules.get("political_keywords", ["चुनाव", "रैली", "गठबंधन", "सीट", "वोट", "भाषण", "पार्टी प्रवक्ता", "election", "rally", "vote"])
    is_political = any(kw.lower() in text for kw in political_keywords)
    
    # 2. Urgent Hazard Filter
    hazard_keywords = rules.get("hazard_keywords", ["बाढ़", "पुल गिरा", "आग", "मौत", "हादसा", "जलमग्न", "flood", "collapse", "fatal", "fire", "emergency"])
    is_hazard = any(hk.lower() in text for hk in hazard_keywords)
    
    # Add exotic attributes
    attributes = item.get("attributes", {})
    attributes["rule_filtered"] = True
    attributes["hazard_detected"] = is_hazard
    if is_hazard:
        attributes["hazard_category"] = "Urgent Public Safety / Hazard"
        
    result_item = {
        **item,
        "is_political": is_political,
        "urgency_level": 5 if is_hazard else item.get("urgency_level", 2),
        "attributes": attributes
    }
    return {"status": "success", "item": result_item}

@app.get("/api/db/export")
async def export_database(target: str = "processed", format: str = "json"):
    """Export raw or processed news database as JSON or CSV."""
    if target == "raw":
        items = await get_all_raw_news(limit=500)
    else:
        items = await get_all_processed_news(limit=500)

    if format.lower() == "csv":
        if not items:
            return StreamingResponse(io.StringIO("no data"), media_type="text/csv")
        output = io.StringIO()
        fieldnames = list(items[0].keys())
        writer = csv.DictWriter(output, fieldnames=fieldnames)
        writer.writeheader()
        for row in items:
            # Flatten lists/dicts for CSV
            flat_row = {}
            for k, v in row.items():
                if isinstance(v, (list, dict)):
                    flat_row[k] = json.dumps(v, ensure_ascii=False)
                else:
                    flat_row[k] = v
            writer.writerow(flat_row)
        output.seek(0)
        return StreamingResponse(
            output,
            media_type="text/csv",
            headers={"Content-Disposition": f"attachment; filename=bihar_{target}_db_{int(time.time())}.csv"}
        )
    else:
        return JSONResponse(
            content={"target": target, "count": len(items), "data": items},
            headers={"Content-Disposition": f"attachment; filename=bihar_{target}_db_{int(time.time())}.json"}
        )

@app.post("/api/db/import")
async def import_database(file: UploadFile = File(...)):
    """Import raw or processed database from JSON file."""
    try:
        content = await file.read()
        payload = json.loads(content.decode("utf-8"))
        items = payload.get("data", []) if isinstance(payload, dict) else payload
        target = payload.get("target", "raw") if isinstance(payload, dict) else "raw"
        
        imported_count = 0
        for item in items:
            if target == "processed" or "urgency_level" in item:
                await insert_processed_news(item)
            else:
                await insert_raw_news(item)
            imported_count += 1
            
        await hub.broadcast_log("SYSTEM", "SUCCESS", f"Imported {imported_count} records into {target} DB.")
        return {"status": "success", "imported": imported_count}
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Import failed: {str(e)}")

@app.post("/api/db/reset")
async def reset_databases():
    """Reset and re-create database tables."""
    await reset_all_databases()
    pipeline.pending_queue.clear()
    pipeline._raw_cache.clear()
    await hub.broadcast_log("SYSTEM", "WARN", "All SQLite databases and queues reset.")
    return {"status": "success", "message": "Databases wiped and re-initialized."}

# Mount static frontend files
static_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
os.makedirs(static_dir, exist_ok=True)
app.mount("/static", StaticFiles(directory=static_dir), name="static")

@app.get("/", response_class=HTMLResponse)
async def serve_dashboard():
    """Serve main frontend canvas dashboard."""
    index_path = os.path.join(static_dir, "index.html")
    if os.path.exists(index_path):
        with open(index_path, "r", encoding="utf-8") as f:
            return HTMLResponse(content=f.read())
    return HTMLResponse("<h2>Bihar Citizen Echo Dashboard is compiling...</h2>")
