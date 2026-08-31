# MineBench — Ark 自定义网关适配版

> 这是 [Ammaar-Alam/minebench](https://github.com/Ammaar-Alam/minebench) 的 fork,
> 增加了对**固定请求契约**第三方网关的支持,补齐了批量跑分与可分享的 3D 导出,
> 并新增**多提供商配置 / Battle 多模型对比 / 完整请求响应日志**。
> 原项目的完整介绍见本文档下半部分(Upstream README)。

出站 `User-Agent` 统一为 `claude-cli/2.1.179 (external, cli)`
(单一来源 `lib/ai/userAgent.ts`,每个提供商可单独覆盖,
或用 `CUSTOM_API_USER_AGENT` 覆盖默认值)。

## 这个 fork 做了什么

原仓库的 `custom` 通道假设对端是标准 OpenAI 兼容服务。对于
火山方舟 Agent Plan 端点(`/api/plan/v3`)这类**参数被锁定**的网关,
有 5 处不兼容,均已实测确认并适配:

| 问题 | 现象 | 处理 |
|---|---|---|
| URL 路径被改写 | `/api/plan/v3` → `/api/plan/v3/v1/...` → 404 | 新增 `exactPath` 模式,路径原样保留 |
| `response_format` | **接受但不执行**(返回散文,不报错) | 默认不发送,改用提示词约束 + 容错提取 |
| `reasoning_content` | 与 `content` 同级,会污染 JSON | 双通道分流,思维链独立展示 |
| `max_tokens` | 上游默认 262144 → 网关 400 报错 | **硬钳制**到 131072,不可被调用方覆盖 |
| `model` 回显 | 恒为 `"auto"` | 不用于校验 |

`thinking: {type:"enabled"}` 恒发送;`reasoning_effort` 支持
`low`/`medium`/`high`/`xhigh`/`max`,也可完全省略。取值非法会**抛错而非静默降级**。

### 结构化输出的实测结论

方舟平台**文档上是支持**结构化输出的,问题出在**端点层级**:

- `/api/plan/v3` 只接受 agent-plan 模型(如 `ark-code-latest`);
  请求 `doubao-seed-1-6-251015` 会返回 `UnsupportedModel`
- plan 作用域的 key 打标准 `/api/v3` 端点会 401
- 传 `response_format: "字符串"` 会正确报错 `expected an object`,
  证明字段被解析;但传合法 schema 后**接受即丢弃**

定量对比(同一提示各跑 3 次):

| 方式 | 可解析为 JSON |
|---|---|
| `json_schema` strict | **0 / 3**(返回散文) |
| 仅提示词约束 | **3 / 3** |

因此默认关闭,并提供开关 —— 若你的 key 指向标准 `/api/v3`,
在前端勾选即可启用真结构化输出,无需改代码。

用这个脚本可以自行判断任意端点:

```bash
sh scripts/probe-structured-output.sh
```

## 新增功能

### 多 AI 提供商配置（可添加任意多个）

`/battle` 与 `/sandbox` 共用一套「自定义提供商」配置层，
不再局限于单一 `custom` 通道。每个提供商可独立配置：

| 配置项 | 说明 |
|---|---|
| 接口类型 | OpenAI 兼容 `/chat/completions`、OpenAI Responses `/responses`、Anthropic `/messages` |
| Base URL | 主机名或完整端点 URL |
| API Key | **可为空**（网关可用 IP / mTLS / 自定义头鉴权） |
| 自动追加 `/v1` | **显式开关**，不做 URL 形状猜测 |
| 锁定信封模式 | 钉住 `max_tokens=131072` + `thinking:{type:"enabled"}` + `include_usage` |
| `response_format` | 默认关闭（很多网关「校验但不执行」） |
| 流式 | SSE 开关 |
| 自定义参数 | 任意键值，支持 `a.b.c` 点路径写入嵌套对象，类型可选 string/number/boolean/json |
| 自定义请求头 | 与鉴权头一起发送，同名可覆盖默认值 |
| thinking 字段 | `omit` / `enabled` / `disabled` / `budget`(Anthropic 预算模式) |
| `reasoning_effort` | `none`(省略) / minimal / low / medium / high / xhigh / max |
| 模型列表 | 一键拉取 `/models`，也可手动增删 |
| 单模型覆盖 | 每个模型可单独覆盖 max_tokens / temperature / reasoning_effort 等 |

**`/v1` 开关为什么必须是显式的**：`https://api.openai.com` 需要补 `/v1`，
而 `https://.../api/plan/v3` 补了就 404 —— 靠 URL 形状猜测正是上游
`custom` 通道最初出错的原因，所以这里把决定权交给使用者并原样执行。

**锁定参数不可被绕过**：自定义参数在锁定钉值**之前**应用，
之后 `max_tokens` / `thinking` / `stream_options` 会被重新钉回，
因此无论 UI 里填了什么，锁定契约始终成立（有测试覆盖）。

配置（含 API key）**只存在浏览器 localStorage**，
随每次请求发送给服务端，服务端不落库、不写盘。

### Battle 多模型对比界面

`/battle`：同一提示词 + 同一配置并发跑多个模型，并排对比。

- 每个结果卡片显示实时进度、方块数、耗时、token 用量、思维链、trace
- ☆ 勾选 winner（可多选）
- **全屏预览**：单栏 / 双栏分屏对比，`←/→` 切换、`S` 分屏、`W` 标记、`Esc` 退出
- **多选导出**：范围可选 winners / 全部成功 / 自定义勾选，
  格式支持 Build JSON、GLB、STL、Minecraft schematic、单文件 HTML 查看器、
  以及 Markdown 对比报告（含方块数/耗时/token 表格与失败原因）

导出按顺序逐个执行而非并发 —— 刚跑完的多个百万级方块构建仍驻留内存，
并发导出是手机端 OOM 的可靠触发方式。

### 请求/响应完整日志（调试用）

勾选 **Capture debug log** 后，每次提供商往返的完整内容都可在页面查看：

- **Request**：URL、全部请求头、完整请求体 JSON
- **Response**：状态码、响应头、解析后的 JSON、拼装出的文本、usage
- **Raw body**：流式响应的原始 SSE 帧
- **Reasoning**：与正文分流的思维链

一键复制当前视图或请求体 JSON。
`Authorization` / `x-api-key` 等鉴权头在离开服务端前即被替换为 `«redacted»`，
不会进入日志、前端或磁盘（有测试覆盖）。

### 批量跑分

上游的 `pnpm batch:generate` 只接受目录内置的 `ModelKey`,无法驱动自定义端点。
新脚本跑同一套官方 15 题:

```bash
sh tests/custom-gateway/build.sh     # 首次需编译 AI 层

node scripts/bench-custom.mjs \
  --grid 512 --palette advanced --reasoning max \
  --attempts 3 --concurrency 15 \
  --name run512 --html --gif
```

支持并发、断点续跑(`--resume`)、逐题落盘,自动生成 `report.md`
(方块数、材质数、连通性、token 消耗)。

### 单文件 3D 网页导出

零依赖、零网络请求,数据 base64 内嵌,**双击即可打开**,手机也支持。
内置两套相机(环绕 / 自由飞行),按 <kbd>V</kbd> 切换,切换时视角连续不跳。

```bash
node scripts/export-html-viewer.mjs <build.json> <out.html> "标题"
```

环绕模式的目标点跟随**可见表面质心**而非包围盒中心 ——
后者对「宽地形 + 高细塔」这类结构会悬在半空。

### 旋转 GIF 导出

```bash
node scripts/export-gif.mjs <build.json> <out.gif> [帧数] [尺寸]
```

### 方块颜色来自真实纹理

从 `public/textures/atlas.png` 采样每个方块的平均色(77 个方块零缺失),
顶面/侧面分开取色(草方块顶绿侧土),并对水、树叶等
运行时染色的灰度遮罩纹理施加标准色调。

```bash
node scripts/build-block-colors.mjs   # 换材质包后重跑
```

### 诊断工具

```bash
node scripts/analyze-build.cjs <build.json>   # 连通性、分层统计、材质直方图
node scripts/slice-build.cjs   <build.json>   # ASCII 剖面,排查结构问题
```

## 快速开始

```bash
pnpm install
pnpm atlas                           # 生成纹理图集(首次必须)
sh tests/custom-gateway/build.sh     # 编译 AI 层供脚本使用
```

创建 `.env.local`:

```bash
CUSTOM_API_BASE_URL=https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions
CUSTOM_API_KEY=<你的 key>
CUSTOM_API_MODEL_ID=ark-code-latest
CUSTOM_API_REASONING_EFFORT=max
CUSTOM_API_USER_AGENT=claude-cli/2.1.179 (external, cli)
MINEBENCH_ALLOW_SERVER_KEYS=1
```

网页版:

```bash
pnpm dev    # → localhost:3000/sandbox
```

模型下拉框选 **Custom → OpenAI-compatible model**,勾选
**Locked-envelope gateway mode**,点 **Apply Ark plan/v3 preset** 自动填好配置。

完整说明见 **[QUICKSTART.md](QUICKSTART.md)**,
技术细节与全部实验矩阵见 **[docs/CUSTOM_PROVIDER.md](docs/CUSTOM_PROVIDER.md)**。

## 测试

```bash
sh tests/custom-gateway/build.sh              # 编译 AI 层(生成 .btest)
sh tests/custom-gateway/build-configured.sh   # 编译多提供商层(.btest-configured)

node tests/custom-gateway/envelope.cjs    # 锁定契约与参数钳制(33 项)
node tests/custom-gateway/security.cjs    # SSRF 防护 + 端点构造(30 项)
node tests/custom-gateway/camera.cjs      # 查看器相机与环绕中心(21 项)

# 多提供商层:URL 构造、锁定钉值不可绕过、三种接口的请求体/流式解析、
# 密钥脱敏、usage 归一化。设 MB_TEST_* 后额外跑真实往返。
MB_TEST_BASE_URL=... MB_TEST_API_KEY=... \
  node tests/custom-gateway/configured-provider.cjs

# 端到端:经「配置化提供商」真实生成并校验一个 voxel build
node tests/custom-gateway/configured-e2e.cjs "a stone lighthouse"

# 可选:OpenAI / Anthropic 真实往返(缺 key 自动跳过)
MB_OPENAI_KEY=... MB_ANTHROPIC_KEY=... \
  node tests/custom-gateway/live-flavours.cjs

node tests/custom-gateway/integration.cjs "a stone lighthouse"   # 旧通道端到端
```

类型检查(受限环境下 `tsc` 整项目会 OOM,故按文件分批):

```bash
sh scripts/typecheck-batch.sh                 # 默认检查多提供商相关文件
sh scripts/typecheck-batch.sh path/to/file.ts # 或指定文件
```

## 安全说明

- API key 只存放于 `.env.local`(已 gitignore)或浏览器 localStorage,
  仓库内无任何硬编码密钥;服务端不落库、不写盘
- **鉴权头永不进入日志**:`Authorization` / `x-api-key` 等在离开服务端前
  即被替换为 `«redacted»`(调试日志、前端、磁盘均看不到明文)
- SSRF 防护对**新增的多提供商端点同样生效**:无论 `chat/completions`、
  `responses`、`messages` 还是 `models`,都走同一套校验 ——
  拒绝 localhost、`.local`、私有/保留 IP 段、嵌入式凭据,
  逐条校验 DNS 解析结果,并连接到已校验的 IP(防 DNS rebinding)
- 自定义请求头名按 RFC 7230 token 校验、头值禁止换行,阻断头注入
- `CUSTOM_API_TRUSTED_HOSTS` 仅用于本机 DNS 把公网域名解析到保留网段的情况
  (代理/VPN/split-horizon),且不会放宽到未授权主机

## 与上游的差异

- 压成单提交,未保留上游 commit 历史
- 未包含 `.github/workflows/ci.yml`(上游 CI,依赖其自有 secrets)
- 其余文件与上游一致

## 已知限制

- **`max_tokens` 锁定 131072**。grid 512 理论上限 1.34 亿方块,
  但受 token 上限约束,实际收益相比 grid 256 有限
  (生成的是 JS 代码而非坐标列表,所以实际方块数可远超 token 估算值)
- 保存构建、画廊、排行榜需要 Postgres
  (`pnpm db:up && pnpm db:wait && pnpm prisma:migrate`);
  纯生成与跑分不需要

---
---

# Upstream README

以下为原项目 [Ammaar-Alam/minebench](https://github.com/Ammaar-Alam/minebench) 的说明,原文保留。


<p align="center">
  <a href="https://minebench.ai">
    <img src=".github/assets/readme/minebench-banner.png" style="height: 10em" alt="MineBench banner"/>
  </a>
</p>

<p align="center">
  <a href="https://minebench.ai"><img alt="Live" src="https://img.shields.io/badge/Live-minebench.ai-0ea5e9?style=flat&logo=vercel&logoColor=white" /></a>
  <a href="https://alpha.minebench.ai"><img alt="Alpha" src="https://img.shields.io/badge/Alpha-alpha.minebench.ai-f59e0b?style=flat&logo=vercel&logoColor=white" /></a>
  <a href="https://apps.apple.com/app/minebench/id6803704037"><img alt="App Store" src="https://img.shields.io/badge/App%20Store-iOS-000000?style=flat&logo=apple&logoColor=white" /></a>
  <a href="https://github.com/Ammaar-Alam/minebench/releases/latest"><img alt="Latest Release" src="https://img.shields.io/github/v/release/Ammaar-Alam/minebench?style=flat&color=22c55e&label=release&display_name=tag" /></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-3b82f6?style=flat" /></a>
</p>

<p align="center">
  <a href="docs/README.md"><img alt="Docs" src="https://img.shields.io/badge/Docs-Documentation-6366f1?style=flat" /></a>
  <a href="https://buymeacoffee.com/ammaaralam"><img alt="Support" src="https://img.shields.io/badge/Support-Buy%20Me%20a%20Coffee-ffdd00?style=flat&logo=buy-me-a-coffee&logoColor=000000" /></a>
  <a href="https://x.com/minebench_ai"><img alt="MineBench on X" src="https://img.shields.io/badge/X-%40minebench_ai-000000?style=flat&logo=x&logoColor=white" /></a>
</p>

<h1 align="center">MineBench</h1>

**A benchmark for evaluating AI spatial reasoning through Minecraft-style voxel construction.**

Models are given a natural-language prompt and must produce raw 3D coordinates as JSON. In tool mode, models call `voxel.exec` (minimal primitives: `block`, `box`, `line`) to generate large builds beyond token-only JSON limits. MineBench visualizes the output and ranks models from blind head-to-head votes using a global Bradley-Terry model with uncertainty intervals.

**[Try it live](https://minebench.ai)**

![MineBench arena — Opus 4.5 versus Opus 4.6](.github/assets/readme/benchmark-split.gif)
![MineBench default Arena landing page](.github/assets/readme/arena-landing-page.png)

> [!Note]
> MineBench is not technically a 'benchmark' as it has no objectively correct answers; it is a take on the <a href="https://arxiv.org/abs/2403.04132">LMSYS Chatbot Arena</a>. Many use MineBench to get the general feel or "vibe" of a model. AI labs may use MineBench to privately A/B test model checkpoints.

## Why MineBench?

Most LLM benchmarks test text and raw accuracy. MineBench instead tests whether a model can reason about 3D space. Given a prompt like "a medieval castle with four towers", the model must mentally construct geometry, pick materials, and output thousands of precise block coordinates. No vision model or diffusion – just math and spatial logic.

As it turns out, this kind of spatial reasoning correlates strongly with a model's raw general intelligence; the MineBench leaderboard tracks, anecdotally, the same hierarchy that most people observe in real-world usage: the smartest reasoning models are clearly visible when asked to produce visual builds.

MineBench, unlike other benchmarks, gives an easy way to visually determine (at least one aspect of) a model's raw intelligence. The ranking system also highlights which models are clearly 'bench-maxed' (i.e. when a model has amazing benchmarks on paper, but clearly lacks in real world usage).

![MineBench arena — two AI models building a medieval castle side-by-side](.github/assets/readme/arena-dark.gif)

## Features

* **Arena** — blind head-to-head comparisons of pre-generated builds with confidence-aware ranking
* **Sandbox** — compare existing builds, generate new ones, or import output from any model
* **Gallery** — explore community prompts and keep signed-in generations
* **Leaderboard** — live rankings with win/loss/draw stats across all models
* **Exports** — save builds as GLB, STL, or WorldEdit `.schem` for Blender, 3D printing, and Minecraft

## Documentation

* Full docs index: [`docs/README.md`](docs/README.md)
* Local development: [`docs/local-development.md`](docs/local-development.md)
* Operations and API reference: [`docs/operations.md`](docs/operations.md)
* Gallery and saved generations: [`docs/gallery.md`](docs/gallery.md)
* Arena ranking: [`docs/arena-ranking-system.md`](docs/arena-ranking-system.md)
* Build export and imports: [`docs/build-export-import.md`](docs/build-export-import.md)

## Frequently Asked Questions

The full FAQ is available at **[minebench.ai/faq](https://minebench.ai/faq)**. Every answer has a stable link for sharing or citation.

### About MineBench

* [What is MineBench?](https://minebench.ai/faq#what-is-minebench)
* [How do models actually create the builds?](https://minebench.ai/faq#how-do-models-create-builds)
* [Why do some models add objects or scenery that were not explicitly requested?](https://minebench.ai/faq#why-do-models-add-extra-scenery)

### Methodology

* [How are models ranked if there is no single correct build?](https://minebench.ai/faq#how-are-models-ranked)
* [Can models train on MineBench or “benchmax” it?](https://minebench.ai/faq#can-minebench-be-contaminated-or-benchmaxxed)
* [How do grid size, block limits, and different leaderboard settings work?](https://minebench.ai/faq#how-do-grid-size-block-limits-and-leaderboard-settings-work)
* [Why not add more prompts, grid sizes, block-limited settings, and other evaluation modes?](https://minebench.ai/faq#why-not-add-more-evaluation-modes)
* [Are generations one-shot?](https://minebench.ai/faq#are-generations-one-shot)

### Using MineBench

* [Can I compare different models directly?](https://minebench.ai/faq#can-i-compare-models-directly)
* [Can models that are not on the official leaderboard be tested?](https://minebench.ai/faq#can-unofficial-models-be-tested)
* [Why isn't a particular model on the leaderboard?](https://minebench.ai/faq#why-is-a-model-missing)
* [Can MineBench builds be exported?](https://minebench.ai/faq#can-i-export-builds)
* [Is MineBench using Minecraft MCP, Blender MCP, or a coding agent?](https://minebench.ai/faq#is-this-minecraft-mcp-blender-mcp-or-a-coding-agent)
* [How can MineBench be supported or contributed to?](https://minebench.ai/faq#how-can-i-support-or-contribute)

## Supported Models

MineBench currently benchmarks models from OpenAI, Anthropic, Google, Moonshot, DeepSeek, MiniMax, xAI, Z.AI, Qwen, Meta, and any model available through OpenRouter.

![MineBench leaderboard showing model rankings](.github/assets/readme/leaderboard-dark.png)

## Quick Start (Local)

This path lets you run the full app and compare existing builds from `uploads/` without generating new ones.

Prereqs: Node.js `18+`, `pnpm`, Docker.

```bash
pnpm install
cp .env.example .env
pnpm dev:setup
```

In a second terminal:

```bash
pnpm prompt --import
```

Then open:

* `http://localhost:3000/` (Arena)
* `http://localhost:3000/sandbox`
* `http://localhost:3000/leaderboard`

For environment variables, live generation, seeding/import workflows, batch generation, API routes, troubleshooting, and deployment, see the docs:

* [`docs/local-development.md`](docs/local-development.md)
* [`docs/operations.md`](docs/operations.md)
* [`docs/deployment.md`](docs/deployment.md)

## Sponsors

A huge thank you to the sponsors helping make MineBench possible:

* **[3D-Agent](https://3d-agent.com)**
  * AI-powered tools for Blender and 3D workflows
  * **10% off with code `MINEBENCH10`**
* **OpenAI**
* **Anthropic**
* **Google DeepMind**
* **Z.ai**
* **Moonshot AI**

Their support, including API credits, helps fund MineBench evaluations. If you would like to support MineBench yourself, you can **[support us here](https://buymeacoffee.com/ammaaralam)**.

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](.github/CONTRIBUTING.md) for how to add new models, submit benchmark prompts, improve the UI, or fix bugs.

## Licenses

[MIT](LICENSE)

Texture pack: [Faithful](https://faithfulpack.net/) (see `assets/texture-pack/LICENSE.txt`)

Inspired by [MC-Bench](https://github.com/mc-bench) and [VoxelBench](https://voxelbench.ai/)
