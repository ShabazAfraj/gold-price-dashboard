#!/usr/bin/env python3
"""Collect Gold.de bar offers and EUR spot data into an append-only CSV."""
from __future__ import annotations

import argparse
import csv
import re
import sys
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import TypedDict
from urllib.parse import urljoin, urlparse
from zoneinfo import ZoneInfo

import requests
from bs4 import BeautifulSoup
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

ROOT = Path(__file__).resolve().parents[1]
HISTORY_PATH = ROOT / "public" / "data" / "history.csv"
LEGACY_PATH = ROOT / "data" / "legacy_gold_prices.csv"
BAR_LIST_URL = "https://www.gold.de/kaufen/goldbarren/"
SPOT_URL = "https://www.gold.de/kurse/goldpreis/"
TROY_OUNCE_GRAMS = Decimal("31.1034768")
BERLIN = ZoneInfo("Europe/Berlin")

FIELDNAMES = [
    "timestamp_utc",
    "denomination",
    "weight_g",
    "lowest_price_eur",
    "retail_eur_per_g",
    "spot_eur_per_g",
    "spot_quote_at_utc",
    "availability",
    "offer_url",
    "retail_source_url",
    "spot_source_url",
]


class CatalogItem(TypedDict):
    weight_g: Decimal
    denomination: str
    price: Decimal | None
    availability: str
    offer_url: str


PRICE_RE = re.compile(r"\bab\s*([\d.]+,\d{2})\s*EUR\b", re.IGNORECASE)
SPOT_HEADER_RE = re.compile(
    r"\bGOLD\s+[\d.,]+\s+\$/oz\s+[\d.,]+\s+€/oz\s+([\d.,]+)\s+€/g\b",
    re.IGNORECASE,
)

REQUIRED_STANDARD_DENOMINATIONS = frozenset(
    {
        "1 g", "2 g", "2.5 g", "5 g", "10 g", "20 g", "25 g",
        "1/2 oz", "1 oz", "50 g", "100 g", "250 g", "500 g", "1 kg",
    }
)


def normalized_text(value: str) -> str:
    return " ".join(value.replace("\xa0", " ").replace("\u202f", " ").split())


def parse_euro_amount(value: str) -> Decimal:
    """Parse a German-formatted euro value such as 11.914,25."""
    cleaned = value.strip().replace(".", "").replace(",", ".")
    try:
        amount = Decimal(cleaned)
    except InvalidOperation as exc:
        raise ValueError(f"Invalid German euro amount: {value!r}") from exc
    if amount <= 0:
        raise ValueError(f"Euro amount must be positive: {value!r}")
    return amount


def parse_weight_slug(slug: str) -> tuple[Decimal, str] | None:
    """Convert a GOLD.DE category slug into grams and a display denomination."""
    slug = slug.lower().strip("/")

    # Decimal gram denominations use e.g. 2-5-gramm for 2.5 g.
    match = re.fullmatch(r"(\d+)-(\d+)-gramm", slug)
    if match:
        weight = Decimal(f"{match.group(1)}.{match.group(2)}")
        return weight, f"{format(weight.normalize(), 'f')} g"

    match = re.fullmatch(r"(\d+)-gramm", slug)
    if match:
        weight = Decimal(match.group(1))
        return weight, f"{format(weight.normalize(), 'f')} g"

    match = re.fullmatch(r"(\d+)(?:-kg|kg|kilogramm)", slug)
    if match:
        kilograms = Decimal(match.group(1))
        weight = kilograms * Decimal("1000")
        return weight, f"{kilograms.normalize()} kg"

    # Gold.de represents fractional ounces in slugs such as 1-2-oz.
    match = re.fullmatch(r"(\d+)-(\d+)-oz", slug)
    if match:
        numerator = Decimal(match.group(1))
        denominator = Decimal(match.group(2))
        if denominator == 0:
            return None
        weight = TROY_OUNCE_GRAMS * numerator / denominator
        label = f"{match.group(1)}/{match.group(2)} oz"
        return weight, label

    match = re.fullmatch(r"(\d+)-oz", slug)
    if match:
        ounces = Decimal(match.group(1))
        weight = TROY_OUNCE_GRAMS * ounces
        label = f"{ounces.normalize()} oz"
        return weight, label

    return None


def label_from_anchor(text: str, fallback: str) -> str:
    match = re.match(
        r"^\s*(\d+(?:[.,]\d+)?\s*(?:g|kg|oz)|\d+\s*/\s*\d+\s*oz)\s+Goldbarren\b",
        text,
        re.IGNORECASE,
    )
    if match:
        return normalized_text(match.group(1)).replace(",", ".")
    return fallback


