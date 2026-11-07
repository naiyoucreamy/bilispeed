/**
 * BiliSpeed - 播放器「倍速按钮」上的轻量档位条（Content Script）
 * ---------------------------------------------------------------
 * 只做一件事：
 *   鼠标移到 / 点击 B 站播放器控制栏自带的「倍速」按钮时，不弹 B 站自己的菜单，
 *   而是在按钮上方弹出一条档位条，点一下就能切到插件里的那几档速度。
 *
 * 边界（刻意保持轻量，其它一概不碰）：
 *   - 不改 popup / 悬浮球 / 快捷键 / 调速内核，一行都不动；
 *   - 档位只有插件本来就有的那 8 档，不新增速度概念；
 *   - 改速一律走 content.js 暴露的 window.__bilispeed.set()，
 *     于是「粘住速度」的那整套机制（ratechange 纠正、媒体事件补刀、
 *     兜底轮询、SPA 重扫、按标签页记速）全部照旧生效；
 *   - 找不到倍速按钮（B 站改版 / 非播放器页面）就什么都不做，
 *     右下角的悬浮球仍然是完整入口，不会出现「入口消失」。
 *
 * 实现要点：
 *   1. 原生菜单用 speedbar.css 藏掉（manifest 注入，document_start 就生效）；
 *   2. hover 用 mouseover 委托打开；按下 / 点击也走 click —— 两条路都能弹。
 *      鼠标离开按钮和档位条后延迟一小会儿再收，给「从按钮挪到档位条」留出路；
 *   3. 在 window 捕获阶段拦 click —— content script 比页面脚本先注册，
 *      所以这一手一定能抢在播放器自己的处理之前；
 *   4. 档位条挂在 Shadow DOM 里，样式与页面完全隔离；
 *   5. 位置跟着按钮的 getBoundingClientRect() 算（fixed 定位），
 *      滚动 / 缩放 / 全屏时重算，按钮没了就收起。
 *
 * 调试：页面 Console 里 __bilispeedSpeedbar.open() / .close() / .isOpen()。
 */

