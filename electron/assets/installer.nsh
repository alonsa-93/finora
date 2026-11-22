; Finora - custom NSIS steps (electron-builder "nsis.include").
; Uninstall: stop "Start with Windows" and ask whether to delete the user's data as well
; (%LOCALAPPDATA%\Finora: encrypted data, the wrapped key, logs, settings). Default = keep.
; Never runs during an update (isUpdated) and keeps the data in silent mode.

!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Finora"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "MoneyCash" ; the name before 1.1
    ${ifNot} ${Silent}
      ${if} ${Cmd} `MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "למחוק גם את כל הנתונים של Finora מהמחשב?$\r$\n$\r$\nהתנועות, החיבורים, פרטי ההתחברות המוצפנים ומפתח ההצפנה שבתיקייה$\r$\n$LOCALAPPDATA\Finora$\r$\nיימחקו לצמיתות.$\r$\n$\r$\nבחירה ב'לא' משאירה אותם, כדי שהתקנה מחדש תמשיך מאותו מקום." IDYES`
        RMDir /r "$LOCALAPPDATA\Finora"
      ${endIf}
    ${endIf}
  ${endIf}
!macroend
