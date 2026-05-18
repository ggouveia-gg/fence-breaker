!macro customInstall
  SetDetailsPrint both
  DetailPrint "Instalando plugin do OBS..."
  SetOutPath "$TEMP\FenceBreaker"
  File "${BUILD_RESOURCES_DIR}\fence-breaker.dll"
  ClearErrors
  CopyFiles /SILENT "$TEMP\FenceBreaker\fence-breaker.dll" \
    "C:\Program Files\obs-studio\obs-plugins\64bit\fence-breaker.dll"
  ${If} ${Errors}
    CopyFiles /SILENT "$TEMP\FenceBreaker\fence-breaker.dll" \
      "$PROGRAMFILES64\obs-studio\obs-plugins\64bit\fence-breaker.dll"
  ${EndIf}
  DetailPrint "Plugin instalado!"
!macroend

!macro customUnInstall
  Delete "C:\Program Files\obs-studio\obs-plugins\64bit\fence-breaker.dll"
  Delete "$PROGRAMFILES64\obs-studio\obs-plugins\64bit\fence-breaker.dll"
!macroend
