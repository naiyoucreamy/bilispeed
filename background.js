/**
 * BiliSpeed - Service Worker
 * ---------------------------------------------------------------
 * 职责：
 *  1. 诊断：把各标签页上报的“当前速度 + 存储键 + 变更历史”打印到 worker
 *     控制台，用来一眼确认到底是不是“所有标签页共用一个速度”。
 *     页面 Console 里执行 __bilispeed.dump() 即可触发。
 *  2. 回答 content script 的 whoami（告诉它自己的 tabId）——**仅用于诊断显示**。
 *     速度的存储键已经改用页面 sessionStorage 里的随机 ID，不再依赖 tabId，
 *     所以这条链路即使失效也不影响功能。
 */

'use strict';

const SESSION_PREFIX = 'bilispeed.rate.';

/**
 * 把某个标签页的状态打到 service worker 控制台。
 * @param {object} report
 * @param {number|null} senderTabId
 */
function logTabReport(report, senderTabId) {
  const tabId = report.tabId ?? senderTabId;
  console.log(
    `[BiliSpeed] tab ${tabId} | ${report.url || '?'}\n`
    + `            目标速度: ${report.target}x | 页面实际: ${report.actual === null ? '无 video' : `${report.actual}x`}`
    + ` | 有无 video: ${report.hasVideo} | 视频身份: ${report.identity || '(非视频页)'}\n`
    + `            session 键: ${report.key || '(未绑定 tabId！退化为纯内存)'}\n`
    + `            其它标签页记录: ${Object.keys(report.otherTabs || {}).length
      ? JSON.stringify(report.otherTabs) : '(无)'}\n`
    + `            速度变更历史: ${JSON.stringify(report.history || [])}`,
  );
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return undefined;

  // ---- 诊断上报：由页面里的 __bilispeed.dump() 发出 ----
  if (message.type === 'bilispeed:debugDump') {
    const tabId = sender && sender.tab ? sender.tab.id : null;
    logTabReport(message.report || {}, tabId);
    // 顺手把整个 session 区域的键打出来（不打印具体速度，避免噪音）
    if (chrome.storage && chrome.storage.session) {
      chrome.storage.session.get(null)
        .then((all) => {
          const keys = Object.keys(all || {}).filter((k) => k.startsWith(SESSION_PREFIX));
          console.log(`[BiliSpeed] session 中现有 ${keys.length} 个标签页记录：`, keys.sort());
        })
        .catch(() => {});
    }
    sendResponse({ ok: true, tabId });
    return true;
  }

  // ---- whoami：告诉调用方它自己的 tabId ----
  if (message.type === 'bilispeed:whoami') {
    const tabId = sender && sender.tab ? sender.tab.id : null;
    sendResponse({ ok: tabId !== null && tabId !== undefined, tabId: tabId ?? null });
    return true;
  }

  return undefined;
});
