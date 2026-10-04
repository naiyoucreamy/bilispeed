/**
 * 快捷键自测台（仅本地验证用，不属于扩展本体）
 * ------------------------------------------------------------------
 * 跑真实的 keys.js + shortcut.js（配一套极简 DOM 桩），验证：
 *   1. 清单注册：词汇表先于监听脚本、两者都只在 B 站页面
 *   2. 词汇表本身：默认键位、按键显示文本、修饰键精确匹配、脏配置退回默认
 *   3. 默认键位真的能改倍速：] 加速、[ 减速、\ 重置
 *   4. 步长生效、到边界停住不动
 *   5. 该让路的时候让路：输入框里、本页没有视频、没绑定的键、输入法组合中
 *   6. 右下角提示：内容正确、1.2 秒后收起、连续按键重新计时、不吃鼠标事件
 *   7. 配置来自 sync 区域，改完立刻生效（不用刷新页面）
 *   8. 全屏时照常生效，提示也跟着进全屏层
 *   9. 职责边界：不碰 <video>、不自己写 playbackRate，改速一律走 __bilispeed
 *  10. 设置界面与页面脚本共用同一份键位定义（不重复实现）
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const KEYS_SRC = fs.readFileSync(path.join(ROOT, 'keys.js'), 'utf8');
const SHORTCUT_SRC = fs.readFileSync(path.join(ROOT, 'shortcut.js'), 'utf8');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const HTML = fs.readFileSync(path.join(ROOT, 'popup.html'), 'utf8');
const POPUP = fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8');

/* ---------------- 极简 DOM 桩 ---------------- */

function matchSel(el, selector) {
  if (selector.startsWith('.')) return el.classList.contains(selector.slice(1));
  if (selector.startsWith('#')) return el.id === selector.slice(1);
  return el.tagName === selector.toUpperCase();
}

function createElement(tag = 'div', id = '') {
  const listeners = {};
  const attrs = {};
  const children = [];
  const classes = new Set();

  const el = {
    tagName: tag.toUpperCase(),
    id,
    nodeType: 1,
    textContent: '',
    style: { cssText: '' },
    dataset: {},
    parentNode: null,
    isContentEditable: false,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle(c, force) {
        if (force === undefined) { classes.has(c) ? classes.delete(c) : classes.add(c); return classes.has(c); }
        force ? classes.add(c) : classes.delete(c);
        return force;
      },
      _all: () => [...classes],
    },
    setAttribute: (k, v) => { attrs[k] = String(v); },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    removeEventListener: () => {},
    // 直接把原事件对象交给监听器：preventDefault / stopPropagation 记在原对象上，
    // 桩外面才断言得到（复制一份的话 this 就指到副本去了）
    _fire: (type, event = {}) => {
      if (event.type === undefined) event.type = type;
      (listeners[type] || []).forEach((fn) => fn(event));
    },
    _count: (type) => (listeners[type] || []).length,
    appendChild: (child) => {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = el;
      children.push(child);
      return child;
    },
    removeChild: (child) => {
      const i = children.indexOf(child);
      if (i !== -1) children.splice(i, 1);
      child.parentNode = null;
      return child;
    },
    _children: children,
    attachShadow: () => { el._shadow = createElement('shadow-root'); return el._shadow; },
    querySelector: (sel) => children.find((c) => matchSel(c, sel)) || null,
    querySelectorAll: (sel) => children.filter((c) => matchSel(c, sel)),
  };

  // className 与 classList 保持同步（真实 DOM 的行为）
  let className = '';
  Object.defineProperty(el, 'className', {
    get: () => className,
    set: (value) => { className = String(value); classes.add(className); },
  });

  // innerHTML：shortcut.js 只用它塞 <style> 与 .toast 两个子元素
  Object.defineProperty(el, 'innerHTML', {
    get: () => el._html || '',
    set: (value) => {
      el._html = String(value);
      children.length = 0;
      const style = createElement('style');
      style.textContent = value; // 桩里整段存下来，便于检查 CSS 契约
      const toast = createElement('div');
      toast.className = 'toast';
      el.appendChild(style);
      el.appendChild(toast);
    },
  });

  return el;
}

/** 模拟一次 keydown */
function keyEvent(code, options = {}) {
  const target = options.target || null;
  const event = {
    type: 'keydown',
    code,
    key: options.key !== undefined ? options.key : code,
    ctrlKey: options.ctrl === true,
    altKey: options.alt === true,
    shiftKey: options.shift === true,
    metaKey: options.meta === true,
    isComposing: options.isComposing === true,
    target,
    composedPath: () => (target ? [target] : []),
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
  };
  return event;
}

