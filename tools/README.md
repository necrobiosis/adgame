# 开发期工具

两个基于 Playwright 的截图脚本，用来在无头浏览器里跑游戏并抓画面。
容器里已预装 Chromium（`/opt/pw-browsers/chromium`），**不要**执行 `playwright install`。

先起开发服务器：

```bash
npx vite --port 5173
```

## screenshots.mjs —— 顺序跑一局并连拍

```bash
node tools/screenshots.mjs 8      # 进第一关，每 2.2 秒拍一张，共 8 张
```

## capture.mjs —— 快进到指定局面再拍

靠 `window.__game.fastForward(秒)`（仅开发构建暴露）跳过等待，直接抓想看的那一帧。
参数是一个 JSON 数组，每项 `[关卡, 停止条件, 截图名]`，停止条件是一段对 `d`
（`window.__game.debug()` 的返回值）求值的表达式：

```bash
node tools/capture.mjs '[[1,"d.nearest<6","l1-contact"],[5,"d.drawn.titan>2","l5-titan"]]'
```

可选的第二个参数是一份存档 JSON，用来指定关卡解锁状态和升级等级：

```bash
node tools/capture.mjs '[[5,"d.drawn.boss>0","boss5"]]' \
  '{"version":1,"gold":99999,"unlockedLevel":5,"upgrades":{"squad":8,"damage":8,"fireRate":6,"cannon":4,"armor":6,"weapon":2},"bestTime":{},"muted":true}'
```

截图落在 `SHOTS` 常量指定的目录里。
