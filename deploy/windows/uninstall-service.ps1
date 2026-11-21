<#
.SYNOPSIS
    卸载 install-service.ps1 注册的计划任务与防火墙规则。

.DESCRIPTION
    只删除任务与本脚本创建的防火墙规则；数据目录原样保留（凭据、settings.json、
    channel-pack）。要一并清理数据目录，请显式传 -RemoveData。
#>
[CmdletBinding()]
param(
    [string]$TaskName = 'OurFreeModel',
    [switch]$RemoveData,
    [string]$DataDir
)

$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw '卸载任务计划需要管理员权限。请以管理员身份重新运行本脚本。'
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "已删除计划任务：$TaskName"
} else {
    Write-Host "未找到计划任务：$TaskName（跳过）"
}

$ruleName = "$TaskName LAN relay"
$rule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if ($rule) {
    Remove-NetFirewallRule -DisplayName $ruleName
    Write-Host "已删除防火墙规则：$ruleName"
}

if ($RemoveData) {
    if (-not $DataDir) { throw '-RemoveData 需要同时指定 -DataDir，以免删错目录。' }
    $resolved = [IO.Path]::GetFullPath($DataDir)
    if (-not (Test-Path -LiteralPath $resolved)) { Write-Host "数据目录不存在：$resolved"; return }
    # 只删除看起来确实是本服务数据目录的路径。
    $marker = Join-Path $resolved 'settings.json'
    $looksRight = (Test-Path -LiteralPath $marker) -or (Get-ChildItem -LiteralPath $resolved -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -in @('channel-credentials.json', 'channel-pack', 'service.lock') })
    if (-not $looksRight) { throw "拒绝删除 $resolved：它看起来不是 Our Free Model 的数据目录。" }
    Remove-Item -LiteralPath $resolved -Recurse -Force
    Write-Host "已删除数据目录：$resolved（其中包含明文凭据，删除后不可恢复）"
} else {
    Write-Host '数据目录已保留。需要清理时再加 -RemoveData -DataDir <目录>。'
}