/**
 * BiliSpeed - Popup 逻辑（按标签页临时记速版）
 * ---------------------------------------------------------------
 * 存储模型：**没有全局存储**。速度由 content script 保存在内存里，
 * 并镜像到 chrome.storage.session 的 `bilispeed.rate.<tabKey>`（tabKey 是该
 * 标签页专属的随机 ID，存在页面的 sessionStorage 里）：
 *   - 标签页内所有视频共用一个速度（切视频 / 切分P / SPA 跳转 / 刷新都保持）
 *   - 标签页关闭 -> session 区域随标签页销毁 -> 速度自动清除
 *   - 新标签页 -> 永远是 1x
 *
 * popup 的职责只有两件事：
 *   1. 向 content script 询问/下发速度（sendMessage）
 *   2. 页面上的 content script 尚未就绪时（刚装扩展、页面没刷新），
 *      用 scripting 兜底直接设一遍当前 video 的 playbackRate
 */

'use strict';

const MIN_RATE = 0.25;
const MAX_RATE = 16;
const STEP = 0.25;
const DEFAULT_RATE = 1;

/** 拖动滑块时合并发送，避免每个像素都发消息 */
const THROTTLE_MS = 80;
/** 给 content script 发消息的超时 */
const MESSAGE_TIMEOUT_MS = 400;

/* ---------------------------- DOM ---------------------------- */

const slider = document.getElementById('rateSlider');
const rateText = document.getElementById('rateText');
const tagEl = document.getElementById('tag');
const statusEl = document.getElementById('status');
const resetBtn = document.getElementById('resetBtn');
const minusBtn = document.getElementById('minusBtn');
const plusBtn = document.getElementById('plusBtn');
const presetButtons = Array.from(document.querySelectorAll('.preset'));

/* ---------------------------- 状态 ---------------------------- */

/** 当前标签页的速度 */
let uiRate = DEFAULT_RATE;
/** 当前标签页的 id */
let tabId = null;
/** 是否可操作（B 站标签页） */
let operable = false;
/** 页面是否存在 video 元素 */
let hasVideo = false;
/** content script 是否可用（不可用时走 scripting 兜底） */
let contentReady = false;

let sendTimer = null;
let pendingRate = null;
let statusTimer = null;
/** 初始化期间用户已经操作过，就不再用异步结果覆盖 UI */
let userTouched = false;

/* ---------------------------- 工具 ---------------------------- */

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

/** 状态栏文字；警告 3 秒后自动恢复 */
function setStatus(text, isWarn = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('warn', Boolean(isWarn));
  if (statusTimer !== null) clearTimeout(statusTimer);
  if (isWarn) {
    statusTimer = setTimeout(() => {
      statusEl.textContent = '就绪';
      statusEl.classList.remove('warn');
    }, 3000);
  }
}

/** 刷新滑块填充渐变 */
function paintSlider() {
  const percent = ((uiRate - MIN_RATE) / (MAX_RATE - MIN_RATE)) * 100;
  slider.style.background =
    `linear-gradient(90deg, var(--brand) ${percent}%, var(--line) ${percent}%)`;
}

/** 同步所有 UI 元素 */
function render() {
  rateText.textContent = `${uiRate.toFixed(2)}x`;
  slider.value = String(uiRate);
  paintSlider();
  for (const btn of presetButtons) {
    btn.classList.toggle('active', Math.abs(Number(btn.dataset.rate) - uiRate) < 0.001);
  }

  slider.disabled = !operable;
  resetBtn.disabled = !operable;
  minusBtn.disabled = !operable;
  plusBtn.disabled = !operable;
  for (const btn of presetButtons) btn.disabled = !operable;
}

/* ---------------------------- tab / 消息 ---------------------------- */

async function getActiveTab() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs && tabs[0] ? tabs[0] : null;
  } catch (err) {
    return null;
  }
}

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
 * 给当前标签页的 content script 发消息，带超时。
 * 超时 / 无接收方返回 null。
 * @returns {Promise<any|null>}
 */
function sendToTab(id, message) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), MESSAGE_TIMEOUT_MS);

    try {
      chrome.tabs.sendMessage(id, message, (response) => {
        // 读取 lastError 吞掉 “Receiving end does not exist” 之类的报错
        void chrome.runtime.lastError;
        finish(response === undefined ? null : response);
      });
    } catch (err) {
      finish(null);
    }
  });
}

/**
 * 兜底：用 scripting 在页面里直接设速。
 * 仅在 content script 未就绪（刚装扩展 / 页面没刷新）时使用。
 * @returns {Promise<boolean>} 是否成功执行
 */
async function injectRate(id, rate) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: id },
      func: (value) => {
        const videos = document.querySelectorAll('video');
        for (const video of videos) {
          try { video.playbackRate = value; } catch (e) { /* 忽略单个失败 */ }
        }
        return videos.length;
      },
      args: [rate],
    });
    return true;
  } catch (err) {
    return false;
  }
}

/* ---------------------------- 下发流程 ---------------------------- */

