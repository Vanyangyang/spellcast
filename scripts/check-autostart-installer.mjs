import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Real NSIS compilation and execution, using only a unique temporary HKCU key.
// Run on Windows: node scripts/check-autostart-installer.mjs
if (process.platform !== 'win32') throw new Error('This NSIS smoke check requires Windows.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const makensis = process.env.SPELLCAST_MAKENSIS ?? path.join(process.env.LOCALAPPDATA, 'tauri', 'NSIS', 'Bin', 'makensis.exe');
assert.ok(existsSync(makensis), `NSIS compiler unavailable: ${makensis}`);
const work = mkdtempSync(path.join(tmpdir(), 'spellcast-autostart-'));
const registryKey = `Software\\SpellcastInstallerSmoke\\${randomUUID()}`;
const approvedKey = `${registryKey}\\StartupApproved`;
const hook = path.join(root, 'src-tauri', 'windows', 'autostart.nsh');
const installer = path.join(work, 'smoke.exe');
const displayName = `Spellcast autostart smoke ${randomUUID()}`;
const nsisPath = value => value.replaceAll('$', '$$');
const script = `Unicode true
!include MUI2.nsh
!include FileFunc.nsh
!define SPELLCAST_AUTOSTART_REGISTRY_KEY "${registryKey}"
!define SPELLCAST_AUTOSTART_REGISTRY_NAME "TestStartup"
!define SPELLCAST_AUTOSTART_APPROVED_KEY "${approvedKey}"
!include "${nsisPath(hook)}"
; Match Tauri: include hooks before the product constants and ordinary vars.
!define MAINBINARYNAME "spellcast-smoke"
Var PassiveMode
Var RemoveOldValue
Var TestResult
Name "${displayName}"
OutFile "${nsisPath(installer)}"
InstallDir "${nsisPath(path.join(work, 'Installed App'))}"
RequestExecutionLevel user
AutoCloseWindow true
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"
Function .onInit
  \${GetOptions} $CMDLINE "/P" $PassiveMode
  IfErrors +2
  StrCpy $PassiveMode "1"
  \${GetOptions} $CMDLINE "/REMOVEOLD" $RemoveOldValue
  IfErrors +2
  StrCpy $RemoveOldValue "1"
  \${GetOptions} $CMDLINE "/LANG=" $0
  IfErrors +2
  StrCpy $LANGUAGE $0
FunctionEnd
Function SkipIfPassive
  StrCmp $PassiveMode "1" 0 +2
  Abort
FunctionEnd
Section
  FileOpen $TestResult "${nsisPath(path.join(work, 'state.txt'))}" w
  FileWrite $TestResult "$SpellcastAutostartCaptured|$SpellcastAutostartEnabled|$LANGUAGE"
  FileClose $TestResult
  \${If} $RemoveOldValue == "1"
    DeleteRegValue HKCU "\${SPELLCAST_AUTOSTART_REGISTRY_KEY}" "\${SPELLCAST_AUTOSTART_REGISTRY_NAME}"
  \${EndIf}
  !insertmacro NSIS_HOOK_POSTINSTALL
  FileOpen $TestResult "${nsisPath(path.join(work, 'completed.txt'))}" w
  FileWrite $TestResult "completed"
  FileClose $TestResult
SectionEnd
Function .onInstSuccess
  Quit
FunctionEnd
`;

const driver = String.raw`
param([string]$CasePath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$case = Get-Content -LiteralPath $CasePath -Raw -Encoding UTF8 | ConvertFrom-Json
$process = $null
$savedAcl = $null
$registryHandle = $null
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public static class InstallerSmokeUi {
  public delegate bool EnumProc(IntPtr window, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr data);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int capacity);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] static extern IntPtr GetDlgItem(IntPtr window, int id);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
  public static string Text(IntPtr window) { var text = new StringBuilder(1024); GetWindowText(window,text,text.Capacity); return text.ToString(); }
  public static IntPtr Window(int pid, string label) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((w,d) => { uint id; GetWindowThreadProcessId(w,out id); if(id==pid && Checkbox(w,label)!=IntPtr.Zero) found=w; return true; }, IntPtr.Zero);
    return found;
  }
  public static IntPtr Checkbox(IntPtr window, string label) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(window,(w,d) => { if(Text(w)==label) found=w; return true; },IntPtr.Zero);
    return found;
  }
  public static int Checked(IntPtr checkbox) { return SendMessage(checkbox,0xF0,IntPtr.Zero,IntPtr.Zero).ToInt32(); }
  public static void Click(IntPtr checkbox) { SendMessage(checkbox,0xF5,IntPtr.Zero,IntPtr.Zero); }
  public static void Next(IntPtr window) { PostMessage(window,0x111,new IntPtr(1),GetDlgItem(window,1)); }
}
'@
try {
  $seed = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($case.registryKey)
  try {
    $seed.DeleteValue('TestStartup', $false)
    if ($case.existing) { $seed.SetValue('TestStartup', '"C:\Old App\spellcast.exe"', [Microsoft.Win32.RegistryValueKind]::String) }
  } finally { $seed.Close() }
  if ($case.approvedKeyExists -or $null -ne $case.approved) {
    $approvedSeed = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($case.approvedKey)
    try {
      if ($null -ne $case.approved) { $approvedSeed.SetValue('TestStartup', [byte[]]$case.approved, [Microsoft.Win32.RegistryValueKind]::Binary) }
    } finally { $approvedSeed.Close() }
  }
  if ($case.denyWrite -or $case.denyApproved -or $case.denyApprovedRead) {
    $rights = [System.Security.AccessControl.RegistryRights]::ReadPermissions -bor [System.Security.AccessControl.RegistryRights]::ChangePermissions
    $denyKey = if ($case.denyApproved -or $case.denyApprovedRead) { $case.approvedKey } else { $case.registryKey }
    $registryHandle = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($denyKey, [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree, $rights)
    $savedAcl = $registryHandle.GetAccessControl().GetSecurityDescriptorBinaryForm()
    $acl = $registryHandle.GetAccessControl()
    $denyRight = if ($case.denyApprovedRead) { [System.Security.AccessControl.RegistryRights]::QueryValues } else { [System.Security.AccessControl.RegistryRights]::SetValue }
    $rule = [System.Security.AccessControl.RegistryAccessRule]::new([System.Security.Principal.WindowsIdentity]::GetCurrent().User, $denyRight, [System.Security.AccessControl.AccessControlType]::Deny)
    $acl.AddAccessRule($rule)
    $registryHandle.SetAccessControl($acl)
  }
  $process = Start-Process -FilePath $case.installer -ArgumentList $case.args -WindowStyle Hidden -PassThru
  $initial = $null
  if ($case.gui) {
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    $checkbox = [IntPtr]::Zero
    do {
      if ($process.HasExited) { throw 'Installer exited before Welcome checkbox appeared.' }
      $window = [InstallerSmokeUi]::Window($process.Id,$case.label)
      if ($window -ne [IntPtr]::Zero) { $checkbox = [InstallerSmokeUi]::Checkbox($window,$case.label) }
      if ($checkbox -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 50 }
    } while ($checkbox -eq [IntPtr]::Zero -and [DateTime]::UtcNow -lt $deadline)
    if ($checkbox -eq [IntPtr]::Zero) { throw 'Welcome checkbox with expected localized label was not found.' }
    $initial = [InstallerSmokeUi]::Checked($checkbox)
    if ($null -ne $case.select -and $initial -ne [int]$case.select) { [InstallerSmokeUi]::Click($checkbox) }
    if ($null -ne $case.select -and [InstallerSmokeUi]::Checked($checkbox) -ne [int]$case.select) { throw 'Checkbox click did not change its state.' }
    [InstallerSmokeUi]::Next($window)
  }
  if (-not $process.WaitForExit(20000)) { throw 'Installer did not finish within 20 seconds.' }
  if ($case.denyApprovedRead) {
    # Restore query access before inspecting the installer's resulting bytes.
    $restoreAcl = [System.Security.AccessControl.RegistrySecurity]::new()
    $restoreAcl.SetSecurityDescriptorBinaryForm($savedAcl, [System.Security.AccessControl.AccessControlSections]::Access)
    $registryHandle.SetAccessControl($restoreAcl)
    $savedAcl = $null
  }
  $read = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($case.registryKey)
  try { $value = $read.GetValue('TestStartup', $null) } finally { $read.Close() }
  $approvedRead = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($case.approvedKey)
  $approved = $null
  $approvedKind = $null
  if ($null -ne $approvedRead) {
    try {
      $approved = $approvedRead.GetValue('TestStartup', $null)
      if ($null -ne $approved) { $approvedKind = $approvedRead.GetValueKind('TestStartup').ToString() }
    } finally { $approvedRead.Close() }
  }
  [pscustomobject]@{ exitCode = $process.ExitCode; initial = $initial; value = $value; approvedKeyExists = ($null -ne $approvedRead); approved = $approved; approvedKind = $approvedKind } | ConvertTo-Json -Compress
} finally {
  if ($null -ne $process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force }
  if ($null -ne $savedAcl) {
    $restoreAcl = [System.Security.AccessControl.RegistrySecurity]::new()
    $restoreAcl.SetSecurityDescriptorBinaryForm($savedAcl, [System.Security.AccessControl.AccessControlSections]::Access)
    $registryHandle.SetAccessControl($restoreAcl)
  }
  if ($null -ne $registryHandle) { $registryHandle.Close() }
  [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($case.registryKey, $false)
}
`;

function run(executable, args) {
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 60_000, windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${executable} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

try {
  const nsi = path.join(work, 'smoke.nsi');
  const ps = path.join(work, 'driver.ps1');
  writeFileSync(nsi, '\uFEFF' + script);
  writeFileSync(ps, '\uFEFF' + driver);
  const compile = run(makensis, ['/V3', nsi]);
  assert.ok(!/warning 6000:/i.test(compile), `Unused callbacks in compiled hook:\n${compile}`);
  assert.ok(!/warning 6040:/i.test(compile), `Missing language strings:\n${compile}`);
  console.log('PASS: real NSIS hook compiles with early include, Welcome callbacks, English and SimpChinese.');

  const approvedEnabled = [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const approvedDisabled = [3, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0];
  const cases = [
    { name: 'clean interactive install defaults off', gui: true, initial: 0, enabled: false },
    { name: 'English checkbox enables startup', gui: true, select: 1, initial: 0, enabled: true },
    { name: 'Chinese checkbox enables startup', gui: true, language: 2052, select: 1, initial: 0, enabled: true },
    { name: 'existing interactive startup defaults on', gui: true, existing: true, initial: 1, enabled: true },
    { name: 'unchecking clears existing startup', gui: true, existing: true, select: 0, initial: 1, enabled: false },
    { name: 'interactive upgrade restores captured startup', gui: true, existing: true, removeOld: true, initial: 1, enabled: true },
    { name: 'interactive upgrade keeps explicit opt-out', gui: true, existing: true, select: 0, removeOld: true, initial: 1, enabled: false },
    { name: 'passive upgrade restores startup deleted by old uninstaller', passive: true, existing: true, removeOld: true, enabled: true },
    { name: 'clean passive install stays off', passive: true, enabled: false },
    { name: 'silent install preserves existing startup', existing: true, enabled: true },
    { name: 'clean silent install stays off', enabled: false },
    { name: 'real registry write denial fails installation', existing: true, denyWrite: true, fails: true },
    { name: 'real registry delete denial fails installation', denyWrite: true, fails: true },
    { name: 'task-manager disabled startup defaults off', gui: true, existing: true, approved: approvedDisabled, initial: 0, enabled: false },
    { name: 'checkbox resets task-manager disabled binary and updates path', gui: true, existing: true, approved: approvedDisabled, select: 1, initial: 0, enabled: true },
    { name: 'silent install keeps task-manager disabled startup off', existing: true, approved: approvedDisabled, enabled: false },
    { name: 'passive upgrade keeps task-manager disabled startup off', passive: true, existing: true, approved: approvedDisabled, removeOld: true, enabled: false },
    { name: 'approved enabled binary preserves startup', existing: true, approved: approvedEnabled, enabled: true },
    { name: 'missing approved value defaults enabled and gets reset', existing: true, approvedKeyExists: true, enabled: true },
    { name: 'short approved binary defaults enabled', existing: true, approved: [3, 0, 0], enabled: true },
    { name: 'first byte alone does not determine effective status', existing: true, approved: [3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], enabled: true },
    { name: 'extended approved record checks final eight bytes', gui: true, existing: true, approved: [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], initial: 0, enabled: false },
    { name: 'real approved-key write denial fails installation', existing: true, approved: approvedEnabled, denyApproved: true, fails: true },
    { name: 'unreadable approved record defaults enabled like the plugin', existing: true, approved: approvedDisabled, denyApprovedRead: true, enabled: true },
  ];
  for (const test of cases) {
    rmSync(path.join(work, 'state.txt'), { force: true });
    rmSync(path.join(work, 'completed.txt'), { force: true });
    const language = test.language ?? 1033;
    const args = [test.gui ? '' : test.passive ? '/P' : '/S', `/LANG=${language}`, test.removeOld ? '/REMOVEOLD' : ''].filter(Boolean).join(' ');
    const casePath = path.join(work, 'case.json');
    writeFileSync(casePath, JSON.stringify({ ...test, registryKey, approvedKey, installer, args, label: language === 2052 ? '登录 Windows 时启动 Spellcast' : 'Start Spellcast when I sign in' }));
    const result = JSON.parse(run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps, '-CasePath', casePath]));
    if (test.fails) {
      assert.equal(result.exitCode, 1, `${test.name}: expected error exit code`);
      assert.equal(existsSync(path.join(work, 'completed.txt')), false, `${test.name}: hook falsely completed`);
    } else {
      assert.equal(result.exitCode, 0, `${test.name}: unexpected installer error`);
      assert.equal(existsSync(path.join(work, 'completed.txt')), true, `${test.name}: missing completion marker`);
      assert.equal(result.value ?? null, test.enabled ? `"${path.join(work, 'Installed App', 'spellcast-smoke.exe')}"` : null, `${test.name}: wrong startup command`);
    }
    const hasApprovedKey = Boolean(test.approvedKeyExists || test.approved);
    assert.equal(result.approvedKeyExists, hasApprovedKey, `${test.name}: approved key was unexpectedly created or removed`);
    const expectedApproved = !test.fails && test.enabled && hasApprovedKey ? approvedEnabled : test.approved ?? null;
    assert.deepEqual(result.approved, expectedApproved, `${test.name}: wrong StartupApproved bytes`);
    if (expectedApproved) assert.equal(result.approvedKind, 'Binary', `${test.name}: StartupApproved must be REG_BINARY`);
    if (test.gui) assert.equal(result.initial, test.initial, `${test.name}: wrong default checkbox state`);
    const beforeSection = readFileSync(path.join(work, 'state.txt'), 'utf8').split('|');
    assert.equal(beforeSection[0], test.gui || test.passive ? '1' : '', `${test.name}: unexpected GUIInit capture`);
    console.log(`PASS: ${test.name}`);
  }
  console.log('Verified real callback execution, localized labels, quoted paths, no-value deletion, registry failures, /S and /P, captured-state restoration, and plugin-compatible StartupApproved behavior.');
  console.log('Boundary: the isolated harness simulates old-uninstaller deletion; it does not install/uninstall the real Spellcast bundle or check visual layout at different DPI scales.');
} finally {
  rmSync(work, { recursive: true, force: true });
}
