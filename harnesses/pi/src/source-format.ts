import { format } from 'prettier'
import { harnessFormatOptions } from './document-tools.ts'

// @ts-expect-error Shared formatting code is JavaScript.
import { addReadabilitySpacing } from '../scripts/linting/readability.mjs'

export async function formatSource(source: string, path: string): Promise<string> {
  const formatted = await format(source, { ...harnessFormatOptions, filepath: path })
  return addReadabilitySpacing(formatted, path)
}
