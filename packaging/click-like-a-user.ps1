# CI only: the user's hand. While AnomalyHunter.exe installs, answer the dialogs a person would answer - "Yes" on
# Windows' certificate warning, "OK" on Anomaly Hunter's own message - and keep a screenshot + the text of each one.
# Usage (Windows PowerShell): click-like-a-user.ps1 <folder for screenshots and clicks.log> [minutes]
param([string]$Out, [int]$Minutes = 10)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms, System.Drawing
$A = [Windows.Automation.AutomationElement]
$P = [Windows.Automation.AutomationElement]
$answer = @{ 'Security Warning' = 'Yes'; 'Anomaly Hunter' = 'OK' }
New-Item -ItemType Directory -Force $Out | Out-Null
$n = 0; $end = (Get-Date).AddMinutes($Minutes)
function Shot($file) {
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  [System.Drawing.Graphics]::FromImage($bmp).CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
  $bmp.Save($file); $bmp.Dispose()
}
while ((Get-Date) -lt $end) {
  foreach ($w in $A::RootElement.FindAll([Windows.Automation.TreeScope]::Children, [Windows.Automation.Condition]::TrueCondition)) {
    $title = $w.Current.Name
    if (-not $answer.ContainsKey($title)) { continue }
    $n++
    $words = ($w.FindAll([Windows.Automation.TreeScope]::Descendants,
      (New-Object Windows.Automation.PropertyCondition($P::ControlTypeProperty, [Windows.Automation.ControlType]::Text))) |
      ForEach-Object { $_.Current.Name }) -join ' | '
    Shot (Join-Path $Out ("dialog-{0}.png" -f $n))
    $btn = $w.FindFirst([Windows.Automation.TreeScope]::Descendants,
      (New-Object Windows.Automation.AndCondition(
        (New-Object Windows.Automation.PropertyCondition($P::ControlTypeProperty, [Windows.Automation.ControlType]::Button)),
        (New-Object Windows.Automation.PropertyCondition($P::NameProperty, $answer[$title])))))
    $btn.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
    "dialog $n '$title': clicked $($answer[$title]) - $words" | Out-File -Append -Encoding utf8 (Join-Path $Out 'clicks.log')
    Start-Sleep -Milliseconds 800
  }
  Start-Sleep -Milliseconds 300
}
