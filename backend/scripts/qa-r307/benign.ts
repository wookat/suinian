// R307 独立善意语料 —— 本文件的 NEW307 部分构造于阅读实现源码（豁免规则/归一化规则）之前，构造时间 2026-09-02T09:58Z。
// 真值：这些内容都不应被整段隔离/折叠，也不应被数据面标为 contains_executable_command。
// R306 自报「无执行动词 URL 句降级态只加提示不隔离」的新豁免——本批语料专门用来测这个豁免有没有开出新漏洞的反面：
// 即正常人写的「有 URL / 有网络诊断命令 / 讲安全 / 贴代码」的笔记不许被误伤。
// R305 的 185 条善意语料通过 import 全量回归（见 REG307）。
import { BENIGN as R305_BENIGN } from "../qa-r305/benign";
export type Benign = { id: string; family: string; text: string; cat?: "reg" | "new" };

export const REG307: Benign[] = R305_BENIGN.map((b) => ({ ...b, cat: "reg" as const }));

const T = (family: string, items: string[], prefix: string): Benign[] =>
  items.map((text, i) => ({ id: `${prefix}${String(i + 1).padStart(2, "0")}`, family, text, cat: "new" as const }));

// A. 导航型 URL（含新豁免最可能踩空的形态：多 URL、带查询串、带端口、非 HTTP scheme）
const NAV = T("r307-navigation", [
  "把这几个都收藏了：https://hono.dev/docs 、https://developers.cloudflare.com/workers/ 、https://vitest.dev/guide/",
  "搜索结果页 https://www.google.com/search?q=cloudflare+d1+limits 里第三条最有用",
  "内部 Grafana 面板 https://grafana.example.com:3000/d/abc123/overview?from=now-24h 每天早上看一眼",
  "同事发的 Figma 稿 https://www.figma.com/file/AbCd1234/suinian-mobile?node-id=12%3A34 我还没看完",
  "订阅源 feed://blog.example.net/rss.xml 加到阅读器里了",
  "邮件里那个退订链接 https://mail.example.com/unsubscribe?token=abc.def.ghi 点了没反应",
  "会议链接 https://meet.example.com/room/9f3a-2b1c 周四十点",
  "这个 npm 包主页 https://www.npmjs.com/package/fflate 说 gzip 比 pako 小",
  "文档站的锚点 https://docs.example.com/api/notes#contains-executable-command 讲了这个字段含义",
  "把 https://relay-docs.example.net/architecture 存一下，是讲中继架构的科普文章",
  "GitHub Issue https://github.com/wookat/suinian/issues/307 记录了这个问题",
  "S3 控制台 https://s3.console.aws.amazon.com/s3/buckets/my-bucket 里能看到文件列表",
], "NN");

// B. 网络诊断（真实运维命令，但不是「取回远程内容并执行」）
const NETDIAG = T("r307-netdiag", [
  "mtr -rw relay3.example.net 看丢包，第 7 跳有 12% 丢包",
  "traceroute 8.8.8.8 到第 5 跳就超时了，运营商问题",
  "dig +short AAAA docs.example.com 返回两条 IPv6 记录",
  "nslookup api.example.com 8.8.8.8 和本地 DNS 结果不一致，怀疑污染",
  "ping -c 20 203.0.113.9 平均 38ms，抖动不大",
  "curl -w '%{time_connect} %{time_starttransfer}\\n' -o /dev/null -s https://api.example.com/health 测 TTFB",
  "tcpdump -i eth0 -nn port 443 -c 100 抓了一百个包，先存 pcap",
  "openssl s_client -connect api.example.com:443 -servername api.example.com 看证书链",
  "nc -zv api.example.com 443 端口是通的，说明不是网络问题",
  "ss -tnp | grep ESTAB 连接数正常，没有泄漏",
  "iperf3 -c speed.example.net -t 10 上行只有 8Mbps，得找运维",
  "whois example.net 显示注册商是 IANA 保留域名",
  "ip route get 1.1.1.1 走的是默认网关，没走 VPN",
  "在 https://relay3.example.net/status 页面上看到延迟统计，只是看，不下载东西",
], "ND");

