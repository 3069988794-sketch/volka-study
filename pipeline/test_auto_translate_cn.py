from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent


def load_module():
    spec = importlib.util.spec_from_file_location("auto_translate_cn", ROOT / "auto_translate_cn.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class AutoTranslateCnTests(unittest.TestCase):
    def test_build_pending_items_skips_existing_translations(self):
        auto = load_module()
        gaps = [
            {"sense_id": "s000001", "gloss_en": "first gloss", "example_en": "First example."},
            {"sense_id": "s000002", "gloss_en": "second gloss", "example_en": "Second example."},
        ]

        pending = auto.build_pending_items(
            gaps,
            existing={"s000001": {"gloss_cn": "已有", "example_cn": "已有例句。"}},
            limit=None,
        )

        self.assertEqual([item["sense_id"] for item in pending], ["s000002"])

    def test_translate_items_writes_valid_shard(self):
        auto = load_module()

        class FakeTranslator:
            def translate_many(self, texts):
                return [f"中:{text}" for text in texts]

        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "part_auto_mt_001.json"
            count = auto.translate_items(
                [
                    {"sense_id": "s000001", "gloss_en": "simple gloss", "example_en": "A simple example."},
                    {"sense_id": "s000002", "gloss_en": "another gloss", "example_en": "Another example."},
                ],
                translator=FakeTranslator(),
                output_path=out,
                chunk_size=1,
                delay_seconds=0,
            )

            payload = json.loads(out.read_text(encoding="utf-8"))

        self.assertEqual(count, 2)
        self.assertEqual(set(payload), {"translations"})
        self.assertEqual(set(payload["translations"]), {"s000001", "s000002"})
        self.assertEqual(payload["translations"]["s000001"]["gloss_cn"], "中:simple gloss")
        self.assertEqual(payload["translations"]["s000002"]["example_cn"], "中:Another example.")

    def test_mymemory_parser_rejects_error_payload(self):
        auto = load_module()

        with self.assertRaises(RuntimeError):
            auto.parse_mymemory_payload({"responseStatus": 429, "responseDetails": "quota"})

    def test_split_pair_translation_accepts_spaced_marker(self):
        auto = load_module()

        self.assertEqual(
            auto.split_pair_translation("短释义\n@ @ EXAMPLE @ @\n自然例句。"),
            ("短释义", "自然例句。"),
        )

    def test_continue_on_error_records_failed_sense_id(self):
        auto = load_module()

        class FailingPairTranslator:
            def translate_many(self, texts):
                raise AssertionError("pair path should be used")

            def translate_pairs(self, items):
                if items[0]["sense_id"] == "s000002":
                    raise RuntimeError("rate limited")
                return [("释义", "例句。")]

        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "part_auto_mt_001.json"
            count = auto.translate_items(
                [
                    {"sense_id": "s000001", "gloss_en": "one", "example_en": "One."},
                    {"sense_id": "s000002", "gloss_en": "two", "example_en": "Two."},
                ],
                translator=FailingPairTranslator(),
                output_path=out,
                chunk_size=1,
                delay_seconds=0,
                continue_on_error=True,
            )
            payload = json.loads(out.read_text(encoding="utf-8"))
            errors = json.loads(out.with_suffix(out.suffix + ".errors.json").read_text(encoding="utf-8"))

        self.assertEqual(count, 1)
        self.assertEqual(set(payload["translations"]), {"s000001"})
        self.assertIn("s000002", errors["errors"])


if __name__ == "__main__":
    unittest.main()
