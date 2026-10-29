#requires -Version 5.1
<#
  DSH computer-use worker.
  A long-lived Windows PowerShell process speaking newline-delimited JSON over
  stdio. Every request is { id, op, params }; every response is
  { id, ok, result } or { id, ok:false, error }.
  Nothing else may be written to stdout: the parent parses it as JSON lines.
#>
param([switch]$SelfTest)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'

Add-Type -AssemblyName System.Drawing
$script:WinFormsReady = $false
try {
  Add-Type -AssemblyName System.Windows.Forms
  $script:WinFormsReady = $true
} catch { $script:WinFormsReady = $false }

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class DshWin {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLengthW(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int x, int y, int w, int h, bool repaint);
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr hWnd, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, int data, IntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] public static extern uint MapVirtualKeyW(uint code, uint mapType);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
}
"@

#region platform setup -------------------------------------------------------
$script:DpiAware = $false
try {
  if ([DshWin]::SetProcessDpiAwarenessContext([IntPtr](-4))) { $script:DpiAware = $true }
  elseif ([DshWin]::SetProcessDPIAware()) { $script:DpiAware = $true }
} catch { try { [DshWin]::SetProcessDPIAware() | Out-Null; $script:DpiAware = $true } catch { } }

# UIAutomation is optional: a missing runtime must not break the other ops.
$script:UiaReady = $false
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  $script:UiaReady = $true
} catch { $script:UiaReady = $false }

$script:UiaCache = @{}
$script:UiaGeneration = 0

function Get-Screens {
  $list = New-Object System.Collections.ArrayList
  if (-not $script:WinFormsReady) {
    $null = $list.Add(@{
      index = 0; name = 'DISPLAY'; primary = $true
      x = [DshWin]::GetSystemMetrics(76); y = [DshWin]::GetSystemMetrics(77)
      width = [DshWin]::GetSystemMetrics(78); height = [DshWin]::GetSystemMetrics(79)
    })
    return $list
  }
  $i = 0
  foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
    $b = $s.Bounds
    $null = $list.Add(@{
      index = $i
      name = $s.DeviceName
      primary = [bool]$s.Primary
      x = [int]$b.X; y = [int]$b.Y; width = [int]$b.Width; height = [int]$b.Height
    })
    $i++
  }
  return $list
}

function Get-VirtualBounds {
  $screens = Get-Screens
  if ($screens.Count -eq 0) { return @{ x = 0; y = 0; width = 0; height = 0 } }
  $minX = [int]::MaxValue; $minY = [int]::MaxValue; $maxX = [int]::MinValue; $maxY = [int]::MinValue
  foreach ($s in $screens) {
    if ($s.x -lt $minX) { $minX = $s.x }
    if ($s.y -lt $minY) { $minY = $s.y }
    if (($s.x + $s.width) -gt $maxX) { $maxX = $s.x + $s.width }
    if (($s.y + $s.height) -gt $maxY) { $maxY = $s.y + $s.height }
  }
  return @{ x = $minX; y = $minY; width = ($maxX - $minX); height = ($maxY - $minY) }
}

#region windows -------------------------------------------------------------
function Format-Hwnd { param([IntPtr]$h) return [int64]$h.ToInt64() }