/** 假 <video>：只用来回答“本页有没有视频” */
function createVideo() {
  return { tagName: 'VIDEO', nodeType: 1 };
}

/* ---------------- 倍速接口桩（语义与 content.js 对齐） ---------------- */

function createRateApi(state) {
  const MIN = 0.25;
  const MAX = 16;
  const STEP = 0.25;
  const normalize = (value) => {
    const num = Number(value);
    if (!Number.isFinite(num)) return 1;
    const clamped = Math.min(MAX, Math.max(MIN, num));
    return Math.round(Math.round(clamped / STEP) * STEP * 100) / 100;
  };
  return {
    get: () => ({ ok: true, target: state.target, hasVideo: state.hasVideo }),
    set: (rate) => {
      state.target = normalize(rate);
      state.sets.push(state.target);
      return state.target;
    },
    reset: () => {
      state.target = 1;
      state.resets += 1;
      return 1;
    },
    rescan: () => {},
  };
}

/* ---------------- 环境 ---------------- */

function createEnv({
  bindings = null,
  step = null,
  hasVideo = true,
  rate = 1,
  apiWorks = true,
  syncBroken = false,
  video = true,
} = {}) {
  const state = { target: rate, hasVideo, sets: [], resets: 0 };
  const config = {};
  if (bindings) config['bilispeed.shortcuts'] = bindings;
  if (step !== null) config['bilispeed.step'] = step;

  const docListeners = {};
  const videoEl = video ? createVideo() : null;
  const document = {
    documentElement: createElement('html'),
    body: createElement('body'),
    hidden: false,
    fullscreenElement: null,
    createElement: (tag) => createElement(tag),
    addEventListener: (t, fn) => { (docListeners[t] ||= []).push(fn); },
    removeEventListener: () => {},
    querySelector: (sel) => (sel === 'video' ? videoEl : null),
    querySelectorAll: () => [],
    // 同上：事件对象原样传给监听器，preventDefault 的效果才留在外面这个对象上
    _fire: (t, event = {}) => {
      if (event.type === undefined) event.type = t;
      (docListeners[t] || []).forEach((fn) => fn(event));
    },
    _listenerCount: (t) => (docListeners[t] || []).length,
  };

  const onChangedListeners = [];
  const written = [];
  const chrome = {
    storage: {
      sync: {
        get: async (keys) => {
          if (syncBroken) throw new Error('storage unavailable');
          const out = {};
          for (const k of [].concat(keys)) if (k in config) out[k] = config[k];
          return out;
        },
        set: async (obj) => { Object.assign(config, obj); written.push(obj); },
      },
      onChanged: { addListener: (fn) => onChangedListeners.push(fn) },
    },
  };

  const win = {};
  win.window = win;
  win.top = win;
  if (apiWorks) win.__bilispeed = createRateApi(state);

  const ctx = vm.createContext({
    window: win,
    document,
    chrome,
    setTimeout,
    clearTimeout,
    console,
    Date,
  });
  vm.runInContext(KEYS_SRC, ctx, { filename: 'keys.js' });
  vm.runInContext(SHORTCUT_SRC, ctx, { filename: 'shortcut.js' });

  const hosts = () => [
    ...document.body._children,
    ...(document.fullscreenElement ? document.fullscreenElement._children : []),
  ];
  const host = hosts().find((c) => c.id === 'bilispeed-shortcut-root') || null;
  const shadow = host ? host._shadow : null;
  const toast = shadow ? shadow.querySelector('.toast') : null;

  return {
    win, document, chrome, state, config, written,
    host, shadow, toast,
    keys: win.__BILISPEED_KEYS__,
    /** 从 document 上派发一次 keydown（shortcut.js 就监听在这儿） */
    press: (event) => document._fire('keydown', event),
    /** 模拟设置界面改了配置（storage.onChanged） */
    emitChange: (changes, area = 'sync') => onChangedListeners.forEach((fn) => fn(changes, area)),
    hostParent: () => (host ? host.parentNode : null),
  };
}

/* ---------------- 设置界面环境（真跑 popup.js + keys.js） ---------------- */

