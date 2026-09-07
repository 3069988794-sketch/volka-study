# Volka Study

把一本 364 页的英语教材，变成一个能让人每天打开、练到能开口的学习应用。

**目标**：中文母语者，从零到 **CEFR B2**——能就熟悉和不熟悉的话题流畅交谈。这是技术移民、大学入学和职场沟通的实际门槛。

## 它解决什么问题

教材只是「识别材料」，不是「训练方案」。认识 3000 个词 ≠ 能在 0.5 秒内想起、说对、让别人听懂。这个应用把教材强制转化为**产出训练**：

- 7223 个义项，每条带一个平均 8 词的自然例句，100% 覆盖
- FSRS 间隔复习 + 8 种题型轮换，从「听音辨义」一路练到「中→英无提示口述」
- 录音 + A/B 对比跟读，发音差异自己暴露出来
- 241 个学习日 × 60 分钟，按「落地生存 → 日常自理 → 工作胜任 → 自然交流」四阶段重排学习顺序

## 技术栈

| 层 | 选择 |
|---|---|
| 框架 | Next.js 16 (App Router) + TypeScript |
| 数据库 | `node:sqlite`（Node 内置，零原生依赖） |
| 样式 | Tailwind CSS v4 |
| 动效 | Motion (framer-motion) |
| 状态 | Zustand |
| 复习算法 | ts-fsrs |
| 图表 | Recharts |
| 数据管线 | Python（PDF 抽取 / 富化 / TTS / 词级标注，离线跑一次） |

## 目录速览

```
app/          页面与 API Route Handlers
components/   会话引擎、可点词例句、音频组件
lib/          db / srs / planner / storage / audio
pipeline/     Python 离线管线（抽取→富化→翻译→TTS→校验）
data/         senses.json、id_registry.json、word_senses.json
legacy/       旧版单文件 demo 存档
```

## 启动

```bash
npm install
npm run dev     # 开发，http://localhost:3000
npm run build && npm start   # 生产
```

数据管线（需 Python + `3000 Textbook.pdf`，产物已提交，通常无需重跑）：

```bash
python pipeline/1_extract.py && python pipeline/2_enrich.py && python pipeline/5_validate.py
```

## 数据说明

- `data/id_registry.json` 是永久 ID 注册表，**不可再生成**，改文本不影响 ID——这是进度数据的地基
- `data/audio/`（约 10197 个 mp3）由 `pipeline/4_tts.py` 按例句哈希生成，不入库，可随时重跑
- 学习记录在 `data/progress.db`（gitignore），每日自动备份到 `data/backups/`

## 隐私

本仓库为**私有**。`data/senses.json` 等文件含《Volka English 3000》教材的完整提取内容，仅作个人学习备份，请勿公开或分发。
