# -*- coding: utf-8 -*-
"""Stage 8: starling vertex-animation-texture export (SPEC 6.2, format 'murm-vat-1') -> assets/birds/.
Rows 0..31 = cycle_pose(k/32) (phase 0 = top of stroke, downstroke 0 -> 0.57), row 32 = glide, row 33 = bound.
Positions / normals are the evaluated (armature-deformed) meshes, converted to the glTF frame (x, z, -y):
+Z head, +Y back, +X left wing, metres. Vertices are split only at UV seams.
Also copies the textures and writes CREDITS.json; then self-checks (rows 0/16/32/33 rebuilt from the half floats vs
the evaluated mesh). Run: blender -b --factory-startup -P s8_vat.py"""
import sys, os, json, shutil
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mcommon import *
import s5_rig as R

ASSETS = os.path.join(ROOT, "assets", "birds")
os.makedirs(ASSETS, exist_ok=True)
bpy.ops.wm.open_mainfile(filepath=os.path.join(BLEND, "s5_rigged.blend"))
meta3 = json.load(open(os.path.join(BLEND, "s3_meta.json")))
NROWS, NCYC = 34, 32
LODS = [("real", 0, "rig_real"), ("retro", 1, "rig_retro"), ("sil", 2, "rig_retro"), ("micro", 3, "rig_retro")]


def row_pose(r):
    if r < NCYC:
        return R.cycle_pose(r / NCYC)
    return R.POSES["glide" if r == 32 else "bound"]


def to_gltf(a):
    return np.stack([a[..., 0], a[..., 2], -a[..., 1]], -1)


