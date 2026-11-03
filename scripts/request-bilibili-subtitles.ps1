param([Parameter(Mandatory=$true)][ValidatePattern('^BV[A-Za-z0-9]{10}$')][string]$Bvid,[ValidatePattern('^[0-9]{1,20}$')][string]$Cid,[ValidatePattern('^[A-Za-z0-9_-]{1,30}$')][string]$Language)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$workspace=Split-Path -Parent $PSScriptRoot
$bytes=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes((Join-Path $workspace '.local/bilibili-collector.dpapi')),[Text.Encoding]::UTF8.GetBytes('PersonalMediaAssistant/collector/v1'),[Security.Cryptography.DataProtectionScope]::CurrentUser)
try{
 $c=[Text.Encoding]::UTF8.GetString($bytes)|ConvertFrom-Json
 if($c.endpoint -ne 'https://your-site.example.invalid/api/ingest/bilibili'){throw 'ENDPOINT_SCOPE_DENIED'}
 $headers=@{Authorization='Bearer '+$c.ingest_token;'OAI-Sites-Authorization'='Bearer '+$c.sites_token}
 function Send-Request($Data){try{return Invoke-RestMethod -Uri $c.endpoint -Method Post -Headers $headers -ContentType 'application/json' -Body ($Data|ConvertTo-Json -Depth 4 -Compress) -MaximumRedirection 0 -TimeoutSec 30}catch{throw 'SUBTITLE_REQUEST_FAILED'}}
 $state=Send-Request @{schema_version='1.0';device_id=$c.device_id;op='state'}
 if($state.sync_paused){throw 'SYNC_PAUSED_BY_OWNER'}
 $payload=@{schema_version='1.0';device_id=$c.device_id;op='request_subtitles';epoch=$state.sync_epoch;bvid=$Bvid}
 if($Cid){$payload.cid=$Cid};if($Language){$payload.language=$Language}
 $r=Send-Request $payload
 [pscustomobject]@{accepted=$r.accepted;status=$r.status;queued=$r.queued;part=$(if($Cid){'specified'}else{'first_part_only'})}|ConvertTo-Json -Compress
}finally{[Array]::Clear($bytes,0,$bytes.Length);$c=$null;$headers=$null}
