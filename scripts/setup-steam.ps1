param([switch]$SelfTest)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$workspace = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$destination = Join-Path $workspace '.local\steam-setup.dpapi'
$project = 'appgprj_REPLACE_ME'
$entropy = [System.Text.Encoding]::UTF8.GetBytes('PersonalMediaAssistant/platform-setup/v1')
function Test-SteamInput([string]$Key, [string]$Id) { return ($Key -cmatch '^[a-fA-F0-9]{32}$' -and $Id -cmatch '^7656119[0-9]{10}$') }
if ($SelfTest) {
    if (!(Test-SteamInput ('a' * 32) '76561198000000000') -or (Test-SteamInput 'invalid' '76561198000000000') -or (Test-SteamInput ('a' * 32) 'account-name')) { throw 'INPUT_VALIDATION_FAILED' }
    $sample = [System.Text.Encoding]::UTF8.GetBytes('{"test_only":true}')
    $encrypted = [System.Security.Cryptography.ProtectedData]::Protect($sample,$entropy,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    $decoded = [System.Security.Cryptography.ProtectedData]::Unprotect($encrypted,$entropy,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    if ([Convert]::ToBase64String($sample) -ne [Convert]::ToBase64String($decoded)) { throw 'DPAPI_ROUNDTRIP_FAILED' }
    [Array]::Clear($sample,0,$sample.Length); [Array]::Clear($decoded,0,$decoded.Length)
    Write-Output 'PASS: Steam input validation and CurrentUser DPAPI; no credentials or files created.'
    exit 0
}
if ($project.EndsWith('REPLACE_ME')) { throw 'DEPLOYMENT_CONFIG_REQUIRED' }
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Personal Media Assistant - Steam 安全配置'
$form.ClientSize = New-Object System.Drawing.Size(690,470)
$form.StartPosition = 'CenterScreen'; $form.FormBorderStyle = 'FixedDialog'; $form.MaximizeBox = $false
$form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI',10)
function Add-Label([string]$Text,[int]$Y,[int]$Height=30) {
    $label = New-Object System.Windows.Forms.Label
    $label.Text=$Text; $label.Location=New-Object System.Drawing.Point(24,$Y); $label.Size=New-Object System.Drawing.Size(640,$Height)
    $form.Controls.Add($label)
}
Add-Label '填写你的 Steam Web API Key；密钥会以密码形式显示。' 18
$key = New-Object System.Windows.Forms.TextBox
$key.Location=New-Object System.Drawing.Point(24,55); $key.Size=New-Object System.Drawing.Size(640,30); $key.UseSystemPasswordChar=$true; $key.MaxLength=32
$form.Controls.Add($key)
Add-Label 'SteamID64（17位数字，不是昵称）' 100
$id = New-Object System.Windows.Forms.TextBox
$id.Location=New-Object System.Drawing.Point(24,135); $id.Size=New-Object System.Drawing.Size(640,30); $id.MaxLength=17
$form.Controls.Add($id)
# Read only the current account identifier. Never read game caches or credentials.
try {
    $active=[uint64](Get-ItemProperty -LiteralPath 'HKCU:\Software\Valve\Steam\ActiveProcess' -Name ActiveUser -ErrorAction Stop).ActiveUser
    if ($active -eq 0) { throw 'STEAM_NOT_SIGNED_IN' }
    $id.Text=([uint64]76561197960265728+$active).ToString()
    Add-Label '已填入当前Steam登录账号ID，请确认是要同步的账号。' 175
} catch {
  try {
    $steamRoot=(Get-ItemProperty -LiteralPath 'HKCU:\Software\Valve\Steam' -ErrorAction Stop).SteamPath
    $accountsPath=Join-Path $steamRoot 'config\loginusers.vdf'
    $accounts=[System.IO.File]::ReadAllText($accountsPath)
    $recent=@([regex]::Matches($accounts,'(?ms)^\s*"(?<id>7656119[0-9]{10})"\s*\{(?<body>.*?)^\s*\}') | Where-Object {$_.Groups['body'].Value -match '"MostRecent"\s*"1"'})
    if ($recent.Count -eq 1) { $id.Text=$recent[0].Groups['id'].Value; Add-Label '已填入本机Steam最近账号ID，请确认是要同步的账号。' 175 }
    else { Add-Label '请填写要同步的Steam账号ID；不读取游戏缓存。' 175 }
  } catch { Add-Label '在 Steam 个人资料链接中查找 /profiles/ 后的17位数字。' 175 }
}
$official = New-Object System.Windows.Forms.LinkLabel
$official.Text='打开 Steam 官方密钥申请页'; $official.Location=New-Object System.Drawing.Point(24,217); $official.AutoSize=$true
$official.Add_LinkClicked({ Start-Process 'https://steamcommunity.com/dev/apikey' })
$form.Controls.Add($official)
Add-Label "申请页域名：your-site.example.invalid`nSteam 条款、登录和手机确认请自行完成。" 250 55
$consent = New-Object System.Windows.Forms.CheckBox
$consent.Text='允许将这两个配置导入我的私有站点 Sites Secret，用于只读同步。'
$consent.Location=New-Object System.Drawing.Point(24,320); $consent.Size=New-Object System.Drawing.Size(645,32)
$form.Controls.Add($consent)
$save = New-Object System.Windows.Forms.Button
$save.Text='加密保存配置'; $save.Location=New-Object System.Drawing.Point(475,375); $save.Size=New-Object System.Drawing.Size(190,42)
$save.Add_Click({
    if (!(Test-SteamInput $key.Text.Trim() $id.Text.Trim())) { [System.Windows.Forms.MessageBox]::Show('请填写32位十六进制 API Key 和有效的17位 SteamID64。','请检查输入') | Out-Null; return }
    if (!$consent.Checked) { [System.Windows.Forms.MessageBox]::Show('请确认将配置用于此私有站点的只读同步。','请确认配置用途') | Out-Null; return }
    $clear = $null
    try {
        $data=@{schema_version='1.0'; project_id=$project; created_at=[DateTimeOffset]::UtcNow.ToString('o'); entries=@{STEAM_API_KEY=$key.Text.Trim(); STEAM_ID=$id.Text.Trim()}}
        $clear=[System.Text.Encoding]::UTF8.GetBytes(($data|ConvertTo-Json -Depth 4 -Compress))
        $protected=[System.Security.Cryptography.ProtectedData]::Protect($clear,$entropy,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)
        [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($destination)) | Out-Null
        [System.IO.File]::WriteAllBytes(($destination+'.tmp'),$protected)
        Move-Item -LiteralPath ($destination+'.tmp') -Destination $destination -Force
        $key.Clear()
        [System.Windows.Forms.MessageBox]::Show('配置已按当前Windows用户加密保存。请回到你的agent说“Steam配置已保存”，不要发送密钥。','已加密保存') | Out-Null
        $form.Close()
    } catch { [System.Windows.Forms.MessageBox]::Show('保存失败，请检查本地目录权限。未显示密钥或原始错误。','配置未保存') | Out-Null }
    finally { if ($null -ne $clear) {[Array]::Clear($clear,0,$clear.Length)}; $data=$null }
})
$form.Controls.Add($save)
$cancel = New-Object System.Windows.Forms.Button
$cancel.Text='稍后配置'; $cancel.Location=New-Object System.Drawing.Point(330,375); $cancel.Size=New-Object System.Drawing.Size(125,42)
$cancel.Add_Click({$form.Close()}); $form.Controls.Add($cancel)
[void]$form.ShowDialog()
$key.Clear(); $form.Dispose()
