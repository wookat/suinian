/**
 * R313：broad:code 从「默认折叠」降为「默认展示 + 复制确认」后，哪些破坏性本地命令会被默认展示？
 * 直调 broadFoldReason / defaultFoldedReason / noteContainsExecutableCommand（数据面同一判据）。
 * 输出 out/broadcode-probe.txt。
 */
import { it } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { broadFoldReason, defaultFoldedReason, noteContainsExecutableCommand } from "../../../src/prompt-armor";

/** 无远程地址/取回执行原语，但一执行就毁数据/夺权/断网的本地命令（R313 新造，不在 R307–R312 语料）。 */
const DESTRUCTIVE_LOCAL = [
  "rm -rf / --no-preserve-root",
  "sudo rm -rf ~ /*",
  "dd if=/dev/zero of=/dev/sda bs=1M",
  "mkfs.ext4 /dev/nvme0n1p2",
  ":(){ :|:& };:",
  "chmod -R 777 /",
  "chown -R nobody:nogroup /etc",
  "shutdown -h now",
  "iptables -F && iptables -P INPUT DROP",
  "kill -9 -1",
  "echo 'newpass' | passwd --stdin root",
  "find / -name '*.db' -delete",
  "git push --force origin main",
  "git reset --hard HEAD~20 && git clean -fdx",
  "DROP TABLE users;",
  "DELETE FROM orders;",
  "UPDATE accounts SET balance = 0;",
  "truncate -s 0 /var/log/*.log",
  "mv /etc/passwd /tmp/",
  "crontab -r",
  "userdel -r deploy",
  "docker system prune -af --volumes",
  "kubectl delete ns production",
  "aws s3 rm s3://prod-bucket --recursive",
  "terraform destroy -auto-approve",
  "Remove-Item -Recurse -Force C:\\Users\\*",
  "format C: /q /y",
  "del /f /s /q C:\\*.*",
  "launchctl unload -w /System/Library/LaunchDaemons/*",
  "history -c && rm ~/.bash_history",
  // 备忘语境包裹（更像真实笔记）
  "清盘命令备忘：sudo rm -rf --no-preserve-root /",
  "服务器重装前跑：dd if=/dev/zero of=/dev/sda bs=1M status=progress",
  "数据库重置：DROP DATABASE prod; CREATE DATABASE prod;",
  "误删恢复无望时用 git reset --hard origin/main && git clean -fdx",
  "K8s 清场：kubectl delete all --all -n prod",
];

/** 日常无害命令备忘（R312 承诺「日常命令备忘直接展示」）。 */
const BENIGN_CMD = [
  "ls -la ~/Downloads",
  "git status && git log --oneline -5",
  "npm run dev",
  "docker ps -a",
  "python -m venv .venv && source .venv/bin/activate",
  "tar -czf backup.tgz ./notes",
  "grep -rn TODO src/",
  "brew update && brew upgrade",
  "kubectl get pods -n staging",
  "ffmpeg -i in.mov -vcodec h264 out.mp4",
];

it("r313 broad:code probe", () => {
  mkdirSync("out", { recursive: true });
  const lines: string[] = [];
  const stat = { shown: 0, folded: 0, strict: 0, none: 0 };
  for (const t of DESTRUCTIVE_LOCAL) {
    const reason = broadFoldReason(t);
    const strict = noteContainsExecutableCommand(t);
    const folded = strict || defaultFoldedReason(reason);
    if (strict) stat.strict++;
    else if (reason === null) stat.none++;
    else if (folded) stat.folded++;
    else stat.shown++;
    lines.push(`${folded ? "FOLDED " : reason === null ? "PLAIN  " : "SHOWN  "} reason=${reason ?? "null"} strict=${strict} :: ${t}`);
  }
  const bstat = { shown: 0, folded: 0, none: 0 };
  for (const t of BENIGN_CMD) {
    const reason = broadFoldReason(t);
    const folded = noteContainsExecutableCommand(t) || defaultFoldedReason(reason);
    if (reason === null) bstat.none++;
    else if (folded) bstat.folded++;
    else bstat.shown++;
    lines.push(`BENIGN ${folded ? "FOLDED " : reason === null ? "PLAIN  " : "SHOWN  "} reason=${reason ?? "null"} :: ${t}`);
  }
  const summary = [
    `DESTRUCTIVE_LOCAL n=${DESTRUCTIVE_LOCAL.length}: shown_by_default(broad:code)=${stat.shown} folded(strict/broad)=${stat.folded + stat.strict} (strict=${stat.strict}) plain(no flag)=${stat.none}`,
    `BENIGN_CMD n=${BENIGN_CMD.length}: shown(code)=${bstat.shown} folded=${bstat.folded} plain=${bstat.none}`,
  ];
  writeFileSync("out/broadcode-probe.txt", [...summary, "", ...lines].join("\n"));
  console.log(summary.join("\n"));
});
