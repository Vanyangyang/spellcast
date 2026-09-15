$ErrorActionPreference = 'Stop'
$workspace = 'G:\VibeProj\spellcast'
$evidence = Join-Path $workspace 'artifacts\runtime-acceptance-20260914'
$attempt = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')
$destination = Join-Path $workspace 'src-tauri\target\debug'
$candidateDirectory = Join-Path $workspace 'src-tauri\target-teardown-20260913\debug'
$backup = Join-Path $evidence "deployment-backup-$attempt"
$profileBackup = Join-Path 'C:\Users\Administrator\AppData\Local\SpellcastAcceptance' "profile-backup-$attempt"
$candidateHash = 'f56257631cd66a48fec58b51634fb4ce93956d46d490000bf0fe4ae122a410ed'
$oldHash = '316c90654eb48a6b2c033b158b777c09a3cd8b41129b19c3c61d498b4f23da55'
$nativeNode = 'C:\Program Files\nodejs\node.exe'
$nativePython = 'C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DeploymentIdentity {
  [DllImport("kernel32.dll")] public static extern int GetCurrentPackageFullName(ref uint length, IntPtr name);
  [DllImport("kernel32.dll")] public static extern uint SetErrorMode(uint mode);
}
'@
[uint32]$length = 0
$identity = [DeploymentIdentity]::GetCurrentPackageFullName([ref]$length, [IntPtr]::Zero)
if ($identity -ne 15700) { throw 'Deployment must run in unpackaged Explorer context.' }
[void][DeploymentIdentity]::SetErrorMode(0x8003)
$result = [ordered]@{ pass = $false; stage = 'preflight'; startedAt = [DateTime]::UtcNow.ToString('o'); packageIdentityCode = $identity; backup = $backup; profileBackup = $profileBackup }
try {
  if (Get-Process spellcast -ErrorAction SilentlyContinue) { throw 'Spellcast is running; deployment has not changed anything.' }
  if ((Get-FileHash -LiteralPath (Join-Path $candidateDirectory 'spellcast.exe')).Hash.ToLower() -ne $candidateHash) { throw 'Candidate differs from the accepted binary.' }
  if ((Get-FileHash -LiteralPath (Join-Path $destination 'spellcast.exe')).Hash.ToLower() -ne $oldHash) { throw 'Original binary changed; refusing overwrite.' }
  [void](New-Item -ItemType Directory -Path $backup)
  [void](New-Item -ItemType Directory -Path $profileBackup)
  & $nativePython (Join-Path $workspace 'scripts\backup-runtime-state.py') 'C:\Users\Administrator\AppData\Roaming\com.spellcast.board\spellcast.sqlite3' (Join-Path $backup 'state')
  if ($LASTEXITCODE -ne 0) { throw 'Physical state backup failed.' }
  foreach ($relative in @('.codex\config.toml', '.agents\plugins\marketplace.json', '.codex\skills\spellcast', 'plugins\spellcast')) {
    $source = Join-Path 'C:\Users\Administrator' $relative
    if (Test-Path -LiteralPath $source) {
      $copy = Join-Path $profileBackup $relative
      [void](New-Item -ItemType Directory -Force -Path (Split-Path -Parent $copy))
      Copy-Item -LiteralPath $source -Destination $copy -Recurse -Force
    }
  }
  foreach ($name in @('spellcast.exe', 'spellcast.pdb')) {
    $original = Join-Path $destination $name
    if (Test-Path -LiteralPath $original) { Copy-Item -LiteralPath $original -Destination (Join-Path $backup $name) }
  }
  $resources = Join-Path $destination 'resources\codex-plugin'
  $staging = Join-Path $destination "resources\codex-plugin-staged-$attempt"
  Copy-Item -LiteralPath (Join-Path $workspace 'src-tauri\resources\codex-plugin') -Destination $staging -Recurse
  # Every directory move below is a literal child of the verified runtime directory or backup.
  foreach ($target in @($resources, $staging)) {
    if (-not [IO.Path]::GetFullPath($target).StartsWith([IO.Path]::GetFullPath($destination) + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Resource move escaped runtime directory.' }
  }
  if (Test-Path -LiteralPath $resources) { Move-Item -LiteralPath $resources -Destination (Join-Path $backup 'resources-original') }
  Move-Item -LiteralPath $staging -Destination $resources
  $result.stage = 'replace-binary'
  Copy-Item -LiteralPath (Join-Path $candidateDirectory 'spellcast.exe') -Destination (Join-Path $destination 'spellcast.exe') -Force
  if (Test-Path -LiteralPath (Join-Path $candidateDirectory 'spellcast.pdb')) { Copy-Item -LiteralPath (Join-Path $candidateDirectory 'spellcast.pdb') -Destination (Join-Path $destination 'spellcast.pdb') -Force }
  if ((Get-FileHash -LiteralPath (Join-Path $destination 'spellcast.exe')).Hash.ToLower() -ne $candidateHash) { throw 'Deployed binary hash mismatch.' }
  $result.stage = 'real-profile-ui-install'
  foreach ($variable in @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NODE_USE_ENV_PROXY', 'NODE_OPTIONS')) { [Environment]::SetEnvironmentVariable($variable, $null, 'Process') }
  $env:NO_PROXY = '127.0.0.1,localhost,::1'
  & $nativeNode (Join-Path $workspace 'scripts\verify-deployed-runtime.mjs') (Join-Path $destination 'spellcast.exe') (Join-Path $backup 'state\spellcast.sqlite3') $profileBackup
  if ($LASTEXITCODE -ne 0) { throw 'Deployed runtime verification failed; inspect deployment-native-result.json.' }
  $result.pass = $true
  $result.stage = 'complete'
  $result.appSha256 = $candidateHash
} catch { $result.error = $_.Exception.Message }
finally {
  $result.finishedAt = [DateTime]::UtcNow.ToString('o')
  [IO.File]::WriteAllText((Join-Path $evidence 'deployment-result.json'), ($result | ConvertTo-Json -Depth 5))
}
if (-not $result.pass) { exit 1 }
