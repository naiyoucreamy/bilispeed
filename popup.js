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
 * 这份界面有两个入口，但只有一套代码：
 *   · 浏览器工具栏的扩展图标（原生弹窗）
 *   · 页面右下角的悬浮按钮（floating.js 用 iframe 加载同一个 popup.html）
 * 唯一的差别是 iframe 里拿不到可信的“当前标签页 URL/权限”，
 * 所以 isEmbedded() 为真时跳过那一步，直接把能力判定视为成立。
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
const closeBtn = document.getElementById('closeBtn');
const settingsBtn = document.getElementById('settingsBtn');
const mainView = document.getElementById('mainView');
const settingsView = document.getElementById('settingsView');
const settingsExitBtn = document.getElementById('settingsExitBtn');
const themeToggle = document.getElementById('darkModeToggle');
const presetButtons = Array.from(document.querySelectorAll('.preset'));

/* ---------------------------- 状态 ---------------------------- */

/** 当前标签页的速度 */
let uiRate = DEFAULT_RATE;
/** 当前标签页的 id（仅用于发消息，不显示给用户；悬浮按钮内嵌打开时为 null） */
let tabId = null;
/** 是否可操作（B 站标签页） */
let operable = false;
/** 是否由页面悬浮按钮以 iframe 方式打开（此时走“当前窗口活动标签页”投递） */
let embedded = false;
/** content script 是否就绪 */
let contentReady = false;

let sendTimer = null;
let pendingRate = null;
let hintTimer = null;
/** 初始化期间用户已经操作过，就不再用异步结果覆盖 UI */
let userTouched = false;
/**
 * 内嵌打开时，面板里的「×」要怎么关掉面板。
 * 扩展页面不能自己把自己所在的 iframe 收起来，所以由外层的 floating.js
 * 通过 postMessage 接管；这里只负责在需要时把它显示出来。
 */
let closePanel = null;
/** 上报高度用的 ResizeObserver（只挂一次） */
let heightObserver = null;
/** 当前是否停在设置界面 */
let settingsOpen = false;

/**
 * 现在能不能把速度发出去。
 * 工具栏弹窗有确定的 tabId；悬浮按钮内嵌打开时没有 tabId，
 * 但仍然可以按“当前窗口的活动标签页”投递，所以这里是两个条件的并集。
 */
function canSend() {
  return embedded || tabId !== null;
}

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
 * 提示通道。
 * 界面上已经不再有那行提示文字（用户要求删掉），所以这里保留成空实现：
 * 调用点还有好几处（非 B 站页面、页面没注入、本页没有视频、兜底注入失败），
 * 它们表达的是“当前不可用/需要注意”，删掉调用会让这些情况彻底无声无息。
 * 现在统一降级成“什么都不显示”，但**必须容忍 statusEl 不存在**，
 * 否则一旦有人把这些调用恢复，会立刻抛 TypeError。
 *
 * @param {string} text 提示内容（当前不展示，保留语义）
 * @param {boolean} [persistent] 为 true 时不自动消失
 */