def parse_catalog(html: str) -> list[CatalogItem]:
    """Parse weight category links and their cheapest displayed 'ab' prices."""
    soup = BeautifulSoup(html, "html.parser")
    grouped: dict[Decimal, CatalogItem] = {}

    for anchor in soup.find_all("a", href=True):
        href = anchor.get("href")
        if not isinstance(href, str):
            continue
        path = urlparse(urljoin("https://www.gold.de", href)).path
        match = re.fullmatch(r"/kaufen/goldbarren/([^/]+)/?", path)
        if not match:
            continue

        parsed = parse_weight_slug(match.group(1))
        if parsed is None:
            continue
        weight, fallback_label = parsed
        if not Decimal("1") <= weight <= Decimal("1000"):
            continue

        text = normalized_text(anchor.get_text(" ", strip=True))
        if not text:
            continue
        label = label_from_anchor(text, fallback_label)
        item = grouped.setdefault(
            weight,
            {
                "weight_g": weight,
                "denomination": label,
                "price": None,
                "availability": "unknown",
                "offer_url": path,
            },
        )
        # Prefer the visible denomination used on the site's category card.
        if label and item["availability"] == "unknown":
            item["denomination"] = label
        item["offer_url"] = urljoin("https://www.gold.de", path)

        price_match = PRICE_RE.search(text)
        if price_match:
            price = parse_euro_amount(price_match.group(1))
            old_price = item["price"]
            if old_price is None or price < old_price:
                item["price"] = price
                item["availability"] = "available"
        elif "keine angebote" in text.lower() and item["availability"] != "available":
            item["availability"] = "no_offer"

    return [grouped[key] for key in sorted(grouped)]


def parse_spot(html: str, captured_at: datetime) -> tuple[Decimal, str]:
    """Read Gold.de's EUR/g fine-gold spot quote and its displayed quote time."""
    text = normalized_text(BeautifulSoup(html, "html.parser").get_text(" ", strip=True))
    match = SPOT_HEADER_RE.search(text)
    if match:
        spot = parse_euro_amount(match.group(1))
    else:
        # Fallback to the main quote, which is explicitly EUR per fine troy ounce.
        ounce_match = re.search(
            r"Goldpreis\s+in\s+EUR\s+je\s+Feinunze\s*\(31,103\s*g\)\s*([\d.]+,\d{2})\s*EUR",
            text,
            re.IGNORECASE,
        )
        if not ounce_match:
            raise ValueError("Could not identify Gold.de's EUR/g spot quote")
        spot = parse_euro_amount(ounce_match.group(1)) / TROY_OUNCE_GRAMS

    date_match = re.search(
        r"Aktueller Goldpreis in Euro am\s+(\d{2}\.\d{2}\.\d{4})",
        text,
        re.IGNORECASE,
    )
    time_match = re.search(r"Stand:\s*(\d{2}:\d{2})(?::\d{2})?\s*Uhr", text)
    quote_at: datetime | None = None
    if date_match and time_match:
        try:
            local_time = datetime.strptime(
                f"{date_match.group(1)} {time_match.group(1)}", "%d.%m.%Y %H:%M"
            ).replace(tzinfo=BERLIN)
            # A just-after-midnight page can still carry the previous day's quote.
            if local_time > captured_at.astimezone(BERLIN) + timedelta(minutes=5):
                local_time -= timedelta(days=1)
            quote_at = local_time.astimezone(timezone.utc)
        except ValueError:
            pass

    if spot <= 0:
        raise ValueError("Spot price must be positive")
    return spot, quote_at.isoformat(timespec="seconds") if quote_at else ""


def make_session() -> requests.Session:
    retry = Retry(
        total=3,
        connect=3,
        read=2,
        status=3,
        backoff_factor=1.0,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=frozenset({"GET"}),
        respect_retry_after_header=True,
    )
    session = requests.Session()
    session.headers.update(
        {
            "User-Agent": "GoldPriceDashboard/1.0 (+https://github.com/ShabazAfraj/gold-price-dashboard)",
            "Accept-Language": "de-DE,de;q=0.9,en;q=0.7",
        }
    )
    session.mount("https://", HTTPAdapter(max_retries=retry))
    return session


def validate_catalog(catalog: list[CatalogItem]) -> None:
    observed = {item["denomination"] for item in catalog}
    missing = sorted(REQUIRED_STANDARD_DENOMINATIONS - observed)
    if missing:
        raise RuntimeError(
            "Gold.de category list is missing expected standard denominations: "
            f"{', '.join(missing)}. No partial snapshot was saved."
        )

    priced = [item for item in catalog if item["price"] is not None]
    if len(priced) < 6:
        raise RuntimeError(
            f"Only found {len(priced)} priced denominations; the page structure may "
            "have changed, so no partial snapshot was saved."
        )


def fetch_inputs(session: requests.Session) -> tuple[list[CatalogItem], Decimal, str]:
    catalog_response = session.get(BAR_LIST_URL, timeout=25)
    catalog_response.raise_for_status()
    catalog = parse_catalog(catalog_response.text)
    validate_catalog(catalog)

    spot_response = session.get(SPOT_URL, timeout=25)
    spot_response.raise_for_status()
    captured_at = datetime.now(timezone.utc).replace(microsecond=0)
    spot, quote_at = parse_spot(spot_response.text, captured_at)
    return catalog, spot, quote_at


