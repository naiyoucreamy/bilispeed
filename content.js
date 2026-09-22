/**
 * BiliSpeed - B 站自定义倍速（Content Script）
 * ---------------------------------------------------------------
 * 设计要点：
 *  1. 只操作 <video>.playbackRate，绝不修改 B 站 DOM，不注入按钮/菜单，
 *     因此不会和 Bewlycat 之类的扩展抢 DOM。
 *  2. 目标速度存在 chrome.storage.sync（key: bilispeed.rate）。
 *  3. 通过四种机制让速度“粘住”：
 *       - video 元素出现/被替换时立刻应用（MutationObserver + 定时兜底）
 *       - ratechange 事件：B 站自己把 playbackRate 改回去时，我们改回来
 *       - loadedmetadata / loadeddata / play / seeking：切 P、切清晰度、换视频后补刀
 *       - history.pushState/replaceState 与 popstate/hashchange：SPA 路由跳转后校验
 *  4. popup 通过 chrome.runtime.sendMessage / chrome.storage.onChanged 立即同步。
 */

(() => {
  'use strict';

  // 防止脚本被重复注入时出现两份监控循环
  if (window.__BILISPEED_LOADED__) return;
  window.__BILISPEED_LOADED__ = true;

  /** storage 中保存倍速的键名 */
  const STORAGE_KEY = 'bilispeed.rate';

  /** 允许的倍速范围与步进 */
  const MIN_RATE = 0.25;
  const MAX_RATE = 16;
  const STEP = 0.25;

  /** 默认速度（也是“重置”后的速度） */
  const DEFAULT_RATE = 1;

  /** 兜底轮询间隔：B 站偶尔会有不触发事件的静默重置，低频扫描最稳 */
  const POLL_INTERVAL_MS = 500;

  /** 目标速度（用户设置值） */
  let targetRate = DEFAULT_RATE;

  /** 当前正在监控的 video 元素 */
  let currentVideo = null;

  /** 给当前 video 绑定的监听器引用，方便换元素时解绑（避免泄漏） */
  let boundListeners = null;

  /** 定时器句柄 */
  let pollTimer = null;

  /* ------------------------------------------------------------------ */
  /* 工具函数                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * 把任意输入规整成合法倍速：数值化 + 限制范围 + 对齐 0.25 步进。
   * @param {unknown} value
   * @returns {number}
   */
  function normalizeRate(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return DEFAULT_RATE;
    const clamped = Math.min(MAX_RATE, Math.max(MIN_RATE, num));
    // 对齐到 step，顺便消除浮点误差（例如 2.4999999 -> 2.5）
    const stepped = Math.round(clamped / STEP) * STEP;
    return Math.round(stepped * 100) / 100;
  }

  /**
   * 找到页面上“真正在播放”的 video 元素。
   * B 站有时候 DOM 里存在多个 <video>（例如小窗、旧节点未移除），
   * 优先选没有暂停的、其次选时长最长的、最后退回第一个。
   * @returns {HTMLVideoElement|null}
   */
  function findVideo() {
    const videos = Array.from(document.querySelectorAll('video'));
    if (videos.length === 0) return null; // 视频还没加载出来，属正常情况

    let best = null;
    let bestScore = -1;
    for (const video of videos) {
      // 忽略 source 都没挂上的空元素
      if (!video.currentSrc && video.readyState === 0) continue;
      let score = 0;
      if (!video.paused) score += 100;                 // 正在播放的最优
      if (video.duration && Number.isFinite(video.duration)) {
        score += Math.min(video.duration, 100);        // 时长更长更像是主播放器
      }
      if (score > bestScore) {
        bestScore = score;
        best = video;
      }
    }
    return best || videos[0];
  }

  /**
   * 把目标速度写入指定 video。只有当实际值不一致时才赋值，避免无谓的属性写入。
   * @param {HTMLVideoElement} video
   * @returns {boolean} 是否真的做了修改
   */
  function applyRateTo(video) {
    if (!video) return false;
    // 个别浏览器限制到 16，这里是我们的上限；比较用容差防止浮点抖动
    if (Math.abs(video.playbackRate - targetRate) < 0.001) return false;
    try {
      video.playbackRate = targetRate;
      return true;
    } catch (err) {
      // 极少数情况下（媒体未就绪）会抛错，忽略即可，后续事件/轮询会重试
      return false;
    }
  }

  /** 对所有已知 video 应用目标速度（当前元素 + 页面上的其它 video） */
  function applyRateEverywhere() {
    applyRateTo(currentVideo);
    for (const video of document.querySelectorAll('video')) {
      if (video !== currentVideo) applyRateTo(video);
    }
  }

  /* ------------------------------------------------------------------ */
  /* video 元素接管                                                      */
  /* ------------------------------------------------------------------ */

  /** 解绑当前 video 上的所有监听器 */
  function releaseVideo() {
    if (currentVideo && boundListeners) {
      for (const [type, handler] of boundListeners) {
        currentVideo.removeEventListener(type, handler);
      }
    }
    currentVideo = null;
    boundListeners = null;
  }

  /**
   * 接管一个 video 元素：绑定事件并立刻应用倍速。
   * @param {HTMLVideoElement} video
   */
  function adoptVideo(video) {
    if (!video || video === currentVideo) {
      // 元素没变也要补一次，防止中途被重置
      if (video) applyRateTo(video);
      return;
    }

    releaseVideo();
    currentVideo = video;

    // 这些事件覆盖了：首次加载、切 P、切清晰度、切视频、拖动进度、从暂停恢复
    const onEvent = () => {
      applyRateTo(video);
    };

    const onRateChange = () => {
      // 关键点：别人（B 站播放器 / 其它扩展）改了速率，我们立刻改回目标值。
      // 注意 applyRateTo 内部有“相等就不赋值”的判断，因此不会死循环。
      if (Math.abs(video.playbackRate - targetRate) >= 0.001) {
        applyRateTo(video);
      }
    };

    boundListeners = [
      ['ratechange', onRateChange],   // 被外部重置 -> 改回来
      ['loadstart', onEvent],         // 新视频源开始加载
      ['loadedmetadata', onEvent],    // 拿到时长/元数据
      ['loadeddata', onEvent],
      ['canplay', onEvent],
      ['play', onEvent],              // 用户点播放
      ['playing', onEvent],
      ['seeking', onEvent],           // 拖动进度条后某些播放器会重置
      ['seeked', onEvent],
      ['emptied', onEvent],           // 切换分 P 时常见
    ];

    for (const [type, handler] of boundListeners) {
      // useCapture=true，保证在 B 站自己的监听器之前拿到事件（更早纠正）
      video.addEventListener(type, handler, true);
    }

    // 顺手记录：B 站播放器 UI 上显示的速率可能和实际不一致，
    // 我们不动 DOM，所以这里不做任何 UI 同步。
    applyRateTo(video);
  }

  /** 每次“世界可能变了”之后调用：重新找 video 并接管 */
  function syncVideo() {
    const video = findVideo();
    if (video) {
      adoptVideo(video);          // 内部会处理“还是同一个元素”的情况
      applyRateTo(video);
    } else {
      // 视频元素还不存在（页面刚打开 / SPA 正在渲染），属正常，等下一轮
      releaseVideo();
    }
    // 页面上可能有多个 video（B 站某些页面会有预览播放器），一并处理
    for (const other of document.querySelectorAll('video')) {
      if (other !== currentVideo) applyRateTo(other);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 监控机制                                                            */
  /* ------------------------------------------------------------------ */

  /** MutationObserver：video 被添加/移除/替换时立即响应 */
  function startDomObserver() {
    const observer = new MutationObserver(() => {
      // 用 microtask 之外的同步调用即可；查找成本很低
      const video = findVideo();
      if (!video) {
        if (currentVideo) releaseVideo();
        return;
      }
      if (video !== currentVideo) adoptVideo(video);
      else applyRateTo(video);
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      // 不监听 attributes：B 站改 class/属性非常频繁，监听属性会浪费性能
    });
  }

  /** 低频轮询兜底：应对“元素没变但速率被静默重置”的情况 */
  function startPolling() {
    if (pollTimer !== null) return;
    pollTimer = setInterval(syncVideo, POLL_INTERVAL_MS);
  }

  /** 监听 SPA 路由变化。B 站的跳转走 history.pushState，不会触发原生事件，需要打补丁 */
  function startSpaWatcher() {
    const onRouteChange = () => {
      // 路由刚变时新 video 往往还没挂上，这里多补几次（同时轮询也会兜底）
      [0, 150, 500, 1200].forEach((delay) => setTimeout(syncVideo, delay));
    };

    for (const method of ['pushState', 'replaceState']) {
      const original = history[method];
      history[method] = function patched(...args) {
        const result = original.apply(this, args);
        onRouteChange();
        return result;
      };
    }

    window.addEventListener('popstate', onRouteChange);
    window.addEventListener('hashchange', onRouteChange);
    // 页面从后台切回前台（bfcache / 切标签）时也校验一次
    window.addEventListener('pageshow', onRouteChange);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) syncVideo();
    });
  }

  /* ------------------------------------------------------------------ */
  /* 存储同步                                                            */
  /* ------------------------------------------------------------------ */

  /** 从 chrome.storage.sync 读取目标速度 */
  async function loadRate() {
    try {
      const data = await chrome.storage.sync.get(STORAGE_KEY);
      targetRate = normalizeRate(data && data[STORAGE_KEY] !== undefined ? data[STORAGE_KEY] : DEFAULT_RATE);
    } catch (err) {
      // storage 不可用（极少见）时退回默认值，保证功能不崩
      targetRate = DEFAULT_RATE;
    }
    applyRateEverywhere();
  }

  /** 写入目标速度并立即应用 */
  async function saveRate(rate) {
    targetRate = normalizeRate(rate);
    applyRateEverywhere();
    try {
      await chrome.storage.sync.set({ [STORAGE_KEY]: targetRate });
    } catch (err) {
      /* 写失败也不影响当前页面使用 */
    }
    return targetRate;
  }

  /** 其它标签页/弹出页改了设置时同步过来 */
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' && area !== 'local') return;
    if (!changes[STORAGE_KEY]) return;
    targetRate = normalizeRate(changes[STORAGE_KEY].newValue);
    applyRateEverywhere();
  });

  /* ------------------------------------------------------------------ */
  /* 与 popup 通信                                                       */
  /* ------------------------------------------------------------------ */

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') return undefined;

    switch (message.type) {
      case 'bilispeed:get':
        // 返回“页面上实际生效”的速率，方便 popup 显示真实状态
        sendResponse({
          ok: true,
          target: targetRate,
          actual: currentVideo ? currentVideo.playbackRate : null,
          hasVideo: Boolean(document.querySelector('video')),
        });
        return true; // 同步响应，但返回 true 也无害

      case 'bilispeed:set':
        saveRate(message.rate).then((rate) => {
          sendResponse({ ok: true, rate });
        });
        return true; // 异步响应，必须 return true 保持通道打开

      case 'bilispeed:reset':
        saveRate(DEFAULT_RATE).then((rate) => {
          sendResponse({ ok: true, rate });
        });
        return true;

      default:
        return undefined;
    }
  });

  /** 页面内调试/被 scripting.executeScript 调用时的兜底 API（不污染 DOM） */
  window.__bilispeed = {
    get: () => ({ target: targetRate, actual: currentVideo ? currentVideo.playbackRate : null }),
    set: (rate) => saveRate(rate),
    reset: () => saveRate(DEFAULT_RATE),
    /** 手动触发一次扫描，调试用 */
    rescan: () => syncVideo(),
  };

  /* ------------------------------------------------------------------ */
  /* 启动                                                                */
  /* ------------------------------------------------------------------ */

  async function boot() {
    await loadRate();     // 先拿到用户设置，避免先按 1x 播放再跳变
    startDomObserver();
    startPolling();
    startSpaWatcher();
    syncVideo();
  }

  boot();

  // 页面卸载时清理定时器（虽然浏览器会自动清理，写出来更明确）
  window.addEventListener('pagehide', () => {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  });
})();
