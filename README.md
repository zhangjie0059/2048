# 2048

一个纯 HTML/CSS/JavaScript 实现的 2048 小游戏，无任何外部依赖，打开即玩。

支持倍数模式（4/8/16 倍）与外部 C++ 强 AI 自动玩（见下文）。

## 运行方式

**推荐方式（无需安装任何环境）：**

- 双击 `start.bat`，或用浏览器直接打开 `index.html`。

游戏是纯静态页面，直接以文件方式打开即可游玩；分数与最高分会保存在浏览器本地存储中。

如果之后希望以本地服务器方式访问（可选，需要电脑上已安装 Python）：

```bash
python -m http.server 8000
```

然后访问 `http://localhost:8000`。

## 玩法

- 方向键 / WASD / 触摸滑动控制方块移动
- 相同数字碰撞后合并为它们的和
- 合成 2048 即获胜，之后可以继续挑战更高分数
- 分数与最高分实时显示，最高分保存在浏览器本地存储中

## 倍数模式

- 支持 1 倍 / 4 倍 / 8 倍 / 16 倍，切换后立即开始新一局
- 倍数越高，开局与每次刷新的方块越大（4 倍恒为 4，16 倍恒为 16），胜利目标同步缩放（4 倍目标 8192，16 倍目标 32768）
- 方块颜色阶梯按倍数等比映射，最高分按倍数分别保存
- 选择会保存在浏览器本地，下次打开自动恢复

## 自动化测试

需要 Node.js（项目目录中已包含测试脚本，也可以使用任意 Node 环境）：

```bash
node tests/logic.test.js   # 游戏核心逻辑测试
node tests/ai.test.js      # AI 一致性模糊测试 + 整局强度基准
```

AI 强度基准（固定种子，可复现）：6 局全部达到 2048，4 局达到 4096，最好成绩 8192。

## C++ 强 AI（冲 16384 / 32768）

JS AI 受限于单步搜索速度，冲到 8192 已是上限附近；32768 级别的 AI 需要每秒搜索数百万
节点，这正是 C++ 的优势。项目附带 `2048ai.cpp`（位棋盘 + expectimax，启发式参考
MIT 开源的 nneonneo/2048-ai），编译为 `2048ai.exe` 后可直接用于雷电模拟器自动游玩。

### 安装编译器（任选其一）

**方式 A（推荐，体积小）：MinGW-w64 via MSYS2**

1. 从 <https://www.msys2.org/> 下载并安装 MSYS2；
2. 打开 "MSYS2 UCRT64" 终端，执行：

```bash
pacman -S --needed mingw-w64-ucrt-x86_64-gcc
```

**方式 B：给现有 Visual Studio 2019 补装 Windows 10 SDK**

打开 "Visual Studio Installer" -> 修改 -> 单个组件 -> 勾选 "Windows 10 SDK" -> 安装。

### 编译

```bash
build.bat
```

### 基准测试（自玩 N 局，统计达到 8192/16384/32768 的比例）

```bash
2048ai.exe bench --games 200 --seed 12345
2048ai.exe bench --games 100 --budget 2000000   # 更大节点预算 = 更深搜索
```

### 雷电模拟器自动游玩时使用 C++ 引擎

```bash
node emulator-autoplay.js --cpp                # 使用 C++ AI（默认预算 400000 节点/步）
node emulator-autoplay.js --cpp --budget 2000000
```

`2048ai.exe` 不存在时脚本会自动回退到 JS AI。

## 统一入口：App 版 + 网页版双模自动玩

同一套 C++ 强 AI 引擎（`2048ai.exe`，共享封装见 `engine.js`）可以驱动两种载体：

```bash
node autoplay.js --target web --url <网页2048地址>        # 网页版
node autoplay.js --target app                             # 雷电模拟器 App 版
```

### 网页版（web-autoplay.js）

使用 Playwright 驱动系统 Chrome/Edge，读取 DOM 棋盘（兼容 Cirulli 系
`.tile-position-x-y` 与 transform 定位系；若页面提供 `window.__game2048.getGrid()`
则直接读取精确棋盘），把 16 个数喂给 C++ 引擎，再用方向键走子。

```bash
node web-autoplay.js --url http://localhost:8000/ --budget 2097152
node web-autoplay.js --url https://play2048.co/ --budget 2097152 --headed --autorestart
```

常用参数：

- `--budget N`：C++ 单步搜索预算，越大越强越慢（冲 32768 建议 2097152）
- `--target-tile N`：达到该方块即停止（默认 32768）
- `--moves N` / `--once`：调试用，限制步数或只走一步
- `--headed`：显示浏览器窗口（默认无头）
- `--autorestart` / `--no-autorestart`：游戏结束自动点“新游戏”重开（默认开启）
- `--delay MS`：每步等待动画的毫秒数（默认 160）

### App 版（emulator-autoplay.js）

```bash
node emulator-autoplay.js --cpp --budget 2097152
node emulator-autoplay.js --cpp --budget 2097152 --restart-tap 450,1400
```

- 新增 adb 掉线自动重连（实例端口 = 5555 + index*2）
- `--restart-tap x,y`：游戏结束后点击“新游戏”按钮自动重开（坐标按 900x1600 竖屏）
- 环境变量：`LD_INDEX`（实例索引）、`DELAY`、`LD_ADB`、`RESTART_TAP`

两种模式共用 `engine.js` 中的 `bestMoveCpp(values, budget)`，决策核心完全一致。
