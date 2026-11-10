using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

// One native sidecar for the desktop helper. It owns:
//   - visible top-level window enumeration (DWM extended frame bounds)
//   - global keyboard state sampling
//   - mouse-follow sampling while a client->desktop drag is active
//
// Line protocol (UTF-8 JSON, one object per line):
//   {"type":"windows","list":[{"hwnd":"123","left":0,...}]}
//   {"type":"key","down":1,"vk":65,"ctrl":0,"alt":0,"shift":0,"meta":0}
//   {"type":"mouse","left":1,"x":100,"y":200}
// Commands from stdin:
//   windows:start / windows:stop
//   keys:start / keys:stop
//   mouse:start / mouse:stop
//   ping / quit
class WhaleNativeHelper
{
    private static readonly object OutputLock = new object();
    private static readonly StreamWriter Output =
        new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
    private static readonly TextReader Input =
        new StreamReader(Console.OpenStandardInput(), Encoding.UTF8);

    private static volatile bool running = true;
    private static volatile bool windowsEnabled = false;
    private static volatile bool keysEnabled = false;
    private static volatile bool mouseEnabled = false;
    private static volatile bool pointerWatch = false;
    private static volatile bool windowsReset = true;
    private static volatile bool keysReset = true;

    private static readonly HashSet<string> IgnoredClasses = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    private static readonly HashSet<uint> ExcludedPids = new HashSet<uint>();
    private static readonly List<WindowInfo> Windows = new List<WindowInfo>();

    [STAThread]
    private static int Main(string[] args)
    {
        Output.AutoFlush = true;
        bool keysOnly = false;
        for (int i = 0; i < args.Length; i++)
        {
            if (String.Equals(args[i], "--keys-only", StringComparison.OrdinalIgnoreCase)) keysOnly = true;
        }

        IgnoredClasses.Add("Progman");
        IgnoredClasses.Add("WorkerW");
        IgnoredClasses.Add("Shell_TrayWnd");
        IgnoredClasses.Add("Shell_SecondaryTrayWnd");
        IgnoredClasses.Add("Windows.UI.Core.CoreWindow");

        ExcludedPids.Add((uint)Process.GetCurrentProcess().Id);
        uint envPid;
        if (UInt32.TryParse(Environment.GetEnvironmentVariable("DSH_WHALE_HELPER_PID") ?? "", out envPid) && envPid != 0)
        {
            ExcludedPids.Add(envPid);
        }

        if (keysOnly)
        {
            windowsEnabled = false;
            keysEnabled = true;
        }

        Thread windowsThread = new Thread(WindowsLoop);
        windowsThread.IsBackground = true;
        windowsThread.Start();

        Thread keysThread = new Thread(KeysLoop);
        keysThread.IsBackground = true;
        keysThread.Start();

        Thread mouseThread = new Thread(MouseLoop);
        mouseThread.IsBackground = true;
        mouseThread.Start();

        // Thread.Sleep granularity defaults to ~15.6 ms on Windows, which caps
        // the hot window sampler around 64 Hz and visibly judders on a 144/165
        // Hz display. Request 1 ms timers while the helper is alive.
        timeBeginPeriod(1);
        try
        {
            CommandLoop();
        }
        finally
        {
            running = false;
            timeEndPeriod(1);
        }
        return 0;
    }

    private static void CommandLoop()
    {
        while (running)
        {
            string line;
            try
            {
                line = Input.ReadLine();
            }
            catch
            {
                return;
            }
            if (line == null) return;
            line = line.Trim();
            if (line.Length == 0) continue;
            if (line == "quit" || line == "exit") return;
            if (line == "windows:start")
            {
                windowsReset = true;
                windowsEnabled = true;
                continue;
            }
            if (line == "windows:stop")
            {
                windowsEnabled = false;
                continue;
            }
            if (line == "keys:start")
            {
                keysReset = true;
                keysEnabled = true;
                continue;
            }
            if (line == "keys:stop")
            {
                keysEnabled = false;
                continue;
            }
            if (line == "mouse:start")
            {
                mouseEnabled = true;
                continue;
            }
            if (line == "mouse:stop")
            {
                mouseEnabled = false;
                continue;
            }
            if (line == "pointer:start")
            {
                pointerWatch = true;
                continue;
            }
            if (line == "pointer:stop")
            {
                pointerWatch = false;
                continue;
            }
            if (line == "ping")
            {
                WriteLine("{\"type\":\"pong\"}");
                continue;
            }
            if (line == "status")
            {
                WriteLine("{\"type\":\"status\",\"windows\":" + (windowsEnabled ? "1" : "0") +
                    ",\"keys\":" + (keysEnabled ? "1" : "0") +
                    ",\"mouse\":" + (mouseEnabled ? "1" : "0") + "}");
                continue;
            }
            if (line == "keys:dump")
            {
                StringBuilder down = new StringBuilder();
                for (int vk = 8; vk <= 255; vk++)
                {
                    if (!IsDown(vk)) continue;
                    if (down.Length > 0) down.Append(',');
                    down.Append(vk.ToString(CultureInfo.InvariantCulture));
                }
                WriteLine("{\"type\":\"keys-down\",\"list\":[" + down + "]}");
            }
        }
    }

