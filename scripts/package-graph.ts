import { readFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { posix, resolve } from 'node:path'
import ts from '@typescript/typescript6'

const imports = (path: string, source: string) => {
  const specifiers: string[] = []
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  const visit = (node: ts.Node) => {
    let specifier: ts.Node | undefined
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      specifier = node.moduleSpecifier
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      specifier = node.arguments.at(0)
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      specifier = node.argument.literal
    }
    if (specifier !== undefined) {
      if (ts.isStringLiteral(specifier)) {
        specifiers.push(specifier.text)
      } else {
        throw new Error('The package graph contains a non-literal import.')
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return specifiers
}

// Start at the supported entries: an unrelated generated file is never an input authority.
export const reviewedRuntimePaths = (root: string) => {
  const paths = new Set<string>()
  const visit = (path: string) => {
    if (!paths.has(path)) {
      if (!/^dist\/[a-zA-Z0-9_-]+\.mjs$/.test(path)) {
        throw new Error('The package graph imports a path outside its runtime output.')
      }
      paths.add(path)
      const source = readFileSync(resolve(root, path), 'utf8')
      for (const specifier of imports(path, source)) {
        if (!isBuiltin(specifier)) {
          if (!specifier.startsWith('./') || specifier.includes('\\')) {
            throw new Error('The package graph contains a non-contained runtime import.')
          }
          visit(posix.join(posix.dirname(path), specifier))
        }
      }
    }
  }
  visit('dist/index.mjs')
  visit('dist/cli.mjs')
  return [...paths].sort()
}

export const assertPublicDeclarations = (root: string) => {
  const entry = readFileSync(resolve(root, 'src/index.ts'), 'utf8')
  const declaration = readFileSync(resolve(root, 'dist/index.d.ts'), 'utf8')
  const exportNames = (path: string, source: string) =>
    ts
      .createSourceFile(path, source, ts.ScriptTarget.Latest, true)
      .statements.flatMap(node =>
        ts.isExportDeclaration(node) && node.exportClause !== undefined && ts.isNamedExports(node.exportClause)
          ? node.exportClause.elements.map(element => element.name.text)
          : [],
      )
  const facade = ts.createSourceFile('index.d.ts', declaration, ts.ScriptTarget.Latest, true)
  const declarations = facade.statements.flatMap(node => {
    if (
      ts.canHaveModifiers(node) &&
      ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)
    ) {
      throw new Error('The declaration facade must not introduce a default export.')
    }
    if (ts.isVariableStatement(node)) {
      return node.declarationList.declarations.map(binding => binding.name.getText(facade))
    }
    if (
      ts.isClassDeclaration(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isInterfaceDeclaration(node)
    ) {
      return node.name === undefined ? [] : [node.name.text]
    }
    if (ts.isExportDeclaration(node) && node.exportClause !== undefined && ts.isNamedExports(node.exportClause)) {
      return []
    }
    throw new Error('The declaration facade contains an unsupported private declaration.')
  })
  const expected = JSON.stringify(exportNames('index.ts', entry).sort())
  if (
    imports('index.d.ts', declaration).length !== 0 ||
    facade.referencedFiles.length !== 0 ||
    facade.typeReferenceDirectives.length !== 0 ||
    expected !== JSON.stringify(declarations.sort()) ||
    expected !== JSON.stringify(exportNames('index.d.ts', declaration).sort())
  ) {
    throw new Error('The declaration facade must contain exactly the supported root exports without imports.')
  }
}
