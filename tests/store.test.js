'use strict';

const { after, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsignal-store-'));
process.env.QSIGNAL_DATA_DIR = tempDir;
const store = require('../lib/store');

after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test('设置校验会夹紧越界参数并保留进攻档', () => {
  const sanitized = store.sanitizeSettings({
    profile: 'offense',
    minScore: 10,
    maxPositions: 99,
    stopLossPct: 0,
    takeProfitPct: 99,
    refreshInterval: 5,
  });
  assert.equal(sanitized.profile, 'offense');
  assert.equal(sanitized.minScore, 55);
  assert.equal(sanitized.maxPositions, 6);
  assert.equal(sanitized.stopLossPct, 3);
  assert.equal(sanitized.takeProfitPct, 12);
  assert.equal(sanitized.refreshInterval, 30);
  assert.equal(store.sanitizeSettings({ profile: 'unknown' }).profile, 'auto');
});

test('状态归一化会去重并过滤无效代码', () => {
  const normalized = store.normalizeState({
    watchlist: ['600000', '600000', 'abc', '12345', '1234567'],
    paperTrades: null,
    settings: { minScore: 120 },
  });
  assert.deepEqual(normalized.watchlist, ['600000', '123456']);
  assert.deepEqual(normalized.paperTrades, []);
  assert.equal(normalized.settings.minScore, 90);
});

test('自选股与模拟交易生命周期可持久化', async () => {
  const initial = await store.loadState();
  assert.ok(initial.watchlist.length >= 1);

  const added = await store.addToWatchlist('600519');
  assert.equal(added.watchlist[0], '600519');
  await assert.rejects(store.addToWatchlist('123'), /6 位数字/);

  const removed = await store.removeFromWatchlist('600519');
  assert.equal(removed.watchlist.includes('600519'), false);

  await store.updateSettings({
    profile: 'auto',
    minScore: 72,
    maxPositions: 1,
    stopLossPct: 3,
    takeProfitPct: 5,
    refreshInterval: 90,
  });

  const opened = await store.addPaperTrade({
    code: '600519',
    name: '贵州茅台',
    industry: '白酒',
    entryPrice: 10,
    score: 82,
    stopLoss: 9.7,
    takeProfit: 10.5,
  });
  const trade = opened.paperTrades[0];
  assert.equal(trade.status, 'open');
  assert.equal(opened.paperTrades.length, 1);

  await assert.rejects(store.addPaperTrade({ code: '600519', name: '贵州茅台', entryPrice: 10 }), /已在模拟持仓/);
  await assert.rejects(store.addPaperTrade({ code: '000001', name: '平安银行', entryPrice: 10 }), /持仓已达上限/);

  const closed = await store.closePaperTrade(trade.id, 11, '测试平仓');
  assert.equal(closed.paperTrades[0].status, 'closed');
  assert.ok(Math.abs(closed.paperTrades[0].pnlPct - 10) < 1e-9);
  assert.equal(closed.paperTrades[0].result, 'win');

  await assert.rejects(store.closePaperTrade(trade.id, 12), /未找到可平仓/);

  const reset = await store.resetPerformance();
  assert.deepEqual(reset.paperTrades, []);
});