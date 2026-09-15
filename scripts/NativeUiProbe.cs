using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Automation;

public static class NativeUiProbe
{
    delegate bool EnumWindowProc(IntPtr window, IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowProc callback, IntPtr data);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder title, int size);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr window, uint message, IntPtr w, IntPtr l);
    public static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        try
        {
            var process = Process.GetProcessById(Int32.Parse(args[1]));
            if (!String.Equals(process.ProcessName, "spellcast", StringComparison.OrdinalIgnoreCase)) throw new Exception("Target is not Spellcast.");
            process.Refresh();
            var window = process.MainWindowHandle;
            if (window == IntPtr.Zero || process.MainWindowTitle != "Spellcast")
            {
                var candidates = new List<IntPtr>();
                EnumWindows(delegate(IntPtr handle, IntPtr unused) {
                    uint owner; GetWindowThreadProcessId(handle, out owner);
                    var title = new StringBuilder(256); GetWindowText(handle, title, title.Capacity);
                    if (owner == process.Id && title.ToString() == "Spellcast") candidates.Add(handle);
                    return true;
                }, IntPtr.Zero);
                if (candidates.Count == 1) window = candidates[0];
            }
            if (args[0] == "window")
            {
                var selectedTitle = new StringBuilder(256); GetWindowText(window, selectedTitle, selectedTitle.Capacity);
                Print(new { hwnd = window.ToInt64(), visible = window != IntPtr.Zero && IsWindowVisible(window), minimized = IsIconic(window), foreground = GetForegroundWindow() == window, title = selectedTitle.ToString() });
                return 0;
            }
            if (window == IntPtr.Zero) throw new Exception("No visible main window yet.");
            if (args[0] == "hide") { ShowWindow(window, 0); Print(new { hidden = true }); return 0; }
            if (args[0] == "close") { Print(new { posted = PostMessage(window, 0x10, IntPtr.Zero, IntPtr.Zero) }); return 0; }
            var root = AutomationElement.FromHandle(window);
            if (args.Length > 3)
            {
                root = root.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.AutomationIdProperty, args[3]));
                if (root == null) throw new Exception("Scope not found: " + args[3]);
            }
            var elements = root.FindAll(TreeScope.Descendants, Condition.TrueCondition);
            var result = new List<Dictionary<string, object>>();
            var matches = new List<AutomationElement>();
            for (int index = 0; index < elements.Count && index < 1000; index++)
            {
                var element = elements[index];
                var info = element.Current;
                if (info.IsOffscreen) continue;
                if (args[0] == "invoke" && info.IsEnabled && info.ControlType == ControlType.Button && (info.AutomationId == args[2] || info.Name == args[2])) matches.Add(element);
                if (args[0] == "value" && info.AutomationId == args[2]) matches.Add(element);
                if (args[0] == "buttons" && info.ControlType != ControlType.Button) continue;
                if (info.Name.Length == 0 && info.AutomationId.Length == 0) continue;
                result.Add(new Dictionary<string, object> { { "name", info.Name }, { "id", info.AutomationId }, { "type", info.ControlType.ProgrammaticName }, { "enabled", info.IsEnabled } });
            }
            if (args[0] == "invoke")
            {
                if (matches.Count != 1) throw new Exception("Expected one enabled button, found " + matches.Count);
                object pattern;
                if (!matches[0].TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) throw new Exception("Button has no native Invoke pattern.");
                ((InvokePattern)pattern).Invoke();
                Print(new { invoked = args[2] });
            }
            else if (args[0] == "value")
            {
                if (matches.Count != 1) throw new Exception("Expected one value control.");
                object pattern;
                if (!matches[0].TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) throw new Exception("No native value pattern.");
                Print(new { value = ((ValuePattern)pattern).Current.Value });
            }
            else Print(result);
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error.ToString()); return 1; }
    }
    static void Print(object data) { Console.WriteLine(new JavaScriptSerializer().Serialize(data)); }
}
