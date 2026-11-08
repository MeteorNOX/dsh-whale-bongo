# Beat Lab

独立的节拍检测测试页，不属于插件，不会被打进 npm 包。

```text
node tools/beat-lab-server.mjs
```

打开 `http://127.0.0.1:8899/`。

可以：

- 采集系统声音（Chrome/Edge 的分享窗口里勾选“分享音频”）。
- 采集麦克风。
- 载入本地音频文件，做一次分析。
- 生成 12 秒 120 BPM 的测试点击，校验 BPM 和节拍数。
- 调整分析窗口与自动分析间隔。
- 查看每次 `detect()` 的耗时、BPM、置信度、节拍数和与参考 BPM 的误差。

页面使用 `runtime/electron-helper/vendor/beat-detect.js`，与插件桌面模式是同一份
`@audio/beat` 检测代码；插件在 Worker 中运行，这个页面在主线程运行，因此页面上的
耗时是算法计算量参考，不包含插件 UI 的绘制时间。
