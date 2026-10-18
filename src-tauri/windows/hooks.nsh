; Memo: NSIS installer hooks (bundle.windows.nsis.installerHooks).
;
; Adds "Start Memo when Windows starts" to the installer's welcome page,
; checked by default. Tauri includes this file before the installer's pages,
; so the SHOW / LEAVE functions defined here attach to the first page inserted
; after it: the welcome page. Passive/silent installs skip that page and keep
; the default (on).
;
; The Run value has the same name ("Memo") and argument (--autostart) as the
; one written by tauri-plugin-autostart, so Configurações → "Iniciar com o
; sistema" in the app shows and changes the installer's choice.

!include LogicLib.nsh
!include nsDialogs.nsh

!define MEMO_RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"

Var MemoAutostartCheckbox
; "off" when unchecked; empty (page skipped) = on.
Var MemoAutostartChoice

!define MUI_PAGE_CUSTOMFUNCTION_SHOW MemoWelcomeShow
Function MemoWelcomeShow
  ${If} $LANGUAGE == 1046 ; Portuguese (Brazil)
    StrCpy $0 "Iniciar o Memo junto com o Windows"
  ${Else}
    StrCpy $0 "Start Memo when Windows starts"
  ${EndIf}
  ${NSD_CreateCheckbox} 120u 172u 195u 12u "$0"
  Pop $MemoAutostartCheckbox
  SetCtlColors $MemoAutostartCheckbox "" "FFFFFF"
  ${If} $MemoAutostartChoice != "off"
    ${NSD_Check} $MemoAutostartCheckbox
  ${EndIf}
FunctionEnd

!define MUI_PAGE_CUSTOMFUNCTION_LEAVE MemoWelcomeLeave
Function MemoWelcomeLeave
  ${NSD_GetState} $MemoAutostartCheckbox $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $MemoAutostartChoice "on"
  ${Else}
    StrCpy $MemoAutostartChoice "off"
  ${EndIf}
FunctionEnd

!macro NSIS_HOOK_POSTINSTALL
  ${If} $MemoAutostartChoice == "off"
    DeleteRegValue HKCU "${MEMO_RUN_KEY}" "${PRODUCTNAME}"
  ${Else}
    WriteRegStr HKCU "${MEMO_RUN_KEY}" "${PRODUCTNAME}" '"$INSTDIR\${MAINBINARYNAME}.exe" --autostart'
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegValue HKCU "${MEMO_RUN_KEY}" "${PRODUCTNAME}"
!macroend
