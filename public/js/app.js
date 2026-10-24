'use strict';

const VIEW_META = {
  overview: { title: '今日总览', kicker: 'COMMAND CENTER', hash: '#overview' },
  screener: { title: '量化选股', kicker: 'SIGNAL SCREENER', hash: '#screener' },
  tail: { title: '尾盘确认', kicker: 'CLOSE CONFIRMATION', hash: '#tail' },
  watchlist: { title: '自选股', kicker: 'WATCHLIST RADAR', hash: '#watchlist' },
  performance: { title: '模拟战绩', kicker: 'PAPER PERFORMANCE', hash: '#performance' },
};

const state = {
  data: null,
  view: 'overview',
  loading: false,
  error: null,
  settings: null,
  screenerFilter: 'all',
  alertDismissed: false,
  lastUpdated: null,
  searchResults: [],
  searchSeq: 0,
  searchTimer: null,
  selectedCode: null,
  detail: null,
  detailError: null,
  klineRange: 60,
  overlay: null,
  clockTimer: null,
  autoTimer: null,
  demoReason: '',
  feedbackPending: false,
};

let sparkUid = 0;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function attr(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

function icon(name, className = '') {
  return `<svg class="icon ${className}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}

function finite(value) {
  return Number.isFinite(Number(value));
}

function friendlyDataError(message) {
  const text = String(message || '').trim();
  if (!text) return '未知错误';
  if (/fetch failed|network|ECONN|ENOTFOUND|socket|aborted|timeout|ETIMEDOUT/i.test(text)) return '无法连接行情服务';
  return text;
}

function number(value, digits = 2, fallback = '--') {
  if (!finite(value)) return fallback;
  return Number(value).toFixed(digits);
}

function signed(value, digits = 2, suffix = '%') {
  if (!finite(value)) return '--';
  const rounded = Number(value).toFixed(digits);
  return `${Number(value) > 0 ? '+' : ''}${rounded}${suffix}`;
}

function pctText(value, digits = 2) {
  return signed(value, digits, '%');
}

function toneClass(value) {
  if (!finite(value) || Number(value) === 0) return 'neutral';
  return Number(value) > 0 ? 'up' : 'down';
}

function scoreTone(score) {
  if (!finite(score)) return 'warn';
  if (Number(score) >= 62) return 'up';
  if (Number(score) < 46) return 'down';
  return 'warn';
}

function orbColor(score) {
  const tone = scoreTone(score);
  if (tone === 'up') return 'var(--red)';
  if (tone === 'down') return 'var(--green)';
  return 'var(--amber)';
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, finite(value) ? Number(value) : min));
}

function amountYi(value) {
  if (!finite(value)) return '--';
  return `${number(Number(value) / 100000000, 2)}亿`;
}

function compactAmount(value) {
  if (!finite(value)) return '--';
  const amount = Number(value);
  if (amount >= 100000000) return `${number(amount / 100000000, 2)}亿`;
  if (amount >= 10000) return `${number(amount / 10000, 0)}万`;
  return number(amount, 0);
}

function formatDateTime(value, withTime = true) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
    hour: withTime ? '2-digit' : undefined,
    minute: withTime ? '2-digit' : undefined,
    hour12: false,
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return withTime ? `${map.month}-${map.day} ${map.hour}:${map.minute}` : `${map.month}-${map.day}`;
}

function shanghaiParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    weekday: map.weekday,
    date: `${map.year}-${map.month}-${map.day}`,
    time: `${map.hour}:${map.minute}:${map.second}`,
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
    minutes: Number(map.hour) * 60 + Number(map.minute),
  };
}

function toast(message, type = 'info', duration = 2800) {
  const root = $('#toast-root');
  if (!root) return;
  const item = document.createElement('div');
  item.className = `toast ${type === 'error' ? 'is-error' : type === 'success' ? 'is-success' : ''}`;
  const iconName = type === 'error' ? 'alert' : type === 'success' ? 'check' : 'info';
  item.innerHTML = `${icon(iconName)}<span>${escapeHtml(message)}</span>`;
  root.appendChild(item);
  window.setTimeout(() => {
    item.classList.add('is-leaving');
    window.setTimeout(() => item.remove(), 220);
  }, duration);
}

async function api(path, options = {}) {
  const { timeout = 20000, ...rest } = options;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeout);
  try {
    return await apiRequest(path, rest, controller.signal);
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('行情响应超时，请稍后重试');
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

async function apiRequest(path, options = {}, signal) {
  const response = await fetch(path, {
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
    signal,
  });
  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok) throw new Error(payload?.error || `请求失败（HTTP ${response.status}）`);
  return payload;
}

function getEffectiveProfile() {
  const effective = state.data?.screener?.effective;
  if (effective?.profile) return effective;
  const settings = state.settings || {};
  return { profile: settings.profile || 'auto', minScore: settings.minScore ?? 72, maxPositions: settings.maxPositions ?? 4, positionPct: 12 };
}

function profileLabel(profile) {
  return { auto: '自适应', balanced: '均衡档', defense: '防守档', offense: '进攻档' }[profile] || profile || '自适应';
}

function actionBadge(action) {
  const item = action || { label: '等待', tone: 'neutral' };
  return `<span class="badge ${attr(item.tone || 'neutral')}">${escapeHtml(item.label || item.labelLong || '等待')}</span>`;
}

function arrowAction(label = '查看', extra = '') {
  return `<button class="section-link" ${extra}>${escapeHtml(label)}${icon('chevron')}</button>`;
}

function emptyState(title, text, actionLabel = '', action = '') {
  return `<div class="empty-state">
    <div class="empty-icon">${icon('radar')}</div>
    <h3>${escapeHtml(title)}</h3>
    <p>${escapeHtml(text)}</p>
    ${actionLabel ? `<button class="btn btn-sm" data-action="${attr(action)}">${escapeHtml(actionLabel)}</button>` : ''}
  </div>`;
}

function sparkline(values, options = {}) {
  const clean = (Array.isArray(values) ? values : []).map(Number).filter(Number.isFinite);
  if (clean.length < 2) return `<div class="${options.className || 'spark-wrap'}"></div>`;
  const width = 100;
  const height = 34;
  const pad = 2;
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const span = max - min || 1;
  const points = clean.map((value, index) => {
    const x = pad + (index / (clean.length - 1)) * (width - pad * 2);
    const y = height - pad - ((value - min) / span) * (height - pad * 2);
    return [x, y];
  });
  const line = points.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  const area = `${line} L${(width - pad).toFixed(2)},${height} L${pad},${height} Z`;
  const up = clean.at(-1) >= clean[0];
  const color = up ? 'var(--red)' : 'var(--green)';
  const id = `sp-${++sparkUid}`;
  return `<div class="${options.className || 'spark-wrap'}"><svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="价格走势">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".22"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
    <path d="${area}" fill="url(#${id})"/>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
  </svg></div>`;
}

function scoreOrb(score, label = '综合评分', small = false) {
  const safe = clamp(score ?? 0, 0, 100);
  return `<div class="score-orb${small ? ' small' : ''}" style="--score:${safe};--orb:${orbColor(safe)}">
    <div class="score-orb-inner"><strong>${finite(score) ? Math.round(score) : '--'}</strong><span>/ 100</span><em>${escapeHtml(label)}</em></div>
  </div>`;
}

function checkItem(check) {
  return `<span class="check-item ${check.ok ? 'ok' : ''}"><span class="check-icon">${icon(check.ok ? 'check' : 'close')}</span>${escapeHtml(check.label)}</span>`;
}

async function init() {
  bindEvents();
  const hashView = location.hash.replace('#', '');
  if (VIEW_META[hashView]) state.view = hashView;
  syncViewChrome();
  if (new URLSearchParams(location.search).get('demo') === '1') {
    await loadDemo();
    scheduleAutoRefresh();
    return;
  }
  await loadDashboard(false);
  scheduleAutoRefresh();
}

async function loadDashboard(force = false, silent = false) {
  if (state.loading) return;
  state.loading = true;
  state.error = null;
  if (!silent) setRefreshBusy(true);
  if (!state.data) renderView();
  try {
    const payload = await api(`api/bootstrap${force ? '?refresh=1' : ''}`, { timeout: 45000 });
    state.data = payload;
    state.settings = payload.settings || state.settings;
    state.demoReason = '';
    state.lastUpdated = Date.now();
    if (payload.alert?.buySignals + payload.alert?.qualifiedCandidates > 0) state.alertDismissed = false;
    updateChrome();
    renderView();
  } catch (error) {
    state.error = error.message || '行情加载失败';
    if (!state.data) {
      state.loading = false;
      await loadDemo(true, { reason: state.error, automatic: true });
      return;
    }
    if (state.data?.meta?.demo) state.demoReason = state.error;
    if (!silent) toast(friendlyDataError(state.error), 'error', 4200);
    updateChrome();
    renderView();
  } finally {
    state.loading = false;
    setRefreshBusy(false);
  }
}

async function loadDemo(silent = false, options = {}) {
  if (state.loading) return;
  state.loading = true;
  state.error = null;
  if (!state.data) renderView();
  try {
    const payload = await api('/data/demo.json');
    state.data = payload;
    state.settings = payload.settings || state.settings;
    state.demoReason = options.reason || '';
    state.lastUpdated = Date.now();
    state.alertDismissed = false;
    updateChrome();
    renderView();
    if (options.automatic) toast('实时行情不可用，已切换到演示模式；页面数据不是真实行情', 'error', 5200);
    else if (!silent) toast('已载入演示数据，可预览全部功能', 'info', 3200);
  } catch (error) {
    state.error = error.message || '演示数据载入失败';
    renderView();
    toast(friendlyDataError(state.error), 'error', 3600);
  } finally {
    state.loading = false;
  }
}

function scheduleAutoRefresh() {
  window.clearInterval(state.autoTimer);
  state.autoTimer = window.setInterval(() => {
    const seconds = Number(state.settings?.refreshInterval) || 90;
    if (document.hidden || state.loading || state.data?.meta?.demo) return;
    if (!state.data || Date.now() - (state.lastUpdated || 0) < seconds * 1000) return;
    loadDashboard(true, true);
  }, 5000);
}

function demoReadOnly() {
  if (!state.data?.meta?.demo) return false;
  toast('演示模式为只读，恢复实时行情后才能修改', 'info', 3200);
  return true;
}

function demoSearch(term) {
  const keyword = String(term || '').trim().toLowerCase();
  if (!keyword) return [];
  const pools = [
    ...(state.data?.watchlist || []),
    ...(state.data?.screener?.candidates || []),
    ...(state.data?.screener?.exclusions || []),
  ];
  const seen = new Set();
  return pools.filter((item) => {
    if (!item || seen.has(item.code)) return false;
    const match = String(item.code).includes(keyword) || String(item.name).toLowerCase().includes(keyword);
    if (match) seen.add(item.code);
    return match;
  }).slice(0, 12).map((item) => ({
    code: item.code,
    name: item.name,
    displayCode: item.displayCode || item.code,
    price: item.price,
    pct: item.pct,
    industry: item.industry,
  }));
}

function buildDemoDetail(code) {
  const pools = [...(state.data?.watchlist || []), ...(state.data?.screener?.candidates || [])];
  const item = pools.find((stock) => stock.code === code);
  if (!item) return null;
  const price = Number(item.price) || 10;
  const pct = Number(item.pct) || 0;
  const prevClose = Number(item.prevClose) || price / (1 + pct / 100);
  const bars = Array.from({ length: 90 }, (_, index) => {
    const progress = index / 89;
    const base = price * 0.88 + (price * 0.12) * progress;
    const wave = Math.sin(index * 0.47) * price * 0.013 + Math.cos(index * 0.19) * price * 0.009;
    const close = index === 89 ? price : Math.max(price * 0.72, base + wave);
    return { date: `2026-06-${String((index % 28) + 1).padStart(2, '0')}`, open: close * 0.996, close, high: close * 1.018, low: close * 0.985, volume: 1000000 + index * 2000, amount: 120000000 + index * 300000 };
  });
  const trends = Array.from({ length: 120 }, (_, index) => {
    const progress = index / 119;
    const base = prevClose + (price - prevClose) * progress;
    const wave = Math.sin(index * 0.18) * prevClose * 0.004;
    return { time: `${String(9 + Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}`, close: base + wave, open: base, high: base + wave + 0.01, low: base + wave - 0.01, volume: 10000, amount: 200000, avg: base };
  });
  return {
    stock: {
      code: item.code, name: item.name, price, pct, prevClose, industry: item.industry,
      high: price * 1.025, low: price * 0.975, open: prevClose * 1.002,
      volumeRatio: item.volumeRatio, turnover: item.turnover, netInflow: item.netInflow,
      secid: item.code.startsWith('6') ? `1.${item.code}` : `0.${item.code}`,
    },
    analysis: item,
    bars,
    intraday: { preClose: prevClose, trends },
    inWatchlist: Boolean((state.data?.watchlist || []).some((stock) => stock.code === code)),
  };
}
function setRefreshBusy(busy) {
  $$('[data-action="refresh"]').forEach((button) => button.classList.toggle('is-spinning', busy));
  const chip = $('#data-chip-text');
  if (busy && chip) chip.textContent = '同步中';
}

function updateChrome() {
  const data = state.data;
  const demo = Boolean(data?.meta?.demo);
  const market = data?.market;
  const score = market?.score;
  const status = market?.status || '等待数据';
  const sideScore = $('#side-score');
  const sideStatus = $('#side-status');
  const sideBar = $('#side-score-bar');
  const sideLine = $('#side-market-line');
  const sideLive = $('#side-live');
  if (sideScore) sideScore.textContent = finite(score) ? Math.round(score) : '--';
  if (sideStatus) {
    sideStatus.textContent = status;
    sideStatus.className = scoreTone(score);
  }
  if (sideBar) sideBar.style.width = `${clamp(score ?? 0, 0, 100)}%`;
  if (sideLine) sideLine.textContent = market ? `${market.stateLine || ''} ${market.summary || ''}`.trim() : '正在读取市场宽度与趋势...';
  if (sideLive) {
    sideLive.classList.toggle('is-off', Boolean(state.error));
    sideLive.innerHTML = `<i></i>${state.error ? (demo ? '演示·离线' : '离线') : demo ? '演示' : data ? (data.meta?.stale ? '缓存' : '在线') : '接入中'}`;
  }

  const chip = $('#data-chip');
  const chipText = $('#data-chip-text');
  if (chip) {
    chip.classList.toggle('is-off', Boolean(state.error) || Boolean(data?.meta?.stale && !demo));
    chip.classList.toggle('is-demo', demo);
    chip.title = demo && state.demoReason
    ? `演示数据：${friendlyDataError(state.demoReason)}`
    : data?.meta?.dataSource
      ? `数据源：${data.meta.dataSource}${data.meta.dataDate ? ` · ${data.meta.dataDate}` : ''}`
      : '行情数据状态';
  }
  if (chipText) chipText.textContent = state.error ? (demo ? '演示 · 离线' : '连接异常') : demo ? '演示数据' : data ? (data.meta?.stale ? '缓存行情' : '行情在线') : '正在接入';

  const qualified = data?.screener?.qualifiedCount ?? 0;
  const candidates = data?.screener?.candidates?.length ?? 0;
  const navScreener = $('#nav-screener-count');
  if (navScreener) {
    navScreener.textContent = String(qualified || candidates || 0);
    navScreener.classList.toggle('is-hot', qualified > 0);
  }
  const navWatch = $('#nav-watch-count');
  if (navWatch) navWatch.textContent = String(data?.watchlist?.length ?? 0);

  const footDate = $('#foot-data-date');
  if (footDate) footDate.textContent = data?.meta?.dataDate || '--';
  const footerUpdated = $('#footer-updated');
  if (footerUpdated) footerUpdated.textContent = state.error ? (demo ? '演示数据 · 实时连接失败' : `同步失败：${friendlyDataError(state.error)}`) : demo ? '演示数据 · 不代表实时行情' : state.lastUpdated ? `最近同步 ${formatDateTime(new Date(state.lastUpdated).toISOString())}` : '尚未同步';

  renderAlert();
}

function renderAlert() {
  const ribbon = $('#alert-ribbon');
  if (!ribbon) return;
  const alert = state.data?.alert;
  const candidates = state.data?.screener?.candidates || [];
  const focus = candidates.find((item) => item.qualified) || candidates[0];
  if (!alert || state.alertDismissed || (!alert.buySignals && !alert.qualifiedCandidates)) {
    ribbon.hidden = true;
    return;
  }
  ribbon.hidden = false;
  const title = $('#alert-title');
  const text = $('#alert-text');
  const total = (alert.buySignals || 0) + (alert.qualifiedCandidates || 0);
  if (title) title.textContent = `今日发现 ${total} 个候选信号`;
  if (text) text.textContent = focus ? `${focus.name} · ${focus.industry} · 综合评分 ${focus.score}` : alert.message;
  const action = $('.alert-action', ribbon);
  if (action) {
    action.dataset.viewTarget = 'screener';
  }
}

function setView(view, options = {}) {
  if (!VIEW_META[view]) return;
  state.view = view;
  if (options.hash !== false) history.replaceState(null, '', VIEW_META[view].hash);
  syncViewChrome();
  renderView();
  if (options.scroll !== false) window.scrollTo({ top: 0, behavior: 'smooth' });
  window.clearInterval(state.clockTimer);
  if (view === 'tail') {
    state.clockTimer = window.setInterval(updateTailClock, 1000);
    updateTailClock();
  }
}

function syncViewChrome() {
  const meta = VIEW_META[state.view] || VIEW_META.overview;
  const title = $('#page-title');
  const kicker = $('#page-kicker');
  if (title) title.textContent = meta.title;
  if (kicker) kicker.textContent = meta.kicker;
  document.title = `${meta.title} · 智能选股`;
  $$('[data-view]').forEach((button) => button.classList.toggle('is-active', button.dataset.view === state.view));
}

function renderView() {
  const root = $('#view-root');
  if (!root) return;
  if (!state.data) {
    if (state.error) {
      root.innerHTML = renderErrorState();
    } else {
      root.innerHTML = `<section class="loading-view" aria-label="加载中"><div class="loading-caption"><i></i><span>正在接入同花顺行情，首次加载约需 5–10 秒…</span></div><div class="skeleton skeleton-hero"></div><div class="skeleton-grid"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div><div class="skeleton skeleton-list"></div></section>`;
    }
    return;
  }
  let html = '';
  if (state.view === 'overview') html = renderOverview();
  else if (state.view === 'screener') html = renderScreener();
  else if (state.view === 'tail') html = renderTail();
  else if (state.view === 'watchlist') html = renderWatchlist();
  else if (state.view === 'performance') html = renderPerformance();
  const demoReason = state.demoReason ? `实时行情不可用（${escapeHtml(friendlyDataError(state.demoReason))}）。` : '';
  const demoBanner = state.data?.meta?.demo ? `<div class="demo-banner">${icon('info')}<span>${demoReason}当前为内置演示数据，不是真实行情，仅用于预览功能。</span><button class="demo-banner-action" data-action="refresh">重试实时行情</button></div>` : '';
  root.innerHTML = demoBanner + html;
  if (state.view === 'tail') updateTailClock();
}

function renderErrorState() {
  const message = state.error || '未知错误';
  return `<section class="view-section">
    <div class="panel error-panel">
      <div class="error-icon">${icon('alert')}</div>
      <h2>暂时无法读取行情</h2>
      <p>后端已启动，但公开行情接口当前不可达，或网络访问被系统拦截。页面不会使用虚构数据，请恢复网络后重试。</p>
      <code>${escapeHtml(message)}</code>
      <div class="error-actions">
        <button class="btn btn-primary" data-action="refresh">${icon('refresh')}重新连接</button>
        <button class="btn" data-action="open-settings">${icon('settings')}检查参数</button>
        <button class="btn" data-action="load-demo">${icon('chart')}预览演示界面</button>
      </div>
      <div class="offline-hint">${icon('info')}<span>若服务由 Codex 沙箱启动，行情请求可能被限制。关闭终端后，双击项目里的「启动量化工具」脚本，可在普通桌面环境重新启动。</span></div>
    </div>
  </section>`;
}

function updateTailClock() {
  const clock = $('#tail-countdown');
  if (!clock) return;
  const info = tailStatus();
  clock.innerHTML = `${escapeHtml(info.countdown)}${info.suffix ? `<small>${escapeHtml(info.suffix)}</small>` : ''}`;
  const phase = $('#tail-live-phase');
  if (phase) phase.textContent = info.phase;
  const hint = $('#tail-live-hint');
  if (hint) hint.textContent = info.hint;
  const bars = $$('#tail-window i');
  bars.forEach((bar, index) => bar.classList.toggle('active', index < info.progress));
}

function tailStatus() {
  const now = shanghaiParts();
  const weekend = now.weekday === '周六' || now.weekday === '周日';
  const start = 14 * 60 + 45;
  const end = 15 * 60;
  if (weekend) return { phase: '周末休市', countdown: '--:--:--', suffix: '', hint: '下个交易日再执行尾盘检查', progress: 0, active: false };
  if (now.minutes < start) {
    const seconds = (start - now.minutes) * 60 - now.second;
    return { phase: '等待尾盘窗口', countdown: clockText(seconds), suffix: '后进入', hint: '14:45 开始执行尾盘确认流程', progress: 0, active: false };
  }
  if (now.minutes < end) {
    const seconds = (end - now.minutes) * 60 - now.second;
    const progress = Math.round(((now.minutes - start) / (end - start)) * 8);
    return { phase: '尾盘确认窗口', countdown: clockText(seconds), suffix: '后收盘', hint: '只确认已达标信号，不追高、不新增犹豫仓位', progress: clamp(progress, 1, 8), active: true };
  }
  return { phase: '今日已收盘', countdown: '--:--:--', suffix: '', hint: '复盘当日信号，准备下一交易日计划', progress: 8, active: false };
}

function clockText(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map((value) => String(value).padStart(2, '0')).join(':');
}
function renderOverview() {
  const data = state.data;
  const market = data.market || {};
  const breadth = data.breadth || {};
  const screener = data.screener || {};
  const indexes = data.indexes || [];
  const sectors = data.sectors || {};
  const candidates = screener.candidates || [];
  const watchlist = data.watchlist || [];
  const performance = data.performance || {};
  const meta = data.meta || {};
  const modules = market.modules || [];
  const upWidth = breadth.total ? ((breadth.up || 0) / breadth.total) * 100 : 0;
  const flatWidth = breadth.total ? ((breadth.flat || 0) / breadth.total) * 100 : 0;
  const downWidth = breadth.total ? ((breadth.down || 0) / breadth.total) * 100 : 0;

  const moduleRows = modules.map((item) => {
    const raw = Number(item.raw) || 0;
    const contribution = Number(item.contribution) || 0;
    return `<div class="module-row">
      <div class="module-label"><strong>${escapeHtml(item.name)}</strong><span>权重 ${escapeHtml(item.weight)}%</span></div>
      <div class="module-mid">
        <div class="progress ${raw >= 60 ? 'red' : raw < 45 ? 'green' : ''}"><span style="width:${clamp(raw, 0, 100)}%"></span></div>
        <p>${escapeHtml(item.primary || '')}${item.secondary ? ` / ${escapeHtml(item.secondary)}` : ''}</p>
      </div>
      <div class="module-score ${scoreTone(raw)}"><strong>${contribution > 0 ? '+' : ''}${number(contribution, 1)}</strong><span>贡献分</span></div>
    </div>`;
  }).join('');

  const indexCards = indexes.map((item) => `<div class="index-card">
      <div class="index-card-top"><span class="index-card-name">${escapeHtml(item.short || item.name)}<b>${escapeHtml(item.code || '')}</b></span><span class="badge ${toneClass(item.pct)}">${pctText(item.pct)}</span></div>
      <div class="index-card-price">${number(item.price, 2)}</div>
      <div class="index-card-bottom"><span class="${toneClass(item.pct)}">${pctText(item.pct)}</span><span class="faint">5日 ${pctText(item.ret5)}</span></div>
      <div class="index-card-meta">MA5 <b>${number(item.ma5)}</b> · MA10 <b>${number(item.ma10)}</b></div>
    </div>`).join('');

  const candidateRows = candidates.slice(0, 5).map((item, index) => `<div class="candidate-mini" data-action="open-stock" data-code="${attr(item.code)}" role="button" tabindex="0">
      <span class="rank-no ${index < 2 ? 'top' : ''}">${String(index + 1).padStart(2, '0')}</span>
      <span class="candidate-mini-main"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.industry)} · ${escapeHtml(item.statusLabel || '观察')}</span></span>
      <span class="mini-price">${number(item.price)}<span class="${toneClass(item.pct)}">${pctText(item.pct)}</span></span>
      <span class="mini-score">${number(item.score, 0)}<span>评分</span></span>
      <span class="mini-action">${actionBadge(item.action)}</span>
    </div>`).join('');

  const watchRows = watchlist.slice(0, 4).map((item) => `<div class="watch-preview" data-action="open-stock" data-code="${attr(item.code)}" role="button" tabindex="0">
      <div class="wp-main"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.displayCode || item.code)} · ${escapeHtml(item.industry || '')}</small></div>
      <div class="wp-price">${number(item.price)}<span class="${toneClass(item.pct)}">${pctText(item.pct)}</span></div>
      <span class="badge ${attr(item.action?.tone || 'neutral')}">${escapeHtml(item.action?.label || '等待')}</span>
    </div>`).join('');

  const topSectors = (sectors.top || []).slice(0, 5).map((item) => `<span class="sector-chip">${escapeHtml(item.name)}<b class="up">${pctText(item.pct)}</b></span>`).join('');
  const bleeding = (sectors.outflow || []).slice(0, 3).map((item) => `<span class="sector-chip bleed">${escapeHtml(item.name)}<b class="down">${pctText(item.excess5)}</b></span>`).join('');
  const mainlines = (sectors.mainlines || []).join(' / ') || '暂无明确主线';
  const bleedingText = (sectors.bleeding || []).join(' / ') || '暂无持续失血板块';

  return `<section class="view-section">
    <div class="quick-grid">
      <button class="quick-card" data-view-target="screener"><span class="quick-icon">${icon('radar')}</span><span class="quick-copy"><strong>量化选股</strong><span>评分过滤 · 板块共振</span></span>${icon('arrow')}</button>
      <button class="quick-card" data-view-target="tail"><span class="quick-icon">${icon('clock')}</span><span class="quick-copy"><strong>尾盘确认</strong><span>14:45 - 15:00</span></span>${icon('arrow')}</button>
      <button class="quick-card" data-view-target="watchlist"><span class="quick-icon">${icon('star')}</span><span class="quick-copy"><strong>自选分析</strong><span>${watchlist.length} 只正在跟踪</span></span>${icon('arrow')}</button>
      <button class="quick-card" data-view-target="performance"><span class="quick-icon">${icon('chart')}</span><span class="quick-copy"><strong>模拟战绩</strong><span>${performance.openCount || 0} 笔持仓中</span></span>${icon('arrow')}</button>
    </div>

    <div class="overview-main">
      <div class="overview-column">
        <article class="panel market-hero">
          <div class="market-hero-head">
            <div>
              <div class="market-kicker">MARKET REGIME / ${escapeHtml(meta.dataDate || '--')}</div>
              <h2 class="market-title">明日大盘预测</h2>
              <div class="market-subline"><span class="${attr(market.statusTone || 'warn')}">${escapeHtml(market.status || '中性')}</span><span class="dot"></span><span>${escapeHtml(market.stateLine || '等待市场数据')}</span><span class="dot"></span><span>${escapeHtml(meta.marketPhase || '已收盘')}</span></div>
              <p class="market-summary">${escapeHtml(market.summary || '')}</p>
            </div>
            ${scoreOrb(market.score, market.status || '中性')}
          </div>
          <div class="module-list">${moduleRows || `<div class="empty-state"><p>暂无评分模块</p></div>`}</div>
          <div class="core-points">
            <div class="core-point"><span class="up">多头依据</span><p>${escapeHtml(market.core?.bull || '暂无')}</p></div>
            <div class="core-point"><span class="down">空头压制</span><p>${escapeHtml(market.core?.bear || '暂无')}</p></div>
            <div class="core-point"><span class="warn">结构分化</span><p>${escapeHtml(market.core?.divergence || '暂无')}</p></div>
          </div>
          <div class="breadth-strip">
            <div>
              <div class="breadth-counts"><strong class="up">${number(breadth.up, 0)}</strong><span>上涨</span><strong class="down" style="margin-left:8px">${number(breadth.down, 0)}</strong><span>下跌</span><strong style="margin-left:8px">${number(breadth.flat, 0)}</strong><span>平盘</span></div>
              <div class="breadth-bar"><i class="b-up" style="width:${upWidth}%"></i><i class="b-flat" style="width:${flatWidth}%"></i><i class="b-down" style="width:${downWidth}%"></i></div>
            </div>
            <div class="breadth-meta"><span>宽度 <b>${number(breadth.upRatioPct, 1)}%</b></span><span>涨停 <b class="up">${number(breadth.limitUp, 0)}</b></span><span>跌停 <b class="down">${number(breadth.limitDown, 0)}</b></span></div>
            <div class="breadth-meta"><span>成交额 <b>${number(breadth.totalAmountYi, 1)}亿</b></span><span>主力 <b class="${toneClass(breadth.netInflowYi)}">${signed(breadth.netInflowYi, 2, '亿')}</b></span></div>
          </div>
        </article>

        <section class="panel">
          <div class="panel-head"><div class="panel-title">${icon('radar')}板块雷达 <span class="panel-sub">SECTOR MOMENTUM</span></div><span class="badge ${Number(sectors.market5d) >= 0 ? 'up' : 'down'}">大盘5日 ${pctText(sectors.market5d)}</span></div>
          <div class="panel-body">
            <div class="sector-chips">${topSectors || `<span class="sector-empty">暂无领涨板块</span>`}</div>
            <div class="sector-mainlines">
              <div class="sector-label">领涨主线</div>
              <div class="sector-line"><b>${escapeHtml(mainlines)}</b></div>
              <div class="sector-label" style="margin-top:13px">失血 / 规避</div>
              <div class="sector-chips">${bleeding || `<span class="sector-empty">暂无持续失血板块</span>`}</div>
              <div class="sector-line"><span class="down">${escapeHtml(bleedingText)}</span></div>
            </div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-head"><div class="panel-title">${icon('bolt')}今日候选 <span class="panel-sub">TOP SIGNALS</span></div><button class="section-link" data-view-target="screener">全部 ${candidates.length} 只${icon('chevron')}</button></div>
          <div class="candidate-preview-list">${candidateRows || emptyState('暂无候选', '当前筛选条件下没有合格标的，空仓也是一种仓位。')}</div>
        </section>
      </div>

      <div class="overview-column side">
        <section>
          <div class="section-head"><div><h2 class="section-title">${icon('chart')}指数状态</h2><p class="section-desc">趋势与均线位置</p></div><span class="badge ${attr(market.statusTone || 'warn')}">${escapeHtml(market.status || '中性')}</span></div>
          <div class="index-grid">${indexCards || emptyState('暂无指数数据', '等待行情接口恢复。')}</div>
        </section>

        <section class="panel">
          <div class="panel-head"><div class="panel-title">${icon('star')}自选观察 <span class="panel-sub">${watchlist.length} STOCKS</span></div><button class="section-link" data-view-target="watchlist">管理${icon('chevron')}</button></div>
          <div class="watch-preview-list">${watchRows || emptyState('自选股为空', '搜索股票并加入自选，即可开始跟踪。')}</div>
        </section>

        <section class="panel">
          <div class="panel-head"><div class="panel-title">${icon('wallet')}模拟战绩 <span class="panel-sub">PAPER TRADING</span></div><button class="section-link" data-view-target="performance">详情${icon('chevron')}</button></div>
          <div class="perf-mini-grid">
            <div class="perf-mini"><strong>${performance.totalTrades || 0}</strong><span>累计交易</span></div>
            <div class="perf-mini"><strong class="${performance.winRate >= 50 ? 'up' : performance.winRate !== null ? 'down' : ''}">${performance.winRate === null ? '--' : `${number(performance.winRate, 1)}%`}</strong><span>胜率</span></div>
            <div class="perf-mini"><strong class="${toneClass(performance.totalPnlPct)}">${performance.totalPnlPct === null ? '--' : pctText(performance.totalPnlPct)}</strong><span>累计收益</span></div>
          </div>
          <div class="panel-body" style="padding-top:12px"><button class="btn btn-sm" style="width:100%" data-action="open-paper" ${performance.openCount ? '' : 'disabled'}>${icon('wallet')}${performance.openCount ? `查看 ${performance.openCount} 笔模拟持仓` : '暂无模拟持仓'}</button></div>
        </section>
      </div>
    </div>
  </section>`;
}

function renderScreener() {
  const screener = state.data.screener || {};
  const candidates = screener.candidates || [];
  const effective = getEffectiveProfile();
  const filter = state.screenerFilter;
  const filtered = candidates.filter((item) => filter === 'all' ? true : filter === 'qualified' ? item.qualified : !item.qualified);
  const exclusions = screener.exclusions || [];
  const filterName = { all: '全部候选', qualified: '达标信号', watch: '观察名单' }[filter] || '全部候选';

  const cards = filtered.map((item, index) => candidateCard(item, index)).join('');
  const exclusionsHtml = exclusions.length ? `<section class="panel exclusion-panel">
    <div class="panel-head"><div class="panel-title">${icon('shield')}风险排除 <span class="panel-sub">BLOCKED BY SECTOR</span></div><span class="badge down">${exclusions.length} 只</span></div>
    <div class="exclusion-list">${exclusions.map((item) => `<div class="exclusion-row"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.reason)}</span><b class="${toneClass(item.pct)}">${pctText(item.pct)}</b></div>`).join('')}</div>
  </section>` : '';

  return `<section class="view-section">
    <div class="page-intro">
      <div><h2>量化选股</h2><p>量价、资金、板块与趋势四维评分；只执行通过确认清单的标的。</p></div>
      <div class="page-intro-actions"><span class="badge ${effective.profile === 'defense' ? 'down' : effective.profile === 'offense' ? 'up' : 'warn'}">${profileLabel(effective.profile)} · 门槛 ${effective.minScore}</span><button class="btn btn-sm" data-action="copy-screener">${icon('download')}复制清单</button></div>
    </div>
    <div class="stat-strip">
      <div class="stat-box"><span>基础股票池</span><strong>${number(screener.poolSize, 0)}</strong><small>通过流动性与风险过滤</small></div>
      <div class="stat-box"><span>深度扫描</span><strong>${number(screener.scanned, 0)}</strong><small>读取 120 日历史行情</small></div>
      <div class="stat-box"><span>入选候选</span><strong>${candidates.length}</strong><small>按综合评分排序</small></div>
      <div class="stat-box"><span>达标信号</span><strong class="${screener.qualifiedCount ? 'up' : ''}">${number(screener.qualifiedCount, 0)}</strong><small>仍需尾盘人工确认</small></div>
    </div>
    <div class="filter-row">
      <div class="segmented" role="tablist" aria-label="候选筛选">
        <button class="${filter === 'all' ? 'is-active' : ''}" data-action="filter-screener" data-filter="all">全部候选 ${candidates.length}</button>
        <button class="${filter === 'qualified' ? 'is-active' : ''}" data-action="filter-screener" data-filter="qualified">达标 ${screener.qualifiedCount || 0}</button>
        <button class="${filter === 'watch' ? 'is-active' : ''}" data-action="filter-screener" data-filter="watch">观察 ${Math.max(0, candidates.length - (screener.qualifiedCount || 0))}</button>
      </div>
      <span class="filter-note">当前：${escapeHtml(filterName)} · 参数与大盘环境自动适配</span>
    </div>
    <div class="candidate-list">${cards || emptyState('没有符合条件的标的', '提高或降低评分门槛，或等待下一轮行情刷新。', '重新扫描', 'refresh')}</div>
    ${exclusionsHtml}
  </section>`;
}

function candidateCard(item, index) {
  const plan = item.plan || {};
  const tags = (item.tags || []).map((tag, tagIndex) => `<span class="tag ${tagIndex === 0 ? 'amber' : tag.includes('流入') ? 'red' : 'blue'}">${escapeHtml(tag)}</span>`).join('');
  const checks = item.confirmation?.checks || [];
  const inWatch = (state.data?.watchlist || []).some((stock) => stock.code === item.code);
  return `<article class="candidate-card ${item.qualified ? 'is-qualified' : ''}">
    <div class="candidate-rank"><b>${String(item.rank || index + 1).padStart(2, '0')}</b><span>${item.qualified ? 'QUALIFIED' : 'WATCH'}</span></div>
    <div class="candidate-content">
      <div class="candidate-head">
        <div>
          <div class="stock-identity"><h3>${escapeHtml(item.name)}</h3><span class="code">${escapeHtml(item.displayCode || item.code)}</span><span class="badge ${item.qualified ? 'warn' : ''}">${escapeHtml(item.statusLabel || '观察')}</span>${actionBadge(item.action)}</div>
          <div class="candidate-price-row"><span class="candidate-price">${number(item.price)}</span><span class="candidate-change ${toneClass(item.pct)}">${pctText(item.pct)}</span><span class="stock-industry">${escapeHtml(item.industry)}</span></div>
          <div class="candidate-meta">换手 <b>${number(item.turnover, 1)}%</b> · 量比 <b>${number(item.volumeRatio)}</b> · 主力 <b class="${toneClass(item.netInflow)}">${signed(item.netInflow, 2, '亿')}</b></div>
        </div>
        <div class="candidate-head-right">
          ${sparkline(item.spark || [])}
          <div class="score-block"><strong class="${scoreTone(item.score)}">${number(item.score, 0)}</strong><span>综合评分</span><div class="progress score-track"><span style="width:${clamp(item.score, 0, 100)}%"></span></div></div>
        </div>
      </div>
      <div class="candidate-tags">${tags || `<span class="tag">等待更多确认</span>`}</div>
      <div class="candidate-note">${escapeHtml(item.note || item.review || '')}</div>
      <div class="plan-row">
        <div class="plan-cell"><span>触发区间</span><strong>${number(plan.triggerLow)} - ${number(plan.triggerHigh)}</strong></div>
        <div class="plan-cell"><span>止损</span><strong class="down">${number(plan.stopLoss)}</strong></div>
        <div class="plan-cell"><span>止盈</span><strong class="up">${number(plan.takeProfit)}</strong></div>
        <div class="plan-cell"><span>仓位</span><strong>${number(item.positionPct || plan.positionPct, 0)}%</strong></div>
        <div class="plan-cell"><span>盈亏比</span><strong>${number(plan.riskReward, 1)} : 1</strong></div>
      </div>
      <div class="checks">${checks.map(checkItem).join('')}</div>
      <div class="candidate-actions">
        <button class="btn btn-sm" data-action="open-stock" data-code="${attr(item.code)}">${icon('search')}详情</button>
        <button class="btn btn-sm" data-action="${inWatch ? 'remove-watch' : 'add-watch'}" data-code="${attr(item.code)}">${icon('star')}${inWatch ? '移出自选' : '加入自选'}</button>
        <span class="spacer"></span>
        <button class="btn btn-sm ${item.qualified ? 'btn-primary' : ''}" data-action="paper-buy" data-code="${attr(item.code)}" data-name="${attr(item.name)}" ${item.qualified ? '' : 'disabled'}>${icon('bolt')}模拟买入</button>
      </div>
    </div>
  </article>`;
}
function renderTail() {
  const data = state.data;
  const screener = data.screener || {};
  const candidates = [...(screener.candidates || [])].sort((a, b) => Number(b.qualified) - Number(a.qualified) || b.score - a.score);
  const qualified = candidates.filter((item) => item.qualified);
  const market = data.market || {};
  const effective = getEffectiveProfile();
  const status = tailStatus();
  const windowBars = Array.from({ length: 8 }, (_, index) => `<i class="${index < status.progress ? 'active' : ''}"></i>`).join('');
  const summaryText = market.score >= 60 ? '大盘评分在及格线上方，可执行已达标信号。' : market.score >= 48 ? '大盘环境中性，只做最强信号并压缩仓位。' : '大盘环境偏弱，尾盘以防守和观察为主。';
  const eligible = candidates.slice(0, 6);

  return `<section class="view-section">
    <div class="page-intro"><div><h2>尾盘确认</h2><p>14:45 - 15:00 只确认已有信号，不临时追高，不扩大风险暴露。</p></div><div class="page-intro-actions"><button class="btn btn-sm" data-view-target="screener">${icon('radar')}返回候选池</button><button class="btn btn-sm" data-action="refresh">${icon('refresh')}刷新确认</button></div></div>
    <div class="tail-hero">
      <div class="panel tail-card">
        <div class="tail-clock"><div class="countdown" id="tail-countdown">${escapeHtml(status.countdown)}${status.suffix ? `<small>${escapeHtml(status.suffix)}</small>` : ''}</div><span class="badge ${status.active ? 'warn' : ''}" id="tail-live-phase">${escapeHtml(status.phase)}</span></div>
        <div class="tail-phase"><span class="live-dot"><i></i>北京时间</span><span>·</span><span id="tail-live-hint">${escapeHtml(status.hint)}</span></div>
        <div class="tail-window"><span>14:45</span><div class="window-track" id="tail-window">${windowBars}</div><span>15:00</span></div>
      </div>
      <div class="panel tail-card">
        <div class="tail-rule-list">
          <div class="tail-rule"><span>大盘评分</span><strong class="${scoreTone(market.score)}">${number(market.score, 0)}</strong></div>
          <div class="tail-rule"><span>候选数量</span><strong>${candidates.length}</strong></div>
          <div class="tail-rule"><span>达标信号</span><strong class="${qualified.length ? 'up' : ''}">${qualified.length}</strong></div>
          <div class="tail-rule"><span>单票上限</span><strong>${number(effective.positionPct, 0)}%</strong></div>
        </div>
        <div class="sector-line" style="margin-top:14px"><span>当前模式</span><b>${profileLabel(effective.profile)}</b><span class="faint">·</span><span>${escapeHtml(market.status || '中性')}</span></div>
      </div>
    </div>
    <div class="panel tail-summary" style="margin-bottom:16px"><div class="tail-summary-copy"><strong>${escapeHtml(summaryText)}</strong><p>${qualified.length ? `${qualified.length} 只标的通过全部 / 多数确认项，仍需检查分时承接与量能。` : '当前没有完全达标的标的，不为了交易而交易。'}</p></div><span class="badge ${qualified.length ? 'warn' : 'blue'}">${qualified.length ? '有确认清单' : '保持空仓'}</span></div>
    <div class="section-head"><div><h2 class="section-title">${icon('clock')}确认清单</h2><p class="section-desc">达标项越多，执行优先级越高</p></div><span class="badge">${qualified.length} 达标 / ${candidates.length} 候选</span></div>
    <div class="candidate-list">${eligible.length ? eligible.map((item, index) => candidateCard(item, index)).join('') : emptyState('今日没有尾盘信号', '等待下一轮扫描；纪律优先于交易频率。', '重新扫描', 'refresh')}</div>
  </section>`;
}

function renderWatchlist() {
  const watchlist = state.data.watchlist || [];
  const navWatch = $('#nav-watch-count');
  if (navWatch) navWatch.textContent = String(watchlist.length);
  if (!watchlist.length) {
    return `<section class="view-section">
      <div class="page-intro"><div><h2>自选股 · 实时分析</h2><p>跟踪量价、资金、板块与交易计划。</p></div><button class="btn btn-sm btn-primary" data-action="focus-search">${icon('plus')}添加自选</button></div>
      <div class="panel">${emptyState('自选股列表为空', '在顶部搜索框输入股票代码或名称，打开详情后加入自选。', '搜索股票', 'focus-search')}</div>
      <div class="add-stock-panel" style="margin-top:14px"><span class="add-icon">${icon('search')}</span><div><strong>快速添加</strong><p>支持股票代码或名称，例如 600000、浦发银行。</p></div><button class="btn btn-sm" data-action="focus-search">${icon('search')}开始搜索</button></div>
    </section>`;
  }

  const cards = watchlist.map((item) => {
    const metrics = item.metrics || {};
    const sector = item.sector;
    const score = Number(item.score) || 0;
    const tags = [];
    if (item.netInflow > 0) tags.push('主力净流入');
    if (metrics.lowDays >= 2) tags.push(`抬底 ${metrics.lowDays} 天`);
    if (sector?.excess5 > 0) tags.push(`${sector.name}共振`);
    if (item.volumeRatio >= 1 && item.volumeRatio <= 2.5) tags.push('量价匹配');
    const tagsHtml = tags.slice(0, 3).map((tag, index) => `<span class="tag ${index === 0 ? 'amber' : index === 1 ? 'blue' : 'red'}">${escapeHtml(tag)}</span>`).join('');
    return `<article class="watch-card">
      <div class="watch-top">
        <div class="watch-top-main"><h3>${escapeHtml(item.name)}</h3><span class="code">${escapeHtml(item.displayCode || item.code)} · ${escapeHtml(item.industry || '未分类')}</span></div>
        <div class="watch-price"><strong class="${toneClass(item.pct)}">${number(item.price)}</strong><span class="${toneClass(item.pct)}">${pctText(item.pct)}</span></div>
      </div>
      <div class="watch-bottom">
        <div class="watch-score"><b class="${scoreTone(score)}">${number(score, 0)}</b><span>评分</span></div>
        <div class="progress"><span style="width:${clamp(score, 0, 100)}%"></span></div>
        <div class="watch-actions"><span class="badge ${attr(item.action?.tone || 'neutral')}">${escapeHtml(item.action?.label || '等待')}</span></div>
      </div>
      <div class="watch-note"><b>${escapeHtml(item.review || '')}</b><br>${escapeHtml(item.planText || '')}</div>
      <div class="watch-tags">${tagsHtml || `<span class="tag">等待确认</span>`}</div>
      <div class="watch-footline"><span>量比 ${number(item.volumeRatio)} · 换手 ${number(item.turnover, 1)}% · ATR ${number(metrics.atrPct, 1)}%</span><span class="bias ${attr(item.bias?.tone || 'neutral')}">${escapeHtml(item.bias?.text || '待确认')}</span></div>
      <div class="candidate-actions">
        <button class="btn btn-sm" data-action="open-stock" data-code="${attr(item.code)}">${icon('search')}详情</button>
        <button class="btn btn-sm" data-action="paper-buy" data-code="${attr(item.code)}" data-name="${attr(item.name)}">${icon('bolt')}模拟买入</button>
        <span class="spacer"></span>
        <button class="btn btn-sm btn-danger" data-action="remove-watch" data-code="${attr(item.code)}">${icon('trash')}移除</button>
      </div>
    </article>`;
  }).join('');

  return `<section class="view-section">
    <div class="page-intro"><div><h2>自选股 · 实时分析</h2><p>共 ${watchlist.length} 只，按加入顺序展示；点击详情查看日线与分时。</p></div><div class="page-intro-actions"><button class="btn btn-sm" data-action="refresh">${icon('refresh')}刷新分析</button><button class="btn btn-sm btn-primary" data-action="focus-search">${icon('plus')}添加自选</button></div></div>
    <div class="watch-toolbar"><button class="btn" data-action="focus-search">${icon('search')}搜索股票</button><span class="filter-note">最多跟踪 30 只，评分与大环境自动适配</span></div>
    <div class="watch-grid">${cards}</div>
  </section>`;
}

function renderPerformance() {
  const performance = state.data.performance || {};
  const open = performance.open || [];
  const closed = performance.closed || [];
  const curve = performance.curve || [];
  const openRows = open.map((trade) => `<tr>
    <td><span class="table-stock"><strong>${escapeHtml(trade.stockName || trade.name)}</strong><small>${escapeHtml(trade.code)}</small></span></td>
    <td>${number(trade.entryPrice)}</td><td>${number(trade.currentPrice)}</td>
    <td class="${toneClass(trade.currentPnlPct)}">${pctText(trade.currentPnlPct)}</td>
    <td class="down">${number(trade.stopLoss)}</td><td class="up">${number(trade.takeProfit)}</td>
    <td>${number(trade.score, 0)}</td>
    <td><button class="btn btn-sm" data-action="close-trade" data-id="${attr(trade.id)}" data-name="${attr(trade.stockName || trade.name)}">${icon('check')}模拟平仓</button></td>
  </tr>`).join('');
  const closedRows = closed.slice(0, 30).map((trade) => `<tr>
    <td><span class="table-stock"><strong>${escapeHtml(trade.name)}</strong><small>${escapeHtml(trade.code)}</small></span></td>
    <td>${number(trade.entryPrice)}</td><td>${number(trade.exitPrice)}</td>
    <td class="${toneClass(trade.pnlPct)}">${pctText(trade.pnlPct)}</td>
    <td>${formatDateTime(trade.entryAt)}</td><td>${formatDateTime(trade.exitAt)}</td>
    <td>${number(trade.score, 0)}</td>
  </tr>`).join('');
  const equity = curve.length >= 2 ? equityChart(curve) : `<div class="equity-empty">${icon('chart')}<span style="margin-top:8px">完成至少一笔模拟交易后显示资金曲线</span></div>`;
  const disciplineCount = performance.openCount || 0;

  return `<section class="view-section">
    <div class="page-intro"><div><h2>模拟战绩</h2><p>只记录手动确认的模拟交易，用于验证纪律与策略，不代表真实收益。</p></div><div class="page-intro-actions"><button class="btn btn-sm btn-danger" data-action="reset-performance">${icon('trash')}重置战绩</button><button class="btn btn-sm" data-action="refresh">${icon('refresh')}刷新</button></div></div>
    <div class="perf-stats">
      <div class="perf-stat"><span>累计交易</span><strong>${performance.totalTrades || 0}</strong><small>${performance.closedCount || 0} 笔已平仓</small></div>
      <div class="perf-stat"><span>胜率</span><strong class="${performance.winRate >= 50 ? 'up' : performance.winRate !== null ? 'down' : ''}">${performance.winRate === null || performance.winRate === undefined ? '--' : `${number(performance.winRate, 1)}%`}</strong><small>近5笔 ${performance.recentWinRate === null || performance.recentWinRate === undefined ? '--' : `${number(performance.recentWinRate, 0)}%`}</small></div>
      <div class="perf-stat"><span>累计收益</span><strong class="${toneClass(performance.totalPnlPct)}">${performance.totalPnlPct === null || performance.totalPnlPct === undefined ? '--' : pctText(performance.totalPnlPct)}</strong><small>按单笔收益简单累加</small></div>
      <div class="perf-stat"><span>平均收益</span><strong class="${toneClass(performance.avgPnlPct)}">${performance.avgPnlPct === null || performance.avgPnlPct === undefined ? '--' : pctText(performance.avgPnlPct)}</strong><small>每笔平仓平均值</small></div>
      <div class="perf-stat"><span>最大回撤</span><strong class="down">${performance.maxDrawdownPct === null || performance.maxDrawdownPct === undefined ? '--' : pctText(performance.maxDrawdownPct)}</strong><small>${disciplineCount} 笔持仓中</small></div>
    </div>
    <div class="perf-layout">
      <section class="panel"><div class="panel-head"><div class="panel-title">${icon('chart')}累计收益曲线 <span class="panel-sub">EQUITY CURVE</span></div><span class="badge ${performance.winRate >= 50 ? 'up' : 'warn'}">${performance.winRate === null || performance.winRate === undefined ? '样本不足' : `胜率 ${number(performance.winRate, 1)}%`}</span></div><div class="equity-wrap">${equity}</div></section>
      <section class="panel perf-side"><h3>执行纪律</h3><div class="perf-side-list">
        <div class="perf-side-row"><span class="dot"></span><span>当前仓位模式</span><b>${profileLabel(getEffectiveProfile().profile)}</b></div>
        <div class="perf-side-row"><span class="dot"></span><span>持仓上限</span><b>${number(getEffectiveProfile().maxPositions, 0)} 只</b></div>
        <div class="perf-side-row"><span class="dot"></span><span>单票仓位</span><b>${number(getEffectiveProfile().positionPct, 0)}%</b></div>
        <div class="perf-side-row"><span class="dot"></span><span>止损 / 止盈</span><b>${number((state.settings || {}).stopLossPct, 1)}% / ${number((state.settings || {}).takeProfitPct, 1)}%</b></div>
        <div class="perf-side-row"><span class="dot"></span><span>纪律状态</span><b class="${performance.discipline === '防守档' ? 'down' : 'warn'}">${escapeHtml(performance.discipline || '常规档')}</b></div>
      </div><div class="divider" style="margin:16px 0"></div><p class="filter-note">模拟交易按最新价平仓，不计算滑点、手续费与涨跌停无法成交的情况。用于研究，不构成投资建议。</p></section>
    </div>
    <section class="panel" style="margin-bottom:16px"><div class="panel-head"><div class="panel-title">${icon('wallet')}持仓中 <span class="panel-sub">OPEN POSITIONS</span></div><span class="badge ${open.length ? 'warn' : ''}">${open.length} 笔</span></div><div class="table-wrap">${open.length ? `<table class="data-table"><thead><tr><th>股票</th><th>买入价</th><th>最新价</th><th>浮动盈亏</th><th>止损</th><th>止盈</th><th>评分</th><th>操作</th></tr></thead><tbody>${openRows}</tbody></table>` : emptyState('暂无模拟持仓', '从选股或自选股列表手动记录模拟买入。', '查看候选', 'go-screener')}</div></section>
    <section class="panel"><div class="panel-head"><div class="panel-title">${icon('check')}已平仓 <span class="panel-sub">CLOSED TRADES</span></div><span class="badge">${closed.length} 笔</span></div><div class="table-wrap">${closed.length ? `<table class="data-table"><thead><tr><th>股票</th><th>买入价</th><th>卖出价</th><th>收益</th><th>买入时间</th><th>平仓时间</th><th>评分</th></tr></thead><tbody>${closedRows}</tbody></table>` : emptyState('暂无历史交易', '平仓后会在这里沉淀交易结果与胜率。')}</div></section>
  </section>`;
}

function equityChart(curve) {
  const values = curve.map((item) => Number(item.equity)).filter(Number.isFinite);
  if (values.length < 2) return '';
  const width = 100;
  const height = 45;
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const span = max - min || 1;
  const points = values.map((value, index) => {
    const x = (index / (values.length - 1)) * width;
    const y = height - ((value - min) / span) * height;
    return [x, y];
  });
  const line = points.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  const area = `${line} L${width},${height} L0,${height} Z`;
  const zeroY = height - ((0 - min) / span) * height;
  const positive = values.at(-1) >= 0;
  const color = positive ? 'var(--red)' : 'var(--green)';
  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="累计收益曲线">
    <defs><linearGradient id="eq-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".22"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
    <line x1="0" y1="${zeroY.toFixed(2)}" x2="${width}" y2="${zeroY.toFixed(2)}" stroke="rgba(255,255,255,.10)" stroke-width=".35" stroke-dasharray="1.2 1.6"/>
    <line x1="0" y1="11.25" x2="100" y2="11.25" stroke="rgba(255,255,255,.035)" stroke-width=".28"/>
    <line x1="0" y1="22.5" x2="100" y2="22.5" stroke="rgba(255,255,255,.035)" stroke-width=".28"/>
    <line x1="0" y1="33.75" x2="100" y2="33.75" stroke="rgba(255,255,255,.035)" stroke-width=".28"/>
    <path d="${area}" fill="url(#eq-fill)"/>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
    <circle cx="${points.at(-1)[0]}" cy="${points.at(-1)[1]}" r="1.7" fill="${color}" vector-effect="non-scaling-stroke"/>
  </svg>`;
}
function openOverlay(markup, drawer = false) {
  const root = $('#overlay-root');
  root.innerHTML = `<div class="overlay ${drawer ? 'is-drawer' : ''}" data-overlay-backdrop="1">${markup}</div>`;
  document.body.classList.add('is-locked');
}

