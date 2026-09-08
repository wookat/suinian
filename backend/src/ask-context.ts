import { neutralizePromptInjection } from "./triage";
import { redactGuardedLinesForModel, normalizedGuardedLeak, MODEL_REDACTED_LINE, foldCompact, VERBATIM_REDIRECT_NOTICE } from "./prompt-armor";

/** 正文开头的 [xxx]/【xxx】前缀是元数据（R212 P3-5），送进生成上下文前剔除，避免模型把它们复制进回答充当引文号。 */
export const LEADING_META_PREFIX_RE = /^\s*(?:[[【][^\]】\n]{1,24}[\]】]\s*)+/;

/** 预算内整句收尾：截断点回退到最近的句读/换行，不产出半句残片。 */
export function clipAtSentence(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const head = text.slice(0, budget);
  const m = head.match(/^[\s\S]*[。！？!?；;\n]/);
  return m && m[0].length >= budget * 0.6 ? m[0] : head;
}

export type ModelContextNoteInput = {
  title: string | null | undefined;
  content: string;
  /** askGuardNoteUnit(n)：标题 + 正文 + 链接标题 + 链接摘要，受守行按这个单元语境判。 */
  unit: string;
  crossGuarded: ReadonlySet<string>;
  budget: number;
  /** 取值型问题里在讲秘密但不是问题主题的笔记：整条不进上下文（模型只见占位行，仍可引用角标）。 */
  withholdWhole?: boolean;
};

export type ModelContextNoteText = { text: string; redacted: number; withheld: boolean };

/**
 * R324 B（decision-r324）：单条笔记送模型的文本。R322 的替换（redactGuardedLinesForModel）原先作用在
 * 「注入中和 → 前缀剥离 → 截断」之后的文本上，而受守行是按原文判的——中和改写了行字面（零宽字符 / ChatML 记号 /
 * 祈使句 / 编码载荷 / 定界仿冒）或剥掉了首部 [标签] 前缀后，受守行与处理后文本不再逐字相等，替换失效，原文进了上下文
 * （R323 本地确证 17/60）。这里把顺序倒过来：先在原文上按行替换，再对替换后的文本做中和 / 剥离 / 截断；最后再按归一化
 * 比对复查一次（fail-closed）：处理后的文本里仍能比对出受守取值时整条只留占位。
 */
export function modelContextNoteText(input: ModelContextNoteInput): ModelContextNoteText {
  if (input.withholdWhole) return { text: MODEL_REDACTED_LINE, redacted: 1, withheld: true };
  const title = input.title ?? "";
  const redacted = redactGuardedLinesForModel(`${title}\n${input.content}`, input.unit, input.crossGuarded);
  const nl = redacted.text.indexOf("\n");
  const titleOut = nl === -1 ? redacted.text : redacted.text.slice(0, nl);
  const bodyRaw = nl === -1 ? "" : redacted.text.slice(nl + 1);
  const body = clipAtSentence(neutralizePromptInjection(bodyRaw).replace(LEADING_META_PREFIX_RE, ""), input.budget);
  const text = `${titleOut}\n${body}`;
  if (normalizedGuardedLeak(text, [input.unit]) !== null) return { text: MODEL_REDACTED_LINE, redacted: redacted.redacted + 1, withheld: true };
  return { text, redacted: redacted.redacted, withheld: false };
}

export type HeldSegment = { s: string; tier: string };
const CITATION_MARK_RE = /\s*[[［]\d{1,2}[\]］]/g;
const stripCitationMarks = (t: string): string => t.replace(CITATION_MARK_RE, "");

/**
 * R324 C3（audit-r323 A6：delta 扣下的句段在 done 里以明文重现）：逐段闸门因收口类原因扣下的句段，在 done 的答案里逐句复核——
 * 同一句段（去角标折叠后相等或 ≥8 字包含）若在 done 的信任域下仍过不了闸门（passesDoneGate），就从 done 里去掉。
 * done 闸门比逐段闸门多一项只有 done 才确定的输入（最终 references 里的同屏善意单元），所以同信任域也必须重跑，
 * 不能按「判据同源」直接去掉。整答被去空时退回原文指引 + 原角标。
 */
export function reconcileDoneAnswer(
  answer: string,
  heldClosed: readonly HeldSegment[],
  _doneTierKind: string,
  passesDoneGate: (segment: string) => boolean
): { answer: string; dropped: number } {
  const held = heldClosed.map((h) => ({ ...h, fold: foldCompact(stripCitationMarks(h.s)) })).filter((h) => h.fold.length >= 4);
  if (held.length === 0) return { answer, dropped: 0 };
  const parts = answer.split(/(?<=\n|[。！？!?；;])/);
  let dropped = 0;
  const kept = parts.filter((p) => {
    const f = foldCompact(stripCitationMarks(p));
    if (!f) return true;
    const hit = held.find((h) => h.fold === f || (h.fold.length >= 8 && f.includes(h.fold)) || (f.length >= 8 && h.fold.includes(f)));
    if (!hit) return true;
    if (passesDoneGate(stripCitationMarks(p).trim())) return true;
    dropped += 1;
    return false;
  });
  if (dropped === 0) return { answer, dropped: 0 };
  const marks = [...new Set(answer.match(/[[［]\d{1,2}[\]］]/g) ?? [])].join("");
  const rest = kept.join("").trim();
  return { answer: rest.length > 0 && !/^(?:[[［]\d{1,2}[\]］]|\s)+$/.test(rest) ? rest : `${VERBATIM_REDIRECT_NOTICE}${marks}`, dropped };
}
