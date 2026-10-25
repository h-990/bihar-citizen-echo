"""
Prompt Engine & Schema for DeepSeek AI Automator.
Specially tuned for Bihar Regional News & Grievance extraction with ultra-low latency prompt design.
"""
import re
import json
from typing import Dict, Any, Optional

BIHAR_DISTRICTS = [
    "Patna", "Gaya", "Muzaffarpur", "Bhagalpur", "Darbhanga", "Purnia", "Begusarai",
    "Samastipur", "Rohtas", "Nalanda", "Vaishali", "Saran", "Siwan", "Gopalganj",
    "Madhubani", "Saharsa", "Madhepura", "Supaul", "Katihar", "Araria", "Kishanganj",
    "Banka", "Munger", "Jamui", "Lakhisarai", "Sheikhpura", "Nawada", "Aurangabad",
    "Jehanabad", "Arwal", "Bhojpur", "Buxar", "Kaimur", "West Champaran",
    "East Champaran", "Sitamarhi", "Sheohar", "Khagaria"
]

FAST_EXTRACTION_SYSTEM_PROMPT = """You are a high-speed Bihar News & Public Grievance Intelligence Engine.
Your task is to analyze news from Bihar (India) and extract structured civic intelligence.
RULES:
1. OUTPUT STRICT RAW JSON ONLY. NEVER output markdown fences like ```json, no preface, no reasoning.
2. Determine if the item is a PUBLIC GRIEVANCE (civic breakdown, waterlogging, broken roads/bridges, electricity cut, hospital negligence, corruption, land dispute, school mid-day meal issue, farmer crisis) or GENERAL NEWS.
3. Mark `is_political: true` if it is purely partisan mudslinging or political rallies without direct civic resolution.
4. Urgency Level: 1 (Routine) to 5 (Critical/Emergency/Life-threatening/Flood collapse).
5. Logical Flaw Rating: 1 (Factual & grounded) to 5 (Sensationalized rumor / heavy bias / contradiction).
6. Accurately identify Bihar District, Block/City, and Locality.
"""

def build_deepseek_prompt(item: Dict[str, Any], enable_websearch: bool = False) -> str:
    """
    Build an ultra-compact single prompt to send directly into DeepSeek Chat web input.
    Designed to minimize tokens, eliminate reasoning delay, and force instant JSON reply.
    """
    title = item.get("title", "")
    content = item.get("content") or item.get("snippet", "")
    source = item.get("source_name", "Bihar Local Source")

    search_instruction = ""
    search_schema = ""
    if enable_websearch:
        search_instruction = "CRITICAL: SEARCH THE LIVE WEB to verify if this event/complaint is a verified authentic occurrence or unverified/fake rumor.\n"
        search_schema = ',\n  "truthfulness_score": 5,\n  "truth_verdict": "Verified Fact | Unverified Claim | Misleading | Fake Rumor"'

    safe_title = json.dumps(title[:80])[1:-1]
    safe_source = json.dumps(source[:50])[1:-1]

    prompt = f"""STRICT: Return ONLY a valid JSON object (no markdown, no quotes around json, no reasoning) analyzing this Bihar civic report:
{search_instruction}
Source: {safe_source}
Headline: {title}
Content: {content[:1000]}

Schema:
{{
  "title": "{safe_title}",
  "actual_news": "2 sentence factual summary",
  "is_grievance": true,
  "grievance_type": "Road/Infra | Waterlogging/Drainage | Electricity | Hospital/Health | School/Education | Sanitation/Garbage | Law & Order/Crime | Administrative Corruption | Land Dispute | Agriculture/Farmer | Public Transport | General Civic | General News",
  "is_political": false,
  "urgency_level": 3,
  "logical_flaw_rating": 1,
  "sentiment": "Negative | Neutral | Positive",
  "affected_population": "Individual | Ward/Mohalla (100-500) | Panchayat/Village (1k-5k) | Block/Town (10k+) | District Crisis",
  "district": "Bihar District (e.g. Patna, Gaya, Muzaffarpur, Darbhanga, etc.)",
  "city_block": "Block, Tehsil, or Sub-division (e.g. Kankarbagh, Danapur, Barh, Maripur, Phulwari)",
  "locality": "Exact Mohalla, Chowk, Road, Village, or specific area outside city (e.g. Kankarbagh Auto Stand, GB Road, Brahmpura, Bela Industrial Area, Ward 44)",
  "key_demands": ["Demand 1", "Demand 2"],
  "responsible_authority": "e.g. PMC / BSPHCL / RCD Bihar / District Magistrate"{search_schema}
}}"""
    return prompt

