const path = require('path')
const fs = require('fs')
const resolve = require('resolve')
const { parse: parseURL } = require('url')
const crypto = require('crypto')
const acorn = require('acorn')
const walk = require('acorn-walk')

class Cached {
  constructor (content, mimetype) {
    this.content = content
    this.headers = {
      'content-type': mimetype + '; charset=utf-8',
      etag: '"' + crypto.createHash('sha1').update(content).digest('hex') + '"'
    }
  }
}

exports.moduleMiddleware = (root) => {
  const ms = new ModuleMiddleware({ root })
  return ms.middleware
}

class ModuleMiddleware {
  constructor (options) {
    this.root = unwin(options.root)
    this.cache = Object.create(null)

    // Make sure that 'handleRequest' is bound to 'this', so that
    // it can be used as ``
    this.handleRequest = this.handleRequest.bind(this)
    this.middleware = this.middleware.bind(this)
  }

  send (req, res, status, text, extraHeaders = {}) {
    let finalHeaders = {
      'access-control-allow-origin': '*',
      'x-request-url': req.url
    }

    if (typeof extraHeaders === 'string') extraHeaders = { 'content-type': extraHeaders }
    finalHeaders = { ...finalHeaders, ...extraHeaders }

    res.writeHead(status, finalHeaders)
    res.end(text)
  }

  middleware (req, res, next) {
    if (!this.handleRequest(req, res)) next()
  }

  handleRequest (req, res) {
    const url = parseURL(req.url)
    // let handle = this.prefixTest.exec(url.pathname)
    const handle = url.pathname.endsWith('js') || url.pathname.endsWith('mjs')
    if (!handle) return false

    const pathname = url.pathname
    let cached = this.cache[path]
    if (!cached) {
      const moduleFilePath = unwin(path.join(this.root, pathname))
      let code
      try {
        code = fs.readFileSync(moduleFilePath, 'utf8')
      } catch {
        return false
      }
      // if (/\.map$/.test(moduleFilePath)) {
      //   cached = this.cache[path] = new Cached(code, "application/json")
      // } else {
      const { resolvedCode, error } = this.resolveImports(moduleFilePath, code)
      if (error) {
        this.send(req, res, 500, error)
        return true
      }
      cached = this.cache[pathname] = new Cached(resolvedCode, 'application/javascript')
      // }
      // Drop cache entry when the file changes.
      const watching = fs.watch(moduleFilePath, () => {
        watching.close()
        this.cache[pathname] = null
      })
    }

    const noneMatch = req.headers['if-none-match']
    if (noneMatch && noneMatch.indexOf(cached.headers.etag) > -1) {
      this.send(req, res, 304, null)
      return true
    }

    this.send(req, res, 200, cached.content, cached.headers)
    return true
  }

  // Resolve a module path to a relative filepath where
  // the module's file exists.
  resolveModule (moduleFilePath, importPath) {
    const moduleDirPath = path.dirname(moduleFilePath)
    let resolved
    try {
      resolved = fs.realpathSync(resolve.sync(importPath, { basedir: moduleDirPath, packageFilter }))
    } catch (e) {
      return { error: e.toString() }
    }

    return { path: unwin(path.relative(moduleDirPath, resolved)) }
  }

  resolveImports (moduleFilePath, code) {
    const patches = []
    let ast
    try {
      ast = acorn.parse(code, { sourceType: 'module', ecmaVersion: 'latest' })
    } catch (error) {
      return { error: error.toString() }
    }
    const patchSrc = (node) => {
      if (!node.source) return
      const orig = (0, eval)(code.slice(node.source.start, node.source.end))
      const { error, path } = this.resolveModule(moduleFilePath, orig)
      if (error) return { error }
      patches.push({
        from: node.source.start,
        to: node.source.end,
        text: JSON.stringify('./' + path)
      })
    }
    walk.simple(ast, {
      ExportNamedDeclaration: patchSrc,
      ImportDeclaration: patchSrc,
      ImportExpression: node => {
        if (node.source.type === 'Literal') {
          const { error, path } = this.resolveModule(moduleFilePath, node.source.value)
          if (!error) {
            patches.push({
              from: node.source.start,
              to: node.source.end,
              text: JSON.stringify('./' + path)
            })
          }
        }
      }
    })
    for (const patch of patches.sort((a, b) => b.from - a.from)) {
      code = code.slice(0, patch.from) + patch.text + code.slice(patch.to)
    }
    return { resolvedCode: code }
  }
}
exports.ModuleMiddleware = ModuleMiddleware

const unwin = path.sep === '\\' ? s => s.replace(/\\/g, '/') : s => s

function packageFilter (pkg) {
  if (pkg.module) pkg.main = pkg.module
  else if (pkg.jnext) pkg.main = pkg.jsnext
  return pkg
}
