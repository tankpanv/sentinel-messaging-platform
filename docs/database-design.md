# 数据库设计

DDL 位于 `backend/src/infrastructure/db/schema.sql`，迁移入口 `migrate.ts`。迁移在事务内持有 advisory lock，可重复运行；`schema_migrations` 记录当前 `1.3.0`，Backend 启动检查该版本。`pgcrypto` 提供 UUID。任何 DDL 变动须增加版本并保留可升级路径，部署顺序是先兼容性迁移再启动新代码。

| 表 | 职责与约束 |
|---|---|
| `users`, `auth_sessions`, `refresh_sessions` | salted scrypt 凭据、可立即撤销的访问会话、一次性 refresh token 哈希与重用检测 |
| `accounts`, `groups`, `group_members` | 账号状态和 CAS version；群与内部/网关 ID；成员及角色 |
| `messages` | 时间线和 outbox 共表；`(group_id,msg_id)`、`(group_id,client_msg_id)` 唯一；发送尝试与媒体状态 |
| `gateway_events`, `gateway_cursor` | 事件原文和连续已处理游标，支持重复与乱序投递 |
| `websocket_events` | 全局递增 seq 和可重放的实时事件 |
| `jobs` | 建群/退群状态、阶段进度、错误与恢复信息 |
| `agent_runs`, `agent_pending_messages`, `agent_tool_effects` | 运行历史、待触发消息和工具副作用幂等键 |
| `sequences`, `sequence_runs` | 定义和运行快照，变量来源、排期、步骤状态 |

`one_running_agent_per_group` 与 `one_running_sequence_per_group` 是部分唯一索引。状态变更与其事务性后果一起提交；HTTP 调用在事务外执行，通过先持久化意图和恢复 worker 达到可恢复性。网关本身不对 clientMsgId 去重，unknown 发送必须在确认未落地后才能重试。数据库备份需要同时保护消息、游标、运行和会话表；媒体文件需与备份周期协调。
