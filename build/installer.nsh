; Webline hieß bis Version 1.8 "Webcase": Verknüpfungen mit dem alten Namen entfernen, sie zeigen auf Webcase.exe,
; die es nach dem Update nicht mehr gibt.
;
; Desktop-Symbol (seit 1.13): electron-builder legt es NICHT mehr an (createDesktopShortcut: false), sonst
; löscht das alte Deinstallationsprogramm es bei jedem Update von Hand und das neue legt es wieder an - es
; springt an eine andere Stelle oder kommt zurück, obwohl man es gelöscht hat. Stattdessen:
;   - Erst-Installation (noch kein Webline installiert): Symbol anlegen
;   - Update (Auto-Updater oder Setup von Hand über eine vorhandene Installation): Symbol nicht anfassen.
;     Nur wenn das alte Deinstallationsprogramm (bis 1.12) es gerade gelöscht hat, wird es wiederhergestellt.
;   - Deinstallieren: Symbol entfernen, beim Update (Deinstallation der alten Version) nicht.

; Die Variablen nur im Installer (im Deinstallationsprogramm wären sie unbenutzt = Warnung = Build-Fehler)
!ifndef BUILD_UNINSTALLER
  Var /GLOBAL weblineFreshInstall
  Var /GLOBAL weblineHadDesktopLink
!endif

!macro customInit
  ; läuft vor dem Entfernen der alten Version: ist Webline schon installiert, und gibt es das Desktop-Symbol?
  StrCpy $weblineFreshInstall "1"
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  StrCmp $0 "" 0 webline_installed
  ReadRegStr $0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  StrCmp $0 "" webline_check_done webline_installed
  webline_installed:
    StrCpy $weblineFreshInstall "0"
  webline_check_done:
  StrCpy $weblineHadDesktopLink "0"
  IfFileExists "$DESKTOP\${SHORTCUT_NAME}.lnk" 0 +2
    StrCpy $weblineHadDesktopLink "1"
!macroend

!macro customInstall
  Delete "$DESKTOP\Webcase.lnk"
  Delete "$SMPROGRAMS\Webcase.lnk"

  StrCpy $1 ""
  ${ifNot} ${isUpdated}
    ${if} $weblineFreshInstall == "1"
      StrCpy $1 "create"
    ${endIf}
  ${endIf}
  ${if} $weblineHadDesktopLink == "1"
    ${ifNot} ${FileExists} "$DESKTOP\${SHORTCUT_NAME}.lnk"
      StrCpy $1 "create"
    ${endIf}
  ${endIf}
  ${if} $1 == "create"
    CreateShortCut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$DESKTOP\${SHORTCUT_NAME}.lnk" "${APP_ID}"
  ${endIf}

  ; für "Standard-Apps" in den Windows-Einstellungen: Typen mit den ProgIDs, die electron-builder anlegt (= "name" in package.json)
  DeleteRegKey SHCTX "Software\Webline\Capabilities"
  WriteRegStr SHCTX "Software\Webline\Capabilities" "ApplicationName" "Webline"
  WriteRegStr SHCTX "Software\Webline\Capabilities" "ApplicationDescription" "HTML files as real programs"
  WriteRegStr SHCTX "Software\Webline\Capabilities" "ApplicationIcon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHCTX "Software\Webline\Capabilities\FileAssociations" ".html" "HTML-Datei"
  WriteRegStr SHCTX "Software\Webline\Capabilities\FileAssociations" ".htm" "HTM-Datei"
  WriteRegStr SHCTX "Software\Webline\Capabilities\FileAssociations" ".xhtml" "XHTML-Datei"
  WriteRegStr SHCTX "Software\Webline\Capabilities\FileAssociations" ".mhtml" "Webarchiv"
  WriteRegStr SHCTX "Software\Webline\Capabilities\FileAssociations" ".mht" "Webarchiv"
  WriteRegStr SHCTX "Software\Webline\Capabilities\FileAssociations" ".pdf" "PDF-Dokument"
  WriteRegStr SHCTX "Software\Webline\Capabilities\FileAssociations" ".svg" "SVG-Grafik"
  WriteRegStr SHCTX "Software\Webline\Capabilities\FileAssociations" ".md" "Markdown-Datei"
  WriteRegStr SHCTX "Software\RegisteredApplications" "Webline" "Software\Webline\Capabilities"
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    ; echtes Deinstallieren: Desktop-Symbol weg (beim Update bleibt es, wo es ist)
    WinShell::UninstShortcut "$DESKTOP\${SHORTCUT_NAME}.lnk"
    Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
    DeleteRegKey SHCTX "Software\Webline\Capabilities"
    DeleteRegKey /ifempty SHCTX "Software\Webline"
    DeleteRegValue SHCTX "Software\RegisteredApplications" "Webline"
  ${endIf}
!macroend