function closeOverlay() {
  const root = $('#overlay-root');
  if (root) root.innerHTML = '';
  document.body.classList.remove('is-locked');
  state.pendingConfirm = null;
}

function confirmDialog(options = {}) {
  state.pendingConfirm = options.onConfirm || null;
  openOverlay(`<div class="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
    <div class="modal-head"><div><h2 id="confirm-title">${escapeHtml(options.title || '请确认')}</h2><p>${escapeHtml(options.subtitle || '此操作需要你的确认')}</p></div><button class="icon-button ghost" data-action="close-overlay" aria-label="关闭">${icon('close')}</button></div>
    <div class="modal-body"><p style="color:var(--muted);font-size:11px;line-height:1.8">${escapeHtml(options.message || '')}</p></div>
    <div class="modal-actions"><button class="btn" data-action="close-overlay">取消</button><button class="btn ${options.danger ? 'btn-danger' : 'btn-primary'}" data-action="confirm-overlay">${escapeHtml(options.confirmLabel || '确认')}</button></div>
  </div>`);
}

function openSettings() {
  const settings = { profile: 'auto', minScore: 72, maxPositions: 4, stopLossPct: 3, takeProfitPct: 5, refreshInterval: 90, ...(state.settings || {}) };
  const profiles = [
    ['auto', '自适应', '随大盘切换'],
    ['balanced', '均衡档', '常规信号'],
    ['defense', '防守档', '高门槛低仓'],
  ];
  openOverlay(`<div class="modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
    <div class="modal-head"><div><h2 id="settings-title">策略参数</h2><p>参数保存后，下一次扫描立即生效。</p></div><button class="icon-button ghost" data-action="close-overlay" aria-label="关闭">${icon('close')}</button></div>
    <form id="settings-form">
      <div class="modal-body settings-form">
        <div class="form-section">
          <div class="form-label"><span>仓位模式</span><output>${profileLabel(settings.profile)}</output></div>
          <input type="hidden" name="profile" value="${attr(settings.profile)}">
          <div class="profile-options">${profiles.map(([key, label, desc]) => `<button type="button" class="profile-option ${settings.profile === key ? 'is-active' : ''}" data-action="select-profile" data-profile="${key}"><strong>${label}</strong><span>${desc}</span></button>`).join('')}</div>
          <p class="form-hint">自适应模式会在评分偏弱时自动切换防守档。</p>
        </div>
        <div class="form-grid">
          <div class="form-section">
            <div class="form-label"><label for="minScore">最低评分</label><output data-output="minScore">${number(settings.minScore, 0)}</output></div>
            <input class="range" id="minScore" name="minScore" type="range" min="55" max="90" step="1" value="${attr(settings.minScore)}">
            <p class="form-hint">仅将评分达到门槛的标的列入达标信号。</p>
          </div>
          <div class="form-section">
            <div class="form-label"><label for="maxPositions">最大持仓</label><output data-output="maxPositions">${number(settings.maxPositions, 0)} 只</output></div>
            <input class="range" id="maxPositions" name="maxPositions" type="range" min="1" max="6" step="1" value="${attr(settings.maxPositions)}">
            <p class="form-hint">同时限制候选数量与模拟持仓数量。</p>
          </div>
          <div class="form-section">
            <div class="form-label"><label for="stopLossPct">止损比例</label><output data-output="stopLossPct">${number(settings.stopLossPct, 1)}%</output></div>
            <input class="range" id="stopLossPct" name="stopLossPct" type="range" min="2" max="6" step="0.5" value="${attr(settings.stopLossPct)}">
            <p class="form-hint">触发价计划中的固定止损幅度。</p>
          </div>
          <div class="form-section">
            <div class="form-label"><label for="takeProfitPct">止盈比例</label><output data-output="takeProfitPct">${number(settings.takeProfitPct, 1)}%</output></div>
            <input class="range" id="takeProfitPct" name="takeProfitPct" type="range" min="3" max="12" step="0.5" value="${attr(settings.takeProfitPct)}">
            <p class="form-hint">次日冲高优先兑现，止盈计划仅作参考。</p>
          </div>
        </div>
        <div class="form-section">
          <div class="form-label"><label for="refreshInterval">自动刷新间隔</label><output data-output="refreshInterval">${number(settings.refreshInterval, 0)} 秒</output></div>
          <input class="range" id="refreshInterval" name="refreshInterval" type="range" min="30" max="600" step="30" value="${attr(settings.refreshInterval)}">
          <p class="form-hint">页面可见时按此间隔自动拉取行情；演示模式下会暂停。</p>
        </div>
      </div>
      <div class="modal-actions"><button type="button" class="btn" data-action="close-overlay">取消</button><button type="submit" class="btn btn-primary">${icon('check')}保存参数</button></div>
    </form>
  </div>`);
}

