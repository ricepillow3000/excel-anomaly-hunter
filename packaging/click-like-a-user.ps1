# CI only: the user's hand. While AnomalyHunter.exe installs, answer the dialogs a person would answer - "Yes" on
# Windows' certificate warning, "OK" on Anomaly Hunter's own message - and log each dialog's words (+ a screenshot).
# Clicks the button directly (BM_CLICK, what a mouse click sends a classic dialog); UI Automation's Invoke didn't land.
# Usage (Windows PowerShell): click-like-a-user.ps1 <folder for screenshots and clicks.log> [minutes]
param([string]$Out, [int]$Minutes = 10)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
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
$n = 0; $end = (Get-Date).AddMinutes($Minutes)
while ((Get-Date) -lt $end) {
  foreach ($d in @(@('Security Warning', 'Yes'), @('Anomaly Hunter', 'OK'))) {
    $said = [Hand]::Find($d[0], $d[1])
    if ($null -ne $said) {
      $n++; Shot (Join-Path $Out ("dialog-{0}.png" -f $n))   # what the user sees, before the click
      [Hand]::Click()
    } elseif ([Hand]::Front($d[0])) {  # no button windows to click: press the key a person would
      $n++; Shot (Join-Path $Out ("dialog-{0}.png" -f $n)); $said = '(keyboard)'
      [System.Windows.Forms.SendKeys]::SendWait($(if ($d[1] -eq 'Yes') { 'y' } else { '{ENTER}' }))
    } else { continue }
    "dialog $n '$($d[0])': clicked $($d[1]) - $said" | Out-File -Append -Encoding utf8 $log
    Start-Sleep -Milliseconds 1500
  }
  Start-Sleep -Milliseconds 500
}
