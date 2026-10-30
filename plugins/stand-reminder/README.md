# @local/stand-reminder

DSH Web GUI 的久坐提醒插件。默认每 60 分钟弹出一次提醒窗，让你站起来；点「我站起来了」后进入休息倒计时（默认 2 分钟，环形进度 + 分秒），也可以「稍后 10 分钟」「跳过这次」。窗口浮在页面上、带一层淡遮罩，不改变会话内容；标题栏的「站一站」按钮一直显示距离下次提醒还有多久，点开是设置页。

> 座位：`conversation.session.header.utilities`（会话标题栏的「站一站」入口 + 倒计时）+ `shell.overlay`（提醒窗本体，全局浮层）。不占主区域、不抢右侧栏。

## 为什么时间由 Host 记

日程归 Host 管，存在 `<DSH_HOME>/stand-reminder/state.json` 里，浏览器只负责显示和上报操作：

- **刷新页面不会重置这一小时**。关掉标签页再打开，倒计时接着走，不会因为刷新而从 60 分钟重新开始。
- **只有开着页面才会提醒**。没有页面在听（SSE 没连上）时，到点不弹窗、也不悄悄积攒；下次连上时重新锚定，避免开页面瞬间被一串迟到的提醒淹没。
- **迟到超过 10 分钟就顺延**。机器睡眠/页面关了很久，回来时那条提醒已经没意义：直接重新锚定，不弹旧窗。
- 同一时刻只保留一个未处理的提醒（按 `at` 去重；正在休息时不会被第二个 `due` 打断）。

## 一圈的流程

1. 计时到点，Host 推 `due`，页面弹出提醒窗（带提示音）。
2. **我站起来了 · 休息 2 分钟** → 记一次站立，进入休息倒计时；倒计时结束显示「休息结束」，6 秒后自动关。
3. 休息中可 **提前坐下**（结束这次休息，回到正常计时）。
4. 不想现在站：**稍后 10 分钟**、**跳过这次**（按一个完整间隔顺延），或 `×` / `Esc` / 点空白处（等于稍后提醒）。
5. **设置**：开关提醒、间隔（30/45/60/90/120 分钟）、休息时长（1/2/3/5 分钟）、稍后时长（5/10/15/30 分钟）、提示音、后台系统通知；底部是今天的站立次数与累计休息分钟，「现在提醒一次」立刻试一下。

## 数据

- 默认文件：`<DSH_HOME>/stand-reminder/state.json`（Windows 默认 `C:\Users\<你>\.dsh\stand-reminder\state.json`）。`DSH_HOME` 未设置时退回 `~/.dsh`。
- 结构：`{ version, settings, enabled, nextDueAt, sittingSince, snoozedUntil, today: { date, stands, seconds } }`。
- 每次操作立刻落盘（写临时文件再 rename），损坏时把原文件备份成 `state.json.corrupt-<时间戳>`，从默认值开始。
- 跨天自动归零（按本机时区的 `YYYY-MM-DD`）。
- 配置（`cordis.patch.yml`）：
  - `file`：空 = 默认路径；相对路径按 `DSH_HOME` 解析；绝对路径原样使用。
  - `enabled` / `intervalMinutes` / `breakSeconds` / `snoozeMinutes` / `sound` / `notify`：**只是首次运行的种子**。窗口里改过的设置会写进 `state.json` 并在之后优先；想回到种子值就删掉这个文件。
  - 取值范围：间隔 5–480 分钟、休息 30–900 秒、稍后 1–60 分钟（越界自动夹住）。

## 窗口

- 四个面：提醒（站立按钮 + 稍后/跳过）、休息（128px 环形，`MM:SS`）、休息结束、设置。
- 手势：`Esc`、`×`、点遮罩空白处 = 稍后提醒；休息中是提前坐下。设置页里 `Esc` 只是关闭设置。
- 标题栏入口：「站一站 42m」倒计时 / 「站一站 关」；设置页打开时标题区会显示下一次的钟点。
- 声音：WebAudio 合成的两声短促提示（不依赖资源文件）；系统通知只在页面隐藏且已授权时发。
- 外观只用宿主主题 token（`--dsw-alias-*`），亮/暗色跟随；`prefers-reduced-motion` 下关闭动效；窄屏自动收窄到 `calc(100vw - 40px)`。

## 会话怎么用

| action | 作用 |
|---|---|
| `status` | 查看开关、间隔与下一次提醒时间 |
| `remind` | 现在推一次提醒（没有打开的页面时返回 `shown: false` 并说明原因） |
| `snooze` | 稍后提醒（`minutes` 可选，默认 10） |
| `skip` | 跳过这次，按一个完整间隔顺延 |
| `configure` | 改设置（`intervalMinutes` / `breakSeconds` / `snoozeMinutes` / `enabled` / `sound` / `notify`） |

