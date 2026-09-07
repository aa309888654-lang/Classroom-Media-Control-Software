# [ELEVATED] Close ZCode's stale asar handles and delete old build dirs.
# Result log: C:\Users\jickchen\AppData\Local\Temp\cleanup-result.txt
$log = 'C:\Users\jickchen\AppData\Local\Temp\cleanup-result.txt'
$handleExe = 'C:\Users\jickchen\AppData\Local\Temp\handle.exe'
'start ' + (Get-Date) | Out-File $log -Encoding utf8
try {
  $lines = & $handleExe -accepteula -nobanner 'win-unpacked\resources\app.asar' 2>$null
  $n = 0
  foreach ($l in $lines) {
    if ($l -notmatch 'ZCode\.exe') { continue }
    if ($l -match 'pid:\s*(\d+).*type:\s*File\s+([0-9A-F]+):\s+(.*)$') {
      $hpid = $Matches[1]; $hid = $Matches[2]; $p = $Matches[3]
      if ($p -match '-clean') { continue }
      if ($p -notmatch 'win-unpacked') { continue }
      $r = 'y' | & $handleExe -accepteula -nobanner -c $hid -p $hpid 2>&1
      ("close " + $hid + " pid " + $hpid + " => " + (($r | Out-String) -replace '\s+', ' ')) | Out-File $log -Append -Encoding utf8
      $n++
    }
  }
  ("closed handles: " + $n) | Out-File $log -Append -Encoding utf8
} catch { ("handle phase error: " + $_.Exception.Message) | Out-File $log -Append -Encoding utf8 }

$dirs = @(
  'I:\教务系统\软件封装',
  'I:\教务系统\软件封装-修复版',
  'I:\教务系统\软件封装-新版本',
  'I:\教务系统\软件封装-v0.1.1',
  'I:\教务系统\app\dist'
)
foreach ($d in $dirs) {
  try {
    if (Test-Path -LiteralPath $d) {
      Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction Stop
      ("DELETED " + $d) | Out-File $log -Append -Encoding utf8
    } else {
      ("already-gone " + $d) | Out-File $log -Append -Encoding utf8
    }
  } catch {
    ("FAILED " + $d + " => " + $_.Exception.Message) | Out-File $log -Append -Encoding utf8
  }
}
'end ' + (Get-Date) | Out-File $log -Append -Encoding utf8
