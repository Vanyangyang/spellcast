# 潮汐港

两个独立作品：潮位参数，以及一张俯视港湾机制图。它们通过宿主声明的端口连接，**不是**同一个画布对象里的三个区域。

- 参数作品只拥有 `state={tide:number}`，输出 `tide`。
- 地图作品只拥有 `state={selected:string}`，输入 `tide`。闸口是作品内部的选择锚点（`spellcast.select`），不是独立原子对象。
- 宿主上的原生数值对象通过 Canvas 绑定读取同一个 `tide` 端口。

发布时：

```
参数 io:{inputs:{},outputs:{tide:'number'}}
地图 io:{inputs:{tide:'number'},outputs:{}}
```

本目录通过相对路径加载 `__spellcast.js`。页面不请求网络。这是示例作品，不是 Spellcast 宿主本身。
