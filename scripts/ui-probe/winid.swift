// 运行时 UI 验证用：列出 volo 主窗口的 CGWindowID + PID + 屏幕 bounds。
// windowID 供 `screencapture -x -l <id>` 按窗口抓图（被遮挡也能截，出图带阴影边距）。
// 编译：swiftc -O -o /tmp/winid winid.swift   用法：/tmp/winid
import CoreGraphics
import Foundation
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
for w in list {
  let owner = (w[kCGWindowOwnerName as String] as? String ?? "").lowercased()
  guard owner == "volo" else { continue }
  guard w[kCGWindowLayer as String] as! Int == 0 else { continue }
  let id = w[kCGWindowNumber as String] as! Int
  let pid = w[kCGWindowOwnerPID as String] as! Int
  let b = w[kCGWindowBounds as String] as! [String: Any]
  print("id=\(id) pid=\(pid) x=\(b["X"]!) y=\(b["Y"]!) w=\(b["Width"]!) h=\(b["Height"]!)")
}