def migrate_legacy_rows(path: Path = LEGACY_PATH) -> list[dict[str, str]]:
    """Convert the old wide CSV into long-format rows; historical spot is unknown."""
    if not path.exists():
        return []
    migrated: list[dict[str, str]] = []
    with path.open(newline="", encoding="utf-8") as handle:
        for old in csv.DictReader(handle):
            timestamp = old.get("timestamp", "").strip()
            if not timestamp:
                continue
            for grams, old_column in (
                (Decimal("20"), "price_20g_eur"),
                (Decimal("50"), "price_50g_eur"),
                (Decimal("100"), "price_100g_eur"),
            ):
                value = old.get(old_column, "").strip()
                if not value:
                    continue
                try:
                    price = Decimal(value)
                except InvalidOperation:
                    continue
                if price <= 0:
                    continue
                weight_key = format(grams.normalize(), "f")
                migrated.append(
                    {
                        "timestamp_utc": timestamp,
                        "denomination": f"{weight_key} g",
                        "weight_g": weight_key,
                        "lowest_price_eur": f"{price:.2f}",
                        "retail_eur_per_g": f"{(price / grams):.6f}",
                        "spot_eur_per_g": "",
                        "spot_quote_at_utc": "",
                        "availability": "available",
                        "offer_url": urljoin(
                            "https://www.gold.de/kaufen/goldbarren/",
                            {"20": "20-gramm/", "50": "50-gramm/", "100": "100-gramm/"}[weight_key],
                        ),
                        "retail_source_url": BAR_LIST_URL,
                        "spot_source_url": SPOT_URL,
                    }
                )
    return migrated


def load_known_denominations(path: Path) -> dict[Decimal, dict[str, str]]:
    known: dict[Decimal, dict[str, str]] = {}
    if not path.exists():
        return known
    with path.open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            try:
                weight = Decimal(row.get("weight_g", ""))
            except (InvalidOperation, TypeError):
                continue
            known[weight] = {
                "denomination": row.get("denomination", f"{weight} g"),
                "offer_url": row.get("offer_url", ""),
            }
    return known


def build_snapshot_rows(
    catalog: list[CatalogItem], spot: Decimal, quote_at: str, captured_at: str, history_path: Path
) -> list[dict[str, str]]:
    current = {item["weight_g"]: item for item in catalog}
    known = load_known_denominations(history_path)
    for item in catalog:
        known[item["weight_g"]] = {
            "denomination": str(item["denomination"]),
            "offer_url": str(item["offer_url"]),
        }

    rows: list[dict[str, str]] = []
    for weight in sorted(known):
        item = current.get(weight)
        metadata = known[weight]
        if item is None:
            price = None
            availability = "not_listed"
            offer_url = metadata["offer_url"]
            denomination = metadata["denomination"]
        else:
            price = item["price"]
            availability = str(item["availability"])
            offer_url = str(item["offer_url"])
            denomination = str(item["denomination"])

        retail_per_g = (price / weight) if price is not None else None
        rows.append(
            {
                "timestamp_utc": captured_at,
                "denomination": denomination,
                "weight_g": format(weight.normalize(), "f"),
                "lowest_price_eur": f"{price:.2f}" if price is not None else "",
                "retail_eur_per_g": f"{retail_per_g:.6f}" if retail_per_g is not None else "",
                "spot_eur_per_g": f"{spot:.6f}",
                "spot_quote_at_utc": quote_at,
                "availability": availability,
                "offer_url": offer_url,
                "retail_source_url": BAR_LIST_URL,
                "spot_source_url": SPOT_URL,
            }
        )
    return rows


def collect(history_path: Path = HISTORY_PATH, legacy_path: Path = LEGACY_PATH) -> int:
    session = make_session()
    catalog, spot, quote_at = fetch_inputs(session)
    captured_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    rows = build_snapshot_rows(catalog, spot, quote_at, captured_at, history_path)

    history_path.parent.mkdir(parents=True, exist_ok=True)
    first_write = not history_path.exists() or history_path.stat().st_size == 0
    migrated = migrate_legacy_rows(legacy_path) if first_write else []

    with history_path.open("a", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDNAMES, lineterminator="\n")
        if first_write:
            writer.writeheader()
            writer.writerows(migrated)
        writer.writerows(rows)

    available = sum(row["availability"] == "available" for row in rows)
    print(
        f"Saved {len(rows)} current denomination rows ({available} with offers), "
        f"spot €{spot:.2f}/g, after migrating {len(migrated)} legacy rows; "
        f"capture {captured_at}."
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="Fetch and parse, but do not append data")
    args = parser.parse_args()

    if args.dry_run:
        session = make_session()
        catalog, spot, quote_at = fetch_inputs(session)
        print(f"Spot: €{spot:.2f}/g (quote {quote_at})")
        for item in catalog:
            price = item["price"]
            print(
                f"{item['denomination']}: "
                f"{('€' + format(price, '.2f')) if price is not None else item['availability']}"
            )
        return 0

    try:
        return collect()
    except (requests.RequestException, ValueError, RuntimeError) as exc:
        print(f"Collection failed; no current snapshot was appended: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
