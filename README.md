# dsh-model-switch

DSH (DeepSeek Harness) 全局插件：用任意按键（含 spare 键、蓝牙小键盘、遥控器 HID 键盘等）**一键切换模型与思考强度**。

在输入框下方那一行（模型显示同一行）的左侧渲染一个机械键帽按钮，点开面板可以把任意组合键（建议 F13–F24 或 Ctrl/Alt 组合）映射到「某个 provider 的某个模型 + 思考强度档位」。之后在页面上直接按下遥控器按键即可切换，全程无浮动弹窗打扰。

## 功能

- 🎹 机械键帽样式按钮（面板打开时呈现"按下"状态），位于输入框下方模型行左侧
- 组合键 → 模型 + 思考强度 的映射管理（添加 / 换模型 / 调强度 / 删除）
- 录入流程在面板内完成：点「添加按键映射」→ 面板显示"正在监听"并实时回执收到的按键 → 选模型 → 选强度，面板全程不关闭
- 模型列表来自 DSH 官方 `modelDirectories` 服务（与 UI 模型选择器同数据源，实时同步），并兼容 `remote.session` 旧接口
- 内置轻量诊断通道（宿主落盘 `$DSH_HOME/.rms-diag.ndjson`），排查"按键没反应"之类问题不需要开 DevTools

## 安装

```bash
dsh plugin --profile web add link:<本目录绝对路径>
```

或者手工安装（本项目实际使用的方式）：

1. 把本目录放进 `$(DSH_HOME)/profiles/web/packages/dsh-remote-model-switch`
2. 在 `profiles/web/package.json` 中：
   - `dependencies` 加 `"dsh-remote-model-switch": "file:./packages/dsh-remote-model-switch"`
   - `dsh.profile.bundles` 数组加 `"dsh-remote-model-switch"`
3. 在 `profiles/web` 下执行 `pnpm install`
4. 完全退出并重启 DSH，刷新页面

> 注意：pnpm 对内容变化但版本号不变的 `file:` 依赖可能跳过重链。改过 `lib/*.js` 后如果没生效，把文件手动同步到 `profiles/web/node_modules/dsh-remote-model-switch/`，或 bump `version` 后重新 `pnpm install`。

## 结构

```
package.json          bundle manifest（dsh.bundle.patch + dsh.client）
cordis.patch.yml      宿主配置插入：- id: remote-model-switch
lib/index.js          宿主半：启动标记 + 诊断路由（/remote-model-switch/diag、/state）
lib/client.js         客户端半：全部 UI 与按键逻辑（bundle 客户端模块格式）
```

## 开发

日常迭代基本只需要改 `lib/client.js`：改完同步到 `node_modules` 那份 → 重启 DSH → 刷新页面。

排查工具：浏览器半在关键节点（模块加载、apply、槽位挂载、按键捕获、模型目录加载、切换执行）会 POST 到宿主，落盘 `$DSH_HOME/.rms-diag.ndjson`；宿主半的挂载证据在 `$DSH_HOME/.rms-host-loaded.json`。

## 已知边界

- 按键映射存在页面内存里，刷新页面后需要重新录入（持久化在计划中）
- 遥控器需要以 HID 键盘身份发送普通按键码（F13–F24 最理想）；多媒体/消费类按键（音量、播放等）浏览器不会产生 `keydown`，无法捕获

## License

MIT
