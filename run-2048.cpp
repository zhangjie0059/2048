// 2048 自动玩启动器：双击本 exe 即用 C++ 强 AI（210 万预算）驱动模拟器里的 2048。
// 用法：2048自动玩.exe          -> 操作模拟器实例 0
//       2048自动玩.exe 1        -> 操作模拟器实例 1（可同时开多个实例并行跑）
// 原理：找到 node.exe，运行同目录下的 emulator-autoplay.js --cpp --budget 2097152。
#include <windows.h>
#include <stdio.h>
#include <wchar.h>

int wmain(int argc, wchar_t** argv) {
    int index = 0;
    if (argc > 1) index = _wtoi(argv[1]);
    wchar_t idx[16];
    swprintf(idx, 16, L"%d", index);
    SetEnvironmentVariableW(L"LD_INDEX", idx);
    wchar_t title[64];
    swprintf(title, 64, L"2048自动玩 - 实例%d", index);
    SetConsoleTitleW(title);

    wchar_t dir[MAX_PATH];
    if (!GetModuleFileNameW(NULL, dir, MAX_PATH)) return 1;
    wchar_t* slash = wcsrchr(dir, L'\\');
    if (slash) *slash = L'\0';

    const wchar_t* nodes[] = {
        L"C:\\Users\\zhangjie\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\node\\bin\\node.exe",
        L"node.exe",
    };
    wchar_t script[MAX_PATH];
    swprintf(script, MAX_PATH, L"%s\\emulator-autoplay.js", dir);

    for (int i = 0; i < 2; i++) {
        const wchar_t* node = nodes[i];
        if (GetFileAttributesW(node) == INVALID_FILE_ATTRIBUTES) continue;
        wchar_t cmd[2048];
        swprintf(cmd, 2048, L"\"%s\" \"%s\" --cpp --budget 2097152", node, script);
        STARTUPINFOW si;
        ZeroMemory(&si, sizeof(si));
        si.cb = sizeof(si);
        PROCESS_INFORMATION pi;
        if (CreateProcessW(NULL, cmd, NULL, NULL, FALSE, 0, NULL, dir, &si, &pi)) {
            CloseHandle(pi.hThread);
            WaitForSingleObject(pi.hProcess, INFINITE);
            CloseHandle(pi.hProcess);
            return 0;
        }
    }
    wprintf(L"未找到 node.exe（需要安装 Node.js 或使用项目内置运行时）。\n");
    return 1;
}
