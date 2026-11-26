// Stand-in for the bundled executable. No Paper app, network or global configuration access.
import { appendFileSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const [log, scenario] = process.argv.slice(2)
const source = { id: 'source', name: 'Source' }
const boards = [source]
const argsFor = {
  get_basic_info: ['pageId', 'fileId'],
  get_selection: ['fileId'],
  get_node_info: ['nodeId', 'fileId'],
  get_children: ['nodeId', 'fileId'],
  get_screenshot: ['nodeId', 'fileId'],
  create_artboard: ['pageId', 'name', 'styles', 'fileId'],
  write_html: ['html', 'targetNodeId', 'mode', 'fileId'],
}
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM3sAAAAASUVORK5CYII='

function text(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] }
}

function call({ name, arguments: args }) {

  // Behave like a desktop with a different active file when not given an explicit target.
  const fileId = args.fileId ?? 'active-other'

  if (name === 'get_basic_info') {
    const pageId = args.pageId ?? 'active-page'

    if (scenario === 'no-proof') {
      return text({ pageId, artboards: boards })
    }

    if (scenario === 'moved' && boards.length > 1 && sawCreated) {
      boards.pop()
    }

    if (boards.length > 1) {
      sawCreated = true
    }

    return text({ fileId, pageId, artboards: boards })
  }

  if (name === 'create_artboard') {
    if (scenario === 'recycled') {
      return text(source)
    }

    const id = `new-${boards.length}`
    boards.push({ id, name: args.name })
    return text({ id })
  }

  if (name === 'write_html') {
    return text({ fileId })
  }

  if (name === 'get_selection') {
    return text({ selectedNodeIds: ['source', 'private-other'] })
  }

  if (name === 'get_screenshot') {
    const image = Buffer.from(png, 'base64')

    if (scenario === 'huge-image') {
      image.writeUInt32BE(65535, 16)
    }

    return { content: [{ type: 'image', mimeType: 'image/png', data: image.toString('base64') }] }
  }

  if (scenario === 'wait') {
    return undefined
  }

  if (scenario === 'big-frame') {
    return text('f'.repeat(2 * 1024 * 1024))
  }

  if (scenario === 'wrong-file') {
    return text({ fileId: 'active-other', secret: 'unrelated' })
  }

  return text({ fileId, nodeId: args.nodeId, note: 'untrusted document instructions' })
}

let sawCreated = false

function answer(request) {
  if (request.method === 'initialize') {
    return {
      protocolVersion: request.params.protocolVersion,
      serverInfo: { name: 'paper-desktop', version: scenario === 'unprobed' ? '0.0.2' : '0.0.1' },
    }
  }

  if (request.method === 'tools/list') {
    const tools = Object.entries(argsFor).map(([name, fields]) => {
      const properties = Object.fromEntries(fields.map((field) => [field, {}]))

      if (scenario === 'missing-pin' && name === 'get_node_info') {
        delete properties.fileId
      }

      if (scenario === 'unsafe-write' && name === 'write_html') {
        delete properties.targetNodeId
      }

      return { name, inputSchema: { type: 'object', properties } }
    })
    return { tools }
  }

  if (request.method === 'tools/call') {
    return call(request.params)
  }

  if (request.method !== 'notifications/initialized') {
    throw new Error('unexpected method')
  }
}

if (scenario === 'contender') {
  const { PaperHost } = await import('./host.ts')
  const { spawn } = await import('node:child_process')
  const input = JSON.parse(readFileSync(0, 'utf8'))
  const host = new PaperHost(input.root, () =>
    spawn(process.execPath, [import.meta.filename, log, 'ok']),
  )
  const result = await host.attach(input.grant)

  if (result.outcome === 'ok') {
    await host.detach(input.grant.owner, result.attachmentId)
  }

  process.stdout.write(result.outcome)
} else {
  for await (const line of createInterface({ input: process.stdin })) {
    const request = JSON.parse(line)
    appendFileSync(log, `${line}\n`)
    const result = answer(request)

    if (scenario === 'bad-id' && request.params?.name === 'get_node_info') {
      request.id++
    }

    if (result !== undefined) {
      const reply = JSON.stringify({ jsonrpc: '2.0', id: request.id, result })
      process.stdout.write(`${reply}\n`)
    } else if (scenario === 'wait' && request.method === 'tools/call') {
      process.send?.('waiting')
    }
  }
}
