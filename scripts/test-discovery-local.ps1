param([Parameter(Mandatory=$true)][string]$Snapshot)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$workspace=Split-Path -Parent $PSScriptRoot
$probe=Join-Path $workspace 'outputs/discovery-probe.mjs'
if(-not (Test-Path -LiteralPath $probe)){throw 'Build scripts/probe-discovery.ts with esbuild before running.'}
$raw=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes((Join-Path $workspace '.local/bilibili-setup.dpapi')),[Text.Encoding]::UTF8.GetBytes('PersonalMediaAssistant/platform-setup/v1'),[Security.Cryptography.DataProtectionScope]::CurrentUser)
try{
 $setup=[Text.Encoding]::UTF8.GetString($raw)|ConvertFrom-Json
 if($setup.project_id -ne 'appgprj_REPLACE_ME' -or $setup.schema_version -ne '1.0'){throw 'SETUP_PROJECT_MISMATCH'}
 if((@($setup.entries.PSObject.Properties.Name)-join ',') -ne 'BILIBILI_COOKIE'){throw 'SETUP_KEYS_MISMATCH'}
 $setup.entries|ConvertTo-Json -Compress|& node $probe $Snapshot
 if($LASTEXITCODE -ne 0){throw 'LOCAL_DISCOVERY_CHECK_FAILED'}
}finally{[Array]::Clear($raw,0,$raw.Length);$setup=$null}
