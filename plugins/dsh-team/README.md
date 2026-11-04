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
| `post` | `title`、`task` | 投一张工单；`task` 必须自包含（路径、范围、验收标准） |
| `board` | `status?` | 看板：排队/运行/完成/失败，每行带 id、状态、耗时、标题 |
| `wait` | `ids[]`、`timeoutMs?` | 阻塞等这些工单结束，返回每张的完整报告（默认 60 s，上限 600 s） |
| `cancel` | `id` | 只对排队中的工单有效 |
| `retry` | `id` | 把已结束的工单放回队列，保留 id |

## 状态与文件

默认在 `<DSH_HOME>/dsh-team/`：

| 路径 | 内容 |
|---|---|
| `tickets.json` | 工单表（原子写：temp + rename） |
| `worktrees/<id>/` | 该工单的工作目录，worker 的唯一可写区之一 |
| `outbox/<id>/` | `task.txt`（含 preamble）、`reply.md`、`log.txt`、`exit` |

配置（`cordis.patch.yml`）：`stateDir`、`maxWorkers`（默认 3）、`timeoutMs`（默认 1 h）、`dshBin`（默认 PATH 上的 `dsh`）、`patchFile`（可选，传给 `dsh headless --patch`，用来固定 worker 的模型路由）。

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
node test/plugin.mjs      # 假 Cordis ctx：注册、post → wait 全链路
```

## 安装

```
plugin_manager { action: "install_bundle", target: "/home/airliu/dsh-plugins/plugins/dsh-team" }
```

或命令行：`dsh plugin --profile web add "link:/home/airliu/dsh-plugins/plugins/dsh-team"`，然后重启 Host。

Windows Desktop 版的 `desktop` profile 由 Electron 独占（`dsh plugin --profile desktop` 会被拒），装法是让 `package.json` 里出现 `"@local/dsh-team": "link:D:/.../plugins/dsh-team"` 并把它加进 `dsh.profile.bundles`，跑一次 pnpm 之后重启应用；worker 的模型路由另用 profile patch 里的 `patchFile` 指向 `<DSH_HOME>/dsh-team/worker.patch.yml`。
