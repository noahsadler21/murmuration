#!/bin/sh
# full rebuild: s3 build -> s4 bakes (real, retro) -> s5 rig  (s0-s2 only needed once)
B="/c/Program Files/Blender Foundation/Blender 5.2/blender.exe"
cd "$(dirname "$0")"
"$B" -b --factory-startup -P s3_build.py 2>&1 | grep "starling\|rror" | grep -v "ring y"
for v in real retro; do "$B" -b --factory-startup -P s4_bake.py -- $v 2>&1 | grep "contribution\|detail normal\|correlation\|rror"; done
"$B" -b --factory-startup -P s5_rig.py 2>&1 | grep "starling\|rror" | grep -v INFO
# v3: VAT export (SPEC 6.2, assets/birds/starling_{real,retro,sil,micro}.json/.bin + textures + CREDITS.json),
# optional impostor atlas, v2-vs-v3 tail sheet (via the peregrine preview script)
"$B" -b --factory-startup -P s8_vat.py 2>&1 | grep "starling\|rror"
"$B" -b --factory-startup -P s9_impostor.py 2>&1 | grep "wrote\|rror"
"$B" -b --factory-startup -P p6_render.py -- tail 2>&1 | grep "measurements\|rror"
python p6_compose.py tail
