# Follow the physical mouse button for the client-to-desktop drag handoff.
# Prints "left|x|y" at ~120Hz until the left button is released.

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DshWhaleMouse {
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")]
  public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")]
  public static extern short GetAsyncKeyState(int vKey);
}
"@

while ($true) {
  $pt = New-Object DshWhaleMouse+POINT
  [DshWhaleMouse]::GetCursorPos([ref]$pt) | Out-Null
  $left = (([DshWhaleMouse]::GetAsyncKeyState(0x01) -band 0x8000) -ne 0)
  [Console]::Out.WriteLine(([int]$left).ToString() + '|' + $pt.X + '|' + $pt.Y)
  [Console]::Out.Flush()
  if (-not $left) { break }
  Start-Sleep -Milliseconds 8
}
