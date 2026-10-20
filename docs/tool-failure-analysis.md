# 工具调用失败复盘（2026-10-20）

## 1. 统计口径

会话日志：`~/.dsh/sessions/--D-Github-big~0020fish--/<sessionId>/session.v4.jsonl.zstd`
方法：zstd 解压后用 Node 解析 `tool/call`、`tool/ptc-dispatch`（含 `isError`/`error.code`）、`tool/result` 三类事件，按工具名与错误码聚合。

## 2. 数据

| 会话 | 工具调用 | 失败 | 失败率 | 说明 |
| --- | --- | --- | --- | --- |
| 主会话 e2abb812 | 163 | 39 | **23.9%** | 网络调研阶段集中爆发 |
| 子 agent 2e44d356 | 170 | 1 | 0.6% | glob 参数错误 |
| 子 agent 718eb997 | 127 | 2 | 1.6% | read 文件不存在 |
| 子 agent d2a4fab4 | 106 | 3 | 2.8% | read 文件不存在 + read 异常 |
| **合计** | **566** | **45** | **8.0%** | 另有 7 次外层 `CODE_RUN_FAILED` |

### 错误构成（主会话 39 次）

| 错误码 | 次数 | 触发场景 | 性质 |
| --- | --- | --- | --- |
| `WEB_UNSUPPORTED_CONTENT_TYPE` | 21 | `cdn.jsdelivr.net/gh/.../*.py` 返回 octet-stream，web_fetch 拒收 | 选错镜像 |
| `WEB_PROVIDER_ERROR` | 12 | `raw.githubusercontent.com` 的网络供应商不可达 | 选错镜像 |
| `ECONNREFUSED` (hindsight) | 2 | 本地 9077 daemon 未启动 | 工具本身坏 |
| `WEB_REDIRECT_BLOCKED` | 1 | 跨域重定向（toutiao） | 目标站限制 |
| `WEB_ABORTED` | 1 | web_search 中断 | 瞬时 |
| `ABORTED` (ops_bash) | 1 | 命令被中断 | 瞬时 |
| 参数校验失败 (compress) | 1 | `content` 传成 `{m00001:"…"}` 而非 startId/endId | 用法错误 |

### 外层 `CODE_RUN_FAILED`：7 次

全部同一个根因：run_code 用 `Promise.all` 并行调用工具，任一 reject 让整个程序失败，兄弟结果全部丢失（hindsight、web_fetch、hindsight_list 各若干次）。这不是"工具坏了"，而是**编排写法没有隔离故障**。

## 3. 根因归纳

1. **编排未隔离**（7 次外层失败 + 连带丢结果）：用 `Promise.all` 而非 `Promise.allSettled`/try-catch。
2. **镜像选择错**（33 次 = 21+12）：默认路径依赖 raw.githubusercontent / jsdelivr 直取源码，二者在此网络环境分别不可达 / 返回 octet-stream。
3. **坏工具仍在注册**（2 次 + 每轮注入的 memory 指令）：Hindsight daemon 未启动，插件仍注册 `hindsight_*` 与注入引导。
4. **环境事实未固化**：bash/curl 与 python 无外网、`write` 不能写 /tmp、全盘 grep 超时——这些每次重新踩。

## 4. 修复清单（本次已执行）

| 项 | 动作 | 生效时点 |
| --- | --- | --- |
| 编排写法 | 新增仓库级 `AGENTS.md` §1：禁止裸 `Promise.all`，一律 `allSettled` + 逐条 try/catch | 下次会话（DSH 启动时加载 AGENTS.md） |
| GitHub 取文件 | `AGENTS.md` §2：改用 `api.github.com/repos/.../contents`（`Accept: application/vnd.github.raw`）或 ghfast.top tarball | 下次会话 |
| 网络/临时文件/grep/compress | `AGENTS.md` §3–§7 固化规则 | 下次会话 |
| Hindsight 失败 | `~/.hindsight/coding-agent.json` 增加 `banks["coding-agent::big fish"].disabled=true`，重启后不再注册/注入 | 重启 DSH 后 |
| 复盘留档 | 本文件 | 立即 |

## 5. 为什么不"修好" Hindsight

实测 daemon 能启动，但有两道硬墙：

1. **Python 进程无外网**：`hindsight-api` 用 urllib/httpx 连接 `api.deepseek.com` 失败（bash/curl 同样返回 000），而记忆抽取与 embedding 都需要出网。
2. **没有可用的 embeddings**：默认 `local` 需 sentence-transformers（未安装，且要下 ~2.5GB torch）；`onnx` 需从 huggingface.co 拉模型（不可达；hf-mirror 可达但需要额外配置 HF_ENDPOINT）；DeepSeek 无 embeddings 接口。

已实测可启动（DeepSeek LLM + onnx 配置），但启动后在 `Verifying connection` 卡死退出，验证了第 1 条。因此选择"本仓库关闭"而非"假装修好"。

## 6. 可验证的改进

- 下一次同类调研中，GitHub 文件读取应 0 失败（走 contents API / tarball）；
- run_code 即使某个子调用失败，也会打印其余结果（allSettled 模板）；
- Hindsight 相关失败应归零（工具不再被调用/注册）。
