@echo off
REM Open WebUI on Cloudflare Workers - local development in one command (Windows).
REM
REM   start-workers.bat            build the UI (if needed) and run wrangler dev
REM   start-workers.bat --mock     ...and start a mock model server, so no API key is needed
REM   start-workers.bat --rebuild  force a fresh frontend build
REM
REM Then open http://localhost:8787 - the first account you create becomes the admin.

setlocal enabledelayedexpansion
cd /d "%~dp0"

set MOCK=0
set REBUILD=0
set PORT=8787

:parse
if "%~1"=="" goto parsed
if /i "%~1"=="--mock" set MOCK=1
if /i "%~1"=="--rebuild" set REBUILD=1
shift
goto parse
:parsed

where node >nul 2>nul
if errorlevel 1 (
	echo Node.js 18+ is required. Install it from https://nodejs.org
	exit /b 1
)

if not exist node_modules (
	echo ==^> Installing frontend dependencies ^(first run takes a few minutes^)
	set CYPRESS_INSTALL_BINARY=0
	call npm install --no-audit --no-fund || exit /b 1
)

if not exist workers\node_modules (
	echo ==^> Installing worker dependencies
	call npm --prefix workers install --no-audit --no-fund || exit /b 1
)

if "%REBUILD%"=="1" goto build
if not exist build\index.html goto build
goto builddone
:build
echo ==^> Building the SvelteKit frontend into .\build
call npm run build:workers || exit /b 1
:builddone

if not exist workers\.dev.vars (
	echo ==^> Creating workers\.dev.vars with a development signing key
	for /f %%i in ('node -e "console.log(require(''crypto'').randomBytes(32).toString(''hex''))"') do set SECRET=%%i
	> workers\.dev.vars echo # Local development secrets. Never commit this file.
	>> workers\.dev.vars echo WEBUI_SECRET_KEY=!SECRET!
	>> workers\.dev.vars echo # OPENAI_API_BASE_URL=https://api.openai.com/v1
	>> workers\.dev.vars echo # OPENAI_API_KEY=sk-...
)

echo ==^> Applying D1 migrations to the local database
call npm --prefix workers exec -- wrangler d1 migrations apply open-webui --local || exit /b 1

if "%MOCK%"=="1" (
	echo ==^> Starting the mock model server on http://127.0.0.1:11435/v1
	start "open-webui mock model" cmd /c node workers\scripts\mock-openai.mjs
	findstr /b /c:"OPENAI_API_BASE_URL=" workers\.dev.vars >nul 2>nul
	if errorlevel 1 (
		>> workers\.dev.vars echo OPENAI_API_BASE_URL=http://127.0.0.1:11435/v1
		>> workers\.dev.vars echo OPENAI_API_KEY=mock-key
	)
)

echo ==^> Starting wrangler dev on http://localhost:%PORT%
echo     The first account you create becomes the administrator.
cd workers
call npx wrangler dev --port %PORT%
