/**
 * BiliSpeed - 页面悬浮按钮（Content Script · 只负责“入口”，不碰倍速逻辑）
 * ---------------------------------------------------------------
 * 目标：在 B 站页面上放一个很小的圆形按钮，点一下就能打开 BiliSpeed 面板，
 *       不必每次都去点浏览器工具栏上的扩展图标。
 *
 * 设计原则（与 content.js 的约定保持一致）：
 *  1. **界面与逻辑完全不重复实现**：面板里是一个 iframe，直接加载扩展自带的
 *     popup.html —— 也就是工具栏弹窗用的那一份界面和那一份 popup.js。
 *     所以按钮打开的东西和点工具栏图标打开的东西，必然是同一个东西。
 *  2. **倍速逻辑一行都不碰**：本文件不读写速度、不发扩展消息、不接触 <video>，
 *     只做“显示 / 隐藏一个 iframe”。调速仍然全部由 content.js + popup.js 完成。
 *  3. **不污染页面 DOM**：整个按钮挂在 Shadow DOM 里，样式与 B 站互相隔离，
 *     不会被站点的 `* {}` 规则或深色模式影响，也不会把样式漏到页面上。
 *  4. **按钮保持最小**：按钮上不写扩展名。名字（BiliSpeed）就在展开的面板里 ——
 *     面板顶部本来就是品牌行，所以页面上不会重复出现两处品牌字。
 *
 * 外观：
 *   - 按钮：32px 圆形，B 站蓝渐变 + 一个“仪表盘”图标，固定在右下角
 *   - 面板：就是 popup 自己那张卡片，外面**不再套一层圆角方框**
 *     （套壳会出现两层边框，看起来又厚又重），只用投影把它从页面里托起来
 *
 * 交互：
 *   - 点按钮         -> 在按钮上方弹出面板（每次打开都重新加载，状态永远最新）
 *   - 再点按钮       -> 收起
 *   - 点页面别处     -> 收起
 *   - Esc            -> 收起
 *   - 面板右上角 ×   -> 收起（由 popup.js 发消息请外层收起）
 *   - 切换标签页     -> 随窗口失焦收起
 *   - 视频全屏时     -> 自动隐藏按钮，退出全屏恢复
 *
 * 调试：页面 Console 里 __bilispeedFloat.open() / .close() / .toggle() 可手动控制。
 */

