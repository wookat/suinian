# 碎念 Suinian — Android App

Kotlin + Jetpack Compose + Material 3（minSdk 26，包名 `com.zalize.suinian`）。

## 功能
- **分享接收**：任何 app「分享 → 碎念」（`ACTION_SEND` / `ACTION_SEND_MULTIPLE`，`text/plain` + `image/*`），弹出轻量确认页（可加一句备注）→ `POST /api/notes` → Toast 后自动关闭；离线/失败自动入本地队列（Room），联网后 WorkManager 重试
- **速记**：首页顶部速记框；桌面小组件（Glance）一键打开速记；通知栏常驻快捷入口（设置里可关闭）
- **查看端**：原生时间流列表（分类角标 / #标签 / 链接卡片）+ 分类筛选（想法/待办/收藏/资料）+ 关键词搜索，直接调后端 API
- **设置**：API Base URL、Bearer Token、Mock 模式开关、通知入口开关

## 构建
需要 JDK 17 + Android SDK（compileSdk 35）。

```bash
cd android
./gradlew assembleDebug
# 产物：app/build/outputs/apk/debug/app-debug.apk
```

## 安装
```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

## 配置
1. 打开 app → 右上角设置
2. 填 API Base URL（如 `https://suinian-api.zalize.com`）与 API Token → 保存
3. 后端就绪前保持「Mock 模式」开启，可用本地模拟数据体验完整流程；后端可用后关闭 Mock 即切到真实 API

## 与后端的接口约定（docs/SPEC.md）
- `POST /api/notes`（Bearer token）body：`{source, raw_type, content, url?}`
- `GET /api/notes?category=&tag=&q=&cursor=`，响应假定为 `{notes: [...], cursor?}`（note 字段与 SPEC D1 notes 表一致）
- 分类/标签由后端 AI 分拣产生，app 只展示

## 已知限制（R1）
- 图片分享：R1 SPEC 未定义附件上传接口，目前以 `raw_type=image` + 文件名占位内容入库，待后端 attachments/R2 上传接口就绪后接入真实上传
- 时间流分页（cursor）后续接入；当前一次拉取首页数据
- 通知栏入口在 Android 13+ 需授予通知权限
