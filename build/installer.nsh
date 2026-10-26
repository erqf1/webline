; Webline hieß bis Version 1.8 "Webcase": Verknüpfungen mit dem alten Namen entfernen, sie zeigen auf Webcase.exe,
; die es nach dem Update nicht mehr gibt. Die neuen Verknüpfungen "Webline" legt der Installer selbst an.
!macro customInstall
  Delete "$DESKTOP\Webcase.lnk"
  Delete "$SMPROGRAMS\Webcase.lnk"
!macroend
