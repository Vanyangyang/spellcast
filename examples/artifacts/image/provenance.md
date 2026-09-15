# 雨水亭图像来源

2026-09-07，使用内置 `image_gen` 工具生成一张原图，再对同一原图进行一次定向编辑；没有使用 CLI/API fallback。两个结果均为 1536 × 1024 PNG，已复制进项目，原始生成文件也予以保留。图像用于 Canvas 的比较、区域反馈与素材保存验证，是概念插画。

| 文件 | 字节数 | SHA-256 |
| --- | --- | --- |
| `assets/pavilion-original.png` | 3,532,534 | `4a79671cec624682d0b8bd4a0977ebeae10b89799c907da43c4879d4bddc6b0b` |
| `assets/pavilion-amber-before-pool-seq17.png`（原琥珀屋顶版本） | 3,409,147 | `13c0590413890c657805aff05a26e2e2a5dadb6df9ed910cecbe70c1a9416192` |

原图提示词：

> Use case: stylized-concept. Create one refined architectural landscape illustration for an interactive Canvas image-review example. A small rainwater observation pavilion sits in a lush botanical rain garden: a distinctive pale blue-green sloping glass canopy, slim timber supports, a visible rainwater collection channel, reeds, shallow water and stepping stones. Calm daylight after rain, soft reflections, tactile paper and gouache texture, careful architectural perspective, sophisticated editorial illustration, warm ivory / forest green / muted teal with small ochre accents. Wide landscape composition, the pavilion and its roof clearly visible near the center, sufficient botanical context but not cluttered. The image should make the canopy a clear, local region to select and revise in a later edit. No writing, labels, lettering, UI, logos, or watermark. This is a conceptual illustration, not a construction drawing.

编辑提示词（输入为同目录中的原图）：

> Use case: precise-object-edit. Edit the supplied pavilion illustration. Change only the large sloping glass canopy from cool pale blue-green glass to warm amber / honey-tinted translucent glass. Make the roof color difference clearly visible while retaining the same panel seams, frame geometry, perspective, transparency and physical roof shape. Preserve the original composition, dimensions, timber supports, plants, water, stones, lighting, paper texture and all elements outside the roof as closely as possible. Do not add or remove objects. No writing, labels, UI, logos, or watermark.

两版已经进行视觉检查；屋顶变化清晰，构图与主要对象保持一致。这不构成逐像素不变的保证，比较器保留两份独立原文件。

## Canvas 请求 17：把这里换成一个游泳池

用户在 `everything-image-20260907 / work` 的 bundle `969c4408-c96a-4d63-8c34-e4527a7761af` 中选择编辑版区域，并提出“把这里换成一个游泳池？”。输入素材为该版本的 `assets/pavilion-amber.png`，其 SHA-256 与上表琥珀屋顶图相同；使用原生 `spellcast_artifact_read` 核对版本及文件，再以本地同哈希文件进行内置 ImageGen 编辑，没有使用 CLI/API fallback。

选区采用 normalized-image 坐标：`x=0.14910540301151462, y=0.13485504743177532, width=0.7063241806908769, height=0.6331411261392926`。保留原 `view=compare, split=0, target=amber` 和选区状态；`amber` 是已有编辑版本的稳定标识，现在显示游泳池版本。查看编辑版或移动对照滑块可见新图。

新图为 1536 × 1024 PNG，3,373,408 字节，SHA-256 `ab3ddbdd696fe259f99aef5b9959dd8030c75076b5479332c1bbfb42f37b246d`。独立文件保存于项目 `output/images/pavilion-pool-seq17.png`，作品使用稳定路径 `assets/pavilion-amber.png`；旧图另存为 `assets/pavilion-amber-before-pool-seq17.png`，历史 bundle 也保留。已检查生成图：中央亭子变为带入水台阶的矩形泳池，保留主要林木、前景水面和踏石，以及暖色水彩风格。

本次完整编辑提示词（输入为上述琥珀屋顶图）：

> Edit the provided image. It is the exact edit target from Spellcast Canvas. The user asks in Chinese: 把这里换成一个游泳池？ (Replace this selected area with a swimming pool.) Create ONE edited image with the same 1536 by 1024 landscape composition and watercolor architectural illustration style. The user-selected rectangle is normalized x=0.1491054, y=0.1348550, width=0.7063242, height=0.6331411; approximately pixels x229 to1314 and y138 to786. Within this area, replace the central amber-roofed pavilion and its central rainwater display/benches with an outdoor swimming pool occupying its site. Remove the central pavilion roof and supports; reconstruct the forest/background where they were. Show a clearly recognizable, elegant rectangular swimming pool in perspective, with clear pale turquoise swimming water, subtle underwater steps, and narrow natural-stone coping, visually integrated into this woodland garden. It must look large and deep enough for swimming, not like another shallow rain garden or tiny pond. Preserve the existing viewpoint, framing, warm muted autumn light, paper texture, surrounding trees, foreground pond and stepping stones, marginal wildflowers and reeds. Keep changes concentrated inside the specified rectangle and preserve the scene outside it as closely as possible. The pool itself must remain within the selected site. No people, no text, no labels, no selection border, no UI, no added buildings. Deliver the finished image only.
