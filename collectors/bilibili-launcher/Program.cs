using System.Diagnostics;
string root=Path.GetFullPath(Path.Combine(AppContext.BaseDirectory,"..",".."));
string script=Path.Combine(root,"scripts","sync-bilibili-local.ps1"),state=Path.Combine(root,".local","bilibili");
if(!File.Exists(script))return 1;
Directory.CreateDirectory(state);string log=Path.Combine(state,"collector.log");
if(File.Exists(log)&&new FileInfo(log).Length>1024*1024)File.Move(log,log+".previous",true);
var start=new ProcessStartInfo("powershell.exe"){UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true,WorkingDirectory=root};
foreach(string arg in new[]{"-NoProfile","-NonInteractive","-WindowStyle","Hidden","-File",script})start.ArgumentList.Add(arg);
using var child=Process.Start(start);if(child is null)return 1;
using var output=new StreamWriter(new FileStream(log,FileMode.Append,FileAccess.Write,FileShare.Read)){AutoFlush=true};var gate=new SemaphoreSlim(1,1);
async Task Pump(StreamReader reader){while(await reader.ReadLineAsync() is string line){await gate.WaitAsync();try{await output.WriteLineAsync(line);}finally{gate.Release();}}}
await Task.WhenAll(Pump(child.StandardOutput),Pump(child.StandardError),child.WaitForExitAsync());return child.ExitCode;