async function saveSettings(form) {
  if (demoReadOnly()) { closeOverlay(); return; }
  const data = new FormData(form);
  const settings = {
    profile: String(data.get('profile') || 'auto'),
    minScore: Number(data.get('minScore')),
    maxPositions: Number(data.get('maxPositions')),
    stopLossPct: Number(data.get('stopLossPct')),
    takeProfitPct: Number(data.get('takeProfitPct')),
    refreshInterval: Number(data.get('refreshInterval')),
  };
  const submit = form.querySelector('[type="submit"]');
  if (submit) submit.disabled = true;
  try {
    const payload = await api('api/settings', { method: 'POST', body: JSON.stringify({ settings }) });
    state.settings = payload.settings || settings;
    closeOverlay();
    toast('策略参数已保存，正在重新扫描', 'success');
    await loadDashboard(false, true);
  } catch (error) {
    toast(error.message, 'error', 3800);
    if (submit) submit.disabled = false;
  }
}

async function openStock(code) {
  const normalized = String(code || '').replace(/\D/g, '').slice(0, 6);
  if (!normalized) return;
  closeSearch();
  state.selectedCode = normalized;
  state.detail = null;
  state.detailLoading = true;
  state.detailError = null;
  if (state.data?.meta?.demo) {
    state.detailLoading = false;
    state.detail = buildDemoDetail(normalized);
    if (!state.detail) state.detailError = '演示数据中没有这只股票';
    renderStockDrawer();
    return;
  }
  renderStockDrawer();
  try {
    const detail = await api(`api/stock/${normalized}`);
    if (state.selectedCode !== normalized) return;
    state.detail = detail;
    state.detailLoading = false;
    renderStockDrawer();
  } catch (error) {
    if (state.selectedCode !== normalized) return;
    state.detailLoading = false;
    state.detailError = error.message;
    renderStockDrawer();
  }
}

