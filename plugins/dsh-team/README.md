# dsh-team

后台工单：把任务交给**独立的 Headless worker** 并行执行，不占用当前对话。给任何会话一个 `team` 工具——投单、看板、等结果；右侧栏里有一块实时看板。

## 界面

看板住在**右侧栏**（`sidebar.right.pane.tab`），和会话并排：工单在跑的时候你照常读对话，点开工单就在同一个右栏里展开报告，不弹窗、不遮住聊天。

| 位置 | 是什么 |
|---|---|
| 左侧栏图标 | 只画图标本身（尺寸由侧栏的 `props.size` 决定，不自带按钮盒子，所以和「插件」「自动化任务」等内置项对齐）；有活跃工单时右上角一个发光小点 |
| 会话标题栏「工单」按钮 | 同上 |
| 右栏 tab 标题 | 品牌色小灯 + 活跃数 |
| 右栏 tab 正文 | 列表：状态计数、投单表单、筛选（全部/进行中/已完成/失败） |
| 点开一行 | 同一栏内切到详情：`←` 返回、完整报告、输出目录、取消/重跑 |

tab 类型经官方 `sidebarRightTabs` 服务注册，`sidebarRight.openTab('dsh-team')` 打开——和 `serial-monitor` 同一套机制。

视觉沿用 `todo-list` / `stand-reminder` 那一套：品牌色渐变细线（面板顶沿、表单、报告块各一条）、发光状态灯（`box-shadow: currentColor`）、运行中工单左侧呼吸光条、等宽字体数字。样式只用 Host 主题 token，明暗主题自动跟随。

## 它解决什么

单个会话是串行的：你问一句，Agent 做一件，做完才能问下一件；跑测试的三十分钟里，这轮对话只能干等。

`dsh-team` 把"值得拆出去"的任务变成工单：

```
会话 ──team post──▶ 工单排队 ──dispatcher──▶ dsh headless worker（隔离进程）
   ▲                                              │
   └────────── team wait ◀── outbox/<id>/reply.md ┘
```

worker 是独立进程、独立会话，失败不拖累对话；`maxWorkers` 控制同时跑几个。

## 什么时候拆（写给模型的判据）

**拆**（满足任一条）：单个子任务预计超过 3 分钟；几件事互相独立、可以并行；任务要跑很久或要脱离本轮对话；产出是大块文本、只需归档。

**不拆**：一次工具调用就能拿到答案（查文件、grep、读知识库）；答案依赖本会话上下文；需要来回澄清——worker 看不到本会话，也不会反问你。

## 工具接口

一个工具 `team`，五个动作：

| action | 参数 | 说明 |
|---|---|---|
| `post` | `title`、`task`、`from?` | 投一张工单；`task` 必须自包含（路径、范围、验收标准）。带 `from: [id...]` 就是汇总单，见下节 |
| `board` | `status?` | 看板：排队/运行/完成/失败，每行带 id、状态、耗时、标题 |
| `wait` | `ids[]`、`timeoutMs?` | 阻塞等这些工单结束，返回每张的完整报告（默认 60 s，上限 600 s）。**只在必须本轮拿到结果时用**——正常情况下完成会自己推回来 |
| `cancel` | `id` | 只对排队中的工单有效 |
| `retry` | `id` | 把已结束的工单放回队列，保留 id |

## 完成即推送（不用 wait）

一张工单属于投它的那个 Session：`post` 时把 `sessionId` 记在工单上，worker 一结束，Host 就把报告作为一条**后续消息**推回该 Session：

```
agent.followup({ role: 'user', source: { kind: 'dsh-team', ticketId }, content: [报告] })
await sessions.flush(agent.session)
```

于是对话里的 Agent 会自己开口汇报，不需要谁去轮询。细节：

