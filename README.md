# Personal Media Assistant

一套长期运行、可扩展、支持多设备访问的个人数字兴趣助手。

本项目旨在让 ChatGPT 结合跨平台的真实行为记录、长期个人偏好与主观评价，为用户提供个性化内容推荐、兴趣分析、作品探索和历史查询。

项目也希望让这些数据自然融入日常聊天：在用户授权并启用相应连接后，ChatGPT 能根据话题需要，按需主动查询相关记录，给出更贴合个人经历与偏好的回答。

本仓库发布的是 **0.7.1 开源模板**，使用 MIT 许可证。每位部署者使用自己的私有站点、数据库和凭据。

## 已实现

| 平台/模块 | 能力 |
| --- | --- |
| Steam | 官方 API 游戏库、近期游玩、累计时长、按游戏读取成就；每日累计样本与区间增量；核验官方游戏→原声应用关系 |
| Bilibili | 本机读取并上传历史、收藏夹、收藏、最近点赞/投币、稍后再看、关注UP；按需读取指定分P与语言的字幕 |
| 网易云音乐 | 红心、最近列表、全部时间/本周排行、歌单目录与完整曲目、歌词片段、周/月/总量及年度足迹 |
| 弹弹play | 只读 LiteDB 副本，提取关注、完成/放弃状态、个人评分、评论和分集最后观看观察 |
| 跨平台 | 37个 MCP 工具、兴趣事实摘要、作品候选关联、时间轴、推荐反馈、私有JSONL导出与删除/暂停/恢复 |

前端和后端位于 `apps/mcp-gateway`，使用 ChatGPT Sites Worker 与 D1。Windows 本机采集器只主动发起 HTTPS 请求，不开放本地端口。Steam与网易云在云端读取，B站采用本机同步路径，弹弹play只读本地数据。根目录 `src` 是 SQLite 参考原型，不是生产服务。

## 重要边界

- 数据仅覆盖平台实际提供的窗口，不承诺完整历史或“绝对没看过”。
- 全成就不等于剧情通关，累计时长不等于完整游戏会话。
- B站云端实时搜索/视频推荐可能受风控限制。本机同步成功不代表云端实时推荐恢复。
- 网易云最近列表不是已经证实的逐次播放事件。时长默认推定：周/月为分钟，总量/年度为秒；保留原值和 `inferred_user_accepted` 标记，可按实际接口证据调整。
- 标题相似只生成候选；Steam官方归属与相同网易云专辑ID分别保留证据，不自动确认跨平台OST对应关系。
- 游戏、音乐、动画的完整个性化推荐尚未实现。服务不直接读取或写入 ChatGPT Memory，也不替代 Notion。

## 安装

把以下内容发送给你的agent：

```text
请帮我安装并配置这个开源项目：
https://github.com/xiongyuhang1/PersonalMediaAssistant

先阅读README、docs/DEPLOYMENT.md、docs/DATA_SEMANTICS.md和SECURITY.md，再检查我的系统与账号实际具备的部署能力，按最合适的方案完成安装，不要只给我一份计划。

请克隆源码，安装依赖并运行测试；如我具备ChatGPT Sites能力，创建我自己的私有站点和D1数据库，使用项目返回的真实ID和地址配置模板、构建并发布。没有托管能力时先完成本机验证，并说明哪些步骤还缺条件，不要擅自购买服务器。

在我的Windows电脑上构建并配置需要的采集和扫码工具。平台登录、手机确认和Steam API Key由我在官方页面或本机安全窗口完成；不要让我在聊天里发送Cookie、密码、验证码或密钥。只读来源数据，不修改平台账号或原始数据库，只同步必要的结构化记录。

最后验证服务健康、同步状态、数据覆盖范围和少量真实查询，保留时间和单位的真实含义；不能读取或受平台限制的功能明确说明。不要用我的真实数据测试删除，不要把私人配置、记录或截图提交到GitHub。完成后告诉我如何在ChatGPT里使用，以及哪些验证仍需要我操作。
```

需要 Node.js 24（至少24.13）、Python 3；Windows 采集/扫码工具另需 .NET 10 SDK/运行时。GitHub 的公开代码不会自动提供 Sites 托管或平台账号授权；部署能力以你的账号实际可用功能为准。

```powershell
git clone https://github.com/xiongyuhang1/PersonalMediaAssistant.git
cd PersonalMediaAssistant
npm ci --prefix apps/mcp-gateway
npm run verify --prefix apps/mcp-gateway
```

先按 [部署说明](docs/DEPLOYMENT.md) 创建自己的私有 Sites 项目，再绑定自己的项目ID和HTTPS站点地址：

```powershell
python scripts/configure-deployment.py --project-id YOUR_ACTUAL_PROJECT_ID --site-origin https://YOUR_SITE.chatgpt.site
```

此命令只填入部署标识，不接收密码或Cookie。必须在构建、扫码登录和采集器配置前运行。占位地址使用不可访问的 `.invalid` 域名；请勿直接运行未配置的采集流程。

随后在 Sites Secret 中配置各平台凭据，构建采集器，并通过隐藏输入保存当前Windows用户的DPAPI配置。详见 [部署说明](docs/DEPLOYMENT.md)、[数据语义](docs/DATA_SEMANTICS.md)。不要把实际凭据、配置、导出文件或截图提交到Git。

## 测试与构建

```powershell
# Worker/D1/MCP：类型检查及79项隔离服务端测试
npm run verify --prefix apps/mcp-gateway

# Web/Worker生产构建
npm run build --prefix apps/mcp-gateway

# 根目录SQLite参考原型
npm ci
npm test

# 本机B站采集器（先安装apps/mcp-gateway依赖）
npm run build:collector --prefix apps/mcp-gateway
```

服务端测试使用合成数据与内存SQLite，不连接真实账号，也不删除真实数据。Windows采集器构建方式见部署说明。可选的[GitHub Actions模板](docs/ci.example.yml)可在具有工作流写入权限时放到`.github/workflows/ci.yml`。

## 目录

```text
apps/mcp-gateway/  Sites前端、Worker、D1迁移、MCP与测试
collectors/        Windows只读采集器、扫码工具与无窗口启动器
scripts/           配置、构建、同步与诊断脚本
src/ test/         SQLite参考原型与测试
vendor/            必要的第三方适配代码及许可证
docs/              公共部署说明和数据语义
```

欢迎通过 Issue 报告可复现的问题，通过 Pull Request 提交改进。请只附脱敏错误码和合成样例，参见 [安全说明](SECURITY.md)。原始代码使用 [MIT](LICENSE)，第三方代码保留各自的许可和署名，见 [第三方说明](THIRD_PARTY_NOTICES.md)。
