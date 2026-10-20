# -*- coding: utf-8 -*-
"""Peregrine p2: orthographic data captures of the cleaned scan (models/blend/p1_scan_oriented.blend).
  top   (from +Z): the folded wings (dorsal flight feathers, coverts), back, crown and the upper tail
  below (from -Z): the barred breast, belly and flanks, the undertail coverts and the tail underside
Passes: albedo (the scan's unlit base colour as emission, linear) and normal (the scan geometry's shading normal in
the capture frame: image right / image up / toward the camera, *0.5+0.5). The spread wings and the tail are UV-mapped
into these captures (p3), the underwing from the barred underparts. Writes models/blend/pcap_<view>_<pass>.exr."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pcommon import *

bpy.ops.wm.open_mainfile(filepath=os.path.join(BLEND, "p1_scan_oriented.blend"))
for o in list(bpy.context.scene.objects):
    if o.type in ("CAMERA", "LIGHT"):
        bpy.data.objects.remove(o)
scan = bpy.data.objects["scan"]
orig = [s.material for s in scan.material_slots]
plog("scan materials: %s" % [m.name for m in orig])


def tex_of(m):
    return next(n.image for n in m.node_tree.nodes if n.type == "TEX_IMAGE" and n.image)


def emit_albedo(m):
    e = bpy.data.materials.new("emit_alb_" + m.name)
    e.use_nodes = True
    nt = e.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    em = nt.nodes.new("ShaderNodeEmission")
    t = nt.nodes.new("ShaderNodeTexImage")
    t.image = tex_of(m)
    t.interpolation = "Cubic"
    nt.links.new(t.outputs["Color"], em.inputs["Color"])
    nt.links.new(em.outputs[0], out.inputs[0])
    return e


def emit_normal(axes):
    e = bpy.data.materials.new("emit_nrm")
    e.use_nodes = True
    nt = e.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    em = nt.nodes.new("ShaderNodeEmission")
    geo = nt.nodes.new("ShaderNodeNewGeometry")
    comb = nt.nodes.new("ShaderNodeCombineXYZ")
    for i, ax in enumerate(axes):
        d = nt.nodes.new("ShaderNodeVectorMath")
        d.operation = "DOT_PRODUCT"
        d.inputs[1].default_value = ax
        nt.links.new(geo.outputs["Normal"], d.inputs[0])
        nt.links.new(d.outputs["Value"], comb.inputs[i])
    ma = nt.nodes.new("ShaderNodeVectorMath")
    ma.operation = "MULTIPLY_ADD"
    ma.inputs[1].default_value = (0.5, 0.5, 0.5)
    ma.inputs[2].default_value = (0.5, 0.5, 0.5)
    nt.links.new(comb.outputs[0], ma.inputs[0])
    nt.links.new(ma.outputs[0], em.inputs["Color"])
    nt.links.new(em.outputs[0], out.inputs[0])
    return e


sc = bpy.context.scene
gpu_cycles(sc, 12)
sc.cycles.use_denoising = False
sc.cycles.max_bounces = 0
sc.cycles.filter_width = 0.8
sc.render.film_transparent = True
sc.view_settings.view_transform = "Standard"
sc.world = bpy.data.worlds.new("black")
W = int(round(2 * CAP_HX * CAP_PPM))
H = int(round((CAP_Y1 - CAP_Y0) * CAP_PPM))
sc.render.resolution_x, sc.render.resolution_y = W, H
sc.render.resolution_percentage = 100
sc.render.image_settings.file_format = "OPEN_EXR"
sc.render.image_settings.color_depth = "16"
sc.render.image_settings.color_mode = "RGBA"
yc = (CAP_Y0 + CAP_Y1) / 2
alb = [emit_albedo(m) for m in orig]
VIEWS = {"top": ((0, yc, 1.0), (0, 0, 0), ((1, 0, 0), (0, 1, 0), (0, 0, 1))),
         "below": ((0, yc, -1.0), (math.pi, 0, 0), ((1, 0, 0), (0, -1, 0), (0, 0, -1)))}
for view, (loc, rot, axes) in VIEWS.items():
    cd = bpy.data.cameras.new("cap")
    cd.type = "ORTHO"
    cd.ortho_scale = CAP_Y1 - CAP_Y0
    cd.clip_start, cd.clip_end = 0.01, 3.0
    cam = bpy.data.objects.new("cap", cd)
    sc.collection.objects.link(cam)
    cam.location = loc
    cam.rotation_euler = rot
    sc.camera = cam
    nrm = emit_normal(axes)
    for kind in ("albedo", "normal"):
        for i, s in enumerate(scan.material_slots):
            s.material = alb[i] if kind == "albedo" else nrm
        sc.render.filepath = os.path.join(BLEND, "pcap_%s_%s.exr" % (view, kind))
        t = time.time()
        bpy.ops.render.render(write_still=True)
        plog("capture %s %s %dx%d (%.1f s)" % (view, kind, W, H, time.time() - t))
    bpy.data.objects.remove(cam)
for i, s in enumerate(scan.material_slots):
    s.material = orig[i]
plog("done")
