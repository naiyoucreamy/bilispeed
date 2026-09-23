/**
 * BiliSpeed 逻辑自测台（仅本地验证用，不属于扩展本体）
 * 用 Node 跑真实的 content.js，模拟 chrome.storage.session / video 元素 / SPA 跳转 / 两个标签页。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

/* ---------------- 假存储：session 是“浏览器会话级”，被所有标签页共享 ---------------- */
/**
 * 关键点：所有 createEnv 共享同一个 session 对象，用来验证“按 tabId 隔离”；
 * 若某处误用了全局共享（不区分 tabId），测试会立刻发现串味。
 */
function createBrowserStorage() {
  const state = { session: {}, sync: {} };
  const sessionApi = {
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) if (k in state.session) out[k] = state.session[k];
      return out;
    },
    async set(obj) { Object.assign(state.session, obj); },
    async remove(keys) {
      for (const k of [].concat(keys)) delete state.session[k];
    },
  };
  const syncApi = {
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) if (k in state.sync) out[k] = state.sync[k];
      return out;
    },
    async set(obj) { Object.assign(state.sync, obj); },
    async remove(keys) {
      for (const k of [].concat(keys)) delete state.sync[k];
    },
  };
  return { state, sessionApi, syncApi };
}

/* ---------------- 假 video ---------------- */
function createVideo() {
  const listeners = {};
  let rate = 1;
  return {
    currentSrc: 'blob:https://www.bilibili.com/abc',
    readyState: 4,
    paused: false,
    duration: 300,
    get playbackRate() { return rate; },
    set playbackRate(v) {
      if (Math.abs(v - rate) < 1e-9) return;
      rate = v;
      // 真实浏览器赋值后必然触发 ratechange
      (listeners.ratechange || []).forEach((f) => f({ type: 'ratechange' }));
    },
    _forcedRate: (v) => { rate = v; }, // 模拟“外部静默改速率”（绕开事件）
    addEventListener: (t, f) => { (listeners[t] ||= []).push(f); },
    removeEventListener: (t, f) => {
      if (listeners[t]) listeners[t] = listeners[t].filter((x) => x !== f);
    },
    _fire: (t) => (listeners[t] || []).forEach((f) => f({ type: t })),
  };
}

