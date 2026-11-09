(() => {
  "use strict";

  const LIVE_DATA_URL = "https://raw.githubusercontent.com/ShabazAfraj/gold-price-dashboard/main/public/data/history.csv";
  const LOCAL_DATA_URL = "./data/history.csv";
  const SVG_NS = "http://www.w3.org/2000/svg";
  const MAX_SERIES = 4;
  const PAGE_SIZE = 15;
  const CURRENCY = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const NUMBER = new Intl.NumberFormat("en-IE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const SERIES_COLORS = ["#b58b3c", "#8f5947", "#6e8191", "#6f7e57"];

  let rows = [];
  let csvText = "";
  let activeWeights = new Set();
  let activeRange = "30";
  let historyVisibleCount = PAGE_SIZE;
  let dataMode = "loading";
  let rangeCursor = 0;

  const $ = (id) => document.getElementById(id);

  function parseCsvLine(line) {
    const fields = [];
    let value = "";
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (char === '"') {
        if (quoted && line[i + 1] === '"') {
          value += '"';
          i += 1;
        } else {
          quoted = !quoted;
        }
      } else if (char === "," && !quoted) {
        fields.push(value);
        value = "";
      } else {
        value += char;
      }
    }
    fields.push(value);
    return fields;
  }

  function parseCsv(text) {
    const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.length > 0);
    if (lines.length < 2) return [];
    const headers = parseCsvLine(lines[0]);
    return lines.slice(1).map((line) => {
      const cells = parseCsvLine(line);
      const record = {};
      headers.forEach((key, index) => { record[key] = cells[index] ?? ""; });
      return {
        timestamp: record.timestamp_utc,
        time: Date.parse(record.timestamp_utc),
        denomination: record.denomination,
        weight: Number(record.weight_g),
        price: record.lowest_price_eur === "" ? null : Number(record.lowest_price_eur),
        retailPerGram: record.retail_eur_per_g === "" ? null : Number(record.retail_eur_per_g),
        spotPerGram: record.spot_eur_per_g === "" ? null : Number(record.spot_eur_per_g),
        spotQuotedAt: record.spot_quote_at_utc,
        availability: record.availability,
        offerUrl: record.offer_url,
        retailSource: record.retail_source_url,
        spotSource: record.spot_source_url,
      };
    }).filter((row) => Number.isFinite(row.time) && Number.isFinite(row.weight));
  }

  async function requestCsv(url) {
    const separator = url.includes("?") ? "&" : "?";
    const response = await fetch(`${url}${separator}v=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`Data request failed (${response.status})`);
    return response.text();
  }

  function uniqueWeights() {
    const values = new Map();
    [...rows].sort((a, b) => a.time - b.time).forEach((row) => {
      if (!values.has(row.weight) || row.denomination) values.set(row.weight, row.denomination);
    });
    return [...values.entries()].sort((a, b) => a[0] - b[0]).map(([weight, label]) => ({ weight, label }));
  }

  function latestRowsByWeight() {
    const latest = new Map();
    [...rows].sort((a, b) => a.time - b.time).forEach((row) => latest.set(row.weight, row));
    return latest;
  }

  function latestCapture() {
    let capture = null;
    rows.forEach((row) => { if (!capture || row.time > capture.time) capture = row; });
    return capture;
  }

  function latestSpot() {
    return [...rows].filter((row) => row.spotPerGram !== null).sort((a, b) => b.time - a.time)[0] || null;
  }

  function formatMoney(value) {
    return Number.isFinite(value) ? CURRENCY.format(value) : "—";
  }

  function formatPerGram(value) {
    return Number.isFinite(value) ? `${CURRENCY.format(value)} / g` : "—";
  }

  function formatPercent(value) {
    if (!Number.isFinite(value)) return "—";
    const sign = value > 0 ? "+" : "";
    return `${sign}${NUMBER.format(value)}%`;
  }

  function formatDate(value, includeTime = true) {
    if (!Number.isFinite(value)) return "—";
    const options = includeTime
      ? { dateStyle: "medium", timeStyle: "short" }
      : { month: "short", day: "numeric" };
    return new Intl.DateTimeFormat(undefined, options).format(new Date(value));
  }

  function formatTime(value) {
    if (!value) return "—";
    const time = Date.parse(value);
    return Number.isFinite(time) ? formatDate(time) : "—";
  }

  function formatAge(minutes) {
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${Math.floor(minutes)} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hr${hours === 1 ? "" : "s"} ago`;
    const days = Math.floor(hours / 24);
    return `${days} day${days === 1 ? "" : "s"} ago`;
  }

  function setStatus(state, message) {
    const pill = $("status-pill");
    pill.dataset.state = state;
    $("collector-status").textContent = message;
  }

  function renderHeader() {
    const capture = latestCapture();
    const captureAt = capture ? capture.time : NaN;
    if (!Number.isFinite(captureAt)) {
      setStatus("unavailable", "No price history available");
      $("last-updated").textContent = "Waiting for the first successful collection";
      return;
    }
    const ageMinutes = Math.max(0, (Date.now() - captureAt) / 60000);
    $("last-updated").textContent = `Last successful capture · ${formatDate(captureAt)}`;
    if (ageMinutes > 120) setStatus("stale", `Stale · ${formatAge(ageMinutes)}`);
    else if (dataMode === "fallback") setStatus("stale", `Bundled history · ${formatAge(ageMinutes)}`);
    else setStatus("fresh", `Collector active · ${formatAge(ageMinutes)}`);
    $("data-source-status").textContent = dataMode === "live"
      ? "Reading the public GitHub history"
      : "Showing bundled history; live feed unavailable";
  }

  function selectedHistoryWeight() {
    const select = $("history-weight-select");
    return Number(select.value);
  }

  function renderMetrics() {
    const spot = latestSpot();
    const selectedWeight = selectedHistoryWeight();
    const selectedLabel = uniqueWeights().find((entry) => entry.weight === selectedWeight)?.label || "Selected denomination";
    const current = latestRowsByWeight().get(selectedWeight);
    $("spot-value").textContent = spot ? CURRENCY.format(spot.spotPerGram) : "—";
    $("spot-quoted-at").textContent = spot ? `Gold.de quote · ${formatTime(spot.spotQuotedAt)}` : "Spot comparison not yet available";
    $("retail-size-label").textContent = selectedLabel;
    $("premium-size-label").textContent = `For ${selectedLabel}`;

    if (current && current.availability === "available" && current.price !== null) {
      $("retail-value").textContent = formatMoney(current.price);
      $("retail-per-gram").textContent = `Retail ${formatPerGram(current.retailPerGram)}`;
      if (spot) {
        const delta = current.retailPerGram - spot.spotPerGram;
        const percentage = (current.retailPerGram / spot.spotPerGram - 1) * 100;
        $("premium-value").textContent = formatMoney(delta);
        $("premium-percent").textContent = `${formatPercent(percentage)} per gram vs spot`;
      } else {
        $("premium-value").textContent = "—";
        $("premium-percent").textContent = "Spot comparison unavailable";
      }
    } else {
      $("retail-value").textContent = current?.availability === "no_offer" ? "No offer" : "—";
      $("retail-per-gram").textContent = "Retail €/g —";
      $("premium-value").textContent = "—";
      $("premium-percent").textContent = "No current retail comparison";
    }
    $("observation-count").textContent = new Intl.NumberFormat().format(rows.length);
    $("tracked-size-count").textContent = `${uniqueWeights().length} distinct denominations in the ledger`;
    $("tracked-size-range").textContent = `01—${String(uniqueWeights().length).padStart(2, "0")}`;
  }

  function safeGoldUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.hostname === "www.gold.de" ? url.href : "https://www.gold.de/kaufen/goldbarren/";
    } catch (_) {
      return "https://www.gold.de/kaufen/goldbarren/";
    }
  }

  function renderOffers() {
    const grid = $("offer-grid");
    grid.replaceChildren();
    const capture = latestCapture();
    const currentByWeight = latestRowsByWeight();
    $("offers-captured-at").textContent = capture ? `Latest capture · ${formatDate(capture.time)}` : "No capture available";

    uniqueWeights().forEach(({ weight, label }) => {
      const item = currentByWeight.get(weight);
      const card = document.createElement("article");
      card.className = "offer-card";
      const top = document.createElement("div");
      top.className = "offer-card-top";
      const denomination = document.createElement("span");
      denomination.className = "offer-denomination";
      denomination.textContent = label;
      const status = document.createElement("span");
      const available = Boolean(item && item.availability === "available" && item.price !== null);
      status.className = "offer-status";
      status.dataset.state = available ? "available" : "unavailable";
      status.textContent = available ? "Listed" : item?.availability === "no_offer" ? "No offer" : "Unavailable";
      top.append(denomination, status);
      card.append(top);

      const price = document.createElement("p");
      price.className = available ? "offer-price" : "offer-price offer-price-unavailable";
      price.textContent = available ? formatMoney(item.price) : item?.availability === "no_offer" ? "No current offer" : "Not listed";
      card.append(price);

      const unit = document.createElement("div");
      unit.className = "offer-meta";
      const unitLabel = document.createElement("span");
      unitLabel.textContent = "Retail / g";
      const unitValue = document.createElement("strong");
      unitValue.textContent = available ? formatMoney(item.retailPerGram) : "—";
      unit.append(unitLabel, unitValue);
      card.append(unit);

      const premium = document.createElement("div");
      premium.className = "offer-meta";
      const premiumLabel = document.createElement("span");
      premiumLabel.textContent = "Premium / g";
      const premiumValue = document.createElement("strong");
      const spot = latestSpot();
      premiumValue.textContent = available && spot ? formatMoney(item.retailPerGram - spot.spotPerGram) : "—";
      premium.append(premiumLabel, premiumValue);
      card.append(premium);

      const link = document.createElement("a");
      link.className = "offer-link";
      link.href = safeGoldUrl(item?.offerUrl || "");
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Open Gold.de category ↗";
      card.append(link);
      grid.append(card);
    });
  }

  function renderWeightControls() {
    const weights = uniqueWeights();
    const preferred = weights.find((entry) => entry.weight === 100) || weights[0];
    if (!activeWeights.size && preferred) activeWeights.add(preferred.weight);
    const chips = $("weight-chips");
    chips.replaceChildren();
    weights.forEach(({ weight, label }) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "weight-chip";
      button.dataset.weight = String(weight);
      button.setAttribute("aria-pressed", String(activeWeights.has(weight)));
      button.textContent = label;
      button.addEventListener("click", () => {
        if (activeWeights.has(weight)) {
          if (activeWeights.size > 1) activeWeights.delete(weight);
        } else if (activeWeights.size < MAX_SERIES) {
          activeWeights.add(weight);
        } else {
          $("chart-summary").textContent = `Choose up to ${MAX_SERIES} retail sizes at once.`;
          return;
        }
        renderWeightControls();
        renderChart();
      });
      chips.append(button);
    });
  }

  function renderWeightSelect() {
    const select = $("history-weight-select");
    const existing = Number(select.value);
    select.replaceChildren();
    uniqueWeights().forEach(({ weight, label }) => {
      const option = document.createElement("option");
      option.value = String(weight);
      option.textContent = label;
      select.append(option);
    });
    const next = uniqueWeights().some((entry) => entry.weight === existing)
      ? existing
      : (uniqueWeights().find((entry) => entry.weight === 100)?.weight ?? uniqueWeights()[0]?.weight);
    if (next !== undefined) select.value = String(next);
  }

  function svgElement(name, attributes = {}) {
    const node = document.createElementNS(SVG_NS, name);
    Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
    return node;
  }

  function addSvgText(svg, text, x, y, anchor = "start", className = "chart-axis-label") {
    const node = svgElement("text", { x, y, "text-anchor": anchor, class: className });
    node.textContent = text;
    svg.append(node);
  }

  function chartSeries() {
    const rangeRows = getRowsInRange();
    const series = [];
    const spotByTime = new Map();
    rangeRows.forEach((row) => {
      if (row.spotPerGram !== null) spotByTime.set(row.time, row.spotPerGram);
    });
    const spotPoints = [...spotByTime.entries()].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time, value }));
    if (spotPoints.length) series.push({ key: "spot", label: "Gold spot", color: "#315c4c", points: spotPoints });

    const weightMap = new Map(uniqueWeights().map((entry) => [entry.weight, entry.label]));
    [...activeWeights].sort((a, b) => a - b).forEach((weight, index) => {
      const points = rangeRows
        .filter((row) => row.weight === weight && row.availability === "available" && row.retailPerGram !== null)
        .map((row) => ({ time: row.time, value: row.retailPerGram }))
        .sort((a, b) => a.time - b.time);
      if (points.length) series.push({ key: String(weight), label: `${weightMap.get(weight) || `${weight} g`} retail`, color: SERIES_COLORS[index % SERIES_COLORS.length], points });
    });
    return series;
  }

  function getRowsInRange() {
    if (activeRange === "all") return rows;
    const days = Number(activeRange);
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    return rows.filter((row) => row.time >= cutoff);
  }

  function renderChart() {
    const svg = $("price-chart");
    const empty = $("chart-empty");
    svg.replaceChildren();
    const series = chartSeries();
    const values = series.flatMap((item) => item.points.map((point) => point.value));
    const rangeRows = getRowsInRange();
    if (!values.length || !rangeRows.length) {
      svg.hidden = true;
      empty.hidden = false;
      $("chart-legend").replaceChildren();
      $("chart-summary").textContent = `No observations in this range · ${rangeRows.length} rows checked`;
      return;
    }
    svg.hidden = false;
    empty.hidden = true;
    const width = 1000;
    const height = 360;
    const left = 76;
    const right = 20;
    const top = 18;
    const bottom = 45;
    const plotWidth = width - left - right;
    const plotHeight = height - top - bottom;
    const times = series.flatMap((item) => item.points.map((point) => point.time));
    const minTime = Math.min(...times);
    const maxTime = Math.max(...times);
    let minValue = Math.min(...values);
    let maxValue = Math.max(...values);
    const spread = maxValue - minValue;
    const padding = spread === 0 ? Math.max(maxValue * 0.015, 1) : spread * 0.14;
    minValue -= padding;
    maxValue += padding;
    if (minTime === maxTime) {
      rangeCursor += 1;
    }
    const xScale = (value) => left + (maxTime === minTime ? plotWidth / 2 : ((value - minTime) / (maxTime - minTime)) * plotWidth);
    const yScale = (value) => top + ((maxValue - value) / (maxValue - minValue)) * plotHeight;

    for (let tick = 0; tick <= 4; tick += 1) {
      const y = top + (plotHeight / 4) * tick;
      const value = maxValue - ((maxValue - minValue) / 4) * tick;
      svg.append(svgElement("line", { x1: left, x2: width - right, y1: y, y2: y, class: "chart-grid" }));
      addSvgText(svg, CURRENCY.format(value), left - 12, y + 4, "end");
    }

    const labelCount = Math.min(4, Math.max(2, Math.floor(plotWidth / 210)));
    for (let tick = 0; tick <= labelCount; tick += 1) {
      const fraction = tick / labelCount;
      const x = left + fraction * plotWidth;
      const time = minTime + fraction * (maxTime - minTime);
      addSvgText(svg, formatDate(time, false), x, height - 13, tick === 0 ? "start" : tick === labelCount ? "end" : "middle");
    }

    series.forEach((item) => {
      if (!item.points.length) return;
      const pathData = item.points.map((point, index) => `${index === 0 ? "M" : "L"}${xScale(point.time).toFixed(2)},${yScale(point.value).toFixed(2)}`).join(" ");
      svg.append(svgElement("path", { d: pathData, class: "chart-line", stroke: item.color }));
      const last = item.points[item.points.length - 1];
      svg.append(svgElement("circle", { cx: xScale(last.time), cy: yScale(last.value), r: 4.6, class: "chart-endpoint", fill: item.color }));
    });

    const legend = $("chart-legend");
    legend.replaceChildren();
    series.forEach((item) => {
      const entry = document.createElement("span");
      entry.className = "legend-item";
      const swatch = document.createElement("i");
      swatch.className = "legend-swatch";
      swatch.style.backgroundColor = item.color;
      const label = document.createElement("span");
      label.textContent = item.label;
      entry.append(swatch, label);
      legend.append(entry);
    });
    const retailLabels = series.filter((item) => item.key !== "spot").map((item) => item.label.replace(" retail", ""));
    const spotLength = series.find((item) => item.key === "spot")?.points.length || 0;
    $("chart-summary").textContent = `${retailLabels.join(" + ") || "Retail €/g"}${spotLength ? " compared with spot €/g" : " · spot history begins with the new collector"}`;
  }

  function renderHistoryTable() {
    const selectedWeight = selectedHistoryWeight();
    const selectedLabel = uniqueWeights().find((entry) => entry.weight === selectedWeight)?.label || "selected bar";
    const observations = rows
      .filter((row) => row.weight === selectedWeight)
      .sort((a, b) => b.time - a.time);
    const visible = observations.slice(0, historyVisibleCount);
    const body = $("history-table-body");
    body.replaceChildren();
    visible.forEach((row) => {
      const tr = document.createElement("tr");
      const delta = row.spotPerGram !== null && row.retailPerGram !== null ? row.retailPerGram - row.spotPerGram : null;
      const cells = [
        formatDate(row.time),
        formatMoney(row.price),
        formatMoney(row.retailPerGram),
        formatMoney(row.spotPerGram),
        delta === null ? "—" : formatMoney(delta),
      ];
      cells.forEach((value, index) => {
        const td = document.createElement("td");
        td.textContent = value;
        if (index === 0) td.title = row.timestamp;
        tr.append(td);
      });
      body.append(tr);
    });
    $("history-row-count").textContent = `${visible.length} of ${observations.length} captures · ${selectedLabel}`;
    $("show-earlier").hidden = visible.length >= observations.length;
  }

  function setActiveRange(value) {
    activeRange = value;
    document.querySelectorAll(".range-button").forEach((button) => {
      const active = button.dataset.range === value;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    renderChart();
  }

  function bindControls() {
    document.querySelectorAll(".range-button").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.range === activeRange));
      button.addEventListener("click", () => setActiveRange(button.dataset.range));
    });
    $("download-csv").addEventListener("click", () => {
      const blob = new Blob([csvText], { type: "text/csv;charset=utf-8" });
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = "gold-price-history.csv";
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(href);
    });
    $("show-earlier").addEventListener("click", () => {
      historyVisibleCount += PAGE_SIZE;
      renderHistoryTable();
    });
  }

  async function initialize() {
    bindControls();
    try {
      csvText = await requestCsv(LIVE_DATA_URL);
      dataMode = "live";
    } catch (_) {
      try {
        csvText = await requestCsv(LOCAL_DATA_URL);
        dataMode = "fallback";
      } catch (error) {
        dataMode = "unavailable";
        setStatus("unavailable", "Price history unavailable");
        $("data-source-status").textContent = "No data file could be loaded";
        $("chart-empty").hidden = false;
        $("chart-empty").textContent = "The history file could not be loaded. Try again later.";
        $("chart-summary").textContent = "Price history unavailable";
        console.error("Could not load the gold price history", error);
        return;
      }
    }

    rows = parseCsv(csvText);
    if (!rows.length) {
      setStatus("unavailable", "No observations in price history");
      $("chart-empty").hidden = false;
      $("chart-empty").textContent = "The history file has no usable observations yet.";
      return;
    }

    renderWeightSelect();
    const initialWeight = uniqueWeights().find((entry) => entry.weight === 100) || uniqueWeights()[0];
    if (initialWeight) {
      $("history-weight-select").value = String(initialWeight.weight);
      activeWeights.add(initialWeight.weight);
    }
    $("history-weight-select").addEventListener("change", () => {
      historyVisibleCount = PAGE_SIZE;
      renderMetrics();
      renderHistoryTable();
    });
    renderHeader();
    renderMetrics();
    renderOffers();
    renderWeightControls();
    renderChart();
    renderHistoryTable();
  }

  initialize();
})();
