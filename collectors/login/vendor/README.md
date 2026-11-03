# 平台登录工具依赖与来源

- 登录协议参考 `@xzxzzx/bilibili-mcp` 1.14.6 的 `dist/bilibili/qr-login.js`。当前二维码主机和轮询状态以安装包源码及真实登录响应为准。相关修改为本项目独立的WinForms界面、域名限制、Cookie白名单和CurrentUser DPAPI保存；保留Apache-2.0许可于 `bilibili-mcp.LICENSE`。上游项目为 https://github.com/XZXZZX-Ai/bilibili-mcp 。
- 网易云二维码、账号读取及weapi/eapi协议参考此前已核查的 api-enhanced 模块与加密代码（提交 `984cc021b8598cf94c22134f32a8426887fb2de7`）；保留MIT许可于 `netease-api.LICENSE`。协议路径和状态不构成用户凭据。
- QRCoder 1.6.0 用于在本机生成二维码，NuGet声明MIT许可，仓库提交 `bd980577640c47f8bb881cf24c8443415a579d36`；许可见 `QRCoder.LICENSE`。二维码内容不发送给远程图片服务。

本目录不包含平台实际登录态。登录成功后的Cookie只进入当前用户的加密本地文件，之后通过Sites原生Secret接口配置到已绑定的私有站点。
