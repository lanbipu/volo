// 运行时 UI 验证用：向屏幕坐标合成一次鼠标滚轮事件（CGEvent 全局投递）。
// 用于滚动 WKWebView 内容区（同 click.swift 的通道，System Events 无法可靠触发）。
// 编译：swiftc -O -o /tmp/scroll scroll.swift   用法：/tmp/scroll <x> <y> <deltaY> [ticks]
import CoreGraphics
import Foundation
let args = CommandLine.arguments
let pt = CGPoint(x: Double(args[1])!, y: Double(args[2])!)
let deltaY = Int32(args[3])!
let ticks = args.count > 4 ? Int(args[4])! : 1
CGWarpMouseCursorPosition(pt)
usleep(30000)
for _ in 0..<ticks {
  let ev = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: deltaY, wheel2: 0, wheel3: 0)!
  ev.location = pt
  ev.post(tap: .cghidEventTap)
  usleep(20000)
}
