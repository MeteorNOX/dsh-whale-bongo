# dsh-whale-bongo · 给 AI 的安装教程

这是一个 **DSH 本地 UI bundle**，不是普通网页，也不是需要 `npm install/build` 的前端项目。  
请安装**整个 `dsh-whale-bongo` 目录**（或 `.tgz` 包），然后把当前 DSH profile 重启一次。

- 插件名：`dsh-whale-bongo`
- 当前版本：`0.1.0`
- 形态：输入框旁的打字挂件，没有侧边栏页面
- 默认：逻辑 3、`本体.png`、手部 14/81/35/41/77.5、音量 60
- 不依赖 npm 包、不需要构建、不需要 iframe

---

## 1. 准备

1. 解压 `dsh-whale-bongo-0.1.0.zip`，得到：

   ```text
   dsh-whale-bongo/
     package.json
     cordis.patch.yml
     index.js
     client.js
     assets/
     locale/
     icon.png
     README.md
   ```

2. 把目录放到一个稳定路径，例如：

   ```text
   Windows: <插件目录>\dsh-whale-bongo
   macOS/Linux: <插件目录>/dsh-whale-bongo
   ```

3. 不要只复制 `client.js`，也不要手动改 `assets/widget.js`；整个目录才是 bundle。

---

## 2. 推荐：用 DSH 插件管理器 / `plugin_manager`

### 有 `plugin_manager` 工具时

调用“安装本地 bundle”的操作，参数按当前工具实际 schema：

```text
source  = link:<插件绝对路径>       # 或直接填 <插件绝对路径>
profile = <当前使用的 profile>      # 桌面端通常是 desktop
```

示例：

```text
source  = link:<插件绝对路径>
profile = desktop
```

如果工具支持 tarball，也可以直接安装：

```text
dsh-whale-bongo-0.1.0.tgz
```

### 没有工具、用桌面 UI 时

1. 打开 DSH → **设置 / 插件**。
2. 选择 **添加插件 / 安装本地 bundle**。
3. 指向解压后的 `dsh-whale-bongo` 目录，或 `.tgz`。
4. profile 选当前正在使用的 profile（通常是 `desktop`）。
5. 安装完成后 **完全退出并重启一次 DSH**。

> 必须重启一次，而不是只刷新页面：宿主半的注入行只在 DSH 启动时收集。  
> 安装后不需要在插件里再点“启用”。

---

## 3. 兜底：命令行 / 手工安装

仅在插件管理器不可用时使用。**优先用上面的方式。**

### 3.1 进入 profile

```text
${DSH_HOME:-~/.dsh}/profiles/<profile>
```

桌面端一般是：

```text
<用户目录>\.dsh\profiles\desktop
```

先备份：

```text
package.json
pnpm-lock.yaml
cordis.patch.yml
```

### 3.2 链接包

在 profile 目录执行（pnpm 路径按本机实际环境）：

```bash
pnpm add "link:<插件绝对路径>" --dir "<profile目录>"
```

或者：

```bash
dsh plugin --profile <profile> add "link:<插件绝对路径>"
```

> 注意：打包版桌面客户端的 `dsh` CLI 可能拒绝 `desktop` profile，
> 提示 “managed exclusively by the Electron application”。  
> 遇到这种情况请改用 DSH UI 的插件管理器。

### 3.3 加入 profile 的 bundles 列表

编辑 profile 的 `package.json`：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "...",
        "dsh-whale-bongo"
      ]
    }
  },
  "dependencies": {
    "dsh-whale-bongo": "link:D:/dsh-plugins/dsh-whale-bongo"
  }
}
```

不需要手工改 profile 的 `cordis.patch.yml`。  
插件的 `cordis.patch.yml` 会插入自己的 Host 行。

### 3.4 重启并验证

完全退出 DSH，再打开一次。

查看 health：

```bash
curl http://127.0.0.1:<DSH端口>/dsh-whale-bongo/health
```

预期类似：

```json
{
  "ok": true,
  "version": "0.1.0",
  "widget": "/dsh-whale-bongo/widget.js",
  "portrait": "/dsh-whale-bongo/portrait.png"
}
```

如果 404：
- Host 行没有加载，通常是没重启，或 bundle 没加进 `dsh.profile.bundles`。
- 检查 profile 的 `package.json` 和 `node_modules/dsh-whale-bongo`。

---

## 4. 安装后的表现

- 打开任意**对话页**，挂件出现在输入框上方（默认贴图片底边）。
- **没有侧边栏入口**，不要找“插件页面”。
- 鼠标悬浮到图片上，图片右上角出现 `☰` 按钮。
- 点 `☰` 打开设置；菜单可拖动，位置会持久化。
- 设置项：主体图片、手部、颜色、动效、音效、大小。
- 默认配置：`logic3 / 本体.png / 100,0,0 / 14 / 81 / 35 / 41 / 77.5`。

如果 health 正常但挂件不出现：
1. 确认当前是**对话页**（不是设置页、插件页）。
2. `Ctrl+F5` 硬刷新。
3. 仍不行就再完全重启一次 DSH。
4. 浏览器控制台或 localStorage 里可看：
   - `dsh-whale-bongo:diag:start`
   - `dsh-whale-bongo:diag:mount`
   - `dsh-whale-bongo:diag:place`
   - `dsh-whale-bongo:diag:error`

---

## 5. 卸载

优先用 DSH 插件管理器卸载。

手工卸载时：
1. 从 profile 的 `dsh.profile.bundles` 删除 `dsh-whale-bongo`。
2. 删除依赖或执行 `pnpm remove dsh-whale-bongo`。
3. 重启 DSH。
4. 可选：清除 `dsh-whale-bongo:*` 的 localStorage。

---

## 6. 给其他 AI 的最短指令

如果只想复制一段提示词给另一个 AI：

```text
请把 dsh-whale-bongo 安装到当前 DSH profile。
它是一个本地 UI bundle，不需要构建、没有 npm 依赖。
优先调用你的 plugin_manager 安装本地 bundle：
source = link:<解压后的 dsh-whale-bongo 绝对路径>
profile = 当前 profile（桌面端通常是 desktop）
如果没有 plugin_manager：
- 备份 profile 的 package.json / pnpm-lock.yaml
- pnpm add "link:<绝对路径>" --dir "<profile目录>"
- 在 profile package.json 的 dsh.profile.bundles 追加 "dsh-whale-bongo"
- 完全重启 DSH
安装后确认：
curl http://127.0.0.1:<端口>/dsh-whale-bongo/health
应返回 ok:true / version:0.1.0。
不要修改插件源码，不要手工改 profile 的 cordis.patch.yml。
```
