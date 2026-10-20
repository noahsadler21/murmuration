# -*- coding: utf-8 -*-
"""Stage 2b (tail top/bottom captures, v2); based on stage 2: orthographic data captures of the cleaned scan's folded wings (bird's left = +X, right = -X):
albedo, detail normal (tangent frame = image right / image up / toward camera), occlusion, spec level.
These are planar projections from the re-posed scan; the spread wing is UV-mapped into them (s3).
Writes EXR (linear) to models/blend/cap_<side>_<pass>.exr"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mcommon import *

bpy.ops.wm.open_mainfile(filepath=os.path.join(BLEND, "s1_scan_oriented.blend"))
for o in list(bpy.context.scene.objects):
    if o.type in ("CAMERA", "LIGHT"):
        bpy.data.objects.remove(o)
scan = bpy.data.objects["scan"]
src = scan.data.materials[0]
imgs = {}
for n in src.node_tree.nodes:
    if n.type == "TEX_IMAGE" and n.image:
        imgs[os.path.basename(n.image.filepath)] = n.image
log("scan images: %s" % list(imgs))


def img(key):
    return next(v for k, v in imgs.items() if key in k)


def emit_mat(kind, cam_axes=None):
    """kind: albedo | occ | spec | normal ; normal emits (n.T, n.B, n.N) * 0.5 + 0.5 in the camera frame"""
    m = bpy.data.materials.new("emit_" + kind)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    em = nt.nodes.new("ShaderNodeEmission")
    nt.links.new(em.outputs[0], out.inputs[0])
    t = nt.nodes.new("ShaderNodeTexImage")
    if kind == "albedo":
        t.image = img("diffuse")
        nt.links.new(t.outputs["Color"], em.inputs["Color"])
    elif kind == "occ":
        t.image = img("occlusion")
        nt.links.new(t.outputs["Color"], em.inputs["Color"])
    elif kind == "spec":
        t.image = img("specular")
        nt.links.new(t.outputs["Color"], em.inputs["Color"])
    elif kind == "normal":
        t.image = img("normal")
        t.image.colorspace_settings.name = "Non-Color"
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nt.links.new(t.outputs["Color"], nm.inputs["Color"])
        T, B, N = cam_axes
        comb = nt.nodes.new("ShaderNodeCombineXYZ")
        for i, axis in enumerate((T, B, N)):
            d = nt.nodes.new("ShaderNodeVectorMath")
            d.operation = "DOT_PRODUCT"
            d.inputs[1].default_value = axis
            nt.links.new(nm.outputs["Normal"], d.inputs[0])
            nt.links.new(d.outputs["Value"], comb.inputs[i])
        ma = nt.nodes.new("ShaderNodeVectorMath")
        ma.operation = "MULTIPLY_ADD"
        ma.inputs[1].default_value = (0.5, 0.5, 0.5)
        ma.inputs[2].default_value = (0.5, 0.5, 0.5)
        nt.links.new(comb.outputs[0], ma.inputs[0])
        nt.links.new(ma.outputs[0], em.inputs["Color"])
    return m


sc = bpy.context.scene
gpu_cycles(sc, 16)
sc.cycles.use_denoising = False
sc.cycles.filter_width = 1.0
sc.render.film_transparent = True
sc.view_settings.view_transform = "Standard"
sc.world = bpy.data.worlds.new("black")
RES = 1600
SCALE = 0.08          # metres across -> 20 px/mm
CEN = Vector((0.0, 0.066, 0.0))
sc.render.resolution_x = sc.render.resolution_y = RES
sc.render.resolution_percentage = 100
# top: image right +X, up +Y, N +Z ; bottom: image right +X, up -Y, N -Z
views = {"top": ((0, 0, 1), (0, 0, 0), (1, 0, 0), (0, 1, 0)), "bot": ((0, 0, -1), (math.pi, 0, 0), (1, 0, 0), (0, -1, 0))}
for name, (d, rot, T, B) in views.items():
    cam = new_cam("tcap_" + name, CEN + Vector(d) * 0.4, CEN, ortho=SCALE)
    cam.rotation_euler = rot
    sc.camera = cam
    for kind in ("albedo", "normal", "occ"):
        scan.data.materials[0] = emit_mat(kind, (T, B, d))
        for fmt, ext in (("OPEN_EXR", "exr"), ("PNG", "png")):
            if fmt == "PNG" and kind == "occ":
                continue
            sc.render.image_settings.file_format = fmt
            sc.render.image_settings.color_depth = "32" if fmt == "OPEN_EXR" else "8"
            sc.view_settings.view_transform = "Raw" if (kind == "normal" and fmt == "PNG") else "Standard"
            sc.render.filepath = os.path.join(BLEND, "tcap_%s_%s.%s" % (name, kind, ext))
            bpy.ops.render.render(write_still=True)
        log("tail capture %s %s" % (name, kind))
scan.data.materials[0] = src
log("done")
