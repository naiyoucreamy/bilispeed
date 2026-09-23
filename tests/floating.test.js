/**
 * 悬浮按钮自测台（仅本地验证用，不属于扩展本体）
 * ------------------------------------------------------------------
 * 跑真实的 floating.js（配一套极简 DOM 桩），验证：
 *   1. 清单注册正确（content_scripts + web_accessible_resources）
 *   2. 宿主元素与 Shadow DOM 里的按钮 / 浮层结构正确
 *   3. 点击按钮 -> 浮层用 iframe 加载 **真实的 popup.html**，再点一次收起
 *   4. 点页面别处 / Esc / 全屏 / 加载失败 等边界行为
 *   5. floating.js 完全不碰倍速逻辑（不读写速度、不发扩展消息）
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'floating.js'), 'utf8');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const HTML = fs.readFileSync(path.join(ROOT, 'popup.html'), 'utf8');
const POPUP_CSS = fs.readFileSync(path.join(ROOT, 'popup.css'), 'utf8');
const POPUP = fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8');

const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/';

/* ---------------- 极简 DOM 桩 ---------------- */

function createClassList() {
  const set = new Set();
  return {
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    contains: (c) => set.has(c),
    toggle(c, force) {
      if (force === true) { set.add(c); return true; }
      if (force === false) { set.delete(c); return false; }
      if (set.has(c)) { set.delete(c); return false; }
      set.add(c);
      return true;
    },
    _all: () => [...set],
  };
}

function createElement(tag = 'div', id = '') {
  const listeners = {};
  const attrs = {};
  const nodes = [];
  const el = {
    tagName: tag.toUpperCase(),
    id,
    style: { cssText: '', visibility: '' },
    dataset: {},
    textContent: '',
    src: '',
    parent: null,
    _html: '',
    classList: createClassList(),
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    removeEventListener: (type, fn) => {
      if (listeners[type]) listeners[type] = listeners[type].filter((f) => f !== fn);
    },
    _fire: (type, event = {}) => {
      (listeners[type] || []).forEach((fn) => fn({ type, stopPropagation() {}, composedPath: () => [el], ...event }));
    },
    _count: (type) => (listeners[type] || []).length,
    setAttribute: (k, v) => { attrs[k] = String(v); },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    _attrs: attrs,
    focus: () => { el._focused = true; },
    appendChild: (child) => { child.parent = el; nodes.push(child); return child; },
    remove: () => {
      if (el.parent) {
        const list = el.parent._children;
        const i = list.indexOf(el);
        if (i !== -1) list.splice(i, 1);
        el.parent = null;
      }
    },
    querySelector: (sel) => el._children.find((c) => matches(c, sel)) || null,
    querySelectorAll: (sel) => el._children.filter((c) => matches(c, sel)),
    attachShadow: () => { el._shadow = createElement('shadow-root'); return el._shadow; },
    _children: nodes,
  };

  // iframe 赋值 src 之后浏览器一定会触发 load（桩里用一次异步回调代替）
  let src = '';
  Object.defineProperty(el, 'src', {
    get: () => src,
    set: (value) => {
      src = String(value);
      setTimeout(() => el._fire('load'), 0);
    },
  });

  // iframe：**跨源**，外层拿不到 contentDocument（真实浏览器会抛 SecurityError）。
  // 这一点必须如实模拟 —— 之前桩里给了个假 contentDocument，
  // 把「content script 读不到扩展页面」这个真问题掩盖掉了。
  if (tag === 'iframe') {
    el._posted = [];
    Object.defineProperty(el, 'contentDocument', {
      get() {
        // 跨源访问：浏览器抛 SecurityError，content script 侧一律 catch 掉
        throw new Error("SecurityError: Blocked a frame with origin \"https://www.bilibili.com\" from accessing a cross-origin frame.");
      },
    });
    el._contentWindow = {
      postMessage: (message) => { el._posted.push(message); },
    };
    Object.defineProperty(el, 'contentWindow', { get: () => el._contentWindow });
  }

  // className 与 classList 保持同步（真实 DOM 的行为）
  let className = '';
  Object.defineProperty(el, 'className', {
    get: () => className,
    set: (value) => { className = String(value); el.classList.add(className); },
  });

  // innerHTML 只需要支持 floating.js 用的那份模板
  Object.defineProperty(el, 'innerHTML', {
    get: () => el._html,
    set: (value) => {
      el._html = String(value);
      nodes.length = 0;
      el._style = createElement('style');
      el._style.textContent = value;
      el._children.push(el._style);
      el._button = createElement('button');
      el._button.className = 'launcher';
      // 属性按模板里的真实取值解析，避免桩和模板各说各话
      for (const [, k, v] of value.matchAll(/([a-z-]+)="([^"]*)"/g)) el._button.setAttribute(k, v);
      el._panel = createElement('div', 'bilispeed-floating-panel');
      el._panel.className = 'panel';
      el._panel.dataset.state = 'idle';
      el._fallback = createElement('div');
      el._fallback.className = 'fallback';
      el._panel.appendChild(el._fallback);
      el._hint = createElement('div');
      el._hint.className = 'hint';
      nodes.push(el._button, el._panel, el._hint);
    },
  });

  return el;
}

