/**
 * 「分类」下拉的页面侧探针：页面脚本模板 + 返回值窄化校验集中在这里。
 * 为什么单独成文件：category.ts 负责流程与 fail-closed 决策，脚本模板本身很长，混在一起两边都难读
 * （仓库规定单文件 ≤400 行）。
 *
 * 校准事实（真机，2026-10-21/22 测试小号）见 category.ts 顶部注释；这里只关心「怎么从页面取到可信坐标」。
 * @module @bigfish/channel-cdp/category-page
 */
import { jsQuote } from './dom.ts'

/** 「分类」表单项的 label 文本。 */
export const CATEGORY_LABEL = '分类'
/** 分类下拉选项（antd portal，挂在 body 上）。 */
const CATEGORY_OPTION = '.ant-select-item-option'
/** antd Select 的下拉容器（portal）。 */
const CATEGORY_DROPDOWN = '.ant-select-dropdown'
/** antd 给「已关闭但没销毁」的下拉加的类。 */
const HIDDEN_DROPDOWN_CLASS = 'ant-select-dropdown-hidden'

export interface CategorySelectState {
  point: { x: number; y: number }
  inViewport: boolean
  open: boolean
}

export type OptionMiss = 'not-open' | 'no-option' | 'off-screen' | 'obscured'

export interface CategoryOptionProbe {
  point?: { x: number; y: number }
  miss?: OptionMiss
  options: string[]
}

/** 页面脚本里的「找分类表单项」片段（各脚本共用，只依赖 antd 的 form item 结构）。 */
const PAGE_FIND_CATEGORY_ITEM = `  function findCategoryItem() {
    const want = ${jsQuote(CATEGORY_LABEL)};
    const items = Array.from(document.querySelectorAll(".ant-form-item"));
    return items.find(function (it) {
      const label = it.querySelector(".ant-form-item-label label");
      if (label === null) return false;
      const title = (label.getAttribute("title") || "").trim();
      return title === want || (label.textContent || "").trim() === want;
    }) || null;
  }`

/**
 * 页面脚本里的「解析分类下拉」片段：只认当前 Select 自己的下拉，且必须真的处于打开状态。
 * 打开判据是 `.ant-select-open` + aria-expanded=true —— 本机环境下拉 appear 动画永远停在 prepare、
 * opacity 恒为 0，等动画或建可见性判断必然误判。
 */
const PAGE_CATEGORY_DROPDOWN = `  function optionText(el) { return (el.textContent || "").trim(); }
  function resolveDrop(item) {
    const select = item.querySelector(".ant-select");
    const comb = item.querySelector("[role=combobox]");
    const open = select !== null && select.classList.contains("ant-select-open") &&
      comb !== null && comb.getAttribute("aria-expanded") === "true";
    if (!open) return null;
    const listId = comb === null ? "" : (comb.getAttribute("aria-controls") || comb.getAttribute("aria-owns") || "");
    const list = listId === "" ? null : document.getElementById(listId);
    let drop = list === null ? null : list.closest(${jsQuote(CATEGORY_DROPDOWN)});
    if (drop === null) {
      /* listbox id 找不到时退回「最后一个可见下拉」：每个 Select 复用一个 portal，新开的在最后；
         必须排除 hidden，否则会点到已关闭/别的 Select 的旧选项 */
      const visible = Array.from(document.querySelectorAll(${jsQuote(CATEGORY_DROPDOWN)})).filter(function (el) {
        const style = window.getComputedStyle(el);
        return !el.classList.contains(${jsQuote(HIDDEN_DROPDOWN_CLASS)}) &&
          style.display !== "none" && style.visibility !== "hidden";
      });
      drop = visible.length === 0 ? null : visible[visible.length - 1];
    }
    return drop;
  }`

/** 触发器坐标 + 是否在视口内 + 下拉是否真的打开。 */
export function categoryStateScript(): string {
  return `(function () {
  /* bf-category-select-state */
${PAGE_FIND_CATEGORY_ITEM}
  const item = findCategoryItem();
  if (item === null) return '';
  const select = item.querySelector(".ant-select");
  const comb = item.querySelector("[role=combobox]");
  const trigger = item.querySelector(".ant-select-selector");
  if (trigger === null) return '';
  const rect = trigger.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return '';
  const inViewport = rect.top >= 0 && rect.left >= 0 &&
    rect.bottom <= window.innerHeight && rect.right <= window.innerWidth;
  const open = select !== null && select.classList.contains("ant-select-open") &&
    comb !== null && comb.getAttribute("aria-expanded") === "true";
  return JSON.stringify({
    x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2),
    inViewport: inViewport, open: open
  });
})()`
}