function Get-WindowList {
  $script:winRows = New-Object System.Collections.ArrayList
  $fg = [DshWin]::GetForegroundWindow()
  $cb = [DshWin+EnumWindowsProc]{
    param([IntPtr]$h, [IntPtr]$l)
    try {
      if (-not [DshWin]::IsWindowVisible($h)) { return $true }
      $len = [DshWin]::GetWindowTextLengthW($h)
      if ($len -le 0) { return $true }
      $sb = New-Object System.Text.StringBuilder ($len + 2)
      [void][DshWin]::GetWindowTextW($h, $sb, $sb.Capacity)
      $title = $sb.ToString()
      if ([string]::IsNullOrWhiteSpace($title)) { return $true }
      $cls = New-Object System.Text.StringBuilder 256
      [void][DshWin]::GetClassNameW($h, $cls, $cls.Capacity)
      $r = New-Object DshWin+RECT
      [void][DshWin]::GetWindowRect($h, [ref]$r)
      $procId = [uint32]0
      [uint32]$tid = [DshWin]::GetWindowThreadProcessId($h, [ref]$procId)
      $pname = ''
      try { $pname = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { }
      $state = 'normal'
      if ([DshWin]::IsIconic($h)) { $state = 'minimized' }
      elseif ([DshWin]::IsZoomed($h)) { $state = 'maximized' }
      $null = $script:winRows.Add(@{
        handle = [int64]$h.ToInt64()
        title = $title
        process = $pname
        processId = [int]$procId
        className = $cls.ToString()
        state = $state
        active = ($h -eq $fg)
        x = [int]$r.Left; y = [int]$r.Top
        width = [int]($r.Right - $r.Left); height = [int]($r.Bottom - $r.Top)
      })
    } catch { }
    return $true
  }
  [void][DshWin]::EnumWindows($cb, [IntPtr]::Zero)
  return $script:winRows
}

function Resolve-WindowTarget {
  param($p)
  if ($null -ne $p.handle) {
    $h = [IntPtr][int64]$p.handle
    if ([DshWin]::IsWindow($h)) {
      return @{ hwnd = $h; title = (Get-WindowTitle $h) }
    }
    throw "window handle $($p.handle) is not a live window"
  }
  $needle = ''
  if ($null -ne $p.title) { $needle = [string]$p.title } elseif ($null -ne $p.window) { $needle = [string]$p.window }
  if (-not [string]::IsNullOrWhiteSpace($needle)) {
    $rows = Get-WindowList
    $match = $rows | Where-Object { $_.title -eq $needle } | Select-Object -First 1
    if ($null -eq $match) { $match = $rows | Where-Object { $_.title -like "*$needle*" } | Select-Object -First 1 }
    if ($null -eq $match) { throw "no visible window title matches ""$needle""; call computer_window with action=""list"" to see them" }
    return @{ hwnd = [IntPtr][int64]$match.handle; title = $match.title }
  }
  $fg = [DshWin]::GetForegroundWindow()
  if ($fg -ne [IntPtr]::Zero) { return @{ hwnd = $fg; title = (Get-WindowTitle $fg) } }
  throw 'no target window: pass a window title or handle'
}

function Get-WindowTitle {
  param([IntPtr]$h)
  $len = [DshWin]::GetWindowTextLengthW($h)
  if ($len -le 0) { return '' }
  $sb = New-Object System.Text.StringBuilder ($len + 2)
  [void][DshWin]::GetWindowTextW($h, $sb, $sb.Capacity)
  return $sb.ToString()
}

function Set-WindowFocus {
  param([IntPtr]$h)
  if ([DshWin]::IsIconic($h)) { [void][DshWin]::ShowWindow($h, 9) }
  [void][DshWin]::BringWindowToTop($h)
  [void][DshWin]::SetForegroundWindow($h)
  Start-Sleep -Milliseconds 70
  if ([DshWin]::GetForegroundWindow() -ne $h) {
    # Windows denies foreground changes to background processes; a synthesized
    # ALT tap marks this process as the last input owner and lifts the denial.
    [DshWin]::keybd_event([byte]0x12, [byte]0, [uint32]0, [IntPtr]::Zero)
    [DshWin]::keybd_event([byte]0x12, [byte]0, [uint32]2, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 40
    [void][DshWin]::SetForegroundWindow($h)
    Start-Sleep -Milliseconds 80
  }
  return ([DshWin]::GetForegroundWindow() -eq $h)
}
#endregion

#region input ---------------------------------------------------------------
$script:MouseFlags = @{
  leftdown = 0x0002; leftup = 0x0004; rightdown = 0x0008; rightup = 0x0010
  middledown = 0x0020; middleup = 0x0040; wheel = 0x0800
}

$script:KeyMap = @{
  'backspace' = 0x08; 'tab' = 0x09; 'enter' = 0x0D; 'return' = 0x0D; 'shift' = 0x10
  'ctrl' = 0x11; 'control' = 0x11; 'alt' = 0x12; 'menu' = 0x12; 'pause' = 0x13
  'capslock' = 0x14; 'esc' = 0x1B; 'escape' = 0x1B; 'space' = 0x20; 'pageup' = 0x21
  'pgup' = 0x21; 'pagedown' = 0x22; 'pgdn' = 0x22; 'end' = 0x23; 'home' = 0x24
  'left' = 0x25; 'up' = 0x26; 'right' = 0x27; 'down' = 0x28; 'printscreen' = 0x2C
  'insert' = 0x2D; 'ins' = 0x2D; 'delete' = 0x2E; 'del' = 0x2E; 'win' = 0x5B
  'lwin' = 0x5B; 'rwin' = 0x5C; 'apps' = 0x5D; 'numlock' = 0x90; 'scrolllock' = 0x91
  'semicolon' = 0xBA; 'equals' = 0xBB; 'comma' = 0xBC; 'minus' = 0xBD; 'period' = 0xBE
  'slash' = 0xBF; 'backtick' = 0xC0; 'grave' = 0xC0; 'lbracket' = 0xDB; 'backslash' = 0xDC
  'rbracket' = 0xDD; 'quote' = 0xDE
}
$script:ExtendedKeys = @(0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2C, 0x2D, 0x2E, 0x5B, 0x5C, 0x5D, 0x90, 0x2E)
for ($i = 1; $i -le 24; $i++) { $script:KeyMap["f$i"] = 0x6F + $i }

function Resolve-VirtualKey {
  param([string]$name)
  $k = $name.Trim().ToLowerInvariant()
  if ($script:KeyMap.ContainsKey($k)) { return $script:KeyMap[$k] }
  if ($k.Length -eq 1) {
    $c = [int][char]$k.ToUpperInvariant()
    if ($k -match '^[a-z0-9]$') { return $c }
  }
  throw "unknown key name ""$name"""
}

function Send-VirtualKey {
  param([int]$vk, [uint32]$flags)
  $ext = 0
  if ($script:ExtendedKeys -contains $vk) { $ext = 1 }
  [DshWin]::keybd_event([byte]$vk, [byte]0, [uint32]($flags -bor $ext), [IntPtr]::Zero)
}

function Send-KeySequence {
  param([string[]]$keys)
  $held = New-Object System.Collections.ArrayList
  foreach ($combo in $keys) {
    $parts = @($combo -split '\+' | Where-Object { $_ -ne '' })
    if ($parts.Count -eq 0) { continue }
    $mods = @()
    if ($parts.Count -gt 1) { $mods = $parts[0..($parts.Count - 2)]; $main = $parts[-1] }
    else { $main = $parts[0] }
    $modVks = @()
    foreach ($m in $mods) {
      $mvk = Resolve-VirtualKey $m
      $modVks += $mvk
      Send-VirtualKey $mvk 0
      $null = $held.Add($mvk)
      Start-Sleep -Milliseconds 12
    }
    $vk = Resolve-VirtualKey $main
    Send-VirtualKey $vk 0
    Start-Sleep -Milliseconds 25
    Send-VirtualKey $vk 2
    Start-Sleep -Milliseconds 12
    for ($i = $modVks.Count - 1; $i -ge 0; $i--) {
      Send-VirtualKey $modVks[$i] 2
      Start-Sleep -Milliseconds 12
    }
    Start-Sleep -Milliseconds 30
  }
}
#endregion

#region capture -------------------------------------------------------------
function Test-BitmapBlank {
  param([System.Drawing.Bitmap]$bmp)
  $pts = @(
    @(4, 4), @([int]($bmp.Width / 2), [int]($bmp.Height / 2)),
    @([int]($bmp.Width - 5), [int]($bmp.Height - 5)), @([int]($bmp.Width / 2), 4)
  )
  foreach ($pt in $pts) {
    try {
      $c = $bmp.GetPixel($pt[0], $pt[1])
      if ($c.R -ne 0 -or $c.G -ne 0 -or $c.B -ne 0) { return $false }
    } catch { return $false }
  }
  return $true
}

function New-Capture {
  param($p)
  $originX = 0; $originY = 0; $w = 0; $h = 0; $hwnd = [IntPtr]::Zero
  if ($null -ne $p.region) {
    $originX = [int]$p.region[0]; $originY = [int]$p.region[1]
    $w = [int]$p.region[2]; $h = [int]$p.region[3]
  } elseif ($null -ne $p.window -or $null -ne $p.handle) {
    $t = Resolve-WindowTarget $p
    $hwnd = $t.hwnd
    $r = New-Object DshWin+RECT
    [void][DshWin]::GetWindowRect($hwnd, [ref]$r)
    $originX = [int]$r.Left; $originY = [int]$r.Top
    $w = [int]($r.Right - $r.Left); $h = [int]($r.Bottom - $r.Top)
  } elseif ($null -ne $p.monitor) {
    $screens = Get-Screens
    $idx = [int]$p.monitor
    $s = $screens | Where-Object { $_.index -eq $idx } | Select-Object -First 1
    if ($null -eq $s) { throw "monitor $idx does not exist; available: 0..$($screens.Count - 1)" }
    $originX = $s.x; $originY = $s.y; $w = $s.width; $h = $s.height
  } else {
    $v = Get-VirtualBounds
    $originX = $v.x; $originY = $v.y; $w = $v.width; $h = $v.height
  }
  if ($w -le 0 -or $h -le 0) { throw "capture area is empty (${w}x${h})" }

  $bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $printed = $false
  if ($hwnd -ne [IntPtr]::Zero) {
    try {
      $hdc = $g.GetHdc()
      $printed = [DshWin]::PrintWindow($hwnd, $hdc, 2)
      $g.ReleaseHdc($hdc)
      if ($printed -and (Test-BitmapBlank $bmp)) { $printed = $false }
    } catch { $printed = $false; try { $g.ReleaseHdc() } catch { } }
    if (-not $printed) { $g.Clear([System.Drawing.Color]::Black); $g.CopyFromScreen($originX, $originY, 0, 0, (New-Object System.Drawing.Size($w, $h))) }
  } else {
    $g.CopyFromScreen($originX, $originY, 0, 0, (New-Object System.Drawing.Size($w, $h)))
  }
  $g.Dispose()

  $scale = 1.0
  $outBmp = $bmp
  $maxW = 0
  if ($null -ne $p.maxWidth) { $maxW = [int]$p.maxWidth }
  if ($maxW -gt 0 -and $w -gt $maxW) {
    $scale = [double]$maxW / [double]$w
    $nw = [int][Math]::Max(1, [Math]::Round($w * $scale))
    $nh = [int][Math]::Max(1, [Math]::Round($h * $scale))
    $scaled = New-Object System.Drawing.Bitmap $nw, $nh, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $sg = [System.Drawing.Graphics]::FromImage($scaled)
    $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $sg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $sg.DrawImage($bmp, 0, 0, $nw, $nh)
    $sg.Dispose()
    $outBmp = $scaled
  }

  $format = 'jpeg'
  if ($null -ne $p.format -and [string]$p.format -eq 'png') { $format = 'png' }
  $ms = New-Object System.IO.MemoryStream
  if ($format -eq 'png') {
    $outBmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  } else {
    $quality = 82
    if ($null -ne $p.quality) { $quality = [int]$p.quality }
    if ($quality -lt 10) { $quality = 10 }
    if ($quality -gt 100) { $quality = 100 }
    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
    $encParams = New-Object System.Drawing.Imaging.EncoderParameters 1
    $encParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, [int64]$quality)
    $outBmp.Save($ms, $codec, $encParams)
  }
  $bytes = $ms.ToArray()
  $result = @{
    data = [System.Convert]::ToBase64String($bytes)
    format = $format
    width = [int]$outBmp.Width
    height = [int]$outBmp.Height
    captureX = $originX; captureY = $originY
    captureWidth = $w; captureHeight = $h
    scale = [Math]::Round($scale, 4)
    bytes = $bytes.Length
    monitors = @(Get-Screens)
  }
  $ms.Dispose()
  $outBmp.Dispose()
  $bmp.Dispose()
  return $result
}
#endregion

#region operations ----------------------------------------------------------
function Op-Ping {
  param($p)
  return @{
    os = [System.Environment]::OSVersion.VersionString
    psVersion = $PSVersionTable.PSVersion.ToString()
    pwsh = ($PSVersionTable.PSEdition -eq 'Core')
    dpiAware = $script:DpiAware
    uiAutomation = $script:UiaReady
    user = [System.Environment]::UserName
    monitors = @(Get-Screens)
    virtual = Get-VirtualBounds
    cursor = (Get-CursorPosition)
  }
}

function Get-CursorPosition {
  $pt = New-Object DshWin+POINT
  if ([DshWin]::GetCursorPos([ref]$pt)) { return @{ x = [int]$pt.X; y = [int]$pt.Y } }
  return @{ x = 0; y = 0 }
}

function Op-Screenshot {
  param($p)
  return New-Capture $p
}

function Op-CaptureFile {
  param($p)
  if ([string]::IsNullOrWhiteSpace([string]$p.path)) { throw 'captureFile requires path' }
  $shot = New-Capture $p
  $bytes = [System.Convert]::FromBase64String($shot.data)
  $dir = [System.IO.Path]::GetDirectoryName([string]$p.path)
  if ($dir -and -not (Test-Path $dir)) { $null = New-Item -ItemType Directory -Path $dir -Force }
  [System.IO.File]::WriteAllBytes([string]$p.path, $bytes)
  $shot.Remove('data')
  $shot['path'] = [string]$p.path
  return $shot
}

function Op-DecodeFrame {
  param($p)
  # Re-encode one captured still into the raw RGB24 buffer a GIF frame needs.
  $src = [string]$p.src
  $out = [string]$p.out
  $w = [int]$p.width
  $h = [int]$p.height
  $img = [System.Drawing.Image]::FromFile($src)
  $bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($img, 0, 0, $w, $h)
  $g.Dispose()
  $img.Dispose()
  $rect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
  $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $stride = $data.Stride
  $buffer = New-Object byte[] ($stride * $h)
  [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $buffer, 0, $buffer.Length)
  $bmp.UnlockBits($data)
  $bmp.Dispose()
  $rgb = New-Object byte[] ($w * $h * 3)
  for ($y = 0; $y -lt $h; $y++) {
    [System.Array]::Copy($buffer, ($y * $stride), $rgb, ($y * $w * 3), ($w * 3))
  }
  [System.IO.File]::WriteAllBytes($out, $rgb)
  return @{ path = $out; width = $w; height = $h; bytes = $rgb.Length }
}

function Op-Mouse {
  param($p)
  $action = [string]$p.action
  if ($null -ne $p.x -and $null -ne $p.y) {
    if (-not [DshWin]::SetCursorPos([int]$p.x, [int]$p.y)) { throw "could not move the pointer to $($p.x),$($p.y)" }
    Start-Sleep -Milliseconds 25
  }
  switch ($action) {
    'move' { }
    'click' {
      [DshWin]::mouse_event([uint32]$script:MouseFlags.leftdown, 0, 0, 0, [IntPtr]::Zero)
      Start-Sleep -Milliseconds 40
      [DshWin]::mouse_event([uint32]$script:MouseFlags.leftup, 0, 0, 0, [IntPtr]::Zero)
    }
    'double_click' {
      for ($i = 0; $i -lt 2; $i++) {
        [DshWin]::mouse_event([uint32]$script:MouseFlags.leftdown, 0, 0, 0, [IntPtr]::Zero)
        Start-Sleep -Milliseconds 35
        [DshWin]::mouse_event([uint32]$script:MouseFlags.leftup, 0, 0, 0, [IntPtr]::Zero)
        Start-Sleep -Milliseconds 60
      }
    }
    'right_click' {
      [DshWin]::mouse_event([uint32]$script:MouseFlags.rightdown, 0, 0, 0, [IntPtr]::Zero)
      Start-Sleep -Milliseconds 40
      [DshWin]::mouse_event([uint32]$script:MouseFlags.rightup, 0, 0, 0, [IntPtr]::Zero)
    }
    'middle_click' {
      [DshWin]::mouse_event([uint32]$script:MouseFlags.middledown, 0, 0, 0, [IntPtr]::Zero)
      Start-Sleep -Milliseconds 40
      [DshWin]::mouse_event([uint32]$script:MouseFlags.middleup, 0, 0, 0, [IntPtr]::Zero)
    }
    'drag' {
      if ($null -eq $p.toX -or $null -eq $p.toY) { throw 'drag needs toX and toY' }
      $fromX = $null; $fromY = $null
      if ($null -ne $p.x -and $null -ne $p.y) { $fromX = [int]$p.x; $fromY = [int]$p.y }
      else { $cur = Get-CursorPosition; $fromX = $cur.x; $fromY = $cur.y }
      [void][DshWin]::SetCursorPos($fromX, $fromY)
      Start-Sleep -Milliseconds 30
      [DshWin]::mouse_event([uint32]$script:MouseFlags.leftdown, 0, 0, 0, [IntPtr]::Zero)
      Start-Sleep -Milliseconds 50
      $toX = [int]$p.toX; $toY = [int]$p.toY
      $steps = 12
      for ($i = 1; $i -le $steps; $i++) {
        $cx = [int]($fromX + ($toX - $fromX) * $i / $steps)
        $cy = [int]($fromY + ($toY - $fromY) * $i / $steps)
        [void][DshWin]::SetCursorPos($cx, $cy)
        Start-Sleep -Milliseconds 18
      }
      Start-Sleep -Milliseconds 60
      [DshWin]::mouse_event([uint32]$script:MouseFlags.leftup, 0, 0, 0, [IntPtr]::Zero)
    }
    'scroll' {
      $notches = 3
      if ($null -ne $p.amount) { $notches = [int]$p.amount }
      $delta = $notches * 120
      $remaining = [Math]::Abs($delta)
      $sign = 1
      if ($delta -lt 0) { $sign = -1 }
      while ($remaining -gt 0) {
        $step = [Math]::Min(120, $remaining) * $sign
        [DshWin]::mouse_event([uint32]$script:MouseFlags.wheel, 0, 0, [int]$step, [IntPtr]::Zero)
        $remaining -= [Math]::Abs($step)
        Start-Sleep -Milliseconds 25
      }
    }
    default { throw "unknown mouse action ""$action""" }
  }
  Start-Sleep -Milliseconds 60
  $cur = Get-CursorPosition
  return @{ action = $action; x = $cur.x; y = $cur.y; virtual = (Get-VirtualBounds) }
}

function Op-Key {
  param($p)
  $action = [string]$p.action
  if ($action -eq 'type') {
    $text = [string]$p.text
    if ([string]::IsNullOrEmpty($text)) { return @{ action = 'type'; typed = 0 } }
    $prev = $null
    $restore = $false
    try {
      if ([System.Windows.Forms.Clipboard]::ContainsText()) { $prev = [System.Windows.Forms.Clipboard]::GetText(); $restore = $true }
    } catch { }
    try {
      [System.Windows.Forms.Clipboard]::SetText($text)
      Start-Sleep -Milliseconds 60
      Send-KeySequence @('ctrl+v')
      Start-Sleep -Milliseconds ([Math]::Max(120, [Math]::Min(1500, 60 + $text.Length * 8)))
    } finally {
      if ($restore -and $null -ne $prev) {
        Start-Sleep -Milliseconds 80
        try { [System.Windows.Forms.Clipboard]::SetText($prev) } catch { }
      }
    }
    return @{ action = 'type'; typed = $text.Length }
  }
  if ($action -eq 'press') {
    $keys = @()
    if ($null -ne $p.keys) { $keys = @($p.keys | ForEach-Object { [string]$_ }) }
    elseif (-not [string]::IsNullOrWhiteSpace([string]$p.text)) { $keys = @([string]$p.text) }
    if ($keys.Count -eq 0) { throw 'press needs keys, e.g. ["ctrl+s"]' }
    Send-KeySequence $keys
    return @{ action = 'press'; keys = $keys }
  }
  throw "unknown key action ""$action"""
}

function Op-Window {
  param($p)
  $action = [string]$p.action
  switch ($action) {
    'list' {
      $rows = Get-WindowList
      $rows = $rows | Sort-Object -Property @{ Expression = 'active'; Descending = $true }, @{ Expression = 'title' }
      return @{ count = $rows.Count; windows = @($rows); virtual = (Get-VirtualBounds) }
    }
    'focus' {
      $t = Resolve-WindowTarget $p
      $ok = Set-WindowFocus $t.hwnd
      return @{ handle = [int64]$t.hwnd.ToInt64(); title = $t.title; focused = $ok }
    }
    'close' {
      $t = Resolve-WindowTarget $p
      [void][DshWin]::PostMessageW($t.hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
      return @{ handle = [int64]$t.hwnd.ToInt64(); title = $t.title; closed = $true }
    }
    'minimize' {
      $t = Resolve-WindowTarget $p
      [void][DshWin]::ShowWindow($t.hwnd, 6)
      return @{ handle = [int64]$t.hwnd.ToInt64(); state = 'minimized' }
    }
    'maximize' {
      $t = Resolve-WindowTarget $p
      [void][DshWin]::ShowWindow($t.hwnd, 3)
      return @{ handle = [int64]$t.hwnd.ToInt64(); state = 'maximized' }
    }
    'restore' {
      $t = Resolve-WindowTarget $p
      [void][DshWin]::ShowWindow($t.hwnd, 9)
      return @{ handle = [int64]$t.hwnd.ToInt64(); state = 'normal' }
    }
    'move' {
      $t = Resolve-WindowTarget $p
      $r = New-Object DshWin+RECT
      [void][DshWin]::GetWindowRect($t.hwnd, [ref]$r)
      $x = $r.Left; $y = $r.Top; $w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
      if ($null -ne $p.x) { $x = [int]$p.x }
      if ($null -ne $p.y) { $y = [int]$p.y }
      if ($null -ne $p.width) { $w = [int]$p.width }
      if ($null -ne $p.height) { $h = [int]$p.height }
      [void][DshWin]::MoveWindow($t.hwnd, $x, $y, $w, $h, $true)
      return @{ handle = [int64]$t.hwnd.ToInt64(); x = $x; y = $y; width = $w; height = $h }
    }
    'info' {
      $t = Resolve-WindowTarget $p
      $r = New-Object DshWin+RECT
      [void][DshWin]::GetWindowRect($t.hwnd, [ref]$r)
      $state = 'normal'
      if ([DshWin]::IsIconic($t.hwnd)) { $state = 'minimized' } elseif ([DshWin]::IsZoomed($t.hwnd)) { $state = 'maximized' }
      return @{
        handle = [int64]$t.hwnd.ToInt64(); title = $t.title; state = $state
        x = [int]$r.Left; y = [int]$r.Top; width = [int]($r.Right - $r.Left); height = [int]($r.Bottom - $r.Top)
      }
    }
    default { throw "unknown window action ""$action""" }
  }
}

function Op-App {
  param($p)
  $action = [string]$p.action
  switch ($action) {
    'launch' {
      $file = [string]$p.path
      if ([string]::IsNullOrWhiteSpace($file)) { throw 'launch needs path (executable, document, folder or URL)' }
      $startArgs = @{ FilePath = $file; PassThru = $true }
      if (-not [string]::IsNullOrWhiteSpace([string]$p.arguments)) { $startArgs['ArgumentList'] = [string]$p.arguments }
      if (-not [string]::IsNullOrWhiteSpace([string]$p.workingDirectory)) { $startArgs['WorkingDirectory'] = [string]$p.workingDirectory }
      $proc = Start-Process @startArgs
      $result = @{ launched = $file; pid = 0; process = ''; handle = [int64]0 }
      if ($null -ne $proc) {
        $result.pid = [int]$proc.Id
        try { $result.process = [string]$proc.ProcessName } catch { }
      }
      # Packaged apps start through a shim, so the process that owns the window
      # is usually a different one; prefer the window whose process matches the
      # executable name.
      $base = [System.IO.Path]::GetFileNameWithoutExtension($file)
      for ($attempt = 0; $attempt -lt 6; $attempt++) {
        Start-Sleep -Milliseconds 350
        $rows = Get-WindowList
        $match = $rows | Where-Object { $_.process -eq $base } | Select-Object -Last 1
        if ($null -eq $match -and $null -ne $proc) { $match = $rows | Where-Object { $_.processId -eq $proc.Id } | Select-Object -First 1 }
        if ($null -ne $match) {
          $result.handle = [int64]$match.handle
          $result.pid = [int]$match.processId
          $result.process = [string]$match.process
          $result.title = [string]$match.title
          break
        }
      }
      return $result
    }
    'list' {
      $list = New-Object System.Collections.ArrayList
      foreach ($proc in (Get-Process -ErrorAction SilentlyContinue | Sort-Object -Property ProcessName)) {
        $h = [int64]0
        try { $h = [int64]$proc.MainWindowHandle.ToInt64() } catch { }
        if ($h -eq 0) { continue }
        $null = $list.Add(@{
          pid = [int]$proc.Id; process = $proc.ProcessName; handle = $h
          title = $proc.MainWindowTitle; memoryMb = [Math]::Round($proc.WorkingSet64 / 1MB, 1)
        })
      }
      return @{ count = $list.Count; processes = @($list) }
    }
    'close' {
      if ($null -eq $p.pid) { throw 'close needs pid' }
      $proc = Get-Process -Id ([int]$p.pid) -ErrorAction Stop
      $name = $proc.ProcessName
      try { [void]$proc.CloseMainWindow() } catch { }
      Start-Sleep -Milliseconds 500
      try { if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force } } catch { }
      return @{ pid = [int]$p.pid; process = $name; closed = $true }
    }
    default { throw "unknown app action ""$action""" }
  }
}

function Op-Clipboard {
  param($p)
  $action = [string]$p.action
  if ($action -eq 'read') {
    $text = ''
    for ($i = 0; $i -lt 3; $i++) {
      try { $text = [System.Windows.Forms.Clipboard]::GetText(); break } catch { Start-Sleep -Milliseconds 80 }
    }
    return @{ text = $text; length = $text.Length }
  }
  if ($action -eq 'write') {
    $text = [string]$p.text
    for ($i = 0; $i -lt 3; $i++) {
      try { [System.Windows.Forms.Clipboard]::SetText($text); return @{ written = $text.Length } } catch { Start-Sleep -Milliseconds 80 }
    }
    throw 'clipboard is busy: another application holds it'
  }
  throw "unknown clipboard action ""$action"""
}

function Get-UiaElement {
  param($ref)
  if (-not $script:UiaReady) { throw 'UI Automation is unavailable in this PowerShell host' }
  $key = [string]$ref
  if (-not $script:UiaCache.ContainsKey($key)) {
    throw "unknown element ref ""$ref""; call computer_ui with action=""tree"" first (refs expire after the next tree read)"
  }
  return $script:UiaCache[$key]
}

function Op-Ui {
  param($p)
  if (-not $script:UiaReady) { throw 'UI Automation is unavailable in this PowerShell host' }
  $action = [string]$p.action
  if ($action -eq 'tree') {
    $t = $null
    try { $t = Resolve-WindowTarget $p } catch { $t = @{ hwnd = [DshWin]::GetForegroundWindow(); title = '' } }
    if ($t.hwnd -eq [IntPtr]::Zero) { throw 'no window to inspect' }
    $script:UiaCache = @{}
    $maxElements = 900
    if ($null -ne $p.maxElements) { $maxElements = [int]$p.maxElements }
    $lines = New-Object System.Collections.ArrayList
    $count = 0
    $script:uiaCounter = 0
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($t.hwnd)
    if ($null -eq $root) { throw 'the target window exposes no UI Automation tree' }
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $script:uiaLines = $lines
    Add-UiaNode $root $walker 0 $maxElements | Out-Null
    return @{ handle = [int64]$t.hwnd.ToInt64(); title = (Get-WindowTitle $t.hwnd); count = $script:uiaCounter; tree = ($lines -join "`n") }
  }
  if ($action -eq 'invoke' -or $action -eq 'click') {
    $el = Get-UiaElement $p.ref
    $done = Invoke-UiaElement $el $action
    return @{ ref = [string]$p.ref; action = $action; result = $done }
  }
  if ($action -eq 'set_value') {
    $el = Get-UiaElement $p.ref
    $pattern = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
      $pattern.SetValue([string]$p.value)
      return @{ ref = [string]$p.ref; action = 'set_value'; result = 'value pattern' }
    }
    throw 'the element does not support setting a value'
  }
  if ($action -eq 'focus') {
    $el = Get-UiaElement $p.ref
    $el.SetFocus()
    return @{ ref = [string]$p.ref; action = 'focus'; result = 'focused' }
  }
  if ($action -eq 'read') {
    $el = Get-UiaElement $p.ref
    return @{ ref = [string]$p.ref; name = $el.Current.Name; value = (Get-UiaValue $el) }
  }
  throw "unknown ui action ""$action"""
}

