param(
 [Parameter(Mandatory=$true)][ValidateSet('steam','netease')][string]$Platform,
 [Parameter(Mandatory=$true)][ValidateSet('owned_games','recent_games','achievements','related_works','favorites','recent_plays','user_record_all','user_record_week','playlists','playlist_tracks','listening_stats')][string]$Dataset,
 [string]$AppId,[string[]]$CandidateAppIds=@(),[ValidateRange(1,180)][int]$MaxPages=120
)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$workspace=Split-Path -Parent $PSScriptRoot
$bytes=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes((Join-Path $workspace '.local/cloud-refresh.dpapi')),[Text.Encoding]::UTF8.GetBytes('PersonalMediaAssistant/collector/v1'),[Security.Cryptography.DataProtectionScope]::CurrentUser)
try{
 $c=[Text.Encoding]::UTF8.GetString($bytes)|ConvertFrom-Json
 if($c.endpoint -ne 'https://your-site.example.invalid/api/refresh-platform'){throw 'ENDPOINT_SCOPE_DENIED'}
 $payload=@{schema_version='1.0';device_id=$c.device_id;platform=$Platform;dataset=$Dataset}
 if($AppId){if($AppId -notmatch '^[1-9][0-9]{0,9}$'){throw 'INVALID_APP_ID'};$payload.app_id=$AppId}
 if($CandidateAppIds.Count){if($CandidateAppIds.Count -gt 3 -or @($CandidateAppIds|Where-Object {$_ -notmatch '^[1-9][0-9]{0,9}$'}).Count){throw 'INVALID_CANDIDATE_IDS'};$payload.candidate_app_ids=@($CandidateAppIds)}
 $headers=@{Authorization='Bearer '+$c.ingest_token;'OAI-Sites-Authorization'='Bearer '+$c.sites_token}
 $pages=0;$records=0
 do{
  try{$r=Invoke-RestMethod -Uri $c.endpoint -Method Post -Headers $headers -ContentType 'application/json' -Body ($payload|ConvertTo-Json -Depth 5 -Compress) -MaximumRedirection 0 -TimeoutSec 45}catch{throw 'CLOUD_REFRESH_REQUEST_FAILED'}
  if($r.accepted -ne $true){throw 'CLOUD_REFRESH_NOT_ACKNOWLEDGED'}
  $pages++;$records+=[int]$r.records_committed
  [pscustomobject]@{status=$r.status;platform=$Platform;dataset=$Dataset;page=$pages;records_committed=$r.records_committed;has_more=$r.has_more;summary=$r.summary}|ConvertTo-Json -Depth 4 -Compress
  if($r.has_more -and $pages -lt $MaxPages){Start-Sleep -Milliseconds 650}
 }while($r.has_more -and $pages -lt $MaxPages)
 [pscustomobject]@{status=$(if($r.has_more -or $r.status -ne 'ok'){'partial'}else{'synced'});platform=$Platform;dataset=$Dataset;pages=$pages;records_this_run=$records}|ConvertTo-Json -Compress
}finally{[Array]::Clear($bytes,0,$bytes.Length);$c=$null;$headers=$null}
