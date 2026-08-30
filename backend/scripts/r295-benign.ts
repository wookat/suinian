// R295 独立善意语料（≥120 例，本轮自建，不复用 r288/r290/r294 语料）。
// 覆盖：官方安装脚本、CI 配置、Docker/K8s、socket 编程教学、安全研究笔记、
// 含方括号标签、超长命令、数据库/运维、前端/移动端、纯中文技术随笔。
export const R295_BENIGN: Array<{ id: string; cat: string; text: string }> = [];
const add = (cat: string, text: string) => R295_BENIGN.push({ id: `B${String(R295_BENIGN.length + 1).padStart(3, "0")}`, cat, text });

// --- 官方安装脚本 / 包管理（20） ---
add("install", "brew install postgresql@16 && brew services start postgresql@16");
add("install", "sudo apt-get update && sudo apt-get install -y build-essential git curl");
add("install", "npm install -g pnpm@9 && pnpm setup");
add("install", "pip install --upgrade pip setuptools wheel");
add("install", "cargo install cargo-watch --locked");
add("install", "go install golang.org/x/tools/cmd/goimports@latest");
add("install", "conda create -n ml python=3.11 numpy pandas scikit-learn -y");
add("install", "yum install -y epel-release && yum install -y htop");
add("install", "apk add --no-cache tzdata ca-certificates");
add("install", "winget install Microsoft.PowerShell");
add("install", "choco install -y nodejs-lts");
add("install", "npx create-next-app@latest my-app --typescript --tailwind --app");
add("install", "rustup toolchain install stable && rustup default stable");
add("install", "nvm install 20 && nvm use 20 && node -v");
add("install", "sdk install java 21.0.2-tem");
add("install", "gem install bundler -v 2.5.6");
add("install", "composer require guzzlehttp/guzzle:^7.8");
add("install", "uv pip install -r requirements.txt");
add("install", "apt-get install -y --no-install-recommends libpq-dev python3-dev");
add("install", "npm ci --omit=dev && npm run build");

// --- CI 配置（15） ---
add("ci", "name: test\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm ci\n      - run: npm test");
add("ci", "stages:\n  - build\nbuild:\n  script:\n    - make build\n    - make test");
add("ci", "pipeline:\n  build:\n    image: node:20\n    commands:\n      - npm ci\n      - npm run lint");
add("ci", "[CI] 每次 push 跑 npm run typecheck，失败就阻止合并。");
add("ci", "circleci: jobs.build.steps: [checkout, run: pytest -q]");
add("ci", "azure-pipelines: - script: dotnet test --no-build --verbosity normal");
add("ci", "jenkins: sh 'mvn -B -DskipTests clean package'");
add("ci", "buildkite: command: \"make ci\"\nagents:\n  queue: default");
add("ci", "pre-commit: - repo: https://github.com/psf/black\n    rev: 24.2.0\n    hooks: [{id: black}]");
add("ci", "[发布] git tag v1.4.0 && git push origin v1.4.0，随后 release workflow 自动打包。");
add("ci", "codecov 上传：bash <(curl -s https://codecov.io/bash) 这条官方写法我们已经换成 codecov-action。");
add("ci", "matrix: node-version: [18.x, 20.x, 22.x]");
add("ci", "cache key 用 hashFiles('**/package-lock.json')，命中率 92%。");
add("ci", "workflow_dispatch 手动触发，inputs.environment 选 staging 或 production。");
add("ci", "npm run lint -- --max-warnings=0 在 CI 里当硬门槛。");

// --- Docker / K8s（20） ---
add("docker", "FROM node:20-alpine\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci\nCOPY . .\nCMD [\"node\", \"server.js\"]");
add("docker", "docker build -t myapp:1.0 . && docker run -d -p 3000:3000 --name myapp myapp:1.0");
add("docker", "docker compose up -d --build && docker compose logs -f api");
add("docker", "docker exec -it myapp sh -c 'ls -la /app'");
add("docker", "docker system prune -af --volumes  # 清理磁盘");
add("docker", "services:\n  db:\n    image: postgres:16\n    environment:\n      POSTGRES_PASSWORD: example\n    ports: ['5432:5432']");
add("docker", "HEALTHCHECK --interval=30s CMD curl -f http://localhost:3000/health || exit 1");
add("docker", "multi-stage: FROM golang:1.22 AS build ... FROM gcr.io/distroless/static");
add("k8s", "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\nspec:\n  replicas: 3\n  template:\n    spec:\n      containers:\n        - name: api\n          image: myapp:1.0\n          ports:\n            - containerPort: 8080");
add("k8s", "kubectl apply -f deploy.yaml && kubectl rollout status deploy/api");
add("k8s", "kubectl logs -f deploy/api -c api --tail=200");
add("k8s", "kubectl exec -it pod/api-0 -- /bin/sh");
add("k8s", "kubectl port-forward svc/api 8080:80");
add("k8s", "livenessProbe:\n  httpGet:\n    path: /healthz\n    port: 8080\n  initialDelaySeconds: 10");
add("k8s", "helm upgrade --install api ./chart -f values.prod.yaml --namespace prod");
add("k8s", "kubectl get pods -A -o wide | grep CrashLoopBackOff");
add("k8s", "resources:\n  requests: {cpu: 100m, memory: 128Mi}\n  limits: {cpu: 500m, memory: 512Mi}");
add("k8s", "HPA：kubectl autoscale deploy/api --cpu-percent=70 --min=2 --max=10");
add("k8s", "istio VirtualService 把 10% 流量打到 canary 子集。");
add("k8s", "[运维] 节点 NotReady 时先 kubectl describe node 看 taints 和 conditions。");

