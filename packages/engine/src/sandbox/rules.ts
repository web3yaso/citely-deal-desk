/**
 * 注入检测规则表（`docs/design/llm-provider-openai.md` §6.3 第 1 条）。
 *
 * 独立成文件是为了便于扩充：新增一条规则 = 往数组里加一个对象，
 * 不动 `sanitizeMaterial()` 一行代码。
 *
 * 规则是**确定性**的正则匹配，不调 LLM。它是 `injection_attempt` 的主源；
 * LLM 自报是辅助源，两者取并集（§6.3 第 3 条）。
 */

/** 沙箱产出的风险标记。目前只有一个，保留联合类型以便扩充。 */
export type SandboxFlag = "injection_attempt";

export interface InjectionRule {
  /** 规则标识，进 `detections[].rule`。 */
  readonly id: string;
  /** 命中后追加的 flag。 */
  readonly flag: SandboxFlag;
  /** 匹配模式。必须带 `g` 以便逐个命中取证据。 */
  readonly pattern: RegExp;
  /** 人读说明（"为什么这算注入"）。 */
  readonly rationale: string;
}

/**
 * 由码点数组构造字符类正则。
 *
 * 为什么不直接写正则字面量：这些码点在编辑器里**完全不可见**，
 * 字面写法既无法人工审阅、也容易被后续编辑静默破坏。
 */
function charClassOf(codePoints: readonly number[]): RegExp {
  const cls = codePoints.map((cp) => String.fromCodePoint(cp)).join("");
  return new RegExp(`[${cls}]`, "gu");
}

/** U+200B–U+200F 零宽与方向标记、U+2060 word joiner、U+FEFF BOM。 */
const ZERO_WIDTH_CODE_POINTS = [0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2060, 0xfeff];

/** U+202A–U+202E 方向覆盖、U+2066–U+2069 方向隔离。 */
const BIDI_CONTROL_CODE_POINTS = [
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
];

export const INJECTION_RULES: readonly InjectionRule[] = [
  // ① 祈使覆盖式：直接命令模型丢弃既有指令。
  {
    id: "imperative_override",
    flag: "injection_attempt",
    pattern: /ignore\s+(?:all\s+)?(?:the\s+)?(?:previous|above|prior)\s+instructions?/gi,
    rationale: "要求模型丢弃 system 指令",
  },
  {
    id: "imperative_override",
    flag: "injection_attempt",
    pattern: /disregard\s+(?:the\s+)?(?:above|previous|prior|earlier)/gi,
    rationale: "要求模型忽略上文指令",
  },
  {
    id: "imperative_override",
    flag: "injection_attempt",
    pattern: /\byou\s+are\s+now\b/gi,
    rationale: "试图重设模型身份",
  },
  {
    id: "imperative_override",
    flag: "injection_attempt",
    pattern: /\bnew\s+instructions?\b/gi,
    rationale: "宣称提供新指令",
  },

  // ② 角色伪造：伪造对话结构，试图让材料冒充更高权威的通道。
  {
    id: "role_forgery",
    flag: "injection_attempt",
    pattern: /(?:^|\n)\s*(?:system|developer|assistant)\s*:/gi,
    rationale: "伪造 role 前缀",
  },
  {
    id: "role_forgery",
    flag: "injection_attempt",
    pattern: /<\/?\s*(?:instructions?|system|developer)\s*>/gi,
    rationale: "伪造指令块标签",
  },
  {
    id: "role_forgery",
    flag: "injection_attempt",
    pattern: /<\|\s*(?:im_start|im_end|endoftext|channel)\s*\|>/gi,
    rationale: "伪造聊天模板特殊 token",
  },

  // ③ 目标性指令：直接指向本系统的判定/结算词汇——最危险的一类。
  {
    id: "targeted_instruction",
    flag: "injection_attempt",
    pattern: /mark\s+all\s+(?:parties|legs|payees)\s+payable/gi,
    rationale: "指令放行全部资金腿",
  },
  {
    id: "targeted_instruction",
    flag: "injection_attempt",
    pattern: /\bset\s+(?:the\s+)?verdict\s+to\b/gi,
    rationale: "指令改写 verdict",
  },
  {
    id: "targeted_instruction",
    flag: "injection_attempt",
    // 大小写敏感：PASS/HOLD/ESCALATE 是本系统的枚举字面量，
    // 放开大小写会把 "output pass" 之类的日常英文误判成注入。
    pattern: /\b(?:output|return|respond\s+with)\s+(?:PASS|HOLD|ESCALATE)\b/g,
    rationale: "指令改写 condition",
  },
  {
    id: "targeted_instruction",
    flag: "injection_attempt",
    pattern:
      /\bverdict\s*[:=]\s*"?(?:confirmed_in_scope|confirmed_exempt|gray_data|gray_interpretive|unverifiable)"?/gi,
    rationale: "在材料里直接写 verdict 赋值",
  },

  // ④ 混淆：用不可见字符/方向控制符/超长不透明载荷躲避人工与规则审阅。
  {
    id: "obfuscation_zero_width",
    flag: "injection_attempt",
    pattern: charClassOf(ZERO_WIDTH_CODE_POINTS),
    rationale: "零宽字符（人眼不可见）",
  },
  {
    id: "obfuscation_bidi",
    flag: "injection_attempt",
    pattern: charClassOf(BIDI_CONTROL_CODE_POINTS),
    rationale: "Unicode 方向控制符（可视觉倒置文本）",
  },
  {
    id: "obfuscation_base64",
    flag: "injection_attempt",
    pattern: /[A-Za-z0-9+/]{200,}={0,2}/g,
    rationale: "超长 base64 样式载荷（不透明内容）",
  },
];
