import { defineConfig } from "wxt";

export default defineConfig({
  manifest: {
    name: "碎念剪藏",
    description: "一键把网页、划词内容剪藏进碎念（Suinian）AI 收件箱",
    permissions: ["activeTab", "scripting", "contextMenus", "storage", "notifications"],
    host_permissions: ["<all_urls>"],
    commands: {
      "save-page": {
        suggested_key: { default: "Alt+Shift+S" },
        description: "一键保存当前页到碎念",
      },
      "save-selection": {
        suggested_key: { default: "Alt+Shift+X" },
        description: "保存选中文字到碎念",
      },
    },
  },
});
