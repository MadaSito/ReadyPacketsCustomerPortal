#!/usr/bin/env python3
"""mount-feature.py <featureDir> — registers client/src/features/<dir>/routes `<dir>Feature` in the registry."""
import sys
d=sys.argv[1]; p='client/src/app/registry.ts'; s=open(p).read()
imp=f'import {{ {d}Feature }} from "@/features/{d}/routes";\n'
if imp not in s:
    s=s.replace('\nexport const FEATURES', imp+'\nexport const FEATURES',1)
    s=s.replace('];\n\nexport const ROUTE_WRAPPERS', f'  {d}Feature,\n];\n\nexport const ROUTE_WRAPPERS',1)
    open(p,'w').write(s)
