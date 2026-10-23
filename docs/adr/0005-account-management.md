# ADR 0005：账号管理（多账号 / 切换 / 退出 / cookie 生命周期 / 保活）的边界与落点

- 状态：已采纳（2026-10-23，账号模块 v2 落地时定稿）
- 关联：[ADR 0002 运行时契约](0002-p0-runtime-contract.md)、[ADR 0004 面板 rpc 通道](0004-client-host-rpc.md)
- 实现：`packages/core/src/settings.ts`、`packages/channel-cdp/src/cookies.ts`、`packages/daemon/src/{account-state,account-session,account-lifecycle,account-keepalive,account-list}.ts`、`packages/plugin-ops/{client.js,src/rpc.js}`

## 背景

账号模块 v1 只能「看摘要 + 按需校验」：`GET /accounts` 是只读摘要（`ready` 只代表本地字段齐备），`POST /accounts/:id/verify` 打一次 mtop `head` 判断在线。用户 2026-10-23 要求把账号管理补全：**切换、退出登录、添加账户、cookie 生命周期**，并补上一轮指出的短板（定时保活、多账号、verify 限流、凭据备份）。

约束：

1. daemon 不调 LLM（AGENTS §1.1）；写操作必须幂等、单账号写串行（§1.2/§1.3）；凭据只加密落盘、日志脱敏（§1.4）。
2. 空闲时不该持续打闲鱼接口：账号级风控敏感，`head` 也是真实请求。
3. 「退出登录」在闲鱼网页是注销会话；工具里的退出**不能**等价于它——用户可能只是想在本工具里换号。

## 决策

### 1. 当前账号放 core settings，不放凭据文件

`Settings.activeAccountId`（空串 = 未选）。理由：它是**工具本地状态**，不是闲鱼账号属性；放 settings 才能复用现有 `GET/PUT /settings`、`settings.put` 的校验与面板表单，也不用改凭据加密格式。导入/登录成功后若为空自动选中该账号；退出登录删的正是当前账号则清空。

### 2. 退出登录 = 只删本地加密凭据

`POST /accounts/:id/logout` 只做 `credentials.delete`（+ 清 `activeAccountId`），**绝不注销闲鱼网页会话**。面板第一次点只把文案改成「确认退出登录」并明确提示这一点，第二次才带 `confirm:true`。

理由：注销网页会话是破坏性且难恢复的动作，而用户对「退出」的预期在工具语境里是「本工具不再用它」。真要注销请去闲鱼网页操作。

### 3. cookie 生命周期用「导入时真实过期时间 + 刷新时间估算」

- 导入（CDP）时把 goofish cookie 的 `expires`（秒）转毫秒写进凭据 `meta.expires`（`channel-cdp/src/cookies.ts` 的 `selectGoofishCookieExpiries`）。
- verify 真的拿到新 `_m_h5_tk` 并回写成功时写 `meta.refreshedAt`。
- `GET /accounts` 的 `loginExpiresAt`：有 `refreshedAt` → `refreshedAt + 2h`（`source: 'estimated'`）；否则 `meta.expires['_m_h5_tk']`（`source: 'browser'`）；都没有则缺省，面板显示「—」。

不做「精确到期时间」的原因：`_m_h5_tk` 的真实有效期由闲鱼决定、刷新响应不保证给新过期时间；2h 是实测数量级，标「估算」比假装精确好。

### 4. 检测状态单独落 `account-state.json`

`<data>/account-state.json`：`{version:1,accounts:{<id>:{lastCheckedAt,lastOnline,lastCode}}}`，原子写（tmp+rename、0600），坏文件返回空表。理由：这是**展示态**，丢了不影响发布与凭据；塞进凭据文件会让加密格式与迁移变复杂。

### 5. verify 防抖：同账号单飞 + 5s 冷却

`account-session.ts`：同一账号并发调用共享一个 Promise；`VERIFY_COOLDOWN_MS = 5_000` 内命中返回上次结果并带 `cached:true`（失败不缓存）。面板自动检测再叠一层 10 分钟模块级缓存（每次都是真打 `head`，账号级风控敏感），行内「检测」强制刷新。

**仍然不占限流桶、不触发熔断**（与 v1 一致，已知缺口）：verify 是只读探测，进写桶会误伤发布预算；真要进熔断得先定「读桶」口径，另开一题。

### 6. 保活默认关、间隔由 settings 控制

`account-keepalive.ts`：`setInterval().unref()`、上轮未完跳过、`stop()` 幂等；picker 优先 `activeAccountId`，否则第一个 `ready` 账号。runtime 包装 settings store，`keepAliveEnabled` / `keepAliveIntervalMs` 变更后 reconcile；默认 **false**、间隔 300s（夹 60s..3600s）。

理由：默认开会让「装好就默默打接口」，与账号风控纪律冲突；默认关、用户显式开启更安全。

### 7. 面板列与 `data-role` 契约

7 列：当前 / 账号 / 登录状态 / 登录态剩余 / 最近检测 / 凭据更新 / 操作；25 个 `data-role`（`account-*` / `keepalive-*`）见 [client-plugin-sidebar.md](../client-plugin-sidebar.md) §1。切换（本地设置）一次点击；其余写操作两次确认。

## 后果

- `client.js` 行数冲破原 700 行上限 → AGENTS §3 例外上限上调到 **900 行**（同一 bundle、无构建步骤的约束没变）。
- `packages/daemon/src/routes.ts` 546 行，仍超 400 行通规；拆路由文件另开一题（先不动，避免这轮把 review 面摊大）。
- 扫码登录路径不写 `meta.expires`：它的 cookie 来自登录后的 CookieJar，没有 CDP 的 `expires` 字段；要显示剩余时间得等一次 verify 真刷新（`refreshedAt` 落盘）。
- `account-state.json` 与 `settings.json` 是两个文件，极端断电可能不同步；两者都是展示态，不影响发布与凭据。

## 未采纳的替代方案

| 方案 | 为什么不做 |
| --- | --- |
| 退出登录同时注销闲鱼网页会话 | 破坏性、不可逆，且超出「本工具换号」的语义 |
| 把 `activeAccountId` 写进凭据文件 | 污染加密格式与迁移；settings 已有读写通道 |
| verify 进写限流桶/熔断 | 会误伤发布预算；读桶口径未定 |
| 保活默认开 | 与账号风控纪律冲突（装好就默默打接口） |
| 面板自动检测 60 秒一次 | 每次都是真打 `head`，60s 太密；改 10 分钟 + 手动强制刷新 |
