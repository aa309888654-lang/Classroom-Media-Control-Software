# Release stale asar handles held by the ZCode host process (indexer leftovers), keep -clean untouched
$handleExe = 'C:\Users\jickchen\AppData\Local\Temp\handle.exe'
$lines = & $handleExe -accepteula -nobanner 'win-unpacked\resources\app.asar' 2>$null
$targets = @()
foreach ($l in $lines) {
  if ($l -notmatch 'ZCode\.exe') { continue }
  if ($l -match 'pid:\s*(\d+).*type:\s*File\s+([0-9A-F]+):\s+(.*)$') {
    $hpid = $Matches[1]; $hid = $Matches[2]; $p = $Matches[3]
    if ($p -match '-clean') { continue }
    if ($p -match 'win-unpacked') { $targets += [PSCustomObject]@{ Pid = $hpid; Handle = $hid; Path = $p } }
  }
}
Write-Host ("handles to release: " + $targets.Count)
foreach ($t in $targets) {
  $r = 'y' | & $handleExe -accepteula -nobanner -c $t.Handle -p $t.Pid 2>&1
  Write-Host ("close " + $t.Handle + " pid " + $t.Pid + ": " + (($r | Out-String).Trim() -split "`n")[-1])
}
Write-Host 'HANDLES_RELEASED'
