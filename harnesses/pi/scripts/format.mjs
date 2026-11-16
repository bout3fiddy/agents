import * as prettier from 'prettier'
import { writeFile } from 'node:fs/promises'
import { sourceFiles } from './linting/files.mjs'
import { addReadabilitySpacing } from './linting/readability.mjs'

const checking = process.argv.includes('--check')

for (const file of await sourceFiles(process.cwd())) {
  if (file.name.startsWith('fixtures/')) {
    continue
  }

  const info = await prettier.getFileInfo(file.path)

  if (!info.inferredParser) {
    continue
  }

  const options = await prettier.resolveConfig(file.path)
  let formatted = await prettier.format(file.source, { ...options, filepath: file.path })
  formatted = addReadabilitySpacing(formatted, file.name)

  if (formatted !== file.source) {
    if (checking) {
      console.error(`${file.name}: formatting required`)
      process.exitCode = 1
    } else {
      await writeFile(file.path, formatted)
    }
  }
}
