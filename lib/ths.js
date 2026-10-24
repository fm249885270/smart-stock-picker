'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const CACHE_DIR = path.join(__dirname, '..', 'data', 'cache');
const MEMORY_TTL = 30 * 1000;
const DISK_TTL = 12 * 60 * 60 * 1000;
const memory = new Map();
const inflight = new Map();

const QUOTE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
  Referer: 'http://www.10jqka.com.cn/',
  Accept: '*/*',
};

const MARKET_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
  Referer: 'http://q.10jqka.com.cn/',
  Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
};

const SINA_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
  Referer: 'https://finance.sina.com.cn/',
  Accept: 'application/json,text/plain,*/*',
};

const INDEX_DEFS = [
  { secid: '1.000001', code: '000001', key: 'hs_1A0001', name: '上证指数' },
  { secid: '0.399001', code: '399001', key: 'hs_399001', name: '深证成指' },
  { secid: '0.399006', code: '399006', key: 'hs_399006', name: '创业板指' },
  { secid: '1.000688', code: '000688', key: 'hs_1B0688', name: '科创50' },
];

function toNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === '-' || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === '-' || value === '' || value === '亏损') return null;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, digits = 2) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function cacheFileName(key) {
  const hash = crypto.createHash('sha1').update(key).digest('hex');
  return path.join(CACHE_DIR, `${hash}.json`);
}

