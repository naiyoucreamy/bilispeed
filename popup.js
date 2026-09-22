/**
 * BiliSpeed - Popup 逻辑
 * ---------------------------------------------------------------
 * 三路同步策略，任何一步失败都不会让 popup 卡死：
 *   1. chrome.storage.sync  —— 持久化，全局生效（所有标签页 / 重启浏览器后仍生效）
 *   2. chrome.tabs.sendMessage —— 通知当前 B 站标签页的 content script 立即应用
 *   3. chrome.scripting.executeScript —— 内容脚本尚未注入时的兜底（弱化为直接写 storage）
 */

'use strict';

const STORAGE_KEY = 'bilispeed.rate';
const MIN_RATE = 0.25;
const MAX_RATE = 16;
const STEP = 0.25;
const DEFAULT_RATE = 1;

/** 拖动滑块时合并写入，避免每个像素都发消息 */
const WRITE_THROTTLE_MS = 80;

/** DOM 引用 */
const slider = document.getElementById('rateSlider');
const rateText = document.getElementById('rateText');
const tagEl = document.getElementById('tag');
const statusEl = document.getElementById('status');
const resetBtn = document.getElementById('resetBtn');
const minusBtn = document.getElementById('minusBtn');
const plusBtn = document.getElementById('plusBtn');
const presetButtons = Array.from(document.querySelectorAll('.preset'));

/** 当前 UI 上的速度 */
let currentRate = DEFAULT_RATE;

/** 节流计时器 */
let writeTimer = null;
let pendingRate = null;

let statusTimer = null;

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

/**
 * 规整倍速：范围钳制 + 0.25 对齐 + 消除浮点误差
 * @param {unknown} value
 * @returns {number}
 */
function normalizeRate(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULT_RATE;
  const clamped = Math.min(MAX_RATE, Math.max(MIN_RATE, num));
  const stepped = Math.round(clamped / STEP) * STEP;
  return Math.round(stepped * 100) / 100;
}

/** 显示一行状态文字，3 秒后自动恢复成提示语 */
function setStatus(text, isWarn = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('warn', Boolean(isWarn));
  if (statusTimer !== null) clearTimeout(statusTimer);
  if (isWarn) {
    statusTimer = setTimeout(() => {
      statusEl.textContent = '仅在 B 站页面生效';
      statusEl.classList.remove('warn');
    }, 3000);
  }
}

/** 刷新滑块背景渐变（填充到当前值的位置） */
function paintSlider() {
  const percent = ((currentRate - MIN_RATE) / (MAX_RATE - MIN_RATE)) * 100;
  slider.style.background =
    `linear-gradient(90deg, var(--brand) ${percent}%, var(--line) ${percent}%)`;
}

/** 把速度同步到所有 UI 元素上 */
function renderRate() {
  rateText.textContent = `${currentRate.toFixed(2)}x`;
  slider.value = String(currentRate);
  paintSlider();
  for (const btn of presetButtons) {
    btn.classList.toggle('active', Math.abs(Number(btn.dataset.rate) - currentRate) < 0.001);
  }
}

/* ------------------------------------------------------------------ */
/* 与页面 / 存储交互                                                    */
/* ------------------------------------------------------------------ */

/** 拿到当前激活的标签页（可能不是 B 站页面） */
async function getActiveTab() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs && tabs[0] ? tabs[0] : null;
  } catch (err) {
    return null;
  }
}

/** 判断一个 tab 是否是我们能注入的 B 站页面 */
function isBilibiliTab(tab) {
  if (!tab || !tab.url) return false;
  try {
    const url = new URL(tab.url);
    return /(^|\.)bilibili\.com$/i.test(url.hostname) && /^https?:$/.test(url.protocol);
  } catch (err) {
    return false;
  }
}

/**
 * 通知当前标签页的 content script 应用速度。
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
async function applyToActiveTab(rate) {
  const tab = await getActiveTab();
  if (!isBilibiliTab(tab)) {
    return { ok: false, reason: 'not-bilibili' };
  }
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'bilispeed:set', rate });
    return { ok: Boolean(res && res.ok), reason: res ? undefined : 'no-response' };
  } catch (err) {
    // 典型场景：扩展刚安装/刷新，content script 还没注入（页面需要刷新一次）
    // 兜底：用 scripting 直接在页面上执行一次赋值，至少当前页面立刻生效。
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (value) => {
          if (window.__bilispeed && typeof window.__bilispeed.set === 'function') {
            window.__bilispeed.set(value);
            return true;
          }
          // content script 完全没注入：直接把页面上的 video 设一遍（本次有效，刷新后由 content script 接管）
          for (const video of document.querySelectorAll('video')) {
            try { video.playbackRate = value; } catch (e) { /* 忽略 */ }
          }
          return false;
        },
        args: [rate],
      });
      return { ok: true, reason: 'fallback' };
    } catch (err2) {
      return { ok: false, reason: 'inject-failed' };
    }
  }
}

