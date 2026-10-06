# 升级到 0.1.4

更新代码、运行 `bun install --frozen-lockfile` 并重启 MCP。0.1.4 不增加服务端表结构或 API，兼容 0.1.3 服务端；doctor 会提示版本不同。更早版本的数据库与客户端迁移要求见 [0.1.3 升级说明](upgrade-0.1.3.md)，升级前备份专用数据库和 SQLite（停客户端后含 WAL/SHM）。

首次自动获取 namespace 失败不再导致 MCP 整体退出。网络故障及 408/425/429/5xx 时可在未绑定本地模式保存、读取 pending 记忆，云端恢复后再验证身份和权限并绑定。status.namespace=null 表示尚未绑定，不能声称已共享。已知 ro 凭据仍拒绝本地写入；未验证权限的队列可能在验证后 blocked，需要更换合法凭据或明确丢弃，不会偷偷上传。

默认首次离线缓存以 .unbound.db 结尾，绑定后保持原路径。重启和联网令牌轮换按已绑定 URL/namespace/agent 复用；离线轮换仅复用唯一已知绑定。多个身份无法判断时显式指定 namespace 和正确缓存路径，不要手动复制正在使用的队列。固定 MEMBRIDGE_CACHE_PATH 的行为不变。回滚到 0.1.3 时务必显式使用该缓存路径；旧版不会自动发现 .unbound.db。

身份请求单飞，临时失败后 5 秒退避，同一次 remember 不重复验证。后台每 30 秒继续重试，手动 sync 可立即重试。URL 脱敏修复带端口和 @ 路径的普通 URL，同时保留真实密码脱敏。

CI 新增隔离 MySQL 权限测试：仅 SELECT/INSERT/UPDATE/DELETE/CREATE 不能完成旧表迁移，补 ALTER 后仍缺 INDEX；补齐后生成列与排序索引成功，随后撤销 ALTER/INDEX 仍可启动并读写。该测试需额外 MEMBRIDGE_TEST_MYSQL_ADMIN_URL 指向 membridge_test* 临时测试库，账号需创建/删除测试用户和隔离测试库；应用账号不需要这些管理权限。不会连接用户生产 MySQL。

confirmToken 仍证明客户端取得过预览，无法证明人工阅读；强制人工 elicitation 与数据生命周期功能仍待独立设计。
