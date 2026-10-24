'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeRealhead,
  normalizeSinaStock,
  parseJsonp,
  parseKlineRows,
  parseSectorTable,
  parseStockTable,
  parseUnitNumber,
} = require('../lib/ths');

test('同花顺 JSONP 与日线字段解析正确', () => {
  const payload = parseJsonp('cb({"name":"测试股份","data":"20261022,10,11,9,10.5,1000,100000,1.2,,,0;20261023,10.5,12,10,11.5,2000,200000,2.3,,,0"})');
  const bars = parseKlineRows(payload, 10);
  assert.equal(bars.length, 2);
  assert.deepEqual(
    bars[1],
    {
      date: '2026-10-23',
      open: 10.5,
      high: 12,
      low: 10,
      close: 11.5,
      volume: 2000,
      amount: 200000,
      turnover: 2.3,
      pct: 9.52,
      change: 1,
      amplitude: 19.05,
    },
  );
  assert.equal(parseKlineRows(payload, 1)[0].date, '2026-10-23');
});

test('同花顺实时行情字段归一化', () => {
  const quote = normalizeRealhead({
    items: {
      5: '600519',
      10: '1335.00',
      6: '1318.49',
      7: '1311.84',
      8: '1343.88',
      9: '1310.00',
      13: '5768593',
      19: '7677216300',
      1968584: '0.462',
      2034120: '18.744',
      526792: '2.570',
      199112: '1.25',
      name: '贵州茅台',
    },
  });
  assert.equal(quote.code, '600519');
  assert.equal(quote.name, '贵州茅台');
  assert.equal(quote.price, 1335);
  assert.equal(quote.pct, 1.25);
  assert.equal(quote.turnover, 0.462);
  assert.equal(quote.pe, 18.744);
  assert.equal(quote.prevClose, 1318.49);
});

test('同花顺全市场表格与单位解析正确', () => {
  assert.equal(parseUnitNumber('6.11亿'), 611000000);
  assert.equal(parseUnitNumber('8576.98万'), 85769800);
  assert.equal(parseUnitNumber('--'), null);
  const html = `<table><thead><tr><th>序号</th><th>代码</th></tr></thead><tbody>
    <tr><td>1</td><td><a>600519</a></td><td><a>贵州茅台</a></td><td>1335.00</td><td>1.25</td><td>16.51</td><td>0.00</td><td>0.46</td><td>1.53</td><td>2.57</td><td>76.77亿</td><td>12.56亿</td><td>1.67万亿</td><td>18.74</td><td></td></tr>
  </tbody></table>`;
  const rows = parseStockTable(html);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].code, '600519');
  assert.equal(rows[0].amount, 7677000000);
  assert.equal(rows[0].turnover, 0.46);
  assert.equal(rows[0].volumeRatio, 1.53);
  assert.equal(rows[0].floatCap, 1670000000000);
});

test('同花顺行业板块代码与资金字段解析正确', () => {
  const html = `<table><thead><tr><th>序号</th><th>板块</th></tr></thead><tbody>
    <tr><td>1</td><td><a href="/thshy/detail/code/881121/">半导体</a></td><td>3.65</td><td>4121.61</td><td>2605.47</td><td>140.82</td><td>174</td><td>15</td><td>63.22</td><td><a>粤芯半导体</a></td><td>33.64</td><td>20.01</td></tr>
  </tbody></table>`;
  const rows = parseSectorTable(html);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].code, '881121');
  assert.equal(rows[0].name, '半导体');
  assert.equal(rows[0].pct, 3.65);
  assert.equal(rows[0].netInflow, 14082000000);
  assert.equal(rows[0].upCount, 174);
  assert.equal(rows[0].leaderPct, 20.01);
});

test('新浪全市场记录可转换为统一股票结构', () => {
  const stock = normalizeSinaStock({
    symbol: 'sh600519',
    code: '600519',
    name: '贵州茅台',
    trade: '1335.000',
    pricechange: 16.51,
    changepercent: 1.252,
    settlement: '1318.490',
    open: '1311.840',
    high: '1343.880',
    low: '1310.000',
    volume: 5768593,
    amount: 7677216300,
    turnoverratio: 0.462,
    per: 18.744,
    pb: 2.57,
    mktcap: 166885890,
    nmc: 166885890,
  });
  assert.equal(stock.code, '600519');
  assert.equal(stock.market, 1);
  assert.equal(stock.price, 1335);
  assert.equal(stock.pct, 1.252);
  assert.equal(stock.floatCap, 1668858900000);
  assert.equal(stock.prevClose, 1318.49);
});