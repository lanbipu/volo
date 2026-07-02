// 运行时 UI 验证用：向屏幕坐标合成一次左键点击（CGEvent 全局投递）。
// System Events 的 `click at` 对 WKWebView 无效（AX 命中但 DOM click 不触发），必须走这条通道；
// 事件发给坐标处最顶层窗口，点击前需保证 volo 置顶且该坐标无遮挡（见 CLAUDE.md「运行时 UI 验证」）。
// 编译：swiftc -O -o /tmp/click click.swift   用法：/tmp/click <x> <y>
import CoreGraphics
import Foundation
let args = CommandLine.arguments
let pt = CGPoint(x: Double(args[1])!, y: Double(args[2])!)
for type in [CGEventType.leftMouseDown, .leftMouseUp] {
  let ev = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: pt, mouseButton: .left)!
  ev.post(tap: .cghidEventTap)
  usleep(60000)
}
