# 快速开始

自定义第三方网关适配版 MineBench。完整技术说明见 `docs/CUSTOM_PROVIDER.md`。

## 1. 环境

- Node.js 20+
- pnpm(`corepack enable pnpm`)
- Docker(可选,仅完整站点功能需要 Postgres;跑分和生成不需要)

## 2. 安装

```bash
pnpm install
pnpm atlas          # 生成方块纹理图集(首次必须)
```

## 3. 配置

创建 `.env.local`(已在 .gitignore 中,不会误提交):

```bash
CUSTOM_API_BASE_URL=https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions
CUSTOM_API_KEY=<你的 key>
CUSTOM_API_MODEL_ID=ark-code-latest
CUSTOM_API_DISPLAY_NAME=Ark Code (plan/v3)
CUSTOM_API_REASONING_EFFORT=max
CUSTOM_API_USER_AGENT=Kelivo

MINEBENCH_ALLOW_SERVER_KEYS=1
AI_DEBUG=1

# 仅当本机 DNS 把该域名解析到保留网段时才需要(代理/VPN 环境)
# CUSTOM_API_TRUSTED_HOSTS=ark.cn-beijing.volces.com
```

## 4. 跑官方 15 题 bench

```bash
sh tests/custom-gateway/build.sh     # 编译 AI 层到 .btest/(首次必须)

node scripts/bench-custom.mjs \
  --grid 512 --palette advanced --reasoning max \
  --attempts 3 --concurrency 15 \
  --name run512 --html --gif
```

产出在 `.bench-out/run512/`:

- `<题目>.json` — 体素数据
- `<题目>.html` — 单文件可分享 3D 网页(双击即开,零依赖)
- `<题目>.gif` — 旋转动图
- `report.md` — 汇总表(方块数/材质数/连通性/token 消耗)

### 常用参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `--grid` | 64 | 64 / 256 / 512 |
| `--palette` | simple | simple(25 种)/ advanced(80 种) |
| `--reasoning` | 环境变量 | low / medium / high / xhigh / max / none |
| `--attempts` | 2 | 单题失败重试次数 |
| `--concurrency` | 1 | 1~15,并发跑多题 |
| `--prompt` | 全部 | 指定题目 slug,可多个 |
| `--resume` | 关 | 跳过已成功的题(中断后续跑) |
| `--html` / `--gif` | 关 | 导出 3D 网页 / GIF |
| `--name` | grid\<N\> | 输出子目录名 |

15 道题目 slug:
`arcade` `astronaut` `steampunk` `carrier` `locomotive` `skyscraper`
`treehouse` `cottage` `worldtree` `fighter-jet` `floating` `shipwreck`
`phoenix` `knight` `castle`

## 5. 网页版

```bash
pnpm dev            # → http://localhost:3000/sandbox
```

在模型下拉框选 **Custom → OpenAI-compatible model**,勾选
**Locked-envelope gateway mode**,点 **Apply Ark plan/v3 preset** 自动填好配置。

生成完可在结果卡片导出 JSON / 3D 网页 / GIF / GLB / STL / NBT。

> 保存构建、画廊、排行榜需要 Postgres:
> `pnpm db:up && pnpm db:wait && pnpm prisma:migrate`
> 纯生成和跑分不需要。

## 6. 验证与测试

```bash
# 确认 key 和端点可用(最快)
node scripts/probe-custom-gateway.mjs "a stone watchtower"

# 探测该端点是否真支持结构化输出
sh scripts/probe-structured-output.sh

# 测试套件(不发网络请求)
sh tests/custom-gateway/build.sh
node tests/custom-gateway/envelope.cjs    # 锁定契约 33 项
node tests/custom-gateway/security.cjs    # SSRF 防护 17 项
node tests/custom-gateway/camera.cjs      # 查看器相机 21 项

# 真实端到端
node tests/custom-gateway/integration.cjs "a compact stone lighthouse"
```

## 7. 单独导出可视化

```bash
node scripts/export-html-viewer.mjs <build.json> <out.html> "标题"
node scripts/export-gif.mjs        <build.json> <out.gif> [帧数] [尺寸]
node scripts/render-build-preview.mjs <build.json> <out.png>

node scripts/analyze-build.cjs <build.json>   # 连通性/分层统计
node scripts/slice-build.cjs   <build.json>   # ASCII 剖面(排查结构)
```

## 8. 已知注意事项

- **`max_tokens` 锁定 131072**,适配器会把更大的调用方值钳制下来,否则网关报错。
- **`reasoning_effort` 取值错误会抛异常**,不静默降级 —— 避免你以为用了 max 实际跑默认档。
- **`response_format` 默认不发送**。该网关(`/api/plan/v3`,Agent Plan)会校验字段
  形状却不执行,实测 0/3 次返回可解析 JSON;仅靠提示词约束则 3/3 成功。
  若你的 key 指向标准 `/api/v3`,可在前端勾选开关启用真结构化输出。
- **grid 512 的实际产出受 token 上限约束**:理论上限 1.34 亿方块,但
  131072 tokens 大约只能表达 1 万个方块条目。由于生成的是 JS 代码而非坐标列表,
  实际方块数可远超此值,但收益相比 grid 256 有限。
- 材质包在 `assets/texture-pack/`。换包后重跑
  `pnpm atlas && node scripts/build-block-colors.mjs`。
