'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildBreadth,
  buildMarketModel,
  buildTradePlan,
  calculateScore,
  marketPhase,
  resolveProfile,
  searchStocks,
  shanghaiNowParts,
} = require('../lib/strategy');

const settings = {
  profile: 'auto',
  minScore: 72,
  maxPositions: 4,
  stopLossPct: 3,
  takeProfitPct: 5,
  refreshInterval: 90,
  positionPct: 12,
};

function buildBars(count = 60) {
  return Array.from({ length: count }, (_, index) => {
    const close = 10 + index * 0.1;
    return {
      date: `2026-07-${String((index % 28) + 1).padStart(2, '0')}`,
      open: close - 0.05,
      close,
      high: close + 0.15,
      low: close - 0.15,
      volume: 1_000_000,
      amount: 100_000_000,
    };
  });
}

test('市场宽度与涨跌停统计正确', () => {
  const breadth = buildBreadth([
    { code: '600000', pct: 2, netInflow: 100, amount: 1e8, turnover: 3 },
    { code: '300001', pct: 20, netInflow: 200, amount: 2e8, turnover: 5 },
    { code: '000002', pct: -2, netInflow: -50, amount: 1e8, turnover: 7 },
    { code: '000003', pct: 0, amount: 1e8, turnover: 4 },
  ]);
  assert.equal(breadth.up, 2);
  assert.equal(breadth.down, 1);
  assert.equal(breadth.flat, 1);
  assert.equal(breadth.limitUp, 1);
  assert.equal(breadth.limitDown, 0);
  assert.equal(breadth.total, 4);
  assert.equal(breadth.upRatioPct, 50);
  assert.equal(breadth.netInflowYi, 0);
});

test('自适应档位按大盘评分切换并收紧防守参数', () => {
  const defense = resolveProfile(settings, { score: 45 });
  assert.equal(defense.profile, 'defense');
  assert.equal(defense.minScore, 78);
  assert.equal(defense.maxPositions, 3);

  const balanced = resolveProfile(settings, { score: 60 });
  assert.equal(balanced.profile, 'balanced');
  assert.equal(balanced.minScore, 72);

  const offense = resolveProfile(settings, { score: 72 });
  assert.equal(offense.profile, 'offense');
  assert.equal(offense.minScore, 69);

  const manual = resolveProfile({ ...settings, profile: 'defense', minScore: 60 }, { score: 90 });
  assert.equal(manual.minScore, 78);
});

test('个股评分包含五维拆解且受趋势与资金支撑', () => {
  const stock = {
    code: '600001',
    name: '测试股份',
    price: 15.9,
    pct: 2,
    high: 16,
    low: 15.5,
    turnover: 7,
    volumeRatio: 1.4,
    netInflow: 200_000_000,
    netInflowPct: 4,
  };
  const result = calculateScore(stock, buildBars(), { pct: 2, excess5: 2, netInflow: 100_000_000 }, settings);
  assert.ok(result);
  assert.ok(result.score >= 60 && result.score <= 98);
  assert.equal(Object.keys(result.dimensions).sort().join(','), 'capital,risk,sector,trend,volumePrice');
  assert.ok(result.metrics.ma5 > result.metrics.ma20);
  assert.ok(result.metrics.lowDays >= 0);
});

test('交易计划按设置生成止损止盈与盈亏比', () => {
  const stock = { price: 20, high: 20.2, low: 19.4, pct: 2 };
  const metrics = { ma5: 19.8, ma20: 19.2, high20: 20.1, atrPct: 3.5 };
  const plan = buildTradePlan(stock, metrics, settings, 82);
  assert.equal(plan.stopLoss, 19.4);
  assert.equal(plan.takeProfit, 21);
  assert.equal(plan.stopLossPct, 3);
  assert.equal(plan.takeProfitPct, 5);
  assert.equal(plan.riskReward, 1.7);
  assert.equal(plan.executable, true);
  assert.ok(plan.triggerLow <= stock.price);
});

test('大盘模型输出可解释模块与状态', () => {
  const indexes = [
    { pct: 1, maScore: 80, ma5: 10, ma10: 9.8, ma20: 9.5, price: 10.2, aboveMa5: true, aboveMa10: true },
    { pct: 0.6, maScore: 70, ma5: 10, ma10: 9.8, ma20: 9.5, price: 10.1, aboveMa5: true, aboveMa10: true },
    { pct: 1.4, maScore: 85, ma5: 10, ma10: 9.8, ma20: 9.5, price: 10.3, aboveMa5: true, aboveMa10: true },
    { pct: 0.8, maScore: 75, ma5: 10, ma10: 9.8, ma20: 9.5, price: 10.2, aboveMa5: true, aboveMa10: true },
  ];
  const breadth = { up: 3200, down: 1500, flat: 200, total: 4900, limitUp: 40, limitDown: 5, upRatio: 0.65, upRatioPct: 65, positiveFlowRatio: 0.6, netInflowYi: 30 };
  const market = buildMarketModel(indexes, breadth, 2.5, 1.08);
  assert.ok(market.score >= 0 && market.score <= 100);
  assert.equal(market.modules.length, 4);
  assert.ok(['偏强', '中性', '防守'].includes(market.status));
  assert.ok(market.summary.length > 0);
});

test('股票搜索支持代码和名称且限制条数', async () => {
  const context = {
    stocks: [
      { code: '600000', name: '浦发银行', price: 10, pct: 1, industry: '银行' },
      { code: '000001', name: '平安银行', price: 12, pct: 0.5, industry: '银行' },
    ],
  };
  const byCode = await searchStocks(context, '600');
  assert.equal(byCode.length, 1);
  assert.equal(byCode[0].displayCode, '600000.XSHG');
  const byName = await searchStocks(context, '平安');
  assert.equal(byName.length, 1);
  assert.equal(byName[0].code, '000001');
  assert.deepEqual(await searchStocks(context, ''), []);
});

test('上海时间与交易阶段结构稳定', () => {
  const parts = shanghaiNowParts(new Date('2026-10-23T07:00:00Z'));
  assert.equal(parts.date, '2026-10-23');
  assert.equal(parts.time, '15:00:00');
  const phase = marketPhase();
  assert.ok(typeof phase.label === 'string' && phase.label.length > 0);
  assert.equal(typeof phase.open, 'boolean');
});