"""
Database module for Bihar News & Grievance Analysis.
Uses aiosqlite for high-concurrency asynchronous SQLite persistence.
"""
import os
import time
import json
import uuid
import aiosqlite
from typing import Dict, Any, List, Optional

DB_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "grievance_bihar.db")

async def init_db():
    """Initialize database tables with WAL mode for concurrent reading/writing."""
    async with aiosqlite.connect(DB_FILE) as db:
        await db.execute("PRAGMA journal_mode=WAL;")
        await db.execute("PRAGMA synchronous=NORMAL;")
        await db.execute("PRAGMA busy_timeout=10000;")
        await db.execute("PRAGMA cache_size=-64000;")  # 64MB memory page cache
        await db.execute("PRAGMA temp_store=MEMORY;")
        await db.execute("PRAGMA mmap_size=268435456;")  # 256MB memory-mapped I/O
        
        # 1. Raw Scraped News Table
        await db.execute("""
            CREATE TABLE IF NOT EXISTS raw_news (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                snippet TEXT,
                content TEXT,
                source_name TEXT NOT NULL,
                source_url TEXT,
                media_urls TEXT, -- JSON array of image/media URLs
                district_hint TEXT,
                scraped_at REAL NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending' -- pending, processing, completed, failed
            );
        """)
        await db.execute("CREATE INDEX IF NOT EXISTS idx_raw_status ON raw_news(status);")
        await db.execute("CREATE INDEX IF NOT EXISTS idx_raw_scraped_at ON raw_news(scraped_at DESC);")

        # 2. Processed News & Grievance Table with Dynamic Attributes
        await db.execute("""
            CREATE TABLE IF NOT EXISTS processed_news (
                id TEXT PRIMARY KEY,
                raw_id TEXT NOT NULL UNIQUE,
                title TEXT NOT NULL,
                actual_news TEXT,
                is_grievance INTEGER NOT NULL DEFAULT 0, -- 1 for True, 0 for False
                grievance_type TEXT,
                is_political INTEGER NOT NULL DEFAULT 0, -- 1 for True, 0 for False
                urgency_level INTEGER NOT NULL DEFAULT 1, -- 1 (Low) to 5 (Critical)
                logical_flaw_rating INTEGER NOT NULL DEFAULT 1, -- 1 (Solid) to 5 (Heavy Flaws)
                sentiment TEXT DEFAULT 'Neutral',
                affected_population TEXT,
                district TEXT NOT NULL DEFAULT 'Bihar (General)',
                city_block TEXT,
                locality TEXT,
                key_demands TEXT, -- JSON array of strings
                responsible_authority TEXT,
                media_urls TEXT, -- JSON array of images tagged with this news id
                source_name TEXT,
                source_url TEXT,
                raw_ai_response TEXT,
                attributes_json TEXT DEFAULT '{}', -- Open-ended dynamic exotic fields & tags
                processed_at REAL NOT NULL,
                FOREIGN KEY (raw_id) REFERENCES raw_news(id) ON DELETE CASCADE
            );
        """)
        await db.execute("CREATE INDEX IF NOT EXISTS idx_proc_district ON processed_news(district);")
        await db.execute("CREATE INDEX IF NOT EXISTS idx_proc_grievance ON processed_news(is_grievance);")
        await db.execute("CREATE INDEX IF NOT EXISTS idx_proc_urgency ON processed_news(urgency_level DESC);")
        await db.execute("CREATE INDEX IF NOT EXISTS idx_proc_grievance_type ON processed_news(grievance_type);")
        await db.execute("CREATE INDEX IF NOT EXISTS idx_proc_processed_at ON processed_news(processed_at DESC);")

        # 3. System & Pipeline Logs
        await db.execute("""
            CREATE TABLE IF NOT EXISTS system_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp REAL NOT NULL,
                stream TEXT NOT NULL, -- SYSTEM, SCRAPER, DEEPSEEK, PIPELINE
                level TEXT NOT NULL,  -- INFO, WARN, ERROR, SUCCESS
                message TEXT NOT NULL,
                details TEXT          -- Optional JSON or details string
            );
        """)
        await db.execute("CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON system_logs(timestamp DESC);")

        # 4. Pipeline Node Settings Persistence (with positions)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS pipeline_nodes (
                node_id TEXT PRIMARY KEY,
                node_type TEXT NOT NULL,
                title TEXT NOT NULL,
                config_json TEXT NOT NULL,
                pos_x REAL DEFAULT 60,
                pos_y REAL DEFAULT 40,
                updated_at REAL NOT NULL
            );
        """)

        # 5. Interactive Pipeline Graph Edges
        await db.execute("""
            CREATE TABLE IF NOT EXISTS pipeline_edges (
                edge_id TEXT PRIMARY KEY,
                source_node TEXT NOT NULL,
                source_port TEXT NOT NULL,
                target_node TEXT NOT NULL,
                target_port TEXT NOT NULL,
                config_json TEXT DEFAULT '{}',
                created_at REAL NOT NULL
            );
        """)

        # Migrations for existing tables if columns missing
        for alter_sql in [
            "ALTER TABLE pipeline_nodes ADD COLUMN pos_x REAL DEFAULT 60;",
            "ALTER TABLE pipeline_nodes ADD COLUMN pos_y REAL DEFAULT 40;",
            "ALTER TABLE processed_news ADD COLUMN attributes_json TEXT DEFAULT '{}';",
            "UPDATE processed_news SET id = raw_id WHERE raw_id IS NOT NULL AND raw_id != '' AND id != raw_id;"
        ]:
            try:
                await db.execute(alter_sql)
            except Exception:
                pass

        await db.commit()
    await seed_default_edges_if_empty()

def generate_news_id(prefix: str = "bihar") -> str:
    """Generate human-readable unique identifier based on timestamp and hash."""
    ts = int(time.time())
    suffix = uuid.uuid4().hex[:6]
    return f"{prefix}_{ts}_{suffix}"

async def insert_raw_news(item: Dict[str, Any]) -> tuple[str, bool]:
    """Insert a raw scraped news item into raw_news table with title/url deduplication. Returns (id, is_new)."""
    title = (item.get("title") or "").strip()
    source_url = (item.get("source_url") or "").strip()

    async with aiosqlite.connect(DB_FILE) as db:
        # 1. Deduplication check by exact title
        if title:
            async with db.execute("SELECT id FROM raw_news WHERE title = ?", (title,)) as c:
                row = await c.fetchone()
                if row:
                    return (row[0], False)

        # 2. Deduplication check by source_url (if not generic/google search)
        if source_url and "news.google.com" not in source_url:
            async with db.execute("SELECT id FROM raw_news WHERE source_url = ?", (source_url,)) as c:
                row = await c.fetchone()
                if row:
                    return (row[0], False)

        raw_id = item.get("id") or generate_news_id("raw")
        media_json = json.dumps(item.get("media_urls", []))
        await db.execute("""
            INSERT OR IGNORE INTO raw_news 
            (id, title, snippet, content, source_name, source_url, media_urls, district_hint, scraped_at, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            raw_id,
            title or "Untitled News",
            item.get("snippet", ""),
            item.get("content", ""),
            item.get("source_name", "Unknown Bihar Source"),
            source_url,
            media_json,
            item.get("district_hint", "Bihar"),
            item.get("scraped_at", time.time()),
            item.get("status", "pending")
        ))
        await db.commit()
    return (raw_id, True)