/** 读分类当前值（没选中返回空串）。 */
export function categoryValueScript(): string {
  return `(function () {
  /* bf-category-value */
${PAGE_FIND_CATEGORY_ITEM}
  const item = findCategoryItem();
  if (item === null) return '';
  const selected = item.querySelector(".ant-select-selection-item");
  if (selected === null) return '';
  const title = (selected.getAttribute("title") || "").trim();
  return title === "" ? ((selected.textContent || "").trim()) : title;
})()`
}

/** 把「分类」触发器滚进视口（只在打开下拉之前用）。 */
export function categoryScrollScript(): string {
  return `(function () {
  /* bf-category-scroll */
${PAGE_FIND_CATEGORY_ITEM}
  const item = findCategoryItem();
  if (item === null) return '';
  const trigger = item.querySelector(".ant-select-selector");
  if (trigger === null) return '';
  trigger.scrollIntoView({ block: "center", inline: "nearest" });
  return "ok";
})()`
}

/** 目标选项的坐标（只在可见、无人遮挡时给坐标；否则给出原因和候选）。 */
export function categoryOptionScript(want: string): string {
  return `(function () {
  /* bf-category-option-rect */
${PAGE_FIND_CATEGORY_ITEM}
${PAGE_CATEGORY_DROPDOWN}
  const item = findCategoryItem();
  if (item === null) return JSON.stringify({ miss: "not-open", options: [] });
  const drop = resolveDrop(item);
  if (drop === null) return JSON.stringify({ miss: "not-open", options: [] });
  const nodes = Array.from(drop.querySelectorAll(${jsQuote(CATEGORY_OPTION)}));
  const options = nodes.map(optionText).filter(function (t) { return t !== ""; });
  const hit = nodes.find(function (el) { return optionText(el) === ${jsQuote(want)}; });
  if (hit === undefined) return JSON.stringify({ miss: "no-option", options: options });
  const box = drop.getBoundingClientRect();
  const rect = hit.getBoundingClientRect();
  const x = Math.round(rect.left + rect.width / 2);
  const y = Math.round(rect.top + rect.height / 2);
  /* 不调 scrollIntoView：选项在 portal 里，滚它会把主页面滚走并让 antd 重排下拉 */
  const inside = rect.width > 0 && rect.height > 0 && x > box.left && x < box.right &&
    y > box.top && y < box.bottom && x > 0 && x < window.innerWidth && y > 0 && y < window.innerHeight;
  if (!inside) return JSON.stringify({ miss: "off-screen", options: options });
  const at = document.elementFromPoint(x, y);
  const under = at === null ? null : at.closest(${jsQuote(CATEGORY_OPTION)});
  if (under === null || optionText(under) !== ${jsQuote(want)}) {
    return JSON.stringify({ miss: "obscured", options: options, under: under === null ? "" : optionText(under) });
  }
  return JSON.stringify({ x: x, y: y, options: options });
})()`
}

/** 当前下拉里出现的候选文本（只用于报错提示；下拉没打开时返回空数组）。 */
export function categoryOptionTextsScript(): string {
  return `(function () {
  /* bf-category-option-texts */
${PAGE_FIND_CATEGORY_ITEM}
${PAGE_CATEGORY_DROPDOWN}
  const item = findCategoryItem();
  if (item === null) return [];
  const drop = resolveDrop(item);
  if (drop === null) return [];
  return Array.from(drop.querySelectorAll(${jsQuote(CATEGORY_OPTION)}))
    .map(optionText).filter(function (t) { return t !== ""; });
})()`
}

/** 页面脚本返回的 JSON 对象（非法一律当没拿到：页面重渲染时 rect 会短暂为 0）。 */
export function parseRecord(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== 'string' || !raw.startsWith('{')) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  return parsed as Record<string, unknown>
}

export function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 页面坐标必须为正（CDP 拒绝 0/负坐标）。 */
export function readPoint(record: Record<string, unknown>): { x: number; y: number } | undefined {
  const x = readNumber(record, 'x')
  const y = readNumber(record, 'y')
  if (x === undefined || y === undefined || x <= 0 || y <= 0) return undefined
  return { x, y }
}

export function readTextList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
}
