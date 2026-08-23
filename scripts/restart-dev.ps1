$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$lockPath = Join-Path $repoRoot ".dev-restart.lock"
if (Test-Path $lockPath) {
    $existingPid = $null
    try {
        $raw = Get-Content -Path $lockPath -Raw -ErrorAction Stop
        if ($raw) {
            $existingPid = [int]$raw
        }
    } catch {
        $existingPid = $null
    }

    $lockIsActive = $false
    if ($existingPid) {
        $proc = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
        if ($proc) {
            $lockIsActive = $true
        }
    }

    if ($lockIsActive) {
        Write-Error "Another restart session is already running (PID: $existingPid). Stop it first."
        exit 1
    }

    Remove-Item $lockPath -Force -ErrorAction SilentlyContinue
}

Set-Content -Path $lockPath -Value $PID -NoNewline

try {

$backendExePath = Join-Path $repoRoot "backend\target\debug\server.exe"

function Stop-StaleBackendProcesses {
    $serverProcesses = Get-Process -Name server -ErrorAction SilentlyContinue
    if (-not $serverProcesses) { return }

    foreach ($proc in $serverProcesses) {
        $procPath = $null
        try {
            $procPath = $proc.Path
        } catch {
            $procPath = $null
        }

        if ($procPath -and $procPath -ieq $backendExePath) {
            try {
                Stop-Process -Id $proc.Id -Force -ErrorAction Stop
                Write-Host "Stopped stale backend process $($proc.Id)"
            } catch {
                Write-Warning "Could not stop stale backend process $($proc.Id): $($_.Exception.Message)"
            }
        }
    }
}

function Stop-StaleDevSupervisors {
    $watchers = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            ($_.Name -ieq 'cargo-watch.exe') -and
            $_.CommandLine -and
            ($_.CommandLine -like "*$repoRoot*")
        }

    foreach ($watcher in $watchers) {
        try {
            Stop-Process -Id $watcher.ProcessId -Force -ErrorAction Stop
            Write-Host "Stopped stale cargo-watch process $($watcher.ProcessId)"
        } catch {
            Write-Warning "Could not stop stale cargo-watch process $($watcher.ProcessId): $($_.Exception.Message)"
        }
    }
}

function Stop-StaleBackendParents {
    $staleNodes = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            ($_.Name -ieq 'node.exe') -and
            $_.CommandLine -and
            ($_.CommandLine -like "*$repoRoot*") -and
            ($_.CommandLine -match 'concurrently')
        }

    foreach ($nodeProc in $staleNodes) {
        try {
            Stop-Process -Id $nodeProc.ProcessId -Force -ErrorAction Stop
            Write-Host "Stopped stale concurrently process $($nodeProc.ProcessId)"
        } catch {
            Write-Warning "Could not stop stale concurrently process $($nodeProc.ProcessId): $($_.Exception.Message)"
        }
    }

    $backendParents = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            ($_.Name -in @('cmd.exe', 'rustup.exe', 'cargo.exe')) -and
            $_.CommandLine -and
            ($_.CommandLine -like "*$repoRoot*") -and
            ($_.CommandLine -match 'backend[/\\]Cargo.toml|cargo\s+run\s+--manifest-path\s+backend')
        }

    foreach ($proc in $backendParents) {
        try {
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
            Write-Host "Stopped stale backend parent process $($proc.ProcessId) [$($proc.Name)]"
        } catch {
            Write-Warning "Could not stop stale backend parent process $($proc.ProcessId): $($_.Exception.Message)"
        }
    }
}

function Stop-ListeningPort {
    param([int]$Port)

    $connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if (-not $connections) { return }

    $pids = $connections | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($procId in $pids) {
        try {
            Stop-Process -Id $procId -Force -ErrorAction Stop
            Write-Host "Stopped process $procId on port $Port"
        } catch {
            Write-Warning "Could not stop process $procId on port ${Port}: $($_.Exception.Message)"
        }
    }
}

function Stop-BackendPortOwnerChain {
    param([int]$Port = 8080)

    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $listener) { return }

    $ownerId = [int]$listener.OwningProcess
    if ($ownerId -eq $PID) { return }

    $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $ownerId" -ErrorAction SilentlyContinue
    if (-not $owner) { return }

    $ownerName = $owner.Name
    $ownerCmd = [string]$owner.CommandLine
    Write-Host "Port $Port is held by PID $ownerId ($ownerName). Stopping it..."

    try {
        Stop-Process -Id $ownerId -Force -ErrorAction Stop
        Write-Host "Stopped PID $ownerId on port $Port"
    } catch {
        Write-Warning "Could not stop PID $ownerId on port ${Port}: $($_.Exception.Message)"
    }

    # If this is our Rust backend chain, also stop known parent launchers so it is not re-spawned immediately.
    if ($ownerName -ieq 'server.exe' -and $ownerCmd -like '*backend*target*debug*server.exe*') {
        $parentId = [int]$owner.ParentProcessId
        $hops = 0
        while ($parentId -gt 0 -and $hops -lt 6) {
            $hops++
            $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $parentId" -ErrorAction SilentlyContinue
            if (-not $parent) { break }

            $pName = [string]$parent.Name
            $pCmd = [string]$parent.CommandLine
            $nextParentId = [int]$parent.ParentProcessId

            $isKnownLauncher = $pName -in @('cargo.exe', 'rustup.exe', 'cmd.exe', 'node.exe')
            $isRepoRelated = $pCmd -like "*$repoRoot*"
            if ($isKnownLauncher -and $isRepoRelated) {
                try {
                    Stop-Process -Id $parentId -Force -ErrorAction Stop
                    Write-Host "Stopped stale launcher PID $parentId ($pName)"
                } catch {
                    Write-Warning "Could not stop stale launcher PID ${parentId}: $($_.Exception.Message)"
                }
            }

            $parentId = $nextParentId
        }
    }
}

function Wait-PortFree {
    param([int]$Port, [int]$Attempts = 20)

    for ($i = 0; $i -lt $Attempts; $i++) {
        $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $listener) {
            return $true
        }
        Start-Sleep -Milliseconds 250
    }

    return $false
}

# Backend + common Vite ports
$ports = @(8080, 5173, 5174, 5175, 5176, 5177, 5178)
foreach ($port in $ports) {
    Stop-ListeningPort -Port $port
}

Stop-StaleBackendProcesses
Stop-StaleDevSupervisors
Stop-StaleBackendParents

# Final safety pass for backend bind conflicts.
for ($i = 0; $i -lt 3; $i++) {
    Stop-BackendPortOwnerChain -Port 8080
    if (Wait-PortFree -Port 8080 -Attempts 8) {
        break
    }
}

if (-not (Wait-PortFree -Port 8080 -Attempts 4)) {
    Write-Error "Port 8080 is still busy after cleanup. Stop the conflicting process and retry."
    exit 1
}

npm run dev
} finally {
    if (Test-Path $lockPath) {
        Remove-Item $lockPath -Force -ErrorAction SilentlyContinue
    }
}
