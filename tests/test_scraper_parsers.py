"""
Unit tests for Bihar regional scraper parsing, district detection,
and civic grievance taxonomy. Authored for the scraping ingestion pipeline.
"""
import re
import unittest

DISTRICT_MAP = {
    "Patna": ["पटना", "patna", "बाढ़", "दानापुर", "मोकामा", "मसौढ़ी", "फुलवारी"],
    "Muzaffarpur": ["मुजफ्फरपुर", "muzaffarpur", "कांटी", "सकरा", "सरैया"],
    "Gaya": ["गया", "gaya", "बोधगया", "शेरघाटी", "टिकारी"],
    "Bhagalpur": ["भागलपुर", "bhagalpur", "कहलगांव", "नवगछिया"],
    "Darbhanga": ["दरभंगा", "darbhanga", "बेनीपुर", "बिरौल"],
    "Nalanda": ["नालंदा", "nalanda", "बिहार शरीफ", "राजगीर"],
    "Purnia": ["पूर्णिया", "purnia", "धमदाहा", "बनमनखी"]
}

GRIEVANCE_TAXONOMY = {
    "Roads & Waterlogging": ["सड़क", "पुल", "गड्ढा", "जलजमाव", "कीचड़", "नाला", "सीवर"],
    "Power & Electricity": ["बिजली", "ट्रांसफार्मर", "स्मार्ट मीटर", "कटौती", "अंधेरा"],
    "Drinking Water": ["पेयजल", "नल-जल", "हैंडपंप", "टैंकर", "जल संकट"],
    "Healthcare": ["अस्पताल", "सदर अस्पताल", "डॉक्टर", "दवा", "एंबुलेंस"],
    "Sanitation": ["कचरा", "सफाई", "दुर्गंध", "गंदगी", "निगम"]
}

def detect_district_from_text(text: str) -> str:
    lower = text.lower()
    for district, keywords in DISTRICT_MAP.items():
        for kw in keywords:
            if kw.lower() in lower:
                return district
    return "Bihar"

def classify_civic_grievance(text: str):
    lower = text.lower()
    for category, keywords in GRIEVANCE_TAXONOMY.items():
        for kw in keywords:
            if kw.lower() in lower:
                return True, category
    return False, "General"

def sanitize_headline(raw: str) -> str:
    cleaned = re.sub(r'<[^>]+>', '', raw)
    cleaned = re.sub(r'\s+', ' ', cleaned).strip()
    # Strip site branding suffix
    cleaned = re.sub(r'\s*[-|]\s*(Dainik Bhaskar|Live Hindustan|Prabhat Khabar).*$', '', cleaned, flags=re.IGNORECASE)
    return cleaned

class TestScraperParsers(unittest.TestCase):
    def test_district_detection(self):
        sample1 = "मुजफ्फरपुर के कांटी में जलजमाव से लोग परेशान"
        sample2 = "राजगीर में पर्यटन विकास कार्यों का जायजा"
        sample3 = "General state budget speech by finance minister"
        
        self.assertEqual(detect_district_from_text(sample1), "Muzaffarpur")
        self.assertEqual(detect_district_from_text(sample2), "Nalanda")
        self.assertEqual(detect_district_from_text(sample3), "Bihar")

    def test_civic_grievance_classification(self):
        text_power = "स्मार्ट मीटर लगाने के विरोध में ग्रामीणों ने बिजली दफ्तर घेरा"
        text_water = "भीषण गर्मी में नल-जल योजना ठप, टैंकर से आपूर्ति की मांग"
        text_general = "राज्य क्रिकेट टूर्नामेंट का कल से शुभारंभ"

        is_g1, cat1 = classify_civic_grievance(text_power)
        self.assertTrue(is_g1)
        self.assertEqual(cat1, "Power & Electricity")

        is_g2, cat2 = classify_civic_grievance(text_water)
        self.assertTrue(is_g2)
        self.assertEqual(cat2, "Drinking Water")

        is_g3, cat3 = classify_civic_grievance(text_general)
        self.assertFalse(is_g3)
        self.assertEqual(cat3, "General")

    def test_headline_sanitization(self):
        raw_html = "<h1>गया में पुलिया धंसने से आवागमन बाधित - Dainik Bhaskar</h1>"
        clean = sanitize_headline(raw_html)
        self.assertEqual(clean, "गया में पुलिया धंसने से आवागमन बाधित")

if __name__ == "__main__":
    unittest.main()
