/**
 * 播放器倍速按钮档位条 自测台（仅本地验证用，不属于扩展本体）
 * ------------------------------------------------------------------
 * 跑真实的 speedbar.js（配一套极简 DOM 桩），验证：
 *   1. 清单注册正确（content_scripts 里既有 css 又有 js，document_start）
 *   2. 原生倍速菜单确实被 speedbar.css 藏掉，且只藏 bpx 菜单
 *   3. 点 B 站倍速按钮 -> 弹出档位条，并且原生点击被拦下
 *   4. 档位条位置：右对齐按钮、贴在按钮上方、收在视口内
 *   5. 点档位 -> 走 __bilispeed.set()、点亮当前档、点完收起
 *   6. 再点按钮 / 点别处 / Esc / 按钮离开视口 都能收起
 *   7. 全屏时宿主搬进全屏元素
 *   8. 职责边界：不碰 popup / 悬浮球 / 存储
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'speedbar.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'speedbar.css'), 'utf8');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

const BTN_SELECTOR = '.bpx-player-ctrl-btn.bpx-player-ctrl-playbackrate';

/* ---------------- 极简 DOM 桩 ---------------- */

function createClassList(initial = []) {
  const set = new Set(initial);
  return {
    add: (...names) => names.forEach((c) => set.add(c)),
    remove: (...names) => names.forEach((c) => set.delete(c)),
    contains: (c) => set.has(c),
    toggle(c, force) {
      const on = force === undefined ? !set.has(c) : Boolean(force);
      if (on) set.add(c);
      else set.delete(c);
      return on;
    },
    _all: () => [...set],
  };
}