function renderStockDrawer() {
  const code = state.selectedCode || '';
  const detail = state.detail;
  const stock = detail?.stock;
  const analysis = detail?.analysis;
  const loading = state.detailLoading;
  const error = state.detailError;
  const headerName = stock?.name || '股票详情';
  const headerCode = analysis?.displayCode || stock?.secid || code;
  const price = analysis?.price ?? stock?.price;
  const pct = analysis?.pct ?? stock?.pct;

  let body = '';
  if (loading) {
    body = `<div class="loading-view" style="padding:0"><div class="skeleton" style="min-height:190px"></div><div class="skeleton-grid" style="grid-template-columns:1fr 1fr"><div class="skeleton" style="min-height:160px"></div><div class="skeleton" style="min-height:160px"></div></div></div>`;
  } else if (error || !detail) {
    body = `<div class="error-panel" style="min-height:320px"><div class="error-icon">${icon('alert')}</div><h2>详情加载失败</h2><p>${escapeHtml(error || '未获取到数据')}</p><div class="error-actions"><button class="btn" data-action="retry-stock" data-code="${attr(code)}">${icon('refresh')}重试</button></div></div>`;
  } else if (!analysis) {
    body = `<div class="error-panel" style="min-height:320px"><div class="error-icon">${icon('info')}</div><h2>历史数据不足</h2><p>该股票暂时无法完成评分，可能停牌或数据源尚未返回足够历史行情。</p></div>`;
  } else {
    const bars = detail.bars || [];
    const intraday = detail.intraday?.trends || [];
    const intradayValues = intraday.map((bar) => bar.close).filter(Number.isFinite);
    const klineRange = [30, 60, 90].includes(Number(state.klineRange)) ? Number(state.klineRange) : 60;
    const klineBars = bars.filter((bar) => ['open', 'high', 'low', 'close'].every((key) => finite(bar[key])));
    const rangeButtons = [30, 60, 90].map((value) => `<button class="${klineRange === value ? 'is-active' : ''}" data-action="kline-range" data-range="${value}">${value}日</button>`).join('');
    const preClose = detail.intraday?.preClose || analysis.prevClose;
    const dimensionDefs = [
      ['资金', analysis.dimensions?.capital, 25],
      ['量价', analysis.dimensions?.volumePrice, 25],
      ['板块', analysis.dimensions?.sector, 20],
      ['趋势', analysis.dimensions?.trend, 25],
      ['风控', analysis.dimensions?.risk, 10],
    ];
    const dimensions = dimensionDefs.map(([label, value, max]) => `<div class="dimension-row"><span>${label}</span><div class="progress"><span style="width:${clamp((Number(value) / max) * 100, 0, 100)}%"></span></div><b>${number(value, 1)}</b></div>`).join('');
    const inWatch = Boolean(detail.inWatchlist);
    const plan = analysis.plan || {};
    const reasons = (analysis.reasons || []).map((text) => `<div class="detail-bullet">${escapeHtml(text)}</div>`).join('');
    const risks = (analysis.risks || []).map((text) => `<div class="detail-bullet risk">${escapeHtml(text)}</div>`).join('');
    body = `<div class="drawer-body">
      <div class="detail-grid">
        <div class="chart-panel kline-panel"><div class="chart-head kline-head"><div class="kline-meta"><span>日K线</span><div class="kline-legend"><span><i class="ma5"></i>MA5</span><span><i class="ma10"></i>MA10</span><span><i class="ma20"></i>MA20</span></div></div><div class="kline-ranges">${rangeButtons}</div></div><div class="kline-readout" data-kline-readout>${klineReadout(klineBars.slice(-klineRange).at(-1))}</div><div class="chart-canvas kline-canvas">${klineChart(klineBars, { limit: klineRange })}</div></div>
        <div class="detail-score-card">${scoreOrb(analysis.score, analysis.action?.label || '综合评分')}<h3>${escapeHtml(analysis.action?.labelLong || '等待信号')}</h3><p>${escapeHtml(analysis.bias?.text || '')}</p><div class="dimension-list">${dimensions}</div></div>
      </div>
      <div class="chart-panel" style="margin-bottom:14px"><div class="chart-head"><span>分时走势</span><em>昨收 ${number(preClose)} · ${intradayValues.length ? '当日 ' + intradayValues.length + ' 点' : '暂无分时数据'}</em></div><div class="chart-canvas" style="height:166px">${intradayValues.length >= 2 ? priceChart(intradayValues, { color: 'var(--amber)', baseline: preClose, height: 36 }) : `<div class="equity-empty">暂无当日分时数据</div>`}</div></div>
      <div class="detail-metrics">
        <div class="detail-metric"><span>MA5</span><strong>${number(analysis.metrics?.ma5)}</strong></div>
        <div class="detail-metric"><span>MA20</span><strong>${number(analysis.metrics?.ma20)}</strong></div>
        <div class="detail-metric"><span>ATR 波动</span><strong>${number(analysis.metrics?.atrPct, 1)}%</strong></div>
        <div class="detail-metric"><span>5日 / 20日</span><strong><span class="${toneClass(analysis.metrics?.ret5)}">${pctText(analysis.metrics?.ret5)}</span> / <span class="${toneClass(analysis.metrics?.ret20)}">${pctText(analysis.metrics?.ret20)}</span></strong></div>
        <div class="detail-metric"><span>连续抬底</span><strong>${number(analysis.metrics?.lowDays, 0)} 天</strong></div>
        <div class="detail-metric"><span>量比</span><strong>${number(analysis.volumeRatio)}</strong></div>
        <div class="detail-metric"><span>换手率</span><strong>${number(analysis.turnover, 1)}%</strong></div>
        <div class="detail-metric"><span>板块超额</span><strong class="${toneClass(analysis.sector?.excess5)}">${pctText(analysis.sector?.excess5)}</strong></div>
      </div>
      <div class="detail-section"><h3>${icon('bolt')}交易计划</h3><div class="plan-row" style="margin-top:10px">
        <div class="plan-cell"><span>触发区间</span><strong>${number(plan.triggerLow)} - ${number(plan.triggerHigh)}</strong></div>
        <div class="plan-cell"><span>止损</span><strong class="down">${number(plan.stopLoss)}</strong></div>
        <div class="plan-cell"><span>止盈</span><strong class="up">${number(plan.takeProfit)}</strong></div>
        <div class="plan-cell"><span>仓位</span><strong>${number(plan.positionPct, 0)}%</strong></div>
        <div class="plan-cell"><span>盈亏比</span><strong>${number(plan.riskReward, 1)} : 1</strong></div>
      </div><p>${escapeHtml(analysis.planText || '')}</p></div>
      <div class="detail-section"><h3>${icon('radar')}大师点评</h3><p>${escapeHtml(analysis.review || '')}</p></div>
      <div class="detail-section"><h3>${icon('trend')}支持因素</h3><div class="detail-bullets">${reasons || `<div class="detail-bullet">暂无明确正向因素</div>`}</div></div>
      <div class="detail-section"><h3>${icon('shield')}风险信号</h3><div class="detail-bullets">${risks || `<div class="detail-bullet risk">暂无额外风险信号</div>`}</div></div>
      <div class="detail-actions"><button class="btn ${inWatch ? 'btn-danger' : 'btn-primary'}" data-action="${inWatch ? 'remove-watch' : 'add-watch'}" data-code="${attr(code)}">${icon('star')}${inWatch ? '移出自选' : '加入自选'}</button><button class="btn" data-action="paper-buy" data-code="${attr(code)}" data-name="${attr(headerName)}">${icon('bolt')}记录模拟买入</button></div>
    </div>`;
  }

  openOverlay(`<aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="stock-title">
    <div class="drawer-head">
      <div class="drawer-head-main"><h2 id="stock-title">${escapeHtml(headerName)}</h2><span class="detail-code">${escapeHtml(headerCode)}${analysis?.industry ? ` · ${escapeHtml(analysis.industry)}` : ''}</span><div class="drawer-price-line"><strong>${number(price)}</strong><span class="${toneClass(pct)}">${pctText(pct)}</span>${analysis ? actionBadge(analysis.action) : ''}</div></div>
      <div class="drawer-head-right"><button class="icon-button ghost" data-action="close-overlay" aria-label="关闭详情">${icon('close')}</button></div>
    </div>
    ${body}
  </aside>`, true);
  attachKlineInteractions($('#overlay-root'));
}

