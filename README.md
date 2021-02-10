# Serve ES6 modules

This module serves ES6 modules ensuring node resolution via the node algorithm. Express middleware included.

Resolution is done via the node algorithm, but letting "module" or "jsnext" fields in package.json take precedence over "main".

_NOTE: this module draws strong inspiration (and large chunks of repurposed code) from
Marijn Haverbeke's awesome [esmoduleserve](https://github.com/marijnh/esmoduleserve)._

## Usage as a stand alone server

You can use es6-dev-server as a server:

````
$ ../es6-dev-server/server --help
Usage: server [options]

Options:
  -V, --version        output the version number
  -p, --port <port>    Set the port (default: 3000)
  -e, --entry <entry>  Default file for SPAs (never returning "not found"). (default: "")
  -h, --help           display help for command
````

It will run the server in the current directory; javascript modules will be translate so that `import 'lit-element'` will be translated into `import '../../node_modules/lit-element.js'


## Usage as middleware

You can use it as middleware in your programs:

````
const moduleMiddleware = require('es6-dev-server').moduleMiddleware

(...)

app.use(moduleMiddleware({ root: '.') })
````

The parameter is the directory that will be served.


## Usage as middleware (advanced)

You can call the internal middleware function of es6-dev-server, and have full control over
the way the middleware is called:

````
const ModuleMiddleware = require('es6-dev-server').ModuleMiddleware

const mm = new ModuleMiddleware({ root: '.' })
app.use((req, res, next) => {
  if (mm.handleRequest(req, res)) {
    // The request WAS handled by the middleware's handleRequest() function
  } else {
    // The request was NOT handled by the middleware's handleRequest() function
    next()
  }
})
````
