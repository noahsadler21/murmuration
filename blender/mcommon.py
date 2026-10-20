# -*- coding: utf-8 -*-
"""Shared helpers for the murmuration starling look test (Blender 5.x).
Frame: metres, head toward -Y, back toward +Z, bird's left wing toward +X... see LOOKTEST.md."""
import bpy
import math
import os
import sys
import time
import numpy as np
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
RAW = os.path.join(ROOT, "models", "raw", "starling")
OUT = os.path.join(ROOT, "models", "out", "starling")
PREVIEW = os.path.join(ROOT, "models", "preview")
BLEND = os.path.join(ROOT, "models", "blend")
T0 = time.time()


def log(msg):
    print("[starling %6.1fs] %s" % (time.time() - T0, msg))
    sys.stdout.flush()


def wipe():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def select_only(ob):
    bpy.ops.object.select_all(action="DESELECT")
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob


def gpu_cycles(sc, samples=64):
    sc.render.engine = "CYCLES"
    sc.cycles.samples = samples
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        for dt in ("OPTIX", "CUDA"):
            try:
                prefs.compute_device_type = dt
                prefs.get_devices()
                if any(d.type == dt for d in prefs.devices):
                    for d in prefs.devices:
                        d.use = (d.type == dt)
                    sc.cycles.device = "GPU"
                    return dt
            except Exception:
                continue
    except Exception as e:
        log("gpu setup failed: %s" % e)
    return "CPU"


def verts_np(me):
    a = np.empty(len(me.vertices) * 3, dtype=np.float64)
    me.vertices.foreach_get("co", a)
    return a.reshape(-1, 3)


def tri_count(ob):
    return sum(len(p.vertices) - 2 for p in ob.data.polygons)


def img_pixels(img):
    w, h = img.size
    px = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    return px.reshape(h, w, 4)


def save_px(px, path, name, noncolor=True):
    h, w = px.shape[:2]
    img = bpy.data.images.new(name, w, h, alpha=False)
    if noncolor:
        img.colorspace_settings.name = "Non-Color"
    full = np.ones((h, w, 4), dtype=np.float32)
    c = min(3, px.shape[2]) if px.ndim == 3 else 1
    if px.ndim == 2:
        full[..., :3] = px[..., None]
    else:
        full[..., :c] = px[..., :c]
        if c == 1:
            full[..., 1] = full[..., 2] = px[..., 0]
    img.pixels.foreach_set(full.ravel())
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    return img


def look_at(cam, target, up=Vector((0, 0, 1))):
    d = (Vector(target) - cam.location).normalized()
    cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()


def new_cam(name, loc, target, ortho=None, lens=85):
    cd = bpy.data.cameras.new(name)
    if ortho:
        cd.type = "ORTHO"
        cd.ortho_scale = ortho
    else:
        cd.lens = lens
    cd.clip_start = 0.005
    cd.clip_end = 200
    cam = bpy.data.objects.new(name, cd)
    bpy.context.scene.collection.objects.link(cam)
    cam.location = Vector(loc)
    look_at(cam, target)
    return cam


def dusk_world(sc, strength=1.0):
    """cool dusk sky gradient (zenith blue-violet, horizon warm) + warm low sun lamp added separately"""
    w = bpy.data.worlds.new("dusk")
    sc.world = w
    w.use_nodes = True
    nt = w.node_tree
    nt.nodes.clear()
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    bg = nt.nodes.new("ShaderNodeBackground")
    out = nt.nodes.new("ShaderNodeOutputWorld")
    nt.links.new(tc.outputs["Generated"], sep.inputs[0])
    # Generated on world = view direction; Z in -1..1 -> map
    mp = nt.nodes.new("ShaderNodeMapRange")
    mp.inputs[1].default_value = -0.2
    mp.inputs[2].default_value = 1.0
    nt.links.new(sep.outputs["Z"], mp.inputs[0])
    nt.links.new(mp.outputs[0], ramp.inputs[0])
    e = ramp.color_ramp.elements
    e[0].position = 0.0
    e[0].color = (0.30, 0.20, 0.17, 1)
    e[1].position = 1.0
    e[1].color = (0.10, 0.16, 0.36, 1)
    m = e.new(0.2)
    m.color = (0.55, 0.36, 0.30, 1)
    m2 = e.new(0.45)
    m2.color = (0.26, 0.30, 0.48, 1)
    nt.links.new(ramp.outputs["Color"], bg.inputs["Color"])
    bg.inputs["Strength"].default_value = strength
    nt.links.new(bg.outputs[0], out.inputs[0])
    return w


def overcast_world(sc, strength=1.0, ground=False):
    """uniform studio-grey sky; ground=True: bright overcast dome above the horizon, dark ground below"""
    w = bpy.data.worlds.new("overcast")
    sc.world = w
    w.use_nodes = True
    nt = w.node_tree
    bg = nt.nodes.get("Background") or nt.nodes.new("ShaderNodeBackground")
    bg.inputs["Color"].default_value = (0.78, 0.80, 0.83, 1)
    bg.inputs["Strength"].default_value = strength
    if ground:
        tc = nt.nodes.new("ShaderNodeTexCoord")
        sep = nt.nodes.new("ShaderNodeSeparateXYZ")
        ramp = nt.nodes.new("ShaderNodeValToRGB")
        nt.links.new(tc.outputs["Generated"], sep.inputs[0])
        mp = nt.nodes.new("ShaderNodeMapRange")
        mp.inputs[1].default_value = -0.15
        mp.inputs[2].default_value = 0.6
        nt.links.new(sep.outputs["Z"], mp.inputs[0])
        nt.links.new(mp.outputs[0], ramp.inputs[0])
        e = ramp.color_ramp.elements
        e[0].position = 0.0
        e[0].color = (0.035, 0.035, 0.033, 1)
        e[1].position = 1.0
        e[1].color = (0.86, 0.88, 0.90, 1)
        m = e.new(0.2)
        m.color = (0.62, 0.64, 0.66, 1)
        nt.links.new(ramp.outputs["Color"], bg.inputs["Color"])
    return w


def sun(name, direction_from, energy, color, angle_deg=1.0):
    ld = bpy.data.lights.new(name, "SUN")
    ld.energy = energy
    ld.color = color
    ld.angle = math.radians(angle_deg)
    ob = bpy.data.objects.new(name, ld)
    bpy.context.scene.collection.objects.link(ob)
    d = Vector(direction_from).normalized()
    ob.rotation_euler = (-d).to_track_quat("-Z", "Y").to_euler()
    return ob


def render_to(sc, cam, path, res=(800, 800)):
    sc.camera = cam
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.resolution_percentage = 100
    sc.render.filepath = path
    sc.render.image_settings.file_format = "PNG"
    bpy.ops.render.render(write_still=True)
    return path
