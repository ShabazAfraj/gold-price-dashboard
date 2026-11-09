# Data sources and interpretation

**Checked:** 10 November 2026. Values below describe the source pages at that time; the collector reads their current page content on every run.

## Retail bar prices

Source: [Gold.de gold-bar comparison](https://www.gold.de/kaufen/goldbarren/)

The comparison page provides category links for standard bar sizes and displays prices in the form `ab … EUR` (from-price). The collector recognizes those category links, ignores sizes below 1g or above 1000g, and records the lowest displayed `ab` price for each denomination. At the time checked, the page exposed 1g, 2g, 2.5g, 5g, 10g, 20g, 25g, 1/2 oz, 1 oz, 50g, 100g, 250g, 500g, and 1kg categories. Ounce sizes are stored with their troy-ounce gram conversion. The list is discovered from the page rather than hard-coded, so the set can change if Gold.de changes its categories.

A category's `ab` price is the displayed lowest offer, not a guaranteed checkout total. Shipping, availability, and retailer terms may affect the actual purchase price. Only category-level lowest prices are captured; individual dealer offers are not.

## Gold spot price

Source: [Gold.de gold-price page](https://www.gold.de/kurse/goldpreis/)

The page describes the quote as the gold market/spot price and displays EUR per fine troy ounce, alongside EUR/g and a quote-time indicator. The collector records the EUR/g fine-gold quote and the page's displayed quote time when present. Gold.de states that one troy ounce is exactly 31.1034768 grams and that non-USD quotes are derived from the USD gold price using the current exchange rate. Retail premium is calculated as `lowest bar price ÷ bar weight − spot EUR/g`; the premium percentage is `retail EUR/g ÷ spot EUR/g − 1`.

## Migrated history

The initial long-format dataset includes all **616** rows from the original tracker CSV ([source file](https://github.com/ShabazAfraj/gold-price-tracker/blob/main/gold_prices.csv)), covering 14 August through 9 November 2026. The previous file contains complete 20g, 50g, and 100g prices for every row but has no spot-price field. Those migrated retail observations therefore retain an empty spot value; spot comparison begins with the first new collection and is never backfilled or fabricated.

## Crawl behavior

The collector reads only the public bar-comparison page and gold-price page, with low request volume (two page requests per hourly run), a descriptive User-Agent, timeouts, and bounded retries. It does not call Gold.de's `/data/`, `/ajax/`, `/cronjob/`, or `/goto/` paths, which are disallowed in its robots.txt. If either page is unavailable, the spot cannot be parsed, or the category page appears structurally incomplete, the collector exits without appending a snapshot.
