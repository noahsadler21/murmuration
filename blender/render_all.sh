#!/bin/sh
B="/c/Program Files/Blender Foundation/Blender 5.2/blender.exe"
cd "$(dirname "$0")"
for w in "$@"; do "$B" -b --factory-startup -P s6_render.py -- $w 2>&1 | grep "Traceback\|Error:\|done"; python compose_sheets.py $w; done
echo ALLDONE
