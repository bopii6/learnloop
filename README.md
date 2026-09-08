# LearnLoop —— 学习智能体 MVP

对标 Hyperknow V1 的最小可用版本：输入任务 → Agent 搜索全网 → 结合学习者画像出课程 → 白板课堂边讲边画边语音，随时打断。

## 功能（MVP 范围）

- **Agent 内核**：意图分类 → 检索规划（2-3 个搜索词）→ 并行搜索 → 抓取网页正文 → 流式生成带引用讲解
- **课程生成**：搜索 → 分轮澄清（MCQ）→ 结构蓝图（可编辑）→ 大纲 → 白板教学
- **白板课堂（beat 播放器）**：AI 讲师产出「逐句讲解 + 绑定板书动作」的 beat 脚本，前端播放器同步驱动——语音逐句朗读、白板逐条书写、字幕条同步、对话框同步入稿；可暂停/续播，提问或回答 checkpoint 后自动断点续播
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
| `LLM_MODEL` | 是 | 默认 `deepseek-chat` |
| `TAVILY_API_KEY` | 否 | 填了搜索质量更好（国内需代理）；不填走博查/必应 |
| `BOCHA_API_KEY` | 否 | 国内搜索 API，有免费额度：https://open.bochaai.com |
| `DASHSCOPE_API_KEY` | 否 | 白板语音播报（qwen3-tts）与语音识别（qwen3-asr，Chrome 兜底不可用时）共用，走阿里云百炼（0.8 元/万字符，送 1 万字符）：https://bailian.console.aliyun.com/?tab=model#/api-key ；不填播报用浏览器系统音色、识别用浏览器原生 |

LLM 可换任何 OpenAI 兼容端点（GLM / 通义 / 中转站），改三个变量即可。
语音播报选型调研与细节见 [docs/白板语音播报TTS选型与接入.md](docs/白板语音播报TTS选型与接入.md)。

## 技术栈

Next.js 15 (App Router) + TypeScript + Tailwind + Vercel AI SDK + JSON 文件存储

## 架构（对应 Hyperknow 四层模型的 L1）

```
用户提问
  → POST /api/chat (SSE)
    → classify  意图分类（chat / search / clarify）
    → plan      生成 2-3 个搜索词
    → search    并行搜索（Tavily/博查/Bing）
    → read      抓取 top 4 网页正文
    → write     流式生成带 [n] 引用的讲解
  → 消息落盘 data/conversations/{id}.json
```

课程链路（个性化贯穿）：

```
POST /api/course (SSE)
  → search → clarify ×4（注入画像，不重复提问）→ blueprint（可编辑）→ outline
  → captureCourseProfile：澄清问答沉淀进 data/profile.json，LLM 蒸馏画像摘要

POST /api/teach (SSE)
  → 导演规划 8-12 个教学片段 → 每片段产出 beat 脚本：{say, section, items}[]
  → 前端播放器逐 beat 播放：字幕 + 对话 + 白板书写 + speechSynthesis 逐句朗读
  → 打断：提问注入「当前片段 + 已写板书 + 画像」，答完自动续播
```

事件协议（SSE JSON）：课程 `stage / clarify_round / sources / blueprint / outline / done / error`；教学 `stage / beats / token / done / error`。
前端只认事件，后续加工具（文件阅读、资产生成）不用改前端框架。

## 已知取舍（MVP）

- 无登录（本地自用）；历史存本地 JSON 文件
- 搜索为确定性 pipeline，不是通用 ReAct 循环（下一版升级）
- 客户端中断后服务端会继续跑完并保存完整回答，重载会话可能出现部分+完整两条（小概率，暂容忍）
- 引用角标在流式过程中不渲染（生成完才可点击）
- 语音用浏览器 speechSynthesis（逐句朗读保证同步）；换云端 TTS 时只需替换播放器的 speak 实现，beat 协议不变

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

生效后：课程、教材、会话、画像、用户、集市数据全部写入你的桶。本地仍保留三样（刻意不上云）：`data/ocr-cache`（tesseract 语言包，需要文件路径）、`data/.auth-secret`（本机会话签名密钥）、`data/classrooms`（课堂断线恢复快照，非珍贵数据）。

### 第二步：应用本体上 Workers（待做）

- `@opennextjs/cloudflare` 适配 Next.js；课堂 WebSocket（server.mjs）重写为 Durable Object
- OCR 移到浏览器端：tesseract.js 是 WASM 可直接在浏览器跑（服务端原生 canvas 上不了 Workers）；渲染 + OCR 在用户浏览器完成，服务器只收文本，还省服务器算力
- 届时需要：Cloudflare API Token（Workers / D1 部署权限）
