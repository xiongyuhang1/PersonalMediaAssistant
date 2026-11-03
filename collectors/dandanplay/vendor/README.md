# LiteDB 兼容性

本机活动日志在 .NET 10 + LiteDB 5.0.17 的 ReadOnly Dispose 中触发 checkpoint，产生不可写流异常；播放器附带的同版本组件也复现。正式采集器使用固定 NuGet 5.0.17 包。

源数据库与日志仅通过 `FileAccess.Read` 打开，按稳定指纹生成私有临时副本；只在副本上恢复日志并读表。归一化后删除副本，读前后再次比对源主库和日志。原库不执行 checkpoint、迁移、建索引或写入，原始副本不上传云端。

LiteDB 是 MIT 许可；上游为 https://github.com/litedb-org/LiteDB 。许可文件来自所使用的 NuGet 包。本版本针对已核查的LiteDB缓存格式；源格式变化时须重新验证。
