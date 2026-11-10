import csv
import tempfile
import unittest
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

from scripts.collect_prices import (
    REQUIRED_STANDARD_DENOMINATIONS,
    parse_catalog,
    parse_euro_amount,
    parse_spot,
    parse_weight_slug,
    migrate_legacy_rows,
    validate_catalog,
)


class CollectorParsingTests(unittest.TestCase):
    def test_german_euro_amount(self):
        self.assertEqual(parse_euro_amount("11.914,25"), Decimal("11914.25"))

    def test_standard_and_fractional_weights(self):
        self.assertEqual(parse_weight_slug("2-5-gramm"), (Decimal("2.5"), "2.5 g"))
        self.assertEqual(parse_weight_slug("500-gramm"), (Decimal("500"), "500 g"))
        half_ounce = parse_weight_slug("1-2-oz")
        assert half_ounce is not None
        self.assertEqual(half_ounce[1], "1/2 oz")
        one_ounce = parse_weight_slug("1-oz")
        assert one_ounce is not None
        self.assertAlmostEqual(float(one_ounce[0]), 31.1034768)
        self.assertEqual(parse_weight_slug("1kg"), (Decimal("1000"), "1 kg"))
        self.assertIsNone(parse_weight_slug("geschenkbarren"))

    def test_catalog_validation_rejects_a_partial_list_with_many_valid_rows(self):
        catalog = [
            {
                "weight_g": Decimal("1"),
                "denomination": denomination,
                "price": Decimal("100.00"),
                "availability": "available",
                "offer_url": "https://www.gold.de/kaufen/goldbarren/",
            }
            for denomination in sorted(REQUIRED_STANDARD_DENOMINATIONS)
        ]
        with self.assertRaisesRegex(RuntimeError, "missing expected standard denominations"):
            validate_catalog(catalog[:-1])

    def test_catalog_uses_lowest_price_and_limits_weight_range(self):
        html = """
        <a href="/kaufen/goldbarren/1-gramm/">1 g Goldbarren ab 123,00 EUR</a>
        <a href="/kaufen/goldbarren/1-gramm/">1 g Goldbarren ab 121,50 EUR</a>
        <a href="/kaufen/goldbarren/1-2-oz/">1/2 oz Goldbarren ab 1.881,40 EUR</a>
        <a href="/kaufen/goldbarren/500-gramm/">500 g Goldbarren ab 59.559,00 EUR</a>
        <a href="/kaufen/goldbarren/1kg/">1 kg Goldbarren keine Angebote</a>
        <a href="/kaufen/goldbarren/400-oz/">400 oz Goldbarren ab 100.000,00 EUR</a>
        <a href="/kaufen/goldbarren/weitere/">Weitere Einheiten ab 64,36 EUR 0,5 g</a>
        """
        catalog = parse_catalog(html)
        by_label = {item["denomination"]: item for item in catalog}
        self.assertEqual(by_label["1 g"]["price"], Decimal("121.50"))
        self.assertIn("1/2 oz", by_label)
        self.assertEqual(by_label["1 kg"]["availability"], "no_offer")
        self.assertNotIn("400 oz", by_label)
        self.assertEqual(len(catalog), 4)

    def test_spot_parser_uses_eur_per_gram_and_quote_timestamp(self):
        html = """
        <html><body>
        GOLD 4.142,83 $/oz 3.691,15 €/oz 118,67 €/g 118.673 €/kg
        <p>Aktueller Goldpreis in Euro am 10.11.2026</p>
        <div>Stand: 00:30 Uhr in 30 Sek.</div>
        </body></html>
        """
        captured = datetime(2026, 11, 9, 23, 31, tzinfo=timezone.utc)
        spot, quote_at = parse_spot(html, captured)
        self.assertEqual(spot, Decimal("118.67"))
        self.assertEqual(quote_at, "2026-11-09T23:30:00+00:00")

    def test_spot_parser_leaves_quote_time_blank_when_source_does_not_show_one(self):
        html = "<p>GOLD 4.142,83 $/oz 3.691,15 €/oz 118,67 €/g</p>"
        captured = datetime(2026, 11, 9, 23, 31, tzinfo=timezone.utc)
        spot, quote_at = parse_spot(html, captured)
        self.assertEqual(spot, Decimal("118.67"))
        self.assertEqual(quote_at, "")

    def test_legacy_migration_preserves_each_old_weight_and_leaves_spot_unknown(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "old.csv"
            path.write_text(
                "timestamp,price_20g_eur,price_50g_eur,price_100g_eur\n"
                "2026-11-01T00:00:00+00:00,2400.00,6000.00,12000.00\n",
                encoding="utf-8",
            )
            rows = migrate_legacy_rows(path)
        self.assertEqual(len(rows), 3)
        self.assertEqual([row["weight_g"] for row in rows], ["20", "50", "100"])
        self.assertTrue(all(row["spot_eur_per_g"] == "" for row in rows))
        self.assertEqual(rows[0]["retail_eur_per_g"], "120.000000")


if __name__ == "__main__":
    unittest.main()
