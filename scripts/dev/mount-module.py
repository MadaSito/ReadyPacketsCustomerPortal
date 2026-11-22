#!/usr/bin/env python3
"""mount.py <moduleDir> <serviceKey> <Pascal> [routerKey]  — wires a server module into container, root router, schema index."""
import sys,os
d,key,P=sys.argv[1:4]; rk=sys.argv[4] if len(sys.argv)>4 else d
p='server/container.ts'; s=open(p).read()
imp=f'import {{ create{P}Module, type {P}Module }} from "./modules/{d}/index.js";\n'
if imp not in s:
    a='\nexport interface ModuleRegistry {'
    s=s.replace(a, imp.rstrip('\n')+'\n'+a,1) if False else s.replace('\n\nexport interface ModuleRegistry {', '\n'+imp+'\nexport interface ModuleRegistry {',1)
    s=s.replace('\n}\n\n/** Everything a request handler can reach', f'\n  {key}: {P}Module;\n}}\n\n/** Everything a request handler can reach',1)
    s=s.replace('  services.sessionResolver = {', f'  services.{key} = create{P}Module(deps);\n  services.sessionResolver = {{',1)
    s=s.replace('  ];\n  services.allModules = modules;', f'    services.{key},\n  ];\n  services.allModules = modules;',1)
    open(p,'w').write(s)
p='server/trpc/root.ts'; s=open(p).read()
imp=f'import {{ {rk}Router }} from "../modules/{d}/router.js";\n'
if imp not in s and os.path.exists(f'server/modules/{d}/router.ts'):
    s=s.replace('\nexport const appRouter = router({', imp+'\nexport const appRouter = router({',1)
    s=s.replace('});\n\nexport type AppRouter', f'  {rk}: {rk}Router,\n}});\n\nexport type AppRouter',1)
    open(p,'w').write(s)
p='server/db/schema/index.ts'; s=open(p).read()
line=f'export * from "../../modules/{d}/schema.js";\n'
if line not in s and os.path.exists(f'server/modules/{d}/schema.ts'):
    s=s.replace('export * from "../../security/rateLimiterSchema.js";', line+'export * from "../../security/rateLimiterSchema.js";',1); open(p,'w').write(s)
