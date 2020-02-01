//
// conn = new Conn({user_mask: 'asdlfjasdf', () => {}, () => {}})
// conn.subscribe() // start
// when connection is dead, it only calls onDead once, after that this object is useless
// its resource will be clear, no more settimeout is created
function Conn (credential, onDead, onEvents) {
	credential = credential || {}
	var dead = false
	var apiUrl = 'https://realtime-0.subiz.net/'
	var initialized = false
	var connectionSeek = randomString() // used to determind connection id

	// force dead
	this.dead = function () {
		dead = true
	}

	this.subscribe = function (events, cb) {
		if (dead) return cb('dead')
		if (events.length <= 0) return cb()
		var header = { 'content-type': 'text/plain' }
		if (credential.access_token) {
			header.Authorization = 'Bearer ' + credential.access_token
		}
		var query = `?seek=${connectionSeek}`
		if (credential.user_mask) {
			query += `&x-user-mask=${encodeURIComponent(credential.user_mask)}`
		}
		xhrsend('POST', `${apiUrl}subs${query}`, JSON.stringify({ events }), header, function (_, body, code) {
			if (dead) return cb('dead')
			if (code !== 200) return cb('cannot subscribe')

			if (initialized) return cb()
			initialized = true
			// first time sub, should grab the initial token
			polling(parseJSON(body).initial_token, 0) // start the poll
			cb()
		})
	}

	// user should not call this function
	var polling = function (token, backoff) {
		if (dead) return
		xhrsend('GET', `${apiUrl}poll?token=${token}`, undefined, undefined, function (status, body, code) {
			if (dead) return
			if (code === 500) {
				// TODO: or lost network connection, move this code to xhrsend
				setTimeout(function () {
					polling(token, backoff + 1)
				}, calcNextBackoff(backoff))
				return
			}

			if (code === 200) {
				body = parseJSON(body)
				onEvents(body.events)
				return polling(body.sequential_token, 0)
			}

			// our fault, should kill
			dead = true
			onDead()
		})
	}
}

function Realtime () {
	var stop = false
	var pubsub = new Pubsub()

	var lastConn
	var subscribedEvents = {}
	var session = randomString()

	this.un = function (subid) {
		pubsub.un(subid)
	}

	this.onEvent = function (cb) {
		return pubsub.on('event', cb)
	}

	this.onInterrupted = function (cb) {
		return pubsub.on('interrupted', cb)
	}

	this.reset = function (credential) {
		credential = credential || {}
		if (lastConn) lastConn.dead()
		lastConn = undefined

		// generate new sesion id, old callbacks with old session will realize and step down
		session = randomString() //

		// logout
		if (!credential.access_token && !credential.user_mask) {
			stop = true
			return
		}
		stop = false
		return reconnect(session, credential)
	}

	this.subscribe = function (events) {
		return new Promise(function (rs) {
			// ignore already subscribed events
			var newEvs = filter(events, function (ev) {
				return !subscribedEvents[ev]
			})
			if (newEvs.length === 0) return rs()
			if (!lastConn) rs('must reset first')

			lastConn.subscribe(newEvs, function (err) {
				if (err) return rs(err)
				map(newEvs, function (ev) {
					subscribedEvents[ev] = true
				})
				rs()
			})
		})
	}

	var reconnect = function (mysession, credential) {
		if (mysession !== session || stop) return // outdated
		if (lastConn) lastConn.dead()
		lastConn = new Conn(
			credential,
			function () {
				if (mysession !== session || stop) return // outdated
				pubsub.emit('interrupted')
				reconnect(mysession, credential) // reconnect and resubscribe
			},
			function (events) {
				map(events, function (ev) {
					pubsub.emit('event', ev)
				}) // TODO: prevent dup
			},
		)

		// resubscribe all subscribed event
		return lastConn.subscribe(Object.keys(subscribedEvents))
	}
}

// TODO retry forever on network lost, server return 500 or 502 or 429
function xhrsend (method, url, body, header, cb) {
	cb = cb || function () {}

	var request = new window.XMLHttpRequest()
	request.onreadystatechange = function (e) {
		if (request.readyState !== 4) return

		cb(undefined, request.responseText, request.status)
	}

	request.onerror = function () {
		cb('network_error', request.responseText)
		cb = function () {} // dont call cb anymore
	}

	request.open(method, url)
	var headerKeys = header ? Object.keys(header) : []
	for (var i = 0; i < headerKeys.length; i++) {
		request.setRequestHeader(headerKeys[i], header[headerKeys[i]])
	}
	request.send(body)
}

function parseJSON (str) {
	try {
		return parseJSON(str)
	} catch (e) {}
}

function randomString () {
	var str = ''
	for (var i = 0; i < 30; i++) {
		var asciiKey = Math.floor(Math.random() * 25 + 97)
		str += String.fromCharCode(asciiKey)
	}
	return str
}

var DELI = '-[/]-'

function Pubsub () {
	var listeners = []

	this.emit = function (topic) {
		var args = []
		for (var i = 1; i < arguments.length; i++) args.push(arguments[i])
		map(listeners[topic], function (cb) {
			return cb.apply(undefined, args)
		})
	}

	this.on = function (topic, cb) {
		var subid = topic + DELI + randomString(20)
		if (!listeners[topic]) listeners[topic] = {}
		listeners[topic][subid] = cb
		return subid
	}

	this.un = function (subid) {
		if (!subid) return
		var topic = subid.split(DELI)[0]
		if (!listeners[topic]) return
		delete listeners[topic][subid]
	}
}

var RECONNECT_INTERVAL = 1000
var MAX_RECONNECT_INTERVAL = 30000
var RECONNECT_DECAY = 1.5
function calcNextBackoff (attempts) {
	if (!attempts || attempts === -1) return 0 // first time connect
	var delaytime = RECONNECT_INTERVAL * Math.pow(RECONNECT_DECAY, attempts)
	return Math.min(MAX_RECONNECT_INTERVAL, delaytime)
}

function map (collection, predicate) {
	if (!collection) return []
	if (!predicate) return collection

	var out = []
	if (Array.isArray(collection)) {
		for (var i = 0; i < collection.length; i++) {
			out.push(predicate(collection[i], i))
		}
		return out
	}

	if (typeof collection === 'object') {
		var keys = Object.keys(collection)
		for (var i = 0; i < keys.length; i++) {
			var k = keys[i]
			out.push(predicate(collection[k], k))
		}
		return out
	}

	return out
}

function filter (collection, predicate) {
	if (!Array.isArray(collection)) return []
	var out = []
	for (var i = 0; i < collection.length; i++) {
		if (predicate(collection[i], i)) out.push(collection[i])
	}
	return out
}

module.exports = Realtime