function Get-UiaValue {
  param($el)
  $pattern = $null
  try {
    if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) { return $pattern.Current.Value }
  } catch { }
  try {
    if ($el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) { return $pattern.DocumentRange.GetText(2000) }
  } catch { }
  return $el.Current.Name
}

function Invoke-UiaElement {
  param($el, [string]$mode)
  $pattern = $null
  try {
    if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { $pattern.Invoke(); return 'invoke pattern' }
  } catch { }
  try {
    if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) { $pattern.Select(); return 'selection item pattern' }
  } catch { }
  try {
    if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pattern)) { $pattern.Toggle(); return 'toggle pattern' }
  } catch { }
  $rect = $el.Current.BoundingRectangle
  if ($rect.Width -le 0 -or $rect.Height -le 0) { throw 'the element has no clickable area' }
  $el.SetFocus()
  Start-Sleep -Milliseconds 60
  $cx = [int]($rect.X + $rect.Width / 2)
  $cy = [int]($rect.Y + $rect.Height / 2)
  [void][DshWin]::SetCursorPos($cx, $cy)
  Start-Sleep -Milliseconds 40
  [DshWin]::mouse_event([uint32]$script:MouseFlags.leftdown, 0, 0, 0, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [DshWin]::mouse_event([uint32]$script:MouseFlags.leftup, 0, 0, 0, [IntPtr]::Zero)
  return 'pointer click'
}

