# LearnLoop —— 学习智能体 MVP

对标 Hyperknow V1 的最小可用版本：输入任务 → Agent 搜索全网 → 结合学习者画像出课程 → 白板课堂边讲边画边语音，随时打断。

## 功能（MVP 范围）

- **Agent 内核**：意图分类 → 检索规划（2-3 个搜索词）→ 并行搜索 → 抓取网页正文 → 流式生成带引用讲解
- **课程生成**：搜索 → 分轮澄清（MCQ）→ 结构蓝图（可编辑）→ 大纲 → 白板教学
- **白板课堂（卡片流）**：AI 讲师产出「板书卡片 + 口播」动作序列，播放器逐组执行——打字机落字、圈画重点、卡拉OK 字幕、云端语音；课中小测停下等作答，讲师点评后发徽章；随时暂停 / 调语速 / 重听 / 「没听懂」（讲师换角度重讲）；本机记住进度可断点续播；一键生成只读回放链接
- **学习者画像**：跨课程持久化（data/profile.json），澄清问答自动沉淀 + LLM 蒸馏摘要，注入后续课程生成与教学
- **引用系统**：正文 [1][2] 角标，点击高亮来源卡片
- **历史记录**：本地 JSON 文件持久化（data/conversations/），左侧栏管理
- **停止生成**：随时中断

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 配置：复制 .env.example 为 .env，填入 LLM_API_KEY
cp .env.example .env

# 3. 启动
npm run dev
# 打开 http://localhost:3000
```

## 配置说明（.env）

| 变量 | 必填 | 说明 |
|---|---|---|
| `LLM_BASE_URL` | 是 | 默认 `https://api.deepseek.com`（国内直连） |
| `LLM_API_KEY` | 是 | 去 https://platform.deepseek.com 注册，充 10 元够用很久 |
| `LLM_MODEL` | 否 | 默认 `deepseek-flash`；可按任务覆盖：`LLM_MODEL_<TASK>` / `LLM_THINKING_<TASK>`（任务：fast / chat / design / script / judge，见 `lib/agent/llm.ts`） |
| `DEEPSEEK_API_KEY` | 视情况 | 搜索、网页正文、扫描版教材 OCR 全走 DeepSeek Search / Fetch / OCR。LLM 走 DeepSeek 时不用填（复用 `LLM_API_KEY`）；LLM 换别家时必填 |
| `DASHSCOPE_API_KEY` | 否 | 白板语音播报（qwen3-tts）与语音识别（qwen3-asr，Chrome 兜底不可用时）共用，走阿里云百炼（0.8 元/万字符，送 1 万字符）：https://bailian.console.aliyun.com/?tab=model#/api-key ；不填播报用浏览器系统音色、识别用浏览器原生 |

LLM 可换任何 OpenAI 兼容端点（GLM / 通义 / 中转站），改三个变量即可。
语音播报选型调研与细节见 [docs/白板语音播报TTS选型与接入.md](docs/白板语音播报TTS选型与接入.md)。

## 开发与发布

```bash
npm run typecheck   # 类型检查
npm test            # 单元测试（tests/*.test.ts，Node 内置 test runner，无需额外依赖）
npm run build       # 生产构建
node scripts/smoke.mjs [baseUrl]   # 冒烟：主要页面与只读接口过一遍，不调大模型；部署后对线上域名跑一次
npm run eval -- --only=ml-systematic,cooking-zero,r-for-elderly   # 课程质量评测（改提示词前后各跑一次）
```

push 到 `main` 会触发 GitHub Actions：先跑 **类型检查 → 单元测试 → 生产构建**，全部通过才部署到 Cloudflare Workers；PR 只跑检查不部署。

## 技术栈

Next.js 15 (App Router) + TypeScript + Tailwind + Vercel AI SDK + JSON 文件存储

## 架构（对应 Hyperknow 四层模型的 L1）

```
用户提问
  → POST /api/chat (SSE)
    → classify  意图分类（chat / search / clarify）
    → plan      生成 2-3 个搜索词
    → search    并行搜索（DeepSeek Search）
    → read      抓取 top 4 网页正文
    → write     流式生成带 [n] 引用的讲解
  → 消息落盘 data/conversations/{id}.json
```

课程链路（个性化贯穿）：

