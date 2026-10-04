/**
 * BiliSpeed - 页面快捷键（Content Script）
 * ---------------------------------------------------------------
 * 职责只有两件：
 *   1. 把键盘上的三组按键翻译成「加速 / 减速 / 重置 1x」；
 *   2. 改完在右下角轻轻报一下当前速度 —— 否则按了键看不见任何反馈。
 *
 * 它**不碰 <video>**：改速一律走 content.js 暴露的 __bilispeed.set() / reset()，
 * 于是「粘住速度」的那整套机制（ratechange 纠正、媒体事件补刀、兜底轮询、
 * SPA 重扫、按标签页记速）全部照旧生效 —— 快捷键只是多了一个入口，
 * 不是第二套调速逻辑，也不会绕过任何既有行为。
 *
 * 键位与匹配规则放在 keys.js 里，与设置界面共用同一份；这里只管
 * 「读配置、听键盘、显示提示」。配置存在 sync 区域，改完立刻生效
 * （storage.onChanged），不必刷新页面。
 *
 * 生效范围：
 *   - 只在页面里已经有 <video> 时拦截按键，其余情况一律原样放行；
 *   - 焦点在输入框 / 可编辑区域（弹幕框、搜索框、评论框）里时不触发；
 *   - 视频全屏时照常生效，提示也会跟到全屏层里显示；
 *   - 不做冲突检测：撞上 B 站自带键时两边都会响应，用户自己挑不打架的键即可。
 */

