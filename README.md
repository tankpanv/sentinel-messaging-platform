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

地址：控制台 `http://127.0.0.1:5173`，API `http://127.0.0.1:4000`，网关模拟器 `http://127.0.0.1:4001`，Agent `http://127.0.0.1:4002`。初始用户 `admin/admin`（读写）和 `viewer/viewer`（只读），仅用于本地演示。正式环境必须替换用户凭据与 `JWT_SECRET`。

各服务可在各自目录用 `npm run dev` 单独调试；Backend 需要 `DATABASE_URL`、`GATEWAY_URL`、`AGENT_URL`，Frontend 可用 `VITE_BACKEND_URL` 指向 API。修改 OpenAPI 后运行 `npm run api:generate`，生成代码在 `frontend/src/generated`。

## 验证

```bash
npm run build
npm --prefix backend test
npm run integration
npm run e2e
```

集成与 E2E 测试创建隔离 PostgreSQL schema、启动独立本地服务并清理数据；E2E 需要 Chromium（可用 `npx playwright install chromium` 安装）。`bash scripts/smoke-local.sh` 可检查已启动的本地服务。CI 配置见 `.github/workflows/ci.yml`。

## 配置与运行

环境变量示例见 [.env.example](.env.example)。`npm run migrate` 可重复执行数据库迁移；Backend 启动时检查 schema 版本。`npm run dev` 自动预载 OpenTelemetry；独立运行部署包时设置 `NODE_OPTIONS="--import=/项目路径/scripts/otel.mjs"` 与 `OTEL_SERVICE_NAME`。设置 `OTEL_EXPORTER_OTLP_ENDPOINT` 可向 OTLP 接收端发送 traces；Prometheus 指标在 `/api/metrics`。网关的 `/admin/*` 是模拟器故障注入接口，不应暴露到公网。

`agent-service` 默认使用实际规则引擎，保持会话并通过完整工具协议工作。设置 `AGENT_PROVIDER=anthropic`、`ANTHROPIC_API_KEY`、`ANTHROPIC_MODEL` 可切换到 Anthropic Messages API；该模式需要有效外部账号与网络。媒体文件保存在 `MEDIA_DIR`，默认保留 30 天。生产部署应使用持久卷或共享对象存储；当前文件方案面向单 Backend 实例。

## 文档

- [架构与故障恢复](docs/architecture.md)
- [领域模型](docs/domain-model.md)
- [数据库设计](docs/database-design.md)
- [API 契约](docs/api-contract.md) 与 [OpenAPI](openapi/openapi.yaml)
- [测试矩阵](docs/test-strategy.md)
- [可观测性与告警](docs/observability.md)
- [AI 协作指南](docs/ai-development.md)
- [架构决策](docs/adr/0001-local-development.md)
