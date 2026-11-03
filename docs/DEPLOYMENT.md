# 部署与本机配置

## 1. 环境与源码

Node.js 24（至少24.13）、Python 3。Windows工具需要.NET 10。先克隆仓库；公开源码不会包含可用的平台凭据或预先绑定的个人站点。

```powershell
npm ci --prefix apps/mcp-gateway
npm run verify --prefix apps/mcp-gateway
```

## 2. 创建自己的私有Sites项目

在具备Sites能力的agent中读取当前Sites技能，选用本仓库的`apps/mcp-gateway`源码。首次部署时没有project_id，应创建自己的私有项目，并使用返回的精确ID。保留D1绑定`DB`与MCP能力；不要使用其他人的站点或扩大访问范围。使用当前技能指定的源码与发布流程，生产构建命令为`npm run build`。

取得自己项目的真实ID和生成的HTTPS站点地址后，在仓库根目录运行：

```powershell
python scripts/configure-deployment.py --project-id YOUR_ACTUAL_PROJECT_ID --site-origin https://YOUR_SITE.chatgpt.site
```

脚本只写入非敏感部署标识和本地配置，替换代码中明确的占位符，并设置`.openai/hosting.json`。它保留采集器的站点/项目匹配检查。修改站点时可再次运行。请在构建登录工具和采集器前配置；不要把自己的部署标识修改混入公共功能PR。

自定义域名目前不受该配置脚本支持；先使用Sites提供的`chatgpt.site`地址。没有Sites能力时可进行本机测试，但不能把本机预览当作已部署的远程服务。

## 3. 配置云端Secret

| 配置 | 用途 |
| --- | --- |
| `PMA_CURSOR_KEY` | 至少32字符的分页/确认令牌签名密钥 |
| `PMA_INGEST_TOKEN` | 弹弹play独立上传密钥 |
| `PMA_BILI_INGEST_TOKEN` | B站独立上传密钥 |
| `PMA_REFRESH_TOKEN` | 可选，仅允许指定设备刷新Steam/网易云白名单缓存 |
| `PMA_INGEST_DEVICE_ID` | 与本机配置一致的设备ID |
| `STEAM_API_KEY`、`STEAM_ID` | Steam官方API与自己的SteamID64 |
| `BILIBILI_COOKIE` | 自己授权的只读B站访问会话；本机采集另从自己的DPAPI读取 |
| `NETEASE_COOKIE`、`NETEASE_UID` | 自己授权的网易云会话与UID |

密钥可在本机用`python -c "import secrets; print(secrets.token_urlsafe(32))"`生成。应直接写入平台Secret管理能力，不要粘贴到公开讨论、源码、命令行参数或日志。环境更新后需重新部署，检查运行时生效状态。所有平台凭据均按Secret保存。

## 4. 构建Windows工具

在仓库根目录执行，输出为依赖.NET运行时的程序：

```powershell
dotnet publish collectors/dandanplay/Pma.DandanCollector.csproj -c Release -r win-x64 --self-contained false -o outputs/dandanplay-collector
dotnet publish collectors/launcher/Pma.CollectorLauncher.csproj -c Release -r win-x64 --self-contained false -o outputs/dandanplay-collector
dotnet publish collectors/login/Pma.LoginHelper.csproj -c Release -r win-x64 --self-contained false -o outputs/platform-login
dotnet publish collectors/bilibili-launcher/Pma.BilibiliLauncher.csproj -c Release -r win-x64 --self-contained false -o outputs/bilibili-collector
npm run build:collector --prefix apps/mcp-gateway
```

使用`outputs/platform-login/Pma.LoginHelper.exe --workspace <仓库绝对路径>`扫码，手机确认由账号所有者完成。Steam可使用`scripts/setup-steam.ps1`的本地安全窗口。结果保存为`.local/*-setup.dpapi`，仅当前Windows用户能解密。不要读取其他应用的浏览器Cookie，不要在聊天中索要凭据。

## 5. 配置本机上传

从自己Sites项目的受支持服务访问能力取得Sites访问令牌。它不能替代应用的独立上传密钥。使用采集器的`setup`隐藏输入模式配置DPAPI文件：

```powershell
outputs/dandanplay-collector/Pma.DandanCollector.exe setup --credentials .local/dandanplay.dpapi
```

隐藏输入的JSON形状如下。占位符不能直接使用，应在本机安全输入或由agent通过隐藏stdin注入真实值：

```json
{
  "endpoint": "https://YOUR_SITE.chatgpt.site/api/ingest/dandanplay",
  "device_id": "YOUR_DEVICE_ID",
  "ingest_token": "YOUR_INDEPENDENT_UPLOAD_SECRET",
  "sites_token": "YOUR_SITES_SERVICE_ACCESS_TOKEN"
}
```

B站使用`.local/bilibili-collector.dpapi`、`/api/ingest/bilibili`与独立B站上传密钥；云端刷新使用`.local/cloud-refresh.dpapi`、`/api/refresh-platform`与独立刷新密钥。都通过同一`setup --credentials`方式封存，不共享不同用途的密钥。

初次验证可运行：

```powershell
outputs/dandanplay-collector/Pma.DandanCollector.exe sync --credentials .local/dandanplay.dpapi --state .local/dandanplay
./scripts/sync-bilibili-local.ps1
./scripts/refresh-cloud-platform.ps1 -Platform netease -Dataset playlists
./scripts/refresh-cloud-platform.ps1 -Platform netease -Dataset playlist_tracks
./scripts/refresh-cloud-platform.ps1 -Platform netease -Dataset listening_stats
```

弹弹play默认从当前用户AppData目录读取LiteDB的一致副本，不能修改源库。首次同步后核对计数、时间、覆盖范围和错误码；只用合成数据测试删除。若明确需要自动同步，再使用对应`install-*-startup/sync`脚本注册计划任务，并分别验证重启触发。

## 6. MCP与限制验收

发布后使用Sites为自己创建的Personal Media Assistant插件，检查健康、同步状态、覆盖范围和少量记录。新聊天可能需要重新加载工具清单。私有网页登录应使用自己的正常账号认证，不伪造用户身份头。

Steam成就通过`steam_get_achievements({app_id,refresh:true})`按游戏读取；字幕通过`bilibili_get_subtitles`按需排队，本机同步时接收。电脑离线只能查询已上传的数据。年度足迹、时长单位、字幕及作品关系的边界见[数据语义](DATA_SEMANTICS.md)。
