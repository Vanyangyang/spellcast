; Included before Tauri's product constants and variables. Keep callbacks here,
; and expand product-dependent commands only inside the POSTINSTALL hook.
!ifndef SPELLCAST_AUTOSTART_HOOK_INCLUDED
!define SPELLCAST_AUTOSTART_HOOK_INCLUDED

; Test harnesses override these to avoid touching the real startup entry.
!ifndef SPELLCAST_AUTOSTART_REGISTRY_KEY
  !define SPELLCAST_AUTOSTART_REGISTRY_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
!endif
!ifndef SPELLCAST_AUTOSTART_REGISTRY_NAME
  !define SPELLCAST_AUTOSTART_REGISTRY_NAME "Spellcast"
!endif
!ifndef SPELLCAST_AUTOSTART_APPROVED_KEY
  !define SPELLCAST_AUTOSTART_APPROVED_KEY "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run"
!endif

Var SpellcastAutostartCaptured
Var SpellcastAutostartEnabled
Var SpellcastAutostartCheckbox
Var SpellcastAutostartInteractive
Var SpellcastAutostartReadValue
Var SpellcastAutostartResult

LangString SpellcastAutostartLabel 1033 "Start Spellcast when I sign in"
LangString SpellcastAutostartLabel 2052 "登录 Windows 时启动 Spellcast"
LangString SpellcastAutostartFailed 1033 "Unable to update the Windows startup setting. Installation could not complete."
LangString SpellcastAutostartFailed 2052 "无法更新 Windows 开机启动设置，安装未能完成。"

!define MUI_CUSTOMFUNCTION_GUIINIT SpellcastAutostartCapture
!define MUI_PAGE_CUSTOMFUNCTION_SHOW SpellcastAutostartWelcomeShow
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE SpellcastAutostartWelcomeLeave

Function SpellcastAutostartCapture
  ; Capture once, before PageReinstall can run an older uninstaller. /S does
  ; not invoke GUIInit; its state is read later by POSTINSTALL instead.
  StrCmp $SpellcastAutostartCaptured "1" capture_done
  StrCpy $SpellcastAutostartEnabled "0"
  ClearErrors
  ReadRegStr $SpellcastAutostartReadValue HKCU "${SPELLCAST_AUTOSTART_REGISTRY_KEY}" "${SPELLCAST_AUTOSTART_REGISTRY_NAME}"
  IfErrors capture_recorded
  StrCpy $SpellcastAutostartEnabled "1"
  Call SpellcastAutostartReadApproved
  capture_recorded:
  StrCpy $SpellcastAutostartCaptured "1"
  ClearErrors
  capture_done:
FunctionEnd

