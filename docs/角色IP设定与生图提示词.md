# 白板 IP 角色设定与生图提示词（小太阳 / 简笔小人）

> 2026-09-11 立项。白板内的原语版已上线（课堂顶栏「角色」可切换：☀ 小太阳 / ✏ 简笔小人 / 先不要）。
> 本文档服务于角色定名、性格，以及用 yang0/handraw-style 风格库生成「UI 层形象」（头像/海报章/预告卡立绘）。

## 一、角色定位

- **不是贴在 UI 上的吉祥物，是白板世界的原住民**：讲师每页用同一支笔把它画出来，它活在板书的故事里（翻车现场它在场、重点出现它发光）。
- 白板内一律用 Excalidraw 原语版（同笔触、零图片成本、可逐笔出现）；图片版只用于 UI 与传播物料。

## 二、候选 A：小太阳（白板内默认）

- **名字候选**：晒晒（推荐，暖阳主题+「晒」出知识的双关）/ 阳阳 / 暖暖
- **性格**：精力过剩的早八人，永远先到教室；爱抢答、爱显摆，翻车时第一个"哎呀"。
- **口头禅**：正常「稳了，照亮它。」；翻车「哎呀，烫到了。」；答对「看！我说了吧。」
- **画法（已上线）**：圆身 + 八根光芒线（颜色随当前模块强调色轮换）+ 豆豆眼 + 三点微笑弧，漂浮在页眉右端。
- **表情扩展方向**：强调=光芒变长弹开；翻车=光芒耷拉+嘴弧翻转；庆祝=转圈（光芒角度整体旋转）。

## 三、候选 B：简笔小人

- **名字候选**：阿线（线条画的线）/ 小白（白板的小白）/ 炭炭
- **性格**：安静但戏多，用肢体语言演剧情；站在页眉线上像站岗，逐页换一只手挥。
- **口头禅**：正常「这条划重点。」；翻车「扶我一下。」；结课「下课！冲食堂！」
- **画法（已上线）**：圆头 + 豆豆眼微笑 + 身体线 + 挥手/插腰双臂 + 站页眉线上，挥手方向逐页交替。

## 四、handraw-style 生图用法（yang0/handraw-style）

用法：画廊选编号 → 输入「**NNN号风格，主题：XXX**」→ Skill 返回双语提示词 → 投给生图 AI。
编号规则：三位纯数字 001-261；A 区 001-035 幽默手绘、B 区 036-054 绘本叙事、C 区 055-082 现代平面人物体系。

- **小太阳**：优先在 **B 区 036-054**（绘本/可爱叙事）里挑编号，候选输入示例：
  - 「BBB号风格，主题：一个豆豆眼小太阳吉祥物三视图（正面/侧面/背面），暖橙色 (#e8590c) 简笔手绘，奶油色背景 (#f8efdd)，极简圆润，粗线描边，微粗糙手绘质感，表情：微笑」
- **简笔小人**：优先在 **A 区 001-035**（幽默手绘/火柴人系）里挑编号，候选输入示例：
  - 「AAA号风格，主题：一个简笔火柴人角色设定表（character sheet），白底墨棕 (#43301f) 线条，圆头豆豆眼，五视图+六种表情（正常/惊讶/翻车晕/庆祝/写字/递粉笔），暖手绘质感」

### 不依赖 Skill 的自包含提示词（英文投 gpt-image-2 等直接可用）

**小太阳 character sheet：**
> A character design sheet of a cute minimalist sun mascot, hand-drawn doodle style with wobbly ink outlines, warm terracotta orange (#e8590c) on cream paper background (#f8efdd). Three views (front / side / back) plus six expressions (smiling, excited with rays popping, shocked with drooping rays, dizzy, celebrating, writing with a pencil). Bean-shaped dot eyes, simple curved smile, eight uneven hand-drawn rays. Flat colors, no gradients, rough sketch texture, consistent character across all views, white margins.

**简笔小人 character sheet：**
> A character design sheet of a stick figure mascot in humorous hand-drawn style, warm dark-brown ink lines (#43301f) on white background, round head with dot eyes and a simple smile, one arm raised waving. Full-body views (front / side / back / walking / writing) plus six expressions (normal, surprised, facepalm, celebrating with both arms up, thinking, handing over a piece of chalk). Rough hand-drawn line texture, minimal and playful, consistent proportions across all poses.

### 一致性铁律

1. 同一编号 + 同一主题短语，一次生成整个 character sheet（不要分次生成单表情）。
2. 锁种子（生图工具支持则固定 seed）；后续补表情时**上传第一次的设定图当参考图**。
3. 选定后把定稿图存 `public/brand/`（如 `public/brand/sun-sheet.png`），头像/海报章从设定图裁切，禁止每次重生成。

## 五、用途映射（选定角色后逐步接入）

| 场景 | 形式 | 状态 |
|---|---|---|
| 白板内（每页页眉） | Excalidraw 原语，逐笔出现 | ✅ 已上线（顶栏「角色」切换） |
| 字幕条「讲师」标签 | 小头像（图片版裁切） | 待接入 |
| 预告卡（课堂入口） | 立绘 + 迎宾语 | 待接入 |
| 知识海报角落 | 签名章（角色 + 名字 + 日期） | 待接入（板书内原语版已随海报） |
| 结课认证 | 盖章 | 待接入 |
| checkpoint 答对/答错、结课 | 表情反应层（贴图层） | 待接入（v2） |
| 剧本俏皮台词 | 提示词加角色性格 | 并入「导演拆戏」（用户指定后做） |

## 六、决策记录

- 2026-09-11：两个候选原语版上线，待用户二选一（或都不选）；选定后此文档补「定稿：XXX」，未选项归档。
