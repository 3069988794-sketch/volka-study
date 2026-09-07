from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent


def load_module(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class CnPipelineTests(unittest.TestCase):
    def test_seed_key_matches_enriched_sense_shape(self):
        translate = load_module("translate_cn", "3_translate_cn.py")
        sense = {
            "headword": "I",
            "pos": "pron.",
            "level": "A1",
            "gloss_en": "the speaker, as the subject of a verb",
        }

        self.assertEqual(
            translate.seed_key(sense),
            "I|pron.|A1|the speaker, as the subject of a verb",
        )

    def test_apply_cn_sources_prefers_cache_over_seed(self):
        translate = load_module("translate_cn", "3_translate_cn.py")
        senses = [
            {
                "sense_id": "s000001",
                "natural_key": "I|pron.|A1|1",
                "headword": "I",
                "pos": "pron.",
                "level": "A1",
                "gloss_en": "the speaker, as the subject of a verb",
                "example_en": "I drink coffee in the morning.",
            }
        ]
        seeds = {"I|pron.|A1|the speaker, as the subject of a verb": "说话者，作动词主语"}
        cache = {
            "s000001": {
                "gloss_cn": "我；说话者本人",
                "example_cn": "我早上喝咖啡。",
            }
        }

        merged, gaps = translate.apply_cn_sources(senses, seeds, cache)

        self.assertEqual(gaps, [])
        self.assertEqual(merged[0]["gloss_cn"], "我；说话者本人")
        self.assertEqual(merged[0]["example_cn"], "我早上喝咖啡。")

    def test_missing_example_translation_is_reported_even_when_seed_has_gloss(self):
        translate = load_module("translate_cn", "3_translate_cn.py")
        senses = [
            {
                "sense_id": "s000001",
                "natural_key": "I|pron.|A1|1",
                "headword": "I",
                "pos": "pron.",
                "level": "A1",
                "gloss_en": "the speaker, as the subject of a verb",
                "example_en": "I drink coffee in the morning.",
                "priority": "T0",
                "freq_rank": 7,
            }
        ]
        seeds = {"I|pron.|A1|the speaker, as the subject of a verb": "说话者，作动词主语"}

        merged, gaps = translate.apply_cn_sources(senses, seeds, {})

        self.assertEqual(merged[0]["gloss_cn"], "说话者，作动词主语")
        self.assertEqual(merged[0]["example_cn"], "")
        self.assertEqual(
            gaps,
            [
                {
                    "sense_id": "s000001",
                    "headword": "I",
                    "level": "A1",
                    "priority": "T0",
                    "freq_rank": 7,
                    "missing": ["example_cn"],
                    "gloss_en": "the speaker, as the subject of a verb",
                    "example_en": "I drink coffee in the morning.",
                }
            ],
        )


if __name__ == "__main__":
    unittest.main()
