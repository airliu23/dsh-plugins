# dsh-plugins

私人收藏的 **DeepSeek Harness (DSH)** 插件仓库。每个插件是一个独立的 **bundle**：自带 `package.json`、`cordis.patch.yml`、Host 半（`index.js`）和 Client 半（`client.js`），装上即用，不需要编译。

仓库地址：<https://github.com/airliu23/dsh-plugins>　克隆：`git clone https://github.com/airliu23/dsh-plugins.git`

## 目录结构

```
dsh-plugins/
├── plugins/
│   ├── serial-monitor/          # 串口监视：右侧栏 tab + 只读工具
│   │   ├── index.js             #   Host 半
│   │   ├── client.js            #   Client 半（浏览器）
│   │   ├── serial_sidecar.py    #   pyserial 子进程
│   │   ├── cordis.patch.yml     #   bundle 自带的插件行 + 默认配置
│   │   ├── package.json
│   │   ├── test/                #   无浏览器回归测试（相对路径，可直接跑）
│   │   ├── README.md            #   设计、接口、已知边界
│   │   └── INSTALL.md           #   安装 / 分发步骤
│   └── todo-list/               # 待办清单：左侧栏图标 + 整页面板
│       ├── index.js             #   Host 半：路由 + todo 工具
│       ├── store.js             #   清单本体（落盘 / 通知）
│       ├── client.js            #   Client 半：面板 + SSE 订阅
│       ├── cordis.patch.yml
│       ├── package.json
│       ├── test/store.mjs       #   存储层回归测试
│       ├── test/host-routes.mjs #   路由 + 工具接线测试
│       └── README.md
└── README.md
```

## 安装某个插件

DSH 的安装入口是 `plugin_manager` 的 `install_bundle`，**target 填插件的绝对目录**；它会自己装包并把 bundle 加进当前 profile——不要手工改 profile 的 `package.json` / `cordis.patch.yml`，也不要在 profile 目录里跑 pnpm。

```
plugin_manager { action: "install_bundle", target: "D:\\path\\to\\dsh-plugins\\plugins\\serial-monitor" }
```

装完刷新 Web GUI 页面。本地目录是**软链语义**，装完别搬走目录。

## 插件清单

| 插件 | 一句话 | 细节 |
|---|---|---|
| [`serial-monitor`](plugins/serial-monitor/README.md) | 串口日志回显到右侧栏 tab，**收到就推**（SSE，不轮询）；**端口由用户在面板开关，会话只能只读**（`status/read/wait/mark/ports`）；不探测波特率，支持多路 | [README](plugins/serial-monitor/README.md) · [INSTALL](plugins/serial-monitor/INSTALL.md) |
| [`todo-list`](plugins/todo-list/README.md) | 左侧栏「待办」整页清单：增删改勾选、本地落盘、SSE 实时同步；会话用 `todo` 工具读写同一份数据（与 `todo_write` 计划分开） | [README](plugins/todo-list/README.md) |

## 共同前置

- DSH（带 Web GUI）。插件的右侧栏 tab 依赖官方包提供的 `sidebarRightTabs` / `sidebarRight` 客户端服务，DSH 大版本升级后先验证一次。
- Node 由 DSH 自带；带 Python 子进程的插件另外需要 Python 3 + 对应库（`serial-monitor` 需要 `pyserial`）。

## 开发约定

- 一个插件一个目录，放在 `plugins/<name>/`；目录名与 `package.json` 的 `name` 后半段一致。
- `package.json` 必须有 `dsh.bundle.patch` 指向自带的 patch 文件；有界面时加 `dsh.client`。
- 测试放插件自己的 `test/`，用相对路径（`import.meta.url` 推包根），状态目录写进 `test/.state/` 并 gitignore，避免误碰正在运行的实例。
- `files` 只列运行必需文件，`pnpm pack` 出来的 tgz 就是可分发的单文件。
- 改完在本地 `set_plugin(false → true)` 重载验证，再提交。

## 升级与卸载

```
plugin_manager { action: "set_plugin",   target: "include:<row-id>", enabled: false }   # 停用
plugin_manager { action: "set_plugin",   target: "include:<row-id>", enabled: true  }   # 启用
plugin_manager { action: "remove_bundle", target: "<包名>" }                            # 卸载
```

改动 Client 半后要刷新页面（Ctrl+R）才生效。