```
POST /api/course (SSE)
  → search → clarify ×4（注入画像，不重复提问）→ blueprint（可编辑）→ outline
  → captureCourseProfile：澄清问答沉淀进 data/profile.json，LLM 蒸馏画像摘要

POST /api/board (SSE)
  → start：生成本节板书脚本（卡片 + 口播 + 圈画 + 小测 + 徽章）→ 媒体导演决定配图/互动动画
           → 按 group 帧下发；讲稿按 用户×课节 缓存（复习 / 回放直接读缓存，不再生成）
  → answer：有小测 = 点评；无小测 = 课堂追问 /「没听懂」，回应插队到当前这拍之后播放
POST /api/replay → 把讲稿快照存成只读回放链接（/replay/:id）
  → 打断：提问注入「当前片段 + 已写板书 + 画像」，答完自动续播
```

事件协议（SSE JSON）：课程 `stage / clarify_round / sources / blueprint / outline / done / error`；课堂 `session_ready / group / generated_image / generated_animation / media_failed / auth_required / response_complete / error`。
前端只认事件，后续加工具（文件阅读、资产生成）不用改前端框架。

## 已知取舍（MVP）

- 无登录（本地自用）；历史存本地 JSON 文件
- 搜索为确定性 pipeline，不是通用 ReAct 循环（下一版升级）
- 客户端中断后服务端会继续跑完并保存完整回答，重载会话可能出现部分+完整两条（小概率，暂容忍）
- 引用角标在流式过程中不渲染（生成完才可点击）
- 断点续播进度存在本机浏览器（换设备从头开始）；"上过哪些课节"以服务端讲稿缓存为准，跨设备一致

## 下一步（按复刻报告的 Phase 继续）

- Phase 3 文件引擎：PDF 上传 + 页级索引 + 页码引用
- Phase 4 学习资产：quiz / flashcard / cheatsheet（Schema-First）
- Phase 5 记忆系统进阶：画像手动编辑 + 掌握度追踪（quiz 结果回写画像）

## Cloudflare 存储与部署路线

存储层已抽象（`lib/storage.ts`）：本地 `data/` 与 Cloudflare R2 双驱动，业务代码零改动切换。

### 第一步：数据上桶（代码已就绪，填配置即生效）

1. Cloudflare 控制台 → R2 → 创建桶（如 `learnloop`）
2. R2 → 管理 R2 API 令牌 → 创建令牌（对象读和写），拿到 Access Key ID / Secret Access Key
3. 账户 ID 在控制台首页右侧
4. `.env` 填入 `CF_ACCOUNT_ID` / `CF_R2_BUCKET` / `CF_R2_ACCESS_KEY_ID` / `CF_R2_SECRET_ACCESS_KEY`，重启
5. 访问 `/api/storage-check` 确认 `"mode":"r2"` 且往返成功

生效后：课程、教材、会话、画像、用户、集市数据全部写入你的桶。本地仍保留两样（刻意不上云）：`data/.auth-secret`（本机会话签名密钥）、`data/classrooms`（课堂断线恢复快照，非珍贵数据）。

### 第二步：应用本体上 Workers（待做）

- `@opennextjs/cloudflare` 适配 Next.js（课堂已不依赖 WebSocket 自定义服务，纯 HTTP/SSE，可直接上 Workers）
- OCR 已改走 DeepSeek OCR 云端接口，服务端不再做位图渲染，Workers 上直接可用
- 届时需要：Cloudflare API Token（Workers / D1 部署权限）

### 部署操作注意（本机实测踩坑，已多次复发）

- **dev server 与 deploy 共写 `.next` 会构建失败**：`next build` 报 `Cannot find module for page: ...` 或 `Failed to collect page data for ...`，是缓存冲突不是代码问题。正确顺序：先停 dev（`netstat -ano | findstr :3000` 找 PID，PowerShell `Stop-Process -Id <pid> -Force`）→ `rm -rf .next` → `npm run deploy` → 重启 `npm run dev`。
- **管道会吃掉真实退出码**：`npm run deploy 2>&1 | tail` 这类写法失败也显示成功（退出码取的是 tail 的）。判断部署结果要看日志里的 `Deployed learnloop triggers` 和 `Current Version ID`。
- **Worker 版本上传偶发 Cloudflare API 瞬时错误**（如 `Completion token has already been consumed [code: 100312]`）：静态资源已去重上传，直接重跑 `npx opennextjs-cloudflare deploy`（跳过重新构建）补传 Worker 即可，实测重试一次就过。
