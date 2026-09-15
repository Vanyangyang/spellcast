# Everything Canvas：按表达需求选择能力

研究日期：2026-09-07。本文保留官方资料核对后的工程选型建议。随后经用户同意，开放 Web 作品容器及首批八个样本已实现；范围、原生窗口验收证据与剩余连接边界见[实现记录](2026-09-07-everything-canvas-implementation.md)。候选矩阵里的其他引擎仍是按需选项，不能据此视为全部验收通过。

## 推荐结论

采用“开放 Web 产物 + 按需加载的专用引擎 + 宿主生成与计算工具”。表达范围应覆盖文字、公式、数据、关系、空间、动画、图像、音视频、可运行实验和可交付文档。常用库作为可靠的快捷入口，名单不成为模型输出的白名单；未预置的库可以随具体产物评估、构建和交付。

SVG 是格式，Three.js 是运行引擎，ImageGen 是生成工具，它们属于不同层。把三者分开，才能同时接纳模型直接写出的作品、其他工具生成的素材，以及需要计算才能得到的结果。

用户已经明确：Everything Canvas 要释放 Astra 等模型的表达能力，按需求尽量覆盖广泛且效果好的形式，质量优先。已有四类结构块和反馈回路是可复用基础，四类块不构成产品上限。该目标见[此前产品记录](2026-09-07-canvas-design.md)。

## 用这些需求判断“效果好”

1. **说清楚问题**：复杂关系、数量、时间、空间和感官信息能找到合适表达；文字本身也可以是最好的答案。
2. **可以探索**：支持拖动、筛选、调参数、暂停、逐步播放和比较变化。
3. **可以继续共创**：选择能对应数据行、图节点、曲线、模型部件、图像区域或媒体时间段，回到原任务后能修改原产物。
4. **成品质量**：中文排版、公式、清晰缩放、配色、动效、键盘操作、窄窗口阅读和导出都进入验收。
5. **模型能够可靠制作**：有清楚 API、稳定版本、可调试源码和成熟示例。不能把生成出来但打不开的网页算作支持。
6. **长期可用**：源码、素材、交互状态和版本可保存；窗口恢复和局部更新不丢用户选择。

额度不作为删减表达能力的理由。帧率、显存、启动时间、依赖维护和可分发许可仍然影响用户拿到的产品质量。以下推荐是适配判断，不是未做过的性能排名。

## 候选矩阵

“优先”指值得进入首批正式支持；“按需”指遇到相应需求时提供，不代表禁止模型使用。

