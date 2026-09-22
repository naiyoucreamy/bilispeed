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
 *
 * 界面原则：只显示用户需要的信息。当前速度、常用档位、重置。
 * 不显示任何内部标识（标签页号、存储键、实现细节）。
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
/** 提示文字停留时间 */
const HINT_MS = 2600;

/* ---------------------------- DOM ---------------------------- */

const slider = document.getElementById('rateSlider');
const rateValue = document.getElementById('rateValue');
const statusEl = document.getElementById('status');
const resetBtn = document.getElementById('resetBtn');
const minusBtn = document.getElementById('minusBtn');
const plusBtn = document.getElementById('plusBtn');
const presetButtons = Array.from(document.querySelectorAll('.preset'));

/* ---------------------------- 状态 ---------------------------- */

/** 当前标签页的速度 */
let uiRate = DEFAULT_RATE;
/** 当前标签页的 id（仅用于发消息，不显示给用户） */
let tabId = null;
/** 是否可操作（B 站标签页） */
let operable = false;
/** content script 是否就绪 */
let contentReady = false;

let sendTimer = null;
let pendingRate = null;
let hintTimer = null;
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

/**
 * 按速度计算强调色：慢速偏青，越接近上限越暖。
 * 让"更快"这件事在视觉上能被直接感知。
 * @param {number} rate
 * @returns {string} CSS 颜色
 */
function accentFor(rate) {
  const t = (Math.min(MAX_RATE, Math.max(MIN_RATE, rate)) - MIN_RATE) / (MAX_RATE - MIN_RATE);
  const stops = [
    [0.00, [0, 176, 214]],   // 0.25x 天蓝
    [0.25, [0, 132, 214]],   // 4x    深蓝
    [0.55, [124, 92, 224]],  // 8.5x  靛紫
    [0.80, [232, 92, 106]],  // 12.8x 珊瑚红
    [1.00, [242, 118, 48]],  // 16x   暖橙
  ];
  let lo = stops[0];
  let hi = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i += 1) {
    if (t >= stops[i][0] && t <= stops[i + 1][0]) {
      lo = stops[i];
      hi = stops[i + 1];
      break;
    }
  }
  const span = hi[0] - lo[0] || 1;
  const k = (t - lo[0]) / span;
  const mix = (a, b) => Math.round(a + (b - a) * k);
  return `rgb(${mix(lo[1][0], hi[1][0])}, ${mix(lo[1][1], hi[1][1])}, ${mix(lo[1][2], hi[1][2])})`;
}

/**
 * 显示一条提示（只在需要时出现）
 * @param {string} text
 * @param {boolean} [persistent] 为 true 时不自动消失
 */
function showHint(text, persistent = false) {
  statusEl.textContent = text;
  statusEl.hidden = false;
  if (hintTimer !== null) clearTimeout(hintTimer);
  if (!persistent) {
    hintTimer = setTimeout(() => {
      statusEl.hidden = true;
      hintTimer = null;
    }, HINT_MS);
  }
}

/** 收起提示 */
function hideHint() {
  if (hintTimer !== null) {
    clearTimeout(hintTimer);
    hintTimer = null;
  }
  statusEl.hidden = true;
}

/** 同步所有 UI 元素 */
function render() {
  const accent = accentFor(uiRate);
  const fill = ((uiRate - MIN_RATE) / (MAX_RATE - MIN_RATE)) * 100;

  rateValue.textContent = uiRate.toFixed(2);
  document.documentElement.style.setProperty('--accent', accent);
  document.documentElement.style.setProperty('--fill', `${fill}%`);
  slider.value = String(uiRate);
  slider.setAttribute('aria-valuetext', `${uiRate.toFixed(2)} 倍速`);

  for (const btn of presetButtons) {
    btn.classList.toggle('is-active', Math.abs(Number(btn.dataset.rate) - uiRate) < 0.001);
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

/** 立即下发 */
async function flushSend() {
  if (sendTimer !== null) {
    clearTimeout(sendTimer);
    sendTimer = null;
  }
  if (pendingRate === null) return;
  const rate = pendingRate;
  pendingRate = null;

  if (tabId === null) return;

  const res = await sendToTab(tabId, { type: 'bilispeed:set', rate });
  if (res && res.ok) {
    contentReady = true;
    hideHint(); // 成功是常态：界面上数字已经变了，不需要再报一句
    return;
  }

  // content script 没响应：兜底直接注入设置
  const injected = await injectRate(tabId, rate);
  showHint(injected ? '刷新一下页面即可长期生效' : '这个页面暂时无法调速，刷新后重试');
}

/** 重置为 1x */
async function resetRate() {
  userTouched = true;
  uiRate = DEFAULT_RATE;
  render();
  if (tabId === null) return;
  const res = await sendToTab(tabId, { type: 'bilispeed:reset' });
  if (res && res.ok) {
    hideHint();
    return;
  }
  const injected = await injectRate(tabId, DEFAULT_RATE);
  if (!injected) showHint('这个页面暂时无法调速，刷新后重试');
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

// 滑块：input 期间只更新 UI + 节流下发，保证拖动顺滑
slider.addEventListener('input', () => {
  userTouched = true;
  uiRate = normalizeRate(slider.value);
  render();
  scheduleSend(uiRate);
});

// 松手立即下发，避免节流窗口内关掉 popup 丢设置
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
    render();
    showHint('打开一个 B 站视频后即可使用', true);
    return;
  }

  tabId = tab.id;
  operable = true;

  // 读取当前标签页的速度
  const state = await sendToTab(tabId, { type: 'bilispeed:get' });
  contentReady = Boolean(state && state.ok);

  if (!userTouched) {
    uiRate = contentReady ? normalizeRate(state.target) : DEFAULT_RATE;
  }
  render();

  // 只在"不能用"或"需要用户做点什么"的时候才提示
  if (!contentReady) {
    showHint('刷新一下页面即可使用', true);
  } else if (!state.hasVideo) {
    showHint('本页还没有开始播放视频', true);
  } else {
    hideHint();
  }
}

init();
