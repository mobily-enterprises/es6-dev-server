const express = require('express')
const path = require('path')
const cookieParser = require('cookie-parser')
const logger = require('morgan')
const moduleMiddleware = require('./index').moduleMiddleware
const { program } = require('commander')
const root = process.cwd()

const app = express()
const entry = program.opts().entry

app.use(logger('dev'))
app.use(express.json())
app.use(express.urlencoded({ extended: false }))
app.use(cookieParser())

// Middleware to map imports in JS files so that node module resolution is used
app.use(moduleMiddleware(root))

// Serve static files
app.use(express.static(path.join(root)))

// If there is a defalt entry defined, then always return that one
// for not found entries
if (entry) {
  app.use((req, res, next) => {
    if ((req.method === 'GET' || req.method === 'HEAD') && req.accepts('html')) {
      res.sendFile(entry, { root }, err => err && next())
    } else next()
  })
  }

// Default "not found"
app.use(function (req, res, next) {
  res
    .status(404)
    .send("Sorry can't find that!")
})


module.exports = app
