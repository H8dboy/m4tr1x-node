# M4TR1X — Push to GitHub
# Run this once in PowerShell to upload the code

Write-Host ""
Write-Host "=======================================" -ForegroundColor Green
Write-Host "  M4TR1X v2.0 — Push to GitHub" -ForegroundColor Green
Write-Host "=======================================" -ForegroundColor Green
Write-Host ""
Write-Host "You need a GitHub Personal Access Token (PAT)." -ForegroundColor Yellow
Write-Host "Get one at: https://github.com/settings/tokens/new" -ForegroundColor Cyan
Write-Host "  -> Scopes needed: check 'repo'" -ForegroundColor Cyan
Write-Host ""

$token = Read-Host "Paste your GitHub PAT here"

if (-not $token) {
    Write-Host "No token entered. Aborting." -ForegroundColor Red
    exit 1
}

# Set remote URL with token embedded
git remote set-url origin "https://$token@github.com/H8dboy/m4tr1x-electron.git"

Write-Host ""
Write-Host "Pushing to GitHub..." -ForegroundColor Yellow

git push -u origin main

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "SUCCESS! Code pushed to GitHub." -ForegroundColor Green
    Write-Host "https://github.com/H8dboy/m4tr1x-electron" -ForegroundColor Cyan
} else {
    Write-Host ""
    Write-Host "Push failed. Check the error above." -ForegroundColor Red
}

# Remove token from remote URL for security
git remote set-url origin "https://github.com/H8dboy/m4tr1x-electron.git"

Write-Host ""
Write-Host "Press any key to close..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
