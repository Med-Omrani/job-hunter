# JobCenter Docker watchdog — self-healing for reboots and daemon crashes.
# Ensures: Docker engine -> compose stack -> monitor.js -> APK :8090 server.
# Idempotent: only acts when something is missing; logs only on action (or engine down).
# Called by Scheduled Task "JobCenterDockerWatchdog" (logon + every 5 min).
# Never deletes volumes; never touches the legacy job_center stack.

$Repo = 'C:\Users\DELL\Desktop\jobcenter-docker'
$Daemon = Join-Path $Repo 'app\daemon'
$Log = Join-Path $Daemon 'events-watchdog.log'
$ApkDir = Join-Path $Repo 'app\jobcenter\build\app\outputs\flutter-apk'

function WLog([string]$type, [string]$detail = '') {
  $line = [ordered]@{ ts = (Get-Date).ToUniversalTime().ToString('o'); proc = 'watchdog'; type = $type }
  if ($detail) { $line['detail'] = $detail }
  try { ($line | ConvertTo-Json -Compress) | Out-File -FilePath $Log -Append -Encoding utf8 } catch {}
}

# 1. Docker engine -----------------------------------------------------------
docker info --format '{{.ServerVersion}}' >$null 2>&1
if ($LASTEXITCODE -ne 0) {
  try { Start-Process 'C:\Program Files\Docker\Docker\Docker Desktop.exe' -ErrorAction Stop } catch {
    WLog 'docker_start_failed' $_.Exception.Message; exit 0
  }
  $waited = 0
  while ($waited -lt 180) {
    Start-Sleep -Seconds 10; $waited += 10
    docker info --format '{{.ServerVersion}}' >$null 2>&1
    if ($LASTEXITCODE -eq 0) { break }
  }
  docker info --format '{{.ServerVersion}}' >$null 2>&1
  if ($LASTEXITCODE -ne 0) { WLog 'engine_down' "still down after ${waited}s"; exit 0 }
  WLog 'engine_started' "after ${waited}s"
}

# 2. Compose stack (only act if a container is missing/not running) ----------
$needUp = $false
foreach ($c in @('jobcenter-postgres', 'jobcenter-redis', 'jobcenter-api', 'jobcenter-nginx')) {
  $running = docker inspect -f '{{.State.Running}}' $c 2>$null
  if ($running -ne 'true') { $needUp = $true; break }
}
if ($needUp) {
  try {
    & docker compose up -d --working-directory $Repo 2>&1 | Out-Null
    WLog 'stack_up' 'docker compose up -d executed'
  } catch { WLog 'stack_up_failed' $_.Exception.Message }
}

# 3. Daemon monitor (watches hunters/worker/chatbot/applyworker itself) ------
$mon = Get-CimInstance Win32_Process -Filter "Name='node.exe'" 2>$null |
  Where-Object { $_.CommandLine -like '*app/daemon/monitor.js*' }
if (-not $mon) {
  try {
    Start-Process node -ArgumentList 'app/daemon/monitor.js' -WorkingDirectory $Repo -ErrorAction Stop
    WLog 'monitor_started' 'monitor.js was missing'
  } catch { WLog 'monitor_start_failed' $_.Exception.Message }
}

# 4. APK download server for phone installs (:8090) ---------------------------
$py = Get-CimInstance Win32_Process -Filter "Name='python.exe'" 2>$null |
  Where-Object { $_.CommandLine -like '*http.server*8090*' }
if ((-not $py) -and (Test-Path -LiteralPath $ApkDir)) {
  try {
    Start-Process python -ArgumentList '-m', 'http.server', '8090', '--directory', $ApkDir `
      -WorkingDirectory $ApkDir -ErrorAction Stop
    WLog 'apk_started' ':8090 was missing'
  } catch { WLog 'apk_start_failed' $_.Exception.Message }
}