function matches(el, selector) {
  if (selector.startsWith('.')) return el.classList.contains(selector.slice(1));
  if (selector.startsWith('#')) return el.id === selector.slice(1);
  return el.tagName === selector.toUpperCase();
}

/* ---------------- 环境 ---------------- */

function createEnv({ popupUrlWorks = true, dark = false } = {}) {
  const listeners = {};
  const body = createElement('body');
  const documentElement = createElement('html');
  const document = {
    readyState: 'complete',
    hidden: false,
    fullscreenElement: null,
    body,
    documentElement,
    createElement: (tag) => createElement(tag),
    addEventListener: (t, fn) => { (listeners[`doc:${t}`] ||= []).push(fn); },
    removeEventListener: () => {},
    hasFocus: () => false,
    _fire: (t, event = {}) => (listeners[`doc:${t}`] || []).forEach((fn) => fn({ type: t, stopPropagation() {}, composedPath: () => [], ...event })),
  };

  const winListeners = {};
  const win = {
    addEventListener: (t, fn) => { (winListeners[t] ||= []).push(fn); },
    removeEventListener: () => {},
    matchMedia: () => ({ matches: dark, addEventListener: () => {} }),
    _fire: (t, event = {}) => (winListeners[t] || []).forEach((fn) => fn({ type: t, ...event })),
    location: new URL('https://www.bilibili.com/video/BV1AA411c7de'),
  };
  win.window = win;
  win.top = win; // content script 跑在顶层文档里

  const urlCalls = [];
  const posted = [];
  const chrome = {
    runtime: {
      lastError: undefined,
      getURL: (p) => {
        urlCalls.push(p);
        if (!popupUrlWorks) throw new Error('Extension context invalidated.');
        return EXT_ORIGIN + p;
      },
      sendMessage: () => { throw new Error('floating.js 不应该发扩展消息'); },
    },
    storage: { session: { get: () => { throw new Error('floating.js 不应该读存储'); } } },
  };

  const ctx = vm.createContext({
    window: win, document, chrome, location: win.location,
    setTimeout, clearTimeout, console, Math, Number, Object, JSON, URL, Date, String, Boolean, Error,
  });
  vm.runInContext(SRC, ctx, { filename: 'floating.js' });

  return {
    document, body, win,
    host: body._children[0] || null,
    shadow: (body._children[0] && body._children[0]._shadow) || null,
    urlCalls,
    /** 面板（iframe）往外层发的消息，按发生顺序 */
    get posted() {
      const frameEl = this.shadow && this.shadow._panel.querySelector('iframe');
      return (frameEl ? frameEl._posted : []).map((message) => ({
        target: frameEl._contentWindow,
        message,
      }));
    },
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

(async () => {
  console.log('\n[1] manifest 注册：新入口不影响原有配置');
  {
    const scripts = MANIFEST.content_scripts.flatMap((c) => c.js);
    check('content.js 仍在第一位', scripts[0], 'content.js');
    check('floating.js 已注册', scripts.includes('floating.js'), true);
    check('两个脚本都只在 B 站页面运行',
      MANIFEST.content_scripts.every((c) => c.matches[0] === '*://*.bilibili.com/*'), true);
    check('两个脚本都是 document_start',
      MANIFEST.content_scripts.every((c) => c.run_at === 'document_start'), true);

    const war = MANIFEST.web_accessible_resources;
    check('声明了 web_accessible_resources', Array.isArray(war) && war.length === 1, true);
    check('暴露的就是 popup 界面本身（含它引用的样式与主题脚本）',
      war[0].resources, ['popup.html', 'popup.css', 'theme.js']);
    check('只对 B 站页面暴露', war[0].matches[0], '*://*.bilibili.com/*');

    check('工具栏 action 与 popup.html 保持不变',
      MANIFEST.action.default_popup === 'popup.html'
      && MANIFEST.action.default_icon['128'] === 'icons/icon128.png', true);
    check('权限没有被放大', MANIFEST.permissions, ['storage', 'scripting']);
    check('没有把 chrome.tabs 加进权限（内嵌时不需要）', MANIFEST.permissions.includes('tabs'), false);
  }

  console.log('\n[1b] 可加载性：Chrome 会拒绝以 “_” 开头的文件/目录，这里提前挡住');
  {
    // Chrome 报错原文：Cannot load extension with file or directory name _test.
    // Filenames starting with "_" are reserved for use by the system.
    // 所以自测目录必须是 tests，任何 “_” 开头的名字都不能出现在扩展目录里。
    // 唯一例外是 _locales：它是浏览器官方保留的本地化目录，必须叫这个名字
    // （README 里那条「不能叫 _test」的规则，说的就是这个坑）。
    const ALLOWED_UNDERSCORE = ['_locales'];
    const offenders = [];
    (function walk(dir, prefix) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '.git') continue;
        const rel = prefix + entry.name;
        if (entry.name.startsWith('_') && !ALLOWED_UNDERSCORE.includes(entry.name)) {
          offenders.push(rel + (entry.isDirectory() ? '/' : ''));
        }
        if (entry.isDirectory()) walk(path.join(dir, entry.name), `${rel}/`);
      }
    }(ROOT, ''));
    check('扩展目录里没有以 “_” 开头的文件或目录（_locales 除外）', offenders, []);

    // manifest 里引用的每个路径都必须真实存在，否则同样会加载失败
    const referenced = [
      MANIFEST.background.service_worker,
      ...MANIFEST.content_scripts.flatMap((c) => c.js),
      ...MANIFEST.web_accessible_resources.flatMap((w) => w.resources),
      MANIFEST.action.default_popup,
      ...Object.values(MANIFEST.action.default_icon),
      ...Object.values(MANIFEST.icons),
    ];
    check('manifest 引用的资源全部存在', referenced.filter((p) => !fs.existsSync(path.join(ROOT, p))), []);
  }

  console.log('\n[1c] 本地化：manifest 必须声明 default_locale，__MSG_ 引用必须有对应词条');
  {
    // 商店（Microsoft Edge Add-ons / Chrome Web Store）判定扩展语言的依据就是这个字段：
    // 没有 default_locale，manifest 里的中文只是普通字符，后台会把语言识别成 en-US。
    check('manifest 声明了 default_locale', MANIFEST.default_locale, 'zh_CN');

    const localeFile = path.join(ROOT, '_locales', MANIFEST.default_locale, 'messages.json');
    check(`默认语言包存在（_locales/${MANIFEST.default_locale}/messages.json）`, fs.existsSync(localeFile), true);

    let MESSAGES = {};
    let parseOk = true;
    try {
      MESSAGES = JSON.parse(fs.readFileSync(localeFile, 'utf8'));
    } catch {
      parseOk = false;
    }
    // messages.json 语法错误会让整个扩展加载失败（Chrome/Edge 都会直接报错）
    check('messages.json 是合法 JSON', parseOk, true);
    check('locale 目录名是合法 locale（下划线 + 地区）',
      /^[a-z]{2,3}(_[A-Z]{2})?$/.test(MANIFEST.default_locale), true);

    const expand = (value) => {
      const keys = [];
      const text = String(value).replace(/__MSG_([A-Za-z0-9_@]+)__/g, (_, key) => {
        keys.push(key);
        return (MESSAGES[key] && MESSAGES[key].message) || '';
      });
      return { text, keys };
    };

    check('name 用的是 __MSG_ 引用（未写死中文）', /^__MSG_.*__$/.test(MANIFEST.name), true);
    check('description 用的是 __MSG_ 引用（未写死中文）', /^__MSG_.*__$/.test(MANIFEST.description), true);

    for (const [field, value, limit] of [['name', MANIFEST.name, 75], ['description', MANIFEST.description, 132]]) {
      const { text, keys } = expand(value);
      check(`${field} 的每个 __MSG_ 键都能在语言包里查到`, keys.filter((k) => !MESSAGES[k]), []);
      check(`${field} 展开后不含未替换的 __MSG_ 残留`, text.includes('__MSG_'), false);
      check(`${field} 展开后非空`, text.trim().length > 0, true);
      // 商店对条目名 / 摘要长度有硬限制，超了会直接拒绝提交
      check(`${field} 展开后不超过 ${limit} 字符（商店限制）`, text.length <= limit, true);
    }

    const { text: extName } = expand(MANIFEST.name);
    const { text: extDesc } = expand(MANIFEST.description);
    check('展开后的扩展名是 BiliSpeed', extName, 'BiliSpeed');
    check('展开后的描述是 B站自定义倍速', extDesc, 'B站自定义倍速');

    // 词条本身要能替换出来：每个 __MSG_ 键都得有非空 message
    for (const key of ['extName', 'extDesc']) {
      check(`语言包词条 ${key} 有非空 message`,
        Boolean(MESSAGES[key]) && typeof MESSAGES[key].message === 'string' && MESSAGES[key].message.length > 0, true);
    }
  }

  console.log('\n[2] 页面里出现悬浮按钮（Shadow DOM 隔离，不动页面结构）');
  {
    const env = createEnv();
    check('宿主元素已挂到 body 末尾', Boolean(env.host), true);
    check('宿主元素 id 稳定', env.host.id, 'bilispeed-floating-root');
    check('宿主元素不影响页面布局（fixed + all:initial）',
      /position:\s*fixed/.test(env.host.style.cssText) && /all:\s*initial/.test(env.host.style.cssText), true);

    const button = env.shadow._button;
    const panel = env.shadow._panel;
    check('按钮是 <button>（键盘可用）', button.tagName, 'BUTTON');
    check('按钮默认 aria-expanded=false', button.getAttribute('aria-expanded'), 'false');
    check('按钮与面板做了无障碍关联', button.getAttribute('aria-controls'), panel.id);
    check('面板默认收起', panel.classList.contains('is-open'), false);
    check('面板初始不含 iframe（省一次扩展页面加载）', panel.querySelectorAll('iframe').length, 0);
    check('轻提示默认不显示', env.shadow._hint.classList.contains('is-shown'), false);
    check('轻提示不吃鼠标事件', /\.hint\s*\{[\s\S]*?pointer-events:\s*none/.test(env.shadow._style.textContent), true);

    const css = env.shadow._style.textContent;
    // 叠放次序：按钮 > 面板 > 轻提示（按钮永远压在最上面，不会被面板挡住）
    const zOf = (sel) => Number((css.match(new RegExp(`\\${sel}\\s*\\{[\\s\\S]*?z-index:\\s*(\\d+)`)) || [])[1]);
    check('按钮压在最上层', zOf('.launcher') > zOf('.panel'), true);
    check('面板压住轻提示', zOf('.panel') > zOf('.hint'), true);
    check('按钮与面板样式都在 Shadow DOM 内', css.includes('.launcher') && css.includes('.panel'), true);
    check('按钮固定右下角', /\.launcher\s*\{[\s\S]*?position:\s*fixed[\s\S]*?right:/.test(css), true);

    // ---- 小巧：一个小圆，不写扩展名 ----
    check('按钮是小圆（32px 圆形）', /\.launcher\s*\{[\s\S]*?width:\s*32px;[\s\S]*?height:\s*32px;/.test(css)
      && /\.launcher\s*\{[\s\S]*?border-radius:\s*50%/.test(css), true);
    check('按钮上不写扩展名（名字只在面板里）', env.shadow._html.includes('class="label"'), false);
    check('按钮用图标 + title 说明用途',
      env.shadow._html.includes('class="icon"') && env.shadow._html.includes('title="BiliSpeed 倍速控制"'), true);

    // ---- 不留外壳：页面里只有 popup 自己那一层圆角框 ----
    check('面板宽度就是界面本体宽度（296px）', /\.panel\s*\{[\s\S]*?width:\s*296px/.test(css), true);
    check('面板自己不设底色（不垫出一圈边框）', /\.panel\s*\{[^}]*background:/.test(css), false);
    check('面板自己不描边（不再双层轮廓）', /\.panel\s*\{[^}]*border:/.test(css), false);
    check('只靠很轻的投影把面板托起来',
      /\.panel\s*\{[\s\S]*?box-shadow:[\s\S]*?0 20px 40px -26px/.test(css), true);

    // ---- 圆角：面板 / iframe / 界面本体三者必须成套 ----
    const panelRadius = Number((css.match(/\.panel\s*\{[\s\S]*?border-radius:\s*(\d+)px/) || [])[1]);
    const frameRadius = Number((css.match(/\.panel iframe\s*\{[\s\S]*?border-radius:\s*(\d+)px/) || [])[1]);
    const bodyRadius = Number((POPUP_CSS.match(/--radius-lg:\s*(\d+)px/) || [])[1]);
    check('iframe 圆角与界面本体一致（都是 --radius-lg）', frameRadius, bodyRadius);
    check('面板圆角略大于界面（给投影留位，外圈不露直角）', panelRadius > bodyRadius, true);
    check('圆角已经调大（≥20px，观感柔和）', bodyRadius >= 20, true);
    check('面板裁剪溢出，圆角才真正生效',
      /\.panel\s*\{[\s\S]*?overflow:\s*hidden/.test(css), true);

    // ---- 高度链路：iframe 不能是 100%，否则会和面板互相喂饭 ----
    check('iframe 高度由 JS 写死，CSS 里不是 100%',
      /\.panel iframe\s*\{[\s\S]*?height:\s*(?!100%)/.test(css), true);

    // 名字不再单独占一行：面板里就是界面本体（品牌行已移除）
    check('面板里不再有品牌行', /class="brand"/.test(HTML), false);
    check('加载中的兜底文案也去掉品牌名，保持面板轻巧',
      env.shadow._html.includes('BiliSpeed 加载中'), false);
    check('面板宽度与界面本体一致（popup.css 里 body 就是 296px）',
      /body\s*\{[\s\S]*?width:\s*296px/.test(POPUP_CSS), true);
    // 界面本体必须是透明外框 + 一层圆角：否则又会出现「白框套圆角」
    const cssNoShared = POPUP_CSS.replace(/html,\s*body\s*\{[\s\S]*?\n\}/g, '');
    const bodyRule = (cssNoShared.match(/(?:^|\n)body\s*\{[\s\S]*?\n\}/) || [''])[0];
    check('界面最外层 html/body 背景透明、margin/padding 为 0',
      /html,\s*body\s*\{\s*margin:\s*0;\s*padding:\s*0;\s*background:\s*transparent;/.test(POPUP_CSS), true);
    check('body 自己不再用 padding 垫出一圈方底', /padding:/.test(bodyRule), false);
  }

  console.log('\n[3] 点击按钮 -> 面板加载真实的 popup.html（界面不重复实现）');
  {
    const env = createEnv();
    const button = env.shadow._button;
    const panel = env.shadow._panel;

    button._fire('click');
    check('按钮切换为展开态', button.getAttribute('aria-expanded'), 'true');
    check('面板展开', panel.classList.contains('is-open'), true);
    check('只向扩展要了 popup.html', env.urlCalls, ['popup.html']);
    const frameEl = panel.querySelector('iframe');
    check('iframe 的地址就是 popup.html', frameEl.src, `${EXT_ORIGIN}popup.html`);
    check('iframe 铺满面板（外缩 1px，正是投影的圆角所在）',
      /\.panel iframe\s*\{[\s\S]*?width:\s*calc\(100% - 2px\)[\s\S]*?margin:\s*1px/.test(env.shadow._style.textContent), true);
    check('打开时露一句轻提示', env.shadow._hint.classList.contains('is-shown'), true);

    // 面板里就是同一份 popup.html 的界面（#status 已按需求删除，不在此列）
    for (const id of ['rateSlider', 'rateValue', 'resetBtn', 'closeBtn']) {
      check(`界面元素 #${id} 来自 popup.html`, HTML.includes(`id="${id}"`), true);
    }

    await wait(20);
    check('加载完成后撤掉兜底卡片', panel.dataset.state, 'ready');
    check('打开后向外层握了手（告诉面板它被内嵌了）',
      frameEl._posted.some((m) => m.type === 'bilispeed:panelHello'), true);
  }

  console.log('\n[3b] 面板高度：由面板自己上报（跨源只能这样），不再留空白');
  {
    const env = createEnv();
    const panel = env.shadow._panel;
    env.shadow._button._fire('click');
    await wait(20);
    const frameEl = panel.querySelector('iframe');

    // 建立“面板 -> 外层”的消息来源校验
    env.win._fire('message', { data: { type: 'bilispeed:panelHello' }, source: frameEl.contentWindow });

    // 面板上报内容高度 318px
    env.win._fire('message', {
      data: { type: 'bilispeed:panelHeight', height: 318 },
      source: frameEl.contentWindow,
    });
    check('iframe 高度按上报值设置', frameEl.style.height, '318px');
    check('面板高度 = 上报值 + 上下各 1px 边距', panel.style.height, '320px');

    // 内容变高（例如出现状态提示）后再次上报
    env.win._fire('message', {
      data: { type: 'bilispeed:panelHeight', height: 372 },
      source: frameEl.contentWindow,
    });
    check('内容变高后面板跟着长高', panel.style.height, '374px');

    // 反复上报同一个值必须稳定，不能自我放大
    const heights = [];
    for (let i = 0; i < 5; i += 1) {
      env.win._fire('message', {
        data: { type: 'bilispeed:panelHeight', height: 372 },
        source: frameEl.contentWindow,
      });
      heights.push(panel.style.height);
    }
    check('反复上报后高度稳定（不自我放大）', [...new Set(heights)], ['374px']);

    // 异常值忽略
    env.win._fire('message', { data: { type: 'bilispeed:panelHeight', height: 5 }, source: frameEl.contentWindow });
    check('过小的高度被忽略（还没排版好）', panel.style.height, '374px');
    env.win._fire('message', { data: { type: 'bilispeed:panelHeight', height: NaN }, source: frameEl.contentWindow });
    check('非法高度被忽略', panel.style.height, '374px');

    // 别的窗口发来的高度不许改面板
    env.win._fire('message', { data: { type: 'bilispeed:panelHeight', height: 999 }, source: { fake: true } });
    check('不理会来路不明的高度上报', panel.style.height, '374px');
  }

  console.log('\n[3c] 跨源约束：不许再去读 iframe 内部（那正是空白的根因）');
  {
    // 只检查会执行的代码，注释里提到 contentDocument 是在解释“为什么不能这么干”
    const code = SRC
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/(^|\s)\/\/.*$/, ''))
      .join('\n');
    check('代码里没有访问 iframe.contentDocument', /contentDocument/.test(code), false);
    check('代码里没有访问 iframe.contentWindow.document', /contentWindow\.document/.test(code), false);
    check('没有给 iframe 加 sandbox（不必要且会改变源）',
      /setAttribute\('sandbox'/.test(code), false);
    check('高度靠 postMessage 协议传输', /bilispeed:panelHeight/.test(code), true);
    check('popup.js 侧有对应的上报实现', /bilispeed:panelHeight/.test(POPUP), true);
    // 桩必须如实模拟跨源：读 contentDocument 要抛错
    const env = createEnv();
    env.shadow._button._fire('click');
    const frameEl = env.shadow._panel.querySelector('iframe');
    let threw = false;
    try { void frameEl.contentDocument; } catch (err) { threw = true; }
    check('测试桩里读 contentDocument 会抛错（与真实浏览器一致）', threw, true);
  }

  console.log('\n[4] 收起：再点按钮 / 点页面别处 / Esc / 切换标签页');
  {
    const env = createEnv();
    const button = env.shadow._button;
    const panel = env.shadow._panel;

    button._fire('click');
    await wait(20);
    button._fire('click');
    check('再点一次收起', panel.classList.contains('is-open'), false);
    check('收起时丢弃 iframe（下次打开重新读当前速度）', panel.querySelectorAll('iframe').length, 0);
    check('收起后 aria-expanded=false', button.getAttribute('aria-expanded'), 'false');

    button._fire('click');
    await wait(20);
    env.document._fire('click', { target: env.document.body, composedPath: () => [env.document.body] });
    check('点页面别处收起', panel.classList.contains('is-open'), false);

    button._fire('click');
    await wait(20);
    env.document._fire('keydown', { key: 'Escape' });
    check('Esc 收起', panel.classList.contains('is-open'), false);
    check('Esc 后焦点回到按钮', button._focused, true);
  }

  console.log('\n[4a] 面板右上角的「×」：面板请外层收起（扩展页面收不了自己的 iframe）');
  {
    const env = createEnv();
    const button = env.shadow._button;
    const panel = env.shadow._panel;

    button._fire('click');
    await wait(20);
    const frameEl = panel.querySelector('iframe');
    check('打开后向外层握了手', env.posted, [{ target: frameEl.contentWindow, message: { type: 'bilispeed:panelHello' } }]);
    check('握手的目标就是面板自己', env.posted[0].target, frameEl.contentWindow);

    env.win._fire('message', { data: { type: 'bilispeed:panelClose' }, source: frameEl.contentWindow });
    check('收到 panelClose 后收起', panel.classList.contains('is-open'), false);
    check('收起后焦点回到按钮', button._focused, true);

    // 别的窗口发来的同名消息不该把面板关掉
    button._fire('click');
    await wait(20);
    env.win._fire('message', { data: { type: 'bilispeed:panelClose' }, source: { fake: true } });
    check('不理会来路不明的 panelClose', panel.classList.contains('is-open'), true);
  }

  console.log('\n[4b] 切走标签页时自动收起（与原生弹窗一致的手感）');
  {
    const env = createEnv();
    const panel = env.shadow._panel;
    env.shadow._button._fire('click');
    await wait(20);
    check('先展开', panel.classList.contains('is-open'), true);
    await wait(520); // 刚打开的一瞬间不误收（点击会先带走窗口焦点）
    env.win._fire('blur');
    check('焦点移出浏览器窗口时收起', panel.classList.contains('is-open'), false);
  }

  console.log('\n[5] 边界：视频全屏时让位、加载失败时给人话、扩展刚更新不崩');
  {
    const env = createEnv();
    const panel = env.shadow._panel;
    env.document.fullscreenElement = env.shadow._button; // 模拟进入全屏
    env.document._fire('fullscreenchange');
    check('全屏时按钮隐藏', env.host.style.visibility, 'hidden');
    env.document.fullscreenElement = null;
    env.document._fire('fullscreenchange');
    check('退出全屏后恢复', env.host.style.visibility, '');

    env.shadow._button._fire('click');
    const frame = panel.querySelector('iframe');
    frame._fire('error');
    check('加载失败会给出人话提示', panel.querySelector('.fallback').textContent, '面板加载失败，刷新页面后重试');
    panel && check('失败态有独立标记', panel.dataset.state, 'failed');

    const broken = createEnv({ popupUrlWorks: false });
    broken.shadow._button._fire('click');
    check('取不到界面地址时不抛错、只提示重新加载扩展',
      broken.shadow._panel.querySelector('.fallback').textContent, '扩展刚刚更新过，重新加载一下扩展即可使用');
    check('取不到地址时不创建 iframe', broken.shadow._panel.querySelectorAll('iframe').length, 0);
  }

  console.log('\n[6] 深色偏好只影响按钮自己');
  {
    const env = createEnv({ dark: true });
    check('跟随系统深色', env.host.classList.contains('dark'), true);
    const light = createEnv({ dark: false });
    check('浅色下不加 dark 类', light.host.classList.contains('dark'), false);
  }

  console.log('\n[7] 职责边界：悬浮按钮完全不碰倍速逻辑');
  {
    // 去掉注释里的说明文字，只看真正会执行的代码
    const code = SRC
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/(^|\s)\/\/.*$/, ''))
      .join('\n');
    for (const banned of ['playbackRate', 'chrome.storage', 'chrome.tabs', 'bilispeed:set', 'bilispeed:get']) {
      check(`代码里不出现 ${banned}`, code.includes(banned), false);
    }
    check('只用了一次 getURL（就为了拿 popup.html）', (code.match(/getURL\(/g) || []).length, 1);
    check('没有运行期字符串拼接出来的界面地址（只有一个常量）',
      /POPUP_PAGE = 'popup\.html'/.test(code), true);
    check('界面方框尺寸固定，不随页面样式变化',
      /\.panel\s*\{[\s\S]*?max-height:\s*calc\(100vh/.test(SRC), true);
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
