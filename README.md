# BiliSpeed

一个自用的 B站倍速扩展，突破网页版 2 倍速限制，最高支持 16 倍速。

## 功能

- 支持 0.25x ~ 16x 调速，步进 0.25
- 常用速度快捷按钮：0.5x / 1x / 1.5x / 2x / 3x / 4x / 8x / 16x
- 滑块精细调节，实时显示当前速度
- 记住上次设置的速度，重开浏览器依然生效
- 切换视频、分P、SPA 路由跳转后速度保持不变
- 如果 B站播放器重置了速度，自动恢复为用户设置值
- 一键重置为 1x
- 非 B站页面自动禁用，避免干扰

## 两个入口，同一套界面

- **浏览器工具栏**：点扩展图标，弹出原生弹窗（原有方式，行为不变）
- **页面右下角的小圆按钮**：点一下，在按钮上方弹出同一个面板

两者加载的是同一份 `popup.html` / `popup.js`，所以界面、逻辑、行为完全一致，
速度也共享（同一个标签页同一个速度）。悬浮按钮只负责开关面板：

- 按钮是 32px 的小圆，只有图标不写名字，尽量不挡画面
- 展开出来的就是界面本体那一层圆角面板（`html`/`body` 全透明、无 margin/padding），
  面板的圆角、描边、底色都画在 `body` 上，所以**不会有方形白底露在圆角外面**
- 面板 296px 宽、紧凑布局，高度按界面内容自动量，不留空白也不出滚动条
- 收起靠面板右上角的「×」（平时隐形，鼠标移到面板上才显形），也可以点按钮 / 点页面别处 / 按 Esc / 切走标签页
- 视频进入全屏时按钮自动隐藏，退出全屏恢复

## 本地化（商店语言识别）

扩展名和描述走 `_locales` 本地化，不再写死在 manifest 里：

- `manifest.json`：`"default_locale": "zh_CN"`，`name` / `description` 用 `__MSG_extName__` / `__MSG_extDesc__`
- `_locales/zh_CN/messages.json`：`extName` = `BiliSpeed`，`extDesc` = `B站自定义倍速`

商店后台（Partner Center）判定扩展支持哪些语言，靠的就是这份 `__MSG_` 引用 + 对应语言包；
如果 manifest 里是写死的中文，后台只会识别出 `en-US`。

## 自测（不需要浏览器）

```bash
node tests/content.test.js     # 倍速逻辑：按标签页隔离、刷新恢复、SPA 跳转、性能契约
node tests/popup-ui.test.js    # 弹窗界面与下发流程（含悬浮面板内嵌打开的场景）
node tests/floating.test.js    # 悬浮按钮：清单注册、开关面板、本地化词条、边界情况
```

> 注意：自测目录必须叫 `tests`，不能叫 `_test` —— Chrome 不允许扩展目录里出现以
> 下划线开头的文件或目录（`Filenames starting with "_" are reserved for use by the system`），
> 否则扩展会直接加载失败。`tests/floating.test.js` 里有一条断言专门守着这个坑。
>
> 唯一的例外是 `_locales`：浏览器官方保留的本地化目录，必须叫这个名字，断言里已放行。

## 卡顿怎么查（性能自检）

如果感觉切换倍速时页面/视频卡顿，不用装 profiler，在**B 站页面的 Console** 里跑：

```js
await __bilispeed.profile()        // 默认观测 3 秒
await __bilispeed.profile(5000)    // 观测 5 秒
```

它会主动切一次速率并回报这些数据（跑完会把速度还原成你原来设的值）：

| 字段 | 看什么 |
| --- | --- |
| `perSecond` | 各监控机制**每秒触发多少次**。`poll` 稳定后应 ≈ 2；`mutationTotal` 高说明页面 DOM 在狂动 |
| `mechanism.qsa` | 每秒全篇 `querySelectorAll('video')` 次数。这是 DOM 扫描的总开销，越低越好 |
| `longTasks` | 主线程长任务（>50ms）的个数/总时长/最长一次。**这里非 0 才是真的“卡”** |
| `rateSwitchCost` | 单次 `setRate` 的同步耗时（毫秒）。正常应在 1ms 量级 |
| `videoState` | 播放器真实状态：`buffered` 缓冲区间、`droppedFrames` 丢帧数、`readyState` |

判读经验：

- `longTasks.count` 明显 > 0 且 `rateSwitchCost` 也大 → 是扩展脚本占住了主线程；
- `longTasks` 为 0、`rateSwitchCost` 极小，但视频仍卡 → **不是扩展的问题**，
  多半是播放器/解码侧（尤其高倍速、4K、PCDN 源），扩展只写了一个 `playbackRate`；
- `videoState.buffered` 很短或 `droppedFrames` 持续增长 → 是缓冲/解码跟不上，与扩展无关。


