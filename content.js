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

  /** 兜底轮询间隔（速度已落定后的常规节奏） */
  const POLL_INTERVAL_MS = 500;

  /** 速度还没落定时的快速轮询间隔 */
  const FAST_POLL_INTERVAL_MS = 80;

  /**
   * 快速轮询的最长持续时间。超过就降到常规间隔 —— 否则一旦
   * chrome.storage.session 长时间不返回，快速轮询会一直跑下去。
   */
  const FAST_POLL_BUDGET_MS = 3000;

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

  /**
   * 性能计数器（诊断用，只加不读，开销可忽略）。
   * 用来回答“到底哪个机制在疯跑”—— 这是定位卡顿的关键证据。
   * 通过页面 Console 的 __bilispeed.profile() 查看。
   */
  const perf = {
    poll: 0,          // 轮询 tick 次数
    ratechange: 0,    // ratechange 事件次数
    mediaEvent: 0,    // 其它媒体事件次数
    mutationTotal: 0, // MutationObserver 回调次数（收到的批次数）
    mutationVideo: 0, // 其中“确实出现 video”而触发的处理次数
    route: 0,         // SPA 路由变化次数
    syncVideo: 0,     // syncVideo 调用次数
    qsa: 0,           // document.querySelectorAll('video') 调用次数
    applyRate: 0,     // 真正写 playbackRate 的次数
    storageWrite: 0,  // session 写入次数
  };

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

  /**
   * 把速度归零（内存 + session 一起，立即落盘），并刷新 popup 可能看到的实际值。
   *
   * 注意：这里**不**自己扫 DOM —— 调用方 syncVideo() 紧接着就会用同一份
   * video 列表把速度铺开（含这一刀归零），所以本函数只管状态与落盘。
   */
  async function resetForNewVideo(identity) {
    const previous = targetRate;
    targetRate = DEFAULT_RATE;
    videoIdentity = identity;
    enteredVideo = true;
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
   * 查页面上所有 video（统一入口，顺带计数，便于性能自检）。
   * @returns {ArrayLike<HTMLVideoElement>}
   */
  function queryVideos() {
    perf.qsa += 1;
    return document.querySelectorAll('video');
  }

  /**
   * 单调时钟（毫秒）。performance.now 缺失时退回 Date.now，
   * 保证性能自检在任何环境下都不会因为取时间而抛错。
   * @returns {number}
   */
  function nowMs() {
    try {
      if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
        return performance.now();
      }
    } catch (err) { /* 落到 Date.now */ }
    return Date.now();
  }

  /**
   * 下一帧执行（带 setTimeout 兜底）。
   * 用于把同一帧内成批的事件/变动聚合成一次处理，避免重复扫描 DOM。
   * @param {() => void} fn
   */
  function requestFrame(fn) {
    try {
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(fn);
        return;
      }
    } catch (err) { /* 落到 setTimeout */ }
    setTimeout(fn, 16);
  }

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
      perf.applyRate += 1;
      video.playbackRate = targetRate;
      return true;
    } catch (err) {
      // 媒体未就绪时赋值偶发抛错，忽略，后续事件/轮询会重试
      return false;
    }
  }

  /**
   * 对页面上所有 video 应用当前目标速度。
   *
   * 注意：本函数**不做** document.querySelectorAll —— 一次查询一把梭，
   * 由调用方把结果传进来，避免一次逻辑里对整篇文档查两遍（B 站页面很大）。
   *
   * currentVideo 仍然单独补一刀：它有可能已经脱离开文档（换源瞬间），
   * 这时不在查询结果里，但依然应该是被接管的目标。
   * applyRateTo 内部判等，所以重复应用没有任何额外代价。
   * @param {ArrayLike<HTMLVideoElement>} [videos] 已查好的 video 列表
   */
  function applyRateEverywhere(videos) {
    const list = videos || queryVideos();
    for (const video of list) applyRateTo(video);
    if (currentVideo) applyRateTo(currentVideo);
  }

  /* ---------------------------- video 接管 ---------------------------- */

  /**
   * 找到页面上“真正在播放”的 video：优先未暂停的，其次时长最长的。
   * @param {ArrayLike<HTMLVideoElement>} [videos] 已查好的 video 列表（可复用，省一次查询）
   */
  function findVideo(videos) {
    const list = videos || queryVideos();
    if (list.length === 0) return null; // 视频还没加载出来，属正常情况

    let best = null;
    let bestScore = -1;
    for (const video of list) {
      if (!video.currentSrc && video.readyState === 0) continue;
      let score = 0;
      if (!video.paused) score += 100;
      if (video.duration && Number.isFinite(video.duration)) score += Math.min(video.duration, 100);
      if (score > bestScore) {
        bestScore = score;
        best = video;
      }
    }
    return best || list[0];
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
      perf.mediaEvent += 1;
      applyRateTo(video);
    };

    const onRateChange = () => {
      perf.ratechange += 1;
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
   *
   * 性能要点：整段逻辑只查一次 DOM（findVideo 内部那一次），
   * 之后复用同一个列表把速度铺到所有 video 上。
   */
  function syncVideo() {
    perf.syncVideo += 1;
    // 1) 视频身份变化 -> 可能要把速度清零（离开再进来 / 换视频）
    assessVideoEntry(videoIdentityNow());

    // 2) 找到 video 并接管，把当前目标速度钉上去。
    //    这里拿到的列表顺手留给第 3 步复用，避免重复查询。
    const videos = queryVideos();
    const video = findVideo(videos);
    if (video) adoptVideo(video);
    else releaseVideo(); // 视频还不存在（页面刚打开 / SPA 正在渲染），等下一轮

    // 3) 页面上可能有多个 video（预览播放器等），一并处理
    applyRateEverywhere(videos);
  }

  /* ---------------------------- 监控机制 ---------------------------- */

  /**
   * MutationObserver：video 被添加/移除/替换时立即响应。
   *
   * 性能要点：B 站页面的 DOM 变动极频繁（弹幕、评论、推荐流、侧栏……），
   * 每个 mutation 都跑一次 findVideo() 会造成大量无谓的整篇文档查询。
   * 所以这里只做两件事：
   *   1. 用 rAF 把同一帧内的成批 mutation 聚合成一次处理；
   *   2. 只在“真的出现了 video”时才去接管。
   * 轮询仍在兜底，所以这里漏掉任何边缘情况都不会影响功能。
   */
  function startDomObserver() {
    let scheduled = false;

    const observer = new MutationObserver((records) => {
      perf.mutationTotal += 1;
      if (scheduled) return;
      // 只有“新增了 video 节点”才需要立刻响应；其余 DOM 变动与本扩展无关。
      // （video 已存在时的速度纠正交给事件与轮询，不必为每次 mutation 扫一遍）
      if (!hasVideoInMutations(records)) return;

      scheduled = true;
      requestFrame(() => {
        scheduled = false;
        perf.mutationVideo += 1;
        const videos = queryVideos();
        if (videos.length === 0) {
          if (currentVideo) releaseVideo();
          return;
        }
        const video = findVideo(videos);
        if (video && video !== currentVideo) adoptVideo(video);
        applyRateEverywhere(videos);
      });
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      // 不监听 attributes：B 站改 class/属性极频繁，监听属性纯浪费 CPU
    });
  }

  /**
   * 这批 mutation 里是否新增了 video 元素（含嵌套在新增子树里的）。
   * @param {MutationRecord[]} records
   * @returns {boolean}
   */
  function hasVideoInMutations(records) {
    for (const record of records) {
      const added = record.addedNodes;
      if (!added || added.length === 0) continue;
      for (const node of added) {
        if (node.nodeType !== 1) continue; // 只要元素节点
        if (node.tagName === 'VIDEO') return true;
        // 新增的是容器（B 站换播放器时常见）：看它内部有没有 video
        if (typeof node.querySelector === 'function' && node.querySelector('video')) return true;
      }
    }
    return false;
  }

  /**
   * 兜底轮询。
   *
   * 恢复速度之前用更短的间隔（速度还没落定的窗口通常只有几十毫秒），
   * 拿到速度后固定为 POLL_INTERVAL_MS，避免长期高频扫描浪费 CPU。
   *
   * 用 setTimeout 自续期而不是 setInterval，原因有二（都是性能/正确性刚需）：
   *  1. 间隔可以在每轮之间动态决定，降频时**下一个 tick 就生效**，
   *     不用先 clearInterval 再重启（旧写法在重启的窗口里可能漏一次或叠一次）；
   *  2. setInterval 在页面卡顿时会堆积回调，一恢复就连续补跑好几轮扫描，
   *     正是“切换速率时更卡”的放大器；自续期天然不会堆积。
   *
   * 另外**必须给快速轮询一个上限**：loadRate() 期间若 chrome.storage.session
   * 长时间不返回（service worker 冷启动、存储异常），rateLoaded 会一直是 false，
   * 80ms 快速轮询就会无限期地以 ~12 次/秒 扫描 DOM（实测过，这是真正的卡顿源）。
   * 超过 FAST_POLL_BUDGET_MS 后一律降到常规间隔，功能不变（轮询本来就只是兜底）。
   */
  function startPolling() {
    if (pollTimer !== null) return;
    const startedAt = Date.now();

    const tick = () => {
      pollTimer = null;
      perf.poll += 1;
      syncVideo();

      // 速度已恢复到常规节奏，或快速轮询已超出预算 -> 用常规间隔
      const stillFast = !rateLoaded && (Date.now() - startedAt) < FAST_POLL_BUDGET_MS;
      pollTimer = setTimeout(tick, stillFast ? FAST_POLL_INTERVAL_MS : POLL_INTERVAL_MS);
    };

    pollTimer = setTimeout(tick, rateLoaded ? POLL_INTERVAL_MS : FAST_POLL_INTERVAL_MS);
  }

  /** 停掉轮询（标签页隐藏 / 要销毁时用，避免后台白扫） */
  function stopPolling() {
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  /**
   * SPA 路由监听：B 站跳转走 history.pushState，不触发原生事件，必须打补丁。
   *
   * 性能要点：B 站在滚动、加载推荐位时也会调用 pushState/replaceState，
   * 每次都排 4 次全量扫描代价很高。这里两处收口：
   *  1. 只有 pathname 真的变了才算“换了页面”（同页 replaceState 不排扫描）；
   *  2. 补刀复用 scheduleResync 的合并逻辑，连续路由变化不会叠加。
   */
  function startSpaWatcher() {
    /** 上一次见到的路径，用来识别“真的换页了” */
    let lastPath = location.pathname + location.search;

    const onRouteChange = () => {
      const now = location.pathname + location.search;
      if (now === lastPath) return; // 只是同页状态刷新，不关本扩展的事
      lastPath = now;
      perf.route += 1;

      // 路由刚变时新 video 往往还没挂上，多补几次；轮询也会兜底。
      // 速度本身不变（本标签页共用），只是要在新 video 上重新钉一遍。
      // 同样用 0/150/500 的节奏即可，1200ms 那次由常规轮询覆盖。
      scheduleResync();
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
      if (document.hidden) {
        // 切到后台就别再扫了，省 CPU / 省电
        stopPolling();
        return;
      }
      syncVideo();
      startPolling(); // 回到前台恢复兜底轮询
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
        // 立刻补一次扫描：此刻 video 元素可能还没出现/还没被接管。
        // syncVideo() 内部已经会把速度铺到页面上**所有** video（含新出现的），
        // 所以这里不需要再单独调一次 applyRateEverywhere()。
        syncVideo();
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
      perf.storageWrite += 1;
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
   * 设置本标签页的速度。
   *
   * 这是「切换速率」的热路径，必须只做必要的事：
   *  - 立刻查一次 DOM 并铺速度（用户要马上看到效果）；
   *  - 之后只在“新 video 可能还没挂上”的窗口里补几次轻量校验，
   *    且补校验之间彼此去重，避免用户连点档位时堆叠出一串全量扫描。
   * @param {number} rate
   */
  function setRate(rate) {
    targetRate = normalizeRate(rate);
    everSynced = true;
    rateLoaded = true;

    // 一次查询，铺到所有 video（含 currentVideo）
    applyRateEverywhere();

    noteRateChange(targetRate, 'popup 设置');
    saveRate();

    // 新 video 可能马上要出现（例如正在切视频），补几次。
    // scheduleResync 内部会合并同一批补刀，连点档位不会叠加扫描。
    scheduleResync();
    return targetRate;
  }

  /**
   * 短时间内安排几次补偿扫描（合并重复请求）。
   * 只在“video 可能刚被替换、事件还没到”的窗口里用，属于兜底性质。
   */
  let resyncTimers = null;
  function scheduleResync() {
    if (resyncTimers !== null) {
      for (const timer of resyncTimers) clearTimeout(timer);
    }
    resyncTimers = [0, 150, 500].map((delay) => setTimeout(() => {
      if (delay === 500) resyncTimers = null;
      syncVideo();
    }, delay));
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
    /**
     * 性能自检：在页面 Console 里跑，量出本扩展到底占了多少主线程。
     *
     * 用法：
     *   await __bilispeed.profile()          // 默认测 3 秒
     *   await __bilispeed.profile(5000)      // 测 5 秒
     *
     * 它做三件事：
     *   1. 统计各监控机制（轮询/事件/MutationObserver/路由）被触发了多少次；
     *   2. 用 PerformanceObserver 抓长任务（longtask），看主线程有没有被堵住；
     *   3. 主动"切换一次速率"，单独量这次操作的开销。
     * 测完会把结果打印到 Console 并返回对象。
     *
     * @param {number} durationMs 观测时长
     */
    profile: async (durationMs = 3000) => {
      const stats = {
        durationMs,
        mechanism: {
          poll: perf.poll,
          ratechange: perf.ratechange,
          mediaEvent: perf.mediaEvent,
          mutation: { total: perf.mutationTotal, videoRelated: perf.mutationVideo },
          route: perf.route,
          syncVideo: perf.syncVideo,
          qsa: perf.qsa,
          applyRate: perf.applyRate,
          storageWrite: perf.storageWrite,
        },
        perSecond: null,
        longTasks: { count: 0, totalMs: 0, max: 0, supported: false },
        videoState: null,
        rateSwitchCost: null,
      };

      // ---- 1. 观测窗口：只听长任务，不打扰页面 ----
      let observer = null;
      try {
        if (typeof PerformanceObserver === 'function') {
          observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              stats.longTasks.count += 1;
              stats.longTasks.totalMs += entry.duration;
              if (entry.duration > stats.longTasks.max) stats.longTasks.max = entry.duration;
            }
          });
          observer.observe({ entryTypes: ['longtask'] });
          stats.longTasks.supported = true;
        }
      } catch (err) {
        /* 不支持 longtask 就算了，下面的计数依然有效 */
      }

      const snap = () => ({ ...perf });
      const before = snap();
      const windowStart = nowMs();

      // ---- 2. 观测期间主动切一次速率（模拟用户点档位）----
      const origRate = targetRate;
      const probeRate = origRate === 4 ? 8 : 4;
      await new Promise((resolve) => {
        setTimeout(() => {
          setRate(probeRate);
          setTimeout(() => {
            setRate(origRate); // 恢复原速度
            setTimeout(resolve, 200);
          }, Math.max(300, durationMs / 2));
        }, 100);
      });

      const after = snap();
      const elapsedSec = Math.max(0.001, (nowMs() - windowStart) / 1000);
      if (observer) { try { observer.disconnect(); } catch (err) { /* 忽略 */ } }

      // 观测窗口内的增量 + 折算到每秒（每秒次数最直观）
      stats.countersDuringWindow = {};
      stats.perSecond = {};
      for (const key of Object.keys(after)) {
        const delta = after[key] - before[key];
        stats.countersDuringWindow[key] = delta;
        stats.perSecond[key] = Number((delta / elapsedSec).toFixed(1));
      }
      stats.longTasks.totalMs = Number(stats.longTasks.totalMs.toFixed(1));
      stats.longTasks.max = Number(stats.longTasks.max.toFixed(1));

      // ---- 3. 单独量一次「切换速率」的同步耗时 ----
      {
        const t0 = nowMs();
        setRate(probeRate);
        const t1 = nowMs();
        setRate(origRate);
        const t2 = nowMs();
        stats.rateSwitchCost = {
          setRateMs: Number((t1 - t0).toFixed(2)),
          setRateBackMs: Number((t2 - t1).toFixed(2)),
        };
        // 确保恢复用户原本的速度（setRate 已恢复，这里再兜一次底）
        targetRate = origRate;
        applyRateEverywhere();
      }

      // 逐项安全取值：诊断代码绝不能因为某个属性缺失/抛错而中断
      const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
      const v = currentVideo || document.querySelector('video');
      stats.videoState = v
        ? {
          playbackRate: num(v.playbackRate),
          readyState: num(v.readyState),
          paused: typeof v.paused === 'boolean' ? v.paused : null,
          buffered: (() => {
            try {
              if (!v.buffered || v.buffered.length === 0) return '(空)';
              return `${v.buffered.start(0).toFixed(1)}~${v.buffered.end(v.buffered.length - 1).toFixed(1)}s`;
            } catch (err) {
              return '(读不到)';
            }
          })(),
          currentTime: num(v.currentTime),
          duration: num(v.duration),
          videoWidth: num(v.videoWidth),
          videoHeight: num(v.videoHeight),
          droppedFrames: (() => {
            try {
              return typeof v.getVideoPlaybackQuality === 'function'
                ? num(v.getVideoPlaybackQuality().droppedVideoFrames) : null;
            } catch (err) {
              return null;
            }
          })(),
          totalFrames: (() => {
            try {
              return typeof v.getVideoPlaybackQuality === 'function'
                ? num(v.getVideoPlaybackQuality().totalVideoFrames) : null;
            } catch (err) {
              return null;
            }
          })(),
        }
        : null;

      console.log('[BiliSpeed 性能自检]', JSON.stringify(stats, null, 2));
      return stats;
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
    // loadRate 内部恢复过速度时已经 syncVideo 过一次；这里只在“没恢复过”时
    // 补一刀，避免启动阶段对同一份 DOM 反复全量扫描。
    if (targetRate === DEFAULT_RATE) applyRateEverywhere();
  }

  boot();

  window.addEventListener('pagehide', () => {
    stopPolling();
    // 标签页关闭时什么都不用清 —— session 存储会随标签页自动销毁，
    // 这正是“关闭标签页即清除速度”的实现方式。
  });
})();