function Add-UiaNode {
  param($element, $walker, [int]$depth, [int]$maxElements)
  if ($null -eq $element -or $script:uiaCounter -ge $maxElements) { return }
  if ($depth -gt 24) { return }
  $cur = $element.Current
  $rect = $cur.BoundingRectangle
  $isOffscreen = $false
  try { $isOffscreen = $cur.IsOffscreen } catch { }
  $role = ''
  try { $role = ($cur.ControlType.ProgrammaticName -replace '^ControlType\.', '') } catch { }
  $name = ''
  try { $name = [string]$cur.Name } catch { }
  $autoId = ''
  try { $autoId = [string]$cur.AutomationId } catch { }
  $enabled = $true
  try { $enabled = [bool]$cur.IsEnabled } catch { }
  $patterns = New-Object System.Collections.ArrayList
  try {
    foreach ($sp in $cur.GetSupportedPatterns()) {
      $pn = ''
      try { $pn = [string]$sp.ProgrammaticName } catch { }
      if ($pn -eq 'InvokePatternIdentifiers.Pattern') { $null = $patterns.Add('invoke') }
      elseif ($pn -eq 'ValuePatternIdentifiers.Pattern') { $null = $patterns.Add('value') }
      elseif ($pn -eq 'TogglePatternIdentifiers.Pattern') { $null = $patterns.Add('toggle') }
      elseif ($pn -eq 'SelectionItemPatternIdentifiers.Pattern') { $null = $patterns.Add('select') }
      elseif ($pn -eq 'ExpandCollapsePatternIdentifiers.Pattern') { $null = $patterns.Add('expand') }
      elseif ($pn -eq 'TextPatternIdentifiers.Pattern') { $null = $patterns.Add('text') }
    }
  } catch { }
  $actionable = ($patterns.Count -gt 0) -or ($role -in @('Button', 'MenuItem', 'CheckBox', 'RadioButton', 'TabItem', 'Edit', 'ComboBox', 'Hyperlink', 'ListItem', 'TreeItem'))
  if (-not $isOffscreen -and ($actionable -or -not [string]::IsNullOrWhiteSpace($name))) {
    $ref = $script:uiaCounter
    $script:uiaCounter++
    $script:UiaCache[[string]$ref] = $element
    $sb = New-Object System.Text.StringBuilder
    $null = $sb.Append((' ' * [Math]::Min($depth * 2, 24)))
    $null = $sb.Append('[' + $ref + '] ' + $role)
    if (-not [string]::IsNullOrWhiteSpace($name)) {
      $display = $name -replace "`r?`n", ' '
      if ($display.Length -gt 120) { $display = $display.Substring(0, 120) + '...' }
      $null = $sb.Append(' "' + $display + '"')
    }
    if (-not [string]::IsNullOrWhiteSpace($autoId)) { $null = $sb.Append(' #' + $autoId) }
    if ($patterns.Count -gt 0) { $null = $sb.Append(' <' + ($patterns -join ',') + '>') }
    if ($rect.Width -gt 0 -and $rect.Height -gt 0) {
      $null = $sb.Append(' @' + [int]$rect.X + ',' + [int]$rect.Y + ' ' + [int]$rect.Width + 'x' + [int]$rect.Height)
    }
    if (-not $enabled) { $null = $sb.Append(' disabled') }
    $null = $script:uiaLines.Add($sb.ToString())
  }
  $child = $walker.GetFirstChild($element)
  while ($null -ne $child -and $script:uiaCounter -lt $maxElements) {
    Add-UiaNode $child $walker ($depth + 1) $maxElements
    $child = $walker.GetNextSibling($child)
  }
}
#endregion

