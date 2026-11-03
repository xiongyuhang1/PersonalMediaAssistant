$ErrorActionPreference='Stop'
$workspace=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$exe=Join-Path $workspace 'outputs\bilibili-collector\Pma.BilibiliLauncher.exe'
if(!(Test-Path -LiteralPath $exe)-or !(Test-Path -LiteralPath (Join-Path $workspace '.local\bilibili-collector.dpapi'))){throw 'BUILD_AND_CONFIGURE_BILIBILI_COLLECTOR_FIRST'}
$name='PersonalMediaAssistant-BilibiliLocalSync'
$description='PersonalMediaAssistant managed local Bilibili reader: normalized outbound HTTPS only.'
$old=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
if($old -and $old.Description -ne $description){throw 'TASK_OWNERSHIP_MISMATCH'}
$action=New-ScheduledTaskAction -Execute $exe -WorkingDirectory $workspace
$periodic=New-ScheduledTaskTrigger -Once -At (Get-Date).AddHours(6) -RepetitionInterval (New-TimeSpan -Hours 6)
$logon=New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name);$logon.Delay='PT30S'
$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $name -Description $description -Action $action -Trigger @($periodic,$logon) -Settings $settings -Principal $principal -Force|Out-Null
Get-ScheduledTask -TaskName $name|Select-Object TaskName,State|ConvertTo-Json -Compress
