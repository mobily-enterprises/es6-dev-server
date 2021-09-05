// ES6 DEV SERVER
// =====
// [ES6 Dev Server](https://github.com/mobily-enterprises/es6-dev-server/) (or ESDS)is a
// minimalistic server and Express middleware that allows you to serve modern
// web applications written that use ES6 import statements and want to use make sure
// that module resolution happens via the node algorithm. So, for example
// `import { LitElement } from 'lit-element'` will be translated into
// `import { LitElement, html, css } from '../../node_modules/lit-element/lit-element.js'
// Note that the browser will give an error if a module's path doesn't start with
// `/`, `..` or `.` and that most of builds made with rollup will take care of exactly
// this.
//
// Having this translation at dev server level means that you can run your application
// without having to build it every time.
//
// TODO:
// * Add https://www.npmjs.com/package/reload so that it does client reload
// * Check whether we need/want `unwin()``
// * Get rid of that `require('url')` which is now obsolete
//
// Basic imports
// -------------
// ESDS needs a few modules to do its work. `path` and `fs` are used to deal with paths,
// `resolve` will apply node's module resolution algorithm. `crypto` will be used to
// create the ETAG hash for the text, and `acorn` and `acorn-walk` are used to tokenise
// the served JS files in order to fix the paths of the `import` statements in those files.
//
const path = require('path')
const fs = require('fs')
const resolve = require('resolve')
const { parse: parseURL } = require('url')
const crypto = require('crypto')
const acorn = require('acorn')
const walk = require('acorn-walk')

// Caching pattern
// ---------------
// ESDS implements a simple caching mechanism, where each entry stores the contents
// and the headers, which include the served content's ETAG.
// Here is the simple implementation:

class Cached {
  constructor (content) {
    this.content = content
    this.headers = {
      'content-type': 'application/javascript; charset=utf-8',
      etag: '"' + crypto.createHash('sha1').update(content).digest('hex') + '"'
    }
  }
}

// The actual middleware class
// ---------------------------
// This is the main class that will create the middleware.
// Using this class is a matter of instantiating it and then using the
// resulting object's
//
// ````
// const es6ds = new ModuleMiddleware(opts)
// app.use(es6ds.middleware)
// ````
//
// Where `es6ds.middleware` is the method that will act as a middleware.
class ModuleMiddleware {
// The constructor will do some important things. First of all, will
// save the options to local properties, so that every function
// will have access to it.
//
// It will also initiate the cache (here `Object.create(null)` will make sure
// that the object is totally empty, rather than inheriting from Object.prototype)
// Finally, it will make sure that `this.handleRequest` and `this.middleware` are
// bound to the `this` object, so that it's possible to pass it as a function
// like shown above: `app.use(es6ds.middleware)` and still have the correct
// scope for `this`. (Remember that calling `es6ds.middleware()` would ensure that
// `this` is correct within the method. However, writing `app.use(es6ds.middleware)`
// is simply passing the method as a function reference to `app.use()`)
  constructor (options) {
    this.root = unwin(options.root)

    this.cache = Object.create(null)

    /* Make sure that 'handleRequest' is bound to 'this', so that */
    /* it can be used as `` */
    this.handleRequest = this.handleRequest.bind(this)
    this.middleware = this.middleware.bind(this)
  }

  // This class's main goal is to send data back to the client that requested it.
  //
  // This function does exactly that in a simple, minimalistic fashion.
  //
  // Two headers are returned by default, and stored in `finalHeaders`. On top of
  // them, developers can pass extra headers. This will be later used by the class
  // to pass extra headers stored in the Cache class
  //
  // The function will use `res.writeHead()` to write the status and headers,
  // and `res.end()` and to send the contents.
  send (req, res, status, text, extraHeaders = {}) {
    let finalHeaders = {
      'access-control-allow-origin': '*',
      'x-request-url': req.url
    }

    /* Add extra headers to `finalHeaders`, which will be sent back to the client */
    if (typeof extraHeaders === 'string') extraHeaders = { 'content-type': extraHeaders }
    finalHeaders = { ...finalHeaders, ...extraHeaders }

    res.writeHead(status, finalHeaders)
    res.end(text)
  }

  // ESDS is mainly a middleware. The `middleware()` method is the middleware
  // function that will be passed to Express, and which will become part of the
  // chain which will eventually result in the client receiving a response
  //
  // This function simply calls `this.handleRequest()`, which will in turn return
  // `true` or `false`. `true` means that the request has been fulfilled
  // -- that is, the function has already sent data to the client. This will happen
  // for javascript files (.js and .mjs). `false` means that nothing was sent to the
  // client - in which case, it will call `next()` and let the next middleware deal
  // with the request.
  //
  // This means that for javascript files, this will be the end of the road in terms
  // of Express middleware.
  //
  // Remember that `moduleMiddleware.middleware` can be passed as a reference and
  // still be bound to the `this` object thanks to the work done in the
  // constructor.

  middleware (req, res, next) {
    if (!this.handleRequest(req, res)) next()
  }

