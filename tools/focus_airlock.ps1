param(
    [string]$Title = 'Airlock',
    [string[]]$ProcessNames = @('msedge', 'chrome'),
    [switch]$DetectOnly
)

$signature = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class AirlockWindow
{
    private delegate bool EnumWindowsProc(IntPtr window, IntPtr state);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr state);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr window, StringBuilder text, int count);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool ShowWindowAsync(IntPtr window, int command);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr window, IntPtr after,
        int x, int y, int cx, int cy, uint flags);

    public static IntPtr FindExact(string title, int[] processIds)
    {
        var allowed = new HashSet<int>(processIds);
        IntPtr match = IntPtr.Zero;

        EnumWindows(delegate(IntPtr window, IntPtr state) {
            if (!IsWindowVisible(window)) return true;

            uint processId;
            GetWindowThreadProcessId(window, out processId);
            if (!allowed.Contains((int)processId)) return true;

            var text = new StringBuilder(512);
            GetWindowText(window, text, text.Capacity);
            if (!String.Equals(text.ToString(), title, StringComparison.Ordinal)) return true;

            match = window;
            return false;
        }, IntPtr.Zero);

        return match;
    }

    // Returns whether the window actually came forward, not merely that we asked.
    //
    // Windows' foreground lock lets it refuse SetForegroundWindow from a process that isn't
    // already in front — which is exactly this script's situation. Restoring a minimised
    // window is reliable; raising a buried one is not, and a discarded return value there is
    // the difference between a working taskbar click and one that appears to do nothing.
    public static bool Focus(IntPtr window)
    {
        const int SW_RESTORE = 9;
        const int SW_SHOW = 5;
        const uint SWP_NUDGE = 0x0043;      // NOSIZE | NOMOVE | SHOWWINDOW
        IntPtr HWND_TOPMOST = new IntPtr(-1);
        IntPtr HWND_NOTOPMOST = new IntPtr(-2);

        ShowWindowAsync(window, IsIconic(window) ? SW_RESTORE : SW_SHOW);
        if (SetForegroundWindow(window)) return true;

        // Same nudge the folder picker uses: yank it to the top of the Z-order, drop it back
        // out of always-on-top, then ask again.
        SetWindowPos(window, HWND_TOPMOST, 0, 0, 0, 0, SWP_NUDGE);
        SetWindowPos(window, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NUDGE);
        return SetForegroundWindow(window);
    }
}
'@

try {
    Add-Type -TypeDefinition $signature -ErrorAction Stop

    $processIds = @(Get-Process -Name $ProcessNames -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty Id)
    if ($processIds.Count -eq 0) { exit 1 }

    $window = [AirlockWindow]::FindExact($Title, [int[]]$processIds)
    if ($window -eq [IntPtr]::Zero) { exit 1 }

    # 0 found and raised · 1 not found · 2 helper broke · 4 found but Windows refused the
    # raise. Callers must treat 4 like 0 and NOT open another window — the window is there,
    # and a duplicate app window is worse than one that didn't come forward.
    if ($DetectOnly) { exit 0 }
    if ([AirlockWindow]::Focus($window)) { exit 0 }
    exit 4
} catch {
    exit 2
}
