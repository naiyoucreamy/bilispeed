/**
 * BiliSpeed - 快捷键词汇表（页面脚本与设置界面共用这一份）
 * ---------------------------------------------------------------
 * 为什么单独一个文件：
 *   快捷键要能被两边读懂 —— 页面里的监听（shortcut.js）和设置界面（popup.js）。
 *   但扩展的 content script 与扩展页面是两个世界，没有模块系统可以互相 import，
 *   所以做成「一份文件、两处加载」：
 *     · manifest.json 里当 content script 注入（排在 content.js 之后、shortcut.js 之前）
 *     · popup.html 里用 <script> 引一次
 *   默认键位、存储键、匹配规则、按键的显示文本因此只有一份，
 *   不会出现「设置界面显示的和页面里实际生效的不是一回事」。
 *
 * 这里只有常量与纯函数：不碰 DOM、不读写存储、不发消息 —— 所以 Node 里能直接测。
 *
 * 按键怎么存：
 *   存**物理键位**（KeyboardEvent.code）+ 四个修饰键的布尔值，而不是按键字符
 *   （KeyboardEvent.key）。这样输入法开着、按住 Shift、大小写锁定都不会让绑定
 *   失效：录的时候按的是哪个键，之后就一直认那个键。
 */

(function (root) {
  'use strict';

  /** 三个动作的默认键位：] 加速、[ 减速、\ 重置为 1x */
  const DEFAULT_BINDINGS = {
    faster: { code: 'BracketRight', ctrl: false, alt: false, shift: false, meta: false },
    slower: { code: 'BracketLeft', ctrl: false, alt: false, shift: false, meta: false },
    reset: { code: 'Backslash', ctrl: false, alt: false, shift: false, meta: false },
  };

  /** 动作清单：顺序就是设置界面上的顺序 */
  const ACTIONS = ['faster', 'slower', 'reset'];

  /** 配置存在 sync 区域：跟着账号走，换台电脑也还在 */
  const BINDINGS_KEY = 'bilispeed.shortcuts';
  const STEP_KEY = 'bilispeed.step';

  /** 步长的范围与粒度：与倍速滑块完全一致（0.25 ~ 16，粒度 0.25） */
  const MIN_STEP = 0.25;
  const MAX_STEP = 16;
  const STEP_UNIT = 0.25;
  const DEFAULT_STEP = 0.25;

  /**
   * 这些键按下去不产生字符，只表示「接下来要按组合键」。
   * 录制时遇到它们要继续等，不能把 Shift 本身录成一个快捷键。
   */
  const MODIFIER_CODES = [
    'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
    'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight',
    'CapsLock', 'NumLock', 'ScrollLock', 'ContextMenu', 'Fn', 'FnLock',
  ];

  /** 有专属写法的键：符号键、导航键、空白键 */
  const CODE_LABELS = {
    Backquote: '`',
    Minus: '-',
    Equal: '=',
    Backslash: '\\',
    BracketLeft: '[',
    BracketRight: ']',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    Space: '空格',
    Enter: '回车',
    NumpadEnter: '小键盘回车',
    Tab: 'Tab',
    Escape: 'Esc',
    Backspace: '退格',
    Delete: 'Delete',
    Insert: 'Insert',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
  };

  /**
   * 把一个键位代号变成界面上给人看的字。
   * 认不出来就直接显示代号本身 —— 宁可难看，也不要显示成空白。
   * @param {string} code KeyboardEvent.code
   * @returns {string}
   */
  function codeLabel(code) {
    if (typeof code !== 'string' || code === '') return '';
    if (CODE_LABELS[code]) return CODE_LABELS[code];
    let match = /^Key([A-Z])$/.exec(code);
    if (match) return match[1];
    match = /^Digit(\d)$/.exec(code);
    if (match) return match[1];
    match = /^Numpad(\d)$/.exec(code);
    if (match) return `小键盘${match[1]}`;
    return code;
  }

  /**
   * 系统键（Meta）在 Mac 上叫 Cmd、在 Windows 上叫 Win，别让用户猜。
   * 认不出平台时退回 Win —— 这只是显示文本，不影响绑定本身。
   * @returns {string}
   */
  function metaLabel() {
    try {
      const nav = typeof navigator !== 'undefined' ? navigator : null;
      const hint = nav ? `${nav.platform || ''} ${nav.userAgent || ''}` : '';
      return /Mac|iPhone|iPad/i.test(hint) ? 'Cmd' : 'Win';
    } catch (err) {
      return 'Win';
    }
  }

  /**
   * 规整步长：范围钳制 + 对齐 0.25 + 消除浮点误差。
   * 规则与倍速滑块保持一致，避免出现 3.7500000000000004 这种数。
   * @param {unknown} value
   * @returns {number}
   */
  function normalizeStep(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return DEFAULT_STEP;
    const clamped = Math.min(MAX_STEP, Math.max(MIN_STEP, num));
    const stepped = Math.round(clamped / STEP_UNIT) * STEP_UNIT;
    return Math.round(stepped * 100) / 100;
  }

  /**
   * 规整一条绑定；不合法（没有键位代号）时返回 null，由调用方决定退回什么。
   * @param {unknown} raw
   * @returns {{code: string, ctrl: boolean, alt: boolean, shift: boolean, meta: boolean}|null}
   */
  function normalizeBinding(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const code = typeof raw.code === 'string' ? raw.code : '';
    if (code === '') return null;
    return {
      code,
      ctrl: raw.ctrl === true,
      alt: raw.alt === true,
      shift: raw.shift === true,
      meta: raw.meta === true,
    };
  }

  /**
   * 规整整份配置：缺的、坏的、被手改乱的，一律退回默认键位。
   * 所以存储里是脏数据也不会让某个动作彻底失灵。
   * @param {unknown} raw
   * @returns {Record<string, {code: string, ctrl: boolean, alt: boolean, shift: boolean, meta: boolean}>}
   */
  function normalizeBindings(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const out = {};
    for (const action of ACTIONS) {
      out[action] = normalizeBinding(source[action]) || { ...DEFAULT_BINDINGS[action] };
    }
    return out;
  }

  /**
   * 这个键位代号是不是「单纯的修饰键」（或者是空值）。
   * @param {unknown} code
   * @returns {boolean}
   */
  function isModifierCode(code) {
    return typeof code !== 'string' || code === '' || MODIFIER_CODES.includes(code);
  }

  /**
   * 从一次 keydown 里取出可绑定的键位；只按了修饰键时返回 null（继续等下一个键）。
   * @param {KeyboardEvent} event
   * @returns {{code: string, ctrl: boolean, alt: boolean, shift: boolean, meta: boolean}|null}
   */
  function bindingFromEvent(event) {
    if (!event || isModifierCode(event.code)) return null;
    return {
      code: event.code,
      ctrl: event.ctrlKey === true,
      alt: event.altKey === true,
      shift: event.shiftKey === true,
      meta: event.metaKey === true,
    };
  }

  /**
   * 两条绑定是不是同一个键位（含修饰键，必须完全一致）。
   * @returns {boolean}
   */
  function sameBinding(a, b) {
    const x = normalizeBinding(a);
    const y = normalizeBinding(b);
    if (!x || !y) return false;
    return x.code === y.code
      && x.ctrl === y.ctrl && x.alt === y.alt && x.shift === y.shift && x.meta === y.meta;
  }

  /**
   * 这次键盘事件是不是触发了这条绑定。
   * 修饰键要求**精确匹配**：绑定的是 ]，那 Shift+] 不算 ——
   * 否则用户给两个动作分别绑 ] 和 Shift+] 时会同时触发。
   * @param {unknown} binding
   * @param {KeyboardEvent} event
   * @returns {boolean}
   */
  function matchesBinding(binding, event) {
    const b = normalizeBinding(binding);
    if (!b || !event || typeof event.code !== 'string') return false;
    return b.code === event.code
      && b.ctrl === (event.ctrlKey === true)
      && b.alt === (event.altKey === true)
      && b.shift === (event.shiftKey === true)
      && b.meta === (event.metaKey === true);
  }

  /**
   * 绑定在界面上的显示文本，例如 `[`、`Shift+]`、`Ctrl+Alt+K`。
   * @param {unknown} binding
   * @returns {string}
   */
  function describeBinding(binding) {
    const b = normalizeBinding(binding);
    if (!b) return '未设置';
    const parts = [];
    if (b.ctrl) parts.push('Ctrl');
    if (b.alt) parts.push('Alt');
    if (b.shift) parts.push('Shift');
    if (b.meta) parts.push(metaLabel());
    parts.push(codeLabel(b.code));
    return parts.join('+');
  }

  root.__BILISPEED_KEYS__ = {
    DEFAULT_BINDINGS,
    ACTIONS,
    BINDINGS_KEY,
    STEP_KEY,
    MIN_STEP,
    MAX_STEP,
    STEP_UNIT,
    DEFAULT_STEP,
    MODIFIER_CODES,
    codeLabel,
    metaLabel,
    normalizeStep,
    normalizeBinding,
    normalizeBindings,
    isModifierCode,
    bindingFromEvent,
    sameBinding,
    matchesBinding,
    describeBinding,
  };
})(typeof window !== 'undefined' ? window : globalThis);
