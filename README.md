# Sentinel Messaging Platform

多账号群组消息平台。`backend` 是 Node.js/TypeScript/PostgreSQL API 与后台任务；`gateway-service` 是专门模拟外部 HTTP/SSE 消息网关的独立服务；`agent-service` 是遵守工具调用协议的独立决策服务；`frontend` 是 React 18/TypeScript/shadcn/ui 控制台。业务服务在本地作为独立进程运行，直接连接 PostgreSQL。

## 快速开始

需要 Node.js 22+、npm、Docker（仅用于一键启动 PostgreSQL）和 `psql`（集成测试需要）。

```bash
npm ci
npm --prefix backend ci
npm --prefix gateway-service ci
npm --prefix agent-service ci
npm --prefix frontend ci
bash scripts/start-postgres.sh
npm run dev
```

`start-postgres.sh` 拉取 PostgreSQL 16 镜像，建立持久化数据卷、`sentinel` 数据库和应用用户，执行迁移，并用应用账号验证连接。它可重复运行，业务服务不在容器中。若已有本机 PostgreSQL，配置 `.env` 中的 `PG*` 和 `APP_DB_*` 后运行 `bash scripts/setup-local-db.sh`。默认数据库连接为 `postgresql://sentinel:sentinel@127.0.0.1:5432/sentinel`。

地址：控制台 `http://127.0.0.1:25173`，API `http://127.0.0.1:28080`，网关模拟器 `http://127.0.0.1:28081`，Agent `http://127.0.0.1:28082`。初始用户 `admin/admin`（读写）和 `viewer/viewer`（只读），仅用于本地演示。正式环境必须替换用户凭据与 `JWT_SECRET`。可用 `bash scripts/dev-local.sh start|stop|restart|status` 管理全部本地服务。

各服务可在各自目录用 `npm run dev` 单独调试；Backend 需要 `DATABASE_URL`、`GATEWAY_URL`、`AGENT_URL`，Frontend 可用 `VITE_BACKEND_URL` 指向 API。修改 OpenAPI 后运行 `npm run api:generate`，生成代码在 `frontend/src/generated`。

**浏览器网络边界：**平台控制台功能仍只调用同源 Backend `/api/*` 和 `/ws`，使用 OpenAPI 生成客户端；Backend 负责消费 Gateway SSE 和处理业务状态。左侧“Gateway 消息服务”是独立管理页，浏览器通过 `frontend/src/api/gateway.ts` 直接请求 Gateway 的 HTTP/SSE，不调用平台群组或消息接口。默认连接页面所在主机的 `GATEWAY_PORT`（本地为 `28081`），也可设置 `VITE_GATEWAY_URL`。开发脚本中的 Gateway 是本仓库模拟器，其 `/admin/*` 接口没有鉴权，只能用于隔离开发环境。`npm run check:boundary` 检查只有该客户端可直连 Gateway。`npm run api:generate` 保持平台客户端使用同源 Backend。

管理页用 Gateway 的 `/groups`、`/users`、`/groups/:id/messages` 读取状态，通过 `/events?since=...` 接收实时事件。所有身份都以统一 Gateway 用户显示，用户的创建、读取、改名、删除、入群、退群和发送不在界面区分来源。群主或管理员可直接邀请、提升、踢出和退群。可运行 `node tests/gateway-direct-page.mjs` 验证浏览器链路和请求边界；脚本会新建并清理专用 Gateway 群和用户。

平台数据库记录 ID 与 Gateway 群 ID 是两个命名空间。界面主标题统一使用 Gateway 群 ID 的短形式；群组工作台详情把平台 UUID 明确标为“平台记录 ID”。Gateway 管理页只使用 Gateway ID，不读取平台群映射。当前仓库启动的 Gateway 仍是模拟服务，页面中创建的用户也只是该模拟 Gateway 的持久化用户，不能作为真实外部平台接入证据。

## 入群申请与成员操作

