# 自定义第三方提供商适配 (Locked-Envelope Gateway)

本文档记录 MineBench 接入**固定请求契约**第三方网关的适配实现。

参考目标端点:

```
https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions
```

---

## 1. 为什么需要专门适配

仓库原有的 `custom` 通道 (`lib/ai/providers/openaiCompatible.ts`) 假设对端是标准
OpenAI 兼容服务。对该网关有 **5 处不兼容**,实测确认如下。

### 1.1 URL 路径会被破坏

`customApiGuard.ts` 原逻辑会强行拼接 `/v1`:

```
输入: https://ark.cn-beijing.volces.com/api/plan/v3
原行为: .../api/plan/v3/v1/chat/completions   ← 404
需要:   .../api/plan/v3/chat/completions
```

**解法**:`resolveCustomApiTarget(url, { exactPath: true })` 保留路径原样,
仅在缺失时补 `/chat/completions`。SSRF 防护(私有 IP / localhost / 凭据 /
DNS 解析校验)完全保留。

### 1.2 `response_format` 被「接受但不执行」

> **先说结论,避免误解**:火山方舟**平台是支持结构化输出的**
> (见官方《结构化输出(beta)》文档)。问题出在**端点层级** ——
> `/api/plan/v3` 是 **Agent Plan 网关**,不是文档所描述的标准推理端点。

#### 对照实验

同一个 key,变量逐一分离:

| 编号 | 端点 | 模型 | 参数 | 结果 |
|---|---|---|---|---|
| A1 | `/api/plan/v3` | `ark-code-latest` | `json_schema` strict | 200,**返回散文** |
| A2 | `/api/plan/v3` | `ark-code-latest` | `json_object` | 200,**返回散文** |
| A3 | `/api/plan/v3` | `doubao-seed-1-6-251015` | `json_schema` | `UnsupportedModel: does not support the **agent plan** feature` |
| B1–B4 | `/api/v3`(标准) | 任意 | 任意 | **401 AuthenticationError** |
| C1 | `/api/plan/v3` | `ark-code-latest` | **非法** schema 关键字 | 200,静默接受(文档说应报错) |
| G | `/api/plan/v3` | `ark-code-latest` | `response_format: "字符串"` | **400 `expected an object`** |
| J | `/api/plan/v3` | `ark-code-latest` | `guided_json` / `response_schema` / `structured_output` … | 全部静默接受 |

#### 关键推论

**G 与 A1 的对比是决定性的**:

- 传字符串 → 报错 `expected an object` ⇒ 网关**确实解析了**这个字段
- 传合法 schema 对象 → 接受后**不执行** ⇒ 典型的**空实现**(accepted but ignored)

再加上 C1(文档承诺「不支持的关键字会显式报错」,实际没有)和 J
(任何编造的参数名都被照单全收),可以确认该网关对结构化输出相关字段
只做形状校验、不做语义实现。

D 组进一步显示 plan 端点**只接受 `ark-code-latest`**,其余模型一律
`UnsupportedModel`;而 B 组显示 plan 作用域的 key 在标准 `/api/v3` 上直接 401 —— 
所以用这个 key **无法触达**文档所述的结构化输出能力。

#### 定量对比

同一提示、各跑 3 次:

| 方式 | 可解析为 JSON | 输出示例 |
|---|---|---|
| `json_schema` strict | **0 / 3** | `Here's a point: **P = (3, 4)**...`(连数值都答错) |
| 仅提示词约束 | **3 / 3** | `{"x": 3, "y": 5}` |
| 工具调用 JSON(容错提取) | **3 / 3** | 成功提取 `voxel.exec` |

#### 解法:开关化,而非写死

- **默认关闭** `response_format`,依靠提示词约束 + `extractFirstJsonObject`
  容错提取(平衡括号扫描,自动跳过围栏与前后散文)。
- 提供 `customGatewayStructuredOutput` 开关(前端复选框 / API 字段)。
  若你的 key 指向**标准 `/api/v3`** 或其他真正实现了 json_schema 的网关,
  打开即可使用真结构化输出 —— 无需改代码。
