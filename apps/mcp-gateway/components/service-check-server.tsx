export function ServiceCheck({ checked, completed }: { checked: boolean; completed: number | null }) {
  const ok = checked && completed !== null;
  return <div className="service-check">
    <h3>连接与备份</h3><p>用当前账号检查服务，也可以下载自己的已同步记录。</p>
    <div className="tool-actions"><form action="/#records" method="get"><button type="submit" name="check" value="1">检查服务连接</button></form><a href="/api/export">导出记录（JSONL） ↗</a></div>
    <p role="status" className={ok ? 'check-result good' : 'check-result'}>{ok ? `服务查询正常，关注且已看完 ${completed} 部。` : checked ? '已连接，弹弹play尚未完成首次同步。' : '检查当前账号能否查询已同步数据。'}</p>
    <p className="tool-note">导出包含记录、显式反馈与Steam时长样本；大数据量按文件末行提供的链接继续下载。ChatGPT 中可输入 @Personal Media Assistant 选择插件。</p>
  </div>;
}
