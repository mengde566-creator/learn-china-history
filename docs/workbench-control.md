# 工作台项目控制入口

项目登记使用原地址 `http://localhost:3100/`。工作台调用仓库根目录下的 `.workbench/control`，支持 `status`、`start`、`stop`、`restart` 和 `logs`；省略动作时等同于 `status`。

控制脚本以 `/usr/local/bin/node` 和项目已安装的 Next.js 直接启动 `web/.next` 生产构建。启动前必须有锁定版本 Node 24.15.0、Next.js 15.5.27 和非空 `web/.next/BUILD_ID`。`start` 不执行依赖安装、内容生成或构建。服务绑定 `localhost:3100`，启动后检查首页、`/p/jingke`、`/p/jingke/06-yishui` 及首页样式资源。

本项目只控制自己记录的 PID：记录启动时间、Next 启动命令、web 工作目录，并和 3100 端口监听 PID 对照。端口被其他进程占用或身份无法确认时，脚本返回错误并保持该进程不动。正常停止仅向已核实的项目 PID 发送 `SIGTERM`；超时不升级为强制终止。生命周期动作共用运行目录中的短锁，状态和日志读取不写锁。服务日志、PID 和动作锁只放在 `.workbench/runtime/`，权限为当前用户私有；该目录已加入 `.gitignore`。

每次调用只向 stdout 写一行 UTF-8 JSON，字段符合工作台 `ControlReply`；诊断内容不写入 stdout。日志读取只取文件尾部，最多 200 行/48 KiB，并对凭据字段做文本脱敏；`Authorization`、`Proxy-Authorization`、`Cookie` 和 `Set-Cookie` 的整行值完整隐藏，避免泄露 scheme 后的令牌或多段 Cookie。项目目前不使用数据库、上传目录或外部服务。

本地验证：

```sh
.workbench/control status
.workbench/control start
.workbench/control logs
.workbench/control restart
.workbench/control stop
```

日志脱敏回归（从 `web/` 执行，使用合成日志和一次性临时项目副本，不启动服务）：

```sh
/usr/local/bin/node --test scripts/test-workbench-control-logs.mjs
```

生产构建由项目自己的发布流程准备；控制入口不会替代该流程，也不会改写 `http://localhost:3100/` 这个浏览器 origin。