- 打开时 `max_tokens=131072` 与 `thinking:{type:"enabled"}` 的锁定**依然生效**
  (已有回归测试覆盖)。

> 若你确定用的是标准 `/api/v3` 端点并持有对应 key,
> 更推荐直接走仓库原有的 `openaiCompatible.ts` 通道 ——
> 它本来就会发送 `response_format`,并带有 400 降级逻辑。

### 1.3 `reasoning_content` 会污染 JSON

流式响应中思维链是 `content` 的**同级字段**:

```json
{"choices":[{"delta":{"content":"","reasoning_content":"I'm checking that 17 times 3...","role":"assistant"}}]}
```

原 SSE 解析只读 `delta.content`。若照搬会把思维链混入构建 JSON,解析必然失败。

**解法**:双通道分流。`reasoning_content` → `onReasoningDelta`(独立展示),
`content` → `onDelta`(参与解析)。

### 1.4 `max_tokens` 必须锁定

原代码有个**递降重试阶梯**(`tokenBudgetCandidates`):131072 → 128000 → 100000 → ...
每次 400 就降一档重试。

该网关接受 131072,阶梯纯属浪费额度;且降档会削弱大型构建能力。

**解法**:锁定 `max_tokens: 131072`,单次请求,无阶梯。

### 1.5 `model` 回显为 `auto`

响应中 `"model":"auto"`,不等于请求的 `ark-code-latest`。任何据此做校验的逻辑都会误判。

**解法**:不使用响应的 `model` 字段做校验。

---

## 2. 锁定的请求契约

`lib/ai/providers/customGateway.ts` 中 `buildCustomRequestBody()` 产出:

```jsonc
{
  "model": "ark-code-latest",
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user",   "content": "..." }
  ],
  "stream": true,
  "max_tokens": 131072,              // 锁定,不降档
  "thinking": { "type": "enabled" }, // 锁定,必须存在且开启
  "stream_options": { "include_usage": true },
  "reasoning_effort": "medium"       // 可选:low|medium|high|xhigh|max,或整体省略
}
```

请求头:

```
Authorization:      Bearer <CUSTOM_API_KEY>
Content-Type:       application/json
Accept:             text/event-stream    (流式) / application/json (非流式)
X-Conversation-Id:  <UUID>               (未配置则每请求自动生成)
User-Agent:         Kelivo               (可配置)
```

### reasoning_effort 取值

| 值 | 行为 |
|---|---|
| `low` / `medium` / `high` / `xhigh` / `max` | 原样透传 |
| `none` / 留空 | **完全不发送该参数**(契约允许) |
| 其他 | 抛错,不静默降级 |

`thinking: {type:"enabled"}` **始终发送**,与 `reasoning_effort` 无关。

---

## 3. 改动文件清单

| 文件 | 改动 |
|---|---|
| `lib/ai/providers/customGateway.ts` | **新增**。适配器主体:锁定信封、双通道 SSE、usage 采集 |
| `lib/ai/providers/customApiGuard.ts` | 新增 `exactPath` 选项,保留路径原样 |
| `lib/ai/generateVoxelBuild.ts` | `custom` 分支按 `customGatewayMode` 路由到新适配器;新增 reasoning/usage 回调 |
| `lib/ai/types.ts` | 请求类型加网关字段;`GenerateEvent` 加 `reasoning`/`usage`/`trace` |
| `app/api/generate/route.ts` | zod 校验新字段;`exactPath` 守卫;转发新事件 |
| `components/sandbox/SandboxLive.tsx` | 网关配置 UI、预设按钮、思维链/用量展示、localStorage 持久化 |
| `scripts/probe-custom-gateway.mjs` | **新增**。独立端到端验证脚本 |

**保留不变**的完整流程:提示词构建 → 流式接收 → JSON 提取 →
`voxel.exec` 沙箱执行 → `validateVoxelBuild` 校验 → 三维渲染 → 导出
(GLB / STL / NBT / schematic)。

