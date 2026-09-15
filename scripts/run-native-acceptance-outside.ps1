$ErrorActionPreference = 'Stop'
$workspace = 'G:\VibeProj\spellcast'
$evidence = Join-Path $workspace 'artifacts\runtime-acceptance-20260914'
$attempt = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')
$candidateRoot = Join-Path 'C:\Users\Administrator\AppData\Local\SpellcastAcceptance' "native-$attempt"
$backupDirectory = Join-Path $evidence "backup-physical-$attempt"
$oldExecutable = Join-Path $workspace 'src-tauri\target\debug\spellcast.exe'
$candidate = Join-Path $workspace 'src-tauri\target-teardown-20260913\debug\spellcast.exe'
$nativeNode = 'C:\Program Files\nodejs\node.exe'
$nativePython = 'C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$nativeCodex = 'C:\Users\Administrator\AppData\Roaming\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NativeAcceptanceIdentity {
  [DllImport("kernel32.dll")] public static extern int GetCurrentPackageFullName(ref uint length, IntPtr name);
  [DllImport("kernel32.dll")] public static extern uint SetErrorMode(uint mode);
}
'@
[uint32]$identityLength = 0
$identityCode = [NativeAcceptanceIdentity]::GetCurrentPackageFullName([ref]$identityLength, [IntPtr]::Zero)
if ($identityCode -ne 15700) { throw "Expected unpackaged Explorer context, got $identityCode" }
[void][NativeAcceptanceIdentity]::SetErrorMode(0x8003)
$closedOld = $false
$passed = $false
$result = [ordered]@{ packageIdentityCode = $identityCode; startedAt = [DateTime]::UtcNow.ToString('o'); stage = 'backup'; pass = $false; profile = $candidateRoot; backup = $backupDirectory }
try {
  $snapshot = Invoke-WebRequest -Uri 'http://127.0.0.1:47194/api/board' -UseBasicParsing -TimeoutSec 5
  $boardSnapshot = $snapshot.Content | ConvertFrom-Json
  if (-not $boardSnapshot.nodes) { throw 'Could not verify the running board snapshot.' }
  [IO.File]::WriteAllText((Join-Path $evidence "board-before-close-$attempt.json"), $snapshot.Content)
  $result.stage = 'close-old'
  $observed = Get-CimInstance Win32_Process -Filter "Name='spellcast.exe'"
  foreach ($item in $observed) {
    if ($item.ExecutablePath -ne $oldExecutable) { throw "Unexpected Spellcast process $($item.ProcessId)." }
    $process = Get-Process -Id $item.ProcessId
    if (-not $process.CloseMainWindow()) { throw "Could not request a normal close for $($item.ProcessId)." }
    if (-not $process.WaitForExit(10000)) { throw 'Old app did not exit; no force termination.' }
    $closedOld = $true
    $result.oldPid = $item.ProcessId
    $result.oldExitCode = $process.ExitCode
  }
  $result.stage = 'backup-after-close'
  & $nativePython (Join-Path $workspace 'scripts\backup-runtime-state.py') 'C:\Users\Administrator\AppData\Roaming\com.spellcast.board\spellcast.sqlite3' $backupDirectory
  if ($LASTEXITCODE -ne 0) { throw 'Physical database backup failed.' }
  $result.stage = 'native-candidate'
  # This driver talks only to loopback services; do not inherit Node proxy hooks.
  foreach ($variable in @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NODE_USE_ENV_PROXY', 'NODE_OPTIONS')) {
    [Environment]::SetEnvironmentVariable($variable, $null, 'Process')
  }
  $env:NO_PROXY = '127.0.0.1,localhost,::1'
  & $nativeNode (Join-Path $workspace 'scripts\check-native-ui-setup.mjs') $candidate $nativeCodex (Join-Path $workspace 'src-tauri\resources\codex-plugin') $candidateRoot
  if ($LASTEXITCODE -ne 0) { throw "Native candidate acceptance failed: $LASTEXITCODE" }
  $passed = $true
  $result.pass = $true
  $result.stage = 'complete'
} catch {
  $result.error = $_.Exception.Message
} finally {
  if ($closedOld -and -not $passed -and -not (Get-Process spellcast -ErrorAction SilentlyContinue)) {
    Start-Process -FilePath $oldExecutable -WorkingDirectory $workspace -WindowStyle Hidden
    $result.restoredOldApp = $true
  }
  $result.finishedAt = [DateTime]::UtcNow.ToString('o')
  [IO.File]::WriteAllText((Join-Path $evidence 'outside-result.json'), ($result | ConvertTo-Json -Depth 5))
}
if (-not $passed) { exit 1 }
