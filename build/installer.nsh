; Webline hieß bis Version 1.8 "Webcase": Verknüpfungen mit dem alten Namen entfernen, sie zeigen auf Webcase.exe,
; die es nach dem Update nicht mehr gibt. Die neuen Verknüpfungen "Webline" legt der Installer selbst an.
!macro customInstall
  Delete "$DESKTOP\Webcase.lnk"
  Delete "$SMPROGRAMS\Webcase.lnk"
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
    DeleteRegKey SHCTX "Software\Webline\Capabilities"
    DeleteRegKey /ifempty SHCTX "Software\Webline"
    DeleteRegValue SHCTX "Software\RegisteredApplications" "Webline"
  ${endIf}
!macroend