在“账号管理”或“群组与消息”提交入群申请后，申请先保存为“待审批”，无需预先生成邀请链接。操作员在群组详情中同意后，后台申请网关邀请链接、等待链接可用、提交入群请求，再依据 `member_joined` 事件或网关成员列表确认实际入群；网关返回 202 时页面显示“入群中”。拒绝申请不会调用网关。申请和处理状态保存在 PostgreSQL，服务重启后会继续处理已同意的申请。

群组详情还可生成邀请链接、提升成员为管理员、移出成员、自行退群、切换 Agent 与自动移除；账号管理页可查看账号的所属群组、申请记录及连接状态。上述操作使用 OpenAPI 生成的前端客户端调用后端接口。网关协议本身没有审批接口，审批属于本系统的控制台流程。

## 定时序列与序列运行

“定时序列”是可复用的步骤模板；“序列运行”是把某个模板绑定到一个群，并用本次输入的变量实际执行一次。每一步包含发送角色（`admin` 或 `member`）、文本模板和相对上一步送达的延迟。例如第 1 步延迟 10 秒、第 2 步延迟 5 秒，表示服务在启动后等待 10 秒发送第 1 步，收到网关 `message_sent` 后再等待 5 秒发送第 2 步。步骤还可填写 `senderAccountId`，指定群内服务账号的 `accountId` 发送该步消息；留空仍按角色自动选择。本次运行可用 `stepAccountIds`（例如 `{ "2": "acc-3" }`）覆盖模板的指定账号；值为空字符串则恢复自动选择。指定账号限流时等待，不在群内或不可用时跳过该步。

控制台的完整流程是：选择目标群和已保存序列→查看每一步并按需填写发送成员 ID→填写 `vars` 默认变量和 `stepVars` 按步骤覆盖变量→点击“预检”→在弹窗核对每一步最终文本、发送账号、变量值和来源→确认启动。预检在 Backend 完成；任意 `{key}` 无法解析时返回 `422 UNRESOLVED_PLACEHOLDER`，并显示具体 `stepIndex` 与 `key`，不会创建运行记录，也不会向网关发送消息。

运行期间，Backend 根据成员角色和账号状态选择发送账号：管理员步骤优先群管理员，成员步骤按账号 ID 字典序选择成员；`rate_limited` 账号会让步骤保持等待，账号恢复后再按顺序发送；没有匹配角色的账号会把步骤标记为 `skipped`。步骤状态会从 `pending` 进入 `accepted`、`sent`、`failed` 或 `skipped`，每一步的计划时间、实际送达时间、发送账号、解析变量和来源都可在页面查看。群不可用时运行变为 `stopped`；同一群同时只能有一个 `running` 运行，数据库唯一索引保证并发启动只有一个成功。Backend 重启后只重新排期当前最早的逾期步骤，后续步骤仍等待前一步真实送达。

## 测试执行与结果查看

测试前需安装各目录依赖、启动可访问的 PostgreSQL，并安装 Chromium：

```bash
npx playwright install chromium
```

C3 浏览器用例验证“登录 → 打开群组 → 查看 Agent Run 步骤与结果”。下面的命令会先构建项目，再创建隔离 PostgreSQL schema，启动独立的 Gateway 模拟器、mock Agent、Backend 和 Vite，最后自动清理服务和 schema：

```bash
npm run test:c3
```

终端会逐步显示断言结果；无论成功或失败都会生成 `test-results/c3-agent-run/html/index.html`。成功报告附带 Agent Run 步骤页截图，失败报告还保留 screenshot、video 和 trace。用 Playwright 报告查看器打开结果：

```bash
npm run test:c3:report
```

查看器会打印本地地址并保持运行，查看完按 `Ctrl+C` 退出。失败 trace 也可按报告中的附件链接查看，或执行 `npx playwright show-trace <trace.zip>`。

其他测试的执行入口和结果位置如下：

