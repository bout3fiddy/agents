import ts from 'typescript'

function isCompound(node) {
  return (
    ts.isIfStatement(node) ||
    ts.isForStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isTryStatement(node) ||
    ts.isSwitchStatement(node) ||
    ts.isFunctionDeclaration(node)
  )
}

export function addReadabilitySpacing(source, filename) {
  if (!/\.(?:ts|tsx|js|mjs|cjs)$/.test(filename)) {
    return source
  }

  const kind = filename.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, kind)
  const lines = source.split('\n')
  const insertions = new Set()
  const comments = new Map()
  const lineAt = (position) => tree.getLineAndCharacterOfPosition(position).line

  function visit(node) {
    const leading = ts.getLeadingCommentRanges(source, node.pos) || []

    for (const comment of leading) {
      const line = lineAt(comment.pos)
      const { character } = tree.getLineAndCharacterOfPosition(comment.pos)

      if (!lines[line].slice(0, character).trim()) {
        comments.set(line, lineAt(comment.end))
      }
    }

    if (node.statements) {
      const statements = node.statements

      for (let index = 1; index < statements.length; index++) {
        const before = statements[index - 1],
          after = statements[index]

        if (!isCompound(before) && !isCompound(after)) {
          continue
        }

        const start = lineAt(after.getStart(tree))
        const end = lineAt(before.end)
        const between = lines.slice(end + 1, start)

        if (!between.some((line) => !line.trim())) {
          insertions.add(start)
        }
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(tree)
  const commentEnds = new Set(comments.values())

  for (const start of comments.keys()) {
    if (start && lines[start - 1].trim() && !commentEnds.has(start - 1)) {
      insertions.add(start)
    }
  }

  // Work backwards so every insertion still uses the original AST line numbers.
  for (const line of [...insertions].sort((a, b) => b - a)) {
    lines.splice(line, 0, '')
  }

  return lines.join('\n')
}
