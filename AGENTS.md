# AGENTS.md — 本仓库的工作约定（DSH 自动加载）

> 起因：2026-10-20 复盘发现主会话 **163 次工具调用 / 39 次失败（23.9%）**，全部是可预防的用法问题。
> 完整统计、根因与修复记录见 `docs/tool-failure-analysis.md`。以下规则必须遵守。

## 1. run_code：任何工具调用都要兜住异常

```ts
// ✅ 唯一推荐写法
const jobs = { a: tools.web_fetch({url: u1}), b: tools.ops_bash({command: c}) }
const settled = await Promise.allSettled(Object.values(jobs))
settled.forEach((s, i) => {
  if (s.status === "rejected") { console.log("FAILED", Object.keys(jobs)[i], String(s.reason).slice(0, 200)); return }
  console.log(Object.keys(jobs)[i], (s.value as any)?.stdout?.text ?? JSON.stringify(s.value).slice(0, 500))
})
```

- **禁止** `await Promise.all([...tools.web_fetch(...)])** 直接并行网络/文件工具：任意一个 reject，整个程序崩溃，已完成的结果也全部丢失（历史上 7 次 `CODE_RUN_FAILED` 都是这个原因）。
- 单个调用用 `try/catch`；循环里逐次 try，失败跳过继续。

## 2. 取 GitHub 文件：不要用 raw.githubusercontent.com / jsdelivr

| 路径 | 结果 | 结论 |
| --- | --- | --- |
| `https://raw.githubusercontent.com/...` | web_fetch → `WEB_PROVIDER_ERROR` | **不可用** |
| `https://cdn.jsdelivr.net/gh/.../*.py` | 返回 `application/octet-stream` → `WEB_UNSUPPORTED_CONTENT_TYPE` | **不可用**（.md 偶尔可以，别赌） |
| `https://api.github.com/repos/{o}/{r}/contents/{path}` | 200 + base64 | ✅ 首选（带 `Accept: application/vnd.github.raw` 可直接拿原文） |
| `https://ghfast.top/https://github.com/{o}/{r}/archive/refs/heads/{branch}.tar.gz` | 200 | ✅ 整仓下载（配合 bash `tar -xzf`） |
| `https://api.github.com/repos/{o}/{r}` / `/git/trees/{branch}?recursive=1` | 200 | ✅ 仓库元信息 / 文件树 |

## 3. 网络出口只有一个：run_code 里的 Node fetch

- `ops_bash` 里的 `curl`/`wget` 对外网返回 **000**（无出口）；`python urllib` 直接连接失败。
- 需要联网时，在 run_code 里用 `await fetch(...)`（可加 `AbortSignal.timeout`），或 `tools.web_search` / `tools.web_fetch`。
- 本地回环（127.0.0.1）同样以 node fetch 为准。

## 4. 临时文件写进 `.scratch/`

- `write` 工具写 `/tmp` 会被文件沙箱拒绝（`file access denied under workspace-write mode`）；bash 虽然能写 `/tmp`，但不要依赖。
- 临时脚本/中间产物统一放 `D:\Github\big fish\.scratch\`（已在 .gitignore），交付物放 `docs/`、`research/`。

## 5. compress 参数格式

```ts
// ✅
await tools.compress({ content: [{ startId: "m00100", endId: "m00150", summary: "…" }] })
// ❌ 曾报 "no valid ranges parsed"
await tools.compress({ content: { m00100: "m00100–m00150" } } as any)
```

## 6. grep / find 必须限定范围

- 只在具体目录 + `--include=*.ts` 之类过滤下 grep；对 `$HOME`、`node_modules`、整个 DSH checkout 做递归扫描会 60–120s 超时（已发生 2 次）。
- 结果一律 `| head -n`，或先 `-l` 列文件再逐个读。

## 7. 长命令要设 timeoutMs，探测要有上限

`ops_bash` 默认 120s；服务启动、扫描类命令显式传 `timeoutMs`，轮询用固定次数 + `await new Promise(r => setTimeout(r, ms))`，不要无界 sleeps。

## 8. Hindsight 记忆：本机**当前不可用**，不要调用

- 现象：`hindsight_*` 全部 `ECONNREFUSED 127.0.0.1:9077`；daemon 从没起来。
- 根因：daemon 是 Python 进程，本沙箱里 **Python/bash 无外网出口**（LLM 与 embedding 都拉不到），且默认 embeddings=local 需要 sentence-transformers（未安装）、HF 不可达。
- 处理：已在本仓库关闭 memory（`~/.hindsight/coding-agent.json` → `banks["coding-agent::big fish"].disabled = true`），重启 DSH 后生效。**在那之前不要调用 `hindsight_*`**，避免继续产生失败记录。
- 恢复条件（任一）：换成可达的 LLM+embeddings（含 OpenAI 兼容 embeddings 端点）、或 cloud 模式配 token、或放开 Python 进程网络。

## 9. 报告口径

引用工具产物时注明来源与命令；失败要写进最终答复（不静默重试掩盖）。修改本文件后告知用户"下次会话生效"。