```
stand_reminder { action: "status" }
stand_reminder { action: "snooze", minutes: 5 }
stand_reminder { action: "configure", intervalMinutes: 45 }
```

系统提示里有一节 `stand-reminder`：AI 知道这个工具存在，也知道「提醒是用户自己的节奏，不要主动催」。

## 结构

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半：路径解析、10 秒一跳的调度、5 条 HTTP 路由、`stand_reminder` 工具、系统提示一节 |
| `store.js` | 日程与设置本体：加载/校验/落盘/状态迁移（`stood`/`sat-down`/`snooze`/`skip`/`configure`），不依赖 Cordis，测试直接驱动 |
| `client.js` | Client 半：标题栏入口、四个窗口面、SSE 订阅、休息倒计时、提示音与系统通知 |
| `cordis.patch.yml` | 插入 `stand-reminder` 行 + 默认配置 |
| `locale/zh.json` / `locale/en.json` | 插件市场里的名称与介绍 |
| `test/store.mjs` | 存储/日程回归测试（无浏览器、无服务） |
| `test/host-routes.mjs` | Host 接线测试：最小 ctx 桩驱动 5 条路由 + 工具 + SSE |
| `test/client-window.mjs` | 客户端测试：迷你 React + 假 EventSource/fetch 驱动四个面 |

路由都过 `connection.requestRejection` 的鉴权闸（裸 WebServer 路由默认不过闸）：

```
GET  /plugins/stand-reminder/state
GET  /plugins/stand-reminder/events            # text/event-stream：snapshot / state / due，20s 心跳
POST /plugins/stand-reminder/ack               # { action: stood | sat-down | snooze | skip, at?, breakSeconds?, minutes? }
POST /plugins/stand-reminder/settings          # { intervalMinutes?, breakSeconds?, snoozeMinutes?, sound?, notify?, enabled? }
POST /plugins/stand-reminder/remind            # 手动推一次
```

改动类请求成功返回 `{ ok: true, ...snapshot }`，失败 400 `{ error }`。浏览器优先用 SSE，建不起来时退回 5 秒轮询。

## 安装

在 Web GUI 左侧栏「插件」→ **添加插件** → 粘贴本地目录 `D:\wireless\dsh-plugins\plugins\stand-reminder` → 安装 → 立即启用 → 刷新页面（Ctrl+R）。如果插件页提示需要重启，重启 DSH。

装了 `plugin_manager` 的环境也可以直接：

```
plugin_manager { action: "install_bundle", target: "D:\\wireless\\dsh-plugins\\plugins\\stand-reminder" }
```

本地目录是软链语义，**别移动或删除源目录**。

## 验证

1. 刷新页面：标题栏出现「站一站 60m」之类的倒计时；点它打开设置页。
2. 设置页把间隔改成 30 分钟、休息 2 分钟 → 关闭设置，倒计时按钮跟着变。
3. 点「现在提醒一次」→ 立刻弹提醒窗，带提示音；点「我站起来了」→ 进入 02:00 环形倒计时。
4. 休息中点「提前坐下」→ 回到正常计时；再次「现在提醒一次」，用 `Esc` 关掉 → 按钮变成「站一站 10m」。
5. 把间隔改成 5 分钟，等一轮 → 自动弹出；**关掉标签页再等一轮 → 不弹**，重新打开后倒计时重新锚定（不会连续弹）。
6. `node test/store.mjs`、`node test/host-routes.mjs`、`node test/client-window.mjs` 都应打印 `ok`。

## 已知边界

- 只有**开着页面**时才会弹窗；标签页关掉/浏览器退出后不会提醒（也不会用系统级定时）。多个页面同时开着时，各自都会收到 `due` 并弹窗。
- 迟到超过 10 分钟的提醒直接顺延，不补弹。
- 系统通知需要浏览器授权，且只在页面隐藏时发；提示音受浏览器自动播放策略限制，第一次需要用户点一下窗口。
- 统计只有「今天」的次数与分钟数，没有历史报表；跨天归零。
- 只有一个计时实例（同一 profile 一份 `state.json`），不按 workspace / 会话分。
- 休息倒计时在本地按 `breakEndsAt` 校正：页面休眠再唤醒会立即对齐，不会多算。
- 依赖的公开面：`ctx.webServer.register`、`ctx.tools.register`、`ctx.systemPrompt.section`、`ctx.slots.inject/register`、`ctx.locale.register/bind`。DSH 大版本升级后按「验证」一节跑一遍。
