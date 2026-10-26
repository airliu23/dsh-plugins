# 安装 / 分发说明

把 `@local/serial-monitor`（DSH Web GUI 的串口监视插件）装到**别人的机器**或**另一个 profile** 上的步骤。

## 它是什么

一个 DSH bundle，包含三部分，装完即用，不需要编译：

| 文件 | 角色 |
|---|---|
| `index.js` | Host 半：每路 `port@baud` 一个 sidecar 子进程、环形缓冲、HTTP 路由、只读工具 `serial_monitor` |
| `client.js` | Client 半：会话标题栏按钮 + 右侧栏「串口」tab |
| `serial_sidecar.py` | pyserial 读写（`list` 枚举 / `read` 流式 NDJSON，收到 `quit` 优雅关句柄） |
| `cordis.patch.yml` | bundle 自动插入 `serial-monitor` 插件行 + 默认配置 |

归属很清楚：**用户**在面板里开/关串口，**会话**只能 `status/read/wait/mark/ports` 读数据。

## 前置条件（目标机器）

1. DSH（带 Web GUI 的桌面版或 `dsh web`），版本与插件要求的客户端服务一致（见文末"依赖的上游服务"）。
2. Python 3 且装了 pyserial：

   ```
   python -c "import serial; print(serial.__version__)"
   ```

   没有就 `python -m pip install pyserial`。默认配置用 PATH 上的 `python`，需要指定绝对路径就改 `config.pythonPath`。
3. 串口驱动（CH341 / FTDI / 板载 USB-CDC 等），能看见 COM 口。
4. **仅 Windows 验证过**（见"跨平台"一节）。

## 怎么装（目标机器上只要一步）

DSH 的插件安装入口是 `plugin_manager` 的 `install_bundle`，它自己负责装包 + 把 bundle 加进当前 profile（不要手工改 profile 的 `package.json` / `cordis.patch.yml`，也不要自己在 profile 目录里跑 pnpm）：

```
plugin_manager { action: "install_bundle", target: "<这个包的绝对目录>" }
```

装完刷新 Web GUI 页面即可。本地目录是**软链语义**（profile 里记成 `link:<你传的目录>`），所以**装完别移动或删除源目录**。

### 把包送到对方机器上的几种方式

| 方式 | 做法 | 适合 |
|---|---|---|
| **git clone**（首选） | `git clone https://github.com/airliu23/dsh-plugins.git`，`target` 填 `<clone 目录>\plugins\serial-monitor` | 同事机器、内网，顺便能升级 |
| **目录拷贝** | 只把 `plugins\serial-monitor` 复制/压缩过去，解压到 `D:\plugins\serial-monitor`，`target` 填这个绝对路径 | 只想给一个插件 |
| **tgz 中转** | `pnpm pack` 生成 `local-serial-monitor-1.0.0.tgz`（约 25 KB），传过去解压成目录（tar 里是 `package/`，建议改名 `serial-monitor`），再按目录方式装 | 只要一个文件传过去 |
| **私有 registry** | 改 `name` 成你们自己的 scope（如 `@acme/dsh-serial-monitor`）、去掉 `private: true`、`pnpm publish`，`target` 填 `"@acme/dsh-serial-monitor@1.0.0"` | 多人长期用、要升级通知 |

`target` 目前确定支持的是**包名/spec**（`name@version`、绝对目录）。tgz 文件路径不是安装入口——把它当传输载体，解压成目录再装。

### 升级

```
git pull                                   # 或换掉源目录里的文件
plugin_manager { action: "set_plugin", target: "include:serial-monitor", enabled: false }
plugin_manager { action: "set_plugin", target: "include:serial-monitor", enabled: true }
```

客户端半是浏览器加载的，改完要刷新页面（Ctrl+R）才生效。

## 装完怎么验

按顺序，任一步不对就停在那步：