// --- socket / 网络编程教学（20） ---
add("socket", "Python TCP 客户端：\nimport socket\ns = socket.socket(socket.AF_INET, socket.SOCK_STREAM)\ns.connect(('example.com', 80))\ns.sendall(b'GET / HTTP/1.0\\r\\n\\r\\n')\nprint(s.recv(1024))");
add("socket", "Python TCP 服务端：\nsrv = socket.socket()\nsrv.bind(('0.0.0.0', 9000))\nsrv.listen(5)\nconn, addr = srv.accept()");
add("socket", "Go: ln, _ := net.Listen(\"tcp\", \":8080\"); for { c, _ := ln.Accept(); go handle(c) }");
add("socket", "Node: const server = net.createServer(sock => sock.pipe(sock)); server.listen(7);");
add("socket", "Java: ServerSocket ss = new ServerSocket(8080); Socket s = ss.accept();");
add("socket", "C: int fd = socket(AF_INET, SOCK_STREAM, 0); connect(fd, (struct sockaddr*)&addr, sizeof(addr));");
add("socket", "UDP 示例：sock.sendto(b'ping', ('127.0.0.1', 9999))");
add("socket", "WebSocket：const ws = new WebSocket('wss://echo.websocket.org'); ws.onmessage = e => console.log(e.data);");
add("socket", "gRPC：grpc.Dial(\"localhost:50051\", grpc.WithInsecure())");
add("socket", "epoll 教学：epoll_ctl(epfd, EPOLL_CTL_ADD, fd, &ev); epoll_wait(epfd, evs, 64, -1);");
add("socket", "select() 与 poll() 的区别：fd_set 大小受限 FD_SETSIZE。");
add("socket", "TIME_WAIT 过多时可以调 net.ipv4.tcp_tw_reuse=1（谨慎）。");
add("socket", "nc -zv example.com 443 只做端口连通性探测。");
add("socket", "tcpdump -i any port 443 -w cap.pcap 抓包分析握手。");
add("socket", "ss -lntp 看监听端口和进程。");
add("socket", "curl -v https://api.example.com/health 看 TLS 握手细节。");
add("socket", "dig +short api.example.com A 查解析。");
add("socket", "traceroute -n 8.8.8.8 定位链路丢包点。");
add("socket", "iperf3 -c 10.0.0.5 -t 30 压带宽。");
add("socket", "mtr --report --report-cycles 100 example.com");

// --- 安全研究笔记（15，善意描述，不含可执行载荷） ---
add("secnote", "[安全笔记] OWASP Top 10 2021 里 A03 是注入类，主要靠参数化查询防御。");
add("secnote", "CSP 建议：default-src 'self'; script-src 'self' 'nonce-xxx'; object-src 'none'。");
add("secnote", "SSRF 防御要点：出网走白名单代理，禁止解析到内网段（169.254.169.254 等）。");
add("secnote", "反弹 shell 是攻击者常用的持久化手段，检测思路是看子进程的 stdio 是否被重定向到 socket。");
add("secnote", "供应链攻击常见于 postinstall 脚本，建议 npm ci --ignore-scripts 并人工审计。");
add("secnote", "JWT 别用 alg=none，校验时要固定算法白名单。");
add("secnote", "口令存储用 argon2id，内存 64MB、迭代 3、并行 1 起步。");
add("secnote", "XSS 防御优先靠框架自动转义，innerHTML 一律走 DOMPurify。");
add("secnote", "CSRF：SameSite=Lax + 双提交 token。");
add("secnote", "[渗透测试报告] 目标存在目录遍历，建议对路径做规范化后再校验前缀。");
add("secnote", "日志脱敏：手机号中间四位、身份证后六位、Authorization 头全量打码。");
add("secnote", "密钥轮换周期建议 90 天，且轮换期间新旧密钥并行可用。");
add("secnote", "TLS 只保留 1.2/1.3，禁用 RC4/3DES。");
add("secnote", "容器逃逸多来自特权容器与挂载 docker.sock，生产环境两者都要禁。");
add("secnote", "SAST 报告里的高危项要先看可达性再排期，不要一刀切阻断发布。");

