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
	// tell if connection is dead

	var lastToken = ''
	if (!accid) accid = ''

	var status = 'active' // active | polling (trouble while polling) | subbing (trouble while subscribing) | dead

	// The long polling loop runs sequentially, with each poll starting immediately
	// after the previous one completes. If an error occurs, the loop will pause
	// using an exponential backoff strategy. It will terminate if an unretryable
	// error is encountered. The polling loop begins after the first subscription
	// call completes successfully
	var polling = function (backoff) {
		if (status == 'dead') return
		callAPI('get', apiUrl + 'poll?token=' + lastToken + '&account-id=' + accid, undefined, function (body, code) {
			if (status == 'dead') return

			if (retryable(code)) {
				if (status == 'active') status = 'polling'
				return setTimeout(polling, calcNextBackoff(backoff), backoff + 1)
			}

			if (code !== 200) {
				// unretryable error, should kill
				status = 'dead'
				return onDead('poll')
			}

			if (status == 'polling') status = 'active'
			// 200, success
			body = parseJSON(body) || {}
			if (body.host) apiUrl = absUrl(body.host)

			var seqToken = body.sequential_token
			// the server returns a malform payload. We should end
			if (!seqToken) {
				status = 'dead'
				return onDead('poll')
			}
			lastToken = seqToken
			onEvents(body.events || [])
			return polling(0)
		})
	}

	var subQueue = flow.batch(50, 100, function (events) {
		if (status == 'dead') return repeat('dead', events.length)
		if (events.length <= 0) return []

		var done = false
		setTimeout(() => {
			if (done) return
			if (status == 'dead') return
			if (status == 'active') status = 'subbing'
		}, 4000)

		setTimeout(() => {
			// too long, kill
			if (done) return
			done = true
			if (status == 'dead') return
			status = 'dead' // mark as dead
			onDead('poll')
			out = repeat('dead', events.length)
			resolve(false) // break loop
		}, 60000)

		var resolve
		var promise = new Promise((rs) => {
			resolve = rs
		})
		var out = []
		flow
			.loop(function () {
				return new Promise(function (rs) {
					if (status == 'dead') {
						out = repeat('dead', events.length)
						return rs(false) // break loop
					}

					var query = '?token=' + lastToken
					credential.getAccessToken().then(function (access_token) {
						if (status == 'dead') {
							out = repeat('dead', events.length)
							return rs(false) // break loop
						}

						if (credential.user_ref) query += '&user_ref=' + encodeURIComponent(credential.user_ref)
						else if (credential.user_mask) query += '&user-mask=' + encodeURIComponent(credential.user_mask)
						else if (access_token) query += '&access-token=' + access_token

						var fullurl = apiUrl + 'subs' + query + '&account-id=' + encodeURIComponent(accid || credential.account_id)
						callAPI('post', fullurl, JSON.stringify({events: events}), function (body, code) {
							if (done) return
							if (status == 'subbing') status = 'active'

							if (status == 'dead') {
								out = repeat('dead', events.length)
								return rs(false) // break loop
							}

							if (retryable(code)) {
								status = 'subbing'
								return setTimeout(rs, 3000, true)
							}

							// unretryable error
							if (code !== 200) {
								// we are unable to start the communication with the realtime server.
								// Must notify the user by killing the connection
								status = 'dead'
								onDead('subscribe', body, code)
								out = repeat('dead', events.length)
								return rs(false)
							}

							done = true
							if (lastToken) return rs(false)

							// first time sub, should grab the initial token
							body = parseJSON(body) || {}
							var initialToken = body.initial_token
							// the server returns a malform payload. We should end
							if (!initialToken) {
								status = 'dead'
								onDead('subscribe', body, code)
								out = repeat('dead', events.length)
								return rs(false) // break loop
							}

							if (body.host) apiUrl = absUrl(body.host)

							lastToken = initialToken
							polling(0)
							return rs(false)
						})
					})
				})
			})
			.then(function () {
				resolve(out)
			})
		return promise
	})

	// subscribe call /subs API to tell server that we are listening for those events
	// this function may start polling loop if it hasn't been started yet
	// Note: this function is not design to be thread safed so, do not call this
	// function multiple times at once
	this.subscribe = subQueue.push.bind(subQueue)

	this.getStatus = function () {
		if (status == 'dead' || status == 'active') return status
		return 'connecting'
	}

	// kill force the connection to dead state
	this.kill = function () {
		status = 'dead'
	}
}

// Realtime is just a stronger Conn.
// This class helps you subscribe and listen realtime event from the
// realtime server
// additional features compare to conn:
//   + auto recreate and resub if the last conn is dead
//   + don't subscribe already subscribed events
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
	// {
	//   a: 'online',
	//   b: 'offline',
	//   c: 'connecting',
	// }
	var topics = {}

	// stop the connection
	var stop = false
	this.stop = function () {
		if (!conn || stop) return
		stop = true
		conn.kill()
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

	var conn
	this.subscribe = function (events) {
		if (stop) return Promise.resolve({})
		if (typeof events === 'string') events = [events]
		if (!Array.isArray(events)) return Promise.resolve({error: 'param should be an array or string'})

		// ignore already subscribed events
		var all = []
		for (var i = 0; i < events.length; i++) {
			var topic = events[i]
			if (!topic) continue
			if (!topics[topic]) {
				topics[topic] = true
				all.push(conn.subscribe(topic))
			}
		}
		if (all.length === 0) return Promise.resolve({})

		return Promise.all(all).then(function (errs) {
			for (var i = 0; i < errs.length; i++) if (errs[i]) return {error: errs[i]}
			for (var j = 0; j < events.length; j++) topics[events[j]] = true
			return {}
		})
	}

	// reconnect make sure there is alway a Conn running in the background
	// if the Conn is dead, it recreate a new one
	this.reconnect = function () {
		if (stop) return Promise.resolve(false)
		// reset subscribed topic
		var allTopics = Object.keys(topics)
		for (var i = 0; i < allTopics.length; i++) topics[allTopics[i]] = false
		var randomUrl = apiUrls[Math.floor(Math.random() * apiUrls.length)]
		if (conn) conn.kill() // kill old connection
		conn = new Conn(
			randomUrl,
			credential,
			function (code, body, status) {
				if (stop) return
				pubsub.emit('interrupted', code, body, status)
				if (!skipautoreconnect) setTimeout(this.reconnect, 2000) // reconnect and resubscribe after 2 sec
			},
			function (events) {
				if (stop) return
				for (var i = 0; i < events.length; i++) pubsub.emit('event', events[i])
			},
			callAPI,
			accid,
		)

		// resubscribe all subscribed events
		var topicKeys = Object.keys(topics)
		return this.subscribe(topicKeys)
	}
	this.reconnect()
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