#region protocol ------------------------------------------------------------
$script:Ops = @{
  ping = 'Op-Ping'; screenshot = 'Op-Screenshot'; captureFile = 'Op-CaptureFile'
  decodeFrame = 'Op-DecodeFrame'; mouse = 'Op-Mouse'; key = 'Op-Key'; window = 'Op-Window'
  app = 'Op-App'; clipboard = 'Op-Clipboard'; ui = 'Op-Ui'
}

function Invoke-Op {
  param([string]$op, $params)
  if (-not $script:Ops.ContainsKey($op)) { throw "unknown op ""$op""" }
  $fn = $script:Ops[$op]
  $out = & $fn $params
  $chosen = $out
  if ($out -is [array]) {
    $chosen = $out | Where-Object { $_ -is [hashtable] } | Select-Object -First 1
    if ($null -eq $chosen) { $chosen = @{ value = $out } }
  }
  return $chosen
}

function ConvertTo-JsonLine {
  param($obj)
  return (ConvertTo-Json -InputObject $obj -Depth 24 -Compress)
}

if ($SelfTest) {
  '--- ping'
  ConvertTo-JsonLine (Invoke-Op 'ping' @{}) 
  '--- windows'
  ConvertTo-JsonLine (Invoke-Op 'window' @{ action = 'list' })
  '--- screenshot(64)'
  $s = Invoke-Op 'screenshot' @{ maxWidth = 320 }
  "w=$($s.width) h=$($s.height) scale=$($s.scale) bytes=$($s.bytes) monitors=$($s.monitors.Count)"
  if ($script:UiaReady) {
    '--- ui tree'
    $u = Invoke-Op 'ui' @{ action = 'tree'; maxElements = 40 }
    $u.tree
  }
  exit 0
}

$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), (New-Object System.Text.UTF8Encoding($false)), $false)
$stdout = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), (New-Object System.Text.UTF8Encoding($false)))
$stdout.AutoFlush = $true

$stdout.WriteLine('{"ready":true}')

while ($true) {
  $line = $null
  try { $line = $stdin.ReadLine() } catch { break }
  if ($null -eq $line) { break }
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  $id = 0
  try {
    $req = ConvertFrom-Json -InputObject $line
    $id = [int]$req.id
    $result = Invoke-Op ([string]$req.op) $req.params
    $resp = @{ id = $id; ok = $true; result = $result }
  } catch {
    $msg = $_.Exception.Message
    $resp = @{ id = $id; ok = $false; error = $msg }
  }
  try { $stdout.WriteLine((ConvertTo-JsonLine $resp)) } catch { break }
}
#endregion
