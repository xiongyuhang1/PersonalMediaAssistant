$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$workspace = Split-Path -Parent $PSScriptRoot
$probe = Join-Path $workspace 'outputs/platform-probe.mjs'
if (-not (Test-Path -LiteralPath $probe)) { throw 'Build scripts/probe-platforms.ts with esbuild before running.' }
$entries = @{}
try {
    foreach ($provider in @('steam', 'bilibili', 'netease')) {
        $setupPath = Join-Path $workspace ".local/$provider-setup.dpapi"
        if (-not (Test-Path -LiteralPath $setupPath)) { continue }
        $raw = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($setupPath), [Text.Encoding]::UTF8.GetBytes('PersonalMediaAssistant/platform-setup/v1'), [Security.Cryptography.DataProtectionScope]::CurrentUser)
        try {
            $setup = [Text.Encoding]::UTF8.GetString($raw) | ConvertFrom-Json
            if ($setup.schema_version -ne '1.0' -or $setup.project_id -ne 'appgprj_REPLACE_ME') { throw 'SETUP_PROJECT_MISMATCH' }
            $expected = switch ($provider) { steam { 'STEAM_API_KEY,STEAM_ID' } bilibili { 'BILIBILI_COOKIE' } netease { 'NETEASE_COOKIE,NETEASE_UID' } }
            if ((@($setup.entries.PSObject.Properties.Name | Sort-Object) -join ',') -ne $expected) { throw 'SETUP_KEYS_MISMATCH' }
            foreach ($entry in $setup.entries.PSObject.Properties) { $entries[$entry.Name] = [string]$entry.Value }
        } finally { [Array]::Clear($raw, 0, $raw.Length); $setup = $null }
    }
    $entries | ConvertTo-Json -Compress | & node $probe
    if ($LASTEXITCODE -ne 0) { throw 'PROBE_FAILED' }
} finally { $entries.Clear() }
