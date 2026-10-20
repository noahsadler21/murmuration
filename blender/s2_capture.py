# -*- coding: utf-8 -*-
"""Stage 2: orthographic data captures of the cleaned scan's folded wings (bird's left = +X, right = -X):
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
w = bpy.data.worlds.new("black")
sc.world = w
sc.render.image_settings.file_format = "OPEN_EXR"
sc.render.image_settings.color_depth = "32"
sc.render.resolution_x, sc.render.resolution_y = 2400, 1200
sc.render.resolution_percentage = 100
# camera frames: side +X looks -X: right = +Y, up = +Z, toward camera = +X ; side -X: right = -Y
sides = {"L": ((1, 0, 0), (0, 1, 0)), "R": ((-1, 0, 0), (0, -1, 0))}
for side, (d, right) in sides.items():
    cam = new_cam("cap_" + side, Vector(d) * 0.5, (0, 0, 0), ortho=0.22)
    sc.camera = cam
    T, B, N = right, (0, 0, 1), d
    for kind in ("albedo", "occ", "spec", "normal"):
        m = emit_mat(kind, (T, B, N))
        scan.data.materials[0] = m
        sc.render.filepath = os.path.join(BLEND, "cap_%s_%s.exr" % (side, kind))
        bpy.ops.render.render(write_still=True)
        log("captured %s %s" % (side, kind))
        if kind in ("albedo", "normal"):
            sc.render.image_settings.file_format = "PNG"
            sc.render.image_settings.color_depth = "8"
            if kind == "normal":
                sc.view_settings.view_transform = "Raw"
            sc.render.filepath = os.path.join(BLEND, "cap_%s_%s.png" % (side, kind))
            bpy.ops.render.render(write_still=True)
            sc.view_settings.view_transform = "Standard"
            sc.render.image_settings.file_format = "OPEN_EXR"
            sc.render.image_settings.color_depth = "32"
scan.data.materials[0] = src
log("done")