async function readDiskCache(key) {
  try {
    const raw = await fs.readFile(cacheFileName(key), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeDiskCache(key, data) {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(cacheFileName(key), JSON.stringify({ savedAt: Date.now(), data }), 'utf8');
  } catch {
    // Cache failures must not interrupt live analysis.
  }
}

async function cached(key, ttl, loader) {
  const current = memory.get(key);
  if (current && Date.now() - current.savedAt < ttl) {
    return { data: current.data, stale: false, cached: true, savedAt: current.savedAt };
  }
  if (inflight.has(key)) return inflight.get(key);

  const task = (async () => {
    try {
      const data = await loader();
      const savedAt = Date.now();
      memory.set(key, { data, savedAt });
      await writeDiskCache(key, data);
      return { data, stale: false, cached: false, savedAt };
    } catch (error) {
      const disk = await readDiskCache(key);
      if (disk) {
        memory.set(key, { data: disk.data, savedAt: disk.savedAt });
        return {
          data: disk.data,
          stale: Date.now() - disk.savedAt > DISK_TTL,
          cached: true,
          savedAt: disk.savedAt,
          warning: error.message,
        };
      }
      throw error;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, task);
  return task;
}

async function fetchBuffer(url, { headers = MARKET_HEADERS, timeout = 15000, retries = 2 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, { headers, signal: controller.signal });
      if (!response.ok) throw new Error(`同花顺接口 HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

async function fetchText(url, options = {}) {
  const buffer = await fetchBuffer(url, options);
  if (options.encoding === 'gbk') {
    try { return new TextDecoder('gbk').decode(buffer); }
    catch { return buffer.toString('utf8'); }
  }
  return buffer.toString('utf8');
}

function parseJsonp(text) {
  const raw = String(text || '').trim();
  const start = raw.indexOf('(');
  const end = raw.lastIndexOf(')');
  const body = start >= 0 && end > start ? raw.slice(start + 1, end) : raw;
  return JSON.parse(body);
}

async function fetchJsonp(url, options = {}) {
  const text = await fetchText(url, { headers: QUOTE_HEADERS, ...options });
  return parseJsonp(text);
}

async function fetchJson(url, options = {}) {
  const text = await fetchText(url, options);
  return JSON.parse(text);
}

function formatDate(value) {
  const raw = String(value || '').replace(/\D/g, '');
  if (raw.length !== 8) return String(value || '');
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

function marketForCode(code) {
  return String(code || '').startsWith('6') ? 1 : 0;
}

function stockKey(code) {
  return `hs_${String(code || '').replace(/\D/g, '').slice(0, 6)}`;
}

function normalizeRealhead(payload, meta = {}) {
  const item = payload?.items || {};
  const code = String(meta.code || item['5'] || '').trim();
  const price = optionalNumber(item['10']);
  const prevClose = optionalNumber(item['6']);
  const computedPct = price !== null && prevClose ? ((price / prevClose) - 1) * 100 : null;
  return {
    code,
    market: meta.market ?? marketForCode(code),
    secid: meta.secid || `${meta.market ?? marketForCode(code)}.${code}`,
    name: String(item.name || meta.name || code).trim(),
    price,
    pct: optionalNumber(item['199112']) ?? computedPct,
    change: optionalNumber(item['264648']) ?? (price !== null && prevClose !== null ? price - prevClose : null),
    volume: optionalNumber(item['13']),
    amount: optionalNumber(item['19']),
    amplitude: price !== null && prevClose ? Math.abs((optionalNumber(item['8']) ?? price) - (optionalNumber(item['9']) ?? price)) / prevClose * 100 : null,
    turnover: optionalNumber(item['1968584']),
    pe: optionalNumber(item['2034120']),
    volumeRatio: optionalNumber(item['1771976']),
    high: optionalNumber(item['8']),
    low: optionalNumber(item['9']),
    open: optionalNumber(item['7']),
    prevClose,
    marketCap: optionalNumber(item['3475914']),
    floatCap: optionalNumber(item['3541450']),
    speed: optionalNumber(item['592920']),
    pb: optionalNumber(item['526792']),
    netInflow: null,
    netInflowPct: null,
    industry: '',
    status: String(item.stockStatus || '').trim(),
    quoteTime: String(item.updateTime || '').trim(),
  };
}

function parseKlineRows(payload, limit = 120) {
  const raw = payload?.data;
  const rows = Array.isArray(raw) ? raw : String(raw || '').split(';');
  const bars = [];
  for (const row of rows) {
    const values = String(row || '').split(',');
    if (values.length < 6) continue;
    const close = toNumber(values[4]);
    if (!(close > 0)) continue;
    bars.push({
      date: formatDate(values[0]),
      open: toNumber(values[1]),
      high: toNumber(values[2]),
      low: toNumber(values[3]),
      close,
      volume: toNumber(values[5]),
      amount: toNumber(values[6]),
      turnover: optionalNumber(values[7]),
      pct: null,
      change: null,
      amplitude: null,
    });
  }
  bars.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index];
    const previous = bars[index - 1];
    if (previous?.close) {
      bar.pct = round(((bar.close / previous.close) - 1) * 100, 2);
      bar.change = round(bar.close - previous.close, 3);
      bar.amplitude = round(((bar.high - bar.low) / previous.close) * 100, 2);
    }
  }
  return bars.slice(-Math.max(1, Number(limit) || 120));
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function stripHtml(value) {
  return decodeHtml(String(value || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function parseHtmlRowData(html) {
  const table = String(html || '').match(/<table[^>]*>([\s\S]*?)<\/table>/i);
  if (!table) return [];
  return Array.from(table[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi))
    .map((match) => {
      const row = match[1];
      if (/<th[\s>]/i.test(row)) return null;
      const cells = Array.from(row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)).map((cell) => stripHtml(cell[1]));
      return cells.length ? { cells, html: row } : null;
    })
    .filter(Boolean);
}

function parseHtmlRows(html) {
  return parseHtmlRowData(html).map((row) => row.cells);
}

function parseUnitNumber(value) {
  const text = String(value || '').replace(/,/g, '').trim();
  if (!text || text === '--' || text === '亏损') return null;
  const match = text.match(/^(-?\d+(?:\.\d+)?)(万亿|亿|万)?$/);
  if (!match) return null;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return null;
  if (match[2] === '万亿') return base * 1000000000000;
  if (match[2] === '亿') return base * 100000000;
  if (match[2] === '万') return base * 10000;
  return base;
}

function parseStockTable(html) {
  return parseHtmlRows(html).map((cells) => {
    const code = String(cells[1] || '').match(/\d{6}/)?.[0] || '';
    if (!code) return null;
    const market = marketForCode(code);
    return {
      code,
      market,
      secid: `${market}.${code}`,
      name: cells[2] || code,
      price: optionalNumber(cells[3]),
      pct: optionalNumber(cells[4]),
      change: optionalNumber(cells[5]),
      speed: optionalNumber(cells[6]),
      turnover: optionalNumber(cells[7]),
      volumeRatio: optionalNumber(cells[8]),
      amplitude: optionalNumber(cells[9]),
      amount: parseUnitNumber(cells[10]),
      floatShares: parseUnitNumber(cells[11]),
      floatCap: parseUnitNumber(cells[12]),
      pe: optionalNumber(cells[13]),
      industry: '',
      netInflow: null,
      netInflowPct: null,
    };
  }).filter((row) => row && row.price !== null);
}

function parseSectorTable(html) {
  return parseHtmlRowData(html).map((entry) => {
    const cells = entry.cells;
    const code = String(entry.html.match(/\/thshy\/detail\/code\/(\d+)/i)?.[1] || '').slice(0, 6);
    if (!code) return null;
    return {
      code,
      name: cells[1] || '',
      type: 'industry',
      pct: optionalNumber(cells[2]),
      amount: parseUnitNumber(cells[4]),
      netInflow: (parseUnitNumber(cells[5]) ?? 0) * 100000000,
      netInflowPct: null,
      upCount: optionalNumber(cells[6]),
      downCount: optionalNumber(cells[7]),
      price: optionalNumber(cells[8]),
      leader: cells[9] || '',
      leaderCode: '',
      leaderPct: optionalNumber(cells[11]),
    };
  }).filter((row) => row && row.name && row.pct !== null);
}

function normalizeSinaStock(row) {
  const code = String(row?.code || '').match(/\d{6}/)?.[0] || '';
  if (!code) return null;
  const market = String(row.symbol || '').startsWith('sh') ? 1 : 0;
  const price = optionalNumber(row.trade);
  if (price === null || price <= 0) return null;
  const prevClose = optionalNumber(row.settlement);
  const high = optionalNumber(row.high);
  const low = optionalNumber(row.low);
  return {
    code,
    market,
    secid: `${market}.${code}`,
    name: String(row.name || code).trim(),
    price,
    pct: optionalNumber(row.changepercent),
    change: optionalNumber(row.pricechange),
    volume: optionalNumber(row.volume),
    amount: optionalNumber(row.amount),
    amplitude: high !== null && low !== null && prevClose ? ((high - low) / prevClose) * 100 : null,
    turnover: optionalNumber(row.turnoverratio),
    pe: optionalNumber(row.per),
    volumeRatio: null,
    high,
    low,
    open: optionalNumber(row.open),
    prevClose,
    marketCap: optionalNumber(row.mktcap) !== null ? optionalNumber(row.mktcap) * 10000 : null,
    floatCap: optionalNumber(row.nmc) !== null ? optionalNumber(row.nmc) * 10000 : null,
    speed: null,
    pb: optionalNumber(row.pb),
    netInflow: null,
    netInflowPct: null,
    industry: '',
    tickTime: String(row.ticktime || ''),
  };
}

async function fetchSinaCount() {
  const url = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeStockCount?node=hs_a';
  const value = await fetchJson(url, { headers: SINA_HEADERS, timeout: 12000, retries: 2 });
  const count = Number(value);
  if (!Number.isFinite(count) || count < 1000) throw new Error('全市场股票数量异常');
  return count;
}

async function fetchSinaPage(page, expected = 100) {
  const url = `https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page=${page}&num=100&sort=symbol&asc=1&node=hs_a&symbol=&_s_r_a=page`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const json = await fetchJson(url, { headers: SINA_HEADERS, timeout: 12000, retries: 1 });
    if (!Array.isArray(json)) throw new Error('全市场行情接口返回格式异常');
    const rows = json.map(normalizeSinaStock).filter(Boolean);
    if (json.length >= expected) return rows;
    if (attempt < 1) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return [];
}

async function fetchSinaUniverse() {
  const total = await fetchSinaCount();
  const pageCount = Math.ceil(total / 100);
  const results = new Array(pageCount);
  let cursor = 0;
  async function worker() {
    while (cursor < pageCount) {
      const index = cursor;
      cursor += 1;
      const page = index + 1;
      const expected = Math.min(100, total - index * 100);
      await new Promise((resolve) => setTimeout(resolve, (index % 3) * 80));
      results[index] = await fetchSinaPage(page, expected);
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
  const stocks = results.flat();
  if (stocks.length < total * 0.9) throw new Error(`全市场股票数量不足（${stocks.length}/${total}）`);
  return stocks;
}

async function fetchQuotePage(page = 1) {
  const url = page === 1
    ? 'http://q.10jqka.com.cn/index/index/board/all/field/zdf/order/desc/page/1/ajax/1/'
    : `http://q.10jqka.com.cn/index/index/board/all/field/zdf/order/desc/page/${page}/`;
  const html = await fetchText(url, { headers: MARKET_HEADERS, encoding: 'gbk', timeout: 12000, retries: 1 });
  if (!/<table/i.test(html)) throw new Error('同花顺全市场行情为空');
  return parseStockTable(html);
}

async function fetchSectorPage(page = 1) {
  const url = page === 1
    ? 'http://q.10jqka.com.cn/thshy/'
    : `http://q.10jqka.com.cn/thshy/index/page/${page}/`;
  const html = await fetchText(url, { headers: MARKET_HEADERS, encoding: 'gbk', timeout: 12000, retries: 1 });
  return parseSectorTable(html);
}

async function getMarketSnapshot() {
  return cached('ths-market-snapshot-v1', MEMORY_TTL, async () => {
    const [sinaResult, thsResult] = await Promise.allSettled([
      fetchSinaUniverse(),
      fetchQuotePage(1),
    ]);
    if (sinaResult.status !== 'fulfilled' || sinaResult.value.length < 1000) {
      const reason = sinaResult.status === 'rejected' ? sinaResult.reason.message : '全市场股票数量不足';
      throw new Error(`全市场行情不可用：${reason}`);
    }
    const stocks = sinaResult.value;
    if (thsResult.status === 'fulfilled' && thsResult.value.length) {
      const quotes = new Map(thsResult.value.map((stock) => [stock.code, stock]));
      for (let index = 0; index < stocks.length; index += 1) {
        const quote = quotes.get(stocks[index].code);
        if (!quote) continue;
        stocks[index] = {
          ...stocks[index],
          price: quote.price ?? stocks[index].price,
          pct: quote.pct ?? stocks[index].pct,
          change: quote.change ?? stocks[index].change,
          turnover: quote.turnover ?? stocks[index].turnover,
          amount: quote.amount ?? stocks[index].amount,
          volumeRatio: quote.volumeRatio ?? stocks[index].volumeRatio,
          amplitude: quote.amplitude ?? stocks[index].amplitude,
        };
      }
    }
    stocks.sort((a, b) => a.code.localeCompare(b.code));
    return {
      total: stocks.length,
      stocks,
      source: thsResult.status === 'fulfilled' ? '同花顺 / 新浪全市场' : '新浪全市场',
    };
  });
}

async function getStockQuote(stock) {
  const code = String(typeof stock === 'string' ? stock : stock?.code || '').replace(/\D/g, '').slice(0, 6);
  if (!code) throw new Error('股票代码无效');
  return cached(`ths-quote:${code}`, MEMORY_TTL, async () => {
    let payload;
    try {
      payload = await fetchJsonp(`http://d.10jqka.com.cn/v6/realhead/${stockKey(code)}/last.js`);
    } catch {
      payload = await fetchJsonp(`http://d.10jqka.com.cn/v6/realhead/${stockKey(code)}/defer/last.js`);
    }
    return normalizeRealhead(payload, { code });
  });
}

async function getIndexQuotes() {
  return cached('ths-index-quotes-v1', MEMORY_TTL, async () => {
    const results = await Promise.all(INDEX_DEFS.map(async (def) => {
      let payload;
      try {
        payload = await fetchJsonp(`http://d.10jqka.com.cn/v6/realhead/${def.key}/last.js`);
      } catch {
        payload = await fetchJsonp(`http://d.10jqka.com.cn/v6/realhead/${def.key}/defer/last.js`);
      }
      return normalizeRealhead(payload, def);
    }));
    return results;
  });
}

async function getKline(key, limit, meta) {
  return cached(`ths-kline:${key}:${limit}`, 10 * 60 * 1000, async () => {
    const payload = await fetchJsonp(`http://d.10jqka.com.cn/v6/line/${key}/01/last.js`);
    const bars = parseKlineRows(payload, limit);
    if (!bars.length) throw new Error('同花顺历史行情为空');
    return {
      code: String(meta?.code || key.split('_').at(-1)),
      name: String(payload?.name || meta?.name || ''),
      bars,
    };
  });
}

async function getStockKline(stock, limit = 120) {
  const code = String(typeof stock === 'string' ? stock : stock?.code || '').replace(/\D/g, '').slice(0, 6);
  if (!code) throw new Error('股票代码无效');
  return getKline(stockKey(code), limit, { code });
}

async function getIndexKline(secid, limit = 80) {
  const def = INDEX_DEFS.find((item) => item.secid === secid || item.code === String(secid).split('.').at(-1));
  if (!def) throw new Error('未配置该同花顺指数');
  return getKline(def.key, limit, def);
}

async function getSectorKline(boardCode, limit = 30) {
  const code = String(boardCode || '').replace(/\D/g, '').slice(0, 6);
  if (!code) throw new Error('板块代码无效');
  return getKline(`bk_${code}`, limit, { code });
}

async function getIntraday(stock) {
  const code = String(typeof stock === 'string' ? stock : stock?.code || '').replace(/\D/g, '').slice(0, 6);
  if (!code) throw new Error('股票代码无效');
  return cached(`ths-intraday:${code}`, MEMORY_TTL, async () => {
    const payload = await fetchJsonp(`http://d.10jqka.com.cn/v6/time/${stockKey(code)}/last.js`);
    const row = payload?.[stockKey(code)] || Object.values(payload || {})[0] || {};
    const trends = String(row.data || '').split(';').map((line) => {
      const values = line.split(',');
      if (values.length < 2) return null;
      const close = toNumber(values[1]);
      if (!(close > 0)) return null;
      const rawTime = String(values[0] || '').padStart(4, '0');
      return {
        time: `${rawTime.slice(0, 2)}:${rawTime.slice(2, 4)}`,
        open: close,
        close,
        high: close,
        low: close,
        volume: toNumber(values[4]),
        amount: toNumber(values[2]),
        avg: toNumber(values[3]),
      };
    }).filter(Boolean);
    return {
      preClose: optionalNumber(row.pre),
      trends,
    };
  });
}

async function getSectorList(type) {
  if (type === 'concept') {
    return {
      data: [],
      stale: false,
      cached: false,
      savedAt: Date.now(),
      source: '同花顺行业板块',
      warning: '同花顺公开概念排行暂不可用',
    };
  }
  return cached('ths-sector-industry-v1', 90 * 1000, async () => {
    const pages = await Promise.all([fetchSectorPage(1), fetchSectorPage(2)]);
    const byCode = new Map();
    for (const row of pages.flat()) byCode.set(row.code, row);
    const rows = Array.from(byCode.values()).filter((row) => row.name);
    if (!rows.length) throw new Error('同花顺行业板块为空');
    return { rows, source: '同花顺行业板块' };
  }).then((result) => {
    const data = result.data?.rows || [];
    return { ...result, data, source: result.data?.source || '同花顺行业板块' };
  });
}

async function checkDataHealth() {
  const quote = await getStockQuote('600519');
  return {
    ok: quote.data?.price !== null && quote.data?.price !== undefined,
    provider: '同花顺',
    checkedAt: new Date().toISOString(),
  };
}

module.exports = {
  checkDataHealth,
  formatDate,
  getIndexKline,
  getIndexQuotes,
  getIntraday,
  getKline,
  getMarketSnapshot,
  getSectorKline,
  getSectorList,
  getStockKline,
  getStockQuote,
  normalizeRealhead,
  normalizeSinaStock,
  parseHtmlRows,
  parseJsonp,
  parseKlineRows,
  parseSectorTable,
  parseStockTable,
  parseUnitNumber,
};