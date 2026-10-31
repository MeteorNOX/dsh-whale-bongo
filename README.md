<div align="center">
  <img src="assets/dsh-whale-bongo-icon.png" width="260" alt="dsh-whale-bongo 图标">
  <h1>dsh-whale-bongo</h1>
  <p><strong>QQ 弹弹的类 bongo 手手挂件</strong></p>
  <p><code>v0.2.1</code> · <code>dsh-bongo-fish</code> 的独立重置版本</p>
  <p><code>DSH</code> <code>Web Bundle</code> <code>No Build</code> <code>MIT Code</code></p>
</div>

> 是 `dsh-bongo-fish` 的独立重置版本；参考其注入方式与交互思路。  
> 不是官方分支，也不代表原作者发布。

> [!WARNING]
> **npm 包暂未发布。** 作者 npm 账号目前仍处于冻结状态，解封时间未定；请先使用 GitHub Release 的 zip/tgz，或直接安装本地目录。

## 目录

- [版本选择](#版本选择)
- [这是什么](#这是什么)
- [亮点](#亮点)
- [安装](#安装)
- [设置](#设置)
- [与 dsh-bongo-fish 共存](#与-dsh-bongo-fish-共存)
- [卸载与数据清理](#卸载与数据清理)
- [常见问题](#常见问题)
- [项目结构](#项目结构)
- [来源与版权](#来源与版权)
- [素材与许可](#素材与许可)
- [致谢](#致谢)

---

## 版本选择

两款挂件面向不同的使用偏好，可以按自己的习惯选择：

<table>
  <thead>
    <tr>
      <th align="left"></th>
      <th align="left">原版 <a href="https://github.com/YUsaltyfish/dsh-bongo-fish"><code>dsh-bongo-fish</code></a></th>
      <th align="left">本版 <code>dsh-whale-bongo</code></th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>适合的需求</td>
      <td>正常手/萌圆手两套配置、图片和音效上传、提醒拍手</td>
      <td>双手按键反馈、图片 Q 弹、打字角度、手部几何/颜色/轮廓</td>
    </tr>
    <tr>
      <td>安装</td>
      <td><a href="https://github.com/YUsaltyfish/dsh-bongo-fish">前往原版仓库</a></td>
      <td><a href="#安装">安装本版</a></td>
    </tr>
    <tr>
      <td>同时安装</td>
      <td colspan="2">可以；两个挂件并存，拖开即可</td>
    </tr>
  </tbody>
</table>

主要区别：

- **手部**：原版有正常手/萌圆手两套配置；本版为双手按键的手手，支持手部几何、颜色和轮廓粗细调节。
- **按压手感**：原版正常手瞬切下沉、萌圆手下压回弹；本版手手按压后回弹，并提供鼠标按压行为选项。
- **原版敲击抖动**：原版敲击键盘时插件有抖动反馈。

---

## 这是什么

`dsh-whale-bongo` 是一个 **QQ 弹弹的类 bongo 手手挂件**，是 [`dsh-bongo-fish`](https://github.com/YUsaltyfish/dsh-bongo-fish) 的重置版本。

原版 [`dsh-bongo-fish`](https://github.com/YUsaltyfish/dsh-bongo-fish) 是一个 bongo cat 风格的 DSH 打字挂件，强调跟随敲击节奏互动的原味手感。本版参考它的注入方式与交互思路，重新实现了双手动作、图片回弹和设置系统，采用偏 Q 弹、手部按压表现明显的方向。

它浮在 DSH 输入框旁：

- 默认磁吸在输入框右上方；
- 每敲一下键盘，手手随之按下；
- 支持自定义图片、手手颜色、音效、挂件大小；
- 支持水平自动翻转；
- 透明区域点击/拖动直接穿透到 DSH。

本仓库不是原项目的官方分支，也不代表原作者发布。

一句话：**原版偏原味节奏，本版偏 Q 弹、手部表现和可调角度；按习惯选择，也可以两个都装。**

---

## 亮点

| | |
|:--|:--|
| **双手按键反馈** | 两只手随敲键按下。 |
| **鼠标点击按压** | 点击角色图片区域，双手按下、图片压扁；按住保持，松开回弹。 |
| **同键同手** | 同一按键保持同一只手，不同按键交替左右手。 |
| **图片 Q 弹** | 以图片底边为锚点压扁回弹，强度 0–10；回弹时不裁左右，投影完整。 |
| **打字角度** | 随机角度和真实键位两套方向系统，真实键位支持左右手分管。 |
| **透明穿透** | 按图片 alpha 生成 SVG `clip-path`，只有角色本体接收鼠标，透明区域直接穿透。 |
| **自由磁吸** | 吸附输入框上/下边线段、上沿中心点，或页面视口边线；中心点会记忆并在布局变化时跟随，拖动时显示吸附圆点。 |
| **水平翻转** | 自动按输入框 45%/55% 迟滞判断、自定义分割线、始终不翻转、始终翻转；带弹性过渡。 |
| **菜单安全区** | 菜单不会进入 DSH 标题栏，关闭按钮始终可点。 |
| **自定义音效** | 支持上传本地音频替换默认敲击音，可恢复默认；音效保存在浏览器本地。 |
| **面板同步吸附** | 提问、授权、计划确认面板出现时，按输入框的吸附方式贴到当前面板上；面板关闭后回到输入框。 |
| **无构建依赖** | 纯 DSH bundle，不需要 `npm install`，不需要前端 build。 |

---

## 安装

### 从 GitHub Release 安装

1. 打开 [GitHub Releases](https://github.com/MeteorNOX/dsh-whale-bongo/releases)；
2. 下载最新 Release 中的 `dsh-whale-bongo-0.2.1-package.zip` 或 `dsh-whale-bongo-0.2.1.tgz`；
3. 在 DSH「插件 → 添加插件 → 安装本地 bundle」中选择解压后的目录，或选择 `.tgz`；
4. **完全退出并重开 DSH**。

### 本地开发安装

1. 打开 DSH → **设置 / 插件**；
2. 选择 **添加插件 / 安装本地 bundle**；
3. 指向本仓库目录，或输入：

   ```text
   link:<本仓库绝对路径>
   ```

4. 安装完成后 **完全退出并重启一次 DSH**；
5. 打开任意对话页，挂件会出现在输入框右上方。

### npm（暂不可用）

npm 账号仍未解封，以下内容仅作发布后参考：

```text
dsh-whale-bongo
```

```bash
# 仅 npm 发布后可用；当前未发布，会 404
dsh plugin --profile web add dsh-whale-bongo@0.2.1
```

> [!TIP]
> 给其他 AI / 其他 DSH 的安装教程见 [`INSTALL-FOR-AI.md`](INSTALL-FOR-AI.md)，包含 `plugin_manager`、命令行兜底和 health 验证。

---

## 设置

| 分组 | 内容 |
|:--|:--|
| 主体图片 | 更换图片、恢复默认、图片大小、水平位置、垂直位置 |
| 手部 | 内部色、轮廓色、轮廓粗细、宽度、高宽比、间距、对称轴、垂直位置 |
| 音效 | 按键音量（0 显示「关」）、更换自定义音效、恢复默认音效 |
| 行为与动效 | Q 弹程度；鼠标按压行为；水平翻转；过滤快捷键与修饰键；打字角度 |
| 大小 | 挂件尺寸 |

默认值：

```text
图片          本体.png
图片缩放      100%
图片位置      0, 0
轮廓粗细      100%
手部宽度      14
高宽比        81
手部间距      35
对称轴        41
垂直位置      77.5
图片 Q 弹     5
鼠标按压      手部变扁，不下压
翻转          自动
分割线        50%
过滤快捷键    开启
打字角度      关闭
角度偏移      30°
音量          15
音效          默认音效
挂件大小      140
```

---

## 与 dsh-bongo-fish 共存

可以同时安装：

- 包名不同：`dsh-bongo-fish` / `dsh-whale-bongo`
- Host 路由独立：本插件使用 `/dsh-whale-bongo`
- DOM id 不同
- localStorage 键不同
- 菜单、图片、手部参数各自独立

同时安装后：

- 两个挂件会同时出现，可能重叠；拖动其中一个错开即可；
- 两边按键音效会同时响，可以调低其中一个的音量，或只保留一个；
- 卸载其中一个不会影响另一个。

---

## 卸载与数据清理

优先在 DSH 插件管理器中移除 `dsh-whale-bongo`。  
Web / CLI 环境在 npm 发布后可执行：

```bash
dsh plugin --profile web remove dsh-whale-bongo
```

卸载后挂件会停止加载。设置与自定义图片保存在当前浏览器 localStorage 中；如需彻底清理，可在浏览器站点数据中删除本插件的存储。

---

## 常见问题

<details>
<summary><strong>安装后看不到挂件</strong></summary>

1. 确认已经**完全重启 DSH**，而不只是刷新页面；
2. `Ctrl + F5` 硬刷新；
3. 确认当前在**对话页**，不是设置页或插件页；
4. 检查 Host 路由：

   ```text
   /dsh-whale-bongo/health
   ```

</details>

<details>
<summary><strong>真实键位模式没有角度</strong></summary>

1. 检查 `/dsh-whale-bongo/key-angles.json` 是否返回 200；
2. 如果 404，说明 Host 还是旧版本，需要完全重启 DSH；
3. 浏览器里只刷新页面不会加载新的 Host 路由。

</details>

<details>
<summary><strong>菜单关闭按钮点不到 / 菜单进入标题栏</strong></summary>

当前版本已给菜单增加 56px 顶部安全区，并把最大高度限制在安全区下方。  
如果 DSH 标题栏比 56px 更高，需要按实际高度调整安全区。

</details>

<details>
<summary><strong>菜单按钮不见了</strong></summary>

菜单按钮默认隐藏，只在鼠标悬浮到**图片**或按钮本身时显示；离开后延迟约 420ms 隐藏。

</details>

<details>
<summary><strong>没有声音</strong></summary>

检查菜单「音效 → 音量」是否大于 0；系统音量/浏览器自动播放策略也可能影响首次播放。

</details>

<details>
<summary><strong>npm 安装失败</strong></summary>

当前 npm 包尚未发布。请使用 GitHub Release 的 zip/tgz，或本地目录安装。

</details>

---

## 项目结构

<details>
<summary>展开查看项目结构</summary>

```text
dsh-whale-bongo/
  package.json          # bundle 元数据、DSH client 配置
  cordis.patch.yml      # Host 注入行
  index.js              # Host 半：路由、静态资源、注入
  client.js             # 客户端模块入口
  assets/widget.js      # 浏览器半
  assets/key-angles.json # 真实键位模式的键位横向坐标表
  assets/dsh-whale-bongo-icon.png  # 图片素材（版权归原作者）
  assets/portrait.png   # 图片素材（版权归原作者）
  assets/sounds/        # 音效素材（版权归原作者）+ CC0 许可
  icon.png              # 插件列表图标（版权归原作者）
  locale/               # 中英文标题
  LICENSE
  CHANGELOG.md
  CONTRIBUTORS.md
  .gitignore
  README.md
  INSTALL-FOR-AI.md     # 给其他 AI 的安装教程
```

</details>

菜单里的下拉使用可复用的 `.dsnw-select` 组件：触发器、浮层选项、选中态、键盘操作和点击外部关闭都在同一套样式/逻辑中，后续新增下拉设置时可以直接复用。

---

## 来源与版权

> [!IMPORTANT]
> **图片素材与音效素材版权归原作者所有，不跟随本仓库代码的 MIT 许可。**

- 原版 [`dsh-bongo-fish`](https://github.com/YUsaltyfish/dsh-bongo-fish)（作者 [YUsaltyfish](https://github.com/YUsaltyfish)）是一个 bongo cat 风格的 DSH 打字挂件；原项目名称、原始代码、原始素材和原有品牌归原作者所有。
- 本仓库是 [`dsh-bongo-fish`](https://github.com/YUsaltyfish/dsh-bongo-fish) 的重置版本，参考其注入方式和交互思路，**独立重写**；两个仓库分开维护。
- 经双方友好协商，双方互为对方仓库的协作者。
- **本仓库的代码与重写逻辑**版权归本仓库作者，按 MIT 许可。
- **当前所有图片与音效素材**（`assets/portrait.png`、`assets/dsh-whale-bongo-icon.png`、`icon.png`、`assets/sounds/hit.wav`）版权归 **[YUsaltyfish](https://github.com/YUsaltyfish)**；本仓库按双方约定使用，不随代码 MIT 许可重新授权。
- 音效的原始素材来源为 Kenney CC0；具体许可见 `assets/sounds/LICENSE-kenney-CC0.txt`。
- 如需二次使用或商用图片/音效，请联系原作者确认；不要仅依据代码的 MIT 许可使用素材。
- 本仓库不是 `dsh-bongo-fish` 的官方分支，也不会把原项目说成自己的原创项目。

> 简单说：**代码归代码，素材归原作者；仓库分开，互相署名，两个都能装。**

---

## 素材与许可

| 内容 | 版权 / 许可 |
|:--|:--|
| 本仓库代码与重写逻辑 | MIT |
| `assets/portrait.png` | 版权归 [YUsaltyfish](https://github.com/YUsaltyfish)；按双方约定使用 |
| `assets/dsh-whale-bongo-icon.png` | 版权归 [YUsaltyfish](https://github.com/YUsaltyfish)；按双方约定使用 |
| `icon.png` | 版权归 [YUsaltyfish](https://github.com/YUsaltyfish)；按双方约定使用 |
| `assets/sounds/hit.wav` | 版权归 [YUsaltyfish](https://github.com/YUsaltyfish)；原始素材为 Kenney CC0 |
| `dsh-bongo-fish` 原项目 | 版权归原作者，遵循原项目许可 |

> 代码的 MIT 许可**不覆盖**图片和音效素材。二次使用或商用素材前，请联系原作者确认。

---

## 致谢

- [YUsaltyfish](https://github.com/YUsaltyfish)：原版 [`dsh-bongo-fish`](https://github.com/YUsaltyfish/dsh-bongo-fish) 的作者，注入方式、交互思路、图片与音效素材
- Kenney：CC0 音效原始素材
- DSH：桌面端与 Web bundle 能力

<div align="center">
  <sub>两款挂件，各有侧重；按需选择，也可同时安装。</sub>
</div>
