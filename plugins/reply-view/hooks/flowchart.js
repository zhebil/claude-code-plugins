import { SHAPE_CORNERS } from './mermaid.bundle.mjs'

const UP = 1
const DOWN = 2
const LEFT = 4
const RIGHT = 8
const OPPOSITE = { [UP]: DOWN, [DOWN]: UP, [LEFT]: RIGHT, [RIGHT]: LEFT }
const JOINTS = [' ', '│', '│', '│', '─', '┘', '┐', '┤', '─', '└', '┌', '├', '─', '┴', '┬', '┼']
const STRAIGHT = {
  dotted: { [UP | DOWN]: '┆', [LEFT | RIGHT]: '┄' },
  thick: { [UP | DOWN]: '┃', [LEFT | RIGHT]: '━' },
}
const ARROW_INTO = { WEST: '►', EAST: '◄', NORTH: '▼', SOUTH: '▲' }
const FLOW = { LR: 'RIGHT', RL: 'LEFT', TD: 'DOWN', TB: 'DOWN', BT: 'UP' }
const PORT_SIDES = {
  RIGHT: ['WEST', 'EAST'],
  LEFT: ['EAST', 'WEST'],
  DOWN: ['NORTH', 'SOUTH'],
  UP: ['SOUTH', 'NORTH'],
}
const PSEUDO_STATES = { 'state-start': '●', 'state-end': '◉' }

const textWidth = (text) => [...text].length

function wrap(line, width) {
  const lines = []
  let current = ''
  for (const word of line.split(/\s+/).filter(Boolean)) {
    if (current && textWidth(current) + 1 + textWidth(word) > width) {
      lines.push(current)
      current = word
    } else {
      current = current ? `${current} ${word}` : word
    }
  }
  return [...lines, current]
}

function nodeLines(node, wrapWidth) {
  if (PSEUDO_STATES[node.shape]) return [PSEUDO_STATES[node.shape]]
  return node.label.split('\n').flatMap((line) => wrap(line, wrapWidth))
}

function portsOf(flow, width, height) {
  const [inSide, outSide] = PORT_SIDES[flow]
  const center = {
    WEST: [0, Math.floor((height - 1) / 2)],
    EAST: [width, Math.floor((height - 1) / 2)],
    NORTH: [Math.floor((width - 1) / 2), 0],
    SOUTH: [Math.floor((width - 1) / 2), height],
  }
  const port = (side) => ({ side, x: center[side][0], y: center[side][1] })
  return { in: port(inSide), out: port(outSide) }
}

export function elkGraph(parsed, direction, wrapWidth) {
  const flow = FLOW[direction] ?? 'DOWN'
  const horizontal = flow === 'RIGHT' || flow === 'LEFT'
  const links = parsed.edges.filter((edge) => edge.source !== edge.target)
  const nodes = new Map()
  const children = [...parsed.nodes.values()].map((node) => {
    const loops = parsed.edges.filter((edge) => edge.source === node.id && edge.target === node.id)
    const lines = [...nodeLines(node, wrapWidth), ...loops.map((loop) => (loop.label ? `↺ ${loop.label}` : '↺'))]
    const width = Math.max(...lines.map(textWidth)) + 4
    const height = lines.length + 2
    const ports = portsOf(flow, width, height)
    nodes.set(node.id, { lines, shape: node.shape, ports })
    return {
      id: node.id,
      width,
      height,
      ports: ['in', 'out'].map((kind) => {
        const { side, x, y } = ports[kind]
        return { id: `${node.id}:${kind}`, x, y, width: 0, height: 0, layoutOptions: { 'elk.port.side': side } }
      }),
      layoutOptions: { 'elk.portConstraints': 'FIXED_POS', 'elk.alignment': horizontal ? 'LEFT' : 'TOP' },
    }
  })
  const edges = links.map((edge, i) => ({
    id: `e${i}`,
    sources: [`${edge.source}:out`],
    targets: [`${edge.target}:in`],
    labels: edge.label ? [{ text: ` ${edge.label} `, width: textWidth(edge.label) + 2, height: 1 }] : [],
  }))
  const graph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': flow,
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.spacing.nodeNode': horizontal ? '1' : '2',
      'elk.layered.spacing.nodeNodeBetweenLayers': horizontal ? '4' : '2',
      'elk.spacing.edgeEdge': '1',
      'elk.spacing.edgeNode': '1',
      'elk.spacing.edgeLabel': '0',
      'elk.layered.spacing.edgeEdgeBetweenLayers': '1',
      'elk.layered.spacing.edgeNodeBetweenLayers': '2',
      'elk.spacing.componentComponent': '2',
      'elk.aspectRatio': '1.6',
      'elk.padding': '[top=0,left=0,bottom=0,right=0]',
      'elk.edgeLabels.inline': 'true',
      'elk.edgeLabels.placement': 'CENTER',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.layered.cycleBreaking.strategy': 'DEPTH_FIRST',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
    },
    children,
    edges,
  }
  return {
    graph,
    nodes,
    edges: links.map((edge) => ({
      ...edge,
      from: nodes.get(edge.source).ports.out,
      to: nodes.get(edge.target).ports.in,
    })),
  }
}