/** 节流下发（拖动滑块时用） */
function scheduleSend(rate) {
  pendingRate = rate;
  if (sendTimer !== null) return;
  sendTimer = setTimeout(() => {
    sendTimer = null;
    flushSend();
  }, THROTTLE_MS);
}

/** 立即下发并更新状态栏 */
async function flushSend() {
  if (sendTimer !== null) {
    clearTimeout(sendTimer);
    sendTimer = null;
  }
  if (pendingRate === null) return;
  const rate = pendingRate;
  pendingRate = null;

  if (tabId === null) {
    setStatus('无法定位当前标签页', true);
    return;
  }

  const res = await sendToTab(tabId, { type: 'bilispeed:set', rate });
  if (res && res.ok) {
    contentReady = true;
    setStatus(`已应用到本标签页（${rate.toFixed(2)}x）`);
    return;
  }

  // content script 没响应：兜底直接注入设置
  const injected = await injectRate(tabId, rate);
  if (injected) {
    setStatus('已生效；刷新页面后由扩展自动接管', true);
  } else {
    setStatus('页面未响应（请刷新页面重试）', true);
  }
}

/** 重置为 1x */
async function resetRate() {
  userTouched = true;
  uiRate = DEFAULT_RATE;
  render();
  if (tabId === null) return;
  const res = await sendToTab(tabId, { type: 'bilispeed:reset' });
  if (res && res.ok) {
    setStatus('已重置为 1.00x');
  } else {
    const injected = await injectRate(tabId, DEFAULT_RATE);
    setStatus(injected ? '已重置为 1.00x' : '页面未响应（请刷新页面）', !injected);
  }
}

/**
 * 设置速度的唯一入口
 * @param {number} rate
 * @param {{immediate?: boolean}} options immediate=true 跳过节流
 */
function setRate(rate, options = {}) {
  uiRate = normalizeRate(rate);
  render();
  pendingRate = uiRate;
  if (options.immediate) flushSend();
  else scheduleSend(uiRate);
}

/* ---------------------------- 事件绑定 ---------------------------- */

slider.addEventListener('input', () => {
  userTouched = true;
  uiRate = normalizeRate(slider.value);
  render();
  scheduleSend(uiRate);
});

slider.addEventListener('change', () => {
  userTouched = true;
  uiRate = normalizeRate(slider.value);
  render();
  pendingRate = uiRate;
  flushSend();
});

resetBtn.addEventListener('click', resetRate);

minusBtn.addEventListener('click', () => {
  userTouched = true;
  setRate(Number((uiRate - STEP).toFixed(2)), { immediate: true });
});

plusBtn.addEventListener('click', () => {
  userTouched = true;
  setRate(Number((uiRate + STEP).toFixed(2)), { immediate: true });
});

for (const btn of presetButtons) {
  btn.addEventListener('click', () => {
    userTouched = true;
    setRate(Number(btn.dataset.rate), { immediate: true });
  });
}

// PageUp / PageDown 快速跳档（←/→ 由原生 range 处理）
document.addEventListener('keydown', (event) => {
  if (event.key === 'PageUp') {
    userTouched = true;
    setRate(Number((uiRate + 1).toFixed(2)), { immediate: true });
    event.preventDefault();
  } else if (event.key === 'PageDown') {
    userTouched = true;
    setRate(Number((uiRate - 1).toFixed(2)), { immediate: true });
    event.preventDefault();
  }
});

/* ---------------------------- 初始化 ---------------------------- */

async function init() {
  render();

  const tab = await getActiveTab();
  if (!tab || !isBilibiliTab(tab)) {
    operable = false;
    tagEl.textContent = tab ? '非 B 站页面' : '无活动标签页';
    render();
    setStatus('仅在 B 站页面生效', true);
    return;
  }

  tabId = tab.id;
  operable = true;

  // 向 content script 读取当前标签页的速度
  const state = await sendToTab(tabId, { type: 'bilispeed:get' });

  if (state && state.ok) {
    contentReady = true;
    hasVideo = Boolean(state.hasVideo);
  } else {
    contentReady = false;
  }

  if (!userTouched) {
    uiRate = state && state.ok ? normalizeRate(state.target) : DEFAULT_RATE;
  }
  render();

  // 标签文案：显示本标签页的随机键前缀，用来直观确认各标签页互相独立
  const tabKeyShort = state && state.ok && state.tabKey
    ? String(state.tabKey).slice(0, 6)
    : null;
  tagEl.textContent = tabKeyShort
    ? `标签页 #${tabKeyShort}`
    : `标签页 ${tabId} · 未就绪`;

  // 状态栏
  if (!contentReady) {
    setStatus('扩展未注入此页面，改速度后请刷新一次', true);
  } else if (!hasVideo) {
    setStatus('本标签页暂无 video（播放器未加载）', true);
  } else if (state && state.actual !== null && Math.abs(state.actual - uiRate) >= 0.001) {
    setStatus(`页面实际：${Number(state.actual).toFixed(2)}x`);
  } else if (Math.abs(uiRate - DEFAULT_RATE) < 0.001) {
    setStatus('本标签页使用默认 1x');
  } else {
    setStatus(`本标签页：${uiRate.toFixed(2)}x`);
  }
}

init();
