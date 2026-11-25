---
name: Grok Bot 换背景
description: use this when the user uploads an image and wants to change the Grok Bot desktop app background, wallpaper, or skin.
---

# Grok Bot 换背景

当用户上传图片，希望更换 Mac 上 Grok Bot 桌面应用背景、壁纸或皮肤时使用。官方设置只有 Light/Dark/Accent，没有壁纸 API。本技能通过本机 Electron 调试连接添加临时页面覆盖层。

## 硬规则

- 不修改官方 `Grok Bot.app`、`app.asar` 或签名。
- 不发布图片，不上传到图床，不删除用户原图。仅保存上传附件，以及为本机使用所需的副本。
- 调试端口仅使用 `127.0.0.1:19222`，面板助手仅绑定 `127.0.0.1:19223`。不得绑定公网地址或转发这两个端口。
- 未经用户确认，不得退出或重启 Grok Bot。请求换背景本身不代表同意重启；重启会关闭当前聊天窗口。
- 助手在应用已经带着本机调试口运行时只注入，不退出。应用若从 Dock 等入口打开且没有 `127.0.0.1:19222`，已安装的 `watch` 可以做一次 AppleScript 正常退出并重新打开。这一次失败就停止：不发 SIGTERM 或 SIGKILL，不连着再退，60 秒内不第二次，24 小时内自动失败满 3 次后停止自动退出。
- 不要用 cron、`launchd` 日历、`StartInterval` 或定时轮询冒充“应用打开了”。`watch` 只听系统的应用启动/退出通知，以及调试连接上的导航、加载和新窗口事件。
- `status` 不能证明壁纸正显示在画面上。`running`、`debug`、`panel`、`lastApplied` 都只说明进程和记录，不说明图片可见。
- 同一时间只能有一个助手监听 `127.0.0.1:19223`。旧版助手不会交接；先停掉旧进程，再启动新助手。不要为了抢端口结束进程。
- 用户要求恢复时，运行 `restore`，不要再次应用壁纸或擅自重启。

## 操作步骤

1. 将上传图片保存为本地文件，支持 PNG、JPG、JPEG、WebP。保留原文件。
2. 所有应用命令必须在用户的 Mac 上执行，要求 Node.js 22+。如果助手运行在远程机器，使用已获授权的文件传输方式把图片与本技能的 helper 复制到用户 Mac；没有 Mac 连接时提供命令让用户执行，不要在远程机器连接调试端口，也不要建立端口转发。
3. Helper 位于本技能旁的相对路径 [`scripts/grokbot-wallpaper.mjs`](scripts/grokbot-wallpaper.mjs)。在技能目录运行，含空格的路径必须加引号：

   ```bash
   node scripts/grokbot-wallpaper.mjs status
   node scripts/grokbot-wallpaper.mjs apply "/absolute/path/photo.png" --opacity 0.9 --dark
   ```

   `--light` 可改用浅色外观；默认深色。透明度参数限制在 0.15–1，默认 0.9，数值越大照片越明显。超过 4MB 的图片会尝试用 macOS `sips` 缩小为 JPEG，仍过大或工具不可用时会拒绝。副本为 `~/Library/Application Support/grokbot-wallpaper/current.<扩展名>`。
4. 如果 CLI 因调试端口未开启而以状态码 2 退出，向用户解释：“第一次换背景需要重启一次 Grok Bot，开启仅本机可用的调试端口。重启会关闭当前聊天窗口，请先保存当前工作。”取得重启确认后，才可执行：

   ```bash
   node scripts/grokbot-wallpaper.mjs apply "/absolute/path/photo.png" --opacity 0.9 --dark --relaunch
   ```

   如果用户已明确确认本次重启，无需重复询问。端口已经开启时 helper 只注入，不退出应用。不要用额外的退出命令绕过此边界。

判断应用是否在运行时不要用 `pgrep -x "Grok Bot"`，改用 osascript 或 `ps` 匹配主程序路径。重启时用 `open -a` 传 `--args`，不要直接启动主二进制，以免 Launch Services 再拉起一份并丢掉调试参数。`--relaunch` 也只正常退出一次；应用没退出就停，不要强制结束。
5. 以 CLI 成功结果为依据报告：给出实际应用图片的绝对路径，并说明“这是本机覆盖层，不是官方主题”。透明度与深浅按这次参数和 `last-applied.json` 保留，不要改成另一套数值。登录后只会启动助手，不会自行打开 Grok Bot；用户打开应用时，助手才恢复上次的图片。聊天切换、返回、重新加载和新窗口靠页面事件补上覆盖层，不是靠定时复查。应用成功后右下角有悬浮面板。助手保存到 `~/Library/Application Support/grokbot-wallpaper/`。`status` 里的 `panel` 为 true 只表示助手在听端口。页面透明化使用运行时几何与背景颜色判断，不能保证每个应用版本布局都完美；若显示不合适，调整透明度或恢复，不修改官方文件。

## 恢复

在同一台 Mac、同一用户下执行：

```bash
node scripts/grokbot-wallpaper.mjs restore
```

Helper 移除当前页面的壁纸层与样式，恢复记录过的内联背景属性，并移除记录的重载注入脚本；成功后将 `last-applied.json` 标记为已恢复。原图与缓存副本保留。若调试端口已关闭，明确说明无法验证或修改当前窗口，不声称已恢复；用户手动完全退出应用也会清除进程内覆盖层。恢复失败时报告错误，不擅自重启。

安全提示：回环调试端口允许同一台电脑上的其他进程访问 Grok Bot 窗口；保持绑定 `127.0.0.1`，不要转发端口。