def srgb_to_lin(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def load_rgb(path):
    im = bpy.data.images.load(path, check_existing=True)
    im.colorspace_settings.name = "Non-Color"
    a = img_pixels(im)[..., :3].copy()   # bottom-up rows, raw sRGB codes / 255
    return a


ALB = {}


def albedo_means(me, tri_loops, uvs, parts_tri, texpath, Vrest):
    """area-weighted mean linear albedo over body (part 0/1) and wing (part 2/3) triangles, sampled at 16 points
    per triangle from the albedo atlas"""
    if texpath not in ALB:
        ALB[texpath] = srgb_to_lin(load_rgb(texpath))
    A = ALB[texpath]
    h, w = A.shape[:2]
    acc = {"body": np.zeros(3), "wing": np.zeros(3)}
    wsum = {"body": 0.0, "wing": 0.0}
    bary = [(a, b) for a in np.linspace(0.05, 0.95, 5) for b in np.linspace(0.05, 0.95, 5) if a + b <= 1.0]
    for t, (l0, l1, l2) in enumerate(tri_loops):
        p = Vrest[[me.loops[l].vertex_index for l in (l0, l1, l2)]]
        area = 0.5 * np.linalg.norm(np.cross(p[1] - p[0], p[2] - p[0]))
        key = "wing" if parts_tri[t] in (2, 3) else "body"
        u0, u1, u2 = uvs[l0], uvs[l1], uvs[l2]
        s = np.zeros(3)
        for a, b in bary:
            uv = u0 * (1 - a - b) + u1 * a + u2 * b
            x = int(np.clip(uv[0] * w, 0, w - 1))
            y = int(np.clip(uv[1] * h, 0, h - 1))   # bottom-up rows = Blender v
            s += A[y, x]
        acc[key] += area * s / len(bary)
        wsum[key] += area
    return {k: [round(float(c), 4) for c in acc[k] / max(wsum[k], 1e-12)] for k in acc}


def export(lod_name, lod, arm_name):
    ob = bpy.data.objects["starling_" + lod_name]
    arm = bpy.data.objects[arm_name]
    me = ob.data
    me.calc_loop_triangles()
    nl = len(me.loops)
    uvs = np.empty(nl * 2, np.float32)
    me.uv_layers[0].data.foreach_get("uv", uvs)
    uvs = uvs.reshape(-1, 2)
    parts = np.empty(len(me.polygons), np.int32)
    me.attributes["part"].data.foreach_get("value", parts)
    wing_s = np.zeros(len(me.vertices), np.float32)
    if "wing_s" in me.attributes:
        me.attributes["wing_s"].data.foreach_get("value", wing_s)
    # split vertices at UV seams only
    key2id, loop2id, src_vert = {}, np.empty(nl, np.int64), []
    vwing = np.zeros(len(me.vertices), bool)
    for p in me.polygons:
        if parts[p.index] in (2, 3):
            for vi in p.vertices:
                vwing[vi] = True
    for l in range(nl):
        vi = me.loops[l].vertex_index
        k = (vi, round(float(uvs[l, 0]), 5), round(float(uvs[l, 1]), 5))
        if k not in key2id:
            key2id[k] = len(src_vert)
            src_vert.append(vi)
        loop2id[l] = key2id[k]
    src_vert = np.array(src_vert)
    nv = len(src_vert)
    assert nv <= 4096, nv
    tri_loops = [tuple(t.loops) for t in me.loop_triangles]
    parts_tri = [int(parts[t.polygon_index]) for t in me.loop_triangles]
    index = np.array([[loop2id[l] for l in tl] for tl in tri_loops], np.uint16).ravel()
    uv_out = np.zeros((nv, 2), np.float32)
    uv_out[loop2id] = uvs
    uv_out[:, 1] = 1.0 - uv_out[:, 1]
    pos = np.zeros((NROWS, nv, 4), np.float32)
    nrm = np.zeros((NROWS, nv, 4), np.float32)
    exact = {}
    for r in range(NROWS):
        R.apply_pose(arm, row_pose(r))
        dg = bpy.context.evaluated_depsgraph_get()
        ev = ob.evaluated_get(dg)
        em = ev.to_mesh()
        M = np.array(ob.matrix_world)
        co = np.empty(len(em.vertices) * 3, np.float64)
        em.vertices.foreach_get("co", co)
        co = co.reshape(-1, 3) @ M[:3, :3].T + M[:3, 3]
        cn = np.empty(len(em.loops) * 3, np.float64)
        em.corner_normals.foreach_get("vector", cn)
        cn = cn.reshape(-1, 3) @ M[:3, :3].T
        ev.to_mesh_clear()
        acc = np.zeros((nv, 3))
        np.add.at(acc, loop2id, cn)
        acc /= np.maximum(np.linalg.norm(acc, axis=1, keepdims=True), 1e-9)
        pos[r, :, :3] = to_gltf(co[src_vert])
        pos[r, :, 3] = vwing[src_vert].astype(np.float32)
        nrm[r, :, :3] = to_gltf(acc)
        nrm[r, :, 3] = np.where(vwing[src_vert], np.clip(wing_s[src_vert] / R.SPAN, 0, 1), 0.0)
        exact[r] = pos[r, :, :3].copy()
    R.apply_pose(arm, R.POSES["glide"])
    vat_pos = pos.astype(np.float16)
    vat_nrm = np.clip(np.round(nrm[..., :3] * 127.5 + 127.5), 0, 255)
    vat_nrm = np.concatenate([vat_nrm, np.round(nrm[..., 3:] * 255)], -1).astype(np.uint8)
    # ---- write .bin, 4-byte aligned blocks
    blobs, bufs, off = [], {}, 0
    for name, arr, count in (("index", index, index.size), ("uv", uv_out.ravel(), uv_out.size),
                             ("vatPos", vat_pos.ravel(), vat_pos.size), ("vatNrm", vat_nrm.ravel(), vat_nrm.size)):
        b = arr.astype(arr.dtype.newbyteorder("<")).tobytes()
        bufs[name] = {"offset": off, "count": int(count)}
        pad = (-len(b)) % 4
        blobs.append(b + b"\0" * pad)
        off += len(b) + pad
    name = "starling_" + lod_name
    with open(os.path.join(ASSETS, name + ".bin"), "wb") as f:
        f.write(b"".join(blobs))
    allp = pos[..., :3].reshape(-1, 3)
    bbox = [round(float(x), 5) for x in list(allp.min(0)) + list(allp.max(0))]
    tex_variant = "real" if lod_name == "real" else "retro"
    Vrest = verts_np(me)
    albl = albedo_means(me, tri_loops, uvs, parts_tri, os.path.join(OUT, "starling_%s_albedo.png" % tex_variant), Vrest)
    textures = {"albedo": None, "mask": None, "normal": None}
    if lod_name in ("real", "retro"):
        textures = {"albedo": "starling_%s_albedo.png" % lod_name, "mask": "starling_%s_mask.png" % lod_name,
                    "normal": "starling_real_normal.png" if lod_name == "real" else None}
    js = {"format": "murm-vat-1", "name": name, "lod": lod, "verts": int(nv), "tris": int(index.size // 3),
          "rows": NROWS, "cycleFrames": NCYC, "rowGlide": 32, "rowBound": 33, "wingbeatHz": R.WINGBEAT_HZ,
          "downstroke": R.DOWNSTROKE, "spanM": 0.39, "lengthM": 0.205,
          "frame": "glTF +Z head, +Y back, +X left wing, metres", "bbox": bbox, "buffers": bufs,
          "textures": textures, "albedoLinear": albl,
          "measured": {"spanGlideM": round(float(pos[32, :, 0].max() - pos[32, :, 0].min()), 4),
                       "lengthGlideM": round(float(pos[32, :, 2].max() - pos[32, :, 2].min()), 4)},
          "source": "blender/s8_vat.py from models/blend/s5_rigged.blend (%s)" % time.strftime("%Y-%m-%d %H:%M")}
    with open(os.path.join(ASSETS, name + ".json"), "w", encoding="utf-8") as f:
        json.dump(js, f, indent=1)
    # ---- self check: rebuild rows from the written half floats
    raw = open(os.path.join(ASSETS, name + ".bin"), "rb").read()
    o = bufs["vatPos"]
    back = np.frombuffer(raw, "<f2", o["count"], o["offset"]).astype(np.float32).reshape(NROWS, nv, 4)
    errs = {r: float(np.abs(back[r, :, :3] - exact[r]).max() * 1000) for r in (0, 16, 32, 33)}
    log("%s: %d verts (%d mesh verts), %d tris, bin %d B, max |err| mm %s, albedoLinear %s" % (
        name, nv, len(me.vertices), index.size // 3, len(raw), {k: round(v, 3) for k, v in errs.items()}, albl))
    return {"name": name, "verts": int(nv), "tris": int(index.size // 3), "errMm": errs, "bytes": len(raw)}


res = []
for lod_name, lod, arm_name in LODS:
    if ("starling_" + lod_name) in bpy.data.objects:
        res.append(export(lod_name, lod, arm_name))
    else:
        log("missing object starling_%s - skipped" % lod_name)
# textures (normal = baked)
for src, dst in (("starling_real_albedo.png", None), ("starling_real_mask.png", None),
                 ("starling_real_normal_baked.png", "starling_real_normal.png"),
                 ("starling_retro_albedo.png", None), ("starling_retro_mask.png", None)):
    shutil.copyfile(os.path.join(OUT, src), os.path.join(ASSETS, dst or src))
cred = {"starling": "European starling scan: Virtual Museums of Małopolska / Tomek Natural Science Museum (MP 314), CC0",
        "peregrine": "Peregrine falcon scan: The Watt Institution (Inverclyde), CC-BY 4.0",
        "peregrineUrl": "https://sketchfab.com/3d-models/peregrine-falcon-falco-peregrinus-49cb0ef2fa2847b0aca92ab6deecf919"}
with open(os.path.join(ASSETS, "CREDITS.json"), "w", encoding="utf-8") as f:
    json.dump(cred, f, indent=1, ensure_ascii=False)
with open(os.path.join(BLEND, "s8_vat_report.json"), "w") as f:
    json.dump(res, f, indent=1)
log("done")
