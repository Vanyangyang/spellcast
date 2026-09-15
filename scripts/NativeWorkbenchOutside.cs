using System;
using System.Diagnostics;
using System.IO;
public static class NativeWorkbenchOutside {
  [STAThread] public static int Main() {
    const string root = @"G:\VibeProj\spellcast";
    var start = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe"));
    start.Arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -File \"" + Path.Combine(root, @"scripts\workbench-runtime-outside.ps1") + "\"";
    start.UseShellExecute = false; start.CreateNoWindow = true; start.WorkingDirectory = root;
    start.RedirectStandardOutput = true; start.RedirectStandardError = true;
    using (var process = Process.Start(start)) {
      var output = process.StandardOutput.ReadToEndAsync(); var errors = process.StandardError.ReadToEndAsync(); process.WaitForExit();
      File.WriteAllText(Path.Combine(root, @"artifacts\workbench-20260914\runtime-worker.stdout.txt"), output.Result);
      File.WriteAllText(Path.Combine(root, @"artifacts\workbench-20260914\runtime-worker.stderr.txt"), errors.Result);
      return process.ExitCode;
    }
  }
}