Function SpellcastAutostartReadApproved
  ; Match auto-launch 0.5.0: unreadable/missing or fewer than eight bytes
  ; means enabled; otherwise the final eight raw bytes must all be zero.
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  System::Call 'advapi32::RegOpenKeyExW(p 0x80000001, w "${SPELLCAST_AUTOSTART_APPROVED_KEY}", i 0, i 0x20019, *p.r0) i.r1'
  StrCmp $1 0 0 approved_read_done
  System::Call 'advapi32::RegQueryValueExW(p r0, w "${SPELLCAST_AUTOSTART_REGISTRY_NAME}", p 0, p 0, p 0, *i.r2) i.r1'
  StrCmp $1 0 0 approved_read_close
  IntCmp $2 8 0 approved_read_close 0
  System::Alloc $2
  Pop $3
  StrCmp $3 0 approved_read_close
  System::Call 'advapi32::RegQueryValueExW(p r0, w "${SPELLCAST_AUTOSTART_REGISTRY_NAME}", p 0, p 0, p r3, *i r2r2) i.r1'
  StrCmp $1 0 0 approved_read_free
  IntCmp $2 8 0 approved_read_free 0
  IntOp $4 $3 + $2
  IntOp $4 $4 - 8
  System::Call '*$4(i.r1, i.r2)'
  StrCmp $1 0 0 approved_read_disabled
  StrCmp $2 0 approved_read_free
  approved_read_disabled:
  StrCpy $SpellcastAutostartEnabled "0"
  approved_read_free:
  System::Free $3
  approved_read_close:
  System::Call 'advapi32::RegCloseKey(p r0)'
  approved_read_done:
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function SpellcastAutostartEnableApproved
  ; Do not create StartupApproved on profiles where Windows has not made it.
  ; If it exists, reset the task-manager override to the plugin's 12 bytes:
  ; REG_BINARY 02 00 00 00 00 00 00 00 00 00 00 00.
  Push $0
  Push $1
  Push $2
  System::Call 'advapi32::RegOpenKeyExW(p 0x80000001, w "${SPELLCAST_AUTOSTART_APPROVED_KEY}", i 0, i 2, *p.r0) i.r1'
  StrCpy $SpellcastAutostartResult $1
  StrCmp $1 2 approved_enable_missing
  StrCmp $1 0 0 approved_enable_done
  System::Alloc 12
  Pop $2
  StrCmp $2 0 approved_enable_allocation_failed
  System::Call '*$2(i 2, i 0, i 0)'
  System::Call 'advapi32::RegSetValueExW(p r0, w "${SPELLCAST_AUTOSTART_REGISTRY_NAME}", i 0, i 3, p r2, i 12) i.r1'
  StrCpy $SpellcastAutostartResult $1
  System::Free $2
  Goto approved_enable_close
  approved_enable_allocation_failed:
  StrCpy $SpellcastAutostartResult "8"
  approved_enable_close:
  System::Call 'advapi32::RegCloseKey(p r0)'
  Goto approved_enable_done
  approved_enable_missing:
  StrCpy $SpellcastAutostartResult "0"
  approved_enable_done:
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function SpellcastAutostartWelcomeShow
  Call SpellcastAutostartCapture
  StrCpy $SpellcastAutostartInteractive "1"
  ; The stock two-line Welcome text ends at 175u. This control remains within
  ; the 193u page and does not replace or shorten Tauri's welcome copy.
  ${NSD_CreateCheckbox} 120u 176u 195u 12u "$(SpellcastAutostartLabel)"
  Pop $SpellcastAutostartCheckbox
  SetCtlColors $SpellcastAutostartCheckbox "000000" "FFFFFF"
  ${NSD_SetState} $SpellcastAutostartCheckbox $SpellcastAutostartEnabled
FunctionEnd

Function SpellcastAutostartWelcomeLeave
  ${NSD_GetState} $SpellcastAutostartCheckbox $SpellcastAutostartEnabled
FunctionEnd

Function SpellcastAutostartDelete
  ; DeleteRegValue conflates missing values with real failures. This Windows
  ; API returns ERROR_FILE_NOT_FOUND (2) for an already disabled setting.
  Push $0
  System::Call 'advapi32::RegDeleteKeyValueW(p 0x80000001, w "${SPELLCAST_AUTOSTART_REGISTRY_KEY}", w "${SPELLCAST_AUTOSTART_REGISTRY_NAME}") i.r0'
  StrCpy $SpellcastAutostartResult $0
  Pop $0
FunctionEnd

Function SpellcastAutostartFailure
  DetailPrint "$(SpellcastAutostartFailed) ($SpellcastAutostartResult)"
  StrCmp $SpellcastAutostartInteractive "1" 0 failure_abort
  MessageBox MB_OK|MB_ICONSTOP "$(SpellcastAutostartFailed)"
  failure_abort:
  SetErrorLevel 1
  Abort
FunctionEnd

!macro NSIS_HOOK_POSTINSTALL
  Call SpellcastAutostartCapture
  ${If} $SpellcastAutostartEnabled == "1"
    ClearErrors
    WriteRegStr HKCU "${SPELLCAST_AUTOSTART_REGISTRY_KEY}" "${SPELLCAST_AUTOSTART_REGISTRY_NAME}" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\"'
    ${If} ${Errors}
      StrCpy $SpellcastAutostartResult "WriteRegStr"
      Call SpellcastAutostartFailure
    ${EndIf}
    Call SpellcastAutostartEnableApproved
    ${If} $SpellcastAutostartResult != "0"
      Call SpellcastAutostartFailure
    ${EndIf}
  ${Else}
    Call SpellcastAutostartDelete
    ${If} $SpellcastAutostartResult != "0"
    ${AndIf} $SpellcastAutostartResult != "2"
      Call SpellcastAutostartFailure
    ${EndIf}
  ${EndIf}
!macroend

!endif