    private static void WindowsLoop()
    {
        string last = "";
        DateTime hotUntil = DateTime.MinValue;
        while (running)
        {
            if (!windowsEnabled)
            {
                Thread.Sleep(50);
                continue;
            }
            if (windowsReset)
            {
                windowsReset = false;
                last = "";
            }

            try
            {
                List<WindowInfo> list = SnapshotWindows();
                list.Sort(delegate(WindowInfo a, WindowInfo b) { return a.hwnd.CompareTo(b.hwnd); });
                string json = WindowsJson(list);
                if (json != last)
                {
                    WriteLine(json);
                    last = json;
                    hotUntil = DateTime.UtcNow.AddMilliseconds(500);
                }
            }
            catch (Exception error)
            {
                WriteLine("{\"type\":\"error\",\"message\":\"" + Escape(error.Message) + "\"}");
                Thread.Sleep(500);
            }
            Thread.Sleep(DateTime.UtcNow < hotUntil ? 6 : 33);
        }
    }

    private static volatile bool ctrlDown = false;
    private static volatile bool altDown = false;
    private static volatile bool shiftDown = false;
    private static volatile bool metaDown = false;

    private static void KeysLoop()
    {
        bool[] previous = new bool[256];
        bool registered = false;
        // Raw Input is not delivered to message-only or hidden windows on Windows.
        // Keep this tool window visible but off-screen; WS_EX_TOOLWINDOW hides it from Alt-Tab.
        IntPtr hwnd = CreateWindowEx(0x00000080, "STATIC", "", 0x00CF0000, -2000, -2000, 100, 100,
            IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
        if (hwnd == IntPtr.Zero)
        {
            WriteLine("{\"type\":\"error\",\"message\":\"raw input window creation failed: " +
                Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture) + "\"}");
            return;
        }
        ShowWindow(hwnd, 5);

        RAWINPUTDEVICE[] devices = new RAWINPUTDEVICE[1];
        devices[0].usUsagePage = 0x01;
        devices[0].usUsage = 0x06;
        devices[0].dwFlags = 0x00000100;
        devices[0].hwndTarget = hwnd;

        while (running)
        {
            if (!keysEnabled)
            {
                if (registered)
                {
                    devices[0].dwFlags = 0x00000001;
                    devices[0].hwndTarget = IntPtr.Zero;
                    RegisterRawInputDevices(devices, 1, (uint)Marshal.SizeOf(typeof(RAWINPUTDEVICE)));
                    registered = false;
                }
                Thread.Sleep(30);
                continue;
            }

            if (keysReset)
            {
                keysReset = false;
                Array.Clear(previous, 0, previous.Length);
                ctrlDown = false;
                altDown = false;
                shiftDown = false;
                metaDown = false;
            }

            if (!registered)
            {
                devices[0].dwFlags = 0x00000100;
                devices[0].hwndTarget = hwnd;
                if (!RegisterRawInputDevices(devices, 1, (uint)Marshal.SizeOf(typeof(RAWINPUTDEVICE))))
                {
                    WriteLine("{\"type\":\"error\",\"message\":\"RegisterRawInputDevices failed: " +
                        Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture) + "\"}");
                    Thread.Sleep(1000);
                    continue;
                }
                registered = true;
            }

            try
            {
                MSG msg;
                while (PeekMessage(out msg, IntPtr.Zero, 0, 0, 0x0001))
                {
                    if (msg.message == 0x00FF) HandleRawInput(msg.lParam, previous);
                    TranslateMessage(ref msg);
                    DispatchMessage(ref msg);
                }
            }
            catch (Exception error)
            {
                WriteLine("{\"type\":\"error\",\"message\":\"" + Escape(error.Message) + "\"}");
                Thread.Sleep(500);
            }
            Thread.Sleep(5);
        }

