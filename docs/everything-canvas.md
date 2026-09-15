# Everything Canvas：制作和继续修改开放作品

Canvas 可以在现有版本化回复中承载完整的 Web 作品。原来的文字、对照、X6 关系图和分镜仍可使用；新的 `artifact` 块承接 HTML/CSS/JavaScript、SVG、Canvas、图片、音视频及可随作品打包的库。

## 最小制作流程

1. 在当前 Agent 的宿主中制作一个可分发目录，以 UTF-8 HTML 为入口。保留编译前源码、构建文件和实际素材。
2. 用本地预览检查内容、交互、错误和文件路径。库、字体与数据要随作品保存，不能依赖临时 CDN 链接。
3. 读取 `spellcast_board`，用 `spellcast_artifact` 提交目录、入口、`source_id`、稳定的 `reply_id` / `block_id`、标题与简介。更新时提供最新 `expected_revision`。
4. 在正式窗口查看作品。参数与选择保存在独立的状态版本中；显式提问才进入原任务反馈链路。

本仓库的便捷构建命令是：

```powershell
node scripts/build-artifact.mjs examples/artifacts/math artifacts/my-work-v1
```

源目录内的 `main.js` 或 `main.ts` 会打包为 `app.js`，CSS 为 `app.css`。在 HTML 中引用它们。输出目录必须是新目录，工具不会删除已有版本。输出包含原始源码、构建器、包锁文件与实际使用依赖的版本和许可证。也可以使用宿主里其他适合项目的构建方式，再提交完整产物目录。

```json
{
  "source_id": "codex:actual-task-uuid",
  "reply_id": "water-experiment",
  "block_id": "work",
  "title": "一个可以操作的实验",
  "directory": "G:/project/artifacts/my-work-v1",
  "entry": "index.html"
}
```

这里的来源应是当前任务的实际身份；示例值不能直接用来绑定其他任务。

## 参数与对象选择

容器会在作品脚本前提供 `window.spellcast`，不需要作品自行引用运行接口脚本。

```js
const saved = await window.spellcast.ready;
const slider = document.querySelector("#speed");
slider.value = saved.speed ?? 1;
slider.oninput = () => window.spellcast.setState({ speed: Number(slider.value) });
window.spellcast.onRestore(state => { slider.value = state.speed ?? 1; });

window.spellcast.select({
  ids: ["rotor"],
  asset: "assets/model.glb",
  label: "风杯组件"
});
```

状态是最多 64 KB 的 JSON 对象。它适合参数、输入、排序、视角与选区；大型数据和素材放在资源文件中。`setState` 合并顶层字段；恢复处理器应更新控件，不再调用保存，以免产生状态回响。

选区内容由作品按需求表达，例如数据行 ID、图节点、mesh 名称，或 `{asset, region, coordinate_space}` / `{asset, time_range}`。说明坐标和时间单位。选区并不意味着栅格图片已经有矢量图层，也不意味着任何第三方编辑器都自动具备共同编辑语义。

在作品块上点击“提问”，发送时会保留对应的作品版本和选择状态。原任务读取 `artifact_context`，核对那个版本后更新原块。已有反馈的排队、读取、回复和确认回执继续适用。

## 查看、修改与导出

- 直接拖动卡片主体调整位置；双击卡片、点击“打开”，或用顶部“打开内容”进入正常大小的阅读器，再编辑、选择和操作作品。
- 选中卡片后按 Delete 或 Backspace 删除；想法卡和回复卡均支持。输入框、编辑区或弹窗内不会触发。卡片在删除成功保存后才消失，未发送的内容仍可在“草稿”中找回。
- W/A/S/D 分别向上、左、下、右移动视角，支持长按；输入框、打开的作品和组合快捷键保留原行为。也可以按住空格或鼠标中键拖动画布，或开启“手形工具”。普通滚轮围绕鼠标位置缩放，比例按钮显示当前倍率。
- “卡片总览”以固定字号列出内容，可打开或定位；“整理布局”把现有卡片排成网格，一次撤销可恢复原位置。新卡片分列放置，重启保留缩放和视角。
- “停止”移除运行中的 frame；“重新运行”重新载入已保存的作品与参数。作品自己的动画应提供暂停，并在 `pagehide` 释放渲染器、监听、媒体和 Worker。
- “源码与版本”提供资源查看、文本源码草稿、保存和历史版本恢复。HTML/CSS/JavaScript/JSON/SVG 可直接改版；编译前 TypeScript 等仍需在宿主重建。
- 内容更新与参数更新各有版本检查。发生冲突时保留输入，可查看最新参数并显式保存合并结果。
- “导出作品”保存 ZIP，包括文件、源码、依赖记录和当前状态。解压后用本地静态服务器打开入口，浏览器的模块、字体和模型加载规则仍然适用。报告类作品也可以携带宿主生成的 PDF。

作品内的下载应把本地资源读取为 Blob，再创建带 `download` 的链接；隔离文档的 opaque origin 会使普通跨源下载链接失效。报告样本包含这一最小实现。

`spellcast_artifact_read` 可查看 manifest、历史版本与具体文本源文件。二进制及较大文件通过本地资源或导出获取，避免把图像和视频以长字符串塞进模型上下文。

## 运行与保存边界

源码和素材写入独立的不可变 SQLite 资源记录，画布快照只引用 bundle。当前导入上限为 2,048 个文件、单文件 128 MiB、合计 256 MiB；路径必须留在明确提交的目录内，链接和隐藏路径不进入发布包。`__spellcast.js` 是容器保留文件。

运行使用浏览器 sandbox、按作品资源路径限制的 CSP 和独立 MessageChannel。普通作品不访问宿主 DOM、存储与控制接口；数据获取、计算、构建和生成留在原宿主。使用本机 GPU、WebView 和媒体解码能力时，应在目标平台验证，不能把 Windows 的结果当作所有系统的验收。

库的开放性不等于已替每一个库完成适配。首批样本使用 ECharts、Tabulator、KaTeX、Mermaid、Three.js、Markdown 和浏览器原生媒体；进一步的科学绘图、地图、二维引擎和计算方案见[选型报告](reviews/2026-09-07-everything-canvas-options.md)。

## 代表性作品

| 源目录 | 表达与可操作对象 |
| --- | --- |
| `examples/artifacts/search` | SVG + Mermaid；搜索步骤和网格单元 |
| `examples/artifacts/data` | ECharts + Tabulator；联动筛选、排序与数据行 |
| `examples/artifacts/math` | KaTeX + SVG；公式、摆长、角度与时间 |
| `examples/artifacts/assembly` | Three.js + GLB；部件、展开程度与视角 |
| `examples/artifacts/image` | 实际生成图与编辑版；比较和归一化选区 |
| `examples/artifacts/media` | 实际生成音视频；播放、范围和循环 |
| `examples/artifacts/tool` | 自定义 HTML/SVG 工具；参数、备注与导出 |
| `examples/artifacts/report` | Markdown、公式和图片；章节定位与 PDF |

这些作品的源数据与简化假设写在各自页面中。实际验收结果见[实现与验收记录](reviews/2026-09-07-everything-canvas-implementation.md)。
