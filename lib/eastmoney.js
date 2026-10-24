'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const CACHE_DIR = path.join(__dirname, '..', 'data', 'cache');
const MEMORY_TTL = 45 * 1000;
const DISK_TTL = 12 * 60 * 60 * 1000;
const memory = new Map();
const inflight = new Map();

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
  Referer: 'https://quote.eastmoney.com/',
  Accept: 'application/json,text/plain,*/*',
};

function toNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === '-' || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === '-' || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cacheFileName(key) {
  const hash = crypto.createHash('sha1').update(key).digest('hex');
  return path.join(CACHE_DIR, `${hash}.json`);
}

async function readDiskCache(key) {
  try {
    const raw = await fs.readFile(cacheFileName(key), 'utf8');
    const payload = JSON.parse(raw);
    return payload;
  } catch {
    return null;
  }
}

async function writeDiskCache(key, data) {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    const payload = JSON.stringify({ savedAt: Date.now(), data });
    await fs.writeFile(cacheFileName(key), payload, 'utf8');
  } catch {
    // Cache writes must never break live analysis.
  }
}

async function fetchJson(url, { timeout = 15000, retries = 2 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, { headers: HEADERS, signal: controller.signal });
      if (!response.ok) throw new Error(`行情接口 HTTP ${response.status}`);
      const text = await response.text();
      const json = JSON.parse(text);
      if (json.rc !== undefined && json.rc !== 0) throw new Error(`行情接口返回错误码 ${json.rc}`);
      return json;
    } catch (error) {
      lastError = error;
      if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
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

function stockQuery(fields) {
  return `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=6000&po=1&np=1&ut=fa5fd1943c7b386f172d6893dbfba10b&fltt=2&invt=2&fid=f6&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23&fields=${fields}`;
}

const STOCK_FIELDS = 'f2,f3,f4,f5,f6,f7,f8,f9,f10,f12,f13,f14,f15,f16,f17,f18,f20,f21,f22,f23,f62,f100,f184';

function normalizeStock(row) {
  const code = String(row.f12 || '');
  const market = Number(row.f13);
  return {
    code,
    market,
    secid: `${market}.${code}`,
    name: String(row.f14 || code).trim(),
    price: optionalNumber(row.f2),
    pct: optionalNumber(row.f3),
    change: optionalNumber(row.f4),
    volume: optionalNumber(row.f5),
    amount: optionalNumber(row.f6),
    amplitude: optionalNumber(row.f7),
    turnover: optionalNumber(row.f8),
    pe: optionalNumber(row.f9),
    volumeRatio: optionalNumber(row.f10),
    high: optionalNumber(row.f15),
    low: optionalNumber(row.f16),
    open: optionalNumber(row.f17),
    prevClose: optionalNumber(row.f18),
    marketCap: optionalNumber(row.f20),
    floatCap: optionalNumber(row.f21),
    speed: optionalNumber(row.f22),
    pb: optionalNumber(row.f23),
    netInflow: optionalNumber(row.f62),
    netInflowPct: optionalNumber(row.f184),
    industry: String(row.f100 || '未分类').trim(),
  };
}

async function getMarketSnapshot() {
  return cached('market-snapshot-v2', MEMORY_TTL, async () => {
    const json = await fetchJson(stockQuery(STOCK_FIELDS));
    const rows = Array.isArray(json.data?.diff) ? json.data.diff : Object.values(json.data?.diff || {});
    const stocks = rows.map(normalizeStock).filter((item) => item.code && item.name && item.price !== null);
    return { total: stocks.length, stocks };
  });
}

async function getIndexQuotes() {
  return cached('index-quotes-v2', MEMORY_TTL, async () => {
    const url = 'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&secids=1.000001,0.399001,0.399006,1.000688&fields=f2,f3,f4,f5,f6,f12,f14,f15,f16,f17,f18';
    const json = await fetchJson(url);
    const rows = Array.isArray(json.data?.diff) ? json.data.diff : Object.values(json.data?.diff || {});
    return rows.map((row) => ({
      code: String(row.f12),
      name: String(row.f14),
      price: optionalNumber(row.f2),
      pct: optionalNumber(row.f3),
      change: optionalNumber(row.f4),
      volume: optionalNumber(row.f5),
      amount: optionalNumber(row.f6),
      high: optionalNumber(row.f15),
      low: optionalNumber(row.f16),
      open: optionalNumber(row.f17),
      prevClose: optionalNumber(row.f18),
    }));
  });
}

function normalizeKlineLine(line) {
  const values = line.split(',');
  return {
    date: values[0],
    open: toNumber(values[1]),
    close: toNumber(values[2]),
    high: toNumber(values[3]),
    low: toNumber(values[4]),
    volume: toNumber(values[5]),
    amount: toNumber(values[6]),
    amplitude: toNumber(values[7]),
    pct: toNumber(values[8]),
    change: toNumber(values[9]),
    turnover: toNumber(values[10]),
  };
}

async function getKline(secid, limit = 120) {
  const key = `kline:${secid}:${limit}`;
  return cached(key, 10 * 60 * 1000, async () => {
    const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${encodeURIComponent(secid)}&klt=101&fqt=1&lmt=${limit}&end=20500101&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61`;
    const json = await fetchJson(url);
    const lines = json.data?.klines || [];
    return {
      code: json.data?.code || secid.split('.')[1],
      name: json.data?.name || '',
      bars: lines.map(normalizeKlineLine).filter((bar) => bar.close > 0),
    };
  });
}

async function getStockKline(stock, limit = 120) {
  return getKline(stock.secid, limit);
}

async function getIndexKline(secid, limit = 80) {
  return getKline(secid, limit);
}

function normalizeSector(row, type) {
  return {
    code: String(row.f12 || ''),
    name: String(row.f14 || '').trim(),
    type,
    pct: optionalNumber(row.f3),
    price: optionalNumber(row.f2),
    netInflow: optionalNumber(row.f62),
    netInflowPct: optionalNumber(row.f184),
    upCount: optionalNumber(row.f104),
    downCount: optionalNumber(row.f105),
    leader: String(row.f128 || '').trim(),
    leaderCode: String(row.f140 || '').trim(),
    leaderPct: optionalNumber(row.f136),
  };
}

async function getSectorList(type) {
  const fsQuery = type === 'concept' ? 'm:90+t:3+f:!50' : 'm:90+t:2+f:!50';
  return cached(`sector-${type}-v2`, 90 * 1000, async () => {
    const url = `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=500&po=1&np=1&ut=fa5fd1943c7b386f172d6893dbfba10b&fltt=2&invt=2&fid=f3&fs=${fsQuery}&fields=f2,f3,f12,f14,f62,f104,f105,f128,f136,f140,f184`;
    const json = await fetchJson(url);
    const rows = Array.isArray(json.data?.diff) ? json.data.diff : Object.values(json.data?.diff || {});
    return rows.map((row) => normalizeSector(row, type)).filter((row) => row.code && row.name);
  });
}

async function getSectorKline(boardCode, limit = 30) {
  return getKline(`90.${boardCode}`, limit);
}

async function getIntraday(stock) {
  const key = `intraday:${stock.secid}`;
  return cached(key, 45 * 1000, async () => {
    const url = `https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=${encodeURIComponent(stock.secid)}&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ndays=1&iscr=0`;
    const json = await fetchJson(url);
    const lines = json.data?.trends || [];
    return {
      preClose: optionalNumber(json.data?.preClose),
      trends: lines.map((line) => {
        const values = line.split(',');
        return {
          time: values[0],
          open: toNumber(values[1]),
          close: toNumber(values[2]),
          high: toNumber(values[3]),
          low: toNumber(values[4]),
          volume: toNumber(values[5]),
          amount: toNumber(values[6]),
          avg: toNumber(values[7]),
        };
      }).filter((row) => row.close > 0),
    };
  });
}

async function checkDataHealth() {
  const result = await cached('health-check-v1', 30 * 1000, async () => {
    const json = await fetchJson(stockQuery('f2,f3,f12,f14'), { timeout: 8000, retries: 0 });
    const rows = json.data?.diff;
    return { ok: Boolean(rows), total: json.data?.total || 0, checkedAt: new Date().toISOString() };
  });
  return result;
}

module.exports = {
  checkDataHealth,
  getIndexKline,
  getIndexQuotes,
  getIntraday,
  getKline,
  getMarketSnapshot,
  getSectorKline,
  getSectorList,
  getStockKline,
};