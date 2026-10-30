<div align="center">
  <img src="assets/dsh-whale-bongo-icon.png" width="260" alt="dsh-whale-bongo 图标">
  <h1>dsh-whale-bongo</h1>
  <p><strong>QQ 弹弹的类 bongo 手手挂件</strong></p>
  <p><code>dsh-bongo-fish</code> 的重置版本 · Q 弹手感的 DSH 打字挂件</p>
  <p><code>DSH</code> <code>Web Bundle</code> <code>No Build</code> <code>MIT Code</code></p>
</div>

> 是 `dsh-bongo-fish` 的独立重置版本；参考其注入方式与交互思路。  
> 不是官方分支，也不代表原作者发布。

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
      <td>双手按键反馈、图片 Q 弹、手部几何/颜色/轮廓、折叠菜单</td>
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
- **按压手感**：原版正常手瞬切下沉、萌圆手下压回弹；本版手手按压后回弹。
- **本版图片 Q 弹**：图片以底边为锚点做 Q 弹。
- **原版敲击抖动**：原版敲击时有抖动反馈。

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

## 这是什么

`dsh-whale-bongo` 是一个 **QQ 弹弹的类 bongo 手手挂件**，是 [`dsh-bongo-fish`](https://github.com/YUsaltyfish/dsh-bongo-fish) 的重置版本。

原版 [`dsh-bongo-fish`](https://github.com/YUsaltyfish/dsh-bongo-fish) 是一个 bongo cat 风格的 DSH 打字挂件，强调跟随敲击节奏互动的原味手感。本版参考它的注入方式与交互思路，重新实现了双手动作、图片回弹和设置系统，采用偏 Q 弹、手部按压表现明显的方向，并提供图片、手部、颜色、音效等设置。两款挂件侧重不同，按喜好选择即可。

它浮在 DSH 输入框旁：

- 默认磁吸在输入框右上方；
- 每敲一下键盘，手手随之按下；
- 支持自定义图片、手手颜色、音效和挂件大小；
- 透明区域点击/拖动直接穿透到 DSH。

本仓库不是原项目的官方分支，也不代表原作者发布。

一句话：**原版偏原味节奏，本版偏 Q 弹与手部表现；按习惯选择，也可以两个都装。**

---

## 亮点

| | |
|:--|:--|
| **双手按键反馈** | 两只手随敲键按下。 |
| **同键同手** | 同一按键保持同一只手，不同按键交替左右手。 |
| **图片 Q 弹** | 以图片底边为锚点压扁回弹，强度 0–500；回弹时不裁左右，投影完整。 |
| **透明穿透** | 按图片 alpha 生成 SVG `clip-path`，只有角色本体接收鼠标，透明区域直接穿透。 |
| **自由磁吸** | 吸附输入框卡片边缘或客户端底边，靠近底部时优先贴底。 |
| **完全可调** | 图片、图片缩放/位移、手部几何、颜色、轮廓粗细、音量、大小都能单独调。 |
| **折叠 + 直显** | 图片、手部、音效默认收起；动效和大小直接显示为滑块。 |
| **菜单可拖动** | 拖标题栏可临时移动；再次唤出回到挂件旁的固定位置；展开/收起不重新定位。 |
| **无构建依赖** | 纯 DSH bundle，不需要 `npm install`，不需要前端 build。 |

---

## 安装

### 从插件管理器安装

在 DSH 桌面端「插件 → 添加插件」中输入：

```text
dsh-whale-bongo
```

安装或更新后 **完全退出并重开 DSH**。  
Web / CLI 环境也可以：

```bash
dsh plugin --profile web add dsh-whale-bongo@0.1.0
```

### 本地开发安装

1. 打开 DSH → **设置 / 插件**；
2. 选择 **添加插件 / 安装本地 bundle**；
3. 指向本仓库目录，或输入：

   ```text
   link:<本仓库绝对路径>
   ```

4. 安装完成后 **完全退出并重启一次 DSH**；
5. 打开任意对话页，挂件会出现在输入框右上方。

> [!TIP]
> 给其他 AI / 其他 DSH 的安装教程见 [`INSTALL-FOR-AI.md`](INSTALL-FOR-AI.md)，包含 `plugin_manager`、命令行兜底和 health 验证。

---

## 设置

| 分组 | 内容 |
|:--|:--|
| 主体图片 | 更换图片、恢复默认、图片大小、水平位置、垂直位置 |
| 手部 | 内部色、轮廓色、轮廓粗细、宽度、高宽比、间距、对称轴、垂直位置 |
| 音效 | 按键音量 |
| 动效 | 图片回弹强度 |
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
图片 Q 弹     250
音量          60
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
Web / CLI 环境：

```bash
dsh plugin --profile web remove dsh-whale-bongo
```

卸载后挂件会停止加载。设置与自定义图片保存在当前浏览器的 localStorage 中；如需彻底清理，可在浏览器站点数据中删除本插件的存储。

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
<summary><strong>菜单按钮不见了</strong></summary>

菜单按钮默认隐藏，只在鼠标悬浮到**图片**或按钮本身时显示；离开后延迟约 420ms 隐藏。

</details>

<details>
<summary><strong>没有声音</strong></summary>

检查菜单「音效 → 音量」是否大于 0；系统音量/浏览器自动播放策略也可能影响首次播放。

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
  assets/dsh-whale-bongo-icon.png  # README 顶部图标
  assets/portrait.png   # 图片素材（版权归原作者）
  assets/sounds/        # hit.wav（版权归原作者）+ CC0 许可
  locale/               # 中英文标题
  icon.png              # 插件列表图标
  LICENSE
  CHANGELOG-0.1.0.md
  .gitignore
  README.md
  INSTALL-FOR-AI.md     # 给其他 AI 的安装教程
```

</details>

---

## 来源与版权

> [!IMPORTANT]
> **图片素材与音效素材版权归原作者所有，不跟随本仓库代码的 MIT 许可。**

- 原版 [`dsh-bongo-fish`](https://github.com/YUsaltyfish/dsh-bongo-fish)（作者 [YUsaltyfish](https://github.com/YUsaltyfish)）是一个 bongo cat 风格的 DSH 打字挂件；原项目名称、原始代码、原始素材和原有品牌归原作者所有。
- 本仓库是 [`dsh-bongo-fish`](https://github.com/YUsaltyfish/dsh-bongo-fish) 的重置版本，参考其注入方式和交互思路，**独立重写**；两个仓库分开维护。
- 经双方友好协商，双方互为对方仓库的协作者。
- **本仓库的代码与重写逻辑**版权归本仓库作者，按 MIT 许可。
- **图片素材 `assets/portrait.png`** 与 **音效素材 `assets/sounds/hit.wav`** 版权归 **[YUsaltyfish](https://github.com/YUsaltyfish)**；本仓库按双方约定使用，不随代码 MIT 许可重新授权。
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
