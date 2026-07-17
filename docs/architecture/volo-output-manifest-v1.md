# Volo Output Manifest v1

## 契约

生产 manifest 的 schema version 固定为 `volo_output.v1`：

```json
{
  "schema_version": "volo_output.v1",
  "revision": 42,
  "mode": "show",
  "nodes": {
    "LanNode": {
      "image_path": "C:\\ProgramData\\UECM\\ndisplay-output\\images\\frame-42.png",
      "crop": [800, 0, 800, 600]
    },
    "RazerNode": {
      "image_path": "C:\\ProgramData\\UECM\\ndisplay-output\\images\\frame-42.png",
      "crop": [0, 0, 800, 600]
    }
  }
}
```

字段：

- `schema_version`：必须等于 `volo_output.v1`。
- `revision`：无符号 64 位整数；同一输出 session 内严格单调递增。
- `mode`：`show` 或 `clear`。
- `nodes`：以 nDisplay node id 为 key 的对象，key 必须与输出拓扑完全一致。
- `image_path`：该节点本地、已完整落盘的新文件名 PNG 绝对路径。
- `crop`：`[x, y, width, height]` 像素四元组，来源是节点 `viewport_rect_px`。

`show` 必须包含拓扑中的全部节点，且不能包含未知节点。`clear` 的 `nodes` 必须为空对象。

## 发布顺序

1. 为本次 revision 生成从未使用过的新 PNG 文件名。
2. 先把 PNG 完整推送到所有节点的 `image_path`。
3. 每个节点确认文件存在且大小/校验通过后，才生成 manifest。
4. manifest 先写同目录临时文件，再以原子 rename/replace 覆盖正式路径。
5. 只有发布成功才能提交 revision；失败重试不能复用一个已经部分可见的旧文件名。

## 像素 1:1 不变量

每个节点都必须满足：

```text
crop[width, height] == viewport_rect_px[width, height] == window_px
```

UE 5.8 nDisplay 在输入输出尺寸不一致时强制使用 `SF_Bilinear`，纹理的 `Filter=Nearest` 无法覆盖。因此 topology validation 将 window/viewport mismatch 作为 error。
