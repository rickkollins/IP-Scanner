# Maker Studio

A browser app for 3D printing, laser engraving and CNC carving. Its page and dialog layout follows
Snapmaker Luban's: a Home page, three editors, a machine-control Workspace and Settings. All of the code,
icons, text and machine names are original. It doesn't use any Luban or Snapmaker branding or assets.

There's no build step and nothing to install. Open `index.html` in a browser, or serve the folder:

```bash
python3 -m http.server -d luban-clone 8000
```

Then go to <http://localhost:8000>. For USB connections, use Chrome or Edge, because they support Web Serial.

## Pages

| Page | What it does |
| --- | --- |
| **Home** | Start tiles for each mode, new/open project, recent projects, case library, tutorials, manual, shortcuts, problem report |
| **3D Printing** | Import STL/OBJ (button or drag-and-drop), add shapes, then move/scale/rotate/mirror/lay flat, auto-arrange, repair, simplify and assign extruders (dual). Pick a material and print profile, generate G-code and step through the layers with line-type toggles. Shows time, filament, weight and cost. You can export G-code/STL/OBJ or send the file to Workspace |
| **Laser** | Design on the material: text, rectangle, ellipse, polygon, star, line, freehand pen, images and SVG import (converted to vectors), plus camera capture for the background. Each object gets a toolpath (vector line or fill, black-and-white fill or greyscale). Preview shows laser-on and travel moves |
| **CNC** | The same canvas with stock setup and Z zero. Toolpaths: on-path, outside or inside outline (with holding tabs), pocket, and greyscale relief. Tools come from a tool library and cut in multiple depth passes |
| **Workspace** | Connect over USB (Web Serial) or the built-in simulator. Has jog/home/set-origin controls, position readout, console with history, G-code file list, toolpath visualizer, start/pause/stop with progress and remaining time, temperature/laser/spindle panels, editable macros and a webcam view |
| **Settings** | General (language, units, theme), Machine, Connection, Profiles & libraries, Software update, Firmware, Download manager, Shortcuts, About |

## Dialogs

Quick setup wizard · New project · Open project · Unsaved changes · Machine settings · Printing profiles
manager · Material manager · Laser parameter library · CNC tool library · Export models · Export G-code ·
Send to device · Connect (Wi-Fi/serial) · Repair model · Simplify model · Auto arrange · Job setup ·
Edit text · Image processing · Toolpath settings · Camera capture · Macro editor · Keyboard shortcuts ·
About · Software update · Firmware update · Case library · Tutorials · Software manual · Report a problem ·
Download manager · Language · Recover unsaved work. There are also generic confirm, alert and prompt dialogs.

## Limits

- The slicer is deliberately simple: perimeters use approximate offsets, infill is lines or a grid, and
  support is columns under overhangs. The G-code is valid Marlin-style output, but check the preview
  before printing anything important.
- Browsers can't scan the local network, so the Wi-Fi tab only lists the simulator. Use USB serial to reach
  a real machine.
- Firmware upload only works on the simulator.
- Projects (`.msproj`, JSON) are downloaded when you save. Recent projects, custom profiles, materials,
  presets, tools and macros are kept in the browser's local storage.

## Code layout

```
index.html          page shell
css/app.css         styles (light and dark)
js/core.js          DOM helpers, dialogs, forms, router, undo history, icons
js/data.js          machines, profiles, materials, laser presets, CNC tools, preferences
js/mesh.js          mesh primitives, STL/OBJ import & export, repair, simplify, lay flat
js/viewport3d.js    canvas 3D renderer with orbit/pan/zoom and picking
js/slicer.js        FDM slicer and G-code writer
js/dialogs.js       all dialogs
js/home.js          Home page and case library
js/printing.js      3D Printing page
js/editor2d.js      Laser and CNC pages (shared editor, toolpaths, G-code)
js/workspace.js     Workspace page, serial/simulated devices, job runner
js/settings.js      Settings page
js/main.js          menu bar, shortcuts, start-up, crash recovery
```
