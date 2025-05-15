var flow = require('@subiz/flow')
var {xhrsend, parseJSON, Pubsub} = require('./common.js')

// Conn represents a realtime connection between an user and the realtime
// server (https://rt-0.subiz.com)
//
// You can subscribe for realtime events and it will sent you new events
// as fast as possible through onEvents callback.
//
// It will try it best to keep the communication with the realtime
// server. But if the user is offline for too long or the network can't
// keep up with incomming events (rarely happend with today internet speed).
// The connection will be killed. Dead.
//
// Once dead, onDead will be called. After that, the connection is
// useless, all resources will be released.
function Conn(apiUrl, credential, onDead, onEvents, callAPI, accid) {
	callAPI = callAPI || xhrsend // allow hook
	credential = credential || {}
	var lastToken = ''
	if (!accid) accid = ''
	var is_dead = false // tell if the connection is dead
	var is_polling_stuck = false // tell if we've having trouble doing /poll
	var is_sub_stuck = true // tell if we've having trouble doing /subscribe

	// The long polling loop runs sequentially, with each poll starting immediately
	// after the previous one completes. If an error occurs, the loop will pause
	// using an exponential backoff strategy. It will terminate if an unretryable
	// error is encountered.
	// The first loop begins after the first subscription call completes successfully
	var polling = function (backoff) {
		if (is_dead) return
		callAPI('get', apiUrl + 'poll?token=' + lastToken + '&v=5&account-id=' + accid, undefined, function (body, code) {
			if (is_dead) return
			if (retryable(code)) {
				is_polling_stuck = true
				return setTimeout(polling, calcNextBackoff(backoff), backoff + 1)
			}

			if (code !== 200) {
				// unretryable error, should kill
				is_polling_stuck = true
				return kill('poll')
			}

			// 200, success
			is_polling_stuck = false
			body = parseJSON(body) || {}
			if (body.host) apiUrl = absUrl(body.host)

			var seqToken = body.sequential_token
			// the server returns a malform payload. We should end
			if (!seqToken) return kill('poll')
			lastToken = seqToken
			onEvents(body.events || [])
			return polling(0)
		})
	}

	var subQueue = flow.batch(50, 100, function (topics) {
		if (is_dead) return Promise.resolve(repeat('dead', topics.length))
		if (topics.length <= 0) return Promise.resolve([])

		var resolve
		var promise = new Promise((rs) => {
			resolve = rs
		})

		var done = false
		setTimeout(function () {
			if (!done && !is_dead) is_sub_stuck = true
		}, 4000)

		setTimeout(() => {
			// too long, kill
			if (done) return
			done = true
			is_sub_stuck = true
			resolve(repeat('dead', topics.length))
			if (is_dead) return
			kill('subs')
		}, 60000)

		flow.loop(function () {
			return new Promise(function (rs) {
				if (is_dead) {
					resolve(repeat('dead', topics.length))
					return rs(false) // break loop
				}

				var query = '?token=' + lastToken
				credential.getAccessToken().then(function (access_token) {
					if (is_dead) {
						resolve(repeat('dead', topics.length))
						return rs(false) // break loop
					}

					if (credential.user_ref) query += '&user_ref=' + encodeURIComponent(credential.user_ref)
					else if (credential.user_mask) query += '&user-mask=' + encodeURIComponent(credential.user_mask)
					else if (access_token) query += '&access-token=' + access_token

					var fullurl =
						apiUrl + 'subs' + query + '&v=5&account-id=' + encodeURIComponent(accid || credential.account_id)
					callAPI('post', fullurl, JSON.stringify({events: topics}), function (body, code) {
						if (done) return
						if (is_dead) {
							resolve(repeat('dead', topics.length))
							return rs(false) // break loop
						}

						if (retryable(code)) {
							is_sub_stuck = true
							return setTimeout(rs, 3000, true)
						}

						// unretryable error
						if (code !== 200) {
							// we are unable to start the communication with the realtime server.
							// Must notify the user by killing the connection
							kill('subs')
							resolve(repeat('dead', topics.length))
							return rs(false)
						}
						is_sub_stuck = false
						done = true
						if (lastToken) {
							resolve(topics)
							return rs(false)
						}

						// first time sub, should grab the initial token
						body = parseJSON(body) || {}
						var initialToken = body.initial_token
						// the server returns a malform payload. We should end
						if (!initialToken) {
							kill('subs')
							resolve(repeat('dead', topics.length))
							return rs(false) // break loop
						}

						// learn new host
						if (body.host) apiUrl = absUrl(body.host)

						lastToken = initialToken
						polling(0)
						resolve(topics)
						return rs(false) // to break the loop
					})
				})
			})
		})

		return promise
	})

	// subscribe call /subs API to tell server that we are listening for those events
	// this function may start polling loop if it hasn't been started yet
	// its safe to call this function multiple times
	this.subscribe = subQueue.push.bind(subQueue)

	this.getStatus = function () {
		if (is_dead) return 'dead'
		if (is_sub_stuck || is_polling_stuck) return 'connecting'
		return 'active'
	}

	// kill force the connection to dead state
	var kill = function (reason) {
		is_dead = true
		onDead(reason)
	}
	this.kill = kill
}

