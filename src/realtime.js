// Conn represents a realtime connection between an user and the realtime
// server (https://realtime-0.subiz.com)
//
// You can subscribe for realtime events and it will sent you new events
// as fast as possible through onEvents callback.
//
// It will try it best to keep the communication with the realtime
// server. But if the user is offline for too long or her network can't
// keep up with the incomming events (rarely happend with today
// internet speed). The connection will be halt. Dead.
//
// Once dead, onDead will be called. After that, the connection is
// useless, all resources will be released.
function Conn (apiUrl, credential, onDead, onEvents, callAPI) {
	callAPI = callAPI || xhrsend // allow hook
	credential = credential || {}
	// tell if connection is dead
	var dead = false

	// is long polling started?
	var initialized = false

	// used to determind connection id
	// server will see two Conns with the same connection seek as one
	var connectionSeek = randomString()

	// kill force the connection to dead state
	this.kill = function () {
		dead = true
	}

	// long polling loop, polling will run sequentialy. Each polling will start right
	// after the previous returned. In case of error, polling loop will pause based on
	// exponential backoff algorithm. Polling loop will terminate if it encounter an
	// un-retryable error
	// the polling loop starts after the first subscribe call finished successfully
	var polling = function (token, backoff) {
		if (dead) return
		callAPI('get', `${apiUrl}poll?token=${token}`, undefined, function (body, code) {
			if (dead) return
			if (retryable(code)) return setTimeout(polling, calcNextBackoff(backoff), token, backoff + 1)
			if (code !== 200) {
				// unretryable error, should kill
				dead = true
				return onDead('poll')
			}

			// 200, success
			body = parseJSON(body)

			var sequentialToken = body.sequential_token
			// the server returns a malform payload. We should retry and hope it heal soon
			if (!sequentialToken) return setTimeout(polling, calcNextBackoff(backoff), token, backoff + 1)
			onEvents(body.events || [])
			return polling(sequentialToken, 0)
		})
	}

	// subscribe call /subs API to tell server that we are listening for those events
	// this function may start polling loop if it hasn't been started yet
	var thethis = this
	this.subscribe = function (events, cb) {
		if (dead) return cb('dead')
		if (events.length <= 0) return cb()
		var query = `?seek=${connectionSeek}`

		// prepare authorization
		var access_token = credential.getAccessToken && credential.getAccessToken()
		if (credential.user_mask) query += `&user-mask=${encodeURIComponent(credential.user_mask)}`
		else if (access_token) query += `&access-token=${access_token}`

		callAPI('post', `${apiUrl}subs${query}`, JSON.stringify({ events }), function (body, code) {
			if (dead) return cb('dead')
			if (retryable(code)) return setTimeout(thethis.subscribe, 3000, events, cb)

			// unretryable error
			if (code !== 200) {
				// we are unable to start the communication with realtime server.
				// Must notify the user by killing the connection
				dead = true
				onDead('subscribe', body, code)
				return cb('cannot subscribe')
			}

			// success
			if (initialized) return cb()
			initialized = true

			body = parseJSON(body) || {}
			var initialToken = body.initial_token
			// the server returns a malform payload. We should retry and hope it heal soon
			if (!initialToken) return setTimeout(thethis.subscribe, 3000, events, cb)
			// first time sub, should grab the initial token
			polling(initialToken, 0) // start the poll
			cb()
		})
	}
}

// Realtime is just a stronger Conn.
// This class helps you subscribe and listen realtime event from the
// realtime server
// additional features compare to conn:
//   + auto recreate and resub if the last conn is dead
//   + don't subscribe already subscribed events
function Realtime (apiUrl, credential, callAPI) {
	credential = credential || {}

	var stop = false

	var pubsub = new Pubsub()

	// holds all subscribed event as its keys
	var subscribedEvents = {}

	// stop the connection
	this.stop = function () {
		stop = true
		if (conn) conn.kill()
	}

	this.un = function (subid) {
		pubsub.un(subid)
	}

	this.onEvent = function (cb) {
		return pubsub.on('event', cb)
	}

	this.onInterrupted = function (cb) {
		return pubsub.on('interrupted', cb)
	}

	var conn
	this.subscribe = function (events) {
		return new Promise(function (rs) {
			if (stop) return rs()

			// ignore already subscribed events
			var newEvs = filter(events, function (ev) {
				return !subscribedEvents[ev]
			})
			if (newEvs.length === 0) return rs()
			conn.subscribe(newEvs, function (err) {
				if (err) return rs(err)
				map(newEvs, function (ev) {
					subscribedEvents[ev] = true
				})
				rs()
			})
		})
	}

	// reconnect make sure there is alway a Conn running is the background
	// if the Conn is dead, it recreate a new one
	var reconnect = function () {
		if (stop) return
		conn = new Conn(
			apiUrl,
			credential,
			function (code, body, status) {
				if (stop) return
				pubsub.emit('interrupted', code, body, status)
				setTimeout(reconnect, 1000) // reconnect and resubscribe after 1 sec
			},
			function (events) {
				if (stop) return
				map(events, function (ev) {
					pubsub.emit('event', ev)
				})
			},
			callAPI,
		)

		// resubscribe all subscribed events
		conn.subscribe(Object.keys(subscribedEvents), function () {})
	}
	reconnect()
}