/** 简化版选择器匹配：支持 .a.b / #id / tag */
function matches(el, selector) {
  if (!el || el.nodeType !== 1) return false;
  if (selector.includes(',')) return selector.split(',').some((s) => matches(el, s.trim()));
  const classes = [...selector.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
  const id = (selector.match(/#([\w-]+)/) || [])[1];
  const tag = (selector.match(/^([a-zA-Z]+)/) || [])[1];
  if (id && el.id !== id) return false;
  if (tag && el.tagName !== tag.toUpperCase()) return false;
  return classes.every((c) => el.classList.contains(c));
}

function createElement(tag = 'div') {
  const el = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    id: '',
    style: { cssText: '' },
    dataset: {},
    classList: createClassList(),
    parentNode: null,
    isConnected: true,
    _children: [],
    _listeners: {},
    _rect: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
    _offsetWidth: 0,
    _offsetHeight: 0,

    addEventListener(type, fn) { (el._listeners[type] ||= []).push(fn); },
    removeEventListener() {},
    _fire(type, event = {}) {
      (el._listeners[type] || []).forEach((fn) => fn(event));
    },
    appendChild(child) {
      child.parentNode = el;
      el._children.push(child);
      return child;
    },
    attachShadow() {
      el._shadow = createElement('shadow-root');
      el._shadow.parentNode = el;
      return el._shadow;
    },
    querySelector(sel) {
      for (const child of el._children) {
        if (matches(child, sel)) return child;
        const deep = child.querySelector && child.querySelector(sel);
        if (deep) return deep;
      }
      return null;
    },
    querySelectorAll(sel) {
      const found = [];
      const walk = (node) => {
        for (const child of node._children || []) {
          if (matches(child, sel)) found.push(child);
          walk(child);
        }
      };
      walk(el);
      return found;
    },
    closest(sel) {
      let node = el;
      while (node) {
        if (node.nodeType === 1 && matches(node, sel)) return node;
        node = node.parentNode;
      }
      return null;
    },
    matches(sel) { return matches(el, sel); },
    getBoundingClientRect() { return el._rect; },
  };

  Object.defineProperty(el, 'offsetWidth', { get: () => el._offsetWidth });
  Object.defineProperty(el, 'offsetHeight', { get: () => el._offsetHeight });

  // className 与 classList 保持同步（真实 DOM 的行为）
  let className = '';
  Object.defineProperty(el, 'className', {
    get: () => className,
    set: (value) => {
      className = String(value);
      className.split(/\s+/).filter(Boolean).forEach((c) => el.classList.add(c));
    },
  });

  // 只需要解析 speedbar.js 用到的那份模板
  Object.defineProperty(el, 'innerHTML', {
    get: () => el._html || '',
    set: (value) => {
      el._html = String(value);
      el._children = [];
      if (value.includes('class="bar"')) {
        const bar = createElement('div');
        bar.className = 'bar';
        bar.parentNode = el;
        for (const hit of value.matchAll(/data-rate="([\d.]+)"/g)) {
          const rateBtn = createElement('button');
          rateBtn.className = 'rate';
          rateBtn.dataset.rate = hit[1];
          bar.appendChild(rateBtn);
        }
        el._children.push(bar);
        el._bar = bar;
      }
    },
  });

  return el;
}

/* ---------------- 环境 ---------------- */

/** 事件在 DOM 里的传播路径（从目标一路向上，模拟 composedPath 的常见形态） */
function pathOf(node) {
  const path = [];
  let current = node;
  while (current) {
    path.push(current);
    current = current.parentNode;
  }
  return path;
}

function createEnv() {
  const winListeners = {};
  const docListeners = {};
  const timers = new Map();
  const timeouts = new Map();
  let timerSeq = 0;

  const body = createElement('body');
  const documentElement = createElement('html');

  const document = {
    readyState: 'complete',
    body,
    documentElement,
    fullscreenElement: null,
    createElement: (tag) => createElement(tag),
    addEventListener(type, fn) { (docListeners[type] ||= []).push(fn); },
    removeEventListener() {},
    querySelector: (sel) => body.querySelector(sel),
    querySelectorAll: (sel) => body.querySelectorAll(sel),
    _fire(type, event = {}) {
      (docListeners[type] || []).forEach((fn) => fn(event));
    },
  };

  const api = {
    target: 1,
    calls: [],
    get() { return { target: api.target }; },
    set(rate) { api.target = rate; api.calls.push(rate); return rate; },
  };

  const win = {
    innerWidth: 1280,
    innerHeight: 800,
    __bilispeed: api,
    addEventListener(type, fn) { (winListeners[type] ||= []).push(fn); },
    removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
    _fire(type, event = {}) {
      (winListeners[type] || []).forEach((fn) => fn(event));
    },
    _count: (type) => (winListeners[type] || []).length,
  };
  win.window = win;

  const ctx = vm.createContext({
    window: win,
    document,
    location: new URL('https://www.bilibili.com/video/BV1AA411c7de'),
    console,
    Math,
    Number,
    Object,
    JSON,
    Date,
    String,
    Boolean,
    Error,
    URL,
    setTimeout(fn) {
      const id = ++timerSeq;
      timeouts.set(id, fn);
      return id;
    },
    clearTimeout(id) { timeouts.delete(id); },
    setInterval(fn) {
      const id = ++timerSeq;
      timers.set(id, fn);
      return id;
    },
    clearInterval(id) { timers.delete(id); },
    requestAnimationFrame(fn) { fn(); return 1; },
    cancelAnimationFrame() {},
  });
  vm.runInContext(SRC, ctx, { filename: 'speedbar.js' });

  const host = body._children[0] || null;
  const shadow = host && host._shadow;
  const bar = shadow && shadow._bar;

  return {
    document,
    body,
    win,
    api,
    host,
    shadow,
    bar,
    timers,
    /** 触发所有登记过的 interval 回调（模拟 watchdog 到点） */
    tickTimers() { for (const fn of [...timers.values()]) fn(); },
    /** 触发所有登记过的 setTimeout 回调（模拟 hover 延迟收起到点） */
    runTimeouts() {
      const pending = [...timeouts.values()];
      timeouts.clear();
      for (const fn of pending) fn();
    },
    click(target) {
      const event = {
        type: 'click',
        target,
        defaultPrevented: false,
        propagationStopped: false,
        preventDefault() { event.defaultPrevented = true; },
        stopPropagation() { event.propagationStopped = true; },
        composedPath() { return pathOf(target); },
      };
      win._fire('click', event);
      return event;
    },
    hover(target, relatedTarget = null) {
      const event = {
        type: 'mouseover',
        target,
        relatedTarget,
        composedPath() { return pathOf(target); },
      };
      win._fire('mouseover', event);
      return event;
    },
    leave(target, relatedTarget = null) {
      const event = {
        type: 'mouseout',
        target,
        relatedTarget,
        composedPath() { return pathOf(target); },
      };
      win._fire('mouseout', event);
      return event;
    },
    key(key) {
      const event = { type: 'keydown', key };
      win._fire('keydown', event);
      return event;
    },
    /** 造一个 B 站倍速按钮并设好位置 */
    makeRateButton(rect = { left: 1000, top: 700, right: 1040, bottom: 730, width: 40, height: 30 }) {
      const btn = createElement('div');
      btn.id = 'bpx-rate-btn';
      btn.className = 'bpx-player-ctrl-btn bpx-player-ctrl-playbackrate';
      btn._rect = rect;
      btn.classList.add('bpx-player-ctrl-btn', 'bpx-player-ctrl-playbackrate');
      return btn;
    },
  };
}

/* ---------------- 断言 ---------------- */

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  // 先比同一性（DOM 节点会形成循环引用，不能直接 JSON.stringify）
  let ok = Object.is(actual, expected);
  if (!ok) {
    try {
      ok = JSON.stringify(actual) === JSON.stringify(expected);
    } catch (err) {
      ok = false;
    }
  }
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}\n        期望: ${JSON.stringify(expected)}\n        实际: ${JSON.stringify(actual)}`);
  }
}

console.log('\n[1] manifest 注册：新入口只加自己，不动原有配置');
{
  const entries = MANIFEST.content_scripts.filter((c) => c.js.includes('speedbar.js'));
  check('speedbar.js 只注册了一条', entries.length, 1);
  const entry = entries[0];
  check('同时注入了 speedbar.css', entry.css, ['speedbar.css']);
  check('只在 B 站页面运行', entry.matches[0], '*://*.bilibili.com/*');
  check('document_start（赶在播放器之前）', entry.run_at, 'document_start');
  check('不在 iframe 里重复注入', entry.all_frames, false);

  const scripts = MANIFEST.content_scripts.flatMap((c) => c.js);
  check('原有四个入口都还在', ['content.js', 'floating.js', 'keys.js', 'shortcut.js'].every((s) => scripts.includes(s)), true);
  check('权限没有被放大', MANIFEST.permissions, ['storage', 'scripting']);
}

console.log('\n[2] 样式：只藏 B 站原生倍速菜单');
{
  check('原生倍速菜单被 display:none !important 藏掉',
    /\.bpx-player-ctrl-playbackrate-menu\s*\{[\s\S]*?display:\s*none\s*!important/.test(CSS), true);
  check('同时禁止它吃鼠标事件',
    /\.bpx-player-ctrl-playbackrate-menu\s*\{[\s\S]*?pointer-events:\s*none/.test(CSS), true);
  check('不碰旧版播放器的菜单（旧版保持原样）', CSS.includes('.bilibili-player-video-btn-speed-menu'), false);
  check('不碰倍速按钮本身', /\.bpx-player-ctrl-playbackrate\s*\{/.test(CSS), false);
}

console.log('\n[3] 启动：宿主挂在 body 末尾，监听都在捕获阶段');
{
  const env = createEnv();
  check('宿主已挂到 body 末尾', env.body._children.includes(env.host), true);
  check('宿主不影响页面布局（fixed + all:initial）',
    /position:\s*fixed/.test(env.host.style.cssText) && /all:\s*initial/.test(env.host.style.cssText), true);
  check('注册了 window click 监听', env.win._count('click') > 0, true);
  check('注册了 window mouseover 监听（悬停也能开）', env.win._count('mouseover') > 0, true);
  check('注册了 window mouseout 监听（离开才收）', env.win._count('mouseout') > 0, true);
  check('注册了 window keydown 监听', env.win._count('keydown') > 0, true);
  check('档位条默认收起', env.bar.classList.contains('is-open'), false);
  check('档位是插件原有的 8 档，从快到慢排列', env.bar.querySelectorAll('.rate').map((b) => b.dataset.rate),
    ['16', '8', '4', '3', '2', '1.5', '1', '0.5']);
  check('档位竖排成一列', /flex-direction:\s*column/.test(SRC), true);
  check('档位条是窄条（一列按钮的宽度）', /width:\s*54px/.test(SRC), true);
}

console.log('\n[4] 点 B 站倍速按钮 -> 弹出档位条并拦下原生点击');
{
  const env = createEnv();
  const btn = env.makeRateButton();
  env.bar._offsetWidth = 54;
  env.bar._offsetHeight = 285;

  const event = env.click(btn);
  check('档位条展开', env.bar.classList.contains('is-open'), true);
  check('原生点击被拦下（preventDefault）', event.defaultPrevented, true);
  check('原生点击不再往下传（stopPropagation）', event.propagationStopped, true);

  // 右对齐按钮：1040 - 54 = 986；贴在按钮上方：700 - 285 - 8 = 407
  check('右对齐按钮右边缘', env.bar.style.left, '986px');
  check('贴在按钮正上方', env.bar.style.top, '407px');

  // 按下时 hover 通常已经打开过了：点击只保证「是开的」，不会一按就关
  env.click(btn);
  check('按下来时保持打开（不会一按就关）', env.bar.classList.contains('is-open'), true);
}

console.log('\n[4b] 悬停也弹；离开后延迟收起，进档位条不收起');
{
  const env = createEnv();
  env.bar._offsetWidth = 54;
  env.bar._offsetHeight = 285;
  const btn = env.makeRateButton();
  const video = createElement('video');

  env.hover(btn);
  check('鼠标放上去就展开', env.bar.classList.contains('is-open'), true);

  env.leave(btn, video);
  check('刚离开还没收（留出挪到档位条的时间）', env.bar.classList.contains('is-open'), true);
  env.runTimeouts();
  check('延迟到点后收起', env.bar.classList.contains('is-open'), false);

  // 从按钮挪到档位条上：这次不算离开，不能收
  env.hover(btn);
  env.leave(btn, env.host);
  env.runTimeouts();
  check('鼠标进档位条时不收起', env.bar.classList.contains('is-open'), true);

  // 从档位条再移出去：延迟收起
  const three = env.bar.querySelectorAll('.rate').find((b) => b.dataset.rate === '3');
  env.leave(three, video);
  env.runTimeouts();
  check('从档位条移出后收起', env.bar.classList.contains('is-open'), false);

  // 鼠标在页面别处晃：不打扰已经打开的档位条
  env.hover(btn);
  const other = createElement('div');
  env.hover(other);
  env.leave(other, video);
  env.runTimeouts();
  check('鼠标在别处晃动不会误收', env.bar.classList.contains('is-open'), true);
}

console.log('\n[5] 位置：左右收在视口内，上方放不下时翻到下方');
{
  const env = createEnv();
  env.bar._offsetWidth = 54;
  env.bar._offsetHeight = 285;

  // 按钮贴右边：右对齐后仍在视口内
  const right = env.makeRateButton({ left: 1265, top: 700, right: 1275, bottom: 730, width: 10, height: 30 });
  env.click(right);
  check('不越出右边界', env.bar.style.left, `${1280 - 54 - 8}px`);

  // 按钮贴顶：上方放不下，翻到下方
  const top = env.makeRateButton({ left: 1000, top: 5, right: 1040, bottom: 35, width: 40, height: 30 });
  env.click(top);
  check('上方放不下时翻到按钮下方', env.bar.style.top, `${35 + 8}px`);

  // 按钮贴左：不越出左边界
  const left = env.makeRateButton({ left: 2, top: 700, right: 42, bottom: 730, width: 40, height: 30 });
  env.click(left);
  check('不越出左边界', env.bar.style.left, '8px');
}

console.log('\n[6] 点档位 -> 走 __bilispeed.set()，点完收起');
{
  const env = createEnv();
  env.bar._offsetWidth = 54;
  env.bar._offsetHeight = 285;
  const btn = env.makeRateButton();
  env.click(btn);

  const three = env.bar.querySelectorAll('.rate').find((b) => b.dataset.rate === '3');
  const event = {
    type: 'click',
    target: three,
    stopPropagation() {},
    preventDefault() {},
    composedPath() { return [three, env.host]; },
  };
  env.bar._fire('click', event);

  check('下发了一次 3 倍速', env.api.calls, [3]);
  check('目标是 3 倍速', env.api.target, 3);
  check('点完收起（和原生菜单一致）', env.bar.classList.contains('is-open'), false);
  check('3x 档位被点亮', three.classList.contains('is-active'), true);
}

console.log('\n[7] 打开时高亮当前速度');
{
  const env = createEnv();
  env.api.target = 2;
  env.bar._offsetWidth = 54;
  env.bar._offsetHeight = 285;
  env.click(env.makeRateButton());
  const active = env.bar.querySelectorAll('.rate').filter((b) => b.classList.contains('is-active'));
  check('只有 2x 被点亮', active.map((b) => b.dataset.rate), ['2']);
}

console.log('\n[8] 收起：点别处 / Esc / 按钮离开视口');
{
  const env = createEnv();
  env.bar._offsetWidth = 54;
  env.bar._offsetHeight = 285;
  const btn = env.makeRateButton();

  env.click(btn);
  const outside = createElement('div');
  env.click(outside);
  check('点页面别处收起', env.bar.classList.contains('is-open'), false);

  env.click(btn);
  env.key('Escape');
  check('Esc 收起', env.bar.classList.contains('is-open'), false);
  env.key('Enter');
  check('其它按键不影响', env.bar.classList.contains('is-open'), false);

  env.click(btn);
  btn._rect = { left: 1000, top: 2000, right: 1040, bottom: 2030, width: 40, height: 30 };
  env.tickTimers();
  check('按钮滚出视口后自动收起', env.bar.classList.contains('is-open'), false);
}

console.log('\n[9] 全屏：宿主搬进全屏元素');
{
  const env = createEnv();
  const fsEl = createElement('div');
  env.document.fullscreenElement = fsEl;
  env.document._fire('fullscreenchange');
  check('全屏时宿主挂进全屏元素', env.host.parentNode, fsEl);

  env.document.fullscreenElement = null;
  env.document._fire('fullscreenchange');
  check('退出全屏后回到 body', env.host.parentNode, env.body);
}

console.log('\n[10] 找不到倍速按钮时不折腾（悬浮球仍是完整入口）');
{
  const env = createEnv();
  const other = createElement('div');
  other.className = 'some-other-button';
  const event = env.click(other);
  check('普通点击不会弹出档位条', env.bar.classList.contains('is-open'), false);
  check('也不会拦截页面点击', event.defaultPrevented, false);
  check('普通点击不会触发改速', env.api.calls, []);
}

console.log('\n[11] 职责边界：只加这一个入口，不碰别的');
{
  const code = SRC
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, ''))
    .join('\n');
  for (const banned of ['popup.html', '__BILISPEED_FLOATING_LOADED__', 'bilispeed:panelHello']) {
    check(`不碰悬浮球 / 弹窗：${banned}`, code.includes(banned), false);
  }
  check('不直接写存储（速度仍由 content.js 负责）', /chrome\.storage/.test(code), false);
  check('改速只走 __bilispeed.set', /__bilispeed/.test(code) && /\.set\(/.test(code), true);
  check('没有第二条调速逻辑（不直接写 playbackRate 主路径）',
    /playbackRate\s*=/.test(code.replace(/video\.playbackRate\s*=\s*rate/g, '')), false);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
