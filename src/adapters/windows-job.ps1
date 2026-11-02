# Runs one command inside a Windows job object of its own (C-07, November 2026; the director chose this PowerShell
# wrapper over a compiled helper). Node puts its children in a job that lets their children break away silently, so a
# process an agent or a test starts detached outlived its parent, the controller's tree kill and the controller's own
# end. This wrapper stays an ordinary child of the controller, so it ends with it. It starts the command suspended and
# outside Node's job, puts it in a job that ends every process in it when its last handle closes and allows no
# breakaway, then lets it run with the wrapper's own standard handles, environment and working folder.
#
# When the command's main process ends, what it left running is ended and counted, so a finished attempt has nothing
# still running (the director's rule 2), unless STUDIO_JOB_KEEP is set (Try's Run, which keeps its app running until
# Stop). Ending the wrapper, or the controller, ends the whole tree either way.
#
# Input, from the environment (taken out of it before the command starts, so the command never sees them):
#   STUDIO_JOB_COMMAND_LINE  the command line, quoted as Windows reads it (src/adapters/process-job.mjs)
#   STUDIO_JOB_REPORT        where to write {"exitCode": n, "leftovers": n}, or empty
#   STUDIO_JOB_KEEP          "1" to keep what the main process left running until the job empties
# The wrapper writes nothing to standard output; the command's output passes through untouched. It exits with the
# command's exit code, or 9901 when it could not start it (the reason on standard error).
$ErrorActionPreference = 'Stop'
$commandLine = $env:STUDIO_JOB_COMMAND_LINE
$report = $env:STUDIO_JOB_REPORT
$keep = $env:STUDIO_JOB_KEEP -eq '1'
Remove-Item Env:STUDIO_JOB_COMMAND_LINE, Env:STUDIO_JOB_REPORT, Env:STUDIO_JOB_KEEP -ErrorAction SilentlyContinue
if (-not $commandLine) { [Console]::Error.WriteLine('windows-job: no command line given.'); exit 9901 }
try {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class StudioJob {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInformation { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
    public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
  }
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcess(
    string app, System.Text.StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd,
    ref StartupInfo si, out ProcessInformation pi);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr a, string n);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr j, int c, ref ExtendedLimits i, uint l);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr j, int c, out Accounting i, uint l, IntPtr r);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr j, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr p, uint code);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr t);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr p, out uint code);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
  public static int Leftovers;
  static uint Active(IntPtr job) {
    Accounting info;
    return QueryInformationJobObject(job, 1, out info, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero) ? info.ActiveProcesses : 0;
  }
  public static int Run(string commandLine, bool keep) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    ExtendedLimits limits = new ExtendedLimits();
    limits.Basic.LimitFlags = 0x2000; // KILL_ON_JOB_CLOSE; no breakaway allowed
    if (job == IntPtr.Zero || !SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)))
      throw new Exception("the job could not be made (" + Marshal.GetLastWin32Error() + ")");
    StartupInfo si = new StartupInfo();
    si.cb = Marshal.SizeOf(si);
    si.dwFlags = 0x100; // STARTF_USESTDHANDLES
    si.hStdInput = GetStdHandle(-10); si.hStdOutput = GetStdHandle(-11); si.hStdError = GetStdHandle(-12);
    ProcessInformation pi;
    // CREATE_SUSPENDED | CREATE_BREAKAWAY_FROM_JOB (from Node's job, which allows it) | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT
    uint flags = 0x4 | 0x01000000 | 0x08000000 | 0x400;
    if (!CreateProcess(null, new System.Text.StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true, flags, IntPtr.Zero, null, ref si, out pi))
      throw new Exception("the command could not be started (" + Marshal.GetLastWin32Error() + ")");
    if (!AssignProcessToJobObject(job, pi.hProcess)) {
      int error = Marshal.GetLastWin32Error();
      TerminateProcess(pi.hProcess, 9901);
      throw new Exception("the command could not be put in its job (" + error + ")");
    }
    ResumeThread(pi.hThread);
    WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
    uint code; GetExitCodeProcess(pi.hProcess, out code);
    uint left = Active(job);
    if (keep) { while (Active(job) > 0) Thread.Sleep(500); }
    else if (left > 0) {
      Leftovers = (int)left;
      TerminateJobObject(job, 1);
      // Ending is asynchronous; the wrapper exits once nothing of the job runs, within ten seconds.
      for (int i = 0; i < 200 && Active(job) > 0; i++) Thread.Sleep(50);
    }
    return (int)code;
  }
}
"@
  $code = [StudioJob]::Run($commandLine, $keep)
} catch {
  [Console]::Error.WriteLine("windows-job: $($_.Exception.Message)")
  exit 9901
}
if ($report) {
  try { [System.IO.File]::WriteAllText($report, "{""exitCode"":$code,""leftovers"":$([StudioJob]::Leftovers)}") } catch {}
}
exit $code