- **消息来源**：`source.kind = 'dsh-team'`，带 `ticketId`。DSH 的 source 是「各生产者各自声明 kind」的可扩展联合类型，未知 kind 由消费方忽略，所以不用抢 `schedule` / `goal` 的语义。
- **消息工厂在本地**：bundle 是 link 进来的目录，`@deepseek-ai/dsh-llm` 从那里 resolve 不到，所以按 `createMessage` 的形状自己构造（`{ id: randomUUID(), role: 'user', content, source }` + 深冻结）——`createUserMessage` 运行时做的事就是这个。
- **agent 从哪来**：`post` 的工具调用带着 `exec.agent`（agent loop 注入），直接记住；Host 重启过、手上没有活 agent 时，用 `sessionController.resolveAgent(sessionId)` 找回（会触发 Session 恢复）。都找不到就**不推**——宁可不打扰，也不写进一个没人看的会话。
- **不重复**：工单上有 `notifiedAt`，推送成功后落盘；进程内还有一个 `attempted` 集合兜住「改状态 → onChange → 再推送」的回环。
- **不重放旧账**：Host 启动时先把已结束的工单标成已通知，免得重启后把昨天的报告再推一遍。
- **面板投的单不推**：Web 面板投的工单没有会话（`sessionId` 为空），只在看板上出现。
- 配置：`notify`（默认 `true`）、`notifyMaxChars`（默认 4000，超出的部分留在 `reply.md`）。

## 汇总单（把合并交给 worker）

`post` 带 `from: [上游 id...]` 就是一张汇总单。它解决的是分片评审的老问题：多张工单各说各的，横向对比要人来写。

- **门控**：汇总单一直排在队列里，等上游全部结束（`done` / `failed` / `canceled` 都算结束）才开跑；它不会堵住后面排队的其它工单，被取消的上游也不会把它卡死。
- **拼装**：开跑时 dispatcher 把上游的报告拼在 task 后面——每张最多 6000 字符、合计最多 14 K，超出就截断并指向 `reply.md` 的完整文件。worker 于是不必重读上游读过的文件，省掉的就是那部分重复开销。
- **可见**：看板上这类工单显示 `⏸ … 等 N 张上游`。
- **收口**：汇总单的产出照常推回投单会话，于是「投片 → 汇总 → 回话」整条链上没有人工环节。

典型用法是一轮投完：先投 A / B / C，再投 `from: [A,B,C]` 的汇总单，然后继续做别的事，等四条通知。实测（两个 hal 模块 + 一张汇总单，真 worker）：上游 11 s / 14 s 完成，汇总单在上游都结束后才开始，17 s 完成，`task.txt` 里带着两份上游报告，最终报告直接对比了两者而不需要重读源码。

## 状态与文件

默认在 `<DSH_HOME>/dsh-team/`：

| 路径 | 内容 |
|---|---|
| `tickets.json` | 工单表（原子写：temp + rename）；每张带 `sessionId`（谁投的）与 `notifiedAt`（报告推回去了没有） |
| `worktrees/<id>/` | 该工单的工作目录，worker 的唯一可写区之一 |
| `outbox/<id>/` | `task.txt`（含 preamble）、`reply.md`、`log.txt`、`exit` |

配置（`cordis.patch.yml`）：`stateDir`、`maxWorkers`（默认 3）、`timeoutMs`（默认 1 h）、`dshBin`（默认 PATH 上的 `dsh`）、`patchFile`（可选，传给 `dsh headless --patch`，用来固定 worker 的模型路由）、`notify`、`notifyMaxChars`。

## 凭据与 worker 的模型

`dsh headless` 子进程不会自动继承 Host 的 provider 凭据，直接跑会得到
`MISSING_CREDENTIAL`。所以 runner 在 spawn 前读取 `<DSH_HOME>/.credentials.yaml`
的 `refs:` 段，把 `*_KEY` 形状的变量注入子进程环境（`process.env` 优先于文件）。

worker 的模型路由用 `patchFile` 固定，**不要**依赖 `~/.dsh/profiles/headless`
——那个 profile 的 patch 会被 DSH 配置编辑器覆写。一个可用的
`<DSH_HOME>/dsh-team/worker.patch.yml`：

```yaml
- insert:
    - id: llm-pi-ai
      name: '@deepseek-ai/dsh-llm-pi-ai'
      config:
        providers:
          southchip:
            apiKeyEnv: SOUTHCHIP_API_KEY
            api: openai-completions
            baseURL: https://litellm.southchips.net/
            models:
              - id: sc-deepseek-flash
                name: sc-deepseek-flash
- id: agent-default-model
  config:
    provider: southchip
    model: sc-deepseek-flash
```

