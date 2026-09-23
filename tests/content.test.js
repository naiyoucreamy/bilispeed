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

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