---

## 4. 数据流

```
SandboxLive.tsx  (勾选 gateway mode + reasoning_effort)
      │  POST /api/generate  { models:[{ provider:"custom", customGatewayMode:true, ... }] }
      ▼
app/api/generate/route.ts
      │  zod 校验 → assertSafeCustomApiUrl(url, {exactPath:true})  ← SSRF 防护
      ▼
generateVoxelBuild()
      │  buildSystemPrompt() + buildUserPrompt()
      ▼
callDirectProvider()  provider="custom" && customGatewayMode
      ▼
customGatewayGenerateText()          ← lib/ai/providers/customGateway.ts
      │  锁定信封 POST,SSE 双通道分流
      ├──> reasoning_content ──> onReasoningDelta ──> UI 思维链面板
      └──> content           ──> onDelta         ──> 累积文本
      ▼
extractFirstJsonObject()             ← 容错提取(跳过围栏/散文)
      ▼
voxelExecToolCallSchema.safeParse()   ← 校验工具调用结构
      ▼
runVoxelExec()                        ← node:vm 沙箱执行 JS,产出体素
      ▼
validateVoxelBuildSpec()              ← 边界/调色板/数量校验 + 去重
      ▼
VoxelViewer (three.js)  +  导出 GLB/STL/NBT/schematic
```

---

## 5. 实测结果

```
POST https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions
model=ark-code-latest max_tokens=131072 thinking=enabled reasoning_effort=medium
HTTP 200

reasoning_content chars: 199        ← 正确分流,未污染 JSON
content chars:           3495
usage: {"completion_tokens":2843,"prompt_tokens":414,"total_tokens":3257,
        "completion_tokens_details":{"reasoning_tokens":747}}

=== TOOL CALL EXTRACTED ===
gridSize=64 palette=simple seed=123
code length: 3311 chars

=== VOXEL EXEC RESULT ===
raw placements:  2084
unique blocks:   1836
boxes: 49  lines: 0
distinct types:  9 -> grass_block, stone, cobblestone, stone_bricks,
                      oak_planks, glass, oak_log, glowstone, oak_leaves
bounds: x[20..44] y[0..31] z[20..44]

PASS: full pipeline verified.
```

---

## 6. 安全说明

- API key 只存放于 `.env.local`(已被 `.gitignore` 忽略)或浏览器 localStorage
  的既有 provider-keys 存储;**网关配置的持久化不含密钥**。
- SSRF 防护在 `exactPath` 模式下**完整保留**:仍然拒绝 localhost、`.local`、
  私有/保留 IP 段、嵌入式凭据,并对 DNS 解析结果逐条校验。
- 生产环境强制 https(`NODE_ENV=production` 时 http 被拒)。

---

## 7. 本地运行

### 7.1 环境要求

- Node.js 20+(仓库用 Next 15 / React 19)
- pnpm 10.26.1(`corepack enable pnpm`)
- Docker(仅当需要 Postgres;**纯生成测试不需要**)

### 7.2 安装

```bash
git clone https://github.com/Ammaar-Alam/minebench.git
cd minebench
corepack enable pnpm
pnpm install
```

### 7.3 配置

创建 `.env.local`(已在 `.gitignore` 中):

```bash
CUSTOM_API_BASE_URL=https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions
CUSTOM_API_KEY=<你的 key>
CUSTOM_API_MODEL_ID=ark-code-latest
CUSTOM_API_DISPLAY_NAME=Ark Code (plan/v3)
CUSTOM_API_REASONING_EFFORT=medium
CUSTOM_API_USER_AGENT=Kelivo

# 允许服务端读取 .env 中的 key(否则必须在前端填写)
MINEBENCH_ALLOW_SERVER_KEYS=1
AI_DEBUG=1

# 仅在本机 DNS 把该域名解析到保留网段时才需要(代理/VPN/split-horizon)
# CUSTOM_API_TRUSTED_HOSTS=ark.cn-beijing.volces.com
```