1. `plugin_manager { action: "list_plugins" }` → 能看到 `@local/serial-monitor`（行 id 形如 `include:serial-monitor`），状态启用。
2. 刷新 Web GUI 页面。
3. 打开任意会话：标题栏应出现「● 串口」按钮；点它 → 右侧栏出现「串口」tab（聊天在左、串口在右）。
4. 面板里选端口 + 波特率 → 「添加」。卡片出现后字节数应自己往上涨、日志自动跟到最新行。
5. 让会话读一下：

   ```
   serial_monitor { action: "status" }
   ```

   输出里的 `client: tabs=yes sidebar=yes type=@local/serial-monitor` 说明客户端两半都挂上了；`清单：COM23@9600` 说明端口是你（用户）开的。

## 每台机器必须各自处理的差异

| 项 | 说明 |
|---|---|
| COM 口名 | 各机器不同（`COM3` / `COM23`），面板里选，别写死 |
| 波特率 | 面板里填，插件不探测 |
| 清单 | 记在各自机器的 `%TEMP%\dsh-serial-monitor\declared.json`，不随包分发 |
| `config.streams` | 只是**首次运行**的种子（`declared.json` 不存在时用它）；没有它插件起来是空的，等用户在面板添加 |
| `config.pythonPath` | Python 不在 PATH 上时填绝对路径 |
| `config.stateDir` | 需要隔离锁文件/清单时改它（测试脚本就用了这一手） |

覆盖配置：在 profile 的 `cordis.patch.yml` 里按 `id: serial-monitor` override，或在 bundle 自带的 `cordis.patch.yml` 里改默认值。

## 跨平台

代码是 Node + pyserial + 浏览器，本身跨平台，但有两处 Windows 假设：

1. `PORT_PATTERN`（`index.js`）只接受 `[A-Za-z0-9_\-.]`，会拒绝 `/dev/ttyUSB0`。POSIX 上把它放宽成
   `/^[A-Za-z0-9_\-.\/]{1,80}$/` 即可。
2. 停止路径依赖"子进程自己关句柄"来打断阻塞 read（`quit` → `handle.close()`）。POSIX 上同样成立，但没实测。
3. 默认状态目录用 `os.tmpdir()`，各平台都有。

## 依赖的上游服务

客户端半用两个由 `@deepseek-ai/dsh-client-ui-sidebar-right` 通过 `ctx.reflect.provide` 暴露的服务：

- `sidebarRightTabs.register({ id, kind, title })` —— 注册 tab 类型
- `sidebarRight.openTab(kind, {...})` —— 从标题栏按钮打开它

它们不在 Service 目录里，用 `ctx.get('sidebarRightTabs')` / `ctx.get('sidebarRight')` 取。**上游改名或删掉这两个服务，tab 就打不开**（按钮会把错误显示在 tooltip 里）。换 DSH 大版本后先跑一次 `serial_monitor status` 看 `client:` 那行。

其他用到的公开面：`ctx.tools.register`、`ctx.inject(['systemPrompt']) + systemPrompt.section`、`ctx.inject(['webServer']) + register({kind:'exact', path, handler})`、`ctx.slots.inject/register`、`ctx.locale.register/bind`。都是稳定接口。

## 已知行为（不是 bug）

- 同一 COM 口只能被一个进程持有：插件开着口时，别的工具（含 `uart_capture.py`）会拿到 `Access is denied`。要独占就先在面板「全部停止」。
- 「全部停止」后端口约 0.1 s 交还（优雅关闭），不会有驱动卡死的残留。
- 面板按 300 ms 增量轮询（空闲 1200 ms），**不是** WebSocket —— 起停刷新页面都不会漏字节。
- 会话不能开/关端口，这是设计：工具里根本没有那些动作。

## 自测（改代码后）

测试脚本在仓库里的 `plugins/serial-monitor/test/`（不进 tarball，但随 git 仓库走），用相对路径，可以直接在包目录里跑：

```
node test/serial-smoke.mjs      # Host：只读边界 + 面板开停 + 读数据
node test/client-refresh.mjs    # Client：自动重绘 + 自动滚动（两种布局）
```

跑之前先把插件停掉，否则测试与真实例抢 COM 口。测试自己的锁/清单写在 `test/.state/`（已 gitignore）。
