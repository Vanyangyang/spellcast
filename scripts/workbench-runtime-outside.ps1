$ErrorActionPreference = 'Stop'
$workspace = 'G:\VibeProj\spellcast'
$evidence = Join-Path $workspace 'artifacts\workbench-20260914'
$request = [IO.File]::ReadAllText((Join-Path $evidence 'runtime-request.json')) | ConvertFrom-Json
if ($request.run -notmatch '^[a-zA-Z0-9-]+$' -or $request.mode -notin @('candidate', 'deploy', 'direct', 'runtime', 'verify')) { throw 'Invalid workbench runtime request.' }
$output = Join-Path $evidence $request.run
[void](New-Item -ItemType Directory -Force -Path $output)
$candidate = Join-Path $workspace 'src-tauri\target-teardown-20260913\debug\spellcast.exe'
$production = Join-Path $workspace 'src-tauri\target\debug\spellcast.exe'
$nativePython = 'C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WorkbenchProcessIdentity {
  [DllImport("kernel32.dll")] public static extern int GetCurrentPackageFullName(ref uint length, IntPtr name);
}
'@
[uint32]$length = 0
$identity = [WorkbenchProcessIdentity]::GetCurrentPackageFullName([ref]$length, [IntPtr]::Zero)
if ($request.mode -eq 'verify') {
  if ($identity -ne 15700) { throw 'Verify must run in unpackaged Explorer context.' }
  $cli = 'C:\Users\Administrator\AppData\Roaming\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe'
  $listed = (& $cli plugin list --marketplace personal --json | Out-String) | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) { throw 'Native plugin listing failed.' }
  $installed = $listed.installed | Where-Object { $_.name -eq 'spellcast' -and $_.marketplaceName -eq 'personal' -and $_.enabled -and $_.installed } | Select-Object -First 1
  if (-not $installed) { throw 'Spellcast plugin is not active.' }
  $source = 'C:\Users\Administrator\plugins\spellcast'
  if ([IO.Path]::GetFullPath($installed.source.path) -ne $source) { throw 'Unexpected installed source.' }
  $cache = Join-Path 'C:\Users\Administrator\.codex\plugins\cache\personal\spellcast' $installed.version
  $integrity = [IO.File]::ReadAllText((Join-Path $workspace 'src-tauri\resources\codex-plugin\integrity.json')) | ConvertFrom-Json
  $checked = @()
  foreach ($file in $integrity.files.PSObject.Properties) {
    if ($file.Name -in @('.codex-plugin/plugin.json','.mcp.json','hooks/hooks.json')) { continue }
    foreach ($base in @($source,$cache)) { if ((Get-FileHash -LiteralPath (Join-Path $base $file.Name)).Hash.ToLower() -ne $file.Value) { throw ('Installed payload mismatch: ' + $file.Name) } }
    $checked += $file.Name
  }
  if ([IO.File]::ReadAllText((Join-Path $source '.mcp.json')) -notmatch '127.0.0.1:47194/mcp') { throw 'MCP endpoint differs from production.' }
  [IO.File]::WriteAllText((Join-Path $output 'plugin-verified.json'), (@{ pass=$true; packageIdentityCode=$identity; version=$installed.version; source=$source; cache=$cache; checked=$checked; time=[DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Depth 4))
  exit 0
}
$result = [ordered]@{ pass = $false; mode = $request.mode; stage = 'preflight'; packageIdentityCode = $identity; startedAt = [DateTime]::UtcNow.ToString('o') }
function Save-Result { [IO.File]::WriteAllText((Join-Path $output ($request.mode + '-result.json')), ($result | ConvertTo-Json -Depth 5)) }
try {
  if ($identity -ne 15700) { throw 'The file operation worker must run in unpackaged Explorer context.' }
  if (Get-Process spellcast -ErrorAction SilentlyContinue) { throw 'Close the exact Spellcast window normally first; no process is terminated by this script.' }
  if ((Get-FileHash -LiteralPath $candidate).Hash.ToLower() -ne $request.candidateSha256) { throw 'Candidate hash changed.' }
  if ((Get-FileHash -LiteralPath $production).Hash.ToLower() -ne $request.productionSha256) { throw 'Production hash changed.' }
  $backup = Join-Path $output ($request.mode + '-physical-state-' + $request.candidateSha256.Substring(0,8))
  & $nativePython (Join-Path $workspace 'scripts\backup-runtime-state.py') 'C:\Users\Administrator\AppData\Roaming\com.spellcast.board\spellcast.sqlite3' $backup
  if ($LASTEXITCODE -ne 0) { throw 'Physical SQLite backup failed.' }
  $result.backup = $backup
  $start = New-Object Diagnostics.ProcessStartInfo
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
  if ($request.mode -eq 'candidate') {
    $profile = Join-Path 'C:\Users\Administrator\AppData\Local\SpellcastAcceptance' ($request.run + '-' + $request.candidateSha256.Substring(0,8))
    if (Test-Path -LiteralPath $profile) { throw 'Candidate profile already exists.' }
    foreach ($name in @('app', 'home', 'home\.codex', 'Roaming', 'Local', 'temp', 'cwd')) { [void](New-Item -ItemType Directory -Path (Join-Path $profile $name) -Force) }
    $app = Join-Path $profile 'app\spellcast.exe'
    Copy-Item -LiteralPath $candidate -Destination $app
    [void](New-Item -ItemType Directory -Path (Join-Path $profile 'app\resources'))
    Copy-Item -LiteralPath (Join-Path $workspace 'src-tauri\resources\codex-plugin') -Destination (Join-Path $profile 'app\resources\codex-plugin') -Recurse
    $start.FileName = $app; $start.WorkingDirectory = Join-Path $profile 'cwd'
    $overrides = @{ HOME = (Join-Path $profile 'home'); USERPROFILE = (Join-Path $profile 'home'); CODEX_HOME = (Join-Path $profile 'home\.codex'); APPDATA = (Join-Path $profile 'Roaming'); LOCALAPPDATA = (Join-Path $profile 'Local'); TEMP = (Join-Path $profile 'temp'); TMP = (Join-Path $profile 'temp'); SPELLCAST_PORT = '47321'; SPELLCAST_STATE_FILE = (Join-Path $profile 'state.sqlite3'); WEBVIEW2_USER_DATA_FOLDER = (Join-Path $profile 'WebView2') }
    foreach ($name in $overrides.Keys) { $start.EnvironmentVariables[$name] = $overrides[$name] }
    foreach ($name in @('HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NODE_OPTIONS','NODE_USE_ENV_PROXY')) { $start.EnvironmentVariables.Remove($name) }
    $result.profile = $profile; $result.executable = $app; $result.sha256 = $request.candidateSha256
    $process = [Diagnostics.Process]::Start($start)
    $result.pid = $process.Id; $result.pass = $true; $result.stage = 'candidate-running'; Save-Result
    $process.WaitForExit()
    [IO.File]::WriteAllText((Join-Path $output 'candidate-exit.json'), (@{ pid=$process.Id; code=$process.ExitCode; sha256=$request.candidateSha256; finishedAt=[DateTime]::UtcNow.ToString('o') } | ConvertTo-Json))
  } else {
    if ($request.mode -eq 'deploy') {
      $exitEvidence = [IO.File]::ReadAllText((Join-Path $output 'candidate-exit.json')) | ConvertFrom-Json
      if ($exitEvidence.code -ne 0 -or $exitEvidence.sha256 -ne $request.candidateSha256 -or -not $request.candidateAccepted) { throw 'Candidate needs successful native acceptance and a normal exit.' }
    }
    $profileBackup = Join-Path 'C:\Users\Administrator\AppData\Local\SpellcastAcceptance' ('profile-' + $request.run)
    [void](New-Item -ItemType Directory -Path $profileBackup)
    foreach ($relative in @('.codex\config.toml','.agents\plugins\marketplace.json','plugins\spellcast')) {
      $source = Join-Path 'C:\Users\Administrator' $relative
      if (Test-Path -LiteralPath $source) { $copy = Join-Path $profileBackup $relative; [void](New-Item -ItemType Directory -Force -Path (Split-Path -Parent $copy)); Copy-Item -LiteralPath $source -Destination $copy -Recurse }
    }
    $result.profileBackup = $profileBackup
    if ($request.mode -eq 'runtime') {
      $drafts = 'C:\Users\Administrator\AppData\Local\com.spellcast.board\EBWebView\Default\Local Storage\leveldb'
      if (Test-Path -LiteralPath $drafts) {
        $result.localDraftBackup = Join-Path $output 'local-drafts'
        Copy-Item -LiteralPath $drafts -Destination $result.localDraftBackup -Recurse
      }
    }
    $fileBackup = Join-Path $output 'runtime-original'; [void](New-Item -ItemType Directory -Path $fileBackup)
    $result.fileBackup = $fileBackup
    $destination = Split-Path -Parent $production
    foreach ($name in @('spellcast.exe','spellcast.pdb')) { $old = Join-Path $destination $name; if (Test-Path -LiteralPath $old) { Copy-Item -LiteralPath $old -Destination (Join-Path $fileBackup $name) } }
    $resources = Join-Path $destination 'resources\codex-plugin'
    $staged = Join-Path $destination ('resources\codex-plugin-workbench-' + $request.run)
    Copy-Item -LiteralPath (Join-Path $workspace 'src-tauri\resources\codex-plugin') -Destination $staged -Recurse
    foreach ($target in @($resources,$staged)) { if (-not [IO.Path]::GetFullPath($target).StartsWith([IO.Path]::GetFullPath($destination) + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Resource path escaped the runtime directory.' } }
    if (Test-Path -LiteralPath $resources) { Move-Item -LiteralPath $resources -Destination (Join-Path $fileBackup 'resources') }
    Move-Item -LiteralPath $staged -Destination $resources
    Copy-Item -LiteralPath $candidate -Destination $production -Force
    $candidatePdb = [IO.Path]::ChangeExtension($candidate, '.pdb'); if (Test-Path -LiteralPath $candidatePdb) { Copy-Item -LiteralPath $candidatePdb -Destination (Join-Path $destination 'spellcast.pdb') -Force }
    if ((Get-FileHash -LiteralPath $production).Hash.ToLower() -ne $request.candidateSha256) { throw 'Deployed binary hash mismatch.' }
    if ($request.mode -eq 'direct') {
      & 'C:\Program Files\nodejs\node.exe' (Join-Path $workspace 'scripts\update-installed-workbench-plugin.mjs')
      if ($LASTEXITCODE -ne 0) { throw 'Direct plugin update failed.' }
    }
    $start.FileName = $production; $start.WorkingDirectory = $workspace
    foreach ($name in @('SPELLCAST_PORT','SPELLCAST_STATE_FILE','WEBVIEW2_USER_DATA_FOLDER','TAURI_CONFIG')) { $start.EnvironmentVariables.Remove($name) }
    $process = [Diagnostics.Process]::Start($start)
    $result.pid = $process.Id; $result.executable = $production; $result.pass = $true; $result.stage = 'production-running'
  }
} catch { $result.pass = $false; $result.error = $_.Exception.Message }
finally { $result.finishedAt = [DateTime]::UtcNow.ToString('o'); Save-Result }
if (-not $result.pass) { exit 1 }
