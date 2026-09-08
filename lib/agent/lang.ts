// 输出语言守卫：管线把"输出语言"当一等参数之后，用文字脚本分布做廉价校验，
// 挡住"要求西班牙语、产出全中文"这类整段跑偏。只抓大错（CJK/拉丁/西里尔整段不符），
// 细粒度语种判别（西 vs 葡、英 vs 德）不做——那需要真正的语言识别，收益配不上成本。

/** 期望语言与实际文本是否相符。true=相符 false=跑偏 null=判断不了（按相符处理，不拦管线） */
export function langMatchesExpectation(
  expected: string | undefined,
  text: string
): boolean | null {
  const want = (expected || "").toLowerCase();
  if (!want) return null;
  // 去掉空白/数字/标点/符号后统计各脚本字符数（\p{P}\p{S} 需要 u 标志，Node 18+ 支持）
  const sample = text.replace(/[\s\d\p{P}\p{S}]/gu, "");
  if (sample.length < 12) return null;
  const cjk = (sample.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const latin = (sample.match(/[a-zA-Z\u00c0-\u024f\u1e00-\u1eff]/g) || []).length;
  const cyrillic = (sample.match(/[\u0400-\u04ff]/g) || []).length;
  const denom = cjk + latin + cyrillic;
  if (denom === 0) return null;
  const cjkRatio = cjk / denom;
  const cyrRatio = cyrillic / denom;

  if (/中文|汉语|华语|chinese/.test(want)) {
    // 技术课标题里英文术语很多（"LLM Agent 深度工程"），阈值放宽到 0.3
    return cjkRatio >= 0.3;
  }
  if (/日文|日语|japanese|韩文|韩语|korean/.test(want)) {
    return null; // 汉字/假名/谚文混写，脚本分布判断不了
  }
  if (/俄文|俄语|russian/.test(want)) {
    return cyrRatio >= 0.3;
  }
  // 其余一切拉丁系语言（英/西/葡/法/德…）：真正的失败模式是"整段输出成了中文"，
  // 抓这一条就够——西语误写成葡语这种级别交给人眼
  if (/英|西班|葡萄|法|德|意|拉丁|english|spanish|portuguese|french|german|italian|spaniol/.test(want)) {
    return cjkRatio <= 0.1;
  }
  return null;
}

/** 把状态里的输出语言/约束清单组装成可注入提示词的块（无内容返回空串） */
export function constraintsBlock(
  outputLanguage: string | undefined,
  constraints: string[] | undefined
): string {
  const lines: string[] = [];
  if (outputLanguage) {
    lines.push(
      `- 输出语言：${outputLanguage}（所有生成内容——标题、大纲、讲解、板书、题目、选项、解释——都必须使用该语言；专有名词/术语可保留英文原词）`
    );
  }
  for (const c of constraints || []) {
    const t = String(c).trim();
    if (t) lines.push(`- ${t}`);
  }
  if (lines.length === 0) return "";
  return `【用户对这门课的要求（必须遵守；这些是对产出的要求，不是搜索词，也不是主题本身）】\n${lines.join("\n")}\n\n`;
}
