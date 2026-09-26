# 可观测性与告警

Backend 的 HTTP 请求日志为 JSON，包含 `event`、`service`、`requestId`、`traceId`、`ogId`、`userId`、路径、状态和耗时；响应回传 `x-request-id` 与 `x-trace-id`。调用方可传 `x-request-id`、`x-og-id` 与 W3C `traceparent`。`scripts/otel.mjs` 预载 Node OpenTelemetry SDK，对 HTTP 和 PostgreSQL 自动插桩；`npm run dev` 已预载。设置 `OTEL_EXPORTER_OTLP_ENDPOINT` 后发送 OTLP traces，否则只保留日志/指标。独立进程部署需设置 `NODE_OPTIONS=--import=/绝对路径/scripts/otel.mjs` 和不同的 `OTEL_SERVICE_NAME`。

Backend `/api/metrics` 输出 Prometheus 文本：`sentinel_http_requests_total`、`sentinel_http_request_duration_seconds`、`sentinel_outbox_messages{status}`、`sentinel_running_jobs{kind}`、`sentinel_gateway_cursor_gap`、`sentinel_gateway_sse_connected`、`sentinel_gateway_sse_reconnects_total`、`sentinel_oldest_unknown_seconds`，以及 Node 运行时指标。建议 Prometheus 每 15 秒采集；规则见 [alerts.yml](alerts.yml)。

操作员排障顺序：先以 `requestId` 检索请求错误，再用 `traceId` 查看跨服务 HTTP/DB spans；查看相关 `clientMsgId`、`eventId`、`runId` 或 `jobId` 的数据库状态；比较网关 SSE 游标与事件表，核对 outbox unknown 年龄。事件处理失败会输出 `gateway_event_failed` 日志并推 `inconsistency` WS 事件，后台随后重试。报警规则需要按真实业务量调整阈值并连接通知渠道。

限制：当前 Agent/Gateway 的业务日志及异步 worker 手工 span 覆盖仍少于 Backend HTTP/PG 自动 trace；生产环境要配置集中日志、OTLP Collector、指标存储与告警接收器。`/api/metrics` 当前与业务 API 共端口，公网部署应由反向代理限制访问。
