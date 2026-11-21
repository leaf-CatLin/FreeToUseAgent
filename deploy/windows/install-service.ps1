<#
.SYNOPSIS
    把 Our Free Model 独立服务注册成 Windows 任务计划程序任务（开机启动）。

.DESCRIPTION
    用任务计划程序而不是 sc.exe：服务本体是一个普通 Node 进程，不需要 SCM 包装，
    也不需要第三方工具。任务的执行身份是当前用户（服务需要读写自己的数据目录），
    因此不需要管理员权限即可长期运行推理；安装/卸载任务本身需要管理员。

    只发布推理面：管理台仍然只监听回环（见 docs/protocols.md 与 deploy/README.md）。

.PARAMETER NodePath
    node.exe 的完整路径。默认取 PATH 里的 node。

.PARAMETER RepoPath
    本仓库检出目录（含 packages/standalone/cli.mjs）。

.PARAMETER DataDir
    数据目录（settings.json、channel-credentials.json、channel-pack/）。默认 <RepoPath>\data。

.PARAMETER Port
    本机管理/推理端口，默认 18900（仅回环）。

.PARAMETER LanPort
    LAN 中继端口，默认 18901。

.PARAMETER TaskName
    任务名，默认 OurFreeModel。

.EXAMPLE
    .\install-service.ps1 -RepoPath 'C:\ofm\dsh-our-free-model' -DataDir 'C:\ofm\data'
#>
[CmdletBinding()]
param(
    [string]$NodePath = (Get-Command node -ErrorAction Stop).Source,
    [Parameter(Mandatory = $true)][string]$RepoPath,
    [string]$DataDir,
    [int]$Port = 18900,
    [int]$LanPort = 18901,
    [string]$TaskName = 'OurFreeModel'
)

$ErrorActionPreference = 'Stop'

function Assert-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw '安装任务计划需要管理员权限。请以管理员身份重新运行本脚本。'
    }
}

Assert-Administrator

$cli = Join-Path $RepoPath 'packages\standalone\cli.mjs'
if (-not (Test-Path -LiteralPath $cli)) { throw "找不到 $cli；-RepoPath 应指向仓库根目录。" }
if (-not (Test-Path -LiteralPath $NodePath)) { throw "找不到 node：$NodePath" }
if ($Port -lt 1 -or $Port -gt 65535) { throw 'Port 必须在 1 到 65535 之间。' }
if ($LanPort -lt 0 -or $LanPort -gt 65535) { throw 'LanPort 必须在 0 到 65535 之间。' }
if (-not $DataDir) { $DataDir = Join-Path $RepoPath 'data' }

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
$logDir = Join-Path $DataDir 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$arguments = @(
    "`"$cli`"",
    '--data-dir', "`"$DataDir`"",
    '--port', "$Port",
    '--lan',
    '--lan-port', "$LanPort"
) -join ' '

$action = New-ScheduledTaskAction -Execute $NodePath -Argument $arguments -WorkingDirectory $RepoPath
# AtStartup 覆盖重启后自动恢复；RestartCount 处理崩溃。
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

# 只放行 LAN 中继端口，且仅限私网配置；本机端口不需要入站规则。
$ruleName = "$TaskName LAN relay"
$existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if ($existing) { Remove-NetFirewallRule -DisplayName $ruleName }
if ($LanPort -gt 0) {
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP `
        -LocalPort $LanPort -Profile Private -Program $NodePath | Out-Null
}

Write-Host "已注册计划任务：$TaskName"
Write-Host "  数据目录：$DataDir"
Write-Host "  本机端口：$Port（管理台仅回环）"
Write-Host "  LAN 端口：$LanPort"
if ($LanPort -gt 0) { Write-Host "  防火墙规则：$ruleName（仅私网配置）" }
Write-Host ''
Write-Host '启动：Start-ScheduledTask -TaskName ''' + $TaskName + ''''
Write-Host '日志：Get-Content "' + (Join-Path $logDir 'service.log') + '" -Wait'
Write-Host ''
Write-Host '注意：任务用你的身份运行，因此能读写数据目录里的明文凭据。'
Write-Host '取 LAN Key：本机管理台，或加 --lan-key-out 重启服务。'