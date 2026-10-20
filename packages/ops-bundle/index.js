/**
 * @bigfish/ops-bundle 的 ESM 入口。
 *
 * 本包不执行代码，只承载 cordis.patch.yml —— bundle 的语义由 package.json 里的
 * dsh.bundle.patch 声明，入口仅用于让 Node/pnpm 解析包本身。
 *
 * @module @bigfish/ops-bundle
 */
export const name = 'bigfish-ops-bundle'
