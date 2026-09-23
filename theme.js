/**
 * BiliSpeed - 主题引导脚本
 * ---------------------------------------------------------------
 * 必须在 <head> 里**同步**执行，所以是独立文件而不是并进 popup.js：
 *   popup.js 挂在 </body> 前，那时页面可能已经绘制过一帧，
 *   暗色用户会先看到一瞬浅色底再翻黑（FOUC）。
 *   放在 <head> 的同步脚本会在首次绘制之前把 data-theme 定下来。
 *
 * 为什么用 localStorage 而不是 chrome.storage：
 *   只有 localStorage 能同步读。chrome.storage 是异步的，
 *   等它回来时多半已经画过一帧，白闪照样出现。
 *
 * 职责只有两件（都在首帧之前完成）：
 *   1. 把 memory 里的主题写到 <html data-theme="...">；
 *   2. 标出「当前被嵌在页面悬浮面板的 iframe 里」。
 * 第 2 条是因为同一个窗口既可能是工具栏弹窗、也可能是悬浮面板的 iframe，
 * 而这两者对 <html> 底色的要求正好相反，没法只靠一条 CSS 兼顾（见 popup.css）。
 */
(function () {
  'use strict';

  var THEME_KEY = 'bilispeed.theme';
  var root = document.documentElement;

  var theme = 'light';
  try {
    if (window.localStorage.getItem(THEME_KEY) === 'dark') theme = 'dark';
  } catch (err) {
    /* 读不到存储（隐私模式等）：退回浅色，不影响使用 */
  }
  root.setAttribute('data-theme', theme);

  try {
    if (window.top !== window) root.classList.add('is-embedded');
  } catch (err) {
    // 读 window.top 抛错 = 一定被嵌在跨源 iframe 里
    root.classList.add('is-embedded');
  }
})();