(() => {
  'use strict';

  // 防止脚本被重复注入时出现两个按钮
  if (window.__BILISPEED_FLOATING_LOADED__) return;
  window.__BILISPEED_FLOATING_LOADED__ = true;

  /* ---------------------------- 常量 ---------------------------- */

  /** 宿主元素的 id（挂在 <body> 末尾） */
  const ROOT_ID = 'bilispeed-floating-root';

  /** 面板里要加载的界面：工具栏弹窗用的那份 popup.html */
  const POPUP_PAGE = 'popup.html';

  /** 按钮与视口右下角的距离，以及面板底部要让出的高度（要略大于按钮高度） */
  const EDGE = 12;
  const BUTTON_LIFT = 50;

  /** iframe 加载超时（毫秒）：超过则认为扩展需要重新加载 */
  const FRAME_TIMEOUT_MS = 6000;

  /** 打开时那句轻提示停留时间 */
  const HINT_MS = 2200;

  /* ---------------------------- 状态 ---------------------------- */

  const host = document.createElement('div');
  host.id = ROOT_ID;
  /**
   * 宿主元素本身必须完全不参与页面布局：
   *   - all:initial 抹掉站点可能命中的通用样式，后面的声明再逐条覆盖回来
   *   - display:block 只是给 Shadow DOM 里的子元素一个正常的包含块坐标，
   *     尺寸仍然是 0（子元素全是 fixed 定位），所以不会挡住页面任何内容
   */
  host.style.cssText = 'all:initial;display:block;position:fixed;inset:auto;width:0;height:0;z-index:2147483000;';

  const shadow = host.attachShadow({ mode: 'open' });

  let button = null;
  let panel = null;
  let hint = null;
  let frame = null;
  let frameTimer = null;
  let hintTimer = null;
  let open = false;
  /** 刚通过按钮打开时，忽略窗口聚焦/失焦带来的误收起 */
  let suppressBlur = 0;

  /* ---------------------------- 小工具 ---------------------------- */

  /** 可以随时移除的事件绑定（避免日后重复注入累积监听） */
  function on(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    return () => target.removeEventListener(type, handler, options);
  }

  function preventBubble(event) {
    event.stopPropagation();
  }

  /** 当前是否处于全屏（含视频全屏） */
  function isFullscreen() {
    return Boolean(document.fullscreenElement || document.webkitFullscreenElement);
  }

  /** 系统是否偏好深色 */
  function prefersDark() {
    try {
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    } catch (err) {
      return false;
    }
  }

  /* ---------------------------- 样式（全部在 Shadow DOM 内） ---------------------------- */

  const CSS = `
    /* 样式只作用在 Shadow DOM 内，绝不外泄到页面 */
    :host { box-sizing: border-box; }
    :host > * { box-sizing: border-box; }

    /* ---------------- 悬浮按钮：就一个小圆 ----------------
       刻意不写扩展名 —— 名字放在展开的面板里（面板顶部就是 BiliSpeed 品牌行），
       这样按钮能做到最小，页面上也不会重复出现两处品牌字。 */
    .launcher {
      position: fixed;
      z-index: 4;
      right: ${EDGE}px;
      bottom: ${EDGE}px;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      padding: 0;
      margin: 0;
      color: #fff;
      background: linear-gradient(135deg, #00aeec 0%, #0086c9 100%);
      border: 1px solid rgba(255, 255, 255, 0.22);
      border-radius: 50%;
      box-shadow: 0 3px 10px -3px rgba(0, 134, 201, 0.7), 0 1px 3px rgba(16, 24, 40, 0.16);
      cursor: pointer;
      user-select: none;
      -webkit-user-select: none;
      transition: transform 0.14s ease, box-shadow 0.14s ease, background 0.14s ease;
    }

    .launcher:hover {
      background: linear-gradient(135deg, #17b8f0 0%, #0093d8 100%);
      box-shadow: 0 5px 14px -3px rgba(0, 134, 201, 0.8), 0 1px 4px rgba(16, 24, 40, 0.18);
      transform: translateY(-1px);
    }

    .launcher:active { transform: scale(0.94); }

    .launcher:focus-visible {
      outline: 2px solid #fff;
      outline-offset: 2px;
    }

    /* 打开时按钮保持“按下”状态，一眼能看出面板是它打开的 */
    .launcher[aria-expanded="true"] {
      background: linear-gradient(135deg, #0093d8 0%, #0074ad 100%);
    }

    .launcher .icon {
      width: 17px;
      height: 17px;
      display: block;
    }

    /* ---------------- 打开时那句轻提示 ---------------- */
    .hint {
      position: fixed;
      z-index: 2;
      right: ${EDGE + 8}px;
      bottom: ${BUTTON_LIFT + 2}px;
      max-width: 240px;
      padding: 6px 10px;
      font: 400 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
      color: #fff;
      background: rgba(15, 20, 25, 0.86);
      border-radius: 9px;
      box-shadow: 0 4px 14px -6px rgba(0, 0, 0, 0.5);
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.18s ease;
    }

    .hint.is-shown { opacity: 1; }

    /* ---------------- 面板：不再套一层壳 ----------------
       展开出来的就是 popup 自己那一层（圆角、描边、底色都在 popup.css 的
       body 上），所以这里不设 background、不设 border，
       只留一圈很轻的投影把面板从页面里托起来。 */
    .panel {
      position: fixed;
      z-index: 3;
      right: ${EDGE}px;
      bottom: ${BUTTON_LIFT}px;
      width: 296px;
      /* 默认高度只是“量出来之前”的兜底，真实高度由 fitPanelToContent() 设置 */
      height: 330px;
      max-height: calc(100vh - ${BUTTON_LIFT + EDGE}px);
      /* 比 popup.css 的 --radius-lg(20px) 略大一点点，
         这样圆角外侧不会露出投影的直角边缘 */
      border-radius: 21px;
      /* 裁掉 iframe 的方角，圆角才真正生效 */
      overflow: hidden;
      box-shadow:
        0 1px 2px rgba(16, 24, 40, 0.045),
        0 8px 18px -10px rgba(16, 24, 40, 0.16),
        0 20px 40px -26px rgba(16, 24, 40, 0.22);
      opacity: 0;
      transform: translateY(8px) scale(0.98);
      transform-origin: 100% 100%;
      pointer-events: none;
      visibility: hidden;
      transition: opacity 0.16s ease, transform 0.16s ease, visibility 0.16s;
    }

    .panel.is-open {
      opacity: 1;
      transform: none;
      pointer-events: auto;
      visibility: visible;
    }

    /* 面板本体外缩 1px：它的圆角与投影圆角严丝合缝，四边不会露出投影的硬边。
       iframe 高度由 JS 按内容量出来写死（见 fitPanelToContent）：
       这里不能写 height:100%，否则会和面板高度互相喂饭，一路涨到视口那么大。 */
    .panel iframe {
      display: block;
      width: calc(100% - 2px);
      height: 300px; /* JS 量出来后会被覆盖；这只是量出来之前的临时值 */
      margin: 1px;
      border: 0;
      background: #fbfcfd;
      color-scheme: light;
      border-radius: 20px;
    }

    /* iframe 还没就绪时的兜底卡片：形状与 popup 本体保持一致，
       这样“加载中 -> 加载完成”之间不会出现轮廓跳变 */
    .fallback {
      position: absolute;
      inset: 1px;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0 20px;
      font: 400 12px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
      color: #5b6672;
      text-align: center;
      background: #fbfcfd;
      border: 1px solid #e9edf2;
      border-radius: 20px;
      pointer-events: none;
    }

    .panel[data-state="ready"] .fallback { display: none; }

    /* ---------------- 窄屏：面板不超过可用宽度 ---------------- */
    @media (max-width: 560px) {
      .panel { width: min(296px, calc(100vw - ${EDGE * 2}px)); }
    }

    /* ---------------- 深色偏好 ----------------
       注意：面板里是 popup 自带的固定浅色界面，这里绝不改它的底色，
       否则会出现“深色外壳 + 浅色内容”的割裂观感；只把投影加重一点分出色块。 */
    :host(.dark) .launcher {
      border-color: rgba(255, 255, 255, 0.18);
    }

    :host(.dark) .panel {
      box-shadow:
        0 0 0 1px rgba(255, 255, 255, 0.06),
        0 8px 20px -10px rgba(0, 0, 0, 0.45),
        0 22px 44px -24px rgba(0, 0, 0, 0.55);
    }

    :host(.dark) .fallback {
      border-color: #2b3038;
    }

    /* ---------------- 尊重“减少动态效果” ---------------- */
    @media (prefers-reduced-motion: reduce) {
      .launcher, .panel, .hint { transition: none !important; }
    }
  `;

  /* ---------------------------- 结构 ---------------------------- */

  const TEMPLATE = `
    <style>${CSS}</style>
    <button class="launcher" type="button" aria-haspopup="dialog" aria-expanded="false"
            aria-controls="bilispeed-floating-panel" title="BiliSpeed 倍速控制">
      <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12.5" r="8.4" fill="none" stroke="currentColor" stroke-width="2.2"
                stroke-linecap="round" stroke-dasharray="33 20" transform="rotate(140 12 12.5)"></circle>
        <path d="M12 12.5 L16.6 8.4" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"></path>
        <circle cx="12" cy="12.5" r="1.7" fill="currentColor"></circle>
      </svg>
    </button>
    <div class="panel" id="bilispeed-floating-panel" role="dialog" aria-label="BiliSpeed 倍速控制"
         data-state="idle">
      <div class="fallback">加载中…</div>
    </div>
    <div class="hint" role="status" aria-live="polite">记住的速度已生效，切视频也不变</div>
  `;

  /**
   * 把按钮挂到页面上。document_start 时 <body> 还没出现，
   * 所以这里等 DOM 就绪再插，避免被页面后续的清空操作抹掉。
   */
  function mount() {
    shadow.innerHTML = TEMPLATE;

    button = shadow.querySelector('.launcher');
    panel = shadow.querySelector('.panel');
    hint = shadow.querySelector('.hint');

    button.addEventListener('click', (event) => {
      event.stopPropagation();
      toggle();
    });

    // 面板内部的点击不要冒泡到页面，避免触发站点自己的收起逻辑
    panel.addEventListener('click', preventBubble);
    panel.addEventListener('pointerdown', preventBubble);

    // 深色偏好只作用在 Shadow DOM 内的按钮与面板上，不改页面任何类名
    host.classList.toggle('dark', prefersDark());

    const target = document.body || document.documentElement;
    target.appendChild(host);

    const media = tryMatchMedia();
    if (media) {
      const sync = () => host.classList.toggle('dark', prefersDark());
      if (typeof media.addEventListener === 'function') media.addEventListener('change', sync);
    }

    on(document, 'click', (event) => {
      if (!open) return;
      if (event.target === host || event.target === button || event.target === panel) return;
      if (typeof event.composedPath === 'function' && event.composedPath().includes(host)) return;
      close();
    }, true);

    on(document, 'keydown', (event) => {
      if (!open || event.key !== 'Escape') return;
      close();
      if (button) button.focus({ preventScroll: true });
    }, true);

    on(document, 'fullscreenchange', syncFullscreen);
    on(document, 'webkitfullscreenchange', syncFullscreen);

    // 面板里点了「×」：它自己收不起来，发消息请我们收起。
    // 同一条通道也用来接收面板上报的内容高度（跨源只能靠 postMessage）。
    on(window, 'message', (event) => {
      const data = event && event.data;
      if (!data || typeof data !== 'object') return;
      if (frame && event.source !== frame.contentWindow) return; // 只认自己这个面板
      if (data.type === 'bilispeed:panelHeight') {
        applyPanelHeight(Number(data.height));
        return;
      }
      if (data.type === 'bilispeed:panelClose') {
        if (!open) return;
        close();
        if (button) button.focus({ preventScroll: true });
      }
    });

    // 焦点移出整个窗口时收起（切标签页 / 点浏览器界面），保持和原生弹窗一致的手感
    on(window, 'blur', () => {
      if (!open || Date.now() < suppressBlur) return;
      if (typeof document.hasFocus === 'function' && document.hasFocus()) return;
      close();
    });

    syncFullscreen();
  }

  function tryMatchMedia() {
    try {
      return window.matchMedia('(prefers-color-scheme: dark)');
    } catch (err) {
      return null;
    }
  }

  /** 全屏看视频时藏起来，别挡画面 */
  function syncFullscreen() {
    if (!host) return;
    host.style.visibility = isFullscreen() ? 'hidden' : '';
  }

  /* ---------------------------- 开 / 关 ---------------------------- */

  /** 取出界面地址；取不到说明扩展本身需要重新加载 */
  function popupUrl() {
    try {
      const url = chrome.runtime.getURL(POPUP_PAGE);
      return typeof url === 'string' && url ? url : null;
    } catch (err) {
      return null;
    }
  }

  /**
   * 每次打开都重新加载 iframe：
   * popup.js 会在文档加载时读取一次当前速度，重载一次就等价于“重新点开一次弹窗”，
   * 所以这里不需要（也不应该）自己去同步任何状态。
   * @param {string} url 界面地址
   */
  function loadFrame(url) {
    frame = document.createElement('iframe');
    frame.setAttribute('title', 'BiliSpeed 倍速控制');
    // 注意：不要在这里读 iframe 的内容（跨源会抛 SecurityError），
    // 高度由面板自己 postMessage 报上来，见 applyPanelHeight()

    let settled = false;
    const settle = (state, message) => {
      if (settled) return;
      settled = true;
      if (frameTimer !== null) {
        clearTimeout(frameTimer);
        frameTimer = null;
      }
      panel.dataset.state = state;
      if (message) showFallback(message);
    };

    frame.addEventListener('load', () => {
      settle('ready', '');
      // 告诉面板“你被内嵌了”：它据此显示右上角的「×」、
      // 回连本页负责收起，并把自身内容高度报上来（跨源只能这样传）
      tellPanelWeAreEmbedded();
    });
    frame.addEventListener('error', () => settle('failed', '面板加载失败，刷新页面后重试'));
    frameTimer = setTimeout(() => settle('failed', '面板加载失败了，重新加载扩展后重试'), FRAME_TIMEOUT_MS);

    frame.src = url;
    panel.appendChild(frame);
  }

  /**
   * 面板加载完成后握个手：popup.js 收到 hello 才会显示「×」，
   * 并在被点击时回一条 panelClose 请我们把面板收起来
   * （扩展页面没法自己收起它所在的 iframe，所以这步必须由外面做）。
   */
  function tellPanelWeAreEmbedded() {
    if (!frame) return;
    try {
      frame.contentWindow.postMessage({ type: 'bilispeed:panelHello' }, '*');
    } catch (err) {
      /* 发不出去也没关系：点页面别处、Esc 一样能收起 */
    }
  }

  function showFallback(message) {
    const el = panel.querySelector('.fallback');
    if (el) el.textContent = message;
  }

  /**
   * 面板高度：由**面板自己**量好后用 postMessage 报上来，这里只管接收。
   *
   * 为什么不能在这里自己去量 iframe 里的内容？（踩过大坑，务必别改回去）
   *   content script 跑在页面的源里（https://www.bilibili.com），
   *   而 iframe 里是 chrome-extension:// 的页面 —— 两者**跨源**。
   *   所以 el.contentDocument 会直接抛 SecurityError，会被 catch 吞掉，
   *   高度永远设不上，面板就一直留着一大块空白（之前那个 bug）。
   *   跨源读不了，但 postMessage 可以，所以改由面板主动上报。
   *
   * @param {number} height 面板内容的真实高度（px）
   */
  function applyPanelHeight(height) {
    if (!Number.isFinite(height) || height < 40) return; // 太小说明还没排版好
    const h = Math.ceil(height);
    if (frame) frame.style.height = `${h}px`;
    panel.style.height = `${h + 2}px`; // 上下各留 1px 边距
  }

  /** 打开时轻轻提一句（只露一次，不干扰操作） */
  function showHint() {
    if (!hint) return;
    if (hintTimer !== null) clearTimeout(hintTimer);
    hint.classList.add('is-shown');
    hintTimer = setTimeout(() => {
      hint.classList.remove('is-shown');
      hintTimer = null;
    }, HINT_MS);
  }

  function hideHint() {
    if (hintTimer !== null) {
      clearTimeout(hintTimer);
      hintTimer = null;
    }
    if (hint) hint.classList.remove('is-shown');
  }

  function openPanel() {
    if (open || !panel) return;
    const url = popupUrl();
    open = true;
    suppressBlur = Date.now() + 500;
    button.setAttribute('aria-expanded', 'true');
    panel.dataset.state = 'loading';
    showFallback('加载中…');
    panel.classList.add('is-open');
    if (url) loadFrame(url);
    else showFallback('扩展刚刚更新过，重新加载一下扩展即可使用');
    showHint();
  }

  function close() {
    if (!open || !panel) return;
    open = false;
    button.setAttribute('aria-expanded', 'false');
    panel.classList.remove('is-open');
    hideHint();
    if (frameTimer !== null) {
      clearTimeout(frameTimer);
      frameTimer = null;
    }
    // 丢弃这一次的 iframe：下次打开重新加载，保证读到的速度是最新的
    if (frame) {
      frame.remove();
      frame = null;
    }
    // 高度还原成默认值，下次按新内容重新量
    panel.style.height = '';
    panel.dataset.state = 'idle';
  }

  function toggle() {
    if (open) close();
    else openPanel();
  }

  /* ---------------------------- 启动 ---------------------------- */

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }

  /** 调试 / 自测入口（页面 Console 可用，不污染 DOM 结构） */
  window.__bilispeedFloat = {
    open: openPanel,
    close,
    toggle,
    isOpen: () => open,
    /** 宿主元素与 Shadow Root，便于排查样式问题 */
    root: () => host,
    shadow: () => shadow,
    button: () => button,
    iframe: () => frame,
  };
})();