### 7.4 生成纹理图集并启动

```bash
pnpm atlas          # 生成方块纹理图集(首次必须)
pnpm dev            # http://localhost:3000
```

Sandbox 页面依赖数据库的部分(保存构建 / 画廊 / 排行榜)在无 Postgres 时会降级,
但**「输入提示词 → 生成 → 渲染 → 导出」主流程可直接使用**。

需要完整功能时:

```bash
pnpm db:up && pnpm db:wait && pnpm prisma:migrate
pnpm dev
```

---

## 8. 用你的 API 测试生成

### 8.1 网页操作(推荐)

1. 打开 <http://localhost:3000/sandbox>
2. 模型下拉框选 **Custom → OpenAI-compatible model**
3. 勾选 **Locked-envelope gateway mode**
4. 点 **Apply Ark plan/v3 preset**(自动填好 URL / model id / UA)
5. 选 `reasoning_effort`(默认 medium;选 *Omit parameter* 则不发送该参数)
6. 如果没设 `MINEBENCH_ALLOW_SERVER_KEYS=1`,展开 API keys 区域填入 Custom API key
7. 输入提示词,例如 `a compact stone lighthouse on a rocky island`
8. 选网格大小(64 最快,512 最精细),点 **Generate**

生成过程中可以看到:

- 实时流式方块预览
- **Chain of thought** 折叠面板(`reasoning_content` 独立展示)
- **token 用量**(prompt / completion / reasoning / cached / total)
- **Provider trace**(实际被接受的请求参数)

完成后可导出 JSON / GLB / STL / NBT / schematic,或导出对比 GIF。

### 8.2 命令行验证(不需要数据库和前端)

**a. 纯 API 契约探测** —— 最快确认 key 和端点可用:

```bash
node scripts/probe-custom-gateway.mjs "a small stone watchtower"
```

输出流式进度(`.` = 思维链,`+` = 正文),然后提取工具调用、执行体素代码、
打印方块数与包围盒,产物写入 `.probe-out/`。

**b. 锁定契约单元测试**(25 项,不发网络请求):

```bash
sh tests/custom-gateway/build.sh
node tests/custom-gateway/envelope.cjs
```

验证 `max_tokens` 钳制、`thinking` 恒开、`response_format` 不发送、
`reasoning_effort` 的透传与省略语义、消息顺序等。

**c. SSRF 安全回归测试**(18 项):

```bash
node tests/custom-gateway/security.cjs
```

验证 localhost / 私有网段 / link-local / 嵌入凭据 / IPv4-mapped IPv6 仍被拒绝,
白名单不会放宽到未授权主机,且路径保留与旧行为都正确。

**d. 真实端到端集成测试** —— 驱动真正的 `generateVoxelBuild()`:

```bash
node tests/custom-gateway/integration.cjs "a compact stone lighthouse"
```

打印 traces、双通道字符数、token 用量、方块数、被接受的配置,
产物写入 `.probe-out/integration-build.json`。

**e. 结构分析与离线渲染**(无需浏览器):

```bash
node scripts/analyze-build.cjs .probe-out/integration-build.json
node scripts/render-build-preview.mjs .probe-out/integration-build.json out.png
```

`analyze-build.cjs` 输出分层方块数、连通分量、邻接率、材质直方图 ——
用于判断构建是否为连贯实体而非散点。
`render-build-preview.mjs` 做等轴测软光栅化并输出 PNG。

### 8.3 实测基线

```
prompt: "a small stone tower"   grid 64   reasoning_effort=low

max_output_tokens   262144 (调用方) -> 131072 (钳制后)
thinking            enabled, effort=low
reasoning tokens    2577
content chars       6026
reasoning chars     1764   (独立通道,未污染 JSON)
blockCount          31932
distinct types      18
largest component   99.8%  (单一连通实体)
generationTimeMs    95244
```

---

## 9. 已知环境注意事项

