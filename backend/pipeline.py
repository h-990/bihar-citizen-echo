"""
Pipeline Orchestration Engine with Arbitrary Dynamic Graph Routing.
Enables connecting ANY node to ANY other node on the canvas in ANY combination
(e.g., Scraper -> Severity -> DeepSeek -> FactCheck -> Terminal, or any permutation).
Handles real-time wire traversal, throttling, and open-ended attribute enrichment.
"""
import asyncio
import json
import time
from typing import Dict, Any, List, Optional, Set
import httpx

from backend.database import (
    get_pending_raw_news, update_raw_news_status, insert_raw_news,
    save_node_config, get_all_nodes, get_all_edges, insert_processed_news,
    save_pipeline_edge
)
from backend.prompt_engine import build_deepseek_prompt

class PipelineOrchestrator:
    def __init__(self, hub):
        self.hub = hub
        self.hub.set_pipeline(self)
        
        # In-memory queues
        self.pending_queue: List[Dict[str, Any]] = []
        self._raw_cache: Dict[str, Dict[str, Any]] = {}
        
        # In-flight accumulated items progressing through the graph
        self._in_flight_items: Dict[str, Dict[str, Any]] = {}
        self._visited_nodes: Dict[str, Set[str]] = {}
        
        # Throttle & State
        self.is_paused: bool = False
        self.ai_delay_ms: int = 4000
        self.enable_websearch: bool = False
        self.bypass_deepthink: bool = True
        self._worker_task: Optional[asyncio.Task] = None
        self._crawl_scheduler_task: Optional[asyncio.Task] = None
        self.crawl_interval_seconds: int = 180
        self.crawl_jitter_seconds: int = 20
        self._deepseek_busy: bool = False
        self._deepseek_busy_since: float = 0.0
        self._last_dispatch_time: float = 0.0

    def set_websearch_factcheck(self, enabled: bool):
        self.enable_websearch = bool(enabled)

    def set_bypass_deepthink(self, enabled: bool):
        self.bypass_deepthink = bool(enabled)

    async def initialize(self):
        """Initialize default canvas nodes, edges, and background loop."""
        nodes = await get_all_nodes()
        if not nodes:
            # Register ONLY the 3 default canvas nodes
            await save_node_config("nodeScraper", "scraper", "Bihar Regional Web Scraper", {
                "speed_ms": 2500,
                "sources": ["Dainik Bhaskar", "Prabhat Khabar", "Live Hindustan", "Civic RSS"]
            }, pos_x=60, pos_y=40)

            await save_node_config("nodeDeepseek", "ai_automator", "DeepSeek AI Web Automator", {
                "speed_ms": 4000,
                "disable_deepthink": True
            }, pos_x=920, pos_y=40)

            await save_node_config("nodeTerminal", "terminal_dispatch", "Master Output & Processed DB", {
                "auto_archive": True
            }, pos_x=1720, pos_y=40)

        # Initialize default edges if none exist
        edges = await get_all_edges()
        if not edges:
            default_edges = [
                ("edge_scraper_to_deepseek", "nodeScraper", "out", "nodeDeepseek", "in"),
                ("edge_deepseek_to_terminal", "nodeDeepseek", "out", "nodeTerminal", "in")
            ]
            for eid, src, sport, tgt, tport in default_edges:
                await save_pipeline_edge(eid, src, sport, tgt, tport)

        # Load pending items from DB
        pending_db_items = await get_pending_raw_news(limit=50)
        for item in pending_db_items:
            self._raw_cache[item["id"]] = item
            if item not in self.pending_queue:
                self.pending_queue.append(item)

        # Start queue worker
        if self._worker_task is None or self._worker_task.done():
            self._worker_task = asyncio.create_task(self._process_queue_loop())

        # Start periodic background crawl scheduler
        if self._crawl_scheduler_task is None or self._crawl_scheduler_task.done():
            self._crawl_scheduler_task = asyncio.create_task(self._periodic_crawl_loop())

    async def _periodic_crawl_loop(self):
        """Periodically trigger automated regional crawl checks with randomized jitter."""
        import random
        while True:
            try:
                jitter = random.uniform(-self.crawl_jitter_seconds, self.crawl_jitter_seconds)
                sleep_duration = max(30.0, self.crawl_interval_seconds + jitter)
                await asyncio.sleep(sleep_duration)

                if not self.is_paused and self.hub and len(self.hub.scraper_clients) > 0:
                    await self.hub.send_to_scraper_ext({"type": "TRIGGER_SCRAPE_NOW"})
                    await self.hub.broadcast_log("SCHEDULER", "INFO", f"Periodic crawl sweep dispatched (Next in ~{int(sleep_duration)}s)")
            except asyncio.CancelledError:
                break
            except Exception:
                await asyncio.sleep(15.0)

    async def enqueue_raw_item(self, item: Dict[str, Any]):
        """Add newly scraped item into pipeline graph with deduplication."""
        raw_id = item.get("id") or item.get("raw_id")
        title = (item.get("title") or "").strip()
        # Prevent queue duplication
        if any(i.get("id") == raw_id or (title and (i.get("title") or "").strip() == title) for i in self.pending_queue):
            return
        self._raw_cache[raw_id] = item
        self.pending_queue.append(item)
        await self.hub.broadcast_log("PIPELINE", "INFO", f"Enqueued at nodeScraper: {title[:40]}")

    def get_cached_raw_meta(self, raw_id: str) -> Optional[Dict[str, Any]]:
        return self._raw_cache.get(raw_id)

    def pause_pipeline(self):
        self.is_paused = True

    def resume_pipeline(self):
        self.is_paused = False
        if self.hub and self.hub.deepseek_status == "idle":
            self._deepseek_busy = False
            self._deepseek_busy_since = 0.0

    def set_ai_delay(self, delay_ms: int):
        self.ai_delay_ms = max(500, delay_ms)

    def on_deepseek_finished(self):
        self._deepseek_busy = False
        self._deepseek_busy_since = 0.0

    # ================= ARBITRARY DYNAMIC GRAPH ROUTING =================
    async def route_from_node(self, current_node_id: str, item: Dict[str, Any]):
        """
        Dynamically finds all outgoing edges from current_node_id and dispatches
        the item (with enriched metadata) to all target nodes.
        If no outgoing edges exist, item is finalized into Processed DB.
        """
        raw_id = item.get("id") or item.get("raw_id")
        self._in_flight_items[raw_id] = item
        
        if raw_id not in self._visited_nodes:
            self._visited_nodes[raw_id] = set()
        self._visited_nodes[raw_id].add(current_node_id)

        edges = await get_all_edges()
        outgoing = [e for e in edges if e["source_node"] == current_node_id]

        if not outgoing:
            await self.finalize_item(item)
            return

        for edge in outgoing:
            target_node = edge["target_node"]
            if target_node in self._visited_nodes[raw_id]:
                # Prevent cycle loop
                continue
            await self.dispatch_to_node(target_node, item)

    async def dispatch_to_node(self, target_node_id: str, item: Dict[str, Any]):
        """Dispatch item to the respective target node/extension."""
        raw_id = item.get("id") or item.get("raw_id")

        # 1. DEEPSEEK AI AUTOMATOR NODE
        if "deepseek" in target_node_id.lower():
            if not self.hub.deepseek_clients:
                await self.hub.broadcast_log(
                    "PIPELINE", "WARN",
                    f"Waiting for DeepSeek extension/tab: holding '{item.get('title', '')[:30]}' in queue."
                )
                self.pending_queue.insert(0, item)
                await asyncio.sleep(2)
                return

            if self._deepseek_busy:
                # Self-healing timeout for busy flag (45 seconds)
                if self._deepseek_busy_since > 0 and (time.time() - self._deepseek_busy_since > 45.0):
                    self._deepseek_busy = False
                    self._deepseek_busy_since = 0.0
                    await self.hub.broadcast_log("PIPELINE", "WARN", "DeepSeek task timed out (45s). Auto-reset busy flag to unblock pipeline.")
                else:
                    self.pending_queue.insert(0, item)
                    await asyncio.sleep(1.5)
                    return

            self._deepseek_busy = True
            self._deepseek_busy_since = time.time()
            prompt = build_deepseek_prompt(item, enable_websearch=self.enable_websearch)
            payload = {
                "type": "PROCESS_NEWS_ITEM",
                "raw_id": raw_id,
                "title": item.get("title", ""),
                "prompt": prompt,
                "enable_websearch": self.enable_websearch,
                "bypass_deepthink": self.bypass_deepthink,
                "district_hint": item.get("district_hint", "Bihar")
            }

            await self.hub.broadcast_log("PIPELINE", "INFO", f"Dispatching to DeepSeek Node: {item.get('title', '')[:35]}")
            sent = await self.hub.send_to_deepseek_ext(payload)
            if not sent:
                self._deepseek_busy = False
                self.pending_queue.insert(0, item)

        # 2. CIVIC SEVERITY SCORER NODE
        elif "severity" in target_node_id.lower():
            if not self.hub.severity_clients:
                await self.hub.broadcast_log(
                    "PIPELINE", "WARN",
                    f"Civic Severity Ext not connected: passing '{item.get('title', '')[:30]}' to next node."
                )
                await self.route_from_node(target_node_id, item)
                return

            payload = {
                "type": "EVALUATE_SEVERITY",
                "raw_id": raw_id,
                "item": item
            }
            await self.hub.broadcast_log("PIPELINE", "INFO", f"Dispatching to Severity Scorer Node: {item.get('title', '')[:35]}")
            sent = await self.hub.send_to_severity_ext(payload)
            if not sent:
                await self.route_from_node(target_node_id, item)

        # 3. REGIONAL FACT-CHECKER NODE
        elif "factcheck" in target_node_id.lower():
            if not self.hub.factcheck_clients:
                await self.hub.broadcast_log(
                    "PIPELINE", "WARN",
                    f"Fact-Checker Ext not connected: passing '{item.get('title', '')[:30]}' to next node."
                )
                await self.route_from_node(target_node_id, item)
                return

            payload = {
                "type": "EVALUATE_FACTCHECK",
                "raw_id": raw_id,
                "item": item
            }
            await self.hub.broadcast_log("PIPELINE", "INFO", f"Dispatching to Fact-Checker Node: {item.get('title', '')[:35]}")
            sent = await self.hub.send_to_factcheck_ext(payload)
            if not sent:
                await self.route_from_node(target_node_id, item)

        # 4. RULE-BASED POLITICAL PURGE / FILTER NODE
        elif "rule" in target_node_id.lower():
            title = (item.get("title") or "").lower()
            snippet = (item.get("snippet") or "").lower()
            content = (item.get("content") or "").lower()
            full_text = f"{title} {snippet} {content}"

            political_keywords = ["चुनाव", "bjp", "rjd", "jdu", "congress", "प्रत्याशी", "रैली", "गठबंधन", "वोट", "विपक्ष"]
            is_pol = any(k in full_text for k in political_keywords)
            
            if "attributes" not in item:
                item["attributes"] = {}
            item["attributes"]["rule_filter_evaluated"] = True
            item["attributes"]["is_political_flag"] = is_pol

            if is_pol:
                await self.hub.broadcast_log("PIPELINE", "WARN", f"Rule Filter: Flagged political content in '{item.get('title', '')[:35]}'")
            else:
                await self.hub.broadcast_log("PIPELINE", "SUCCESS", f"Rule Filter: Pure civic issue confirmed '{item.get('title', '')[:35]}'")

            # Continue routing along rule node's outgoing edges
            await self.route_from_node(target_node_id, item)

        # 5. TERMINAL OUTPUT NODE / DEFAULT
        else:
            await self.finalize_item(item)

    # ================= NODE RESPONSE CALLBACKS =================
    async def on_severity_finished(self, raw_id: str, severity_data: Dict[str, Any]):
        """Called when Extension 3 (Severity Scorer) completes evaluation."""
        item = self._in_flight_items.get(raw_id) or self._raw_cache.get(raw_id) or {"id": raw_id}
        if "attributes" not in item:
            item["attributes"] = {}
        item["attributes"]["severity_data"] = severity_data
        
        # Boost urgency if severe hazard detected
        hazard_score = severity_data.get("hazard_score", 30)
        item["urgency_level"] = max(int(item.get("urgency_level") or 1), round(hazard_score / 20))
        item["grievance_type"] = item.get("grievance_type") or severity_data.get("hazard_category", "Public Grievance")
        item["is_grievance"] = True

        self._in_flight_items[raw_id] = item
        # Follow outgoing edges from nodeSeverity
        await self.route_from_node("nodeSeverity", item)

    async def on_factcheck_finished(self, raw_id: str, factcheck_data: Dict[str, Any]):
        """Called when Extension 4 (Fact-Checker) completes evaluation."""
        item = self._in_flight_items.get(raw_id) or self._raw_cache.get(raw_id) or {"id": raw_id}
        if "attributes" not in item:
            item["attributes"] = {}
        item["attributes"]["factcheck_data"] = factcheck_data
        
        self._in_flight_items[raw_id] = item
        # Follow outgoing edges from nodeFactcheck
        await self.route_from_node("nodeFactcheck", item)

    async def finalize_item(self, item: Dict[str, Any]):
        """Save fully enriched item into Processed DB and notify frontends."""
        raw_id = item.get("id") or item.get("raw_id")
        item["raw_id"] = raw_id
        
        # Merge raw news meta if missing
        raw_meta = self.get_cached_raw_meta(raw_id)
        if raw_meta:
            if not item.get("media_urls"):
                item["media_urls"] = raw_meta.get("media_urls", [])
            if not item.get("source_name"):
                item["source_name"] = raw_meta.get("source_name", "Bihar Local Source")
            if not item.get("source_url"):
                item["source_url"] = raw_meta.get("source_url", "")
            if not item.get("title") or item.get("title") == "Bihar News Extraction":
                item["title"] = raw_meta.get("title", "")
            if not item.get("actual_news"):
                item["actual_news"] = raw_meta.get("snippet", "")

        proc_id = await insert_processed_news(item)
        item["id"] = proc_id

        await self.hub.broadcast_log(
            "PIPELINE", "SUCCESS",
            f"FINALIZED: '{item.get('title', '')[:40]}' -> Processed DB (ID: {proc_id})"
        )

        await self.hub.send_to_frontends({
            "type": "NEW_PROCESSED_ITEM",
            "item": item
        })

    # ================= QUEUE WORKER =================
    async def _process_queue_loop(self):
        """Background loop starting raw items from nodeScraper along canvas edges."""
        while True:
            try:
                await asyncio.sleep(0.5)

                if self.is_paused or self.hub.is_custom_intercept_active:
                    continue

                if not self.pending_queue:
                    # Pick up any pending or unfinalized items from SQLite
                    pending_db_items = await get_pending_raw_news(limit=10)
                    for db_item in pending_db_items:
                        if db_item["id"] not in self._raw_cache:
                            self._raw_cache[db_item["id"]] = db_item
                        if not any(i.get("id") == db_item["id"] for i in self.pending_queue):
                            self.pending_queue.append(db_item)
                    if not self.pending_queue:
                        continue

                # Throttle check
                now = time.time()
                elapsed_ms = (now - self._last_dispatch_time) * 1000
                if elapsed_ms < self.ai_delay_ms:
                    continue

                # Pop next item to enter the pipeline
                item = self.pending_queue.pop(0)
                raw_id = item.get("id") or item.get("raw_id")
                await update_raw_news_status(raw_id, "processing")
                self._last_dispatch_time = time.time()

                # Start routing from nodeScraper along whichever wires the user connected!
                await self.route_from_node("nodeScraper", item)

            except asyncio.CancelledError:
                break
            except Exception as e:
                await self.hub.broadcast_log("PIPELINE", "ERROR", f"Graph routing loop error: {str(e)}")
                await asyncio.sleep(2)

    # ================= SAMPLE BIHAR INGESTION =================
    async def ingest_sample_bihar_feed(self):
        """Inject authentic Bihar civic news items for instant test."""
        sample_items = [
            {
                "title": "पटना के कंकड़बाग में 4 दिनों से जलजमाव, सीवर ओवरफ्लो से लोग घरों में कैद",
                "snippet": "कंकड़बाग ऑटो स्टैंड और मुख्य बाजार के पास पिछले चार दिनों से बारिश और सीवेज का पानी भरा हुआ है। संप हाउस की मोटरें जलने से निकासी ठप।",
                "content": "पटना के पॉश इलाके कंकड़बाग में पिछले 96 घंटों से गंदे पानी का जलजमाव बना हुआ है। संप हाउस की दो मोटरें जल गई हैं। बच्चे स्कूल नहीं जा पा रहे हैं और डेंगू का खतरा बढ़ गया है। नगर निगम के अधिकारियों को शिकायत दर्ज कराई गई है।",
                "source_name": "Dainik Bhaskar Bihar",
                "source_url": "https://www.bhaskar.com/local/bihar/patna/news/patna-kankarbagh-waterlogging-drainage-issue-132451.html",
                "media_urls": [
                    "https://images.unsplash.com/photo-1547683905-f686c993aae5?auto=format&fit=crop&w=800&q=80"
                ],
                "district_hint": "Patna"
            },
            {
                "title": "मुजफ्फरपुर सदर अस्पताल में दवाओं की किल्लत, डॉक्टर नदारद, मरीजों का हंगामा",
                "snippet": "सदर अस्पताल में एंटी-रेबीज इंजेक्शन और जीवनरक्षक दवाएं खत्म। ओपीडी में डॉक्टर समय पर नहीं पहुंचने से मरीजों के परिजनों ने हंगामा किया।",
                "content": "मुजफ्फरपुर के सदर अस्पताल की इमरजेंसी और ओपीडी में दवाओं की भारी किल्लत है। डॉक्टर ने बाहर की मेडिकल स्टोर से दवा खरीदने की पर्ची थमा दी। सिविल सर्जन ने जांच के आदेश दिए हैं।",
                "source_name": "Prabhat Khabar",
                "source_url": "https://www.prabhatkhabar.com/state/bihar/muzaffarpur/sadar-hospital-medicine-shortage-protest-98213",
                "media_urls": [
                    "https://images.unsplash.com/photo-1519494026892-80bbd2d6fd0d?auto=format&fit=crop&w=800&q=80"
                ],
                "district_hint": "Muzaffarpur"
            },
            {
                "title": "गया शहर के जीबी रोड पर 11kV ट्रांसफार्मर में ब्लास्ट, 18 घंटे से बिजली गुल",
                "snippet": "भीषण गर्मी में बिजली आपूर्ति ठप होने से पेयजल संकट गहराया। व्यवसायी संघ ने बिजली विभाग के खिलाफ प्रदर्शन की चेतावनी दी।",
                "content": "गया शहर के मुख्य व्यावसायिक केंद्र जीबी रोड पर ट्रांसफार्मर में जोरदार धमाका हुआ जिससे 1500 घरों और दुकानों की बिजली गुल हो गई। पेयजल के लिए हाहाकार मच गया है।",
                "source_name": "Live Hindustan Bihar",
                "source_url": "https://www.livehindustan.com/bihar/gaya/transformer-blast-power-outage-gb-road-87123",
                "media_urls": [
                    "https://images.unsplash.com/photo-1473341304170-971dccb5ac1e?auto=format&fit=crop&w=800&q=80"
                ],
                "district_hint": "Gaya"
            }
        ]

        inserted_count = 0
        for item in sample_items:
            raw_id, is_new = await insert_raw_news(item)
            item["id"] = raw_id
            if is_new:
                inserted_count += 1
                await self.enqueue_raw_item(item)
                await self.hub.send_to_frontends({
                    "type": "NEW_RAW_ITEM",
                    "item": item
                })

        await self.hub.broadcast_log(
            "PIPELINE", "SUCCESS",
            f"Successfully injected {inserted_count} sample Bihar civic items into the graph pipeline."
        )
