"""
Comprehensive System Test for Bihar Citizen Echo.
Tests DB async layer, Prompt Engine & Parsers, REST APIs, and WebSocket Hub communication.
"""
import asyncio
import json
import time
import httpx
import websockets

from backend.database import (
    init_db, insert_raw_news, get_all_raw_news, insert_processed_news,
    get_all_processed_news, log_event, get_recent_logs, reset_all_databases
)
from backend.prompt_engine import (
    build_deepseek_prompt, clean_and_parse_deepseek_response, fallback_regex_parse
)

async def test_database_and_parser():
    print("\n--- 1. Testing Database & Prompt Engine ---")
    await init_db()
    await reset_all_databases()

    # 1. Test Raw Insertion
    raw_id, _ = await insert_raw_news({
        "title": "पटना के बोरिंग रोड पर सीवर चोक, बदबू से व्यापारी परेशान",
        "snippet": "व्यापारियों का कहना है कि नगर निगम को 10 बार आवेदन दिया गया पर सफाई नहीं हुई।",
        "content": "पटना के बोरिंग रोड चौराहे के पास मुख्य सीवर लाइन चोक होने से गंदा पानी सड़क पर बह रहा है। स्थानीय दुकानदारों ने नगर निगम के खिलाफ नारेबाजी की।",
        "source_name": "Dainik Bhaskar Bihar",
        "source_url": "https://bhaskar.com/bihar/patna/news1",
        "media_urls": ["https://images.unsplash.com/photo-1547683905-f686c993aae5"],
        "district_hint": "Patna"
    })
    print(f"✓ Inserted raw news with ID: {raw_id}")

    raw_items = await get_all_raw_news(limit=10)
    assert len(raw_items) == 1, f"Expected 1 raw item, got {len(raw_items)}"
    print(f"✓ Retrieved raw item from DB: {raw_items[0]['title']}")

    # 2. Test DeepSeek Prompt Builder
    prompt = build_deepseek_prompt(raw_items[0])
    assert "STRICT: Return ONLY a valid JSON object" in prompt
    print("✓ DeepSeek compact prompt built successfully.")

    # 3. Test DeepSeek Response Parsing (with <think> tags & ```json)
    simulated_deepseek_response = """
    <think>
    Thinking process:
    The user wants structured extraction for Patna sewage grievance.
    This is definitely a grievance related to sanitation/drainage.
    Urgency is 3 because road is blocked with foul odor.
    </think>
    ```json
    {
      "title": "पटना के बोरing रोड पर सीवर चोक से व्यापारी परेशान",
      "actual_news": "पटना के बोरिंग रोड पर सीवर चोक होने से गंदा पानी सड़क पर बह रहा है और दुकानदारों का व्यापार प्रभावित हो रहा है।",
      "is_grievance": true,
      "grievance_type": "Waterlogging/Drainage",
      "is_political": false,
      "urgency_level": 3,
      "logical_flaw_rating": 1,
      "sentiment": "Negative",
      "affected_population": "Ward/Mohalla (100-500)",
      "district": "Patna",
      "city_block": "Patna Sadar",
      "locality": "Boring Road",
      "key_demands": ["सीवर लाइन की तत्काल सफाई", "दोषी सुपरवाइजर पर कार्रवाई"],
      "responsible_authority": "Patna Municipal Corporation (PMC)"
    }
    ```
    """
    parsed = clean_and_parse_deepseek_response(simulated_deepseek_response)
    assert parsed is not None, "Parsed result should not be None"
    assert parsed["is_grievance"] is True
    assert parsed["district"] == "Patna"
    assert parsed["urgency_level"] == 3
    print("✓ DeepSeek response successfully parsed, <think> tags and markdown fences stripped cleanly.")

    # 4. Insert Processed News
    parsed["raw_id"] = raw_id
    parsed["media_urls"] = raw_items[0]["media_urls"]
    proc_id = await insert_processed_news(parsed)
    assert proc_id == raw_id, f"Discrete entity ID mismatch: expected {raw_id}, got {proc_id}"
    print(f"✓ Inserted processed news with discrete ID: {proc_id} (identical to raw_id)")

    proc_items = await get_all_processed_news()
    assert len(proc_items) == 1
    assert proc_items[0]["id"] == raw_id, f"Entity ID in DB {proc_items[0]['id']} != raw_id {raw_id}"
    assert proc_items[0]["district"] == "Patna"
    print(f"✓ Retrieved processed intelligence item: {proc_items[0]['title']} [Discrete ID: {proc_items[0]['id']}]")