- **`reasoning_effort` 取值错误会抛异常**,不会静默降级 —— 这是有意设计,
  避免你以为用了 `max` 实际跑的是默认档。
- **`max_tokens` 是硬上限**。即使上游 `generateVoxelBuild` 传入 262144
  (仓库默认),适配器也会钳制到 131072,否则网关返回
  `InvalidParameter: integer above maximum value`。
- **`response_format` 永不发送**。该网关会静默忽略它并返回散文,
  依赖它做结构化输出会导致解析静默失败。
- 网关返回的 `model` 字段恒为 `"auto"`,不要用它做校验。

---

## 10. 导出可分享的 3D 网页

生成结果除了 JSON / GLB / STL / NBT,还可以导出成**单文件 HTML**:
数据 base64 内嵌、渲染器内联,**零外部依赖、零网络请求**。
对方双击就能在浏览器里自由查看,手机同样支持。

### 10.1 网页导出

Sandbox 生成成功后,点结果卡片右下角的 **3D 网页导出**按钮即可下载。

### 10.2 命令行导出

```bash
# 只需执行一次:从真实纹理图集提取方块颜色
node scripts/build-block-colors.mjs

# 导出
node scripts/export-html-viewer.mjs <build.json> <out.html> "标题文字"
```

### 10.3 颜色来源

`scripts/build-block-colors.mjs` 直接从 `public/textures/atlas.png` **采样每个
方块的平均色**,而不是手写调色板,因此与站内渲染一致:

- 顶面 / 侧面分别取色 —— 草方块顶面是绿色、侧面是土色
- 半透明像素按 alpha 加权,不会被边缘拉灰
- 水、树叶、草等在游戏里靠运行时染色的**灰度遮罩纹理**,按 `RUNTIME_TINTS`
  施加标准色调(否则平均出来是灰色)
- 输出 `lib/blocks/block-colors.generated.json`(80 个方块,零缺失)

换材质包后重跑该脚本即可。

### 10.4 两种相机模式

查看器内置两套相机,点左上角按钮或按 <kbd>V</kbd> 切换。
**切换时视角完全连续**,不会跳变。

| | 环绕视角(默认) | 自由视角 |
|---|---|---|
| 拖动 | 绕目标点旋转 | 转动视角(第一人称) |
| 滚轮 | 缩放 | 沿视线前后飞行 |
| Shift+拖动 / 中键 | 平移目标点 | 平移相机 |
| 双指 | 缩放 + 平移 | 缩放 + 平移 |
| 键盘 | — | <kbd>WASD</kbd> 移动、<kbd>Q</kbd>/<kbd>E</kbd> 升降、<kbd>Shift</kbd> 加速 |
| 触屏 | — | 屏幕摇杆(前进/后退/上升/下降) |

要点:

- **环绕模式的目标点可平移**,不再锁死在模型几何中心 —— 放大后也能看到边角。
- **自由模式可飞进建筑内部**:近裁剪面按相机与模型的实际距离动态计算。
- 按任意移动键会**自动切到自由视角**,不必先点按钮。
- <kbd>F</kbd> 重置视图,<kbd>R</kbd> 开关自动旋转。

### 10.5 相机逻辑测试

```bash
node tests/custom-gateway/camera.cjs
```

无头运行(打桩 DOM/WebGL),验证 12 项:模式切换的位置与朝向连续性、
飞行确实位移、上升独立于朝向、环绕目标可平移且平移不改变距离等。

### 10.6 文件体积参考

31932 个方块 / 18 种材质 → **193 KB**(仅绘制 18232 个暴露面,内部面剔除)。

---

## 11. 格式对比

| 格式 | 分享难度 | 对方需要什么 |
|---|---|---|
| **单文件 HTML** | 最简单 | 浏览器,双击即可 |
| GLB | 中 | 3D 软件 / Windows 3D 查看器 |
| STL | 中 | 3D 打印或建模软件 |
| NBT / schematic | 难 | Minecraft + Litematica 等模组 |
| PNG | 简单但静态 | 只能看一个角度 |
