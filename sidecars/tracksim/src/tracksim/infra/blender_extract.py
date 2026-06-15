"""在 Blender 内运行（`blender --background --factory-startup --python this.py -- --in ... --out ...`）。
tracksim 进程绝不 import 本模块。输出 tracksim.track/1 的 track.json。"""
import argparse
import json
import math
import sys

import bpy  # 仅 Blender 自带 Python 可用
from mathutils import Vector  # Blender 自带

TRACK_SCHEMA = "tracksim.track/1"

# 坐标映射常量。目标接收端 = Unreal Engine（Z-up, X-forward, 左手系, cm）。
# Blender 导入 UE FBX 后为 Z-up 右手系；UE 世界 = 对 Blender 世界做反射 diag(1,-1,1)（翻 Y：右手→左手）。
# 位置：UE FBX → Disguise（经 FreeD）。Disguise FreeD 接收端用 FreeD-native Z-up(Z=height)，收包后自动
#   把 FreeD Z(height)→Disguise Y(up)、FreeD Y→Disguise Z(前)。故 tracksim 发 FreeD Z-up 坐标(右/前/上)：
#   ① Blender 导入 UE FBX 把 UE 的 Y 取反 ⇒ UE=(bx,-by,bz)×100cm（d3_060404 ground truth 实测）。
#   ② UE→Disguise(文档 ue-disguise-axis-mapping.md §3)：右=UE_Y=-by, 上=UE_Z=bz, 前=UE_X=bx。
#   ③ 打成 FreeD Z-up：freed(X右,Y前,Z上)=(-by, bx, bz)。实测闭环(f150)：发 freed(12.5,-25,5.2)
#      → Disguise Offset(12.5,5.2,-25)=右/上/前 ✓；旋转 freed(pan,tilt,roll)→Disguise(heading,elev,roll)=UE FRotator ✓。
_POS_AXES = [1, 0, 2]              # pose(freed X/Y/Z) = Blender -by / bx / bz = Disguise 右 / 前 / 上(height)
_POS_SIGN = [-1.0, 1.0, 1.0]       # freed_X=-by(右), freed_Y=bx(前), freed_Z=bz(上/height)
# 旋转：Blender 导入把 UE 的 Y 取反 ⇒ 反射 diag(1,-1,1) 还原 UE 世界，解 UE FRotator(见 _extract_rotation)：
#   pan=Yaw、tilt=Pitch(抬头+)、roll=Roll。按 ue-disguise-axis-mapping.md：Disguise ACC(heading/elevation/roll)
#   与 UE(Yaw/Pitch/Roll) 直接相等，故 Disguise FreeD: pan→heading=Yaw, tilt→elevation=Pitch, roll→roll=Roll。
#   f0(朝 +X 正立)→(0,0,0)；对 d3_060404 ground truth f150(Yaw-26/Pitch-4.8/Roll5) 实测吻合。
# 下面是对接收端的零点/符号微调位：若某轴方向反，翻 _ROT_SIGN；整体差常数，补 _ROT_OFFSET_DEG。
_ROT_SIGN = [1.0, 1.0, 1.0]          # pan(Yaw) / tilt(Pitch) / roll(Roll) 正方向
_ROT_OFFSET_DEG = [0.0, 0.0, 0.0]    # pan / tilt / roll 零点偏移（度）


def _parse_args(argv):
    if "--" in argv:
        argv = argv[argv.index("--") + 1:]
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--out", dest="out", required=True)
    ap.add_argument("--camera", default="")
    return ap.parse_args(argv)


def _import_fbx(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=path)   # Blender 5.1.2 仍提供 legacy 算子（实测可用）


def _pick_camera(name):
    cams = sorted([o for o in bpy.data.objects if o.type == "CAMERA"], key=lambda o: o.name)
    if not cams:
        raise SystemExit("ERR_NO_CAMERA: no camera in FBX")
    if name:
        for c in cams:
            if c.name == name:
                return c
        raise SystemExit("ERR_CAMERA_NOT_FOUND: %s | available=%s" % (name, [c.name for c in cams]))
    if len(cams) > 1:
        raise SystemExit("ERR_MULTI_CAMERA: %s" % [c.name for c in cams])
    return cams[0]


