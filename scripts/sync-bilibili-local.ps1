param([int]$MaxPages=180,[switch]$SubtitlesOnly)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$workspace=Split-Path -Parent $PSScriptRoot
$node=(Get-Command node -ErrorAction Stop).Source
$payload=@{}
try {
    foreach($config in @(@{Path='.local\bilibili-setup.dpapi';Entropy='PersonalMediaAssistant/platform-setup/v1'},@{Path='.local\bilibili-collector.dpapi';Entropy='PersonalMediaAssistant/collector/v1'})) {
        $raw=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes((Join-Path $workspace $config.Path)),[Text.Encoding]::UTF8.GetBytes($config.Entropy),[Security.Cryptography.DataProtectionScope]::CurrentUser)
        try {
            $data=[Text.Encoding]::UTF8.GetString($raw)|ConvertFrom-Json
            if($data.entries){if($data.project_id -ne 'appgprj_REPLACE_ME'){throw 'PROJECT_MISMATCH'};$payload.BILIBILI_COOKIE=[string]$data.entries.BILIBILI_COOKIE}
            else{foreach($key in @('endpoint','device_id','ingest_token','sites_token')){$payload[$key]=[string]$data.$key}}
        }finally{[Array]::Clear($raw,0,$raw.Length);$data=$null}
    }
    $arguments=@('--state',(Join-Path $workspace '.local\bilibili'),'--max-pages',$MaxPages);if($SubtitlesOnly){$arguments+='--only-subtitles'}
    $payload|ConvertTo-Json -Compress|& $node (Join-Path $workspace 'outputs\bilibili-collector\collector.mjs') @arguments
    if($LASTEXITCODE -ne 0){throw 'BILIBILI_COLLECTOR_FAILED'}
}finally{$payload.Clear()}
