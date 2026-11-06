# magpie-opencode-cli

一个 magpie 供应商插件：通过**本机安装的 OpenCode CLI** 提供 OpenCode 的免费模型。

## 为什么需要它

OpenCode 的免费额度只对**官方客户端**开放。同一个模型、同一个 prompt：

| 调用方式 | 结果 |
|---|---|
| 直接 POST `https://opencode.ai/inference/v1/chat/completions` | `429 FreeUsageLimitError` |
| `opencode run -m opencode/<model>` | 正常返回 |

2026-10-25 实测：匿名 `public` 凭据、自有 Console key、User-Agent 伪装成 `opencode/1.15.5`，四种组合全部 429；换 IP 也没有用。官方维护者在 issue #43786 的答复是「免费模型是给 OpenCode 内部使用的」，并关闭为 working as intended。

所以这个插件不直连 opencode.ai，而是驱动本机的 OpenCode CLI——请求由官方客户端身份发出，额度按 CLI 的 session 计算。

## 依赖

- 已安装 **OpenCode CLI**，1.x（`npm i -g opencode-ai`）或 2.x（`npm i -g @opencode/cli`）都可以；`~/.opencode/bin/opencode` 也行
- magpie（自带 Bun 插件宿主，无需另装 Node）

插件按以下顺序查找 CLI：`PATH` → `OPENCODE_BIN` / `BUDDY_OPENCODE_PATH` 环境变量 → `~/.opencode/bin/opencode.exe` → npm 全局 `node_modules/opencode-ai/bin/opencode.exe` → npm 全局 `opencode.cmd`。npm 留下的 `.cmd` 垫片会被跟踪到它指向的真实 `.exe`。

CLI 未安装时，登录会失败并提示安装命令。

两个大版本在插件里的差异：

| | 1.x | 2.x |
|---|---|---|
| 模型列表 | `models --verbose` 带完整元数据 | 只有 `models`，仅 id，无上下文/费用字段 |
| 事件流 | `step_start` / `text` / `step_finish` | 只有 `step_start` / `text` |
| token 用量 | `step_finish` 里带 | 不提供，用量记为 0 |
| 长对话 | 只能走命令行参数 | 走 stdin，无 32,767 字符限制 |

## 安装

从 git 仓库（公开仓库，目标机器的 git 无需凭据）：

```sh
magpie plugin add github:Jimmy6188/magpie-opencode-cli
magpie plugin login opencode-cli
magpie providers
```

钉某个版本用 `#`：`magpie plugin add github:Jimmy6188/magpie-opencode-cli#v0.1.0`。

本地开发则直接给文件夹路径，就地加载当前内容：

```sh
magpie plugin add /path/to/magpie-opencode-cli
```

登录方式是「本机 OpenCode CLI」，**无需任何密钥**——CLI 用它自己的本地身份（匿名，或你自己登录过的账号）。

## 模型

登录后可用 `opencode models --verbose` 看到的全部免费模型，自动过滤掉已废弃的。2026-10-25 本机为 9 个：

```
beam-free                       big-pickle                    deepseek-v4.1-flash-free
flint-40b-free                  glm-5.3-flash-free            mimo-v2.6-flash-free
nemotron-3-ultra-free           nemotron-3.5-lightning-free   nemotron-3.5-super-vl-free
```

模型 ID 形如 `opencode-cli/nemotron-3.5-lightning-free`，和其他供应商一样可以进 `auto/*` 路由组、配 `fallback`。

## 免费额度用尽时会发生什么

OpenCode 的免费池按本机身份（或 API key）限流；额度用尽时它返回 429
`FreeUsageLimitError`，并附上接受下次请求的等待时长。插件把这个状态原样往上传：

```
HTTP 429
Retry-After: 74808
{"error":{"message":"Free usage limit reached. … Free quota resets at 2026-11-07 08:49（约 20.8 小时后）.",
          "type":"rate_limit_error"}}
```

流式请求也一样：插件会先读 CLI 打印的第一个事件，确认不是错误才提交 SSE 响应。
这样调用方（magpie 路由组）看到的是真正的 429，可以按 `Retry-After` 冷却该供应商并切到下一个成员，
而不是拿到一个 HTTP 200、错误藏在响应体里的“成功”请求。

0.1.2 之前的版本对**流式**请求会先回 200 再在流里吐错误，且把额度耗尽当普通 502，
丢掉状态码和重置时间。

## 已知限制

1. **只支持对话，不支持工具调用**。插件的模型声明 `toolcall: false`，请求里的 `tools` 会被忽略。工具调用需要额外一套 JSON envelope 协议，尚未实现。
2. **对话长度**：1.x 受 Windows 命令行上限约束（32,767 字符），超过 24,000 字符会返回明确错误；2.x 把 prompt 走 stdin，上限放宽到 200,000 字符（约为免费模型 128k 上下文的一半）。
3. **无会话连续性**：每一轮都把完整历史序列化进 prompt，token 开销高于原生 session。
4. **每次请求多 1–2 秒**：要为该请求启动一个 CLI 进程。
5. **并发上限 2**（`magpie.maxConcurrency`），每个请求一个进程。
6. **2.x 没有 token 用量**：`step_finish` 事件被移除，magpie 里该渠道的消耗显示为 0。
7. **上游风险**：OpenCode 维护者明言该身份门禁 "may change at any time"，CLI 通道哪天被收不意外。
8. **免费额度**：免费池按 IP/key 限流，与模型无关——一个模型 429 时其他免费模型同样 429，只能等 `Retry-After` 到期或换网络出口，没有“换模型绕过”。额度本身由上游控制，插件无法恢复。

## 工作原理

```
Proma / agent
   ↓ OpenAI chat completions
magpie 网关
   ↓ 同一个请求（插件宿主，Bun）
index.mjs 的 loader.fetch
   ↓ messages → 一段带角色标记的 transcript
cli.mjs  spawn opencode run --format json -m opencode/<model> <prompt>
   ↓ 逐行读 stdout 的 JSON 事件
protocol.mjs  事件 → OpenAI SSE chunk / 非流式 completion
```

## 开发

```sh
bun selftest.mjs   # 离线：用假 runner 跑错误与流式路径，不需要额度
node verify.mjs    # 真实：会发起实际请求，需要免费额度可用
```

`verify.mjs` 跑本地检查：CLI 定位、免费模型列表、提示词形态、一次非流式请求、一次流式请求（`[DONE]`/usage/`finish_reason`）、地区墙模型的错误信息、未知模型与空 messages 的拒绝。它不属于插件运行所需文件。

`selftest.mjs` 用注入的 runner 覆盖额度错误（流式与非流式都必须先回 429 + `Retry-After`）、2.x/1.x 正常流、流中途失败、旧版错误结构、未知模型与空消息的拒绝，因此额度耗尽时也能验证改动。

要改协议转换就看 `protocol.mjs`，要改 CLI 调用就看 `cli.mjs`，两者的输入输出都被 `verify.mjs` 与 `selftest.mjs` 覆盖。