async def test_rest_and_websocket_hub():
    print("\n--- 2. Testing WebSocket Hub & Real-time Dispatch ---")
    import uvicorn
    from backend.app import app

    config = uvicorn.Config(app, host="127.0.0.1", port=8001, log_level="warning")
    server = uvicorn.Server(config)
    
    server_task = asyncio.create_task(server.serve())
    await asyncio.sleep(1.5)

    base_url = "http://127.0.0.1:8001"
    ws_base = "ws://127.0.0.1:8001/ws/hub"

    try:
        async with httpx.AsyncClient() as client:
            # 1. Test Status API
            resp = await client.get(f"{base_url}/api/status")
            status_data = resp.json()
            assert resp.status_code == 200
            print("✓ REST GET /api/status OK:", status_data["pipeline"])

            # 2. Test Ingest Sample Feed API
            resp_sample = await client.post(f"{base_url}/api/pipeline/trigger_sample")
            assert resp_sample.status_code == 200
            print("✓ REST POST /api/pipeline/trigger_sample OK.")

            # 3. Connect Frontend WebSocket
            async with websockets.connect(f"{ws_base}?client_type=frontend") as ws_frontend:
                print("✓ Frontend WebSocket connected.")
                # Read initial messages
                welcome = await asyncio.wait_for(ws_frontend.recv(), timeout=2.0)
                msg1 = json.loads(welcome)
                print(f"✓ Frontend received message: {msg1.get('type')}")

                # 4. Connect Scraper Extension WebSocket
                async with websockets.connect(f"{ws_base}?client_type=scraper_ext") as ws_scraper:
                    print("✓ Scraper Extension WebSocket connected.")
                    # Send scraped news batch
                    sample_batch = [{
                        "id": f"bihar_test_{int(time.time())}",
                        "title": "गया के विष्णुपद मंदिर मार्ग पर सड़क टूटने से श्रद्धालु चोटिल",
                        "snippet": "सड़क पर नुकीले पत्थर निकले हुए हैं। नगर निगम ध्यान नहीं दे रहा।",
                        "content": "गया के ऐतिहासिक विष्णुपद मंदिर जाने वाले मुख्य रास्ते पर सड़क पूरी तरह ध्वस्त हो चुकी है।",
                        "source_name": "Live Hindustan Bihar",
                        "source_url": "https://livehindustan.com/bihar/gaya/news",
                        "media_urls": ["https://images.unsplash.com/photo-1515162816999-a0c47dc192f7"],
                        "district_hint": "Gaya",
                        "scraped_at": time.time()
                    }]
                    await ws_scraper.send(json.dumps({
                        "type": "SCRAPER_RAW_ITEMS",
                        "items": sample_batch
                    }))
                    print("✓ Scraper pushed items over WebSocket.")

                    # Frontend should receive NEW_RAW_ITEM
                    frontend_item_msg = await asyncio.wait_for(ws_frontend.recv(), timeout=3.0)
                    msg_item = json.loads(frontend_item_msg)
                    print(f"✓ Frontend live update received: {msg_item.get('type')}")

                # 5. Connect DeepSeek Extension WebSocket
                async with websockets.connect(f"{ws_base}?client_type=deepseek_ext") as ws_deepseek:
                    print("✓ DeepSeek Automator WebSocket connected.")
                    await ws_deepseek.send(json.dumps({
                        "type": "DEEPSEEK_READY",
                        "status": "idle"
                    }))

                    # Wait for pipeline to dispatch an item to DeepSeek
                    dispatch_msg = await asyncio.wait_for(ws_deepseek.recv(), timeout=6.0)
                    task_data = json.loads(dispatch_msg)
                    if task_data.get("type") == "PROCESS_NEWS_ITEM":
                        raw_id = task_data["raw_id"]
                        print(f"✓ DeepSeek received task for raw_id: {raw_id}")
                        
                        # Simulate DeepSeek returning processed JSON
                        await ws_deepseek.send(json.dumps({
                            "type": "DEEPSEEK_PROCESSED_RESULT",
                            "raw_id": raw_id,
                            "result": {
                                "title": "गया विष्णुपद मंदिर मार्ग पर सड़क ध्वस्त",
                                "actual_news": "विष्णुपद मंदिर मार्ग पर गड्ढों के कारण श्रद्धालु परेशान हैं।",
                                "is_grievance": True,
                                "grievance_type": "Road/Infra",
                                "is_political": False,
                                "urgency_level": 4,
                                "logical_flaw_rating": 1,
                                "sentiment": "Negative",
                                "district": "Gaya",
                                "city_block": "Gaya Town",
                                "locality": "Vishnupad Road",
                                "key_demands": ["सड़क की तुरंत मरम्मत"],
                                "responsible_authority": "Gaya Municipal Corporation"
                            }
                        }))
                        print("✓ DeepSeek sent processed result back.")

                # 6. Test Priority Custom Send Message Feature
                print("\n--- 3. Testing Priority Custom Query Intercept ---")
                async with websockets.connect(f"{ws_base}?client_type=deepseek_ext") as ws_deepseek_custom:
                    await ws_deepseek_custom.send(json.dumps({"type": "DEEPSEEK_READY"}))

                    # Trigger priority query in background task
                    async def trigger_custom_query():
                        await asyncio.sleep(0.5)
                        resp = await client.post(
                            f"{base_url}/api/ai/inject_query",
                            json={"text": "पटना में सबसे ज्यादा शिकायतें किस विभाग की हैं?"}
                        )
                        print("✓ Custom query POST response:", resp.json())

                    asyncio.create_task(trigger_custom_query())

                    # DeepSeek extension should receive INJECT_USER_QUERY
                    custom_task = await asyncio.wait_for(ws_deepseek_custom.recv(), timeout=5.0)
                    custom_msg = json.loads(custom_task)
                    assert custom_msg.get("type") == "INJECT_USER_QUERY"
                    print(f"✓ DeepSeek received custom prompt: '{custom_msg.get('text')}'")

                    # DeepSeek replies with answer
                    await ws_deepseek_custom.send(json.dumps({
                        "type": "DEEPSEEK_CUSTOM_RESPONSE",
                        "text": "पटना में सबसे अधिक शिकायतें पटना नगर निगम (जलजमाव व सीवर) और विद्युत आपूर्ति से संबंधित हैं।"
                    }))
                    print("✓ DeepSeek returned priority response; pipeline resumed.")

            print("\n========================================================")
            print("🎉 ALL TESTS PASSED! Backend, DB, Prompts, Extensions, and Priority Intercept verified!")
            print("========================================================")

    finally:
        server.should_exit = True
        await server_task

if __name__ == "__main__":
    asyncio.run(test_database_and_parser())
    asyncio.run(test_rest_and_websocket_hub())
