# 上游只读代码

`bilibili/src/{config,http,wbi}.ts` 原样来自 Gsxcheng/Bilibili-Agent-mcp，提交 `acbba19130d755a0cb5c4c3bf0cc93192904e5bd`。保留同目录 LICENSE（MIT，含 Bilibili-Evolved 声明）。应用不注册或调用写入、下载方法，配置始终 `allowWrite=false`；调用通过有界超时和错误脱敏包装。

网易云只读请求映射参考 Vael-KY/netease-music-mcp `7a9344bd2839b10451e9a8cbe7b4c8d6271a608e` 及 api-enhanced `984cc021b8598cf94c22134f32a8426887fb2de7`，修正 score/播放次数与最近列表语义。相关 MIT 通知见 `netease-*` 目录。生产服务使用已实现的只读请求封装，api-enhanced作为协议参考，不需要额外托管侧车。
