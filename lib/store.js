'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const DATA_DIR = process.env.QSIGNAL_DATA_DIR
  ? path.resolve(process.env.QSIGNAL_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const STATE_TMP = path.join(DATA_DIR, 'state.json.tmp');

const DEFAULT_SETTINGS = {
  profile: 'auto',
  minScore: 72,
  maxPositions: 4,
  stopLossPct: 3,
  takeProfitPct: 5,
  refreshInterval: 90,
};

const DEFAULT_STATE = {
  version: 1,
  watchlist: ['301117', '601798', '301511', '603989'],
  paperTrades: [],
  settings: { ...DEFAULT_SETTINGS },
  updatedAt: new Date().toISOString(),
};

let memoryState = null;
let writeQueue = Promise.resolve();

function sanitizeSettings(input = {}) {
  const merged = { ...DEFAULT_SETTINGS, ...input };
  return {
    profile: ['auto', 'balanced', 'offense', 'defense'].includes(merged.profile) ? merged.profile : 'auto',
    minScore: Math.round(Math.min(90, Math.max(55, Number(merged.minScore) || DEFAULT_SETTINGS.minScore))),
    maxPositions: Math.round(Math.min(6, Math.max(1, Number(merged.maxPositions) || DEFAULT_SETTINGS.maxPositions))),
    stopLossPct: Math.min(6, Math.max(2, Number(merged.stopLossPct) || DEFAULT_SETTINGS.stopLossPct)),
    takeProfitPct: Math.min(12, Math.max(3, Number(merged.takeProfitPct) || DEFAULT_SETTINGS.takeProfitPct)),
    refreshInterval: Math.round(Math.min(600, Math.max(30, Number(merged.refreshInterval) || DEFAULT_SETTINGS.refreshInterval))),
  };
}

function normalizeState(input) {
  const state = { ...DEFAULT_STATE, ...(input || {}) };
  state.watchlist = Array.from(new Set((Array.isArray(state.watchlist) ? state.watchlist : DEFAULT_STATE.watchlist)
    .map((code) => String(code).replace(/\D/g, '').slice(0, 6))
    .filter((code) => code.length === 6))).slice(0, 30);
  state.paperTrades = Array.isArray(state.paperTrades) ? state.paperTrades : [];
  state.settings = sanitizeSettings(state.settings);
  return state;
}

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function loadState() {
  if (memoryState) return memoryState;
  await ensureDataDir();
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    memoryState = normalizeState(JSON.parse(raw));
  } catch {
    memoryState = normalizeState(DEFAULT_STATE);
    await saveState(memoryState);
  }
  return memoryState;
}

async function saveState(state) {
  await ensureDataDir();
  const next = normalizeState({ ...state, updatedAt: new Date().toISOString() });
  memoryState = next;
  writeQueue = writeQueue.then(async () => {
    await fs.writeFile(STATE_TMP, JSON.stringify(next, null, 2), 'utf8');
    await fs.rename(STATE_TMP, STATE_FILE);
  });
  await writeQueue;
  return next;
}

async function updateState(mutator) {
  const state = await loadState();
  const draft = structuredClone(state);
  const result = await mutator(draft);
  const saved = await saveState(draft);
  return result === undefined ? saved : result;
}

async function addToWatchlist(code) {
  return updateState((state) => {
    const normalized = String(code || '').replace(/\D/g, '').slice(0, 6);
    if (normalized.length !== 6) throw new Error('股票代码应为 6 位数字');
    if (!state.watchlist.includes(normalized)) state.watchlist.unshift(normalized);
    state.watchlist = state.watchlist.slice(0, 30);
    return state;
  });
}

async function removeFromWatchlist(code) {
  return updateState((state) => {
    state.watchlist = state.watchlist.filter((item) => item !== String(code));
    return state;
  });
}

async function updateSettings(settings) {
  return updateState((state) => {
    state.settings = sanitizeSettings(settings);
    return state;
  });
}

async function addPaperTrade(trade) {
  return updateState((state) => {
    if (state.paperTrades.some((item) => item.status === 'open' && item.code === trade.code)) {
      throw new Error('该股票已在模拟持仓中');
    }
    const openCount = state.paperTrades.filter((item) => item.status === 'open').length;
    if (openCount >= state.settings.maxPositions) {
      throw new Error(`模拟持仓已达上限（${state.settings.maxPositions} 只）`);
    }
    state.paperTrades.unshift({
      id: `P${Date.now().toString(36).toUpperCase()}`,
      status: 'open',
      createdAt: new Date().toISOString(),
      ...trade,
    });
    return state;
  });
}

async function closePaperTrade(id, exitPrice, note = '') {
  return updateState((state) => {
    const trade = state.paperTrades.find((item) => item.id === id && item.status === 'open');
    if (!trade) throw new Error('未找到可平仓的模拟持仓');
    trade.status = 'closed';
    trade.exitPrice = Number(exitPrice);
    trade.exitAt = new Date().toISOString();
    trade.pnlPct = Math.round((((trade.exitPrice / trade.entryPrice) - 1) * 100) * 10000) / 10000;
    trade.result = trade.pnlPct >= 0 ? 'win' : 'loss';
    trade.closeNote = note;
    return state;
  });
}

async function resetPerformance() {
  return updateState((state) => {
    state.paperTrades = [];
    return state;
  });
}

module.exports = {
  DEFAULT_SETTINGS,
  addPaperTrade,
  addToWatchlist,
  closePaperTrade,
  loadState,
  removeFromWatchlist,
  resetPerformance,
  normalizeState,
  sanitizeSettings,
  saveState,
  updateSettings,
};