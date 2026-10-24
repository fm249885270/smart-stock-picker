'use strict';

const marketdata = require('./marketdata');
const {
  atrPct,
  clamp,
  formatCode,
  higherLowDays,
  mean,
  returnPct,
  round,
  sma,
  stddev,
} = require('./indicators');

const INDEX_DEFS = [
  { secid: '1.000001', code: '000001', name: '上证指数', short: '上证' },
  { secid: '0.399001', code: '399001', name: '深证成指', short: '深证' },
  { secid: '0.399006', code: '399006', name: '创业板指', short: '创业' },
  { secid: '1.000688', code: '000688', name: '科创50', short: '科创' },
];

const SECTOR_BLOCKLIST = /昨日|首亏|预增|预减|扭亏|业绩|融资融券|标准普尔|MSCI|富时|深股通|沪股通|转债|次新股|百元股|低价股|微盘股|壳资源|ST股|破净股|高送转|股权转让|举牌|IPO受益|基金重仓|机构重仓|社保重仓|QFII|养老金|中证|上证50|沪深300|央视50|创业成份|科创板|注册制|同花顺|东方财富|证金持股|汇金持股|中字头|破净|高股息|红利|含B股|含H股|AH股|茅指数|宁组合/;

const contextState = { at: 0, data: null, promise: null };
const screenState = { key: '', at: 0, data: null, promise: null };
const watchState = { key: '', at: 0, data: null, promise: null };

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        results[index] = { error: error.message };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

function shanghaiNowParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hour12: false,
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${map.year}-${map.month}-${map.day}`,
    time: `${map.hour}:${map.minute}:${map.second}`,
    hour: Number(map.hour),
    minute: Number(map.minute),
    weekday: map.weekday,
  };
}

function marketPhase() {
  const now = shanghaiNowParts();
  const weekend = now.weekday === '周六' || now.weekday === '周日';
  const minutes = now.hour * 60 + now.minute;
  const open = !weekend && ((minutes >= 570 && minutes <= 690) || (minutes >= 780 && minutes <= 900));
  let label = '已收盘';
  if (weekend) label = '周末休市';
  else if (open && minutes < 690) label = '早盘交易';
  else if (open) label = '尾盘交易';
  else if (minutes < 570) label = '盘前';
  else if (minutes > 690 && minutes < 780) label = '午间休市';
  return { now, open, label };
}

function applyLivePrice(bars, quotePrice, today) {
  if (!Array.isArray(bars) || !bars.length) return [];
  const next = bars.map((bar) => ({ ...bar }));
  const last = next.at(-1);
  if (quotePrice && last.date === today) last.close = quotePrice;
  return next;
}

function indexMetrics(def, quote, kline, today) {
  const bars = applyLivePrice(kline?.bars || [], quote?.price, today);
  const closes = bars.map((bar) => bar.close).filter(Number.isFinite);
  const close = quote?.price ?? closes.at(-1) ?? null;
  if (close && closes.length) closes[closes.length - 1] = close;
  const ma5 = sma(closes, 5);
  const ma10 = sma(closes, 10);
  const ma20 = sma(closes, 20);
  const ma60 = sma(closes, 60);
  const fiveDay = returnPct(closes, 5);
  const amounts = bars.map((bar) => bar.amount).filter(Number.isFinite);
  const previousAmounts = amounts.slice(-6, -1);
  const amountRatio = mean(previousAmounts) ? (amounts.at(-1) / mean(previousAmounts)) : 1;
  let maScore = 0;
  if (close && ma5 && close >= ma5) maScore += 0.25;
  if (close && ma10 && close >= ma10) maScore += 0.25;
  if (close && ma20 && close >= ma20) maScore += 0.3;
  if (ma5 && ma10 && ma5 >= ma10) maScore += 0.2;
  return {
    ...def,
    name: quote?.name || def.name,
    price: round(close),
    pct: round(quote?.pct ?? bars.at(-1)?.pct ?? 0),
    high: round(quote?.high ?? bars.at(-1)?.high),
    low: round(quote?.low ?? bars.at(-1)?.low),
    amount: quote?.amount ?? bars.at(-1)?.amount ?? 0,
    ma5: round(ma5),
    ma10: round(ma10),
    ma20: round(ma20),
    ma60: round(ma60),
    ret5: round(fiveDay),
    amountRatio: round(amountRatio),
    maScore: round(maScore * 100, 1),
    aboveMa5: Boolean(close && ma5 && close >= ma5),
    aboveMa10: Boolean(close && ma10 && close >= ma10),
    aboveMa20: Boolean(close && ma20 && close >= ma20),
    bars,
  };
}

function buildBreadth(stocks) {
  let up = 0;
  let down = 0;
  let flat = 0;
  let limitUp = 0;
  let limitDown = 0;
  let positiveFlow = 0;
  let validFlow = 0;
  let netInflow = 0;
  let totalAmount = 0;
  let totalTurnover = 0;
  let turnoverCount = 0;
  for (const stock of stocks) {
    const pct = stock.pct ?? 0;
    if (pct > 0.001) up += 1;
    else if (pct < -0.001) down += 1;
    else flat += 1;
    const isStar = stock.code.startsWith('300') || stock.code.startsWith('301') || stock.code.startsWith('688');
    if (pct >= (isStar ? 19.5 : 9.8)) limitUp += 1;
    if (pct <= (isStar ? -19.5 : -9.8)) limitDown += 1;
    if (Number.isFinite(stock.netInflow)) {
      validFlow += 1;
      if (stock.netInflow > 0) positiveFlow += 1;
      netInflow += stock.netInflow;
    }
    totalAmount += stock.amount || 0;
    if (Number.isFinite(stock.turnover)) {
      totalTurnover += stock.turnover;
      turnoverCount += 1;
    }
  }
  const breadthBase = up + down + flat || 1;
  const flowBase = validFlow || 1;
  return {
    up,
    down,
    flat,
    total: stocks.length,
    limitUp,
    limitDown,
    upRatio: up / breadthBase,
    upRatioPct: round((up / breadthBase) * 100, 1),
    positiveFlowRatio: validFlow ? positiveFlow / flowBase : 0.5,
    netInflow,
    netInflowYi: round(netInflow / 100000000, 2),
    totalAmountYi: round(totalAmount / 100000000, 1),
    avgTurnover: round(totalTurnover / (turnoverCount || 1), 2),
  };
}
function computeMarketScore(indexes, breadth, amountRatio) {
  const core = [indexes[0], indexes[2], indexes[3]];
  const avgPct = mean(core.map((item) => item.pct ?? 0)) ?? 0;
  const dispersion = stddev(core.map((item) => item.pct ?? 0));
  const positive = core.filter((item) => (item.pct ?? 0) >= 0).length;
  const consistency = Math.max(positive, core.length - positive) / core.length;
  const upRatio = breadth.upRatio;
  const volumeBonus = clamp((amountRatio - 1) * 14, -8, 8);

  const leadingRaw = clamp(
    42 + (upRatio - 0.5) * 108 + (breadth.positiveFlowRatio - 0.5) * 22 + clamp(breadth.netInflowYi / 90, -5, 7),
    0,
    100,
  );
  const synchronousRaw = clamp(50 + avgPct * 13 + volumeBonus + clamp((breadth.limitUp - breadth.limitDown) / 12, -4, 4), 0, 100);
  const laggingRaw = mean(indexes.map((item) => item.maScore)) ?? 50;
  const structureRaw = clamp(43 + avgPct * 11 + (consistency - 0.5) * 46 - dispersion * 8 + volumeBonus * 0.4, 0, 100);

  const modules = [
    { key: 'leading', name: '领先信号', weight: 35, raw: leadingRaw },
    { key: 'synchronous', name: '同步信号', weight: 15, raw: synchronousRaw },
    { key: 'lagging', name: '滞后慢变', weight: 30, raw: laggingRaw },
    { key: 'structure', name: '结构趋势', weight: 15, raw: structureRaw },
  ];
  for (const item of modules) item.contribution = round((item.raw * item.weight) / 100, 1);
  const score = round(modules.reduce((sum, item) => sum + item.contribution, 0), 1);
  return { modules, score, avgPct, dispersion, consistency, positive };
}

function classifyVolume(amountRatio) {
  if (amountRatio >= 1.1) return '放量';
  if (amountRatio <= 0.9) return '缩量';
  return '平量';
}

function formatSigned(value, digits = 2) {
  if (!Number.isFinite(value)) return '--';
  const rounded = round(value, digits);
  return `${rounded > 0 ? '+' : ''}${rounded}%`;
}

function buildMarketModel(indexes, breadth, market5d, amountRatio) {
  const model = computeMarketScore(indexes, breadth, amountRatio);
  const sse = indexes[0];
  const gem = indexes[2];
  const star = indexes[3];
  const volumeText = classifyVolume(amountRatio);
  const breadthText = breadth.upRatio >= 0.62 ? '宽度偏强' : breadth.upRatio <= 0.38 ? '宽度偏弱' : '宽度均衡';
  const breadthState = breadth.upRatio >= 0.6 ? '普涨' : breadth.upRatio <= 0.4 ? '普跌' : '分化';
  let status = '中性';
  if (model.score >= 62) status = '偏强';
  else if (model.score < 46) status = '防守';
  const sameDirection = (sse.pct >= 0 && gem.pct >= 0 && star.pct >= 0) || (sse.pct < 0 && gem.pct < 0 && star.pct < 0);
  const statusTone = status === '偏强' ? 'up' : status === '防守' ? 'down' : 'warn';
  const summary = status === '偏强'
    ? '市场宽度与趋势共振，可正常选股，但仍只做最强信号。'
    : status === '防守'
      ? '趋势与资金承接偏弱，降低频率，优先保护本金。'
      : '指数分化、量能一般，保持轻仓，等确认后再提高暴露。';

  const modules = model.modules.map((item) => {
    if (item.key === 'leading') {
      item.primary = `涨家数占比 ${breadth.upRatioPct}%`;
      item.secondary = `5日动量 ${formatSigned(market5d)} / 上涨 ${breadth.up} 家`;
    } else if (item.key === 'synchronous') {
      item.primary = `上证 ${formatSigned(sse.pct)}`;
      item.secondary = `量能 ${round(amountRatio, 2)}x / 涨停 ${breadth.limitUp} 家`;
    } else if (item.key === 'lagging') {
      item.primary = `MA5 ${sse.ma5 ?? '--'} / MA10 ${sse.ma10 ?? '--'}`;
      item.secondary = `MA20 ${sse.ma20 ?? '--'} / 收盘 ${sse.price ?? '--'}`;
    } else {
      item.primary = `上证 ${formatSigned(sse.pct)} / 创业 ${formatSigned(gem.pct)} / 科创 ${formatSigned(star.pct)}`;
      item.secondary = `三指数${sameDirection ? '同向' : '分化'} / 离散度 ${round(model.dispersion, 2)}%`;
    }
    item.tone = item.raw >= 58 ? 'up' : item.raw < 44 ? 'down' : 'warn';
    return item;
  });

  return {
    title: '明日大盘预测',
    score: model.score,
    status,
    statusTone,
    passLine: 60,
    passLabel: model.score >= 60 ? '及格线以上' : '及格线以下',
    stateLine: `${volumeText}${breadthState}（${breadthText}）`,
    summary,
    modules,
    core: {
      bull: `${breadth.up}家上涨、上证${sse.aboveMa5 ? '站上' : '位于'}MA5${sse.aboveMa5 ? '上方' : '下方'}`,
      bear: `${breadth.down}家下跌、上证${sse.aboveMa10 ? '守住' : '跌破'}MA10`,
      divergence: `三大指数${sameDirection ? '同向' : '分化'}（上证${formatSigned(sse.pct)} / 创业${formatSigned(gem.pct)} / 科创${formatSigned(star.pct)}）`,
    },
    indexes,
    breadth,
    market5d: round(market5d, 2),
    amountRatio: round(amountRatio, 2),
    volumeState: volumeText,
  };
}

function filterSectorCandidates(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    if (!row.name || !Number.isFinite(row.pct) || SECTOR_BLOCKLIST.test(row.name)) return false;
    const key = row.name.replace(/[ⅠⅡⅢ]/g, '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function analyzeSectorRadar(market5d) {
  const [conceptsRes, industriesRes] = await Promise.all([
    marketdata.getSectorList('concept'),
    marketdata.getSectorList('industry'),
  ]);
  const concepts = filterSectorCandidates(conceptsRes.data);
  const industries = filterSectorCandidates(industriesRes.data);
  const allBoards = [...concepts, ...industries];
  const rankScore = (row) => (row.pct ?? 0) * 0.7 + clamp((row.netInflowPct ?? 0) * 0.18, -3, 3);
  const sorted = [...allBoards].sort((a, b) => rankScore(b) - rankScore(a));
  const toFetch = [...sorted.slice(0, 18), ...sorted.slice(-10)];
  const uniqueBoards = Array.from(new Map(toFetch.map((row) => [row.code, row])).values());
  const klineResults = await mapLimit(uniqueBoards, 8, (row) => marketdata.getSectorKline(row.code, 30));

  const enriched = uniqueBoards.map((row, index) => {
    const result = klineResults[index];
    const bars = result?.data?.bars || [];
    const closes = bars.map((bar) => bar.close).filter(Number.isFinite);
    const ret5 = returnPct(closes, 5);
    return {
      ...row,
      ret5: round(ret5),
      excess5: round(ret5 === null ? null : ret5 - market5d),
      score: round(rankScore(row) + clamp((ret5 ?? 0) * 0.35, -3, 4), 2),
    };
  });

  const top = enriched
    .filter((item) => item.type === 'concept' || item.pct > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  const outflow = enriched
    .filter((item) => (item.excess5 ?? 0) < -3 && (item.netInflow ?? 0) < 0)
    .sort((a, b) => (a.excess5 ?? 0) - (b.excess5 ?? 0))
    .slice(0, 6);

  const industryMap = new Map(industries.map((item) => [item.name, item]));
  for (const item of enriched) if (item.type === 'industry') industryMap.set(item.name, item);

  return {
    top,
    outflow,
    mainlines: top.slice(0, 3).map((item) => item.name),
    bleeding: outflow.map((item) => item.name),
    industryMap,
    industryBoards: new Map(industries.map((item) => [item.name, item])),
    market5d: round(market5d),
    sourceStale: conceptsRes.stale || industriesRes.stale,
    source: Array.from(new Set([conceptsRes.source, industriesRes.source].filter(Boolean))).join(' + '),
  };
}

function chooseDataDate(indexes) {
  const dates = indexes.flatMap((item) => item.bars.map((bar) => bar.date)).filter(Boolean).sort();
  return dates.at(-1) || shanghaiNowParts().date;
}

async function buildMarketContext() {
  const started = Date.now();
  const [snapshotRes, quoteRes, ...klineResults] = await Promise.all([
    marketdata.getMarketSnapshot(),
    marketdata.getIndexQuotes(),
    ...INDEX_DEFS.map((item) => marketdata.getIndexKline(item.secid, 80)),
  ]);
  const phase = marketPhase();
  const today = phase.now.date;
  const quotes = quoteRes.data;
  const indexes = INDEX_DEFS.map((def, index) => {
    const quote = quotes.find((item) => item.code === def.code) || {};
    return indexMetrics(def, quote, klineResults[index].data, today);
  });
  const breadth = buildBreadth(snapshotRes.data.stocks);
  const sse = indexes[0];
  const market5d = sse.ret5 ?? 0;
  const amountRatio = sse.amountRatio ?? 1;
  const market = buildMarketModel(indexes, breadth, market5d, amountRatio);
  const sectors = await analyzeSectorRadar(market5d);
  const stale = snapshotRes.stale || quoteRes.stale || klineResults.some((result) => result.stale) || sectors.sourceStale;
  const dataDate = chooseDataDate(indexes);
  const sources = Array.from(new Set([
    snapshotRes.source,
    quoteRes.source,
    ...klineResults.map((result) => result.source),
    sectors.source,
  ].filter(Boolean)));
  return {
    stocks: snapshotRes.data.stocks,
    stockMap: new Map(snapshotRes.data.stocks.map((stock) => [stock.code, stock])),
    indexes,
    breadth,
    market,
    sectors,
    meta: {
      generatedAt: new Date().toISOString(),
      dataDate,
      dataSource: stale ? '本地缓存行情' : (sources.join(' + ') || '实时行情'),
      stale,
      latencyMs: Date.now() - started,
      marketPhase: phase.label,
      marketOpen: phase.open,
      time: phase.now.time,
      totalStocks: snapshotRes.data.total,
      cacheHit: Boolean(snapshotRes.cached && quoteRes.cached),
    },
  };
}

async function getMarketContext(force = false) {
  if (!force && contextState.data && Date.now() - contextState.at < 50000) return contextState.data;
  if (!force && contextState.promise) return contextState.promise;
  const task = buildMarketContext()
    .then((data) => {
      contextState.data = data;
      contextState.at = Date.now();
      return data;
    })
    .finally(() => {
      contextState.promise = null;
    });
  contextState.promise = task;
  return task;
}
function resolveProfile(settings, market) {
  let profile = settings.profile;
  if (profile === 'auto') {
    if (market.score < 52) profile = 'defense';
    else if (market.score >= 68) profile = 'offense';
    else profile = 'balanced';
  }
  const effective = {
    ...settings,
    profile,
    minScore: settings.minScore,
    maxPositions: settings.maxPositions,
    positionPct: round(clamp(48 / settings.maxPositions, 8, 22), 0),
  };
  if (profile === 'defense') {
    effective.minScore = Math.max(settings.minScore, 78);
    effective.maxPositions = Math.min(settings.maxPositions, 3);
    effective.positionPct = Math.min(effective.positionPct, 10);
  } else if (profile === 'offense') {
    effective.minScore = Math.max(65, settings.minScore - 3);
    effective.positionPct = Math.min(18, effective.positionPct + 2);
  }
  return effective;
}

function isRiskName(name) {
  return /(^|\*)ST|退市|退$|^N|^C/.test(name) || /-U$/.test(name);
}

function baseEligible(stock) {
  if (!stock || isRiskName(stock.name)) return false;
  if (/^[48]/.test(stock.code)) return false;
  if (!Number.isFinite(stock.price) || stock.price < 3 || stock.price > 160) return false;
  if (!Number.isFinite(stock.pct) || stock.pct < -3 || stock.pct > 7.5) return false;
  if (!Number.isFinite(stock.turnover) || stock.turnover < 1.5 || stock.turnover > 22) return false;
  if (Number.isFinite(stock.volumeRatio) && (stock.volumeRatio < 0.75 || stock.volumeRatio > 6)) return false;
  if (!Number.isFinite(stock.amount) || stock.amount < 120000000) return false;
  if (!Number.isFinite(stock.floatCap) || stock.floatCap < 2000000000 || stock.floatCap > 220000000000) return false;
  if (Number.isFinite(stock.netInflow) && stock.netInflow <= 0) return false;
  if (!Number.isFinite(stock.high) || !Number.isFinite(stock.low) || stock.high <= stock.low) return false;
  return true;
}

function preliminaryScore(stock, sector) {
  const pctScore = clamp(10 + stock.pct * 1.8, 0, 18);
  const flowScore = clamp(6 + (stock.netInflowPct ?? 0) * 0.9, 0, 16);
  const turnoverScore = 10 - Math.abs((stock.turnover ?? 7) - 7) * 0.9;
  const volumeScore = !Number.isFinite(stock.volumeRatio)
    ? 4
    : stock.volumeRatio >= 1 && stock.volumeRatio <= 2.5
      ? 6
      : stock.volumeRatio < 1 ? stock.volumeRatio * 4 : Math.max(0, 8 - (stock.volumeRatio - 2.5) * 1.5);
  const sectorScore = sector ? clamp(5 + (sector.pct ?? 0) * 1.1, 0, 10) : 5;
  const capScore = stock.floatCap < 30000000000 ? 4 : stock.floatCap < 100000000000 ? 2 : 1;
  return pctScore + flowScore + clamp(turnoverScore, 0, 10) + volumeScore + sectorScore + capScore;
}

function calculateScore(stock, bars, sector, settings) {
  const closes = bars.map((bar) => bar.close).filter(Number.isFinite);
  if (closes.length < 25) return null;
  const close = stock.price ?? closes.at(-1);
  closes[closes.length - 1] = close;
  const ma5 = sma(closes, 5);
  const ma10 = sma(closes, 10);
  const ma20 = sma(closes, 20);
  const ma60 = sma(closes, 60);
  const atr = atrPct(bars, 14) ?? 4;
  const ret5 = returnPct(closes, 5) ?? 0;
  const ret20 = returnPct(closes, 20) ?? 0;
  const high20 = Math.max(...bars.slice(-20).map((bar) => bar.high));
  const lowDays = higherLowDays(bars, 5);
  const netFlow = stock.netInflow ?? 0;
  const flowPct = stock.netInflowPct ?? 0;
  const distanceMa5 = ma5 ? ((close / ma5) - 1) * 100 : 0;
  const distanceMa20 = ma20 ? ((close / ma20) - 1) * 100 : 0;
  const upperShadow = ((stock.high ?? close) - close) / close * 100;

  const capital = clamp(9 + flowPct * 0.8 + (netFlow > 0 ? 4 : 0) + clamp(netFlow / 100000000, 0, 4), 0, 25);
  const turnoverPart = clamp(10 - Math.abs((stock.turnover ?? 7) - 7) * 0.85, 0, 10);
  const volumePart = !Number.isFinite(stock.volumeRatio)
    ? 4
    : stock.volumeRatio >= 1 && stock.volumeRatio <= 2.5
      ? 6
      : stock.volumeRatio < 1 ? clamp(stock.volumeRatio * 4, 0, 4) : clamp(8 - (stock.volumeRatio - 2.5) * 1.3, 0, 5);
  const pctPart = stock.pct > 0 && stock.pct <= 6 ? 4 : stock.pct > 6 ? 1 : 2;
  const volumePrice = turnoverPart + volumePart + pctPart;

  const sectorPctPart = sector ? clamp(5 + (sector.pct ?? 0) * 1.1, 0, 10) : 5;
  const sectorExcessPart = sector ? clamp(5 + (sector.excess5 ?? 0) * 0.75, 0, 10) : 5;
  const sectorScore = sectorPctPart + sectorExcessPart;

  let trend = 0;
  if (close > ma5) trend += 3;
  if (close > ma20) trend += 5;
  if (ma20 && ma60 && ma20 > ma60) trend += 5;
  if (ma5 && ma10 && ma5 > ma10) trend += 2;
  if (ret5 > 0) trend += 2;
  if (close >= high20 * 0.97) trend += 4;
  else if (close >= high20 * 0.92) trend += 2;
  if (lowDays >= 2) trend += 3;
  trend += clamp(distanceMa20 * 0.12, -3, 2);

  let risk = 0;
  if (atr <= 3.5) risk += 4;
  else if (atr <= 5) risk += 3;
  else if (atr <= 7) risk += 1.5;
  if (Math.abs(distanceMa5) <= 6) risk += 3;
  else if (Math.abs(distanceMa5) <= 10) risk += 1.5;
  if (upperShadow <= 2.5) risk += 3;
  else if (upperShadow <= 5) risk += 1;

  let score = capital + volumePrice + sectorScore + clamp(trend, 0, 25) + clamp(risk, 0, 10);
  if (close < ma20) score -= 8;
  if (netFlow < 0) score -= 7;
  if (sector && (sector.excess5 ?? 0) < -4 && (sector.netInflow ?? 0) < 0) score -= 7;
  if (stock.pct > 9.5) score -= 6;
  score = clamp(score, 5, 98);

  return {
    score: round(score, 0),
    dimensions: {
      capital: round(capital, 1),
      volumePrice: round(volumePrice, 1),
      sector: round(sectorScore, 1),
      trend: round(clamp(trend, 0, 25), 1),
      risk: round(clamp(risk, 0, 10), 1),
    },
    metrics: {
      ma5: round(ma5),
      ma10: round(ma10),
      ma20: round(ma20),
      ma60: round(ma60),
      atrPct: round(atr),
      ret5: round(ret5),
      ret20: round(ret20),
      high20: round(high20),
      lowDays,
      distanceMa5: round(distanceMa5),
      distanceMa20: round(distanceMa20),
      upperShadow: round(upperShadow),
      volumeRatio: round(stock.volumeRatio),
      turnover: round(stock.turnover),
    },
    sector,
  };
}

function sectorExcessText(sector) {
  if (!sector) return '板块数据待补充';
  return `${sector.name}近5日超额 ${formatSigned(sector.excess5)}`;
}

function buildReasons(stock, metrics, sector) {
  const reasons = [];
  if ((stock.netInflow ?? 0) > 0) reasons.push(`主力净流入 ${(stock.netInflow / 100000000).toFixed(2)} 亿`);
  if (metrics.ma20 && metrics.ma60 && metrics.ma20 > metrics.ma60) reasons.push('MA20 上穿 MA60，趋势修复');
  if (metrics.lowDays >= 2) reasons.push(`连续抬底 ${metrics.lowDays} 天`);
  if (sector && (sector.excess5 ?? 0) > 0) reasons.push(`${sector.name}板块跑赢大盘`);
  if (stock.volumeRatio >= 1 && stock.volumeRatio <= 2.5) reasons.push('温和放量，量价匹配');
  if (metrics.ret5 > 0 && metrics.ret5 < 8) reasons.push(`5日涨幅 ${formatSigned(metrics.ret5)}，未过度透支`);
  return reasons.slice(0, 4);
}

function buildRisks(stock, metrics, sector) {
  const risks = [];
  if (stock.price < metrics.ma5) risks.push('收盘跌破 MA5，短线转弱');
  if (stock.price < metrics.ma20) risks.push('仍在 MA20 下方，趋势未确认');
  if ((stock.netInflowPct ?? 0) < 0) risks.push('主力净流出');
  if (sector && (sector.excess5 ?? 0) < -3) risks.push('所属板块持续跑输大盘');
  if (metrics.atrPct > 6) risks.push('波动率偏高，需缩小仓位');
  if (metrics.distanceMa5 > 8) risks.push('偏离 MA5 较远，防冲高回落');
  return risks.slice(0, 4);
}

function buildReview(stock, metrics, sector, score) {
  const priceVsMa5 = stock.price >= metrics.ma5 ? '站上' : '跌破';
  const maAlignment = metrics.ma20 > metrics.ma60 ? '中期均线多头' : '中期均线仍弱';
  const flow = (stock.netInflow ?? 0) > 0 ? '主力回流' : '主力承压';
  if (score >= 78) return `量价活跃；${flow}；${maAlignment}，等待放量突破确认。`;
  if (score >= 60) return `量价平稳；${priceVsMa5}短均线；${sectorExcessText(sector)}，观察等信号。`;
  if (score >= 45) return `结构一般；${priceVsMa5}MA5；${flow}，不追高，等待趋势修复。`;
  return `量价偏弱；${priceVsMa5}短均线；${sectorExcessText(sector)}，暂无交易优势。`;
}

function buildPlan(stock, metrics, score) {
  if (score >= 78) return '明日放量上攻（量比>1.5）再考虑；回踩 MA5 不破可分批，跌破止损离场。';
  if (score >= 62) return `明日不追高，放量站稳 ${metrics.ma5} 再考虑，缩量则继续等待。`;
  if (score >= 45) return '明日以观察为主；收复 MA10 且主力转正后再评估。';
  return '明日不买，继续观察；只有放量收复 MA20 才重新纳入。';
}

function buildBias(stock, metrics, sector, score) {
  if (score >= 78 && stock.price >= metrics.ma5 && (stock.netInflow ?? 0) > 0) return { text: '明日偏强', tone: 'up' };
  if (score < 50 || (stock.price < metrics.ma5 && metrics.ma5 < metrics.ma10)) return { text: '明日看弱', tone: 'down' };
  return { text: '分歧待确认', tone: 'warn' };
}

function buildAction(score, metrics, stock) {
  if (score >= 80 && stock.price >= metrics.ma5 && (stock.netInflow ?? 0) > 0) {
    return { key: 'buy', label: '可买', labelLong: '强势 · 可买', tone: 'up' };
  }
  if (score >= 64) return { key: 'watch', label: '关注', labelLong: '可关注 · 观望', tone: 'warn' };
  if (score >= 48) return { key: 'wait', label: '等待', labelLong: '信号不足 · 等待', tone: 'neutral' };
  return { key: 'avoid', label: '不买', labelLong: '没戏 · 跳过', tone: 'down' };
}

function buildTradePlan(stock, metrics, settings, score) {
  const stopLossPct = settings.stopLossPct;
  const takeProfitPct = settings.takeProfitPct;
  const atr = (metrics.atrPct / 100) * stock.price;
  let low = Math.max(metrics.ma5 ?? stock.price * 0.975, stock.price - atr * 0.45);
  let high = Math.min(stock.price * 1.015, (metrics.high20 ?? stock.price * 1.05) * 1.002);
  low = Math.min(low, stock.price * 0.995);
  high = Math.max(high, stock.price * 0.998);
  return {
    triggerLow: round(low),
    triggerHigh: round(high),
    stopLoss: round(stock.price * (1 - stopLossPct / 100)),
    takeProfit: round(stock.price * (1 + takeProfitPct / 100)),
    stopLossPct,
    takeProfitPct,
    entryType: stock.price >= (metrics.high20 ?? stock.price) * 0.97 ? '突破确认' : '回踩承接',
    positionPct: settings.positionPct,
    riskReward: round(takeProfitPct / Math.max(stopLossPct, 0.1), 1),
    executable: score >= 60 && stock.price >= (metrics.ma20 ?? 0),
  };
}

function analyzeStock(stock, kline, context, settings) {
  if (!stock || !kline?.bars?.length) return null;
  const sector = context.sectors.industryMap.get(stock.industry) || null;
  const scoreData = calculateScore(stock, kline.bars, sector, settings);
  if (!scoreData) return null;
  const action = buildAction(scoreData.score, scoreData.metrics, stock);
  const bias = buildBias(stock, scoreData.metrics, sector, scoreData.score);
  const plan = buildTradePlan(stock, scoreData.metrics, settings, scoreData.score);
  const spark = kline.bars.slice(-32).map((bar) => round(bar.close));
  const excess5 = scoreData.metrics.ret5 === null ? null : scoreData.metrics.ret5 - (context.market.market5d ?? 0);
  return {
    code: stock.code,
    name: stock.name,
    displayCode: formatCode(stock.code),
    industry: stock.industry || '未分类',
    price: round(stock.price),
    pct: round(stock.pct),
    change: round(stock.change),
    prevClose: round(stock.prevClose),
    volumeRatio: round(stock.volumeRatio),
    turnover: round(stock.turnover),
    netInflow: round(stock.netInflow / 100000000, 2),
    netInflowPct: round(stock.netInflowPct),
    score: scoreData.score,
    dimensions: scoreData.dimensions,
    metrics: scoreData.metrics,
    sector: sector ? {
      code: sector.code,
      name: sector.name,
      pct: sector.pct,
      ret5: sector.ret5,
      excess5: sector.excess5,
      netInflow: round((sector.netInflow ?? 0) / 100000000, 2),
    } : null,
    excess5: round(excess5),
    action,
    bias,
    review: buildReview(stock, scoreData.metrics, sector, scoreData.score),
    planText: buildPlan(stock, scoreData.metrics, scoreData.score),
    plan,
    reasons: buildReasons(stock, scoreData.metrics, sector),
    risks: buildRisks(stock, scoreData.metrics, sector),
    spark,
  };
}
async function ensureIndustryHistory(context, industries) {
  const missing = industries.filter((name) => {
    const board = context.sectors.industryBoards.get(name);
    return board && !Number.isFinite(board.ret5);
  });
  if (!missing.length) return;
  const results = await mapLimit(missing.slice(0, 18), 6, async (name) => {
    const board = context.sectors.industryBoards.get(name);
    const result = await marketdata.getSectorKline(board.code, 30);
    const closes = result.data.bars.map((bar) => bar.close).filter(Number.isFinite);
    const ret5 = returnPct(closes, 5);
    return {
      name,
      code: board.code,
      pct: board.pct,
      netInflow: board.netInflow,
      netInflowPct: board.netInflowPct,
      ret5: round(ret5),
      excess5: round(ret5 === null ? null : ret5 - (context.market.market5d ?? 0)),
    };
  });
  for (const item of results) {
    if (item?.error) continue;
    const existing = context.sectors.industryMap.get(item.name) || context.sectors.industryBoards.get(item.name);
    context.sectors.industryMap.set(item.name, { ...existing, ...item });
  }
}

async function screenCandidates(context, settings) {
  const effective = resolveProfile(settings, context.market);
  const pool = context.stocks.filter(baseEligible);
  const ranked = pool
    .map((stock) => ({
      stock,
      prelim: preliminaryScore(stock, context.sectors.industryMap.get(stock.industry) || null),
    }))
    .sort((a, b) => b.prelim - a.prelim)
    .slice(0, 38);
  const quoteResults = await mapLimit(ranked, 8, (item) => marketdata.getStockQuote(item.stock));
  const prelim = ranked
    .map((item, index) => {
      const quote = quoteResults[index]?.data;
      const stock = quote ? { ...item.stock, ...quote } : item.stock;
      return {
        stock,
        prelim: preliminaryScore(stock, context.sectors.industryMap.get(stock.industry) || null),
      };
    })
    .sort((a, b) => b.prelim - a.prelim);

  const industries = Array.from(new Set(prelim.map((item) => item.stock.industry)));
  await ensureIndustryHistory(context, industries);

  const klineResults = await mapLimit(prelim, 8, (item) => marketdata.getStockKline(item.stock, 120));
  const analyses = prelim
    .map((item, index) => {
      const result = klineResults[index];
      if (!result?.data?.bars?.length) return null;
      return analyzeStock(item.stock, result.data, context, effective);
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  const top = analyses.slice(0, effective.maxPositions + 1);
  const candidates = top.map((item, index) => {
    const sectorOk = !(item.sector && (item.sector.excess5 ?? 0) < -4 && (item.sector.netInflow ?? 0) < 0);
    const qualified = item.score >= effective.minScore && sectorOk && item.action.key !== 'avoid';
    const confirmationChecks = [
      { key: 'score', label: `评分 ≥ ${effective.minScore}`, ok: item.score >= effective.minScore, detail: `${item.score} 分` },
      { key: 'sector', label: '板块未失血', ok: sectorOk, detail: item.sector ? `${item.sector.name} 超额 ${formatSigned(item.sector.excess5)}` : '暂无板块数据' },
      { key: 'price', label: '价格处于触发区间', ok: item.price <= item.plan.triggerHigh * 1.01, detail: `${item.plan.triggerLow} - ${item.plan.triggerHigh}` },
      { key: 'volume', label: '量比 ≥ 1.0', ok: (item.volumeRatio ?? 0) >= 1, detail: `量比 ${item.volumeRatio}` },
      { key: 'market', label: '大盘环境不弱', ok: context.market.score >= 48, detail: `${context.market.score} / 60` },
    ];
    const passCount = confirmationChecks.filter((check) => check.ok).length;
    return {
      ...item,
      rank: index + 1,
      qualified,
      status: qualified ? 'qualified' : 'watch',
      statusLabel: qualified ? '达标' : '观察',
      effectiveMinScore: effective.minScore,
      tags: [
        item.sector?.excess5 > 0 ? '板块共振' : null,
        item.netInflow > 0 ? '主力净流入' : null,
        item.metrics.ma20 > item.metrics.ma60 ? '均线多头' : null,
        item.metrics.lowDays >= 2 ? `抬底${item.metrics.lowDays}天` : null,
        item.volumeRatio >= 1 ? '量比充足' : null,
      ].filter(Boolean).slice(0, 4),
      note: `${item.sector?.name || item.industry}${item.sector?.excess5 > 0 ? '主线共振' : '结构修复'}，${item.metrics.lowDays >= 2 ? '抬底延续' : '等待确认'}；次日冲高优先兑现，-${effective.stopLossPct}% 严格止损。`,
      confirmation: {
        checks: confirmationChecks,
        passCount,
        total: confirmationChecks.length,
        ready: passCount >= (effective.profile === 'defense' ? 4 : 3),
      },
      positionPct: effective.positionPct,
    };
  });

  const badSectors = new Set(context.sectors.outflow.map((item) => item.name));
  const exclusions = pool
    .filter((stock) => badSectors.has(stock.industry) && (stock.netInflow ?? 0) <= 0)
    .sort((a, b) => (a.pct ?? 0) - (b.pct ?? 0))
    .slice(0, 5)
    .map((stock) => {
      const sector = context.sectors.industryMap.get(stock.industry);
      return {
        code: stock.code,
        name: stock.name,
        displayCode: formatCode(stock.code),
        price: round(stock.price),
        pct: round(stock.pct),
        industry: stock.industry,
        reason: `${stock.industry}板块近5日跑输大盘 ${formatSigned(sector?.excess5)}，存量资金失血`,
      };
    });

  return {
    effective,
    candidates,
    topWatch: analyses.slice(0, 8).map((item) => ({ code: item.code, name: item.name, score: item.score, industry: item.industry })),
    exclusions,
    poolSize: pool.length,
    scanned: prelim.length,
    qualifiedCount: candidates.filter((item) => item.qualified).length,
  };
}

async function getScreener(context, settings) {
  const key = JSON.stringify(settings);
  if (screenState.data && screenState.key === key && Date.now() - screenState.at < 50000) return screenState.data;
  if (screenState.promise && screenState.key === key) return screenState.promise;
  screenState.key = key;
  const task = screenCandidates(context, settings)
    .then((data) => {
      screenState.data = data;
      screenState.at = Date.now();
      return data;
    })
    .finally(() => {
      screenState.promise = null;
    });
  screenState.promise = task;
  return task;
}

async function analyzeWatchlist(context, codes, settings) {
  const stocks = codes.map((code) => context.stockMap.get(code)).filter(Boolean);
  const quoteResults = await mapLimit(stocks, 6, (stock) => marketdata.getStockQuote(stock));
  const liveStocks = stocks.map((stock, index) => {
    const quote = quoteResults[index]?.data;
    return quote ? { ...stock, ...quote } : stock;
  });
  const klineResults = await mapLimit(liveStocks, 6, (stock) => marketdata.getStockKline(stock, 120));
  return liveStocks.map((stock, index) => {
    const result = klineResults[index];
    const analysis = result?.data ? analyzeStock(stock, result.data, context, settings) : null;
    if (!analysis) {
      return {
        code: stock.code,
        name: stock.name,
        displayCode: formatCode(stock.code),
        price: round(stock.price),
        pct: round(stock.pct),
        score: 0,
        action: { key: 'wait', label: '等待', labelLong: '数据不足 · 等待', tone: 'neutral' },
        bias: { text: '等待数据', tone: 'neutral' },
        review: '历史行情暂不可用，请稍后刷新。',
        planText: '数据不足，暂不交易。',
        metrics: {},
        spark: [],
        sector: null,
        reasons: [],
        risks: ['历史行情缺失'],
      };
    }
    return analysis;
  });
}

async function getWatchlist(context, codes, settings) {
  const key = `${codes.join(',')}:${JSON.stringify(settings)}`;
  if (watchState.data && watchState.key === key && Date.now() - watchState.at < 50000) return watchState.data;
  if (watchState.promise && watchState.key === key) return watchState.promise;
  watchState.key = key;
  const task = analyzeWatchlist(context, codes, settings)
    .then((data) => {
      watchState.data = data;
      watchState.at = Date.now();
      return data;
    })
    .finally(() => {
      watchState.promise = null;
    });
  watchState.promise = task;
  return task;
}
function buildPerformance(state, context) {
  const trades = state.paperTrades || [];
  const open = trades.filter((trade) => trade.status === 'open').map((trade) => {
    const stock = context.stockMap.get(trade.code);
    const price = stock?.price ?? trade.entryPrice;
    const pnlPct = ((price / trade.entryPrice) - 1) * 100;
    return { ...trade, currentPrice: round(price), currentPnlPct: round(pnlPct), stockName: stock?.name || trade.name };
  });
  const closed = trades.filter((trade) => trade.status === 'closed').sort((a, b) => new Date(a.exitAt) - new Date(b.exitAt));
  const wins = closed.filter((trade) => trade.pnlPct > 0);
  const totalPnl = closed.reduce((sum, trade) => sum + (trade.pnlPct || 0), 0);
  const recent = closed.slice(-5);
  const recentWins = recent.filter((trade) => trade.pnlPct > 0);
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  const curve = closed.map((trade) => {
    equity += trade.pnlPct || 0;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity - peak);
    return { date: trade.exitAt, equity: round(equity, 2) };
  });
  return {
    totalTrades: trades.length,
    openCount: open.length,
    closedCount: closed.length,
    winRate: closed.length ? round((wins.length / closed.length) * 100, 1) : null,
    recentWinRate: recent.length ? round((recentWins.length / recent.length) * 100, 1) : null,
    avgPnlPct: closed.length ? round(totalPnl / closed.length, 2) : null,
    totalPnlPct: round(totalPnl, 2),
    maxDrawdownPct: round(maxDrawdown, 2),
    open,
    closed: closed.slice().reverse(),
    curve,
    discipline: closed.length && (recentWins.length / Math.max(recent.length, 1)) < 0.4 ? '防守档' : '常规档',
  };
}

async function getBootstrap(state, options = {}) {
  const context = await getMarketContext(Boolean(options.force));
  const settings = state.settings;
  const [screener, watchlist] = await Promise.all([
    getScreener(context, settings),
    getWatchlist(context, state.watchlist, settings),
  ]);
  const performance = buildPerformance(state, context);
  const buySignals = watchlist.filter((item) => item.action?.key === 'buy').length;
  return {
    meta: {
      ...context.meta,
      scanLatencyMs: Date.now() - Date.parse(context.meta.generatedAt),
    },
    market: context.market,
    indexes: context.indexes.map(({ bars, ...item }) => item),
    breadth: context.breadth,
    sectors: {
      top: context.sectors.top,
      outflow: context.sectors.outflow,
      mainlines: context.sectors.mainlines,
      bleeding: context.sectors.bleeding,
      market5d: context.sectors.market5d,
    },
    screener,
    watchlist,
    performance,
    settings,
    alert: {
      buySignals,
      qualifiedCandidates: screener.qualifiedCount,
      message: buySignals + screener.qualifiedCount > 0
        ? `今日 ${buySignals + screener.qualifiedCount} 个标的达到观察阈值`
        : '今日暂无强信号，空仓也是一种仓位',
    },
  };
}

async function searchStocks(context, query) {
  const term = String(query || '').trim().toLowerCase();
  if (!term) return [];
  return context.stocks
    .filter((stock) => stock.code.includes(term) || stock.name.toLowerCase().includes(term))
    .slice(0, 12)
    .map((stock) => ({
      code: stock.code,
      name: stock.name,
      displayCode: formatCode(stock.code),
      price: round(stock.price),
      pct: round(stock.pct),
      industry: stock.industry,
    }));
}

async function getStockDetail(context, code, settings) {
  const stock = context.stockMap.get(String(code));
  if (!stock) throw new Error('未找到该股票');
  const quoteRes = await marketdata.getStockQuote(stock);
  const liveStock = quoteRes?.data ? { ...stock, ...quoteRes.data } : stock;
  const [klineRes, intradayRes] = await Promise.all([
    marketdata.getStockKline(liveStock, 180),
    marketdata.getIntraday(liveStock).catch(() => ({ data: { trends: [], preClose: liveStock.prevClose } })),
  ]);
  const analysis = analyzeStock(liveStock, klineRes.data, context, settings);
  return {
    stock: liveStock,
    analysis,
    bars: klineRes.data.bars.slice(-90),
    intraday: intradayRes.data,
  };
}

module.exports = {
  analyzeStock,
  baseEligible,
  buildAction,
  buildBreadth,
  buildMarketModel,
  buildTradePlan,
  calculateScore,
  formatSigned,
  getBootstrap,
  getMarketContext,
  getScreener,
  getStockDetail,
  getWatchlist,
  mapLimit,
  marketPhase,
  resolveProfile,
  screenCandidates,
  searchStocks,
  shanghaiNowParts,
};