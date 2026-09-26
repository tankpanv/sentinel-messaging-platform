# API 契约

[OpenAPI 3.0 契约](../openapi/openapi.yaml) 是 REST 字段与前端生成客户端的源文件。运行 `npm run api:generate` 更新 `frontend/src/generated`；前端统一经 `frontend/src/api/client.ts` 处理 Bearer token、refresh cookie 和错误。新增/变更 REST 接口时同步修改契约、生成代码、实现与测试。

Backend HTTP 错误为 `{ "error": { "code", "message", "requestId", ... } }`。JWT access token 有效期 15 分钟，refresh token 只用 HttpOnly cookie 传输；viewer 所有写操作为 403。`WS /ws` 先发 `{ type:"auth", accessToken, sinceSeq? }`，随后收到 `{seq,type,payload}`；客户端存储最大 seq 并在重连时补齐。

外部网关协议见原始题目 2.1 节，模拟服务由 `gateway-service` 实现；`/admin/*` 只用于故障注入与集成验证。Agent 协议见题目 2.2 节，`agent-service` 验证恰好四个工具及 JSON Schema，Backend 保留原始响应和逐步结果。跨服务新增字段应先确定兼容性和重试语义。
