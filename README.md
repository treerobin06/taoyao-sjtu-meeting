# SJTU 云视频会议工具箱

[meeting.sjtu.edu.cn](https://meeting.sjtu.edu.cn/) 的批量管理油猴脚本。给一学期要开几十场重复会议的课题组用——一次配预设、一次建一整学期，每天 3 秒把当天邀请发到群里。

## 功能

- **📅 批量创建**：任务行 = 一组重复会议（主题+星期+时间+日期范围），逐个提交，可中途取消/跨页面恢复
- **📋 列表与导出**：扫描页面表格 → 主题/日期/今天/明天筛选 → snapshot 提取 / 含 `meeting.tencent.com` 入会链接（首次抓取后缓存）/ ICS 下载 / 自定义模板
- **📦 预设 + tag**：保存任务行为预设、打 tag（"本学期"、"组会"…），按 tag 一键加载全部到任务列表
- **🗑 回收站**：删除前自动归档完整邀请文本

## 安装

本工具箱是一个**油猴脚本**（user script），需要先装一个浏览器扩展来加载它。最常用的是 **Tampermonkey**（油猴）——一个能给指定网页注入自定义 JS 的扩展，详见 [tampermonkey.net](https://www.tampermonkey.net/)。

1. 装 Tampermonkey：[Edge](https://microsoftedge.microsoft.com/addons/detail/iikmkjmpaadaobahmlepeloendndfphd) / [Chrome](https://chrome.google.com/webstore/detail/dhdgffkkebhmkfjojejmpbldmpobfkfo) / [Firefox](https://addons.mozilla.org/firefox/addon/tampermonkey/) / [Safari](https://apps.apple.com/app/tampermonkey/id1482490089)
2. Chrome/Edge 在 `chrome://extensions/` 或 `edge://extensions/` 打开"开发者模式"（Tampermonkey 加载 user script 需要）
3. 点链接装脚本：**[sjtu-meeting-toolkit.user.js](https://github.com/treerobin06/taoyao-sjtu-meeting/raw/main/sjtu-meeting-toolkit.user.js)** → Tampermonkey 弹窗确认安装
4. 打开 [my-meeting](https://meeting.sjtu.edu.cn/my-meeting)，登录后右下角应出现 🎯 圆形按钮

## 典型工作流

**学期初一次性建一整学期**：顶部学期范围设起点+周数 → 📦 tab 给预设打 "本学期" tag → 按 tag 加载全部 → 📅 tab 预览 → 开始批量创建。

**每天发邀请到群**：📋 tab → 📅 今天 → 🔗 含入会链接（首次每条 ~3s，之后秒级缓存命中）→ 文本已复制到剪贴板。

**临时删除**：📋 tab 筛选勾选 → 🗑 删除选中（走页面原生批量删除 API，秒级）→ 删前自动进回收站。

## 关键点

- **数据只在本地 localStorage**，不上传任何外部服务器
- 批量创建默认操作间隔 3 秒防 SJTU 风控，不建议 <2s
- "含入会链接"首次慢是因为邀请文本只在详情对话框里，脚本要模拟点开→抓取→关闭；之后走 localStorage 缓存
- 默认密码 `000000`、默认联席 jAccount 在顶部配置区，可一键"批量补到所有预设"
- 误删无法从 SJTU 恢复，但回收站留有完整邀请文本可重建

## 输出模板占位符

```
{topic} {time} {date} {hm} {duration} {code} {pwd} {link} {invite}
```

在 📋 tab "🎨 模板" 栏写自定义文本，留空则用默认 snapshot 格式。

## License & 作者

MIT。作者 [@tree06](https://github.com/treerobin06)，与 Claude Code 协作开发。Issues / PR 欢迎。
