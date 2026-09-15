# Linked Tide

两个 500×440 的有限画布作品，以想象港湾的涨潮机制为题。它们只用于交互探索，不提供真实航海建议。

## 发布参数

发布“参数”作品时使用新的 `io` 字段：`io:{inputs:{},outputs:{tide:'number'}}`

发布“图表”作品时使用新的 `io` 字段：`io:{inputs:{tide:'number'},outputs:{}}`

两个页面都在各自目录通过相对路径加载 `__spellcast.js`；发布器将它放在页面旁边。页面本身不请求网络，也不依赖框架。

## 状态与端口归属

- `parameter/index.html` 只拥有 `state={tide:number}`。滑条和数字输入同步后，先调用 `setState({tide})`，再以当前 `spellcast.inputs.revision` 调用 `publishOutputs({tide}, expectedInputRevision)`。它也订阅 `onInputs`，让每次输入快照刷新都重新发布当前潮位。
- `chart/index.html` 只拥有 `state={selected:string}`。`onInputs` 只读取瞬时的 `inputs.ports.tide` 并重画水线，绝不覆盖选中的港湾或城市标记；标记变化通过 `spellcast.select({id,label})` 传出。端口缺失或不可用时，页面清空当前数值并明确显示“输入不可用”，因此不会保留旧潮位。
- 两页都在 `await spellcast.ready` 后读取自己的 `spellcast.state`，并在 `onRestore` 恢复各自的控制值或选择。恢复值有效时不会回写相同状态；参数页仍会重新发布，图表页仍会重新声明其选择。缺失或无效状态才会写入各自默认值。

每页的“模拟上游故障”按钮只调用 `spellcast.reportError(...)` 来演示错误路径，页面会说明重启本作品即可恢复。原生解释由父容器作为独立对象渲染，不属于这两个作品。
