'use strict';

const ths = require('./ths');
const eastmoney = require('./eastmoney');

async function attachSource(result, source) {
  const value = await result;
  if (!value || typeof value !== 'object') return value;
  return value.source ? value : { ...value, source };
}

async function withFallback(label, primary, secondary) {
  let primaryError;
  try {
    return await primary();
  } catch (error) {
    primaryError = error;
  }
  try {
    const result = await secondary();
    return {
      ...result,
      source: result.source || '东方财富',
      fallback: true,
      warning: `${label}已切换备用源：${primaryError.message}`,
    };
  } catch (secondaryError) {
    const error = new Error(`${label}不可用：同花顺 ${primaryError.message}；东方财富 ${secondaryError.message}`);
    error.cause = secondaryError;
    throw error;
  }
}

async function getMarketSnapshot() {
  return withFallback(
    '全市场行情',
    () => attachSource(ths.getMarketSnapshot(), '同花顺 / 新浪全市场'),
    () => attachSource(eastmoney.getMarketSnapshot(), '东方财富'),
  );
}

async function getStockQuote(stock) {
  try {
    return attachSource(await ths.getStockQuote(stock), '同花顺');
  } catch {
    return null;
  }
}

async function getIndexQuotes() {
  return withFallback(
    '指数行情',
    () => attachSource(ths.getIndexQuotes(), '同花顺'),
    () => attachSource(eastmoney.getIndexQuotes(), '东方财富'),
  );
}

async function getStockKline(stock, limit = 120) {
  return withFallback(
    '个股历史行情',
    () => attachSource(ths.getStockKline(stock, limit), '同花顺'),
    () => attachSource(eastmoney.getStockKline(stock, limit), '东方财富'),
  );
}

async function getIndexKline(secid, limit = 80) {
  return withFallback(
    '指数历史行情',
    () => attachSource(ths.getIndexKline(secid, limit), '同花顺'),
    () => attachSource(eastmoney.getIndexKline(secid, limit), '东方财富'),
  );
}

async function getSectorKline(boardCode, limit = 30) {
  return withFallback(
    '板块历史行情',
    () => attachSource(ths.getSectorKline(boardCode, limit), '同花顺'),
    () => attachSource(eastmoney.getSectorKline(boardCode, limit), '东方财富'),
  );
}

async function getSectorList(type) {
  if (type === 'concept') {
    return withFallback(
      '概念板块',
      () => attachSource(eastmoney.getSectorList(type), '东方财富'),
      () => attachSource(ths.getSectorList(type), '同花顺'),
    );
  }
  return withFallback(
    '行业板块',
    () => attachSource(ths.getSectorList(type), '同花顺'),
    () => attachSource(eastmoney.getSectorList(type), '东方财富'),
  );
}

async function getIntraday(stock) {
  return withFallback(
    '分时行情',
    () => attachSource(ths.getIntraday(stock), '同花顺'),
    () => attachSource(eastmoney.getIntraday(stock), '东方财富'),
  );
}

async function checkDataHealth() {
  try {
    const health = await ths.checkDataHealth();
    if (health.ok) return { ...health, source: '同花顺' };
  } catch {
    // Fall through to the backup provider.
  }
  try {
    const result = await eastmoney.checkDataHealth();
    const data = result.data || result;
    return {
      ok: Boolean(data.ok),
      provider: '东方财富',
      total: data.total || 0,
      checkedAt: new Date().toISOString(),
      source: '东方财富',
    };
  } catch (error) {
    return {
      ok: false,
      provider: '无',
      checkedAt: new Date().toISOString(),
      error: error.message,
    };
  }
}

module.exports = {
  checkDataHealth,
  getIndexKline,
  getIndexQuotes,
  getIntraday,
  getMarketSnapshot,
  getSectorKline,
  getSectorList,
  getStockKline,
  getStockQuote,
};