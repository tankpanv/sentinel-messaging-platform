# 领域模型

## Account

`AccountState` 为 `idle | online | rate_limited | disconnected | suspended | session_expired`。终态没有出边。状态变化使用 `expectedFrom` 做乐观并发控制；终态事务同时删除群成员并取消排队消息。

## Group

群有 `active | unreachable | left` 生命周期，成员角色为 `creator | admin | member`。Gateway group id 与平台内部 group id 分离，所有外部副作用通过 gateway adapter 边界执行。

## Message

消息唯一键为 `(group_id,msg_id)`，出站请求唯一键为 `(group_id,client_msg_id)`。发送意图先为 `queued`；外部调用期间持久标为 `unknown`，收到 202 后为 `accepted`，收到 `message_sent` 或对账确认后为 `sent`；明确失败为 `failed`，账号/群终止导致未发送时为 `cancelled`。`unknown` 必须经查询确认后才能重试。

## AgentRun

一个群最多一个 running run。每轮 turn、tool use、审计结果、协议错误和 raw response 都持久化；唯一约束保证多实例部署时仍不会并发运行两个 run。

## SequenceRun

运行快照保存解析后的文本、变量来源、排期时间和发送状态。数据库部分唯一索引保证一个群最多一个 running sequence run。
