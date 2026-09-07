param(
  [Parameter(Mandatory = $true)][string]$Action,        # start | exit | status | next | prev | pageinfo | presenter
  [string]$ProgId = '',
  [string]$Path = '',
  [string]$Close = 'true',
  [string]$ExportDir = ''
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$candidates = @($ProgId, 'PowerPoint.Application', 'KWPP.Application', 'Kwpp.Application') |
  Where-Object { $_ } | Select-Object -Unique

function Out-Json($obj) {
  $obj | ConvertTo-Json -Compress
}

# 附着到已运行的实例；没有则返回 $null（不新建）
function Get-RunningApp {
  foreach ($id in $candidates) {
    try {
      $app = [System.Runtime.InteropServices.Marshal]::GetActiveObject($id)
      if ($app) { return @{ App = $app; ProgId = $id } }
    } catch { }
  }
  return $null
}

try {
  switch ($Action) {

    'start' {
      if (-not $Path -or -not (Test-Path -LiteralPath $Path)) {
        Out-Json @{ ok = $false; error = 'file-not-found'; detail = $Path }
        exit 1
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
        Out-Json @{ ok = $false; error = 'no-office-com' }
        exit 1
      }
      # ReadOnly=msoTrue, Untitled=msoFalse, WithWindow=msoTrue
      $pres = $app.Presentations.Open($Path, -1, 0, -1)
      $pres.SlideShowSettings.Run()
      Out-Json @{ ok = $true; progId = $usedId; action = 'start' }
    }

    'exit' {
      $found = Get-RunningApp
      if (-not $found) {
        Out-Json @{ ok = $true; action = 'exit'; wasRunning = $false }
        exit 0
      }
      $app = $found.App
      $wasPresenting = $false
      try {
        if ($app.SlideShowWindows.Count -ge 1) {
          $app.SlideShowWindows.Item(1).View.Exit()
          $wasPresenting = $true
        }
      } catch { }
      if ($Close -eq 'true') {
        try { $app.Quit() } catch { }
      }
      Out-Json @{ ok = $true; action = 'exit'; wasRunning = $true; wasPresenting = $wasPresenting }
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
      Out-Json @{ ok = $true; presenting = $presenting; file = $file }
    }

    'pageinfo' {
      $found = Get-RunningApp
      if (-not $found) { Out-Json @{ ok = $true; presenting = $false }; exit 0 }
      $app = $found.App
      if ($app.SlideShowWindows.Count -lt 1) { Out-Json @{ ok = $true; presenting = $false }; exit 0 }
      $sw = $app.SlideShowWindows.Item(1)
      Out-Json @{ ok = $true; presenting = $true; position = $sw.View.CurrentShowPosition; total = $sw.Presentation.Slides.Count }
    }

    'next' {
      $found = Get-RunningApp
      if (-not $found) { Out-Json @{ ok = $false; error = 'no-instance' }; exit 1 }
      $app = $found.App
      if ($app.SlideShowWindows.Count -lt 1) { Out-Json @{ ok = $false; error = 'no-slideshow' }; exit 1 }
      $app.SlideShowWindows.Item(1).View.Next()
      $sw = $app.SlideShowWindows.Item(1)
      Out-Json @{ ok = $true; position = $sw.View.CurrentShowPosition; total = $sw.Presentation.Slides.Count }
    }

    'prev' {
      $found = Get-RunningApp
      if (-not $found) { Out-Json @{ ok = $false; error = 'no-instance' }; exit 1 }
      $app = $found.App
      if ($app.SlideShowWindows.Count -lt 1) { Out-Json @{ ok = $false; error = 'no-slideshow' }; exit 1 }
      $app.SlideShowWindows.Item(1).View.Previous()
      $sw = $app.SlideShowWindows.Item(1)
      Out-Json @{ ok = $true; position = $sw.View.CurrentShowPosition; total = $sw.Presentation.Slides.Count }
    }

    'presenter' {
      $found = Get-RunningApp
      if (-not $found) { Out-Json @{ ok = $true; presenting = $false }; exit 0 }
      $app = $found.App
      if ($app.SlideShowWindows.Count -lt 1) { Out-Json @{ ok = $true; presenting = $false }; exit 0 }
      $sw = $app.SlideShowWindows.Item(1)
      $pres = $sw.Presentation
      $pos = $sw.View.CurrentShowPosition
      $total = $pres.Slides.Count
      $nxt = 0; if ($pos -lt $total) { $nxt = $pos + 1 }
      $curImg = ''; $nxtImg = ''; $notes = ''; $nextNotes = ''
      if ($ExportDir -and (Test-Path -LiteralPath $ExportDir)) {
        try { if ($pos -ge 1) { $curImg = Join-Path $ExportDir 'cur.png'; $pres.Slides.Item($pos).Export($curImg, 'PNG', 320, 180) } } catch { }
        try { if ($nxt -ge 1) { $nxtImg = Join-Path $ExportDir 'next.png'; $pres.Slides.Item($nxt).Export($nxtImg, 'PNG', 320, 180) } } catch { }
      }
      try { if ($pos -ge 1) { $notes = $pres.Slides.Item($pos).NotesPage.Shapes.Placeholders.Item(2).TextFrame.TextRange.Text } } catch { }
      try { if ($nxt -ge 1) { $nextNotes = $pres.Slides.Item($nxt).NotesPage.Shapes.Placeholders.Item(2).TextFrame.TextRange.Text } } catch { }
      Out-Json @{ ok = $true; presenting = $true; position = $pos; total = $total; notes = $notes; nextNotes = $nextNotes; curImg = $curImg; nextImg = $nxtImg }
    }

    default {
      Out-Json @{ ok = $false; error = 'unknown-action' }
      exit 1
    }
  }
} catch {
  Out-Json @{ ok = $false; error = 'com-error'; detail = $_.Exception.Message }
  exit 1
}