function canvas() {
  const cells = new Map()
  return {
    get: (x, y) => cells.get(`${x},${y}`),
    put: (x, y, value) => cells.set(`${x},${y}`, value),
    entries: () => [...cells].map(([key, value]) => [...key.split(',').map(Number), value]),
  }
}

function outside(box, port) {
  const x = box.x + port.x
  const y = box.y + port.y
  return { WEST: [x - 1, y], EAST: [x, y], NORTH: [x, y - 1], SOUTH: [x, y] }[port.side]
}

function trace(masks, styles, points, style) {
  const mark = (x, y, bit) => {
    masks.put(x, y, (masks.get(x, y) ?? 0) | bit)
    if (style !== 'solid') styles.put(x, y, style)
  }
  for (let i = 1; i < points.length; i++) {
    let [x, y] = points[i - 1]
    const [tx, ty] = points[i]
    while (x !== tx || y !== ty) {
      const dir = x !== tx ? (tx > x ? RIGHT : LEFT) : ty > y ? DOWN : UP
      mark(x, y, dir)
      if (dir === RIGHT) x++
      else if (dir === LEFT) x--
      else if (dir === DOWN) y++
      else y--
      mark(x, y, OPPOSITE[dir])
    }
  }
}

function drawBox(out, box, node) {
  const shape = PSEUDO_STATES[node.shape] ? 'rounded' : node.shape
  const corners = SHAPE_CORNERS[shape]?.unicode ?? SHAPE_CORNERS.rectangle.unicode
  const right = box.x + box.width - 1
  const bottom = box.y + box.height - 1
  for (let y = box.y; y <= bottom; y++) {
    for (let x = box.x; x <= right; x++) {
      const edge = y === box.y || y === bottom
      out.put(x, y, edge ? '─' : x === box.x || x === right ? '│' : ' ')
    }
  }
  out.put(box.x, box.y, corners.tl)
  out.put(right, box.y, corners.tr)
  out.put(box.x, bottom, corners.bl)
  out.put(right, bottom, corners.br)
  node.lines.forEach((line, row) => {
    const start = box.x + 1 + Math.floor((box.width - 2 - textWidth(line)) / 2)
    ;[...line].forEach((char, i) => out.put(start + i, box.y + 1 + row, char))
  })
}

export function drawLayout(layout, { nodes, edges }) {
  const boxes = new Map(
    layout.children.map((child) => [
      child.id,
      { x: Math.round(child.x), y: Math.round(child.y), width: child.width, height: child.height },
    ]),
  )
  const masks = canvas()
  const styles = canvas()
  const out = canvas()
  const overlays = []
  layout.edges.forEach((elkEdge, i) => {
    const edge = edges[i]
    const start = outside(boxes.get(edge.source), edge.from)
    const end = outside(boxes.get(edge.target), edge.to)
    const bends = (elkEdge.sections ?? []).flatMap((section) =>
      (section.bendPoints ?? []).map((point) => [Math.floor(point.x), Math.floor(point.y)]),
    )
    const points = [start]
    for (const point of [...bends, end]) {
      const last = points.at(-1)
      if (last[0] !== point[0] && last[1] !== point[1]) points.push([point[0], last[1]])
      points.push(point)
    }
    trace(masks, styles, points, edge.style)
    if (edge.hasArrowEnd) overlays.push([...end, ARROW_INTO[edge.to.side]])
    if (edge.hasArrowStart) overlays.push([...start, ARROW_INTO[edge.from.side]])
    for (const label of elkEdge.labels ?? []) {
      ;[...label.text].forEach((char, k) => overlays.push([Math.round(label.x) + k, Math.round(label.y), char]))
    }
  })
  for (const [x, y, mask] of masks.entries()) {
    out.put(x, y, STRAIGHT[styles.get(x, y)]?.[mask] ?? JOINTS[mask])
  }
  for (const [x, y, char] of overlays) out.put(x, y, char)
  for (const [id, box] of boxes) drawBox(out, box, nodes.get(id))

  const cells = out.entries()
  const minX = Math.min(...cells.map(([x]) => x))
  const minY = Math.min(...cells.map(([, y]) => y))
  const maxY = Math.max(...cells.map(([, y]) => y))
  const rows = Array.from({ length: maxY - minY + 1 }, () => [])
  for (const [x, y, char] of cells) rows[y - minY][x - minX] = char
  return rows.map((row) => Array.from(row, (char) => char ?? ' ').join('').trimEnd()).join('\n')
}