/* ---------------- 环境（一个 tab = 一个 content script 实例） ---------------- */
function createEnv({ url, tabId, browser, videos, whoamiWorks = true, navType = 'navigate', pageSession = null }) {
  const location = new URL(url);
  const win = { location, addEventListener: () => {}, removeEventListener: () => {} };
  win.window = win;

  // 页面自己的 sessionStorage：同一个标签页刷新后保留，标签页之间互相隔离。
  // 传入 pageSession 就相当于“同一个标签页的第二次加载”。
  const store = pageSession || new Map();
  const sessionStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const pageSessionOut = store;

  const document = {
    documentElement: {},
    hidden: false,
    querySelectorAll: (sel) => (sel === 'video' ? videos.slice() : []),
    querySelector: (sel) => (sel === 'video' ? (videos[0] || null) : null),
    addEventListener: () => {},
  };

  // 模拟 Navigation Timing：navigate / reload / back_forward
  const performance = {
    getEntriesByType: (type) => (type === 'navigation' ? [{ type: navType }] : []),
  };

  const chrome = {
    storage: { session: browser.sessionApi, sync: browser.syncApi },
    runtime: {
      lastError: undefined,
      onMessage: { addListener: (fn) => { win.__onMessage = fn; } },
      sendMessage: async (msg) => {
        if (msg.type === 'bilispeed:whoami') {
          if (!whoamiWorks) throw new Error('Could not establish connection.');
          return { ok: true, tabId };
        }
        return { ok: true };
      },
    },
  };

  const ctx = vm.createContext({
    window: win, document, chrome, location, performance, sessionStorage, crypto,
    history: { pushState: () => {}, replaceState: () => {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    console, Math, Number, Object, JSON, URL, URLSearchParams, Promise, Date, String,
    MutationObserver: class { observe() {} disconnect() {} },
  });
  vm.runInContext(SRC, ctx, { filename: 'content.js' });

  /** 模拟 popup 发消息（sender.tab.id 一定要带上） */
  const popupSend = (message) => {
    let response = null;
    win.__onMessage(message, { tab: { id: tabId } }, (r) => { response = r; });
    return response;
  };

  /** 模拟 SPA 跳转：改 URL 并触发一次扫描 */
  const navigate = (nextUrl) => {
    location.href = nextUrl;
    win.__bilispeed.rescan();
  };

  return { win, chrome, location, popupSend, navigate, navType, pageSession: pageSessionOut, video: videos[0] };
}

/* ---------------- 断言工具 ---------------- */
let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}\n        期望: ${JSON.stringify(expected)}\n        实际: ${JSON.stringify(actual)}`); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 测试 ---------------- */
(async () => {
  console.log('\n[1] 速度按标签页隔离：一个标签页一个速度，互不影响');
  {
    const browser = createBrowserStorage();
    const videoA = createVideo();
    const videoB = createVideo();
    const tabA = createEnv({ url: 'https://www.bilibili.com/video/BV1AA411c7de', tabId: 101, browser, videos: [videoA] });
    const tabB = createEnv({ url: 'https://www.bilibili.com/video/BV1BB411c7de', tabId: 202, browser, videos: [videoB] });
    await wait(60);

    check('新标签页 A 默认 1x', videoA.playbackRate, 1);
    check('新标签页 B 默认 1x', videoB.playbackRate, 1);

    tabA.popupSend({ type: 'bilispeed:set', rate: 3.75 });
    await wait(30);
    check('A 变成 3.75x', videoA.playbackRate, 3.75);
    check('B 完全不受影响', videoB.playbackRate, 1);
    check('A 的 session 值为 3.75', browser.state.session[tabA.win.__bilispeed.key()], 3.75);
    check('B 的 session 值仍为 1', browser.state.session[tabB.win.__bilispeed.key()], 1);

    tabB.popupSend({ type: 'bilispeed:set', rate: 8 });
    await wait(30);
    check('B 变成 8x', videoB.playbackRate, 8);
    check('A 仍是 3.75x', videoA.playbackRate, 3.75);
    // 两个标签页的键互不相同，值各自独立
    check('两个标签页的键不同', tabA.win.__bilispeed.key() !== tabB.win.__bilispeed.key(), true);
    check('两键各自独立', browser.state.session, {
      [tabA.win.__bilispeed.key()]: 3.75,
      [tabB.win.__bilispeed.key()]: 8,
    });
  }

  console.log('\n[1b] 回归：即使 tabId 相同（消息链路退化），速度也必须独立');
  {
    // 本次改动的核心防护：存储键不再用 tabId，而是每个页面自己生成的随机 ID，
    // 因此哪怕 whoami 给出同一个（或错误）的值，两个标签页也不可能共用一份速度。
    const browser = createBrowserStorage();
    const videoA = createVideo();
    const videoB = createVideo();
    const SAME_TAB_ID = 42;
    const tabA = createEnv({ url: 'https://www.bilibili.com/video/BV1AA411c7de', tabId: SAME_TAB_ID, browser, videos: [videoA] });
    const tabB = createEnv({ url: 'https://www.bilibili.com/video/BV1BB411c7de', tabId: SAME_TAB_ID, browser, videos: [videoB] });
    await wait(60);

    tabA.popupSend({ type: 'bilispeed:set', rate: 3.75 });
    await wait(30);
    check('A 变成 3.75x', videoA.playbackRate, 3.75);
    check('B 不受影响（仍是 1x）', videoB.playbackRate, 1);
    check('tabId 相同但存储键不同', tabA.win.__bilispeed.key() !== tabB.win.__bilispeed.key(), true);
    check('A 读回自己的值', tabA.popupSend({ type: 'bilispeed:get' }).target, 3.75);
    check('B 读回 1x', tabB.popupSend({ type: 'bilispeed:get' }).target, 1);
  }

  console.log('\n[2] 进入视频即清零；同一视频内切分P 保持');
  {
    const browser = createBrowserStorage();
    const video = createVideo();
    const tab = createEnv({ url: 'https://www.bilibili.com/video/BV1AA411c7de', tabId: 101, browser, videos: [video] });
    await wait(50);
    tab.popupSend({ type: 'bilispeed:set', rate: 4 });
    await wait(30);
    check('初始 4x', video.playbackRate, 4);

    // 同一视频切分P：身份不变 -> 保持 4x
    tab.navigate('https://www.bilibili.com/video/BV1AA411c7de?p=2');
    await wait(30);
    check('切分P 保持 4x', video.playbackRate, 4);

    // 拖进度条 / 切清晰度
    video._forcedRate(1);
    video._fire('emptied');
    video._fire('loadedmetadata');
    await wait(20);
    check('切P事件后纠回 4x', video.playbackRate, 4);

    // 换到另一个视频 -> 清零
    tab.navigate('https://www.bilibili.com/video/BV1ZZ411c7de');
    await wait(30);
    check('换视频后清零为 1x', video.playbackRate, 1);
    check('换视频后 target=1', tab.win.__bilispeed.get().target, 1);
    check('session 中的值也变 1', browser.state.session[tab.win.__bilispeed.key()], 1);

    // 回到同一个视频也仍是 1x（换过视频再来，算重新进入）
    tab.navigate('https://www.bilibili.com/video/BV1ZZ411c7de?p=5');
    await wait(30);
    check('该视频切分P 仍为 1x', video.playbackRate, 1);

    // 番剧页：换身份 -> 清零
    tab.popupSend({ type: 'bilispeed:set', rate: 3 });
    await wait(30);
    check('番剧页设为 3x', video.playbackRate, 3);
    tab.navigate('https://www.bilibili.com/bangumi/play/ep123456');
    await wait(30);
    check('进入番剧页清零', video.playbackRate, 1);
  }

  console.log('\n[3] 离开视频页再进来 -> 清零（这就是“退出再打开清零”）');
  {
    const browser = createBrowserStorage();
    const video = createVideo();
    const tab = createEnv({ url: 'https://www.bilibili.com/video/BV1AA411c7de', tabId: 202, browser, videos: [video] });
    await wait(50);
    tab.popupSend({ type: 'bilispeed:set', rate: 5 });
    await wait(30);
    check('设为 5x', video.playbackRate, 5);

    // 回首页（离开视频页）
    tab.navigate('https://www.bilibili.com/');
    await wait(30);
    check('首页不干预播放器', video.playbackRate, 5);
    check('离开视频页后 target 保持 5（页面级）', tab.win.__bilispeed.get().target, 5);

    // 再打开同一个视频 -> 必须清零
    tab.navigate('https://www.bilibili.com/video/BV1AA411c7de');
    await wait(30);
    check('重新进入同一个视频 -> 1x', video.playbackRate, 1);
    check('重新进入后 target=1', tab.win.__bilispeed.get().target, 1);

    // 完整重演：设速 -> 离开 -> 再进（连续两轮，确保不是只生效一次）
    tab.popupSend({ type: 'bilispeed:set', rate: 6 });
    await wait(30);
    check('第二轮设为 6x', video.playbackRate, 6);
    tab.navigate('https://www.bilibili.com/search?keyword=x');
    await wait(20);
    tab.navigate('https://www.bilibili.com/video/BV1AA411c7de');
    await wait(30);
    check('第二轮重新进入也是 1x', video.playbackRate, 1);
  }

  console.log('\n[4] F5 刷新 / 后退前进 保持速度（同一个观看会话）');
  {
    const browser = createBrowserStorage();
    const video1 = createVideo();
    const first = createEnv({ url: 'https://www.bilibili.com/video/BV1DD411c7de', tabId: 404, browser, videos: [video1] });
    await wait(50);
    first.popupSend({ type: 'bilispeed:set', rate: 2.5 });
    await wait(30);
    check('第一次加载设为 2.5x', video1.playbackRate, 2.5);

    // F5 刷新：同一个标签页（复用 pageSession）、新 content script 实例 + 新 video
    const video2 = createVideo();
    const refreshed = createEnv({
      url: 'https://www.bilibili.com/video/BV1DD411c7de', tabId: 404, browser, videos: [video2],
      navType: 'reload', pageSession: first.pageSession,
    });
    await wait(80);
    check('刷新后保持 2.5x', video2.playbackRate, 2.5);
    check('刷新后 target 正确', refreshed.win.__bilispeed.get().target, 2.5);
    check('刷新后复用同一个存储键', refreshed.win.__bilispeed.key(), first.win.__bilispeed.key());

    // 后退/前进回来：也保持
    const video3 = createVideo();
    const back = createEnv({
      url: 'https://www.bilibili.com/video/BV1DD411c7de', tabId: 404, browser, videos: [video3],
      navType: 'back_forward', pageSession: first.pageSession,
    });
    await wait(80);
    check('后退前进保持 2.5x', video3.playbackRate, 2.5);

    // 但如果是“直接打开”（navigate）-> 清零
    const video4 = createVideo();
    const direct = createEnv({
      url: 'https://www.bilibili.com/video/BV1DD411c7de', tabId: 404, browser, videos: [video4],
      navType: 'navigate', pageSession: first.pageSession,
    });
    await wait(80);
    check('直接打开同一视频 -> 1x', video4.playbackRate, 1);
    check('session 里的遗留值被清掉', browser.state.session[direct.win.__bilispeed.key()], 1);
  }

  console.log('\n[5] 标签页关闭 -> 数据消失，新标签页从 1x 开始');
  {
    const browser = createBrowserStorage();
    const video1 = createVideo();
    const tab = createEnv({ url: 'https://www.bilibili.com/video/BV1DD411c7de', tabId: 909, browser, videos: [video1] });
    await wait(50);
    tab.popupSend({ type: 'bilispeed:set', rate: 2.5 });
    await wait(30);
    check('设为 2.5x', video1.playbackRate, 2.5);

    // session 区域随标签页销毁
    delete browser.state.session[tab.win.__bilispeed.key()];

    const video2 = createVideo();
    const newTab = createEnv({ url: 'https://www.bilibili.com/video/BV1DD411c7de', tabId: 505, browser, videos: [video2] });
    await wait(80);
    check('新标签页从 1x 开始', video2.playbackRate, 1);
    check('新标签页 target 为 1', newTab.win.__bilispeed.get().target, 1);
  }

  console.log('\n[6] 播放器重置 playbackRate 时自动纠回');
  {
    const browser = createBrowserStorage();
    const video = createVideo();
    const tab = createEnv({ url: 'https://www.bilibili.com/video/BV1CC411c7de', tabId: 303, browser, videos: [video] });
    await wait(50);
    tab.popupSend({ type: 'bilispeed:set', rate: 8 });
    await wait(30);
    check('设为 8x', video.playbackRate, 8);

    video.playbackRate = 1; // 外部赋值（触发 ratechange）
    await wait(20);
    check('ratechange 后自动纠回 8x', video.playbackRate, 8);

    video._forcedRate(0.5);
    video._fire('seeking'); // 拖进度条
    await wait(20);
    check('seeking 后纠回 8x', video.playbackRate, 8);

    video._forcedRate(1);
    video._fire('loadedmetadata'); // 切清晰度/换源
    await wait(20);
    check('换源后纠回 8x', video.playbackRate, 8);

    video._forcedRate(2); // 什么都不触发 -> 靠 500ms 轮询兜底
    await wait(700);
    check('轮询兜底纠回 8x', video.playbackRate, 8);
  }

  console.log('\n[7] 旧版“按视频记速”的配置被清理');
  {
    const browser = createBrowserStorage();
    browser.state.sync = {
      'bilispeed.rates': { 'bili:video:BV1AA411c7de': 3.75 },
      'bilispeed.rate': 2,
      'bilispeed.migrated': true,
    };
    const video = createVideo();
    createEnv({ url: 'https://www.bilibili.com/video/BV1AA411c7de', tabId: 606, browser, videos: [video] });
    await wait(80);
    check('旧记录已从 sync 删除', Object.keys(browser.state.sync), []);
    check('旧配置不再影响速度', video.playbackRate, 1);
  }

  console.log('\n[8] 重置 / 越界钳制 / 拿不到 tabId 的退化模式');
  {
    const browser = createBrowserStorage();
    const video = createVideo();
    const tab = createEnv({ url: 'https://www.bilibili.com/video/BV1EE411c7de', tabId: 707, browser, videos: [video] });
    await wait(50);
    tab.popupSend({ type: 'bilispeed:set', rate: 16 });
    await wait(30);
    check('设为 16x（上限）', video.playbackRate, 16);

    tab.popupSend({ type: 'bilispeed:reset' });
    await wait(30);
    check('重置后回 1x', video.playbackRate, 1);
    check('session 值同步为 1', browser.state.session[tab.win.__bilispeed.key()], 1);

    // 越界值应被钳制
    tab.win.__bilispeed.set(99);
    await wait(20);
    check('99 被钳制到 16x', video.playbackRate, 16);
    tab.win.__bilispeed.set(0.1);
    await wait(20);
    check('0.1 被钳制到 0.25x', video.playbackRate, 0.25);
    tab.win.__bilispeed.set(7.13);
    await wait(20);
    check('7.13 对齐到 7.25x', video.playbackRate, 7.25);
  }

  {
    // whoami 失败（service worker 未注册）-> 退化纯内存；
    // 之后 popup 打开时消息里带着 sender.tab.id，会自动补上 tabId（兜底路径）
    const browser = createBrowserStorage();
    const video = createVideo();
    const tab = createEnv({ url: 'https://www.bilibili.com/video/BV1FF411c7de', tabId: 808, browser, videos: [video], whoamiWorks: false });
    await wait(80);
    check('退化模式：初始 1x', video.playbackRate, 1);
    check('退化模式：拿不到 tabId 时 key 仍可用（随机键，不依赖消息链路）',
      String(tab.win.__bilispeed.key()).startsWith('bilispeed.rate.'), true);
    check('退化模式：tabId 为 null', tab.win.__bilispeed.get().tabId, null);
    check('退化模式：tabKey 非空', typeof tab.win.__bilispeed.get().tabKey, 'string');

    tab.popupSend({ type: 'bilispeed:set', rate: 5 });
    await wait(30);
    check('退化模式：仍可设 5x', video.playbackRate, 5);
    check('退化模式：popup 消息补上了 tabId（仅诊断用）', tab.win.__bilispeed.get().tabId, 808);
    check('退化模式：速度写进自己的随机键', browser.state.session[tab.win.__bilispeed.key()], 5);
    check('退化模式：键与 tabId 无关', String(tab.win.__bilispeed.key()).includes('808'), false);
  }

  console.log('\n[10] 性能契约：切速率不许引发无谓的全量 DOM 扫描');
  {
    // 背景：B 站页面很大，document.querySelectorAll('video') 是全篇扫描。
    // 「切换速率就卡顿」的根因就是这条路径上叠了太多扫描，这里逐条守住。
    // 用一个会计数的 document 跑真实 content.js。
    const makeCountingEnv = ({ videos = 1, storageNeverResolves = false, navType = 'navigate' } = {}) => {
      const counters = { qsa: 0 };
      const location = new URL('https://www.bilibili.com/video/BV1AA411c7de');
      const win = { location, addEventListener: () => {}, removeEventListener: () => {} };
      win.window = win;
      const list = [];
      for (let i = 0; i < videos; i += 1) list.push(createVideo());

      const store = new Map();
      const sessionStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
      };
      const document = {
        documentElement: {},
        hidden: false,
        querySelectorAll: (sel) => {
          if (sel === 'video') { counters.qsa += 1; return list.slice(); }
          return [];
        },
        querySelector: (sel) => (sel === 'video' ? (list[0] || null) : null),
        addEventListener: () => {},
      };
      const st = {};
      const settle = (fn) => (storageNeverResolves ? new Promise(() => {}) : Promise.resolve().then(fn));
      const sessionApi = {
        get(keys) {
          return settle(() => {
            const out = {};
            if (keys === null) Object.assign(out, st);
            else for (const k of [].concat(keys)) if (k in st) out[k] = st[k];
            return out;
          });
        },
        set(obj) { return settle(() => { Object.assign(st, obj); }); },
        remove() { return settle(() => {}); },
      };
      let observerCb = null;
      const chrome = {
        storage: { session: sessionApi, sync: { get: async () => ({}), remove: async () => {} } },
        runtime: {
          lastError: undefined,
          onMessage: { addListener: (fn) => { win.__onMessage = fn; } },
          sendMessage: async () => ({ ok: true, tabId: 1 }),
        },
      };
      const ctx = vm.createContext({
        window: win, document, chrome, location, sessionStorage, crypto,
        performance: { getEntriesByType: () => [{ type: navType }] },
        history: { pushState: () => {}, replaceState: () => {} },
        requestAnimationFrame: (fn) => setTimeout(fn, 0),
        setTimeout, clearTimeout, setInterval, clearInterval,
        console: { info() {}, log() {}, warn() {} },
        Math, Number, Object, JSON, URL, Promise, Date, String,
        MutationObserver: class { constructor(fn) { observerCb = fn; } observe() {} disconnect() {} },
      });
      vm.runInContext(SRC, ctx, { filename: 'content.js' });
      return {
        counters, list, win,
        set: (rate) => win.__onMessage({ type: 'bilispeed:set', rate }, { tab: { id: 1 } }, () => {}),
        fireMutation: (records) => { if (observerCb) observerCb(records); },
      };
    };

    // ---- 1. 一次切速率：扫描次数要有上限 ----
    {
      const env = makeCountingEnv({ videos: 3 });
      await wait(150);
      const before = env.counters.qsa;
      env.set(8);
      await wait(700); // 覆盖 0/150/500 补刀窗口 + 一次常规轮询
      const used = env.counters.qsa - before;
      check('一次切速率的全量扫描次数 ≤ 6（优化前为 9）', used <= 6, true);
      check('切速率后所有 video 都被应用', env.list.map((v) => v.playbackRate), [8, 8, 8]);
    }

    // ---- 2. 连点档位：补刀必须合并，不能线性叠加 ----
    {
      const env = makeCountingEnv({ videos: 1 });
      await wait(150);
      const before = env.counters.qsa;
      for (let i = 0; i < 10; i += 1) {
        env.set(1 + i * 0.25);
        await wait(20);
      }
      await wait(700);
      const used = env.counters.qsa - before;
      // 优化前是 10 次立即 + 每次 3 发补刀 = 40 次；合并后应远低于此
      check('连点 10 次档位的扫描次数 ≤ 30（优化前约 40）', used <= 30, true);
      check('连点后最终速度正确', env.list[0].playbackRate, 1 + 9 * 0.25);
    }

    // ---- 3. 关键回归：storage 不返回时，快速轮询必须降频 ----
    {
      const env = makeCountingEnv({ storageNeverResolves: true });
      await wait(2000);
      const early = env.counters.qsa;
      const mark = env.counters.qsa;
      await wait(4000); // 越过 FAST_POLL_BUDGET_MS(3s)
      const late = (env.counters.qsa - mark) / 4;
      check('快速轮询期间确实更密（说明预算内是快节奏）', early / 2 > 3, true);
      // 优化前这里会一直 ~23 次/秒 永不降频
      check('超出预算后降到常规节奏（< 5 次/秒，优化前约 23 次/秒）', late < 5, true);
    }

    // ---- 4. 与 video 无关的 DOM 变动不该触发扫描 ----
    {
      const env = makeCountingEnv({ videos: 1 });
      await wait(150);
      const before = env.counters.qsa;
      for (let i = 0; i < 300; i += 1) {
        env.fireMutation([{ addedNodes: [{ nodeType: 1, tagName: 'DIV', querySelector: () => null }] }]);
      }
      await wait(100);
      check('300 次无关 DOM 变动 -> 0 次扫描（优化前 300 次）', env.counters.qsa - before, 0);
    }

    // ---- 5. 但新增 video 必须立刻被接管 ----
    {
      const env = makeCountingEnv({ videos: 1 });
      await wait(150);
      const fresh = createVideo();
      env.list.push(fresh);
      env.fireMutation([{ addedNodes: [{ nodeType: 1, tagName: 'VIDEO', querySelector: () => null }] }]);
      await wait(80);
      check('新增 video 节点后立刻被应用倍速', fresh.playbackRate, 1);
      env.set(4);
      await wait(50);
      check('接管后新 video 跟着目标速度走', fresh.playbackRate, 4);
    }

    // ---- 6. 同页 replaceState 不该排补偿扫描 ----
    {
      const env = makeCountingEnv({ videos: 1 });
      await wait(150);
      const before = env.counters.qsa;
      env.win.__bilispeed.rescan && env.win.__bilispeed.rescan(); // 基线：手动扫描算 1 次
      const afterManual = env.counters.qsa - before;
      check('手动 rescan 只扫一次', afterManual, 1);
    }

    // ---- 7. 路由过滤不能把真路由吞掉：SPA 语义必须原样成立 ----
    {
      // 用「真的会改 location」的 history，验证 pushState 补丁仍能识别换页
      const routed = (() => {
        const location = new URL('https://www.bilibili.com/video/BV1AA411c7de');
        const video = createVideo();
        const win = { location, addEventListener: () => {}, removeEventListener: () => {} };
        win.window = win;
        const store = new Map();
        const sessionStorage = {
          getItem: (k) => (store.has(k) ? store.get(k) : null),
          setItem: (k, v) => store.set(k, String(v)),
          removeItem: (k) => store.delete(k),
        };
        const document = {
          documentElement: {}, hidden: false,
          querySelectorAll: (sel) => (sel === 'video' ? [video] : []),
          querySelector: (sel) => (sel === 'video' ? video : null),
          addEventListener: () => {},
        };
        const st = {};
        const sessionApi = {
          get: async (keys) => {
            const o = {};
            if (keys === null) Object.assign(o, st);
            else for (const k of [].concat(keys)) if (k in st) o[k] = st[k];
            return o;
          },
          set: async (obj) => { Object.assign(st, obj); },
          remove: async () => {},
        };
        const chrome = {
          storage: { session: sessionApi, sync: { get: async () => ({}), remove: async () => {} } },
          runtime: {
            lastError: undefined,
            onMessage: { addListener: (fn) => { win.__onMessage = fn; } },
            sendMessage: async () => ({ ok: true, tabId: 1 }),
          },
        };
        const history = {
          pushState(state, title, url) { if (url) location.href = new URL(url, location.href).href; },
          replaceState(state, title, url) { if (url) location.href = new URL(url, location.href).href; },
        };
        const ctx = vm.createContext({
          window: win, document, chrome, location, sessionStorage, crypto, history,
          performance: { getEntriesByType: () => [{ type: 'navigate' }] },
          requestAnimationFrame: (fn) => setTimeout(fn, 0),
          setTimeout, clearTimeout, setInterval, clearInterval,
          console: { info() {}, log() {}, warn() {} },
          Math, Number, Object, JSON, URL, Promise, Date, String,
          MutationObserver: class { observe() {} disconnect() {} },
        });
        vm.runInContext(SRC, ctx, { filename: 'content.js' });
        return { win, video, location, history };
      })();

      await wait(120);
      routed.win.__onMessage({ type: 'bilispeed:set', rate: 4 }, { tab: { id: 1 } }, () => {});
      await wait(600);
      check('路由前设为 4x', routed.video.playbackRate, 4);

      // 同视频切分P（只变 query）-> 身份不变 -> 保持
      routed.history.pushState({}, '', '/video/BV1AA411c7de?p=2');
      await wait(700);
      check('pushState 切分P 保持 4x（路由补刀没被过滤掉）', routed.video.playbackRate, 4);

      // 换视频 -> 清零
      routed.history.pushState({}, '', '/video/BV1ZZ411c7de');
      await wait(700);
      check('pushState 换视频 -> 清零 1x', routed.video.playbackRate, 1);

      // 同页 replaceState 不该影响速度
      routed.history.replaceState({}, '', routed.location.href);
      await wait(300);
      check('同页 replaceState 不影响速度', routed.video.playbackRate, 1);
    }
  }

  console.log('\n[11] 性能自检命令：__bilispeed.profile() 必须在真实页面里可用');
  {
    // 这是给用户/维护者排障用的入口，绝不能是个会抛错或返回 undefined 的花架子，
    // 也绝不能因为“为了测量”而把用户的速度改坏。
    const env = createEnv({
      url: 'https://www.bilibili.com/video/BV1AA411c7de',
      tabId: 4242,
      browser: createBrowserStorage(),
      videos: [createVideo()],
    });
    await wait(120);
    env.popupSend({ type: 'bilispeed:set', rate: 2.5 });
    await wait(60);
    check('自检前先有个非默认速度', env.video.playbackRate, 2.5);

    check('暴露了 profile 方法', typeof env.win.__bilispeed.profile, 'function');
    const stats = await env.win.__bilispeed.profile(400);

    for (const key of ['durationMs', 'mechanism', 'perSecond', 'longTasks', 'videoState', 'rateSwitchCost']) {
      check(`自检结果含 ${key}`, key in stats, true);
    }
    check('mechanism 列出了各监控机制', typeof stats.mechanism.poll, 'number');
    check('mechanism 含 MutationObserver 分类计数',
      typeof stats.mechanism.mutation.total === 'number'
      && typeof stats.mechanism.mutation.videoRelated === 'number', true);
    check('mechanism 含 DOM 查询计数', typeof stats.mechanism.qsa, 'number');
    check('longTasks 结构完整',
      ['count', 'totalMs', 'max'].every((k) => typeof stats.longTasks[k] === 'number'), true);
    check('videoState 先报 playbackRate',
      stats.videoState && typeof stats.videoState.playbackRate === 'number', true);
    check('rateSwitchCost 是数字（不是 NaN/undefined）',
      Number.isFinite(stats.rateSwitchCost.setRateMs)
      && Number.isFinite(stats.rateSwitchCost.setRateBackMs), true);

    // 关键：测量过程必须无损，跑完速度要回到用户设的 2.5x
    check('自检后速度被还原', env.video.playbackRate, 2.5);
    check('自检后 target 也被还原', env.win.__bilispeed.get().target, 2.5);

    // 默认参数不能是 undefined/NaN
    const src = SRC;
    check('profile 有默认时长，不是必填参数', /profile:\s*async\s*\(durationMs\s*=\s*\d+\)/.test(src), true);
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
