# Enumerate visible top-level desktop windows for widget edge snapping.
# Emits one JSON array line when the visible window set or geometry changes.

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class DshWhaleWindowInfo {
  public long hwnd;
  public int left;
  public int top;
  public int right;
  public int bottom;
  public string title;
}

public class DshWhaleWindows {
  private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")]
  private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")]
  private static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")]
  private static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")]
  private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")]
  private static extern int GetWindowLong(IntPtr hWnd, int index);
  [DllImport("user32.dll")]
  private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetClassName(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("dwmapi.dll")]
  private static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out RECT rect, int size);
  [DllImport("dwmapi.dll")]
  private static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out int value, int size);

  [StructLayout(LayoutKind.Sequential)]
  private struct RECT { public int Left, Top, Right, Bottom; }

  private static readonly HashSet<string> IgnoredClasses = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
    "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd",
    "Windows.UI.Core.CoreWindow"
  };

  public static DshWhaleWindowInfo[] Snapshot(uint excludedPid) {
    var result = new List<DshWhaleWindowInfo>();
    EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
      if (!IsWindowVisible(hWnd) || IsIconic(hWnd)) return true;

      uint pid;
      GetWindowThreadProcessId(hWnd, out pid);
      if (pid == excludedPid) return true;

      var exStyle = GetWindowLong(hWnd, -20);
      if ((exStyle & 0x00000080) != 0) return true; // WS_EX_TOOLWINDOW

      var cls = new StringBuilder(256);
      GetClassName(hWnd, cls, cls.Capacity);
      if (IgnoredClasses.Contains(cls.ToString())) return true;

      int cloaked;
      if (DwmGetWindowAttribute(hWnd, 14, out cloaked, sizeof(int)) == 0 && cloaked != 0) return true;

      RECT rect;
      bool got = DwmGetWindowAttribute(hWnd, 9, out rect, Marshal.SizeOf(typeof(RECT))) == 0;
      if (!got && !GetWindowRect(hWnd, out rect)) return true;

      int width = rect.Right - rect.Left;
      int height = rect.Bottom - rect.Top;
      if (width < 120 || height < 80) return true;

      var title = new StringBuilder(512);
      GetWindowText(hWnd, title, title.Capacity);
      if (title.Length == 0) return true;

      result.Add(new DshWhaleWindowInfo {
        hwnd = hWnd.ToInt64(),
        left = rect.Left,
        top = rect.Top,
        right = rect.Right,
        bottom = rect.Bottom,
        title = title.ToString()
      });
      return true;
    }, IntPtr.Zero);
    return result.ToArray();
  }
}
"@

$excludedPid = 0
if ($env:DSH_WHALE_HELPER_PID) {
  [uint32]::TryParse($env:DSH_WHALE_HELPER_PID, [ref]$excludedPid) | Out-Null
}

$last = ''
$hotUntil = [DateTime]::MinValue
while ($true) {
  $list = @([DshWhaleWindows]::Snapshot([uint32]$excludedPid) | Sort-Object { [long]$_.hwnd })
  $json = ConvertTo-Json -InputObject $list -Compress -Depth 4
  if ($json -ne $last) {
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
    $last = $json
    $hotUntil = [DateTime]::UtcNow.AddMilliseconds(500)
  }
  if ([DateTime]::UtcNow -lt $hotUntil) {
    Start-Sleep -Milliseconds 12
  } else {
    Start-Sleep -Milliseconds 33
  }
}
