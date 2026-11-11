# AutoDL Companion 0.2.0

Windows 桌面版 AutoDL 候补助手。支持已有实例自动开机，以及新建实例、同地区克隆工作台。每个人在自己的电脑上登录、保存任务，不集中保管账号。

![新建与克隆工作台（未登录的本地界面）](docs/rent-workspace.png)

## 下载

在 [Releases](https://github.com/lxuetl/autoautodl/releases) 下载 Windows 便携 EXE，直接运行即可，并可用同页的 SHA256SUMS.txt 校验。当前版本标为预发布测试版。便携程序未签名，Windows 可能显示来源提示。

开发构建也可从 [Build Windows](https://github.com/lxuetl/autoautodl/actions/workflows/windows.yml) 下载 windows-portable，产物保留 7 天。维护者推送 v 开头的版本标签时会自动测试、构建并发布到 Releases。

## 新建与克隆

1. 桌面应用选择“租机候补”，点击“打开新建与克隆工作台”。
2. 点击“打开登录”，在专用浏览器自行登录 AutoDL，返回工作台点击“检查登录状态”。验证码需自行完成。
3. 同步官方 GPU 型号与镜像，选择 GPU、卡数、地区和框架 / 版本 / Python 与系统 / CUDA 四级镜像。
4. 先选择“只通知”，或明确勾选费用授权后启用自动创建。提交前重新核对库存与费用，提交后对账；结果不明时停在待核实，避免重复创建。
5. 克隆任务选择同地区已关机的源实例，可复制数据盘并更换 GPU。源实例受只读保护，克隆后仍需检查目标实例中的数据是否完整。

工作台提供任务暂停与恢复、超时、重复任务检测、主机冷却、桌面提醒，以及可选的微信 / Webhook 通知和 AI 环境选卡。外部通知和 AI 需用户自行填写并启用服务凭据，不配置也可使用候补功能。

工作台有独立浏览器会话，与主窗口的开机账号分别登录、退出。两者可能登录不同账号，授权计费前请核对。主窗口“退出开机账号”不会退出工作台，请在工作台单独“退出 AutoDL”。

关闭工作台窗口后任务继续运行。退出桌面应用会等待任务引擎与专用浏览器安全关闭。电脑休眠或断网时无法持续候补。

## 已有实例自动开机

在主窗口登录开机账号，刷新列表，选择目标实例并开启“监控并自动开机”。默认每 45 秒检查目标主机空闲 GPU，卡数满足时提交一次有卡开机；结果不明时需核实后再解除锁定。

![主窗口（虚构演示数据）](docs/preview.png)

## 多人使用与存储

每位用户在自己的 Windows 账号下运行客户端。现阶段没有共享服务器、组织权限或同一客户端多账号协作。

- 主窗口 Token 存在 Electron userData 的 profile.json，使用 Windows DPAPI 加密。
- 工作台任务、日志、浏览器会话在 userData 下 rent-workspace/。浏览器会话由浏览器保存，不要将整个目录视为加密备份，不要分享该目录。
- 本地服务只绑定随机 127.0.0.1 端口，校验本地请求和访问令牌。不要将该端口代理到公网。
- 外部服务 Key 与通知凭据可选择记住，以 Windows DPAPI 加密保存。

## 开发与构建

需要 Node.js 22+。专用浏览器优先使用 Playwright Chromium，缺失时尝试本机 Edge；没有 Edge 时可运行 npx playwright install chromium。

```powershell
npm ci
npm test
npm start
# 虚构实例演示，不访问 AutoDL
npm run demo
# 输出 Windows 便携 EXE 到 release/
npm run dist
```

## 验证与引用

当前 357 项测试通过，涵盖已有实例判断、工作台回环绑定和访问令牌、新建与克隆、费用限制、提交与对账、重启恢复、凭据处理等。另检查桌面与打包程序的无账号启动。此集成版尚未使用真实账号验证新建、克隆或计费开机，上游实测记录不能当作本版本的实测。

工作台集成 [cc2025cheng/Stop-Manually-Refreshing-AutoDL-GPU](https://github.com/cc2025cheng/Stop-Manually-Refreshing-AutoDL-GPU) 的 MIT 源码、界面与测试，保留许可证，详见 [第三方说明](THIRD_PARTY_NOTICES.md)。本项目增加 Electron 窗口、随机回环服务与退出处理。

已有实例开机模块参考 [CrazyAutoDL](https://github.com/A2ureeE/CrazyAutoDL) 的功能与接口方式，未复制源码。该模块使用非官方公开的网页端接口；新建与克隆工作台通过专用浏览器操作页面。两者可能因 AutoDL 改版失效，也不能保证平台允许自动化或账号不会被限制。
