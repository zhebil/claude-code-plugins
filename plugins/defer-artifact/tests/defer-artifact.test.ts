import { expect, test } from 'claude-code/testing'

function describeAsCore(on) {
  on('tool.describe', ($, e) => ({ description: e.description }))
}

test('puts the Artifact tool behind tool search', async ($, on) => {
  describeAsCore(on)
  expect(await $.tool.describe({ tool: 'Artifact', description: 'Publishes pages' })).toEqual({
    description: 'Publishes pages',
    isDeferred: true,
  })
})

test('leaves every other tool as the engine lists it', async ($, on) => {
  describeAsCore(on)
  expect(await $.tool.describe({ tool: 'ArtifactData', description: 'Reads rows' })).toEqual({ description: 'Reads rows' })
  expect(await $.tool.describe({ tool: 'Bash', description: 'Runs commands' })).toEqual({ description: 'Runs commands' })
})
