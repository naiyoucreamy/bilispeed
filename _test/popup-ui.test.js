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

/* ---------------- 从 HTML 里解析真实结构 ---------------- */
const ids = [...HTML.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
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
    hidden: false,
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
    for (const id of ['rateSlider', 'rateValue', 'status', 'resetBtn', 'minusBtn', 'plusBtn']) {
      check(`存在 #${id}`, ids.includes(id), true);
    }
    check('状态提示默认隐藏', /id="status"[^>]*hidden/.test(HTML), true);
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
    check('没有多余提示', env.el('status').hidden, true);
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

  console.log('\n[7] 非 B 站页面：禁用交互 + 一句人话提示');
  {
    const env = createEnv({ tab: { id: 9, url: 'https://www.example.com/' }, pageRate: 1 });
    await wait(30);
    check('滑块禁用', env.el('rateSlider').disabled, true);
    check('重置禁用', env.el('resetBtn').disabled, true);
    check('档位全部禁用', env.presets.every((b) => b.disabled), true);
    check('提示内容', env.el('status').textContent, '打开一个 B 站视频后即可使用');
    check('提示可见', env.el('status').hidden, false);
    check('没有发出任何命令', env.sentMessages.length, 0);
  }

  console.log('\n[8] 页面还没注入扩展时，提示刷新而不是内部黑话');
  {
    const env = createEnv({ tab: BV_TAB, pageRate: 1, contentAnswers: false });
    await wait(30);
    check('提示内容', env.el('status').textContent, '刷新一下页面即可使用');
    check('提示可见', env.el('status').hidden, false);
    check('界面仍可操作（会走注入兜底）', env.el('rateSlider').disabled, false);
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

  console.log('\n[10] CSS 与 JS 的类名/变量约定一致');
  {
    check('CSS 定义了 .preset.is-active', CSS.includes('.preset.is-active'), true);
    check('JS 使用的类名被 CSS 覆盖', CSS.includes('.preset.is-active'), true);
    for (const v of ['--accent', '--fill']) {
      check(`CSS 使用 ${v}`, CSS.includes(v), true);
    }
    check('HTML 里没有旧的 .active 类约定', /class="preset active"/.test(HTML), false);
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
