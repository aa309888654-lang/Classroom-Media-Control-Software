# 把被 ZCode 进程占用的 4 个旧版 app.asar 及其空壳目录登记为「重启后自动删除」
$ErrorActionPreference = 'Stop'
$key = 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager'
$targets = @(
  'I:\教务系统\软件封装\win-unpacked\resources\app.asar',
  'I:\教务系统\软件封装\win-unpacked\resources',
  'I:\教务系统\软件封装\win-unpacked',
  'I:\教务系统\软件封装',
  'I:\教务系统\软件封装-修复版\win-unpacked\resources\app.asar',
  'I:\教务系统\软件封装-修复版\win-unpacked\resources',
  'I:\教务系统\软件封装-修复版\win-unpacked',
  'I:\教务系统\软件封装-修复版',
  'I:\教务系统\软件封装-新版本\win-unpacked\resources\app.asar',
  'I:\教务系统\软件封装-新版本\win-unpacked\resources',
  'I:\教务系统\软件封装-新版本\win-unpacked',
  'I:\教务系统\软件封装-新版本',
  'I:\教务系统\软件封装-v0.1.1\win-unpacked\resources\app.asar',
  'I:\教务系统\软件封装-v0.1.1\win-unpacked\resources',
  'I:\教务系统\软件封装-v0.1.1\win-unpacked',
  'I:\教务系统\软件封装-v0.1.1'
)
# PendingFileRenameOperations 格式：源路径(\??\前缀) 与目标路径成对出现，目标为空串 = 删除
$pair = @()
foreach ($t in $targets) { $pair += ('\??\' + $t); $pair += '' }
try {
  $existing = (Get-ItemProperty -Path $key -Name PendingFileRenameOperations -ErrorAction SilentlyContinue).PendingFileRenameOperations
  if ($existing) { $pair = $existing + $pair }
  Set-ItemProperty -Path $key -Name PendingFileRenameOperations -Value $pair -Type MultiString
  Write-Host 'REGISTRY_OK — 将在下次重启时自动删除'
} catch {
  Write-Host ('REGISTRY_FAILED: ' + $_.Exception.Message)
}
