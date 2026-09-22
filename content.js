/**
 * BiliSpeed - B 站自定义倍速（Content Script）· 按标签页临时记速版
 * ---------------------------------------------------------------
 * 核心语义：
 *   - 速度只属于“当前标签页”，标签页内所有视频共用同一个速度；
 *   - **进入视频时一律从 1x 开始**：
 *       · 离开视频页（回首页/搜索/动态…）后再进来   -> 清零
 *       · SPA 里换到另一个视频（含推荐位跳转）      -> 清零
 *       · 直接打开/新开标签页                        -> 1x
 *     **不清零的情况**（同一个观看会话）：
 *       · 同一视频切换分P（BV 号不变，只是 ?p= 变了）
 *       · 在视频页按 F5 刷新（navigation type = reload）
 *       · 浏览器后退/前进回到视频页（navigation type = back_forward）
 *   - **标签页关闭后速度自动消失**（存在 chrome.storage.session 的
 *     bilispeed.rate.<tabKey> 下，tabKey 是本标签页专属的随机 ID，
 *     session 区域随标签页/浏览器会话销毁）。
 *
 * 为什么存储键不用 tabId？
 *   tabId 只能靠扩展消息链路（sender.tab.id / whoami）拿到，链路异常就可能
 *   退化；而且它对用户完全不可见。改用“页面 sessionStorage 里的随机 ID”后：
 *     · 同一标签页刷新后复用同一个键  -> 刷新能恢复速度
 *     · 不同标签页必然不同键          -> 绝不可能共享速度（本题的根因防护）
 *     · 标签页关闭 -> sessionStorage 与 session 区域一起销毁 -> 自动清除
 *
 * 实现要点：
 *  1. 只操作 <video>.playbackRate，绝不修改 B 站 DOM，不注入按钮/菜单，
 *     因此不会和 Bewlycat 之类的扩展抢 DOM。
 *  2. tabId 通过 {type:'bilispeed:whoami'} 消息从 background/popup 侧的
 *     sender.tab.id 拿到（content script 拿不到自己的 tab id，这是标准做法）。
 *     拿不到时退化为“纯内存”，功能照常，只是刷新页面后会回到 1x。
 *  3. 让速度“粘住”的五层防护：
 *       - ratechange（捕获阶段）：B 站把 playbackRate 改回去时立刻改回来
 *       - 媒体生命周期事件：切 P、切清晰度、拖动进度、换源后补刀
 *       - MutationObserver：video 节点出现 / 被替换时重新接管
 *       - 500ms 低频轮询：应对不触发任何事件的静默重置
 *       - history.pushState 补丁 + popstate/hashchange：SPA 路由变化后重新校验
 *  4. 不再按视频记速，因此没有任何“每视频”的存储读写和配额压力：
 *     整个扩展只写一个键、每次改速写一次。
 */