function createPopupEnv({ rate = 1, stored = {} } = {}) {
  const ids = [...HTML.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  const hiddenIds = new Set([...HTML.matchAll(/id="([^"]+)"([^>]*)>/g)]
    .filter((m) => /\bhidden\b/.test(m[2]))
    .map((m) => m[1]));

  const elements = new Map();
  for (const id of ids) {
    const el = createElement('div', id);
    el.hidden = hiddenIds.has(id);
    el.value = '';
    el.checked = false;
    el.disabled = false;
    elements.set(id, el);
  }
  const presets = [...HTML.matchAll(/class="preset"[^>]*data-rate="([\d.]+)"/g)].map((m) => {
    const btn = createElement('button', `preset-${m[1]}`);
    btn.dataset.rate = m[1];
    return btn;
  });

  const config = { ...stored };
  const written = [];
  const sentMessages = [];
  const docListeners = {};

  const root = {
    style: { props: {}, setProperty(k, v) { this.props[k] = v; } },
    setAttribute() {},
    getAttribute() { return null; },
    classList: { add() {}, contains() { return false; } },
  };

  const document = {
    documentElement: root,
    body: createElement('body'),
    getElementById: (id) => elements.get(id) || null,
    querySelectorAll: (sel) => (sel === '.preset' ? presets : []),
    addEventListener: (t, fn) => { (docListeners[t] ||= []).push(fn); },
    removeEventListener: () => {},
    _fire: (t, event = {}) => {
      if (event.type === undefined) event.type = t;
      (docListeners[t] || []).forEach((fn) => fn(event));
    },
  };

  const store = new Map();
  const chrome = {
    tabs: {
      query: async () => [{ id: 1, url: 'https://www.bilibili.com/video/BV1AA411c7de' }],
      sendMessage: (id, message, cb) => {
        if (message.type === 'bilispeed:get') {
          cb({ ok: true, target: rate, actual: rate, hasVideo: true });
          return;
        }
        sentMessages.push({ tabId: id, ...message });
        cb({ ok: true, rate: message.rate });
      },
    },
    runtime: { lastError: undefined, getManifest: () => ({ version: '2.2.0' }) },
    scripting: { executeScript: async () => [] },
    storage: {
      sync: {
        get: async (keys) => {
          const out = {};
          for (const k of [].concat(keys)) if (k in config) out[k] = config[k];
          return out;
        },
        set: async (obj) => { Object.assign(config, obj); written.push(JSON.parse(JSON.stringify(obj))); },
      },
    },
  };

  const win = { addEventListener: () => {}, removeEventListener: () => {} };
  const ctx = vm.createContext({
    window: win,
    document,
    chrome,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    console,
    setTimeout,
    clearTimeout,
    Date,
  });
  vm.runInContext(KEYS_SRC, ctx, { filename: 'keys.js' });
  vm.runInContext(POPUP, ctx, { filename: 'popup.js' });

  return {
    document, written, sentMessages, config,
    el: (id) => elements.get(id),
    /** 在设置界面里敲一下键盘（录制走的就是这条链路） */
    pressKey: (event) => document._fire('keydown', event),
  };
}

/* ---------------- 断言 ---------------- */

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}\n        期望: ${JSON.stringify(expected)}\n        实际: ${JSON.stringify(actual)}`); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 去掉注释后的代码，用来守住“职责边界”这类断言 */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((line) => line.replace(/(^|\s)\/\/.*$/, ''))
  .join('\n');

const SHORTCUT_CODE = stripComments(SHORTCUT_SRC);
const KEYS_CODE = stripComments(KEYS_SRC);

(async () => {
  console.log('\n[1] manifest 注册：词汇表 + 监听脚本，且不放大权限');
  {
    const scripts = MANIFEST.content_scripts.flatMap((c) => c.js);
    check('content.js 仍在第一位', scripts[0], 'content.js');
    check('keys.js 与 shortcut.js 都已注册',
      scripts.includes('keys.js') && scripts.includes('shortcut.js'), true);
    check('keys.js 排在 shortcut.js 之前（先有词汇表再听键盘）',
      scripts.indexOf('keys.js') < scripts.indexOf('shortcut.js'), true);
    check('新增脚本不影响 floating.js 的位置',
      scripts.indexOf('floating.js') < scripts.indexOf('keys.js'), true);
    check('三个脚本条目都只匹配 B 站页面',
      MANIFEST.content_scripts.every((c) => c.matches.join() === '*://*.bilibili.com/*'), true);
    check('三个脚本条目都在 document_start',
      MANIFEST.content_scripts.every((c) => c.run_at === 'document_start'), true);
    check('权限没有被放大', MANIFEST.permissions, ['storage', 'scripting']);
    check('扩展版本没被顺手改掉', MANIFEST.version, '2.2.0');
  }

  console.log('\n[2] 词汇表：默认键位、显示文本、匹配规则');
  {
    const env = createEnv();
    const K = env.keys;
    check('词汇表挂上了 window', typeof K, 'object');
    check('界面与页面共用同一份默认键位',
      K.ACTIONS.map((a) => K.describeBinding(K.DEFAULT_BINDINGS[a])), [']', '[', '\\']);
    check('默认加速是 ]（物理键位 BracketRight）', K.DEFAULT_BINDINGS.faster.code, 'BracketRight');
    check('默认减速是 [（物理键位 BracketLeft）', K.DEFAULT_BINDINGS.slower.code, 'BracketLeft');
    check('默认重置是 \\（物理键位 Backslash）', K.DEFAULT_BINDINGS.reset.code, 'Backslash');

    check('字母键显示成字母', K.describeBinding({ code: 'KeyF' }), 'F');
    check('数字键显示成数字', K.describeBinding({ code: 'Digit3' }), '3');
    check('方向键显示成箭头', K.describeBinding({ code: 'ArrowUp' }), '↑');
    check('空格有中文名', K.describeBinding({ code: 'Space' }), '空格');
    check('组合键按修饰键顺序显示', K.describeBinding({ code: 'KeyK', ctrl: true, shift: true }), 'Ctrl+Shift+K');
    check('认不出的键位原样显示，不显示成空白', K.describeBinding({ code: 'IntlYen' }), 'IntlYen');

    check('空绑定显示「未设置」', K.describeBinding(null), '未设置');

    // --- 修饰键：录制时不能把 Shift 本身录成快捷键 ---
    check('单独按 Shift 不算一个键', K.bindingFromEvent(keyEvent('ShiftLeft', { shift: true })), null);
    check('单独按 Ctrl 不算一个键', K.bindingFromEvent(keyEvent('ControlLeft', { ctrl: true })), null);
    check('组合键会被完整记下',
      K.bindingFromEvent(keyEvent('KeyK', { ctrl: true, shift: true })),
      { code: 'KeyK', ctrl: true, alt: false, shift: true, meta: false });

    // --- 匹配：修饰键精确匹配 ---
    const slower = K.DEFAULT_BINDINGS.slower;
    check('平原的 [ 命中', K.matchesBinding(slower, keyEvent('BracketLeft')), true);
    check('Shift+[ 不命中（避免和另一个动作撞车）',
      K.matchesBinding(slower, keyEvent('BracketLeft', { shift: true })), false);
    check('别的键不命中', K.matchesBinding(slower, keyEvent('KeyD')), false);
    check('绑成 Ctrl+B 后，单独的 B 不命中',
      K.matchesBinding({ code: 'KeyB', ctrl: true }, keyEvent('KeyB')), false);
    check('绑成 Ctrl+B 后，Ctrl+B 命中',
      K.matchesBinding({ code: 'KeyB', ctrl: true }, keyEvent('KeyB', { ctrl: true })), true);

    // --- 脏配置一律退回默认，不让某个动作彻底失灵 ---
    const dirty = K.normalizeBindings({ faster: { code: '' }, slower: 'nonsense', reset: null });
    check('脏配置退回默认键位',
      dirty.faster.code === 'BracketRight' && dirty.slower.code === 'BracketLeft' && dirty.reset.code === 'Backslash',
      true);
    const kept = K.normalizeBindings({ faster: { code: 'KeyF', alt: true } });
    check('合法配置被保留', kept.faster, { code: 'KeyF', ctrl: false, alt: true, shift: false, meta: false });
    check('没配的动作补默认', kept.reset.code, 'Backslash');

    // --- 步长：0.25 ~ 16，粒度 0.25 ---
    check('步长默认 0.25', K.DEFAULT_STEP, 0.25);
    check('步长下限 0.25', K.normalizeStep(0), 0.25);
    check('步长上限 16', K.normalizeStep(99), 16);
    check('步长对齐 0.25', K.normalizeStep(1.1), 1);
    check('步长消除浮点误差', K.normalizeStep(0.1 + 0.2), 0.25);
    check('步长非数字退回默认', K.normalizeStep('abc'), 0.25);
  }

  console.log('\n[3] 默认键位真的能改倍速，并且会拦下这次按键');
  {
    const env = createEnv({ rate: 1 });
    await wait(20);
    check('提示默认不显示', env.toast.classList.contains('is-shown'), false);

    const up = keyEvent('BracketRight');
    env.press(up);
    check('按 ] 加速 0.25', env.state.target, 1.25);
    check('提示显示 1.25x', env.toast.textContent, '1.25x');
    check('提示已浮现', env.toast.classList.contains('is-shown'), true);
    check('拦下了这次按键（不再冒泡给页面）', up.propagationStopped, true);
    check('阻止了默认行为（页面不会当成自己的快捷键）', up.defaultPrevented, true);

    const down = keyEvent('BracketLeft', { shift: false });
    env.press(down);
    check('按 [ 减速回来', env.state.target, 1);
    check('提示跟着更新', env.toast.textContent, '1.00x');

    env.press(keyEvent('BracketRight'));
    env.press(keyEvent('BracketRight'));
    check('连按两次 ] 到 1.5', env.state.target, 1.5);

    env.press(keyEvent('Backslash'));
    check('按 \\ 重置为 1x', env.state.target, 1);
    check('重置走的是 reset（不是 set 1）', env.state.resets, 1);
    check('重置也给了提示', env.toast.textContent, '1.00x');
  }

  console.log('\n[4] 步长：按一次走多远由设置决定');
  {
    const env = createEnv({ rate: 1, step: 2 });
    await wait(20);
    env.press(keyEvent('BracketRight'));
    check('步长 2：1x -> 3x', env.state.target, 3);
    check('提示显示 3.00x', env.toast.textContent, '3.00x');
    env.press(keyEvent('BracketLeft'));
    check('步长 2：3x -> 1x', env.state.target, 1);

    const env2 = createEnv({ rate: 8, step: 16 });
    await wait(20);
    env2.press(keyEvent('BracketLeft'));
    check('步长 16：8x -> 0.25x（被下限接住）', env2.state.target, 0.25);
  }

  console.log('\n[5] 边界：到顶到底就停住，不循环也不越界');
  {
    const env = createEnv({ rate: 16 });
    await wait(20);
    env.press(keyEvent('BracketRight'));
    check('16x 再加速仍是 16x', env.state.target, 16);
    check('提示仍是 16.00x', env.toast.textContent, '16.00x');

    const low = createEnv({ rate: 0.25 });
    await wait(20);
    low.press(keyEvent('BracketLeft'));
    check('0.25x 再减速仍是 0.25x', low.state.target, 0.25);
  }

  console.log('\n[6] 该让路的时候让路：输入框、没视频、没绑定的键');
  {
    // --- 输入框里打字不能触发 ---
    for (const [label, tag] of [['弹幕/搜索用的 <input>', 'input'], ['评论用的 <textarea>', 'textarea']]) {
      const env = createEnv({ rate: 1 });
      await wait(20);
      const field = createElement(tag);
      const event = keyEvent('BracketRight', { target: field });
      env.press(event);
      check(`${label} 里按键不加速`, env.state.target, 1);
      check(`${label} 里按键不拦（正常输入）`, event.defaultPrevented, false);
    }

    const envCE = createEnv({ rate: 1 });
    await wait(20);
    const editable = createElement('div');
    editable.isContentEditable = true;
    envCE.press(keyEvent('BracketRight', { target: editable }));
    check('可编辑区域里按键不加速', envCE.state.target, 1);

    // --- 本页没有视频：不拦、不提示 ---
    const noVideo = createEnv({ rate: 1, hasVideo: false });
    await wait(20);
    const ev = keyEvent('BracketRight');
    noVideo.press(ev);
    check('没有视频时不改速', noVideo.state.target, 1);
    check('没有视频时不拦按键', ev.defaultPrevented, false);
    check('没有视频时不弹提示', noVideo.toast.classList.contains('is-shown'), false);
    check('没有视频时也没调过 set', noVideo.state.sets, []);

    // --- 没绑定的键：完全不管 ---
    const env2 = createEnv({ rate: 1 });
    await wait(20);
    const other = keyEvent('KeyD');
    env2.press(other);
    check('没绑定的键不拦', other.defaultPrevented, false);
    check('没绑定的键不改速', env2.state.sets, []);

    // --- 输入法组合中 ---
    const env3 = createEnv({ rate: 1 });
    await wait(20);
    env3.press(keyEvent('BracketRight', { isComposing: true }));
    check('输入法组合中的按键不触发', env3.state.target, 1);

    // --- 倍速接口还没就绪（页面刚打开）：不崩、不拦 ---
    const env4 = createEnv({ rate: 1, apiWorks: false });
    await wait(20);
    const ev4 = keyEvent('BracketRight');
    env4.press(ev4);
    check('接口没就绪时不拦按键', ev4.defaultPrevented, false);
    check('接口没就绪时界面照常（没抛错）', Boolean(env4.host), true);
  }

  console.log('\n[7] 右下角提示：内容、时长、连续按键重新计时');
  {
    const env = createEnv({ rate: 4 });
    await wait(20);
    env.press(keyEvent('BracketRight'));
    check('提示内容是当前速度', env.toast.textContent, '4.25x');
    await wait(1250);
    check('约 1.2 秒后自己收起', env.toast.classList.contains('is-shown'), false);

    // 连续按键：第二次要把计时器重置，不能提前消失
    env.press(keyEvent('BracketRight'));
    await wait(800);
    env.press(keyEvent('BracketRight'));
    await wait(800);
    check('连续按键时重新计时（后一次仍显示中）', env.toast.classList.contains('is-shown'), true);
    await wait(500);
    check('最后一次之后照样收起', env.toast.classList.contains('is-shown'), false);

    // 位置与手感：右下角、悬浮按钮上方、不吃鼠标事件
    const css = env.shadow.querySelector('style').textContent;
    check('提示固定在右下角', /\.toast\s*\{[\s\S]*?position:\s*fixed[\s\S]*?right:\s*12px/.test(css), true);
    check('提示在悬浮按钮上方（bottom: 52px）', /\.toast\s*\{[\s\S]*?bottom:\s*52px/.test(css), true);
    check('提示不吃鼠标事件', /\.toast\s*\{[\s\S]*?pointer-events:\s*none/.test(css), true);
    check('提示样式只在 Shadow DOM 内（不污染页面）',
      env.host.id === 'bilispeed-shortcut-root' && /all:\s*initial/.test(env.host.style.cssText), true);
    check('动效可被系统设置关掉', /prefers-reduced-motion/.test(css), true);
  }

  console.log('\n[8] 配置：从 sync 读、改完立刻生效，不刷新页面');
  {
    // --- 自定义键位在加载时就生效 ---
    const custom = createEnv({
      rate: 1,
      bindings: { faster: { code: 'KeyF' }, slower: { code: 'KeyS' }, reset: { code: 'KeyR' } },
    });
    await wait(20);
    custom.press(keyEvent('BracketRight'));
    check('改过键位后，旧的 ] 不再加速', custom.state.target, 1);
    custom.press(keyEvent('KeyF'));
    check('新键 F 生效', custom.state.target, 1.25);
    custom.press(keyEvent('KeyS'));
    check('新键 S 减速', custom.state.target, 1);
    custom.press(keyEvent('KeyR'));
    check('新键 R 重置', custom.state.resets, 1);

    // --- 只改了部分动作：其余补默认 ---
    const partial = createEnv({ rate: 2, bindings: { faster: { code: 'Period' } } });
    await wait(20);
    partial.press(keyEvent('BracketLeft'));
    check('没配的动作仍是默认键（[ 减速）', partial.state.target, 1.75);

    // --- 步长从配置读 ---
    const stepped = createEnv({ rate: 1, step: 0.5 });
    await wait(20);
    stepped.press(keyEvent('BracketRight'));
    check('步长取自配置', stepped.state.target, 1.5);

    // --- 设置界面里改完立刻生效（storage.onChanged）---
    const live = createEnv({ rate: 1 });
    await wait(20);
    live.emitChange({
      'bilispeed.shortcuts': { newValue: { faster: { code: 'Equal' } } },
      'bilispeed.step': { newValue: 4 },
    });
    live.press(keyEvent('BracketRight'));
    check('改键位后旧的 ] 立刻失效', live.state.target, 1);
    live.press(keyEvent('Equal'));
    check('新键立刻生效', live.state.target, 5);
    live.press(keyEvent('Equal'));
    check('新步长（4）立刻生效', live.state.target, 9);

    // --- 别的区域变化不该影响它 ---
    live.emitChange({ 'bilispeed.rate.abc': { newValue: 8 } }, 'session');
    live.press(keyEvent('Equal'));
    check('session 区域的变化被忽略', live.state.target, 13);

    // --- 存储读不到时退回默认键位，功能照旧 ---
    const broken = createEnv({ rate: 1, syncBroken: true });
    await wait(20);
    broken.press(keyEvent('BracketRight'));
    check('存储不可用时用默认键位继续工作', broken.state.target, 1.25);
  }

  console.log('\n[9] 全屏：照常生效，提示跟到全屏层里');
  {
    const env = createEnv({ rate: 2 });
    await wait(20);
    check('平时挂在 body 里', env.hostParent() === env.document.body, true);

    const stage = createElement('div', 'bilibili-player-fullscreen');
    env.document.fullscreenElement = stage;
    env.document._fire('fullscreenchange');
    check('进全屏后提示搬进全屏层', env.hostParent() === stage, true);

    env.press(keyEvent('BracketRight'));
    check('全屏时快捷键照常生效', env.state.target, 2.25);
    check('全屏时提示照常显示', env.toast.classList.contains('is-shown'), true);

    env.document.fullscreenElement = null;
    env.document._fire('fullscreenchange');
    check('退出全屏后搬回 body', env.hostParent() === env.document.body, true);
  }

  console.log('\n[10] 职责边界：不碰 <video>，改速只走 __bilispeed');
  {
    for (const banned of ['playbackRate', 'chrome.tabs', 'chrome.storage.session', 'chrome.runtime.sendMessage']) {
      check(`代码里不出现 ${banned}`, SHORTCUT_CODE.includes(banned), false);
    }
    check('改速走 content.js 暴露的接口', /__bilispeed/.test(SHORTCUT_CODE), true);
    check('词汇表里也不碰 DOM 与存储',
      /document\.|chrome\./.test(KEYS_CODE), false);
    check('没有自己发明第二套速度范围（上下限仍由 content.js 钳制）',
      /MAX_RATE|MIN_RATE/.test(SHORTCUT_CODE), false);
    check('监听挂在捕获阶段（抢在站点之前定价）',
      /addEventListener\('keydown', onKeydown, true\)/.test(SHORTCUT_CODE), true);
    check('重复注入时不会挂上第二份监听',
      /__BILISPEED_SHORTCUT_LOADED__/.test(SHORTCUT_CODE), true);
  }

  console.log('\n[11] 设置界面：与页面脚本共用同一份键位定义');
  {
    for (const id of ['shortcutsBtn', 'shortcutsView', 'shortcutsBackBtn',
      'keyFaster', 'keySlower', 'keyReset', 'stepSlider', 'stepValue']) {
      check(`存在 #${id}`, HTML.includes(`id="${id}"`), true);
    }
    check('快捷键入口在设置界面里（排在「关于」之前）',
      HTML.indexOf('id="shortcutsBtn"') < HTML.indexOf('id="aboutBtn"')
      && HTML.indexOf('id="shortcutsBtn"') > HTML.indexOf('id="settingsView"'), true);
    check('这一屏初始 hidden', /id="shortcutsView"[^>]*hidden/.test(HTML), true);
    check('三颗按键胶囊的静态兜底就是默认键位',
      /id="keyFaster"[^>]*>\]</.test(HTML)
      && /id="keySlower"[^>]*>\[</.test(HTML)
      && /id="keyReset"[^>]*>\\</.test(HTML), true);
    check('步长滑块的粒度与倍速滑块一致（0.25 一档）',
      /id="stepSlider"[\s\S]{0,200}?min="0\.25"[\s\S]{0,200}?max="16"[\s\S]{0,200}?step="0\.25"/.test(HTML), true);

    check('设置界面先加载 keys.js 再加载 popup.js',
      HTML.indexOf('<script src="keys.js">') > 0
      && HTML.indexOf('<script src="keys.js">') < HTML.indexOf('<script src="popup.js">'), true);
    check('popup.js 用的是同一份词汇表', /__BILISPEED_KEYS__/.test(POPUP), true);
    // 守住“只有一份定义”：设置界面里不许再抄一遍键位
    for (const code of ['BracketRight', 'BracketLeft', 'Backslash', 'KeyF', 'ArrowUp']) {
      check(`popup.js 里没有重复定义键位（${code}）`, POPUP.includes(code), false);
    }
    check('键位与步长存在 sync 区域（跨设备、与倍速的临时存储无关）',
      /storage\.sync/.test(POPUP) && /bilispeed\.shortcuts/.test(KEYS_SRC), true);
    // 只检查会执行的代码：注释里解释“速度存在会话级区域”是说明，不是实现
    check('popup.js 不直接读会话级存储（那是倍速用的）',
      /storage\.session/.test(stripComments(POPUP)), false);
  }

  console.log('\n[12] 设置界面里的录制流程（真跑 popup.js）');
  {
    const env = createPopupEnv({ rate: 2 });
    await wait(30);

    check('三颗胶囊显示默认键位',
      [env.el('keyFaster').textContent, env.el('keySlower').textContent, env.el('keyReset').textContent],
      [']', '[', '\\']);
    check('步长显示默认值', env.el('stepValue').textContent, '0.25');
    check('这一屏初始收起', env.el('shortcutsView').hidden, true);

    env.el('shortcutsBtn')._fire('click');
    check('从设置里进得去', env.el('shortcutsView').hidden, false);
    check('进这一屏后设置屏收起', env.el('settingsView').hidden, true);
    check('倍速屏也收起', env.el('mainView').hidden, true);

    // ---- 点胶囊开始录制 ----
    env.el('keyFaster')._fire('click');
    check('进入录制态', env.el('keyFaster').textContent, '按下新键…');
    check('录制态有样式钩子（CSS 里会变实心块）',
      env.el('keyFaster').classList.contains('is-recording'), true);

    env.pressKey(keyEvent('ShiftLeft', { key: 'Shift', shift: true }));
    check('只按修饰键不算数，继续等', env.el('keyFaster').textContent, '按下新键…');

    env.pressKey(keyEvent('KeyG'));
    check('录到了 G', env.el('keyFaster').textContent, 'G');
    check('退出录制态', env.el('keyFaster').classList.contains('is-recording'), false);
    check('写进了 sync 区域', env.written.at(-1)['bilispeed.shortcuts'].faster.code, 'KeyG');
    check('没配的动作用默认键补齐',
      env.written.at(-1)['bilispeed.shortcuts'].slower.code, 'BracketLeft');

    // ---- 录组合键 ----
    env.el('keySlower')._fire('click');
    env.pressKey(keyEvent('KeyB', { ctrl: true }));
    check('组合键显示成 Ctrl+B', env.el('keySlower').textContent, 'Ctrl+B');
    check('组合键被完整存下', env.written.at(-1)['bilispeed.shortcuts'].slower,
      { code: 'KeyB', ctrl: true, alt: false, shift: false, meta: false });

    // ---- Esc 取消 ----
    env.el('keyReset')._fire('click');
    const writesBeforeCancel = env.written.length;
    env.pressKey(keyEvent('Escape', { key: 'Escape' }));
    check('Esc 取消录制', env.el('keyReset').textContent, '\\');
    check('取消不写盘', env.written.length, writesBeforeCancel);
    check('取消后不再处于录制态', env.el('keyReset').classList.contains('is-recording'), false);

    // ---- 录制期间按键不会顺带改倍速 ----
    env.el('keyReset')._fire('click');
    const sentBefore = env.sentMessages.length;
    env.pressKey(keyEvent('PageUp', { key: 'PageUp' }));
    check('录制时按键不改倍速', env.sentMessages.length, sentBefore);
    check('这个键被录成了新绑定', env.el('keyReset').textContent, 'PageUp');

    // ---- 步长：拖动只看，松手才落盘 ----
    env.el('stepSlider').value = '2';
    env.el('stepSlider')._fire('input');
    check('拖动时即时显示', env.el('stepValue').textContent, '2.00');
    const writesBeforeStep = env.written.length;
    check('拖动时不落盘', env.written.length, writesBeforeStep);
    env.el('stepSlider')._fire('change');
    check('松手落盘', env.written.at(-1)['bilispeed.step'], 2);

    // ---- 步长越界与对齐 ----
    env.el('stepSlider').value = '99';
    env.el('stepSlider')._fire('change');
    check('步长被钳到上限 16', env.el('stepValue').textContent, '16.00');
    check('落盘的也是钳过的值', env.written.at(-1)['bilispeed.step'], 16);

    // ---- 下次打开：读回保存过的配置 ----
    const again = createPopupEnv({
      rate: 1,
      stored: { 'bilispeed.shortcuts': { faster: { code: 'KeyG' } }, 'bilispeed.step': 2 },
    });
    await wait(30);
    check('重开时读回自定义键位', again.el('keyFaster').textContent, 'G');
    check('没存过的动作仍显示默认键位', again.el('keySlower').textContent, '[');
    check('重开时读回步长', again.el('stepValue').textContent, '2.00');

    // ---- 切换屏幕时录制自动取消（不会在别处吃掉按键）----
    const leaving = createPopupEnv({ rate: 1 });
    await wait(30);
    leaving.el('shortcutsBtn')._fire('click');
    leaving.el('keyFaster')._fire('click');
    leaving.el('shortcutsBackBtn')._fire('click');
    check('离开这一屏就取消录制', leaving.el('keyFaster').textContent, ']');
    check('回到设置屏', leaving.el('settingsView').hidden, false);
    const writesOnLeave = leaving.written.length;
    leaving.pressKey(keyEvent('KeyZ'));
    check('取消后按键不再改绑定', leaving.written.length, writesOnLeave);
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
