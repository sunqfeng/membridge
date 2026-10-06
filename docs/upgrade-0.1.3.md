# 升级到 0.1.3

下述首次自动识别需要联网的限制已在 [0.1.4](upgrade-0.1.4.md) 修复。

先备份专用 MySQL 和客户端缓存，再升级服务端，最后升级 MCP 与已安装 skill。旧版本部署/缓存迁移参见 upgrade-0.1.1.md。运行 doctor 检查服务版本；旧服务未声明 access 时新客户端不提交云写入。

服务启动幂等创建排序索引 mb_memories_recent(namespace,project,deleted,updated_at,id)，迁移账号需要 INDEX 权限；保留生成列所需的 ALTER。索引不改变记录，回滚服务可保留索引，仍没有全文检索。客户端新增 cloud_identity/rebase_previews 表，保留原 outbox；回滚程序可忽略新表，但 namespace 自动绑定后的 profile 与旧版本不兼容，回滚客户端应恢复升级前备份，不能让旧版回写新缓存。

云模式未指定 namespace 时先查 /v1/identity；默认缓存选择真实 namespace，显式 namespace 不被覆盖。固定路径保存已绑定身份，不允许跨 namespace 复用。首次自动识别必须联网，同凭据身份提示以 600 私有文件原子保存，之后允许离线重启；令牌轮换需先联网识别，新旧令牌同身份仍使用同一 DB，待同步内容保留。身份提示按凭据隔离，只含 namespace/agent/access 与指纹，不含令牌原文或记忆。

0.1.1/0.1.2 的 owner 占位缓存若未绑定云身份、凭据指纹一致，可自动复制到真实 namespace 的默认路径，保留源文件并重试 blocked；已同步缓存会失效，原 outbox 保留。不同凭据/已绑定其他身份不能这样迁移，需选择正确缓存并人工审阅。

现有 Unix 目录不会自动改变权限：755 目录会被 doctor 和 MCP 一致拒绝，原权限保持不变。可选择新的私人子目录，或确认原目录完全专用后自行收紧权限；不要改共有父目录。旧版默认 ~/.membridge 若是 755 也需要这样处理。DB/WAL/SHM 仍为 600。

分页 offset>0 需要单 ID 和 version；首段 bodyHash 建议一并传入，待同步记录必须传。版本或内容变化则重新从 0 读取。rebase 确认同时需要预览产生的 confirmToken，旧的只传 confirmVersion 调用会失败；不可猜测、过期、一次性和内容绑定均在 MCP 服务内校验。

ro 会在新写入/删除/确认 rebase 改缓存前被拒绝；已有 outbox 留供审阅。初次离线权限未知的写入仅是本地 pending，不能当成云端成功。脱敏补上 Token 授权、空用户名连接串与 LTAI 标识；不追溯清理旧秘密，应检查旧记录、回执、备份并轮换已泄漏凭据。

仍未实现回执瘦身、可恢复软删/保留期、云端过期清理、FULLTEXT/相关性排序、静态加密、令牌管理命令、审计和 /ready；此版本不承诺这些能力。
