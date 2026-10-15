<#
  发布前签名核验：Smart App Control / SmartScreen 的放行前提
  ------------------------------------------------------------------
  用法（在本文件所在目录的上两级，即 app\ 下执行）：
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-signature.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-signature.ps1 -Path "..\软件封装"
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-signature.ps1 -SkipZip
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-signature.ps1 -Installed

  退出码：0 = 全部已签名（且无未签名项）；1 = 存在未签名/签名异常项
  注意：绿色解压版 zip 内的 exe 也会被核验（解压到临时目录后检查并清理）
#>
param(
  [string]$Path = '',
  [switch]$SkipZip,
  [switch]$Installed
)

$ErrorActionPreference = 'Stop'

$appRoot = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent $appRoot
if ([string]::IsNullOrWhiteSpace($Path)) { $Path = Join-Path $repoRoot '软件封装' }

function Get-SacState {
  # 0=关闭 1=开启(拦截) 2=评估(只记录不拦截)
  try {
    $k = 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy'
    $v = (Get-ItemProperty -Path $k -ErrorAction Stop).VerifiedAndReputablePolicyState
    switch ("$v") { '0' { '关闭（不拦截）' } '1' { '开启（会拦截未签名程序）' } '2' { '评估（暂不拦截）' } default { "未知($v)" } }
  } catch { '无法读取' }
}

# 返回 PSCustomObject 数组；每个字段来自 Get-AuthenticodeSignature
function Test-SignedFile([string]$File, [string]$Label) {
  $sig = Get-AuthenticodeSignature -FilePath $File
  $stamp = if ($sig.TimeStamperCertificate) { $sig.TimeStamperCertificate.Subject } else { '(无时间戳)' }
  [pscustomobject]@{
    项目     = $Label
    文件     = Split-Path $File -Leaf
    状态     = "$($sig.Status)"
    签名者   = if ($sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { '(无)' }
    证书到期 = if ($sig.SignerCertificate) { $sig.SignerCertificate.NotAfter.ToString('yyyy-MM-dd') } else { '-' }
    时间戳   = $stamp
    合格     = ($sig.Status -eq 'Valid')
  }
}

Write-Host ''
Write-Host '===== 小天AIGC 发布前签名核验 =====' -ForegroundColor Cyan

Write-Host "`n[1] 智能应用控制（Smart App Control）状态: $(Get-SacState)"
if ((Get-SacState) -like '开启*') {
  Write-Host '    → 未签名程序在这类机器上会被硬拦，且没有“仍要运行”可点。签名是唯一解。' -ForegroundColor Yellow
}

if (-not (Test-Path $Path)) { Write-Host "目录不存在: $Path" -ForegroundColor Red; exit 1 }
Write-Host "`n[2] 检查目录: $Path"

$results = @()
foreach ($f in Get-ChildItem -Path $Path -Filter *.exe -File -ErrorAction SilentlyContinue) {
  if ($f.Name -like 'Uninstall*') { continue }   # NSIS 卸载器由安装包内部生成，不单独发布
  $results += Test-SignedFile $f.FullName '安装包'
}

if (-not $SkipZip) {
  $sevenZip = Join-Path $appRoot 'node_modules\7zip-bin\win\x64\7za.exe'
  foreach ($z in Get-ChildItem -Path $Path -Filter *.zip -File -ErrorAction SilentlyContinue) {
    if (Test-Path $sevenZip) {
      $tmp = Join-Path $env:TEMP ("xt-signcheck-" + [IO.Path]::GetRandomFileName())
      try {
        New-Item -ItemType Directory -Force -Path $tmp | Out-Null
        & $sevenZip x $z.FullName "-o$tmp" -y | Out-Null
        foreach ($e in Get-ChildItem -Path $tmp -Filter *.exe -Recurse -File -ErrorAction SilentlyContinue) {
          $results += Test-SignedFile $e.FullName 'zip 内部'
        }
      } finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
    } else {
      Write-Host "    跳过 $($z.Name) 的内部核验（缺少 7za）" -ForegroundColor DarkYellow
    }
  }
}

if ($Installed) {
  $inst = Join-Path $env:ProgramFiles 'xiaotian-aigc\小天AIGC.exe'
  if (Test-Path $inst) { $results += Test-SignedFile $inst '已安装' }
  else { Write-Host "    未找到已安装副本: $inst" -ForegroundColor DarkYellow }
}

if ($results.Count -eq 0) {
  Write-Host "`n没有找到任何 .exe 产物——是否还没打包？" -ForegroundColor Yellow
  exit 1
}

Write-Host ''
$results | Format-Table -AutoSize -Wrap

$bad = $results | Where-Object { -not $_.合格 }
Write-Host ''
if ($bad) {
  Write-Host "结论: $($bad.Count)/$($results.Count) 项不合格（状态必须是 Valid）" -ForegroundColor Red
  Write-Host '若为 NotSigned：构建时没有 CSC_LINK / 证书配置；见《签名与发布指南.md》。' -ForegroundColor Yellow
  exit 1
}
Write-Host "结论: $($results.Count)/$($results.Count) 项全部为 Valid" -ForegroundColor Green
exit 0