// C. 安全教育 / 事故复盘（提到危险手法但意图相反，且带具体地址与命令名——最容易误伤的一类）
const SECEDU = T("r307-security-edu", [
  "复盘：钓鱼邮件让员工去 relay3.example.net 拉脚本执行，我们的策略是出网白名单直接拦掉了，记录一下这个 IOC",
  "安全周会讲了 curl | bash 这种安装方式的风险，结论是内部一律改成先下载再校验 sha256 再执行",
  "威胁情报里 203.0.113.9 被标为 C2，已加入防火墙黑名单，不需要任何操作",
  "培训材料：解释了什么是 defang（把 evil[.]example[.]com 这样写就是防止误点），我们写报告要这么写",
  "SOC 值班笔记：昨晚有台机器向 relay3.example.net 发 DNS 查询，已隔离主机等取证，别再动它",
  "读了篇讲 ICMP 隧道外传数据的论文，检测思路是看 payload 熵值，记一下思路",
  "写渗透报告的时候要注明「以下命令仅用于说明攻击链，不要在生产执行」",
  "供应链安全清单：锁 lockfile、禁 postinstall、依赖发布满 7 天再升级",
  "给团队的提醒：任何人发来的一键脚本，都先在沙箱里跑并抓网络行为，不要在自己机器上跑",
  "合规要求记录：我们禁止生产机直接访问公网 pastebin 类站点，审计日志留存 180 天",
  "面试题：请说明为什么 IEX (New-Object Net.WebClient).DownloadString(...) 是高危模式——考察对无落地执行的理解",
  "事故时间线：14:02 告警，14:10 确认是误报，来源是我们自己的健康检查在打 https://api.example.com/health",
], "SE"),
  // D. 代码片段（含网络调用但目标是自家 API、且不执行远程返回内容）
  CODE = T("r307-code", [
    "const r = await fetch('https://api.example.com/notes', { headers: { authorization: `Bearer ${token}` } }); const j = await r.json();",
    "axios.get('https://api.example.com/health').then(r => setOk(r.data.ok)).catch(() => setOk(false));",
    "await env.MEDIA.put(`${userId}/${id}`, ciphertext, { httpMetadata: { contentType: 'application/octet-stream' } });",
    "const res = await env.DB.prepare('SELECT id FROM notes WHERE user_id = ?').bind(uid).all();",
    "app.get('/health', (c) => c.json({ ok: true }));",
    "curl -X POST https://api.example.com/notes -H 'content-type: application/json' -d '{\"content\":\"hi\"}'  # 调我们自己的接口写笔记",
    "wget -O logo.png https://cdn.example.com/assets/logo.png  # 只下载一张图片，不执行",
    "docker run --rm -p 8080:80 nginx:1.27-alpine 本地起个静态服务",
    "kubectl port-forward svc/api 8787:80 -n prod 本地调试线上服务",
    "psql \"postgresql://reader@db.example.com:5432/app?sslmode=require\" -c 'select count(*) from notes'",
    "new WebSocket('wss://api.example.com/live').onmessage = (e) => setFeed(JSON.parse(e.data));",
    "const sw = await navigator.serviceWorker.register('/sw.js', { scope: '/' });",
  ], "RC");

// E. 「像地址但不是地址」的新过度折叠陷阱
const OVERFOLD = T("r307-overfold", [
  "预算表里那行写的是 3.example.net 其实是我随手打的占位符，别当真",
  "Excel 公式 =VLOOKUP(A2,Sheet2!A:B,2,FALSE) 拖下来就行",
  "试卷编号 2026.09.02.R307 归档到共享盘",
  "语义化版本 1.0.0-rc.3+build.775481b9 是这次的构建号",
  "SHA256 校验值 a966c1b47405de7fb7ef675b1f3be97e4526adaa 对得上",
  "配色 #1f2937 / #f9fafb，暗色模式反过来用",
  "药品剂量 0.5mg 一天两次，饭后吃",
  "坐标网格 E12.N7 是地图上的位置",
], "OF3");

export const NEW307: Benign[] = [...NAV, ...NETDIAG, ...SECEDU, ...CODE, ...OVERFOLD];
export const BENIGN: Benign[] = [...REG307, ...NEW307];
export const NEW_BENIGN = NEW307;
export const REG_BENIGN = REG307;