(() => {
  'use strict';

  // 防止脚本被重复注入时出现两条档位条
  if (window.__BILISPEED_SPEEDBAR_LOADED__) return;
  window.__BILISPEED_SPEEDBAR_LOADED__ = true;

  /* ---------------------------- 常量 ---------------------------- */

  /**
   * B 站 bpx 播放器的倍速按钮（点击它的时候弹我们的档位条）。
   * 只认 `.bpx-player-ctrl-playbackrate` 这个类，不强求外面那层 `ctrl-btn` ——
   * B 站改版时少挂一个类也不至于整个入口失效。
   */
  const BTN_SELECTOR = '.bpx-player-ctrl-playbackrate';

  /**
   * 插件本来就有的 8 个档位。
   * 竖排时从快到慢从上往下排：16x 在最上面，0.5x 在最下面。
   */
  const RATES = [16, 8, 4, 3, 2, 1.5, 1, 0.5];

  /** 宿主元素的 id */
  const ROOT_ID = 'bilispeed-speedbar-root';

  /** 档位条距离视口边缘的最小距离 */
  const EDGE = 8;
  /** 档位条与倍速按钮之间的间距 */
  const GAP = 8;

  /** 打开期间检查按钮是否还在的间隔（很轻，只做 rect 校验） */
  const WATCHDOG_MS = 300;

  /**
   * 鼠标离开按钮 / 档位条之后，隔多久收起。
   * 留这么一小段是为了：鼠标从按钮挪到档位条、经过中间那几像素空隙时不至于闪一下。
   */
  const HOVER_CLOSE_MS = 260;

  /* ---------------------------- 状态 ---------------------------- */

  const host = document.createElement('div');
  host.id = ROOT_ID;
  /**
   * 宿主元素不参与页面布局：all:initial 抹掉站点通用样式，
   * 自身 0×0、fixed，里面的档位条才是 fixed 定位。
   */
  host.style.cssText = 'all:initial;display:block;position:fixed;inset:auto;width:0;height:0;z-index:2147483000;';

  const shadow = host.attachShadow({ mode: 'open' });

  /** 是否展开 */
  let open = false;
  /** 当前锚定的倍速按钮（打开时记下，滚动/全屏时用它重算位置） */
  let anchor = null;
  /** 打开期间的校验计时器 */
  let watchdogTimer = null;
  /** hover 离开后的延迟收起计时器 */
  let hoverCloseTimer = null;

  /* ---------------------------- 样式（全部在 Shadow DOM 内） ---------------------------- */

  const CSS = `
    :host { box-sizing: border-box; }
    :host > * { box-sizing: border-box; }

    /* 一条很窄的横条：暗色半透明，贴合播放器控制栏的观感 */
    /* 一列竖排档位：暗色半透明，贴合播放器控制栏的观感。
       宽度固定，所有档位左右对齐；高度按档位数量自然撑开。 */
    .bar {
      position: fixed;
      left: -9999px;
      top: -9999px;
      display: flex;
      flex-direction: column;
      gap: 3px;
      width: 54px;
      padding: 4px;
      font: 500 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
      background: rgba(17, 20, 26, 0.82);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 12px;
      box-shadow: 0 6px 20px -8px rgba(0, 0, 0, 0.65);
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
      transform: translateY(4px);
      transition: opacity 0.14s ease, transform 0.14s ease, visibility 0.14s;
    }

    .bar.is-open {
      opacity: 1;
      visibility: visible;
      pointer-events: auto;
      transform: none;
    }

    /* 每个档位：竖排时占满一列宽，数字用等宽，宽度不随内容跳 */
    .rate {
      width: 100%;
      height: 32px;
      padding: 0 6px;
      font: inherit;
      font-variant-numeric: tabular-nums;
      color: rgba(255, 255, 255, 0.78);
      background: transparent;
      border: 0;
      border-radius: 8px;
      cursor: pointer;
      white-space: nowrap;
      transition: background 0.12s ease, color 0.12s ease, transform 0.1s ease;
    }

    .rate:hover {
      color: #fff;
      background: rgba(255, 255, 255, 0.12);
    }

    .rate:active { transform: scale(0.94); }

    /* 当前档位：实心品牌蓝，一眼看出「现在是这个速度」 */
    .rate.is-active {
      color: #fff;
      font-weight: 600;
      background: #00a1d6;
    }

    .rate.is-active:hover { background: #00a1d6; }

    .rate:focus-visible {
      outline: 2px solid #6fd3f5;
      outline-offset: 1px;
    }

    @media (prefers-reduced-motion: reduce) {
      .bar, .rate { transition: none !important; }
    }
  `;

  /* ---------------------------- 结构 ---------------------------- */

  const TEMPLATE = `
    <style>${CSS}</style>
    <div class="bar" role="toolbar" aria-label="BiliSpeed 倍速">
      ${RATES.map((rate) => (
        `<button class="rate" type="button" data-rate="${rate}" `
        + `aria-label="切换到 ${rate} 倍速">${rate}x</button>`
      )).join('')}
    </div>
  `;

  shadow.innerHTML = TEMPLATE;
  const bar = shadow.querySelector('.bar');

  /* ---------------------------- 小工具 ---------------------------- */

  /** 当前生效的目标速度：优先问 content.js，拿不到就退回 video 的实际值 */
  function currentRate() {
    const api = window.__bilispeed;
    if (api && typeof api.get === 'function') {
      try {
        const state = api.get();
        if (state && Number.isFinite(state.target)) return state.target;
      } catch (err) { /* 落到下面的 video */ }
    }
    const video = document.querySelector('video');
    if (video && Number.isFinite(video.playbackRate)) return video.playbackRate;
    return 1;
  }

  /** 把当前速度对应的档位点亮（不是标准档位时全都不亮） */
  function syncActive() {
    const rate = currentRate();
    for (const btn of bar.querySelectorAll('.rate')) {
      btn.classList.toggle('is-active', Math.abs(Number(btn.dataset.rate) - rate) < 0.001);
    }
  }

  /* ---------------------------- 挂载 ---------------------------- */

  /** 全屏元素（真全屏时，页面其余部分不可见，档位条必须挂进去） */
  function fullscreenRoot() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }

  /** 档位条该挂在哪：全屏时挂进全屏元素，否则挂 body */
  function hostParent() {
    return fullscreenRoot() || document.body || document.documentElement || null;
  }

  /** 把宿主挂到该在的位置（幂等） */
  function mount() {
    const parent = hostParent();
    if (parent && host.parentNode !== parent) parent.appendChild(host);
  }

  /* ---------------------------- 定位 ---------------------------- */

  /**
   * 按锚点按钮的位置把档位条摆好：竖排、贴在按钮正上方、右边缘对齐，
   * 左右都收在视口内；上方放不下就翻到按钮下方。
   * 按钮已经不在文档里 / 完全滚出视口时，直接收起。
   */
  function place() {
    const btn = anchor;
    if (!btn) return;
    if (!btn.isConnected) {
      close();
      return;
    }

    const rect = btn.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      close();
      return;
    }
    // 按钮完全离开视口（页面滚动 / 播放器被移走）-> 收起
    if (
      rect.bottom < 0
      || rect.top > window.innerHeight
      || rect.right < 0
      || rect.left > window.innerWidth
    ) {
      close();
      return;
    }

    // 量之前先把位置挪到屏幕外，避免上一次的坐标干扰测量
    const width = bar.offsetWidth;
    const height = bar.offsetHeight;
    if (width === 0 || height === 0) return; // 还没排版好，下一轮再说

    let left = rect.right - width; // 右边缘对齐按钮右边缘（和原生菜单一致）
    let top = rect.top - height - GAP;

    left = Math.max(EDGE, Math.min(left, window.innerWidth - width - EDGE));

    // 上方空间不够（按钮贴顶）就翻到按钮下方
    if (top < EDGE && rect.bottom + GAP + height <= window.innerHeight - EDGE) {
      top = rect.bottom + GAP;
    } else {
      top = Math.max(EDGE, top);
    }

    bar.style.left = `${Math.round(left)}px`;
    bar.style.top = `${Math.round(top)}px`;
  }

  /* ---------------------------- 开 / 关 ---------------------------- */

  function startWatchdog() {
    if (watchdogTimer !== null) return;
    watchdogTimer = setInterval(() => {
      if (!open) {
        stopWatchdog();
        return;
      }
      place();
    }, WATCHDOG_MS);
  }

  function stopWatchdog() {
    if (watchdogTimer !== null) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
  }

  /** 取消「hover 离开后收起」的计时 */
  function cancelHoverClose() {
    if (hoverCloseTimer !== null) {
      clearTimeout(hoverCloseTimer);
      hoverCloseTimer = null;
    }
  }

  /**
   * 鼠标离开按钮和档位条之后，隔一小会儿再收。
   * 鼠标只是从按钮挪到档位条上时，中间那几像素空隙会先排一次收起，
   * 等鼠标落到档位条上立刻被 cancelHoverClose() 取消 —— 面板不会闪。
   */
  function scheduleHoverClose() {
    if (!open) return;
    cancelHoverClose();
    hoverCloseTimer = setTimeout(() => {
      hoverCloseTimer = null;
      close();
    }, HOVER_CLOSE_MS);
  }

  /** 打开档位条，锚定到被悬停 / 点击的那个倍速按钮上 */
  function openBar(btn) {
    if (!btn) return;
    cancelHoverClose();
    anchor = btn;
    open = true;
    syncActive();
    bar.classList.add('is-open');

    bar.style.left = '-9999px';
    bar.style.top = '-9999px';
    place();
    startWatchdog();
  }

  function close() {
    cancelHoverClose();
    if (!open) {
      stopWatchdog();
      return;
    }
    open = false;
    anchor = null;
    bar.classList.remove('is-open');
    stopWatchdog();
  }

  /* ---------------------------- 改速 ---------------------------- */

  /**
   * 切到指定档位。
   * 走 content.js 的 __bilispeed.set()，所以和 popup、快捷键是同一条路径；
   * 万一 content.js 没注入（极少见），退化成直接写 video.playbackRate，
   * 至少让这一次点击有反应。
   * @param {number} rate
   */
  function setRate(rate) {
    const api = window.__bilispeed;
    if (api && typeof api.set === 'function') {
      try { api.set(rate); } catch (err) { /* 下面兜底 */ }
    } else {
      for (const video of document.querySelectorAll('video')) {
        try { video.playbackRate = rate; } catch (err) { /* 忽略单个失败 */ }
      }
    }
    syncActive();
    close(); // 和原生菜单一样：点完就收起
  }

  /* ---------------------------- 事件 ---------------------------- */

  /**
   * 从点击事件里找出「被点的那个倍速按钮」。
   * 按钮内部的图标 / 文字都可能成为 target，所以统一走 closest。
   * @param {Event} event
   * @param {EventTarget[]} path
   * @returns {Element|null}
   */
  function findRateButton(event, path) {
    const target = event.target;
    if (target && typeof target.closest === 'function') {
      const hit = target.closest(BTN_SELECTOR);
      if (hit) return hit;
    }
    for (const node of path) {
      if (node && node.nodeType === 1 && typeof node.matches === 'function' && node.matches(BTN_SELECTOR)) {
        return node;
      }
    }
    return null;
  }

  function onWindowClick(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];

    // 点自己的档位条：交给 bar 自己的监听处理，别在这里关掉
    if (path.includes(host)) return;

    const btn = findRateButton(event, path);
    if (btn) {
      // 拦下 B 站自己的处理：原生菜单已经被 CSS 藏了，
      // 这里再顺手阻止它的点击逻辑，避免内部状态和界面不一致
      event.preventDefault();
      event.stopPropagation();
      cancelHoverClose();
      // 鼠标按下来时 hover 通常已经打开过了；这里只保证「一定是打开的」，
      // 不再做成 toggle —— 否则刚 hover 打开、一按就关，反而更别扭
      if (!open || anchor !== btn) openBar(btn);
      return;
    }

    // 点页面别处：收起
    if (open) close();
  }

  /**
   * hover 到倍速按钮上也弹（「放上去」和「按下去」两条路都要能开）。
   * 用 mouseover 做委托：按钮内部的图标 / 文字成为 target 也能认出来。
   */
  function onWindowMouseOver(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];

    // 鼠标落在档位条上：别收
    if (path.includes(host)) {
      cancelHoverClose();
      return;
    }

    const btn = findRateButton(event, path);
    if (!btn) return;

    cancelHoverClose();
    if (!open || anchor !== btn) openBar(btn);
  }

  /**
   * 鼠标离开按钮 / 档位条后才排收起。
   * 只处理「从我们身上离开」的 mouseout，鼠标在页面别处怎么动都不打扰；
   * 目的地如果是档位条或按钮，就当作没离开（按钮 <-> 档位条之间来回不闪）。
   */
  function onWindowMouseOut(event) {
    if (!open) return;

    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    const fromButton = Boolean(findRateButton(event, path));
    const fromBar = path.includes(host);
    if (!fromButton && !fromBar) return;

    const to = event.relatedTarget;
    if (to && to.nodeType === 1) {
      if (typeof to.closest === 'function' && to.closest(`#${ROOT_ID}`)) return;
      if (typeof to.closest === 'function' && to.closest(BTN_SELECTOR)) return;
    }

    scheduleHoverClose();
  }

  function onKeydown(event) {
    if (!open || event.key !== 'Escape') return;
    close();
  }

  /** 滚动 / 缩放 / 全屏变化后重新定位 */
  function onViewportChange() {
    if (!open) return;
    place();
  }

  function onFullscreen() {
    mount();
    if (!open) return;
    // 全屏切换后按钮会被搬到新容器里，等一帧再量
    const raf = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (fn) => setTimeout(fn, 16);
    raf(place);
  }

  /* ---------------------------- 启动 ---------------------------- */

  function boot() {
    mount();

    // 捕获阶段：content script 比页面脚本先注册，所以这一手一定抢在前面
    window.addEventListener('click', onWindowClick, true);
    window.addEventListener('mouseover', onWindowMouseOver, true);
    window.addEventListener('mouseout', onWindowMouseOut, true);
    window.addEventListener('keydown', onKeydown, true);
    window.addEventListener('scroll', onViewportChange, true);
    window.addEventListener('resize', onViewportChange);
    document.addEventListener('fullscreenchange', onFullscreen, true);
    document.addEventListener('webkitfullscreenchange', onFullscreen, true);

    // document_start 时 <body> 还没出现，等 DOM 就绪再挂
    if (!document.body && typeof document.addEventListener === 'function') {
      document.addEventListener('DOMContentLoaded', mount, { once: true });
    }
  }

  // 点档位：事件在 Shadow DOM 内被接住，不再往外冒给播放器
  bar.addEventListener('click', (event) => {
    event.stopPropagation();
    const target = event.target;
    const btn = target && typeof target.closest === 'function' ? target.closest('.rate') : null;
    if (!btn) return;
    const rate = Number(btn.dataset.rate);
    if (Number.isFinite(rate)) setRate(rate);
  });
  bar.addEventListener('pointerdown', (event) => event.stopPropagation());

  boot();

  /** 调试入口（页面 Console 可用） */
  window.__bilispeedSpeedbar = {
    open: () => {
      const btn = document.querySelector(BTN_SELECTOR);
      if (btn) openBar(btn);
      return Boolean(btn);
    },
    close,
    isOpen: () => open,
    anchor: () => anchor,
  };
})();