  // The handleRequest() method does the actual work: it will check that the
  // requested file is javascript (.js or .mjs') and that the file is
  // actually in the web server's root. It will then call the crucial
  // `resolveImports()` method, which will actually change the contents of the
  // file so that for example `lit-element` actually becomes
  // `../../node_modules/lit-element/lit-element.js'.
  //
  // A few interesting things happen here too:
  //
  // * Every file is cached. This is a very common caching pattern, where
  // the element is first looked up in the cache (`let cached = this.cache[path]`); only
  // if the element is not already cached, then the whole fetch/note-style path
  // resolution/sending it back to the client actually happens.
  //
  // * For every loaded file, a new watcher is setup; if the file changes, the
  // entry is deleted from the cache. This implies that when `handleRequest()` runs
  // again, the file will be treated a brand new entry: it will be cached, and
  // watched again
  //
  // * If the etag of the cached file matches the etag sent by the client in
  // `if-none-match`, the server will respond with a 304 (and empty contents)
  // rather than the actual file. This is a common mechanism to minimise
  // data exchhange.
  //
  // * The method returns `true` only if if sends contents (either as 304, or 200)

  handleRequest (req, res) {
    const url = parseURL(req.url)

    /* Only actually handle javascript files */
    const handle = url.pathname.endsWith('js') || url.pathname.endsWith('mjs')
    if (!handle) return false

    /* Common caching pattern: look for the element in the cache, and only */
    /* do the work if it's not there */
    /* By the end if this if, the `cached` variable will be set one way or another */
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
      /* Note: if resolveImports() fails, the server will return error 500. */
      let { resolvedCode, error } = this.resolveImports(moduleFilePath, code)
      if (error) {
        // this.send(req, res, 500, error)
        // return true
        resolvedCode = code
      }

      /* The `cached` varialbe is finally assigned now that the resolution is done */
      cached = this.cache[pathname] = new Cached(resolvedCode)

      // Drop cache entry when the file changes.
      const watching = fs.watch(moduleFilePath, () => {
        watching.close()
        this.cache[pathname] = null
      })
    }

    /* Do NOT send contents if the etag matches the one of the file in the cache */
    const noneMatch = req.headers['if-none-match']
    if (noneMatch && noneMatch.indexOf(cached.headers.etag) > -1) {
      this.send(req, res, 304, null)
      return true
    }

    /* Actually send the contents. */
    this.send(req, res, 200, cached.content, cached.headers)
    return true
  }

  // The next function, resolveImports(), is the actual heart of the module.
  // It actually does the *actual* work of changing a javascript source file
  // so that they point to the right spot.
  //
  // This is done by actually parsing the code with `acorn`, a Javascript parser.
  // The resolution is not done using regular expressions etc. It's done by
  // actually parsing the Javascript code, and then patching the relevant
  // part so that the path is rewritten.
  //
  // Note that `walk.simple` is used to walk through the list of nodes
  // of the parsed program; a list of `patches` is created, with the
  // exact positions of the portion to change, and the new text.
  // The new text wwill be longer than the original one; so, changing `code`
  // would have the side effect of messing up the stores ranges; so, the patches
  // are applied in inverted order to the source file, so that making changes
  // doesn't mess up the offset of the other patches.
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
      /* The next line will run eval as an indirect function */
      const orig = (0, eval)(code.slice(node.source.start, node.source.end))
      const { error, path } = this.resolveModuleLikeNode(moduleFilePath, orig)

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
      ExportAllDeclaration: patchSrc,
      ExportDefaultDeclaration: patchSrc,
      ExportNamedDeclaration: patchSrc,    
      ImportExpression: node => {
        if (node.source.type === 'Literal') {
          const { error, path } = this.resolveModuleLikeNode(moduleFilePath, node.source.value)
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

  // The resolveModuleLikeNode method will apply node's resolution algorithm to
  // a path.
  //
  // When `import()`ing a directory rather than a file, it will check whether the path contains a
  // package.json file, and -- if so -- it will check for the `main` property in it. This is what
  // allows you to write `import { LitElement } from 'lit-element'`. That last
  // `lit-element` is translated into `../../node_modules/lit-element` by the `resolveImports()`
  // method. However, that's not enough: the `lit-element` directory will contain a `package.json` file
  // with `"main":"lit-element.js"`. So, the final result will actually be `../../node_modules/lit-element/lit-element.js`
  // which is the desired effect.
  //
  // The packageFilter function makes sure that the module takes into consideration the `module`
  // and the `jnext` properties instead of the default `main` one
  resolveModuleLikeNode (moduleFilePath, importPath) {
    function packageFilter (pkg) {
      if (pkg.module) pkg.main = pkg.module
      else if (pkg.jnext) pkg.main = pkg.jsnext
      return pkg
    }

    const moduleDirPath = path.dirname(moduleFilePath)
    let resolved
    try {
      // resolved = fs.realpathSync(resolve.sync(importPath, { basedir: moduleDirPath, packageFilter }))
      resolved = resolve.sync(importPath, { basedir: moduleDirPath, packageFilter })
    } catch (e) {
      return { error: e.toString() }
    }

    return { path: unwin(path.relative(moduleDirPath, resolved)) }
  }
}

// The class is exported:
exports.ModuleMiddleware = ModuleMiddleware

// However, another function called `moduleMiddleware()` is exported. This function is
// what allows this package to be used without really knowing its inner workingsm: developers
// can type:
//
// ````
// const moduleMiddleware = require('es6-dev-server').moduleMiddleware
// app.use(moduleMiddleware({ root: '.') })
// ````
// The function will create an instance of ModuleMiddleware and return its
// `middleware()` method, which is Express-ready.
exports.moduleMiddleware = (opts) => {
  const ms = new ModuleMiddleware(opts)
  return ms.middleware
}

const unwin = path.sep === '\\' ? s => s.replace(/\\/g, '/') : s => s