| 表达需求 | 推荐与候选 | 能增加的具体效果 | 选择理由与边界 |
| --- | --- | --- | --- |
| 长文、论证、公式 | 优先 HTML/Markdown + KaTeX；数学语义探索需要时用 MathJax | 图文混排、推导、公式、引用与解释并置 | KaTeX 提供 HTML/MathML 输出；MathJax 有公式子表达式探索及语音/盲文能力。按实际公式与无障碍需求选择，不用图片替代可读公式。[KaTeX](https://katex.org/docs/options)、[MathJax](https://docs.mathjax.org/en/latest/basic/accessibility.html) |
| 通用数据图表 | 优先 Apache ECharts；Vega-Lite 是声明式分析候选 | 热图、树图、平行坐标、联动筛选、刷选、时间变化 | ECharts 覆盖常见图表及定制系列；Vega-Lite 用 JSON 表达编码、分面、变换和选择。ECharts 适合默认广覆盖，Vega-Lite 适合按数据语义组合视图。[ECharts](https://echarts.apache.org/en/feature.html)、[Vega-Lite](https://vega.github.io/vega-lite/) |
| 科学与统计图 | 按需 Plotly.js | 等高线、三维曲面、统计分布和科学图形 | 图表语义和坐标系统比用通用 3D 引擎重新绘制更直接；SVG 与 WebGL 输出需分别检查导出质量。[Plotly](https://plotly.com/javascript/) |
| 完全定制的数据叙事 | 按需 D3；快速探索候选 Observable Plot | 随滚动演变的解释、特殊几何编码、自定义关系与交互 | D3 提供低层模块，适合默认图表表达不到的作品；Plot 提供简洁的几何标记、变换与分面。两者可供产物使用，无需同时成为默认图表引擎。[D3](https://d3js.org/what-is-d3)、[Observable Plot](https://observablehq.com/plot/) |
| 可操作的数据表 | 优先原生表格，复杂交互用 Tabulator；TanStack Table 为深度定制候选 | 排序、筛选、分组、编辑、范围选择、下载数据 | Tabulator 自带交互表格与虚拟化能力，适合本项目原生 TypeScript 界面；TanStack 为 headless，需要自行实现外观与 DOM。两者都不能仅凭显示成功宣称完整 Excel 兼容。[Tabulator](https://www.tabulator.info/)、[TanStack](https://tanstack.com/table/v8/docs/overview) |
| 流程、架构、时序 | 优先 Mermaid + 现有 X6 | 快速自动排版的说明图，以及可拖动、可修改关系的图 | Mermaid 适合源文本驱动的说明；现有 X6 承接结构编辑。自动排版图与手工编辑图分别保留来源和坐标。[Mermaid](https://mermaid.js.org/intro/) |
| 网络分析、知识关系 | 按需 Cytoscape.js；超大关系网络另评估 Sigma.js | 邻居、路径、社区、关系子集与图算法探索 | Cytoscape 提供图模型、序列化、布局和图算法；这与流程图编辑是不同需求，不能只靠换布局解决。[Cytoscape](https://js.cytoscape.org/)、[Sigma](https://www.sigmajs.org/) |
| 草图、标注、共同绘制 | 按需 Excalidraw；对象编辑用 Konva；SVG/图像设计编辑候选 Fabric.js | 手绘解释、圈选标注、拖动形状、文字和图片混排 | Excalidraw 提供完整编辑器；Konva 提供对象模型和命中事件；Fabric 擅长对象控制、文字编辑及 SVG 进出。按任务选择，避免同时维护三套手工编辑状态。[Excalidraw](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/integration)、[Konva](https://konvajs.org/docs/)、[Fabric](https://fabricjs.com/) |
| 动态二维示意与生成艺术 | 优先 SVG/Canvas 2D；复杂场景按需 PixiJS | 粒子、轨迹、场、纹理、滤镜、可操作的二维场景 | 小规模图形保留原生可读对象；Pixi 用 GPU 渲染复杂二维内容，支持滤镜和自定义着色器。视觉元素仍需由产物提供可解释的对象 ID。[Pixi 渲染](https://pixijs.com/8.x/guides/components/renderers)、[滤镜](https://pixijs.com/8.x/guides/components/filters) |
| 过程演示与动效 | 优先浏览器动画；复杂编排按需 Motion | 参数变化过渡、分步过程、SVG 路径绘制、播放与暂停 | Motion 可驱动 HTML、SVG 及对象属性；动画应服务解释，并支持暂停和减弱动态效果。Motion 核心与付费扩展分别对待。[Motion](https://motion.dev/docs/quick-start) |
| 三维空间、模型与装配 | 优先已有 Three.js + glTF/GLB；重场景候选 Babylon.js | 旋转、剖面、爆炸视图、部件选择、材质与光照、三维动画 | Three.js 继续作为通用 3D 路线；当项目确实需要完整场景引擎、检查器或更复杂的动画/物理整合时比较 Babylon。库选择不能代替本机 GPU 验证。[Three.js](https://threejs.org/docs/)、[Babylon](https://www.babylonjs.com/specifications/) |
| 数学与物理实验 | 按需 JSXGraph、Rapier，配合原生控件和图形 | 可拖动几何、函数变化、碰撞、约束、摆与机械运动 | JSXGraph 提供动态数学图形；Rapier 提供 2D/3D 物理计算。渲染器显示结果，计算模型负责行为；需要记录参数与假设。[JSXGraph](https://www.jsxgraph.org/home/)、[Rapier](https://rapier.rs/) |
| 地图、路线与地理数据 | 按需 MapLibre GL JS + deck.gl；全球三维数据候选 CesiumJS | 路线、区域比较、热力、轨迹、地形、海量数据层 | MapLibre 承接地图，deck.gl 承接可拾取的数据层；Cesium 适合三维地理数据需求。地图引擎、底图素材和在线服务有各自许可与来源。[MapLibre](https://maplibre.org/projects/gl-js/)、[deck.gl](https://deck.gl/docs)、[Cesium 数据格式](https://cesium.com/learn/data-formats/) |
| 图像与视觉创作 | 优先浏览器图像 + 资产保存；接入宿主的生图/编辑工具 | 大图审阅、变体并排、前后比较、区域标注和局部生成 | Canvas 保留原图、坐标、版本与编辑来源。PNG/JPEG 等栅格图的局部反馈不等于自动获得可编辑矢量图层。ImageGen 是生成入口，不是唯一图片格式。 |
| 音频、音乐与时间段反馈 | 优先原生 audio；按需 WaveSurfer、Tone.js、VexFlow | 波形、时间段选择、循环试听、参数合成、乐谱和声音对应 | WaveSurfer 负责波形与区间；Tone 负责交互音乐；VexFlow 负责乐谱。播放由用户启动，时间段和素材版本需要一起回传。[WaveSurfer](https://wavesurfer.xyz/docs/)、[Tone](https://github.com/tonejs/tone.js/)、[VexFlow](https://vexflow.github.io/vexflow-examples/guides/tutorial/) |
| 视频、分镜与精确动画 | 优先原生 video + 时间标注；宿主按需生成视频或运行 Manim | 动态演示、逐段反馈、分镜比较、精确的数学/技术动画 | Manim 是程序化动画生成器，通常生成视频；现成视频不会自动成为可拖参数的实时模拟。保存生成源码后可交回 Agent 重制指定段落。[Manim](https://docs.manim.community/en/stable/) |
| 可交付文档、阅读与批注 | 优先 PDF.js；宿主按需生成 PDF、Typst 或办公文档 | 分页阅读、页码定位、图文报告、可导出成品 | PDF.js 负责阅读；Typst 可生成 PDF/PNG/SVG/HTML，其中 HTML 仍有实验性边界。Typst SVG 将文字转成字形路径，需要可访问文字时应选 PDF/HTML。[PDF.js](https://mozilla.github.io/pdf.js/getting_started/)、[Typst 导出](https://www.typst.app/docs/web-app/export-and-preview/)、[SVG 边界](https://www.typst.app/docs/reference/svg/) |
| 可运行代码与小工具 | 优先开放 HTML/CSS/JS 产物；源码编辑候选 CodeMirror 6 | 计算器、模拟器、教学实验、定制控制面板、源码与结果对照 | CodeMirror 是编辑器；产物的执行、版本、错误和停止能力由容器承担。React/Svelte 等可以是产物内部的构建选择，不要求把整个 Canvas 改成对应框架。[CodeMirror](https://codemirror.net/docs/guide/) |
| 较重的数据与数值计算 | 按需 DuckDB-Wasm、Pyodide，或现有宿主计算 | SQL 数据探索、Python 科学计算、计算结果与视图联动 | 这是计算层。DuckDB-Wasm 处理 Arrow/CSV/JSON/Parquet；Pyodide 带来浏览器 Python 及已移植的科学包。重任务放 Worker，明确停止与结果保存；不把浏览器当无限资源的后台服务。[DuckDB](https://duckdb.org/docs/current/clients/wasm/overview)、[Pyodide](https://pyodide.org/en/stable/) |

这些领域还可以通过同一个产物入口扩展。例如音乐使用专门的乐谱引擎、地理使用专门的数据坐标系；只有出现真实的领域任务时，再选对应专业引擎。专业能力的扩展不要求重做画布和 Agent 通信。

## 为 Spellcast 收敛的组合

### 开放底座：先形成正式能力

HTML/CSS/JavaScript、SVG、Canvas 2D、图片、audio/video 与资源文件组成开放产物。保留源码和构建输出，沿用现有稳定 ID、修订、来源、布局、草稿和原任务反馈。运行内容与宿主隔离，但表达形式由产物决定。[iframe 基础](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)

常用库固定版本、按需载入；让模型知道可用能力、示例和错误，不要求它只能填写若干图表类型。未预置的库通过具体产物的构建与验证进入。对 React 等产物，优先由现有宿主构建后运行，首轮不另建浏览器内 npm/Node 开发环境。

### 首批正式适配的重点

- 文字与数学：HTML/Markdown + KaTeX；有公式语义探索要求时用 MathJax。
- 数据表达：ECharts + Tabulator，覆盖图表和可操作的数据行。
- 关系表达：现有 X6 + Mermaid；现有结构块继续可用。
- 空间表达：Three.js + glTF/GLB，把模型可提交场景补成正式能力。
- 生成素材：图片及音视频文件的导入、保存、比较、区域/时间段反馈。
- 通用自定义作品：开放 Web 产物，涵盖自定义控件、二维模拟和混合排版。

这组覆盖是首批验收重点，不是产品最终范围。Pixi、Plotly、Vega-Lite、Konva、地图和计算引擎都有明确位置，可以在对应产物中按需使用。

### 以实际任务升级专用能力

| 出现的需求 | 优先增加 |
| --- | --- |
| 科学统计图、曲面、等高线 | Plotly |
| 数据编码、分面、联动选择需要简洁规范 | Vega-Lite |
| 大量二维动态对象、滤镜或着色器 | PixiJS |
| 直接画、标注、移动图内对象 | Konva；完整手绘编辑器则 Excalidraw |
| 几何约束或物理实验 | JSXGraph / Rapier |
| 地理数据与路线 | MapLibre；数据量和图层需求再带入 deck.gl |
| 音频区间和音乐表达 | WaveSurfer / Tone / VexFlow |
| 可复现的复杂数值或 SQL 计算 | Pyodide / DuckDB-Wasm |
| 高质量定制长篇动画或排版文件 | 宿主生成 Manim / Typst 产物 |

## 几个容易选错的位置

**图表不能只选“最自由”的 D3。** 自由度高不自动带来成品质量；坐标、标注、图例和交互都可能变成模型每次重新实现的工作。默认用成熟高层图表，自定义需要时开放 D3 和原生图形。这个判断也与 D3 官方对自身低层定位的说明相符。[D3 取舍](https://d3js.org/what-is-d3)

**绘图编辑器与模型运行容器各有职责。** tldraw 和 Excalidraw 值得作为直接绘制/共同编辑候选。tldraw 的生产使用需要许可安排，且现有 X6 已承接保存与反馈；当前没有证据说明替换外层画布比补开放产物更符合本轮需求。若手工绘制成为主场景，再用同一批真实任务比较外层编辑器。[tldraw 许可](https://tldraw.dev/sdk-features/license-key)

**开放交互作品不要求先嵌入完整开发环境。** WebContainers 需要额外的跨源隔离条件。当前模型已有宿主可写代码和构建产物，先直接运行构建后的作品；只有用户要在画布中完成完整 npm 项目开发时，再评估该路径。[WebContainers 条件](https://webcontainers.io/guides/configuring-headers)

**WebGPU 属于渲染/计算后端，不能替代“该怎样表达”的选择。** 它可以作为支持设备上的增强能力；仍需在实际 WebView 和显卡上检测能力、测试稳定性并提供合适的兼容路径。[WebGPU](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API)

**一个 HTML 页面并不会自动具备共同编辑语义。** 自定义产物至少应交回对象 ID、当前参数或选择摘要。静态图片可以回传标注区域，视频可以回传时间段，三维模型可以回传 mesh ID。源码修改、素材再生成和原生控件编辑分别说明，不把三者混称为“任何内容都能直接编辑”。

## 许可与可维护性核对

本轮查询了以下主仓库的官方元数据与许可文件；检查到的仓库均未归档。维护状态只作为候选筛查，不替代正确性、性能或兼容性验证。

| 候选 | 主项目许可与来源 |
| --- | --- |
| ECharts | [Apache-2.0](https://github.com/apache/echarts) |
| Vega-Lite | [BSD-3-Clause](https://github.com/vega/vega-lite/blob/main/LICENSE) |
| Plotly.js | [MIT](https://github.com/plotly/plotly.js) |
| D3 / Observable Plot | [ISC](https://github.com/d3/d3) / [ISC](https://github.com/observablehq/plot) |
| Mermaid / Excalidraw | [MIT](https://github.com/mermaid-js/mermaid) / [MIT](https://github.com/excalidraw/excalidraw) |
| Pixi / Konva / Fabric | [MIT](https://github.com/pixijs/pixijs) / [MIT](https://github.com/konvajs/konva/blob/master/LICENSE) / [MIT](https://github.com/fabricjs/fabric.js) |
| Motion 核心 | [MIT](https://github.com/motiondivision/motion)，不包含所有付费扩展 |
| KaTeX / MathJax | [MIT](https://github.com/KaTeX/KaTeX) / [Apache-2.0](https://github.com/mathjax/MathJax) |
| Tabulator / TanStack Table | [MIT](https://github.com/tabulator-tables/tabulator) / [MIT](https://github.com/TanStack/table) |
| MapLibre / deck.gl | [BSD-3-Clause 主体及文件内其他归属](https://github.com/maplibre/maplibre-gl-js/blob/main/LICENSE.txt) / [MIT](https://github.com/visgl/deck.gl) |
| Rapier / DuckDB-Wasm / Pyodide | [Apache-2.0](https://github.com/dimforge/rapier) / [MIT](https://github.com/duckdb/duckdb-wasm) / [MPL-2.0](https://github.com/pyodide/pyodide) |

正式引入时固定实际版本并保存对应依赖许可。主引擎许可不自动覆盖字体、模型、图片、地图底图、编解码器和在线服务。采购额度与可分发许可是两件事，付费方案可以参与比较，但不应成为未经选择的发布依赖。

## 用真实作品定型，而不是用库数量验收

建议建立以下代表性验收作品；这是下一阶段的检查集，本轮没有执行这些测试。

| 真实需求样本 | 应验证的结果 |
| --- | --- |
| 一段算法如何运行 | SVG/HTML 动画能暂停和逐步查看；选择某一步，原任务能修改对应内容 |
| 一份数据表如何比较和解释 | 图表与表格共享数据行 ID；刷选、过滤、排序后回传的对象仍准确；变更参数后结果正确 |
| 一个数学或物理机制 | 公式、图形与参数联动；边界输入不会产生误导画面；能重新打开同一组参数 |
| 一个三维对象如何组成 | 旋转、选择部件和爆炸视图可用；回写保留其他部件及用户视角 |
| 一张生成图如何迭代 | 实际生成文件进入资产库；区域标注带素材版本；新版本可比较，旧版本可恢复 |
| 一段音视频如何修改 | 时间段选择、播放与暂停正确；反馈携带时间范围和对应素材；后续版本仍有来源 |
| 一个模型自创的混合小工具 | 同时使用文字、控件、数据和图形；源码可保存，局部修改不清空用户输入 |
| 一份可交付的报告 | 排版、公式和图片保持清晰，文件能导出，回到 Canvas 仍可定位原产物 |

每件作品在正式 Windows 窗口中检查首次显示、中文和窄窗口、交互、原位更新、资源释放、重启恢复与导出。不能只展示旋转方块或静态截图就宣称完整支持 Three.js、生成媒体或开放应用。

最终选择取决于作品是否帮助用户理解和操作，以及模型是否能可靠地继续修改。按需加载控制的是启动与运行负担，开放产物保证的是表达范围。
