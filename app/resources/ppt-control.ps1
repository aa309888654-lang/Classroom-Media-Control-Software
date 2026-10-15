param(
  [Parameter(Mandatory = $true)][string]$Action,        # start | preopen | release | exportall | shutdown | exit | status | next | prev | goto | thumb | pageinfo | presenter | -server
  [string]$ProgId = '',
  [string]$Path = '',
  [string]$Close = 'true',
  [string]$ExportDir = '',
  [string]$Page = '0',                                  # goto：目标页码（1 起）；thumb：导出页码（默认 1）
  [string]$NoExport = ''                                # presenter：'true'=只读已缓存缩略图、不现场导图（放映翻页期保 PowerPoint 主线程，PERF-12）
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
# stdin 编码必须显式设 UTF-8：默认按系统 ANSI（GBK）解码，主进程发来的中文路径会变乱码
# （表现为 Test-Path 找不到文件 → 放映/缩略图失败）。一次性模式参数走命令行 Unicode 不受影响。
try { [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$candidates = @($ProgId, 'PowerPoint.Application', 'KWPP.Application', 'Kwpp.Application') |
  Where-Object { $_ } | Select-Object -Unique

function Out-Json($obj) {
  # pages 数组带嵌套对象，默认 Depth=2 会截断，放宽到 5
  $obj | ConvertTo-Json -Compress -Depth 5
}

# 附着到已运行的实例；没有则返回 $null（不新建）。
# 常驻服务模式下缓存 COM 对象：翻页只需一次轻量校验（Count 触发一次往返），免掉每次 GetActiveObject 的 ROT 查找
$script:CachedApp = $null
$script:CachedId = ''
function Get-RunningApp {
  if ($script:CachedApp) {
    try {
      $null = $script:CachedApp.SlideShowWindows.Count  # 校验代理仍活着（PowerPoint 退出即抛异常）
      return @{ App = $script:CachedApp; ProgId = $script:CachedId }
    } catch {
      $script:CachedApp = $null
      $script:CachedId = ''
    }
  }
  foreach ($id in $candidates) {
    try {
      $app = [System.Runtime.InteropServices.Marshal]::GetActiveObject($id)
      if ($app) {
        $script:CachedApp = $app
        $script:CachedId = $id
        return @{ App = $app; ProgId = $id }
      }
    } catch { }
  }
  return $null
}

# 备注文本缓存：key = 文件全路径|页码。NotesPage 的 COM 读取偏慢，演讲者轮询每 2s 一次，缓存后翻页外的轮询几乎零成本
$script:NotesCache = @{}
function Get-NotesText($pres, [int]$page) {
  if ($page -lt 1) { return '' }
  $key = ''
  try { $key = $pres.FullName } catch { }
  $key = "$key|$page"
  if ($script:NotesCache.ContainsKey($key)) { return $script:NotesCache[$key] }
  $txt = ''
  try { $txt = $pres.Slides.Item($page).NotesPage.Shapes.Placeholders.Item(2).TextFrame.TextRange.Text } catch { }
  if ($script:NotesCache.Count -gt 400) { $script:NotesCache.Clear() }  # 兜底防膨胀
  $script:NotesCache[$key] = $txt
  return $txt
}

# 执行单个动作，返回 hashtable（不直接输出/退出，方便一次性与常驻两种模式复用）
# 注意：本函数与常驻模式共用，失败一律以 ok=$false 返回，不用 exit 表达失败
function Invoke-Action([string]$A, [string]$P, [string]$Cl, [string]$Exp, [string]$Pg, [string]$Ne = '') {
  try {
    switch ($A) {

      'start' {
        if (-not $P -or -not (Test-Path -LiteralPath $P)) {
          return @{ ok = $false; error = 'file-not-found'; detail = $P }
        }
        $app = $null; $usedId = ''
        foreach ($id in $candidates) {
          try {
            $app = New-Object -ComObject $id
            $usedId = $id
            break
          } catch { }
        }
        if (-not $app) {
          return @{ ok = $false; error = 'no-office-com' }
        }
        # 已预打开（preopen）的课件直接复用：一键放映只剩 Run，秒级出画面
        $pres = $null
        $targetPath = [System.IO.Path]::GetFullPath($P)  # BUG-10：原来 Replace('/', '') 会删掉所有正斜杠
        foreach ($p2 in $app.Presentations) {
          try { if ($p2.FullName -ieq $targetPath) { $pres = $p2; break } } catch { }
        }
        if (-not $pres) {
          # ReadOnly=msoTrue, Untitled=msoFalse, WithWindow=msoTrue
          $pres = $app.Presentations.Open($P, -1, 0, -1)
        }
        # Run() 返回 SlideShowWindow 对象，PowerShell 会隐式输出一大段属性转储污染 stdout，
        # 常驻服务模式下甚至会导致进程异常退出，必须显式吞掉
        $null = $pres.SlideShowSettings.Run()
        return @{ ok = $true; progId = $usedId; action = 'start' }
      }

      'preopen' {
        # 放映预热：老师选中课件后就以「只读 + 无窗口」后台打开（不放映），
        # 一键放映时 PowerPoint 已就绪，只剩 Run() 一步，启动从数秒降到亚秒级。
        if (-not $P -or -not (Test-Path -LiteralPath $P)) {
          return @{ ok = $false; error = 'file-not-found'; detail = $P }
        }
        $app = $null; $created = $false
        $found = Get-RunningApp
        if ($found) { $app = $found.App }
        else {
          foreach ($id in $candidates) {
            try {
              $app = New-Object -ComObject $id
              $created = $true
              $script:CachedApp = $app
              $script:CachedId = $id
              break
            } catch { }
          }
        }
        if (-not $app) { return @{ ok = $false; error = 'no-office-com' } }
        try {
          $targetPath = [System.IO.Path]::GetFullPath($P)  # BUG-10：原来 Replace('/', '') 会删掉所有正斜杠
          $have = $false
          foreach ($p2 in $app.Presentations) {
            try { if ($p2.FullName -ieq $targetPath) { $have = $true; break } } catch { }
          }
          if (-not $have) {
            # ReadOnly=msoTrue, Untitled=msoFalse, WithWindow=msoFalse（后台无窗口）
            $null = $app.Presentations.Open($P, -1, 0, 0)
            if ($created) { $script:WeCreated = $true }  # 本进程拉起的 PowerPoint：退出时统一收掉
          }
          return @{ ok = $true; action = 'preopen' }
        } finally {
          # 预打开不 Quit：让 PowerPoint 保持热身状态（应用退出时走 shutdown 收尾）
        }
      }

      'release' {
        # 删除课件前释放占用：把「后台预热打开（只读无窗口）」的演示文稿关掉，
        # 让 Windows 能把它移进回收站（否则文件被 PowerPoint 占住 → 删除失败）。
        # 正在放映（幻灯片放映视图运行中）的不关，返回 presenting 让调用方提示先退出放映。
        if (-not $P -or -not (Test-Path -LiteralPath $P)) {
          return @{ ok = $false; error = 'file-not-found'; detail = $P }
        }
        $found = Get-RunningApp
        if (-not $found) { return @{ ok = $true; action = 'release'; released = $false } }
        $app = $found.App
        # 正在放映这份课件 → 不能关（会打断老师正在放的课）
        $showFile = ''
        try {
          if ($app.SlideShowWindows.Count -ge 1) { $showFile = $app.SlideShowWindows.Item(1).Presentation.FullName }
        } catch { }
        $targetPath = [System.IO.Path]::GetFullPath($P)
        if ($showFile -and ($showFile -ieq $targetPath)) { return @{ ok = $false; error = 'presenting' } }
        $closed = $false
        foreach ($p2 in $app.Presentations) {
          try {
            if ($p2.FullName -ieq $targetPath) {
              try { $p2.Saved = $true } catch { }   # 只读打开、无改动：避免 Close 触发任何保存提示
              $p2.Close()
              $closed = $true
              break
            }
          } catch { }
        }
        return @{ ok = $true; action = 'release'; released = $closed }
      }

      'exportall' {
        # 全部页面缩略图：选中课件后一次性导出所有页（page-N.png 按页缓存）
        if (-not $P -or -not (Test-Path -LiteralPath $P)) {
          return @{ ok = $false; error = 'file-not-found'; detail = $P }
        }
        $app = $null; $created = $false; $pres = $null; $opened = $false
        $found = Get-RunningApp
        if ($found) { $app = $found.App }
        else {
          foreach ($id in $candidates) {
            try {
              $app = New-Object -ComObject $id
              $created = $true
              $script:CachedApp = $app
              $script:CachedId = $id
              break
            } catch { }
          }
        }
        if (-not $app) { return @{ ok = $false; error = 'no-office-com' } }
        try {
          try {
            $pres = $app.Presentations.Open($P, -1, 0, 0)
            $opened = $true
          } catch {
            try {
              $full = (Resolve-Path -LiteralPath $P).Path
              foreach ($p2 in $app.Presentations) { if ($p2.FullName -eq $full) { $pres = $p2; break } }
            } catch { }
          }
          if (-not $pres) { return @{ ok = $false; error = 'open-failed'; detail = $P } }
          $sw = 960.0; $sh = 540.0
          try { $sw = [double]$pres.PageSetup.SlideWidth; $sh = [double]$pres.PageSetup.SlideHeight } catch { }
          $outH = if ($sw -gt 0) { [Math]::Max(1, [Math]::Round(320 * $sh / $sw)) } else { 180 }
          $count = 0
          $aborted = $false
          foreach ($s2 in $pres.Slides) {
            # 老师点了一键放映 → 立刻停导：Export 与幻灯片渲染抢 PowerPoint 主线程，
            # 放映期间继续导图每页翻动都卡（PERF-12）。已导页按页缓存，下次选中再补。
            try {
              if ($app.SlideShowWindows.Count -ge 1) {
                $showFile = ''
                try { $showFile = $app.SlideShowWindows.Item(1).Presentation.FullName } catch { }
                if (-not $showFile -or $showFile -ieq $pres.FullName) { $aborted = $true; break }
              }
            } catch { }
            $img = Join-Path $Exp ("page-{0}.png" -f $s2.SlideIndex)
            if (-not (Test-Path -LiteralPath $img)) {
              try { $s2.Export($img, 'PNG', 320, $outH); $count++ } catch { }
            }
          }
          return @{ ok = $true; action = 'exportall'; total = $pres.Slides.Count; exported = $count; aborted = $aborted }
        } finally {
          # 因放映中断：这份文稿可能正在全屏放映，Close/Quit 会把老师的放映干掉，原样留着（release/shutdown 会收）
          if (-not $aborted) {
            if ($pres -and $opened) { try { $pres.Close() } catch { } }
            if ($created) { try { $app.Quit() } catch { }; $script:CachedApp = $null; $script:CachedId = '' }
          }
        }
      }

      'shutdown' {
        # 应用退出收尾：预打开期间由本进程拉起的 PowerPoint 统一关闭（不留后台进程）
        if ($script:WeCreated -and $script:CachedApp) {
          try { $script:CachedApp.Quit() } catch { }
          $script:CachedApp = $null
          $script:CachedId = ''
          $script:WeCreated = $false
        }
        return @{ ok = $true; action = 'shutdown' }
      }

      'exit' {
        $found = Get-RunningApp
        if (-not $found) {
          return @{ ok = $true; action = 'exit'; wasRunning = $false }
        }
        $app = $found.App
        $wasPresenting = $false
        try {
          if ($app.SlideShowWindows.Count -ge 1) {
            $app.SlideShowWindows.Item(1).View.Exit()
            $wasPresenting = $true
          }
        } catch { }
        if ($Cl -eq 'true') {
          try { $app.Quit() } catch { }
          $script:CachedApp = $null
          $script:CachedId = ''
          $script:NotesCache.Clear()
        }
        return @{ ok = $true; action = 'exit'; wasRunning = $true; wasPresenting = $wasPresenting }
      }

      'status' {
        $found = Get-RunningApp
        $presenting = $false
        $file = ''
        if ($found) {
          try {
            if ($found.App.SlideShowWindows.Count -ge 1) {
              $presenting = $true
              $file = $found.App.SlideShowWindows.Item(1).Presentation.FullName
            }
          } catch { }
        }
        return @{ ok = $true; presenting = $presenting; file = $file }
      }

      'pageinfo' {
        $found = Get-RunningApp
        if (-not $found) { return @{ ok = $true; presenting = $false } }
        $app = $found.App
        if ($app.SlideShowWindows.Count -lt 1) { return @{ ok = $true; presenting = $false } }
        $sw = $app.SlideShowWindows.Item(1)
        return @{ ok = $true; presenting = $true; position = $sw.View.CurrentShowPosition; total = $sw.Presentation.Slides.Count }
      }

      'next' {
        $found = Get-RunningApp
        if (-not $found) { return @{ ok = $false; error = 'no-instance' } }
        $app = $found.App
        if ($app.SlideShowWindows.Count -lt 1) { return @{ ok = $false; error = 'no-slideshow' } }
        $app.SlideShowWindows.Item(1).View.Next()
        $sw = $app.SlideShowWindows.Item(1)
        return @{ ok = $true; position = $sw.View.CurrentShowPosition; total = $sw.Presentation.Slides.Count }
      }

      'prev' {
        $found = Get-RunningApp
        if (-not $found) { return @{ ok = $false; error = 'no-instance' } }
        $app = $found.App
        if ($app.SlideShowWindows.Count -lt 1) { return @{ ok = $false; error = 'no-slideshow' } }
        $app.SlideShowWindows.Item(1).View.Previous()
        $sw = $app.SlideShowWindows.Item(1)
        return @{ ok = $true; position = $sw.View.CurrentShowPosition; total = $sw.Presentation.Slides.Count }
      }

      'goto' {
        $found = Get-RunningApp
        if (-not $found) { return @{ ok = $false; error = 'no-instance' } }
        $app = $found.App
        if ($app.SlideShowWindows.Count -lt 1) { return @{ ok = $false; error = 'no-slideshow' } }
        $sw = $app.SlideShowWindows.Item(1)
        $total = $sw.Presentation.Slides.Count
        $n = 0
        [void][int]::TryParse($Pg, [ref]$n)
        if ($n -lt 1 -or $n -gt $total) { return @{ ok = $false; error = 'bad-page'; total = $total } }
        # 优先 Goto；WPS 等实现缺 Goto 方法时，按页差循环 Next/Previous 兜底
        try { $sw.View.Goto($n) } catch {
          $delta = $n - $sw.View.CurrentShowPosition
          if ($delta -gt 0) { for ($k = 0; $k -lt $delta; $k++) { [void]$sw.View.Next() } }
          elseif ($delta -lt 0) { for ($k = 0; $k -gt $delta; $k--) { [void]$sw.View.Previous() } }
        }
        return @{ ok = $true; position = $sw.View.CurrentShowPosition; total = $total }
      }

      'thumb' {
        # 库缩略图：只读、无窗口打开课件，导出第 1 页（$Page 可指定页码）到 $Exp 指定的输出 PNG 路径。
        # 不碰正在放映的演示；若 PowerPoint/WPS 是本进程自己拉起的，导完就 Quit，不留后台进程；
        # 课件本来就在 PowerPoint 里打开时直接复用那份，且绝不 Close（那是老师正开着的文件）
        if (-not $P -or -not (Test-Path -LiteralPath $P)) { return @{ ok = $false; error = 'file-not-found'; detail = $P } }
        $app = $null; $created = $false
        $found = Get-RunningApp
        if ($found) { $app = $found.App }
        else {
          foreach ($id in $candidates) {
            try {
              $app = New-Object -ComObject $id
              $created = $true
              $script:CachedApp = $app
              $script:CachedId = $id
              break
            } catch { }
          }
        }
        if (-not $app) { return @{ ok = $false; error = 'no-office-com' } }
        $pres = $null; $opened = $false
        try {
          try {
            # ReadOnly=msoTrue, Untitled=msoFalse, WithWindow=msoFalse（后台打开，不出窗口）
            $pres = $app.Presentations.Open($P, -1, 0, 0)
            $opened = $true
          } catch {
            # 已在打开列表里：复用已打开的那份
            try {
              $full = (Resolve-Path -LiteralPath $P).Path
              foreach ($p in $app.Presentations) { if ($p.FullName -eq $full) { $pres = $p; break } }
            } catch { }
          }
          if (-not $pres) { return @{ ok = $false; error = 'open-failed'; detail = $P } }
          $n = 1
          [void][int]::TryParse($Pg, [ref]$n)
          if ($n -lt 1 -or $n -gt $pres.Slides.Count) { $n = 1 }
          # 按幻灯片真实宽高比导出（4:3 / 16:9 都不变形）
          $sw = 960.0; $sh = 540.0
          try { $sw = [double]$pres.PageSetup.SlideWidth; $sh = [double]$pres.PageSetup.SlideHeight } catch { }
          $outH = if ($sw -gt 0) { [Math]::Max(1, [Math]::Round(320 * $sh / $sw)) } else { 180 }
          $pres.Slides.Item($n).Export($Exp, 'PNG', 320, $outH)
          return @{ ok = $true; action = 'thumb' }
        } finally {
          if ($pres -and $opened) { try { $pres.Close() } catch { } }
          if ($created) {
            try { $app.Quit() } catch { }
            $script:CachedApp = $null
            $script:CachedId = ''
          }
        }
      }

      'presenter' {
        $found = Get-RunningApp
        if (-not $found) { return @{ ok = $true; presenting = $false } }
        $app = $found.App
        if ($app.SlideShowWindows.Count -lt 1) { return @{ ok = $true; presenting = $false } }
        $sw = $app.SlideShowWindows.Item(1)
        $pres = $sw.Presentation
        $pos = $sw.View.CurrentShowPosition
        $total = $pres.Slides.Count
        $nxt = 0; if ($pos -lt $total) { $nxt = $pos + 1 }
        # 5 页胶片窗口：以当前页为中心（首尾贴边）；page-N.png 按页缓存
        $start = $pos - 2
        if ($start + 4 -gt $total) { $start = $total - 4 }
        if ($start -lt 1) { $start = 1 }
        $end = [Math]::Min($start + 4, $total)
        # 预导出：把窗口后一页（老师大概率要翻到的页）提前导好，翻页瞬间就不用现场导图卡顿
        $lookahead = [Math]::Min($end + 1, $total)
        $pages = @()
        $newExports = 0
        if ($Exp -and (Test-Path -LiteralPath $Exp)) {
          for ($i = $start; $i -le $lookahead; $i++) {
            $img = ''
            try {
              $img = Join-Path $Exp ("page-{0}.png" -f $i)
              if (-not (Test-Path -LiteralPath $img)) {
                # NoExport：翻页进行中/轮询密集期不导图，只报已缓存页——连续翻页时持续导图是放映卡顿主因（PERF-12）
                if ($Ne -eq 'true') { $img = '' }
                # 每次调用最多导 3 张新图（慢机器上单张导图可达秒级）：超出的留给下一轮，避免单次请求拖太久
                elseif ($newExports -ge 3) { $img = '' }
                else {
                  $sW = 960.0; $sH = 540.0
                  try { $sW = [double]$pres.PageSetup.SlideWidth; $sH = [double]$pres.PageSetup.SlideHeight } catch { }
                  $eH = if ($sW -gt 0) { [Math]::Max(1, [Math]::Round(320 * $sH / $sW)) } else { 180 }
                  $pres.Slides.Item($i).Export($img, 'PNG', 320, $eH)
                  $newExports++
                }
              }
            } catch { $img = '' }
            if ($i -le $end -and $img -and (Test-Path -LiteralPath $img)) { $pages += @{ page = $i; img = $img } }
          }
        }
        $notes = Get-NotesText $pres $pos
        $nextNotes = Get-NotesText $pres $nxt
        return @{ ok = $true; presenting = $true; position = $pos; total = $total; notes = $notes; nextNotes = $nextNotes; pages = $pages; exported = $newExports }
      }

      default {
        return @{ ok = $false; error = 'unknown-action' }
      }
    }
  } catch {
    return @{ ok = $false; error = 'com-error'; detail = $_.Exception.Message }
  }
}

# 常驻服务模式：stdin 每行一个 JSON 请求 {seq,action,path,close,exportDir,page}，
# stdout 每行一个 JSON 应答 {seq,...结果}。由主进程 pptServer.js 托管，免掉每次 spawn PowerShell 的冷启动。
if ($Action -eq '-server') {
  [Console]::Out.WriteLine('SERVER_READY')
  while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if (-not $line.Trim()) { continue }
    $req = $null
    try { $req = $line | ConvertFrom-Json } catch { }
    if (-not $req) { Out-Json @{ seq = -1; ok = $false; error = 'bad-req' }; continue }
    $close = 'true'; if ($req.close) { $close = [string]$req.close }
    $page = '0'; if ($req.page) { $page = [string]$req.page }
    $ne = ''; if ($req.noexport) { $ne = [string]$req.noexport }
    $r = Invoke-Action ([string]$req.action) ([string]$req.path) $close ([string]$req.exportDir) $page $ne
    $out = @{ seq = [int]$req.seq }
    if ($r) { foreach ($k in $r.Keys) { $out[$k] = $r[$k] } }
    Out-Json $out
  }
  exit 0
}

# 一次性模式（保留：server 不可用时的回退路径，行为与旧版一致）
$r = Invoke-Action $Action $Path $Close $ExportDir $Page $NoExport
Out-Json $r
if (-not $r.ok) { exit 1 }
exit 0
