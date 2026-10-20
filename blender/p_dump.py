# diagnostic: dump the welded peregrine scan vertices to models/blend/p0_verts.npy
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mcommon import *
bpy.ops.wm.open_mainfile(filepath=os.path.join(BLEND, sys.argv[sys.argv.index("--") + 1]))
ob = bpy.data.objects["scan"]
np.save(os.path.join(BLEND, sys.argv[sys.argv.index("--") + 2]), verts_np(ob.data).astype(np.float32))
