'use strict';

const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const strategy = require('./lib/strategy');
const marketdata = require('./lib/marketdata');
const store = require('./lib/store');

const PUBLIC_DIR = path.join(__dirname, 'public');
const LAN_MODE = process.argv.includes('--lan') || process.env.LAN === '1';
const HOST = process.env.HOST || (LAN_MODE ? '0.0.0.0' : '127.0.0.1');
const DEFAULT_PORT = Number(process.env.PORT) || 8787;
const STRICT_PORT = process.env.PORT_STRICT === '1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('请求格式不是有效 JSON');
  }
}

async function serveStatic(req, res, pathname) {
  let relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  try { relative = decodeURIComponent(relative); } catch { return sendText(res, 400, 'Bad Request'); }
  const filePath = path.resolve(PUBLIC_DIR, relative);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`) && filePath !== PUBLIC_DIR) {
    return sendText(res, 403, 'Forbidden');
  }
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return sendText(res, 404, 'Not Found');
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
    });
    res.end(data);
  } catch {
    sendText(res, 404, 'Not Found');
  }
}

function roundTradePrice(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

async function handleApi(req, res, url) {
  const { pathname, searchParams } = url;

  if (req.method === 'GET' && pathname === '/api/health') {
    const state = await store.loadState();
    let health;
    try { health = await marketdata.checkDataHealth(); }
    catch (error) { health = { ok: false, error: error.message }; }
    return sendJson(res, 200, { ok: Boolean(health.ok), degraded: !health.ok, data: health, settings: state.settings, time: new Date().toISOString() });
  }

  if (req.method === 'GET' && pathname === '/api/bootstrap') {
    const state = await store.loadState();
    const force = searchParams.get('refresh') === '1';
    const data = await strategy.getBootstrap(state, { force });
    return sendJson(res, 200, data);
  }

  if (req.method === 'GET' && pathname === '/api/market') {
    const context = await strategy.getMarketContext(searchParams.get('refresh') === '1');
    return sendJson(res, 200, {
      market: context.market,
      indexes: context.indexes.map(({ bars: innerBars, ...item }) => item),
      breadth: context.breadth,
      sectors: {
        top: context.sectors.top,
        outflow: context.sectors.outflow,
        mainlines: context.sectors.mainlines,
        bleeding: context.sectors.bleeding,
        market5d: context.sectors.market5d,
      },
      meta: context.meta,
    });
  }

  if (req.method === 'GET' && pathname === '/api/search') {
    const context = await strategy.getMarketContext(false);
    const results = await strategy.searchStocks(context, searchParams.get('q') || '');
    return sendJson(res, 200, { results });
  }

  if (req.method === 'GET' && pathname.startsWith('/api/stock/')) {
    const code = pathname.split('/').at(-1).replace(/\D/g, '').slice(0, 6);
    const state = await store.loadState();
    const context = await strategy.getMarketContext(false);
    const detail = await strategy.getStockDetail(context, code, state.settings);
    return sendJson(res, 200, {
      ...detail,
      inWatchlist: state.watchlist.includes(code),
    });
  }

  if (req.method === 'POST' && pathname === '/api/watchlist') {
    const body = await readBody(req);
    const state = await store.addToWatchlist(body.code);
    return sendJson(res, 200, { ok: true, message: '已加入自选', watchlist: state.watchlist });
  }

  if (req.method === 'DELETE' && pathname.startsWith('/api/watchlist/')) {
    const code = pathname.split('/').at(-1).replace(/\D/g, '');
    const state = await store.removeFromWatchlist(code);
    return sendJson(res, 200, { ok: true, message: '已移出自选', watchlist: state.watchlist });
  }

  if (req.method === 'POST' && pathname === '/api/settings') {
    const body = await readBody(req);
    const state = await store.updateSettings(body.settings || body);
    return sendJson(res, 200, { ok: true, message: '策略参数已保存', settings: state.settings });
  }

  if (req.method === 'POST' && pathname === '/api/paper') {
    const body = await readBody(req);
    const code = String(body.code || '').replace(/\D/g, '').slice(0, 6);
    const state = await store.loadState();
    const context = await strategy.getMarketContext(false);
    const stock = context.stockMap.get(code);
    if (!stock) throw new Error('未找到该股票');
    const quote = await marketdata.getStockQuote(stock);
    const liveStock = quote?.data ? { ...stock, ...quote.data } : stock;
    const kline = await marketdata.getStockKline(liveStock, 120);
    const analysis = strategy.analyzeStock(liveStock, kline.data, context, state.settings);
    if (!analysis) throw new Error('历史数据不足，暂不能记录模拟交易');
    const trade = {
      code,
      name: liveStock.name,
      industry: liveStock.industry,
      entryPrice: roundTradePrice(liveStock.price),
      entryAt: new Date().toISOString(),
      score: analysis.score,
      stopLoss: analysis.plan.stopLoss,
      takeProfit: analysis.plan.takeProfit,
      source: body.source || 'manual',
      profile: strategy.resolveProfile(state.settings, context.market).profile,
      note: analysis.planText,
    };
    const next = await store.addPaperTrade(trade);
    return sendJson(res, 200, { ok: true, message: `已记录 ${liveStock.name} 模拟买入`, state: { paperTrades: next.paperTrades } });
  }

  if (req.method === 'POST' && pathname.match(/^\/api\/paper\/[^/]+\/close$/)) {
    const id = pathname.split('/')[3];
    const state = await store.loadState();
    const trade = state.paperTrades.find((item) => item.id === id);
    if (!trade) throw new Error('模拟持仓不存在');
    const context = await strategy.getMarketContext(false);
    const stock = context.stockMap.get(trade.code);
    if (!stock) throw new Error('未找到行情，暂不能平仓');
    const next = await store.closePaperTrade(id, stock.price, '按最新价模拟平仓');
    return sendJson(res, 200, { ok: true, message: `已按 ${stock.price} 模拟平仓`, state: { paperTrades: next.paperTrades } });
  }

  if (req.method === 'POST' && pathname === '/api/performance/reset') {
    await store.resetPerformance();
    return sendJson(res, 200, { ok: true, message: '模拟战绩已重置' });
  }

  if (req.method === 'GET' && pathname === '/api/performance') {
    const state = await store.loadState();
    const context = await strategy.getMarketContext(false);
    const perf = await strategy.getBootstrap(state, { force: false });
    return sendJson(res, 200, { performance: perf.performance });
  }

  return sendJson(res, 404, { error: '接口不存在' });
}

async function requestHandler(req, res) {
  const started = Date.now();
  res.on('finish', () => {
    if (req.url?.startsWith('/api/')) {
      console.log(`[api] ${req.method} ${req.url.split('?')[0]} ${res.statusCode} ${Date.now() - started}ms`);
    }
  });
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${DEFAULT_PORT}`}`);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method Not Allowed');
    return await serveStatic(req, res, url.pathname);
  } catch (error) {
    console.error('[error]', error.message);
    const status = /未找到|不存在|格式|过大|上限|不能|不足|应为/.test(error.message) ? 400 : 500;
    sendJson(res, status, { error: error.message || '服务器内部错误' });
  }
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => {
      server.removeListener('error', reject);
      resolve(port);
    });
  });
}

async function start() {
  await store.loadState();
  const server = http.createServer(requestHandler);
  let port = DEFAULT_PORT;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    try {
      await listen(server, port);
      break;
    } catch (error) {
      if (error.code !== 'EADDRINUSE' || STRICT_PORT) throw error;
      port += 1;
    }
  }
  const url = `http://127.0.0.1:${port}`;
  console.log('');
  console.log('  智能选股  A股量化作战台');
  console.log(`  已启动: ${url}`);
  if (LAN_MODE) {
    const addresses = Object.values(os.networkInterfaces())
      .flat()
      .filter((item) => item && item.family === 'IPv4' && !item.internal)
      .map((item) => item.address);
    for (const address of addresses) console.log(`  手机访问: http://${address}:${port} （需与电脑连同一 Wi-Fi）`);
    if (!addresses.length) console.log('  手机访问: 未检测到局域网 IP，请先连接 Wi-Fi 或网线');
  }
  console.log('  数据源: 同花顺公开行情（东方财富兜底，仅供研究，不构成投资建议）');
  console.log('  按 Ctrl+C 停止服务');
  console.log('');
  if (process.argv.includes('--open')) {
    const child = spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  }
}

start().catch((error) => {
  console.error('启动失败:', error);
  process.exitCode = 1;
});