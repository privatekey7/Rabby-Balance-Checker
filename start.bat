@echo off
echo Checking dependencies...

IF NOT EXIST "node_modules" (
    echo Installing dependencies...
    call npm install
    echo Dependencies installed successfully!
    echo.
)

echo Starting wallet balance checker...
call npm start
pause 