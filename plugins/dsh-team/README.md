# dsh-team

后台工单：把任务交给**独立的 Headless worker** 并行执行，不占用当前对话。给任何会话一个 `team` 工具——投单、看板、等结果；右侧抽屉里有一块实时看板。

## 界面

三处入口，共用同一份 SSE 推送：

| 位置 | 是什么 |
|---|---|
| 会话标题栏「工单」按钮 | 开/关抽屉 |
| 左侧栏图标 | 同上，右上角徽标显示「排队 + 运行」数 |
| 右侧抽屉 | 看板：状态计数、投单表单、筛选（全部/进行中/已完成/失败）、点开一行看报告与输出目录、取消与重跑 |

抽屉盖在页面上但不夺走对话：`Esc` 或 × 关闭，点遮罩也关。运行中的工单每 5 秒自然刷新（SSE 断开时自动降级为轮询）。样式只用 Host 主题 token，跟随明暗主题。

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
