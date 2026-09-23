/**
 * Popup UI 自测台（仅本地验证用，不属于扩展本体）
 * ------------------------------------------------------------------
 * 直接从 popup.html 解析真实的元素 ID / 档位按钮，再跑真实的 popup.js，
 * 验证：交互 -> 下发命令、UI 渲染、CSS 变量、提示文字。
 * 这样即使以后改了 HTML 结构，测试也会立刻发现 JS 与 HTML 不一致。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'popup.html'), 'utf8');
const SRC = fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'popup.css'), 'utf8');
const FLOATING = fs.readFileSync(path.join(ROOT, 'floating.js'), 'utf8');

/* ---------------- 从 HTML 里解析真实结构 ---------------- */
const ids = [...HTML.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
/** HTML 里带 hidden 属性的元素（例如内嵌面板的「×」按钮），桩要照着来 */
const hiddenIds = new Set([...HTML.matchAll(/id="([^"]+)"([^>]*)>/g)]
  .filter((m) => /\bhidden\b/.test(m[2]))
  .map((m) => m[1]));
const presetRates = [...HTML.matchAll(/class="preset"[^>]*data-rate="([\d.]+)"/g)].map((m) => m[1]);

/* ---------------- 极简 DOM 桩 ---------------- */
function createElement(id, tag = 'div') {
  const listeners = {};
  const attrs = {};
  const classes = new Set();
  return {
    id,
    tagName: tag.toUpperCase(),
    style: { setProperty(k, v) { this[k] = v; } },
    dataset: {},
    textContent: '',
    value: '',
    // 桩模拟真实页面：HTML 里写了 hidden 的元素，解析出来就是 hidden
    hidden: hiddenIds.has(id),
    disabled: false,
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
    _attrs: attrs,
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    _fire: (type, event = {}) => {
      (listeners[type] || []).forEach((fn) => fn({ type, preventDefault() {}, ...event }));
    },
    focus() {},
  };
}

function createEnv({ tab, pageRate, hasVideo = true, contentAnswers = true }) {
  const elements = new Map();
  for (const id of ids) elements.set(id, createElement(id));

  // 按 popup.html 里的真实档位生成按钮
  const presets = presetRates.map((rate) => {
    const btn = createElement(`preset-${rate}`, 'button');
    btn.dataset.rate = rate;
    return btn;
  });

  const rootStyle = { props: {}, setProperty(k, v) { this.props[k] = v; } };
  const sentMessages = [];

  const document = {
    documentElement: { style: rootStyle },
    getElementById: (id) => elements.get(id) || null,
    querySelectorAll: (selector) => (selector === '.preset' ? presets : []),
    addEventListener: () => {},
  };

  const chrome = {
    tabs: {
      query: async () => (tab ? [tab] : []),
      sendMessage: (id, message, cb) => {
        if (message.type === 'bilispeed:get' || message.type === 'bilispeed:resolve') {
          cb(contentAnswers
            ? { ok: true, target: pageRate, actual: pageRate, hasVideo }
            : null);
          return;
        }
        sentMessages.push({ tabId: id, ...message });
        cb(contentAnswers ? { ok: true, rate: message.rate } : null);
      },
    },
    runtime: { lastError: undefined },
    storage: { sync: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    scripting: { executeScript: async () => [] },
  };

  const ctx = vm.createContext({
    window: { addEventListener: () => {} },
    document,
    chrome,
    console, Math, Number, Object, JSON, URL, URLSearchParams,
    setTimeout, clearTimeout, Promise, String, Boolean,
  });
  vm.runInContext(SRC, ctx, { filename: 'popup.js' });

  return { elements, presets, rootStyle, sentMessages, el: (id) => elements.get(id) };
}

/* ---------------- 页面悬浮按钮的内嵌场景 ----------------
   悬浮按钮把同一份 popup.html 放进 iframe，所以这里也把同一份 popup.js
   丢进一个“window.top !== window”的上下文里跑一遍，验证两个入口行为一致。 */
function createEmbeddedEnv({ pageRate = 3, hasVideo = true } = {}) {
  const elements = new Map();
  for (const id of ids) elements.set(id, createElement(id));
  const presets = presetRates.map((rate) => {
    const btn = createElement(`preset-${rate}`, 'button');
    btn.dataset.rate = rate;
    return btn;
  });

  const rootStyle = { props: {}, setProperty(k, v) { this.props[k] = v; } };
  // body.children：高度上报靠它累加。这里如实还原三种元素：
  //   .card   -> 在文档流里，计入
  //   #closeBtn -> position:absolute 且 body 是它的定位祖先（offsetParent 非 null！）
  //                所以必须靠 position 判断排除，否则会多加约 19px
  //   （#status 已删除，不再参与高度计算）
  const bodyChildren = [
    { className: 'close', offsetHeight: 19, hidden: false, offsetParent: {}, style: { position: 'absolute', display: 'flex' } },
    { className: 'card', offsetHeight: 218, hidden: false, offsetParent: {}, style: { position: 'static', display: 'block' } },
  ];
  const document = {
    documentElement: { style: rootStyle },
    body: { children: bodyChildren, offsetHeight: 218 },
    defaultView: { getComputedStyle: (n) => n.style },
    getElementById: (id) => elements.get(id) || null,
    querySelectorAll: (selector) => (selector === '.preset' ? presets : []),
    addEventListener: () => {},
  };

  const sentMessages = [];
  const sendTargets = [];
  const chrome = {
    tabs: {
      // 桩同时支持 callback 与 Promise 两种写法，和真实 API 一致
      query: (query, callback) => {
        const tabs = [{ id: 7 }]; // 内嵌时拿不到 url（没有 tabs 权限）
        if (callback) callback(tabs);
        return Promise.resolve(tabs);
      },
      sendMessage: (target, message, cb) => {
        sendTargets.push(target);
        if (message.type === 'bilispeed:get') {
          cb({ ok: true, target: pageRate, actual: pageRate, hasVideo, tabId: 7, persisted: true });
          return;
        }
        sentMessages.push({ tabId: target, ...message });
        cb({ ok: true, rate: message.rate });
      },
    },
    runtime: { lastError: undefined },
    scripting: { executeScript: async () => [] },
  };

  // 关键：window.top 不是 window，且本页面是扩展页面 -> 判定为“被悬浮按钮内嵌”
  const posted = [];
  const parent = { postMessage: (message) => posted.push(message) };
  const winListeners = {};
  const win = {
    top: {},                    // 不是自己 -> 内嵌
    parent,                     // 外层页面：收到 hello 后我们回它 panelClose
    addEventListener: (t, fn) => { (winListeners[t] ||= []).push(fn); },
    _fire: (t, event = {}) => (winListeners[t] || []).forEach((fn) => fn({ type: t, ...event })),
  };
  const ctx = vm.createContext({
    window: win,
    document,
    chrome,
    location: { protocol: 'chrome-extension:' },
    // 高度上报里会用到 rAF；桩里同步执行，便于断言
    requestAnimationFrame: (fn) => { fn(); return 1; },
    console, Math, Number, Object, JSON, URL, URLSearchParams,
    setTimeout, clearTimeout, Promise, String, Boolean,
  });
  vm.runInContext(SRC, ctx, { filename: 'popup.js' });

  return {
    elements, presets, rootStyle, sentMessages, sendTargets,
    win, parent, posted,
    el: (id) => elements.get(id),
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

const BV_TAB = { id: 1, url: 'https://www.bilibili.com/video/BV1AA411c7de' };

(async () => {
  console.log('\n[1] HTML 结构：档位与必要元素齐全');
  {
    check('8 个档位按钮', presetRates.length, 8);
    check('档位数值', presetRates, ['0.5', '1', '1.5', '2', '3', '4', '8', '16']);
    for (const id of ['rateSlider', 'rateValue', 'resetBtn', 'minusBtn', 'plusBtn']) {
      check(`存在 #${id}`, ids.includes(id), true);
    }
    // 底部那行提示文字已按用户要求删除；提示通道降级为静默，但代码要能容忍它不存在
    check('已删除 #status 提示行', ids.includes('status'), false);
    check('HTML 里不再有 .status', /class="status"/.test(HTML), false);
    check('提示通道容忍元素缺失（不会抛错）',
      /if \(!statusEl\) return;/.test(SRC), true);
    // 界面上不应该出现给开发者看的内部标识
    check('HTML 无内部标识残留', /tabKey|tabId|storage|session|debug|bilispeed:/.test(HTML), false);
  }

  console.log('\n[2] 打开时读回当前标签页的速度并渲染');
  {
    const env = createEnv({ tab: BV_TAB, pageRate: 3.75 });
    await wait(30);
    check('显示 3.75', env.el('rateValue').textContent, '3.75');
    check('滑块位置同步', env.el('rateSlider').value, '3.75');
    check('无障碍读法', env.el('rateSlider').getAttribute('aria-valuetext'), '3.75 倍速');
    check('没有提示元素（已删除）', env.el('status'), undefined);
    check('强调色随速度计算（3.75x 偏青蓝）', env.rootStyle.props['--accent'], 'rgb(0, 137, 214)');
    const active = env.presets.filter((b) => b.classList.contains('is-active')).map((b) => b.dataset.rate);
    check('没有档位被高亮（3.75 不是档位）', active, []);
  }

  console.log('\n[3] 点击档位 -> 下发命令 + 高亮当前档位');
  {
    const env = createEnv({ tab: BV_TAB, pageRate: 1 });
    await wait(30);
    const active0 = env.presets.filter((b) => b.classList.contains('is-active')).map((b) => b.dataset.rate);
    check('初始高亮 1x', active0, ['1']);

    env.presets.find((b) => b.dataset.rate === '4')._fire('click');
    await wait(30);
    check('显示 4.00', env.el('rateValue').textContent, '4.00');
    check('下发了 set 4', env.sentMessages.at(-1), { tabId: 1, type: 'bilispeed:set', rate: 4 });
    const active1 = env.presets.filter((b) => b.classList.contains('is-active')).map((b) => b.dataset.rate);
    check('高亮切到 4x', active1, ['4']);
    check('16x 时强调色更暖（与 1x 不同）', env.rootStyle.props['--accent'] !== 'rgb(0, 176, 214)', true);
  }

  console.log('\n[4] 拖动滑块：节流下发 + 实时渲染');
  {
    const env = createEnv({ tab: BV_TAB, pageRate: 1 });
    await wait(30);
    env.el('rateSlider').value = '6.25';
    env.el('rateSlider')._fire('input');
    check('拖动即时更新数字', env.el('rateValue').textContent, '6.25');
    check('拖动不立刻发消息（等节流）', env.sentMessages.length, 0);
    await wait(140);
    check('节流后发出 set 6.25', env.sentMessages.at(-1), { tabId: 1, type: 'bilispeed:set', rate: 6.25 });

    env.el('rateSlider').value = '12.5';
    env.el('rateSlider')._fire('change');
    await wait(30);
    check('松手立即下发 set 12.5', env.sentMessages.at(-1), { tabId: 1, type: 'bilispeed:set', rate: 12.5 });
    check('显示 12.50', env.el('rateValue').textContent, '12.50');
  }

  console.log('\n[5] 加减 0.25 与重置');
  {
    const env = createEnv({ tab: BV_TAB, pageRate: 2 });
    await wait(30);
    env.el('plusBtn')._fire('click');
    await wait(30);
    check('+0.25 -> 2.25', env.el('rateValue').textContent, '2.25');
    env.el('minusBtn')._fire('click');
    env.el('minusBtn')._fire('click');
    await wait(30);
    check('-0.25 两次 -> 1.75', env.el('rateValue').textContent, '1.75');
    check('下发的倍速正确', env.sentMessages.at(-1).rate, 1.75);

    env.el('resetBtn')._fire('click');
    await wait(30);
    check('重置显示 1.00', env.el('rateValue').textContent, '1.00');
    check('重置走的是 reset 消息', env.sentMessages.at(-1).type, 'bilispeed:reset');
  }

  console.log('\n[6] 边界：最小值不再减小、最大值不再增大');
  {
    const env = createEnv({ tab: BV_TAB, pageRate: 0.25 });
    await wait(30);
    env.el('minusBtn')._fire('click');
    await wait(30);
    check('0.25 再减仍是 0.25', env.el('rateValue').textContent, '0.25');
    env.el('rateSlider').value = '16';
    env.el('rateSlider')._fire('change');
    await wait(30);
    env.el('plusBtn')._fire('click');
    await wait(30);
    check('16 再加仍是 16', env.el('rateValue').textContent, '16.00');
  }

  console.log('\n[7] 非 B 站页面：禁用交互，且不因提示元素缺失而崩');
  {
    const env = createEnv({ tab: { id: 9, url: 'https://www.example.com/' }, pageRate: 1 });
    await wait(30);
    check('滑块禁用', env.el('rateSlider').disabled, true);
    check('重置禁用', env.el('resetBtn').disabled, true);
    check('档位全部禁用', env.presets.every((b) => b.disabled), true);
    // 这一条是回归防护：showHint 会被调用，但元素已删除，必须静默降级
    check('提示元素已删除', env.el('status'), undefined);
    check('软件没有抛错（界面照常渲染）', env.el('rateValue').textContent, '1.00');
    check('没有发出任何命令', env.sentMessages.length, 0);
  }

  console.log('\n[8] 页面还没注入扩展时：走注入兜底，且不因提示元素缺失而崩');
  {
    const env = createEnv({ tab: BV_TAB, pageRate: 1, contentAnswers: false });
    await wait(30);
    check('提示元素已删除', env.el('status'), undefined);
    check('界面仍可操作（会走注入兜底）', env.el('rateSlider').disabled, false);
    // 兜底失败时会调 showHint —— 这里必须安然无恙
    env.presets.find((b) => b.dataset.rate === '2')._fire('click');
    await wait(30);
    check('兜底路径不崩，读数照常更新', env.el('rateValue').textContent, '2.00');
  }

  console.log('\n[9] 界面文案里不出现开发者用语');
  {
    // 只检查"用户真正看得见的文本"：去掉注释和 <script> 里的代码
    const visibleHtml = HTML
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<script[\s\S]*?<\/script>/g, '');
    const banned = [
      '标签页 #', 'tabKey', 'tabId', 'session 键', 'storage + 页面',
      '仅内存', '检查视图', 'debugDump', '未就绪', '页面未响应',
      '__bilispeed', 'dump(', 'Service Worker', 'chrome.', 'sync',
    ];
    for (const word of banned) {
      check(`界面文本不含「${word}」`, visibleHtml.includes(word), false);
    }
    // 展示给用户的字符串（showHint 的参数）里也不应有黑话
    const hintStrings = [...SRC.matchAll(/showHint\(([^)]*)\)/g)].map((m) => m[1]);
    check('提示文案数量合理', hintStrings.length >= 3, true);
    for (const s of hintStrings) {
      check(`提示文案「${s.slice(0, 30)}」不含技术黑话`,
        /tabKey|tabId|storage|session|dump|worker/i.test(s), false);
    }
  }

  console.log('\n[10] 页面悬浮按钮内嵌打开：界面与行为与工具栏弹窗一致');
  {
    const env = createEmbeddedEnv({ pageRate: 3 });
    await wait(30);
    check('内嵌时也能读到当前速度', env.el('rateValue').textContent, '3.00');
    check('内嵌时滑块可用（不会误判成“非 B 站页面”）', env.el('rateSlider').disabled, false);
    check('内嵌时没有提示元素（已删除）', env.el('status'), undefined);
    check('消息发给了本标签页', env.sendTargets[0], 7);

    env.presets.find((b) => b.dataset.rate === '2')._fire('click');
    await wait(30);
    check('内嵌时也能改速', env.sentMessages.at(-1), { tabId: 7, type: 'bilispeed:set', rate: 2 });
    check('改速后读数同步', env.el('rateValue').textContent, '2.00');

    env.el('resetBtn')._fire('click');
    await wait(30);
    check('内嵌时也能重置', env.sentMessages.at(-1), { tabId: 7, type: 'bilispeed:reset' });
    check('重置后读数 1.00', env.el('rateValue').textContent, '1.00');

    env.el('rateSlider').value = '5.5';
    env.el('rateSlider')._fire('change');
    await wait(30);
    check('内嵌时滑块一样下发', env.sentMessages.at(-1), { tabId: 7, type: 'bilispeed:set', rate: 5.5 });
  }

  console.log('\n[10b] 「×」收起按钮：只有内嵌打开时才出现，点了请外层收起');
  {
    const env = createEmbeddedEnv({ pageRate: 1 });
    check('未握手前沿用 HTML 的 hidden（不显示）', env.el('closeBtn').hidden, true);

    // 外层 floating.js 在面板加载完成后发来 hello
    env.win._fire('message', { data: { type: 'bilispeed:panelHello' }, source: env.parent });
    check('握手后「×」出现', env.el('closeBtn').hidden, false);

    env.el('closeBtn')._fire('click');
    check('点「×」向外层请求收起', env.posted.at(-1), { type: 'bilispeed:panelClose' });

    // 握手时还要把自身内容高度报上去（跨源读不了，只能自己量自己报）
    const heightMsg = env.posted.find((m) => m.type === 'bilispeed:panelHeight');
    check('上报了内容高度', Boolean(heightMsg), true);
    // 桩里 .card=218；#status 隐藏(0)；#closeBtn 是 absolute，必须被排除
    check('上报的高度只算在文档流里的元素（排除了 absolute 的「×」）',
      heightMsg && heightMsg.height, 218);

    // 高度上报不依赖握手：init 里就已经报过一次（避免 hello 时序错开时漏掉）
    const bare = createEmbeddedEnv({ pageRate: 2 });
    const bareMsg = bare.posted.find((m) => m.type === 'bilispeed:panelHeight');
    check('未握手也已上报高度（不依赖 hello 时序）', Boolean(bareMsg), true);
    check('未握手时高度同样正确', bareMsg && bareMsg.height, 218);

    // 不是外层发来的 hello 一律不理会
    const other = createEmbeddedEnv({ pageRate: 1 });
    other.win._fire('message', { data: { type: 'bilispeed:panelHello' }, source: { fake: true } });
    check('不理会来路不明的 hello', other.el('closeBtn').hidden, true);
    other.el('closeBtn')._fire('click');
    // 注意：高度上报不依赖握手（谁量谁报），所以只看有没有误发 panelClose
    const closes = other.posted.filter((m) => m.type === 'bilispeed:panelClose');
    check('没握手时点「×」不会误发 panelClose', closes.length, 0);

    // 工具栏弹窗（非内嵌）里不会显示「×」，也不会接管消息
    const top = createEnv({ tab: BV_TAB, pageRate: 1 });
    await wait(30);
    check('工具栏弹窗里「×」保持隐藏', top.el('closeBtn').hidden, true);
  }

  console.log('\n[11] CSS 与 JS 的类名/变量约定一致');  {
    check('CSS 定义了 .preset.is-active', CSS.includes('.preset.is-active'), true);
    check('JS 使用的类名被 CSS 覆盖', CSS.includes('.preset.is-active'), true);
    for (const v of ['--accent', '--fill']) {
      check(`CSS 使用 ${v}`, CSS.includes(v), true);
    }
    check('HTML 里没有旧的 .active 类约定', /class="preset active"/.test(HTML), false);
  }

  console.log('\n[12] 单层面板：最外层透明，只有一层圆角框');
  {
    // ---- 1. 最外层（html / body）必须完全透明、无 margin / 无 padding ----
    const htmlBody = (CSS.match(/html,\s*body\s*\{[\s\S]*?\n\}/) || [''])[0];
    check('html/body 的 margin 为 0', /margin:\s*0/.test(htmlBody), true);
    check('html/body 的 padding 为 0', /padding:\s*0/.test(htmlBody), true);
    check('html/body 背景透明', /background:\s*transparent/.test(htmlBody), true);

    // body 自己那条规则：把共用选择器的 "html,\nbody{" 先排除掉，
    // 再取行首独立出现的 "body { ... }"（JS 的 \s 含换行，直接匹配会误命中）
    const cssNoShared = CSS.replace(/html,\s*body\s*\{[\s\S]*?\n\}/g, '');
    const bodyRule = (cssNoShared.match(/(?:^|\n)body\s*\{[\s\S]*?\n\}/) || [''])[0];
    check('取到了 body 自身的规则（含宽度）', /width:\s*296px/.test(bodyRule), true);
    // body 自己不能再用 padding 圈出一圈底色（那正是之前的白框来源）
    check('body 上不再有 padding（不再垫出一圈底色）', /padding:/.test(bodyRule), false);
    check('body 上不再有多层渐变底色', /radial-gradient/.test(bodyRule), false);

    // ---- 2. body 就是那张圆角面板 ----
    check('body 自带圆角', /border-radius:\s*var\(--radius-lg\)/.test(bodyRule), true);
    check('body 自带描边（唯一的一层）', /border:\s*1px solid var\(--line\)/.test(bodyRule), true);
    check('body 自带面板底色', /background:\s*var\(--surface\)/.test(bodyRule), true);
    check('body 自带轻微投影（扩展弹窗本体没有投影）',
      /box-shadow:\s*var\(--shadow-flat\)/.test(bodyRule)
      && /--shadow-flat:\s*0 1px 2px/.test(CSS), true);
    check('body 是 relative（收起按钮的定位基准）', /position:\s*relative/.test(bodyRule), true);

    // ---- 3. .card 不能再是第二张卡片 ----
    const card = (CSS.match(/\.card\s*\{[\s\S]*?\n\}/) || [''])[0];
    check('.card 只负责内边距', /padding:\s*13px 13px 11px/.test(card), true);
    check('.card 背景透明（不再叠一层底）', /background:\s*transparent/.test(card), true);
    check('.card 无描边', /border:\s*0/.test(card), true);
    check('.card 无圆角', /border-radius:\s*0/.test(card), true);
    check('.card 无投影', /box-shadow:\s*none/.test(card), true);

    // ---- 4. 宽度一致：body 宽度 = floating.js 的面板宽度 ----
    const bodyWidth = (bodyRule.match(/width:\s*(\d+)px/) || [])[1];
    check('body 宽度是 296px（内容 270 + 左右各 13）', bodyWidth, '296');
    check('floating.js 里的面板宽度与之一致',
      /\.panel\s*\{[\s\S]*?width:\s*296px/.test(FLOATING), true);

    // ---- 5. 品牌行已移除；收起按钮浮在右上角、不占布局 ----
    check('HTML 里没有品牌行', /class="brand"/.test(HTML), false);
    check('没有 .head 这行占位元素', /class="head"/.test(HTML), false);
    check('收起按钮浮在右上角（absolute，不占布局）',
      /\.close\s*\{[\s\S]*?position:\s*absolute[\s\S]*?top:\s*14px[\s\S]*?right:\s*14px/.test(CSS), true);
    check('收起按钮平时隐形、悬停才显形',
      /\.close\s*\{[\s\S]*?opacity:\s*0/.test(CSS) && /body:hover \.close/.test(CSS), true);

    // ---- 6. 档位仍然紧凑 ----
    check('档位一行 5 个（8 个档位排 5 + 3 两行）',
      /\.presets\s*\{[\s\S]*?grid-template-columns:\s*repeat\(5, 1fr\)/.test(CSS), true);
  }

  console.log('\n[13] 视觉重构后的一致性：令牌无死代码、几何不乱、反馈不漏');
  {
    // ---- 1. 设计令牌：定义了就必须用上，避免留下死变量 ----
    const defined = [...CSS.matchAll(/^\s*(--[\w-]+):/gm)].map((m) => m[1]);
    const unused = defined.filter(
      (v) => !new RegExp(`var\\(\\s*${v}[,)]`).test(CSS),
    );
    check('没有定义了却没用的令牌', unused, []);

    // ---- 2. 颜色必须走令牌：:root 之外不许再散落硬编码色值 ----
    // 只看 :root 之后的部分；那里只允许纯白/纯黑这类无色彩倾向的中性值
    const afterTokens = CSS.slice(CSS.indexOf('}', CSS.indexOf(':root')) + 1);
    const stray = [...new Set(
      [...afterTokens.matchAll(/#[0-9a-fA-F]{3,8}/g)].map((m) => m[0].toLowerCase()),
    )].filter((c) => !['#fff', '#ffffff', '#0e1318'].includes(c));
    check(':root 之外没有散落的硬编码色值（都走 var）', stray, []);

    // ---- 3. 滑块几何：圆钮必须正好在轨道中线上 ----
    const track = Number((CSS.match(/runnable-track\s*\{[\s\S]*?height:\s*(\d+)px/) || [])[1]);
    const thumb = Number((CSS.match(/slider-thumb\s*\{[\s\S]*?height:\s*(\d+)px/) || [])[1]);
    const marginTop = Number((CSS.match(/slider-thumb\s*\{[\s\S]*?margin-top:\s*(-?\d+)px/) || [])[1]);
    check('圆钮在轨道上居中', marginTop, (track - thumb) / 2);

    // ---- 4. 每个可交互控件都要有悬停与键盘焦点反馈 ----
    for (const sel of ['.step', '.preset', '.reset']) {
      const rule = new RegExp(`\\${sel}:hover:not\\(:disabled\\)`).test(CSS);
      const focus = new RegExp(`\\${sel}:focus-visible`).test(CSS);
      check(`${sel} 有悬停反馈`, rule, true);
      check(`${sel} 有键盘焦点环`, focus, true);
    }
    check('滑块有键盘焦点环', /\.slider:focus-visible::-webkit-slider-thumb/.test(CSS), true);

    // ---- 5. 选中档位必须比普通档位更“重”（实心底 + 彩色投影） ----
    const active = (CSS.match(/\.preset\.is-active\s*\{[\s\S]*?\n\}/) || [''])[0];
    check('选中档位用实心强调色', /background:\s*var\(--accent\)/.test(active), true);
    check('选中档位带彩色投影', /box-shadow:\s*var\(--shadow-accent\)/.test(active), true);
    check('选中档位悬停时不会被悬停样式冲掉',
      /\.preset\.is-active:hover:not\(:disabled\)/.test(CSS), true);

    // ---- 6. 动效可被系统设置关掉 ----
    check('尊重 prefers-reduced-motion',
      /@media \(prefers-reduced-motion: reduce\)/.test(CSS), true);

    // ---- 7. 结构契约：JS 依赖的钩子一个都不能少 ----
    for (const v of ['--accent', '--fill']) {
      check(`JS 写入的变量 ${v} 有 CSS 消费`, CSS.includes(v), true);
    }
    check('JS 切换的 .is-active 有样式', /\.preset\.is-active/.test(CSS), true);
    for (const cls of ['readout', 'rate', 'stepper', 'step', 'slider', 'scale', 'presets', 'preset', 'reset', 'close', 'card']) {
      check(`HTML 用到 .${cls}`, new RegExp(`class="[^"]*\\b${cls}\\b`).test(HTML), true);
    }
    check('#closeBtn 初始 hidden（工具栏弹窗不显示）',
      /id="closeBtn"[^>]*hidden/.test(HTML), true);

    // 提示行已删除：CSS 里那段 .status 规则也应该一并收掉，不留死样式
    check('CSS 里不再有 .status 规则', /^\.status\s*\{/m.test(CSS), false);
    check('CSS 里不再有 status-in 动画', /@keyframes status-in/.test(CSS), false);
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
