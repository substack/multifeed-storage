var hypercore = require('hypercore')
var hcrypto = require('hypercore-crypto')
var deferred = require('deferred-random-access')
var TinyBox = require('tinybox')
var path = require('path')
var LRU = require('lru')
var { nextTick } = process
var DKEY = 'd!' // hex discovery key to key
var LKEY = 'l!' // local name to hex key
var INV_LKEY = 'L!' // local name to key
var KEY = 'k!' // hex key to empty payload
var FEED = 'f_'

function Storage (storage, opts) {
  if (!(this instanceof Storage)) return new Storage(storage, opts)
  if (!opts) opts = {}
  this._db = new TinyBox(storage('db'))
  this._storage = storage
  this._feeds = {} // map hypercore keys to feeds
  this._dkeys = {} // map discovery key to key for loaded feeds
  this._lnames = {} // map local names to key for loaded feeds
  this._delete = opts.delete
}

Storage.prototype._storageF = function (prefix) {
  var self = this
  return function (p) {
    return self._storage(path.join(prefix, p))
  }
}

// Map a discovery key to a public key.
Storage.prototype.fromDiscoveryKey = function (dkey, cb) {
  var hdkey = asHexStr(dkey)
  if (this._dkeys.hasOwnProperty(hdkey)) {
    return nextTick(cb, null, this._dkeys[hdkey])
  }
  this._db.get(DKEY + hdkey, function (err, node) {
    if (err) cb(err)
    else cb(null, node === null ? null : node.value)
  })
}

// Map a local nickname to a public key.
Storage.prototype.fromLocalName = function (localname, cb) {
  if (this._lnames.hasOwnProperty(localname)) {
    return nextTick(cb, null, this._lnames[localname])
  }
  this._db.get(LKEY + localname, function (err, node) {
    if (err) cb(err)
    else cb(null, node === null ? null : node.value)
  })
}

// Create a new hypercore, which can include a local name. (creates + loads)
Storage.prototype.createLocal = function (localname, opts, cb) {
  var self = this
  if (typeof localname === 'object') {
    cb = opts
    opts = localname
  } else if (typeof localname === 'function') {
    cb = localname
    opts = {}
    localname = null
  } else if (typeof opts === 'function') {
    cb = opts
    opts = {}
  }
  if (!cb) cb = noop
  var kp = hcrypto.keyPair()
  var key = kp.publicKey
  var hkey = key.toString('hex')
  var hdkey = asHexStr(hcrypto.discoveryKey(key))
  var store = self._storageF(FEED + hkey)
  var feed = hypercore(store, key, Object.assign({
    secretKey: kp.secretKey
  }, opts))
  feed.once('close', function () {
    delete self._feeds[hkey]
  })
  self._feeds[hkey] = feed
  self._dkeys[hdkey] = key
  if (localname) {
    self._lnames[localname] = key
    self._db.put(LKEY + localname, key)
    self._db.put(INV_LKEY + localname, key)
  }
  self._db.put(DKEY + hdkey, key)
  self._db.put(KEY + hkey, Buffer.alloc(0))
  var pending = 3
  self._db.flush(function (err) {
    if (err) cb(err)
    else if (--pending === 0) cb(null, feed)
  })
  feed.ready(function () {
    if (--pending === 0) cb(null, feed)
  })
  if (--pending === 0) cb(null, feed)
  return feed
}

// Create a new hypercore, which can include a local name. (creates + loads)
Storage.prototype.createRemote = function (key, opts, cb) {
  var self = this
  if (typeof opts === 'function') {
    cb = opts
    opts = {}
  }
  if (!opts) opts = {}
  if (!cb) cb = noop
  var hkey = asHexStr(key)
  key = asBuffer(key)
  var dkey = hcrypto.discoveryKey(key)
  var hdkey = asHexStr(dkey)
  var store = self._storageF(FEED + hkey)
  var feed = hypercore(store, key, opts)
  feed.once('close', function () {
    delete self._feeds[hkey]
  })
  self._feeds[hkey] = feed
  self._dkeys[hdkey] = key
  if (opts.localname) {
    self._lnames[opts.localname] = key
    self._db.put(LKEY + opts.localname, key)
    self._db.put(INV_LKEY + opts.localname, key)
  }
  self._db.put(DKEY + hdkey, key)
  self._db.put(KEY + hkey, Buffer.alloc(0))
  var pending = 3
  self._db.flush(function (err) {
    if (err) cb(err)
    else cb(null, feed)
  })
  feed.ready(function () {
    if (--pending === 0) cb(null, feed)
  })
  if (--pending === 0) cb(null, feed)
  return feed
}

