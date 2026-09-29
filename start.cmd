@echo off
rem Cloud House: production build + local preview on http://127.0.0.1:5201
cd /d "%~dp0"
if not exist node_modules call npm install
call npx vite build
start "" http://127.0.0.1:5201/
call npx vite preview --host 127.0.0.1 --port 5201 --strictPort
