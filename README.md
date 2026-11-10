# gold-price-dashboard

Personal dashboard for gold bar price history, retail EUR/g comparisons, and EUR spot price.

**Live dashboard:** [Gold Ledger](https://shabazafraj.github.io/gold-price-dashboard/).

## Dashboard

A responsive, public dashboard for the lowest listed Gold.de gold-bar prices from 1g to 1000g, compared with the EUR fine-gold spot price per gram. The page provides denomination cards, selectable retail €/g chart series, a full capture ledger, and CSV export.

The collector discovers standard denomination links on Gold.de's gold-bar comparison page. It records the lowest displayed `ab` price per denomination, including ounce sizes when they fall within the 1g–1000g range. It does not collect every dealer listing. The spot series is captured from Gold.de's gold-price page, which quotes the EUR market price for fine gold. Every collection stores the UTC capture time and the spot quote time when the source exposes one.

The long-format file [`public/data/history.csv`](public/data/history.csv) is the durable data source. Each row represents one denomination at one collection time and includes total retail price, calculated retail EUR/g, spot EUR/g, availability, and source links. The previous tracker's complete 20g, 50g, and 100g observations are migrated into this format on the first collection. Those legacy rows have no spot value because the earlier collector did not record spot prices; the spot comparison begins with the new collector's first run.

Prices are the amounts shown by the source and may exclude shipping or change before purchase. Retail bar prices and the fine-gold spot quote are different measures. This dashboard is a personal reference, not investment advice.

See [`DATA_SOURCES.md`](DATA_SOURCES.md) for source interpretation and migration coverage.

## Run locally

```bash
python -m pip install -r requirements.txt
python scripts/collect_prices.py --dry-run
python scripts/collect_prices.py
python -m unittest discover -s tests
python -m http.server 3000 --directory public
```

The scheduled GitHub Actions workflow runs once per hour and can also be started manually from the Actions tab. The GitHub Pages workflow publishes the `public/` dashboard assets whenever `main` changes. A collection failure stops the run without appending a partial or malformed snapshot.

## Data sources

- Retail offers and denomination links: [Gold.de gold-bar comparison](https://www.gold.de/kaufen/goldbarren/)
- EUR spot quote: [Gold.de gold-price page](https://www.gold.de/kurse/goldpreis/)
- Legacy observations: [the original tracker CSV](https://github.com/ShabazAfraj/gold-price-tracker/blob/main/gold_prices.csv)
