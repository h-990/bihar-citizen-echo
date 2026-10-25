"""
WebSocket Connection Hub for orchestrating Chrome Extensions and Frontend Dashboard.
Handles real-time communication, status tracking, logging, and message dispatch.
"""
import asyncio
import json
import time
from typing import Dict, Set, Any, Optional
from fastapi import WebSocket, WebSocketDisconnect

from backend.database import log_event, insert_raw_news, insert_processed_news
from backend.prompt_engine import clean_and_parse_deepseek_response

class ConnectionHub:
    def __init__(self):
        # Connected clients categorized by type
        self.frontend_clients: Set[WebSocket] = set()
        self.scraper_clients: Set[WebSocket] = set()
        self.deepseek_clients: Set[WebSocket] = set()
        self.severity_clients: Set[WebSocket] = set()
        self.factcheck_clients: Set[WebSocket] = set()
        
        # Dynamic Extension Registry (Discovered only when loaded/connected in Chrome)
        self.registered_extensions: Dict[str, Dict[str, Any]] = {}
        
        # State tracking
        self.deepseek_status: str = "disconnected" # "idle", "busy", "disconnected"
        self.scraper_status: str = "disconnected"  # "idle", "active", "disconnected"
        self.severity_status: str = "disconnected" # "idle", "busy", "disconnected"
        self.factcheck_status: str = "disconnected"# "idle", "busy", "disconnected"
        self.is_pipeline_active: bool = True
        self.is_custom_intercept_active: bool = False
        
        # In-flight custom user query future
        self._pending_custom_future: Optional[asyncio.Future] = None
        
        # Reference to pipeline orchestrator
        self.pipeline_orchestrator = None

    def set_pipeline(self, pipeline):
        self.pipeline_orchestrator = pipeline

    async def register(self, websocket: WebSocket, client_type: str):
        """Register a new websocket connection."""
        await websocket.accept()
        
        if client_type == "scraper_ext":
            self.scraper_clients.add(websocket)
            self.scraper_status = "idle"
            self.registered_extensions["scraper_ext"] = {
                "client_type": "scraper_ext",
                "name": "Bihar News Scraper",
                "icon": "🕷️",
                "node_id": "nodeScraper",
                "node_type": "scraper",
                "status": "idle"
            }
            await self.broadcast_log("SCRAPER", "INFO", "Bihar News Scraper Extension loaded & connected.")
        elif client_type == "deepseek_ext":
            self.deepseek_clients.add(websocket)
            self.deepseek_status = "idle"
            self.registered_extensions["deepseek_ext"] = {
                "client_type": "deepseek_ext",
                "name": "DeepSeek AI Automator",
                "icon": "🧠",
                "node_id": "nodeDeepseek",
                "node_type": "ai_automator",
                "status": "idle"
            }
            await self.broadcast_log("DEEPSEEK", "INFO", "DeepSeek AI Web Automator loaded & connected.")
        elif client_type == "severity_ext":
            self.severity_clients.add(websocket)
            self.severity_status = "idle"
            self.registered_extensions["severity_ext"] = {
                "client_type": "severity_ext",
                "name": "Civic Severity Scorer",
                "icon": "🚨",
                "node_id": "nodeSeverity",
                "node_type": "severity_scorer",
                "status": "idle"
            }
            await self.broadcast_log("SEVERITY", "INFO", "Civic Severity Scorer Extension loaded & connected.")
        elif client_type == "factcheck_ext":
            self.factcheck_clients.add(websocket)
            self.factcheck_status = "idle"
            self.registered_extensions["factcheck_ext"] = {
                "client_type": "factcheck_ext",
                "name": "Regional Fact-Checker",
                "icon": "🔍",
                "node_id": "nodeFactcheck",
                "node_type": "fact_checker",
                "status": "idle"
            }
            await self.broadcast_log("FACTCHECK", "INFO", "Regional Fact-Checker Extension loaded & connected.")
        else: # frontend
            self.frontend_clients.add(websocket)
            await self.broadcast_log("SYSTEM", "INFO", "Dashboard canvas client connected.")
            
        await self.broadcast_status()

    async def unregister(self, websocket: WebSocket, client_type: str):
        """Unregister a disconnected websocket."""
        if client_type == "scraper_ext":
            self.scraper_clients.discard(websocket)
            if not self.scraper_clients:
                self.scraper_status = "disconnected"
                self.registered_extensions.pop("scraper_ext", None)
                await self.broadcast_log("SCRAPER", "WARN", "Scraper extension disconnected.")
        elif client_type == "deepseek_ext":
            self.deepseek_clients.discard(websocket)
            if not self.deepseek_clients:
                self.deepseek_status = "disconnected"
                self.registered_extensions.pop("deepseek_ext", None)
                if self.pipeline_orchestrator:
                    self.pipeline_orchestrator.on_deepseek_finished()
                await self.broadcast_log("DEEPSEEK", "WARN", "DeepSeek automator disconnected.")
        elif client_type == "severity_ext":
            self.severity_clients.discard(websocket)
            if not self.severity_clients:
                self.severity_status = "disconnected"
                self.registered_extensions.pop("severity_ext", None)
                await self.broadcast_log("SEVERITY", "WARN", "Civic severity scorer disconnected.")
        elif client_type == "factcheck_ext":
            self.factcheck_clients.discard(websocket)
            if not self.factcheck_clients:
                self.factcheck_status = "disconnected"
                self.registered_extensions.pop("factcheck_ext", None)
                await self.broadcast_log("FACTCHECK", "WARN", "Regional fact checker disconnected.")
        else:
            self.frontend_clients.discard(websocket)
            
        await self.broadcast_status()

    async def broadcast_status(self):
        """Send status update to all connected frontends with dynamic extensions."""
        msg = {
            "type": "STATUS_UPDATE",
            "connected_extensions": list(self.registered_extensions.values()),
            "scraper": {
                "connected": len(self.scraper_clients) > 0,
                "count": len(self.scraper_clients),
                "status": self.scraper_status
            },
            "deepseek": {
                "connected": len(self.deepseek_clients) > 0,
                "count": len(self.deepseek_clients),
                "status": self.deepseek_status
            },
            "severity": {
                "connected": len(self.severity_clients) > 0,
                "count": len(self.severity_clients),
                "status": self.severity_status
            },
            "factcheck": {
                "connected": len(self.factcheck_clients) > 0,
                "count": len(self.factcheck_clients),
                "status": self.factcheck_status
            },
            "pipeline": {
                "active": self.is_pipeline_active,
                "intercept_active": self.is_custom_intercept_active
            },
            "timestamp": time.time()
        }
        await self.send_to_frontends(msg)

    async def broadcast_log(self, stream: str, level: str, message: str, details: Any = None):
        """Log event locally in SQLite and push live to frontend terminal."""
        await log_event(stream, level, message, details)
        payload = {
            "type": "LOG_ENTRY",
            "log": {
                "timestamp": time.time(),
                "stream": stream.upper(),
                "level": level.upper(),
                "message": message,
                "details": details
            }
        }
        await self.send_to_frontends(payload)

    async def send_to_frontends(self, payload: Dict[str, Any]):
        """Send JSON payload to all connected frontend clients."""
        disconnected = set()
        for ws in self.frontend_clients:
            try:
                await ws.send_text(json.dumps(payload))
            except Exception:
                disconnected.add(ws)
        for ws in disconnected:
            self.frontend_clients.discard(ws)

    async def send_to_deepseek_ext(self, payload: Dict[str, Any]) -> bool:
        """Send message to connected DeepSeek extension."""
        if not self.deepseek_clients:
            return False
        sent = False
        for ws in list(self.deepseek_clients):
            try:
                await ws.send_text(json.dumps(payload))
                sent = True
            except Exception:
                self.deepseek_clients.discard(ws)
        return sent

    async def send_to_scraper_ext(self, payload: Dict[str, Any]) -> bool:
        """Send command to connected Scraper extension."""
        if not self.scraper_clients:
            return False
        sent = False
        for ws in list(self.scraper_clients):
            try:
                await ws.send_text(json.dumps(payload))
                sent = True
            except Exception:
                self.scraper_clients.discard(ws)
        return sent

    async def send_to_severity_ext(self, payload: Dict[str, Any]) -> bool:
        """Send task to connected Civic Severity Scorer extension."""
        if not self.severity_clients:
            return False
        sent = False
        for ws in list(self.severity_clients):
            try:
                await ws.send_text(json.dumps(payload))
                sent = True
            except Exception:
                self.severity_clients.discard(ws)
        return sent

    async def send_to_factcheck_ext(self, payload: Dict[str, Any]) -> bool:
        """Send task to connected Regional Fact-Checker extension."""
        if not self.factcheck_clients:
            return False
        sent = False
        for ws in list(self.factcheck_clients):
            try:
                await ws.send_text(json.dumps(payload))
                sent = True
            except Exception:
                self.factcheck_clients.discard(ws)
        return sent

    async def handle_message(self, websocket: WebSocket, client_type: str, data_str: str):
        """Process incoming WebSocket messages from any client."""
        try:
            msg = json.loads(data_str)
        except Exception:
            await self.broadcast_log("SYSTEM", "ERROR", f"Malformed JSON from {client_type}: {data_str[:100]}")
            return

        msg_type = msg.get("type")

        # ----------------- 1. SCRAPER EXTENSION MESSAGES -----------------
        if client_type == "scraper_ext":
            if msg_type == "SCRAPER_RAW_ITEMS":
                items = msg.get("items", [])
                inserted_ids = []
                for item in items:
                    raw_id, is_new = await insert_raw_news(item)
                    if not is_new:
                        continue
                    item["id"] = raw_id
                    inserted_ids.append(raw_id)
                    # Notify pipeline
                    if self.pipeline_orchestrator:
                        await self.pipeline_orchestrator.enqueue_raw_item(item)
                    
                    # Notify frontend card
                    await self.send_to_frontends({
                        "type": "NEW_RAW_ITEM",
                        "item": item
                    })
                if inserted_ids:
                    await self.broadcast_log("SCRAPER", "SUCCESS", f"Received and enqueued {len(inserted_ids)} new news items from extension.")

            elif msg_type == "SCRAPER_STATUS":
                status = msg.get("status", "idle")
                self.scraper_status = status
                await self.broadcast_status()

            elif msg_type == "SCRAPER_LOG":
                await self.broadcast_log("SCRAPER", msg.get("level", "INFO"), msg.get("message", ""))

        # ----------------- 2. DEEPSEEK EXTENSION MESSAGES -----------------
        elif client_type == "deepseek_ext":
            if msg_type == "DEEPSEEK_READY":
                self.deepseek_status = "idle"
                if self.pipeline_orchestrator:
                    self.pipeline_orchestrator.on_deepseek_finished()
                await self.broadcast_log("DEEPSEEK", "INFO", "DeepSeek tab confirmed ready for prompts.")
                await self.broadcast_status()

            elif msg_type == "DEEPSEEK_BUSY":
                self.deepseek_status = "busy"
                await self.broadcast_log("DEEPSEEK", "INFO", "DeepSeek is currently generating response...")
                await self.broadcast_status()

            elif msg_type == "DEEPSEEK_PROCESSED_RESULT":
                self.deepseek_status = "idle"
                raw_id = msg.get("raw_id")
                raw_ai_response = msg.get("raw_ai_response", "")
                parsed = msg.get("result") or clean_and_parse_deepseek_response(raw_ai_response)
                
                if parsed:
                    parsed["id"] = raw_id
                    parsed["raw_id"] = raw_id
                    parsed["processed_at"] = time.time()
                    parsed["raw_ai_response"] = raw_ai_response
                    
                    # Inherit media and source from raw news if available
                    if self.pipeline_orchestrator:
                        raw_meta = self.pipeline_orchestrator.get_cached_raw_meta(raw_id)
                        if raw_meta:
                            parsed["media_urls"] = raw_meta.get("media_urls", [])
                            parsed["source_name"] = raw_meta.get("source_name", "")
                            parsed["source_url"] = raw_meta.get("source_url", "")
                            if not parsed.get("title") or parsed.get("title") == "Bihar News Extraction":
                                parsed["title"] = raw_meta.get("title", "")
                    
                    await self.broadcast_log(
                        "DEEPSEEK", "SUCCESS", 
                        f"Analyzed '{parsed.get('title', '')[:35]}' -> Urgency: {parsed.get('urgency_level')}/5, Grievance: {parsed.get('is_grievance')}"
                    )
                    
                    # Route along canvas graph edges
                    if self.pipeline_orchestrator:
                        self.pipeline_orchestrator.on_deepseek_finished()
                        await self.pipeline_orchestrator.route_from_node("nodeDeepseek", parsed)
                else:
                    await self.broadcast_log("DEEPSEEK", "WARN", f"Could not parse valid JSON for raw_id {raw_id}")
                    if self.pipeline_orchestrator:
                        self.pipeline_orchestrator.on_deepseek_finished()

                await self.broadcast_status()

            elif msg_type == "DEEPSEEK_ERROR":
                self.deepseek_status = "idle"
                err = msg.get("error", "DeepSeek tab execution failed.")
                raw_id = msg.get("raw_id", "")
                await self.broadcast_log("DEEPSEEK", "ERROR", f"DeepSeek error for item {raw_id[:16]}: {err}")
                if self._pending_custom_future and not self._pending_custom_future.done():
                    self._pending_custom_future.set_exception(Exception(err))
                self.is_custom_intercept_active = False
                if self.pipeline_orchestrator:
                    self.pipeline_orchestrator.on_deepseek_finished()
                await self.broadcast_status()

            elif msg_type == "DEEPSEEK_CUSTOM_RESPONSE":
                # Response for user priority custom message
                self.deepseek_status = "idle"
                response_text = msg.get("text", "")
                await self.broadcast_log("DEEPSEEK", "SUCCESS", "Received DeepSeek answer for custom user prompt.")
                
                # Resolve pending future if waiting
                if self._pending_custom_future and not self._pending_custom_future.done():
                    self._pending_custom_future.set_result(response_text)
                    
                # Broadcast response to frontend terminal
                await self.send_to_frontends({
                    "type": "CUSTOM_QUERY_ANSWER",
                    "text": response_text,
                    "timestamp": time.time()
                })
                
                # Mark intercept finished & resume pipeline
                self.is_custom_intercept_active = False
                if self.pipeline_orchestrator:
                    self.pipeline_orchestrator.resume_pipeline()
                await self.broadcast_status()

            elif msg_type == "DEEPSEEK_LOG":
                await self.broadcast_log("DEEPSEEK", msg.get("level", "INFO"), msg.get("message", ""))

        # ----------------- 3. SEVERITY SCORER MESSAGES -----------------
        elif client_type == "severity_ext":
            if msg_type == "SEVERITY_READY":
                self.severity_status = "idle"
                await self.broadcast_log("SEVERITY", "INFO", "Civic severity analyzer confirmed ready.")
                await self.broadcast_status()
            elif msg_type == "SEVERITY_SCORED_RESULT":
                raw_id = msg.get("raw_id")
                severity_data = msg.get("severity_data", {})
                await self.broadcast_log(
                    "SEVERITY", "SUCCESS",
                    f"Hazard Score: {severity_data.get('hazard_score')}/100 [{severity_data.get('response_priority')}] - {severity_data.get('hazard_category')}"
                )
                if self.pipeline_orchestrator:
                    await self.pipeline_orchestrator.on_severity_finished(raw_id, severity_data)
                await self.broadcast_status()
            elif msg_type == "SEVERITY_LOG":
                await self.broadcast_log("SEVERITY", msg.get("level", "INFO"), msg.get("message", ""))

        # ----------------- 4. REGIONAL FACT-CHECKER MESSAGES -----------------
        elif client_type == "factcheck_ext":
            if msg_type == "FACTCHECK_READY":
                self.factcheck_status = "idle"
                await self.broadcast_log("FACTCHECK", "INFO", "Regional fact-checker confirmed ready.")
                await self.broadcast_status()
            elif msg_type == "FACTCHECK_RESULT":
                raw_id = msg.get("raw_id")
                factcheck_data = msg.get("factcheck_data", {})
                await self.broadcast_log(
                    "FACTCHECK", "SUCCESS",
                    f"Verdict: [{factcheck_data.get('authenticity_verdict')}] Credibility: {factcheck_data.get('credibility_score')}/100"
                )
                if self.pipeline_orchestrator:
                    await self.pipeline_orchestrator.on_factcheck_finished(raw_id, factcheck_data)
                await self.broadcast_status()
            elif msg_type == "FACTCHECK_LOG":
                await self.broadcast_log("FACTCHECK", msg.get("level", "INFO"), msg.get("message", ""))

        # ----------------- 5. FRONTEND DASHBOARD MESSAGES -----------------
        else:
            if msg_type == "CUSTOM_USER_QUERY":
                text = msg.get("text", "")
                await self.inject_custom_user_message(text)
                
            elif msg_type == "SET_SCRAPE_SPEED":
                speed_ms = int(msg.get("speed_ms", 2000))
                await self.send_to_scraper_ext({"type": "CONFIG_UPDATE", "scrape_interval_ms": speed_ms})
                await self.broadcast_log("SYSTEM", "INFO", f"Updated scraper interval to {speed_ms}ms")

            elif msg_type == "SET_DEEPSEEK_SPEED":
                speed_ms = int(msg.get("speed_ms", 4000))
                if self.pipeline_orchestrator:
                    self.pipeline_orchestrator.set_ai_delay(speed_ms)
                await self.broadcast_log("SYSTEM", "INFO", f"Updated DeepSeek pipeline delay to {speed_ms}ms")

            elif msg_type == "TOGGLE_PIPELINE":
                active = bool(msg.get("active", True))
                self.is_pipeline_active = active
                if self.pipeline_orchestrator:
                    if active:
                        self.pipeline_orchestrator.resume_pipeline()
                    else:
                        self.pipeline_orchestrator.pause_pipeline()
                await self.broadcast_log("PIPELINE", "INFO", f"Pipeline state changed to: {'RUNNING' if active else 'PAUSED'}")
                await self.broadcast_status()

            elif msg_type == "TRIGGER_SAMPLE_FEED":
                # Trigger built-in Bihar news ingestion for immediate testing
                if self.pipeline_orchestrator:
                    await self.pipeline_orchestrator.ingest_sample_bihar_feed()

            elif msg_type == "START_CRAWLER":
                await self.send_to_scraper_ext({"type": "START_CRAWLER"})
                await self.broadcast_log("SCRAPER", "SUCCESS", "Command sent: Launched automated crawler in Chrome.")

            elif msg_type == "STOP_CRAWLER":
                await self.send_to_scraper_ext({"type": "STOP_CRAWLER"})
                await self.broadcast_log("SCRAPER", "INFO", "Command sent: Paused automated crawler.")

            elif msg_type == "TRIGGER_TAB_SCRAPE":
                # Request Scraper extension to scrape the active/open Chrome tab
                await self.broadcast_log("SCRAPER", "INFO", "Triggering active Chrome tab scraper...")
                sent = await self.send_to_scraper_ext({"type": "START_CRAWLER"})

                if not sent:
                    await self.broadcast_log("SCRAPER", "INFO", "Scraper extension standby; fetching live portal news directly...")
                try:
                    from backend.app import fetch_live_bihar_portal_news
                    items = await fetch_live_bihar_portal_news()
                    inserted_count = 0
                    for it in items:
                        raw_id, is_new = await insert_raw_news(it)
                        if is_new:
                            it["id"] = raw_id
                            inserted_count += 1
                            if self.pipeline_orchestrator:
                                await self.pipeline_orchestrator.enqueue_raw_item(it)
                            await self.send_to_frontends({
                                "type": "NEW_RAW_ITEM",
                                "item": it
                            })
                    if inserted_count > 0:
                        await self.broadcast_log("SCRAPER", "SUCCESS", f"Ingested {inserted_count} new stories from Bihar portals.")
                except Exception as e:
                    await self.broadcast_log("SCRAPER", "WARN", f"Live portal fetch: {e}")

            elif msg_type == "SET_WEBSEARCH_FACTCHECK":
                enabled = bool(msg.get("enabled", False))
                if self.pipeline_orchestrator:
                    self.pipeline_orchestrator.set_websearch_factcheck(enabled)
                await self.broadcast_log("DEEPSEEK", "INFO", f"DeepSeek WebSearch Fact-Checking set to: {'ENABLED' if enabled else 'DISABLED'}")

            elif msg_type == "SET_BYPASS_DEEPTHINK":
                enabled = bool(msg.get("enabled", True))
                if self.pipeline_orchestrator:
                    self.pipeline_orchestrator.set_bypass_deepthink(enabled)
                await self.broadcast_log("DEEPSEEK", "INFO", f"DeepSeek Fast Mode (Bypass DeepThink) set to: {'ENABLED' if enabled else 'DISABLED'}")

            elif msg_type == "SET_ACTIVE_FEEDS":
                sources = msg.get("sources", {})
                await self.send_to_scraper_ext({"type": "CONFIG_UPDATE", "selectedSources": sources})
                await self.broadcast_log("SCRAPER", "INFO", f"Updated active news feed sources: {list(sources.keys())}")


    async def inject_custom_user_message(self, user_prompt: str) -> Optional[str]:
        """
        Pauses automated queue, sends custom prompt to DeepSeek extension,
        waits for response, and then resumes normal queue processing.
        """
        if not self.deepseek_clients:
            await self.broadcast_log("DEEPSEEK", "ERROR", "Cannot send custom query: DeepSeek extension is not connected.")
            await self.send_to_frontends({
                "type": "CUSTOM_QUERY_ANSWER",
                "error": "DeepSeek extension is not connected. Open chat.deepseek.com with the extension active.",
                "timestamp": time.time()
            })
            return None

        # 1. Pause pipeline
        self.is_custom_intercept_active = True
        if self.pipeline_orchestrator:
            self.pipeline_orchestrator.pause_pipeline()
            
        await self.broadcast_log("SYSTEM", "WARN", "Pipeline PAUSED: Injecting high-priority user prompt into DeepSeek.")
        self.deepseek_status = "busy"
        await self.broadcast_status()

        # 2. Dispatch to DeepSeek extension
        loop = asyncio.get_running_loop()
        self._pending_custom_future = loop.create_future()

        await self.send_to_deepseek_ext({
            "type": "INJECT_USER_QUERY",
            "text": user_prompt
        })

        try:
            # Wait with a 45 second timeout
            response = await asyncio.wait_for(self._pending_custom_future, timeout=45.0)
            return response
        except asyncio.TimeoutError:
            await self.broadcast_log("DEEPSEEK", "ERROR", "Timeout waiting for DeepSeek custom prompt response.")
            self.is_custom_intercept_active = False
            if self.pipeline_orchestrator:
                self.pipeline_orchestrator.resume_pipeline()
            await self.broadcast_status()
            return None
        finally:
            self._pending_custom_future = None

hub = ConnectionHub()