// Get an existing hypercore by key or local name. Local names are purely local
// & aren't shared over the network. Loads the core if it isn't loaded.
Storage.prototype.get = function (id, opts) {
  var self = this
  if (self._feeds.hasOwnProperty(id)) {
    // cached
    return self._feeds[id]
  } else if (Buffer.isBuffer(id) && id.length === 32) {
    // buffer key
    var hkey = asHexStr(id)
    if (self._feeds.hasOwnProperty(hkey)) {
      // cached
      return self._feeds[hkey]
    } else {
      // not cached
      var store = self._storageF(FEED + hkey)
      var feed = self._feeds[hkey] = hypercore(store, key, opts)
      feed.once('close', function () {
        delete self._feeds[hkey]
      })
      var hdkey = hcrypto.discoveryKey(id)
      self._dkeys[hdkey] = key
      return feed
    }
  } else if (/^[0-9A-Fa-f]{64}$/.test(id)) {
    // string key
    var key = asBuffer(id)
    var store = self._storageF(FEED + id)
    var hdkey = hcrypto.discoveryKey(key)
    self._dkeys[hdkey] = key
    var feed = self._feeds[id] = hypercore(store, key, opts)
    feed.once('close', function () {
      delete self._feeds[hkey]
    })
    return feed
  } else if (self._lnames.hasOwnProperty(id)) {
    // cached local name
    return self._feeds[asHexStr(self._lnames[id])]
  } else {
    // not cached local name
    var feed = hypercore(deferred(function (cb) {
      self.fromLocalName(id, function (err, key) {
        if (err) return cb(err)
        if (key) {
          // exists
          self._lnames[id] = key
          var hkey = asHexStr(key)
          var hdkey = hcrypto.discoveryKey(key)
          self._dkeys[hdkey] = key
          self._feeds[hkey] = feed
          cb(null, self._storageF(FEED + hkey))
        } else {
          // does not exist
          cb(null, new Error('feed not found'))
        }
      })
    }), opts)
    feed.once('close', function () {
      delete self._feeds[hkey]
    })
    return feed
  }
}

// Whether a hypercore is stored on disk or in memory
Storage.prototype.has = function (key, cb) {
  if (this.isOpen(key)) return nextTick(cb, null, true)
  this._db.get(KEY + key, function (err, node) {
    if (err) cb(err)
    else cb(null, Boolean(node))
  })
}

// Returns boolean true/false if core is open.
Storage.prototype.isOpen = function (id, cb) {
  return this._feeds.hasOwnProperty(asHexStr(id))
}

// Unload a hypercore.
Storage.prototype.close = function (id, cb) {
  var hkey = asHexStr(id)
  if (!this._feeds.hasOwnProperty(hkey)) {
    return nextTick(cb, new Error('feed not loaded'))
  }
  this._feeds[hkey].close(cb)
  delete this._feeds[hkey]
}

// Close all hypercores.
Storage.prototype.closeAll = function (cb) {
  var self = this
  var pending = 1, finished = false
  Object.keys(self._feeds).forEach(function (key) {
    pending++
    self._feeds[key].close(function (err) {
      if (!finished && err) {
        finished = true
        cb(err)
      } else if (!finished && --pending === 0) {
        finished = true
        cb()
      }
    })
  })
  if (--pending === 0 && !finished) {
    finished = true
    cb()
  }
}

// Unload (if necessary) and delete a hypercore.
Storage.prototype.delete = function (id, cb) {
  var self = this
  var hkey = asHexStr(id)
  if (self._feeds.hasOwnProperty(hkey)) {
    self._feeds[hkey].close(function (err) {
      if (err) return cb(err)
      self._delete(FEED + hkey, cb)
    })
  }
  delete self._feeds[hkey]
}

module.exports = Storage

function asBuffer (x) {
  if (Buffer.isBuffer(x)) return x
  if (typeof x === 'string' && /^[0-9A-Fa-f]+$/.test(x)) {
    return Buffer.from(x, 'hex')
  }
  return null
}

function asHexStr (x) {
  if (typeof x === 'string' && /^[0-9A-Fa-f]+$/.test(x)) return x
  if (Buffer.isBuffer(x)) return x.toString('hex')
  return null
}

function noop () {}