// Realtime helps you subscribe and listen realtime event from th
// realtime server
// Realtime is just a stronger Conn.
function Realtime(apiUrls, credential, callAPI, accid, skipautoreconnect) {
	if (typeof apiUrls === 'string' || apiUrls instanceof String) apiUrls = [apiUrls]
	credential = credential || {}
	if (!credential.getAccessToken) {
		credential.getAccessToken = function () {
			return Promise.resolve('')
		}
	}
	if (!accid) accid = credential.account_id || ''
	var pubsub = new Pubsub()

	// holds all topics that realtime must subscribed
	var topics = {}

	// stop the connection
	this.stop = function () {
		if (!conn) return
		conn.kill()
		conn = undefined
		pubsub.emit('interrupted')
	}

	this.onEvent = function (cb) {
		return pubsub.on('event', cb)
	}

	this.onInterrupted = function (cb) {
		return pubsub.on('interrupted', cb)
	}

	this.getStatus = function () {
		if (!conn) return 'dead'
		return conn.getStatus()
	}

	var subscribe = function (events) {
		if (!conn) return Promise.resolve({error: 'dead'})
		if (typeof events === 'string') events = [events]
		if (!Array.isArray(events)) return Promise.resolve({error: 'param should be an array or string'})

		// ignore already subscribed events
		var all = []
		for (var i = 0; i < events.length; i++) {
			var topic = events[i]
			if (!topic) continue
			if (topics[topic]) continue
			topics[topic] = true // mark so next time we wont subscribe this event (topic) again
			all.push(conn.subscribe(topic))
		}
		if (all.length === 0) return Promise.resolve({})
		return Promise.all(all).then(function () {
			if (!conn || conn.getStatus() == 'dead') return {error: 'dead'}
			return {}
		})
	}
	this.subscribe = subscribe

	// reconnect make sure there is alway a Conn running in the background
	// if the Conn is dead, it recreate a new one
	var conn
	var reconnect = function () {
		var randomUrl = apiUrls[Math.floor(Math.random() * apiUrls.length)]
		if (conn) conn.kill() // kill old connection
		var myconn = new Conn(
			randomUrl,
			credential,
			function (code, body, status) {
				if (conn === undefined || myconn != conn) return // outdated
				conn = undefined // prevent dupplicate dead fire
				pubsub.emit('interrupted', code, body, status)
				if (!skipautoreconnect) setTimeout(reconnect, 2000) // reconnect and resubscribe after 2 sec
			},
			function (events) {
				if (myconn != conn) return
				for (var i = 0; i < events.length; i++) pubsub.emit('event', events[i])
			},
			callAPI,
			accid,
		)
		conn = myconn
		var copyTopics = Object.keys(topics)
		topics = {}
		// resubscribe all subscribed events
		return subscribe(copyTopics)
	}
	this.reconnect = reconnect
	reconnect()
}

// calcNextBackoff returns number of seconds we must wait
// before sending a next request
// the results is determind based on exponential backoff algorithm
// see https://en.wikipedia.org/wiki/Exponential_backoff
function calcNextBackoff(attempts) {
	var RECONNECT_INTERVAL = 1000
	var MAX_RECONNECT_INTERVAL = 10000
	var RECONNECT_DECAY = 1.5

	if (!attempts || attempts === -1) return 0 // first time connect
	var delaytime = RECONNECT_INTERVAL * Math.pow(RECONNECT_DECAY, attempts)
	return Math.min(MAX_RECONNECT_INTERVAL, delaytime)
}

// retryable decides whether we should resent the HTTP request
// based on last response or network state
function retryable(code) {
	// code = 0 means server return response without CORS header, so we are unable to read it
	// code = -1 means the network connection is dead
	return (code >= 500 && code < 600) || code === 0 || code === -1 || code === 429
}

function repeat(ele, n) {
	var arr = []
	for (var i = 0; i < n; i++) arr.push(ele)
	return arr
}

function absUrl(url) {
	url = url || ''
	if (url.startsWith('//')) return 'https:' + url
	return url
}

module.exports = Realtime
