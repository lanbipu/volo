// 运行时 UI 验证用：合成一次鼠标拖拽（down → N 段 dragged → up，CGEvent 全局投递）。
// 用于三维视口 orbit/pan/框选 等按住拖动交互（click.swift 同通道）。
// 编译：swiftc -O -o /tmp/drag drag.swift   用法：/tmp/drag <x0> <y0> <x1> <y1> [steps=20] [button=left|right]
import CoreGraphics
import Foundation
let args = CommandLine.arguments
let p0 = CGPoint(x: Double(args[1])!, y: Double(args[2])!)
let p1 = CGPoint(x: Double(args[3])!, y: Double(args[4])!)
let steps = args.count > 5 ? Int(args[5])! : 20
let right = args.count > 6 && args[6] == "right"
let btn: CGMouseButton = right ? .right : .left
let downT: CGEventType = right ? .rightMouseDown : .leftMouseDown
let dragT: CGEventType = right ? .rightMouseDragged : .leftMouseDragged
let upT: CGEventType = right ? .rightMouseUp : .leftMouseUp
CGWarpMouseCursorPosition(p0)
usleep(40000)
CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p0, mouseButton: btn)!.post(tap: .cghidEventTap)
usleep(60000)
CGEvent(mouseEventSource: nil, mouseType: downT, mouseCursorPosition: p0, mouseButton: btn)!.post(tap: .cghidEventTap)
usleep(60000)
for i in 1...steps {
  let t = Double(i) / Double(steps)
  let p = CGPoint(x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t)
  CGWarpMouseCursorPosition(p)
  CGEvent(mouseEventSource: nil, mouseType: dragT, mouseCursorPosition: p, mouseButton: btn)!.post(tap: .cghidEventTap)
  usleep(16000)
}
CGEvent(mouseEventSource: nil, mouseType: upT, mouseCursorPosition: p1, mouseButton: btn)!.post(tap: .cghidEventTap)
usleep(60000)
