using QRCoder;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        if ("appgprj_REPLACE_ME".EndsWith("REPLACE_ME")) { MessageBox.Show("请先运行 scripts/configure-deployment.py 配置自己的私有站点。", "需要部署配置"); return; }
        ApplicationConfiguration.Initialize();
        int index = Array.IndexOf(args, "--workspace");
        string workspace = Path.GetFullPath(index >= 0 && index + 1 < args.Length ? args[index + 1] : Path.Combine(AppContext.BaseDirectory, "..", ".."));
        Application.Run(new LoginForm(workspace));
    }
}
internal sealed class LoginForm : Form
{
    private readonly ComboBox platform = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 330 };
    private readonly PictureBox qr = new() { Width = 320, Height = 320, SizeMode = PictureBoxSizeMode.Zoom, BackColor = Color.White };
    private readonly Label status = new() { AutoSize = false, Width = 530, Height = 55, TextAlign = ContentAlignment.MiddleCenter, Text = "选择平台，然后生成登录二维码。" };
    private readonly Button start = new() { Text = "生成登录二维码", Width = 190, Height = 38 };
    private CancellationTokenSource? attempt;
    private readonly string workspace;
    public LoginForm(string workspace)
    {
        this.workspace = workspace;
        Text = "Personal Media Assistant - 平台安全登录"; ClientSize = new Size(590, 675); StartPosition = FormStartPosition.CenterScreen; FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false; Font = new Font("Microsoft YaHei UI", 10);
        var layout = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, Padding = new Padding(28, 20, 20, 15) };
        layout.Controls.Add(new Label { Text = "B站 / 网易云音乐扫码登录", AutoSize = true, Font = new Font(Font, FontStyle.Bold), Margin = new Padding(0, 0, 0, 12) });
        platform.Items.AddRange(["B站", "网易云音乐"]); platform.SelectedIndex = 0; layout.Controls.Add(platform);
        layout.Controls.Add(new Label { Text = "登录用于你的私有Sites后端只读同步。请核对手机上的登录提示。\n凭据先由当前Windows用户加密保存，再导入该站点的Sites Secret。", Width = 530, Height = 62, Margin = new Padding(0, 14, 0, 5) });
        qr.Margin = new Padding(105, 5, 0, 5); layout.Controls.Add(qr); layout.Controls.Add(status);
        start.Margin = new Padding(170, 0, 0, 10); start.Click += async (_, _) => await BeginLogin(); layout.Controls.Add(start);
        layout.Controls.Add(new Label { Text = "目标：your-site.example.invalid\n无需把Cookie、密码或验证码发到聊天。", Width = 530, Height = 48, ForeColor = Color.DimGray });
        Controls.Add(layout); platform.SelectedIndexChanged += (_, _) => { attempt?.Cancel(); qr.Image?.Dispose(); qr.Image = null; status.Text = "选择平台，然后生成登录二维码。"; };
        FormClosing += (_, _) => attempt?.Cancel();
    }
    private async Task BeginLogin()
    {
        attempt?.Cancel(); attempt?.Dispose(); attempt = new CancellationTokenSource(TimeSpan.FromMinutes(3));
        var token = attempt.Token; string provider = platform.SelectedIndex == 0 ? "bilibili" : "netease";
        start.Enabled = false; platform.Enabled = false; status.Text = "正在请求平台登录二维码…";
        try
        {
            using var login = new PlatformLogin(provider); string url = await login.Generate(token);
            using var generator = new QRCodeGenerator(); using var data = generator.CreateQrCode(url, QRCodeGenerator.ECCLevel.M); using var image = new PngByteQRCode(data); using var stream = new MemoryStream(image.GetGraphic(8));
            qr.Image?.Dispose(); using var decoded = Image.FromStream(stream); qr.Image = new Bitmap(decoded);
            status.Text = provider == "bilibili" ? "请使用B站App扫码，并在手机确认登录。" : "请使用网易云音乐App扫码，并在手机确认登录。";
            while (!token.IsCancellationRequested)
            {
                await Task.Delay(3000, token); var result = await login.Poll(token); status.Text = result.Status;
                if (result.Entries is null) continue;
                Save(provider, result.Entries); qr.Image?.Dispose(); qr.Image = null;
                status.Text = "登录成功，配置已加密保存。\n请回到你的agent说“" + (provider == "bilibili" ? "B站" : "网易云") + "登录已完成”。"; break;
            }
        }
        catch (OperationCanceledException) { if (!IsDisposed) status.Text = "本次登录已取消或超时，可重新生成二维码。"; }
        catch (Exception error) { if (!IsDisposed) status.Text = "登录未完成：" + (error is LoginFailure failure ? failure.Code : "LOGIN_REQUEST_FAILED") + "。\n可重新生成；若有验证，请在平台App完成。"; }
        finally { if (!IsDisposed) { start.Enabled = true; platform.Enabled = true; } }
    }
    private void Save(string provider, Dictionary<string, string> entries)
    {
        string destination = Path.Combine(workspace, ".local", provider + "-setup.dpapi"); Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
        byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(new { schema_version = "1.0", project_id = "appgprj_REPLACE_ME", created_at = DateTimeOffset.UtcNow, entries });
        try { byte[] encrypted = ProtectedData.Protect(bytes, Encoding.UTF8.GetBytes("PersonalMediaAssistant/platform-setup/v1"), DataProtectionScope.CurrentUser); File.WriteAllBytes(destination + ".tmp", encrypted); File.Move(destination + ".tmp", destination, true); }
        finally { CryptographicOperations.ZeroMemory(bytes); entries.Clear(); }
    }
}
