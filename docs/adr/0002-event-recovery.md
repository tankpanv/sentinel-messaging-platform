# ADR 0002：网关事件使用 SSE 游标恢复

事件流保存全局递增 eventId。消费者每次用最后成功处理的 eventId 建立 `since` 连接，数据库唯一键保证重复投递不会重复写入。写入失败不会推进业务语义，并通过 WS inconsistency/日志暴露。
