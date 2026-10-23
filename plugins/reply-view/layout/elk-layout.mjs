import ELK from './elk.bundled.js'

const elk = new ELK()

const point = ({ x, y }) => ({ x, y })

function trim(layout) {
  return {
    children: layout.children.map(({ id, x, y, width, height }) => ({ id, x, y, width, height })),
    edges: layout.edges.map(({ sections = [], labels = [] }) => ({
      sections: sections.map(({ bendPoints = [] }) => ({ bendPoints: bendPoints.map(point) })),
      labels: labels.map(({ text, x, y }) => ({ text, x, y })),
    })),
  }
}

export function layoutAll(graphs) {
  return Promise.all(graphs.map((graph) => elk.layout(graph).then(trim, () => null)))
}
