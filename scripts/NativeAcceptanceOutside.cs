using System;
using System.Diagnostics;
using System.IO;

public static class NativeAcceptanceOutside
{
    [STAThread]
    public static int Main(string[] args)
    {
        const string output = @"G:\VibeProj\spellcast\artifacts\runtime-acceptance-20260914";
#if DEPLOY
        bool deploy = true;
#else
        bool deploy = args.Length == 1 && args[0] == "--deploy";
#endif
        if (args.Length != 0 && !deploy) return 2;
        string prefix = deploy ? "deployment" : "outside";
        string script = @"G:\VibeProj\spellcast\scripts\" + (deploy ? "deploy-runtime-outside.ps1" : "run-native-acceptance-outside.ps1");
        Directory.CreateDirectory(output);
        try
        {
            var start = new ProcessStartInfo();
            start.FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe");
            start.Arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -File \"" + script + "\"";
            start.WorkingDirectory = @"G:\VibeProj\spellcast";
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;
            using (var process = Process.Start(start))
            {
                var stdout = process.StandardOutput.ReadToEndAsync();
                var stderr = process.StandardError.ReadToEndAsync();
                process.WaitForExit();
                File.WriteAllText(Path.Combine(output, prefix + ".stdout.txt"), stdout.Result);
                File.WriteAllText(Path.Combine(output, prefix + ".stderr.txt"), stderr.Result);
                File.WriteAllText(Path.Combine(output, prefix + ".exit.txt"), process.ExitCode.ToString());
                return process.ExitCode;
            }
        }
        catch (Exception error)
        {
            File.WriteAllText(Path.Combine(output, prefix + "-launch-error.txt"), error.ToString());
            return 1;
        }
    }
}
