var flow = require('@subiz/flow')

// Conn represents a realtime connection between an user and the realtime
// server (https://rt-0.subiz.com)
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

	var lastToken = ''

	// kill force the connection to dead state
	this.kill = function () {
		dead = true
	}

	// long polling loop, polling will run sequentialy. Each polling will start right
	// after the previous returned. In case of error, polling loop will pause based on
	// exponential backoff algorithm. Polling loop will terminate if it encounter an
	// un-retryable error
	// the polling loop starts after the first subscribe call finished successfully
	var polling = function (backoff) {
		if (dead) return
		callAPI('get', apiUrl + 'poll?token=' + lastToken, undefined, function (body, code) {
			if (dead) return
			if (retryable(code)) return setTimeout(polling, calcNextBackoff(backoff), backoff + 1)
			if (code !== 200) {
				// unretryable error, should kill
				dead = true
				return onDead('poll')
			}

			// 200, success
			body = parseJSON(body) || {}
			if (body.host) apiUrl = absUrl(body.host)

			var seqToken = body.sequential_token
			// the server returns a malform payload. We should retry and hope it heal soon
			if (!seqToken) return setTimeout(polling, calcNextBackoff(backoff), backoff + 1)
			lastToken = seqToken
			onEvents(body.events || [])
			return polling(0)
		})
	}

	var subQueue = flow.batch(50, 100, function (events) {
		if (dead) return ['dead']
		if (events.length <= 0) return []

		var out = []
		return flow.loop(function () {
			return new Promise(function (rs) {
				var query = '?token=' + lastToken
				credential.getAccessToken().then(function (access_token) {
					if (credential.user_mask) query += '&user-mask=' + encodeURIComponent(credential.user_mask)
					else if (access_token) query += '&access-token=' + access_token

					callAPI('post', apiUrl + 'subs' + query, JSON.stringify({ events: events }), function (body, code) {
						if (dead) {
							out = repeat('dead', events.length)
							return rs(false) // break loop
						}

						if (retryable(code)) return setTimeout(rs, 3000, true)
						// unretryable error
						if (code !== 200) {
							// we are unable to start the communication with realtime server.
							// Must notify the user by killing the connection
							dead = true
							onDead('subscribe', body, code)
							out = repeat('dead', events.length)
							return rs(false)
						}

						if (lastToken) return rs(false)

						// first time sub, should grab the initial token
						body = parseJSON(body) || {}
						var initialToken = body.initial_token
						// the server returns a malform payload. We should retry and hope it heal soon
						if (!initialToken) return setTimeout(rs, 3000, true)
						if (body.host) apiUrl = absUrl(body.host)

						lastToken = initialToken
						polling(0)
						return rs(false)
					})
				})
			})
		}).then(function () {
			return out
		})
	})

	// subscribe call /subs API to tell server that we are listening for those events
	// this function may start polling loop if it hasn't been started yet
	// Note: this function is not design to be thread safed so, do not call this
	// function multiple times at once
	this.subscribe = subQueue.push.bind(subQueue)
}

// Realtime is just a stronger Conn.
// This class helps you subscribe and listen realtime event from the
// realtime server
// additional features compare to conn:
//   + auto recreate and resub if the last conn is dead
//   + don't subscribe already subscribed events
function Realtime (apiUrls, credential, callAPI) {
	if (typeof apiUrls === 'string' || apiUrls instanceof String) apiUrls = [apiUrls]
	credential = credential || {}
	if (!credential.getAccessToken) {
		credential.getAccessToken = function () {
			return Promise.resolve('')
		}
	}

	var pubsub = new Pubsub()

	// holds all topics that realtime must subscribed
	// {
	//   a: 'online',
	//   b: 'offline',
	//   c: 'connecting',
	// }
	var topics = {}

	// stop the connection
	var stop = false
	this.stop = function () {
		if (stop) return
		stop = true
		conn.kill()
	}

	this.onEvent = function (cb) {
		return pubsub.on('event', cb)
	}

	this.onInterrupted = function (cb) {
		return pubsub.on('interrupted', cb)
	}

	var conn
	this.subscribe = function (events) {
		if (stop) return Promise.resolve({})
		if (typeof events === 'string') events = [events]
		if (!Array.isArray(events)) return Promise.resolve({ error: 'param should be an array or string' })

		// ignore already subscribed events
		var all = []
		for (var i = 0; i < events.length; i++) {
			var topic = events[i]
			if (!topic) continue
			if (topics[topic] !== 'online') all.push(conn.subscribe(topic))
		}
		if (all.length === 0) return Promise.resolve({})
		return Promise.all(all).then(function (errs) {
			for (var i = 0; i < errs.length; i++) if (errs[i]) return { error: errs[i] }
			for (var j = 0; j < events.length; j++) topics[events[j]] = true
			return {}
		})
	}

	// reconnect make sure there is alway a Conn running in the background
	// if the Conn is dead, it recreate a new one
	var reconnect = function () {
		if (stop) return
		// reset subscribed topic
		var allTopics = Object.keys(topics)
		for (var i = 0; i < allTopics.length; i++) topics[allTopics[i]] = false

		var randomUrl = apiUrls[Math.floor(Math.random() * apiUrls.length)]
		conn = new Conn(
			randomUrl,
			credential,
			function (code, body, status) {
				if (stop) return
				pubsub.emit('interrupted', code, body, status)
				setTimeout(reconnect, 2000) // reconnect and resubscribe after 2 sec
			},
			function (topics) {
				if (stop) return
				for (var i = 0; i < topics.length; i++) pubsub.emit('event', topics[i])
			},
			callAPI)

		// resubscribe all subscribed events
		var topicKeys = Object.keys(topics)
		for (var i = 0; i < topicKeys.length; i++) conn.subscribe(topicKeys[i])
	}
	reconnect()
}

// xhrsend sends an HTTP request
function xhrsend (method, url, body, cb) {
	var request = new XMLHttpRequest()
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

function Pubsub () {
	// holds all subscriptions for all topics
	// example {
	//   topic1: [cb1, cb2],
	//   topic2: [cb3, cb4],
	// }
	var listeners = {}

	// emit notifies any callback functions that previously
	// subscribed to the topic (by the on function)
	this.emit = function (topic) {
		// skip the first item in arguments, which is the topic
		var args = []
		for (var i = 1; i < arguments.length; i++) args.push(arguments[i])

		var cbs = listeners[topic]
		if (!cbs) return
		for (var i = 0; i < cbs.length; i++) cbs[i].apply(undefined, args)
	}

	// register a callback function for a topic
	// when something is sent to the topic (by the emit function),
	// the callback function will be called
	this.on = function (topic, cb) {
		if (!listeners[topic]) listeners[topic] = []
		listeners[topic].push(cb)
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

// retryable decides whether we should resent the HTTP request
// based on last response or network state
function retryable (code) {
	// code = 0 means server return response without CORS header, so we are unable to read it
	// code = -1 means the network connection is dead
	return (code >= 500 && code < 600) || code === 0 || code === -1 || code === 429
}

function repeat (ele, n) {
	var arr = []
	for (var i = 0; i < n; i++) arr.push(ele)
	return arr
}

function absUrl (url) {
	url = url || ''
	if (url.startsWith('//')) return 'https:' + url
	return url
}

module.exports = Realtime
