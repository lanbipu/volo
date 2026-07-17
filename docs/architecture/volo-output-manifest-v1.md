# Volo Output Manifest v1

## 契约

生产 manifest 的 schema version 固定为 `volo_output.v1`。每个 nDisplay 节点接收一份只描述本节点的扁平 manifest；例如 `LanNode`：

```json
{
  "schema_version": "volo_output.v1",
  "revision": 42,
  "mode": "show",
  "image_path": "C:\\ProgramData\\UECM\\ndisplay-output\\session\\frames\\frame-42.png",
  "crop_x": 800,
  "crop_y": 0,
  "crop_w": 800,
  "crop_h": 600
}
```

字段：

- `schema_version`：必须等于 `volo_output.v1`。
- `revision`：无符号 64 位整数；同一输出 session 内严格单调递增。
- `mode`：`show` 或 `clear`。
- `image_path`：该节点本地、已完整落盘的新文件名 PNG 绝对路径。
- `crop_x` / `crop_y` / `crop_w` / `crop_h`：该节点的 crop，来源是节点 `viewport_rect_px`。

生成器仍要求调用方为拓扑中的全部节点提供 `image_path`，且不能包含未知节点。发布时按 node id 选取对应的扁平 manifest。`clear` 只含 `schema_version`、`revision`、`mode`，不含图片和 crop 字段：

```json
{"schema_version":"volo_output.v1","revision":43,"mode":"clear"}
```

## 发布顺序

1. 为本次 revision 生成从未使用过的新 PNG 文件名。
2. 先把 PNG 完整推送到所有节点的 `image_path`。
3. 所有节点确认文件推送完成后，才为每个节点生成各自的扁平 manifest。
4. manifest 先写同目录临时文件，再以原子 rename/replace 覆盖正式路径。
5. 只有发布成功才能提交 revision；失败重试不能复用一个已经部分可见的旧文件名。

## 像素 1:1 不变量

每个节点都必须满足：

```text
crop_w,crop_h == viewport_rect_px[width,height] == window_px
```

UE 5.8 nDisplay 在输入输出尺寸不一致时强制使用 `SF_Bilinear`，纹理的 `Filter=Nearest` 无法覆盖。因此 topology validation 将 window/viewport mismatch 作为 error。
