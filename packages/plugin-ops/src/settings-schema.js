/**
 * BigFish 设置命名空间的 schema（零依赖，手搓 schemastery 兼容形状）。
 *
 * 为什么手搓而不 import '@deepseek-ai/schemastery'：AGENTS.md §2「运行时零第三方依赖」。
 * 本机 profile 把 @bigfish/plugin-ops 以 junction 装进 node_modules，Node 仍按真实路径
 * D:\Github\big fish 解析依赖，那里没有 schemastery（实测 DYNAMIC IMPORT / createRequire
 * 四种方式全 MODULE_NOT_FOUND）。宿主的 settings.describe() 只需要 schema.toJSON() 的
 * envelope，客户端 ui-settings 用宿主自带 schemastery 把 envelope rehydrate 成 live schema，
 * 所以插件侧只需要一个「可被调用做校验」+「带 toJSON/type/dict/meta」的对象即可。
 *
 * 兼容性与实测依据见 docs/adr/0007-enabled-toggle-zero-dep-settings.md。
 *
 * @module @bigfish/plugin-ops/settings-schema
 */

/** host settings 命名空间 / client settings.plugin.item 的 key；两处物理隔离，必须逐字一致。 */
export const SETTINGS_NAMESPACE = 'bigfish-ops'

/**
 * 造一个 { enabled: boolean } 的 schemastery 兼容 schema。
 *
 * toJSON() 与 `z.object({ enabled: z.boolean().default(defaultValue) }).toJSON()` 字节相等
 * （实测 @deepseek-ai/schemastery 3.18.5）：
 * {"uid":2,"refs":{"1":{"type":"boolean","meta":{"default":<bool>}},"2":{"type":"object","meta":{"default":{}},"dict":{"enabled":1}}}}
 * type/dict/meta 是宿主 redactSecrets(schema, value) 的 walk() 需要的结构视图（不参与序列化）。
 *
 * @param {boolean} defaultValue - config.enabled 的装配层默认值。
 * @returns {Function & {toJSON: Function, type: string, meta: object, dict: object}} 可调用的 schema。
 */
export function makeEnabledSchema(defaultValue) {
  const enabledNode = { type: 'boolean', meta: { default: defaultValue } }
  const envelope = {
    uid: 2,
    refs: {
      1: enabledNode,
      2: { type: 'object', meta: { default: {} }, dict: { enabled: 1 } },
    },
  }
  const schema = (value) => {
    const source = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
    const raw = source.enabled
    let enabled
    if (raw === undefined) enabled = defaultValue
    else if (typeof raw === 'boolean') enabled = raw
    else throw new TypeError('bigfish-ops: enabled 必须是布尔值，收到 ' + String(raw))
    return { enabled }
  }
  schema.toJSON = () => envelope
  schema.type = 'object'
  schema.meta = { default: {} }
  schema.dict = { enabled: enabledNode }
  return schema
}