| 范围 | 执行脚本 | 查看结果 |
| --- | --- | --- |
| 构建 | `npm run build` | 终端退出码与四个服务的构建输出 |
| Backend 单元测试 | `npm --prefix backend test` | 终端 TAP 明细与汇总 |
| 前端访问边界 | `npm run check:boundary` | 终端逐项错误或通过结论 |
| 模拟 Gateway 合同 | `bash tests/gateway/contract-cases.sh` | 终端中的 curl 请求、HTTP 状态和响应 |
| mock Agent 合同与故障链路 | `npm run test:agent` | 终端中的 run 状态、步骤、审计和错误码 |
| Backend 模拟服务集成 | `npm run integration` | 终端断言与带服务名前缀的日志 |
| 综合 Playwright E2E | `npm run e2e` | 终端断言；页面截图位于 `/tmp/*-e2e.png` |
| C3 Playwright E2E | `npm run test:c3` | `npm run test:c3:report`；原始附件在 `test-results/c3-agent-run/` |
| 全部合同、集成与浏览器用例 | `npm run test:all` | 终端按用例组显示结果；其中 C3 另有 HTML 报告 |

更细的单项脚本、覆盖映射与排错入口见 [tests/README.md](tests/README.md) 和 [测试矩阵](docs/test-strategy.md)。`bash scripts/smoke-local.sh` 可检查已经启动的本地服务。CI 配置见 `.github/workflows/ci.yml`。

**测试证据边界：**集成与 E2E 测试使用本仓库实现的 Gateway 模拟器；C3 和默认 Agent 流程使用 `AGENT_PROVIDER=mock`，所谓外部用户消息由模拟端点注入。它们验证模拟协议下的完整处理链路，不验证真实外部平台用户、真实 Gateway 或真实 LLM。测试结论须遵守 [Codex 仓库规则](AGENTS.md)。

## 配置与运行

环境变量示例见 [.env.example](.env.example)。`npm run migrate` 可重复执行数据库迁移；Backend 启动时检查 schema 版本。`npm run dev` 自动预载 OpenTelemetry；独立运行部署包时设置 `NODE_OPTIONS="--import=/项目路径/scripts/otel.mjs"` 与 `OTEL_SERVICE_NAME`。设置 `OTEL_EXPORTER_OTLP_ENDPOINT` 可向 OTLP 接收端发送 traces；Prometheus 指标在 `/api/metrics`。网关的 `/admin/*` 是模拟器故障注入接口，不应暴露到公网。

`agent-service` 默认使用规则引擎，保持会话并通过完整工具协议工作。设置 `AGENT_PROVIDER=anthropic`、`ANTHROPIC_API_KEY`、`ANTHROPIC_MODEL` 可切换到 Anthropic Messages API；该模式需要有效外部账号与网络。Gateway 会话支持点击回形针上传单个不超过 10 MB 的文件，文件先保存在 Gateway 的 `GATEWAY_MEDIA_DIR`（默认 `media_gateway/`），消息事件带 `media` 元数据和 `mediaUrl`。Backend 再从 Gateway 下载到独立的 `MEDIA_DIR`（默认 `media/`），通过授权的 `/api/media/{id}` 提供访问；下载成功后不再保留可能过期的 Gateway 原始 URL。`GATEWAY_MEDIA_RETENTION_DAYS` 和 `MEDIA_RETENTION_DAYS` 分别控制两份文件的保留天数，默认均为 30；运行中的 Agent Run 引用的 Backend 文件延迟清理，过期删除同时清理已结束 Run 快照中的路径。`GATEWAY_PUBLIC_URL` 应设为浏览器可访问且与 Backend 的 `GATEWAY_URL` 同源的地址。生产部署应为两套目录分别配置持久卷；当前文件方案面向单实例，横向扩容需共享对象存储。

## 文档

- [架构与故障恢复](docs/architecture.md)
- [领域模型](docs/domain-model.md)
- [数据库设计](docs/database-design.md)
- [API 契约](docs/api-contract.md) 与 [OpenAPI](openapi/openapi.yaml)
- [测试矩阵](docs/test-strategy.md)
- [可观测性与告警](docs/observability.md)
- [AI 协作指南](docs/ai-development.md)
- [架构决策](docs/adr/0001-local-development.md)