async def get_pending_raw_news(limit: int = 10) -> List[Dict[str, Any]]:
    """Retrieve raw items that are pending processing or interrupted."""
    async with aiosqlite.connect(DB_FILE) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("""
            SELECT id, title, snippet, content, source_name, source_url, media_urls, district_hint, scraped_at, status
            FROM raw_news
            WHERE status = 'pending' OR status = 'processing'
            ORDER BY scraped_at ASC
            LIMIT ?
        """, (limit,)) as cursor:
            rows = await cursor.fetchall()
            results = []
            for r in rows:
                d = dict(r)
                try:
                    d["media_urls"] = json.loads(d["media_urls"] or "[]")
                except Exception:
                    d["media_urls"] = []
                results.append(d)
            return results

async def update_raw_news_status(raw_id: str, status: str):
    """Update status of a raw news record."""
    async with aiosqlite.connect(DB_FILE) as db:
        await db.execute("UPDATE raw_news SET status = ? WHERE id = ?", (status, raw_id))
        await db.commit()

async def insert_processed_news(proc_item: Dict[str, Any]) -> str:
    """Insert or replace a processed news / grievance item with dynamic open-ended attributes."""
    # Discrete entity identity principle: The entity ID is invariant across all pipeline nodes.
    # Payload type/attributes evolve from raw to processed, but item ID remains discrete and identical.
    discrete_id = proc_item.get("raw_id") or proc_item.get("id") or generate_news_id("raw")
    proc_id = discrete_id
    raw_id = discrete_id
    proc_item["id"] = discrete_id
    proc_item["raw_id"] = discrete_id
    media_json = json.dumps(proc_item.get("media_urls", []))
    demands_json = json.dumps(proc_item.get("key_demands", []))

    # Collect any dynamic exotic attributes (non-standard fields)
    standard_keys = {
        "id", "raw_id", "title", "actual_news", "is_grievance", "grievance_type",
        "is_political", "urgency_level", "logical_flaw_rating", "sentiment",
        "affected_population", "district", "city_block", "locality", "key_demands",
        "responsible_authority", "media_urls", "source_name", "source_url",
        "raw_ai_response", "processed_at", "attributes_json"
    }
    attributes = dict(proc_item.get("attributes", {}))
    for k, v in proc_item.items():
        if k not in standard_keys and k != "attributes":
            attributes[k] = v
    attributes_json = json.dumps(attributes)

    async with aiosqlite.connect(DB_FILE) as db:
        await db.execute("""
            INSERT OR REPLACE INTO processed_news 
            (id, raw_id, title, actual_news, is_grievance, grievance_type, is_political,
             urgency_level, logical_flaw_rating, sentiment, affected_population,
             district, city_block, locality, key_demands, responsible_authority,
             media_urls, source_name, source_url, raw_ai_response, attributes_json, processed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            proc_id,
            raw_id,
            proc_item.get("title", ""),
            proc_item.get("actual_news", ""),
            1 if proc_item.get("is_grievance") else 0,
            proc_item.get("grievance_type", "General News"),
            1 if proc_item.get("is_political") else 0,
            int(proc_item.get("urgency_level", 1)),
            int(proc_item.get("logical_flaw_rating", 1)),
            proc_item.get("sentiment", "Neutral"),
            proc_item.get("affected_population", "Unspecified"),
            proc_item.get("district", "Bihar (General)"),
            proc_item.get("city_block", ""),
            proc_item.get("locality", ""),
            demands_json,
            proc_item.get("responsible_authority", ""),
            media_json,
            proc_item.get("source_name", ""),
            proc_item.get("source_url", ""),
            proc_item.get("raw_ai_response", ""),
            attributes_json,
            proc_item.get("processed_at", time.time())
        ))
        if raw_id:
            await db.execute("UPDATE raw_news SET status = 'completed' WHERE id = ?", (raw_id,))
        await db.commit()
    return proc_id

async def get_all_raw_news(limit: int = 100, offset: int = 0) -> List[Dict[str, Any]]:
    """Retrieve list of raw news items."""
    async with aiosqlite.connect(DB_FILE) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("""
            SELECT id, title, snippet, content, source_name, source_url, media_urls, district_hint, scraped_at, status
            FROM raw_news
            ORDER BY scraped_at DESC
            LIMIT ? OFFSET ?
        """, (limit, offset)) as cursor:
            rows = await cursor.fetchall()
            results = []
            for r in rows:
                d = dict(r)
                try:
                    d["media_urls"] = json.loads(d["media_urls"] or "[]")
                except Exception:
                    d["media_urls"] = []
                results.append(d)
            return results

async def get_all_processed_news(limit: int = 100, offset: int = 0, filter_grievance_only: bool = False) -> List[Dict[str, Any]]:
    """Retrieve processed news items with optional filtering and dynamic attributes."""
    query = """
        SELECT id, raw_id, title, actual_news, is_grievance, grievance_type, is_political,
               urgency_level, logical_flaw_rating, sentiment, affected_population,
               district, city_block, locality, key_demands, responsible_authority,
               media_urls, source_name, source_url, raw_ai_response, attributes_json, processed_at
        FROM processed_news
    """
    params: List[Any] = []
    if filter_grievance_only:
        query += " WHERE is_grievance = 1 "
    query += " ORDER BY processed_at DESC LIMIT ? OFFSET ?"
    params.extend([limit, offset])

    async with aiosqlite.connect(DB_FILE) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(query, tuple(params)) as cursor:
            rows = await cursor.fetchall()
            results = []
            for r in rows:
                d = dict(r)
                try:
                    d["media_urls"] = json.loads(d["media_urls"] or "[]")
                except Exception:
                    d["media_urls"] = []
                try:
                    d["key_demands"] = json.loads(d["key_demands"] or "[]")
                except Exception:
                    d["key_demands"] = []
                try:
                    d["attributes"] = json.loads(d.get("attributes_json") or "{}")
                except Exception:
                    d["attributes"] = {}
                d["is_grievance"] = bool(d["is_grievance"])
                d["is_political"] = bool(d["is_political"])
                d["truthfulness_score"] = d["attributes"].get("truthfulness_score", 5)
                d["truth_verdict"] = d["attributes"].get("truth_verdict", "Verified")
                results.append(d)
            return results


async def get_news_detail(item_id: str) -> Optional[Dict[str, Any]]:
    """Get complete detail of a processed or raw news item by ID including dynamic attributes."""
    async with aiosqlite.connect(DB_FILE) as db:
        db.row_factory = aiosqlite.Row
        # Check processed_news first
        async with db.execute("""
            SELECT p.*, r.snippet as raw_snippet, r.content as raw_content, r.scraped_at
            FROM processed_news p
            LEFT JOIN raw_news r ON (p.id = r.id OR p.raw_id = r.id)
            WHERE p.id = ? OR p.raw_id = ?
        """, (item_id, item_id)) as cursor:
            row = await cursor.fetchone()
            if row:
                d = dict(row)
                try:
                    d["media_urls"] = json.loads(d["media_urls"] or "[]")
                except Exception:
                    d["media_urls"] = []
                try:
                    d["key_demands"] = json.loads(d["key_demands"] or "[]")
                except Exception:
                    d["key_demands"] = []
                try:
                    d["attributes"] = json.loads(d.get("attributes_json") or "{}")
                except Exception:
                    d["attributes"] = {}
                d["is_grievance"] = bool(d["is_grievance"])
                d["is_political"] = bool(d["is_political"])
                return d

        # If not in processed, check raw_news
        async with db.execute("SELECT * FROM raw_news WHERE id = ?", (item_id,)) as cursor:
            row = await cursor.fetchone()
            if row:
                d = dict(row)
                try:
                    d["media_urls"] = json.loads(d["media_urls"] or "[]")
                except Exception:
                    d["media_urls"] = []
                d["attributes"] = {}
                return d
    return None

async def log_event(stream: str, level: str, message: str, details: Any = None):
    """Store system or extension log."""
    det_str = ""
    if details:
        if isinstance(details, (dict, list)):
            det_str = json.dumps(details)
        else:
            det_str = str(details)
    async with aiosqlite.connect(DB_FILE) as db:
        await db.execute("""
            INSERT INTO system_logs (timestamp, stream, level, message, details)
            VALUES (?, ?, ?, ?, ?)
        """, (time.time(), stream.upper(), level.upper(), message, det_str))
        await db.commit()

async def get_recent_logs(limit: int = 150, stream: Optional[str] = None) -> List[Dict[str, Any]]:
    """Retrieve recent log events."""
    async with aiosqlite.connect(DB_FILE) as db:
        db.row_factory = aiosqlite.Row
        if stream and stream.upper() != "ALL":
            query = "SELECT * FROM system_logs WHERE stream = ? ORDER BY timestamp DESC LIMIT ?"
            params = (stream.upper(), limit)
        else:
            query = "SELECT * FROM system_logs ORDER BY timestamp DESC LIMIT ?"
            params = (limit,)
            
        async with db.execute(query, params) as cursor:
            rows = await cursor.fetchall()
            return [dict(r) for r in reversed(rows)]

async def save_node_config(node_id: str, node_type: str, title: str, config: Dict[str, Any], pos_x: float = 60, pos_y: float = 40):
    """Persist pipeline node configuration and canvas position."""
    async with aiosqlite.connect(DB_FILE) as db:
        await db.execute("""
            INSERT OR REPLACE INTO pipeline_nodes (node_id, node_type, title, config_json, pos_x, pos_y, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (node_id, node_type, title, json.dumps(config), pos_x, pos_y, time.time()))
        await db.commit()

async def delete_pipeline_node(node_id: str):
    """Delete a pipeline node and sever all its incoming/outgoing edges."""
    async with aiosqlite.connect(DB_FILE) as db:
        await db.execute("DELETE FROM pipeline_nodes WHERE node_id = ?", (node_id,))
        await db.execute("DELETE FROM pipeline_edges WHERE source_node = ? OR target_node = ?", (node_id, node_id))
        await db.commit()

async def get_all_nodes() -> List[Dict[str, Any]]:
    """Get all saved pipeline nodes."""
    async with aiosqlite.connect(DB_FILE) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM pipeline_nodes ORDER BY updated_at ASC") as cursor:
            rows = await cursor.fetchall()
            result = []
            for r in rows:
                d = dict(r)
                try:
                    d["config"] = json.loads(d["config_json"])
                except Exception:
                    d["config"] = {}
                result.append(d)
            return result

async def save_pipeline_edge(edge_id: str, source_node: str, source_port: str, target_node: str, target_port: str, config: Dict[str, Any] = None):
    """Save an interactive connection edge between any two nodes."""
    if not edge_id:
        edge_id = f"edge_{source_node}_{target_node}_{int(time.time()*1000)}"
    cfg_json = json.dumps(config or {})
    async with aiosqlite.connect(DB_FILE) as db:
        await db.execute("""
            INSERT OR REPLACE INTO pipeline_edges (edge_id, source_node, source_port, target_node, target_port, config_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (edge_id, source_node, source_port, target_node, target_port, cfg_json, time.time()))
        await db.commit()
    return edge_id

async def delete_pipeline_edge(edge_id: str):
    """Remove a connection edge."""
    async with aiosqlite.connect(DB_FILE) as db:
        await db.execute("DELETE FROM pipeline_edges WHERE edge_id = ?", (edge_id,))
        await db.commit()

async def get_all_edges() -> List[Dict[str, Any]]:
    """Retrieve all pipeline edges."""
    async with aiosqlite.connect(DB_FILE) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM pipeline_edges ORDER BY created_at ASC") as cursor:
            rows = await cursor.fetchall()
            result = []
            for r in rows:
                d = dict(r)
                try:
                    d["config"] = json.loads(d["config_json"])
                except Exception:
                    d["config"] = {}
                result.append(d)
            return result

async def seed_default_edges_if_empty():
    """Ensure starter pipeline edges exist so sessions or resets immediately have working routing."""
    async with aiosqlite.connect(DB_FILE) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT COUNT(*) as cnt FROM pipeline_edges") as cursor:
            row = await cursor.fetchone()
            if row and row["cnt"] > 0:
                return
    default_edges = [
        ("edge_scraper_to_deepseek", "nodeScraper", "out", "nodeDeepseek", "in"),
        ("edge_deepseek_to_terminal", "nodeDeepseek", "out", "nodeTerminal", "in")
    ]
    for eid, src, sport, tgt, tport in default_edges:
        await save_pipeline_edge(eid, src, sport, tgt, tport)

async def reset_all_databases():
    """Wipe tables and reinitialize."""
    async with aiosqlite.connect(DB_FILE) as db:
        await db.execute("DROP TABLE IF EXISTS processed_news;")
        await db.execute("DROP TABLE IF EXISTS raw_news;")
        await db.execute("DROP TABLE IF EXISTS system_logs;")
        await db.execute("DROP TABLE IF EXISTS pipeline_nodes;")
        await db.execute("DROP TABLE IF EXISTS pipeline_edges;")
        await db.commit()
    await init_db()
    await seed_default_edges_if_empty()

async def get_district_hotspot_summary():
    """Aggregate grievances by district for geo-radar density mapping."""
    async with aiosqlite.connect(DB_FILE) as db:
        db.row_factory = aiosqlite.Row
        query = """
            SELECT 
                district,
                COUNT(*) as total_grievances,
                ROUND(AVG(urgency_level), 2) as avg_urgency,
                SUM(CASE WHEN urgency_level >= 4 THEN 1 ELSE 0 END) as critical_count,
                MAX(urgency_level) as max_urgency,
                COUNT(DISTINCT grievance_type) as unique_types
            FROM processed_news
            WHERE is_grievance = 1
            GROUP BY district
            ORDER BY total_grievances DESC, avg_urgency DESC
        """
        async with db.execute(query) as cursor:
            rows = await cursor.fetchall()
            return [dict(r) for r in rows]


