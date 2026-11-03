$ErrorActionPreference = 'Stop'
$workspace = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$exe = Join-Path $workspace 'outputs\dandanplay-collector\Pma.CollectorLauncher.exe'
$credentials = Join-Path $workspace '.local\dandanplay.dpapi'
$state = Join-Path $workspace '.local\dandanplay'
if (!(Test-Path -LiteralPath $exe) -or !(Test-Path -LiteralPath $credentials)) { throw '先构建采集器并完成加密凭据配置。' }
$name = 'PersonalMediaAssistant-DandanPlaySync'
$description = 'PersonalMediaAssistant managed collector: read-only source snapshots, authenticated outbound HTTPS.'
$existing = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
if ($existing -and $existing.Description -ne $description) { throw '同名计划任务不是本项目创建，保持不变。' }
$arguments = '--credentials "' + $credentials + '" --state "' + $state + '"'
$action = New-ScheduledTaskAction -Execute $exe -Argument $arguments -WorkingDirectory $workspace
$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
$trigger.Delay = 'PT30S'
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $name -Description $description -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $name
Get-ScheduledTask -TaskName $name | Select-Object TaskName,State | ConvertTo-Json -Compress
