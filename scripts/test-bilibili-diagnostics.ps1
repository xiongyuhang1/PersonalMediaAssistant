param([ValidateSet('local','cloud')][string]$Mode='local',[ValidateSet('baseline','history','controls')][string]$Group='baseline',[Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{32}$')][string]$Salt)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$workspace=Split-Path -Parent $PSScriptRoot
$probe=Join-Path $workspace 'outputs/bilibili-probe.mjs'
$entropy=if($Mode -eq 'local'){'PersonalMediaAssistant/platform-setup/v1'}else{'PersonalMediaAssistant/collector/v1'}
$file=if($Mode -eq 'local'){'bilibili-setup.dpapi'}else{'dandanplay.dpapi'}
$raw=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes((Join-Path $workspace ".local/$file")),[Text.Encoding]::UTF8.GetBytes($entropy),[Security.Cryptography.DataProtectionScope]::CurrentUser)
try {
 $decoded=[Text.Encoding]::UTF8.GetString($raw)|ConvertFrom-Json
 if($Mode -eq 'local') {
  if($decoded.schema_version -ne '1.0' -or $decoded.project_id -ne 'appgprj_REPLACE_ME'){throw 'SETUP_PROJECT_MISMATCH'}
  $inputData=@{mode=$Mode;group=$Group;salt=$Salt;BILIBILI_COOKIE=$decoded.entries.BILIBILI_COOKIE}
 } else {$inputData=@{mode=$Mode;group=$Group;salt=$Salt;endpoint=$decoded.endpoint;ingest_token=$decoded.ingest_token;sites_token=$decoded.sites_token}}
 $inputData|ConvertTo-Json -Compress|& node $probe
 if($LASTEXITCODE -ne 0){throw 'BILIBILI_PROBE_FAILED'}
} finally {[Array]::Clear($raw,0,$raw.Length);$decoded=$null;$inputData=$null}
