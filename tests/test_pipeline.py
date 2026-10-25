"""
Integration and Unit Tests for Pipeline Orchestrator and Metric Telemetry.
Authored for core platform engine and automated crawl scheduler.
"""
import unittest
import random

def calculate_crawl_jitter(interval: float, jitter_max: float) -> float:
    jitter = random.uniform(-jitter_max, jitter_max)
    return max(30.0, interval + jitter)

def deduplicate_pipeline_queue(queue: list, new_item: dict) -> bool:
    raw_id = new_item.get("id")
    title = (new_item.get("title") or "").strip()
    if any(i.get("id") == raw_id or (title and (i.get("title") or "").strip() == title) for i in queue):
        return False
    queue.append(new_item)
    return True

class TestPipelineScheduler(unittest.TestCase):
    def test_crawl_jitter_bounds(self):
        interval = 180.0
        jitter_max = 20.0
        for _ in range(50):
            val = calculate_crawl_jitter(interval, jitter_max)
            self.assertGreaterEqual(val, 160.0)
            self.assertLessEqual(val, 200.0)

    def test_queue_deduplication(self):
        queue = []
        item1 = {"id": "art_101", "title": "पटना में जलजमाव"}
        item2 = {"id": "art_102", "title": "पटना में जलजमाव"} # Duplicate title
        item3 = {"id": "art_101", "title": "गया में बिजली संकट"} # Duplicate ID
        item4 = {"id": "art_103", "title": "मुजफ्फरपुर में सड़क मरम्मत"} # Unique

        self.assertTrue(deduplicate_pipeline_queue(queue, item1))
        self.assertFalse(deduplicate_pipeline_queue(queue, item2))
        self.assertFalse(deduplicate_pipeline_queue(queue, item3))
        self.assertTrue(deduplicate_pipeline_queue(queue, item4))
        self.assertEqual(len(queue), 2)

    def test_telemetry_metrics_ratio(self):
        total_proc = 100
        grievances = 65
        ratio = round(grievances / max(1, total_proc), 3)
        self.assertEqual(ratio, 0.65)

if __name__ == "__main__":
    unittest.main()