/** 读取当前标签页的实际播放速率（用于展示真实状态） */
async function readActiveTabRate() {
  const tab = await getActiveTab();
  if (!isBilibiliTab(tab)) return null;
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'bilispeed:get' });
    if (res && res.ok) return res;
  } catch (err) {
    /* 内容脚本未就绪，忽略 */
  }
  return null;
}

/** 写入 storage（带节流，供拖动滑块时使用） */
function scheduleSave(rate) {
  pendingRate = rate;
  if (writeTimer !== null) return;
  writeTimer = setTimeout(flushSave, WRITE_THROTTLE_MS);
}

/** 立即落盘并通知页面 */
async function flushSave() {
  if (writeTimer !== null) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  if (pendingRate === null) return;
  const rate = pendingRate;
  pendingRate = null;

  // 1. 先落地存储：保证即使当前没有 B 站标签页，下次打开也生效
  try {
    await chrome.storage.sync.set({ [STORAGE_KEY]: rate });
  } catch (err) {
    setStatus('存储写入失败（请检查同步权限）', true);
    return;
  }

  // 2. 再通知页面立即应用
  const result = await applyToActiveTab(rate);
  if (result.ok) {
    setStatus('已生效 (storage + 页面)');
  } else if (result.reason === 'not-bilibili') {
    setStatus('已保存，当前不是 B 站页面', true);
  } else {
    setStatus('已保存，页面未响应（请刷新页面）', true);
  }
}

/**
 * 设置速度的唯一入口：更新 UI -> 存储 -> 通知页面
 * @param {number} rate
 * @param {{immediate?: boolean}} options immediate=true 时跳过节流（按钮/默认值用）
 */
function setRate(rate, options = {}) {
  currentRate = normalizeRate(rate);
  renderRate();
  if (options.immediate) {
    pendingRate = currentRate;
    flushSave();
  } else {
    scheduleSave(currentRate);
  }
}

/* ------------------------------------------------------------------ */
/* 事件绑定                                                            */
/* ------------------------------------------------------------------ */

// 滑块：input 期间只更新 UI + 节流保存，保证拖动顺滑
slider.addEventListener('input', () => {
  currentRate = normalizeRate(slider.value);
  renderRate();
  scheduleSave(currentRate);
});

// 松手时立即落盘，避免节流窗口内关掉 popup 丢设置
slider.addEventListener('change', () => {
  currentRate = normalizeRate(slider.value);
  renderRate();
  pendingRate = currentRate;
  flushSave();
});

// 重置为 1x
resetBtn.addEventListener('click', () => {
  setRate(DEFAULT_RATE, { immediate: true });
  setStatus('已重置为 1.00x');
});

// 微调 -0.25
minusBtn.addEventListener('click', () => {
  setRate(Number((currentRate - STEP).toFixed(2)), { immediate: true });
});

// 微调 +0.25
plusBtn.addEventListener('click', () => {
  setRate(Number((currentRate + STEP).toFixed(2)), { immediate: true });
});

// 快捷档位
for (const btn of presetButtons) {
  btn.addEventListener('click', () => {
    setRate(Number(btn.dataset.rate), { immediate: true });
  });
}

// 键盘微调：←/→ 已在原生 range 上生效，这里补充 PageUp/PageDown 快速跳档
document.addEventListener('keydown', (event) => {
  if (event.key === 'PageUp') {
    setRate(Number((currentRate + 1).toFixed(2)), { immediate: true });
    event.preventDefault();
  } else if (event.key === 'PageDown') {
    setRate(Number((currentRate - 1).toFixed(2)), { immediate: true });
    event.preventDefault();
  }
});

// popup 关闭前把未落盘的修改写完
window.addEventListener('pagehide', () => {
  if (pendingRate !== null) {
    // 这里不能 await，用同步发起的 storage.set 尽最大努力保存
    chrome.storage.sync.set({ [STORAGE_KEY]: pendingRate });
    pendingRate = null;
  }
});

/* ------------------------------------------------------------------ */
/* 初始化                                                              */
/* ------------------------------------------------------------------ */

async function init() {
  renderRate();

  // 1. 优先读页面上实际生效的速率（也可能是另一个标签页刚改的）
  const pageState = await readActiveTabRate();

  if (pageState) {
    currentRate = normalizeRate(pageState.target);
    tagEl.textContent = pageState.hasVideo ? '当前页面' : '页面暂无视频';
  } else {
    // 2. 退回到 storage 里的全局设置
    try {
      const data = await chrome.storage.sync.get(STORAGE_KEY);
      const stored = data && data[STORAGE_KEY] !== undefined ? data[STORAGE_KEY] : DEFAULT_RATE;
      currentRate = normalizeRate(stored);
    } catch (err) {
      currentRate = DEFAULT_RATE;
    }
    const tab = await getActiveTab();
    tagEl.textContent = isBilibiliTab(tab) ? '页面未就绪' : '非 B 站页面';
  }

  renderRate();

  if (pageState && pageState.hasVideo) {
    setStatus(pageState.actual !== null
      ? `页面实际：${Number(pageState.actual).toFixed(2)}x`
      : '就绪');
  } else {
    setStatus('仅在 B 站页面生效');
  }

  slider.focus();
}

init();
