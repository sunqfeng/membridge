# 使用体验升级（0.1.2）

本批仅做详情预算与分页、recent、冲突重投、doctor；继续沿用 0.1.1 的权限和 namespace 修复。不引入全文检索、生命周期迁移或 npm 发布。

get_memories 增加 offset（默认 0，对每条正文应用相同起点），仍共享 charBudget；短正文剩余额度重新分配。每条返回 offset、totalLength、nextOffset 和 truncated；读取余文时单独指定该 ID 与其 nextOffset。长度和偏移按 JavaScript UTF-16 单元计算，版本变化后重新从 0 读取。

recent(project, kind?, limit=10, refresh=false) 返回最近更新的索引，无需关键词。项目鉴权、过期/删除过滤与 search 相同，最多 30 条，更新时间降序，ID 降序作稳定次序。查询快照使用同样 TTL，云故障明确标记；离线缓存不代表完整云端列表。

rebase_pending(project, id) 仅允许冲突中的 put：直接读取云端，返回 localMemory/cloudMemory/expectedVersion，不修改队列。审阅确认后再次调用并提供 confirmVersion=expectedVersion；云端版本变化则拒绝。确认时换新 operationId、保留本地正文和来源，更新期望版本并尝试同步。服务端 CAS 防止检查后又发生的并发覆盖；已删除/过期云记录不自动复活。forget 冲突仍由用户决定。

bun run doctor 或 bun src/cli.ts doctor 检查 URL、令牌连通、namespace/agent、缓存身份和 Unix 权限；只读检查，不创建缓存/上传记忆/导入旧数据。未显式配置 namespace/agent 时从云端身份生成明确配置，已指定但不匹配则报告错误。输出 Codex TOML 和通用 MCP JSON，包含绝对 Bun/CLI 路径；令牌继承 MEMBRIDGE_TOKEN 环境变量，不出现在输出。失败退出码 1；本地模式无需云凭据，报告尚不可共享。

服务端先升级以支持 /v1/recent；新参数/工具为增量扩展。缓存无新表。回滚程序无需数据降级，但旧客户端不支持新工具。已经确认提交的 rebase 是普通版本更新，回滚代码不会撤回该写入。
