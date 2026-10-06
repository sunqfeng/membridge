# 升级到 0.1.1

先备份专用 MySQL 数据库和客户端 SQLite（停客户端后复制 DB，包含现存 WAL/SHM）。先升级服务端，再升级客户端：新客户端依赖 /v1/identity，旧服务没有该接口。更新仓库后 bun install --frozen-lockfile，重启服务和 MCP；已安装 skill 需更新其副本。

## 数据库

启动为 mb_memories 添加 search_title/search_body 虚拟生成列，只解析原 payload，不重写记录和回执。账号需 ALTER 权限；没有权限时启动失败并输出安全错误代码。生成列随旧版/新版写入 payload 自动更新，旧版服务可继续读取。回滚服务可以保留这些列；回滚会重新引入旧版检索漏结果问题。

检索仍是子串 LIKE，分页无任意扫描上限；这修正漏结果，但不是 FULLTEXT 性能升级。事务对 MySQL 1213/1205 最多补试两次，先回滚整个事务。

## 客户端缓存与令牌轮换

新身份由 URL/namespace/agent 生成，默认 namespace=owner。务必匹配服务器配置；不同身份不得共享缓存。新客户端首次升级会自动复制当前 token 对应的旧默认缓存，并保留原文件；旧固定路径若当前 token 未变，会自动升级 profile。

若升级前已经换了 token，旧哈希无法逆推出原身份。停客户端，确认旧缓存属于同一 URL/namespace/agent；默认路径用户设置 MEMBRIDGE_LEGACY_CACHE_PATH 为该旧 DB 的绝对路径，导入后取消此变量。固定路径用户确认后一次性设置 MEMBRIDGE_IMPORT_LEGACY=true，升级成功后取消。两者是明确选择旧缓存的迁移开关，不能用于跨身份导入。不要直接删除原文件，也不要同时运行旧客户端。

确认 status 中待同步数量、原待同步 ID；修好权限后 sync(retryFailed=true)。新 profile 建立后，同身份轮换令牌保持 outbox，清理已同步缓存/快照，blocked 回到 pending。不要使用旧客户端回写新缓存；回滚客户端须恢复升级前的缓存备份。

## 修复边界与后续升级

修复包括元数据误命中与窗口漏检、JSON 转义字符、并发同步、常见秘密脱敏、轮换、失败操作重试、Unix 权限、timeline 过滤、时区偏移、工具描述及统一版本。增强包括 ro/rw、哈希令牌、MCP 不可信证据标记、缓存淘汰、启动同步、安全诊断、唯一 agent 身份及临时状态重试。

仍待独立设计和迁移：中文 ngram FULLTEXT/BM25/向量、软删保留期与恢复、回执压缩/保留期、过期云记忆清理。当前 forget 仍清正文、保留墓碑，不能恢复；mb_operations 仍保存完整更新回执并持续增长，旧版本正文可能保留至 forget。不要直接删回执来节省空间，它是失联重试的幂等依据。脱敏修复不追溯清理已经上传的秘密；需检查原记录、回执及备份，并轮换泄漏凭据。
