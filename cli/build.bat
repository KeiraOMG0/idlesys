@echo off
setlocal

set VENV_PY=venv\Scripts\python.exe
set SYS_PY=C:\Program Files\PyManager\python.exe

if exist "%VENV_PY%" (
    set PY=%VENV_PY%
    echo Using venv Python
) else if exist "%SYS_PY%" (
    set PY=%SYS_PY%
    echo Venv not found -- using PyManager Python
    "%SYS_PY%" -m pip install -r requirements.txt --quiet
) else (
    set PY=python
    echo Falling back to PATH python
    python -m pip install -r requirements.txt --quiet
)

echo Building idlesys.exe...
"%PY%" -m PyInstaller --onefile --name idlesys --console --clean --collect-all textual --collect-all rich idlesys_cli.py

if exist dist\idlesys.exe (
    echo.
    echo Build OK: cli\dist\idlesys.exe
    echo Copying to ..\dist\idlesys.exe ...
    if not exist ..\dist mkdir ..\dist
    copy /Y dist\idlesys.exe ..\dist\idlesys.exe
    echo Done. Run /admin release in Discord to post.
) else (
    echo ERROR: dist\idlesys.exe not found -- build failed
    exit /b 1
)

endlocal
