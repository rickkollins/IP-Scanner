# Forge CAD

A parametric 3D CAD modeler that runs in the browser. You build parts from a
feature history (sketch → extrude, revolve, holes, booleans, patterns…), like
Onshape or SolidWorks. Every feature stays editable, and the model rebuilds when
you change one.

**STL files come in as real solids.** An imported STL, OBJ or PLY becomes a
closed solid part, not a display-only polygon shell. You can drill it, cut it,
join it to sketched geometry, pattern it, split it, measure its volume and
export the result. Broken meshes (flipped triangles, small holes, inside-out
files) are repaired automatically on import.

The geometry kernel is [Manifold](https://github.com/elalish/manifold) (C++
compiled to WebAssembly), which gives exact, watertight boolean results on
triangle meshes. Rendering uses [three.js](https://threejs.org/).

## Running it

You need [Node.js](https://nodejs.org/) 18 or newer.

```bash
cd cad
npm install
npm run dev          # opens a dev server at http://localhost:5173
```

To build:

```bash
npm run build         # static site in cad/dist/ (host it anywhere)
npm run build:single  # one self-contained file: cad/dist-single/index.html
```

The single-file build includes everything, including the WebAssembly kernel, so
you can double-click `index.html` to open it from disk with no server.

Your work is autosaved in the browser (IndexedDB) and restored on the next
visit. Use **File → Save project** to keep a `.forge.json` file. Imported meshes
are stored inside it.

## Features

**Modeling (all parametric, in the feature history)**

| Feature | What it does |
| --- | --- |
| Sketch | 2D sketch on Top / Front / Right planes (with offset) or on any flat face of a part |
| Extrude | One side, flipped, symmetric or two sides; through-all cuts; taper and twist; thin walls; filleted or chamfered top and bottom edges; pick individual sketch regions |
| Revolve | Around the sketch's vertical or horizontal axis or a construction line; full or partial angle |
| Hole | Click a face to place it: simple, counterbore or countersink; blind or through-all |
| Primitives | Box, cylinder, sphere, cone, torus, tube, wedge |
| Boolean | Union, subtract, intersect, optionally keeping the tool parts |
| Move / Rotate | Numeric entry or a drag gizmo; scale; move a copy |
| Mirror, linear pattern, circular pattern | Merge the copies into the part or keep them as separate parts; 2D grid patterns |
| Split | Cut parts with a plane and keep one or both halves |
| Convex hull, Smooth, Simplify | Hull of parts; subdivision smoothing; mesh decimation for heavy imports |
| Import mesh | STL (binary and ASCII), OBJ, PLY with unit conversion (mm, cm, m, in) and auto-placement |

Each body-making feature can create a **new part**, **add to**, **remove
from** or **intersect with** existing parts, so multi-part designs work like
Onshape's part studios.

**Sketcher:** line/polyline, corner and centre rectangles, circle, 3-point arc,
polygon, slot, point and construction geometry. Snapping to endpoints, midpoints,
centres, the origin, the grid and horizontal or vertical. Type a number while drawing
for an exact length, size or diameter. Select an entity to edit its dimensions
numerically, and drag points or shapes to move them. **Use part section** traces the
outline of parts where they cross the sketch plane. Nested loops become holes.
You can round every corner of the profile.

**History:** edit any feature (double-click), rename, suppress, reorder (drag
or right-click), delete, and drag the **rollback bar** to see the model at an
earlier step or insert features there. Full undo and redo.

**Inspection:** volume, surface area, mass (with a material list), bounding size,
centre of mass, triangle count and through-hole count for the selection; a
distance measuring tool that snaps to corners; a section view with capped
cut faces.

**View:** orbit, pan and zoom to the cursor; view cube; standard views;
perspective or orthographic; shaded, shaded with edges, wireframe and X-ray;
light and dark themes.

**Export:** STL (binary or ASCII), OBJ and glTF (.glb), for the selected
parts or all visible parts.

## Mouse and keys

| Input | Action |
| --- | --- |
| Left-drag / right-drag / wheel | Orbit / pan / zoom |
| Click, Shift+click | Select parts |
| Double-click a part or feature | Edit the feature |
| Shift+S, Shift+E, Shift+W, Shift+H | Sketch, extrude, revolve, hole |
| M (then W / E) | Move dialog (translate / rotate gizmo) |
| Shift+M | Measure |
| F | Zoom to fit |
| 0 1 3 7 | Iso, front, right, top views |
| Ctrl+Z, Ctrl+Shift+Z | Undo, redo |
| Ctrl+S, Ctrl+O, Ctrl+I | Save, open, import |
| In a sketch: L R C A P S O, X | Drawing tools, construction toggle |

Press the **?** button in the app for the full list.

## Limitations

Forge CAD models solids as precise triangle meshes, not as NURBS boundary
representations (B-rep) like Onshape, SolidWorks or Fusion. That is what lets
STL files act as first-class solids, but it means:

- Curves are faceted. The **Draft / Normal / Fine** setting controls how finely.
- Fillets and chamfers are applied to extrusion edges, not to arbitrary
  selected edges of a finished part.
- STEP and IGES (B-rep formats) can't be imported. Convert them to STL first.
- Sketches use numeric dimensions on each entity rather than a full
  geometric-constraint solver.
- There is no loft, sweep, shell (except thin-wall extrudes), assemblies or
  drawings.

## Development

```bash
npm test   # geometry kernel, features, sketches, file formats and repair
```

The source code layout:

- `src/core/`: the modeling engine (no DOM): features, regeneration with
  per-feature caching, sketches, mesh repair, and file formats.
- `src/app/`: the user interface: viewport, sketcher, panels and file handling.