(() => {
  'use strict';

  // 防止脚本被重复注入时出现两份监控循环
  if (window.__BILISPEED_LOADED__) return;
  window.__BILISPEED_LOADED__ = true;

  /* ---------------------------- 常量 ---------------------------- */

  /** session 存储键前缀：bilispeed.rate.<tabKey> */
  const SESSION_PREFIX = 'bilispeed.rate.';

  /** 在页面 sessionStorage 里保存 tabKey 的键名（用于刷新后复用同一个键） */
  const TAB_KEY_SLOT = 'bilispeed.tabkey';

  /** 历史版本遗留的键（按视频记速 / 全局记速），首次运行清理掉 */
  const LEGACY_KEYS = ['bilispeed.rates', 'bilispeed.rate', 'bilispeed.migrated'];

  const MIN_RATE = 0.25;
  const MAX_RATE = 16;
  const STEP = 0.25;
  /** 新标签页的默认速度 */
  const DEFAULT_RATE = 1;

  /** 兜底轮询间隔 */
  const POLL_INTERVAL_MS = 500;

  /* ---------------------------- 状态 ---------------------------- */

  /** 本标签页的目标速度（唯一的一份状态，存在内存里 = 本标签页的真相） */
  let targetRate = DEFAULT_RATE;

  /**
   * 本标签页的随机 ID（session 存储键的一部分）。
   * 存在页面 sessionStorage 里，所以同一个标签页刷新后复用、关闭后销毁。
   */
  let tabKey = resolveTabKey();

  /** 本标签页的 tabId，仅供诊断显示；null 表示消息链路没拿到 */
  let tabId = null;

  /** 目标速度是否已经从存储恢复过（避免恢复前先用 1x 覆盖了别的值） */
  let rateLoaded = false;

  /** popup 是否已经接管过本页（popup 打开时会主动带上权威值） */
  let everSynced = false;

  /** 当前监控的 video 元素 */
  let currentVideo = null;
  /** 当前 video 上绑定的监听器（换元素时解绑，避免泄漏） */
  let boundListeners = null;

  /**
   * 当前所在视频的身份（不含分 P），用来判断“是否换了个视频”。
   * 初始值：如果是"同一个观看会话"（刷新/后退前进），说明本次加载之前
   * 用户就已经在这个视频里了，先把身份设为当前视频，避免启动时误判成
   * "进入新视频"而把刚恢复的速度又清成 1x。
   */
  let videoIdentity = shouldRestoreRate() ? videoIdentityNow() : null;
  /** 是否已经进过一次视频；用来区分“首次进入视频”和“页内跳转” */
  let enteredVideo = videoIdentity !== null;

  /**
   * 速度变更历史（诊断用）：谁在什么时候、把速度改成了多少。
   * 用来判断“是用户自己设的”还是“从别处继承过来的”。
   */
  let rateHistory = [];

  let pollTimer = null;
  /** 写 session 的防抖计时器 */
  let writeTimer = null;

  /* ---------------------------- 视频身份与“进入即清零” ---------------------------- */

  /**
   * 记录一次速度变更（诊断用）。保留最近 8 条。
   * @param {number} rate
   * @param {string} reason
   */
  function noteRateChange(rate, reason) {
    rateHistory.push({ rate, reason, at: new Date().toISOString().slice(11, 23) });
    if (rateHistory.length > 8) rateHistory = rateHistory.slice(-8);
  }
  /**
   * 取当前页面的“视频身份”（种类 + ID），**刻意不带分 P 参数**：
   * 同一视频的 P1 -> P2 身份不变，因此不会被当成换视频。
   * @returns {string|null} 例如 'video:BV1AA411c7de'；非视频页返回 null
   */
  function videoIdentityNow() {
    const { pathname, hostname } = location;
    let match = pathname.match(/\/video\/(BV[0-9A-Za-z]+|av\d+)/i);
    if (match) return `video:${match[1]}`;
    match = pathname.match(/\/cheese\/play\/(ep\d+|ss\d+)/i);
    if (match) return `cheese:${match[1]}`;
    match = pathname.match(/\/bangumi\/play\/(ep\d+|ss\d+)/i);
    if (match) return `bangumi:${match[1]}`;
    match = pathname.match(/^\/(?:blanc\/)?(\d{1,12})\/?$/);
    if (match && /(^|\.)live\.bilibili\.com$/i.test(hostname)) return `live:${match[1]}`;
    return null;
  }

  /**
   * 本次页面加载是否属于“同一个观看会话”，从而应该恢复上次的速度。
   * 只有两种情况算：刷新（reload）、浏览器后退/前进（back_forward）。
   * 其它情况（直接打开、从首页点进来、从收藏夹打开…）都从 1x 开始。
   * @returns {boolean}
   */
  function shouldRestoreRate() {
    try {
      const entries = performance.getEntriesByType('navigation');
      const type = entries && entries.length > 0 ? entries[0].type : 'navigate';
      return type === 'reload' || type === 'back_forward';
    } catch (err) {
      return false; // 拿不到导航类型时按“重新进入”处理
    }
  }

  /** 把速度归零（内存 + session 一起，立即落盘），并刷新 popup 可能看到的实际值 */
  async function resetForNewVideo(identity) {
    const previous = targetRate;
    targetRate = DEFAULT_RATE;
    videoIdentity = identity;
    enteredVideo = true;
    applyRateEverywhere();
    noteRateChange(DEFAULT_RATE, `进入视频 ${identity}`);
    await flushSaveRate(); // 立即写 1x，避免防抖窗口内刷新导致旧值残留
    if (previous !== DEFAULT_RATE) {
      console.info(`[BiliSpeed] 进入新视频（${identity}），速度已从 ${previous}x 重置为 1x`);
    }
  }

  /**
   * 每次页面变化后检查“视频身份”，决定是否清零。
   * - 离开视频页（身份变 null）：只记录状态，不动速度，避免在首页看到播放器时乱套
   * - 再次进入视频 / 换成另一个视频：清零
   * @param {string|null} identity
   */
  function assessVideoEntry(identity) {
    if (identity === null) {
      videoIdentity = null;
      enteredVideo = false; // 离开了视频页，下次进来算“重新进入”
      return;
    }
    if (!enteredVideo || identity !== videoIdentity) {
      resetForNewVideo(identity); // 再次进入 / 换视频 -> 1x
      return;
    }
    videoIdentity = identity; // 同一视频（例如切分P）：保持速度
  }

  /* ---------------------------- 工具 ---------------------------- */

  /**
   * 生成本标签页专属的随机 ID。
   * **关键点**：不再用 tabId 做存储键。
   * tabId 只能通过扩展消息链路（sender.tab.id / whoami）拿到，链路一旦异常
   * 就可能退化。随机 ID 由页面自己生成，在任何情况下都不会和其它标签页重复，
   * 从根上杜绝“两个标签页共用一个速度”。
   * @returns {string}
   */
  function makeTabKey() {
    try {
      if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    } catch (err) { /* 忽略，走下面的兜底 */ }
    return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  }

  /**
   * 取得本标签页的存储键 ID。
   * 存在**页面自己的 sessionStorage** 里：它天然是“每个标签页一份”的
   * （同一个标签页刷新后还在，其它标签页永远读不到，标签页关闭即销毁），
   * 所以既能做到刷新后恢复速度，又绝不可能跨标签页共享。
   * @returns {string}
   */
  function resolveTabKey() {
    try {
      const existing = sessionStorage.getItem(TAB_KEY_SLOT);
      if (existing) return existing;
      const created = makeTabKey();
      sessionStorage.setItem(TAB_KEY_SLOT, created);
      return created;
    } catch (err) {
      // sessionStorage 被禁用（极少数隐私设置）时退回纯随机：刷新恢复会失效，
      // 但标签页隔离仍然成立
      return makeTabKey();
    }
  }

  /**
   * 规整倍速：数值化 + 范围钳制 + 对齐 0.25 + 消除浮点误差
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

  /** 本标签页在 session 里的键（基于随机 ID，天然隔离） */
  function sessionKey() {
    return tabKey === null ? null : `${SESSION_PREFIX}${tabKey}`;
  }

  /**
   * 把目标速度写入 video。值相同就不写，避免无谓属性写入和无意义的 ratechange。
   * @param {HTMLVideoElement} video
   * @returns {boolean} 是否真的做了修改
   */
  function applyRateTo(video) {
    if (!video) return false;
    if (Math.abs(video.playbackRate - targetRate) < 0.001) return false;
    try {
      video.playbackRate = targetRate;
      return true;
    } catch (err) {
      // 媒体未就绪时赋值偶发抛错，忽略，后续事件/轮询会重试
      return false;
    }
  }

  /** 对页面上所有 video 应用当前目标速度 */
  function applyRateEverywhere() {
    applyRateTo(currentVideo);
    for (const video of document.querySelectorAll('video')) {
      if (video !== currentVideo) applyRateTo(video);
    }
  }

  /* ---------------------------- video 接管 ---------------------------- */

  /** 找到页面上“真正在播放”的 video：优先未暂停的，其次时长最长的 */
  function findVideo() {
    const videos = Array.from(document.querySelectorAll('video'));
    if (videos.length === 0) return null; // 视频还没加载出来，属正常情况

    let best = null;
    let bestScore = -1;
    for (const video of videos) {
      if (!video.currentSrc && video.readyState === 0) continue;
      let score = 0;
      if (!video.paused) score += 100;
      if (video.duration && Number.isFinite(video.duration)) score += Math.min(video.duration, 100);
      if (score > bestScore) {
        bestScore = score;
        best = video;
      }
    }
    return best || videos[0];
  }

  /** 解绑当前 video 上的所有监听器 */
  function releaseVideo() {
    if (currentVideo && boundListeners) {
      for (const [type, handler] of boundListeners) {
        currentVideo.removeEventListener(type, handler, true);
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
    if (!video) return;
    if (video === currentVideo) {
      applyRateTo(video);
      return;
    }

    releaseVideo();
    currentVideo = video;

    const onEvent = () => {
      applyRateTo(video);
    };

    const onRateChange = () => {
      // 核心逻辑：被外部（B 站播放器 / 其它扩展）改了速率，立刻改回目标值。
      // applyRateTo 内部会判等，因此不会死循环。
      if (Math.abs(video.playbackRate - targetRate) >= 0.001) {
        applyRateTo(video);
      }
    };

    boundListeners = [
      ['ratechange', onRateChange],  // 被外部重置 -> 改回来
      ['loadstart', onEvent],        // 新视频源开始加载（切视频 / 切分P）
      ['loadedmetadata', onEvent],
      ['loadeddata', onEvent],
      ['canplay', onEvent],
      ['play', onEvent],
      ['playing', onEvent],
      ['seeking', onEvent],          // 拖进度条后某些播放器会重置
      ['seeked', onEvent],
      ['emptied', onEvent],          // 切换分 P 的典型信号
    ];

    for (const [type, handler] of boundListeners) {
      // useCapture = true：抢在 B 站自己的监听器之前拿到事件，更早纠正
      video.addEventListener(type, handler, true);
    }

    applyRateTo(video);
  }

  /**
   * 每次“世界可能变了”之后调用：先判断是否进了新视频（可能清零），
   * 再重找 video 并保证速度正确。
   */
  function syncVideo() {
    // 1) 视频身份变化 -> 可能要把速度清零（离开再进来 / 换视频）
    assessVideoEntry(videoIdentityNow());

    // 2) 找到 video 并接管，把当前目标速度钉上去
    const video = findVideo();
    if (video) {
      adoptVideo(video);
      applyRateTo(video);
    } else {
      // 视频元素还不存在（页面刚打开 / SPA 正在渲染），属正常，等下一轮
      releaseVideo();
    }

    // 页面上可能有多个 video（预览播放器等），一并处理
    for (const other of document.querySelectorAll('video')) {
      if (other !== currentVideo) applyRateTo(other);
    }
  }

  /* ---------------------------- 监控机制 ---------------------------- */

  /** MutationObserver：video 被添加/移除/替换时立即响应 */
  function startDomObserver() {
    const observer = new MutationObserver(() => {
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
      // 不监听 attributes：B 站改 class/属性极频繁，监听属性纯浪费 CPU
    });
  }

  /**
   * 兜底轮询。
   * 恢复速度之前用更短的间隔（速度还没落定的窗口通常只有几十毫秒），
   * 拿到速度后固定为 POLL_INTERVAL_MS，避免长期高频扫描浪费 CPU。
   */
  function startPolling() {
    if (pollTimer !== null) return;
    const interval = rateLoaded ? POLL_INTERVAL_MS : 80;
    pollTimer = setInterval(() => {
      syncVideo();
      if (rateLoaded && interval !== POLL_INTERVAL_MS) {
        clearInterval(pollTimer);
        pollTimer = null;
        startPolling(); // 用正常间隔重启
      }
    }, interval);
  }

  /** SPA 路由监听：B 站跳转走 history.pushState，不触发原生事件，必须打补丁 */
  function startSpaWatcher() {
    const onRouteChange = () => {
      // 路由刚变时新 video 往往还没挂上，多补几次；轮询也会兜底。
      // 速度本身不变（本标签页共用），只是要在新 video 上重新钉一遍。
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
    window.addEventListener('pageshow', onRouteChange);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) syncVideo();
    });
  }

  /* ---------------------------- 存储（session） ---------------------------- */

  /**
   * 取回本标签页的速度。
   * 只有“同一个观看会话”（刷新 / 后退前进）才恢复；其它情况保持 1x，
   * 实现“退出视频再打开就清零”。
   * session 区域在标签页关闭时自动销毁，所以读到的值天然是临时的。
   */
  async function loadRate() {
    const key = sessionKey();
    if (!key) return;
    try {
      // 顺手清理 session 里其它标签页遗留的键（只可能来自被强制杀掉的标签页）。
      // 本标签页的键是本次加载随机生成的，绝不可能和别人重名。
      try {
        const all = (await chrome.storage.session.get(null)) || {};
        const stale = Object.keys(all).filter((k) => k.startsWith(SESSION_PREFIX) && k !== key);
        if (stale.length > 0) await chrome.storage.session.remove(stale);
      } catch (err) { /* 清不掉也不影响功能 */ }

      if (!shouldRestoreRate()) {
        // 新的一次进入：把上次遗留的值写回 1x，确保 session 里不会有陈旧速度
        if (targetRate === DEFAULT_RATE) await writeSessionRate(DEFAULT_RATE);
        return;
      }
      const data = await chrome.storage.session.get(key);
      const stored = data ? data[key] : undefined;
      // everSynced 为真说明 popup 已经下发过权威值，别被旧值覆盖
      if (stored !== undefined && !everSynced) {
        targetRate = normalizeRate(stored);
        // 立刻补一次扫描：此刻 video 元素可能还没出现/还没被接管，
        // 光调 applyRateEverywhere() 会漏掉它
        syncVideo();
        applyRateEverywhere();
        if (targetRate !== DEFAULT_RATE) {
          console.info(`[BiliSpeed] 已恢复本标签页的速度：${targetRate}x`);
        }
      }
    } catch (err) {
      /* session 不可用时按默认 1x 跑，功能不崩 */
    } finally {
      rateLoaded = true;
    }
  }

  /** 写入本标签页的速度（每次改速只写这一个键） */
  async function saveRate() {
    await writeSessionRate(targetRate);
  }

  /** 底层写入：把指定值写进本标签页的 session 键 */
  async function writeSessionRate(rate) {
    const key = sessionKey();
    if (!key) return;
    try {
      await chrome.storage.session.set({ [key]: rate });
    } catch (err) {
      /* 写失败不影响当前页面使用 */
    }
  }

  /**
   * 立即写入（取消防抖）。用于“进入新视频清零”这类必须马上落盘的场景：
   * 若推到 600ms 之后，用户可能已经刷新/离开了，session 里会残留旧值，
   * 下次刷新就会把旧速度错误地恢复回来。
   */
  async function flushSaveRate() {
    if (writeTimer !== null) {
      clearTimeout(writeTimer);
      writeTimer = null;
    }
    await saveRate();
  }

  /** 清理历史版本留下的键（按视频记速 / 全局记速 / 按 tabId 记速） */
  async function purgeLegacyKeys() {
    try {
      // 1) 旧版 sync 区域：按视频记速、全局单速度
      const data = await chrome.storage.sync.get(LEGACY_KEYS);
      const present = LEGACY_KEYS.filter((key) => data && data[key] !== undefined);
      if (present.length > 0) {
        await chrome.storage.sync.remove(present);
        console.info('[BiliSpeed] 已清理旧版按视频记速的配置：', present.join(', '));
      }

      // 2) 上一版 session 区域用的是 tabId（纯数字后缀），现在改用随机 ID；
      //    这些遗留键不会再被任何标签页使用，直接删掉
      const all = (await chrome.storage.session.get(null)) || {};
      const numericKeys = Object.keys(all)
        .filter((key) => key.startsWith(SESSION_PREFIX) && /^\d+$/.test(key.slice(SESSION_PREFIX.length)));
      if (numericKeys.length > 0) {
        await chrome.storage.session.remove(numericKeys);
        console.info('[BiliSpeed] 已清理旧版按 tabId 记速的 session 键：', numericKeys.join(', '));
      }
    } catch (err) {
      /* 没有旧数据 / storage 不可用都无需处理 */
    }
  }

  /**
   * 询问自己的 tabId —— **仅用于诊断显示**。
   * 速度的读写完全不依赖它了（存储键用的是本页随机生成的 tabKey），
   * 所以这条消息链路就算失败，也只是诊断信息里少一个数字。
   */
  async function resolveTabId() {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'bilispeed:whoami' });
      if (res && typeof res.tabId === 'number') tabId = res.tabId;
    } catch (err) {
      /* service worker 未注册时会抛错，忽略即可 */
    }
  }

  /* ---------------------------- 与 popup 通信 ---------------------------- */

  /** 组装给 popup 的当前状态 */
  function pageState() {
    return {
      ok: true,
      /** 目标速度：本标签页（内存中的权威值） */
      target: targetRate,
      /** 页面实际生效的速率，null 表示当前没有 video 元素 */
      actual: currentVideo ? currentVideo.playbackRate : null,
      hasVideo: Boolean(document.querySelector('video')),
      /** 诊断用：本标签页的随机存储键（各标签页必然不同） */
      tabKey,
      /** 诊断用：tabId（拿不到就是 null，不影响功能） */
      tabId,
      persisted: rateLoaded,
      scope: 'tab',
    };
  }

  /**
   * 设置本标签页的速度
   * @param {number} rate
   */
  function setRate(rate) {
    targetRate = normalizeRate(rate);
    everSynced = true;
    rateLoaded = true;
    applyRateEverywhere();
    noteRateChange(targetRate, 'popup 设置');
    saveRate();
    // 新 video 可能马上要出现（例如正在切视频），补几次
    [0, 150, 500].forEach((delay) => setTimeout(syncVideo, delay));
    return targetRate;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message !== 'object') return undefined;

    // 顺手记下 tabId（仅用于诊断显示；速度读写完全不依赖它）
    if (sender && sender.tab && typeof sender.tab.id === 'number' && tabId === null) {
      tabId = sender.tab.id;
    }

    switch (message.type) {
      // popup 打开时读取当前速度
      case 'bilispeed:get':
        sendResponse(pageState());
        return true;

      // popup 改速
      case 'bilispeed:set':
        sendResponse({ ok: true, rate: setRate(message.rate), ...pageState() });
        return true;

      // popup 重置为 1x
      case 'bilispeed:clear':
      case 'bilispeed:reset':
        sendResponse({ ok: true, rate: setRate(DEFAULT_RATE), ...pageState() });
        return true;

      default:
        return undefined;
    }
  });

  /** 页面内调试 API（不污染 DOM） */
  window.__bilispeed = {
    get: () => pageState(),
    /** 直接设速（不经过 popup），会写 session */
    set: (rate) => setRate(rate),
    reset: () => setRate(DEFAULT_RATE),
    /** 手动触发一次扫描 */
    rescan: () => syncVideo(),
    /** 查看本标签页在 session 里的键（便于确认按标签页隔离） */
    key: () => sessionKey(),
    /**
     * 诊断上报：把本标签页的状态发到 Service Worker 控制台，
     * 并顺带列出 session 里所有标签页的键。
     * 用法：在页面 Console 执行 __bilispeed.dump()，然后到
     * edge://extensions/ → BiliSpeed → “检查视图 Service Worker” 看输出。
     */
    dump: async (label) => {
      const report = {
        label: label || '',
        url: location.href,
        tabId,
        tabKey,
        key: sessionKey(),
        target: targetRate,
        actual: currentVideo ? currentVideo.playbackRate : null,
        hasVideo: Boolean(document.querySelector('video')),
        identity: videoIdentity,
        history: rateHistory.slice(),
        otherTabs: {},
      };
      // 把 session 里“其它标签页的键和值”一并列出，一眼就能看出是否共享
      try {
        const all = (await chrome.storage.session.get(null)) || {};
        for (const [key, value] of Object.entries(all)) {
          if (key !== report.key) report.otherTabs[key] = value;
        }
      } catch (err) {
        /* 读不到就算了 */
      }
      try {
        await chrome.runtime.sendMessage({ type: 'bilispeed:debugDump', report });
      } catch (err) {
        /* worker 不在也能在本地看到这份返回值 */
      }
      return report;
    },
  };

  /* ---------------------------- 启动 ---------------------------- */

  async function boot() {
    purgeLegacyKeys();  // 清理旧版按视频记速的配置（不阻塞主流程）
    startDomObserver();
    startPolling();
    startSpaWatcher();
    syncVideo();        // 先用默认 1x 接管，避免空白期
    // 恢复“同一观看会话”的速度（刷新/后退前进）。存储键是本页随机 ID，
    // 不依赖任何扩展消息链路，所以这一步在任何情况下都能可靠执行。
    await loadRate();
    await resolveTabId();  // 仅补一个诊断用的 tabId
    applyRateEverywhere();
  }

  boot();

  window.addEventListener('pagehide', () => {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    // 标签页关闭时什么都不用清 —— session 存储会随标签页自动销毁，
    // 这正是“关闭标签页即清除速度”的实现方式。
  });
})();
