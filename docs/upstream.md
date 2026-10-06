# 上游来源与修改

MemBridge 基于 Claude-Mem 的记忆流程与部分脱敏代码改造，云端和缓存实现为重新编写。不是全量 fork，不兼容原项目数据库或全部 hooks。

上游：https://github.com/thedotmack/claude-mem ，参考提交 `2d68c3550c19cd6f4efa380882d6eee437c01b75`，版本 13.31.0。

`src/utils/redaction.ts` 的凭据和私钥表达式改写到本项目 `src/model.ts`：移除上游配置与日志依赖，始终脱敏，增加 private 内容排除与通用凭据赋值识别。正则不是识别所有秘密的保证。

采用 search → timeline → get_memories 分层回忆设计，改为 MySQL 权威、本地 SQLite 缓存与待同步、每 agent 项目权限、版本冲突与墓碑。观察由工作 agent 经 skill 提炼，未复制上游后台 provider、商业账户、同步或自动 transcript hooks。

保留 Apache-2.0 LICENSE 与原 NOTICE，补充本项目修改信息。MemBridge 名称不表示原作者认可或官方关系。
