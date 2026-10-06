# 使用体验与一致性（0.1.5）

0.1.2 引入详情分页、recent、冲突重投与 doctor；0.1.3 补上确认令牌、版本/正文绑定、排序索引、运行时 namespace 识别及权限修复。不引入全文检索、生命周期迁移或 npm 发布。

0.1.4 支持首次离线启动；0.1.5 让空结果遵守 TTL、读取详情保留查询快照，服务端在 LIMIT 前过滤过期记忆，recent/timeline 不传正文。同步最多 4 个请求并发，前台写入后的同步阶段和 MCP sync 最多等待 2 秒，返回 pending 后后台继续执行。完整升级边界见 [0.1.5 升级说明](upgrade-0.1.5.md)。

get_memories 的 offset 默认 0，仍共享 charBudget，短正文剩余额度重新分配。每条返回 offset、totalLength、nextOffset、bodyHash 和 truncated。读取余文必须单独指定该 ID、nextOffset 和首段 version；建议同时传首段 bodyHash，待同步内容续读必须传 bodyHash，避免本地修改与云端基础版本号相同导致混合。云端续读刷新详情，不可验证版本时失败；版本/正文变化返回 PAGINATION_VERSION_CHANGED。偏移按 UTF-16 单元，边界落在代理对中间时回退 1 单元，不输出孤立代理字符。

recent(project, kind?, limit=10, refresh=false) 返回最近更新的索引，无需关键词。项目鉴权、过期/删除过滤与 search 相同，最多 30 条，更新时间降序，ID 降序作稳定次序。查询快照使用同样 TTL，云故障明确标记；离线缓存不代表完整云端列表。

rebase_pending(project, id) 仅允许冲突中的 put：直接读取云端，返回 localMemory/cloudMemory/expectedVersion/confirmToken，不修改待同步操作。审阅后同时提交 confirmVersion 和 confirmToken；只猜版本号不能确认。令牌为随机值，数据库只保存哈希，绑定本地操作、完整云内容和 10 分钟有效期；确认一次即消耗，新预览作废旧令牌。版本或内容改变则重新预览。确认换新 operationId、保留本地正文和来源，按 CAS 重投；已删除/过期云记录不自动复活。令牌能证明经过预览接口，不能证明人类实际阅读；agent 不得自动确认覆盖。forget 冲突仍由用户决定。

bun run doctor 或 bun src/cli.ts doctor 检查 URL、令牌连通、namespace/agent、缓存身份和 Unix 权限；只读检查，不创建缓存/上传记忆/导入旧数据。未显式配置 namespace/agent 时从云端身份生成明确配置，已指定但不匹配则报告错误。输出 Codex TOML 和通用 MCP JSON，包含绝对 Bun/CLI 路径；令牌继承 MEMBRIDGE_TOKEN 环境变量，不出现在输出。失败退出码 1；本地模式无需云凭据，报告尚不可共享。

服务端先升级以支持 /v1/recent；新参数/工具为增量扩展。缓存无新表。回滚程序无需数据降级，但旧客户端不支持新工具。已经确认提交的 rebase 是普通版本更新，回滚代码不会撤回该写入。
