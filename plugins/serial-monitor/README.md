# @local/serial-monitor

DSH Web GUI 的串口监视。**谁管端口是硬边界：只有用户能开/关串口，会话只能读数据。**不做任何波特率探测；支持同时回显多路 `port@baud`。日志是**右侧栏的一个 tab**，聊天在左、串口在右，不悬浮、不遮挡消息。

> 座位：`sidebar.right.pane.tab`（key = `@local/serial-monitor`）+ `sidebar.right.pane.tab.title`；tab 类型经官方包提供的 `sidebarRightTabs` / `sidebarRight` 服务注册与打开。不碰 `conversation.composer.dock`（输入框下方的状态行），也不做悬浮抽屉。

## 权限边界

| 谁 | 能做什么 | 怎么用 |
|---|---|---|
| **用户** | 打开、关闭、换端口、换波特率 | 右侧栏「串口」tab：选端口 + 波特率 + `添加`；每张卡的「停止」；顶部「全部停止」「按清单重开」 |
| **会话** | 只读数据 | `serial_monitor` 工具的 `status` / `read` / `wait` / `mark` / `ports` |

会话的工具里**根本没有**开/关串口的动作：`watch`、`add`、`remove`、`pause`、`resume` 一律返回「会话不能开关串口」的说明。这样"抓哪个口"永远是人决定的，会话不会在你不知情时把口抢走或者把波特率改错。

## 会话怎么取数据

| action | 作用 |
|---|---|
| `status` | 用户当前在抓哪几路（key、字节数、错误），不打开任何东西 |
| `read` | `target` 指定某路（缺省=全部），`tailChars` 默认 4000，`sinceLast` 只取增量 |
| `wait` | 等某路（或任意一路）出现子串或 `/正则/`，最长 30 s |
| `mark` | 把增量游标推到末尾，之后 `sinceLast` 只拿新内容 |
| `ports` | **只列**系统上的串口名（不含蓝牙），不打开、不探测 |

```
serial_monitor { action: "status" }
serial_monitor { action: "read", sinceLast: true, target: "COM23@9600" }
serial_monitor { action: "wait", pattern: "boot done|assert|panic", timeoutMs: 10000 }
```

读的是面板同一份字节：每路一个 sidecar 子进程写进 Host 的环形缓冲（默认 40 万字符），面板走 `/poll`，工具走同一份缓冲，所以关掉 tab 也不影响会话读数据，反之亦然。

## 面板

- 会话标题栏「● 串口」按钮 → 右侧栏打开「串口」tab（再点只是聚焦；关 tab 即收起）。
- 每路一张卡片：状态点、`COM23@9600`、累计字节、该路「停止」，下面是各自的滚动日志。
- 顶部：`按清单重开`、`全部停止`、`自动滚动`、`清空`、`复制`（多路带 `===== key =====` 分隔）。
- 第二行：选端口 + 波特率 + `添加`，旁边显示当前清单。
- 抓取是 300 ms 一轮的增量轮询（空闲 1200 ms）；日志自动跟到最新行，往上翻会先停下，滚回底部又继续跟。

## 结构

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半：多路抓取（每路一个 sidecar 子进程）、按路环形缓冲、9 条 HTTP 路由（给面板）、只读的 `serial_monitor` 工具 |
| `serial_sidecar.py` | pyserial 读写；`list`（枚举）/ `read`（流式 NDJSON，stdin 收到 `quit` 即关闭句柄退出） |
| `client.js` | Client 半：标题栏按钮 + 右栏 tab 的 body/title 槽与类型注册 |
| `cordis.patch.yml` | 插入 `serial-monitor` 行 + 配置（`streams` 只是首次运行的种子） |

路由都要过 `connection.requestRejection` 的鉴权闸（裸 WebServer 路由默认不过闸）。它们服务于面板，也就是用户：

```
GET  /plugins/serial-monitor/status
GET  /plugins/serial-monitor/poll?since=COM23@9600:1234,COM22@115200:0   # 每路各自的游标
POST /plugins/serial-monitor/watch    # { streams:[{port,baud}] } 定义清单
POST /plugins/serial-monitor/add      # { port, baud }
POST /plugins/serial-monitor/remove   # { key }
POST /plugins/serial-monitor/stop     # 全部停止（手动模式）
POST /plugins/serial-monitor/resume   # 按清单重开
GET  /plugins/serial-monitor/ports    # 列端口（不打开）
POST /plugins/serial-monitor/diag     # Client 自检回执（右栏服务是否可达、类型是否注册成功）
```

`since` 是 `key:cursor` 的逗号列表（key 做 URL 编码），每路单独增量；超出环形缓冲时丢最旧的并置 `truncated`。

## 配置

profile 的 patch 里覆盖这一行即可（`streams` 只是**首次运行的种子**，之后以面板里用户调整的清单为准，记在 `%TEMP%/dsh-serial-monitor/declared.json`）：

```yaml
- id: serial-monitor
  name: '@local/serial-monitor'
  config:
    pythonPath: python          # 需要能 import serial
    autoStart: true
    ringChars: 400000
    streams:
      - port: COM23
        baud: 9600
```

## 已知边界

- **会话不要另起 `uart_capture.py` 之类的脚本抓同一个口**：端口由插件独占，第二个 handle 只会拿到 `Access is denied`。要数据就用 `read`/`wait`。
- 停止走"优雅关闭"：Host 给子进程写 `quit` → 子进程自己 `handle.close()`（会打断阻塞中的 read）→ 释放端口退出。实测 `全部停止` 后外部进程 ~0.1 s 内就能打开；强杀则某些 USB 串口驱动会把端口卡住一阵。
- 端口被别的程序占着时，卡片和 `status` 都会带上 `error=打不开 COM23 …Access is denied`，不会静默。
- 右栏 tab 依赖 `@deepseek-ai/dsh-client-ui-sidebar-right` 暴露的两个客户端服务：`sidebarRightTabs.register({id, kind, title})` 与 `sidebarRight.openTab(kind, ...)`。它们由 `ctx.reflect.provide` 提供、不在 Service 目录里，用 `ctx.get('sidebarRightTabs')` / `ctx.get('sidebarRight')` 取；上游若改名，tab 就打不开（按钮会以 tooltip 报错）。自检结果看 `serial_monitor status` 输出里的 `client:` 行。
- 面板是 session 作用域：未打开会话时它不渲染（标题栏按钮同理），但 Host 侧抓取不受影响。
- Host 侧冒烟测试：`node test/serial-smoke.mjs`（假 ctx 挂载 `apply()`：验证工具只读并拒绝 watch/add/remove/pause/resume → 面板路由开/停/重开/移除 → 会话 read/wait 读到字节 → `全部停止` 后外部进程能打开端口）。跑之前先把插件停掉，否则真占着 COM 口。
- 客户端回归测试：`node test/client-refresh.mjs`（迷你 React，验自动重绘 + 自动滚动，含"pre 不滚动时由列容器接手"的布局）。
- 两个测试都用相对路径，`test/.state/` 存各自的锁与清单（已 gitignore），不会碰你在跑的那几路。
