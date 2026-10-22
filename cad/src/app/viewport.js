// 3D viewport: scene, cameras, picking, view cube, section view and gizmo.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { meshFromManifold } from '../core/kernel.js';

// BVH-accelerated picking keeps hover responsive on large imported meshes.
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

export const PALETTE = ['#7ea6d8', '#e0a27c', '#8fc98a', '#d8c070', '#ad94d6', '#6fc2b8', '#e392b0', '#a3a9b4'];

const VIEWS = {
  front: { dir: [0, -1, 0], up: [0, 0, 1] },
  back: { dir: [0, 1, 0], up: [0, 0, 1] },
  right: { dir: [1, 0, 0], up: [0, 0, 1] },
  left: { dir: [-1, 0, 0], up: [0, 0, 1] },
  top: { dir: [0, 0, 1], up: [0, 1, 0] },
  bottom: { dir: [0, 0, -1], up: [0, -1, 0] },
  iso: { dir: [1, -1, 0.85], up: [0, 0, 1] },
};

export class Viewport {
  constructor(container, { onPointer, onCameraChange } = {}) {
    this.container = container;
    this.onPointer = onPointer || (() => {});
    this.onCameraChange = onCameraChange || (() => {});
    this.bodyViews = new Map(); // bodyId -> { manifold, group, mesh, back, edges, data }
    this.displayMode = 'edges';
    this.section = { enabled: false, axis: 'X', offset: 0, flip: false };

    const renderer = (this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true }));
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.localClippingEnabled = true;
    container.appendChild(renderer.domElement);
    renderer.domElement.classList.add('gl');

    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'labels';
    container.appendChild(this.labels.domElement);

    const scene = (this.scene = new THREE.Scene());
    THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

    this.persp = new THREE.PerspectiveCamera(40, 1, 0.1, 100000);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -100000, 100000);
    for (const c of [this.persp, this.ortho]) c.up.set(0, 0, 1);
    this.camera = this.persp;
    this.camera.position.set(120, -160, 110);

    const controls = (this.controls = new OrbitControls(this.camera, renderer.domElement));
    controls.enableDamping = true;
    controls.dampingFactor = 0.18;
    controls.zoomToCursor = true;
    controls.screenSpacePanning = true;
    controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    controls.addEventListener('change', () => this.onCameraChange());

    // Lights follow the camera so the model is always lit from the viewer.
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8890a0, 1.6));
    this.keyLight = new THREE.DirectionalLight(0xffffff, 1.5);
    this.keyLight.position.set(1, -1, 2);
    this.camera.add(this.keyLight);
    this.fillLight = new THREE.DirectionalLight(0xffffff, 0.5);
    this.fillLight.position.set(-2, 1, -1);
    this.camera.add(this.fillLight);
    scene.add(this.persp, this.ortho);

    this.world = new THREE.Group();
    this.bodiesGroup = new THREE.Group();
    this.sketchGroup = new THREE.Group();
    this.overlay = new THREE.Group();
    scene.add(this.world, this.bodiesGroup, this.sketchGroup, this.overlay);
    this.buildGrid(10);
    this.buildAxes();

    this.sectionPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);

    this.hoverFace = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: 0x2f7cf6, transparent: true, opacity: 0.35, depthTest: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide }));
    this.hoverFace.visible = false;
    this.hoverFace.renderOrder = 5;
    this.overlay.add(this.hoverFace);

    this.gizmo = new TransformControls(this.camera, renderer.domElement);
    this.gizmo.setSize(0.9);
    this.gizmoHelper = this.gizmo.getHelper();
    scene.add(this.gizmoHelper);
    this.gizmo.addEventListener('dragging-changed', (e) => { controls.enabled = !e.value; });
    this.gizmoProxy = new THREE.Object3D();
    this.gizmoProxy.rotation.order = 'ZYX';
    scene.add(this.gizmoProxy);

    this.raycaster = new THREE.Raycaster();
    this.raycaster.params.Line.threshold = 0.5;
    this.pointer = new THREE.Vector2();
    this.setupPointer();
    this.setupViewCube();
    this.applyTheme();

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    const loop = () => {
      requestAnimationFrame(loop);
      this.tick();
    };
    loop();
  }

  // --- scene furniture ---------------------------------------------------------------------

  applyTheme() {
    const dark = document.documentElement.dataset.theme === 'dark';
    this.dark = dark;
    this.renderer.setClearColor(dark ? 0x1b1f27 : 0xf3f6fa, 1);
    this.gridColors = dark ? [0x3a414f, 0x2a303b] : [0xc4cedb, 0xdfe5ed];
    this.buildGrid(this.gridStep || 10, true);
    this.edgeColor = dark ? 0x0d1016 : 0x29313d;
    for (const v of this.bodyViews.values()) v.edges && (v.edges.material.color.setHex(this.edgeColor));
  }

  buildGrid(step, force) {
    if (!force && step === this.gridStep) return;
    this.gridStep = step;
    if (this.grid) { this.world.remove(this.grid); this.grid.geometry.dispose(); }
    const n = 50;
    const half = step * n;
    const pos = [], col = [];
    const major = new THREE.Color(this.gridColors?.[0] ?? 0xc4cedb), minor = new THREE.Color(this.gridColors?.[1] ?? 0xdfe5ed);
    for (let i = -n; i <= n; i++) {
      const c = i % 10 === 0 ? major : minor;
      if (i === 0) continue;
      pos.push(-half, i * step, 0, half, i * step, 0, i * step, -half, 0, i * step, half, 0);
      for (let k = 0; k < 4; k++) col.push(c.r, c.g, c.b);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    this.grid = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false }));
    this.grid.renderOrder = -1;
    this.world.add(this.grid);
  }

  buildAxes() {
    const L = 1e4;
    const mk = (a, b, color) => {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...a), new THREE.Vector3(...b)]);
      const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.8, depthWrite: false }));
      line.renderOrder = -1;
      return line;
    };
    this.axes = new THREE.Group();
    this.axes.add(mk([-L, 0, 0], [L, 0, 0], 0xe5484d), mk([0, -L, 0], [0, L, 0], 0x30a46c), mk([0, 0, 0], [0, 0, L / 100], 0x3e7bfa));
    this.world.add(this.axes);
  }

  setGridVisible(v) { this.world.visible = v; }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    this.persp.aspect = w / h;
    this.persp.updateProjectionMatrix();
    this.updateOrtho();
  }

  updateOrtho() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    const d = this.camera.position.distanceTo(this.controls.target);
    const halfH = d * Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2));
    if (this.camera === this.ortho) {
      this.ortho.left = -halfH * (w / h); this.ortho.right = halfH * (w / h);
      this.ortho.top = halfH; this.ortho.bottom = -halfH;
      this.ortho.updateProjectionMatrix();
    }
  }

  setProjection(kind) {
    const target = kind === 'ortho' ? this.ortho : this.persp;
    if (target === this.camera) return;
    const from = this.camera;
    target.position.copy(from.position);
    target.quaternion.copy(from.quaternion);
    target.up.copy(from.up);
    if (kind === 'ortho') {
      this.camera = target;
      target.zoom = 1;
      this.updateOrtho();
    } else {
      // Convert ortho zoom back into a camera distance.
      const dir = new THREE.Vector3().subVectors(from.position, this.controls.target);
      dir.multiplyScalar(1 / (from.zoom || 1));
      target.position.copy(this.controls.target).add(dir);
      this.camera = target;
    }
    from.remove(this.keyLight, this.fillLight);
    target.add(this.keyLight, this.fillLight);
    this.controls.object = target;
    this.gizmo.camera = target;
    this.controls.update();
  }

  // --- render loop -------------------------------------------------------------------------

  tick() {
    if (this.anim) {
      const t = Math.min(1, (performance.now() - this.anim.start) / this.anim.duration);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      this.camera.position.lerpVectors(this.anim.fromPos, this.anim.toPos, e);
      this.controls.target.lerpVectors(this.anim.fromTarget, this.anim.toTarget, e);
      this.camera.up.lerpVectors(this.anim.fromUp, this.anim.toUp, e).normalize();
      if (this.camera === this.ortho) this.ortho.zoom = THREE.MathUtils.lerp(this.anim.fromZoom, this.anim.toZoom, e);
      this.camera.lookAt(this.controls.target);
      this.updateOrtho();
      if (t >= 1) { this.anim = null; this.onCameraChange(); }
    }
    this.controls.update();
    // Adaptive grid spacing.
    const d = this.camera.position.distanceTo(this.controls.target) / (this.camera.zoom || 1);
    const step = Math.pow(10, Math.max(-1, Math.floor(Math.log10(d / 8))));
    this.buildGrid(step);
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
    this.renderCube();
  }

  // --- camera views --------------------------------------------------------------------------

  animateTo(pos, target, up, zoom) {
    this.anim = {
      start: performance.now(), duration: 380,
      fromPos: this.camera.position.clone(), toPos: pos,
      fromTarget: this.controls.target.clone(), toTarget: target,
      fromUp: this.camera.up.clone(), toUp: up,
      fromZoom: this.camera.zoom || 1, toZoom: zoom ?? (this.camera.zoom || 1),
    };
  }

  setView(name, box) {
    const v = VIEWS[name];
    this.lookAlong(new THREE.Vector3(...v.dir), new THREE.Vector3(...v.up), box);
  }

  lookAlong(dir, up, box) {
    dir = dir.clone().normalize();
    const { center, radius } = this.frameOf(box);
    const dist = radius / Math.sin(THREE.MathUtils.degToRad(this.persp.fov / 2)) * 1.05;
    const pos = center.clone().add(dir.multiplyScalar(dist));
    this.animateTo(pos, center, up.clone().normalize(), 1);
  }

  frameOf(box) {
    if (!box || box.isEmpty()) {
      box = new THREE.Box3();
      for (const v of this.bodyViews.values()) if (v.group.visible) box.expandByObject(v.mesh);
      if (box.isEmpty()) box.set(new THREE.Vector3(-50, -50, 0), new THREE.Vector3(50, 50, 30));
    }
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    return { center: sphere.center, radius: Math.max(sphere.radius, 1) };
  }

  fit(box) {
    const dir = new THREE.Vector3().subVectors(this.camera.position, this.controls.target);
    this.lookAlong(dir, this.camera.up, box);
  }

  // --- bodies ----------------------------------------------------------------------------------

  /** Make the scene match the model's bodies. */
  syncBodies(bodies, props, { selected = new Set(), hidden = new Set(), highlight = new Set() } = {}) {
    const seen = new Set();
    let i = 0;
    for (const body of bodies.values()) {
      seen.add(body.id);
      let view = this.bodyViews.get(body.id);
      if (!view || view.manifold !== body.manifold) {
        if (view) this.disposeView(view);
        view = this.createView(body);
        this.bodyViews.set(body.id, view);
      }
      const color = props[body.id]?.color || PALETTE[i % PALETTE.length];
      view.baseColor = color;
      view.group.visible = !hidden.has(body.id);
      view.selected = selected.has(body.id);
      view.highlight = highlight.has(body.id);
      this.styleView(view);
      i++;
    }
    for (const [id, view] of this.bodyViews) {
      if (!seen.has(id)) { this.disposeView(view); this.bodyViews.delete(id); }
    }
  }

  createView(body) {
    const data = meshFromManifold(body.manifold);
    const indexed = new THREE.BufferGeometry();
    indexed.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    indexed.setIndex(new THREE.BufferAttribute(data.indices, 1));
    const geometry = toCreasedNormals(indexed, THREE.MathUtils.degToRad(32));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    geometry.computeBoundsTree();
    const material = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.05, roughness: 0.55, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, side: THREE.FrontSide });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.bodyId = body.id;
    const back = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: 0xff7043, side: THREE.BackSide }));
    back.visible = false;
    back.raycast = () => {};
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(indexed, 28),
      new THREE.LineBasicMaterial({ color: this.edgeColor ?? 0x29313d, transparent: true, opacity: 0.85 }),
    );
    edges.raycast = () => {};
    const group = new THREE.Group();
    group.add(mesh, back, edges);
    this.bodiesGroup.add(group);
    return { id: body.id, manifold: body.manifold, group, mesh, back, edges, data, indexed };
  }

  disposeView(view) {
    this.bodiesGroup.remove(view.group);
    view.mesh.geometry.disposeBoundsTree?.();
    view.mesh.geometry.dispose();
    view.indexed.dispose();
    view.edges.geometry.dispose();
    view.mesh.material.dispose();
    view.back.material.dispose();
    view.edges.material.dispose();
  }

  styleView(view) {
    const m = view.mesh.material;
    const color = new THREE.Color(view.baseColor);
    if (view.selected) color.lerp(new THREE.Color(0x2f7cf6), 0.55);
    else if (view.highlight) color.lerp(new THREE.Color(0x2f7cf6), 0.25);
    m.color.copy(color);
    m.emissive.setHex(view.selected ? 0x0b2a66 : 0x000000);
    const mode = this.displayMode;
    m.wireframe = mode === 'wire';
    m.transparent = mode === 'xray';
    m.opacity = mode === 'xray' ? 0.35 : 1;
    m.depthWrite = mode !== 'xray';
    view.edges.visible = mode === 'edges' || mode === 'xray';
    view.edges.material.color.setHex(view.selected ? 0x1554c9 : this.edgeColor ?? 0x29313d);
    const clip = this.section.enabled ? [this.sectionPlane] : [];
    m.clippingPlanes = clip;
    view.edges.material.clippingPlanes = clip;
    view.back.material.clippingPlanes = clip;
    view.back.visible = this.section.enabled && mode !== 'wire';
    view.back.material.color.copy(new THREE.Color(view.baseColor).multiplyScalar(0.6));
    m.needsUpdate = true;
  }

  restyle() {
    for (const v of this.bodyViews.values()) this.styleView(v);
  }

  setDisplayMode(mode) {
    this.displayMode = mode;
    this.restyle();
  }

  setSection(section) {
    Object.assign(this.section, section);
    const n = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] }[this.section.axis];
    const s = this.section.flip ? 1 : -1;
    this.sectionPlane.normal.set(n[0] * s, n[1] * s, n[2] * s);
    this.sectionPlane.constant = -s * this.section.offset;
    this.restyle();
  }

  modelBox(ids) {
    const box = new THREE.Box3();
    for (const [id, v] of this.bodyViews) if (!ids || ids.has(id)) box.expandByObject(v.mesh);
    return box;
  }

  // --- picking ---------------------------------------------------------------------------------

  setPointerFromEvent(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return this.raycaster.ray;
  }

  /** Raycast bodies. Returns { bodyId, point, normal, triangle, view } or null. */
  pickBody(e) {
    this.setPointerFromEvent(e);
    const meshes = [...this.bodyViews.values()].filter((v) => v.group.visible).map((v) => v.mesh);
    let hits = this.raycaster.intersectObjects(meshes, false);
    if (this.section.enabled) hits = hits.filter((h) => this.sectionPlane.distanceToPoint(h.point) >= -1e-6);
    const hit = hits[0];
    if (!hit) return null;
    const view = this.bodyViews.get(hit.object.userData.bodyId);
    const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    // Flat face normal from the triangle itself (vertex normals are creased).
    const { positions, indices } = view.data;
    const t = hit.faceIndex;
    const a = new THREE.Vector3().fromArray(positions, indices[t * 3] * 3);
    const b = new THREE.Vector3().fromArray(positions, indices[t * 3 + 1] * 3);
    const c = new THREE.Vector3().fromArray(positions, indices[t * 3 + 2] * 3);
    const faceNormal = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
    return { bodyId: view.id, point: hit.point, normal: faceNormal.lengthSq() ? faceNormal : normal, triangle: t, view, corners: [a, b, c] };
  }

  /** Nearest mesh vertex to the hit, if it is within `px` pixels on screen. */
  snapVertex(hit, px = 12) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const toScreen = (p) => { const v = p.clone().project(this.camera); return new THREE.Vector2((v.x + 1) * r.width / 2, (1 - v.y) * r.height / 2); };
    const ref = toScreen(hit.point);
    let best = null, bestD = px;
    for (const c of hit.corners) {
      const d = toScreen(c).distanceTo(ref);
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  }

  /** Coplanar, connected triangles around `triangle` (the face a click lands on). */
  planarFace(view, triangle) {
    if (!view.faces) view.faces = computePlanarFaces(view.data);
    const id = view.faces.groupOf[triangle];
    return { id, tris: view.faces.groups[id] };
  }

  showHoverFace(hit) {
    if (!hit) { this.hoverFace.visible = false; return null; }
    const face = this.planarFace(hit.view, hit.triangle);
    const key = `${hit.view.id}:${face.id}:${hit.view.manifold && hit.view.data.indices.length}`;
    if (this.hoverKey !== key) {
      this.hoverKey = key;
      const { positions, indices } = hit.view.data;
      const pos = new Float32Array(face.tris.length * 9);
      face.tris.forEach((t, i) => {
        for (let k = 0; k < 3; k++) pos.set(positions.subarray(indices[t * 3 + k] * 3, indices[t * 3 + k] * 3 + 3), i * 9 + k * 3);
      });
      this.hoverFace.geometry.dispose();
      this.hoverFace.geometry = new THREE.BufferGeometry();
      this.hoverFace.geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    }
    this.hoverFace.visible = true;
    return face;
  }

  /** Intersect the pointer ray with a plane given as THREE.Plane. */
  pickPlane(e, plane) {
    const ray = this.setPointerFromEvent(e);
    return ray.intersectPlane(plane, new THREE.Vector3());
  }

  /** World units per screen pixel at a world point. */
  worldPerPixel(point) {
    const h = this.renderer.domElement.clientHeight;
    if (this.camera === this.ortho) return (this.ortho.top - this.ortho.bottom) / this.ortho.zoom / h;
    const d = this.camera.position.distanceTo(point);
    return (2 * d * Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2))) / h;
  }

  setupPointer() {
    const el = this.renderer.domElement;
    let down = null;
    el.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY, button: e.button };
      this.onPointer('down', e);
    });
    el.addEventListener('pointermove', (e) => {
      const dragging = down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4;
      this.onPointer(dragging ? 'drag' : 'move', e);
    });
    el.addEventListener('pointerup', (e) => {
      const click = down && Math.hypot(e.clientX - down.x, e.clientY - down.y) <= 4;
      this.onPointer('up', e);
      if (click && !this.gizmo.dragging) this.onPointer('click', e);
      down = null;
    });
    el.addEventListener('dblclick', (e) => this.onPointer('dblclick', e));
    el.addEventListener('pointerleave', (e) => this.onPointer('leave', e));
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // --- labels ------------------------------------------------------------------------------------

  label(text, position, cls = 'tag') {
    const div = document.createElement('div');
    div.className = cls;
    div.textContent = text;
    const obj = new CSS2DObject(div);
    obj.position.copy(position);
    return obj;
  }

  // --- gizmo ---------------------------------------------------------------------------------------

  attachGizmo(pivot, mode, onChange, onEnd) {
    this.detachGizmo();
    this.gizmoProxy.position.copy(pivot);
    this.gizmoProxy.rotation.set(0, 0, 0);
    this.gizmoPivot = pivot.clone();
    this.gizmo.attach(this.gizmoProxy);
    this.gizmo.setMode(mode);
    this.gizmo.setTranslationSnap(1);
    this.gizmo.setRotationSnap(THREE.MathUtils.degToRad(5));
    this.gizmoChange = () => onChange(this.gizmoProxy.position.clone().sub(this.gizmoPivot), this.gizmoProxy.rotation.clone());
    this.gizmoEnd = (e) => { if (!e.value) onEnd?.(); };
    this.gizmo.addEventListener('objectChange', this.gizmoChange);
    this.gizmo.addEventListener('dragging-changed', this.gizmoEnd);
  }

  setGizmoState(translate, rotateDeg) {
    if (!this.gizmo.object) return;
    this.gizmoProxy.position.copy(this.gizmoPivot).add(translate);
    this.gizmoProxy.rotation.set(...rotateDeg.map((d) => THREE.MathUtils.degToRad(d)), 'ZYX');
  }

  detachGizmo() {
    if (this.gizmoChange) this.gizmo.removeEventListener('objectChange', this.gizmoChange);
    if (this.gizmoEnd) this.gizmo.removeEventListener('dragging-changed', this.gizmoEnd);
    this.gizmoChange = this.gizmoEnd = null;
    this.gizmo.detach();
  }

  // --- view cube ---------------------------------------------------------------------------------------

  setupViewCube() {
    const size = 112;
    const canvas = document.createElement('canvas');
    canvas.className = 'viewcube';
    this.container.appendChild(canvas);
    const r = (this.cubeRenderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true }));
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.setSize(size, size);
    this.cubeScene = new THREE.Scene();
    this.cubeCamera = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 10);
    this.cubeCamera.up.set(0, 0, 1);
    // BoxGeometry face order: +X, -X, +Y, -Y, +Z, -Z.
    const faces = [['RIGHT', 'right'], ['LEFT', 'left'], ['BACK', 'back'], ['FRONT', 'front'], ['TOP', 'top'], ['BOTTOM', 'bottom']];
    this.cubeFaces = faces;
    const mats = faces.map(([label]) => new THREE.MeshBasicMaterial({ map: this.faceTexture(label) }));
    this.cube = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), mats);
    // Rotate the face textures so the text reads upright from each standard view.
    this.cubeScene.add(this.cube);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(this.cube.geometry), new THREE.LineBasicMaterial({ color: 0x5a6576 }));
    this.cubeScene.add(edges);
    const axis = (d, c) => {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-1, -1, -1), new THREE.Vector3(-1, -1, -1).add(new THREE.Vector3(...d).multiplyScalar(2.6))]);
      return new THREE.Line(g, new THREE.LineBasicMaterial({ color: c }));
    };
    this.cubeScene.add(axis([1, 0, 0], 0xe5484d), axis([0, 1, 0], 0x30a46c), axis([0, 0, 1], 0x3e7bfa));
    const ray = new THREE.Raycaster();
    const pickFace = (e) => {
      const b = canvas.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - b.left) / b.width) * 2 - 1, -((e.clientY - b.top) / b.height) * 2 + 1), this.cubeCamera);
      const hit = ray.intersectObject(this.cube)[0];
      return hit ? hit : null;
    };
    canvas.addEventListener('pointermove', (e) => {
      const hit = pickFace(e);
      mats.forEach((m, i) => m.color.setHex(hit && Math.floor(hit.faceIndex / 2) === i ? 0xbcd4ff : 0xffffff));
    });
    canvas.addEventListener('pointerleave', () => mats.forEach((m) => m.color.setHex(0xffffff)));
    canvas.addEventListener('click', (e) => {
      const hit = pickFace(e);
      if (!hit) return;
      // Clicking near a corner or edge picks the diagonal view.
      const p = hit.point;
      const dir = new THREE.Vector3(...[p.x, p.y, p.z].map((x) => (Math.abs(x) > 0.55 ? Math.sign(x) : 0)));
      const up = Math.abs(dir.z) > 0.5 && Math.abs(dir.x) < 0.5 && Math.abs(dir.y) < 0.5 ? new THREE.Vector3(0, dir.z > 0 ? 1 : -1, 0) : new THREE.Vector3(0, 0, 1);
      this.lookAlong(dir, up);
    });
  }

  faceTexture(label) {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = '#eef2f8';
    g.fillRect(0, 0, 128, 128);
    g.strokeStyle = '#b8c3d3';
    g.lineWidth = 6;
    g.strokeRect(0, 0, 128, 128);
    g.fillStyle = '#334055';
    g.font = '600 25px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(label, 64, 66);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
  }

  renderCube() {
    const dir = new THREE.Vector3().subVectors(this.camera.position, this.controls.target).normalize();
    this.cubeCamera.position.copy(dir.multiplyScalar(5));
    this.cubeCamera.up.copy(this.camera.up);
    this.cubeCamera.lookAt(0, 0, 0);
    this.cubeRenderer.render(this.cubeScene, this.cubeCamera);
  }
}