        if (registered)
        {
            devices[0].dwFlags = 0x00000001;
            devices[0].hwndTarget = IntPtr.Zero;
            RegisterRawInputDevices(devices, 1, (uint)Marshal.SizeOf(typeof(RAWINPUTDEVICE)));
        }
        if (hwnd != IntPtr.Zero) DestroyWindow(hwnd);
    }

    private static void HandleRawInput(IntPtr lParam, bool[] previous)
    {
        uint size = 0;
        uint headerSize = (uint)Marshal.SizeOf(typeof(RAWINPUTHEADER));
        GetRawInputData(lParam, 0x10000003, IntPtr.Zero, ref size, headerSize);
        if (size == 0) return;
        IntPtr buffer = Marshal.AllocHGlobal((int)size);
        try
        {
            uint got = GetRawInputData(lParam, 0x10000003, buffer, ref size, headerSize);
            if (got == 0 || got == uint.MaxValue) return;
            RAWINPUT raw = (RAWINPUT)Marshal.PtrToStructure(buffer, typeof(RAWINPUT));
            if (raw.header.dwType != 1) return;
            int vk = raw.keyboard.VKey;
            if (vk == 0 || vk == 0xFF)
            {
                uint mapped = MapVirtualKey(raw.keyboard.MakeCode, 3);
                vk = (int)mapped;
            }
            if (vk <= 0 || vk > 255) return;
            bool down = (raw.keyboard.Flags & 0x0001) == 0;
            if (IsModifier(vk))
            {
                SetModifierState(vk, down);
                return;
            }
            if (previous[vk] == down) return;
            previous[vk] = down;
            if (vk < 8 || vk == 20 || vk == 144 || vk == 145) return;
            WriteLine(KeyJson(down, vk, ctrlDown, altDown, shiftDown, metaDown));
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static bool IsModifier(int vk)
    {
        return vk == 0x10 || vk == 0x11 || vk == 0x12 || vk == 0x5B || vk == 0x5C ||
            vk == 0xA0 || vk == 0xA1 || vk == 0xA2 || vk == 0xA3 || vk == 0xA4 || vk == 0xA5;
    }

    private static void SetModifierState(int vk, bool down)
    {
        if (vk == 0x10 || vk == 0xA0 || vk == 0xA1) shiftDown = down;
        else if (vk == 0x11 || vk == 0xA2 || vk == 0xA3) ctrlDown = down;
        else if (vk == 0x12 || vk == 0xA4 || vk == 0xA5) altDown = down;
        else if (vk == 0x5B || vk == 0x5C) metaDown = down;
    }

    private static void MouseLoop()
    {
        while (running)
        {
            if (!mouseEnabled && !pointerWatch)
            {
                Thread.Sleep(20);
                continue;
            }
            POINT point;
            bool left = IsDown(0x01);
            try
            {
                if (GetCursorPos(out point))
                {
                    WriteLine(MouseJson(left, point.X, point.Y));
                }
            }
            catch (Exception error)
            {
                WriteLine("{\"type\":\"error\",\"message\":\"" + Escape(error.Message) + "\"}");
                mouseEnabled = false;
            }
            if (!left && !pointerWatch) mouseEnabled = false;
            Thread.Sleep(6);
        }
    }

    private static List<WindowInfo> SnapshotWindows()
    {
        Windows.Clear();
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
        {
            if (!IsWindowVisible(hWnd) || IsIconic(hWnd)) return true;

            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            if (ExcludedPids.Contains(pid)) return true;

            int exStyle = GetWindowLong(hWnd, -20);
            if ((exStyle & 0x00000080) != 0) return true; // WS_EX_TOOLWINDOW

            StringBuilder cls = new StringBuilder(256);
            GetClassName(hWnd, cls, cls.Capacity);
            if (IgnoredClasses.Contains(cls.ToString())) return true;

            int cloaked;
            if (DwmGetWindowAttributeInt(hWnd, 14, out cloaked, sizeof(int)) == 0 && cloaked != 0) return true;

            RECT rect;
            bool got = DwmGetWindowAttributeRect(hWnd, 9, out rect, Marshal.SizeOf(typeof(RECT))) == 0;
            if (!got && !GetWindowRect(hWnd, out rect)) return true;

            int width = rect.Right - rect.Left;
            int height = rect.Bottom - rect.Top;
            if (width < 120 || height < 80) return true;

            StringBuilder title = new StringBuilder(512);
            GetWindowText(hWnd, title, title.Capacity);
            if (title.Length == 0) return true;

            WindowInfo info = new WindowInfo();
            info.hwnd = hWnd.ToInt64();
            info.left = rect.Left;
            info.top = rect.Top;
            info.right = rect.Right;
            info.bottom = rect.Bottom;
            info.title = title.ToString();
            Windows.Add(info);
            return true;
        }, IntPtr.Zero);
        return new List<WindowInfo>(Windows);
    }

    private static string WindowsJson(List<WindowInfo> list)
    {
        StringBuilder sb = new StringBuilder(4096);
        sb.Append("{\"type\":\"windows\",\"list\":[");
        for (int i = 0; i < list.Count; i++)
        {
            if (i > 0) sb.Append(',');
            WindowInfo w = list[i];
            sb.Append("{\"hwnd\":\"").Append(w.hwnd.ToString(CultureInfo.InvariantCulture)).Append('"');
            sb.Append(",\"left\":").Append(w.left.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"top\":").Append(w.top.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"right\":").Append(w.right.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"bottom\":").Append(w.bottom.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"title\":\"").Append(Escape(w.title)).Append("\"}");
        }
        sb.Append("]}");
        return sb.ToString();
    }

    private static string KeyJson(bool down, int vk, bool ctrl, bool alt, bool shift, bool meta)
    {
        return "{\"type\":\"key\",\"down\":" + (down ? "1" : "0") +
            ",\"vk\":" + vk.ToString(CultureInfo.InvariantCulture) +
            ",\"ctrl\":" + (ctrl ? "1" : "0") +
            ",\"alt\":" + (alt ? "1" : "0") +
            ",\"shift\":" + (shift ? "1" : "0") +
            ",\"meta\":" + (meta ? "1" : "0") + "}";
    }

    private static string MouseJson(bool left, int x, int y)
    {
        return "{\"type\":\"mouse\",\"left\":" + (left ? "1" : "0") +
            ",\"x\":" + x.ToString(CultureInfo.InvariantCulture) +
            ",\"y\":" + y.ToString(CultureInfo.InvariantCulture) + "}";
    }

    private static void WriteLine(string line)
    {
        try
        {
            lock (OutputLock) Output.WriteLine(line);
        }
        catch
        {
            running = false;
        }
    }

    private static string Escape(string value)
    {
        if (String.IsNullOrEmpty(value)) return "";
        StringBuilder sb = new StringBuilder(value.Length + 16);
        for (int i = 0; i < value.Length; i++)
        {
            char c = value[i];
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\b': sb.Append("\\b"); break;
                case '\f': sb.Append("\\f"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 32)
                    {
                        sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    }
                    else
                    {
                        sb.Append(c);
                    }
                    break;
            }
        }
        return sb.ToString();
    }

    private static bool IsDown(int vk)
    {
        return (GetAsyncKeyState(vk) & 0x8000) != 0;
    }

    private sealed class WindowInfo
    {
        public long hwnd;
        public int left;
        public int top;
        public int right;
        public int bottom;
        public string title;
    }

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct RAWINPUTDEVICE
    {
        public ushort usUsagePage;
        public ushort usUsage;
        public uint dwFlags;
        public IntPtr hwndTarget;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RAWINPUTHEADER
    {
        public int dwType;
        public int dwSize;
        public IntPtr hDevice;
        public IntPtr wParam;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RAWKEYBOARD
    {
        public ushort MakeCode;
        public ushort Flags;
        public ushort Reserved;
        public ushort VKey;
        public uint Message;
        public uint ExtraInformation;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RAWINPUT
    {
        public RAWINPUTHEADER header;
        public RAWKEYBOARD keyboard;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public UIntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public POINT pt;
        public uint lPrivate;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int X;
        public int Y;
    }

    [DllImport("winmm.dll")]
    private static extern uint timeBeginPeriod(uint period);
    [DllImport("winmm.dll")]
    private static extern uint timeEndPeriod(uint period);

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
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")]
    private static extern int DwmGetWindowAttributeInt(IntPtr hWnd, int attribute, out int value, int size);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")]
    private static extern int DwmGetWindowAttributeRect(IntPtr hWnd, int attribute, out RECT rect, int size);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateWindowEx(uint exStyle, string className, string windowName,
        uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);
    [DllImport("user32.dll")]
    private static extern bool DestroyWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int command);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RegisterRawInputDevices(RAWINPUTDEVICE[] devices, uint count, uint size);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint GetRawInputData(IntPtr hRawInput, uint command, IntPtr data, ref uint size, uint headerSize);
    [DllImport("user32.dll")]
    private static extern uint MapVirtualKey(uint code, uint mapType);
    [DllImport("user32.dll")]
    private static extern bool PeekMessage(out MSG message, IntPtr hWnd, uint min, uint max, uint remove);
    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref MSG message);
    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage(ref MSG message);
    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int vKey);
    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out POINT point);
}
