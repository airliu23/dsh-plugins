# @local/todo-list

DSH Web GUI 的个人待办清单插件。会话标题栏或左侧栏底部的「待办」按钮 → **悬浮小窗**：浮在页面上，聊天仍在下面；拖动标题移动，`×` 或 `Esc` 收起。手动添加、勾选、双击改名、删除、清除已完成。**会话通过 `todo` 工具读写同一份清单**，所以「把这件事记一下」既能在浮窗里做，也能在聊天里说。

> 座位：`conversation.session.header.utilities` + `sidebar.footer.action`（两个入口，同一个开关）+ `shell.overlay`（浮窗本体，id = `todo-list-float`）。不占主区域、不抢右侧栏 tab；切换会话或面板时浮窗留在原位。

## 和 `todo_write` 的区别

| | `todo_write` | 本插件 `todo` |
|---|---|---|
| 归属 | AI 本轮的执行计划 | 用户自己的清单 |
| 生命期 | 随会话/回合 | 长期，存本地文件 |
| 界面 | 聊天里的计划卡片 | 浮在页面上的「待办」小窗 |

两者互不影响：AI 用 `todo_write` 排任务不会改你的待办，反之亦然。系统提示里也写明了这条边界。

## 数据

- 默认文件：`<DSH_HOME>/todo-list/todos.json`（Windows 默认 `C:\Users\<你>\.dsh\todo-list\todos.json`）。`DSH_HOME` 未设置时退回 `~/.dsh`。
- 结构：`{ version: 1, items: [{ id, text, done, createdAt, doneAt }] }`，新的在上面。
- 每次改动立刻落盘（写临时文件再 rename，避免半个 JSON），并当场推给面板。
- 文件损坏时：把原文件备份成 `todos.json.corrupt-<时间戳>`，从空清单开始，面板顶部给出提示。
- 配置（`cordis.patch.yml`）：
  - `file`：空 = 默认路径；相对路径按 `DSH_HOME` 解析；绝对路径原样使用。
  - `maxItems`：条数上限，默认 500（硬顶 10000）。

## 浮窗

- 两个入口：会话标题栏的「待办」按钮，以及左侧栏底部 Settings 旁的勾选图标；两处都带未完成数徽标。点一次打开，再点收起。
- 浮窗：拖标题栏移动，`×` / `Esc` 收起；位置在当前页面会话内记住，刷新页面后回到默认位置（右侧垂直居中）。
- 外观：科技感 HUD 风格——12px 圆角卡片、品牌光晕、顶部光带和底部网格纹理；头部是切角图标、标题/等宽统计和带辉光的完成进度条；行 hover 有品牌色侧标、方形勾选框完成时发光、空状态是发光图标；底部有脉冲状态点；打开时轻微淡入（`prefers-reduced-motion` 下关闭）。
- 内容：未完成/总数统计、`全部 / 未完成 / 已完成` 过滤、`清除已完成`、添加行；每行圆形勾选框、内容（双击行内编辑，`Enter` 保存、`Esc` 取消）、右侧垃圾桶图标删除。
- 尺寸：宽 408（窄屏自适应 `calc(100vw - 24px)`），最大高 580，列表自己滚动（细滚动条）。
- 推送：Host 在每次变更后通过 SSE `/events` 推整份清单；会话用工具加一条，开着的浮窗和入口徽标立刻更新。浏览器断线自动重连，另带 5 s 慢轮询兜底。
- 只用宿主主题 token（`--dsw-alias-*`），亮/暗色跟随；不 import 任何 Harness 客户端包，`shell.overlay` 的空白区域保持点击穿透。

## 会话怎么用

| action | 作用 |
|---|---|
| `list` | 查看清单（`status: all / active / done` 过滤） |
| `add` | 添加一条（`text`） |
| `done` / `undone` | 勾选完成 / 取消完成（`id`） |
| `remove` | 删除（`id`） |
| `clear-done` | 清除全部已完成 |

`id` 可以传完整 id，也可以传 `list` 输出里的序号（1 开始）。序号始终是**整张清单**里的位置——即使按 `status` 过滤，输出了 `3. [ ]` 就传 `3`。工具结果就是同一份快照。

```
todo { action: "add", text: "周五前交周报" }
todo { action: "list", status: "active" }
todo { action: "done", id: "2" }
```

## 结构

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半：路径解析、7 条 HTTP 路由（`state/events/add/toggle/update/remove/clear-done`）、`todo` 工具、系统提示一节 |
| `store.js` | 清单本体：加载/校验/落盘/变更通知。不依赖 Cordis，测试直接驱动它 |
| `client.js` | Client 半：会话标题栏 / 左侧栏两个开关 + 可拖动浮窗、SSE 订阅、行内编辑 |
| `cordis.patch.yml` | 插入 `todo-list` 行 + 默认配置 |
| `test/store.mjs` | Host 存储回归测试（无浏览器、无服务） |
| `test/host-routes.mjs` | Host 接线测试：用最小 ctx 桩驱动 7 条路由 + `todo` 工具 |

路由都过 `connection.requestRejection` 的鉴权闸（裸 WebServer 路由默认不过闸）：

```
GET  /plugins/todo-list/state
GET  /plugins/todo-list/events            # text/event-stream：snapshot + 每次变更的 state
POST /plugins/todo-list/add               # { text }
POST /plugins/todo-list/toggle            # { id, done? }
POST /plugins/todo-list/update            # { id, text }
POST /plugins/todo-list/remove            # { id }
POST /plugins/todo-list/clear-done
```

改动类请求成功返回 `{ ok: true, ...snapshot }`，失败 400 `{ error }`。

## 安装

```
plugin_manager { action: "install_bundle", target: "D:\\wireless\\dsh-plugins\\plugins\\todo-list" }
```

装完刷新 Web GUI 页面（Ctrl+R）。本地目录是软链语义，**别移动或删除源目录**。

## 验证

1. `plugin_manager { action: "list_plugins" }` 能看到 `@local/todo-list`（行 id `include:todo-list`），状态启用。
2. 刷新页面：会话标题栏出现「待办」按钮，左侧栏底部 Settings 旁出现勾选图标。
3. 点任一个 → 浮窗弹出（默认右侧垂直居中），聊天仍可见；拖标题移动、点 `×` 或按 `Esc` 收起。
4. 输入一条并回车 → 立刻出现在列表里；勾选 → 划线并计入「已完成」；双击改名；`×` 删除。
5. 让会话 `todo { action: "add", text: "..." }` → 开着浮窗不用刷新就多一条，入口徽标同步 +1。
6. 重启 DSH → 清单还在（数据在 `todos.json`）。
7. `node test/store.mjs` 与 `node test/host-routes.mjs` 都应打印 `ok`。

## 已知边界

- 浮窗位置只在当前页面会话内记住；刷新页面后回到默认位置。固定宽度、不能缩放。
- 同一时间只有一个浮窗；收起只是隐藏，不影响聊天和其他面板。
- 清单是**全局**的，不按 workspace / session 分；要分区可以把 `file` 指到不同 profile 的配置上（每个 profile 一份）。
- 单条最长 500 字（多余的截断），按空白折叠成一行。
- 没有到期时间、提醒、拖拽排序；排序规则就是「新的在上」。
- 删除立即生效，没有撤销。
- 依赖的公开面：`ctx.webServer.register`、`ctx.tools.register`、`ctx.systemPrompt.section`、`ctx.slots.inject/register`、`ctx.locale.register/bind`。DSH 大版本升级后按「验证」一节跑一遍。