/** Group triangles into planar faces (connected, same plane). */
function computePlanarFaces({ positions, indices }) {
  const nTri = indices.length / 3;
  const normals = new Float32Array(nTri * 3);
  const dists = new Float32Array(nTri);
  for (let t = 0; t < nTri; t++) {
    const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    normals[t * 3] = nx; normals[t * 3 + 1] = ny; normals[t * 3 + 2] = nz;
    dists[t] = nx * positions[a] + ny * positions[a + 1] + nz * positions[a + 2];
  }
  const edgeMap = new Map();
  for (let t = 0; t < nTri; t++) {
    for (let k = 0; k < 3; k++) {
      const i = indices[t * 3 + k], j = indices[t * 3 + ((k + 1) % 3)];
      const key = i < j ? i * 4294967296 + j : j * 4294967296 + i;
      const list = edgeMap.get(key);
      if (list) list.push(t); else edgeMap.set(key, [t]);
    }
  }
  const groupOf = new Int32Array(nTri).fill(-1);
  const groups = [];
  for (let s = 0; s < nTri; s++) {
    if (groupOf[s] >= 0) continue;
    const id = groups.length;
    const tris = [s];
    groupOf[s] = id;
    for (let q = 0; q < tris.length; q++) {
      const t = tris[q];
      for (let k = 0; k < 3; k++) {
        const i = indices[t * 3 + k], j = indices[t * 3 + ((k + 1) % 3)];
        const key = i < j ? i * 4294967296 + j : j * 4294967296 + i;
        for (const u of edgeMap.get(key)) {
          if (groupOf[u] >= 0) continue;
          const dot = normals[u * 3] * normals[s * 3] + normals[u * 3 + 1] * normals[s * 3 + 1] + normals[u * 3 + 2] * normals[s * 3 + 2];
          if (dot > 0.9995 && Math.abs(dists[u] - dists[s]) < 1e-3) { groupOf[u] = id; tris.push(u); }
        }
      }
    }
    groups.push(tris);
  }
  return { groupOf, groups };
}
