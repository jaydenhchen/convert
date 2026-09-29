# 3D PDF to STL

A local web converter for Acrobat 3D PDFs that contain an embedded PRC model. It extracts the PRC stream, converts the tessellated surface to GLB, and writes a binary STL without reducing the object to the PDF page rectangle.

## Run locally

```sh
npm install
npm start
```

Open <http://localhost:3000> and upload a PRC-based 3D PDF. The server keeps the upload in memory for the conversion; it does not write uploaded PDFs to disk.

## GitHub Pages

The GitHub Pages build runs conversion entirely in the browser:

```sh
npm run build:pages
```

The included `.github/workflows/deploy-pages.yml` workflow publishes the generated `dist` directory. GitHub Pages cannot run the Node upload server, so the Pages build uses the browser WebAssembly converter instead.

The current upload limit is 100 MB. The input must be a real 3D PDF with a `/Subtype /PRC` 3D stream, such as the supplied SolidWorks/Acrobat file. Ordinary 2D PDFs and 3D PDFs using U3D are rejected with an explanation rather than producing a fake box.

## Viewer controls

The generated STL is shown in an interactive viewer before download:

- `1` / `2`: front / back
- `3` / `4`: top / bottom
- `5` / `6`: left / right
- `H`: return to the home/isometric view
- `O`: switch orthographic and perspective projection
- `F`: fit the model
- `X`: toggle the cross-section plane
- `[` / `]`: rotate the current view left/right by 90°
- `R`: flip the current view by 180°
- Drag to orbit, scroll to zoom, right-drag to pan
- Click a flat mesh face to align the camera parallel to that face; curved or faceted surfaces align to the clicked triangle.

The section controls let you choose the `YZ`, `XZ`, or `XY` plane, move it through the model, and flip between the high and low side of the cut. Cross sections are capped with generated solid faces, including separate loops and interior holes where the STL intersection supports them. Section hatching is generated as uniform 45° inspection lines. The theme toggle switches between light and dark UI themes.

Mechanical drawing settings provide mutually exclusive `Shaded`, `Shaded + outlines`, `Wireframe`, and `Hidden lines` styles. Hidden lines use mesh sharp-edge filtering plus depth testing so occluded edges are dashed instead of every triangulation edge being shown. Independent overlay checkboxes enable center lines, center marks, section hatching, projection lines, origin axes, and the bounding box.

Center-line and center-mark overlays use a heuristic circular-feature estimator. It fits circles to well-supported polygon vertex rings in the three principal planes; it cannot prove CAD intent or reliably identify every hole from an arbitrary STL. These are inspection aids generated from the tessellated mesh, not dimensionally annotated drafting views. STL has no units, so confirm scale in the slicer before printing.

## Implementation

- `server.mjs`: upload API and static web server
- `converter.mjs`: PDF PRC extraction, PRC→GLB conversion, GLB triangle traversal, binary STL writing
- `public/app.js`: upload flow and Three.js viewer