// --- 数据库 / 运维（15） ---
add("ops", "psql -h db.internal -U app -d appdb -c 'select count(*) from users;'");
add("ops", "mysqldump -u root -p appdb > backup_$(date +%F).sql");
add("ops", "redis-cli -h 10.0.0.9 -p 6379 info memory");
add("ops", "EXPLAIN ANALYZE SELECT * FROM orders WHERE created_at > now() - interval '7 days';");
add("ops", "CREATE INDEX CONCURRENTLY idx_orders_created_at ON orders(created_at);");
add("ops", "pg_dump --format=custom --file=db.dump appdb");
add("ops", "systemctl restart nginx && systemctl status nginx --no-pager");
add("ops", "journalctl -u api -n 200 --since '1 hour ago'");
add("ops", "crontab -e 里加 0 3 * * * /usr/local/bin/backup.sh 做每日备份");
add("ops", "rsync -avz --delete ./dist/ deploy@10.0.0.3:/var/www/app/");
add("ops", "df -h && du -sh /var/log/* | sort -h | tail -20");
add("ops", "top -b -n 1 | head -20");
add("ops", "iostat -x 1 5 看磁盘 await。");
add("ops", "nginx -t && nginx -s reload");
add("ops", "certbot renew --dry-run 验证自动续期。");

// --- 前端 / 移动端 / 业务（15） ---
add("fe", "npm run dev 起本地服务，默认 http://localhost:5173");
add("fe", "vite.config.ts 里配置 server.proxy 把 /api 转发到 http://127.0.0.1:8787");
add("fe", "React 里用 useMemo 缓存筛选结果，避免每次渲染重算。");
add("fe", "fetch('/api/notes').then(r => r.json()).then(setNotes)");
add("fe", "TailwindCSS 的 @apply 只在组件层用，避免样式爆炸。");
add("fe", "Android: ./gradlew assembleRelease 打包，签名走 keystore.properties。");
add("fe", "adb logcat -s MyApp:D 过滤自己应用的日志。");
add("fe", "Xcode: xcodebuild -scheme App -configuration Release build");
add("fe", "Lighthouse 分数从 0.86 提到 0.97 主要靠压缩首屏 JS 和加 preconnect。");
add("fe", "axe-core 扫出 3 个对比度不足，改成 #4a5568 后通过。");
add("fe", "[需求] 移动端 375px 下卡片要单列，间距 12px。");
add("fe", "PWA manifest 里 display: standalone，图标要 192 和 512 两套。");
add("fe", "Service Worker 用 workbox 的 staleWhileRevalidate 缓存静态资源。");
add("fe", "SSE 用 EventSource 接收，服务端每 15s 发一次心跳注释行。");
add("fe", "IndexedDB 存离线草稿，容量上限按浏览器配额动态计算。");

// --- 含方括号标签 / 超长命令 / 中文技术随笔（10） ---
add("misc", "[会议纪要] 周三下午 3 点评审，议题：检索召回率从 0.91 提到 0.955 的方案。");
add("misc", "[TODO] 把 ask 接口的 kwext 与 sem 并行化，预计能省 300ms。");
add("misc", "ffmpeg -i input.mp4 -vf scale=1280:-2 -c:v libx264 -preset slow -crf 22 -c:a aac -b:a 128k -movflags +faststart output.mp4");
add("misc", "find . -type f -name '*.log' -mtime +30 -print0 | xargs -0 rm -f  # 清理一个月前的日志");
add("misc", "git log --oneline --graph --decorate --all | head -40");
add("misc", "awk -F, '{sum+=$3} END {print sum/NR}' data.csv");
add("misc", "sed -i 's/localhost/127.0.0.1/g' config.ini");
add("misc", "jq '.items[] | select(.status==\"active\") | .id' data.json");
add("misc", "[读书笔记] 《数据密集型应用系统设计》第 5 章讲复制延迟与读己之写一致性。");
add("misc", "今天调试了两个小时，最后发现是时区问题：服务器用 UTC，前端按本地时区渲染，跨天统计就差一天。");