function priceChart(values, options = {}) {
  const clean = (Array.isArray(values) ? values : []).map(Number).filter(Number.isFinite);
  if (clean.length < 2) return `<div class="equity-empty">暂无走势数据</div>`;
  const width = 100;
  const height = Number(options.height) || 40;
  const minRaw = Math.min(...clean, ...(finite(options.baseline) ? [Number(options.baseline)] : []));
  const maxRaw = Math.max(...clean, ...(finite(options.baseline) ? [Number(options.baseline)] : []));
  const span = maxRaw - minRaw || 1;
  const pad = 2.5;
  const points = clean.map((value, index) => {
    const x = (index / (clean.length - 1)) * width;
    const y = height - pad - ((value - minRaw) / span) * (height - pad * 2);
    return [x, y];
  });
  const line = points.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  const area = `${line} L${width},${height} L0,${height} Z`;
  const color = options.color || 'var(--amber)';
  const uid = `chart-${++sparkUid}`;
  const baselineY = finite(options.baseline) ? height - pad - ((Number(options.baseline) - minRaw) / span) * (height - pad * 2) : null;
  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="价格走势">
    <defs><linearGradient id="${uid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".2"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
    ${[0.25, 0.5, 0.75].map((ratio) => `<line x1="0" y1="${(height * ratio).toFixed(2)}" x2="${width}" y2="${(height * ratio).toFixed(2)}" stroke="rgba(255,255,255,.045)" stroke-width=".25"/>`).join('')}
    ${baselineY !== null ? `<line x1="0" y1="${baselineY.toFixed(2)}" x2="${width}" y2="${baselineY.toFixed(2)}" stroke="rgba(243,201,105,.32)" stroke-width=".28" stroke-dasharray="1.3 1.8"/>` : ''}
    <path d="${area}" fill="url(#${uid})"/>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
    <circle cx="${points.at(-1)[0].toFixed(2)}" cy="${points.at(-1)[1].toFixed(2)}" r="1.5" fill="${color}" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

function movingAverage(bars, period) {
  const result = [];
  let sum = 0;
  for (let index = 0; index < bars.length; index += 1) {
    sum += Number(bars[index].close);
    if (index >= period) sum -= Number(bars[index - period].close);
    result.push(index >= period - 1 ? sum / period : null);
  }
  return result;
}

function formatHands(value) {
  const hands = Number(value) / 100;
  if (!Number.isFinite(hands) || hands <= 0) return '--';
  if (hands >= 1e8) return `${(hands / 1e8).toFixed(2)}亿手`;
  if (hands >= 1e4) return `${(hands / 1e4).toFixed(1)}万手`;
  return `${Math.round(hands)}手`;
}

function klineReadout(bar) {
  if (!bar) return '<span>暂无K线数据</span>';
  const pct = Number(bar.pct) || 0;
  return `<b>${escapeHtml(bar.date)}</b><span>开 ${number(bar.open)}</span><span>高 ${number(bar.high)}</span><span>低 ${number(bar.low)}</span><span>收 ${number(bar.close)}</span><span class="${pct >= 0 ? 'up' : 'down'}">${pctText(pct)}</span><span>量 ${formatHands(bar.volume)}</span>`;
}

function klineChart(bars, options = {}) {
  const valid = (Array.isArray(bars) ? bars : []).filter((bar) => ['open', 'high', 'low', 'close'].every((key) => finite(bar[key])) && Number(bar.close) > 0);
  if (valid.length < 2) return `<div class="equity-empty">暂无K线数据</div>`;
  const enriched = valid.map((bar, index) => {
    const previous = valid[index - 1];
    const pct = finite(bar.pct) ? Number(bar.pct) : previous?.close ? ((Number(bar.close) / Number(previous.close)) - 1) * 100 : 0;
    return { ...bar, pct };
  });
  const averages = { 5: movingAverage(enriched, 5), 10: movingAverage(enriched, 10), 20: movingAverage(enriched, 20) };
  const limit = Math.max(5, Math.min(Number(options.limit) || 60, enriched.length));
  const start = enriched.length - limit;
  const visible = enriched.slice(start);
  const width = 640;
  const height = 220;
  const padX = 8;
  const priceTop = 8;
  const volumeHeight = 40;
  const volumeBottom = height - 5;
  const priceBottom = volumeBottom - volumeHeight - 10;
  const priceHeight = priceBottom - priceTop;
  const step = (width - padX * 2) / visible.length;
  const bodyWidth = Math.max(1.1, Math.min(7, step * 0.62));
  const priceValues = visible.flatMap((bar) => [Number(bar.low), Number(bar.high)]);
  for (const period of [5, 10, 20]) {
    for (const value of averages[period].slice(start)) if (finite(value)) priceValues.push(Number(value));
  }
  const rawMin = Math.min(...priceValues);
  const rawMax = Math.max(...priceValues);
  const padding = (rawMax - rawMin) * 0.06 || rawMax * 0.01 || 1;
  const minPrice = rawMin - padding;
  const maxPrice = rawMax + padding;
  const priceSpan = maxPrice - minPrice || 1;
  const maxVolume = Math.max(...visible.map((bar) => Number(bar.volume) || 0), 1);
  const xOf = (index) => padX + step * (index + 0.5);
  const yOf = (value) => priceTop + (1 - (Number(value) - minPrice) / priceSpan) * priceHeight;
  const yVolume = (value) => volumeBottom - ((Number(value) || 0) / maxVolume) * volumeHeight;
  const grid = [0, 0.25, 0.5, 0.75, 1].map((ratio) => `<line x1="${padX}" y1="${(priceTop + priceHeight * ratio).toFixed(2)}" x2="${width - padX}" y2="${(priceTop + priceHeight * ratio).toFixed(2)}" stroke="rgba(255,255,255,.05)" stroke-width=".5" vector-effect="non-scaling-stroke"/>`).join('');
  const volumeBars = visible.map((bar, index) => {
    const up = Number(bar.close) >= Number(bar.open);
    const y = yVolume(bar.volume);
    return `<rect x="${(xOf(index) - bodyWidth / 2).toFixed(2)}" y="${y.toFixed(2)}" width="${bodyWidth.toFixed(2)}" height="${Math.max(0.6, volumeBottom - y).toFixed(2)}" fill="${up ? 'var(--red)' : 'var(--green)'}" opacity=".32"/>`;
  }).join('');
  const candles = visible.map((bar, index) => {
    const up = Number(bar.close) >= Number(bar.open);
    const color = up ? 'var(--red)' : 'var(--green)';
    const x = xOf(index);
    const openY = yOf(bar.open);
    const closeY = yOf(bar.close);
    const top = Math.min(openY, closeY);
    const bodyHeight = Math.max(0.9, Math.abs(openY - closeY));
    return `<g><line x1="${x.toFixed(2)}" y1="${yOf(bar.high).toFixed(2)}" x2="${x.toFixed(2)}" y2="${yOf(bar.low).toFixed(2)}" stroke="${color}" stroke-width="1" vector-effect="non-scaling-stroke"/><rect x="${(x - bodyWidth / 2).toFixed(2)}" y="${top.toFixed(2)}" width="${bodyWidth.toFixed(2)}" height="${bodyHeight.toFixed(2)}" fill="${color}" opacity=".92"/></g>`;
  }).join('');
  const maPath = (values) => {
    let path = '';
    let drawing = false;
    values.forEach((value, index) => {
      if (!finite(value)) { drawing = false; return; }
      path += `${drawing ? 'L' : 'M'}${xOf(index).toFixed(2)},${yOf(value).toFixed(2)}`;
      drawing = true;
    });
    return path;
  };
  const maLines = [[5, '#f3c969'], [10, '#6ea8fe'], [20, '#b794f6']].map(([period, color]) => {
    const path = maPath(averages[period].slice(start));
    return path ? `<path d="${path}" fill="none" stroke="${color}" stroke-width="1" stroke-linejoin="round" stroke-linecap="round" opacity=".9" vector-effect="non-scaling-stroke"/>` : '';
  }).join('');
  const last = visible.at(-1);
  const lastY = yOf(last.close);
  const hits = visible.map((bar, index) => `<rect class="kline-hit" x="${(padX + step * index).toFixed(2)}" y="0" width="${step.toFixed(2)}" height="${height}" fill="transparent" pointer-events="all" data-x="${xOf(index).toFixed(2)}" data-y="${yOf(bar.close).toFixed(2)}" data-date="${attr(bar.date)}" data-open="${attr(bar.open)}" data-high="${attr(bar.high)}" data-low="${attr(bar.low)}" data-close="${attr(bar.close)}" data-pct="${attr(bar.pct)}" data-volume="${attr(bar.volume)}"/>`).join('');
  const uid = `kline-${++sparkUid}`;
  return `<svg class="kline-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="日K线图">
    <defs><clipPath id="${uid}"><rect x="0" y="0" width="${width}" height="${height}"/></clipPath></defs>
    <g clip-path="url(#${uid})">${grid}${volumeBars}${candles}${maLines}<line x1="${padX}" y1="${lastY.toFixed(2)}" x2="${width - padX}" y2="${lastY.toFixed(2)}" stroke="rgba(243,201,105,.3)" stroke-width=".6" stroke-dasharray="2 3" vector-effect="non-scaling-stroke"/>${hits}</g>
    <line class="kline-crosshair kline-crosshair-v" x1="0" y1="0" x2="0" y2="${height}" stroke="rgba(243,201,105,.5)" stroke-width=".7" stroke-dasharray="2 3" pointer-events="none" vector-effect="non-scaling-stroke"/>
    <line class="kline-crosshair kline-crosshair-h" x1="0" y1="0" x2="${width}" y2="0" stroke="rgba(243,201,105,.35)" stroke-width=".7" stroke-dasharray="2 3" pointer-events="none" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

function attachKlineInteractions(root) {
  const panel = $('.kline-panel', root || document);
  if (!panel) return;
  const readout = $('[data-kline-readout]', panel);
  const crosshairV = $('.kline-crosshair-v', panel);
  const crosshairH = $('.kline-crosshair-h', panel);
  if (!readout) return;
  const defaultHtml = readout.innerHTML;
  const update = (event) => {
    const hit = event.target.closest?.('.kline-hit');
    if (!hit) return;
    readout.innerHTML = klineReadout({
      date: hit.dataset.date,
      open: Number(hit.dataset.open),
      high: Number(hit.dataset.high),
      low: Number(hit.dataset.low),
      close: Number(hit.dataset.close),
      pct: Number(hit.dataset.pct),
      volume: Number(hit.dataset.volume),
    });
    if (crosshairV) {
      crosshairV.setAttribute('x1', hit.dataset.x);
      crosshairV.setAttribute('x2', hit.dataset.x);
      crosshairV.style.opacity = '1';
    }
    if (crosshairH) {
      crosshairH.setAttribute('y1', hit.dataset.y);
      crosshairH.setAttribute('y2', hit.dataset.y);
      crosshairH.style.opacity = '1';
    }
  };
  panel.addEventListener('pointermove', update);
  panel.addEventListener('pointerdown', update);
  panel.addEventListener('pointerleave', (event) => {
    if (event.pointerType && event.pointerType !== 'mouse') return;
    readout.innerHTML = defaultHtml;
    if (crosshairV) crosshairV.style.opacity = '0';
    if (crosshairH) crosshairH.style.opacity = '0';
  });
}

async function addToWatchlist(code) {
  if (!code) return;
  if (demoReadOnly()) return;
  try {
    await api('api/watchlist', { method: 'POST', body: JSON.stringify({ code }) });
    toast('已加入自选股', 'success');
    await loadDashboard(false, true);
    if (state.selectedCode === code && state.detail) {
      state.detail.inWatchlist = true;
      renderStockDrawer();
    }
  } catch (error) {
    toast(error.message, 'error', 3500);
  }
}

async function removeFromWatchlist(code) {
  if (!code) return;
  if (demoReadOnly()) return;
  try {
    await api(`api/watchlist/${encodeURIComponent(code)}`, { method: 'DELETE' });
    toast('已移出自选股', 'success');
    await loadDashboard(false, true);
    if (state.selectedCode === code && state.detail) {
      state.detail.inWatchlist = false;
      renderStockDrawer();
    }
  } catch (error) {
    toast(error.message, 'error', 3500);
  }
}

async function paperBuy(code, name = '') {
  if (!code || state.feedbackPending) return;
  if (demoReadOnly()) return;
  state.feedbackPending = true;
  try {
    const payload = await api('api/paper', { method: 'POST', body: JSON.stringify({ code, source: 'q-signal' }) });
    toast(payload.message || `已记录 ${name || code} 模拟买入`, 'success');
    await loadDashboard(false, true);
  } catch (error) {
    toast(error.message, 'error', 3800);
  } finally {
    state.feedbackPending = false;
  }
}

function closeTrade(id, name = '') {
  if (demoReadOnly()) return;
  confirmDialog({
    title: '确认模拟平仓',
    subtitle: '按最新行情价格计算',
    message: `将按当前最新价平掉 ${name || '这笔持仓'}，并记录浮动收益。此操作只影响本地模拟战绩。`,
    confirmLabel: '确认平仓',
    onConfirm: async () => {
      try {
        const payload = await api(`api/paper/${encodeURIComponent(id)}/close`, { method: 'POST', body: '{}' });
        closeOverlay();
        toast(payload.message || '已模拟平仓', 'success');
        await loadDashboard(false, true);
      } catch (error) {
        toast(error.message, 'error', 3500);
      }
    },
  });
}

function resetPerformance() {
  if (demoReadOnly()) return;
  confirmDialog({
    title: '重置模拟战绩',
    subtitle: '清空全部模拟交易记录',
    message: '这会永久删除所有持仓中与已平仓的模拟交易，无法恢复。策略参数和自选股不会受影响。',
    confirmLabel: '清空战绩',
    danger: true,
    onConfirm: async () => {
      try {
        const payload = await api('api/performance/reset', { method: 'POST', body: '{}' });
        closeOverlay();
        toast(payload.message || '模拟战绩已重置', 'success');
        await loadDashboard(false, true);
      } catch (error) {
        toast(error.message, 'error', 3500);
      }
    },
  });
}

async function copyScreener() {
  const screener = state.data?.screener || {};
  const candidates = screener.candidates || [];
  if (!candidates.length) {
    toast('当前没有可复制的候选清单');
    return;
  }
  const lines = candidates.map((item) => {
    const plan = item.plan || {};
    return `${item.rank}. ${item.name}（${item.displayCode || item.code}） ${item.industry} | 评分 ${item.score} | ${item.action?.label || '观察'} | 触发 ${plan.triggerLow}-${plan.triggerHigh} | 止损 ${plan.stopLoss} | 止盈 ${plan.takeProfit} | 仓位 ${item.positionPct || plan.positionPct || 0}%`;
  });
  const text = `智能选股 候选清单 ${state.data?.meta?.dataDate || ''}\n${lines.join('\n')}\n仅供研究，不构成投资建议。`;
  try {
    await navigator.clipboard.writeText(text);
    toast(`已复制 ${candidates.length} 只候选`, 'success');
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); toast('候选清单已复制', 'success'); }
    catch { toast('浏览器未允许复制，请手动选择文本', 'error'); }
    area.remove();
  }
}

async function performSearch(term) {
  const keyword = String(term || '').trim();
  if (state.data?.meta?.demo) {
    state.searchResults = demoSearch(keyword);
    renderSearchResults();
    return;
  }
  if (!keyword) {
    state.searchResults = [];
    renderSearchResults();
    return;
  }
  const seq = ++state.searchSeq;
  try {
    const payload = await api(`api/search?q=${encodeURIComponent(keyword)}`);
    if (seq !== state.searchSeq) return;
    state.searchResults = payload.results || [];
    renderSearchResults();
  } catch (error) {
    if (seq !== state.searchSeq) return;
    state.searchResults = [];
    const results = $('#search-results');
    if (results) {
      results.hidden = false;
      results.innerHTML = `<div class="search-empty">${escapeHtml(error.message)}</div>`;
    }
  }
}

function renderSearchResults() {
  const results = $('#search-results');
  if (!results) return;
  const items = state.searchResults || [];
  if (!items.length) {
    results.hidden = false;
    results.innerHTML = `<div class="search-empty">没有匹配的股票，请输入 6 位代码或完整名称</div>`;
    return;
  }
  results.hidden = false;
  results.innerHTML = items.map((item) => `<button class="search-result" data-action="open-stock" data-code="${attr(item.code)}">
    <span class="sr-main"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.displayCode)} · ${escapeHtml(item.industry || '')}</small></span>
    <span class="sr-price">${number(item.price)} <span class="${toneClass(item.pct)}">${pctText(item.pct)}</span></span>
  </button>`).join('');
}

function closeSearch() {
  const results = $('#search-results');
  const wrap = $('#search-wrap');
  if (results) results.hidden = true;
  if (wrap) wrap.classList.remove('is-open');
}

function focusSearch() {
  const wrap = $('#search-wrap');
  const input = $('#global-search');
  if (!input || !wrap) return;
  wrap.classList.add('is-open');
  input.focus();
  input.select();
  if (input.value.trim()) {
    const results = $('#search-results');
    if (results) results.hidden = false;
  }
}

function bindEvents() {
  document.addEventListener('click', handleDocumentClick);
  document.addEventListener('submit', handleSubmit);
  document.addEventListener('input', handleInput);
  document.addEventListener('keydown', handleKeydown);
  window.addEventListener('hashchange', () => {
    const view = location.hash.replace('#', '');
    if (VIEW_META[view] && view !== state.view) setView(view, { hash: false });
  });
  window.addEventListener('resize', () => {
    if (window.innerWidth > 760) $('#search-wrap')?.classList.remove('is-open');
  });
}

function handleDocumentClick(event) {
  const overlay = event.target.closest('[data-overlay-backdrop]');
  if (overlay && event.target === overlay) {
    closeOverlay();
    return;
  }

  const viewButton = event.target.closest('[data-view]');
  if (viewButton) {
    event.preventDefault();
    setView(viewButton.dataset.view);
    closeSearch();
    return;
  }

  const viewTarget = event.target.closest('[data-view-target]');
  if (viewTarget) {
    event.preventDefault();
    setView(viewTarget.dataset.viewTarget);
    closeSearch();
    return;
  }

  const actionElement = event.target.closest('[data-action]');
  if (actionElement) {
    if (actionElement.disabled) return;
    const action = actionElement.dataset.action;
    const code = actionElement.dataset.code;
    if (!['open-settings', 'refresh', 'open-stock', 'paper-buy', 'remove-watch', 'add-watch', 'close-trade', 'reset-performance', 'focus-search'].includes(action)) {
      if (!event.target.closest('#search-wrap') && !event.target.closest('#search-results')) closeSearch();
    }
    switch (action) {
      case 'refresh':
        event.preventDefault();
        loadDashboard(true);
        break;
      case 'open-settings':
        event.preventDefault();
        openSettings();
        break;
      case 'dismiss-alert':
        event.preventDefault();
        state.alertDismissed = true;
        renderAlert();
        break;
      case 'open-stock':
        event.preventDefault();
        openStock(code);
        break;
      case 'add-watch':
        event.preventDefault();
        addToWatchlist(code);
        break;
      case 'remove-watch':
        event.preventDefault();
        removeFromWatchlist(code);
        break;
      case 'paper-buy':
        event.preventDefault();
        paperBuy(code, actionElement.dataset.name || '');
        break;
      case 'close-trade':
        event.preventDefault();
        closeTrade(actionElement.dataset.id, actionElement.dataset.name || '');
        break;
      case 'reset-performance':
        event.preventDefault();
        resetPerformance();
        break;
      case 'confirm-overlay':
        event.preventDefault();
        if (typeof state.pendingConfirm === 'function') {
          const task = state.pendingConfirm;
          state.pendingConfirm = null;
          task();
        }
        break;
      case 'close-overlay':
        event.preventDefault();
        closeOverlay();
        break;
      case 'focus-search':
        event.preventDefault();
        focusSearch();
        break;
      case 'filter-screener':
        event.preventDefault();
        state.screenerFilter = actionElement.dataset.filter || 'all';
        renderView();
        break;
      case 'copy-screener':
        event.preventDefault();
        copyScreener();
        break;
      case 'go-screener':
        event.preventDefault();
        setView('screener');
        break;
      case 'open-paper':
        event.preventDefault();
        setView('performance');
        break;
      case 'select-profile': {
        event.preventDefault();
        const profile = actionElement.dataset.profile || 'auto';
        const form = actionElement.closest('form');
        const input = form?.querySelector('input[name="profile"]');
        if (input) input.value = profile;
        $$('.profile-option', form).forEach((button) => button.classList.toggle('is-active', button === actionElement));
        const output = form?.querySelector('.form-section .form-label output');
        if (output) output.textContent = profileLabel(profile);
        break;
      }
      case 'kline-range':
        event.preventDefault();
        state.klineRange = Number(actionElement.dataset.range) || 60;
        renderStockDrawer();
        break;
      case 'retry-stock':
        event.preventDefault();
        openStock(code);
        break;
      case 'load-demo':
        event.preventDefault();
        loadDemo();
        break;
      case 'toggle-mobile-nav':
        event.preventDefault();
        toast('请使用底部导航切换页面');
        break;
      default:
        break;
    }
    if (event.target.closest('#search-results')) closeSearch();
    return;
  }

  if (!event.target.closest('#search-wrap')) closeSearch();
}

function handleSubmit(event) {
  if (event.target.id === 'settings-form') {
    event.preventDefault();
    saveSettings(event.target);
  }
}

function handleInput(event) {
  const target = event.target;
  if (target.matches('.range')) {
    const output = target.closest('.form-section')?.querySelector('output');
    if (output) {
      const suffix = target.name === 'minScore' ? '' : target.name === 'maxPositions' ? ' 只' : target.name === 'refreshInterval' ? ' 秒' : '%';
      output.textContent = `${number(target.value, target.step.includes('.') ? 1 : 0)}${suffix}`;
    }
  }
  if (target.id === 'global-search') {
    window.clearTimeout(state.searchTimer);
    const term = target.value.trim();
    if (!term) {
      state.searchResults = [];
      closeSearch();
      return;
    }
    const results = $('#search-results');
    if (results) {
      results.hidden = false;
      results.innerHTML = `<div class="search-empty">正在搜索...</div>`;
    }
    state.searchTimer = window.setTimeout(() => performSearch(term), 260);
  }
}

function handleKeydown(event) {
  const target = event.target;
  const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
  if (event.key === 'Escape') {
    if ($('#overlay-root')?.children.length) closeOverlay();
    else closeSearch();
    return;
  }
  if (event.key === '/' && !typing) {
    event.preventDefault();
    focusSearch();
    return;
  }
  if (event.key === 'Enter' && (target instanceof HTMLButtonElement || target?.getAttribute('role') === 'button')) {
    target.click();
  }
}

document.addEventListener('DOMContentLoaded', init);