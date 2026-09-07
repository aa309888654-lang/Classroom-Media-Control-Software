# 查询占用指定文件的进程（Windows Restart Manager API）
param([Parameter(Mandatory=$true)][string]$Path)
$source = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class FileLockFinder {
    [StructLayout(LayoutKind.Sequential)] struct RM_UNIQUE_PROCESS { public int dwProcessId; public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime; }
    const int RmRebootReasonNone = 0; const int CCH_RM_MAX_APP_NAME = 255; const int CCH_RM_MAX_SVC_NAME = 63;
    enum RM_APP_TYPE { RmUnknownApp = 0, RmMainWindow = 1, RmOtherWindow = 2, RmService = 3, RmExplorer = 4, RmConsole = 5, RmCritical = 1000 }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct RM_PROCESS_INFO {
        public RM_UNIQUE_PROCESS Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = CCH_RM_MAX_APP_NAME + 1)] public string strAppName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = CCH_RM_MAX_SVC_NAME + 1)] public string strServiceShortName;
        public RM_APP_TYPE ApplicationType; public uint AppStatus; public uint TSSessionId; [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
    }
    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmRegisterResources(uint pSessionHandle, uint nFiles, string[] rgsFilenames, uint nApplications, [In] RM_UNIQUE_PROCESS[] rgApplications, uint nServices, string[] rgsServiceNames);
    [DllImport("rstrtmgr.dll", CharSet = CharSet.Auto)] static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, string strSessionKey);
    [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint pSessionHandle);
    [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint dwSessionHandle, out uint pnProcInfoNeeded, ref uint pnProcInfo, [In, Out] RM_PROCESS_INFO[] rgAffectedApps, ref uint lpdwRebootReasons);

    public static List<string> FindLockers(string path) {
        uint handle; var key = Guid.NewGuid().ToString(); var result = new List<string>();
        if (RmStartSession(out handle, 0, key) != 0) throw new Exception("RmStartSession failed");
        try {
            if (RmRegisterResources(handle, 1, new[] { path }, 0, null, 0, null) != 0) throw new Exception("RmRegisterResources failed");
            uint needed = 0, count = 0, reasons = 0;
            int res = RmGetList(handle, out needed, ref count, null, ref reasons);
            if (res == 234) {
                var info = new RM_PROCESS_INFO[needed];
                count = needed;
                if (RmGetList(handle, out needed, ref count, info, ref reasons) == 0) {
                    for (int i = 0; i < count; i++) result.Add(info[i].Process.dwProcessId + " - " + info[i].strAppName);
                }
            }
        } finally { RmEndSession(handle); }
        return result;
    }
}
'@
Add-Type -TypeDefinition $source
[FileLockFinder]::FindLockers($Path) | ForEach-Object { Write-Host $_ }
