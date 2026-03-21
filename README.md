# Termux MCP Server

一个运行在 Termux 的 MCP Server，使用 Streamable HTTP 传输。

支持文件读写、搜索、局部编辑、命令执行、后台任务管理、HTTP 请求和文件对比等能力。

## 环境要求

- Node.js `v24.14.0`
- `pnpm` `>=10`

## 快速开始

```bash
pnpm install
cp config.toml.example config.toml
cp secrets.toml.example secrets.toml
pnpm dev
```

生产构建运行：

```bash
pnpm build
pnpm start
```

默认地址：

- Server: `http://127.0.0.1:8765/mcp`
- Health: `http://127.0.0.1:8765/healthz`

## 配置文件

- 主配置：`config.toml`
- 密钥配置：`secrets.toml`

当 `auth.enabled = true` 且 `secrets.toml` 未设置 token 时，服务会自动生成 Bearer Token 并写入 `secrets.toml`。

### 关键配置项

- `server.host` / `server.port` / `server.path`
- `auth.enabled`
- `filesystem.followSymlinks`
- `filesystem.blacklist.prefixes`
- `filesystem.blacklist.globs`
- `limits.commandTimeoutMs`
- `limits.commandConcurrency`
- `limits.commandOutputMaxBytes`
- `limits.backgroundHistoryLimit`
- `limits.httpHardTimeoutMs`
- `limits.httpHardMaxBytes`
- `logging.auditFile`
- `logging.redactFields`
- `jobs.historyFile`
- `jobs.outputDir`

### 环境变量覆盖

- `TERMUX_MCP_CONFIG_PATH`
- `TERMUX_MCP_SECRETS_PATH`
- `TERMUX_MCP_HOST`
- `TERMUX_MCP_PORT`
- `TERMUX_MCP_PATH`
- `TERMUX_MCP_AUTH_ENABLED`
- `TERMUX_MCP_BEARER_TOKEN`

## MCP 调用注意事项

使用 Streamable HTTP 时，`POST /mcp` 请求需要包含：

- `Content-Type: application/json`
- `Accept: application/json, text/event-stream`

标准流程：

1. `initialize`
2. `notifications/initialized`
3. `tools/list` / `tools/call`

## 工具列表

当前提供 11 个工具：

- `fs_read`：读取文件（支持 `utf8` / `base64`、offset/length）
- `fs_copy_move`：复制或移动文件/目录
- `exec_run`：前台执行命令（默认 argv，可选 `shell: true`）
- `fs_write`：写入文件（支持原子写）
- `fs_append`：追加文件内容
- `fs_search`：文件搜索（glob + 文本/正则）
- `exec_bg_start`：启动后台任务
- `exec_bg_list`：查看后台任务与状态（可选输出 tail）
- `http_fetch`：原生 `fetch`（支持超时与响应截断）
- `fs_patch`：局部编辑（严格 search/replace + expectedCount）
- `fs_diff`：文件对比（path 模式与 git 模式）

## 开发与测试

类型检查：

```bash
pnpm check
```

构建：

```bash
pnpm build
```

集成测试（会启动真实服务进程）：

```bash
pnpm test
```

## 安全与审计

- 文件访问采用黑名单策略（`prefixes + globs`）。
- 可配置是否允许符号链接跟随。
- 命令执行不做内容拦截，但有并发、超时、输出截断保护。
- 后台任务历史默认落盘保留最近 `N` 条。
- 审计日志记录参数摘要和结果摘要，并默认脱敏敏感字段。