def clean_and_parse_deepseek_response(raw_text: str) -> Optional[Dict[str, Any]]:
    """
    Extract and parse JSON from DeepSeek's response even if surrounded by thoughts or markdown fences.
    """
    if not raw_text:
        return None

    cleaned = raw_text.strip()
    
    # Strip any <think> ... </think> reasoning tags if DeepThink was inadvertently enabled
    cleaned = re.sub(r'<think>.*?</think>', '', cleaned, flags=re.DOTALL).strip()

    # Strip markdown code blocks like ```json ... ``` or ``` ... ```
    match = re.search(r'```(?:json)?\s*([\s\S]*?)\s*```', cleaned)
    if match:
        cleaned = match.group(1).strip()
    else:
        # Search for first { to last }
        first_brace = cleaned.find('{')
        last_brace = cleaned.rfind('}')
        if first_brace != -1 and last_brace != -1 and last_brace > first_brace:
            cleaned = cleaned[first_brace:last_brace+1]

    try:
        data = json.loads(cleaned)
        # Normalize fields
        if not isinstance(data, dict):
            return None
        
        # Explicit error check: NEVER treat error messages as successful classification
        if "error" in data or data.get("status") == "error":
            return None

        # Must have at least basic classification indicators
        if not data.get("actual_news") and not data.get("title") and "is_grievance" not in data:
            return None
        
        # Ensure proper types
        data["is_grievance"] = bool(data.get("is_grievance", False))
        data["is_political"] = bool(data.get("is_political", False))
        
        try:
            data["urgency_level"] = max(1, min(5, int(data.get("urgency_level", 1))))
        except (ValueError, TypeError):
            data["urgency_level"] = 1
            
        try:
            data["logical_flaw_rating"] = max(1, min(5, int(data.get("logical_flaw_rating", 1))))
        except (ValueError, TypeError):
            data["logical_flaw_rating"] = 1

        standard_keys = {
            "title", "actual_news", "is_grievance", "grievance_type", "is_political",
            "urgency_level", "logical_flaw_rating", "sentiment", "affected_population",
            "district", "city_block", "locality", "key_demands", "responsible_authority",
            "truthfulness_score", "truth_verdict",
            "raw_id", "id", "media_urls", "source_name", "source_url", "raw_ai_response",
            "attributes", "processed_at"
        }
        if "attributes" not in data or not isinstance(data["attributes"], dict):
            data["attributes"] = {}
        for k, v in list(data.items()):
            if k not in standard_keys:
                data["attributes"][k] = v
        # Ensure truth fields are preserved in attributes as well for DB storage
        if "truthfulness_score" in data:
            data["attributes"]["truthfulness_score"] = data["truthfulness_score"]
        if "truth_verdict" in data:
            data["attributes"]["truth_verdict"] = data["truth_verdict"]

        return data
    except Exception as e:
        # Attempt loose regex extraction only if not an error message
        if '"error":' in cleaned or 'error' in cleaned[:30].lower():
            return None
        return fallback_regex_parse(cleaned, raw_text)

def fallback_regex_parse(text: str, original_raw: str) -> Optional[Dict[str, Any]]:
    """Fallback extractor if JSON is malformed."""
    if not text or '"error":' in text:
        return None
    if '"is_grievance"' not in text and '"actual_news"' not in text and '"urgency_level"' not in text:
        return None

    is_grievance = bool(re.search(r'"is_grievance":\s*(true|1)', text, re.I))
    is_political = bool(re.search(r'"is_political":\s*(true|1)', text, re.I))
    
    urgency_match = re.search(r'"urgency_level":\s*(\d)', text)
    urgency = int(urgency_match.group(1)) if urgency_match else 2
    
    district_match = re.search(r'"district":\s*"([^"]+)"', text)
    district = district_match.group(1) if district_match else "Bihar (General)"
    
    sentiment_match = re.search(r'"sentiment":\s*"([^"]+)"', text)
    sentiment = sentiment_match.group(1) if sentiment_match else "Neutral"
    
    grievance_type_match = re.search(r'"grievance_type":\s*"([^"]+)"', text)
    grievance_type = grievance_type_match.group(1) if grievance_type_match else ("General Civic" if is_grievance else "General News")
    
    summary_match = re.search(r'"actual_news":\s*"([^"]+)"', text)
    summary = summary_match.group(1) if summary_match else text[:200]

    block_match = re.search(r'"city_block":\s*"([^"]+)"', text)
    city_block = block_match.group(1) if block_match else ""

    locality_match = re.search(r'"locality":\s*"([^"]+)"', text)
    locality = locality_match.group(1) if locality_match else ""

    auth_match = re.search(r'"responsible_authority":\s*"([^"]+)"', text)
    authority = auth_match.group(1) if auth_match else "Local Administration"

    return {
        "title": "Bihar News Extraction",
        "actual_news": summary,
        "is_grievance": is_grievance,
        "grievance_type": grievance_type,
        "is_political": is_political,
        "urgency_level": urgency,
        "logical_flaw_rating": 2,
        "sentiment": sentiment,
        "affected_population": "Locality",
        "district": district,
        "city_block": city_block,
        "locality": locality,
        "key_demands": [],
        "responsible_authority": authority,
        "raw_ai_response": original_raw
    }
