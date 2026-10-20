#!/bin/sh
# peregrine pipeline: p0 inspect -> p1 clean -> p2 captures -> p3 build -> p4 bakes + plumage remap -> p5 rig/export -> p6 previews
B="/c/Program Files/Blender Foundation/Blender 5.2/blender.exe"
cd "$(dirname "$0")"
F="grep peregrine\|rror"
if [ "$1" = "all" ]; then
  "$B" -b --factory-startup -P p0_inspect.py 2>&1 | grep "peregrine\|rror"
  "$B" -b --factory-startup -P p1_clean.py 2>&1 | grep "peregrine\|rror"
  "$B" -b --factory-startup -P p2_capture.py 2>&1 | grep "peregrine\|rror"
fi
"$B" -b --factory-startup -P p3_build.py 2>&1 | grep "peregrine\|rror"
for v in real retro; do "$B" -b --factory-startup -P p4_bake.py -- $v 2>&1 | grep "report\|misses\|rror"; done
"$B" -b --factory-startup -P p5_rig.py 2>&1 | grep "peregrine\|rror" | grep -v INFO
for w in poses compare scale remap tail; do "$B" -b --factory-startup -P p6_render.py -- $w 2>&1 | grep "rror\|measurements"; done
python p6_compose.py all
echo FALCON_DONE
