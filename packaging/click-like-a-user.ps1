# CI only: the user's hand. While AnomalyHunter.exe installs or uninstalls, answer the dialogs a person would answer -
# "Run" on Windows' warning for a file from the internet (and SmartScreen's "More info" > "Run anyway" if it shows),
# "Yes" on Windows' certificate prompts (add, and remove on uninstall), "OK" on Anomaly Hunter's own message - and log
# each dialog's words (+ a screenshot), and every new window that appears (so a dialog nobody planned for shows up in the log).
# Clicks the button directly (BM_CLICK, what a mouse click sends a classic dialog); UI Automation's Invoke didn't land
# there - it is only used for SmartScreen, which has no classic buttons.
# Usage (Windows PowerShell): click-like-a-user.ps1 <folder for screenshots and clicks.log> [minutes]
param([string]$Out, [int]$Minutes = 10)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing, UIAutomationClient, UIAutomationTypes
Add-Type @"
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;
public static class Hand {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EnumProc f, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  static string Text(IntPtr h) { var s = new StringBuilder(2048); GetWindowText(h, s, 2048); return s.ToString(); }
  static string Cls(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  static IntPtr found;
  // A visible window titled `title` with a `button` -> the dialog's words (the button is kept for Click), else null
  public static string Find(string title, string button) {
    string said = null; found = IntPtr.Zero;
    EnumWindows((w, l) => {
      if (said != null || !IsWindowVisible(w) || Text(w) != title) return true;
      var words = new List<string>(); IntPtr btn = IntPtr.Zero;
      EnumChildWindows(w, (c, l2) => {
        string t = Text(c);
        if (Cls(c) == "Button" && t.Replace("&", "") == button) btn = c;
        else if (t.Trim().Length > 0) words.Add(t.Replace("\r", " ").Replace("\n", " "));
        return true;
      }, IntPtr.Zero);
      if (btn == IntPtr.Zero) return true;
      said = string.Join(" | ", words); found = btn;
      SetForegroundWindow(w);
      return false;
    }, IntPtr.Zero);
    return said;
  }
  public static void Click() { SendMessage(found, 0x00F5, IntPtr.Zero, IntPtr.Zero); } // BM_CLICK
  // Fallback for a dialog drawn without button windows: is a window with this title up? (brought to the front)
  // Every visible titled top-level window, for the log
  public static string Titles() {
    var all = new List<string>();
    EnumWindows((w, l) => { if (IsWindowVisible(w) && Text(w).Trim().Length > 0) all.Add(Text(w)); return true; }, IntPtr.Zero);
    all.Sort(); return string.Join(" | ", all);
  }
  // Visible titled top-level windows, and one window described: title, class, process id and the words inside it
  public static IntPtr[] Tops() {
    var all = new List<IntPtr>();
    EnumWindows((w, l) => { if (IsWindowVisible(w) && Text(w).Trim().Length > 0) all.Add(w); return true; }, IntPtr.Zero);
    return all.ToArray();
  }
  public static string Info(IntPtr w) {
    uint pid; GetWindowThreadProcessId(w, out pid);
    var words = new List<string>();
    EnumChildWindows(w, (c, l2) => { string t = Text(c); if (t.Trim().Length > 0) words.Add(Cls(c) + ": " + t.Replace("\r", " ").Replace("\n", " ")); return true; }, IntPtr.Zero);
    return "'" + Text(w) + "' class " + Cls(w) + " pid " + pid + " | " + string.Join(" | ", words);
  }
  public static bool Front(string title) {
    bool up = false;
    EnumWindows((w, l) => { if (IsWindowVisible(w) && Text(w) == title) { up = true; SetForegroundWindow(w); return false; } return true; }, IntPtr.Zero);
    return up;
  }
}
"@
New-Item -ItemType Directory -Force $Out | Out-Null
$log = Join-Path $Out 'clicks.log'
function Shot($file) {
  try {
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    [System.Drawing.Graphics]::FromImage($bmp).CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $bmp.Save($file); $bmp.Dispose()
  } catch { }  # no screen to copy: the words in clicks.log are the proof
}
# SmartScreen ("Windows protected your PC"): More info, then Run anyway - by UI Automation, it has no classic buttons
$ua = [System.Windows.Automation.AutomationElement]; $tree = [System.Windows.Automation.TreeScope]
function Press($root, $name) {
  $c = New-Object System.Windows.Automation.PropertyCondition($ua::NameProperty, $name)
  $e = $root.FindFirst($tree::Descendants, $c)
  if (-not $e) { return $false }
  $pat = $null
  if ($e.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pat)) { $pat.Invoke(); return $true }
  return $false
}
function SmartScreen {  # its window title names it; the words inside say "Windows protected your PC"
  foreach ($top in $ua::RootElement.FindAll($tree::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
    if ($top.Current.Name -notmatch 'SmartScreen') { continue }
    if (Press $top 'Run anyway') { return 'Run anyway' }
    if (Press $top 'More info') { return 'More info' }
  }
  return $null
}
# Any window that appears after this script starts (a warning nobody planned for): described once in clicks.log with a
# screenshot, and watched for Windows' own "Run anyway" / "Run" / "More info" - what a person would press to go on
$known = @{}; foreach ($h in [Hand]::Tops()) { $known["$h"] = 1 }
$watch = New-Object System.Collections.ArrayList
function Describe($h) {
  $names = ''
  try {
    $all = $ua::FromHandle($h).FindAll($tree::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $names = (@($all | ForEach-Object { "$($_.Current.ControlType.ProgrammaticName -replace '^ControlType\.', '')=$($_.Current.Name)" } |
      Where-Object { $_ -notmatch '=$' } | Select-Object -First 40) -join ' | ')
  } catch { }
  "process $(try { (Get-Process -Id ([Hand]::Info($h) -replace '^.* pid (\d+) .*$', '$1') -ErrorAction Stop).Path } catch { '?' }) || $([Hand]::Info($h)) || ui: $names"
}
$n = 0; $end = (Get-Date).AddMinutes($Minutes); $seen = ''; $tick = 0
"ready $(Get-Date -Format o)" | Out-File -Append -Encoding utf8 $log   # the test starts the double-click after this line
while ((Get-Date) -lt $end) {
  if (($tick++ % 6) -eq 0 -and ($now = [Hand]::Titles()) -ne $seen) { "windows: $now" | Out-File -Append -Encoding utf8 $log; $seen = $now }
  foreach ($h in [Hand]::Tops()) {
    if ($known["$h"]) { continue }
    $known["$h"] = 1; $n++; Shot (Join-Path $Out ("window-{0}.png" -f $n))
    "new window $n - $(Describe $h)" | Out-File -Append -Encoding utf8 $log
    [void]$watch.Add($h)
  }
  foreach ($h in @($watch)) {
    if (-not [Hand]::IsWindow($h)) { $watch.Remove($h); continue }
    foreach ($b in 'Run anyway', 'Run', 'More info') {
      $hit = $false; try { $hit = Press ($ua::FromHandle($h)) $b } catch { }
      if ($hit) { $n++; "dialog $n (new window $h): pressed $b" | Out-File -Append -Encoding utf8 $log; Start-Sleep -Milliseconds 1500; break }
    }
  }
  $ss = $null; try { $ss = SmartScreen } catch { }
  if ($ss) {
    $n++; Shot (Join-Path $Out ("dialog-{0}.png" -f $n))
    "dialog $n 'SmartScreen': clicked $ss" | Out-File -Append -Encoding utf8 $log
    Start-Sleep -Milliseconds 1500
  }
  foreach ($d in @(@('Open File - Security Warning', 'Run'), @('Security Warning', 'Yes'), @('Root Certificate Store', 'Yes'), @('Anomaly Hunter', 'OK'))) {
    $said = [Hand]::Find($d[0], $d[1])
    if ($null -ne $said) {
      $n++; Shot (Join-Path $Out ("dialog-{0}.png" -f $n))   # what the user sees, before the click
      [Hand]::Click()
    } elseif ([Hand]::Front($d[0])) {  # no button windows to click: press the key a person would
      $n++; Shot (Join-Path $Out ("dialog-{0}.png" -f $n)); $said = '(keyboard)'
      [System.Windows.Forms.SendKeys]::SendWait($(switch ($d[1]) { 'Yes' { 'y' } 'Run' { '%r' } default { '{ENTER}' } }))
    } else { continue }
    "dialog $n '$($d[0])': clicked $($d[1]) - $said" | Out-File -Append -Encoding utf8 $log
    Start-Sleep -Milliseconds 1500
  }
  Start-Sleep -Milliseconds 500
}
