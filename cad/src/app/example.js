// A small example part that exercises the main features.

export function exampleDocument() {
  const corner = (x, y, i) => ({ id: `h${i}`, type: 'circle', c: [x, y], r: 3 });
  return {
    name: 'Example bracket',
    rollback: null,
    bodyProps: {},
    settings: { quality: 'normal' },
    nextId: 10,
    features: [
      {
        id: 'f1', type: 'sketch', name: 'Base sketch',
        params: {
          plane: { type: 'XY', offset: 0 }, fill: 'EvenOdd', cornerRadius: 0,
          entities: [{ id: 'r1', type: 'rect', a: [0, 0], b: [80, 50] }, corner(8, 8, 1), corner(72, 8, 2), corner(8, 32, 3), corner(72, 32, 4)],
        },
      },
      {
        id: 'f2', type: 'extrude', name: 'Base plate',
        params: { sketch: 'f1', regions: 'all', direction: 'normal', depth: 8, depth2: 5, throughAll: false, taper: 100, twist: 0, thin: 0, edge: 'fillet', edgeSize: 1.5, operation: 'new', targets: [] },
      },
      {
        id: 'f3', type: 'sketch', name: 'Upright sketch',
        params: {
          plane: { type: 'XZ', offset: -50 }, fill: 'EvenOdd', cornerRadius: 0,
          entities: [
            { id: 'u1', type: 'line', a: [0, 0], b: [80, 0] },
            { id: 'u2', type: 'line', a: [80, 0], b: [80, 34] },
            { id: 'u3', type: 'arc', c: [40, 34], r: 40, a0: 0, a1: Math.PI },
            { id: 'u4', type: 'line', a: [0, 34], b: [0, 0] },
            { id: 'u5', type: 'slot', a: [28, 34], b: [52, 34], r: 6 },
          ],
        },
      },
      {
        id: 'f4', type: 'extrude', name: 'Upright',
        params: { sketch: 'f3', regions: 'all', direction: 'normal', depth: 8, depth2: 5, throughAll: false, taper: 100, twist: 0, thin: 0, edge: 'none', edgeSize: 1, operation: 'add', targets: ['f2'] },
      },
      {
        id: 'f5', type: 'hole', name: 'Counterbored hole',
        params: { position: [40, 21, 8], normal: [0, 0, 1], style: 'counterbore', diameter: 6, depth: 10, throughAll: true, cbDiameter: 11, cbDepth: 3, csDiameter: 10, csAngle: 90, targets: ['f2'] },
      },
      {
        id: 'f6', type: 'sketch', name: 'Knob profile',
        params: {
          plane: { type: 'XZ', offset: 0 }, fill: 'EvenOdd', cornerRadius: 0,
          entities: [
            { id: 'k0', type: 'line', a: [-30, -2], b: [-30, 40], construction: true },
            { id: 'k1', type: 'line', a: [-30, 0], b: [-18, 0] },
            { id: 'k2', type: 'line', a: [-18, 0], b: [-18, 4] },
            { id: 'k3', type: 'line', a: [-18, 4], b: [-23, 9] },
            { id: 'k4', type: 'line', a: [-23, 9], b: [-23, 22] },
            { id: 'k5', type: 'arc', c: [-30, 22], r: 7, a0: 0, a1: Math.PI / 2 },
            { id: 'k6', type: 'line', a: [-30, 29], b: [-30, 0] },
          ],
        },
      },
      {
        id: 'f7', type: 'revolve', name: 'Knob',
        params: { sketch: 'f6', axis: 'construction', angle: 360, flip: false, operation: 'new', targets: [] },
      },
      {
        id: 'f8', type: 'linearPattern', name: 'Knob pattern',
        params: { bodies: ['f7'], axis: 'Y', count: 2, spacing: 35, axis2: 'none', count2: 2, spacing2: 25, merge: false },
      },
    ],
  };
}
