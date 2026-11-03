using System.Diagnostics;

string executable = Path.Combine(AppContext.BaseDirectory, "Pma.DandanCollector.exe");
if (!File.Exists(executable)) return 1;
int stateIndex = Array.IndexOf(args, "--state");
string state = stateIndex >= 0 && stateIndex + 1 < args.Length ? Path.GetFullPath(args[stateIndex + 1]) : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PersonalMediaAssistant");
Directory.CreateDirectory(state);
string logPath = Path.Combine(state, "collector.log");
if (File.Exists(logPath) && new FileInfo(logPath).Length > 1024 * 1024) File.Move(logPath, logPath + ".previous", true);
var start = new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true, WorkingDirectory = Environment.CurrentDirectory };
start.ArgumentList.Add("watch");
foreach (string arg in args) start.ArgumentList.Add(arg);
using var process = Process.Start(start);
if (process is null) return 1;
using var stream = new FileStream(logPath, FileMode.Append, FileAccess.Write, FileShare.Read);
using var writer = new StreamWriter(stream) { AutoFlush = true };
var gate = new SemaphoreSlim(1, 1);
async Task Pump(StreamReader input)
{
    while (await input.ReadLineAsync() is string line) { await gate.WaitAsync(); try { await writer.WriteLineAsync(line); } finally { gate.Release(); } }
}
await Task.WhenAll(Pump(process.StandardOutput), Pump(process.StandardError), process.WaitForExitAsync());
return process.ExitCode;