def _frame_range(cam, scene):
    # 帧范围取自相机动画曲线（实测：import_scene.fbx 不更新 scene.frame_start/end）；无动画则单帧
    ad = cam.animation_data
    if ad and ad.action:
        lo, hi = ad.action.frame_range
        return int(round(lo)), int(round(hi))
    return scene.frame_current, scene.frame_current


def _extract_rotation(mw):
    """把 Blender 相机视线/上方向反射到 UE 世界(diag(1,-1,1))后解 UE FRotator（度）。
    pan=Yaw(绕 Z)、tilt=Pitch(绕 Y, 抬头为正)、roll=Roll(绕 X)。
    用方向向量而非 XYZ 欧拉分量，规避相机近水平时欧拉 gimbal 处耦合错乱。"""
    R = mw.to_3x3()
    fwd_b = (R @ Vector((0.0, 0.0, -1.0))).normalized()   # Blender 视线
    up_b = (R @ Vector((0.0, 1.0, 0.0))).normalized()     # Blender 上方
    fwd = Vector((fwd_b.x, -fwd_b.y, fwd_b.z))            # 反射 → UE 世界
    up = Vector((up_b.x, -up_b.y, up_b.z))
    pan = math.degrees(math.atan2(fwd.y, fwd.x))                      # UE Yaw（绕 Z）
    tilt = math.degrees(math.atan2(fwd.z, math.hypot(fwd.x, fwd.y)))  # UE Pitch（抬头为正）
    right_ref = Vector((0.0, 0.0, 1.0)).cross(fwd)       # 零滚转参考 right（水平）
    if right_ref.length < 1e-6:                          # 视线近竖直 → roll 退化为 0
        return pan, tilt, 0.0
    right_ref.normalize()
    up_ref = fwd.cross(right_ref).normalized()
    roll = math.degrees(math.atan2(up.dot(right_ref), up.dot(up_ref)))
    return pan, tilt, roll


def _map_pose(mw, lens_mm, focus_m):
    loc = mw.to_translation()
    b = [loc.x, loc.y, loc.z]
    x, y, z = (_POS_SIGN[i] * b[_POS_AXES[i]] for i in range(3))
    r = _extract_rotation(mw)
    pan, tilt, roll = (_ROT_SIGN[i] * r[i] + _ROT_OFFSET_DEG[i] for i in range(3))
    return {"pan": pan, "tilt": tilt, "roll": roll, "x": x, "y": y, "z": z,
            "focal_length": lens_mm, "focus_distance": focus_m}


def main():
    args = _parse_args(list(sys.argv))
    _import_fbx(args.inp)
    cam = _pick_camera(args.camera)
    scene = bpy.context.scene
    fps = scene.render.fps / max(1.0, scene.render.fps_base)
    f0, f1 = _frame_range(cam, scene)
    frames = []
    for f in range(f0, f1 + 1):
        scene.frame_set(f)
        mw = cam.matrix_world
        cdata = cam.data
        lens = cdata.lens
        # focus：Blender 读出的物理对焦距离（米）。规范 FBX(如 UE 导出)应直接正确；
        # 注：Disguise take_10 的 FBX 把 focus 编码成了 0.012(应为 12)，需 ×1000——属该导出怪癖，
        # 不在默认里硬编码，待按 UE FBX 确认单位处理。
        focus = cdata.dof.focus_distance
        frames.append({"t": (f - f0) / fps, "pose": _map_pose(mw, lens, focus)})
    out = {"schema": TRACK_SCHEMA, "rate": fps, "camera": cam.name, "frames": frames}
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(out, fh)
    print("OK_FRAMES=%d" % len(frames))


if __name__ == "__main__":
    main()
