    /**
     * 片段 02：草稿集解析与发布参数组装（纯数据：不联网、不碰 daemon、只组 JSON）。
     * 拼接顺序由文件名决定；单独打开不是合法模块，见 scripts/build-client.mjs。
     */
    /**
     * 草稿价格（单位：分）。协议字段是 `priceCents`（core 与 daemon 都只认它），
     * 但面板早期文案与示例写的是 `price`——两个都收，避免用户按示例粘贴却被判「缺 priceCents」。
     * 返回 NaN 表示两个都没给，交给调用方报错。
     */
    function draftPriceCents(draft) {
      const raw = draft.priceCents !== undefined && draft.priceCents !== null ? draft.priceCents : draft.price
      if (typeof raw === 'number') return raw
      if (typeof raw === 'string' && raw.trim() !== '') return Number(raw.trim())
      return Number.NaN
    }
    /** 逐行解析草稿集（内联 JSON 对象或 .json 路径）：路径条目交给 host 侧读取，这里只认形状。 */
    function parseDraftLines(text) {
      return text.split('\n').map(line => line.trim()).filter(line => line !== '').map((line, index) => {
        if (!line.startsWith('{')) {
          return /\.json$/i.test(line)
            ? { index, kind: 'path', ok: true, path: line, message: '路径条目（host 读取）' }
            : { index, kind: 'bad', ok: false, message: '既不是 JSON，也不是 .json 路径' }
        }
        let draft
        try { draft = JSON.parse(line) } catch { return { index, kind: 'inline', ok: false, message: 'JSON 错误' } }
        if (typeof draft !== 'object' || draft === null || Array.isArray(draft)) return { index, kind: 'inline', ok: false, message: 'JSON 不是对象' }
        // 价格单独判：字段名两个都收，但报错统一说协议名 priceCents（否则用户不知道该改哪个键）。
        const missing = ['title', 'images'].filter(key => draft[key] === undefined || draft[key] === null || draft[key] === '' || (Array.isArray(draft[key]) && draft[key].length === 0))
        if (!Number.isSafeInteger(draftPriceCents(draft)) || draftPriceCents(draft) <= 0) missing.push('priceCents')
        return missing.length === 0
          ? { index, kind: 'inline', ok: true, draft, message: '通过' }
          : { index, kind: 'inline', ok: false, draft, message: '缺 ' + missing.join(' / ') }
      })
    }
    /** 组装 xy_publish_batch 参数：只组数据，不执行。 */
    function buildPublishBatchArguments(mode, results, accountId) {
      const args = {
        mode,
        draftPaths: results.filter(result => result.kind === 'path').map(result => result.path),
        drafts: results.filter(result => result.kind === 'inline' && result.ok).map(result => result.draft),
      }
      if (accountId.trim() !== '') args.accountId = accountId.trim()
      return args
    }
    /**
     * 模板兜底：rpc `copy.templates` 拉不到（daemon 未起、宿主里是旧插件）时，至少能填最小事实。
     * 有模板时以 host 下发的为准——client 不复刻品类表，避免第二份定义漂移。
     */
    const FALLBACK_TEMPLATE = {
      common: [
        { id: 'productName', label: '商品名', type: 'text', group: 'base', required: true, maxLength: 120 },
        { id: 'priceYuan', label: '售价（元）', type: 'text', group: 'base', required: true, maxLength: 20 },
        { id: 'condition', label: '成色', type: 'enum', group: 'base', required: true, options: CONDITION_OPTIONS.map(option => ({ value: option.id, label: option.label })) },
      ],
      categories: [{ id: 'other', label: '其他', categoryHint: '', specs: [] }],
    }
    /** 输入框占位符：只影响手感，不参与组装。 */
    const FIELD_PLACEHOLDERS = {
      productName: '如：iPhone 13 128G 星光色',
      priceYuan: '如：129.90',
      imagePaths: 'D:/pics/01.jpg, D:/pics/02.jpg',
      flaws: '边框两处磕碰, 屏幕无划痕',
      accessories: '原装充电线, 包装盒',
      reason: '换新机后闲置 / 搬家清库存',
    }
    function isTemplateField(value) {
      return value !== null && typeof value === 'object'
        && typeof value.id === 'string' && typeof value.label === 'string'
        && typeof value.type === 'string'
    }
    /** 手写窄化：host 的响应也是外部输入，形状不对就当离线处理。 */
    function isTemplateShape(value) {
      if (value === null || typeof value !== 'object' || !Array.isArray(value.common) || !Array.isArray(value.categories)) return false
      return value.common.every(isTemplateField) && value.categories.every(category => category !== null && typeof category === 'object'
        && typeof category.id === 'string' && typeof category.label === 'string'
        && Array.isArray(category.specs) && category.specs.every(isTemplateField))
    }
    /** 当前品类的字段全集：通用字段 + 该品类规格。 */
    function fieldsOfTemplate(template, categoryId) {
      const category = template.categories.find(item => item.id === categoryId) ?? template.categories[0]
      return [...template.common, ...(category === undefined ? [] : category.specs)]
    }
    /**
     * 勾选语义：勾选 = 允许写进本次文案。
     * 必填恒选；品类规格默认选（选了品类就是要把这些信息说清楚），可显式取消；其余默认不选。
     */
    function fieldPicked(field, form) {
      if (field.required === true) return true
      if (field.group === 'specs') return form.picked[field.id] !== false
      return form.picked[field.id] === true
    }
    /** 全选：非必填项全部显式选中（必填本来就恒选）。 */
    function allPicked(fields) {
      const picked = {}
      for (const field of fields) if (field.required !== true) picked[field.id] = true
      return picked
    }
    /** 清空：规格默认是选中的，必须显式 false 才能取消。 */
    function clearedPicked(fields) {
      const picked = {}
      for (const field of fields) if (field.required !== true) picked[field.id] = false
      return picked
    }
    /** 组装 xy_copy_plan 参数（纯数据）；未勾选/未填的字段一律不出现，避免模型替你编。 */
    function buildCopyPlanArguments(form, fields) {
      const args = { styleId: form.styleId }
      const specs = {}
      for (const field of fields) {
        if (!fieldPicked(field, form)) continue
        const raw = form.values[field.id]
        if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) continue
        if (field.group === 'specs') { specs[field.id] = String(raw).trim(); continue }
        if (field.type === 'integer') {
          const number = Number(raw)
          if (Number.isSafeInteger(number)) args[field.id] = number
          continue
        }
        if (field.type === 'bool') { if (raw === true) args[field.id] = true; continue }
        if (field.type === 'list') {
          const items = String(raw).split(/[,，\n]/u).map(item => item.trim()).filter(item => item !== '')
          if (items.length > 0) args[field.id] = items
          continue
        }
        args[field.id] = String(raw).trim()
      }
      if (Object.keys(specs).length > 0) args.specs = specs
      return { tool: 'xy_copy_plan', arguments: args }
    }
    /**
     * 内联草稿 → publish 任务（面板的价格一律按「分」理解）；daemon 执行时 title/desc/priceCents/images 必填。
     *
     * shipping / address 必须带上：队列任务执行时 daemon 读不到草稿文件，
     * 少了 address「必填项预检」必然 VALIDATION（宝贝所在地为空），任务只会 failed。
     * 取值优先级：草稿里显式给了 > daemon 设置里的 defaultAddress / shipping。
     * 与 host 侧 publish-flow.js 的 buildPublishEnqueueInput 保持同一口径。
     */
    function buildPublishItems(results, accountId, defaults) {
      const items = [], problems = []
      const fallback = defaults === undefined || defaults === null ? {} : defaults
      for (const result of results) {
        const draft = result.draft ?? {}, priceCents = draftPriceCents(draft), desc = typeof draft.desc === 'string' ? draft.desc.trim() : ''
        const invalid = typeof draft.title !== 'string' || draft.title.trim() === '' || desc === '' || !Number.isSafeInteger(priceCents) || priceCents <= 0 || !Array.isArray(draft.images) || draft.images.length === 0
        if (invalid) { problems.push('第 ' + String(result.index + 1) + ' 行缺 title / desc / priceCents / images'); continue }
        const payload = { accountId, title: draft.title.trim(), desc, priceCents, images: draft.images }
        if (typeof draft.category === 'string' && draft.category.trim() !== '') payload.category = draft.category.trim()
        const shipping = draft.shipping === 'free' || draft.shipping === 'none' ? draft.shipping : fallback.shipping
        if (shipping === 'free' || shipping === 'none') payload.shipping = shipping
        const address = typeof draft.address === 'string' && draft.address.trim() !== '' ? draft.address.trim() : fallback.address
        if (typeof address === 'string' && address.trim() !== '') payload.address = address.trim()
        // 幂等键带上账号：daemon 的 dedupe_key 是全局唯一，不带账号会让 B 号发同款被判成重复丢单。
        items.push({ kind: 'publish', dedupeKey: 'publish:' + JSON.stringify([accountId, payload.title, payload.desc, priceCents, draft.images, payload.shipping ?? null, payload.address ?? null, payload.category ?? null]), payload })
      }
      return { items, problems }
    }
    /** settings 对象 → 表单初值（发布间隔按秒展示）。 */
    function settingsForm(settings) { return { interval: String(Math.round(Number(settings.publishMinIntervalMs ?? 0) / 1000)), category: String(settings.defaultCategory ?? ''), style: String(settings.copyStyle ?? COPY_STYLE_OPTIONS[0].id) } }
    /**
     * 动作结果行：所有「点两次写操作」的提示都走这里。
     * `role=status` + aria-live 让读屏把「再点一次」「已过期」「失败原因」播报出来——上膛态原本只有颜色差别。
     */
    const resultLine = (result, role) => result === null ? null : h('div', { style: result.kind === 'bad' ? S.badText : result.kind === 'ok' ? S.goodText : S.small, 'data-role': role, role: 'status', 'aria-live': 'polite' }, result.text)
    function gridRow(columns, head) { return { display: 'grid', gridTemplateColumns: columns, gap: '8px', alignItems: 'center', padding: '7px 0', borderBottom: '1px solid var(--dsw-alias-border-l2)', fontSize: head ? '12px' : '13px', color: head ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-label-primary)' } }
    const TASK_GRID = 'minmax(110px, 1.2fr) 70px 84px 64px 92px 78px'