## 并发与吞吐（实测）

测量条件：Windows / `sc-deepseek-flash` / 单轮约 7 s；6 张同构工单（`D:\wireless\firmware` 的 hal 六个模块，各读自己那两个文件、交一张接口契约表）同时开工。

| 指标 | 数值 |
|---|---|
| 墙钟 | 74.6 s |
| 逐张串行相加 | 325.7 s |
| 加速比 | **4.37×** |
| 总轮次 | 35（平均 5.8 轮/张，无重复探索） |
| 单轮延迟 | 6.6 ~ 9.3 s（基线单张 7.4 s，约 +15%） |
| 排队 / 失败 | 0 / 0 |

由此定下的用法：

- **只读分析类任务（读几个文件 → 交一份成品）可以把 `maxWorkers` 开到 6**。它是热生效的：改 profile patch 后不用重启 Host，下一张工单就按新值调度。
- **编译 / 门禁 / 烧录类批处理保持 2~3**。它们抢的是 CPU、同一份工具链和串口，不是模型延迟；6 个 `make` 同时跑只会互相拖慢。
- **同构切片近乎零冗余**（每张只读自己那两个文件）；但**把一个需要统一结论的任务按目录切开，冗余极大**：同一仓库的架构评审切 3 片时总轮次 69 → 119（+72%），墙钟只从 513 s 降到 376 s（-27%），算上人工合并净收益约 -18%。切法比并发度重要。
- **轮次不等于耗时上限**：`steps` 只数推理轮，最终长表格的生成不吃轮次（同批里 4 轮写出 2409 字的那张，单轮看着像 16.9 s）。

## 已知边界

- **worker 冷启动约 3 s**：每张工单一次进程启动，短任务不划算（所以判据是 3 分钟以上）。
- **worker 看不到本会话**：任务必须自包含。
- **Host 退出时正在跑的工单会被标记失败**（下次激活时规范化），不会自动续跑；排队中的会继续。
- **取消只管排队中的**：正在跑的 worker 不杀，避免半写状态。
- **没有面板**：目前只有 `team board` 和 `/plugins/dsh-team/state` 路由；侧栏 UI 是下一步。
- **Windows**：`CreateProcess` 只认 `.exe`，而 npm / Desktop 装出来的 `dsh` 是 `.cmd` 垫片（同目录里那个无扩展名的 `dsh` 是 POSIX 脚本，跑不了）。所以 runner 先按 PATH + `PATHEXT` 把名字解析成真实文件，`.cmd`/`.bat` 走 `cmd.exe /d /s /c`，`.ps1` 走 `powershell -File`；超时用 `taskkill /t /f` 杀整棵进程树——只杀 `cmd.exe` 会留下 worker 和它的管道。`dshBin` 留空即可，也可以直接写 `dsh.cmd` 的绝对路径。测试夹具（`test/fake.mjs`）在 Windows 上生成同样的 `.cmd` 垫片，四支测试在 Windows 上都能跑。

## 测试

```sh
node test/store.mjs       # 持久化、状态规范化、报告截断
node test/dispatcher.mjs  # 并发上限、失败回退、取消/重试
node test/runner.mjs      # 假 dsh：成功/非零退出/超时/找不到可执行文件
node test/plugin.mjs      # 假 Cordis ctx：注册、post → wait 全链路、完成推送
```

## 安装

```
plugin_manager { action: "install_bundle", target: "/home/airliu/dsh-plugins/plugins/dsh-team" }
```

或命令行：`dsh plugin --profile web add "link:/home/airliu/dsh-plugins/plugins/dsh-team"`，然后重启 Host。

Windows Desktop 版的 `desktop` profile 由 Electron 独占（`dsh plugin --profile desktop` 会被拒），装法是让 `package.json` 里出现 `"@local/dsh-team": "link:D:/.../plugins/dsh-team"` 并把它加进 `dsh.profile.bundles`，跑一次 pnpm 之后重启应用；worker 的模型路由另用 profile patch 里的 `patchFile` 指向 `<DSH_HOME>/dsh-team/worker.patch.yml`。
