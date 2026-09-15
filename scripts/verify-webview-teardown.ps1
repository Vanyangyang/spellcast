param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$OutputDirectory,
  [int]$DeadlineMs = 30000
)
$ErrorActionPreference = 'Stop'
$taskExe = (Resolve-Path -LiteralPath $Exe).Path
$taskOut = [IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($taskOut) | Out-Null
$taskProfile = Join-Path $taskOut 'profile'
$taskLog = Join-Path $taskOut 'native.log'
if (Test-Path -LiteralPath $taskLog) { throw 'Use a fresh output directory; preserve earlier evidence.' }
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class SpellcastTeardownErrorMode {
  [DllImport("kernel32.dll")] public static extern uint SetErrorMode(uint mode);
}
'@
$previousErrorMode = [SpellcastTeardownErrorMode]::SetErrorMode(0x8003)
$taskStart = [DateTime]::UtcNow
$psi = New-Object Diagnostics.ProcessStartInfo
$psi.FileName = $taskExe
$psi.WorkingDirectory = Split-Path -Parent $taskExe
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.EnvironmentVariables['SPELLCAST_TEARDOWN_PROFILE'] = $taskProfile
$psi.EnvironmentVariables['SPELLCAST_TEARDOWN_LOG'] = $taskLog
foreach ($entry in @{ APPDATA = 'Roaming'; LOCALAPPDATA = 'Local'; WEBVIEW2_USER_DATA_FOLDER = 'WebView2' }.GetEnumerator()) {
  $dir = Join-Path $taskProfile $entry.Value
  [IO.Directory]::CreateDirectory($dir) | Out-Null
  $psi.EnvironmentVariables[$entry.Key] = $dir
}
$process = New-Object Diagnostics.Process
$process.StartInfo = $psi
try {
  [void]$process.Start()
  $taskPid = $process.Id
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  $exited = $process.WaitForExit($DeadlineMs)
  $killed = $false
  if (-not $exited) {
    # This Process object owns the handle returned by Start, not a rediscovered PID.
    $process.Kill()
    $killed = $true
    [void]$process.WaitForExit(5000)
  }
  $stdoutReady = $stdoutTask.Wait(5000)
  $stderrReady = $stderrTask.Wait(5000)
  $stdout = if ($stdoutReady) { $stdoutTask.Result } else { '[capture did not finish]' }
  $stderr = if ($stderrReady) { $stderrTask.Result } else { '[capture did not finish]' }
  [IO.File]::WriteAllText((Join-Path $taskOut 'stdout.txt'), $stdout)
  [IO.File]::WriteAllText((Join-Path $taskOut 'stderr.txt'), $stderr)
  $native = if ([IO.File]::Exists($taskLog)) { [IO.File]::ReadAllText($taskLog) } else { '' }
  $required = @('outer_install_ok', 'outer_destroy_enter', 'outer_after_def', 'outer_focus_enter', 'outer_focus_after_def', 'outer_entersizemove_enter', 'outer_entersizemove_after_def', 'outer_ncdestroy_removed', 'exit0')
  $ordered = $true
  $last = -1
  foreach ($name in $required) {
    $index = $native.IndexOf("marker=$name`n", [StringComparison]::Ordinal)
    if ($index -lt 0) { $index = $native.IndexOf("marker=$name`r`n", [StringComparison]::Ordinal) }
    if ($index -le $last) { $ordered = $false }
    $last = $index
  }
  # Tauri emits Destroyed from inside DefSubclassProc(WM_DESTROY).
  $destroyedIndex = $native.IndexOf('marker=tauriDestroyed', [StringComparison]::Ordinal)
  $destroyedInCall = $destroyedIndex -gt $native.IndexOf('marker=outer_destroy_enter') -and $destroyedIndex -lt $native.IndexOf('marker=outer_after_def')
  $hwndCovered = $native.Contains('step=hwnd_coverage child=false target_eq_hwnd=true')
  $exitCode = if ($process.HasExited) { $process.ExitCode } else { $null }
  $passed = $exited -and $exitCode -eq 0 -and $stdoutReady -and $stderrReady -and $ordered -and $destroyedInCall -and $hwndCovered -and (-not $native.Contains('outer_ncdestroy_remove_failed'))
  $report = [ordered]@{ pass = $passed; startedAt = $taskStart.ToString('o'); finishedAt = [DateTime]::UtcNow.ToString('o'); exe = $taskExe; sha256 = (Get-FileHash -LiteralPath $taskExe -Algorithm SHA256).Hash.ToLowerInvariant(); pid = $taskPid; exitCode = $exitCode; timedOut = (-not $exited); killedOwnProcess = $killed; orderedReentry = $ordered; destroyedInsideDefSubclassProc = $destroyedInCall; originalNonchildHwnd = $hwndCovered; profile = $taskProfile; note = 'Native synchronous messages during WM_DESTROY; not physical user focus.' }
  $json = $report | ConvertTo-Json -Depth 4
  [IO.File]::WriteAllText((Join-Path $taskOut 'result.json'), $json)
  $json
  if (-not $passed) { exit 1 }
} finally {
  $process.Dispose()
  [void][SpellcastTeardownErrorMode]::SetErrorMode($previousErrorMode)
}
