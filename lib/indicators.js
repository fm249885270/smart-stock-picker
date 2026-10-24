'use strict';

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function mean(values) {
  const clean = values.filter(Number.isFinite);
  if (!clean.length) return null;
  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

function sma(values, period, offset = 0) {
  const end = values.length - offset;
  if (end < period) return null;
  return mean(values.slice(end - period, end));
}

function stddev(values) {
  const avg = mean(values);
  if (avg === null) return 0;
  return Math.sqrt(mean(values.map((value) => (value - avg) ** 2)));
}

function returnPct(values, period) {
  if (values.length <= period) return null;
  const previous = values[values.length - 1 - period];
  const current = values[values.length - 1];
  if (!previous) return null;
  return ((current / previous) - 1) * 100;
}

function trueRanges(bars) {
  const ranges = [];
  for (let index = 1; index < bars.length; index += 1) {
    const bar = bars[index];
    const previousClose = bars[index - 1].close;
    ranges.push(Math.max(bar.high - bar.low, Math.abs(bar.high - previousClose), Math.abs(bar.low - previousClose)));
  }
  return ranges;
}

function atrPct(bars, period = 14) {
  const ranges = trueRanges(bars).slice(-period);
  const avg = mean(ranges);
  const close = bars.at(-1)?.close;
  if (!avg || !close) return null;
  return (avg / close) * 100;
}

function higherLowDays(bars, maxDays = 5) {
  if (bars.length < 2) return 0;
  let days = 0;
  for (let index = bars.length - 1; index > 0 && days < maxDays; index -= 1) {
    if (bars[index].low > bars[index - 1].low) days += 1;
    else break;
  }
  return days;
}

function percentileRank(value, values) {
  const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return 0.5;
  const below = clean.filter((item) => item <= value).length;
  return below / clean.length;
}

function slopePct(values, period = 5) {
  if (values.length < period + 1) return null;
  const last = values.at(-1);
  const first = values.at(-1 - period);
  if (!first) return null;
  return ((last / first) - 1) * 100;
}

function formatCode(code) {
  if (!code) return '--';
  if (String(code).startsWith('6')) return `${code}.XSHG`;
  if (String(code).startsWith('8') || String(code).startsWith('4')) return `${code}.BJSE`;
  return `${code}.XSHE`;
}

module.exports = {
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
};