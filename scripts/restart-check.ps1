$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$env:GOL_DB = Join-Path $root 'data\srv.sqlite'
$env:PORT = '8321'
$p = Start-Process node -ArgumentList 'dist/src/server.js' -WorkingDirectory (Join-Path $PSScriptRoot '..') -PassThru -WindowStyle Hidden
Start-Sleep 2
try {
  $r = Invoke-RestMethod 'http://127.0.0.1:8321/api/runs/1/generations/40'
  Write-Host "restart-read gen40 pop=$($r.data.population) period=$($r.data.cycle.period)"
  $a = Invoke-RestMethod 'http://127.0.0.1:8321/api/runs/1/generations/0/ascii'
  Write-Host ($a.data.ascii -split [Environment]::NewLine)[0]
} finally {
  Stop-Process $p.Id
}
