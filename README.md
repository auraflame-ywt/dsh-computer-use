# 电脑操控与浏览器自动化（DSH 插件）

给 DeepSeek Harness 增加一双「手」和一双「眼」：截屏、鼠标键盘、窗口与控件树、录屏，
以及基于本机 Google Chrome（缺失时回退 Microsoft Edge）的浏览器自动化。全部在本机执行，
不依赖任何第三方 npm 包或外部服务。

> **平台**：本插件是 **Windows 版**，运行于 Windows 10/11（依赖系统自带的 Windows PowerShell 5.1）。
> macOS 版是另一个插件：[`@liuxinye/dsh-automation`](https://github.com/auraflame-ywt/dsh-automation)，
> 两者提供同一组「电脑操控 + 浏览器自动化」能力，只是底层实现不同。

- 插件包名：`@liuxinye/dsh-computer-use`
- 浏览器：优先使用本机安装的 Google Chrome，没有时回退 Microsoft Edge（通过 DevTools 协议驱动）

## 提供的工具

| 工具 | 作用 |
|---|---|
| `computer_screenshot` | 截全桌面 / 单个显示器 / 指定窗口 / 指定矩形，返回图片和文件路径 |
| `computer_mouse` | 移动、单击、双击、右键、中键、拖拽、滚轮（屏幕绝对坐标） |
| `computer_keyboard` | 输入任意文本（含中文，经剪贴板粘贴）；发送组合键如 `ctrl+s`、`alt+tab` |
| `computer_window` | 列出可见窗口，前台/最小化/最大化/还原/移动窗口、关闭窗口 |
| `computer_ui` | 读取窗口的 UI Automation 控件树，并按 ref 点击/调用/设值/聚焦，不依赖像素坐标 |
| `computer_app` | 启动程序、文档、文件夹或网址；列出有窗口的应用；按 pid 结束进程 |
| `computer_clipboard` | 读/写剪贴板文本 |
| `screen_record` | 录屏：`start` 采样帧（默认 6fps，最长 30s），`stop` 合成 GIF，`status` 看进度 |
| `browser_open` | 启动 Google Chrome（缺失时用 Edge）并可选打开网址（保留登录状态，可 `fresh_profile`） |
| `browser_snapshot` | 把当前页面转成带 `[ref=eN]` 的文本树，并附上最近的 console 错误 |
| `browser_act` | 点击、双击、悬停、填写、按键、选择下拉、滚动、跳转、后退/前进、刷新、执行 JS、等待、截图、标签页管理、关闭 |

## 工作方式

- 桌面操作由常驻的 `powershell.exe` 工作进程执行（`lib/windows.ps1`），一条 JSON 请求一行响应，
  避免了每次动作重启解释器的数百毫秒开销；DPI 以「每显示器感知」启动，截图坐标即物理像素。
- 截图优先用 `PrintWindow` 抓单个窗口（可抓被遮挡的窗口），失败时回退到屏幕拷贝。
- 文本输入走剪贴板 + `Ctrl+V`，所以中文、emoji、多行文本在任何应用里都可靠。
- 录屏没有 ffmpeg 时直接由插件内置的 GIF89a 编码器（`lib/gif.js`）合成动画 GIF，
  帧文件保留在 `<输出目录>/recordings/<id>/frames/`，方便之后自己转成视频。
- 浏览器使用 `--remote-debugging-port=<随机空闲端口>` 启动真实窗口，再用 CDP 驱动；
  点击是按元素中心派发真实的鼠标事件，并在每次快照时重新分配 `ref`。

## 输出目录

默认 `~/.dsh/computer-use/`（或 `$DSH_HOME/computer-use/`）：

```
shots/        截图
recordings/   录屏（<id>/<id>.gif 与 frames/）
browser/      Chrome/Edge 的用户配置（保留登录）
```

## 配置

插件没有独立的设置页，需要调参时在 profile 的 `cordis.patch.yml` 里覆盖该行：

```yaml
- id: computer-use-windows
  name: '@liuxinye/dsh-computer-use'
  config:
    outputDir: 'D:\dsh-artifacts'
    maxScreenshotWidth: 1600   # 截图长边上限
    jpegQuality: 82
    attachScreenshots: true    # 模型支持图片输入时把截图作为图像一并返回
    recordFps: 6
    recordMaxSeconds: 30
    recordMaxWidth: 960
    snapshotMaxChars: 12000
    browser: auto              # auto（优先 Chrome，回退 Edge）| chrome | edge
    browserExecutable: null    # 自定义 chrome.exe / msedge.exe 路径
    headless: false            # true 时该 profile 的浏览器默认不弹窗
    browserWidth: 1440
    browserHeight: 900
    browserArgs: []
    commandTimeoutMs: 30000
```

## 限制与注意事项

- 只能操作当前用户会话里的普通窗口；管理员权限窗口（UAC 提权）无法被模拟输入控制。
- `computer_ui` 依赖目标程序实现的 UI Automation；Chromium/Electron 应用只暴露很浅的控件树，
  这类界面请优先用 `browser_*` 工具。
- 录屏在没有 ffmpeg 时产出 GIF（256 色调色板），适合演示与留证，不适合高保真视频。
- 同一时刻只管理一个浏览器会话。
- 插件会把你的屏幕内容写成本地文件，并可能把截图作为图像送给当前模型；
  涉密屏幕请先切换到不支持图片的模型或把 `attachScreenshots` 设为 `false`。

## 安装与卸载

在 DSH 的 **设置 → 插件 → 安装** 里填包名：

```text
@liuxinye/dsh-computer-use
```

命令行等价：

```bash
dsh plugin --profile desktop add @liuxinye/dsh-computer-use
```

### 从源码链接（开发调试）

```bash
dsh plugin --profile desktop add "link:/绝对路径/computer-use"
```

链接式安装时，修改源码后若 profile 的 `hmr.root` 已包含本目录，插件会自动热重载；否则重启 DSH 生效。
