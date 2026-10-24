'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  atrPct,
  clamp,
  formatCode,
  higherLowDays,
  mean,
  percentileRank,
  returnPct,
  round,
  slopePct,
  sma,
  stddev,
} = require('../lib/indicators');

test('SMA 与均值只统计有效数字', () => {
  assert.equal(sma([1, 2, 3, 4, 5], 3), 4);
  assert.equal(sma([1, 2], 3), null);
  assert.equal(sma([1, 2, 3, 4], 2, 1), 2.5);
  assert.equal(mean([1, Number.NaN, 3]), 2);
  assert.equal(mean([]), null);
});

test('收益率、波动率与趋势工具计算正确', () => {
  assert.ok(Math.abs(returnPct([100, 110, 121], 2) - 21) < 1e-9);
  assert.equal(returnPct([100], 1), null);
  assert.ok(Math.abs(slopePct([100, 105, 110], 2) - 10) < 1e-9);
  assert.equal(stddev([2, 4, 4, 4, 5, 5, 7, 9]), 2);
  assert.equal(percentileRank(3, [1, 2, 3, 4]), 0.75);

  const bars = [
    { high: 10, low: 8, close: 9 },
    { high: 11, low: 9, close: 10 },
  ];
  assert.equal(atrPct(bars), 20);
  assert.equal(higherLowDays([{ low: 5 }, { low: 6 }, { low: 7 }]), 2);
  assert.equal(higherLowDays([{ low: 5 }, { low: 7 }, { low: 6 }]), 0);
});

test('数值边界与代码格式稳定', () => {
  assert.equal(clamp(120, 0, 100), 100);
  assert.equal(clamp(-3, 0, 100), 0);
  assert.equal(clamp(Number.NaN, 5, 10), 5);
  assert.equal(round(1.234, 2), 1.23);
  assert.equal(round(Number.NaN), null);
  assert.equal(formatCode('600000'), '600000.XSHG');
  assert.equal(formatCode('000001'), '000001.XSHE');
  assert.equal(formatCode('830799'), '830799.BJSE');
  assert.equal(formatCode(''), '--');
});