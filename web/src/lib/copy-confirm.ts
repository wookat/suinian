import type { CopyGuardLevel } from "@/components/exec-guard"

export const COPY_CONFIRM: Record<CopyGuardLevel, { title: string; description: string }> = {
  sensitive: {
    title: "复制敏感笔记内容？",
    description: "这条笔记已标记敏感（加密保存，不进入问答与搜索）。复制到剪贴板可能被其它应用读取，请确认后再复制。",
  },
  strict: {
    title: "复制含可执行命令的内容？",
    description: "这条笔记含会下载执行远程代码或建立外连的命令。复制后请勿直接粘贴到终端执行，先核对来源。",
  },
  destructive: {
    title: "复制破坏性命令？",
    description: "这条笔记含会删除/覆写数据的命令（如 rm -rf / dd / DROP TABLE）。复制后请先核对目标对象与参数，确认无误再决定是否执行。",
  },
  credential: {
    title: "复制口令/密钥类内容？",
    description: "这条笔记含口令、密钥或连接串口令段。复制到剪贴板可能被其它应用读取，建议改为标记敏感加密保存。",
  },
  broad: {
    title: "复制命令/代码形态内容？",
    description: "这条笔记含远程地址、命令行或编码形态内容（可能只是你自己的备忘）。复制后请先核对参数与来源，再决定是否执行。",
  },
  code: {
    title: "复制命令/代码形态内容？",
    description: "这条笔记含命令行或代码形态内容（可能只是你自己的备忘）。复制后请先核对参数与来源，再决定是否执行。",
  },
}

/** 该强度下复制是否需要先确认（code 只提醒不阻断）。 */
export function copyNeedsConfirm(level: CopyGuardLevel): boolean {
  return level !== "code"
}