function showHint(text, persistent = false) {
  if (!statusEl) return; // 界面里没有提示元素，静默即可
  statusEl.textContent = text;
  statusEl.hidden = false;
  if (hintTimer !== null) clearTimeout(hintTimer);
  if (!persistent) {
    hintTimer = setTimeout(() => {
      if (statusEl) statusEl.hidden = true;
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
  if (statusEl) statusEl.hidden = true;
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
 * 本页面是否被页面内的悬浮按钮以 iframe 方式加载。
 * 悬浮按钮（floating.js）就是把这份 popup.html 塞进一个 iframe 里，
 * 所以此时不必也不该再去问“当前是哪个标签页”：
 *   - 外层页面本身就是 B 站页面，能力判断直接成立；
 *   - 有没有 tabs 权限都不影响（query 拿不到 url 时会误判成“非 B 站页面”）。
 * @returns {boolean}
 */
function isEmbedded() {
  try {
    if (window.top === window) return false;
    return typeof location !== 'undefined' && location.protocol === 'chrome-extension:';
  } catch (err) {
    return false;
  }
}

/**
 * 内嵌打开时，接上和外层（floating.js）的握手链路。
 *
 * 外层会先发一条 bilispeed:panelHello 过来，我们据此：
 *   1. 记住它的来源，点「×」时回 panelClose 请它收起；
 *   2. 显示「×」（所以工具栏弹窗里不会出现它）。
 *
 * 注意：高度上报**不依赖**这条 hello（见 init 里的 reportPanelHeight）——
 * hello 是外层发的，万一时序错开就会漏掉；高度是「谁量谁报」更可靠。
 */
function bindPanelClose() {
  if (typeof window.addEventListener !== 'function') return;
  window.addEventListener('message', (event) => {
    const data = event && event.data;
    if (!data || data.type !== 'bilispeed:panelHello') return;
    if (event.source !== window.parent) return; // 只认外层页面
    const target = event.source;
    closePanel = () => {
      try {
        target.postMessage({ type: 'bilispeed:panelClose' }, '*');
      } catch (err) {
        /* 发不出去就算了，外层还有“点别处收起”兜底 */
      }
    };
    if (closeBtn) closeBtn.hidden = false;
    reportPanelHeight(target); // 补报一次，双保险
  });
}

/**
 * 量出本页内容的真实高度并上报给外层（floating.js），让它把面板高度调到刚好。
 * 用 body 在文档流里的直接子元素高度累加（实际就是 .card）；
 * 以后若再加可见区块，这里会自动算进来，不用改代码。
 * @param {Window} target 外层窗口
 */
function reportPanelHeight(target) {
  /**
   * 这个子元素是否占据布局高度。
   * 注意：不能用 offsetParent === null 来判断绝对定位 ——
   * body 是 position:relative，「#closeBtn」是 position:absolute，
   * 它的 offsetParent 正好是 body（非 null），会被误算成 19px 高度。
   * 所以这里显式看计算后的 position。
   */
  const takesHeight = (child) => {
    const view = document.defaultView;
    if (view && typeof view.getComputedStyle === 'function') {
      const style = view.getComputedStyle(child);
      if (style.display === 'none') return false;
      if (style.position === 'absolute' || style.position === 'fixed') return false;
    }
    if (child.hidden) return false;
    return true;
  };

  const send = () => {
    let height = 0;
    for (const child of document.body.children) {
      if (!takesHeight(child)) continue;
      height += child.offsetHeight;
    }
    if (height < 40) return; // 还没排版好
    try {
      target.postMessage({ type: 'bilispeed:panelHeight', height }, '*');
    } catch (err) {
      /* 报不上去就维持外层的默认高度 */
    }
  };

  // 先报一次（等一帧确保布局稳定），之后内容变化时继续报
  const raf = typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame
    : (fn) => setTimeout(fn, 0);
  raf(() => {
    send();
    // 状态提示出现/消失、速度数字变宽等都会改变高度
    // （只挂一次，避免重复上报时叠加多个 observer）
    if (!heightObserver && typeof window.ResizeObserver === 'function') {
      heightObserver = new window.ResizeObserver(send);
      heightObserver.observe(document.body);
    }
  });
}

/**
 * 给当前标签页的 content script 发消息，带超时。
 * 超时 / 无接收方返回 null。
 * id 为 null（悬浮按钮内嵌打开时）就退回“当前窗口的活动标签页”，
 * 那条消息同样会落到这个标签页的 content script 上。
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

    const deliver = (target) => {
      try {
        chrome.tabs.sendMessage(target, message, (response) => {
          // 读取 lastError 吞掉 “Receiving end does not exist” 之类的报错
          void chrome.runtime.lastError;
          finish(response === undefined ? null : response);
        });
      } catch (err) {
        finish(null);
      }
    };

    if (id !== null && id !== undefined) {
      deliver(id);
      return;
    }
    // 内嵌打开时没有能力（也不需要）拿到 tabId，交给 Chrome 自己找
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      void chrome.runtime.lastError;
      const active = tabs && tabs[0];
      if (!active || typeof active.id !== 'number') {
        finish(null);
        return;
      }
      deliver(active.id);
    });
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

  if (!canSend()) return;

  const res = await sendToTab(tabId, { type: 'bilispeed:set', rate });
  if (res && res.ok) {
    contentReady = true;
    hideHint(); // 成功是常态：界面上数字已经变了，不需要再报一句
    return;
  }

  // content script 没响应：兜底直接注入设置
  // （内嵌打开时没有确定的 tabId，说明是脚本本身没就绪，刷新提示由 init 负责）
  const injected = await injectRate(tabId, rate);
  if (!embedded) showHint(injected ? '刷新一下页面即可长期生效' : '这个页面暂时无法调速，刷新后重试');
}

/** 重置为 1x */
async function resetRate() {
  userTouched = true;
  uiRate = DEFAULT_RATE;
  render();
  if (!canSend()) return;
  const res = await sendToTab(tabId, { type: 'bilispeed:reset' });
  if (res && res.ok) {
    hideHint();
    return;
  }
  const injected = await injectRate(tabId, DEFAULT_RATE);
  if (!injected && !embedded) showHint('这个页面暂时无法调速，刷新后重试');
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

/* ---------------------------- 明暗主题 ---------------------------- */

/**
 * 主题只有两档：light = 原来的样子，dark = 暗色模式。
 *
 * 存 localStorage 而不是 chrome.storage —— 只有它能**同步**读，
 * 而首帧必须在上色之前就知道答案。那次同步读写在 theme.js 里（head 中执行），
 * 这里只负责切换、记忆，以及万一 theme.js 没跑起来时补一刀。
 * 内嵌在悬浮面板里时，localStorage 与工具栏弹窗同源，所以两边看到的主题一致。
 */
const THEME_KEY = 'bilispeed.theme';
const THEME_LIGHT = 'light';
const THEME_DARK = 'dark';

/** 读已保存的主题；读不到 / 读不了都按浅色算 */
function readTheme() {
  try {
    return localStorage.getItem(THEME_KEY) === THEME_DARK ? THEME_DARK : THEME_LIGHT;
  } catch (err) {
    return THEME_LIGHT;
  }
}

/**
 * 应用并记住主题。
 * 只动 <html> 上的 data-theme，不去碰 theme.js 加的 .is-embedded
 * （那个类决定内嵌时要不要给 <html> 铺底色，跟主题是两件事）。
 * @param {string} theme 'light' | 'dark'
 */
function applyTheme(theme) {
  const root = document.documentElement;
  if (root && typeof root.setAttribute === 'function') {
    root.setAttribute('data-theme', theme);
  }
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch (err) {
    /* 存不下就只在本次会话生效，不影响使用 */
  }
}

/* ---------------------------- 界面切换 ---------------------------- */

/**
 * 在「倍速主界面」与「设置界面」之间切换。
 *
 * 两屏是同一份文档里的兄弟节点，靠 [hidden] 互斥显示，不重新加载页面：
 *   - 这样回到主界面时速度读数、滑块位置原样还在，不用重新读一遍；
 *   - 内嵌面板的高度由挂在 body 上的 ResizeObserver 自动重测上报，
 *     所以这里不用手动通知外层，floating.js 会自己跟着改面板高度。
 *
 * @param {boolean} open true = 进设置界面，false = 回倍速界面
 */
function showSettings(open) {
  settingsOpen = open;
  if (mainView) mainView.hidden = open;
  if (settingsView) settingsView.hidden = !open;
  // 进入设置后收起齿轮：那一屏已经有「退出」，不留第二个入口
  if (settingsBtn) settingsBtn.hidden = open;

  // 把焦点交给新屏幕上的按钮，键盘用户不至于原地丢失焦点
  const target = open ? settingsExitBtn : settingsBtn;
  if (target && typeof target.focus === 'function') target.focus();
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

// 内嵌面板里的「×」：请外层把面板收起来（工具栏弹窗里它是隐藏的）
if (closeBtn) {
  closeBtn.addEventListener('click', () => {
    if (closePanel) closePanel();
  });
}

// 齿轮进设置界面，设置界面里的「退出」回倍速界面
if (settingsBtn) {
  settingsBtn.addEventListener('click', () => showSettings(true));
}
if (settingsExitBtn) {
  settingsExitBtn.addEventListener('click', () => showSettings(false));
}

// 暗色开关：theme.js 已在首帧前设过一次，这里对齐开关状态并接管后续切换
if (themeToggle) {
  const initialTheme = readTheme();
  applyTheme(initialTheme); // theme.js 万一没加载，这里补上
  themeToggle.checked = initialTheme === THEME_DARK;
  themeToggle.addEventListener('change', () => {
    applyTheme(themeToggle.checked ? THEME_DARK : THEME_LIGHT);
  });
}

// PageUp / PageDown 快速跳档（←/→ 由原生 range 处理）
document.addEventListener('keydown', (event) => {
  if (settingsOpen) {
    // 设置界面里不该偷偷改倍速；Esc 等同于「退出」
    if (event.key === 'Escape') {
      showSettings(false);
      event.preventDefault();
    }
    return;
  }
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

  embedded = isEmbedded();
  // 内嵌时接上「×」的链路，并**立刻**上报高度：
  // 不依赖外层的 hello（那条消息万一时序错开就会漏），谁量谁报最可靠。
  if (embedded) {
    bindPanelClose();
    if (window.parent && window.parent !== window) reportPanelHeight(window.parent);
  }

  const tab = embedded ? null : await getActiveTab();
  if (!embedded && (!tab || !isBilibiliTab(tab))) {
    operable = false;
    render();
    showHint('打开一个 B 站视频后即可使用', true);
    return;
  }

  // 由页面悬浮按钮打开时，当前标签页就是外层 B 站标签页
  tabId = embedded ? null : tab.id;
  operable = true;

  // 读取当前标签页的速度：内嵌时由 content script 用 sender.tab.id 自己认领
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
