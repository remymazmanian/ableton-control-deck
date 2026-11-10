@echo off
rem Signs files with Azure Artifact Signing, using the metadata in Documents\Code Signing.
rem Always the x64 signtool, also on ARM64 Windows, because the signing dlib is x64.
rem Inno Setup calls this as its "rmsign" tool for the installer and the uninstaller.
setlocal
if not defined SIGNTOOL set SIGNTOOL=C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe
if not defined SIGN_DLIB set SIGN_DLIB=%LOCALAPPDATA%\Microsoft\MicrosoftArtifactSigningClientTools\Azure.CodeSigning.Dlib.dll
if not defined SIGN_METADATA set SIGN_METADATA=%USERPROFILE%\Documents\Code Signing\metadata.json
"%SIGNTOOL%" sign /v /fd SHA256 /tr http://timestamp.acs.microsoft.com /td SHA256 /dlib "%SIGN_DLIB%" /dmdf "%SIGN_METADATA%" %*
exit /b %ERRORLEVEL%
