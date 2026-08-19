# 2048

一个纯 HTML/CSS/JavaScript 实现的 2048 小游戏，无任何外部依赖，打开即玩。

支持倍数模式（4/8/16 倍）与外部 C++ 强 AI 自动玩（见下文）。

## 运行方式

**推荐方式：** 双击 `网页2048-C++自动.bat`，它会启动本地 C++ AI 服务器并打开网页版游戏。
页面里的「▶ 自动」按钮通过服务器调用 C++ 引擎（2048ai.exe，210 万预算）自动玩，可随时停止/继续。
（直接双击 `index.html` 也可以玩，但按钮会回退到内置 JS AI。）

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
- 顶部实时显示本局步数与用时（新游戏重置，游戏结束时计时冻结）
- 「消除最小」按钮：一键清掉当前棋盘上数值最小的方块（游戏结束后也可用来救活继续玩）

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

同一套 C++ 强 AI 引擎（`2048ai.exe`，共享封装见 `engine.js`）驱动两种载体：

### 网页版

`网页2048-C++自动.bat` 启动本地服务器（`server.js`）并打开游戏；页面里的
「▶ 自动」按钮通过 `/api/move` 调用 C++ 引擎（浏览器不能直接运行 exe，所以用服务器做桥梁）。
服务器预算默认 210 万，可用环境变量 `BUDGET` 调整；端口默认 8123，可用 `PORT` 调整。

```bash
node server.js              # 手动启动服务器
```

服务器未启动时（比如直接双击 `index.html`），按钮自动回退到内置 JS AI（ai.js）。

### 雷电模拟器 App 版（emulator-autoplay.js）

```bash
node emulator-autoplay.js --cpp --budget 2097152
node emulator-autoplay.js --cpp --budget 2097152 --restart-tap 450,1400
```

- 新增 adb 掉线自动重连（实例端口 = 5555 + index*2）
- `--restart-tap x,y`：游戏结束后点击“新游戏”按钮自动重开（坐标按 900x1600 竖屏）
- 环境变量：`LD_INDEX`（实例索引）、`DELAY`、`LD_ADB`、`RESTART_TAP`

两种模式共用 `engine.js` 中的 `bestMoveCpp(values, budget)`，决策核心完全一致。