// xhrsend sends an HTTP request
function xhrsend (method, url, body, cb) {
	var request = new window.XMLHttpRequest()
	request.onreadystatechange = function (e) {
		if (request.readyState !== 4) return
		cb && cb(request.responseText, request.status)
		cb = undefined // dont call cb anymore
	}

	request.onerror = function () {
		cb && cb(request.responseText, -1) // network error
		cb = undefined // dont call cb anymore
	}

	request.open(method, url)
	if (body) request.setRequestHeader('content-type', 'text/plain')
	request.send(body)
}

// JSON.parse without exeption
// return undefined when parsing invalid JSON string
function parseJSON (str) {
	try {
		return JSON.parse(str)
	} catch (e) {}
}

// randomString generates a 30 characters random string
function randomString () {
	var str = ''
	for (var i = 0; i < 30; i++) {
		var asciiKey = Math.floor(Math.random() * 25 + 97)
		str += String.fromCharCode(asciiKey)
	}
	return str
}

function Pubsub () {
	// holds all subscriptions for all topics
	// example {
	//   topic1: {sub1: cb1, sub2: cb2},
	//   topic2: {sub3: cb3, sub4: cb4},
	// }
	var listeners = {}

	// delimiter, used to generate topic. Topic = <topic><DELI><randomstr>
	var DELI = '-[/]-'

	// emit notifies any callback functions that previously
	// subscribed to the topic (by the on function)
	this.emit = function (topic) {
		// skip the first item in arguments, which is the topic
		var args = filter(arguments, function (_, i) {
			return i > 0
		})
		map(listeners[topic], function (cb) {
			cb.apply(undefined, args)
		})
	}

	// register a callback function for a topic
	// when something is sent to the topic (by the emit function),
	// the callback function will be called
	// this function returns a string represent the subscription
	// user can use the string to unsubscribe
	this.on = function (topic, cb) {
		var subid = topic + DELI + randomString(20)
		if (!listeners[topic]) listeners[topic] = {}
		listeners[topic][subid] = cb
		return subid
	}

	// remove a subscription
	this.un = function (subid) {
		if (!subid || !subid.split) return
		var topic = subid.split(DELI)[0]
		if (!listeners[topic]) return
		delete listeners[topic][subid]
	}
}

// calcNextBackoff returns number of seconds we must wait
// before sending a next request
// the results is determind based on exponential backoff algorithm
// see https://en.wikipedia.org/wiki/Exponential_backoff
function calcNextBackoff (attempts) {
	var RECONNECT_INTERVAL = 1000
	var MAX_RECONNECT_INTERVAL = 10000
	var RECONNECT_DECAY = 1.5

	if (!attempts || attempts === -1) return 0 // first time connect
	var delaytime = RECONNECT_INTERVAL * Math.pow(RECONNECT_DECAY, attempts)
	return Math.min(MAX_RECONNECT_INTERVAL, delaytime)
}

// like lodash.map
function map (collection, func) {
	if (!collection) return []
	if (!func) return collection

	var out = []
	if (Array.isArray(collection)) {
		for (var i = 0; i < collection.length; i++) out.push(func(collection[i], i))
		return out
	}

	if (typeof collection !== 'object') return []

	// object
	var keys = Object.keys(collection)
	for (var i = 0; i < keys.length; i++) {
		var key = keys[i]
		out.push(func(collection[key], key))
	}
	return out
}

// like lodash.filter
function filter (arr, func) {
	var out = []
	map(arr, function (v, i) {
		if (func(v, i)) out.push(v)
	})
	return out
}

// retryable decides whether we should resent the HTTP request
// based on last response or network state
function retryable (code) {
	// code = 0 means server return response without CORS header, so we are unable to read it
	// code = -1 means the network connection is dead
	return (code >= 500 && code < 600) || code === 0 || code === -1 || code === 429
}

module.exports = Realtime
