"""
Unit tests for Civic Severity Index and District Aggregation Math.
Authored for the Geo-Analytics and Severity Scoring engine.
"""
import unittest

def evaluate_civic_severity_mock(item: dict) -> dict:
    text = f"{item.get('title', '')} {item.get('snippet', '')} {item.get('content', '')}".lower()
    district = item.get("district", "Bihar").lower()

    base_score = 20
    density_multiplier = 1.0
    hazard_category = "ROUTINE_ADMIN"

    # Infrastructure hazard
    if any(k in text for k in ["मौत", "dead", "death", "हादसा", "collapsed", "पुल धंस"]):
        base_score += 50
        hazard_category = "INFRASTRUCTURE_HAZARD"
    elif any(k in text for k in ["जलजमाव", "waterlogging", "बाढ़", "सीवर"]):
        base_score += 30
        hazard_category = "INFRASTRUCTURE_HAZARD"
    elif any(k in text for k in ["अस्पताल", "hospital", "दवा", "डॉक्टर", "डेंगू"]):
        base_score += 35
        hazard_category = "PUBLIC_HEALTH_RISK"
    elif any(k in text for k in ["करंट", "बिजली", "ट्रांसफार्मर", "11kv", "power cut"]):
        base_score += 25
        hazard_category = "ELECTRICAL_FIRE_DANGER"

    # Density weighting
    if "patna" in district or "पटना" in district:
        density_multiplier = 1.30
    elif any(d in district for d in ["muzaffarpur", "gaya", "bhagalpur"]):
        density_multiplier = 1.18

    urgency_bias = (item.get("urgency_level", 3) - 3) * 6
    final_score = int(round((base_score * density_multiplier) + urgency_bias))
    final_score = min(99, max(12, final_score))

    if final_score >= 80:
        priority = "CRITICAL_DISASTER"
    elif final_score >= 60:
        priority = "HIGH_ALERT"
    else:
        priority = "STANDARD_RESPONSE"

    return {
        "score": final_score,
        "category": hazard_category,
        "priority": priority,
        "density_multiplier": density_multiplier
    }

class TestAnalyticsEngine(unittest.TestCase):
    def test_critical_infrastructure_hazard(self):
        item = {
            "title": "पटना के गांधी सेतु के समीप स्लैब धंसने से बड़ा हादसा",
            "snippet": "यातायात पूरी तरह ठप, दो वाहन क्षतिग्रस्त",
            "district": "Patna",
            "urgency_level": 5
        }
        result = evaluate_civic_severity_mock(item)
        self.assertGreaterEqual(result["score"], 80)
        self.assertEqual(result["category"], "INFRASTRUCTURE_HAZARD")
        self.assertEqual(result["priority"], "CRITICAL_DISASTER")
        self.assertEqual(result["density_multiplier"], 1.30)

    def test_public_health_risk(self):
        item = {
            "title": "मुजफ्फरपुर सदर अस्पताल में डेंगू मरीजों के लिए दवा की कमी",
            "snippet": "मरीजों के परिजनों ने किया हंगामा",
            "district": "Muzaffarpur",
            "urgency_level": 3
        }
        result = evaluate_civic_severity_mock(item)
        self.assertEqual(result["category"], "PUBLIC_HEALTH_RISK")
        self.assertGreaterEqual(result["score"], 60)
        self.assertEqual(result["density_multiplier"], 1.18)

    def test_routine_administration(self):
        item = {
            "title": "नालंदा में पुस्तकालय नवीनीकरण कार्य का निरीक्षण",
            "snippet": "अधिकारियों ने प्रगति रिपोर्ट की समीक्षा की",
            "district": "Nalanda",
            "urgency_level": 2
        }
        result = evaluate_civic_severity_mock(item)
        self.assertEqual(result["category"], "ROUTINE_ADMIN")
        self.assertEqual(result["priority"], "STANDARD_RESPONSE")
        self.assertLess(result["score"], 40)

if __name__ == "__main__":
    unittest.main()
