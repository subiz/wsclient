function retryable (code) {
	return code === 500 || code === -1 || code === 429
}
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
	this.kill = function () {
		dead = true
	}

	// user should not call this function
	var polling = function (token, backoff) {
		if (dead) return
		xhrsend('GET', `${apiUrl}poll?token=${token}`, undefined, undefined, function (body, code) {
			if (dead) return
			if (retryable(code)) return setTimeout(polling, calcNextBackoff(backoff), token, backoff + 1)
			if (code !== 200) {
				// unretryable error, should kill
				dead = true
				return onDead()
			}

			// 200, success
			body = parseJSON(body)
			onEvents(body.events)
			return polling(body.sequential_token, 0)
		})
	}

	var thethis = this
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
		xhrsend('POST', `${apiUrl}subs${query}`, JSON.stringify({ events }), header, function (body, code) {
			if (dead) return cb('dead')
			if (retryable(code)) return setTimeout(thethis.subscribe, 3000, events, cb)

			// unretryable error
			if (code !== 200) return cb('cannot subscribe')

			// success
			if (initialized) return cb()
			initialized = true
			// first time sub, should grab the initial token
			polling(parseJSON(body).initial_token, 0) // start the poll
			cb()
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
		if (lastConn) lastConn.kill()
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
		if (lastConn) lastConn.kill()
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
				})
			},
		)

		// resubscribe all subscribed event
		return lastConn.subscribe(Object.keys(subscribedEvents))
	}
}

// TODO retry forever on network lost, server return 500 or 502 or 429
function xhrsend (method, url, body, header, cb) {
	var request = new window.XMLHttpRequest()
	request.onreadystatechange = function (e) {
		if (request.readyState !== 4) return
		cb && cb(request.responseText, request.status)
	}

	request.onerror = function () {
		cb && cb(request.responseText, -1) // network error
		cb = undefined // dont call cb anymore
	}

	request.open(method, url)
	map(header, function (v, k) {
		request.setRequestHeader(k, v)
	})
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

function Pubsub () {
	var listeners = []
	var DELI = '-[/]-'

	this.emit = function (topic) {
		var args = filter(arguments, function (_, i) {
			return i > 0
		})
		map(listeners[topic], function (cb) {
			cb.apply(undefined, args)
		})
	}

	this.on = function (topic, cb) {
		var subid = topic + DELI + randomString(20)
		if (!listeners[topic]) listeners[topic] = {}
		listeners[topic][subid] = cb
		return subid
	}

	this.un = function (subid) {
		if (!subid || !subid.split) return
		var topic = subid.split(DELI)[0]
		if (!listeners[topic]) return
		delete listeners[topic][subid]
	}
}

function calcNextBackoff (attempts) {
	var RECONNECT_INTERVAL = 1000
	var MAX_RECONNECT_INTERVAL = 30000
	var RECONNECT_DECAY = 1.5

	if (!attempts || attempts === -1) return 0 // first time connect
	var delaytime = RECONNECT_INTERVAL * Math.pow(RECONNECT_DECAY, attempts)
	return Math.min(MAX_RECONNECT_INTERVAL, delaytime)
}

function map (collection, func) {
	if (!collection) return []
	if (!func) return collection

	var out = []
	if (Array.isArray(collection)) {
		for (var i = 0; i < collection.length; i++) out.push(func(collection[i], i))
		return out
	}

	if (typeof collection !== 'object') return []

	var keys = Object.keys(collection)
	for (var i = 0; i < keys.length; i++) {
		var k = keys[i]
		out.push(func(collection[k], k))
	}
	return out
}

function filter (arr, func) {
	var out = []
	map(arr, function (v, i) {
		if (func(v, i)) out.push(v)
	})
	return out
}

module.exports = Realtime
