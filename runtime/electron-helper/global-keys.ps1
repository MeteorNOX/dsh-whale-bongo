# Global keyboard state sampler for the desktop widget.
# Prints one line per physical key transition:
#   down|vk|ctrl|alt|shift|meta
# Uses GetAsyncKeyState so it works while another application has focus.

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DshWhaleKeyState {
  [DllImport("user32.dll")]
  public static extern short GetAsyncKeyState(int vKey);
}
"@

$keys = 8..255
$prev = @{}
foreach ($k in $keys) {
  $prev[$k] = (([DshWhaleKeyState]::GetAsyncKeyState($k) -band 0x8000) -ne 0)
}

while ($true) {
  $ctrl = (([DshWhaleKeyState]::GetAsyncKeyState(0x11) -band 0x8000) -ne 0)
  $alt = (([DshWhaleKeyState]::GetAsyncKeyState(0x12) -band 0x8000) -ne 0)
  $shift = (([DshWhaleKeyState]::GetAsyncKeyState(0x10) -band 0x8000) -ne 0)
  $meta = ((([DshWhaleKeyState]::GetAsyncKeyState(0x5B) -band 0x8000) -ne 0) -or (([DshWhaleKeyState]::GetAsyncKeyState(0x5C) -band 0x8000) -ne 0))
  foreach ($k in $keys) {
    $down = (([DshWhaleKeyState]::GetAsyncKeyState($k) -band 0x8000) -ne 0)
    if ($down -ne $prev[$k]) {
      $prev[$k] = $down
      $line = ([int]$down).ToString() + '|' + $k + '|' + ([int]$ctrl) + '|' + ([int]$alt) + '|' + ([int]$shift) + '|' + ([int]$meta)
      [Console]::Out.WriteLine($line)
      [Console]::Out.Flush()
    }
  }
  Start-Sleep -Milliseconds 20
}