(() => {
  'use strict';

  // 防止脚本被重复注入时出现两份监听
  if (window.__BILISPEED_SHORTCUT_LOADED__) return;

  /** 键位词汇表（keys.js 注入，排在 content.js 之后、本文件之前） */
  const KEYS = window.__BILISPEED_KEYS__;
  if (!KEYS) return; // 词汇表没加载上就什么都不做，绝不猜

  window.__BILISPEED_SHORTCUT_LOADED__ = true;

  /* ---------------------------- 常量 ---------------------------- */

  /** 宿主元素的 id（挂在 <body> 末尾，全屏时改挂到全屏层里） */
  const ROOT_ID = 'bilispeed-shortcut-root';

  /** 提示停留时间：到点后开始淡出（淡出本身交给 CSS 过渡） */
  const TOAST_MS = 1200;

  /* ---------------------------- 状态 ---------------------------- */

  /** 当前键位（未读到配置前就是默认值） */
  let bindings = KEYS.normalizeBindings(null);
  /** 当前步长 */
  let step = KEYS.DEFAULT_STEP;
  /** 提示的收起计时器 */
  let toastTimer = null;

  /* ---------------------------- 提示浮层 ---------------------------- */

  /**
   * 宿主元素必须完全不参与页面布局：all:initial 抹掉站点可能命中的通用样式，
   * 尺寸为 0（里面的提示是 fixed 定位），所以不会挡住页面任何内容。
   * 与 floating.js 的宿主同一套路，只是这里只放一粒速度提示。
   */
  const host = document.createElement('div');
  host.id = ROOT_ID;
  host.style.cssText = 'all:initial;display:block;position:fixed;inset:auto;width:0;height:0;z-index:2147483000;';

  const shadow = host.attachShadow({ mode: 'open' });

  const CSS = `
    /* 样式只作用在 Shadow DOM 内，绝不外泄到页面 */
    :host { box-sizing: border-box; }
    :host > * { box-sizing: border-box; }

    /* 右下角、悬浮按钮正上方的一粒小标签：只说“现在是几倍速”。
       与 floating.js 打开面板时那句轻提示同一位置、同一观感，
       这样两处提示看起来是同一个东西。 */
    .toast {
      position: fixed;
      z-index: 1;
      right: 12px;
      bottom: 52px;
      padding: 4px 9px;
      font: 600 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
      font-variant-numeric: tabular-nums;
      color: #fff;
      background: rgba(15, 20, 25, 0.86);
      border-radius: 9px;
      box-shadow: 0 4px 14px -6px rgba(0, 0, 0, 0.5);
      /* 不吃鼠标事件：它只是飘在那里，点它不该挡住底下的播放器 */
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.18s ease;
    }

    .toast.is-shown { opacity: 1; }

    /* 尊重“减少动态效果” */
    @media (prefers-reduced-motion: reduce) {
      .toast { transition: none !important; }
    }
  `;

  shadow.innerHTML = `<style>${CSS}</style><div class="toast" role="status" aria-live="polite"></div>`;

  const toast = shadow.querySelector('.toast');

  /* ---------------------------- 挂载 ---------------------------- */

  /** 当前是否处于全屏（含视频全屏） */
  function fullscreenRoot() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }

  /**
   * 提示该挂到哪：全屏时挂进全屏元素里。
   * 全屏时页面其余部分都不可见（floating.js 的按钮就是因此隐藏的），
   * 不搬进来的话，用户按了快捷键什么也看不到。
   */
  function hostParent() {
    return fullscreenRoot() || document.body || document.documentElement || null;
  }

  /** 把提示挂到该在的位置（幂等：位置没变就什么都不做） */
  function mount() {
    const parent = hostParent();
    if (parent && host.parentNode !== parent) parent.appendChild(host);
  }

  /* ---------------------------- 提示 ---------------------------- */

  /**
   * 显示当前速度，例如 `3.00x`；连续触发时重新计时，不会闪。
   * @param {number} rate
   */
  function showToast(rate) {
    if (!toast) return;
    const value = Number(rate);
    if (!Number.isFinite(value)) return;

    toast.textContent = `${value.toFixed(2)}x`;
    toast.classList.add('is-shown');

    if (toastTimer !== null) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastTimer = null;
      toast.classList.remove('is-shown');
    }, TOAST_MS);
  }

  /* ---------------------------- 配置 ---------------------------- */

  function applyBindings(raw) {
    bindings = KEYS.normalizeBindings(raw);
  }

  function applyStep(raw) {
    step = KEYS.normalizeStep(raw);
  }

  /** 读一次配置（同步区域里没有值就沿用默认键位） */
  function loadConfig() {
    try {
      const got = chrome.storage.sync.get([KEYS.BINDINGS_KEY, KEYS.STEP_KEY]);
      if (!got || typeof got.then !== 'function') return;
      got.then((data) => {
        if (!data) return;
        if (data[KEYS.BINDINGS_KEY] !== undefined) applyBindings(data[KEYS.BINDINGS_KEY]);
        if (data[KEYS.STEP_KEY] !== undefined) applyStep(data[KEYS.STEP_KEY]);
      }).catch(() => {
        /* 读不到就用默认键位，功能不受影响 */
      });
    } catch (err) {
      /* 存储不可用时同样退回默认键位 */
    }
  }

  /** 设置界面里改完立刻生效：不用刷新页面，也不用等下一次加载 */
  function watchConfig() {
    try {
      const area = chrome.storage && chrome.storage.onChanged;
      if (!area || typeof area.addListener !== 'function') return;
      area.addListener((changes, changedArea) => {
        if (!changes) return;
        if (changedArea !== undefined && changedArea !== 'sync') return;
        if (changes[KEYS.BINDINGS_KEY]) applyBindings(changes[KEYS.BINDINGS_KEY].newValue);
        if (changes[KEYS.STEP_KEY]) applyStep(changes[KEYS.STEP_KEY].newValue);
      });
    } catch (err) {
      /* 监听不上也不影响：下次加载页面时照样读到新配置 */
    }
  }

  /* ---------------------------- 键盘 ---------------------------- */

  /**
   * 焦点是不是在「正在打字」的地方。
   * 用 composedPath 而不是 target：B 站有些输入框在 Shadow DOM 里，
   * 只看 target 会拿到宿主元素，判断不出里面是个输入框。
   * @param {KeyboardEvent} event
   * @returns {boolean}
   */
  function isTypingTarget(event) {
    let node = null;
    try {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : null;
      node = path && path.length > 0 ? path[0] : event.target;
    } catch (err) {
      node = event.target;
    }
    if (!node || node.nodeType !== 1) return false;
    const tag = node.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    return node.isContentEditable === true;
  }

  /** 倍速接口（content.js 提供）；没就绪时返回 null，本次按键就不处理 */
  function speedApi() {
    const api = window.__bilispeed;
    if (!api) return null;
    if (typeof api.get !== 'function' || typeof api.set !== 'function' || typeof api.reset !== 'function') {
      return null;
    }
    return api;
  }

  /**
   * 一次 keydown 的处理顺序（便宜的先做，贵的后做）：
   *   1. 是不是我们绑定的键 —— 不是就直接返回，绝大多数按键走这一步；
   *   2. 输入法组合中 / 正在输入框里打字 —— 让用户正常输入；
   *   3. 页面里有没有视频 —— 没有就不拦，按了也没意义；
   *   4. 改速 + 提示 + 拦下这次按键。
   * @param {KeyboardEvent} event
   */
  function onKeydown(event) {
    const faster = KEYS.matchesBinding(bindings.faster, event);
    const slower = KEYS.matchesBinding(bindings.slower, event);
    const reset = KEYS.matchesBinding(bindings.reset, event);
    if (!faster && !slower && !reset) return;

    if (event.isComposing === true) return;
    if (isTypingTarget(event)) return;

    const api = speedApi();
    if (!api) return;

    let state = null;
    try {
      state = api.get();
    } catch (err) {
      state = null;
    }
    if (!state || !state.hasVideo) return;

    let next = null;
    try {
      if (reset) {
        next = api.reset();
      } else {
        const current = Number(state.target);
        const base = Number.isFinite(current) ? current : 1;
        // 上下限由 content.js 那边钳制（0.25 ~ 16），到边界就是停住不动
        next = api.set(base + (faster ? step : -step));
      }
    } catch (err) {
      next = null;
    }
    if (typeof next !== 'number' || !Number.isFinite(next)) return;

    // 拦下这次按键：否则页面很可能还会按自己的快捷键再响应一遍
    event.preventDefault();
    event.stopPropagation();
    showToast(next);
  }

  /* ---------------------------- 启动 ---------------------------- */

  function boot() {
    mount();

    // 捕获阶段：抢在 B 站自己的键盘处理之前定价，拦下来才拦得住
    document.addEventListener('keydown', onKeydown, true);
    document.addEventListener('fullscreenchange', mount, true);
    document.addEventListener('webkitfullscreenchange', mount, true);

    // document_start 时 <body> 还没出现，等 DOM 就绪再挂
    if (!document.body && typeof document.addEventListener === 'function') {
      document.addEventListener('DOMContentLoaded', mount, { once: true });
    }

    loadConfig();
    watchConfig();
  }

  boot();
})();
